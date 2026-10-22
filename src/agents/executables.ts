import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentKind } from "../core/types";
export function agentEnvironment(base = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    PATH: [
      base.PATH ?? "/usr/bin:/bin",
      join(homedir(), ".local/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ].join(delimiter),
  };
}
// Capture exports in memory only. Startup output may contain secrets and must
// never be included in logs or errors. NUL framing preserves multiline values.
export async function loadAgentEnvironment(
  base = process.env,
  shell = base.SHELL || "/bin/zsh",
  timeout = 15000,
): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return agentEnvironment(base);
  const marker = `paper-lens-${randomUUID()}`;
  const command = `printf '\\0${marker}\\0'; /usr/bin/env -0; printf '\\0${marker}\\0'`;
  const output = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      shell,
      ["-ilc", command],
      {
        cwd: homedir(),
        env: base,
        encoding: "buffer",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              "无法读取终端环境（启动失败或超时）；请检查登录 shell 的启动脚本后重试",
            ),
          );
        else resolve(stdout);
      },
    );
  });
  const frame = Buffer.from(`\0${marker}\0`);
  const start = output.indexOf(frame),
    end = output.indexOf(frame, start + frame.length);
  if (start < 0 || end < 0)
    throw new Error("无法读取终端环境：登录 shell 未返回环境变量");
  const env: NodeJS.ProcessEnv = {};
  for (const entry of output
    .subarray(start + frame.length, end)
    .toString()
    .split("\0")) {
    const equals = entry.indexOf("=");
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return agentEnvironment(env);
}
let shellEnvironment: Promise<NodeJS.ProcessEnv> | undefined;
export function resolveAgentEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (!shellEnvironment) {
    shellEnvironment = loadAgentEnvironment().catch((error) => {
      shellEnvironment = undefined;
      throw error;
    });
  }
  return shellEnvironment;
}
export async function executable(
  kind: AgentKind,
  configured = "",
  env = agentEnvironment(),
): Promise<string> {
  const candidates = configured
    ? [configured.replace(/^~(?=\/)/, homedir())]
    : [
        ...env.PATH!.split(delimiter).map((dir) => join(dir, kind)),
        join(homedir(), ".local/bin", kind),
        `/opt/homebrew/bin/${kind}`,
        `/usr/local/bin/${kind}`,
      ];
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Try next installation. */
    }
  }
  throw new Error(
    `未找到 ${kind} CLI，请在 Paper Lens 设置中配置可执行文件路径`,
  );
}
