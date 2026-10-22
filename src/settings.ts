import { PluginSettingTab, Setting, type App } from "obsidian";
import { homedir } from "node:os";
import { join } from "node:path";
import type PaperLensPlugin from "./main";
import type { AgentKind } from "./core/types";
import { executable } from "./agents/executables";
export interface PaperLensSettings {
  defaultAgent: AgentKind;
  codexPath: string;
  claudePath: string;
  codexModel: string;
  claudeModel: string;
  skillPath: string;
  workDir: string;
}
export const DEFAULT_SETTINGS: PaperLensSettings = {
  defaultAgent: "codex",
  codexPath: "",
  claudePath: "",
  codexModel: "",
  claudeModel: "",
  skillPath: "",
  workDir: join(homedir(), "Library/Application Support/Paper Lens"),
};
export class PaperLensSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: PaperLensPlugin,
  ) {
    super(app, plugin);
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Paper Lens" });
    containerEl.createEl("p", {
      text: "使用本机已登录的 Codex 或 Claude Code。模型留空时沿用 CLI 配置。",
    });
    new Setting(containerEl).setName("默认 Agent").addDropdown((drop) =>
      drop
        .addOptions({ codex: "Codex", claude: "Claude Code" })
        .setValue(this.plugin.settings.defaultAgent)
        .onChange(async (value) => {
          this.plugin.settings.defaultAgent = value as AgentKind;
          await this.plugin.saveSettings();
        }),
    );
    const fields: [
      keyof Omit<PaperLensSettings, "defaultAgent">,
      string,
      string,
    ][] = [
      [
        "codexPath",
        "Codex CLI 路径",
        "留空自动检测，例如 /opt/homebrew/bin/codex",
      ],
      [
        "claudePath",
        "Claude Code CLI 路径",
        "留空自动检测，例如 ~/.local/bin/claude",
      ],
      ["codexModel", "Codex 模型覆盖", "留空沿用本地配置"],
      ["claudeModel", "Claude 模型覆盖", "留空沿用本地配置"],
      [
        "skillPath",
        "翻译 skill 路径覆盖",
        "SKILL.md 的绝对路径，留空使用插件自带 skill",
      ],
      [
        "workDir",
        "工作目录",
        "论文快照、聊天索引、翻译检查点和工具缓存所在目录",
      ],
    ];
    for (const [key, name, description] of fields)
      new Setting(containerEl)
        .setName(name)
        .setDesc(description)
        .addText((text) =>
          text
            .setValue(this.plugin.settings[key])
            .setPlaceholder(description)
            .onChange(async (value) => {
              this.plugin.settings[key] = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    new Setting(containerEl)
      .setName("检测本地 Agent")
      .setDesc("检查可执行文件；登录和模型可用性会在任务启动时验证。")
      .addButton((button) =>
        button.setButtonText("检测").onClick(async () => {
          button.setDisabled(true);
          const status = containerEl.createEl("p", {
            attr: { role: "status" },
          });
          const results = await Promise.allSettled(
            (["codex", "claude"] as const).map((kind) =>
              executable(
                kind,
                this.plugin.settings[
                  kind === "codex" ? "codexPath" : "claudePath"
                ],
              ),
            ),
          );
          status.textContent = results
            .map(
              (result, index) =>
                `${index ? "Claude" : "Codex"}：${result.status === "fulfilled" ? result.value : String(result.reason)}`,
            )
            .join("；");
          button.setDisabled(false);
        }),
      );
    containerEl.createEl("p", {
      text: "翻译过程可能通过 Agent 安装工具。PyMuPDF 使用 AGPL/商业双重许可；使用和分发要求见 README。插件不保存 CLI 登录凭据。",
    });
  }
}
