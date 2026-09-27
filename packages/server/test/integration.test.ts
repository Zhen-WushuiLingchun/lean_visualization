import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphFileSchema, isStandardAxiom, type GraphFile } from "@proofflow/schema";
import { afterAll, describe, expect, it } from "vitest";
import { extractProject } from "../src/extract.js";
import { detectProject, resolveToolchain, type ProjectInfo } from "../src/project.js";
import { verifyDecl } from "../src/verify.js";
import { removeDir, tempDir } from "./helpers.js";

/**
 * Real pipeline on examples/toy. Opt in with PROOFFLOW_INTEGRATION=1 (needs elan and the toolchain
 * from examples/toy/lean-toolchain). Artefacts go to a temp state dir; only `lake build` touches
 * examples/toy (its .lake/ build output).
 */
const enabled = process.env["PROOFFLOW_INTEGRATION"] === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const toyDir = path.join(repoRoot, "examples", "toy");
const expectedPath = path.join(toyDir, "expected", "graph.json");
const MISSING = `examples/toy/expected/graph.json not found at ${expectedPath}; skipping the golden comparison and real verification.`;

function normalise(g: GraphFile): GraphFile {
  const copy = structuredClone(g);
  copy.meta.generatedAt = "<generatedAt>";
  copy.meta.project.dir = "<projectDir>";
  return copy;
}

describe.skipIf(!enabled)("integration: examples/toy (PROOFFLOW_INTEGRATION=1)", () => {
  const stateDir = tempDir("pf integration");
  let project: ProjectInfo | null = null;
  let graph: GraphFile | null = null;
  afterAll(() => removeDir(stateDir));

  it("extracts examples/toy and matches expected/graph.json", async (ctx) => {
    if (!existsSync(expectedPath)) {
      console.warn(MISSING);
      ctx.skip(MISSING);
      return;
    }
    project = await detectProject(toyDir, { stateDir });
    const res = await extractProject({ project, log: (l) => process.stderr.write(`[extract] ${l}\n`) });
    graph = res.graph;
    const expected = GraphFileSchema.parse(JSON.parse(readFileSync(expectedPath, "utf8")));
    expect(normalise(res.graph)).toEqual(normalise(expected));
  }, 30 * 60_000);

  it("verifies a clean theorem with every available checker; leanchecker accepts", async (ctx) => {
    if (!existsSync(expectedPath) || !project || !graph) {
      ctx.skip(MISSING);
      return;
    }
    const clean = graph.nodes.find(
      (n) => n.isLocal && !n.isAux && n.kind === "theorem" && n.taints.length === 0 && n.axioms.every(isStandardAxiom),
    );
    expect(clean, "examples/toy should contain a clean local theorem").toBeDefined();
    const toolchain = await resolveToolchain(project);
    const result = await verifyDecl({
      project,
      graph,
      decl: clean!.id,
      checkers: "all",
      toolchain,
      log: (l) => process.stderr.write(`[verify] ${l}\n`),
    });
    process.stderr.write(`[verify] ${result.checkers.map((c) => `${c.checker}=${c.status}`).join(" ")}\n`);
    const lc = result.checkers.find((c) => c.checker === "leanchecker");
    expect(lc?.status).toBe("accepted");
    expect(lc?.exitCode).toBe(0);
    expect(result.exportDecls).toBeGreaterThan(0);
  }, 20 * 60_000);
});

describe.skipIf(enabled)("integration (disabled)", () => {
  it.skip("set PROOFFLOW_INTEGRATION=1 to run the real extractor and checkers on examples/toy", () => {});
});
