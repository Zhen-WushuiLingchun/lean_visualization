import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckerName, CheckerStatus } from "@proofflow/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_CHECKERS,
  LEANEXPORT_NOTE,
  MODULE_REPLAY_NOTE,
  checkerAvailability,
  checkerEnvFor,
  listCheckers,
  nanodaConfig,
  parseRejectedDecl,
  runChecker,
  runNanoda,
} from "../src/checkers.js";
import { FakeRunner, fakeToolchain, removeDir, tempDir, type FakeReply } from "./helpers.js";

let dir = "";
let exportFile = "";
beforeAll(() => {
  dir = tempDir();
  exportFile = path.join(dir, "Toy.main-12345678.ndjson");
  writeFileSync(exportFile, "{}\n");
});
afterAll(() => removeDir(dir));

async function statusOf(checker: CheckerName, reply: FakeReply, axioms: string[] = []) {
  const toolchain = fakeToolchain(dir);
  const runner = new FakeRunner(() => reply);
  const r = await runChecker(checker, {
    toolchain,
    exportFile,
    axioms,
    runner,
    timeoutMs: 1000,
    module: "Toy.Basic",
    projectDir: dir,
  });
  return { r, runner };
}

interface Case {
  checker: CheckerName;
  reply: FakeReply;
  status: CheckerStatus;
  rejectedDecl?: string | null;
}

const T4_LEANCHECKER =
  "Lean default kernel rejects the solution: while replaying declaration 't4':\n(kernel) declaration type mismatch, 't4' has type\n  Eq 1 1\nbut it is expected to have type\n  Eq 2 2\n";
const NANODA_ASSERT =
  "thread 'thread_1' panicked at src/tc.rs:955:71:\nassertion failed: self.def_eq(u, v)\nnote: run with `RUST_BACKTRACE=1`\n";
const NANODA_AXIOM = "thread 'thread_0' panicked at src/tc.rs:230:13:\ndeclaration not found in infer_const, myAx\n";
// Verified 2026-09-28 (Windows path separator as printed): the parser refuses unsafe/partial definitions.
const NANODA_SAFETY =
  "thread 'main' (66072) panicked at src\\parser.rs:784:17:\nassertion failed: !matches!(safety, DefinitionSafety::Unsafe | DefinitionSafety::Partial)\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n";
// An assertion inside the type checker that is not the def_eq one is still a typechecking verdict.
const NANODA_TC_OTHER = "thread 'thread_2' panicked at src/tc.rs:1210:9:\nassertion failed: self.is_sort(t)\n";
// An assertion outside the type checker with no typechecking text is a crash.
const NANODA_PARSER_OTHER = "thread 'main' panicked at src/parser.rs:311:5:\nassertion failed: idx < self.names.len()\n";

const cases: Case[] = [
  // leanchecker (L1)
  { checker: "leanchecker", reply: { exitCode: 0, stdout: "Lean default kernel accepts the solution\n" }, status: "accepted" },
  { checker: "leanchecker", reply: { exitCode: 0, stdout: "" }, status: "error" },
  { checker: "leanchecker", reply: { exitCode: 1, stdout: T4_LEANCHECKER }, status: "rejected", rejectedDecl: "t4" },
  { checker: "leanchecker", reply: { exitCode: 2 }, status: "error" },
  { checker: "leanchecker", reply: { exitCode: 134, stderr: "Aborted" }, status: "error" },
  // leanchecker-module (`lake env leanchecker <Module>`, silent on success; verified outputs)
  { checker: "leanchecker-module", reply: { exitCode: 0 }, status: "accepted" },
  {
    checker: "leanchecker-module",
    reply: {
      exitCode: 1,
      stderr:
        "leanchecker found a problem in Smoke.Hack\nuncaught exception: while replaying declaration 'Smoke.bogus':\n(kernel) declaration type mismatch, 'Smoke.bogus' has type\n  True\nbut it is expected to have type\n  False\n",
    },
    status: "rejected",
    rejectedDecl: "Smoke.bogus",
  },
  { checker: "leanchecker-module", reply: { exitCode: 1, stderr: "some kernel complaint" }, status: "rejected", rejectedDecl: null },
  { checker: "leanchecker-module", reply: { exitCode: 1, stderr: "uncaught exception: Could not find any oleans for: Toy.Basic" }, status: "error" },
  { checker: "leanchecker-module", reply: { exitCode: 2 }, status: "error" },
  { checker: "leanchecker-module", reply: { exitCode: 0, stderr: "PANIC at Lean.Environment" }, status: "error" },
  // leanchecker-paranoid
  { checker: "leanchecker-paranoid", reply: { exitCode: 0, stdout: "Lean default kernel accepts the solution\n" }, status: "accepted" },
  { checker: "leanchecker-paranoid", reply: { exitCode: 1, stderr: "(kernel) declaration type mismatch, 'Foo.bar' has type" }, status: "rejected", rejectedDecl: "Foo.bar" },
  { checker: "leanchecker-paranoid", reply: { exitCode: 3 }, status: "error" },
  // lean4lean
  { checker: "lean4lean", reply: { exitCode: 0, stdout: "checked 297 declarations\n" }, status: "accepted" },
  { checker: "lean4lean", reply: { exitCode: 1, stderr: "uncaught exception: at t4: (kernel) declaration type mismatch" }, status: "rejected", rejectedDecl: "t4" },
  { checker: "lean4lean", reply: { exitCode: 127, stderr: "PANIC at Lean.EnvExtension.getStateImpl" }, status: "error" },
  // nanoda
  { checker: "nanoda", reply: { exitCode: 0 }, status: "accepted" },
  { checker: "nanoda", reply: { exitCode: 101, stderr: NANODA_ASSERT }, status: "rejected", rejectedDecl: null },
  { checker: "nanoda", reply: { exitCode: 101, stderr: NANODA_AXIOM }, status: "declined", rejectedDecl: null },
  // Negative control: a Rust panic without typechecking text is a crash, not a counterexample.
  {
    checker: "nanoda",
    reply: {
      exitCode: 101,
      stderr: "thread 'main' panicked at src/util.rs:88:14:\ncalled `Option::unwrap()` on a `None` value\nnote: run with `RUST_BACKTRACE=1`\n",
    },
    status: "error",
    rejectedDecl: null,
  },
  { checker: "nanoda", reply: { exitCode: 101, stderr: "thread 'thread_2' panicked: type mismatch in app\n" }, status: "rejected" },
  // Tool limitation, not a counterexample: unsafe/partial declarations (e.g. `_unsafe_rec` auxiliaries).
  { checker: "nanoda", reply: { exitCode: 101, stderr: NANODA_SAFETY }, status: "declined", rejectedDecl: null },
  { checker: "nanoda", reply: { exitCode: 101, stderr: NANODA_TC_OTHER }, status: "rejected", rejectedDecl: null },
  { checker: "nanoda", reply: { exitCode: 101, stderr: NANODA_PARSER_OTHER }, status: "error", rejectedDecl: null },
  // `infer_const` belongs to the declined pattern; a plain inference failure is a verdict.
  { checker: "nanoda", reply: { exitCode: 101, stderr: "thread 'thread_1' panicked at src/tc.rs:88:9:\nfailed to infer type of application\n" }, status: "rejected" },
  { checker: "nanoda", reply: { exitCode: 1, stderr: "Error: failed to open configuration file" }, status: "error" },
  { checker: "nanoda", reply: { exitCode: 2 }, status: "error" },
  // con-leche
  { checker: "con-leche", reply: { exitCode: 0, stdout: "con-leche: accepted 38 declarations (--verified)\n" }, status: "accepted" },
  { checker: "con-leche", reply: { exitCode: 1, stderr: "con-leche: invalid: type mismatch in theorem t4 [at theorem t4, fold position 12]" }, status: "rejected", rejectedDecl: "t4" },
  { checker: "con-leche", reply: { exitCode: 2, stderr: "con-leche: not implemented yet: non-standard axiom (myAx) [at axiom myAx, fold position 11]" }, status: "declined", rejectedDecl: null },
  { checker: "con-leche", reply: { exitCode: 2, stderr: "con-leche: declined (295 declarations checked, 1 skipped for tolerated axioms) (--verified): 1 via sorryAx" }, status: "declined" },
  { checker: "con-leche", reply: { exitCode: 4 }, status: "error" },
  // con-ron
  { checker: "con-ron", reply: { exitCode: 0, stdout: "con-ron: accepted 7 declarations (--verified)\n" }, status: "accepted" },
  { checker: "con-ron", reply: { exitCode: 1, stderr: "con-ron: rejected: type mismatch in declaration [at thm t4, fold position 13]" }, status: "rejected", rejectedDecl: "t4" },
  { checker: "con-ron", reply: { exitCode: 2, stderr: "con-ron: declined: non-standard axiom [at axiom myAx, fold position 11]" }, status: "declined" },
  { checker: "con-ron", reply: { exitCode: 3, stderr: "usage: con-ron ..." }, status: "error" },
];

describe("exit-code mapping per docs/CHECKERS.md", () => {
  it.each(cases)("$checker exit $reply.exitCode -> $status", async ({ checker, reply, status, rejectedDecl }) => {
    const { r } = await statusOf(checker, reply);
    expect(r.status).toBe(status);
    expect(r.exitCode).toBe(reply.exitCode);
    if (rejectedDecl !== undefined) expect(r.rejectedDecl).toBe(rejectedDecl);
    if (status !== "rejected") expect(r.rejectedDecl).toBeNull();
  });

  it.each(ALL_CHECKERS)("%s: never accepted on a non-zero exit, even with the success line", async (checker) => {
    const { r } = await statusOf(checker, {
      exitCode: 1,
      stdout: "Lean default kernel accepts the solution\nchecked 1 declarations\ncon-leche: accepted 1 declarations\ncon-ron: accepted 1 declarations\n",
    });
    expect(r.status).not.toBe("accepted");
  });

  it.each(ALL_CHECKERS)("%s: timeout -> timeout", async (checker) => {
    const { r } = await statusOf(checker, { timedOut: true, durationMs: 1000 });
    expect(r.status).toBe("timeout");
    expect(r.exitCode).toBeNull();
  });

  it.each(ALL_CHECKERS)("%s: PANIC with exit 0 -> error", async (checker) => {
    const { r } = await statusOf(checker, { exitCode: 0, stdout: "Lean default kernel accepts the solution\nchecked 1 declarations\ncon-leche: accepted 1 declarations\ncon-ron: accepted 1 declarations\n", stderr: "PANIC at Foo" });
    expect(r.status).toBe("error");
  });

  it.each(ALL_CHECKERS)("%s: missing binary -> unavailable, nothing spawned", async (checker) => {
    const sub = tempDir();
    try {
      const toolchain = fakeToolchain(sub, []);
      const runner = new FakeRunner(() => ({ exitCode: 0 }));
      const r = await runChecker(checker, { toolchain, exportFile, axioms: [], runner });
      expect(r.status).toBe("unavailable");
      expect(r.exitCode).toBeNull();
      expect(runner.calls).toHaveLength(0);
    } finally {
      removeDir(sub);
    }
  });

  it("spawn ENOENT -> unavailable; other spawn errors -> error", async () => {
    expect((await statusOf("leanchecker", { spawnError: "ENOENT" })).r.status).toBe("unavailable");
    expect((await statusOf("leanchecker", { spawnError: "EACCES" })).r.status).toBe("error");
  });
});

describe("argv, environment and stdin", () => {
  it.each([
    ["leanchecker", ["--from-export"]],
    ["leanchecker-paranoid", ["--from-export"]],
    ["lean4lean", ["--import"]],
    ["con-leche", []],
    ["con-ron", []],
  ] as const)("%s gets %j then the export path", async (checker, flags) => {
    const { r, runner } = await statusOf(checker, { exitCode: 0 });
    expect(r.command.slice(1)).toEqual([...flags, exportFile]);
    const call = runner.calls[0];
    expect(call?.opts.stdin).toBe("ignore");
    // lean4lean aborts inside its own error printer under LEAN_ABORT_ON_PANIC, so it runs without it.
    expect(call?.opts.env?.["LEAN_ABORT_ON_PANIC"]).toBe(checker === "lean4lean" ? undefined : "1");
    expect(call?.opts.timeoutMs).toBe(1000);
    expect(path.basename(r.command[0] ?? "")).toMatch(new RegExp(`^${checker}(\\.exe)?$`));
  });

  it("nanoda gets a single config path and the config follows docs/CHECKERS.md", async () => {
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(() => ({ exitCode: 0 }));
    const r = await runNanoda({ toolchain, exportFile, axioms: ["sorryAx", "Toy.myAxiom", "propext"], runner });
    expect(r.status).toBe("accepted");
    expect(path.basename(r.command[0] ?? "")).toMatch(/^nanoda_bin(\.exe)?$/);
    expect(r.command).toHaveLength(2);
    const configPath = r.command[1] ?? "";
    expect(path.dirname(configPath)).toBe(path.dirname(exportFile));
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(config).toEqual({
      use_stdin: false,
      export_file_path: path.resolve(exportFile),
      permitted_axioms: ["Classical.choice", "Quot.sound", "Toy.myAxiom", "propext", "sorryAx"],
      unpermitted_axiom_hard_error: false,
      num_threads: 4,
      nat_extension: true,
      string_extension: true,
    });
    expect(path.isAbsolute(config["export_file_path"] as string)).toBe(true);
    expect(config).not.toHaveProperty("unsafe_permit_all_axioms");
  });

  it("nanodaConfig always includes the standard three, deduplicated", () => {
    const c = nanodaConfig("x.ndjson", ["propext", "propext"]);
    expect(c["permitted_axioms"]).toEqual(["Classical.choice", "Quot.sound", "propext"]);
  });
});

describe("nanoda crash keeps its stderr", () => {
  it("an unknown panic is `error` with the panic text preserved", async () => {
    const stderr = "thread 'main' panicked at src/util.rs:88:14:\ncalled `Option::unwrap()` on a `None` value\n";
    const { r } = await statusOf("nanoda", { exitCode: 101, stderr });
    expect(r.status).toBe("error");
    expect(r.stderrTail).toContain("Option::unwrap()");
    expect(r.binarySha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("leanchecker-module", () => {
  it("runs `lake env leanchecker <module>` in the project dir, stdin closed, aborting on panic", async () => {
    const { r, runner } = await statusOf("leanchecker-module", { exitCode: 0 });
    const toolchain = fakeToolchain(dir);
    const call = runner.calls[0];
    expect(call?.cmd).toBe(toolchain.lake);
    expect(call?.args).toEqual(["env", "leanchecker", "Toy.Basic"]);
    expect(call?.opts.cwd).toBe(dir);
    expect(call?.opts.stdin).toBe("ignore");
    expect(call?.opts.env?.["LEAN_ABORT_ON_PANIC"]).toBe("1");
    expect(r.command).toEqual([toolchain.lake, "env", "leanchecker", "Toy.Basic"]);
    expect(runner.calls.some((c) => c.args.includes("leanexport"))).toBe(false);
  });

  it("is available without leanexport; export-based checkers are not", async () => {
    const sub = tempDir();
    try {
      const toolchain = fakeToolchain(sub, ["leanchecker"], { leanexport: false });
      const infos = listCheckers(toolchain);
      const byName = new Map(infos.map((i) => [i.checker, i]));
      expect(byName.get("leanchecker-module")).toMatchObject({ available: true, level: "L1", note: MODULE_REPLAY_NOTE });
      expect(byName.get("leanchecker")).toMatchObject({ available: false, path: null, note: LEANEXPORT_NOTE });
      for (const c of ["leanchecker-paranoid", "lean4lean", "nanoda", "con-leche", "con-ron"] as const) {
        expect(byName.get(c)).toMatchObject({ available: false, note: LEANEXPORT_NOTE });
      }
      expect(checkerAvailability(toolchain, "leanchecker").available).toBe(false);
      // Running an export-based checker without leanexport spawns nothing.
      const runner = new FakeRunner(() => ({ exitCode: 0 }));
      const r = await runChecker("leanchecker", { toolchain, exportFile: null, runner });
      expect(r.status).toBe("unavailable");
      expect(runner.calls).toHaveLength(0);
    } finally {
      removeDir(sub);
    }
  });

  it("notes a missing binary when leanexport exists, and has no note when available", () => {
    const sub = tempDir();
    try {
      const infos = listCheckers(fakeToolchain(sub, ["leanchecker"]));
      expect(infos.find((i) => i.checker === "leanchecker")?.note).toBeNull();
      expect(infos.find((i) => i.checker === "lean4lean")?.note).toMatch(/not in this toolchain/);
      expect(listCheckers(null).every((i) => !i.available && i.note !== null)).toBe(true);
    } finally {
      removeDir(sub);
    }
  });
});

describe("lean4lean rejections", () => {
  // Verbatim shape of lean4lean's output on a tampered export (v4.35.0-rc3, Windows).
  const PRINTER_PANIC =
    "PANIC at _private.Lean.Environment.0.Lean.EnvExtension.getStateImpl Lean.Environment:1376:4: invalid environment extension has been accessed";
  const MISMATCH = "uncaught exception: at t4: (kernel) declaration type mismatch, 't4' has type\n  [Error pretty printing expression]";

  it("plain exit 1 with the kernel message -> rejected at t4", async () => {
    const { r } = await statusOf("lean4lean", { exitCode: 1, stderr: `${PRINTER_PANIC}\n${PRINTER_PANIC}\n${MISMATCH}\n` });
    expect(r.status).toBe("rejected");
    expect(r.rejectedDecl).toBe("t4");
  });

  it("Windows abort 0xC0000409 after the mismatch text -> still rejected at t4 (text fallback)", async () => {
    const { r } = await statusOf("lean4lean", {
      exitCode: 0xc0000409,
      stderr: `${PRINTER_PANIC}\n${MISMATCH}\nbut it is expected to have type\n  Eq 2 2\n`,
    });
    expect(r.exitCode).toBe(3221226505);
    expect(r.status).toBe("rejected");
    expect(r.rejectedDecl).toBe("t4");
  });

  it("an abort with only a PANIC and no kernel message stays an error", async () => {
    const { r } = await statusOf("lean4lean", { exitCode: 0xc0000409, stderr: `${PRINTER_PANIC}\n` });
    expect(r.status).toBe("error");
  });

  it("the mismatch text never lets a run count as accepted", async () => {
    const { r } = await statusOf("lean4lean", { exitCode: 0, stdout: "checked 3 declarations\n", stderr: MISMATCH });
    expect(r.status).toBe("rejected");
  });

  it("runs without LEAN_ABORT_ON_PANIC even when the toolchain env sets it", () => {
    const env = { PATH: "x", LEAN_ABORT_ON_PANIC: "1" };
    expect(checkerEnvFor("lean4lean", env)).toEqual({ PATH: "x" });
    for (const c of ALL_CHECKERS.filter((x) => x !== "lean4lean")) {
      expect(checkerEnvFor(c, { PATH: "x" })["LEAN_ABORT_ON_PANIC"]).toBe("1");
    }
  });
});

describe("parseRejectedDecl", () => {
  it("reads the declaration from each checker's message style", () => {
    expect(parseRejectedDecl("while replaying declaration 'Foo.«bar baz»':")).toBe("Foo.«bar baz»");
    expect(parseRejectedDecl("'t4' has type")).toBe("t4");
    expect(parseRejectedDecl("[at theorem t4, fold position 12]")).toBe("t4");
    expect(parseRejectedDecl("[at thm Nat.foo, fold position 13]")).toBe("Nat.foo");
    expect(parseRejectedDecl("nothing here")).toBeNull();
  });
});

describe("listCheckers", () => {
  it("reports availability, level, path and toolchain version", () => {
    const sub = tempDir();
    try {
      const toolchain = fakeToolchain(sub, ["leanchecker", "nanoda"]);
      const infos = listCheckers(toolchain);
      expect(infos.map((i) => i.checker)).toEqual([...ALL_CHECKERS]);
      const lc = infos.find((i) => i.checker === "leanchecker");
      expect(lc).toMatchObject({ available: true, level: "L1", version: "toolchain 4.35.0-rc3" });
      expect(infos.find((i) => i.checker === "nanoda")?.available).toBe(true);
      expect(infos.find((i) => i.checker === "lean4lean")).toMatchObject({ available: false, path: null, level: "L2" });
      expect(listCheckers(null).every((i) => !i.available)).toBe(true);
    } finally {
      removeDir(sub);
    }
  });
});
