import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describeFailure, defaultRunner, type Runner } from "./runner.js";

export class ProjectError extends Error {
  override name = "ProjectError";
}

export interface LeanLib {
  name: string;
  srcDir: string | null;
  /** Root modules as declared; empty when the lakefile does not list them (Lake then uses `name`). */
  roots: string[];
  /** Lake globs as written: `Mod` (one), `Mod.+` (submodules), `Mod.*` (Mod and submodules). */
  globs: string[];
}

export interface ProjectInfo {
  /** Absolute native path of the project root. */
  dir: string;
  /** Same path with forward slashes, as written into graph.json. */
  dirPosix: string;
  /** Package name from the lakefile, or the directory name. */
  name: string;
  lakefile: { kind: "toml" | "lean"; path: string };
  libs: LeanLib[];
  /** Package-level `srcDir`, or null. Library `srcDir`s are relative to it. */
  srcDir: string | null;
  /**
   * Root modules to import by default, per Lake: a library's `roots` if declared, else its
   * `globs` expanded against its source directory, else its name.
   */
  defaultRoots: string[];
  /** Module prefixes treated as local by default: every library name, plus roots outside them. */
  defaultLocalPrefixes: string[];
  /** Contents of `lean-toolchain`, trimmed, or null. */
  toolchain: string | null;
  /** Parsed `lake-manifest.json`, or null. */
  manifest: unknown;
  /** Where ProofFlow keeps its artefacts. Defaults to `<dir>/.proofflow`. */
  stateDir: string;
}

export interface DetectOptions {
  /** Override the artefact directory (tests use a temp dir so the audited project stays untouched). */
  stateDir?: string;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------------------------
// TOML subset: top-level keys, [table] and [[array-of-tables]], strings, numbers, booleans,
// arrays (possibly multi-line) and inline tables. Enough for lakefile.toml.

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };

export interface TomlDoc {
  top: Record<string, TomlValue>;
  tables: Array<{ name: string; isArray: boolean; values: Record<string, TomlValue> }>;
}

/** Remove a trailing `#` comment that is outside any string. */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Net bracket depth of `s` counting only brackets outside strings. */
function bracketDepth(s: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth;
}

/** Split on top-level separators (outside strings and brackets). */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e: string) => {
    if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    switch (e) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return e;
    }
  });
}

function parseTomlKey(raw: string): string {
  const k = raw.trim();
  if (k.startsWith('"') && k.endsWith('"') && k.length >= 2) return unescapeBasic(k.slice(1, -1));
  if (k.startsWith("'") && k.endsWith("'") && k.length >= 2) return k.slice(1, -1);
  return k;
}

export function parseTomlValue(raw: string): TomlValue {
  const s = raw.trim();
  if (s.startsWith('"""') || s.startsWith("'''")) {
    const q = s.slice(0, 3);
    const body = s.slice(3, s.lastIndexOf(q) > 2 ? s.lastIndexOf(q) : undefined).replace(/^\r?\n/, "");
    return q === '"""' ? unescapeBasic(body) : body;
  }
  if (s.startsWith('"')) {
    const end = s.lastIndexOf('"');
    return unescapeBasic(s.slice(1, end > 0 ? end : undefined));
  }
  if (s.startsWith("'")) {
    const end = s.lastIndexOf("'");
    return s.slice(1, end > 0 ? end : undefined);
  }
  if (s.startsWith("[")) {
    const inner = s.slice(1, s.lastIndexOf("]") > 0 ? s.lastIndexOf("]") : undefined);
    return splitTopLevel(inner, ",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .map(parseTomlValue);
  }
  if (s.startsWith("{")) {
    const inner = s.slice(1, s.lastIndexOf("}") > 0 ? s.lastIndexOf("}") : undefined);
    const obj: Record<string, TomlValue> = {};
    for (const part of splitTopLevel(inner, ",")) {
      const eq = splitTopLevel(part, "=");
      if (eq.length < 2) continue;
      obj[parseTomlKey(eq[0] ?? "")] = parseTomlValue(eq.slice(1).join("="));
    }
    return obj;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s.replace(/_/g, ""));
  if (s.length > 0 && Number.isFinite(n)) return n;
  return s;
}

export function parseTomlSubset(text: string): TomlDoc {
  const doc: TomlDoc = { top: {}, tables: [] };
  let current: Record<string, TomlValue> = doc.top;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripTomlComment(lines[i] ?? "").trim();
    if (line.length === 0) continue;
    const arr = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(line);
    if (arr) {
      const values: Record<string, TomlValue> = {};
      doc.tables.push({ name: parseTomlKey(arr[1] ?? ""), isArray: true, values });
      current = values;
      continue;
    }
    const tbl = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (tbl) {
      const values: Record<string, TomlValue> = {};
      doc.tables.push({ name: parseTomlKey(tbl[1] ?? ""), isArray: false, values });
      current = values;
      continue;
    }
    const eqIdx = splitTopLevel(line, "=")[0]?.length ?? -1;
    if (eqIdx < 0 || eqIdx >= line.length) continue;
    const key = parseTomlKey(line.slice(0, eqIdx));
    let rhs = line.slice(eqIdx + 1).trim();
    // Multi-line arrays / inline tables / triple-quoted strings.
    if (rhs.startsWith('"""') || rhs.startsWith("'''")) {
      const q = rhs.slice(0, 3);
      while (rhs.indexOf(q, 3) === -1 && i + 1 < lines.length) rhs += "\n" + (lines[++i] ?? "");
    } else {
      while (bracketDepth(rhs) > 0 && i + 1 < lines.length) {
        line = stripTomlComment(lines[++i] ?? "");
        rhs += "\n" + line;
      }
    }
    current[key] = parseTomlValue(rhs);
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------
// lakefile.lean: regex over comment-stripped text.

function stripLeanComments(text: string): string {
  let out = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (depth > 0) {
      if (ch === "/" && next === "-") {
        depth++;
        i++;
      } else if (ch === "-" && next === "/") {
        depth--;
        i++;
      } else if (ch === "\n") out += "\n";
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "-") {
      depth = 1;
      i++;
    } else if (ch === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += ch;
  }
  return out;
}

const LEAN_IDENT = String.raw`(?:«[^»]+»|"[^"]+"|[A-Za-z_À-￿][\w.'!?À-￿]*)`;

/** `«Toy»` → `Toy`, `"toy"` → `toy`; keeps «» when the name really needs escaping. */
export function unescapeLeanIdent(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s
    .split(".")
    .map((part) => {
      const m = /^«([^»]+)»$/.exec(part);
      if (!m) return part;
      const inner = m[1] ?? "";
      return /^[A-Za-z_][\w'!?]*$/.test(inner) ? inner : part;
    })
    .join(".");
}

export interface LakefileInfo {
  name: string | null;
  srcDir: string | null;
  libs: LeanLib[];
}

export function parseLakefileLean(text: string): LakefileInfo {
  const src = stripLeanComments(text);
  const pkg = new RegExp(String.raw`^\s*package\s+(${LEAN_IDENT})`, "m").exec(src);
  const libRe = new RegExp(String.raw`^[ \t]*(?:@\[[^\]]*\][ \t]*)?lean_lib[ \t]+(${LEAN_IDENT})`, "gm");
  const boundary = /^(?:@\[|lean_lib\b|lean_exe\b|package\b|require\b|target\b|script\b|extern_lib\b|input_file\b|input_dir\b|def\b|abbrev\b|open\b|import\b|@\[default_target\])/m;
  const libs: LeanLib[] = [];
  for (const m of src.matchAll(libRe)) {
    const name = unescapeLeanIdent(m[1] ?? "");
    const start = (m.index ?? 0) + m[0].length;
    const rest = src.slice(start);
    const b = boundary.exec(rest);
    const block = b ? rest.slice(0, b.index) : rest;
    const rootsM = /\broots\s*:=\s*#\[([^\]]*)\]/.exec(block);
    const roots = rootsM
      ? [...(rootsM[1] ?? "").matchAll(/`((?:«[^»]+»|[^\s,\]`.«]+)(?:\.(?:«[^»]+»|[^\s,\]`.«]+))*)/g)].map((r) =>
          unescapeLeanIdent(r[1] ?? ""),
        )
      : [];
    const srcDirM = /\bsrcDir\s*:=\s*"([^"]*)"/.exec(block);
    // globs := #[.submodules `Foo, .andSubmodules `Bar, .one `Baz, Glob.submodules `Qux]
    const globsM = /\bglobs\s*:=\s*#\[([^\]]*)\]/.exec(block);
    const globs = globsM
      ? [...(globsM[1] ?? "").matchAll(/\.(one|submodules|andSubmodules)\s+`((?:«[^»]+»|[^\s,\]`.«]+)(?:\.(?:«[^»]+»|[^\s,\]`.«]+))*)/g)].map(
          (g) => {
            const mod = unescapeLeanIdent(g[2] ?? "");
            return g[1] === "submodules" ? `${mod}.+` : g[1] === "andSubmodules" ? `${mod}.*` : mod;
          },
        )
      : [];
    libs.push({ name, srcDir: srcDirM ? (srcDirM[1] ?? null) : null, roots, globs });
  }
  let pkgSrcDir: string | null = null;
  if (pkg) {
    const rest = src.slice((pkg.index ?? 0) + pkg[0].length);
    const b = boundary.exec(rest);
    const m = /\bsrcDir\s*:=\s*"([^"]*)"/.exec(b ? rest.slice(0, b.index) : rest);
    pkgSrcDir = m ? (m[1] ?? null) : null;
  }
  return { name: pkg ? unescapeLeanIdent(pkg[1] ?? "") : null, srcDir: pkgSrcDir, libs };
}

function asString(v: TomlValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

function asStringArray(v: TomlValue | undefined): string[] {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export function parseLakefileToml(text: string): LakefileInfo {
  const doc = parseTomlSubset(text);
  const libs: LeanLib[] = [];
  for (const t of doc.tables) {
    if (!t.isArray || t.name !== "lean_lib") continue;
    const name = asString(t.values["name"]);
    if (!name) continue;
    libs.push({
      name,
      srcDir: asString(t.values["srcDir"]),
      roots: asStringArray(t.values["roots"]),
      globs: asStringArray(t.values["globs"]),
    });
  }
  return { name: asString(doc.top["name"]), srcDir: asString(doc.top["srcDir"]), libs };
}

const PLAIN_COMPONENT = /^[A-Za-z_À-￿][\w'!?À-￿]*$/;

/** File path components → module name, escaping components that need «». */
export function moduleNameOf(components: readonly string[]): string {
  return components.map((c) => (PLAIN_COMPONENT.test(c) ? c : `«${c}»`)).join(".");
}

/** Module name → path components (`Foo.«Bar baz».X` → `["Foo", "Bar baz", "X"]`). */
export function moduleComponents(mod: string): string[] {
  const out: string[] = [];
  const re = /«([^»]*)»|([^.]+)/g;
  for (const m of mod.matchAll(re)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

/** Every `.lean` file under `dir` (recursively, skipping `.lake` and hidden dirs) as module names. */
function submodulesUnder(dir: string, prefix: readonly string[]): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) out.push(...submodulesUnder(path.join(dir, e.name), [...prefix, e.name]));
    else if (e.isFile() && e.name.endsWith(".lean")) out.push(moduleNameOf([...prefix, e.name.slice(0, -5)]));
  }
  return out;
}

/**
 * Expand one Lake glob against a library source directory: `Mod` = exactly Mod, `Mod.+` = every
 * submodule under `Mod/` (not Mod itself), `Mod.*` = Mod (when `Mod.lean` exists) and its submodules.
 */
export function expandGlob(glob: string, srcRoot: string): string[] {
  const g = glob.trim();
  const kind = g.endsWith(".+") ? "sub" : g.endsWith(".*") ? "and" : "one";
  const mod = kind === "one" ? g : g.slice(0, -2);
  if (kind === "one") return [mod];
  const comps = moduleComponents(mod);
  const subs = submodulesUnder(path.join(srcRoot, ...comps), comps).sort();
  if (kind === "and" && existsSync(path.join(srcRoot, ...comps) + ".lean")) return [mod, ...subs];
  return subs;
}

/** Source directory of a library: `<project>/<package srcDir>/<lib srcDir>`. */
export function libSourceRoot(projectDir: string, pkgSrcDir: string | null, lib: Pick<LeanLib, "srcDir">): string {
  return path.resolve(projectDir, pkgSrcDir ?? ".", lib.srcDir ?? ".");
}

/** Lake semantics: `roots` if declared, else expanded `globs`, else the library name. Deduplicated. */
export function defaultRootsOf(libs: readonly LeanLib[], projectDir = ".", pkgSrcDir: string | null = null): string[] {
  const out: string[] = [];
  for (const lib of libs) {
    let mods: string[];
    if (lib.roots.length > 0) mods = lib.roots;
    else if (lib.globs.length > 0) {
      const root = libSourceRoot(projectDir, pkgSrcDir, lib);
      mods = lib.globs.flatMap((g) => expandGlob(g, root));
    } else mods = [lib.name];
    for (const r of mods) if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** True when `prefix` is a component-wise prefix of `mod` (`Foo` covers `Foo` and `Foo.Bar`, not `FooBar`). */
export function isModulePrefix(prefix: string, mod: string): boolean {
  return mod === prefix || mod.startsWith(`${prefix}.`);
}

/** Every library name, plus any root not already covered by one of them. */
export function defaultLocalPrefixesOf(libs: readonly LeanLib[], roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const lib of libs) if (!out.includes(lib.name)) out.push(lib.name);
  for (const r of roots) if (!out.some((p) => isModulePrefix(p, r))) out.push(r);
  return out;
}

/**
 * Where Lake puts a module's `.olean`: the project's build dir, then each dependency's, then the
 * toolchain's `lib/lean` when `toolchainPrefix` is given. Null when none exists.
 */
export function locateOlean(projectDir: string, mod: string, toolchainPrefix?: string | null): string | null {
  const rel = `${path.join(...moduleComponents(mod))}.olean`;
  const bases = [path.join(projectDir, ".lake", "build", "lib", "lean"), path.join(projectDir, ".lake", "build", "lib")];
  try {
    for (const e of readdirSync(path.join(projectDir, ".lake", "packages"), { withFileTypes: true })) {
      if (e.isDirectory()) bases.push(path.join(projectDir, ".lake", "packages", e.name, ".lake", "build", "lib", "lean"));
    }
  } catch {
    /* no dependencies */
  }
  if (toolchainPrefix) bases.push(path.join(toolchainPrefix, "lib", "lean"));
  for (const b of bases) {
    const f = path.join(b, rel);
    if (existsSync(f)) return f;
  }
  return null;
}

export async function detectProject(dir: string, opts: DetectOptions = {}): Promise<ProjectInfo> {
  const abs = path.resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new ProjectError(`Project directory not found: ${abs}`);
  }
  const tomlPath = path.join(abs, "lakefile.toml");
  const leanPath = path.join(abs, "lakefile.lean");
  let info: LakefileInfo;
  let lakefile: ProjectInfo["lakefile"];
  if (existsSync(tomlPath)) {
    info = parseLakefileToml(await readFile(tomlPath, "utf8"));
    lakefile = { kind: "toml", path: tomlPath };
  } else if (existsSync(leanPath)) {
    info = parseLakefileLean(await readFile(leanPath, "utf8"));
    lakefile = { kind: "lean", path: leanPath };
  } else {
    throw new ProjectError(`No lakefile.toml or lakefile.lean in ${abs}. Pass --project <dir>.`);
  }
  const toolchainPath = path.join(abs, "lean-toolchain");
  const toolchain = existsSync(toolchainPath) ? (await readFile(toolchainPath, "utf8")).trim() || null : null;
  let manifest: unknown = null;
  const manifestPath = path.join(abs, "lake-manifest.json");
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      manifest = null;
    }
  }
  const defaultRoots = defaultRootsOf(info.libs, abs, info.srcDir);
  return {
    dir: abs,
    dirPosix: toPosix(abs),
    name: info.name ?? path.basename(abs),
    lakefile,
    libs: info.libs,
    srcDir: info.srcDir,
    defaultRoots,
    defaultLocalPrefixes: defaultLocalPrefixesOf(info.libs, defaultRoots),
    toolchain,
    manifest,
    stateDir: opts.stateDir ? path.resolve(opts.stateDir) : path.join(abs, ".proofflow"),
  };
}

// ---------------------------------------------------------------------------------------------
// Environment and executables.

export const isWindows = process.platform === "win32";

/** The real key used for PATH in an env object (Windows keeps `Path`). */
export function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

export function prependPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = pathKey(env);
  const cur = env[key] ?? "";
  const parts = cur.split(path.delimiter).filter((p) => p.length > 0);
  const norm = (p: string): string => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p));
  const filtered = parts.filter((p) => norm(p) !== norm(dir));
  return { ...env, [key]: [dir, ...filtered].join(path.delimiter) };
}

export function elanBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["ELAN_HOME"];
  return home ? path.join(home, "bin") : path.join(homedir(), ".elan", "bin");
}

/** Binary name with the platform suffix. */
export function exeName(name: string): string {
  return isWindows && !/\.(exe|com)$/i.test(name) ? `${name}.exe` : name;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!isWindows) accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find `name` on the PATH of `env`. On Windows only `.exe`/`.com` are considered because batch
 * files cannot be spawned without a shell.
 */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (path.isAbsolute(name)) return isExecutableFile(name) ? name : null;
  const dirs = (env[pathKey(env)] ?? "").split(path.delimiter).filter((d) => d.length > 0);
  const candidates = isWindows && !/\.(exe|com)$/i.test(name) ? [`${name}.exe`, `${name}.com`] : [name];
  for (const d of dirs) {
    for (const c of candidates) {
      const full = path.join(d.replace(/^"(.*)"$/, "$1"), c);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/** Environment for Lake invocations: `~/.elan/bin` is prepended when `lake` is not otherwise found. */
export function baseEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  if (resolveExecutable("lake", copy)) return copy;
  const elan = elanBinDir(copy);
  return existsSync(elan) ? prependPath(copy, elan) : copy;
}

// ---------------------------------------------------------------------------------------------
// Toolchain.

export interface Toolchain {
  /** `lake env lean --print-prefix`. */
  prefix: string;
  binDir: string;
  /** e.g. `4.35.0-rc3`, or null when it could not be determined. */
  leanVersion: string | null;
  /** Absolute path of the `lake` executable used. */
  lake: string;
  /** Environment for `lake` calls. */
  env: NodeJS.ProcessEnv;
  /** Environment for checker binaries: toolchain bin first on PATH, `LEAN_ABORT_ON_PANIC=1`. */
  checkerEnv: NodeJS.ProcessEnv;
}

export class ToolchainError extends Error {
  override name = "ToolchainError";
}

export interface ToolchainOptions {
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Absolute path of `lake`, or throws with an actionable message. */
export function resolveLake(env: NodeJS.ProcessEnv): string {
  const lake = resolveExecutable("lake", env);
  if (!lake) {
    throw new ToolchainError(
      `lake not found on PATH or in ${elanBinDir(env)}. Install elan (https://github.com/leanprover/elan).`,
    );
  }
  return lake;
}

function versionFromToolchainString(s: string | null): string | null {
  if (!s) return null;
  const m = /:v?([0-9][^\s]*)\s*$/.exec(s);
  return m ? (m[1] ?? null) : null;
}

export async function resolveToolchain(project: ProjectInfo, opts: ToolchainOptions = {}): Promise<Toolchain> {
  const runner = opts.runner ?? defaultRunner;
  const env = baseEnv(opts.env ?? process.env);
  const lake = resolveLake(env);
  // elan may download the toolchain on first use, hence the generous default.
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const r = await runner.run(lake, ["env", "lean", "--print-prefix"], {
    cwd: project.dir,
    env,
    timeoutMs,
    stdin: "ignore",
  });
  if (r.exitCode !== 0) {
    const detail = r.stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
    throw new ToolchainError(`lake env lean --print-prefix failed: ${describeFailure(r)}${detail ? `: ${detail}` : ""}`);
  }
  const prefix = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  if (!prefix) throw new ToolchainError("lake env lean --print-prefix printed nothing");
  const binDir = path.join(prefix, "bin");
  let leanVersion: string | null = null;
  const leanBin = path.join(binDir, exeName("lean"));
  const v = await runner.run(leanBin, ["--version"], { cwd: project.dir, env, timeoutMs: 60_000, stdin: "ignore" });
  if (v.exitCode === 0) {
    const m = /version\s+([^\s,)]+)/.exec(v.stdout);
    leanVersion = m ? (m[1] ?? null) : null;
  }
  leanVersion ??= versionFromToolchainString(project.toolchain);
  const checkerEnv = { ...prependPath(env, binDir), LEAN_ABORT_ON_PANIC: "1" };
  return { prefix, binDir, leanVersion, lake, env, checkerEnv };
}

/** Caches one toolchain resolution per project directory. */
export class ToolchainCache {
  private readonly cache = new Map<string, Promise<Toolchain>>();
  constructor(private readonly opts: ToolchainOptions = {}) {}
  get(project: ProjectInfo): Promise<Toolchain> {
    let p = this.cache.get(project.dir);
    if (!p) {
      p = resolveToolchain(project, this.opts);
      p.catch(() => this.cache.delete(project.dir));
      this.cache.set(project.dir, p);
    }
    return p;
  }
  clear(): void {
    this.cache.clear();
  }
}
