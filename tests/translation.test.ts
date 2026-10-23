import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import {
  TranslationManager,
  type TranslationCallbacks,
} from "../src/translation/manager";
import { AgentService } from "../src/agents/service";
import { digest } from "../src/translation/protocol";
import type { AgentEvent, JobManifest } from "../src/core/types";

const roots: string[] = [];
const managers: TranslationManager[] = [];
afterEach(async () => {
  managers.splice(0).forEach((m) => m.dispose());
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup(cancelImmediately = true) {
  const root = await mkdtemp(join(tmpdir(), "paper-lens-job-"));
  roots.push(root);
  const d = await PDFDocument.create();
  d.addPage([600, 800]);
  const bytes = await d.save();
  const source = join(root, "paper.pdf");
  await writeFile(source, bytes);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const agents = new AgentService();
  let emit!: (event: AgentEvent) => void;
  const manager = new TranslationManager(agents, (_options, _job, callback) => {
    emit = callback;
    return { done, cancel: () => { if (cancelImmediately) finish(); } };
  });
  managers.push(manager);
  const events: AgentEvent[] = [],
    progress: JobManifest[] = [];
  const received: number[] = [],
    saved: string[] = [];
  const callbacks: TranslationCallbacks = {
    event: (event) => {
      events.push(event);
    },
    sourceBytes: async () => readFile(source),
    page: async (page) => {
      received.push(page);
    },
    progress: (manifest) => {
      progress.push(manifest);
    },
    saved: async (path) => {
      saved.push(path);
    },
  };
  const options = {
    documentId: "paper",
    sourcePath: source,
    bytes,
    sizes: [{ width: 600, height: 800 }],
    root,
    fontPath: "font",
    skillPath: "skill",
    sdkPath: "sdk",
    kind: "codex" as const,
    cliPath: "",
  };
  await manager.start(options, callbacks);
  const folder = manager.job!.outputDir;
  const manifest: JobManifest = {
    version: 1,
    jobId: manager.job!.id,
    sourceHash: digest(bytes),
    status: "running",
    pages: [
      {
        page: 1,
        status: "completed",
        artifact: {
          page: 1,
          path: "page.pdf",
          width: 600,
          height: 800,
          sha256: digest(bytes),
          warnings: [],
        },
      },
    ],
  };
  await writeFile(join(folder, "page.pdf"), bytes);
  return {
    manager,
    options,
    callbacks,
    manifest,
    folder,
    bytes,
    source,
    received,
    saved,
    emit: (event: AgentEvent) => emit(event),
    finish,
    events,
    progress,
  };
}
async function check(manager: TranslationManager) {
  for (let i = 0; i < 20; i++) {
    await manager.check();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
describe("translation checkpoints", () => {
  it("clears the previous job when another document has no checkpoint to restore", async () => {
    const s = await setup();
    await s.manager.cancel();
    await s.manager.start({ ...s.options, documentId: "another-paper" }, s.callbacks, true);
    expect(s.manager.job).toBeUndefined();
    expect(s.manager.active).toBe(false);
    expect(JSON.parse(await readFile(join(s.folder, "job.json"), "utf8")).documentId).toBe("paper");
  });
  it("starts a paragraph cache separately from older line translation checkpoints", async () => {
    const s = await setup();
    const legacy = join(s.options.root, "documents", digest(Buffer.from(s.options.documentId + digest(s.bytes))), "translation");
    expect(s.folder).not.toBe(legacy);
  });
  it("keeps the document locked until cancelled workers have stopped", async () => {
    const s = await setup(false);
    const cancelling = s.manager.cancel();
    await vi.waitFor(async () => {
      expect(await readFile(join(s.folder, "cancelled"), "utf8")).toBe("cancelled");
    });
    expect(s.manager.active).toBe(true);
    await expect(s.manager.start(s.options, s.callbacks)).rejects.toThrow("已有翻译任务");
    const another = new TranslationManager(new AgentService());
    managers.push(another);
    await expect(another.start(s.options, s.callbacks)).rejects.toThrow("另一个");
    s.finish();
    await cancelling;
    expect(s.manager.active).toBe(false);
    expect(JSON.parse(await readFile(join(s.folder, "manifest.json"), "utf8")).status).toBe("cancelled");
  });
  it("persists Agent failure across polling and restoration, then clears it for retry", async () => {
    const s = await setup();
    s.emit({
      type: "error",
      text: "Missing environment variable: OPENAI_API_KEY",
    });
    s.finish();
    await check(s.manager);
    expect(s.progress.at(-1)).toMatchObject({
      status: "failed",
      error: "Missing environment variable: OPENAI_API_KEY",
    });
    const stored = JSON.parse(
      await readFile(join(s.folder, "manifest.json"), "utf8"),
    );
    expect(stored.status).toBe("failed");
    await s.manager.start(s.options, s.callbacks, true);
    await check(s.manager);
    expect(s.progress.at(-1)?.error).toContain("OPENAI_API_KEY");
    await s.manager.start(s.options, s.callbacks);
    expect(s.progress.at(-1)).toMatchObject({ status: "running" });
    expect(s.progress.at(-1)?.error).toBeUndefined();
  });
  it("reports completion without delivered artifacts as a retryable failure", async () => {
    const s = await setup();
    s.emit({ type: "done" });
    s.finish();
    await check(s.manager);
    expect(s.progress.at(-1)).toMatchObject({ status: "failed" });
    expect(s.progress.at(-1)?.error).toContain("未交付完整译文");
    expect(s.events.some((e) => e.type === "done")).toBe(false);
    expect(s.events.some((e) => e.type === "error")).toBe(true);
  });
  it("prevents concurrent translation in another tab but allows checkpoint restoration", async () => {
    const s = await setup();
    const another = new TranslationManager(new AgentService());
    managers.push(another);
    await expect(another.start(s.options, s.callbacks)).rejects.toThrow(
      "另一个",
    );
    await another.start(s.options, s.callbacks, true);
    expect(another.active).toBe(false);
    await s.manager.cancel();
  });
  it("delivers duplicate notifications once and saves only a complete validated final", async () => {
    const s = await setup();
    await writeFile(
      join(s.folder, "manifest.json"),
      JSON.stringify(s.manifest),
    );
    await check(s.manager);
    expect(s.received).toEqual([1]);
    expect(s.saved).toEqual([]);
    await check(s.manager);
    expect(s.received).toEqual([1]);
    s.manifest.status = "completed";
    s.manifest.final = { path: "final.pdf", sha256: digest(s.bytes) };
    await writeFile(join(s.folder, "final.pdf"), s.bytes);
    await writeFile(
      join(s.folder, "manifest.json"),
      JSON.stringify(s.manifest),
    );
    await check(s.manager);
    expect(s.saved).toHaveLength(1);
    expect(await readFile(s.saved[0]!)).toEqual(Buffer.from(s.bytes));
  });
  it("refuses stale source versions and keeps completed pages after cancellation", async () => {
    const s = await setup();
    s.manifest.status = "completed";
    s.manifest.final = { path: "final.pdf", sha256: digest(s.bytes) };
    await writeFile(s.source, "externally changed");
    await writeFile(join(s.folder, "final.pdf"), s.bytes);
    await writeFile(
      join(s.folder, "manifest.json"),
      JSON.stringify(s.manifest),
    );
    await check(s.manager);
    expect(s.saved).toEqual([]);
    expect(s.received).toEqual([1]);
    await s.manager.cancel();
    expect(await readFile(join(s.folder, "page.pdf"))).toEqual(
      Buffer.from(s.bytes),
    );
    expect(await readFile(join(s.folder, "cancelled"), "utf8")).toBe(
      "cancelled",
    );
  });
  it("ignores half-written manifests until atomically published valid data arrives", async () => {
    const s = await setup();
    await writeFile(join(s.folder, "manifest.json"), '{"version":');
    await check(s.manager);
    expect(s.received).toEqual([]);
    await writeFile(
      join(s.folder, "manifest.json"),
      JSON.stringify(s.manifest),
    );
    await check(s.manager);
    expect(s.received).toEqual([1]);
  });
});
