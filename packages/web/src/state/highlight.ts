import { useSyncExternalStore } from "react";

/**
 * Hover and selection highlight. Each node and edge subscribes with a selector that returns a short
 * string, so hovering re-renders only the elements whose status changed; the layout never re-runs.
 */
export class HighlightStore {
  private hovered: string | null = null;
  private related: Set<string> | null = null;
  private selected: string | null = null;
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private emit(): void {
    this.listeners.forEach((cb) => cb());
  }

  setHover(id: string | null, related: Set<string> | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.related = id ? related : null;
    this.emit();
  }

  setSelected(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.emit();
  }

  /** Space-separated state classes for a node: `sel`, `hover`, `rel`, `dim`. */
  nodeStatus(id: string): string {
    const parts: string[] = [];
    if (this.selected === id) parts.push("sel");
    if (this.hovered !== null) {
      if (this.hovered === id) parts.push("hover");
      else if (this.related?.has(id)) parts.push("rel");
      else parts.push("dim");
    }
    return parts.join(" ");
  }

  edgeStatus(source: string, target: string): string {
    if (this.hovered === null || !this.related) return "";
    return this.related.has(source) && this.related.has(target) ? "rel" : "dim";
  }
}

export function useNodeHighlight(store: HighlightStore, id: string): string {
  return useSyncExternalStore(store.subscribe, () => store.nodeStatus(id));
}

export function useEdgeHighlight(store: HighlightStore, source: string, target: string): string {
  return useSyncExternalStore(store.subscribe, () => store.edgeStatus(source, target));
}
