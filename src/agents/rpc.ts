import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonLines } from "./json-lines";
import { agentEnvironment } from "./executables";
export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}
export class RpcClient {
  private process: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (x: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private stderr = "";
  constructor(
    path: string,
    cwd: string,
    private event: (message: RpcMessage) => void,
    private exited: (error: Error) => void,
    env = agentEnvironment(),
  ) {
    this.process = spawn(path, ["app-server", "--stdio"], {
      cwd,
      env,
      stdio: "pipe",
    });
    const parser = new JsonLines(
      (value) => {
        const m = value as RpcMessage;
        if (typeof m.id === "number" && !m.method && this.pending.has(m.id)) {
          const p = this.pending.get(m.id)!;
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        } else this.event(m);
      },
      (error) => this.close(error),
    );
    this.process.stdout.on("data", (data: Buffer) => parser.push(data));
    this.process.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-3000);
    });
    this.process.on("error", (e) => this.close(e));
    this.process.on("exit", (code) =>
      this.close(new Error(`Codex 进程退出 (${code}) ${this.stderr}`)),
    );
  }
  send(message: RpcMessage): void {
    if (!this.closed) this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex 连接已关闭"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 响应超时`));
      }, 30000);
      this.pending.set(id, { resolve: (x) => resolve(x as T), reject, timer });
      this.send({ id, method, params });
    });
  }
  close(error = new Error("连接已关闭")): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.process.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.process.exitCode === null) this.process.kill("SIGKILL");
    }, 2000);
    timer.unref?.();
    this.exited(error);
  }
}
