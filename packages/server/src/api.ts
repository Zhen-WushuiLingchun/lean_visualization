import { existsSync, statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VerifyRequestSchema, type CheckerInfo } from "@proofflow/schema";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE, type SSEMessage } from "hono/streaming";
import { z } from "zod";
import { listCheckers } from "./checkers.js";
import { ExtractError, extractProject, formatIssues, type ExtractOptions } from "./extract.js";
import { JobManager } from "./jobs.js";
import { ToolchainCache, type ProjectInfo, type Toolchain } from "./project.js";
import { defaultRunner, type Runner } from "./runner.js";
import { GraphStore } from "./store.js";
import { DEFAULT_CHECKERS, readCachedResults, sortCheckers, verifyDecl, type CheckerSelection } from "./verify.js";

export const DEFAULT_PORT = 4870;
export const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export type ExtractDefaults = Omit<ExtractOptions, "project" | "runner" | "log">;

export interface VerifyDefaults {
  exportTimeoutMs?: number;
  checkerTimeoutMs?: number;
  /** Checkers run in parallel inside one verification. */
  concurrency?: number;
}

export interface CreateAppOptions {
  project: ProjectInfo;
  runner?: Runner;
  jobs?: JobManager;
  graphs?: GraphStore;
  /** A fixed toolchain (tests) or a resolver. Default: resolved once through `lake`. */
  toolchain?: Toolchain | (() => Promise<Toolchain>);
  /** Built web app. `undefined` = default location; `null` = no static files. */
  webDist?: string | null;
  extract?: ExtractDefaults;
  verify?: VerifyDefaults;
}

/** `PROOFFLOW_WEB_DIST`, else `packages/web/dist` next to this package. */
export function defaultWebDist(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["PROOFFLOW_WEB_DIST"];
  if (fromEnv) return path.resolve(fromEnv);
  // src/ and dist/ both sit directly under the package root.
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return path.resolve(pkgRoot, "..", "web", "dist");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const MISSING_DIST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ProofFlow</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5">
<h1>ProofFlow</h1>
<p>The web app is not built yet. Run <code>pnpm build</code> at the repository root, then reload this page.</p>
<p>The API works already, for example <a href="/api/graph">/api/graph</a> and <a href="/api/checkers">/api/checkers</a>.</p>
</body></html>
`;

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

type Inside = { kind: "ok"; file: string } | { kind: "missing" } | { kind: "outside" };

/** Resolve `rel` under `root`, following symlinks, and refuse anything that lands outside. */
export async function resolveInside(root: string, rel: string): Promise<Inside> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { kind: "missing" };
  }
  const candidate = path.resolve(rootReal, rel);
  const lexical = path.relative(rootReal, candidate);
  if (lexical === "" || lexical.split(/[\\/]/)[0] === ".." || path.isAbsolute(lexical)) return { kind: "outside" };
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return { kind: "missing" };
  }
  const r = path.relative(rootReal, real);
  if (r === "" || r.split(/[\\/]/)[0] === ".." || path.isAbsolute(r)) return { kind: "outside" };
  return { kind: "ok", file: real };
}

const ExtractRequestSchema = z
  .object({
    roots: z.array(z.string().min(1)).optional(),
    localPrefixes: z.array(z.string().min(1)).optional(),
    expandExternal: z.boolean().optional(),
    build: z.boolean().optional(),
    statements: z.boolean().optional(),
    statementMaxChars: z.number().int().positive().optional(),
  })
  .strict();

/** Hono app with the JSON API under `/api` and the built web app everywhere else. */
export function createApp(opts: CreateAppOptions): Hono {
  const { project } = opts;
  const runner = opts.runner ?? defaultRunner;
  const jobs = opts.jobs ?? new JobManager();
  const graphs = opts.graphs ?? GraphStore.forProject(project);
  const toolchains = new ToolchainCache({ runner });
  const tcOpt = opts.toolchain;
  const getToolchain = (): Promise<Toolchain> =>
    tcOpt === undefined ? toolchains.get(project) : typeof tcOpt === "function" ? tcOpt() : Promise.resolve(tcOpt);
  const webDist = opts.webDist === undefined ? defaultWebDist() : opts.webDist;
  const verifyDefaults = opts.verify ?? {};

  const app = new Hono();
  app.use("/api/*", cors({ origin: DEV_ORIGINS }));

  app.onError((err, c) => {
    if (err instanceof ExtractError) return c.json({ error: err.message, issues: err.issues }, 500);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.get("/api/health", async (c) => {
    const loaded = await graphs.get().catch(() => null);
    return c.json({ ok: true, project: { name: project.name, dir: project.dirPosix }, graph: loaded !== null });
  });

  app.get("/api/graph", async (c) => {
    const loaded = await graphs.get();
    if (!loaded) return c.json({ error: "graph.json not found. Run proofflow extract." }, 404);
    return c.body(loaded.json, 200, { "content-type": "application/json; charset=utf-8" });
  });

  app.get("/api/source", async (c) => {
    const decl = c.req.query("decl");
    if (!decl) return c.json({ error: "Missing ?decl=" }, 400);
    const loaded = await graphs.get();
    if (!loaded) return c.json({ error: "graph.json not found" }, 404);
    const node = loaded.byId.get(decl);
    if (!node) return c.json({ error: `Unknown declaration: ${decl}` }, 404);
    if (!node.isLocal || !node.src) return c.json({ error: "No local source for this declaration" }, 404);
    if (!/\.lean$/i.test(node.src.file)) return c.json({ error: "Not a Lean source file" }, 404);
    const res = await resolveInside(project.dir, node.src.file);
    if (res.kind === "outside") return c.json({ error: "Source path is outside the project" }, 403);
    if (res.kind === "missing") return c.json({ error: `Source file not found: ${node.src.file}` }, 404);
    if (statSync(res.file).size > MAX_SOURCE_BYTES) return c.json({ error: "Source file too large" }, 413);
    const lines = (await readFile(res.file, "utf8")).split(/\r?\n/);
    const line = Math.min(Math.max(1, node.src.line), Math.max(1, lines.length));
    const endLine = Math.min(Math.max(line, node.src.endLine), lines.length);
    return c.json({ file: node.src.file, line, endLine, text: lines.slice(line - 1, endLine).join("\n") });
  });

  app.get("/api/checkers", async (c) => {
    let tc: Toolchain | null = null;
    try {
      tc = await getToolchain();
    } catch {
      tc = null;
    }
    const infos: CheckerInfo[] = listCheckers(tc);
    return c.json(infos);
  });

  app.post("/api/verify", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    const parsed = VerifyRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid request", issues: formatIssues(parsed.error) }, 400);
    const loaded = await graphs.get();
    if (!loaded) return c.json({ error: "graph.json not found. Run proofflow extract." }, 409);
    const { decl, force } = parsed.data;
    if (!loaded.byId.has(decl)) return c.json({ error: `Unknown declaration: ${decl}` }, 404);
    const requested = parsed.data.checkers;
    // "all" is resolved against the toolchain when the job runs (same rule as the CLI).
    const selection: CheckerSelection =
      requested === "all" ? "all" : requested && requested.length > 0 ? sortCheckers(requested) : [...DEFAULT_CHECKERS];
    const key = `verify\u0000${decl}\u0000${selection === "all" ? "all" : selection.join(",")}\u0000${force ? 1 : 0}`;
    const job = jobs.submitVerify(
      decl,
      async (ctx) => {
        const current = (await graphs.get()) ?? loaded;
        if (!current.byId.has(decl)) throw new Error(`${decl} is no longer in graph.json`);
        const toolchain = await getToolchain();
        return verifyDecl({
          project,
          graph: current.graph,
          decl,
          checkers: selection,
          force: force ?? false,
          runner,
          toolchain,
          log: (l) => ctx.log(l),
          graphMtimeMs: current.mtimeMs,
          ...verifyDefaults,
        });
      },
      key,
    );
    return c.json({ jobId: job.id }, 202);
  });

  app.post("/api/extract", async (c) => {
    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: "Body must be JSON" }, 400);
      }
    }
    const parsed = ExtractRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid request", issues: formatIssues(parsed.error) }, 400);
    const job = jobs.submitExtract(async (ctx) => {
      try {
        await extractProject({ ...opts.extract, ...parsed.data, project, runner, log: (l) => ctx.log(l) });
      } finally {
        graphs.invalidate();
      }
    });
    return c.json({ jobId: job.id }, 202);
  });

  app.get("/api/jobs", (c) => c.json(jobs.list()));

  app.get("/api/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    return job ? c.json(job) : c.json({ error: "Unknown job" }, 404);
  });

  app.get("/api/jobs/:id/events", (c) => {
    const id = c.req.param("id");
    if (!jobs.get(id)) return c.json({ error: "Unknown job" }, 404);
    return streamSSE(c, async (stream) => {
      const queue: SSEMessage[] = [];
      let finished = false;
      let wake: (() => void) | null = null;
      const push = (m: SSEMessage): void => {
        queue.push(m);
        wake?.();
      };
      const unsubscribe = jobs.subscribe(
        id,
        (line) => push({ event: "log", data: line }),
        (job) => {
          push({ event: "done", data: JSON.stringify(job) });
          finished = true;
        },
      );
      stream.onAbort(() => {
        finished = true;
        wake?.();
      });
      try {
        while (!stream.aborted) {
          while (queue.length > 0 && !stream.aborted) await stream.writeSSE(queue.shift() as SSEMessage);
          if (finished) break;
          let timer: NodeJS.Timeout | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, 15_000);
          });
          clearTimeout(timer);
          wake = null;
          if (queue.length === 0 && !finished && !stream.aborted) await stream.write(": ping\n\n");
        }
      } finally {
        unsubscribe?.();
      }
    });
  });

  app.get("/api/results", async (c) => {
    const decl = c.req.query("decl");
    if (!decl) return c.json({ error: "Missing ?decl=" }, 400);
    const loaded = await graphs.get();
    if (loaded && !loaded.byId.has(decl)) return c.json({ error: `Unknown declaration: ${decl}` }, 404);
    return c.json(await readCachedResults(project, decl));
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // Static web app with SPA fallback.
  app.get("*", async (c) => {
    const indexFile = webDist ? path.join(webDist, "index.html") : null;
    if (!webDist || !indexFile || !existsSync(indexFile)) return c.html(MISSING_DIST_PAGE);
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path);
    } catch {
      return c.text("Bad path", 400);
    }
    rel = rel.replace(/^\/+/, "");
    if (rel.length > 0) {
      const res = await resolveInside(webDist, rel);
      if (res.kind === "ok" && statSync(res.file).isFile()) {
        const ext = path.extname(res.file).toLowerCase();
        const headers: Record<string, string> = { "content-type": MIME[ext] ?? "application/octet-stream" };
        if (/[\\/]assets[\\/]/.test(res.file)) headers["cache-control"] = "public, max-age=31536000, immutable";
        return c.body(new Uint8Array(await readFile(res.file)), 200, headers);
      }
      if (res.kind === "outside") return c.text("Forbidden", 403);
      // Missing asset: 404. Anything else (routes may contain Lean names like `Toy.main`) gets the SPA.
      const wantsHtml = (c.req.header("accept") ?? "").includes("text/html");
      if (MIME[path.extname(rel).toLowerCase()] && !wantsHtml) return c.text("Not found", 404);
    }
    return c.body(await readFile(indexFile, "utf8"), 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
  });

  return app;
}
