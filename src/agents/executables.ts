import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentKind } from "../core/types";
export function agentEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(delimiter) };
}
export async function executable(kind: AgentKind, configured = ""): Promise<string> {
  const candidates = configured ? [configured.replace(/^~(?=\/)/, homedir())] : [join(homedir(), ".local/bin", kind), `/opt/homebrew/bin/${kind}`, `/usr/local/bin/${kind}`, ...agentEnvironment().PATH!.split(delimiter).map(dir => join(dir, kind))];
  for (const path of candidates) { try { await access(path, constants.X_OK); return path; } catch { /* Try next installation. */ } }
  throw new Error(`未找到 ${kind} CLI，请在 Paper Lens 设置中配置可执行文件路径`);
}
