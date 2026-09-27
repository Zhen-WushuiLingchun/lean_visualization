import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphFileSchema, type GraphFile } from "@proofflow/schema";
import type { ZodError } from "zod";
import { formatMs, lastLines } from "./export.js";
import { baseEnv, resolveLake, type ProjectInfo } from "./project.js";
import { defaultRunner, describeFailure, type Runner } from "./runner.js";

export const DEFAULT_EXTRACT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_BUILD_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_STATEMENT_MAX_CHARS = 2000;
/** Marker in the extractor template where the project's root imports are inserted. */
export const IMPORTS_MARKER = "-- PROOFFLOW_IMPORTS --";

export class ExtractError extends Error {
  override name = "ExtractError";
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/**
 * `PROOFFLOW_EXTRACT_SCRIPT`, else the first `lean/Extract.lean` found walking up from this module
 * (works from `src/` under tsx/vitest and from `dist/` after build).
 */
export function locateExtractScript(env: NodeJS.ProcessEnv = process.env, from: string = import.meta.url): string {
  const fromEnv = env["PROOFFLOW_EXTRACT_SCRIPT"];
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (!existsSync(abs)) throw new ExtractError(`PROOFFLOW_EXTRACT_SCRIPT points to a missing file: ${abs}`);
    return abs;
  }
  let dir = path.dirname(fileURLToPath(from));
  for (;;) {
    const candidate = path.join(dir, "lean", "Extract.lean");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ExtractError("lean/Extract.lean not found. Set PROOFFLOW_EXTRACT_SCRIPT to its path.");
}

export interface ExtractArgsInput {
  out: string;
  projectDir: string;
  projectName: string;
  roots: readonly string[];
  localPrefixes?: readonly string[];
  expandExternal?: boolean;
  statements?: boolean;
  statementMaxChars?: number;
}

/** Arguments after `--` for the extractor (its CLI contract, docs/ARCHITECTURE.md section 2). */
export function extractorArgs(a: ExtractArgsInput): string[] {
  const args = ["--out", a.out, "--project-dir", a.projectDir, "--project-name", a.projectName];
  for (const r of a.roots) args.push("--root", r);
  for (const p of a.localPrefixes ?? []) args.push("--local-prefix", p);
  if (a.expandExternal) args.push("--expand-external");
  if (a.statementMaxChars !== undefined) args.push("--statement-max-chars", String(a.statementMaxChars));
  if (a.statements === false) args.push("--no-statements");
  return args;
}

/** First `max` zod issues as `path: message` lines. */
export function formatIssues(error: ZodError, max = 10): string[] {
  return error.issues.slice(0, max).map((issue) => {
    let p = "";
    for (const seg of issue.path) {
      if (typeof seg === "number") p += `[${seg}]`;
      else p += p.length === 0 ? String(seg) : `.${String(seg)}`;
    }
    return `${p || "(root)"}: ${issue.message}`;
  });
}

/** Parse and validate graph.json text; throws `ExtractError` listing the first 10 issues. */
export function parseGraph(text: string, source = "graph.json"): GraphFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ExtractError(`${source} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = GraphFileSchema.safeParse(raw);
  if (!r.success) {
    const issues = formatIssues(r.error);
    const more = r.error.issues.length > issues.length ? ` (${r.error.issues.length} issues, first ${issues.length} shown)` : "";
    throw new ExtractError(`${source} does not match the schema${more}:\n  ${issues.join("\n  ")}`, issues);
  }
  return r.data;
}

export interface ExtractOptions {
  project: ProjectInfo;
  /** Root modules to import. Default: `project.defaultRoots`. */
  roots?: readonly string[];
  localPrefixes?: readonly string[];
  expandExternal?: boolean;
  /** Run `lake build` first. Default true. */
  build?: boolean;
  /** Emit pretty-printed statements. Default true. */
  statements?: boolean;
  statementMaxChars?: number;
  timeoutMs?: number;
  buildTimeoutMs?: number;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  scriptPath?: string;
  /** Default `<stateDir>/graph.json`. */
  outPath?: string;
}

export interface ExtractResult {
  graph: GraphFile;
  outPath: string;
  durationMs: number;
  buildMs: number | null;
}

/**
 * Copy the template into the state dir with `import <Root>` lines at the marker. Templates without
 * the marker are run in place (they import the roots at run time with `importModules`).
 */
async function materialiseScript(template: string, roots: readonly string[], stateDir: string): Promise<string> {
  const text = await readFile(template, "utf8");
  if (!text.includes(IMPORTS_MARKER)) return template;
  const imports = roots.map((r) => `import ${r}`).join("\n");
  const out = path.join(stateDir, "Extract.lean");
  await writeFile(out, text.replace(IMPORTS_MARKER, `${imports}\n${IMPORTS_MARKER}`), "utf8");
  return out;
}

export async function extractProject(opts: ExtractOptions): Promise<ExtractResult> {
  const { project } = opts;
  const runner = opts.runner ?? defaultRunner;
  const log = opts.log ?? (() => {});
  const env = baseEnv(opts.env ?? process.env);
  const lake = resolveLake(env);
  const roots = opts.roots && opts.roots.length > 0 ? [...opts.roots] : project.defaultRoots;
  if (roots.length === 0) throw new ExtractError(`No lean_lib found in ${project.lakefile.path}; pass --root.`);
  const started = performance.now();
  await mkdir(project.stateDir, { recursive: true });
  const ignoreFile = path.join(project.stateDir, ".gitignore");
  if (!existsSync(ignoreFile)) await writeFile(ignoreFile, "*\n", "utf8");
  const onLine = (_s: string, line: string): void => {
    if (line.trim().length > 0) log(line);
  };

  let buildMs: number | null = null;
  if (opts.build !== false) {
    log("lake build");
    const b = await runner.run(lake, ["build"], {
      cwd: project.dir,
      env,
      timeoutMs: opts.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      stdin: "ignore",
      onLine,
    });
    buildMs = b.durationMs;
    if (b.exitCode !== 0) {
      const tail = lastLines(`${b.stdout}\n${b.stderr}`, 5);
      throw new ExtractError(`lake build failed: ${describeFailure(b)}${tail ? `: ${tail}` : ""}`);
    }
    log(`lake build ok (${formatMs(b.durationMs)})`);
  }

  const template = opts.scriptPath ? path.resolve(opts.scriptPath) : locateExtractScript(opts.env ?? process.env);
  const script = await materialiseScript(template, roots, project.stateDir);
  const outPath = path.resolve(opts.outPath ?? path.join(project.stateDir, "graph.json"));
  await mkdir(path.dirname(outPath), { recursive: true });
  const tmpOut = `${outPath}.tmp`;
  if (existsSync(tmpOut)) await unlink(tmpOut);
  const args = [
    "env",
    "lean",
    "--run",
    script,
    "--",
    ...extractorArgs({
      out: tmpOut,
      projectDir: project.dirPosix,
      projectName: project.name,
      roots,
      ...(opts.localPrefixes ? { localPrefixes: opts.localPrefixes } : {}),
      expandExternal: opts.expandExternal ?? false,
      statements: opts.statements ?? true,
      statementMaxChars: opts.statementMaxChars ?? DEFAULT_STATEMENT_MAX_CHARS,
    }),
  ];
  log(`extract ${roots.join(", ")}`);
  const r = await runner.run(lake, args, {
    cwd: project.dir,
    env,
    timeoutMs: opts.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS,
    stdin: "ignore",
    onLine,
  });
  if (r.exitCode !== 0) {
    const tail = lastLines(`${r.stdout}\n${r.stderr}`, 5);
    throw new ExtractError(`extractor failed: ${describeFailure(r)}${tail ? `: ${tail}` : ""}`);
  }
  if (!existsSync(tmpOut)) throw new ExtractError(`extractor exited 0 but wrote no output at ${tmpOut}`);
  const text = await readFile(tmpOut, "utf8");
  let graph: GraphFile;
  try {
    graph = parseGraph(text, "extractor output");
  } catch (e) {
    const kept = `${outPath}.invalid.json`;
    await rename(tmpOut, kept).catch(() => undefined);
    if (e instanceof ExtractError) throw new ExtractError(`${e.message}\n  (kept at ${kept})`, e.issues);
    throw e;
  }
  await rename(tmpOut, outPath);
  const durationMs = Math.round(performance.now() - started);
  log(`graph.json ok: ${graph.stats.nodes} nodes (${formatMs(durationMs)})`);
  return { graph, outPath, durationMs, buildMs };
}
