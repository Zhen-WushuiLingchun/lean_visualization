import { existsSync, statSync, type Stats } from "node:fs";
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
import { sha256File } from "./export.js";
import { exeName, type Toolchain } from "./project.js";
import { defaultRunner, type Runner, type RunResult } from "./runner.js";

export const DEFAULT_CHECKER_TIMEOUT_MS = 10 * 60_000;

/** Every checker in canonical order: L1 first. */
export const ALL_CHECKERS: readonly CheckerName[] = [...L1_CHECKERS, ...L2_CHECKERS];

/** What a checker reads: the declaration's leanexport NDJSON, or the module's `.olean`. */
export type CheckerInput = "export" | "module";

export interface CheckerArgs {
  exportFile: string;
  nanodaConfig: string;
  module: string;
}

export interface CheckerSpec {
  name: CheckerName;
  /** Binary name inside `<toolchain>/bin`, without `.exe`. */
  binary: string;
  level: "L1" | "L2";
  input: CheckerInput;
  /** Arguments after the binary (docs/CHECKERS.md). Module checkers run as `lake env <binary> ...`. */
  argv(a: CheckerArgs): string[];
  /** Line the checker prints on success; null when success is silent. */
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

/** nanoda panic text that means a typechecking failure (verified: `assertion failed: self.def_eq(u, v)`). */
export const NANODA_TYPE_FAILURE = /assertion failed|def_eq|type mismatch|infer/;

/** leanchecker failures that are not verdicts (verified: a module without .olean exits 1). */
const NOT_A_VERDICT = /Could not find any oleans|object file .* does not exist|unknown module prefix/i;

export const LEANEXPORT_NOTE = "needs leanexport (bundled from Lean 4.35)";
export const MODULE_REPLAY_NOTE =
  "Replays the node's whole module from .olean with imports trusted (Lean ≥ 4.28)";

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
    input: "export",
    argv: (a) => ["--from-export", a.exportFile],
    success: acceptsLine,
    classifyNonZero: exitOneRejects,
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
  "leanchecker-module": {
    name: "leanchecker-module",
    binary: "leanchecker",
    level: "L1",
    input: "module",
    // `lake env leanchecker <Module>`: replays the module's declarations on top of its imports.
    argv: (a) => [a.module],
    // Silent on success (verified on v4.33.0 and v4.35.0-rc3).
    success: null,
    classifyNonZero: (code, output) => (code === 1 && !NOT_A_VERDICT.test(output) ? "rejected" : "error"),
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
  "leanchecker-paranoid": {
    name: "leanchecker-paranoid",
    binary: "leanchecker-paranoid",
    level: "L2",
    input: "export",
    argv: (a) => ["--from-export", a.exportFile],
    success: acceptsLine,
    classifyNonZero: exitOneRejects,
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
  lean4lean: {
    name: "lean4lean",
    binary: "lean4lean",
    level: "L2",
    input: "export",
    // Without --import lean4lean reads .olean files and fails with `incompatible header`.
    argv: (a) => ["--import", a.exportFile],
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
    input: "export",
    argv: (a) => [a.nanodaConfig],
    success: null,
    classifyNonZero: (code, output) => {
      if (code !== 101) {
        // exit 1 is a config or I/O error (e.g. `failed to open configuration file`), not a verdict.
        return "error";
      }
      // Rust panic. Unpermitted axiom: a refusal to judge. A known typechecking failure: rejection.
      // Any other panic is a checker crash, not a counterexample (the stderr is kept).
      if (/declaration not found in infer_const/.test(output)) return "declined";
      if (NANODA_TYPE_FAILURE.test(output)) return "rejected";
      return "error";
    },
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
  "con-leche": {
    name: "con-leche",
    binary: "con-leche",
    level: "L2",
    input: "export",
    argv: (a) => [a.exportFile],
    success: /con-leche: accepted \d+ declarations/,
    classifyNonZero: conClassify,
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
  "con-ron": {
    name: "con-ron",
    binary: "con-ron",
    level: "L2",
    input: "export",
    argv: (a) => [a.exportFile],
    success: /con-ron: accepted \d+ declarations/,
    classifyNonZero: conClassify,
    abortOnPanic: true,
    rejectOnMismatchText: false,
  },
};

export function checkerBinaryPath(binDir: string, checker: CheckerName): string {
  return path.join(binDir, exeName(CHECKER_SPECS[checker].binary));
}

export function leanexportPath(binDir: string): string {
  return path.join(binDir, exeName("leanexport"));
}

export function hasLeanexport(toolchain: Pick<Toolchain, "binDir">): boolean {
  return existsSync(leanexportPath(toolchain.binDir));
}

export function isExportBased(checker: CheckerName): boolean {
  return CHECKER_SPECS[checker].input === "export";
}

const binaryHashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

/**
 * sha256 of a checker binary, computed once per (path, size, mtime). Part of a checker result's
 * cache identity: a replaced binary never inherits the old binary's verdicts. Null when missing.
 */
export async function binarySha256(file: string): Promise<string | null> {
  let st: Stats;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const hit = binaryHashes.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha256;
  const { sha256 } = await sha256File(file);
  binaryHashes.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
  return sha256;
}

export interface Availability {
  available: boolean;
  /** Resolved binary when available. */
  path: string | null;
  note: string | null;
}

/**
 * A module checker needs its binary. An export-based checker needs its binary and `leanexport`
 * (toolchains before 4.35 ship `leanchecker` but no `leanexport`).
 */
export function checkerAvailability(toolchain: Pick<Toolchain, "binDir">, checker: CheckerName): Availability {
  const spec = CHECKER_SPECS[checker];
  const bin = checkerBinaryPath(toolchain.binDir, checker);
  const binExists = existsSync(bin);
  if (spec.input === "module") {
    return binExists
      ? { available: true, path: bin, note: MODULE_REPLAY_NOTE }
      : { available: false, path: null, note: `${spec.binary} not in this toolchain` };
  }
  if (!hasLeanexport(toolchain)) return { available: false, path: null, note: LEANEXPORT_NOTE };
  if (!binExists) return { available: false, path: null, note: `${spec.binary} not in this toolchain` };
  return { available: true, path: bin, note: null };
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
  toolchain: Pick<Toolchain, "binDir" | "checkerEnv"> & Partial<Pick<Toolchain, "lake" | "env">>;
  /** Absolute path of the NDJSON export (export-based checkers). */
  exportFile?: string | null;
  /** Module to replay (module checkers), and the project root to run `lake env` in. */
  module?: string;
  projectDir?: string;
  /** Transitive axioms of the node (for nanoda's permitted list). */
  axioms?: readonly string[];
  /** Where the nanoda config is written (next to the export). */
  nanodaConfigFile?: string;
  cwd?: string;
  runner?: Runner;
  timeoutMs?: number;
  log?: (line: string) => void;
}

function unavailableResult(checker: CheckerName, command: string[]): CheckerResult {
  return {
    checker,
    status: "unavailable",
    exitCode: null,
    durationMs: 0,
    command,
    binarySha256: null,
    ranAt: null,
    stdoutTail: "",
    stderrTail: "",
    rejectedDecl: null,
  };
}

export async function runChecker(checker: CheckerName, ctx: CheckerContext): Promise<CheckerResult> {
  const spec = CHECKER_SPECS[checker];
  const log = ctx.log ?? (() => {});
  const bin = checkerBinaryPath(ctx.toolchain.binDir, checker);
  const avail = checkerAvailability(ctx.toolchain, checker);

  let cmd: string;
  let args: string[];
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  if (spec.input === "module") {
    const lake = ctx.toolchain.lake ?? "lake";
    const module = ctx.module ?? "";
    cmd = lake;
    args = ["env", spec.binary, ...spec.argv({ exportFile: "", nanodaConfig: "", module })];
    if (!avail.available || !module || !ctx.projectDir) {
      log(`${checker}: unavailable (${avail.note ?? "no module to replay"})`);
      return unavailableResult(checker, [cmd, ...args]);
    }
    cwd = ctx.cwd ?? ctx.projectDir;
    env = checkerEnvFor(checker, ctx.toolchain.env ?? ctx.toolchain.checkerEnv);
  } else {
    const exportFile = ctx.exportFile ?? "";
    const configFile = ctx.nanodaConfigFile ?? exportFile.replace(/\.ndjson$/i, "") + ".nanoda.json";
    cmd = bin;
    args = spec.argv({ exportFile, nanodaConfig: configFile, module: ctx.module ?? "" });
    if (!avail.available || !exportFile) {
      log(`${checker}: unavailable (${avail.note ?? "no export"})`);
      return unavailableResult(checker, [cmd, ...args]);
    }
    if (checker === "nanoda") {
      await writeFile(configFile, JSON.stringify(nanodaConfig(exportFile, ctx.axioms ?? []), null, 2) + "\n", "utf8");
    }
    cwd = ctx.cwd ?? path.dirname(exportFile);
    env = checkerEnvFor(checker, ctx.toolchain.checkerEnv);
  }

  // Identity of the binary that judges: the checker itself (module replay: `leanchecker`).
  const binarySha = await binarySha256(bin);
  const seen: SeenInOutput = { success: false, panic: false, mismatch: false };
  const scan = (text: string): void => {
    if (spec.success?.test(text)) seen.success = true;
    if (/\bPANIC\b/.test(text)) seen.panic = true;
    if (MISMATCH_TEXT.test(text)) seen.mismatch = true;
  };
  log(spec.input === "module" ? `${checker}: replay module ${ctx.module}` : `${checker}: start`);
  const runner = ctx.runner ?? defaultRunner;
  const r = await runner.run(cmd, args, {
    cwd,
    env,
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
    command: [cmd, ...args],
    binarySha256: binarySha,
    ranAt: new Date().toISOString(),
    stdoutTail: r.stdout,
    stderrTail: r.stderr,
    rejectedDecl,
  };
}

/** One entry point per checker, as listed in docs/CHECKERS.md. */
export const runLeanchecker = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("leanchecker", ctx);
export const runLeancheckerModule = (ctx: CheckerContext): Promise<CheckerResult> =>
  runChecker("leanchecker-module", ctx);
export const runLeancheckerParanoid = (ctx: CheckerContext): Promise<CheckerResult> =>
  runChecker("leanchecker-paranoid", ctx);
export const runLean4lean = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("lean4lean", ctx);
export const runNanoda = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("nanoda", ctx);
export const runConLeche = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("con-leche", ctx);
export const runConRon = (ctx: CheckerContext): Promise<CheckerResult> => runChecker("con-ron", ctx);

/**
 * Availability of every checker in the toolchain, with a note when a checker is missing or checks
 * something other than the declaration's closure. The checkers have no safe `--version` flag
 * (`leanchecker --version` blocks), so the version reported is the toolchain's Lean version.
 */
export function listCheckers(toolchain: Pick<Toolchain, "binDir" | "leanVersion"> | null): CheckerInfo[] {
  return ALL_CHECKERS.map((checker) => {
    const level = CHECKER_SPECS[checker].level;
    if (!toolchain) return { checker, available: false, path: null, version: null, level, note: "toolchain not resolved" };
    const a = checkerAvailability(toolchain, checker);
    return {
      checker,
      available: a.available,
      path: a.path,
      version: a.available && toolchain.leanVersion ? `toolchain ${toolchain.leanVersion}` : null,
      level,
      note: a.note,
    };
  });
}
