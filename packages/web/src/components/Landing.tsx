import { useRef, useState, type DragEvent } from "react";
import type { GraphFile } from "@proofflow/schema";
import { parseGraphFile } from "../api/client";
import { STANDALONE_REASON } from "../state/appState";

export const SAMPLE_URL = `${import.meta.env.BASE_URL}fixtures/sample.json`;

export async function loadSampleGraph(): Promise<GraphFile> {
  const res = await fetch(SAMPLE_URL);
  if (!res.ok) throw new Error(`Could not load the sample (HTTP ${res.status}).`);
  const parsed = parseGraphFile(await res.json());
  if (!parsed.ok) throw new Error(`The sample is invalid: ${parsed.issues.join("; ")}`);
  return parsed.graph;
}

export interface LandingProps {
  serverError: string | null;
  onGraph(graph: GraphFile, source: "file" | "sample", label: string): void;
}

export function Landing({ serverError, onGraph }: LandingProps) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const readFile = async (file: File): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not valid JSON.`);
      }
      const parsed = parseGraphFile(json);
      if (!parsed.ok) throw new Error(`${file.name} is not a ProofFlow graph.json:\n${parsed.issues.join("\n")}`);
      onGraph(parsed.graph, "file", file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void readFile(file);
  };
  const sample = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onGraph(await loadSampleGraph(), "sample", "sample.json");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pf-landing">
      <div className="pf-card">
        <h1>ProofFlow</h1>
        <p>An auditable map of a Lean project: axioms on the left, final theorems on the right, and the trust profile of every declaration.</p>
        <p className="pf-note">
          No server answered at <code>/api/graph</code>
          {serverError ? ` (${serverError})` : ""}. You can still open a graph.json produced by <code>pnpm proofflow extract</code>.
        </p>
        <div
          className={`pf-drop${over ? " is-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          Drop graph.json here
          <div className="pf-actions" style={{ justifyContent: "center" }}>
            <button type="button" className="pf-primary" disabled={busy} onClick={() => input.current?.click()}>
              Choose file
            </button>
            <button type="button" disabled={busy} onClick={() => void sample()}>
              Load sample
            </button>
          </div>
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            className="pf-sr"
            aria-label="graph.json file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void readFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {error && <p className="pf-error">{error}</p>}
        <p className="pf-note">{STANDALONE_REASON}</p>
      </div>
    </main>
  );
}
