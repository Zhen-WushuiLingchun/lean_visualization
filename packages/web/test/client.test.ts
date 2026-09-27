import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@proofflow/schema";
import {
  ApiError,
  fetchGraph,
  fetchResults,
  parseGraphFile,
  parseJobEvent,
  parseSourceSnippet,
  parseVerifyStart,
  postVerify,
  subscribeJob,
  type EventSourceCtor,
} from "../src/api/client";
import { result, row, sample } from "./fixtures";

function job(extra: Partial<Job> = {}): Job {
  return {
    id: "j1",
    kind: "verify",
    decl: "Demo.x",
    status: "running",
    createdAt: "2026-09-27T10:00:00Z",
    startedAt: "2026-09-27T10:00:01Z",
    finishedAt: null,
    log: [],
    result: null,
    error: null,
    ...extra,
  };
}

function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(routes)) if (url.startsWith(prefix)) return handler(init);
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("graph loading", () => {
  it("validates /api/graph with the schema", async () => {
    mockFetch({ "/api/graph": () => json(sample) });
    const g = await fetchGraph();
    expect(g.nodes).toHaveLength(sample.nodes.length);
  });
  it("rejects an invalid graph with readable issues", async () => {
    mockFetch({ "/api/graph": () => json({ ...sample, meta: { ...sample.meta, schemaVersion: 2 } }) });
    await expect(fetchGraph()).rejects.toThrow(/meta.schemaVersion/);
  });
  it("turns HTTP errors and HTML fallbacks into ApiError", async () => {
    mockFetch({ "/api/graph": () => new Response("<!doctype html><html></html>", { status: 200 }) });
    await expect(fetchGraph()).rejects.toBeInstanceOf(ApiError);
    mockFetch({ "/api/graph": () => json({ error: "no graph.json, run extract" }, 404) });
    await expect(fetchGraph()).rejects.toThrow("no graph.json, run extract");
  });
  it("reports parse issues for dropped files", () => {
    const r = parseGraphFile({ meta: {}, nodes: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("results, source and verify", () => {
  it("keeps valid cached results, newest first", async () => {
    const a = result([row("leanchecker", "accepted")], { verifiedAt: "2026-09-27T09:00:00Z" });
    const b = result([row("leanchecker", "rejected")], { verifiedAt: "2026-09-27T11:00:00Z" });
    const f = mockFetch({ "/api/results": () => json([a, { junk: true }, b]) });
    const rs = await fetchResults("Demo.«weird name»");
    expect(rs.map((r) => r.verifiedAt)).toEqual([b.verifiedAt, a.verifiedAt]);
    expect(String(f.mock.calls[0]?.[0])).toBe(`/api/results?decl=${encodeURIComponent("Demo.«weird name»")}`);
  });
  it("parses source snippets", () => {
    expect(parseSourceSnippet({ file: "Demo/Basic.lean", line: 3, endLine: 5, text: "theorem x" })).toEqual({ file: "Demo/Basic.lean", line: 3, endLine: 5, text: "theorem x" });
    expect(parseSourceSnippet({ file: 1 })).toBeNull();
  });
  it("accepts several shapes of the verify response", async () => {
    expect(parseVerifyStart({ jobId: "abc" })).toEqual({ jobId: "abc", job: null });
    expect(parseVerifyStart({ id: "abc" })?.jobId).toBe("abc");
    expect(parseVerifyStart({ job: job({ id: "zz" }) })?.jobId).toBe("zz");
    expect(parseVerifyStart({})).toBeNull();
    const f = mockFetch({ "/api/verify": () => json({ jobId: "j9" }) });
    await expect(postVerify({ decl: "Demo.x", checkers: ["leanchecker"] })).resolves.toEqual({ jobId: "j9", job: null });
    const init = f.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ decl: "Demo.x", checkers: ["leanchecker"] });
  });
});

describe("SSE event parsing", () => {
  const done = job({ status: "done", result: result([row("leanchecker", "accepted")]), finishedAt: "2026-09-27T10:00:05Z" });
  it("reads log lines as plain text or JSON", () => {
    expect(parseJobEvent("log", "export done")).toEqual({ type: "log", lines: ["export done"] });
    expect(parseJobEvent("log", JSON.stringify("a\nb"))).toEqual({ type: "log", lines: ["a", "b"] });
    expect(parseJobEvent("log", JSON.stringify({ line: "x" }))).toEqual({ type: "log", lines: ["x"] });
  });
  it("reads done as a Job, a VerifyResult, or a wrapper", () => {
    const a = parseJobEvent("done", JSON.stringify(done));
    expect(a.type === "done" && a.result?.checkers[0]?.status).toBe("accepted");
    const b = parseJobEvent("done", JSON.stringify(done.result));
    expect(b.type === "done" && b.result?.decl).toBe("Demo.x");
    const c = parseJobEvent("done", JSON.stringify({ job: done }));
    expect(c.type === "done" && c.job?.id).toBe("j1");
    const failed = parseJobEvent("done", JSON.stringify(job({ status: "failed", error: "leanexport crashed" })));
    expect(failed.type === "done" && failed.error).toBe("leanexport crashed");
  });
  it("reads typed unnamed messages and status snapshots", () => {
    expect(parseJobEvent("message", JSON.stringify({ type: "log", data: "hello" }))).toEqual({ type: "log", lines: ["hello"] });
    expect(parseJobEvent("status", JSON.stringify(job())).type).toBe("status");
    expect(parseJobEvent("status", JSON.stringify(done)).type).toBe("done");
    expect(parseJobEvent("error", JSON.stringify({ message: "boom" }))).toEqual({ type: "error", message: "boom" });
    expect(parseJobEvent("ping", "{}")).toEqual({ type: "ignore" });
  });
});

class FakeES {
  static last: FakeES | null = null;
  listeners = new Map<string, ((ev: Event) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeES.last = this;
  }
  addEventListener(type: string, cb: (ev: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: string): void {
    const ev = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

describe("subscribeJob", () => {
  it("streams log lines and finishes on done", () => {
    const logs: string[] = [];
    const onDone = vi.fn();
    subscribeJob("j1", { onLog: (l) => logs.push(...l), onDone }, { EventSourceImpl: FakeES as unknown as EventSourceCtor });
    const es = FakeES.last as FakeES;
    expect(es.url).toBe("/api/jobs/j1/events");
    es.emit("log", "leanexport Demo -- Demo.x");
    es.emit("log", "leanchecker: accepted");
    es.emit("done", JSON.stringify(job({ status: "done", result: result([row("leanchecker", "accepted")]) })));
    expect(logs).toEqual(["leanexport Demo -- Demo.x", "leanchecker: accepted"]);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0]?.[0].result.checkers[0].status).toBe("accepted");
    expect(es.closed).toBe(true);
    es.emit("log", "late");
    expect(logs).toHaveLength(2);
  });

  it("falls back to polling when the stream drops before done", async () => {
    const final = job({ status: "done", log: ["a", "b"], result: result([row("leanchecker", "accepted")]) });
    mockFetch({ "/api/jobs/j2": () => json(final) });
    const replaced: string[][] = [];
    const done = new Promise<unknown>((resolve) => {
      subscribeJob("j2", { onLog: () => undefined, onLogReplace: (l) => replaced.push(l), onDone: resolve }, { EventSourceImpl: FakeES as unknown as EventSourceCtor, pollMs: 5 });
    });
    (FakeES.last as FakeES).emit("error");
    const d = (await done) as { result: { checkers: { status: string }[] } };
    expect(d.result.checkers[0]?.status).toBe("accepted");
    expect(replaced).toEqual([["a", "b"]]);
  });
});
