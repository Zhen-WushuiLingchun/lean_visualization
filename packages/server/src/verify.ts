import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CheckerNameSchema,
  L1_CHECKERS,
  VerifyResultSchema,
  verdictOf,
  type CheckerName,
  type CheckerResult,
  type CheckerStatus,
  type GraphFile,
  type VerifyResult,
} from "@proofflow/schema";
import { ALL_CHECKERS, checkerBinaryPath, runChecker } from "./checkers.js";
import { declSlug, exportDecl, exportPaths, findNode, formatMs } from "./export.js";
import { resolveToolchain, type ProjectInfo, type Toolchain } from "./project.js";
import { defaultRunner, type Runner } from "./runner.js";

export class VerifyError extends Error {
  override name = "VerifyError";
  constructor(
    message: string,
    readonly code: "unknown-decl" | "bad-checkers",
  ) {
    super(message);
  }
}

/**
 * `"all"` = every checker whose binary exists in the active toolchain (missing ones are omitted,
 * not reported as `unavailable`); `"L1"` = the default. Same meaning in the API and the CLI.
 */
export type CheckerSelection = readonly CheckerName[] | "all" | "L1";

/** Checkers whose binary exists in the toolchain, in canonical order. */
export function availableCheckers(toolchain: Pick<Toolchain, "binDir">): CheckerName[] {
  return ALL_CHECKERS.filter((c) => existsSync(checkerBinaryPath(toolchain.binDir, c)));
}

export const DEFAULT_CHECKERS: readonly CheckerName[] = L1_CHECKERS;

/** Checker results that are reused from the cache. Errors, timeouts and unavailability are retried. */
export const REUSABLE_STATUSES: readonly CheckerStatus[] = ["accepted", "rejected", "declined"];

export function sortCheckers(names: Iterable<CheckerName>): CheckerName[] {
  const set = new Set(names);
  return ALL_CHECKERS.filter((c) => set.has(c));
}

/** Parse a CLI list such as `leanchecker,nanoda`, `all` or `L1`. */
export function parseCheckerList(text: string): CheckerSelection {
  const parts = text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 1 && parts[0]?.toLowerCase() === "all") return "all";
  if (parts.length === 1 && parts[0]?.toUpperCase() === "L1") return "L1";
  const out: CheckerName[] = [];
  for (const p of parts) {
    const r = CheckerNameSchema.safeParse(p === "nanoda_bin" ? "nanoda" : p);
    if (!r.success) {
      throw new VerifyError(`Unknown checker "${p}". Known: ${ALL_CHECKERS.join(", ")}, all`, "bad-checkers");
    }
    out.push(r.data);
  }
  if (out.length === 0) throw new VerifyError("Empty checker list", "bad-checkers");
  return sortCheckers(out);
}

export function resolveCheckerSelection(
  selection: CheckerSelection | undefined,
  toolchain: Pick<Toolchain, "binDir">,
): CheckerName[] {
  if (selection === undefined || selection === "L1") return [...DEFAULT_CHECKERS];
  if (selection === "all") return availableCheckers(toolchain);
  if (selection.length === 0) return [...DEFAULT_CHECKERS];
  return sortCheckers(selection);
}

/** Latest result per checker; `next` wins over `prev`. Canonical order. */
export function mergeCheckerResults(prev: readonly CheckerResult[], next: readonly CheckerResult[]): CheckerResult[] {
  const byName = new Map<CheckerName, CheckerResult>();
  for (const r of prev) byName.set(r.checker, r);
  for (const r of next) byName.set(r.checker, r);
  return ALL_CHECKERS.flatMap((c) => {
    const r = byName.get(c);
    return r ? [r] : [];
  });
}

export function cacheDirOf(project: Pick<ProjectInfo, "stateDir">, decl: string): string {
  return path.join(project.stateDir, "cache", declSlug(decl));
}

export function cacheFileOf(project: Pick<ProjectInfo, "stateDir">, decl: string, exportHash: string): string {
  return path.join(cacheDirOf(project, decl), `${exportHash}.json`);
}

async function readCacheFile(file: string, decl: string): Promise<VerifyResult | null> {
  try {
    const parsed = VerifyResultSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success || parsed.data.decl !== decl) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Every cached result for a declaration (one per export hash), newest first. */
export async function readCachedResults(project: Pick<ProjectInfo, "stateDir">, decl: string): Promise<VerifyResult[]> {
  const dir = cacheDirOf(project, decl);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: VerifyResult[] = [];
  for (const n of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(n)) continue;
    const r = await readCacheFile(path.join(dir, n), decl);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt));
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

/** Run `tasks` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const declLocks = new Map<string, Promise<unknown>>();

/** Serialise work on the same declaration (export files and cache entries are shared). */
async function withDeclLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = declLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  declLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (declLocks.get(key) === tail) declLocks.delete(key);
  }
}

export interface VerifyOptions {
  project: ProjectInfo;
  graph: Pick<GraphFile, "nodes">;
  decl: string;
  /** Default: L1 only (`leanchecker`). */
  checkers?: CheckerSelection;
  /** Re-export and re-run every requested checker. */
  force?: boolean;
  runner?: Runner;
  /** Resolved when absent. */
  toolchain?: Toolchain;
  log?: (line: string) => void;
  exportTimeoutMs?: number;
  checkerTimeoutMs?: number;
  /** Checkers run in parallel. Default 2. */
  concurrency?: number;
  /** mtime of graph.json, so an export older than the graph is redone. */
  graphMtimeMs?: number;
}

/**
 * Export the declaration's closure, reuse cached checker results for that export hash, run the
 * rest with bounded concurrency, persist the merged results, and return the requested ones.
 */
export async function verifyDecl(opts: VerifyOptions): Promise<VerifyResult> {
  const { project, decl } = opts;
  const node = findNode(opts.graph, decl);
  if (!node) throw new VerifyError(`${decl} is not in graph.json`, "unknown-decl");
  const runner = opts.runner ?? defaultRunner;
  const log = opts.log ?? (() => {});
  const toolchain = opts.toolchain ?? (await resolveToolchain(project, { runner }));
  const requested = resolveCheckerSelection(opts.checkers, toolchain);

  return withDeclLock(`${project.stateDir}\u0000${decl}`, async () => {
    const exp = await exportDecl({
      project,
      graph: opts.graph,
      decl,
      toolchain,
      runner,
      force: opts.force ?? false,
      log,
      ...(opts.exportTimeoutMs !== undefined ? { timeoutMs: opts.exportTimeoutMs } : {}),
      ...(opts.graphMtimeMs !== undefined ? { graphMtimeMs: opts.graphMtimeMs } : {}),
    });
    const cacheFile = cacheFileOf(project, decl, exp.sha256);
    const cached = await readCacheFile(cacheFile, decl);
    const reused: CheckerResult[] = [];
    const toRun: CheckerName[] = [];
    for (const c of requested) {
      const hit = opts.force ? undefined : cached?.checkers.find((r) => r.checker === c);
      if (hit && REUSABLE_STATUSES.includes(hit.status)) {
        log(`${c}: cached ${hit.status}`);
        reused.push(hit);
      } else toRun.push(c);
    }

    const ran = await mapLimit(toRun, opts.concurrency ?? 2, (c) =>
      runChecker(c, {
        toolchain,
        exportFile: exp.file,
        axioms: node.axioms,
        nanodaConfigFile: exportPaths(project, decl).nanodaConfig,
        cwd: path.dirname(exp.file),
        runner,
        log,
        ...(opts.checkerTimeoutMs !== undefined ? { timeoutMs: opts.checkerTimeoutMs } : {}),
      }),
    );

    const verifiedAt = ran.length === 0 && cached ? cached.verifiedAt : new Date().toISOString();
    const leanVersion = exp.leanVersion ?? toolchain.leanVersion ?? "unknown";
    const current = mergeCheckerResults(reused, ran);
    const base = {
      decl,
      module: exp.module,
      exportHash: exp.sha256,
      exportBytes: exp.bytes,
      exportDecls: exp.decls,
      exportDurationMs: exp.durationMs,
      verifiedAt,
      leanVersion,
    };
    if (ran.length > 0 || !cached) {
      const all = mergeCheckerResults(cached?.checkers ?? [], ran);
      const stored: VerifyResult = { ...base, checkers: all, verdict: verdictOf(all) };
      await writeJsonAtomic(cacheFile, VerifyResultSchema.parse(stored));
    }
    const result: VerifyResult = { ...base, checkers: current, verdict: verdictOf(current) };
    log(`verdict: ${result.verdict} (${current.length} checker${current.length === 1 ? "" : "s"}, export ${formatMs(exp.durationMs)})`);
    return VerifyResultSchema.parse(result);
  });
}
