import { mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type {
  TranslationJob,
  JobManifest,
  AgentKind,
  AgentEvent,
  AgentRun,
  PageSize,
} from "../core/types";
import {
  artifactBytes,
  containedPath,
  digest,
  saveExclusive,
  validateManifest,
} from "./protocol";
import type { AgentService } from "../agents/service";
import { TranslationPipeline } from "./pipeline";

export interface TranslationOptions {
  documentId: string;
  sourcePath: string;
  bytes: Uint8Array;
  sizes: PageSize[];
  root: string;
  fontPath: string;
  skillPath: string;
  sdkPath: string;
  kind: AgentKind;
  cliPath: string;
  model?: string;
  effort?: string;
  fullAccess?: boolean;
  concurrency?: number;
}
export interface TranslationCallbacks {
  event: (e: AgentEvent) => void;
  page: (page: number, bytes: Uint8Array, warnings: string[]) => Promise<void>;
  progress: (manifest: JobManifest) => void;
  saved: (path: string, bytes: Uint8Array) => Promise<void>;
  sourceBytes: () => Promise<Uint8Array>;
}
export class TranslationManager {
  private static owners = new Map<string, TranslationManager>();
  private lockKey?: string;
  private starting = false;
  private cancelling = false;
  job?: TranslationJob;
  private run?: AgentRun;
  private timer?: ReturnType<typeof setInterval>;
  private watcher?: FSWatcher;
  private seen = new Map<number, string>();
  private checking = false;
  private stopped = false;
  private saved = false;
  private options?: TranslationOptions;
  private callbacks?: TranslationCallbacks;
  private lastError = "";
  private terminalError = "";
  constructor(agents: AgentService,
    private createRun = (options: TranslationOptions, job: TranslationJob, emit: (event: AgentEvent) => void) =>
      new TranslationPipeline(agents, options, job, emit).start()) {}
  get active(): boolean {
    return !!this.run || this.starting || this.cancelling;
  }
  private unlock(): void {
    if (this.lockKey && TranslationManager.owners.get(this.lockKey) === this)
      TranslationManager.owners.delete(this.lockKey);
    this.lockKey = undefined;
  }
  async start(
    options: TranslationOptions,
    callbacks: TranslationCallbacks,
    restoreOnly = false,
  ): Promise<void> {
    if (this.active) throw new Error("当前论文已有翻译任务");
    const owner = TranslationManager.owners.get(options.sourcePath);
    if (owner && owner !== this && !restoreOnly)
      throw new Error("这篇论文已在另一个 Paper Lens 标签页翻译");
    this.starting = true;
    if (!restoreOnly) {
      this.lockKey = options.sourcePath;
      TranslationManager.owners.set(options.sourcePath, this);
    }
    try {
      await this.startJob(options, callbacks, restoreOnly);
    } catch (e) {
      this.unlock();
      throw e;
    } finally {
      this.starting = false;
      if (!this.run) this.unlock();
    }
  }
  private async startJob(
    options: TranslationOptions,
    callbacks: TranslationCallbacks,
    restoreOnly: boolean,
  ): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.options = options;
    this.callbacks = callbacks;
    this.stopped = false;
    this.saved = false;
    this.lastError = "";
    this.terminalError = "";
    this.seen.clear();
    const sourceHash = digest(options.bytes),
      association = digest(Buffer.from(options.documentId + sourceHash));
    const folder = join(options.root, "documents", association, "translation");
    if (restoreOnly) {
      try {
        await readFile(join(folder, "job.json"));
      } catch {
        return;
      }
    }
    await mkdir(folder, { recursive: true });
    try {
      const old = JSON.parse(
        await readFile(join(folder, "job.json"), "utf8"),
      ) as TranslationJob;
      if (
        old.version === 1 &&
        old.sourceHash === sourceHash &&
        old.documentId === options.documentId &&
        old.pageCount === options.sizes.length &&
        old.outputDir === folder
      )
        this.job = old;
      else throw new Error("任务版本不匹配");
    } catch {
      this.job = {
        version: 1,
        id: randomUUID(),
        documentId: options.documentId,
        sourceHash,
        sourcePath: join(folder, "source.pdf"),
        pageCount: options.sizes.length,
        sizes: options.sizes,
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        outputDir: folder,
        toolDir: join(options.root, "tools"),
        fontPath: options.fontPath,
      };
      await writeFile(this.job.sourcePath, options.bytes);
      await writeFile(
        join(folder, "job.json"),
        JSON.stringify(this.job, null, 2),
      );
      const initial: JobManifest = {
        version: 1,
        jobId: this.job.id,
        sourceHash,
        status: "pending",
        pages: options.sizes.map((_, i) => ({
          page: i + 1,
          status: "pending",
        })),
      };
      await writeFile(join(folder, "manifest.json"), JSON.stringify(initial));
    }
    const job = this.job!;
    if (!restoreOnly) await unlink(join(folder, "cancelled")).catch(() => {});
    try {
      const saved = JSON.parse(
        await readFile(join(folder, "saved.json"), "utf8"),
      ) as { path: string; sha256: string };
      this.saved = digest(await readFile(saved.path)) === saved.sha256;
    } catch {
      /* Not saved yet. */
    }
    this.timer = setInterval(() => {
      void this.check();
    }, 1500);
    try {
      this.watcher = watch(folder, (_, name) => {
        if (name === "manifest.json") void this.check();
      });
    } catch {
      /* Polling covers filesystems without watches. */
    }
    await this.check();
    if (this.stopped) return;
    if (restoreOnly) {
      callbacks.event({
        type: "status",
        text: "已恢复逐页翻译检查点；点击全文翻译可继续未完成页",
      });
      return;
    }
    if (this.saved) {
      callbacks.event({
        type: "status",
        text: "已恢复译文检查点；完整译文已保存",
      });
      return;
    }
    await this.updateManifest((manifest) => {
      manifest.status = "running";
      delete manifest.error;
    });
    await this.check();
    try {
      this.run = this.createRun(options, job,
        (event) => {
          if (event.type === "error") this.terminalError = event.text;
          // Agent completion alone is not a delivered translation.
          if (event.type === "done" || event.type === "error") return;
          callbacks.event(event);
        },
      );
      const current = this.run;
      if (this.stopped) {
        current.cancel();
        this.run = undefined;
        return;
      }
      void current.done
        .then(async () => {
          if (this.run !== current) return;
          while (this.checking)
            await new Promise((resolve) => setTimeout(resolve, 10));
          if (this.run !== current) return;
          await this.check();
          if (!this.stopped) {
            if (!this.saved) {
              this.terminalError ||=
                this.lastError ||
                "Agent 已结束，但未交付完整译文；点击重试可继续未完成页";
              await this.updateManifest((manifest) => {
                manifest.status = "failed";
                manifest.error = this.terminalError;
              });
              await this.check();
              callbacks.event({ type: "error", text: this.terminalError });
            } else callbacks.event({ type: "done" });
          }
        })
        .catch((error) => {
          callbacks.event({ type: "error", text: String(error) });
        })
        .finally(() => {
          if (this.run === current) {
            this.run = undefined;
            this.unlock();
          }
        });
    } catch (e) {
      this.run = undefined;
      this.terminalError = String(e);
      await this.updateManifest((manifest) => {
        manifest.status = "failed";
        manifest.error = this.terminalError;
      });
      await this.check();
      throw e;
    }
  }
  private async updateManifest(
    update: (manifest: JobManifest) => void,
  ): Promise<void> {
    const path = join(this.job!.outputDir, "manifest.json");
    const manifest = validateManifest(
      JSON.parse(await readFile(path, "utf8")),
      this.job!.id,
      this.job!.sourceHash,
      this.job!.pageCount,
    );
    update(manifest);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(manifest));
    await rename(temp, path);
  }
  async check(): Promise<void> {
    if (
      this.checking ||
      this.stopped ||
      !this.job ||
      !this.options ||
      !this.callbacks
    )
      return;
    this.checking = true;
    try {
      const job = this.job,
        callbacks = this.callbacks;
      const raw = JSON.parse(
        await readFile(join(job.outputDir, "manifest.json"), "utf8"),
      );
      const manifest = validateManifest(
        raw,
        job.id,
        job.sourceHash,
        job.pageCount,
      );
      callbacks.progress(
        this.terminalError && !this.saved
          ? { ...manifest, status: "failed", error: this.terminalError }
          : manifest,
      );
      for (const entry of manifest.pages)
        if (
          entry.status === "completed" &&
          entry.artifact &&
          this.seen.get(entry.page) !== entry.artifact.sha256
        ) {
          const bytes = await artifactBytes(
            job.outputDir,
            entry.artifact,
            job.sizes[entry.page - 1]!,
          );
          if (this.stopped) return;
          await callbacks.page(
            entry.page,
            bytes,
            entry.artifact.warnings ?? [],
          );
          this.seen.set(entry.page, entry.artifact.sha256);
        }
      if (!this.saved && manifest.status === "completed") {
        if (this.seen.size !== job.pageCount || !manifest.final)
          throw new Error("任务声明完成，但缺少有效页面或合并文件");
        const bytes = await readFile(
          await containedPath(job.outputDir, manifest.final.path),
        );
        if (digest(bytes) !== manifest.final.sha256)
          throw new Error("最终 PDF 校验失败");
        const final = await PDFDocument.load(bytes);
        if (final.getPageCount() !== job.pageCount)
          throw new Error("最终 PDF 页数不匹配");
        for (let i = 0; i < job.pageCount; i++) {
          const actual = final.getPage(i).getSize(),
            expected = job.sizes[i]!;
          if (
            Math.abs(actual.width - expected.width) > 0.5 ||
            Math.abs(actual.height - expected.height) > 0.5
          )
            throw new Error("最终 PDF 页面尺寸不匹配");
        }
        if (digest(await callbacks.sourceBytes()) !== job.sourceHash)
          throw new Error(
            "原 PDF 已被修改，译文保留在任务目录，未自动保存到原文件夹",
          );
        if (this.stopped) return;
        const saved = await saveExclusive(
          this.options.sourcePath.replace(/\.pdf$/i, ".zh-CN.pdf"),
          bytes,
        );
        this.saved = true;
        await writeFile(
          join(job.outputDir, "saved.json"),
          JSON.stringify({ path: saved, sha256: digest(bytes) }),
        );
        await callbacks.saved(saved, bytes);
      }
      this.lastError = "";
    } catch (e) {
      const error = String(e);
      if (error !== this.lastError) {
        this.lastError = error;
        this.callbacks.event({ type: "status", text: `译文检查：${error}` });
      }
    } finally {
      this.checking = false;
    }
  }
  async cancel(): Promise<void> {
    if (this.cancelling) return;
    this.cancelling = true;
    this.stopped = true;
    const current = this.run;
    current?.cancel();
    this.run = undefined;
    try {
      if (this.job) {
        await writeFile(join(this.job.outputDir, "cancelled"), "cancelled");
        await current?.done;
        const path = join(this.job.outputDir, "manifest.json"),
          m = JSON.parse(await readFile(path, "utf8")) as JobManifest;
        if (m.status !== "completed") {
          m.status = "cancelled";
          const temp = path + ".cancel.tmp";
          await writeFile(temp, JSON.stringify(m));
          await rename(temp, path);
        }
      }
    } catch {
      /* Keep previously published checkpoints. */
    } finally {
      await current?.done.catch(() => {});
      this.cancelling = false;
      this.unlock();
    }
    this.callbacks?.event({ type: "cancelled" });
  }
  dispose(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    const current = this.run;
    current?.cancel();
    if (current) void current.done.finally(() => this.unlock());
    else this.unlock();
    this.run = undefined;
  }
}
