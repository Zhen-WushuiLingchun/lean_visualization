import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventSourceCtor } from "../src/api/client";
import { VerifyStore } from "../src/state/verifyStore";
import { CHECKERS_435, CHECKERS_NONE, CHECKERS_OLD, result, row } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

function store(checkers: VerifyStore["checkers"]): VerifyStore {
  const s = new VerifyStore();
  s.enabled = true;
  s.checkers = checkers;
  return s;
}

describe("checker requests", () => {
  it("asks for the available kernel checker on Lean 4.35+", () => {
    const s = store(CHECKERS_435);
    expect(s.kernelRequest()).toEqual(["leanchecker"]);
    expect(s.allRequest()).toEqual(["leanchecker", "lean4lean", "nanoda", "con-leche", "con-ron"]);
    expect(s.kernelUnavailable()).toBeNull();
  });

  it("falls back to module replay on older toolchains and never sends unavailable names", () => {
    const s = store(CHECKERS_OLD);
    expect(s.kernelRequest()).toEqual(["leanchecker-module"]);
    expect(s.allRequest()).toEqual(["leanchecker-module"]);
    expect(s.kernelUnavailable()).toBeNull();
  });

  it("explains why no kernel check can run, using the server notes", () => {
    const s = store(CHECKERS_NONE);
    expect(s.kernelRequest()).toEqual([]);
    expect(s.kernelUnavailable()).toContain("leanexport is missing");
    expect(s.kernelUnavailable()).toContain("toolchain not found");
    expect(s.allUnavailable()).not.toBeNull();
  });

  it("lets the server resolve requests when availability is unknown", () => {
    const s = store(null);
    expect(s.kernelRequest()).toBeNull();
    expect(s.allRequest()).toBe("all");
    expect(s.kernelUnavailable()).toBeNull();
  });
});

class DoneES {
  constructor(readonly url: string) {}
  addEventListener(type: string, cb: (ev: Event) => void): void {
    if (type !== "done") return;
    const done = {
      id: "j1",
      kind: "verify",
      decl: "Demo.x",
      status: "done",
      createdAt: "2026-09-27T10:00:00Z",
      startedAt: null,
      finishedAt: "2026-09-27T10:00:01Z",
      log: [],
      result: result([row("leanchecker-module", "accepted")], { exportDecls: null }),
      error: null,
    };
    setTimeout(() => cb(new MessageEvent("done", { data: JSON.stringify(done) })), 0);
  }
  close(): void {}
}

describe("verify", () => {
  it("posts exactly the available kernel checkers and stores the result", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ jobId: "j1" }), { status: 202 });
      }),
    );
    const s = store(CHECKERS_OLD);
    s.subscribeOptions = { EventSourceImpl: DoneES as unknown as EventSourceCtor };
    const r = await s.verify("Demo.x", s.kernelRequest());
    expect(bodies).toEqual([{ decl: "Demo.x", checkers: ["leanchecker-module"] }]);
    expect(r?.checkers[0]?.checker).toBe("leanchecker-module");
    expect(s.badge("Demo.x").kind).toBe("ok");
  });

  it("omits the field when availability is unknown and refuses an empty request", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ jobId: "j1" }), { status: 202 });
      }),
    );
    const unknown = store(null);
    unknown.subscribeOptions = { EventSourceImpl: DoneES as unknown as EventSourceCtor };
    await unknown.verify("Demo.x", unknown.kernelRequest());
    expect(bodies).toEqual([{ decl: "Demo.x" }]);

    const none = store(CHECKERS_NONE);
    expect(await none.verify("Demo.y", none.kernelRequest())).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(none.get("Demo.y").job?.error).toContain("leanexport is missing");
  });
});
