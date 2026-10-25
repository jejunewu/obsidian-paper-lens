import { mkdir, readFile, writeFile, unlink, rename, readdir } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type {
  TranslationJob,
  JobManifest,
  TranslationEvent,
  TranslationRun,
  PageSize,
} from "../core/types";
import {
  artifactBytes,
  containedPath,
  digest,
  saveExclusive,
  validateManifest,
} from "./protocol";
import { startTranslation } from "./backend";
import type { ModelApiConfig } from "./config";
import { apiBaseUrl, validateApi } from "./api";
import { translationFingerprint } from "../pdf/fingerprint";

export interface TranslationOptions {
  documentId: string;
  sourcePath: string;
  bytes: Uint8Array;
  sizes: PageSize[];
  root: string;
  runtimePath: string;
  api: ModelApiConfig;
}
export interface TranslationCallbacks {
  event: (e: TranslationEvent) => void;
  page: (page: number, bytes: Uint8Array, warnings: string[]) => Promise<void>;
  progress: (manifest: JobManifest) => void;
  saved: (path: string, bytes: Uint8Array) => Promise<void>;
  restored?: (path: string, bytes: Uint8Array) => Promise<void>;
  sourceBytes: () => Promise<Uint8Array>;
}
function checkpointId(documentId: string, sourceHash: string, api: ModelApiConfig): string {
  return digest(Buffer.from(JSON.stringify([documentId, sourceHash, "pdfmath-2.9.0-babeldoc-0.6.2-v1",
    apiBaseUrl(api.baseUrl), api.model, api.effort, api.autoGlossary])));
}
async function reusableCheckpoint(options: TranslationOptions, sourceHash: string): Promise<string | undefined> {
  const documents = join(options.root, "documents");
  const entries = await readdir(documents, { withFileTypes: true }).catch(() => []);
  let fingerprint: string | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const folder = join(documents, entry.name, "translation");
    try {
      const job = JSON.parse(await readFile(join(folder, "job.json"), "utf8")) as TranslationJob;
      // The historical ID stays unchanged so its directory can still prove the
      // provider/model configuration after any number of subsequent moves.
      if (job.version !== 1 || typeof job.documentId !== "string" ||
          job.pageCount !== options.sizes.length || job.sourcePath !== join(folder, "source.pdf") ||
          job.outputDir !== folder || checkpointId(job.documentId, job.sourceHash, options.api) !== entry.name)
        continue;
      const manifest = validateManifest(JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")),
        job.id, job.sourceHash, job.pageCount);
      if (manifest.status !== "completed" || !manifest.final ||
          !manifest.pages.every((page) => page.status === "completed")) continue;
      if (job.sourceHash !== sourceHash) {
        const snapshot = await readFile(await containedPath(folder, "source.pdf"));
        if (digest(snapshot) !== job.sourceHash) continue;
        fingerprint ??= await translationFingerprint(options.bytes);
        if (await translationFingerprint(snapshot) !== fingerprint) continue;
      }
      return folder;
    } catch {
      // Incomplete, legacy and malformed jobs are not relocation candidates.
    }
  }
  return undefined;
}
export class TranslationManager {
  private static owners = new Map<string, TranslationManager>();
  private lockKey?: string;
  private starting = false;
  private cancelling = false;
  job?: TranslationJob;
  private run?: TranslationRun;
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
  constructor(private createRun = startTranslation) {}
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
    this.job = undefined;
    if (!restoreOnly) validateApi(options.api);
    const sourceHash = digest(options.bytes);
    const expectedFolder = join(options.root, "documents", checkpointId(options.documentId, sourceHash, options.api), "translation");
    let folder = expectedFolder;
    try { await readFile(join(folder, "job.json")); }
    catch { folder = await reusableCheckpoint(options, sourceHash) ?? expectedFolder; }
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
        (old.sourceHash === sourceHash || folder !== expectedFolder) &&
        (old.documentId === options.documentId || folder !== expectedFolder) &&
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
        toolDir: join(options.root, "tools", "pdfmath-2.9.0-v1"),
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
    let savedDocument: { path: string; bytes: Uint8Array } | undefined;
    let finalFingerprint: string | undefined;
    try {
      const saved = JSON.parse(
        await readFile(join(folder, "saved.json"), "utf8"),
      ) as { path: string; sha256: string };
      // Both PDFs may have moved together, or the source may also be renamed.
      // Annotation edits may change the digest. In that case compare with the
      // verified immutable final PDF before adopting the edited export.
      const candidates = new Set([saved.path,
        join(dirname(options.sourcePath), basename(saved.path)),
        options.sourcePath.replace(/\.pdf$/i, ".zh-CN.pdf")]);
      for (const path of candidates) {
        try {
          const bytes = await readFile(path);
          const hash = digest(bytes);
          if (hash !== saved.sha256) {
            if (!finalFingerprint) {
              const manifest = validateManifest(JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")),
                job.id, job.sourceHash, job.pageCount);
              if (manifest.status !== "completed" || !manifest.final) continue;
              const final = await readFile(await containedPath(folder, manifest.final.path));
              if (digest(final) !== manifest.final.sha256) continue;
              finalFingerprint = await translationFingerprint(final);
            }
            if (await translationFingerprint(bytes) !== finalFingerprint) continue;
          }
          this.saved = true;
          savedDocument = { path, bytes };
          if (path !== saved.path || hash !== saved.sha256) {
            const temp = join(folder, `saved.${randomUUID()}.tmp`);
            await writeFile(temp, JSON.stringify({ path, sha256: hash }));
            await rename(temp, join(folder, "saved.json"));
          }
          break;
        } catch { /* Try the next known export location. */ }
      }
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
    if (savedDocument) await callbacks.restored?.(savedDocument.path, savedDocument.bytes);
    if (this.stopped) return;
    if (restoreOnly) {
      callbacks.event({
        type: "status",
        text: "已恢复翻译记录；点击全文翻译可重试",
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
          // Engine completion alone is not a delivered translation.
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
                "翻译引擎已结束，但未交付完整译文；点击重试";
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
        const currentSource = await callbacks.sourceBytes();
        if (digest(currentSource) !== job.sourceHash) {
          const snapshot = await readFile(await containedPath(job.outputDir, "source.pdf"));
          if (digest(snapshot) !== job.sourceHash ||
              await translationFingerprint(currentSource) !== await translationFingerprint(snapshot))
            throw new Error(
              "原 PDF 已被修改，译文保留在任务目录，未自动保存到原文件夹",
            );
        }
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
