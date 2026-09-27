import { useSyncExternalStore } from "react";
import { L1_CHECKERS, L2_CHECKERS, type CheckerInfo, type CheckerName, type Job, type VerifyResult } from "@proofflow/schema";
import { fetchResults, postVerify, subscribeJob, type SubscribeOptions } from "../api/client";
import { badgeOf, effectiveResult, NO_BADGE, RUNNING_BADGE, type Badge } from "../graph/badge";

/**
 * Verification state per declaration: `decl → { job?, results }`. A hand-written external store so
 * that a badge update re-renders only the node whose state changed.
 */

type JobStatus = Job["status"];
export type JobPhase = "posting" | JobStatus;

export interface JobView {
  id: string | null;
  status: JobPhase;
  checkers: CheckerName[];
  log: string[];
  error: string | null;
}

export interface DeclVerify {
  /** Cached and fresh results, newest first. */
  results: VerifyResult[];
  cache: "idle" | "queued" | "loading" | "loaded" | "error";
  job: JobView | null;
}

export interface ConeRun {
  total: number;
  done: number;
  reused: number;
  current: string | null;
  checkers: CheckerName[];
  finished: boolean;
  cancelled: boolean;
  outcomes: Record<Badge["kind"], number>;
}

const EMPTY: DeclVerify = Object.freeze({ results: [], cache: "idle", job: null }) as DeclVerify;
const LOG_LIMIT = 1000;

export const isActive = (j: JobView | null): boolean => j !== null && (j.status === "posting" || j.status === "queued" || j.status === "running");

export class VerifyStore {
  enabled = false;
  checkers: CheckerInfo[] | null = null;
  coneRun: ConeRun | null = null;
  /** Injected in tests. */
  subscribeOptions: SubscribeOptions = {};

  private states = new Map<string, DeclVerify>();
  private keyListeners = new Map<string, Set<() => void>>();
  private listeners = new Set<() => void>();
  private version = 0;
  private badges = new WeakMap<DeclVerify, Badge>();
  private pending = new Map<string, Promise<VerifyResult | null>>();
  private liveRun: ConeRun | null = null;

  // Cached-result loading: debounced, bounded parallelism.
  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = 0;
  readonly maxParallel = 3;
  readonly debounceMs = 150;
  private waiters = new Map<string, Array<() => void>>();

  get = (decl: string): DeclVerify => this.states.get(decl) ?? EMPTY;
  getVersion = (): number => this.version;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  subscribeKey = (decl: string, cb: () => void): (() => void) => {
    let set = this.keyListeners.get(decl);
    if (!set) {
      set = new Set();
      this.keyListeners.set(decl, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.keyListeners.delete(decl);
    };
  };

  private emit(decl: string | null): void {
    this.version++;
    if (decl !== null) this.keyListeners.get(decl)?.forEach((cb) => cb());
    this.listeners.forEach((cb) => cb());
  }

  private patch(decl: string, p: Partial<DeclVerify>): void {
    this.states.set(decl, { ...this.get(decl), ...p });
    this.emit(decl);
  }

  private patchJob(decl: string, p: Partial<JobView>): void {
    const cur = this.get(decl).job;
    if (!cur) return;
    this.patch(decl, { job: { ...cur, ...p } });
  }

  badge(decl: string): Badge {
    const s = this.get(decl);
    if (isActive(s.job)) return RUNNING_BADGE;
    if (s.results.length === 0) return NO_BADGE;
    let b = this.badges.get(s);
    if (!b) {
      b = badgeOf(effectiveResult(s.results));
      this.badges.set(s, b);
    }
    return b;
  }

  /** L1 only. */
  kernelCheckers(): CheckerName[] {
    return [...L1_CHECKERS];
  }

  /** L1 plus every L2 checker the server reports as available (all of them if unknown). */
  allCheckers(): CheckerName[] {
    const l2 = this.checkers ? L2_CHECKERS.filter((c) => this.checkers?.some((i) => i.checker === c && i.available)) : [...L2_CHECKERS];
    return [...L1_CHECKERS, ...l2];
  }

  reset(): void {
    this.states.clear();
    this.queue = [];
    this.coneRun = null;
    this.emit(null);
  }

  // ---- cached results -------------------------------------------------------------------------

  /** Ask for cached results of a visible node. Debounced and deduplicated. */
  requestCached(decl: string): void {
    if (!this.enabled) return;
    if (this.get(decl).cache !== "idle") return;
    this.states.set(decl, { ...this.get(decl), cache: "queued" });
    this.queue.push(decl);
    if (this.timer === null) this.timer = setTimeout(() => this.pump(), this.debounceMs);
  }

  /** Load cached results now and resolve when they are in. */
  loadCached(decl: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const s = this.get(decl);
    if (s.cache === "loaded" || s.cache === "error") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = this.waiters.get(decl) ?? [];
      list.push(resolve);
      this.waiters.set(decl, list);
      if (s.cache === "idle") {
        this.states.set(decl, { ...s, cache: "queued" });
        this.queue.unshift(decl);
      } else if (s.cache === "queued") {
        this.queue = [decl, ...this.queue.filter((d) => d !== decl)];
      }
      this.pump();
    });
  }

  private pump(): void {
    this.timer = null;
    while (this.active < this.maxParallel && this.queue.length > 0) {
      const decl = this.queue.shift() as string;
      if (this.get(decl).cache !== "queued") continue;
      this.active++;
      this.states.set(decl, { ...this.get(decl), cache: "loading" });
      fetchResults(decl)
        .then((results) => {
          const cur = this.get(decl);
          // Keep results that arrived from a job meanwhile.
          const merged = [...cur.results];
          for (const r of results) if (!merged.some((m) => m.exportHash === r.exportHash && m.verifiedAt === r.verifiedAt)) merged.push(r);
          merged.sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt));
          this.patch(decl, { results: merged, cache: "loaded" });
        })
        .catch(() => this.patch(decl, { cache: "error" }))
        .finally(() => {
          this.active--;
          this.waiters.get(decl)?.forEach((w) => w());
          this.waiters.delete(decl);
          this.pump();
        });
    }
  }

  // ---- verification jobs ----------------------------------------------------------------------

  verify(decl: string, checkers: CheckerName[], force = false): Promise<VerifyResult | null> {
    if (!this.enabled) return Promise.resolve(null);
    const existing = this.pending.get(decl);
    if (existing) return existing;
    const p = this.runJob(decl, checkers, force).finally(() => this.pending.delete(decl));
    this.pending.set(decl, p);
    return p;
  }

  private async runJob(decl: string, checkers: CheckerName[], force: boolean): Promise<VerifyResult | null> {
    this.patch(decl, { job: { id: null, status: "posting", checkers, log: [], error: null } });
    let start;
    try {
      start = await postVerify({ decl, checkers, ...(force ? { force } : {}) });
    } catch (e) {
      this.patchJob(decl, { status: "failed", error: e instanceof Error ? e.message : String(e) });
      return null;
    }
    this.patchJob(decl, { id: start.jobId, status: start.job?.status ?? "queued", log: start.job?.log ?? [] });
    const onDone = (d: { result: VerifyResult | null; error: string | null; status?: JobStatus }): VerifyResult | null => {
      if (d.result) this.addResult(decl, d.result);
      this.patchJob(decl, { status: d.status ?? (d.result ? "done" : "failed"), error: d.error ?? (d.result ? null : "The job finished without a result.") });
      return d.result;
    };
    if (start.job && (start.job.status === "done" || start.job.status === "failed" || start.job.status === "cancelled")) {
      return onDone({ result: start.job.result, error: start.job.error, status: start.job.status });
    }
    return new Promise<VerifyResult | null>((resolve) => {
      subscribeJob(
        start.jobId,
        {
          onLog: (lines) => {
            const cur = this.get(decl).job;
            if (!cur) return;
            const log = [...cur.log, ...lines];
            this.patchJob(decl, { log: log.length > LOG_LIMIT ? log.slice(-LOG_LIMIT) : log });
          },
          onLogReplace: (lines) => this.patchJob(decl, { log: lines.slice(-LOG_LIMIT) }),
          onStatus: (job) => this.patchJob(decl, { status: job.status }),
          onDone: ({ job, result, error }) => resolve(onDone({ result, error, ...(job ? { status: job.status } : {}) })),
        },
        this.subscribeOptions,
      );
    });
  }

  private addResult(decl: string, result: VerifyResult): void {
    const cur = this.get(decl);
    const rest = cur.results.filter((r) => !(r.exportHash === result.exportHash && r.verifiedAt === result.verifiedAt));
    this.patch(decl, { results: [result, ...rest] });
  }

  // ---- cone runs ------------------------------------------------------------------------------

  /**
   * Verify declarations one at a time, in the given (topological) order. With `reuseCached`, a
   * declaration whose newest cached result already covers every requested checker is skipped.
   */
  async runCone(decls: readonly string[], checkers: CheckerName[], reuseCached = true): Promise<ConeRun | null> {
    if (!this.enabled || (this.coneRun && !this.coneRun.finished)) return null;
    const run: ConeRun = {
      total: decls.length,
      done: 0,
      reused: 0,
      current: null,
      checkers,
      finished: false,
      cancelled: false,
      outcomes: { none: 0, running: 0, ok: 0, rejected: 0, error: 0, dash: 0 },
    };
    this.liveRun = run;
    this.coneRun = { ...run };
    this.emit(null);
    for (const decl of decls) {
      if (run.cancelled) break;
      this.coneRun = { ...run, current: decl };
      this.emit(null);
      let result: VerifyResult | null = null;
      if (reuseCached) {
        await this.loadCached(decl);
        const eff = effectiveResult(this.get(decl).results);
        if (eff && covers(eff, checkers)) {
          result = eff;
          run.reused++;
        }
      }
      if (!result) result = await this.verify(decl, checkers);
      if (run.cancelled && !result) break;
      run.done++;
      const kind = result ? badgeOf(result).kind : "error";
      run.outcomes[kind]++;
      this.coneRun = { ...run, current: decl };
      this.emit(null);
    }
    run.finished = true;
    this.coneRun = { ...run, current: null };
    this.emit(null);
    return this.coneRun;
  }

  cancelCone(): void {
    const live = this.liveRun;
    if (!live || live.finished) return;
    live.cancelled = true;
    this.coneRun = { ...live };
    this.emit(null);
  }
}

/**
 * Does a result already answer every requested checker definitively? Same rule as the server's
 * cache reuse (docs/ARCHITECTURE.md section 3): accepted, rejected or declined.
 */
export function covers(result: VerifyResult, checkers: readonly CheckerName[]): boolean {
  return checkers.every((c) => {
    const row = result.checkers.find((r) => r.checker === c);
    return row !== undefined && (row.status === "accepted" || row.status === "rejected" || row.status === "declined");
  });
}

export function useDeclVerify(store: VerifyStore, decl: string | null): DeclVerify {
  return useSyncExternalStore(
    (cb) => (decl ? store.subscribeKey(decl, cb) : () => undefined),
    () => (decl ? store.get(decl) : EMPTY),
  );
}

export function useBadge(store: VerifyStore, decl: string | null): Badge {
  return useSyncExternalStore(
    (cb) => (decl ? store.subscribeKey(decl, cb) : () => undefined),
    () => (decl ? store.badge(decl) : NO_BADGE),
  );
}

export function useConeRun(store: VerifyStore): ConeRun | null {
  return useSyncExternalStore(store.subscribe, () => store.coneRun);
}
