import type { TranslationEvent, JobManifest } from "../core/types";

export class TranslationStatus {
  private counts = "";
  private phase = "";
  private failure = "";
  private eventFailure = false;
  private saved = "";
  reset(): void {
    this.counts = this.phase = this.failure = this.saved = "";
    this.eventFailure = false;
  }
  event(event: TranslationEvent): void {
    if (event.type === "progress") {
      const stages: Record<string, string> = {
        "Parse PDF and Create Intermediate Representation": "解析 PDF",
        DetectScannedFile: "检测扫描页", "Parse Page Layout": "识别版面",
        "Parse Paragraphs": "识别段落", "Parse Formulas and Styles": "识别公式与样式",
        "Automatic Term Extraction": "提取术语", "Translate Paragraphs": "翻译段落",
        Typesetting: "排版", "Add Fonts": "嵌入字体", "Generate drawing instructions": "生成页面",
        "Subset font": "字体子集化", "Save PDF": "保存 PDF",
      };
      const percent = Number.isFinite(event.percent) ? Math.max(0, Math.min(100, event.percent)) : 0;
      this.phase = `${stages[event.stage] ?? event.stage} ${event.current}/${event.total} · ${percent.toFixed(0)}%`;
    }
    if (event.type === "status") this.phase = event.text;
    if (event.type === "error") {
      this.failure = event.text;
      this.eventFailure = true;
    }
    if (event.type === "cancelled")
      this.phase = "翻译已取消；点击重试重新处理";
  }
  progress(manifest: JobManifest): void {
    const completed = manifest.pages.filter(
      (page) => page.status === "completed",
    ).length;
    const failed = manifest.pages.filter(
      (page) => page.status === "failed",
    ).length;
    this.counts = `译文 ${completed}/${manifest.pages.length} 页${failed ? ` · ${failed} 页失败` : ""}`;
    if (manifest.status === "running" && !this.eventFailure) this.failure = "";
    if (manifest.status === "failed")
      this.failure =
        manifest.error ||
        manifest.pages.find((page) => page.error)?.error ||
        "部分页面未完成";
    if (!this.phase)
      this.phase = {
        pending: "等待开始",
        running: "正在翻译",
        completed: "正在校验并保存",
        failed: "",
        cancelled: "已取消",
      }[manifest.status];
  }
  save(path: string): void {
    this.saved = `译文已保存：${path.split("/").pop()}`;
  }
  get text(): string {
    if (this.saved) return this.saved;
    return [
      this.counts,
      this.failure
        ? `翻译失败：${this.failure}；点击“全文翻译”重试，详情见下方`
        : this.phase,
    ]
      .filter(Boolean)
      .join(" · ");
  }
}
