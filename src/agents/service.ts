import type { AgentKind, AgentRun, AgentTask, AgentEvent } from "../core/types";
import { executable } from "./executables";
import { runCodex } from "./codex";
import { runClaude } from "./claude";
export class AgentService {
  private runs = new Set<AgentRun>();
  async run(kind: AgentKind, configured: string, sdkPath: string, task: AgentTask, emit: (e: AgentEvent) => void): Promise<AgentRun> {
    const path = await executable(kind, configured);
    const run = kind === "codex" ? runCodex(path, task, emit) : runClaude(path, sdkPath, task, emit);
    this.runs.add(run); void run.done.finally(() => this.runs.delete(run)); return run;
  }
  dispose(): void { for (const run of this.runs) run.cancel(); this.runs.clear(); }
}
