import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { TranslationPipeline, validateTranslations, type PipelineTools } from "../src/translation/pipeline";
import type { AgentService } from "../src/agents/service";
import type { AgentTask, AgentEvent, TranslationJob } from "../src/core/types";
import { digest } from "../src/translation/protocol";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(failReview = false, pageError?: string) {
  const root = await mkdtemp(join(tmpdir(), "paper-lens-pipeline-")); roots.push(root);
  await writeFile(join(root, "skill.md"), "Translate and visually review each page.");
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  const bytes = await pdf.save();
  const job: TranslationJob = { version: 1, id: "job", documentId: "paper", sourceHash: digest(bytes),
    sourcePath: join(root, "source.pdf"), pageCount: 3, sizes: Array(3).fill({ width: 600, height: 800 }),
    sourceLanguage: "en", targetLanguage: "zh-CN", outputDir: root, toolDir: root, fontPath: "font" };
  const layout = { version: 1, extractionVersion: 2, sourceHash: job.sourceHash, pages: [1, 2, 3].map((page) => ({
    page, text: `English page ${page}`, units: [{ id: `p${page}-u1`, text: "A test sentence" }],
    ...(page === 2 && pageError ? { error: pageError } : {}),
  })) };
  // Page 1 is an existing valid checkpoint; only pages 2 and 3 may run.
  await writeFile(join(root, "one.pdf"), bytes);
  const manifest = { version: 1, jobId: job.id, sourceHash: job.sourceHash, status: "running",
    pages: [{ page: 1, status: "completed", artifact: {
      page: 1, path: "one.pdf", sha256: digest(bytes), width: 600, height: 800, warnings: [],
    } }, { page: 2, status: "pending" }, { page: 3, status: "failed" }] };
  const commands: [string, number | undefined][] = [], tasks: AgentTask[] = [], events: AgentEvent[] = [];
  let running = 0, maxRunning = 0, writers = 0, maxWriters = 0, cancelled = 0;
  const tools: PipelineTools = {
    prepare: async () => {},
    json: async (name) => {
      if (name === "layout.json") return layout;
      if (name === "manifest.json") return manifest;
      if (name === "glossary.json") return { terms: [{ english: "test", chinese: "测试" }] };
      throw new Error("No cache");
    },
    command: async (command, page) => {
      commands.push([command, page]);
      if (["publish", "fail", "merge"].includes(command)) {
        writers++; maxWriters = Math.max(maxWriters, writers);
        await new Promise((resolve) => setTimeout(resolve, 5)); writers--;
      }
    },
  };
  const agents = { run: async (_kind: unknown, _path: unknown, _sdk: unknown, task: AgentTask,
    emit: (event: AgentEvent) => void) => {
    tasks.push(task); running++; maxRunning = Math.max(maxRunning, running);
    let finish!: () => void;
    const pause = new Promise<void>((resolve) => { finish = resolve; });
    const timer = setTimeout(finish, 25);
    const done = pause.then(() => {
      clearTimeout(timer); running--;
      const value = task.images ? { approved: !failReview, issues: "clipped", warnings: [] }
        : { translations: [{ id: task.prompt.includes('"p2-u1"') ? "p2-u1" : "p3-u1", text: "测试句子" }] };
      emit({ type: "session", id: task.sessionId ?? `session-${tasks.length}` });
      emit({ type: "result", value });
      emit({ type: "done" });
    });
    return { done, cancel: () => { cancelled++; finish(); } };
  } } as unknown as AgentService;
  const pipeline = new TranslationPipeline(agents, {
    documentId: "paper", sourcePath: job.sourcePath, bytes, sizes: job.sizes, root,
    fontPath: "font", skillPath: join(root, "skill.md"), sdkPath: "sdk", kind: "codex", cliPath: "",
    fullAccess: true, model: "selected", effort: "low", concurrency: 2,
  }, job, (event) => events.push(event), tools);
  return { pipeline, tasks, commands, events, root,
    counters: () => ({ maxRunning, maxWriters, cancelled }) };
}

describe("parallel translation pipeline", () => {
  it("marks an unsupported page failed while translating other pages", async () => {
    const f = await fixture(false, "倾斜文字暂不支持"); await f.pipeline.start().done;
    expect(f.commands.filter(([c]) => c === "fail")).toEqual([["fail", 2]]);
    expect(f.commands.filter(([c]) => c === "publish")).toEqual([["publish", 3]]);
    expect(f.commands.some(([c]) => c === "merge")).toBe(false);
    expect(f.tasks).toHaveLength(2);
    expect(f.events.at(-1)).toMatchObject({ type: "error", text: expect.stringContaining("倾斜文字暂不支持") });
  });
  it("rejects missing, duplicate and unknown translation units", () => {
    const units = [{ id: "a", text: "source" }];
    expect(validateTranslations({ translations: [{ id: "a", text: "中文" }] }, units)).toEqual({ a: "中文" });
    for (const translations of [[], [{ id: "b", text: "中文" }],
      [{ id: "a", text: "" }], [{ id: "a", text: "中文" }, { id: "a", text: "重复" }]])
      expect(() => validateTranslations({ translations }, units)).toThrow();
  });
  it("reuses valid pages and glossary, runs two pages and serializes reviewed publications", async () => {
    const f = await fixture(); await f.pipeline.start().done;
    expect(f.counters()).toMatchObject({ maxRunning: 2, maxWriters: 1 });
    expect(f.commands.filter(([c]) => c === "publish").map(([, p]) => p).sort()).toEqual([2, 3]);
    expect(f.commands.at(-1)).toEqual(["merge", undefined]);
    expect(f.tasks).toHaveLength(4);
    expect(f.tasks.every((t) => t.model === "selected" && t.effort === "low" && t.fullAccess)).toBe(true);
    expect(f.tasks.filter((t) => t.images).every((t) => !!t.sessionId)).toBe(true);
    expect(f.tasks.filter((t) => t.images).every((t) => t.images!.length === 2)).toBe(true);
    const timing = JSON.parse(await readFile(join(f.root, "timing.json"), "utf8"));
    expect(timing).toMatchObject({ concurrency: 2, model: "selected", cancelled: false });
    expect(timing.firstPageMs).toBeGreaterThan(0);
    expect(f.events.some((e) => e.type === "error")).toBe(false);
  });
  it("never publishes pages that fail three visual reviews", async () => {
    const f = await fixture(true); await f.pipeline.start().done;
    expect(f.commands.some(([c]) => c === "publish" || c === "merge")).toBe(false);
    expect(f.commands.filter(([c]) => c === "fail")).toHaveLength(2);
    expect(f.tasks.filter((t) => t.images)).toHaveLength(6);
    expect(f.commands.filter(([c]) => c === "preview")).toHaveLength(2);
    expect(f.events.at(-1)?.type).toBe("error");
  });
  it("cancels both active page runs without publishing or merging", async () => {
    const f = await fixture(); const run = f.pipeline.start();
    for (let i = 0; i < 30 && f.tasks.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    run.cancel(); await run.done;
    expect(f.counters().cancelled).toBe(2);
    expect(f.commands.some(([c]) => c === "publish" || c === "merge")).toBe(false);
    expect(JSON.parse(await readFile(join(f.root, "timing.json"), "utf8")).cancelled).toBe(true);
  });
});
