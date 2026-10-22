import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentEnvironment } from "../src/agents/executables";

describe("local Agent shell environment", () => {
  it("inherits terminal exports without losing multiline values or shell noise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paper lens ' shell-"));
    try {
      await writeFile(
        join(dir, ".zshrc"),
        `echo 'startup banner'
export PAPER_LENS_TEST_KEY='terminal configuration'
export PAPER_LENS_TEST_MULTILINE='line one
line two'
export CODEX_HOME="$ZDOTDIR/custom codex"
unset PAPER_LENS_TEST_UNSET
`,
      );
      const env = await loadAgentEnvironment(
        {
          ...process.env,
          ZDOTDIR: dir,
          PAPER_LENS_TEST_KEY: "gui configuration",
          PAPER_LENS_TEST_UNSET: "unset by terminal configuration",
        },
        "/bin/zsh",
      );
      expect(env.PAPER_LENS_TEST_KEY).toBe("terminal configuration");
      expect(env.PAPER_LENS_TEST_MULTILINE).toBe("line one\nline two");
      expect(env.CODEX_HOME).toBe(join(dir, "custom codex"));
      expect(env.PAPER_LENS_TEST_UNSET).toBeUndefined();
      expect(env.PATH).toContain("/opt/homebrew/bin");
      expect(env["startup banner"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("times out and never exposes shell output in errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paper-lens-shell-"));
    try {
      const shell = join(dir, "shell");
      await writeFile(
        shell,
        "#!/bin/sh\necho secret-value >&2\nexec /bin/sleep 2\n",
        { mode: 0o755 },
      );
      await expect(
        loadAgentEnvironment(process.env, shell, 50),
      ).rejects.toThrow(/^无法读取终端环境（启动失败或超时）/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
