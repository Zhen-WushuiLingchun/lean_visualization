import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { STANDARD_AXIOMS } from "@proofflow/schema";

/**
 * Independent audit of a leanexport NDJSON file (format 3.1.0), without trusting graph.json:
 * is the requested declaration in the export, what kind of record is it, a stable hash of its type,
 * and the exact set of axioms in the closure. Streams line by line; only expression lines are kept
 * (as raw text, keyed by id) so the target's type can be hashed after the target record is seen.
 */
export interface ExportAudit {
  targetFound: boolean;
  /** Record kind: `thm`, `def`, `axiom`, `opaque`, `quot`, or `inductive`/`ctor`/`rec` in a group. */
  targetKind: string | null;
  /** Canonical hash of the target's type expression (see `canonicalTypeHash`), or null. */
  targetTypeSha256: string | null;
  /** Exact axiom names in the export, `Name.toString` form, sorted. */
  axioms: string[];
  /** True iff `axioms` is a subset of {propext, Classical.choice, Quot.sound}. */
  standardAxiomsOnly: boolean;
  /** Declaration records (an inductive group counts once). */
  declCount: number;
}

export interface AuditPass {
  audit: ExportAudit;
  sha256: string;
  bytes: number;
  leanVersion: string | null;
}

type NameComp = string | number;

const PLAIN = /^[A-Za-z_À-￿][\w'!?À-￿]*$/;

/** `Name.toString`-style rendering: components needing escapes get «». */
export function renderName(comps: readonly NameComp[]): string {
  return comps.map((c) => (typeof c === "number" ? String(c) : PLAIN.test(c) ? c : `«${c}»`)).join(".");
}

/** Parse `Foo.«bar baz».0.x'` into components; unescaped all-digit components are numeric. */
export function parseNameComponents(name: string): NameComp[] {
  const out: NameComp[] = [];
  for (const m of name.matchAll(/«([^»]*)»|([^.]+)/g)) {
    if (m[1] !== undefined) out.push(m[1]);
    else {
      const s = m[2] ?? "";
      out.push(/^\d+$/.test(s) ? Number(s) : s);
    }
  }
  return out;
}

const nameKey = (comps: readonly NameComp[]): string => JSON.stringify(comps);

const DECL_KINDS = new Set(["axiom", "def", "thm", "opaque", "quot", "inductive"]);
const EXPR_ID = /^\{"ie":(\d+),|,"ie":(\d+)\}$/;

interface DeclRef {
  name: number;
  type: number;
}

/** Children of an expression node, as expression ids, in the fixed serialisation order. */
function exprChildren(kind: string, v: Record<string, unknown>): number[] {
  switch (kind) {
    case "app":
      return [v["fn"] as number, v["arg"] as number];
    case "lam":
    case "forallE":
      return [v["type"] as number, v["body"] as number];
    case "letE":
      return [v["type"] as number, v["value"] as number, v["body"] as number];
    case "mdata":
      return [v["expr"] as number];
    case "proj":
      return [v["struct"] as number];
    default:
      return [];
  }
}

class Tables {
  readonly names = new Map<number, NameComp[]>([[0, []]]);
  readonly levels = new Map<number, string>([[0, "0"]]);
  readonly exprs = new Map<number, string>();

  name(id: number): NameComp[] {
    const n = this.names.get(id);
    if (!n) throw new Error(`name ${id} is not defined in the export`);
    return n;
  }
  level(id: number): string {
    const l = this.levels.get(id);
    if (l === undefined) throw new Error(`level ${id} is not defined in the export`);
    return l;
  }

  addName(rec: Record<string, unknown>): void {
    const id = rec["in"] as number;
    const s = rec["str"] as { pre: number; str: string } | undefined;
    const n = rec["num"] as { pre: number; i: number } | undefined;
    if (s) this.names.set(id, [...this.name(s.pre), s.str]);
    else if (n) this.names.set(id, [...this.name(n.pre), n.i]);
  }

  addLevel(rec: Record<string, unknown>): void {
    const id = rec["il"] as number;
    let v: string;
    if ("succ" in rec) v = `(succ ${this.level(rec["succ"] as number)})`;
    else if ("max" in rec) {
      const [a, b] = rec["max"] as [number, number];
      v = `(max ${this.level(a)} ${this.level(b)})`;
    } else if ("imax" in rec) {
      const [a, b] = rec["imax"] as [number, number];
      v = `(imax ${this.level(a)} ${this.level(b)})`;
    } else if ("param" in rec) v = `(param ${nameKey(this.name(rec["param"] as number))})`;
    else throw new Error(`unknown level record: ${JSON.stringify(rec).slice(0, 80)}`);
    this.levels.set(id, v);
  }

  /**
   * Canonical Merkle hash of an expression: each node hashes its constructor, its non-binder data
   * (names and levels resolved to canonical strings) and its children's hashes, in a fixed order.
   * Binder names, binder info and `mdata` are ignored (alpha-equivalence, as in `Expr.eqv`), and
   * interning ids never enter the hash. Iterative post-order walk with memoisation, so shared
   * subterms are hashed once and deep terms cannot overflow the stack.
   */
  typeHash(root: number): string {
    const memo = new Map<number, string>();
    const parsed = new Map<number, { kind: string; v: Record<string, unknown> | number | string }>();
    const onStack = new Set<number>();
    const stack: number[] = [root];
    const parse = (id: number): { kind: string; v: Record<string, unknown> | number | string } => {
      let p = parsed.get(id);
      if (!p) {
        const line = this.exprs.get(id);
        if (line === undefined) throw new Error(`expression ${id} is not defined in the export`);
        const obj = JSON.parse(line) as Record<string, unknown>;
        const kind = Object.keys(obj).find((k) => k !== "ie");
        if (!kind) throw new Error(`expression ${id} has no constructor`);
        p = { kind, v: obj[kind] as Record<string, unknown> | number | string };
        parsed.set(id, p);
      }
      return p;
    };
    while (stack.length > 0) {
      const id = stack[stack.length - 1] as number;
      if (memo.has(id)) {
        stack.pop();
        onStack.delete(id);
        continue;
      }
      const { kind, v } = parse(id);
      const kids = typeof v === "object" ? exprChildren(kind, v) : [];
      const pending = kids.filter((k) => !memo.has(k));
      if (pending.length > 0) {
        onStack.add(id);
        for (const k of pending) {
          if (onStack.has(k)) throw new Error(`cycle through expression ${k}`);
          stack.push(k);
        }
        continue;
      }
      const h = (k: number): string => memo.get(k) as string;
      let token: string;
      switch (kind) {
        case "bvar":
          token = `bvar ${v as number}`;
          break;
        case "sort":
          token = `sort ${this.level(v as number)}`;
          break;
        case "const": {
          const o = v as { name: number; us: number[] };
          token = `const ${nameKey(this.name(o.name))} [${o.us.map((u) => this.level(u)).join(" ")}]`;
          break;
        }
        case "app":
          token = `app ${h(kids[0] as number)} ${h(kids[1] as number)}`;
          break;
        case "lam":
        case "forallE":
          token = `${kind} ${h(kids[0] as number)} ${h(kids[1] as number)}`;
          break;
        case "letE":
          token = `let ${h(kids[0] as number)} ${h(kids[1] as number)} ${h(kids[2] as number)}`;
          break;
        case "natVal":
          token = `nat ${String(v)}`;
          break;
        case "strVal":
          token = `str ${JSON.stringify(v)}`;
          break;
        case "mdata":
          memo.set(id, h(kids[0] as number));
          parsed.delete(id);
          continue;
        case "proj": {
          const o = v as { typeName: number; idx: number };
          token = `proj ${nameKey(this.name(o.typeName))} ${o.idx} ${h(kids[0] as number)}`;
          break;
        }
        default:
          throw new Error(`unsupported expression kind ${kind}`);
      }
      memo.set(id, createHash("sha256").update(token, "utf8").digest("hex"));
      parsed.delete(id);
    }
    return memo.get(root) as string;
  }
}

/**
 * Stream an export once: sha256, byte count, meta, and the audit for `decl`. A target whose type
 * cannot be canonicalised (unknown record kind, dangling id) is still `targetFound` with a null
 * type hash; that is reported, not hidden.
 */
export async function auditExport(file: string, decl: string): Promise<AuditPass> {
  const hash = createHash("sha256");
  let bytes = 0;
  const input = createReadStream(file);
  input.on("data", (chunk) => {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const t = new Tables();
  const wanted = nameKey(parseNameComponents(decl));
  const axioms = new Set<string>();
  let declCount = 0;
  let leanVersion: string | null = null;
  let target: (DeclRef & { kind: string }) | null = null;

  for await (const line of rl) {
    if (line.length === 0) continue;
    const m = EXPR_ID.exec(line);
    if (m) {
      t.exprs.set(Number(m[1] ?? m[2]), line);
      continue;
    }
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a malformed line cannot name the target; the checkers will reject the file
    }
    try {
      if ("in" in rec) t.addName(rec);
      else if ("il" in rec) t.addLevel(rec);
      else if ("meta" in rec) {
        const v = (rec["meta"] as { lean?: { version?: unknown } }).lean?.version;
        leanVersion = typeof v === "string" ? v : null;
      } else {
        const kind = Object.keys(rec).find((k) => DECL_KINDS.has(k));
        if (!kind) continue;
        declCount++;
        const body = rec[kind] as Record<string, unknown>;
        const consider = (k: string, d: DeclRef): void => {
          if (target === null && nameKey(t.name(d.name)) === wanted) target = { ...d, kind: k };
        };
        if (kind === "inductive") {
          for (const [group, label] of [
            ["types", "inductive"],
            ["ctors", "ctor"],
            ["recs", "rec"],
          ] as const) {
            for (const d of (body[group] as DeclRef[] | undefined) ?? []) consider(label, d);
          }
        } else {
          const d = body as unknown as DeclRef;
          if (kind === "axiom") axioms.add(renderName(t.name(d.name)));
          consider(kind, d);
        }
      }
    } catch {
      // Dangling name or level id: this record cannot be resolved (it cannot be the target).
    }
  }

  let targetTypeSha256: string | null = null;
  const found = target as (DeclRef & { kind: string }) | null;
  if (found) {
    try {
      targetTypeSha256 = t.typeHash(found.type);
    } catch {
      targetTypeSha256 = null;
    }
  }
  const sorted = [...axioms].sort();
  const standard = STANDARD_AXIOMS as readonly string[];
  return {
    audit: {
      targetFound: found !== null,
      targetKind: found?.kind ?? null,
      targetTypeSha256,
      axioms: sorted,
      standardAxiomsOnly: sorted.every((a) => standard.includes(a)),
      declCount,
    },
    sha256: hash.digest("hex"),
    bytes,
    leanVersion,
  };
}
