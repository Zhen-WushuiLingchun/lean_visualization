import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckerName, VerifyResult } from "@proofflow/schema";
import { VerifyStore } from "../src/state/verifyStore";
import { CHECKERS_435, result, row } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const store = new VerifyStore();
  store.enabled = true;
  store.checkers = CHECKERS_435;
  return store;
}

function completed(decl: string, value: VerifyResult) {
  return new Response(JSON.stringify({ jobId: decl, job: {
    id: decl, kind: "verify", decl, status: "done", createdAt: value.verifiedAt,
    startedAt: null, finishedAt: value.verifiedAt, log: ["Full server log"], result: value, error: null,
  } }), { status: 202 });
}

describe("whole graph verification queue", () => {
  it("submits every unique declaration even with an accepted browser cache", async () => {
    const s = setup();
    const submitted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("/api/results")) return new Response(JSON.stringify([result([row("leanchecker", "accepted")])]));
      const body = JSON.parse(String(init?.body)) as { decl: string; checkers: CheckerName[]; force?: boolean };
      submitted.push(body.decl);
      expect(body.force).toBeUndefined();
      return completed(body.decl, result(body.checkers.map((c) => row(c, "accepted")), { decl: body.decl }));
    }));
    await s.loadCached("Demo.x");
    const run = await s.runAll(["Demo.x", "Demo.aux", "External.x", "Demo.x"], s.allRequest());
    expect(submitted).toEqual(["Demo.x", "Demo.aux", "External.x"]);
    expect(run).toMatchObject({ scope: "all", total: 3, done: 3, finished: true, reused: 0, outcomes: { ok: 3 } });
    expect(s.get("Demo.x").job?.log).toEqual([]);
  });

  it("runs serially and stops after the active job without claiming completion", async () => {
    const s = setup();
    let finish!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const running = s.runAll(["A", "B"], ["leanchecker"], "all", 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await s.runAll(["C"], ["leanchecker"])).toBeNull();
    expect(await s.runCone(["C"], ["leanchecker"])).toBeNull();
    s.cancelCone();
    expect(s.coneRun).toMatchObject({ current: "A", cancelled: true, finished: false });
    finish(completed("A", result([row("leanchecker", "accepted")], { decl: "A" })));
    expect(await running).toMatchObject({ done: 1, total: 2, cancelled: true, finished: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("waits for an existing narrower request then submits the full requested checker set", async () => {
    const s = setup();
    let finish!: (r: Response) => void;
    const bodies: { decl: string; checkers: CheckerName[] }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { decl: string; checkers: CheckerName[] };
      bodies.push(body);
      if (bodies.length === 1) return new Promise<Response>((resolve) => { finish = resolve; });
      return completed(body.decl, result(body.checkers.map((c) => row(c, "accepted")), { decl: body.decl }));
    }));
    const manual = s.verify("A", ["leanchecker"]);
    const batch = s.runAll(["A"], s.allRequest());
    expect(bodies).toHaveLength(1);
    finish(completed("A", result([row("leanchecker", "accepted")], { decl: "A" })));
    await manual;
    expect(await batch).toMatchObject({ done: 1, outcomes: { ok: 1 } });
    expect(bodies.map((b) => b.checkers)).toEqual([["leanchecker"], s.allRequest()]);
  });

  it("continues after failures and counts declines or missing requested rows as incomplete", async () => {
    const s = setup();
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { decl } = JSON.parse(String(init?.body)) as { decl: string };
      if (decl === "error") return new Response("failure", { status: 500 });
      const rows = [row("leanchecker", "accepted")];
      if (decl !== "missing") rows.push(row("con-leche", decl === "declined" ? "declined" : "rejected"));
      return completed(decl, result(rows, { decl }));
    }));
    const run = await s.runAll(["declined", "error", "missing", "rejected"], ["leanchecker", "con-leche"], "local");
    expect(run).toMatchObject({ scope: "local", done: 4, outcomes: { ok: 0, dash: 2, error: 1, rejected: 1 } });
  });

  it("refuses standalone or empty-checker requests", async () => {
    const s = setup();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await s.runAll(["A"], [])).toBeNull();
    s.enabled = false;
    expect(await s.runAll(["A"], ["leanchecker"])).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reset prevents the old batch from submitting further nodes or restoring progress", async () => {
    const s = setup();
    let finish!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const batch = s.runAll(["A", "B"], ["leanchecker"], "all", 1);
    s.reset();
    finish(completed("A", result([row("leanchecker", "accepted")], { decl: "A" })));
    await batch;
    expect(s.coneRun).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps at most two jobs in flight and refills the first free slot", async () => {
    const s = setup();
    const finish = new Map<string, (value: VerifyResult) => void>();
    const started: string[] = [];
    let peak = 0;
    vi.spyOn(s, "verify").mockImplementation((decl) => new Promise((resolve) => {
      started.push(decl);
      finish.set(decl, (value) => resolve(value));
      peak = Math.max(peak, finish.size);
    }));
    const batch = s.runAll(["A", "B", "C", "D"], ["leanchecker"]);
    expect(started).toEqual(["A", "B"]);
    expect(s.coneRun).toMatchObject({ active: ["A", "B"], maxInFlight: 2, done: 0 });
    const firstSnapshot = s.coneRun;
    finish.get("B")?.(result([row("leanchecker", "accepted")], { decl: "B" }));
    finish.delete("B");
    await vi.waitFor(() => expect(started).toEqual(["A", "B", "C"]));
    expect(s.coneRun).toMatchObject({ active: ["A", "C"], done: 1 });
    expect(firstSnapshot?.active).toEqual(["A", "B"]);
    finish.get("A")?.(result([row("leanchecker", "accepted")], { decl: "A" }));
    finish.delete("A");
    await vi.waitFor(() => expect(started).toEqual(["A", "B", "C", "D"]));
    for (const decl of ["C", "D"]) finish.get(decl)?.(result([row("leanchecker", "accepted")], { decl }));
    const run = await batch;
    expect(peak).toBe(2);
    expect(run).toMatchObject({ done: 4, finished: true, active: [], outcomes: { ok: 4 } });
  });

  it("stops new submissions and waits for both active jobs", async () => {
    const s = setup();
    const finish = new Map<string, (value: VerifyResult) => void>();
    const started: string[] = [];
    vi.spyOn(s, "verify").mockImplementation((decl) => new Promise((resolve) => {
      started.push(decl);
      finish.set(decl, resolve);
    }));
    const batch = s.runAll(["A", "B", "C"], ["leanchecker"]);
    expect(started).toEqual(["A", "B"]);
    s.cancelCone();
    finish.get("B")?.(result([row("leanchecker", "accepted")], { decl: "B" }));
    await vi.waitFor(() => expect(s.coneRun?.done).toBe(1));
    expect(started).toEqual(["A", "B"]);
    expect(s.coneRun?.active).toEqual(["A"]);
    finish.get("A")?.(result([row("leanchecker", "accepted")], { decl: "A" }));
    expect(await batch).toMatchObject({ done: 2, total: 3, cancelled: true, finished: true, active: [] });
    expect(started).toEqual(["A", "B"]);
  });

  it("counts a thrown worker as an error and continues the queue", async () => {
    const s = setup();
    const verify = vi.spyOn(s, "verify").mockImplementation(async (decl) => {
      if (decl === "A") throw new Error("worker failed");
      return result([row("leanchecker", "accepted")], { decl });
    });
    const run = await s.runAll(["A", "B", "C"], ["leanchecker"]);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(run).toMatchObject({ done: 3, finished: true, outcomes: { error: 1, ok: 2 } });
  });
});
