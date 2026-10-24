import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { redact } from "./api";

export function runTool(path: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, signal: AbortSignal,
  options: { input?: string; secret?: string; line?: (line: string) => void } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("翻译已取消")); return; }
    const child = spawn(path, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"],
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
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const parse = (text: string) => {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) options.line?.(redact(line, options.secret ?? ""));
      if (pending.length > 100000) pending = pending.slice(-100000);
    };
    child.stdout.on("data", (chunk: Buffer) => { parse(decoder.write(chunk)); });
    child.stderr.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); });
    child.stdin.on("error", () => { /* Early process exit is reported by close. */ });
    child.stdin.end(options.input);
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
    };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      if (signal.aborted) kill("SIGKILL");
      cleanup();
      parse(decoder.end());
      if (pending) options.line?.(redact(pending, options.secret ?? ""));
      if (signal.aborted) reject(new Error("翻译已取消"));
      else if (code !== 0) reject(new Error(`PDF 工具失败 (${code})：${redact(output, options.secret ?? "")}`));
      else resolve();
    });
  });
}
