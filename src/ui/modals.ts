import { Modal, Setting, type App, SuggestModal, TFile } from "obsidian";
export class PdfPicker extends SuggestModal<TFile> {
  constructor(
    app: App,
    private choose: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("搜索 Vault 中的 PDF");
  }
  getSuggestions(query: string): TFile[] {
    return this.app.vault
      .getFiles()
      .filter(
        (file) =>
          file.extension.toLowerCase() === "pdf" &&
          file.path.toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, 100);
  }
  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createEl("div", { text: file.basename });
    el.createEl("small", { text: file.path });
  }
  onChooseSuggestion(file: TFile): void {
    this.choose(file);
  }
}
export function textDialog(
  app: App,
  initial: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    class TextModal extends Modal {
      private value = initial;
      private accepted = false;
      onOpen(): void {
        this.contentEl.createEl("h2", {
          text: initial ? "编辑文字批注" : "添加文字批注",
        });
        const input = this.contentEl.createEl("textarea", {
          attr: { "aria-label": "批注文字", rows: "5" },
        });
        input.value = initial;
        input.className = "pl-modal-text";
        input.addEventListener("input", () => {
          this.value = input.value;
        });
        new Setting(this.contentEl)
          .addButton((button) =>
            button.setButtonText("取消").onClick(() => this.close()),
          )
          .addButton((button) =>
            button
              .setButtonText("确定")
              .setCta()
              .onClick(() => {
                if (!this.value.trim()) return;
                this.accepted = true;
                this.close();
              }),
          );
        input.focus();
      }
      onClose(): void {
        resolve(this.accepted ? this.value.trim() : undefined);
      }
    }
    new TextModal(app).open();
  });
}
export function unsavedDialog(
  app: App,
): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    class UnsavedModal extends Modal {
      private choice: "save" | "discard" | "cancel" = "cancel";
      onOpen(): void {
        this.contentEl.createEl("h2", { text: "有未保存的 Paper Lens 批注" });
        this.contentEl.createEl("p", {
          text: "保存会将两栏批注分别写回原文和译文 PDF，并保留各自的首次备份。",
        });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
          .addButton((b) =>
            b.setButtonText("放弃").onClick(() => {
              this.choice = "discard";
              this.close();
            }),
          )
          .addButton((b) =>
            b
              .setButtonText("保存")
              .setCta()
              .onClick(() => {
                this.choice = "save";
                this.close();
              }),
          );
      }
      onClose(): void {
        resolve(this.choice);
      }
    }
    new UnsavedModal(app).open();
  });
}
