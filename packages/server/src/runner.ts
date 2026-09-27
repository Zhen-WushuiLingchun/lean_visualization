import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Writable } from "node:stream";

/** Characters kept from the end of each captured stream. */
export const TAIL_LIMIT = 4096;

export type StreamName = "stdout" | "stderr";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard limit. The process tree is killed when it is exceeded. */
  timeoutMs: number;
  /** Always closed: several Lean tools block on an open stdin. */
  stdin?: "ignore";
  /** Called once per complete line (without the newline) of either stream. */
  onLine?: (stream: StreamName, line: string) => void;
  /**
   * When set, stdout is piped into this stream (with backpressure) instead of being captured.
   * The runner ends the sink when stdout ends, and also when the process cannot be spawned.
   */
  stdoutSink?: Writable;
}

export interface RunResult {
  /** Null when the process was killed, timed out, or could not be spawned. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when spawning failed (for example `ENOENT`). */
  spawnError: string | null;
  /** Last `TAIL_LIMIT` characters of stdout (empty when `stdoutSink` was used). */
  stdout: string;
  /** Last `TAIL_LIMIT` characters of stderr. */
  stderr: string;
  durationMs: number;
}

/** Everything the server spawns goes through a Runner, so tests can inject a fake. */
export interface Runner {
  run(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult>;
}

/** Keeps only the last `limit` characters of an appended string. */
export class Tail {
  private buf = "";
  constructor(private readonly limit = TAIL_LIMIT) {}
  push(s: string): void {
    if (s.length >= this.limit) {
      this.buf = s.slice(s.length - this.limit);
      return;
    }
    this.buf += s;
    if (this.buf.length > this.limit * 2) this.buf = this.buf.slice(this.buf.length - this.limit);
  }
  toString(): string {
    return this.buf.length > this.limit ? this.buf.slice(this.buf.length - this.limit) : this.buf;
  }
}

/** Splits a text stream into lines, tolerating CRLF and chunk boundaries. */
export class LineSplitter {
  private carry = "";
  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLine = 64 * 1024,
  ) {}
  push(text: string): void {
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl === -1) break;
      let line = this.carry + text.slice(start, nl);
      this.carry = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.onLine(line);
      start = nl + 1;
    }
    this.carry += text.slice(start);
    if (this.carry.length > this.maxLine) {
      this.onLine(this.carry.slice(0, this.maxLine));
      this.carry = "";
    }
  }
  end(): void {
    if (this.carry.length > 0) {
      const line = this.carry.endsWith("\r") ? this.carry.slice(0, -1) : this.carry;
      this.carry = "";
      this.onLine(line);
    }
  }
}

const activeChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of activeChildren) {
      try {
        if (process.platform === "win32") child.kill();
        else if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
}

/** Kill a child and its descendants. Windows needs `taskkill /T`; POSIX children lead their own group. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const fallback = (): void => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    try {
      const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      k.on("error", fallback);
      k.on("exit", (code) => {
        if (code !== 0) fallback();
      });
    } catch {
      fallback();
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Real implementation on `child_process.spawn`, never through a shell. */
export class ProcessRunner implements Runner {
  run(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
    installExitHook();
    const started = performance.now();
    return new Promise<RunResult>((resolve) => {
      const outTail = new Tail();
      const errTail = new Tail();
      const outDec = new StringDecoder("utf8");
      const errDec = new StringDecoder("utf8");
      const outLines = new LineSplitter((l) => opts.onLine?.("stdout", l));
      const errLines = new LineSplitter((l) => opts.onLine?.("stderr", l));
      const sink = opts.stdoutSink;
      let timedOut = false;
      let settled = false;
      let exitCode: number | null = null;
      let signal: string | null = null;
      let child: ChildProcess | undefined;
      let timer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;

      const endSink = (): void => {
        if (sink && !sink.writableEnded && !sink.destroyed) sink.end();
      };

      const finish = (spawnError: string | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        if (child) activeChildren.delete(child);
        if (!sink) {
          const outRest = outDec.end();
          if (outRest) {
            outTail.push(outRest);
            outLines.push(outRest);
          }
          outLines.end();
        }
        const errRest = errDec.end();
        if (errRest) {
          errTail.push(errRest);
          errLines.push(errRest);
        }
        errLines.end();
        resolve({
          exitCode: timedOut || spawnError ? null : exitCode,
          signal,
          timedOut,
          spawnError,
          stdout: outTail.toString(),
          stderr: errTail.toString(),
          durationMs: Math.round(performance.now() - started),
        });
      };

      const armGrace = (): void => {
        if (graceTimer) return;
        // Grandchildren may keep the pipes open; do not wait for them forever.
        graceTimer = setTimeout(() => {
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          endSink();
          finish(null);
        }, 5000);
      };

      try {
        child = spawn(cmd, [...args], {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (e) {
        endSink();
        finish(e instanceof Error ? e.message : String(e));
        return;
      }
      activeChildren.add(child);

      if (sink) {
        child.stdout?.pipe(sink);
      } else {
        child.stdout?.on("data", (chunk: Buffer) => {
          const s = outDec.write(chunk);
          outTail.push(s);
          outLines.push(s);
        });
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        const s = errDec.write(chunk);
        errTail.push(s);
        errLines.push(s);
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        endSink();
        finish(err.code ?? err.message);
      });
      child.on("exit", (code, sig) => {
        exitCode = code;
        signal = sig;
        armGrace();
      });
      child.on("close", (code, sig) => {
        if (exitCode === null) exitCode = code;
        if (signal === null) signal = sig;
        finish(null);
      });

      if (opts.timeoutMs > 0 && Number.isFinite(opts.timeoutMs)) {
        timer = setTimeout(() => {
          timedOut = true;
          if (child) killTree(child);
          armGrace();
        }, opts.timeoutMs);
      }
    });
  }
}

export const defaultRunner: Runner = new ProcessRunner();

/** Human-readable one-liner for a failed run. */
export function describeFailure(r: RunResult): string {
  if (r.spawnError) return `could not start (${r.spawnError})`;
  if (r.timedOut) return `timed out after ${Math.round(r.durationMs / 1000)} s`;
  if (r.exitCode === null) return `killed by ${r.signal ?? "signal"}`;
  return `exit code ${r.exitCode}`;
}
