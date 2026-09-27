import { z } from "zod";

/** Checkers that ship inside a Lean toolchain (v4.35+). Names are stable identifiers, not binaries. */
export const CheckerNameSchema = z.enum([
  "leanchecker", // official kernel, fresh replay of the export (L1)
  "leanchecker-paranoid", // official kernel with extra checks (L2)
  "lean4lean", // typechecker written in Lean (L2)
  "nanoda", // Rust typechecker, binary `nanoda_bin` (L2)
  "con-leche", // independent checker with a soundness theorem (L2)
  "con-ron", // port of con-leche (L2)
]);
export type CheckerName = z.infer<typeof CheckerNameSchema>;

export const L1_CHECKERS: readonly CheckerName[] = ["leanchecker"];
export const L2_CHECKERS: readonly CheckerName[] = [
  "leanchecker-paranoid",
  "lean4lean",
  "nanoda",
  "con-leche",
  "con-ron",
];

export const CheckerStatusSchema = z.enum([
  "accepted", // exit 0 and the checker's success line was seen
  "rejected", // exit 1: the checker explicitly rejected a declaration
  "declined", // exit 2: the checker refuses to judge (e.g. con-leche on a non-standard axiom)
  "error", // crashed, unknown exit code, unparsable output
  "timeout",
  "unavailable", // binary not found in the active toolchain
  "skipped", // not requested
]);
export type CheckerStatus = z.infer<typeof CheckerStatusSchema>;

export const CheckerResultSchema = z.object({
  checker: CheckerNameSchema,
  status: CheckerStatusSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  /** argv actually executed, first element is the resolved binary path. */
  command: z.array(z.string()),
  /** Last ~4 KB of each stream. */
  stdoutTail: z.string(),
  stderrTail: z.string(),
  /** Declaration named in a rejection, when the checker reports one. */
  rejectedDecl: z.string().nullable(),
});
export type CheckerResult = z.infer<typeof CheckerResultSchema>;

export const VerdictSchema = z.enum([
  "accepted", // every requested checker accepted
  "rejected", // at least one requested checker rejected
  "error", // no rejection, but at least one requested checker errored/timed out
  "partial", // some requested checkers unavailable or declined, the rest accepted
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const VerifyResultSchema = z.object({
  decl: z.string(),
  /** Module passed to `leanexport`. */
  module: z.string(),
  /** sha256 hex of the NDJSON export. Cache key together with `decl`. */
  exportHash: z.string(),
  exportBytes: z.number().int().nonnegative(),
  /** Number of declaration records in the export, or null if not counted. */
  exportDecls: z.number().int().nonnegative().nullable(),
  exportDurationMs: z.number().nonnegative(),
  /** ISO-8601. */
  verifiedAt: z.string(),
  leanVersion: z.string(),
  checkers: z.array(CheckerResultSchema),
  verdict: VerdictSchema,
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

/** Derive the verdict from checker results. Skipped checkers are ignored. */
export function verdictOf(results: readonly CheckerResult[]): Verdict {
  const considered = results.filter((r) => r.status !== "skipped");
  if (considered.some((r) => r.status === "rejected")) return "rejected";
  if (considered.some((r) => r.status === "error" || r.status === "timeout")) return "error";
  if (considered.some((r) => r.status === "unavailable" || r.status === "declined")) return "partial";
  if (considered.length === 0) return "partial";
  return "accepted";
}

export const CheckerInfoSchema = z.object({
  checker: CheckerNameSchema,
  available: z.boolean(),
  /** Resolved binary path when available. */
  path: z.string().nullable(),
  version: z.string().nullable(),
  level: z.enum(["L1", "L2"]),
});
export type CheckerInfo = z.infer<typeof CheckerInfoSchema>;

export const JobKindSchema = z.enum(["verify", "extract"]);
export const JobStatusSchema = z.enum(["queued", "running", "done", "failed", "cancelled"]);

export const JobSchema = z.object({
  id: z.string(),
  kind: JobKindSchema,
  /** Declaration for verify jobs, null for extract jobs. */
  decl: z.string().nullable(),
  status: JobStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Tail of log lines (bounded). */
  log: z.array(z.string()),
  result: VerifyResultSchema.nullable(),
  error: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const VerifyRequestSchema = z.object({
  decl: z.string().min(1),
  /**
   * Checkers to run. Defaults to L1 only (`leanchecker`). The literal `"all"` means every checker
   * that is available in the active toolchain (missing ones are omitted rather than reported as
   * `unavailable`).
   */
  checkers: z.union([z.array(CheckerNameSchema), z.literal("all")]).optional(),
  /** Ignore cache. */
  force: z.boolean().optional(),
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
