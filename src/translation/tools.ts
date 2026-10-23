import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import type { TranslationJob } from "../core/types";
import { resolveAgentEnvironment } from "../agents/executables";

export function runTool(path: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("翻译已取消")); return; }
    const child = spawn(path, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32" });
    let output = "", killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch { /* Process already exited. */ }
    };
    const abort = () => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2000);
      killTimer.unref?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    });
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
    };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      cleanup();
      if (signal.aborted) reject(new Error("翻译已取消"));
      else if (code !== 0) reject(new Error(`PDF 工具失败 (${code})：${output}`));
      else resolve();
    });
  });
}

const preparing = new Map<string, Promise<void>>();
export class TranslationTools {
  private env?: NodeJS.ProcessEnv;
  constructor(private job: TranslationJob, private skillPath: string,
    private signal: AbortSignal) {}
  async prepare(): Promise<void> {
    this.env = await resolveAgentEnvironment();
    while (preparing.has(this.job.toolDir)) {
      await preparing.get(this.job.toolDir)!.catch(() => {});
      if (this.signal.aborted) throw new Error("翻译已取消");
    }
    const preparation = runTool("/bin/bash", [
      join(dirname(this.skillPath), "scripts/bootstrap.sh"), this.job.toolDir,
    ], this.job.outputDir, this.env, this.signal);
    preparing.set(this.job.toolDir, preparation);
    try { await preparation; }
    finally { if (preparing.get(this.job.toolDir) === preparation) preparing.delete(this.job.toolDir); }
  }
  async command(command: string, page?: number, extra: string[] = []): Promise<void> {
    await runTool(join(this.job.toolDir, "venv/bin/python"), [
      join(dirname(this.skillPath), "scripts/translate.py"), command,
      "--job", join(this.job.outputDir, "job.json"),
      ...(page ? ["--page", String(page)] : []), ...extra,
    ], this.job.outputDir, { ...this.env!, PYTHONDONTWRITEBYTECODE: "1" }, this.signal);
  }
  async json(name: string): Promise<unknown> {
    return JSON.parse(await readFile(join(this.job.outputDir, name), "utf8"));
  }
}
