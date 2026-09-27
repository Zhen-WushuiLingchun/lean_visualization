import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Job, VerifyResult } from "@proofflow/schema";

export const LOG_LIMIT = 500;

/** Runs at most `limit` tasks at once; the rest wait in FIFO order. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly limit: number) {}
  get pending(): number {
    return this.waiting.length;
  }
  get running(): number {
    return this.active;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Async read/write lock, FIFO with writer preference: once a writer is waiting, later readers
 * queue behind it, so an extraction is never starved by a stream of verifications.
 */
export class RWLock {
  private readers = 0;
  private writer = false;
  private readonly queue: Array<{ write: boolean; grant: () => void }> = [];

  get activeReaders(): number {
    return this.readers;
  }
  get writing(): boolean {
    return this.writer;
  }

  read<T>(fn: () => Promise<T>): Promise<T> {
    return this.with(false, fn);
  }

  write<T>(fn: () => Promise<T>): Promise<T> {
    return this.with(true, fn);
  }

  private async with<T>(write: boolean, fn: () => Promise<T>): Promise<T> {
    await this.acquire(write);
    try {
      return await fn();
    } finally {
      if (write) this.writer = false;
      else this.readers--;
      this.drain();
    }
  }

  private canGrant(write: boolean): boolean {
    return write ? !this.writer && this.readers === 0 : !this.writer;
  }

  private take(write: boolean): void {
    if (write) this.writer = true;
    else this.readers++;
  }

  private acquire(write: boolean): Promise<void> {
    if (this.queue.length === 0 && this.canGrant(write)) {
      this.take(write);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push({ write, grant: resolve }));
  }

  private drain(): void {
    for (;;) {
      const head = this.queue[0];
      if (!head || !this.canGrant(head.write)) return;
      this.queue.shift();
      this.take(head.write);
      head.grant();
      if (head.write) return;
    }
  }
}

export interface JobContext {
  readonly id: string;
  log(line: string): void;
}

export type JobFn = (ctx: JobContext) => Promise<VerifyResult | null>;

export interface JobEvents {
  log: [line: string];
  done: [job: Job];
}

interface JobRecord {
  job: Job;
  emitter: EventEmitter<JobEvents>;
  key: string | null;
  finished: Promise<Job>;
}

export interface JobManagerOptions {
  verifyConcurrency?: number;
  logLimit?: number;
  /** Finished jobs kept in memory. */
  maxFinished?: number;
  /** Mirror job log lines somewhere (the CLI prints them). */
  onLog?: (job: Job, line: string) => void;
}

/**
 * In-memory job registry. Extraction jobs run one at a time and exclusively: verifications wait
 * while an extraction runs, and an extraction waits for running verifications to finish.
 * Verification jobs run with bounded concurrency. Each job has an emitter with `log` and `done`
 * events for SSE.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly lock = new RWLock();
  private readonly extractQueue = new Limiter(1);
  private readonly verifyQueue: Limiter;
  private readonly logLimit: number;
  private readonly maxFinished: number;

  constructor(private readonly opts: JobManagerOptions = {}) {
    this.verifyQueue = new Limiter(opts.verifyConcurrency ?? 2);
    this.logLimit = opts.logLimit ?? LOG_LIMIT;
    this.maxFinished = opts.maxFinished ?? 200;
  }

  submitVerify(decl: string, fn: JobFn, dedupeKey?: string): Job {
    return this.submit("verify", decl, fn, dedupeKey ?? null);
  }

  /** At most one extraction is queued or running; a second request returns the active job. */
  submitExtract(fn: (ctx: JobContext) => Promise<void>): Job {
    return this.submit(
      "extract",
      null,
      async (ctx) => {
        await fn(ctx);
        return null;
      },
      "extract",
    );
  }

  private submit(kind: Job["kind"], decl: string | null, fn: JobFn, key: string | null): Job {
    if (key !== null) {
      for (const rec of this.jobs.values()) {
        if (rec.key === key && (rec.job.status === "queued" || rec.job.status === "running")) return snapshot(rec.job);
      }
    }
    const job: Job = {
      id: randomUUID(),
      kind,
      decl,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      log: [],
      result: null,
      error: null,
    };
    const emitter = new EventEmitter<JobEvents>();
    emitter.setMaxListeners(0);
    const ctx: JobContext = { id: job.id, log: (line) => this.appendLog(rec, line) };
    const queue = kind === "extract" ? this.extractQueue : this.verifyQueue;
    // Extraction (lake build, graph.json rewrite) excludes verification (leanexport reads .oleans).
    const locked = <T>(body: () => Promise<T>): Promise<T> =>
      kind === "extract" ? this.lock.write(body) : this.lock.read(body);
    const rec: JobRecord = { job, emitter, key, finished: Promise.resolve(job) };
    rec.finished = queue.run(() => locked(async () => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      try {
        job.result = await fn(ctx);
        job.status = "done";
      } catch (e) {
        job.status = "failed";
        job.error = e instanceof Error ? e.message : String(e);
        this.appendLog(rec, `error: ${job.error}`);
      }
      job.finishedAt = new Date().toISOString();
      const snap = snapshot(job);
      emitter.emit("done", snap);
      this.prune();
      return snap;
    }));
    this.jobs.set(job.id, rec);
    return snapshot(job);
  }

  private appendLog(rec: JobRecord, line: string): void {
    rec.job.log.push(line);
    if (rec.job.log.length > this.logLimit) rec.job.log.splice(0, rec.job.log.length - this.logLimit);
    this.opts.onLog?.(rec.job, line);
    rec.emitter.emit("log", line);
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((r) => r.job.finishedAt !== null);
    const excess = finished.length - this.maxFinished;
    if (excess <= 0) return;
    finished
      .sort((a, b) => (a.job.finishedAt ?? "").localeCompare(b.job.finishedAt ?? ""))
      .slice(0, excess)
      .forEach((r) => this.jobs.delete(r.job.id));
  }

  get(id: string): Job | undefined {
    const rec = this.jobs.get(id);
    return rec ? snapshot(rec.job) : undefined;
  }

  /** Newest first. */
  list(): Job[] {
    return [...this.jobs.values()].map((r) => snapshot(r.job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  emitter(id: string): EventEmitter<JobEvents> | undefined {
    return this.jobs.get(id)?.emitter;
  }

  /** Resolves when the job finishes (done or failed). */
  wait(id: string): Promise<Job> {
    const rec = this.jobs.get(id);
    return rec ? rec.finished : Promise.reject(new Error(`Unknown job ${id}`));
  }

  /**
   * Replay the current log and subscribe to further events. Returns an unsubscribe function.
   * When the job has already finished, `onDone` is called synchronously.
   */
  subscribe(id: string, onLog: (line: string) => void, onDone: (job: Job) => void): (() => void) | null {
    const rec = this.jobs.get(id);
    if (!rec) return null;
    for (const line of rec.job.log) onLog(line);
    if (rec.job.finishedAt !== null) {
      onDone(snapshot(rec.job));
      return () => {};
    }
    rec.emitter.on("log", onLog);
    rec.emitter.on("done", onDone);
    return () => {
      rec.emitter.off("log", onLog);
      rec.emitter.off("done", onDone);
    };
  }
}

function snapshot(job: Job): Job {
  return structuredClone(job);
}
