import { PluginSettingTab, Setting, type App } from "obsidian";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type PaperLensPlugin from "./main";
import type { AgentKind } from "./core/types";
import { executable, resolveAgentEnvironment } from "./agents/executables";
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
      text: "自动复用本机 Codex / Claude Code 的配置和终端环境，无需重新配置 API Key。下面的路径和模型均为可选覆盖，留空即可。",
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
              resolveAgentEnvironment().then((env) =>
                executable(
                  kind,
                  this.plugin.settings[
                    kind === "codex" ? "codexPath" : "claudePath"
                  ],
                  env,
                ),
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
    new Setting(containerEl)
      .setName("测试 Agent 连接")
      .setDesc(
        "用默认 Agent 发送一条简短测试消息，验证现有配置、认证和模型响应。",
      )
      .addButton((button) =>
        button.setButtonText("测试连接").onClick(async () => {
          button.setDisabled(true);
          const status = containerEl.createEl("p", {
            attr: { role: "status" },
          });
          status.textContent = "正在连接…";
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const cwd = join(this.plugin.workRoot, "connection-test");
            await mkdir(cwd, { recursive: true });
            const kind = this.plugin.settings.defaultAgent;
            let output = "";
            const run = await this.plugin.agents.run(
              kind,
              this.plugin.cliPath(kind),
              this.plugin.sdkPath,
              {
                cwd,
                model: this.plugin.model(kind),
                prompt:
                  "This is a Paper Lens connectivity test. Do not use tools. Reply exactly: Paper Lens 连接成功",
              },
              (event) => {
                if (event.type === "delta") output += event.text;
                if (event.type === "status") status.textContent = event.text;
                if (event.type === "error")
                  status.textContent = `连接失败：${event.text}`;
                if (event.type === "done")
                  status.textContent = `${kind} 连接成功：${output}`;
                if (event.type === "cancelled")
                  status.textContent =
                    "连接测试超时，请检查本地 CLI 是否能正常响应";
                if (event.type === "permission") event.respond(false);
              },
            );
            timeout = setTimeout(() => run.cancel(), 60000);
            await run.done;
          } catch (error) {
            status.textContent = `连接失败：${String(error)}`;
          } finally {
            if (timeout) clearTimeout(timeout);
            button.setDisabled(false);
          }
        }),
      );
    containerEl.createEl("p", {
      text: "翻译过程可能通过 Agent 安装工具。PyMuPDF 使用 AGPL/商业双重许可；使用和分发要求见 README。插件不保存 CLI 登录凭据。",
    });
  }
}
