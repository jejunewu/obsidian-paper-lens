import type {
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist";
import type { Annotation, PageSize, Rect } from "../core/types";
import {
  locatePosition,
  positionOffset,
  type Position,
} from "../core/geometry";
import { openPdf, pdfRuntime } from "./runtime";

interface Slot {
  el: HTMLElement;
  surface: HTMLElement;
  source?: { doc: PDFDocumentProxy; page: number };
  proxy?: PDFPageProxy;
  viewport?: PageViewport;
  render?: RenderTask;
  rendered: boolean;
  version: number;
}
export class PdfReader {
  private slots: Slot[] = [];
  private observer: IntersectionObserver;
  private resize: ResizeObserver;
  private docs = new Set<PDFDocumentProxy>();
  private zoom = 1;
  private scale = 1;
  private mode: "continuous" | "single" = "continuous";
  private page = 1;
  private disposed = false;
  private annotations: Annotation[] = [];
  private selected?: string;
  private lastPosition: Position = { page: 1, fraction: 0 };
  tool: "select" | "pan" | "text" = "select";
  onPosition?: (pos: Position) => void;
  onAnnotation?: (id: string, edit: boolean) => void;
  onInsert?: (page: number, point: [number, number]) => void;
  onMove?: (id: string, delta: [number, number]) => void;
  private suppressScroll = false;
  private frame = 0;
  constructor(
    readonly el: HTMLElement,
    private root: string,
    private readonly readonly = false,
  ) {
    el.classList.add("pl-reader");
    el.tabIndex = 0;
    el.setAttribute("aria-label", readonly ? "译文阅读区域" : "原文阅读区域");
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const slot = this.slots.find((s) => s.el === entry.target);
          if (!slot) continue;
          if (entry.isIntersecting) void this.render(slot);
          else this.release(slot);
        }
      },
      { root: el, rootMargin: "900px 0px" },
    );
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(el);
    el.addEventListener("scroll", this.scrolled);
    el.addEventListener("pointerdown", this.pointerDown);
  }
  sizes: PageSize[] = [];
  async load(bytes: Uint8Array): Promise<string[]> {
    for (const old of this.docs) await old.destroy();
    this.docs.clear();
    const doc = await openPdf(bytes, this.root);
    this.docs.add(doc);
    const texts: string[] = [],
      sizes: PageSize[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      sizes.push({ width: viewport.width, height: viewport.height });
      const content = await page.getTextContent();
      texts.push(
        content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join(""),
      );
      page.cleanup();
    }
    if (this.disposed) {
      await doc.destroy();
      return [];
    }
    this.placeholders(sizes);
    this.slots.forEach((slot, i) => {
      slot.source = { doc, page: i + 1 };
    });
    this.layout();
    return texts;
  }
  placeholders(sizes: PageSize[]): void {
    this.observer.disconnect();
    for (const slot of this.slots) this.release(slot);
    this.el.replaceChildren();
    this.sizes = sizes;
    this.lastPosition = { page: 1, fraction: 0 };
    this.page = 1;
    this.slots = sizes.map((_, i) => {
      const el = document.createElement("section");
      el.className = "pl-page";
      el.dataset.page = String(i + 1);
      el.setAttribute("aria-label", `第 ${i + 1} 页`);
      const surface = document.createElement("div");
      surface.className = "pl-page-surface";
      el.append(surface);
      const label = document.createElement("div");
      label.className = "pl-page-placeholder";
      label.textContent = `第 ${i + 1} 页 · 等待译文`;
      surface.append(label);
      this.el.append(el);
      const slot: Slot = { el, surface, rendered: false, version: 0 };
      this.observer.observe(el);
      return slot;
    });
    this.layout();
  }
  async pageArtifact(page: number, bytes: Uint8Array): Promise<void> {
    const doc = await openPdf(bytes, this.root);
    if (this.disposed) {
      await doc.destroy();
      return;
    }
    this.docs.add(doc);
    const slot = this.slots[page - 1];
    if (!slot) {
      await doc.destroy();
      return;
    }
    const old = slot.source?.doc;
    this.release(slot);
    slot.source = { doc, page: 1 };
    slot.rendered = false;
    if (old && !this.slots.some((s) => s !== slot && s.source?.doc === old)) {
      this.docs.delete(old);
      await old.destroy();
    }
    if (this.isNear(slot)) await this.render(slot);
  }
  async merged(bytes: Uint8Array): Promise<void> {
    const doc = await openPdf(bytes, this.root);
    if (this.disposed) {
      await doc.destroy();
      return;
    }
    const old = [...this.docs];
    this.docs = new Set([doc]);
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      this.release(slot);
      slot.source = { doc, page: i + 1 };
    }
    await Promise.all(old.map((d) => d.destroy()));
    for (const slot of this.slots)
      if (this.isNear(slot)) void this.render(slot);
  }
  setZoom(zoom: number): void {
    this.zoom = zoom;
    this.layout();
  }
  setMode(mode: "continuous" | "single"): void {
    const pos = this.position();
    this.mode = mode;
    this.page = pos.page;
    this.layout();
    this.navigate(pos);
  }
  setTool(tool: "select" | "pan" | "text"): void {
    this.tool = tool;
    this.el.dataset.tool = tool;
  }
  setAnnotations(items: Annotation[], selected?: string): void {
    this.annotations = items;
    this.selected = selected;
    for (const slot of this.slots) this.drawAnnotations(slot);
  }
  position(): Position {
    if (!this.el.clientHeight || !this.el.clientWidth) return this.lastPosition;
    return this.mode === "single"
      ? {
          page: this.page,
          fraction:
            this.el.scrollTop /
            Math.max(1, this.slots[this.page - 1]?.el.offsetHeight ?? 1),
        }
      : locatePosition(
          this.el.scrollTop,
          this.slots.map((s) => ({
            top: s.el.offsetTop,
            height: s.el.offsetHeight,
          })),
        );
  }
  navigate(pos: Position): void {
    this.lastPosition = pos;
    if (this.mode === "single" && this.page !== pos.page) {
      this.page = pos.page;
      this.layout();
    }
    this.suppressScroll = true;
    this.el.scrollTop =
      this.mode === "single"
        ? (this.slots[pos.page - 1]?.el.offsetHeight ?? 0) * pos.fraction
        : positionOffset(
            pos,
            this.slots.map((s) => ({
              top: s.el.offsetTop,
              height: s.el.offsetHeight,
            })),
          );
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.suppressScroll = false;
    });
    for (const slot of this.slots)
      if (this.isNear(slot)) void this.render(slot);
  }
  selection(): { page: number; rects: Rect[]; text: string } | undefined {
    const selection = this.el.ownerDocument.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!this.el.contains(range.commonAncestorContainer)) return;
    const selected = range.toString();
    let match: { page: number; rects: Rect[]; text: string } | undefined;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (!slot.viewport || !range.intersectsNode(slot.surface)) continue;
      const bounds = slot.surface.getBoundingClientRect();
      const rects: Rect[] = [];
      for (const r of range.getClientRects()) {
        if (
          r.width < 1 ||
          r.height < 1 ||
          r.top < bounds.top - 1 ||
          r.bottom > bounds.bottom + 1
        )
          continue;
        const a = slot.viewport.convertToPdfPoint(
            Math.max(0, r.left - bounds.left),
            r.top - bounds.top,
          ),
          b = slot.viewport.convertToPdfPoint(
            Math.min(bounds.width, r.right - bounds.left),
            r.bottom - bounds.top,
          );
        rects.push([
          Math.min(a[0]!, b[0]!),
          Math.min(a[1]!, b[1]!),
          Math.max(a[0]!, b[0]!),
          Math.max(a[1]!, b[1]!),
        ]);
      }
      if (rects.length) {
        if (match) throw new Error("请一次选择同一页中的文字");
        match = { page: i + 1, rects, text: selected };
      }
    }
    return match;
  }
  private scrolled = (): void => {
    if (this.suppressScroll || this.disposed) return;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.lastPosition = this.position();
      this.onPosition?.(this.lastPosition);
    });
  };
  private isNear(slot: Slot): boolean {
    const a = slot.el.getBoundingClientRect(),
      b = this.el.getBoundingClientRect();
    return (
      slot.el.style.display !== "none" &&
      a.bottom > b.top - 900 &&
      a.top < b.bottom + 900
    );
  }
  private layout(): void {
    if (this.disposed || !this.sizes.length || this.el.clientWidth < 40) return;
    const pos = this.lastPosition;
    const maxWidth = Math.max(...this.sizes.map((x) => x.width));
    const scale =
      Math.min(1.5, (this.el.clientWidth - 32) / maxWidth) * this.zoom;
    const changed = Math.abs(scale - this.scale) > 0.001;
    this.scale = scale;
    this.slots.forEach((slot, i) => {
      const size = this.sizes[i]!;
      slot.el.style.width = `${size.width * scale}px`;
      slot.el.style.height = `${size.height * scale}px`;
      slot.el.style.display =
        this.mode === "single" && i + 1 !== this.page ? "none" : "";
      if (changed) this.release(slot);
    });
    this.navigate(pos);
  }
  private async render(slot: Slot): Promise<void> {
    if (this.disposed || slot.rendered || !slot.source) return;
    slot.rendered = true;
    const version = ++slot.version;
    try {
      const page = await slot.source.doc.getPage(slot.source.page);
      if (version !== slot.version || this.disposed) return;
      slot.proxy = page;
      const viewport = page.getViewport({ scale: this.scale });
      slot.viewport = viewport;
      const canvas = document.createElement("canvas");
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      slot.surface.replaceChildren(canvas);
      const context = canvas.getContext("2d")!;
      const pdfjs = await pdfRuntime(this.root);
      slot.render = page.render({
        canvasContext: context,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      await slot.render.promise;
      if (version !== slot.version || this.disposed) return;
      const textEl = document.createElement("div");
      textEl.className = "textLayer";
      textEl.style.setProperty("--scale-factor", String(viewport.scale));
      slot.surface.append(textEl);
      const layer = new pdfjs.TextLayer({
        textContentSource: await page.getTextContent(),
        container: textEl,
        viewport,
      });
      await layer.render();
      if (version !== slot.version) return;
      const existing = await page.getAnnotations();
      for (const annotation of existing) {
        if (annotation.id?.startsWith("paper-lens:")) continue;
        if (!annotation.rect || !annotation.subtype) continue;
        const rect = viewport.convertToViewportRectangle(annotation.rect);
        const marker = document.createElement("div");
        marker.className = "pl-existing-annotation";
        marker.title = annotation.contentsObj?.str ?? annotation.subtype;
        this.placeRect(marker, rect as Rect);
        slot.surface.append(marker);
      }
      this.drawAnnotations(slot);
    } catch (e) {
      if (version !== slot.version || this.disposed) return;
      slot.rendered = false;
      const error = document.createElement("div");
      error.className = "pl-page-placeholder";
      error.textContent = `页面无法渲染：${String(e)}`;
      slot.surface.replaceChildren(error);
    }
  }
  private placeRect(el: HTMLElement, rect: Rect): void {
    el.style.left = `${Math.min(rect[0], rect[2])}px`;
    el.style.top = `${Math.min(rect[1], rect[3])}px`;
    el.style.width = `${Math.abs(rect[2] - rect[0])}px`;
    el.style.height = `${Math.abs(rect[3] - rect[1])}px`;
  }
  private drawAnnotations(slot: Slot): void {
    slot.surface
      .querySelectorAll(".pl-annotation")
      .forEach((el) => el.remove());
    if (this.readonly || !slot.viewport || !slot.rendered) return;
    const number = this.slots.indexOf(slot) + 1;
    for (const item of this.annotations.filter((x) => x.page === number))
      for (const rect of item.rects) {
        const el = document.createElement("button");
        el.className = `pl-annotation pl-${item.kind}${this.selected === item.id ? " is-selected" : ""}`;
        el.dataset.annotation = item.id;
        el.setAttribute(
          "aria-label",
          item.kind === "text"
            ? `文字批注：${item.text}`
            : `高亮：${item.text}`,
        );
        el.title = item.text;
        this.placeRect(
          el,
          slot.viewport.convertToViewportRectangle(rect) as Rect,
        );
        if (item.kind === "text") {
          el.textContent = item.text;
          el.style.fontSize = `${12 * this.scale}px`;
        }
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this.onAnnotation?.(item.id, false);
        });
        el.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          this.onAnnotation?.(item.id, true);
        });
        slot.surface.append(el);
      }
  }
  private pointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement,
      pageEl = target.closest<HTMLElement>(".pl-page"),
      slot = this.slots.find((s) => s.el === pageEl);
    const item =
      target.closest<HTMLElement>("[data-annotation]")?.dataset.annotation;
    if (
      item &&
      this.selected === item &&
      this.tool === "select" &&
      slot?.viewport &&
      !this.readonly
    ) {
      const start = slot.viewport.convertToPdfPoint(e.clientX, e.clientY);
      const end = (event: PointerEvent) => {
        window.removeEventListener("pointerup", end);
        const stop = slot.viewport!.convertToPdfPoint(
          event.clientX,
          event.clientY,
        );
        if (
          Math.hypot(event.clientX - e.clientX, event.clientY - e.clientY) > 4
        )
          this.onMove?.(item, [stop[0]! - start[0]!, stop[1]! - start[1]!]);
      };
      window.addEventListener("pointerup", end, { once: true });
      return;
    }
    if (this.tool === "text" && slot?.viewport && !this.readonly) {
      const bounds = slot.surface.getBoundingClientRect(),
        p = slot.viewport.convertToPdfPoint(
          e.clientX - bounds.left,
          e.clientY - bounds.top,
        );
      this.onInsert?.(this.slots.indexOf(slot) + 1, [p[0]!, p[1]!]);
      return;
    }
    if (this.tool !== "pan") return;
    e.preventDefault();
    const left = this.el.scrollLeft,
      top = this.el.scrollTop;
    const move = (event: PointerEvent) => {
      this.el.scrollLeft = left - event.clientX + e.clientX;
      this.el.scrollTop = top - event.clientY + e.clientY;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };
  private release(slot: Slot): void {
    slot.version++;
    slot.render?.cancel();
    slot.render = undefined;
    slot.proxy?.cleanup();
    slot.proxy = undefined;
    slot.viewport = undefined;
    slot.rendered = false;
    slot.surface.querySelectorAll("canvas").forEach((c) => {
      c.width = 0;
      c.height = 0;
    });
    slot.surface.replaceChildren();
    const label = document.createElement("div");
    label.className = "pl-page-placeholder";
    label.textContent = slot.source
      ? "加载页面…"
      : `第 ${this.slots.indexOf(slot) + 1} 页 · 等待译文`;
    slot.surface.append(label);
  }
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.resize.disconnect();
    this.el.removeEventListener("scroll", this.scrolled);
    this.el.removeEventListener("pointerdown", this.pointerDown);
    for (const slot of this.slots) this.release(slot);
    for (const doc of this.docs) void doc.destroy();
    this.docs.clear();
  }
}
