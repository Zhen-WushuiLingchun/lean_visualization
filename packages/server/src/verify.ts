import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CheckerNameSchema,
  CheckerResultSchema,
  VerifyResultSchema,
  verdictOf,
  type CheckerName,
  type CheckerResult,
  type CheckerStatus,
  type GraphFile,
  type VerifyResult,
} from "@proofflow/schema";
import {
  ALL_CHECKERS,
  binarySha256,
  checkerAvailability,
  checkerBinaryPath,
  hasLeanexport,
  isExportBased,
  runChecker,
} from "./checkers.js";
import {
  declSlug,
  exportDecl,
  exportModuleOf,
  exportPaths,
  findNode,
  formatBytes,
  formatMs,
  sha256File,
  type ExportInfo,
} from "./export.js";
import { locateOlean, resolveToolchain, toPosix, type ProjectInfo, type Toolchain } from "./project.js";
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
 * `"all"` = see `allCheckers` (available checkers; module replay only without leanexport; missing ones
 * are omitted, not reported as `unavailable`); `"L1"` = the default L1 checker. Same meaning in
 * the API and the CLI.
 */
export type CheckerSelection = readonly CheckerName[] | "all" | "L1";

/** Checkers usable in the toolchain, in canonical order (see `checkerAvailability`). */
export function availableCheckers(toolchain: Pick<Toolchain, "binDir">): CheckerName[] {
  return ALL_CHECKERS.filter((c) => checkerAvailability(toolchain, c).available);
}

/**
 * What `"all"` means: every available checker, except that module replay is left out when
 * `leanexport` exists (the export-based checkers cover the closure; module replay can still be
 * requested explicitly). Without `leanexport` this is just `leanchecker-module`.
 */
export function allCheckers(toolchain: Pick<Toolchain, "binDir">): CheckerName[] {
  const avail = availableCheckers(toolchain);
  return hasLeanexport(toolchain) ? avail.filter(isExportBased) : avail;
}

/** L1 by default: `leanchecker` on the export when `leanexport` exists, else module replay. */
export function defaultCheckers(toolchain: Pick<Toolchain, "binDir">): CheckerName[] {
  return hasLeanexport(toolchain) ? ["leanchecker"] : ["leanchecker-module"];
}

/** Default on a toolchain with `leanexport` (Lean ≥ 4.35). Prefer `defaultCheckers(toolchain)`. */
export const DEFAULT_CHECKERS: readonly CheckerName[] = ["leanchecker"];

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
  if (selection === undefined || selection === "L1") return defaultCheckers(toolchain);
  if (selection === "all") return allCheckers(toolchain);
  if (selection.length === 0) return defaultCheckers(toolchain);
  return sortCheckers(selection);
}

export interface ModuleFingerprint {
  module: string;
  /** The `.olean` that was hashed, or null when none was found. */
  file: string | null;
  sha256: string;
  bytes: number;
  /** True when no `.olean` was found and the hash is of `module + lean version` instead. */
  synthetic: boolean;
}

/**
 * Cache key for module replay: sha256 of the module's `.olean` (Lake layout, then dependencies,
 * then the toolchain), or of `module + lean version` when the `.olean` cannot be found.
 */
export async function moduleFingerprint(
  project: Pick<ProjectInfo, "dir">,
  module: string,
  toolchain: Pick<Toolchain, "prefix" | "leanVersion">,
): Promise<ModuleFingerprint> {
  const file = locateOlean(project.dir, module, toolchain.prefix);
  if (file) {
    const { sha256, bytes } = await sha256File(file);
    return { module, file, sha256, bytes, synthetic: false };
  }
  const sha256 = createHash("sha256")
    .update(`module:${module}\nlean:${toolchain.leanVersion ?? "unknown"}`, "utf8")
    .digest("hex");
  return { module, file: null, sha256, bytes: 0, synthetic: true };
}

export function moduleCacheFileOf(project: Pick<ProjectInfo, "stateDir">, module: string, oleanHash: string): string {
  return path.join(project.stateDir, "cache", "_modules", declSlug(module), `${oleanHash}.json`);
}

async function readModuleCache(file: string, toolchain: string): Promise<CheckerResult | null> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { toolchain?: unknown; result?: unknown };
    if (raw.toolchain !== toolchain) return null;
    const parsed = CheckerResultSchema.safeParse(raw.result);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Toolchain identity recorded in bindings: Lean version and prefix. */
export function toolchainIdentity(toolchain: Pick<Toolchain, "leanVersion" | "prefix">): string {
  return `lean ${toolchain.leanVersion ?? "unknown"} at ${toPosix(toolchain.prefix)}`;
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

  const module = exportModuleOf(node, project);
  const exportBased = requested.filter(isExportBased);
  const wantsModule = requested.some((c) => !isExportBased(c));
  const canExport = hasLeanexport(toolchain);

  return withDeclLock(`${project.stateDir}\u0000${decl}`, async () => {
    // What the export and the cache are bound to: the module's current .olean and the toolchain.
    const fp = await moduleFingerprint(project, module, toolchain);
    const binding = { oleanSha256: fp.synthetic ? null : fp.sha256, toolchain: toolchainIdentity(toolchain) };
    // Export only when an export-based checker was asked for and the toolchain can export.
    let exp: ExportInfo | null = null;
    if (exportBased.length > 0 && canExport) {
      exp = await exportDecl({
        project,
        graph: opts.graph,
        decl,
        toolchain,
        runner,
        force: opts.force ?? false,
        log,
        binding,
        ...(opts.exportTimeoutMs !== undefined ? { timeoutMs: opts.exportTimeoutMs } : {}),
        ...(opts.graphMtimeMs !== undefined ? { graphMtimeMs: opts.graphMtimeMs } : {}),
      });
    } else if (exportBased.length > 0) {
      log(`no leanexport in this toolchain (bundled from Lean 4.35): ${exportBased.join(", ")} unavailable`);
    }
    if (!exp) {
      log(
        fp.synthetic
          ? `module replay of ${module}: no .olean found, cache key = hash of module name and Lean version`
          : `module replay of ${module} (.olean ${formatBytes(fp.bytes)}, sha256 ${fp.sha256.slice(0, 12)})`,
      );
    }
    const key = exp ? exp.sha256 : fp.sha256;
    const moduleCache = wantsModule ? moduleCacheFileOf(project, module, fp.sha256) : null;

    const cacheFile = cacheFileOf(project, decl, key);
    const cached = await readCacheFile(cacheFile, decl);
    // A cached result counts only for the same toolchain and the same checker binary.
    const sameToolchain = cached?.binding.toolchain === binding.toolchain;
    const reused: CheckerResult[] = [];
    const toRun: CheckerName[] = [];
    for (const c of requested) {
      let hit = opts.force || !sameToolchain ? undefined : cached?.checkers.find((r) => r.checker === c);
      let from = "cached";
      if (!hit && !opts.force && !isExportBased(c) && moduleCache) {
        // Module replay checks every declaration of the module: share it across declarations.
        hit = (await readModuleCache(moduleCache, binding.toolchain)) ?? undefined;
        from = "cached for module";
      }
      const currentBinary = await binarySha256(checkerBinaryPath(toolchain.binDir, c));
      const sameBinary = hit !== undefined && currentBinary !== null && hit.binarySha256 === currentBinary;
      if (hit && hit.checker === c && sameBinary && REUSABLE_STATUSES.includes(hit.status)) {
        log(`${c}: ${from} ${hit.status}`);
        reused.push(hit);
      } else {
        if (hit && !sameBinary) log(`${c}: cached result came from a different binary, running again`);
        toRun.push(c);
      }
    }

    const ran = await mapLimit(toRun, opts.concurrency ?? 2, (c) =>
      runChecker(c, {
        toolchain,
        exportFile: exp?.file ?? null,
        module,
        projectDir: project.dir,
        axioms: node.axioms,
        nanodaConfigFile: exportPaths(project, decl).nanodaConfig,
        ...(exp && isExportBased(c) ? { cwd: path.dirname(exp.file) } : {}),
        runner,
        log,
        ...(opts.checkerTimeoutMs !== undefined ? { timeoutMs: opts.checkerTimeoutMs } : {}),
      }),
    );
    const moduleRun = ran.find((r) => !isExportBased(r.checker));
    if (moduleRun && moduleCache) {
      await writeJsonAtomic(moduleCache, { toolchain: binding.toolchain, result: CheckerResultSchema.parse(moduleRun) });
    }

    const verifiedAt = ran.length === 0 && cached ? cached.verifiedAt : new Date().toISOString();
    const leanVersion = exp?.leanVersion ?? toolchain.leanVersion ?? "unknown";
    const current = mergeCheckerResults(reused, ran);
    const base = {
      decl,
      module,
      exportHash: key,
      exportBytes: exp ? exp.bytes : (fp?.bytes ?? 0),
      exportDecls: exp ? exp.decls : null,
      exportDurationMs: exp ? exp.durationMs : 0,
      verifiedAt,
      leanVersion,
      binding,
      exportAudit: exp ? exp.audit : null,
    };
    if (ran.length > 0 || !cached || !sameToolchain) {
      const all = mergeCheckerResults(sameToolchain ? (cached?.checkers ?? []) : [], ran);
      const stored: VerifyResult = { ...base, checkers: all, verdict: verdictOf(all) };
      await writeJsonAtomic(cacheFile, VerifyResultSchema.parse(stored));
    }
    const result: VerifyResult = { ...base, checkers: current, verdict: verdictOf(current) };
    const how = exp ? `export ${formatMs(exp.durationMs)}` : "module replay, no export";
    log(`verdict: ${result.verdict} (${current.length} checker${current.length === 1 ? "" : "s"}, ${how})`);
    return VerifyResultSchema.parse(result);
  });
}
