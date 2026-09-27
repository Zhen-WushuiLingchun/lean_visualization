import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CheckerInfoSchema,
  GraphFileSchema,
  JobSchema,
  VerifyResultSchema,
  edgesOf,
  taintsFromAxioms,
  type GraphFile,
  type Job,
} from "@proofflow/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api.js";
import { JobManager } from "../src/jobs.js";
import { exeName } from "../src/project.js";
import {
  FIXTURES,
  FakeRunner,
  fakeProject,
  fakeToolchain,
  loadToyGraph,
  pipelineHandler,
  removeDir,
  tempDir,
} from "./helpers.js";

describe("toy-graph.json fixture", () => {
  const graph = loadToyGraph();

  it("is schema-valid", () => {
    const r = GraphFileSchema.safeParse(graph);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues.slice(0, 5))).toBe(true);
  });

  it("has consistent stats, unique ids and taints matching its axioms", () => {
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(graph.stats.nodes).toBe(graph.nodes.length);
    expect(graph.stats.localNodes).toBe(graph.nodes.filter((n) => n.isLocal).length);
    expect(graph.stats.externalNodes).toBe(graph.nodes.filter((n) => !n.isLocal).length);
    expect(graph.stats.edges).toBe(edgesOf(graph).length);
    for (const s of graph.stats.localSinks) expect(ids).toContain(s);
    for (const n of graph.nodes) {
      const flagTaints = n.taints.filter((t) => !["sorry", "nativeDecide", "customAxiom"].includes(t));
      expect(n.taints, n.id).toEqual(taintsFromAxioms(n.axioms, flagTaints));
    }
  });

  it("covers axiom/theorem/definition, local/external, sorry/custom taints", () => {
    const kinds = new Set(graph.nodes.map((n) => n.kind));
    for (const k of ["axiom", "theorem", "definition"] as const) expect(kinds.has(k)).toBe(true);
    expect(graph.nodes.some((n) => n.isLocal) && graph.nodes.some((n) => !n.isLocal)).toBe(true);
    const taints = new Set(graph.nodes.flatMap((n) => n.taints));
    expect(taints.has("sorry") && taints.has("customAxiom")).toBe(true);
  });
});

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("HTTP API", () => {
  let dir = "";
  let graph: GraphFile;
  let jobs: JobManager;
  let runner: FakeRunner;
  let app: ReturnType<typeof createApp>;
  let webDist = "";

  beforeEach(() => {
    dir = tempDir();
    graph = loadToyGraph();
    // A malicious-looking source path, to prove the server never reads outside the project.
    graph.nodes.push({
      ...graph.nodes.find((n) => n.id === "Toy.double")!,
      id: "Toy.escape",
      src: { file: "../outside.lean", line: 1, col: 0, endLine: 1, endCol: 1 },
    });
    const project = fakeProject(dir);
    mkdirSync(project.stateDir, { recursive: true });
    writeFileSync(path.join(project.stateDir, "graph.json"), JSON.stringify(graph));
    mkdirSync(path.join(dir, "Toy"), { recursive: true });
    writeFileSync(
      path.join(dir, "Toy", "Basic.lean"),
      ["namespace Toy", "", "def double (n : Nat) : Nat :=", "  n + n", "", "theorem double_eq (n : Nat) : double n = n + n :=", "  rfl", ""].join("\r\n"),
    );
    writeFileSync(path.join(path.dirname(dir), "outside.lean"), "secret");
    const toolchain = fakeToolchain(dir, ["leanchecker", "nanoda", "con-leche"]);
    runner = new FakeRunner(pipelineHandler(toolchain));
    jobs = new JobManager();
    webDist = path.join(dir, "web-dist");
    app = createApp({ project, runner, jobs, toolchain, webDist });
  });
  afterEach(() => removeDir(dir));

  it("GET /api/graph returns the validated graph", async () => {
    const res = await app.request("/api/graph");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = GraphFileSchema.parse(await res.json());
    expect(body.nodes).toHaveLength(graph.nodes.length);
  });

  it("GET /api/graph is 404 before extraction and 500 with issues when invalid", async () => {
    const empty = tempDir();
    try {
      const project = fakeProject(empty);
      const a = createApp({ project, runner, webDist: null, toolchain: fakeToolchain(empty) });
      expect((await a.request("/api/graph")).status).toBe(404);
      mkdirSync(project.stateDir, { recursive: true });
      writeFileSync(path.join(project.stateDir, "graph.json"), JSON.stringify({ meta: {}, nodes: [] }));
      const res = await a.request("/api/graph");
      expect(res.status).toBe(500);
      const body = await json<{ issues: string[] }>(res);
      expect(body.issues.length).toBeGreaterThan(0);
      expect(body.issues.length).toBeLessThanOrEqual(10);
    } finally {
      removeDir(empty);
    }
  });

  it("GET /api/source returns the declaration's lines for local nodes only", async () => {
    const res = await app.request(`/api/source?decl=${encodeURIComponent("Toy.double")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ file: "Toy/Basic.lean", line: 3, endLine: 4, text: "def double (n : Nat) : Nat :=\n  n + n" });
    expect((await app.request("/api/source?decl=propext")).status).toBe(404);
    expect((await app.request("/api/source?decl=nope")).status).toBe(404);
    expect((await app.request("/api/source?decl=Toy.main")).status).toBe(404); // file missing
    expect((await app.request("/api/source")).status).toBe(400);
  });

  it("GET /api/source never reads outside the project", async () => {
    const res = await app.request("/api/source?decl=Toy.escape");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("secret");
  });

  it("GET /api/checkers lists every checker with availability", async () => {
    const res = await app.request("/api/checkers");
    const infos = CheckerInfoSchema.array().parse(await res.json());
    expect(infos).toHaveLength(6);
    expect(infos.filter((i) => i.available).map((i) => i.checker)).toEqual(["leanchecker", "nanoda", "con-leche"]);
  });

  it("POST /api/verify validates the body and the declaration", async () => {
    const post = (body: string) => app.request("/api/verify", { method: "POST", body, headers: { "content-type": "application/json" } });
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ decl: "" }))).status).toBe(400);
    expect((await post(JSON.stringify({ decl: "Toy.main", checkers: ["bogus"] }))).status).toBe(400);
    expect((await post(JSON.stringify({ decl: "Nope.nothing" }))).status).toBe(404);
    expect(runner.calls).toHaveLength(0);
  });

  it("POST /api/verify runs a job; /api/jobs, /api/jobs/:id and /api/results reflect it", async () => {
    const res = await app.request("/api/verify", {
      method: "POST",
      body: JSON.stringify({ decl: "Toy.clean_lemma", checkers: ["leanchecker", "con-leche"] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(202);
    const { jobId } = await json<{ jobId: string }>(res);
    const done = await jobs.wait(jobId);
    expect(done.status).toBe("done");
    expect(done.result?.verdict).toBe("accepted");

    const job = JobSchema.parse(await (await app.request(`/api/jobs/${jobId}`)).json());
    expect(job.kind).toBe("verify");
    expect(job.decl).toBe("Toy.clean_lemma");
    expect(job.log.some((l) => l.includes("leanchecker: accepted"))).toBe(true);
    expect(JobSchema.array().parse(await (await app.request("/api/jobs")).json()).map((j) => j.id)).toContain(jobId);
    expect((await app.request("/api/jobs/nope")).status).toBe(404);

    const results = VerifyResultSchema.array().parse(
      await (await app.request(`/api/results?decl=${encodeURIComponent("Toy.clean_lemma")}`)).json(),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.checkers.map((c) => c.checker)).toEqual(["leanchecker", "con-leche"]);
    expect(await (await app.request("/api/results?decl=Toy.main")).json()).toEqual([]);
    expect((await app.request("/api/results?decl=nope")).status).toBe(404);
  });

  it('POST /api/verify with checkers: "all" runs exactly the available checkers', async () => {
    // The fake toolchain has leanchecker, nanoda and con-leche; the other three are missing.
    const res = await app.request("/api/verify", {
      method: "POST",
      body: JSON.stringify({ decl: "Toy.double_eq", checkers: "all" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(202);
    const { jobId } = await json<{ jobId: string }>(res);
    const done = await jobs.wait(jobId);
    expect(done.status).toBe("done");
    expect(done.result?.checkers.map((c) => c.checker)).toEqual(["leanchecker", "nanoda", "con-leche"]);
    expect(done.result?.checkers.some((c) => c.status === "unavailable")).toBe(false);
    expect(done.result?.verdict).toBe("accepted");
    expect(runner.callsTo("lean4lean")).toHaveLength(0);
    const bad = await app.request("/api/verify", {
      method: "POST",
      body: JSON.stringify({ decl: "Toy.double_eq", checkers: "some" }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  it("GET /api/jobs/:id/events streams log lines and a final done event", async () => {
    const res = await app.request("/api/verify", {
      method: "POST",
      body: JSON.stringify({ decl: "Toy.double_eq" }),
      headers: { "content-type": "application/json" },
    });
    const { jobId } = await json<{ jobId: string }>(res);
    const sse = await app.request(`/api/jobs/${jobId}/events`);
    expect(sse.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await sse.text();
    expect(text).toMatch(/event: log\ndata: export Toy\.double_eq from Toy\.Basic/);
    const doneBlock = text.split("\n\n").find((b) => b.startsWith("event: done"));
    expect(doneBlock).toBeDefined();
    const job = JobSchema.parse(JSON.parse((doneBlock ?? "").replace(/^event: done\ndata: /, "")) as Job);
    expect(job.status).toBe("done");
    expect(job.result?.verdict).toBe("accepted");
    // A finished job replays its log and done event.
    const again = await (await app.request(`/api/jobs/${jobId}/events`)).text();
    expect(again).toContain("event: done");
    expect((await app.request("/api/jobs/nope/events")).status).toBe(404);
  });

  it("allows the Vite dev server origin", async () => {
    const res = await app.request("/api/graph", { headers: { origin: "http://localhost:5173" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await app.request("/api/graph", { headers: { origin: "http://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).not.toBe("http://evil.example");
  });

  it("POST /api/extract runs the extractor as a job and reloads the graph", async () => {
    const lakeDir = path.join(dir, "lakebin");
    mkdirSync(lakeDir, { recursive: true });
    const lake = path.join(lakeDir, exeName("lake"));
    writeFileSync(lake, "", { mode: 0o755 });
    const script = path.join(dir, "Extract.lean");
    writeFileSync(script, "def main : IO Unit := pure ()\n");
    const small = loadToyGraph();
    small.nodes = small.nodes.filter((n) => n.id !== "Toy.main");
    small.stats.nodes = small.nodes.length;
    const extractRunner = new FakeRunner(({ args }) => {
      if (args[0] === "build") return { exitCode: 0, stdout: "Build completed successfully.\n" };
      const out = args[args.indexOf("--out") + 1] ?? "";
      return { exitCode: 0, stderr: "extracting\n", effect: () => writeFileSync(out, JSON.stringify(small)) };
    });
    const project = fakeProject(dir);
    const a = createApp({
      project,
      runner: extractRunner,
      jobs,
      webDist: null,
      toolchain: fakeToolchain(dir),
      extract: { scriptPath: script, env: { PATH: lakeDir } },
    });
    expect((await a.request("/api/extract", { method: "POST", body: "{bad" })).status).toBe(400);
    const res = await a.request("/api/extract", { method: "POST", body: JSON.stringify({ build: false }) });
    expect(res.status).toBe(202);
    const { jobId } = await json<{ jobId: string }>(res);
    const done = await jobs.wait(jobId);
    expect(done.error).toBeNull();
    expect(done.status).toBe("done");
    expect(done.log).toContain("extracting");
    expect(extractRunner.calls.map((c) => c.args[0])).toEqual(["env"]);
    const g = GraphFileSchema.parse(await (await a.request("/api/graph")).json());
    expect(g.nodes.some((n) => n.id === "Toy.main")).toBe(false);
  });

  it("serves a plain page when the web app is not built, and JSON 404 for unknown API routes", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pnpm build");
    const api = await app.request("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "Not found" });
  });

  it("serves the built web app with SPA fallback", async () => {
    mkdirSync(path.join(webDist, "assets"), { recursive: true });
    writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>ProofFlow app</title>");
    writeFileSync(path.join(webDist, "assets", "app-123.js"), "console.log(1)");
    const index = await app.request("/");
    expect(await index.text()).toContain("ProofFlow app");
    const deep = await app.request("/cone/Toy.main");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("ProofFlow app");
    const js = await app.request("/assets/app-123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(await js.text()).toBe("console.log(1)");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    const escape = await app.request("/%2e%2e/%2e%2e/graph.json");
    expect(escape.status).not.toBe(200);
  });
});

async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("extraction is exclusive with verification", () => {
  let dir = "";
  afterEach(() => removeDir(dir));

  it("extract waits for a running verify; a later verify waits for the extract", async () => {
    dir = tempDir();
    const project = fakeProject(dir);
    mkdirSync(project.stateDir, { recursive: true });
    const graphText = JSON.stringify(loadToyGraph());
    writeFileSync(path.join(project.stateDir, "graph.json"), graphText);
    const lakeDir = path.join(dir, "lakebin");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(path.join(lakeDir, exeName("lake")), "", { mode: 0o755 });
    const script = path.join(dir, "Extract.lean");
    writeFileSync(script, "def main : IO Unit := pure ()\n");

    const toolchain = fakeToolchain(dir, ["leanchecker"]);
    const base = pipelineHandler(toolchain);
    const events: string[] = [];
    let releaseVerify: () => void = () => {};
    let releaseExtract: () => void = () => {};
    const verifyGate = new Promise<void>((r) => (releaseVerify = r));
    const extractGate = new Promise<void>((r) => (releaseExtract = r));
    const runner = new FakeRunner(async (call) => {
      const { args } = call;
      if (args[0] === "env" && args[1] === "lean") {
        events.push("extract:start");
        await extractGate;
        events.push("extract:end");
        const out = args[args.indexOf("--out") + 1] ?? "";
        return { exitCode: 0, effect: () => writeFileSync(out, graphText) };
      }
      if (args[1] === "leanexport") {
        const decl = args[args.length - 1] ?? "";
        events.push(`export:${decl}:start`);
        if (decl === "Toy.double_eq") await verifyGate;
        events.push(`export:${decl}:end`);
      } else {
        events.push(`check:${path.basename(call.cmd)}`);
      }
      return base(call);
    });
    const jobs = new JobManager();
    const app = createApp({
      project,
      runner,
      jobs,
      toolchain,
      webDist: null,
      extract: { scriptPath: script, env: { PATH: lakeDir }, build: false },
    });
    const post = async (url: string, body: unknown): Promise<string> => {
      const res = await app.request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(202);
      return (await json<{ jobId: string }>(res)).jobId;
    };

    const v1 = await post("/api/verify", { decl: "Toy.double_eq" });
    await waitFor(() => events.includes("export:Toy.double_eq:start"), "first verify to start");
    const ex = await post("/api/extract", {});
    await new Promise((r) => setTimeout(r, 30));
    expect(jobs.get(ex)?.status).toBe("queued");
    const v2 = await post("/api/verify", { decl: "Toy.clean_lemma" });
    await new Promise((r) => setTimeout(r, 30));
    expect(jobs.get(v2)?.status).toBe("queued");
    expect(events).toEqual(["export:Toy.double_eq:start"]);

    releaseVerify();
    await waitFor(() => events.includes("extract:start"), "extraction to start");
    expect(jobs.get(v1)?.status).toBe("done");
    expect(jobs.get(ex)?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 30));
    expect(jobs.get(v2)?.status).toBe("queued");
    expect(events.some((e) => e.startsWith("export:Toy.clean_lemma"))).toBe(false);

    releaseExtract();
    const [d1, dx, d2] = await Promise.all([jobs.wait(v1), jobs.wait(ex), jobs.wait(v2)]);
    expect([d1.status, dx.status, d2.status]).toEqual(["done", "done", "done"]);
    const at = (e: string): number => events.indexOf(e);
    expect(at("export:Toy.double_eq:end")).toBeLessThan(at("extract:start"));
    expect(events.lastIndexOf("check:" + path.basename(checkerBin(toolchain))) >= 0).toBe(true);
    expect(events.indexOf("check:" + path.basename(checkerBin(toolchain)))).toBeLessThan(at("extract:start"));
    expect(at("extract:end")).toBeLessThan(at("export:Toy.clean_lemma:start"));
    expect(dx.startedAt! >= d1.finishedAt!).toBe(true);
    expect(d2.startedAt! >= dx.finishedAt!).toBe(true);
  });
});

function checkerBin(toolchain: { binDir: string }): string {
  return path.join(toolchain.binDir, exeName("leanchecker"));
}

describe("fixture file", () => {
  it("is valid JSON on disk", () => {
    expect(() => JSON.parse(readFileSync(path.join(FIXTURES, "toy-graph.json"), "utf8"))).not.toThrow();
  });
});
