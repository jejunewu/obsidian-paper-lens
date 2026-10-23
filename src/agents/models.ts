import type { query as Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentKind, AgentModel } from "../core/types";
import { RpcClient } from "./rpc";

export async function discoverModels(kind: AgentKind, path: string, sdkPath: string,
  cwd: string, env: NodeJS.ProcessEnv): Promise<AgentModel[]> {
  if (kind === "claude") {
    const sdk = require(sdkPath) as { query: typeof Query };
    const session = sdk.query({ prompt: "", options: {
      cwd, env, pathToClaudeCodeExecutable: path, settingSources: ["user"],
    } });
    try {
      const models = await session.supportedModels();
      return models.map((m) => ({ id: m.value, name: m.displayName,
        efforts: m.supportedEffortLevels ?? [], supportsImages: true }));
    } finally { session.close(); }
  }
  const rpc = new RpcClient(path, cwd, () => {}, () => {}, env);
  try {
    await rpc.request("initialize", { clientInfo: { name: "paper_lens", version: "0.1.0" },
      capabilities: { experimentalApi: false } });
    rpc.send({ method: "initialized" });
    const models: AgentModel[] = [];
    let cursor: string | undefined;
    do {
      const result = await rpc.request<{ data: {
        model: string; displayName: string;
        supportedReasoningEfforts?: { reasoningEffort: string }[];
        inputModalities?: string[];
      }[]; nextCursor?: string }>("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...result.data.map((m) => ({ id: m.model, name: m.displayName,
        efforts: m.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [],
        supportsImages: !m.inputModalities || m.inputModalities.includes("image") })));
      cursor = result.nextCursor || undefined;
    } while (cursor);
    return models;
  } finally { rpc.close(); }
}
