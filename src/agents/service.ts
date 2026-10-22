import type { AgentKind, AgentRun, AgentTask, AgentEvent } from "../core/types";
import { executable, resolveAgentEnvironment } from "./executables";
import { runCodex } from "./codex";
import { runClaude } from "./claude";
export class AgentService {
  private runs = new Set<AgentRun>();
  private disposed = false;
  async run(
    kind: AgentKind,
    configured: string,
    sdkPath: string,
    task: AgentTask,
    emit: (e: AgentEvent) => void,
  ): Promise<AgentRun> {
    emit({
      type: "status",
      text: `正在连接 ${kind === "codex" ? "Codex" : "Claude Code"}，复用终端环境和本地配置…`,
    });
    const env = await resolveAgentEnvironment();
    const path = await executable(kind, configured, env);
    if (this.disposed) throw new Error("Paper Lens 已关闭，连接已取消");
    const run =
      kind === "codex"
        ? runCodex(path, task, emit, env)
        : runClaude(path, sdkPath, task, emit, env);
    this.runs.add(run);
    void run.done.finally(() => this.runs.delete(run));
    return run;
  }
  dispose(): void {
    this.disposed = true;
    for (const run of this.runs) run.cancel();
    this.runs.clear();
  }
}
