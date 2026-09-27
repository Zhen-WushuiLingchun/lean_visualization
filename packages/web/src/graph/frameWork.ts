/** Cooperative, cancellable work for optional all-edge rendering. No idle frames are scheduled. */
export function runFrameWork(
  total: number,
  process: (index: number) => void,
  complete: () => void,
  opts: { budgetMs?: number; maxItemsPerFrame?: number; now?: () => number; raf?: (cb: FrameRequestCallback) => number; cancel?: (id: number) => void } = {},
): () => void {
  const budgetMs = opts.budgetMs ?? 7;
  const maxItems = opts.maxItemsPerFrame ?? 4096;
  const now = opts.now ?? (() => performance.now());
  const raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
  const cancel = opts.cancel ?? ((id) => cancelAnimationFrame(id));
  let index = 0;
  let frame: number | null = null;
  let stopped = false;
  const step = (): void => {
    frame = null;
    if (stopped) return;
    const start = now();
    let count = 0;
    while (index < total && count < maxItems) {
      process(index++);
      count++;
      if (count % 64 === 0 && now() - start >= budgetMs) break;
    }
    if (index === total) complete();
    else frame = raf(step);
  };
  frame = raf(step);
  return () => {
    stopped = true;
    if (frame !== null) cancel(frame);
    frame = null;
  };
}
