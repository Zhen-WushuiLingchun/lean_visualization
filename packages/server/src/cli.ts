#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import type { CheckerResult, GraphFile, VerifyResult } from "@proofflow/schema";
import { Command, InvalidArgumentError } from "commander";
import { createApp, DEFAULT_PORT, type ExtractDefaults, type VerifyDefaults } from "./api.js";
import { LEANEXPORT_NOTE, isExportBased, listCheckers } from "./checkers.js";
import { DEFAULT_BUILD_TIMEOUT_MS, DEFAULT_EXTRACT_TIMEOUT_MS, extractProject } from "./extract.js";
import { DEFAULT_EXPORT_TIMEOUT_MS, formatBytes, formatMs } from "./export.js";
import { DEFAULT_CHECKER_TIMEOUT_MS } from "./checkers.js";
import { JobManager } from "./jobs.js";
import { detectProject, resolveToolchain, type ProjectInfo } from "./project.js";
import { GraphStore } from "./store.js";
import { parseCheckerList, verifyDecl } from "./verify.js";

const VERSION = "0.1.0";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("Expected a positive integer.");
  return n;
}

/** Timeout in seconds; 0 means no wall-clock limit (the process is never killed for time). */
function seconds(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("Expected a whole number of seconds (0 = no limit).");
  return n;
}

function port(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new InvalidArgumentError("Expected a port number.");
  return n;
}

/** Seconds from a flag, else from `PROOFFLOW_<NAME>` (seconds), else the default (ms). */
function timeoutMs(flag: number | undefined, envName: string, fallbackMs: number): number {
  if (flag !== undefined) return flag * 1000;
  const raw = process.env[envName];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n * 1000; // 0 = no wall-clock limit
  }
  return fallbackMs;
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

function fail(e: unknown, code = 1): void {
  err(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = code;
}

function pad(s: string, n: number): string {
  return s.length >= n ? `${s} ` : s.padEnd(n);
}

function printStats(graph: GraphFile, outPath: string, durationMs: number): void {
  const s = graph.stats;
  const kinds = Object.entries(s.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const taints = Object.entries(s.byTaint)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  console.log(`wrote ${outPath} (${formatMs(durationMs)})`);
  console.log(`nodes    ${s.nodes} (local ${s.localNodes}, external ${s.externalNodes}), edges ${s.edges}`);
  console.log(`kinds    ${kinds || "none"}`);
  console.log(`taints   ${taints || "none (local nodes rest on standard axioms only)"}`);
  console.log(`sinks    ${s.localSinks.length}${s.localSinks.length ? `: ${s.localSinks.slice(0, 8).join(", ")}${s.localSinks.length > 8 ? ", ..." : ""}` : ""}`);
  console.log(`axioms   ${s.axiomNodes.length ? s.axiomNodes.join(", ") : "none"}`);
}

function noteOf(r: CheckerResult, noExport = false): string {
  if (r.status === "accepted" || r.status === "skipped") return "";
  if (r.rejectedDecl) return `at ${r.rejectedDecl}`;
  if (r.status === "unavailable") return noExport && isExportBased(r.checker) ? LEANEXPORT_NOTE : "binary not in toolchain";
  if (r.status === "timeout") return "timed out";
  const lines = `${r.stderrTail}\n${r.stdoutTail}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^note: run with/.test(l));
  const priorities = [
    /assertion failed|declaration not found in infer_const/,
    /declined|non-standard|reject|invalid|mismatch/i,
    /PANIC|error|panicked/i,
  ];
  let line = lines[0] ?? "";
  for (const re of priorities) {
    const hit = lines.find((l) => re.test(l));
    if (hit) {
      line = hit;
      break;
    }
  }
  return line.length > 90 ? `${line.slice(0, 87)}...` : line;
}

function printVerify(r: VerifyResult): void {
  console.log(`verify   ${r.decl}`);
  console.log(`module   ${r.module}`);
  if (r.exportDecls === null) {
    // No leanexport run: the key is the module's .olean (or a synthetic hash when none was found).
    const olean = r.exportBytes > 0 ? `.olean ${formatBytes(r.exportBytes)}, sha256 ${r.exportHash.slice(0, 12)}` : "no .olean found";
    console.log(`export   none, module replay of ${r.module} (${olean})`);
  } else {
    console.log(
      `export   ${r.exportDecls} decls, ${formatBytes(r.exportBytes)}, sha256 ${r.exportHash.slice(0, 12)}, ${formatMs(r.exportDurationMs)}`,
    );
  }
  const a = r.exportAudit;
  if (a) {
    console.log(
      `target   ${a.targetFound ? `found (${a.targetKind ?? "?"})` : "NOT FOUND"}, type sha256 ${a.targetTypeSha256 ?? "n/a"}, ` +
        `axioms: ${a.axioms.length ? a.axioms.join(", ") : "none"}, standard only: ${a.standardAxiomsOnly ? "yes" : "no"}`,
    );
  }
  console.log(`binding  .olean sha256 ${r.binding.oleanSha256 ?? "unknown"}, ${r.binding.toolchain ?? "toolchain unknown"}`);
  console.log(`lean     ${r.leanVersion}`);
  console.log("");
  console.log(`${pad("checker", 22)}${pad("status", 13)}${pad("exit", 6)}${pad("time", 10)}note`);
  for (const c of r.checkers) {
    console.log(
      `${pad(c.checker, 22)}${pad(c.status, 13)}${pad(c.exitCode === null ? "-" : String(c.exitCode), 6)}${pad(formatMs(c.durationMs), 10)}${noteOf(c, r.exportDecls === null)}`,
    );
  }
  console.log("");
  console.log(`verdict  ${r.verdict}`);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer.exe", [url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true, shell: false, windowsHide: true });
    child.on("error", () => err(`Could not open a browser. Visit ${url}`));
    child.unref();
  } catch {
    err(`Could not open a browser. Visit ${url}`);
  }
}

interface ExtractFlags {
  project: string;
  root: string[];
  localPrefix: string[];
  expandExternal?: boolean;
  build: boolean;
  statements: boolean;
  statementMaxChars?: number;
  timeout?: number;
  buildTimeout?: number;
}

function extractDefaultsOf(flags: ExtractFlags): ExtractDefaults {
  return {
    ...(flags.root.length ? { roots: flags.root } : {}),
    ...(flags.localPrefix.length ? { localPrefixes: flags.localPrefix } : {}),
    expandExternal: flags.expandExternal ?? false,
    build: flags.build,
    statements: flags.statements,
    ...(flags.statementMaxChars !== undefined ? { statementMaxChars: flags.statementMaxChars } : {}),
    timeoutMs: timeoutMs(flags.timeout, "PROOFFLOW_EXTRACT_TIMEOUT", DEFAULT_EXTRACT_TIMEOUT_MS),
    buildTimeoutMs: timeoutMs(flags.buildTimeout, "PROOFFLOW_BUILD_TIMEOUT", DEFAULT_BUILD_TIMEOUT_MS),
  };
}

async function runExtract(project: ProjectInfo, defaults: ExtractDefaults): Promise<void> {
  const res = await extractProject({ ...defaults, project, log: (l) => err(l) });
  printStats(res.graph, res.outPath, res.durationMs);
}

function addExtractFlags(cmd: Command): Command {
  return cmd
    .option("--root <module>", "root module to import (repeatable; default: every lean_lib)", collect, [])
    .option("--local-prefix <prefix>", "module prefix treated as local (repeatable)", collect, [])
    .option("--expand-external", "emit the full closure of external declarations")
    .option("--no-build", "skip lake build")
    .option("--no-statements", "do not pretty-print statements")
    .option("--statement-max-chars <n>", "truncate statements to n characters", positiveInt)
    .option("--timeout <seconds>", "extractor timeout (default 1800; 0 = no limit)", seconds)
    .option("--build-timeout <seconds>", "lake build timeout (default 3600; 0 = no limit)", seconds);
}

const program = new Command();
program
  .name("proofflow")
  .description("Auditable axiom-to-theorem workflow graphs for Lean 4 projects, with per-node verification.")
  .version(VERSION);

addExtractFlags(
  program
    .command("extract")
    .description("build the project and write .proofflow/graph.json")
    .option("--project <dir>", "Lean project root", "."),
).action(async (flags: ExtractFlags) => {
  try {
    const project = await detectProject(flags.project);
    await runExtract(project, extractDefaultsOf(flags));
  } catch (e) {
    fail(e);
  }
});

interface ServeFlags extends ExtractFlags {
  port: number;
  host: string;
  open?: boolean;
  extract: boolean;
  exportTimeout?: number;
  checkerTimeout?: number;
}

addExtractFlags(
  program
    .command("serve")
    .description("serve the API and the web app (extracts first when graph.json is missing)")
    .option("--project <dir>", "Lean project root", ".")
    .option("--port <port>", "port to listen on", port, DEFAULT_PORT)
    .option("--host <host>", "interface to bind", "127.0.0.1")
    .option("--open", "open the browser")
    .option("--no-extract", "do not extract when graph.json is missing")
    .option("--export-timeout <seconds>", "leanexport timeout (default 600; 0 = no wall-clock kill)", seconds)
    .option("--checker-timeout <seconds>", "per-checker timeout (default 600; 0 = no wall-clock kill)", seconds),
).action(async (flags: ServeFlags) => {
  try {
    const project = await detectProject(flags.project);
    const extractDefaults = extractDefaultsOf(flags);
    const graphs = GraphStore.forProject(project);
    if (!existsSync(graphs.file)) {
      if (flags.extract) {
        err("graph.json missing, extracting first");
        await runExtract(project, extractDefaults);
      } else {
        err("graph.json missing; the viewer stays empty until POST /api/extract or proofflow extract");
      }
    }
    const verifyDefaults: VerifyDefaults = {
      exportTimeoutMs: timeoutMs(flags.exportTimeout, "PROOFFLOW_EXPORT_TIMEOUT", DEFAULT_EXPORT_TIMEOUT_MS),
      checkerTimeoutMs: timeoutMs(flags.checkerTimeout, "PROOFFLOW_CHECKER_TIMEOUT", DEFAULT_CHECKER_TIMEOUT_MS),
    };
    const jobs = new JobManager({
      onLog: (job, line) => err(`[${job.kind}${job.decl ? ` ${job.decl}` : ""}] ${line}`),
    });
    const app = createApp({ project, graphs, jobs, extract: extractDefaults, verify: verifyDefaults });
    const server = serve({ fetch: app.fetch, port: flags.port, hostname: flags.host }, (info) => {
      const shownHost = flags.host === "0.0.0.0" || flags.host === "::" ? "localhost" : flags.host;
      const url = `http://${shownHost}:${info.port}`;
      console.log(`ProofFlow serving ${project.name} at ${url}`);
      if (flags.open) openBrowser(url);
    });
    server.on("error", (e: NodeJS.ErrnoException) => {
      fail(e.code === "EADDRINUSE" ? new Error(`port ${flags.port} is in use; pass --port`) : e);
      process.exit(1);
    });
    const shutdown = (): void => {
      server.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (e) {
    fail(e);
  }
});

interface VerifyFlags {
  project: string;
  checkers: string;
  force?: boolean;
  json?: boolean;
  verbose?: boolean;
  exportTimeout?: number;
  checkerTimeout?: number;
}

program
  .command("verify <decl>")
  .description("export a declaration's closure and replay it through the checkers (exit 0 accepted, 1 rejected, 2 otherwise)")
  .option("--project <dir>", "Lean project root", ".")
  .option("--checkers <list>", "comma-separated checkers, 'all' (every available checker; leanchecker-module only without leanexport) or 'L1' (leanchecker, or leanchecker-module without leanexport)", "L1")
  .option("--force", "re-export and ignore cached results")
  .option("--json", "print the VerifyResult as JSON")
  .option("--verbose", "stream logs to stderr (also with --json)")
  .option("--export-timeout <seconds>", "leanexport timeout (default 600; 0 = no wall-clock kill)", seconds)
  .option("--checker-timeout <seconds>", "per-checker timeout (default 600; 0 = no wall-clock kill)", seconds)
  .action(async (decl: string, flags: VerifyFlags) => {
    try {
      const project = await detectProject(flags.project);
      const selection = parseCheckerList(flags.checkers);
      const loaded = await GraphStore.forProject(project).get();
      if (!loaded) throw new Error(`graph.json not found in ${project.stateDir}. Run proofflow extract first.`);
      const showLogs = flags.verbose === true || flags.json !== true;
      const result = await verifyDecl({
        project,
        graph: loaded.graph,
        decl,
        checkers: selection,
        force: flags.force ?? false,
        graphMtimeMs: loaded.mtimeMs,
        exportTimeoutMs: timeoutMs(flags.exportTimeout, "PROOFFLOW_EXPORT_TIMEOUT", DEFAULT_EXPORT_TIMEOUT_MS),
        checkerTimeoutMs: timeoutMs(flags.checkerTimeout, "PROOFFLOW_CHECKER_TIMEOUT", DEFAULT_CHECKER_TIMEOUT_MS),
        ...(showLogs ? { log: (l: string) => err(l) } : {}),
      });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else printVerify(result);
      process.exitCode = result.verdict === "accepted" ? 0 : result.verdict === "rejected" ? 1 : 2;
    } catch (e) {
      fail(e, 2);
    }
  });

program
  .command("checkers")
  .description("list the checkers available in the project's toolchain")
  .option("--project <dir>", "Lean project root", ".")
  .option("--json", "print CheckerInfo[] as JSON")
  .action(async (flags: { project: string; json?: boolean }) => {
    try {
      const project = await detectProject(flags.project);
      const tc = await resolveToolchain(project);
      const infos = listCheckers(tc);
      if (flags.json) {
        console.log(JSON.stringify(infos, null, 2));
        return;
      }
      console.log(`toolchain ${tc.leanVersion ?? "unknown"}, binaries in ${tc.binDir}`);
      console.log(`${pad("checker", 22)}${pad("level", 7)}${pad("available", 11)}${pad("version", 22)}note`);
      for (const i of infos) {
        console.log(
          `${pad(i.checker, 22)}${pad(i.level, 7)}${pad(i.available ? "yes" : "no", 11)}${pad(i.version ?? "-", 22)}${i.note ?? ""}`,
        );
      }
    } catch (e) {
      fail(e);
    }
  });

await program.parseAsync(process.argv);
