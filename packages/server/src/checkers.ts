import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  L1_CHECKERS,
  L2_CHECKERS,
  STANDARD_AXIOMS,
  type CheckerInfo,
  type CheckerName,
  type CheckerResult,
  type CheckerStatus,
} from "@proofflow/schema";
import { exeName, type Toolchain } from "./project.js";
import { defaultRunner, type Runner, type RunResult } from "./runner.js";

export const DEFAULT_CHECKER_TIMEOUT_MS = 10 * 60_000;

/** Every checker in canonical order: L1 first. */
export const ALL_CHECKERS: readonly CheckerName[] = [...L1_CHECKERS, ...L2_CHECKERS];

export interface CheckerSpec {
  name: CheckerName;
  /** Binary name inside `<toolchain>/bin`, without `.exe`. */
  binary: string;
  level: "L1" | "L2";
  /** Arguments after the binary (docs/CHECKERS.md). */
  argv(exportFile: string, nanodaConfig: string): string[];
  /** Line the checker prints on success; null when success is silent (nanoda). */
  success: RegExp | null;
  /** Exit-code map for non-zero exits. Codes not listed are `error`. */
  classifyNonZero(code: number, output: string): CheckerStatus;
  /** Run with `LEAN_ABORT_ON_PANIC=1`. False for lean4lean (see docs/CHECKERS.md). */
  abortOnPanic: boolean;
  /** A kernel type-mismatch message means `rejected` whatever the exit code. */
  rejectOnMismatchText: boolean;
}

/** Kernel type-mismatch text, as printed by leanchecker and lean4lean. */
export const MISMATCH_TEXT = /declaration type mismatch|but it is expected to have type/;

const acceptsLine = /Lean default kernel accepts the solution/;

function exitOneRejects(code: number): CheckerStatus {
  return code === 1 ? "rejected" : "error";
}

function conClassify(code: number): CheckerStatus {
  if (code === 1) return "rejected";
  if (code === 2) return "declined";
  return "error";
}

export const CHECKER_SPECS: Readonly<Record<CheckerName, CheckerSpec>> = {
  leanchecker: {
    name: "leanchecker",
    binary: "leanchecker",
    level: "L1",
    argv: (file) => ["--from-export", file],
    success: acceptsLine,
    classifyNonZero: exitOneRejects,
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
  "leanchecker-paranoid": {
    name: "leanchecker-paranoid",
    binary: "leanchecker-paranoid",
    level: "L2",
    argv: (file) => ["--from-export", file],
    success: acceptsLine,
    classifyNonZero: exitOneRejects,
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
  lean4lean: {
    name: "lean4lean",
    binary: "lean4lean",
    level: "L2",
    // Without --import lean4lean reads .olean files and fails with `incompatible header`.
    argv: (file) => ["--import", file],
    success: /checked \d+ declarations/,
    classifyNonZero: exitOneRejects,
    // With LEAN_ABORT_ON_PANIC=1 its error printer panics and the process aborts (0xC0000409 on
    // Windows) instead of exiting 1, so a rejection would look like an error.
    abortOnPanic: false,
    rejectOnMismatchText: true,
  },
  nanoda: {
    name: "nanoda",
    binary: "nanoda_bin",
    level: "L2",
    argv: (_file, config) => [config],
    success: null,
    classifyNonZero: (code, output) => {
      // Rust panic. An unpermitted axiom is a refusal to judge, anything else is a rejection.
      if (code === 101) return /declaration not found in infer_const/.test(output) ? "declined" : "rejected";
      // exit 1 is a config or I/O error (e.g. `failed to open configuration file`), not a verdict.
      return "error";
    },
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
  "con-leche": {
    name: "con-leche",
    binary: "con-leche",
    level: "L2",
    argv: (file) => [file],
    success: /con-leche: accepted \d+ declarations/,
    classifyNonZero: conClassify,
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
  "con-ron": {
    name: "con-ron",
    binary: "con-ron",
    level: "L2",
    argv: (file) => [file],
    success: /con-ron: accepted \d+ declarations/,
    classifyNonZero: conClassify,
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
};

export function checkerBinaryPath(binDir: string, checker: CheckerName): string {
  return path.join(binDir, exeName(CHECKER_SPECS[checker].binary));
}

export interface SeenInOutput {
  success: boolean;
  panic: boolean;
  mismatch: boolean;
}

/**
 * Status from a finished run. `accepted` needs exit 0, the success line when the checker prints
 * one, and no PANIC. A timeout is `timeout`; a missing binary is `unavailable`. For checkers with
 * `rejectOnMismatchText`, a kernel type-mismatch message is `rejected` whatever the exit code.
 */
export function classifyRun(checker: CheckerName, r: RunResult, seen: SeenInOutput): CheckerStatus {
  if (r.timedOut) return "timeout";
  if (r.spawnError === "ENOENT") return "unavailable";
  if (r.spawnError) return "error";
  const spec = CHECKER_SPECS[checker];
  if (spec.rejectOnMismatchText && seen.mismatch) return "rejected";
  if (r.exitCode === null) return "error";
  if (r.exitCode === 0) {
    if (seen.panic) return "error";
    if (spec.success && !seen.success) return "error";
    return "accepted";
  }
  return spec.classifyNonZero(r.exitCode, `${r.stdout}\n${r.stderr}`);
}

const REJECTED_PATTERNS: readonly RegExp[] = [
  /while replaying declaration '([^']+)'/,
  /'([^']+)' has type/,
  /\[at (?:theorem|thm|def|definition|opaque|inductive|quot|declaration|decl|axiom)\s+([^,\]\s]+)/,
  /type mismatch in (?:theorem|definition|def|declaration)\s+([^\s\[,]+)/,
  /uncaught exception: at ([^\s:]+):/,
];

/** Declaration named in a rejection message, e.g. `[at theorem t4, ...]` or `'t4' has type`. */
export function parseRejectedDecl(text: string): string | null {
  for (const re of REJECTED_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** nanoda config (docs/CHECKERS.md): the node's transitive axioms plus the standard three. */
export function nanodaConfig(exportFile: string, axioms: readonly string[]): Record<string, unknown> {
  const permitted = [...new Set([...STANDARD_AXIOMS, ...axioms])].sort();
  return {
    use_stdin: false,
    export_file_path: path.resolve(exportFile),
    permitted_axioms: permitted,
    unpermitted_axiom_hard_error: false,
    num_threads: 4,
    nat_extension: true,
    string_extension: true,
  };
}

/** The checker's environment: `LEAN_ABORT_ON_PANIC=1`, except for checkers that must not abort. */
export function checkerEnvFor(checker: CheckerName, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(copy)) if (k.toUpperCase() === "LEAN_ABORT_ON_PANIC") delete copy[k];
  if (CHECKER_SPECS[checker].abortOnPanic) copy["LEAN_ABORT_ON_PANIC"] = "1";
  return copy;
}

export interface CheckerContext {
  toolchain: Pick<Toolchain, "binDir" | "checkerEnv">;
  /** Absolute path of the NDJSON export. */
  exportFile: string;
  /** Transitive axioms of the node (for nanoda's permitted list). */
  axioms: readonly string[];
  /** Where the nanoda config is written (next to the export). */
  nanodaConfigFile?: string;
  cwd?: string;
  runner?: Runner;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export async function runChecker(checker: CheckerName, ctx: CheckerContext): Promise<CheckerResult> {
  const spec = CHECKER_SPECS[checker];
  const bin = checkerBinaryPath(ctx.toolchain.binDir, checker);
  const configFile = ctx.nanodaConfigFile ?? ctx.exportFile.replace(/\.ndjson$/i, "") + ".nanoda.json";
  const command = [bin, ...spec.argv(ctx.exportFile, configFile)];
  const log = ctx.log ?? (() => {});
  if (!existsSync(bin)) {
    log(`${checker}: unavailable (${path.basename(bin)} not in toolchain)`);
    return {
      checker,
      status: "unavailable",
      exitCode: null,
      durationMs: 0,
      command,
      stdoutTail: "",
      stderrTail: "",
      rejectedDecl: null,
    };
  }
  if (checker === "nanoda") {
    await writeFile(configFile, JSON.stringify(nanodaConfig(ctx.exportFile, ctx.axioms), null, 2) + "\n", "utf8");
  }
  const seen: SeenInOutput = { success: false, panic: false, mismatch: false };
  const scan = (text: string): void => {
    if (spec.success?.test(text)) seen.success = true;
    if (/\bPANIC\b/.test(text)) seen.panic = true;
    if (MISMATCH_TEXT.test(text)) seen.mismatch = true;
  };
  log(`${checker}: start`);
  const runner = ctx.runner ?? defaultRunner;
  const r = await runner.run(bin, command.slice(1), {
    cwd: ctx.cwd ?? path.dirname(ctx.exportFile),
    env: checkerEnvFor(checker, ctx.toolchain.checkerEnv),
    timeoutMs: ctx.timeoutMs ?? DEFAULT_CHECKER_TIMEOUT_MS,
    stdin: "ignore",
    onLine: (_stream, line) => {
      scan(line);
      if (line.trim().length > 0) log(`[${checker}] ${line}`);
    },
  });
  // Fake runners may not stream lines; also scan the tails.
  scan(r.stdout);
  scan(r.stderr);
  const status = classifyRun(checker, r, seen);
  const rejectedDecl = status === "rejected" ? parseRejectedDecl(`${r.stdout}\n${r.stderr}`) : null;
  log(`${checker}: ${status}${rejectedDecl ? ` at ${rejectedDecl}` : ""} (${r.durationMs} ms)`);
  return {
    checker,
    status,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    command,
    stdoutTail: r.stdout,
    stderrTail: r.stderr,
    rejectedDecl,
  };
}

/** One entry point per checker, as listed in docs/CHECKERS.md. */
export const runLeanchecker = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("leanchecker", ctx);
export const runLeancheckerParanoid = (ctx: CheckerContext): Promise<CheckerResult> =>
  runChecker("leanchecker-paranoid", ctx);
export const runLean4lean = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("lean4lean", ctx);
export const runNanoda = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("nanoda", ctx);
export const runConLeche = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("con-leche", ctx);
export const runConRon = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("con-ron", ctx);

/**
 * Availability of every checker in the toolchain. The checkers have no safe `--version` flag
 * (`leanchecker --version` blocks), so the version reported is the toolchain's Lean version.
 */
export function listCheckers(toolchain: Pick<Toolchain, "binDir" | "leanVersion"> | null): CheckerInfo[] {
  return ALL_CHECKERS.map((checker) => {
    const level = CHECKER_SPECS[checker].level;
    if (!toolchain) return { checker, available: false, path: null, version: null, level };
    const bin = checkerBinaryPath(toolchain.binDir, checker);
    const available = existsSync(bin);
    return {
      checker,
      available,
      path: available ? bin : null,
      version: available && toolchain.leanVersion ? `toolchain ${toolchain.leanVersion}` : null,
      level,
    };
  });
}
