import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({
  entryPoints: ["scripts/smoke-agents.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/smoke-agents.cjs",
});
const result = spawnSync(
  process.execPath,
  ["dist/smoke-agents.cjs", ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
