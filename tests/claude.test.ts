import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude } from "../src/agents/claude";
import type { AgentEvent } from "../src/core/types";

describe("Claude translation adapter", () => {
  it("bypasses routine approvals and sends model, effort, images and structured output", async () => {
    const root = await mkdtemp(join(tmpdir(), "paper-lens-claude-sdk-"));
    try {
      const sdk = join(root, "sdk.cjs"), image = join(root, "preview.png");
      await writeFile(image, Buffer.from("test PNG"));
      await writeFile(sdk, `exports.query=async function*({prompt,options}) {
 if(options.permissionMode!=='bypassPermissions'||!options.allowDangerouslySkipPermissions||options.canUseTool)throw Error('wrong bypass configuration');
 if(options.model!=='custom-claude'||options.effort!=='low'||options.outputFormat.type!=='json_schema')throw Error('missing model configuration');
 for await (const msg of prompt){
  if(msg.message.content[1].source.media_type!=='image/png'||msg.message.content[1].source.data!=='dGVzdCBQTkc=')throw Error('missing image');
 }
 yield {type:'system',subtype:'init',session_id:'session'};
 yield {type:'result',subtype:'success',is_error:false,structured_output:{approved:true}};
};`);
      const events: AgentEvent[] = [];
      await runClaude("claude", sdk, { cwd: root, prompt: "inspect", model: "custom-claude",
        effort: "low", fullAccess: true, images: [image], outputSchema: { type: "object" } },
        (event) => events.push(event)).done;
      expect(events).toEqual([{ type: "session", id: "session" },
        { type: "result", value: { approved: true } }, { type: "done" }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
