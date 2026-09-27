import { buildIndex, type GraphIndex } from "./graphIndex";
import { prepareView, toWireView, type ViewWorkerRequest, type ViewWorkerResponse, type WireView } from "./viewPipeline";

let index: GraphIndex | null = null;
const cache = new Map<string, WireView>();
const CACHE_LIMIT = 2;
const send = (message: ViewWorkerResponse): void => self.postMessage(message);

self.onmessage = (event: MessageEvent<ViewWorkerRequest>): void => {
  const request = event.data;
  if (request.type === "init") {
    index = buildIndex(request.graph);
    cache.clear();
    send({ type: "ready" });
    return;
  }
  if (!index) {
    send({ type: "error", id: request.id, error: "View worker is not initialized" });
    return;
  }
  const key = JSON.stringify([request.options, request.choice]);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    send({ type: "result", id: request.id, view: cached });
    return;
  }
  prepareView(index, request.options, request.choice)
    .then((view) => {
      const wire = toWireView(view);
      cache.set(key, wire);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      send({ type: "result", id: request.id, view: wire });
    })
    .catch((error: unknown) => send({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) }));
};
