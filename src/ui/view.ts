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
import type { AgentKind, Annotation } from "../core/types";
import { AnnotationStore } from "../core/annotations";
import { digest } from "../translation/protocol";
import { PdfReader } from "../pdf/reader";
import {
  readAnnotations,
  writeAnnotations,
  withoutPaperLensAnnotations,
} from "../pdf/annotations";
import { saveSource } from "../pdf/source";
import { TranslationManager } from "../translation/manager";
import { textDialog, unsavedDialog } from "./modals";
import { TranslationStatus } from "./translation-status";
export const VIEW_TYPE = "paper-lens";

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
  private kind: AgentKind;
  private zoom = 1;
  private translationPanel?: HTMLElement;
  private translateDivider?: HTMLElement;
  private saveButton?: HTMLButtonElement;
  private translateButton?: HTMLButtonElement;
  private cancelButton?: HTMLButtonElement;
  private pageInput?: HTMLInputElement;
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
  private translationPermissions?: HTMLElement;
  private permissionReplies = new Set<(allow: boolean) => void>();
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PaperLensPlugin,
  ) {
    super(leaf);
    this.allowNoFile = true;
    this.kind = plugin.settings.defaultAgent;
    this.manager = new TranslationManager(plugin.agents);
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
      translationOpen: this.translationOpen,
      agent: this.kind,
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
    if (state.agent === "codex" || state.agent === "claude")
      this.kind = state.agent;
    if (typeof state.zoom === "number")
      this.zoom = Math.max(0.25, Math.min(4, state.zoom));
    this.translationOpen = state.translationOpen === true;
    const pos = state.position as
      | { page?: number; fraction?: number }
      | undefined;
    if (pos && Number.isInteger(pos.page) && typeof pos.fraction === "number")
      this.restorePosition = { page: pos.page!, fraction: pos.fraction };
    if (
      path && path !== this.path && this.store.dirty &&
      !(await this.resolveUnsaved())
    ) return;
    await super.setState({ ...state, file: path }, result);
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
    this.clearTranslationPermissions();
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
    const toolButtons: HTMLButtonElement[] = [];
    const setTool = (
      tool: "select" | "pan" | "text",
      button: HTMLButtonElement,
    ) => {
      this.source?.setTool(tool);
      this.translation?.setTool(tool === "pan" ? "pan" : "select");
      for (const item of toolButtons)
        item.setAttribute("aria-pressed", String(item === button));
    };
    const select = this.button(toolbar, "选择", () =>
      setTool("select", select),
    );
    toolButtons.push(select);
    select.setAttribute("aria-pressed", "true");
    const pan = this.button(toolbar, "拖动", () => setTool("pan", pan));
    toolButtons.push(pan);
    this.button(toolbar, "−", () => this.setZoom(this.zoom / 1.2));
    this.button(toolbar, "+", () => this.setZoom(this.zoom * 1.2));
    const mode = toolbar.createEl("select", {
      attr: { "aria-label": "翻页方式" },
    });
    mode.createEl("option", { text: "连续滚动", value: "continuous" });
    mode.createEl("option", { text: "单页阅读", value: "single" });
    mode.addEventListener("change", () => {
      this.source?.setMode(mode.value as "continuous" | "single");
      this.translation?.setMode(mode.value as "continuous" | "single");
    });
    this.button(toolbar, "上一页", () =>
      this.navigate((this.source?.position().page ?? 1) - 1),
    );
    this.button(toolbar, "下一页", () =>
      this.navigate((this.source?.position().page ?? 1) + 1),
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
    this.button(toolbar, "荧光笔", () => this.highlight());
    const text = this.button(toolbar, "插入文本", () => setTool("text", text));
    toolButtons.push(text);
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
    const agent = toolbar.createEl("select", {
      attr: { "aria-label": "Agent 选择" },
    });
    agent.createEl("option", { text: "Codex", value: "codex" });
    agent.createEl("option", { text: "Claude Code", value: "claude" });
    agent.value = this.kind;
    agent.addEventListener("change", () => {
      this.kind = agent.value as AgentKind;
    });
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
    this.translationPermissions = this.contentEl.createDiv({
      cls: "pl-translation-permissions",
    });
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
    this.source.onPosition = (pos) => {
      this.translation?.navigate(pos);
      if (this.pageInput) this.pageInput.value = String(pos.page);
    };
    this.translation.onPosition = (pos) => {
      this.source?.navigate(pos);
      if (this.pageInput) this.pageInput.value = String(pos.page);
    };
    this.source.onAnnotation = (id, edit) => {
      this.selected = id;
      this.source?.setAnnotations(this.store.items, id);
      if (edit && !this.saveBusy)
        void this.editText(id).catch((e) => this.error(e));
    };
    this.source.onInsert = (page, point) => {
      void this.insertText(page, point).catch((e) => this.error(e));
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
    this.panels();
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
  }
  private async loadPaper(): Promise<void> {
    this.ready = false;
    this.status!.textContent = "正在加载论文…";
    this.manager.dispose();
    this.manager = new TranslationManager(this.plugin.agents);
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
      if (this.restorePosition)
        this.navigate(this.restorePosition.page, this.restorePosition.fraction);
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
    if (!selection) throw new Error("请先在原文同一页选中文字");
    this.store.upsert({
      id: randomUUID(),
      page: selection.page,
      kind: "highlight",
      rects: selection.rects,
      text: selection.text,
      color: [1, 0.85, 0.2],
    });
    this.annotationsChanged();
  }
  private async insertText(
    page: number,
    point: [number, number],
  ): Promise<void> {
    if (this.saveBusy) return;
    const text = await textDialog(this.app, "");
    if (!text || this.closed || this.saveBusy) return;
    this.store.upsert({
      id: randomUUID(),
      page,
      kind: "text",
      rects: [[point[0], point[1] - 60, point[0] + 240, point[1]]],
      text,
      color: [1, 1, 0],
    });
    this.annotationsChanged();
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
    this.zoom = Math.max(0.25, Math.min(4, zoom));
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
    this.source?.navigate(pos);
    this.translation?.navigate(pos);
    if (this.pageInput) this.pageInput.value = String(page);
  }
  private async translate(restoreOnly = false): Promise<void> {
    if (!this.ready || !this.bytes)
      throw new Error("请先打开可选中文字的论文 PDF");
    if (this.manager.active) throw new Error("当前论文已有翻译任务");
    if (this.pageTexts.some((text) => !text.trim())) {
      if (restoreOnly) return;
      throw new Error("扫描页不支持翻译，请使用可选中文字的英文 PDF");
    }
    if (!restoreOnly) {
      this.translationOpen = true;
      this.panels();
      this.translateButton!.disabled = true;
      this.cancelButton!.hidden = false;
    }
    this.translationStatus.reset();
    this.translationLog!.textContent = "";
    this.translationStatus.event({
      type: "status",
      text: restoreOnly
        ? "正在恢复翻译检查点…"
        : "正在准备论文快照并连接本地 Agent…",
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
          fontPath: join(
            this.plugin.resourceRoot,
            "fonts/NotoSansCJKsc-Regular.otf",
          ),
          skillPath: this.plugin.skillPath,
          sdkPath: this.plugin.sdkPath,
          kind: this.kind,
          cliPath: this.plugin.cliPath(this.kind),
          model: this.plugin.model(this.kind),
        },
        {
          sourceBytes: async () =>
            readFile(join(this.plugin.basePath, this.path)),
          event: (event) => {
            if (this.closed) {
              if (event.type === "permission") event.respond(false);
              return;
            }
            this.translationStatus.event(event);
            this.progress!.textContent = this.translationStatus.text;
            if (
              event.type === "delta" ||
              event.type === "status" ||
              event.type === "error"
            ) {
              this.translationLog!.textContent = (
                (this.translationLog!.textContent || "") +
                (event.type === "delta" ? event.text : `\n${event.text}\n`)
              ).slice(-12000);
            }
            if (event.type === "error") this.translationDetails!.open = true;
            if (event.type === "permission") {
              this.permissionReplies.add(event.respond);
              const box = this.translationPermissions!.createDiv({
                cls: "pl-permission",
              });
              box.createEl("strong", { text: `翻译 · ${event.title}` });
              box.createEl("pre", { text: event.detail });
              for (const [label, allow] of [
                ["允许本次操作", true],
                ["拒绝", false],
              ] as const)
                this.button(box, label, () => {
                  event.respond(allow);
                  this.permissionReplies.delete(event.respond);
                  box.remove();
                });
            }
            if (
              event.type === "done" ||
              event.type === "error" ||
              event.type === "cancelled"
            ) {
              this.clearTranslationPermissions();
              this.translateButton!.disabled = false;
              this.translateButton!.textContent = "翻译 / 重试失败页";
              this.cancelButton!.hidden = true;
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
      if (!this.manager.active) {
        this.translateButton!.disabled = false;
        this.cancelButton!.hidden = true;
      }
    } catch (e) {
      this.translateButton!.disabled = false;
      this.translateButton!.textContent = "翻译 / 重试失败页";
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
    if (this.path === oldPath) {
      this.path = path;
      this.status!.textContent = "源文件已重命名；请重新打开以建立新的任务关联";
      this.manager.dispose();
    }
  }
  private clearTranslationPermissions(): void {
    for (const reply of this.permissionReplies) reply(false);
    this.permissionReplies.clear();
    this.translationPermissions?.replaceChildren();
  }
  shutdown(): void {
    this.closed = true;
    this.clearTranslationPermissions();
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
