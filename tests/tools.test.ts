import { describe, expect, it } from "vitest";
import { runTool } from "../src/translation/tools";
import { tmpdir } from "node:os";

describe("PDF tool execution", () => {
  it("reports failures and aborts a running tool without leaving its process", async () => {
    const controller = new AbortController();
    await expect(runTool(process.execPath, ["-e", "console.error('layout overflow');process.exit(2)"],
      tmpdir(), process.env, controller.signal)).rejects.toThrow("layout overflow");
    const running = runTool(process.execPath, ["-e", "setInterval(()=>{},1000)"], tmpdir(), process.env, controller.signal);
    controller.abort();
    await expect(running).rejects.toThrow("翻译已取消");
    await expect(runTool(process.execPath, [], tmpdir(), process.env, controller.signal)).rejects.toThrow("翻译已取消");
  });
});
