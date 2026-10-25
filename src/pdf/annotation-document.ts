import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AnnotationStore } from "../core/annotations";
import type { Annotation } from "../core/types";
import { digest } from "../translation/protocol";
import { readAnnotations, writeAnnotations } from "./annotations";
import { saveSource } from "./source";

// Each PDF owns its edits, version and recovery draft, even in a shared toolbar.
export class AnnotationDocument {
  path = "";
  hash = "";
  bytes?: Uint8Array;
  store = new AnnotationStore([]);
  selected?: string;
  private persistence = Promise.resolve();
  constructor(private workRoot: string) {}

  private draftPath(): string {
    return join(this.workRoot, "drafts", digest(Buffer.from(this.path + this.hash)) + ".json");
  }
  async load(path: string, bytes: Uint8Array): Promise<void> {
    await this.flush();
    this.path = path;
    this.bytes = bytes;
    this.hash = digest(bytes);
    this.selected = undefined;
    this.store = new AnnotationStore(await readAnnotations(bytes));
    try {
      const pending = JSON.parse(await readFile(this.draftPath(), "utf8")) as { sourceHash: string; items: Annotation[] };
      if (pending.sourceHash === this.hash && Array.isArray(pending.items)) {
        for (const item of this.store.items)
          if (!pending.items.some((x) => x.id === item.id)) this.store.remove(item.id);
        for (const item of pending.items) this.store.upsert(item);
      }
    } catch { /* No recovery draft for this version. */ }
  }
  changed(): Promise<void> {
    if (!this.path || !this.hash) return this.persistence;
    const path = this.draftPath();
    const value = JSON.stringify({ sourceHash: this.hash, items: this.store.items });
    const dirty = this.store.dirty;
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      await mkdir(join(this.workRoot, "drafts"), { recursive: true });
      if (dirty) await writeFile(path, value);
      else await unlink(path).catch(() => {});
    });
    return this.persistence;
  }
  flush(): Promise<void> { return this.persistence; }
  async save(fontBytes: Uint8Array): Promise<void> {
    if (!this.store.dirty || !this.bytes) return;
    const previousDraft = this.draftPath();
    const written = await writeAnnotations(this.bytes, this.store.items, fontBytes);
    this.hash = await saveSource(this.path, this.hash, written);
    this.bytes = written;
    await this.flush();
    await unlink(previousDraft).catch(() => {});
    this.store.saved();
    await this.changed();
  }
  discard(): Promise<void> {
    this.store.saved();
    this.selected = undefined;
    return this.changed();
  }
  async rename(path: string): Promise<void> {
    if (!this.path || path === this.path) return;
    const previousDraft = this.draftPath();
    this.path = path;
    await this.changed();
    await unlink(previousDraft).catch(() => {});
  }
}
