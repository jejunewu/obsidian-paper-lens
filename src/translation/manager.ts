import { mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { TranslationJob, JobManifest, AgentKind, AgentEvent, AgentRun, PageSize } from "../core/types";
import { artifactBytes, containedPath, digest, saveExclusive, validateManifest } from "./protocol";
import type { AgentService } from "../agents/service";

export interface TranslationOptions {
  documentId: string; sourcePath: string; bytes: Uint8Array; sizes: PageSize[];
  root: string; fontPath: string; skillPath: string; sdkPath: string; kind: AgentKind; cliPath: string; model?: string;
}
export interface TranslationCallbacks {
  event: (e: AgentEvent) => void; page: (page: number, bytes: Uint8Array, warnings: string[]) => Promise<void>;
  progress: (manifest: JobManifest) => void; saved: (path: string, bytes: Uint8Array) => Promise<void>;
  sourceBytes: () => Promise<Uint8Array>;
}
export class TranslationManager {
  job?: TranslationJob; private run?: AgentRun; private timer?: ReturnType<typeof setInterval>; private watcher?: FSWatcher;
  private seen = new Map<number, string>(); private checking = false; private stopped = false; private saved = false;
  private options?: TranslationOptions; private callbacks?: TranslationCallbacks; private lastError = "";
  constructor(private agents: AgentService) {}
  get active(): boolean { return !!this.run; }
  async start(options: TranslationOptions, callbacks: TranslationCallbacks): Promise<void> {
    if (this.run) throw new Error("当前论文已有翻译任务");
    if (this.timer) clearInterval(this.timer); this.watcher?.close();
    this.options = options; this.callbacks = callbacks; this.stopped = false; this.saved = false; this.lastError = ""; this.seen.clear();
    const sourceHash = digest(options.bytes), association = digest(Buffer.from(options.documentId + sourceHash));
    const folder = join(options.root, "documents", association, "translation"); await mkdir(folder, { recursive: true });
    try {
      const old = JSON.parse(await readFile(join(folder, "job.json"), "utf8")) as TranslationJob;
      if (old.version === 1 && old.sourceHash === sourceHash && old.documentId === options.documentId && old.pageCount === options.sizes.length && old.outputDir === folder) this.job = old;
      else throw new Error("任务版本不匹配");
    } catch {
      this.job = { version: 1, id: randomUUID(), documentId: options.documentId, sourceHash, sourcePath: join(folder, "source.pdf"), pageCount: options.sizes.length, sizes: options.sizes, sourceLanguage: "en", targetLanguage: "zh-CN", outputDir: folder, toolDir: join(options.root, "tools"), fontPath: options.fontPath };
      await writeFile(this.job.sourcePath, options.bytes); await writeFile(join(folder, "job.json"), JSON.stringify(this.job, null, 2));
      const initial: JobManifest = { version: 1, jobId: this.job.id, sourceHash, status: "pending", pages: options.sizes.map((_, i) => ({ page: i + 1, status: "pending" })) };
      await writeFile(join(folder, "manifest.json"), JSON.stringify(initial));
    }
    const job = this.job!;
    await unlink(join(folder, "cancelled")).catch(() => {});
    try {
      const saved = JSON.parse(await readFile(join(folder, "saved.json"), "utf8")) as { path: string; sha256: string };
      this.saved = digest(await readFile(saved.path)) === saved.sha256;
    } catch { /* Not saved yet. */ }
    this.timer = setInterval(() => { void this.check(); }, 1500);
    try { this.watcher = watch(folder, (_, name) => { if (name === "manifest.json") void this.check(); }); } catch { /* Polling covers filesystems without watches. */ }
    await this.check();
    if (this.saved) { callbacks.event({ type: "status", text: "已恢复译文检查点；完整译文已保存" }); return; }
    try {
      this.run = await this.agents.run(options.kind, options.cliPath, options.sdkPath, {
        cwd: folder, model: options.model, skillPath: options.skillPath,
        prompt: `请完整执行 paper-lens-translate skill。任务：${join(folder, "job.json")}。原文快照：${job.sourcePath}。工具缓存允许使用：${job.toolDir}。中文字体：${job.fontPath}。逐页英译简中，保留页序、尺寸、图表、公式；视觉检查后发布每页，并最终 merge。若存在已完成产物，验证并复用；修复失败页。不要仅回复翻译说明，必须实际交付协议产物。`
      }, callbacks.event);
      const current = this.run;
      void current.done.then(async () => { if (this.run === current) this.run = undefined; await this.check(); });
    } catch (e) { this.run = undefined; throw e; }
  }
  async check(): Promise<void> {
    if (this.checking || this.stopped || !this.job || !this.options || !this.callbacks) return;
    this.checking = true;
    try {
      const job = this.job, callbacks = this.callbacks;
      const raw = JSON.parse(await readFile(join(job.outputDir, "manifest.json"), "utf8"));
      const manifest = validateManifest(raw, job.id, job.sourceHash, job.pageCount); callbacks.progress(manifest);
      for (const entry of manifest.pages) if (entry.status === "completed" && entry.artifact && this.seen.get(entry.page) !== entry.artifact.sha256) {
        const bytes = await artifactBytes(job.outputDir, entry.artifact, job.sizes[entry.page - 1]!);
        if (this.stopped) return;
        await callbacks.page(entry.page, bytes, entry.artifact.warnings ?? []); this.seen.set(entry.page, entry.artifact.sha256);
      }
      if (!this.saved && manifest.status === "completed") {
        if (this.seen.size !== job.pageCount || !manifest.final) throw new Error("任务声明完成，但缺少有效页面或合并文件");
        const bytes = await readFile(await containedPath(job.outputDir, manifest.final.path));
        if (digest(bytes) !== manifest.final.sha256) throw new Error("最终 PDF 校验失败");
        const final = await PDFDocument.load(bytes);
        if (final.getPageCount() !== job.pageCount) throw new Error("最终 PDF 页数不匹配");
        for (let i = 0; i < job.pageCount; i++) {
          const actual = final.getPage(i).getSize(), expected = job.sizes[i]!;
          if (Math.abs(actual.width - expected.width) > 0.5 || Math.abs(actual.height - expected.height) > 0.5) throw new Error("最终 PDF 页面尺寸不匹配");
        }
        if (digest(await callbacks.sourceBytes()) !== job.sourceHash) throw new Error("原 PDF 已被修改，译文保留在任务目录，未自动保存到原文件夹");
        if (this.stopped) return;
        const saved = await saveExclusive(this.options.sourcePath.replace(/\.pdf$/i, ".zh-CN.pdf"), bytes);
        this.saved = true; await writeFile(join(job.outputDir, "saved.json"), JSON.stringify({ path: saved, sha256: digest(bytes) }));
        await callbacks.saved(saved, bytes);
      }
      this.lastError = "";
    } catch (e) {
      const error = String(e);
      if (error !== this.lastError) { this.lastError = error; this.callbacks.event({ type: "status", text: `译文检查：${error}` }); }
    } finally { this.checking = false; }
  }
  async cancel(): Promise<void> {
    this.stopped = true;
    this.run?.cancel(); this.run = undefined;
    if (this.job) {
      await writeFile(join(this.job.outputDir, "cancelled"), "cancelled");
      try {
        const path = join(this.job.outputDir, "manifest.json"), m = JSON.parse(await readFile(path, "utf8")) as JobManifest;
        if (m.status !== "completed") { m.status = "cancelled"; const temp = path + ".cancel.tmp"; await writeFile(temp, JSON.stringify(m)); await rename(temp, path); }
      } catch { /* Keep previously published checkpoints. */ }
    }
    this.callbacks?.event({ type: "cancelled" });
  }
  dispose(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.watcher?.close(); this.run?.cancel(); this.run = undefined; }
}
