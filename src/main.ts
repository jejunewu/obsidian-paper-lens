import {
  FileSystemAdapter,
  Notice,
  Platform,
  Plugin,
  TFile,
  normalizePath,
} from "obsidian";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  PaperLensSettingsTab,
  type PaperLensSettings,
} from "./settings";
import type { ModelApiConfig } from "./translation/config";
import { PdfPicker } from "./ui/modals";
import { PaperLensView, VIEW_TYPE } from "./ui/view";
import { disposePdfRuntime } from "./pdf/runtime";

export default class PaperLensPlugin extends Plugin {
  settings: PaperLensSettings = { ...DEFAULT_SETTINGS };
  get resourceRoot(): string {
    return join(
      this.basePath,
      this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`,
      "resources",
    );
  }
  get runtimePath(): string {
    return join(this.resourceRoot, "pdfmath");
  }
  get apiConfig(): ModelApiConfig {
    return {
      baseUrl: this.settings.apiBaseUrl, model: this.settings.apiModel,
      apiKey: this.app.secretStorage.getSecret(this.settings.apiKeySecret) ?? "",
      timeout: this.settings.apiTimeout, concurrency: this.settings.translationConcurrency,
      effort: this.settings.reasoningEffort, autoGlossary: this.settings.autoGlossary,
    };
  }
  get workRoot(): string {
    return resolve(
      this.settings.workDir.replace(/^~(?=\/)/, homedir()) ||
        DEFAULT_SETTINGS.workDir,
    );
  }
  get basePath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter))
      throw new Error("Paper Lens 需要本地桌面 Vault");
    return adapter.getBasePath();
  }
  async onload(): Promise<void> {
    if (!Platform.isDesktopApp) {
      new Notice("Paper Lens 仅支持 macOS 桌面");
      return;
    }
    this.settings = normalizeSettings(await this.loadData());
    await this.saveSettings();
    this.registerView(VIEW_TYPE, (leaf) => new PaperLensView(leaf, this));
    this.addSettingTab(new PaperLensSettingsTab(this.app, this));
    this.addCommand({
      id: "open-paper",
      name: "打开论文 PDF",
      callback: () =>
        new PdfPicker(this.app, (file) => {
          void this.openPaper(file);
        }).open(),
    });
    this.addCommand({
      id: "open-active-pdf",
      name: "使用 Paper Lens 打开当前 PDF",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension.toLowerCase() !== "pdf") return false;
        if (!checking) void this.openPaper(file);
        return true;
      },
    });
    this.addRibbonIcon("scan-text", "Paper Lens：打开论文", () =>
      new PdfPicker(this.app, (file) => {
        void this.openPaper(file);
      }).open(),
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension.toLowerCase() === "pdf")
          menu.addItem((item) =>
            item
              .setTitle("使用 Paper Lens 打开")
              .setIcon("scan-text")
              .onClick(() => {
                void this.openPaper(file);
              }),
          );
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))
          if (leaf.view instanceof PaperLensView)
            leaf.view.fileRenamed(file.path, oldPath);
      }),
    );
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
  async openPaper(file: TFile): Promise<void> {
    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: VIEW_TYPE,
        state: { file: normalizePath(file.path) },
        active: true,
      });
      await this.app.workspace.revealLeaf(leaf);
    } catch (e) {
      new Notice(`Paper Lens：${String(e)}`, 10000);
    }
  }
  onunload(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))
      if (leaf.view instanceof PaperLensView) leaf.view.shutdown();
    disposePdfRuntime();
  }
}
