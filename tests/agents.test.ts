import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodex } from "../src/agents/codex";
import type { AgentEvent } from "../src/core/types";

describe("Codex process lifecycle", () => {
  it("streams, resumes its own thread and resolves completion once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paper-lens-agent-"));
    try {
      const cli = join(dir, "codex");
      await writeFile(
        cli,
        `#!/usr/bin/env node\nconst rl=require('readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{ const m=JSON.parse(line); if(!m.id)return;
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='thread/resume')send({id:m.id,result:{thread:{id:m.params.threadId}}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});send({method:'item/agentMessage/delta',params:{threadId:'session',delta:'中文'}});send({method:'turn/completed',params:{threadId:'session',turn:{id:'turn',status:'completed'}}});}
});`,
        { mode: 0o755 },
      );
      const events: AgentEvent[] = [];
      const run = runCodex(
        cli,
        { cwd: dir, prompt: "question", sessionId: "session" },
        (e) => events.push(e),
      );
      await run.done;
      expect(events.filter((e) => e.type === "delta")).toEqual([
        { type: "delta", text: "中文" },
      ]);
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
      expect(events.find((e) => e.type === "session")).toEqual({
        type: "session",
        id: "session",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reports startup failure and cancellation", async () => {
    const events: AgentEvent[] = [];
    await runCodex("/missing/cli", { cwd: tmpdir(), prompt: "x" }, (e) =>
      events.push(e),
    ).done;
    expect(events.some((e) => e.type === "error")).toBe(true);
    const cancelled: AgentEvent[] = [];
    const run = runCodex(
      process.execPath,
      { cwd: tmpdir(), prompt: "x" },
      (e) => cancelled.push(e),
    );
    run.cancel();
    await run.done;
    expect(cancelled.filter((e) => e.type === "cancelled")).toHaveLength(1);
  });
});
