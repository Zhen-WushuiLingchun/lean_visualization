import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GraphFile, Node } from "@proofflow/schema";
import { parseGraph } from "./extract.js";
import type { ProjectInfo } from "./project.js";

export function graphPathOf(project: Pick<ProjectInfo, "stateDir">): string {
  return path.join(project.stateDir, "graph.json");
}

export interface LoadedGraph {
  graph: GraphFile;
  /** Serialised validated graph, reused for every GET /api/graph. */
  json: string;
  byId: Map<string, Node>;
  mtimeMs: number;
}

/** Loads graph.json lazily, validates it once, and reloads when the file changes. */
export class GraphStore {
  private loaded: LoadedGraph | null = null;
  private loading: Promise<LoadedGraph | null> | null = null;

  constructor(readonly file: string) {}

  static forProject(project: Pick<ProjectInfo, "stateDir">): GraphStore {
    return new GraphStore(graphPathOf(project));
  }

  /** Null when graph.json does not exist. Throws `ExtractError` when it is invalid. */
  async get(): Promise<LoadedGraph | null> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.file)).mtimeMs;
    } catch {
      this.loaded = null;
      return null;
    }
    if (this.loaded && this.loaded.mtimeMs === mtimeMs) return this.loaded;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const graph = parseGraph(await readFile(this.file, "utf8"), this.file);
          this.loaded = { graph, json: JSON.stringify(graph), byId: new Map(graph.nodes.map((n) => [n.id, n])), mtimeMs };
          return this.loaded;
        } finally {
          this.loading = null;
        }
      })();
    }
    return this.loading;
  }

  invalidate(): void {
    this.loaded = null;
  }
}
