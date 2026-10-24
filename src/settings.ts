import { PluginSettingTab, Setting, type App } from "obsidian";
import type PaperLensPlugin from "./main";
import { apiBaseUrl, testConnection } from "./translation/api";
export { DEFAULT_SETTINGS, normalizeSettings, type PaperLensSettings } from "./translation/config";

export class PaperLensSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: PaperLensPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Paper Lens" });
    containerEl.createEl("p", { text: "PDFMathTranslate-next 在本地识别段落和排版，通过你指定的 OpenAI 兼容 API 翻译。" });
    new Setting(containerEl).setName("模型 API 地址")
      .setDesc("填写包含 /v1 或服务自定义前缀的 Base URL，也支持完整 /chat/completions 地址。")
      .addText((text) => text.setValue(this.plugin.settings.apiBaseUrl).setPlaceholder("https://api.example.com/v1")
        .onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName("API Key")
      .setDesc("存入 Obsidian 密钥存储，不写入插件 data.json。无认证的本地服务可填任意非空值。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.setValue(this.plugin.app.secretStorage.getSecret(this.plugin.settings.apiKeySecret) ?? "")
          .setPlaceholder("API Key")
          .onChange((value) => this.plugin.app.secretStorage.setSecret(this.plugin.settings.apiKeySecret, value.trim()));
      });
    new Setting(containerEl).setName("翻译模型 ID").setDesc("使用服务实际支持的模型；文本模型即可，不要求图片输入。")
      .addText((text) => text.setValue(this.plugin.settings.apiModel).setPlaceholder("模型 ID")
        .onChange(async (value) => { this.plugin.settings.apiModel = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("推理强度").setDesc("默认不发送 reasoning_effort。仅在服务支持此参数时选择。")
      .addDropdown((drop) => drop.addOptions({ "": "不发送", minimal: "minimal", low: "low", medium: "medium", high: "high" })
        .setValue(this.plugin.settings.reasoningEffort)
        .onChange(async (value) => { this.plugin.settings.reasoningEffort = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("请求超时（秒）").setDesc("单次 API 请求超时，10–600 秒；不代表整篇论文的耗时。")
      .addText((text) => text.setValue(String(this.plugin.settings.apiTimeout)).onChange(async (value) => {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 10 || number > 600) return;
        this.plugin.settings.apiTimeout = Math.round(number); await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("翻译请求并发").setDesc("同时处理的段落请求上限，并作为每秒请求上限；限流时可降低。")
      .addDropdown((drop) => drop.addOptions({ "1": "1", "2": "2", "3": "3", "4": "4" })
        .setValue(String(this.plugin.settings.translationConcurrency))
        .onChange(async (value) => { this.plugin.settings.translationConcurrency = Number(value); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("自动提取术语表").setDesc("提升长文术语一致性，但会额外调用模型并增加耗时。默认关闭。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoGlossary)
        .onChange(async (value) => { this.plugin.settings.autoGlossary = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("工作目录").setDesc("论文快照、任务记录和本地 Python 环境所在目录。")
      .addText((text) => text.setValue(this.plugin.settings.workDir)
        .onChange(async (value) => { this.plugin.settings.workDir = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("测试模型 API").setDesc("发送一条简短 Chat Completions 请求，验证地址、认证和模型；会消耗少量额度。")
      .addButton((button) => button.setButtonText("测试连接").onClick(async () => {
        button.setDisabled(true);
        const status = containerEl.createEl("p", { attr: { role: "status" } });
        status.textContent = "正在连接…";
        try {
          this.plugin.settings.apiBaseUrl = apiBaseUrl(this.plugin.settings.apiBaseUrl);
          await this.plugin.saveSettings();
          status.textContent = `连接成功：${await testConnection(this.plugin.apiConfig)}`;
        } catch (error) { status.textContent = `连接失败：${String(error)}`; }
        finally { button.setDisabled(false); }
      }));
    containerEl.createEl("p", { text: "首次翻译会下载 Python 依赖、识别模型和字体。翻译 API 费用由服务商收取；本地开源组件的许可和安装说明见 README。" });
  }
}
