import { describe, expect, it } from "vitest";
import { runFrameWork } from "../src/graph/frameWork";

function clock() {
  let nextId = 0;
  let time = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const raf = (cb: FrameRequestCallback) => { const id = ++nextId; pending.set(id, cb); return id; };
  const cancel = (id: number) => { pending.delete(id); };
  const tick = () => {
    const jobs = [...pending.values()];
    pending.clear();
    jobs.forEach((cb) => cb(time));
  };
  return { raf, cancel, tick, now: () => time, advance: (ms: number) => { time += ms; }, pending: () => pending.size };
}

describe("cooperative edge work", () => {
  it("limits each frame and schedules no idle frame after completion", () => {
    const c = clock();
    const seen: number[] = [];
    let completed = 0;
    runFrameWork(10, (i) => seen.push(i), () => { completed++; }, { maxItemsPerFrame: 3, raf: c.raf, cancel: c.cancel, now: c.now });
    c.tick(); expect(seen).toEqual([0, 1, 2]); expect(c.pending()).toBe(1);
    c.tick(); c.tick(); c.tick();
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(completed).toBe(1);
    expect(c.pending()).toBe(0);
  });

  it("cancels stale frames before their remaining edges are processed", () => {
    const c = clock();
    const seen: number[] = [];
    let completed = false;
    const stop = runFrameWork(100, (i) => seen.push(i), () => { completed = true; }, { maxItemsPerFrame: 4, raf: c.raf, cancel: c.cancel, now: c.now });
    c.tick(); expect(seen).toHaveLength(4);
    stop(); c.tick();
    expect(seen).toHaveLength(4);
    expect(completed).toBe(false);
    expect(c.pending()).toBe(0);
  });

  it("yields after its time budget even below the item cap", () => {
    const c = clock();
    const seen: number[] = [];
    runFrameWork(500, (i) => { seen.push(i); c.advance(0.15); }, () => undefined, { maxItemsPerFrame: 500, budgetMs: 7, raf: c.raf, cancel: c.cancel, now: c.now });
    c.tick();
    expect(seen.length).toBe(64);
    expect(c.pending()).toBe(1);
  });
});
