# README screenshots

These PNGs are unedited browser screenshots of ProofFlow's production build with the public
`examples/toy` project. They were captured on 2026-09-27 in Chromium at 1600 × 1050, light theme.
No private research project, machine path, source popup, or checker command log is displayed.

- `proof-workflow.png`: the dependency cone of `Toy.cleanMain`, after verification with the
  UI's all-available-checkers option. External declarations are collapsed and auxiliary nodes hidden.
- `checker-results.png`: the cone of `Toy.everything`, with the node panel scrolled to verification.
  The table shows five accepted rows (including module replay) and two declined rows. The CLI's
  six export-based checkers are a different selection from the UI's seven available rows here.

To reproduce, build ProofFlow, extract and serve `examples/toy`, then search each declaration and
press Shift+Enter. Run **Verify (all checkers)** and wait for the result. For the workflow image,
close the panel with Escape and choose Fit. For the results image, leave the panel open, choose Fit,
and scroll the panel to the verification table. Capture the browser viewport without browser chrome.
Timing values and layout may vary between machines.
