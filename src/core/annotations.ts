import type { Annotation } from "./types";

export function textStyle(item: Annotation): {
  fontSize: number; color: Annotation["color"];
} {
  // Older text annotations stored a yellow placeholder but rendered in black.
  return {
    fontSize: Number.isFinite(item.fontSize)
      ? Math.max(6, Math.min(96, item.fontSize!)) : 12,
    color: item.fontSize === undefined ? [0.1, 0.1, 0.1] : item.color,
  };
}

export class AnnotationStore {
  items: Annotation[];
  private history: Annotation[][] = [];
  constructor(items: Annotation[]) {
    this.items = structuredClone(items);
  }
  get dirty(): boolean {
    return this.history.length > 0;
  }
  upsert(item: Annotation): void {
    this.history.push(structuredClone(this.items));
    this.items = [
      ...this.items.filter((x) => x.id !== item.id),
      structuredClone(item),
    ];
  }
  remove(id: string): void {
    if (!this.items.some((x) => x.id === id)) return;
    this.history.push(structuredClone(this.items));
    this.items = this.items.filter((x) => x.id !== id);
  }
  undo(): boolean {
    const previous = this.history.pop();
    if (!previous) return false;
    this.items = previous;
    return true;
  }
  saved(): void {
    this.history = [];
  }
}
