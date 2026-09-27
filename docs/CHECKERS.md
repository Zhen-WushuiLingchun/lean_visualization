# Checker CLI reference (verified on `leanprover/lean4:v4.35.0-rc3`, Windows 11, 2026-09-27)

All binaries live in `<toolchain>/bin/` (`~/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/bin`).
Resolve the toolchain from the project's `lean-toolchain` file through `elan`, or simply run every
command through `lake env <cmd> ...` from the project root, which puts the toolchain `bin/` on `PATH`
and sets `LEAN_PATH`. These invocations are the same ones `lake check --paranoid` uses
(`src/lake/Lake/CLI/Check.lean`, `bundledKernels`).

Set `LEAN_ABORT_ON_PANIC=1` in the environment of every checker (Lake does).

## Export

```
lake env leanexport <Module> -- <decl> [<decl> ...]   > closure.ndjson
```
- Exports the declarations and their transitive closure in NDJSON format 3.1.0. First line is a
  `{"meta":...}` object with `lean.version` and `lean.githash`.
- Trivial theorem: 183 lines, ~1 s. A theorem using `sorry`: 10 851 lines (sorryAx pulls in more).
- Unknown declaration: see the "Errors" section below for the exact behaviour.
- `<Module>` must be a module whose `.olean` exists (any module that transitively imports the
  declaration's module works; use the node's own `module`).

## Checkers

| name (schema) | binary | argv | accept | reject | decline |
|---|---|---|---|---|---|
| `leanchecker` | `leanchecker` | `--from-export <file>` | exit 0, prints `Lean default kernel accepts the solution` | exit 1, error text on stderr (`--silent` suppresses all output; do **not** pass it, we want the message) | n/a |
| `leanchecker-paranoid` | `leanchecker-paranoid` | `--from-export <file>` | exit 0, same line | exit 1 | n/a |
| `lean4lean` | `lean4lean` | `--import <file>` | exit 0, prints `checked N declarations` | exit 1, prints a type-mismatch explanation | n/a |
| `nanoda` | `nanoda_bin` | `<config.json>` (single positional arg, see below) | exit 0 (silent unless `print_success_message`) | exit 101 (Rust panic, e.g. `assertion failed: self.def_eq(u, v)`) | exit 101 with `declaration not found in infer_const, <axiom>` when an axiom is not permitted |
| `con-leche` | `con-leche` | `<file>` (defaults to `--verified`) | exit 0, `con-leche: accepted N declarations (--verified)` | exit 1, `con-leche: invalid: type mismatch in theorem t4 [at theorem t4, fold position 12]` | exit 2, `con-leche: not implemented yet: non-standard axiom (<name>)` or `declined (... skipped for tolerated axioms ...) ... via sorryAx` |
| `con-ron` | `con-ron` | `<file>` | exit 0, `con-ron: accepted N declarations (--verified)` | exit 1, `con-ron: rejected: type mismatch in declaration [at thm t4, ...]` | exit 2, `con-ron: declined: non-standard axiom [at axiom <name>, ...]`; exit 3 = usage/internal |

Observed timings on a 7-declaration closure: all under 0.3 s. lean4lean on a 297-declaration closure
(sorry theorem): about 1 s.

### Important behaviours

- **Neither `leanchecker` nor `lean4lean` reject `sorryAx` or custom axioms**: they are axioms, so
  the closure typechecks. That is why L0 (trust profile) exists. `con-leche`/`con-ron` *decline*
  (exit 2) on any non-standard axiom, including the `<decl>._native.native_decide.ax_i_j` axiom that
  `native_decide` mints on 4.35. A decline is reported as `declined`, never as `rejected`.
- `lean4lean` **without** `--import` tries to read `.olean` files and fails on this toolchain with
  `incompatible header`. Always use `--import <ndjson>`.
- `leanchecker` invoked with a module name replays that module from `.olean`s; we do not use that
  mode. `--fresh <Module>` replays everything into a fresh environment (slow, whole-module).
- Rejection by `nanoda` is a panic (exit 101). Treat exit 101 as `rejected` when stderr contains
  `assertion failed` or `type` errors, and as `declined` when it contains `declaration not found in
  infer_const` (unpermitted axiom). Any other non-zero exit is `error`.

### nanoda config file

`nanoda_bin` takes exactly one argument: a path to a JSON config. Lake writes this (temp file):

```json
{
  "use_stdin": false,
  "export_file_path": "<absolute path to closure.ndjson>",
  "permitted_axioms": ["propext", "Classical.choice", "Quot.sound", "...every axiom in the closure..."],
  "unpermitted_axiom_hard_error": false,
  "num_threads": 4,
  "nat_extension": true,
  "string_extension": true
}
```

Without `nat_extension`/`string_extension` nanoda aborts on the first Nat literal
(`Nat lit extension disallowed by checker execution config`). For ProofFlow the permitted list is the
node's transitive `axioms` from `graph.json` (that is the whole point: L0 already reports them, the
checker's job is typing). Alternatively `"unsafe_permit_all_axioms": true` with an empty
`permitted_axioms` and `unpermitted_axiom_hard_error: false` admits every axiom (see test result in the
"Errors" section).

## Errors and edge cases (fill in from the smoke log)

- `leanexport Smoke -- doesNotExist`: see below.
- Export files can be large (Mathlib-scale closures reach hundreds of MB). Stream them to disk; never
  read them into memory just to hash them; hash with a streaming sha256.
- Every checker must be run with a timeout (default 600 s) and `stdin` closed (`/dev/null`); some
  binaries block on an open stdin.
