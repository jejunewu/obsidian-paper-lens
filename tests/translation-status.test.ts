import { describe, expect, it } from "vitest";
import { TranslationStatus } from "../src/ui/translation-status";
import type { JobManifest } from "../src/core/types";

describe("translation feedback", () => {
  it("keeps terminal errors visible when pending progress and status arrive", () => {
    const status = new TranslationStatus();
    const manifest: JobManifest = {
      version: 1,
      jobId: "job",
      sourceHash: "hash",
      status: "pending",
      pages: [{ page: 1, status: "pending" }],
    };
    status.event({ type: "error", text: "连接失败" });
    status.progress(manifest);
    status.event({ type: "status", text: "等待翻译" });
    expect(status.text).toContain("连接失败");
    expect(status.text).toContain("重试失败页");
    status.reset();
    status.progress(manifest);
    expect(status.text).not.toContain("连接失败");
  });
  it("keeps the saved destination visible after repeated progress", () => {
    const status = new TranslationStatus();
    status.save("/tmp/paper.zh-CN.pdf");
    status.progress({
      version: 1,
      jobId: "job",
      sourceHash: "hash",
      status: "completed",
      pages: [],
    });
    expect(status.text).toBe("译文已保存：paper.zh-CN.pdf");
  });
  it("clears a restored checkpoint failure when retry begins", () => {
    const status = new TranslationStatus();
    const manifest: JobManifest = {
      version: 1,
      jobId: "job",
      sourceHash: "hash",
      status: "failed",
      error: "旧错误",
      pages: [],
    };
    status.progress(manifest);
    expect(status.text).toContain("旧错误");
    status.progress({ ...manifest, status: "running", error: undefined });
    expect(status.text).not.toContain("旧错误");
  });
});
