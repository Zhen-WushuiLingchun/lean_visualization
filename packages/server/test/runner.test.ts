import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LineSplitter, ProcessRunner, TAIL_LIMIT, Tail } from "../src/runner.js";

const node = process.execPath;
const runner = new ProcessRunner();

describe("ProcessRunner (real child processes, no shell)", () => {
  it("captures exit code, streams lines and keeps bounded tails", async () => {
    const lines: string[] = [];
    const r = await runner.run(
      node,
      ["-e", "process.stdout.write('a\\r\\nb\\n' + 'x'.repeat(10000)); console.error('err line'); process.exit(3)"],
      { timeoutMs: 20_000, stdin: "ignore", onLine: (s, l) => lines.push(`${s}:${l.slice(0, 5)}`) },
    );
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeNull();
    expect(r.stdout.length).toBe(TAIL_LIMIT);
    expect(r.stdout.endsWith("xxx")).toBe(true);
    expect(r.stderr.trim()).toBe("err line");
    expect(lines).toContain("stdout:a");
    expect(lines).toContain("stdout:b");
    expect(lines).toContain("stdout:xxxxx");
    expect(lines).toContain("stderr:err l");
  });

  it("passes arguments with spaces and non-ASCII characters verbatim", async () => {
    const arg = "F:/学习 和/研究 's \"q\" & | ;";
    const r = await runner.run(node, ["-e", "process.stdout.write(process.argv[1])", arg], { timeoutMs: 20_000 });
    expect(r.stdout).toBe(arg);
  });

  it("closes stdin so readers see EOF instead of blocking", async () => {
    const r = await runner.run(
      node,
      ["-e", "let n=0; process.stdin.on('data', d => n += d.length); process.stdin.on('end', () => { console.log('eof ' + n); })"],
      { timeoutMs: 20_000, stdin: "ignore" },
    );
    expect(r.stdout.trim()).toBe("eof 0");
  });

  it("kills the process on timeout", async () => {
    const r = await runner.run(node, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(15_000);
  });

  it("reports a missing binary as a spawn error", async () => {
    const r = await runner.run("definitely-not-a-binary-proofflow", [], { timeoutMs: 5000 });
    expect(r.spawnError).toBe("ENOENT");
    expect(r.exitCode).toBeNull();
  });

  it("pipes stdout into a sink when asked", async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise((resolve) => sink.on("end", resolve));
    const r = await runner.run(node, ["-e", "process.stdout.write('hello sink')"], { timeoutMs: 20_000, stdoutSink: sink });
    await done;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(Buffer.concat(chunks).toString()).toBe("hello sink");
  });
});

describe("Tail and LineSplitter", () => {
  it("keeps only the last characters", () => {
    const t = new Tail(5);
    t.push("abc");
    t.push("defgh");
    expect(t.toString()).toBe("defgh");
    for (let i = 0; i < 100; i++) t.push("xy");
    expect(t.toString()).toBe("yxyxy");
  });

  it("joins lines across chunks and strips CR", () => {
    const out: string[] = [];
    const s = new LineSplitter((l) => out.push(l));
    s.push("ab");
    s.push("c\r\nde");
    s.push("f\n\ng");
    s.end();
    expect(out).toEqual(["abc", "def", "", "g"]);
  });
});
