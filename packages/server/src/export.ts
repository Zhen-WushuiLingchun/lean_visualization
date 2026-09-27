import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GraphFile, Node } from "@proofflow/schema";
import { auditExport, type ExportAudit } from "./audit.js";
import type { ProjectInfo, Toolchain } from "./project.js";
import { defaultRunner, describeFailure, type Runner } from "./runner.js";

export const DEFAULT_EXPORT_TIMEOUT_MS = 10 * 60_000;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * File-system-safe ASCII slug of a declaration name plus 8 hex chars of sha1(name), so distinct
 * names never collide even when their readable part does.
 */
export function declSlug(name: string): string {
  const hash = createHash("sha1").update(name, "utf8").digest("hex").slice(0, 8);
  let readable = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .slice(0, 80)
    .replace(/[.\s]+$/, "");
  if (readable.length === 0) readable = "decl";
  const stem = readable.split(".")[0] ?? "";
  if (WINDOWS_RESERVED.test(stem)) readable = `_${readable}`;
  return `${readable}-${hash}`;
}

export interface ExportPaths {
  dir: string;
  /** `<stateDir>/export/<slug>.ndjson` */
  file: string;
  /** Sidecar with hash and timing of the last successful export. */
  info: string;
  /** nanoda config written next to the export. */
  nanodaConfig: string;
}

export function exportPaths(project: Pick<ProjectInfo, "stateDir">, decl: string): ExportPaths {
  const dir = path.join(project.stateDir, "export");
  const slug = declSlug(decl);
  return {
    dir,
    file: path.join(dir, `${slug}.ndjson`),
    info: path.join(dir, `${slug}.info.json`),
    nanodaConfig: path.join(dir, `${slug}.nanoda.json`),
  };
}

const DECL_RECORD = /^\s*\{\s*"(axiom|def|thm|opaque|quot|inductive)"\s*:/;
const HEAD_BYTES = 32;
const FIRST_LINE_MAX = 64 * 1024;

/** Streaming sha256, byte count, declaration-record count and first (meta) line of an NDJSON export. */
export class NdjsonStats {
  private readonly hash: Hash = createHash("sha256");
  private readonly head = Buffer.alloc(HEAD_BYTES);
  private headLen = 0;
  private lineNo = 0;
  private readonly firstLineParts: Buffer[] = [];
  private firstLineLen = 0;
  bytes = 0;
  decls = 0;
  lines = 0;

  push(chunk: Buffer): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      const end = nl === -1 ? chunk.length : nl;
      if (this.headLen < HEAD_BYTES && end > start) {
        const n = Math.min(HEAD_BYTES - this.headLen, end - start);
        chunk.copy(this.head, this.headLen, start, start + n);
        this.headLen += n;
      }
      if (this.lineNo === 0 && this.firstLineLen < FIRST_LINE_MAX && end > start) {
        const n = Math.min(FIRST_LINE_MAX - this.firstLineLen, end - start);
        this.firstLineParts.push(Buffer.from(chunk.subarray(start, start + n)));
        this.firstLineLen += n;
      }
      if (nl === -1) break;
      this.endLine();
      start = nl + 1;
    }
  }

  private endLine(): void {
    if (this.headLen > 0) {
      this.lines++;
      if (DECL_RECORD.test(this.head.toString("latin1", 0, this.headLen))) this.decls++;
    }
    this.headLen = 0;
    this.lineNo++;
  }

  /** Flush a final line without a trailing newline. */
  end(): void {
    if (this.headLen > 0) this.endLine();
  }

  firstLine(): string {
    return Buffer.concat(this.firstLineParts).toString("utf8");
  }

  /** `lean.version` from the `{"meta":...}` header line, when present. */
  leanVersion(): string | null {
    try {
      const meta = JSON.parse(this.firstLine()) as { meta?: { lean?: { version?: unknown } } };
      const v = meta.meta?.lean?.version;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }

  digest(): string {
    return this.hash.digest("hex");
  }
}

/** Pass-through stream that feeds an `NdjsonStats`. */
export class NdjsonStatsStream extends Transform {
  readonly stats = new NdjsonStats();
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.stats.push(chunk);
    cb(null, chunk);
  }
  override _flush(cb: TransformCallback): void {
    this.stats.end();
    cb();
  }
}

export interface FileDigest {
  sha256: string;
  bytes: number;
  decls: number;
  leanVersion: string | null;
}

/** Hash an existing export without reading it into memory. */
export async function digestFile(file: string): Promise<FileDigest> {
  const s = new NdjsonStatsStream();
  s.resume();
  await pipeline(createReadStream(file), s);
  return { sha256: s.stats.digest(), bytes: s.stats.bytes, decls: s.stats.decls, leanVersion: s.stats.leanVersion() };
}

/** Streaming sha256 and size of any file (used for `.olean` fingerprints). */
export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export class ExportError extends Error {
  override name = "ExportError";
  constructor(
    message: string,
    readonly code: "unknown-decl" | "failed" | "panic" | "timeout" | "empty" | "target-missing",
    readonly stderrTail = "",
  ) {
    super(message);
  }
}

export interface ExportInfo {
  decl: string;
  module: string;
  file: string;
  sha256: string;
  bytes: number;
  decls: number;
  durationMs: number;
  leanVersion: string | null;
  reused: boolean;
  command: string[];
  /** Project state the export was taken from. */
  binding: ExportBinding | null;
  /** Facts parsed from the NDJSON itself, independent of graph.json. */
  audit: ExportAudit;
}

/** What an export is bound to: the module's `.olean` at export time and the toolchain identity. */
export interface ExportBinding {
  /** sha256 of the node's module `.olean`, or null when it could not be located. */
  oleanSha256: string | null;
  /** e.g. `lean 4.35.0-rc3 at c:/Users/.../leanprover--lean4---v4.35.0-rc3`. */
  toolchain: string;
}

interface ExportSidecar {
  decl: string;
  module: string;
  sha256: string;
  bytes: number;
  decls: number;
  durationMs: number;
  leanVersion: string | null;
  exportedAt: string;
  oleanSha256?: string | null;
  toolchain?: string;
}

export interface ExportOptions {
  project: ProjectInfo;
  graph: Pick<GraphFile, "nodes">;
  decl: string;
  toolchain: Pick<Toolchain, "lake" | "env">;
  runner?: Runner;
  timeoutMs?: number;
  /** Re-export even if a previous export exists. */
  force?: boolean;
  log?: (line: string) => void;
  /** mtime of graph.json: an export older than the graph is not reused (an extra condition). */
  graphMtimeMs?: number;
  /**
   * Current `.olean` hash and toolchain identity. An existing export is reused only when its
   * sidecar records the same (non-null) `.olean` hash and toolchain; without a binding it is redone.
   */
  binding?: ExportBinding;
}

export function findNode(graph: Pick<GraphFile, "nodes">, decl: string): Node | undefined {
  return graph.nodes.find((n) => n.id === decl);
}

/** Module passed to leanexport: the node's own module (its .olean exists after `lake build`). */
export function exportModuleOf(node: Node, project: Pick<ProjectInfo, "defaultRoots">): string {
  if (node.module.length > 0) return node.module;
  const root = project.defaultRoots[0];
  if (!root) throw new ExportError(`No module known for ${node.id}`, "failed");
  return root;
}

async function readSidecar(file: string): Promise<ExportSidecar | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as ExportSidecar;
  } catch {
    return null;
  }
}

async function removeQuietly(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    /* not there */
  }
}

/**
 * `lake env leanexport <module> -- <decl>` streamed to `<stateDir>/export/<slug>.ndjson`, hashed and
 * counted on the fly. Refuses declarations that are not in graph.json (leanexport exits 0 on them).
 */
export async function exportDecl(opts: ExportOptions): Promise<ExportInfo> {
  const { project, decl } = opts;
  const log = opts.log ?? (() => {});
  const node = findNode(opts.graph, decl);
  if (!node) throw new ExportError(`${decl} is not in graph.json`, "unknown-decl");
  const module = exportModuleOf(node, project);
  const paths = exportPaths(project, decl);
  const command = [opts.toolchain.lake, "env", "leanexport", module, "--", decl];
  await mkdir(paths.dir, { recursive: true });

  const binding = opts.binding ?? null;
  if (!opts.force && existsSync(paths.file)) {
    const side = await readSidecar(paths.info);
    const st = await stat(paths.file);
    const fresh = opts.graphMtimeMs === undefined || st.mtimeMs >= opts.graphMtimeMs;
    // Reuse only an export bound to the current build and toolchain (graph mtime alone is not enough).
    const bound =
      binding !== null &&
      binding.oleanSha256 !== null &&
      side?.oleanSha256 === binding.oleanSha256 &&
      side?.toolchain === binding.toolchain;
    if (side && side.decl === decl && side.module === module && fresh && bound) {
      const pass = await auditExport(paths.file, decl);
      if (pass.sha256 === side.sha256 && pass.audit.declCount > 0 && pass.audit.targetFound) {
        log(`export reused (${pass.audit.declCount} decls, ${formatBytes(pass.bytes)}, bound to .olean ${binding.oleanSha256?.slice(0, 12)})`);
        return {
          decl,
          module,
          file: paths.file,
          sha256: pass.sha256,
          bytes: pass.bytes,
          decls: pass.audit.declCount,
          durationMs: side.durationMs,
          leanVersion: pass.leanVersion ?? side.leanVersion,
          reused: true,
          command,
          binding,
          audit: pass.audit,
        };
      }
    } else if (side && !bound) {
      log("previous export is not bound to the current .olean and toolchain: exporting again");
    }
  }

  log(`export ${decl} from ${module}`);
  const tmp = `${paths.file}.partial`;
  const stats = new NdjsonStatsStream();
  const out = createWriteStream(tmp);
  const written = pipeline(stats, out).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
  let sawPanic = false;
  const runner = opts.runner ?? defaultRunner;
  const r = await runner.run(command[0] ?? "lake", command.slice(1), {
    cwd: project.dir,
    env: opts.toolchain.env,
    timeoutMs: opts.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS,
    stdin: "ignore",
    stdoutSink: stats,
    onLine: (stream, line) => {
      if (stream !== "stderr") return;
      if (/\bPANIC\b/.test(line)) sawPanic = true;
      if (line.trim().length > 0) log(`[leanexport] ${line}`);
    },
  });
  if (!stats.writableEnded) stats.end();
  const writeError = await written;
  const panic = sawPanic || /\bPANIC\b/.test(r.stderr);
  const fail = async (msg: string, code: ExportError["code"]): Promise<never> => {
    await removeQuietly(tmp);
    throw new ExportError(msg, code, r.stderr);
  };
  if (r.timedOut) return fail(`leanexport ${describeFailure(r)}`, "timeout");
  if (r.spawnError) return fail(`leanexport ${describeFailure(r)}`, "failed");
  if (panic) {
    const line = r.stderr.split(/\r?\n/).find((l) => /\bPANIC\b/.test(l)) ?? "PANIC";
    return fail(`leanexport panicked: ${line.trim()}`, "panic");
  }
  if (r.exitCode !== 0) {
    const last = lastLines(r.stderr, 3);
    return fail(`leanexport failed: ${describeFailure(r)}${last ? `: ${last}` : ""}`, "failed");
  }
  if (writeError) return fail(`could not write export: ${writeError.message}`, "failed");
  if (stats.stats.decls === 0) return fail("leanexport produced no declarations", "empty");

  // Independent audit of the NDJSON: the requested declaration must be in it.
  const pass = await auditExport(tmp, decl);
  if (!pass.audit.targetFound) {
    return fail(`target declaration not found in export: ${decl} (${pass.audit.declCount} declarations exported)`, "target-missing");
  }

  await rename(tmp, paths.file);
  const sha256 = stats.stats.digest();
  const info: ExportSidecar = {
    decl,
    module,
    sha256,
    bytes: stats.stats.bytes,
    decls: stats.stats.decls,
    durationMs: r.durationMs,
    leanVersion: stats.stats.leanVersion(),
    exportedAt: new Date().toISOString(),
    oleanSha256: binding?.oleanSha256 ?? null,
    ...(binding ? { toolchain: binding.toolchain } : {}),
  };
  await writeFile(paths.info, JSON.stringify(info, null, 2) + "\n", "utf8");
  log(`export done (${info.decls} decls, ${formatBytes(info.bytes)}, ${formatMs(r.durationMs)})`);
  log(
    `export audit: target ${pass.audit.targetKind}, type sha256 ${pass.audit.targetTypeSha256?.slice(0, 12) ?? "n/a"}, ` +
      `axioms ${pass.audit.axioms.join(", ") || "none"}`,
  );
  return {
    decl,
    module,
    file: paths.file,
    sha256,
    bytes: info.bytes,
    decls: info.decls,
    durationMs: r.durationMs,
    leanVersion: info.leanVersion,
    reused: false,
    command,
    binding,
    audit: pass.audit,
  };
}

export function lastLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-n)
    .join(" | ");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
