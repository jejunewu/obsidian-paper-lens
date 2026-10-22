import type { AgentEvent, JobManifest } from "../core/types";

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
  event(event: AgentEvent): void {
    if (event.type === "status") this.phase = event.text;
    if (event.type === "error") {
      this.failure = event.text;
      this.eventFailure = true;
    }
    if (event.type === "cancelled")
      this.phase = "翻译已取消；已完成页面保留，点击重试可继续";
    if (event.type === "permission") this.phase = "等待你确认下方的任务权限";
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
        ? `翻译失败：${this.failure}；点击“翻译 / 重试失败页”继续，详情见下方`
        : this.phase,
    ]
      .filter(Boolean)
      .join(" · ");
  }
}
