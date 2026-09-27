import { describe, expect, it } from "vitest";
import { JobManager, Limiter, RWLock } from "../src/jobs.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("Limiter", () => {
  it("bounds concurrency", async () => {
    const l = new Limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        l.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe("RWLock", () => {
  it("shares reads, excludes writes, and makes later readers wait behind a queued writer", async () => {
    const lock = new RWLock();
    const order: string[] = [];
    let releaseR1: () => void = () => {};
    const r1 = lock.read(async () => {
      order.push("r1:start");
      await new Promise<void>((r) => (releaseR1 = r));
      order.push("r1:end");
    });
    const r2 = lock.read(async () => {
      order.push("r2");
    });
    await tick();
    const w = lock.write(async () => {
      order.push("w:start");
      await tick(10);
      order.push("w:end");
    });
    const r3 = lock.read(async () => {
      order.push("r3");
    });
    await tick();
    expect(order).toEqual(["r1:start", "r2"]);
    expect(lock.activeReaders).toBe(1);
    releaseR1();
    await Promise.all([r1, r2, w, r3]);
    expect(order).toEqual(["r1:start", "r2", "r1:end", "w:start", "w:end", "r3"]);
    expect(lock.activeReaders).toBe(0);
    expect(lock.writing).toBe(false);
  });

  it("releases the lock when the body throws", async () => {
    const lock = new RWLock();
    await expect(lock.write(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await lock.write(async () => undefined);
    expect(lock.writing).toBe(false);
  });
});

describe("JobManager", () => {
  it("runs extraction serially and records status, timestamps and errors", async () => {
    const jobs = new JobManager();
    let running = 0;
    let peak = 0;
    const slow = async () => {
      running++;
      peak = Math.max(peak, running);
      await tick(10);
      running--;
    };
    // The same key deduplicates; use verify jobs to check the queue bound, extract for serial.
    const a = jobs.submitExtract(slow);
    const b = jobs.submitExtract(slow);
    expect(b.id).toBe(a.id); // one active extraction at a time
    const done = await jobs.wait(a.id);
    expect(done.status).toBe("done");
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(peak).toBe(1);

    const failing = jobs.submitExtract(async () => {
      throw new Error("boom");
    });
    const f = await jobs.wait(failing.id);
    expect(f.status).toBe("failed");
    expect(f.error).toBe("boom");
    expect(f.log.at(-1)).toBe("error: boom");
  });

  it("bounds verification concurrency and deduplicates identical active requests", async () => {
    const jobs = new JobManager({ verifyConcurrency: 2 });
    let running = 0;
    let peak = 0;
    const ids = Array.from({ length: 5 }, (_, i) =>
      jobs.submitVerify(`d${i}`, async () => {
        running++;
        peak = Math.max(peak, running);
        await tick(10);
        running--;
        return null;
      }).id,
    );
    const dupA = jobs.submitVerify("x", async () => null, "same");
    const dupB = jobs.submitVerify("x", async () => null, "same");
    expect(dupB.id).toBe(dupA.id);
    await Promise.all(ids.map((id) => jobs.wait(id)));
    expect(peak).toBe(2);
  });

  it("keeps a bounded log tail and emits log/done events to subscribers", async () => {
    const jobs = new JobManager({ logLimit: 3 });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const job = jobs.submitVerify("d", async (ctx) => {
      for (let i = 0; i < 5; i++) ctx.log(`line ${i}`);
      await gate;
      ctx.log("after");
      return null;
    });
    await tick();
    const seen: string[] = [];
    let doneStatus = "";
    const unsub = jobs.subscribe(
      job.id,
      (l) => seen.push(l),
      (j) => (doneStatus = j.status),
    );
    expect(seen).toEqual(["line 2", "line 3", "line 4"]);
    release();
    await jobs.wait(job.id);
    expect(seen.at(-1)).toBe("after");
    expect(doneStatus).toBe("done");
    unsub?.();
    expect(jobs.get(job.id)?.log).toEqual(["line 3", "line 4", "after"]);
    expect(jobs.subscribe("missing", () => {}, () => {})).toBeNull();
  });

  it("returns snapshots that callers cannot mutate", async () => {
    const jobs = new JobManager();
    const job = jobs.submitVerify("d", async (ctx) => {
      ctx.log("x");
      return null;
    });
    await jobs.wait(job.id);
    const snap = jobs.get(job.id);
    snap?.log.push("tamper");
    expect(jobs.get(job.id)?.log).toEqual(["x"]);
  });
});
