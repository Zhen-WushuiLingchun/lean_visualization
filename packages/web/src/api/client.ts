import {
  CheckerInfoSchema,
  GraphFileSchema,
  JobSchema,
  VerifyResultSchema,
  type CheckerInfo,
  type GraphFile,
  type Job,
  type VerifyRequest,
  type VerifyResult,
} from "@proofflow/schema";

/**
 * Typed access to the ProofFlow server (docs/ARCHITECTURE.md section 3). Every response is
 * validated with the zod schemas from @proofflow/schema; nothing is trusted by shape alone.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SourceSnippet {
  file: string;
  line: number;
  endLine: number;
  text: string;
}

const API = "/api";

function errorText(body: string): string | null {
  try {
    const j = JSON.parse(body) as unknown;
    if (j && typeof j === "object") {
      const o = j as Record<string, unknown>;
      for (const k of ["error", "message"]) if (typeof o[k] === "string") return o[k] as string;
    }
  } catch {
    // not JSON
  }
  const t = body.trim();
  return t && t.length < 300 && !t.startsWith("<") ? t : null;
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
  } catch (e) {
    throw new ApiError(`Network error: ${e instanceof Error ? e.message : String(e)}`, null, url);
  }
  const body = await res.text();
  if (!res.ok) throw new ApiError(errorText(body) ?? `HTTP ${res.status}`, res.status, url);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError("The server did not return JSON.", res.status, url);
  }
}

export type GraphParse = { ok: true; graph: GraphFile } | { ok: false; issues: string[] };

/** Validate an untrusted value as a `GraphFile`, returning readable issues. */
export function parseGraphFile(value: unknown): GraphParse {
  const r = GraphFileSchema.safeParse(value);
  if (r.success) return { ok: true, graph: r.data };
  const issues = r.error.issues.slice(0, 8).map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
  if (r.error.issues.length > 8) issues.push(`and ${r.error.issues.length - 8} more`);
  return { ok: false, issues };
}

export async function fetchGraph(): Promise<GraphFile> {
  const url = `${API}/graph`;
  const json = await requestJson(url);
  const parsed = parseGraphFile(json);
  if (!parsed.ok) throw new ApiError(`graph.json failed validation: ${parsed.issues.join("; ")}`, 200, url);
  return parsed.graph;
}

export async function fetchCheckers(): Promise<CheckerInfo[]> {
  const json = await requestJson(`${API}/checkers`);
  const arr = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { checkers?: unknown }).checkers) ? (json as { checkers: unknown[] }).checkers : [];
  return arr.flatMap((c) => {
    // Tolerate servers that predate `note` rather than dropping every checker.
    const r = CheckerInfoSchema.safeParse(c && typeof c === "object" && !("note" in c) ? { ...c, note: null } : c);
    return r.success ? [r.data] : [];
  });
}

export function parseSourceSnippet(json: unknown): SourceSnippet | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.text !== "string" || typeof o.file !== "string") return null;
  const line = typeof o.line === "number" ? o.line : 1;
  const endLine = typeof o.endLine === "number" ? o.endLine : line;
  return { file: o.file, line, endLine, text: o.text };
}

export async function fetchSource(decl: string): Promise<SourceSnippet> {
  const url = `${API}/source?decl=${encodeURIComponent(decl)}`;
  const snip = parseSourceSnippet(await requestJson(url));
  if (!snip) throw new ApiError("Unexpected source response.", 200, url);
  return snip;
}

/** Cached results for a declaration, newest first. Invalid entries are dropped. */
export function parseResults(json: unknown): VerifyResult[] {
  const arr = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { results?: unknown }).results) ? (json as { results: unknown[] }).results : [];
  const out: VerifyResult[] = [];
  for (const r of arr) {
    const p = VerifyResultSchema.safeParse(r);
    if (p.success) out.push(p.data);
  }
  return out.sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt));
}

export async function fetchResults(decl: string): Promise<VerifyResult[]> {
  return parseResults(await requestJson(`${API}/results?decl=${encodeURIComponent(decl)}`));
}

export interface VerifyStart {
  jobId: string;
  job: Job | null;
}

export function parseVerifyStart(json: unknown): VerifyStart | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const jobParsed = JobSchema.safeParse(o.job ?? o);
  const job = jobParsed.success ? jobParsed.data : null;
  const jobId = typeof o.jobId === "string" ? o.jobId : typeof o.id === "string" ? o.id : job?.id;
  return jobId ? { jobId, job } : null;
}

export async function postVerify(req: VerifyRequest): Promise<VerifyStart> {
  const url = `${API}/verify`;
  const start = parseVerifyStart(
    await requestJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) }),
  );
  if (!start) throw new ApiError("The server did not return a job id.", 200, url);
  return start;
}

export async function fetchJob(id: string): Promise<Job> {
  const url = `${API}/jobs/${encodeURIComponent(id)}`;
  const r = JobSchema.safeParse(await requestJson(url));
  if (!r.success) throw new ApiError("Unexpected job response.", 200, url);
  return r.data;
}

// ---------------------------------------------------------------------------------------------
// Server-Sent Events for /api/jobs/:id/events

export type JobEvent =
  | { type: "log"; lines: string[] }
  | { type: "status"; job: Job }
  | { type: "done"; job: Job | null; result: VerifyResult | null; error: string | null }
  | { type: "error"; message: string }
  | { type: "ignore" };

const DONE_TYPES = new Set(["done", "result", "end", "complete", "finished"]);
const STATUS_TYPES = new Set(["status", "job", "progress", "update"]);

function tryJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function linesOf(payload: unknown): string[] {
  if (typeof payload === "string") return payload.split(/\r?\n/);
  if (Array.isArray(payload)) return payload.filter((l): l is string => typeof l === "string");
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if (Array.isArray(o.lines)) return linesOf(o.lines);
    for (const k of ["line", "message", "text", "data"]) if (typeof o[k] === "string") return linesOf(o[k]);
  }
  return [];
}

function doneOf(payload: unknown): JobEvent {
  const job = JobSchema.safeParse(payload);
  if (job.success) return { type: "done", job: job.data, result: job.data.result, error: job.data.error };
  const res = VerifyResultSchema.safeParse(payload);
  if (res.success) return { type: "done", job: null, result: res.data, error: null };
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if (o.job !== undefined) {
      const inner = doneOf(o.job);
      if (inner.type === "done") return inner;
    }
    if (o.result !== undefined) {
      const r = VerifyResultSchema.safeParse(o.result);
      return { type: "done", job: null, result: r.success ? r.data : null, error: typeof o.error === "string" ? o.error : null };
    }
    if (typeof o.error === "string") return { type: "done", job: null, result: null, error: o.error };
  }
  return { type: "done", job: null, result: null, error: null };
}

/**
 * Interpret one SSE event. Accepts named events (`log`, `done`, `status`, `error`, ...) and
 * unnamed `message` events carrying `{ type, ... }`. Unknown events are ignored.
 */
export function parseJobEvent(eventType: string, data: string): JobEvent {
  let type = eventType;
  let payload = tryJson(data);
  if (type === "message" && payload && typeof payload === "object" && typeof (payload as { type?: unknown }).type === "string") {
    const o = payload as Record<string, unknown>;
    type = o.type as string;
    if (o.data !== undefined) payload = o.data;
    else if (o.payload !== undefined) payload = o.payload;
  }
  if (type === "log" || (type === "message" && typeof payload === "string")) {
    const lines = linesOf(payload);
    return lines.length ? { type: "log", lines } : { type: "ignore" };
  }
  if (DONE_TYPES.has(type)) return doneOf(payload);
  if (STATUS_TYPES.has(type)) {
    const job = JobSchema.safeParse(payload);
    if (!job.success) return { type: "ignore" };
    if (job.data.status === "done" || job.data.status === "failed" || job.data.status === "cancelled") return doneOf(job.data);
    return { type: "status", job: job.data };
  }
  if (type === "error") {
    const lines = linesOf(payload);
    return { type: "error", message: lines.join(" ") || "Job error" };
  }
  if (type === "message") {
    const job = JobSchema.safeParse(payload);
    if (job.success) return parseJobEvent("status", data);
    const lines = linesOf(payload);
    return lines.length ? { type: "log", lines } : { type: "ignore" };
  }
  return { type: "ignore" };
}

export interface JobHandlers {
  onLog(lines: string[]): void;
  /** Replace the whole log with the server's tail (used when polling). */
  onLogReplace?(lines: string[]): void;
  onStatus?(job: Job): void;
  onDone(done: { job: Job | null; result: VerifyResult | null; error: string | null }): void;
}

type EventSourceLike = {
  addEventListener(type: string, cb: (ev: Event) => void): void;
  close(): void;
};
export type EventSourceCtor = new (url: string) => EventSourceLike;

export interface SubscribeOptions {
  EventSourceImpl?: EventSourceCtor | null;
  pollMs?: number;
}

const EVENT_NAMES = ["message", "log", "status", "job", "progress", "update", "done", "result", "end", "complete", "finished"];

/**
 * Follow a job until it finishes. Uses SSE; if the stream fails before `done`, falls back to
 * polling `/api/jobs/:id`. Returns an unsubscribe function.
 */
export function subscribeJob(jobId: string, handlers: JobHandlers, opts: SubscribeOptions = {}): () => void {
  let closed = false;
  let finished = false;
  let polling = false;
  let es: EventSourceLike | null = null;
  const pollMs = opts.pollMs ?? 1000;

  const cleanup = (): void => {
    closed = true;
    es?.close();
    es = null;
  };
  const finish = (d: { job: Job | null; result: VerifyResult | null; error: string | null }): void => {
    if (finished) return;
    finished = true;
    cleanup();
    handlers.onDone(d);
  };
  const dispatch = (ev: JobEvent): void => {
    if (finished) return;
    if (ev.type === "log") handlers.onLog(ev.lines);
    else if (ev.type === "status") handlers.onStatus?.(ev.job);
    else if (ev.type === "done") finish({ job: ev.job, result: ev.result, error: ev.error });
    else if (ev.type === "error") handlers.onLog([`error: ${ev.message}`]);
  };
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    let failures = 0;
    let seen = 0;
    while (!finished) {
      try {
        const job = await fetchJob(jobId);
        failures = 0;
        if (job.log.length !== seen) {
          // The server keeps a bounded tail; replace ours with it (it may overlap what SSE showed).
          if (handlers.onLogReplace) handlers.onLogReplace(job.log);
          else handlers.onLog(job.log.slice(seen));
          seen = job.log.length;
        }
        if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
          finish({ job, result: job.result, error: job.error });
          return;
        }
        handlers.onStatus?.(job);
      } catch (e) {
        if (++failures >= 5) {
          finish({ job: null, result: null, error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };

  const ES: EventSourceCtor | undefined =
    opts.EventSourceImpl === null ? undefined : (opts.EventSourceImpl ?? (typeof EventSource !== "undefined" ? (EventSource as unknown as EventSourceCtor) : undefined));
  if (!ES) {
    void poll();
    return cleanup;
  }
  es = new ES(`${API}/jobs/${encodeURIComponent(jobId)}/events`);
  for (const name of EVENT_NAMES) {
    es.addEventListener(name, (ev) => {
      const data = (ev as MessageEvent).data;
      if (typeof data === "string") dispatch(parseJobEvent(name, data));
    });
  }
  es.addEventListener("error", (ev) => {
    const data = (ev as MessageEvent).data;
    if (typeof data === "string" && data) {
      // A server-sent `event: error`, not a connection failure.
      dispatch(parseJobEvent("error", data));
      return;
    }
    if (finished || closed) return;
    es?.close();
    es = null;
    void poll();
  });
  return () => {
    finished = true;
    cleanup();
  };
}
