import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyAll } from "../src/components/VerifyAll";
import { AppContext, DEFAULT_OPTIONS, initialState, type AppContextValue } from "../src/state/appState";
import { VerifyStore } from "../src/state/verifyStore";
import { CHECKERS_435, graphOf, node, result, row } from "./fixtures";

const graph = graphOf([
  node("T.main"),
  node("T.main.rec", { isAux: true }),
  node("Nat.external", { isLocal: false, module: "Init", package: "Init" }),
], ["T.main"]);

function setup(serverMode = true) {
  const verify = new VerifyStore();
  verify.enabled = serverMode;
  verify.checkers = serverMode ? CHECKERS_435 : null;
  const context: AppContextValue = {
    state: { ...initialState, phase: "ready", source: serverMode ? "server" : "file", graph, options: { ...DEFAULT_OPTIONS, hideAux: true, external: "hide" } },
    dispatch: vi.fn(),
    index: null,
    verify,
    highlight: null as unknown as AppContextValue["highlight"],
    serverMode,
    checkers: verify.checkers,
  };
  render(<AppContext.Provider value={context}><VerifyAll /></AppContext.Provider>);
  return verify;
}

afterEach(() => cleanup());

describe("project verification toolbar", () => {
  it("includes hidden auxiliary and external declarations by default", async () => {
    const verify = setup();
    const verifyOne = vi.spyOn(verify, "verify").mockImplementation(async (decl) => result([row("leanchecker", "accepted")], { decl }));
    const button = screen.getByRole("button", { name: "Verify all (3)" });
    expect(button).toHaveProperty("disabled", false);
    expect(screen.getByRole("combobox", { name: "In-flight verification limit" })).toHaveProperty("value", "2");
    fireEvent.click(button);
    await waitFor(() => expect(verifyOne).toHaveBeenCalledTimes(3));
    expect(verifyOne.mock.calls.map(([decl]) => decl)).toEqual(["T.main", "T.main.rec", "Nat.external"]);
    expect(verifyOne.mock.calls[0]?.[1]).toEqual(["leanchecker", "lean4lean", "nanoda", "con-leche", "con-ron"]);
    expect(await screen.findByText(/Project run: 3\/3 done/)).toBeTruthy();
  });

  it("can verify local declarations with the kernel only", async () => {
    const verify = setup();
    const verifyOne = vi.spyOn(verify, "verify").mockImplementation(async (decl) => result([row("leanchecker", "accepted")], { decl }));
    fireEvent.change(screen.getByRole("combobox", { name: "Verification scope" }), { target: { value: "local" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Verification checkers" }), { target: { value: "kernel" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify all (2)" }));
    await waitFor(() => expect(verifyOne).toHaveBeenCalledTimes(2));
    expect(verifyOne.mock.calls.map(([decl, request]) => [decl, request])).toEqual([["T.main", ["leanchecker"]], ["T.main.rec", ["leanchecker"]]]);
    expect(await screen.findByText(/Local run: 2\/2 done/)).toBeTruthy();
  });

  it("holds the shared busy lock and stops after active declarations", async () => {
    const verify = setup();
    const complete = new Map<string, (value: ReturnType<typeof result>) => void>();
    const verifyOne = vi.spyOn(verify, "verify").mockImplementation((decl) => new Promise((resolve) => {
      complete.set(decl, (value) => resolve({ ...value, decl }));
    }));
    fireEvent.click(screen.getByRole("button", { name: "Verify all (3)" }));
    await waitFor(() => expect(verifyOne).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Verify all (3)" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("combobox", { name: "Verification scope" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/2 in flight/).textContent).toContain("T.main.rec");
    fireEvent.click(screen.getByRole("button", { name: "Stop after active" }));
    expect(screen.getByText(/Waiting for active jobs/)).toBeTruthy();
    await act(async () => {
      complete.get("T.main")?.(result([row("leanchecker", "accepted")]));
      complete.get("T.main.rec")?.(result([row("leanchecker", "accepted")]));
    });
    await waitFor(() => expect(screen.getByText(/Project run: 2\/3 done/).textContent).toContain("Stopped."));
    expect(verifyOne).toHaveBeenCalledTimes(2);
  });

  it("sends the selected in-flight limit to the batch runner", async () => {
    const verify = setup();
    const runAll = vi.spyOn(verify, "runAll").mockResolvedValue(null);
    fireEvent.change(screen.getByRole("combobox", { name: "In-flight verification limit" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify all (3)" }));
    expect(runAll).toHaveBeenCalledWith(["T.main", "T.main.rec", "Nat.external"], verify.allRequest(), "all", 4);
  });

  it("explains why standalone verification is unavailable", () => {
    setup(false);
    const button = screen.getByRole("button", { name: "Verify all (3)" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("title")).toContain("needs the ProofFlow server");
  });
});
