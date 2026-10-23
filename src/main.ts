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
import { AgentService } from "./agents/service";
import {
  DEFAULT_SETTINGS,
  PaperLensSettingsTab,
  type PaperLensSettings,
} from "./settings";
import type { AgentKind } from "./core/types";
import { PdfPicker } from "./ui/modals";
import { PaperLensView, VIEW_TYPE } from "./ui/view";
import { disposePdfRuntime } from "./pdf/runtime";

export default class PaperLensPlugin extends Plugin {
  settings: PaperLensSettings = { ...DEFAULT_SETTINGS };
  agents = new AgentService();
  get resourceRoot(): string {
    return join(
      this.basePath,
      this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`,
      "resources",
    );
  }
  get sdkPath(): string {
    return join(this.resourceRoot, "claude", "sdk.cjs");
  }
  get skillPath(): string {
    return (
      this.settings.skillPath.replace(/^~(?=\/)/, homedir()) ||
      join(this.resourceRoot, "skills/paper-lens-translate/SKILL.md")
    );
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
  cliPath(kind: AgentKind): string {
    return kind === "codex"
      ? this.settings.codexPath
      : this.settings.claudePath;
  }
  model(kind: AgentKind): string | undefined {
    return (
      (kind === "codex"
        ? this.settings.codexModel
        : this.settings.claudeModel) || undefined
    );
  }
  async onload(): Promise<void> {
    if (!Platform.isDesktopApp) {
      new Notice("Paper Lens 首版仅支持 macOS 桌面");
      return;
    }
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
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
    this.agents.dispose();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))
      if (leaf.view instanceof PaperLensView) leaf.view.shutdown();
    disposePdfRuntime();
  }
}
