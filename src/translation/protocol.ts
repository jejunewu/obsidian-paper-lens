import { createHash } from "node:crypto";
import { readFile, realpath, open, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, extname } from "node:path";
import { PDFDocument } from "pdf-lib";
import type { JobManifest, PageArtifact, PageSize } from "../core/types";
export function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function validateManifest(raw: unknown, jobId: string, sourceHash: string, pageCount: number): JobManifest {
  if (!raw || typeof raw !== "object") throw new Error("无效任务清单");
  const m = raw as JobManifest;
  if (m.version !== 1 || m.jobId !== jobId || m.sourceHash !== sourceHash || !["pending", "running", "completed", "failed", "cancelled"].includes(m.status) || !Array.isArray(m.pages) || m.pages.length !== pageCount) throw new Error("任务清单与原文不匹配");
  const seen = new Set<number>();
  for (const p of m.pages) {
    if (!Number.isInteger(p.page) || p.page < 1 || p.page > pageCount || seen.has(p.page) || !["pending", "running", "completed", "failed"].includes(p.status)) throw new Error("任务页码或状态无效");
    if (p.status === "completed" && (!p.artifact || p.artifact.page !== p.page)) throw new Error("完成页缺少有效产物");
    seen.add(p.page);
  }
  return m;
}
export async function containedPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.includes("\0")) throw new Error("产物路径越界");
  const base = await realpath(root), file = await realpath(resolve(base, path));
  const rel = relative(base, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("产物路径越界"); return file;
}
export async function artifactBytes(root: string, artifact: PageArtifact, size: PageSize): Promise<Buffer> {
  const bytes = await readFile(await containedPath(root, artifact.path));
  if (digest(bytes) !== artifact.sha256) throw new Error("产物校验摘要不匹配");
  const doc = await PDFDocument.load(bytes);
  if (doc.getPageCount() !== 1) throw new Error("每页产物必须是单页 PDF");
  const actual = doc.getPage(0).getSize();
  if ([actual.width - size.width, actual.height - size.height, artifact.width - size.width, artifact.height - size.height].some(x => !Number.isFinite(x) || Math.abs(x) > 0.5)) throw new Error("译文页面尺寸与原文不一致");
  return bytes;
}
export async function saveExclusive(path: string, bytes: Uint8Array): Promise<string> {
  const ext = extname(path), stem = path.slice(0, -ext.length);
  for (let n = 0; n < 10000; n++) {
    const candidate = n ? `${stem}.${n}${ext}` : path;
    let handle;
    try { handle = await open(candidate, "wx"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; throw e; }
    try { await handle.writeFile(bytes); await handle.sync(); await handle.close(); return candidate; }
    catch (e) { await handle.close(); await unlink(candidate).catch(() => {}); throw e; }
  }
  throw new Error("无法生成不重名的输出文件");
}
