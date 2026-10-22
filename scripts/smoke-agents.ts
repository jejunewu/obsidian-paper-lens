import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentService } from "../src/agents/service";
import type { AgentEvent } from "../src/core/types";

async function main(): Promise<void> {
  for (const kind of ["codex", "claude"] as const) {
    if (process.argv[2] && process.argv[2] !== kind) continue;
    const cwd = join(tmpdir(), `paper-lens-smoke-${kind}`);
    await mkdir(cwd, { recursive: true });
    let output = "",
      state = "pending";
    const events: string[] = [];
    const emit = (event: AgentEvent) => {
      events.push(event.type);
      if (event.type === "delta") output += event.text;
      if (event.type === "error") {
        state = event.text;
        console.error(kind, event.text);
      }
      if (event.type === "done") state = "completed";
      if (event.type === "permission") {
        event.respond(false);
        console.log(kind, "permission denied in smoke test");
      }
    };
    const task = {
      cwd,
      prompt:
        "This is a Paper Lens connectivity test. Do not use tools. Reply exactly: Paper Lens 连接成功",
    };
    const run = await new AgentService().run(
      kind,
      "",
      join(process.cwd(), "dist/resources/claude/sdk.cjs"),
      task,
      emit,
    );
    const timeout = setTimeout(() => run.cancel(), 60000);
    await run.done;
    clearTimeout(timeout);
    console.log(JSON.stringify({ kind, state, output, events }));
    await writeFile(
      join(cwd, "result.json"),
      JSON.stringify({ kind, state, output, events }, null, 2),
    );
  }
}
void main();
