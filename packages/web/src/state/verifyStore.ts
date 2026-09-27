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

/**
 * What a verify request asks for: an explicit list of available checkers, `"all"` (the server
 * resolves it to every available checker; used only when availability is unknown), or `null` to
 * omit the field and let the server use its L1 default (also only when availability is unknown).
 * Unavailable checker names are never sent.
 */
export type CheckerRequest = CheckerName[] | "all" | null;

export interface JobView {
  id: string | null;
  status: JobPhase;
  checkers: CheckerRequest;
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
  scope: "cone" | "all" | "local";
  total: number;
  done: number;
  reused: number;
  current: string | null;
  /** Declarations occupying batch slots; an existing per-node request may occupy a slot while it finishes. */
  active: string[];
  maxInFlight?: number;
  checkers: CheckerRequest;
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

  /** Server-reported info for a checker, when /api/checkers answered. */
  info(c: CheckerName): CheckerInfo | undefined {
    return this.checkers?.find((i) => i.checker === c);
  }

  /** `true`/`false` from /api/checkers, `null` when availability is unknown. */
  available(c: CheckerName): boolean | null {
    if (!this.checkers) return null;
    return this.info(c)?.available ?? false;
  }

  /**
   * "Verify (kernel)": the L1 checkers the server reports as available (normally `leanchecker`,
   * `leanchecker-module` on toolchains without leanexport). `null` when unknown (server default).
   */
  kernelRequest(): CheckerRequest {
    if (!this.checkers) return null;
    return L1_CHECKERS.filter((c) => this.available(c) === true);
  }

  /** "Verify (all checkers)": every available L1 and L2 checker, or `"all"` when unknown. */
  allRequest(): CheckerRequest {
    if (!this.checkers) return "all";
    return [...L1_CHECKERS, ...L2_CHECKERS].filter((c) => this.available(c) === true);
  }

  /** Why kernel verification cannot run (the server's notes), or null when it can. */
  kernelUnavailable(): string | null {
    const req = this.kernelRequest();
    if (req === null || req === "all" || req.length > 0) return null;
    const notes = L1_CHECKERS.map((c) => this.info(c)?.note).filter((n): n is string => !!n);
    return notes.length > 0 ? notes.join(" ") : "No kernel checker is available in the active toolchain.";
  }

  /** Why no verification at all can run, or null. */
  allUnavailable(): string | null {
    const req = this.allRequest();
    if (req === null || req === "all" || req.length > 0) return null;
    return this.kernelUnavailable() ?? "No checker is available in the active toolchain.";
  }

  reset(): void {
    if (this.liveRun) this.liveRun.cancelled = true;
    this.liveRun = null;
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

  verify(decl: string, checkers: CheckerRequest, force = false): Promise<VerifyResult | null> {
    if (!this.enabled) return Promise.resolve(null);
    const existing = this.pending.get(decl);
    if (existing) return existing;
    const p = this.runJob(decl, checkers, force).finally(() => this.pending.delete(decl));
    this.pending.set(decl, p);
    return p;
  }

  private async runJob(decl: string, checkers: CheckerRequest, force: boolean): Promise<VerifyResult | null> {
    this.patch(decl, { job: { id: null, status: "posting", checkers, log: [], error: null } });
    if (Array.isArray(checkers) && checkers.length === 0) {
      this.patchJob(decl, { status: "failed", error: this.allUnavailable() ?? "No available checker was requested." });
      return null;
    }
    let start;
    try {
      start = await postVerify({ decl, ...(checkers !== null ? { checkers } : {}), ...(force ? { force } : {}) });
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
   * Submit every real declaration to the server through a bounded rolling window. Only the server can validate cached
   * export/toolchain/binary bindings; a previously green browser badge is never a reason to skip.
   * Each export includes its closure, so file order is sufficient and needs no full-graph walk.
   */
  async runAll(decls: readonly string[], checkers: CheckerRequest, scope: "all" | "local" = "all", maxInFlight = 2): Promise<ConeRun | null> {
    if (!this.enabled || (this.coneRun && !this.coneRun.finished) || (Array.isArray(checkers) && checkers.length === 0)) return null;
    const ids = [...new Set(decls)];
    const limit = Number.isFinite(maxInFlight) ? Math.max(1, Math.min(4, Math.floor(maxInFlight))) : 2;
    const request = Array.isArray(checkers) ? [...checkers] : checkers;
    const run: ConeRun = {
      scope, total: ids.length, done: 0, reused: 0, current: null, active: [], maxInFlight: limit, checkers: request,
      finished: false, cancelled: false,
      outcomes: { none: 0, running: 0, ok: 0, rejected: 0, error: 0, dash: 0 },
    };
    this.liveRun = run;
    const publish = (): void => {
      // A reset or a new graph must not restore the old batch's progress.
      if (this.liveRun !== run) return;
      this.coneRun = { ...run, active: [...run.active], outcomes: { ...run.outcomes } };
      this.emit(null);
    };
    publish();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length && !run.cancelled && this.enabled && this.liveRun === run) {
        const decl = ids[next++] as string;
        run.active.push(decl);
        run.current = run.active[0] ?? null;
        publish();
        let submitted = false;
        try {
          // An in-flight manual kernel-only request cannot satisfy an all-checker batch request.
          const pending = this.pending.get(decl);
          if (pending) await pending.catch(() => null);
          if (run.cancelled || !this.enabled || this.liveRun !== run) continue;
          submitted = true;
          const result = await this.verify(decl, request);
          let kind = result ? badgeOf(result).kind : "error";
          if (kind === "ok" && result && !covers(result, request)) kind = "dash";
          run.outcomes[kind]++;
        } catch {
          if (submitted) run.outcomes.error++;
        } finally {
          if (submitted) {
            run.done++;
            // Full logs remain on the server. Do not retain thousands of streamed logs per batch node.
            this.patchJob(decl, { log: [] });
          }
          run.active.splice(run.active.indexOf(decl), 1);
          run.current = run.active[0] ?? null;
          publish();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, () => worker()));
    run.finished = true;
    run.current = null;
    run.active = [];
    publish();
    return { ...run, active: [], outcomes: { ...run.outcomes } };
  }

  /**
   * Verify declarations one at a time, in the given (topological) order. With `reuseCached`, a
   * declaration whose newest cached result already covers every requested checker is skipped.
   */
  async runCone(decls: readonly string[], checkers: CheckerRequest, reuseCached = true): Promise<ConeRun | null> {
    if (!this.enabled || (this.coneRun && !this.coneRun.finished)) return null;
    const run: ConeRun = {
      scope: "cone",
      total: decls.length,
      done: 0,
      reused: 0,
      current: null,
      active: [],
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
    this.coneRun = { ...live, active: [...live.active], outcomes: { ...live.outcomes } };
    this.emit(null);
  }
}

const DEFINITIVE = (status: string): boolean => status === "accepted" || status === "rejected" || status === "declined";

/**
 * Does a result already answer a request definitively? Same rule as the server's cache reuse
 * (docs/ARCHITECTURE.md section 3): accepted, rejected or declined. For requests resolved by the
 * server (`null` = its L1 default, `"all"`), any kernel row counts, plus every L2 row for `"all"`.
 */
export function covers(result: VerifyResult, checkers: CheckerRequest): boolean {
  const row = (c: CheckerName) => result.checkers.find((r) => r.checker === c && r.status !== "skipped");
  const kernel = L1_CHECKERS.some((c) => {
    const r = row(c);
    return r !== undefined && DEFINITIVE(r.status);
  });
  if (checkers === null) return kernel;
  if (checkers === "all") return kernel && L2_CHECKERS.every((c) => row(c) !== undefined && (DEFINITIVE(row(c)?.status ?? "") || row(c)?.status === "unavailable"));
  return checkers.length > 0 && checkers.every((c) => DEFINITIVE(row(c)?.status ?? ""));
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
