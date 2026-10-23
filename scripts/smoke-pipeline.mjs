import { build } from "esbuild";
import { spawn } from "node:child_process";

await build({
  entryPoints: ["scripts/smoke-pipeline.ts"], bundle: true, platform: "node", format: "esm",
  outfile: "dist/smoke-pipeline.mjs",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const child = spawn(process.execPath, ["dist/smoke-pipeline.mjs", ...process.argv.slice(2)], {
  stdio: "inherit", env: process.env,
});
process.once("SIGINT", () => child.kill("SIGINT"));
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("close", (code) => { process.exitCode = code ?? 1; });
