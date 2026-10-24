import {
  FileView,
  Notice,
  TFile,
  type WorkspaceLeaf,
  type ViewStateResult,
} from "obsidian";
import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type PaperLensPlugin from "../main";
import type { Annotation } from "../core/types";
import { AnnotationStore, textStyle } from "../core/annotations";
import { clampZoom, type Position } from "../core/geometry";
import { digest } from "../translation/protocol";
import { PdfReader } from "../pdf/reader";
import {
  readAnnotations,
  writeAnnotations,
  withoutPaperLensAnnotations,
} from "../pdf/annotations";
import { saveSource } from "../pdf/source";
import { TranslationManager } from "../translation/manager";
import { listModels, validateApi } from "../translation/api";
import { textDialog, unsavedDialog } from "./modals";
import { TranslationStatus } from "./translation-status";
export const VIEW_TYPE = "paper-lens";
type PaperTool = "select" | "pan" | "text" | "highlight";
function rgbColor(hex: string): Annotation["color"] {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as Annotation["color"];
}
function hexColor(color: Annotation["color"]): string {
  return "#" + color.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
}

export class PaperLensView extends FileView {
  private path = "";
  private source?: PdfReader;
  private translation?: PdfReader;
  private manager: TranslationManager;
  private store = new AnnotationStore([]);
  private sourceHash = "";
  private bytes?: Uint8Array;
  private pageTexts: string[] = [];
  private selected?: string;
  private tool: PaperTool = "select";
  private toolButtons = new Map<PaperTool, HTMLButtonElement>();
  private modelInput?: HTMLSelectElement;
  private customModelInput?: HTMLInputElement;
  private effortInput?: HTMLSelectElement;
  private modelCatalog: string[] = [];
  private catalogVersion = 0;
  private zoom = 1;
  private zoomInput?: HTMLInputElement;
  private highlightColor = "#ffd933";
  private textColor = "#1a1a1a";
  private fontSize = 12;
  private highlightInput?: HTMLInputElement;
  private textColorInput?: HTMLInputElement;
  private fontSizeInput?: HTMLInputElement;
  private translationPanel?: HTMLElement;
  private translateDivider?: HTMLElement;
  private saveButton?: HTMLButtonElement;
  private translateButton?: HTMLButtonElement;
  private cancelButton?: HTMLButtonElement;
  private pageInput?: HTMLInputElement;
  private scrollButton?: HTMLButtonElement;
  private scrollLinked = true;
  private activePane: "source" | "translation" = "source";
  private status?: HTMLElement;
  private progress?: HTMLElement;
  private translationStatus = new TranslationStatus();
  private translationLog?: HTMLElement;
  private translationDetails?: HTMLDetailsElement;
  private translationOpen = false;
  private saveBusy = false;
  private closed = false;
  private ready = false;
  private persistence = Promise.resolve();
  private restorePosition?: { page: number; fraction: number };
  private restoreTranslationPosition?: Position;
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PaperLensPlugin,
  ) {
    super(leaf);
    this.allowNoFile = true;
    this.manager = new TranslationManager();
  }
  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.path
      ? `Paper Lens · ${this.path.split("/").pop()}`
      : "Paper Lens";
  }
  getIcon(): string {
    return "scan-text";
  }
  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      file: this.path,
      position: this.source?.position() ?? this.restorePosition,
      translationPosition: this.ready ? this.translation?.position() : this.restoreTranslationPosition,
      scrollLinked: this.scrollLinked,
      activePane: this.activePane,
      translationOpen: this.translationOpen,
      zoom: this.zoom,
    };
  }
  async setState(
    state: Record<string, unknown>,
    result: ViewStateResult,
  ): Promise<void> {
    // Restore tabs saved before Paper Lens became a standard FileView.
    const path =
      typeof state.file === "string" ? state.file :
        typeof state.path === "string" ? state.path : "";
    if (typeof state.zoom === "number")
      this.zoom = clampZoom(state.zoom);
    this.translationOpen = state.translationOpen === true;
    this.scrollLinked = state.scrollLinked !== false;
    this.activePane = state.activePane === "translation" ? "translation" : "source";
    const pos = state.position as
      | { page?: number; fraction?: number }
      | undefined;
    this.restorePosition = pos && Number.isInteger(pos.page) && pos.page! > 0 &&
      typeof pos.fraction === "number" && Number.isFinite(pos.fraction)
      ? { page: pos.page!, fraction: Math.max(0, Math.min(1, pos.fraction)) } : undefined;
    const translatedPos = state.translationPosition as Partial<Position> | undefined;
    this.restoreTranslationPosition = translatedPos && Number.isInteger(translatedPos.page) && translatedPos.page! > 0 &&
      typeof translatedPos.fraction === "number" && Number.isFinite(translatedPos.fraction)
      ? { page: translatedPos.page!, fraction: Math.max(0, Math.min(1, translatedPos.fraction)) } : undefined;
    if (
      path && path !== this.path && this.store.dirty &&
      !(await this.resolveUnsaved())
    ) return;
    await super.setState({ ...state, file: path }, result);
    this.panels();
  }
  canAcceptExtension(extension: string): boolean {
    return extension.toLowerCase() === "pdf";
  }
  async onLoadFile(file: TFile): Promise<void> {
    this.path = file.path;
    if (this.source) await this.loadPaper();
  }
  async onUnloadFile(): Promise<void> {
    this.ready = false;
    this.manager.dispose();
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.build();
    if (this.path) await this.loadPaper();
  }
  private button(
    parent: HTMLElement,
    text: string,
    action: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      text,
      attr: { "aria-label": text },
    });
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      void Promise.resolve()
        .then(action)
        .catch((e) => this.error(e));
    });
    return button;
  }
  private build(): void {
    this.contentEl.empty();
    this.contentEl.addClass("paper-lens");
    const toolbar = this.contentEl.createDiv({
      cls: "pl-toolbar",
      attr: { role: "toolbar", "aria-label": "Paper Lens 工具栏" },
    });
    this.saveButton = this.button(toolbar, "保存", () => this.save());
    this.toolButtons.clear();
    this.toolButtons.set("select", this.button(toolbar, "选择", () => this.setTool("select")));
    this.toolButtons.set("pan", this.button(toolbar, "拖动", () => this.setTool("pan")));
    this.button(toolbar, "−", () => this.setZoom(this.zoom / 1.2));
    this.zoomInput = toolbar.createEl("input", {
      type: "text", value: `${Math.round(this.zoom * 100)}%`, cls: "pl-zoom-input",
      attr: { "aria-label": "缩放百分比", title: "缩放百分比（25%–400%）", inputmode: "decimal" },
    });
    const applyZoom = () => {
      const value = this.zoomInput!.value.trim().replace(/%$/, "");
      if (value && Number.isFinite(Number(value))) this.setZoom(Number(value) / 100);
      else this.zoomInput!.value = `${Math.round(this.zoom * 100)}%`;
    };
    this.zoomInput.addEventListener("change", applyZoom);
    this.zoomInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { applyZoom(); this.zoomInput!.blur(); }
      if (e.key === "Escape") { this.zoomInput!.value = `${Math.round(this.zoom * 100)}%`; this.zoomInput!.blur(); }
    });
    this.button(toolbar, "+", () => this.setZoom(this.zoom * 1.2));
    this.button(toolbar, "适合宽度", () => this.setZoom(this.source?.fitZoom() ?? 1));
    const mode = toolbar.createEl("select", {
      attr: { "aria-label": "翻页方式" },
    });
    mode.createEl("option", { text: "连续滚动", value: "continuous" });
    mode.createEl("option", { text: "单页阅读", value: "single" });
    mode.addEventListener("change", () => {
      this.source?.setMode(mode.value as "continuous" | "single");
      this.translation?.setMode(mode.value as "continuous" | "single");
    });
    this.scrollButton = this.button(toolbar, "同步滚动", () => {
      this.setScrollLinked(!this.scrollLinked);
    });
    this.button(toolbar, "上一页", () =>
      this.navigate((this.activeReader()?.position().page ?? 1) - 1),
    );
    this.button(toolbar, "下一页", () =>
      this.navigate((this.activeReader()?.position().page ?? 1) + 1),
    );
    this.pageInput = toolbar.createEl("input", {
      type: "number",
      value: "1",
      cls: "pl-page-input",
      attr: { "aria-label": "跳转页码", min: "1" },
    });
    this.pageInput.addEventListener("change", () =>
      this.navigate(Number(this.pageInput!.value)),
    );
    const highlighter = this.button(toolbar, "荧光笔", () => this.toggleHighlight());
    highlighter.title = "选中文字后自动高亮；再次点击或按 Esc 退出";
    this.toolButtons.set("highlight", highlighter);
    this.highlightInput = this.colorControl(toolbar, "高亮颜色", this.highlightColor, (color) => {
      this.highlightColor = color;
      this.updateStyle("highlight", { color: rgbColor(color) });
    });
    this.toolButtons.set("text", this.button(toolbar, "插入文本", () => this.setTool("text")));
    this.textColorInput = this.colorControl(toolbar, "文字颜色", this.textColor, (color) => {
      this.textColor = color;
      this.updateStyle("text", { color: rgbColor(color), fontSize: this.fontSize });
    });
    this.fontSizeInput = toolbar.createEl("input", {
      type: "number", value: String(this.fontSize), cls: "pl-font-size",
      attr: { "aria-label": "文字字号（pt）", title: "文字字号（pt）", min: "6", max: "96", step: "1" },
    });
    this.fontSizeInput.addEventListener("change", () => {
      const size = Number(this.fontSizeInput!.value);
      if (Number.isFinite(size) && size >= 6 && size <= 96) {
        this.fontSize = size;
        this.updateStyle("text", { fontSize: size, color: rgbColor(this.textColor) });
      }
      this.fontSizeInput!.value = String(this.fontSize);
    });
    toolbar.createEl("span", { text: "pt" });
    this.button(toolbar, "删除", () => {
      if (this.saveBusy) throw new Error("批注正在保存，请稍候");
      if (!this.selected) throw new Error("请先选择 Paper Lens 批注");
      this.store.remove(this.selected);
      this.selected = undefined;
      this.annotationsChanged();
    });
    this.button(toolbar, "撤销", () => {
      if (this.saveBusy) throw new Error("批注正在保存，请稍候");
      this.store.undo();
      this.annotationsChanged();
    });
    this.translateButton = this.button(toolbar, "全文翻译", () =>
      this.translate(),
    );
    this.modelInput = toolbar.createEl("select", { attr: { "aria-label": "翻译模型" } });
    this.modelInput.addEventListener("change", () => {
      if (this.customModelInput) this.customModelInput.hidden = this.modelInput!.value !== "custom";
      this.rememberModel();
      this.fillEfforts();
    });
    this.customModelInput = toolbar.createEl("input", { type: "text", cls: "pl-model-input",
      attr: { "aria-label": "自定义翻译模型 ID", placeholder: "模型 ID" } });
    this.customModelInput.addEventListener("change", () => { this.rememberModel(); this.fillEfforts(); });
    this.effortInput = toolbar.createEl("select", { attr: { "aria-label": "翻译推理强度" } });
    this.effortInput.addEventListener("change", () => {
      this.plugin.settings.reasoningEffort = this.effortInput!.value;
      void this.plugin.saveSettings().catch((e) => this.error(e));
    });
    this.button(toolbar, "刷新模型", () => this.loadModels(true));
    void this.loadModels();
    const toggleTranslation = this.button(toolbar, "译文", () => {
      this.translationOpen = !this.translationOpen;
      this.panels();
      toggleTranslation.setAttribute(
        "aria-expanded",
        String(this.translationOpen),
      );
    });
    toggleTranslation.setAttribute(
      "aria-expanded",
      String(this.translationOpen),
    );
    const row = this.contentEl.createDiv({ cls: "pl-task-row" });
    this.status = row.createDiv({ cls: "pl-status", attr: { role: "status" } });
    this.progress = row.createDiv({
      cls: "pl-progress",
      attr: { role: "status" },
    });
    this.cancelButton = this.button(row, "取消翻译", async () => {
      await this.manager.cancel();
    });
    this.cancelButton.hidden = true;
    this.translationDetails = this.contentEl.createEl("details", {
      cls: "pl-translation-details",
    });
    this.translationDetails.createEl("summary", { text: "翻译任务详情" });
    this.translationLog = this.translationDetails.createEl("pre");
    const panels = this.contentEl.createDiv({ cls: "pl-panels" });
    const originalPanel = panels.createDiv({ cls: "pl-panel pl-source-panel" });
    const originalHeader = originalPanel.createDiv({ cls: "pl-panel-header" });
    originalHeader.createEl("strong", { text: "原文" });
    const sourceEl = originalPanel.createDiv();
    this.source = new PdfReader(sourceEl, this.plugin.resourceRoot);
    this.translateDivider = this.divider(
      panels,
      originalPanel,
      () => this.translationPanel!,
    );
    this.translationPanel = panels.createDiv({
      cls: "pl-panel pl-translation-panel",
    });
    const translationHeader = this.translationPanel.createDiv({
      cls: "pl-panel-header",
    });
    translationHeader.createEl("strong", { text: "简体中文译文" });
    this.button(translationHeader, "收起", () => {
      this.translationOpen = false;
      this.panels();
    });
    this.translation = new PdfReader(
      this.translationPanel.createDiv(),
      this.plugin.resourceRoot,
      true,
    );
    this.source.onPosition = (pos) => this.readerPosition("source", pos);
    this.translation.onPosition = (pos) => this.readerPosition("translation", pos);
    for (const pane of ["source", "translation"] as const) {
      const el = pane === "source" ? this.source.el : this.translation.el;
      for (const event of ["pointerdown", "focusin", "wheel"] as const)
        this.registerDomEvent(el, event, () => {
          this.activePane = pane;
          if (this.pageInput) this.pageInput.value = String(this.activeReader()?.position().page ?? 1);
        });
    }
    this.source.onAnnotation = (id, edit) => {
      const changed = this.selected !== id;
      this.selected = id;
      this.syncStyleControls();
      if (changed) this.source?.setAnnotations(this.store.items, id);
      if (edit && !this.saveBusy)
        void this.editText(id).catch((e) => this.error(e));
    };
    this.source.onSelection = () => {
      try { this.selectionFinished(); }
      catch (error) { this.error(error); }
    };
    this.registerDomEvent(sourceEl, "keydown", (event) => {
      if (event.key === "Escape" && this.tool === "highlight") this.setTool("select");
    });
    this.source.onInsert = (page, point) => {
      void this.insertText(page, point).then((created) => {
        if (created) this.setTool("select");
      }).catch((e) => this.error(e));
    };
    this.source.onMove = (id, delta) => {
      const item = this.store.items.find((x) => x.id === id);
      if (!item || this.saveBusy) return;
      this.store.upsert({
        ...item,
        rects: item.rects.map((r) => [
          r[0] + delta[0],
          r[1] + delta[1],
          r[2] + delta[0],
          r[3] + delta[1],
        ]),
      });
      this.annotationsChanged();
    };
    this.source.onResize = (id, rect) => {
      const item = this.store.items.find((x) => x.id === id && x.kind === "text");
      if (!item || this.saveBusy) return;
      this.store.upsert({ ...item, rects: [rect] });
      this.annotationsChanged();
    };
    this.source.onZoom = this.translation.onZoom = (zoom) => this.setZoom(zoom);
    this.registerDomEvent(panels, "dragover", (e) => {
      e.preventDefault();
    });
    this.registerDomEvent(panels, "drop", (e) => {
      e.preventDefault();
      const transfer = e.dataTransfer;
      if (!transfer) return;
      const text = transfer.getData("text/plain").replace(/^\[\[|\]\]$/g, "");
      const file = this.app.vault.getAbstractFileByPath(text);
      if (file instanceof TFile && file.extension.toLowerCase() === "pdf")
        void this.plugin.openPaper(file);
      else {
        const dropped = transfer.files[0] as
          | (File & { path?: string })
          | undefined;
        if (dropped?.path?.startsWith(this.plugin.basePath + "/")) {
          const local = this.app.vault.getAbstractFileByPath(
            dropped.path.slice(this.plugin.basePath.length + 1),
          );
          if (local instanceof TFile && local.extension.toLowerCase() === "pdf")
            void this.plugin.openPaper(local);
        }
      }
    });
    this.setTool(this.tool);
    this.panels();
  }
  private setTool(tool: PaperTool): void {
    this.tool = tool;
    this.source?.setTool(tool === "highlight" ? "select" : tool);
    this.translation?.setTool(tool === "pan" ? "pan" : "select");
    if (this.source) this.source.el.dataset.highlight = String(tool === "highlight");
    if (tool === "highlight") {
      this.selected = undefined;
      this.source?.setAnnotations(this.store.items);
    }
    for (const [name, button] of this.toolButtons)
      button.setAttribute("aria-pressed", String(name === tool));
  }
  private toggleHighlight(): void {
    if (this.saveBusy) throw new Error("批注正在保存，请稍候");
    if (this.tool === "highlight") { this.setTool("select"); return; }
    this.setTool("highlight");
    this.highlight();
  }
  private selectionFinished(): void {
    if (this.tool === "highlight" && !this.saveBusy) this.highlight();
  }
  private divider(
    parent: HTMLElement,
    left: HTMLElement,
    right: () => HTMLElement,
  ): HTMLElement {
    const bar = parent.createDiv({
      cls: "pl-divider",
      attr: {
        role: "separator",
        tabindex: "0",
        "aria-orientation": "vertical",
        "aria-label": "调整面板宽度",
      },
    });
    const resize = (delta: number) => {
      const rightEl = right();
      const leftEl = left.hidden ? this.source!.el.parentElement! : left;
      const a = leftEl.getBoundingClientRect().width,
        b = rightEl.getBoundingClientRect().width;
      if (a + delta < 160 || b - delta < 160) return;
      leftEl.style.flex = `0 0 ${a + delta}px`;
      rightEl.style.flex = `1 1 ${b - delta}px`;
    };
    bar.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        resize(e.key === "ArrowLeft" ? -20 : 20);
      }
    });
    bar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      let last = e.clientX;
      const move = (event: PointerEvent) => {
        resize(event.clientX - last);
        last = event.clientX;
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
    });
    return bar;
  }
  private panels(): void {
    if (!this.translationPanel) return;
    this.translationPanel.hidden = !this.translationOpen;
    this.translateDivider!.hidden = !this.translationOpen;
    if (!this.translationOpen) {
      this.activePane = "source";
      if (this.pageInput) this.pageInput.value = String(this.source?.position().page ?? 1);
    }
    if (this.scrollButton) {
      const label = this.scrollLinked ? "同步滚动" : "独立滚动";
      this.scrollButton.textContent = label;
      this.scrollButton.setAttribute("aria-label", label);
      this.scrollButton.setAttribute("aria-pressed", String(this.scrollLinked));
      this.scrollButton.disabled = !this.translationOpen;
      this.scrollButton.title = !this.translationOpen ? "展开译文后可切换滚动方式" : this.scrollLinked
        ? "两栏按相同页码和页内位置一起滚动；点击切换为独立滚动"
        : "两栏各自滚动，翻页作用于最后操作的一栏；点击恢复同步";
    }
  }
  private activeReader(): PdfReader | undefined {
    return this.activePane === "translation" ? this.translation : this.source;
  }
  private readerPosition(pane: "source" | "translation", pos: Position): void {
    this.activePane = pane;
    if (this.scrollLinked)
      (pane === "source" ? this.translation : this.source)?.navigate(pos);
    if (this.pageInput) this.pageInput.value = String(pos.page);
    this.app.workspace.requestSaveLayout();
  }
  private setScrollLinked(linked: boolean): void {
    this.scrollLinked = linked;
    this.panels();
    if (linked) {
      const pos = this.activeReader()?.position();
      if (pos) this.readerPosition(this.activePane, pos);
    }
    this.app.workspace.requestSaveLayout();
  }
  private rememberModel(): void {
    this.plugin.settings.apiModel = this.modelInput!.value === "custom"
      ? this.customModelInput!.value.trim() : this.modelInput!.value;
    void this.plugin.saveSettings().catch((e) => this.error(e));
  }
  private fillEfforts(disabled = this.manager.active): void {
    if (!this.effortInput) return;
    this.effortInput.replaceChildren();
    for (const [value, text] of Object.entries({ "": "推理：不发送", minimal: "minimal", low: "low", medium: "medium", high: "high" }))
      this.effortInput.createEl("option", { text, value });
    this.effortInput.value = this.plugin.settings.reasoningEffort;
    this.effortInput.disabled = disabled;
  }
  private async loadModels(refresh = false): Promise<void> {
    if (!this.modelInput || !this.customModelInput) return;
    const version = ++this.catalogVersion;
    const fill = () => {
      const model = this.plugin.settings.apiModel;
      this.modelInput!.replaceChildren();
      for (const id of this.modelCatalog) this.modelInput!.createEl("option", { text: id, value: id });
      this.modelInput!.createEl("option", { text: "自定义模型…", value: "custom" });
      const custom = !this.modelCatalog.includes(model);
      this.modelInput!.value = custom ? "custom" : model;
      this.customModelInput!.value = custom ? model : "";
      this.customModelInput!.hidden = !custom;
      this.fillEfforts();
    };
    fill();
    if (!refresh) return;
    try {
      this.modelCatalog = await listModels(this.plugin.apiConfig);
      if (this.closed || version !== this.catalogVersion) return;
      fill();
      this.modelInput.title = "当前 API 服务的模型目录";
    } catch (error) {
      if (this.closed || version !== this.catalogVersion) return;
      this.modelInput.title = "模型目录不可用，可直接填写模型 ID";
      this.error(error);
    }
  }
  private colorControl(parent: HTMLElement, label: string, value: string,
    change: (value: string) => void): HTMLInputElement {
    const input = parent.createEl("input", { type: "color", value, cls: "pl-color-input",
      attr: { "aria-label": label, title: label } });
    input.addEventListener("change", () => change(input.value));
    return input;
  }
  private updateStyle(kind: Annotation["kind"], style: Partial<Annotation>): void {
    const item = this.store.items.find((x) => x.id === this.selected && x.kind === kind);
    if (!item || this.saveBusy) return;
    this.store.upsert({ ...item, ...style });
    this.annotationsChanged();
  }
  private syncStyleControls(): void {
    const item = this.store.items.find((x) => x.id === this.selected);
    if (!item) return;
    if (item.kind === "highlight") {
      this.highlightColor = hexColor(item.color);
      if (this.highlightInput) this.highlightInput.value = this.highlightColor;
    } else {
      const style = textStyle(item);
      this.textColor = hexColor(style.color);
      this.fontSize = style.fontSize;
      if (this.textColorInput) this.textColorInput.value = this.textColor;
      if (this.fontSizeInput) this.fontSizeInput.value = String(this.fontSize);
    }
  }
  private async loadPaper(): Promise<void> {
    this.ready = false;
    this.status!.textContent = "正在加载论文…";
    this.manager.dispose();
    this.manager = new TranslationManager();
    try {
      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf")
        throw new Error("未找到 Vault 中的 PDF");
      this.bytes = new Uint8Array(await this.app.vault.readBinary(file));
      this.sourceHash = digest(this.bytes);
      const pages = await this.source!.load(
        await withoutPaperLensAnnotations(this.bytes),
      );
      if (this.closed) return;
      this.store = new AnnotationStore(await readAnnotations(this.bytes));
      this.pageTexts = pages;
      try {
        const pending = JSON.parse(
          await readFile(this.pendingPath(), "utf8"),
        ) as { sourceHash: string; items: Annotation[] };
        if (
          pending.sourceHash === this.sourceHash &&
          Array.isArray(pending.items)
        ) {
          for (const item of this.store.items)
            if (!pending.items.some((x) => x.id === item.id))
              this.store.remove(item.id);
          for (const item of pending.items) this.store.upsert(item);
        }
      } catch {
        /* No pending edits for this version. */
      }
      this.translation!.placeholders(this.source!.sizes);
      this.source!.setZoom(this.zoom);
      this.translation!.setZoom(this.zoom);
      this.annotationsChanged();
      if (this.pageInput) this.pageInput.max = String(pages.length);
      this.ready = true;
      this.status!.textContent = `${file.basename} · ${pages.length} 页${pages.some((text) => !text.trim()) ? " · 含无文本页，扫描页不支持翻译" : ""}`;
      if (this.restorePosition && this.restorePosition.page <= pages.length)
        this.source!.navigate(this.restorePosition);
      this.translation!.navigate(this.scrollLinked
        ? this.source!.position() : this.restoreTranslationPosition && this.restoreTranslationPosition.page <= pages.length
          ? this.restoreTranslationPosition : this.source!.position());
      if (this.pageInput) this.pageInput.value = String(this.activeReader()?.position().page ?? 1);
      await this.translate(true);
    } catch (e) {
      this.error(e);
    }
  }
  private pendingPath(): string {
    return join(
      this.plugin.workRoot,
      "drafts",
      digest(
        Buffer.from(this.plugin.basePath + "/" + this.path + this.sourceHash),
      ) + ".json",
    );
  }
  private annotationsChanged(): void {
    this.syncStyleControls();
    this.source?.setAnnotations(this.store.items, this.selected);
    if (this.saveButton) {
      this.saveButton.textContent = this.store.dirty ? "保存 *" : "保存";
      this.saveButton.disabled = this.saveBusy;
    }
    if (!this.path || !this.sourceHash) return;
    const path = this.pendingPath(),
      value = JSON.stringify({
        sourceHash: this.sourceHash,
        items: this.store.items,
      });
    const dirty = this.store.dirty;
    this.persistence = this.persistence
      .catch(() => {})
      .then(async () => {
        await mkdir(join(this.plugin.workRoot, "drafts"), { recursive: true });
        if (dirty) await writeFile(path, value);
        else await unlink(path).catch(() => {});
      });
    void this.persistence.catch((e) =>
      this.error(`无法保存批注恢复草稿：${String(e)}`),
    );
  }
  private highlight(): void {
    if (this.saveBusy) throw new Error("批注正在保存，请稍候");
    const selection = this.source?.selection();
    if (!selection?.text.trim()) return;
    this.store.upsert({
      id: randomUUID(),
      page: selection.page,
      kind: "highlight",
      rects: selection.rects,
      text: selection.text,
      color: rgbColor(this.highlightColor),
    });
    this.annotationsChanged();
    this.source?.clearSelection();
  }
  private async insertText(
    page: number,
    point: [number, number],
  ): Promise<boolean> {
    if (this.saveBusy) return false;
    const text = await textDialog(this.app, "");
    if (!text || this.closed || this.saveBusy) return false;
    const id = randomUUID();
    this.store.upsert({
      id,
      page,
      kind: "text",
      rects: [[point[0], point[1] - 60, point[0] + 240, point[1]]],
      text,
      color: rgbColor(this.textColor),
      fontSize: this.fontSize,
    });
    this.selected = id;
    this.annotationsChanged();
    return true;
  }
  private async editText(id: string): Promise<void> {
    const item = this.store.items.find((x) => x.id === id);
    if (!item || item.kind !== "text") return;
    const text = await textDialog(this.app, item.text);
    if (text && !this.saveBusy) {
      this.store.upsert({ ...item, text });
      this.annotationsChanged();
    }
  }
  private async save(): Promise<void> {
    if (this.saveBusy || !this.store.dirty || !this.bytes) return;
    this.saveBusy = true;
    this.annotationsChanged();
    try {
      const previousDraft = this.pendingPath();
      const written = await writeAnnotations(
        this.bytes,
        this.store.items,
        await readFile(
          join(this.plugin.resourceRoot, "fonts/NotoSansCJKsc-Regular.otf"),
        ),
      );
      this.sourceHash = await saveSource(
        join(this.plugin.basePath, this.path),
        this.sourceHash,
        written,
      );
      this.bytes = written;
      await this.persistence;
      await unlink(previousDraft).catch(() => {});
      this.store.saved();
      new Notice("批注已保存；首次原文备份保存在 .paper-lens.bak");
    } finally {
      this.saveBusy = false;
      this.annotationsChanged();
    }
  }
  private setZoom(zoom: number): void {
    this.zoom = clampZoom(zoom);
    if (this.zoomInput) this.zoomInput.value = `${Math.round(this.zoom * 100)}%`;
    this.source?.setZoom(this.zoom);
    this.translation?.setZoom(this.zoom);
  }
  private navigate(page: number, fraction = 0): void {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > (this.source?.sizes.length ?? 0)
    )
      return;
    const pos = { page, fraction: Math.max(0, Math.min(1, fraction)) };
    this.activeReader()?.navigate(pos);
    if (this.scrollLinked)
      (this.activePane === "source" ? this.translation : this.source)?.navigate(pos);
    if (this.pageInput) this.pageInput.value = String(page);
    this.app.workspace.requestSaveLayout();
  }
  private async translate(restoreOnly = false): Promise<void> {
    if (!this.ready || !this.bytes)
      throw new Error("请先打开可选中文字的论文 PDF");
    if (this.manager.active) throw new Error("当前论文已有翻译任务");
    if (this.pageTexts.every((text) => !text.trim())) {
      if (restoreOnly) return;
      throw new Error("扫描页不支持翻译，请使用可选中文字的英文 PDF");
    }
    if (!restoreOnly) {
      validateApi(this.plugin.apiConfig);
      this.translationOpen = true;
      this.panels();
      this.translateButton!.disabled = true;
      this.cancelButton!.hidden = false;
      for (const input of [this.modelInput, this.customModelInput, this.effortInput])
        if (input) input.disabled = true;
    }
    this.translationStatus.reset();
    this.translationLog!.textContent = "";
    this.translationStatus.event({
      type: "status",
      text: restoreOnly
        ? "正在恢复翻译检查点…"
        : "正在准备论文快照和翻译引擎…",
    });
    this.progress!.textContent = this.translationStatus.text;
    try {
      const pdf = await PDFDocument.load(this.bytes);
      await this.manager.start(
        {
          documentId: `${this.plugin.basePath}/${this.path}`,
          sourcePath: join(this.plugin.basePath, this.path),
          bytes: this.bytes,
          sizes: pdf.getPages().map((page) => page.getSize()),
          root: this.plugin.workRoot,
          runtimePath: this.plugin.runtimePath,
          api: this.plugin.apiConfig,
        },
        {
          sourceBytes: async () =>
            readFile(join(this.plugin.basePath, this.path)),
          event: (event) => {
            if (this.closed) {
              return;
            }
            this.translationStatus.event(event);
            this.progress!.textContent = this.translationStatus.text;
            if (
              event.type === "status" ||
              event.type === "error"
            ) {
              this.translationLog!.textContent = (
                (this.translationLog!.textContent || "") +
                `\n${event.text}\n`
              ).slice(-12000);
            }
            if (event.type === "error") this.translationDetails!.open = true;
            if (
              event.type === "done" ||
              event.type === "error" ||
              event.type === "cancelled"
            ) {
              this.translateButton!.disabled = false;
              this.translateButton!.textContent = "翻译 / 重试";
              this.cancelButton!.hidden = true;
              for (const input of [this.modelInput, this.customModelInput])
                if (input) input.disabled = false;
              this.fillEfforts(false);
            }
          },
          progress: (manifest) => {
            if (this.closed) return;
            this.translationStatus.progress(manifest);
            this.progress!.textContent = this.translationStatus.text;
          },
          page: async (page, bytes, warnings) => {
            if (!this.closed) {
              await this.translation!.pageArtifact(page, bytes);
              if (warnings.length)
                new Notice(`第 ${page} 页：${warnings.join("；")}`);
            }
          },
          saved: async (path, bytes) => {
            if (!this.closed) {
              await this.translation!.merged(bytes);
              this.translationStatus.save(path);
              this.progress!.textContent = this.translationStatus.text;
              new Notice(`译文已保存：${path}`);
            }
          },
        },
        restoreOnly,
      );
      if (restoreOnly && !this.manager.job) {
        this.translationStatus.event({ type: "status", text: "尚未翻译，点击“全文翻译”开始" });
        this.progress!.textContent = this.translationStatus.text;
      }
      if (!this.manager.active) {
        this.translateButton!.disabled = false;
        this.cancelButton!.hidden = true;
        for (const input of [this.modelInput, this.customModelInput])
          if (input) input.disabled = false;
        this.fillEfforts();
      }
    } catch (e) {
      for (const input of [this.modelInput, this.customModelInput])
        if (input) input.disabled = false;
      this.fillEfforts();
      this.translateButton!.disabled = false;
      this.translateButton!.textContent = "翻译 / 重试";
      this.cancelButton!.hidden = true;
      this.translationStatus.event({ type: "error", text: String(e) });
      this.progress!.textContent = this.translationStatus.text;
      this.translationLog!.textContent += `\n${String(e)}\n`;
      this.translationDetails!.open = true;
      throw e;
    }
  }
  private async resolveUnsaved(): Promise<boolean> {
    const choice = await unsavedDialog(this.app);
    if (choice === "cancel") return false;
    if (choice === "save") {
      try {
        await this.save();
      } catch (e) {
        this.error(e);
        return false;
      }
    } else {
      this.store.saved();
      this.annotationsChanged();
      await this.persistence;
    }
    return true;
  }
  private error(error: unknown): void {
    const text = String(error);
    if (this.status) this.status.textContent = text;
    new Notice(`Paper Lens：${text}`, 10000);
  }
  fileRenamed(path: string, oldPath: string): void {
    if (this.path === oldPath || this.path.startsWith(oldPath + "/")) {
      this.path = path + this.path.slice(oldPath.length);
      this.manager.dispose();
      this.manager = new TranslationManager();
      if (this.ready && !this.closed)
        void this.translate(true).catch((error) => this.error(error));
    }
  }
  shutdown(): void {
    this.closed = true;
    this.manager.dispose();
    this.source?.dispose();
    this.translation?.dispose();
  }
  async onClose(): Promise<void> {
    if (!this.closed && this.store.dirty) {
      const resolved = await this.resolveUnsaved();
      if (!resolved) {
        await this.persistence;
        const file = this.app.vault.getAbstractFileByPath(this.path);
        if (file instanceof TFile)
          setTimeout(() => {
            void this.plugin.openPaper(file);
          }, 0);
      }
    }
    await this.persistence;
    this.shutdown();
  }
}
