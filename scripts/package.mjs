import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const { version } = JSON.parse(await readFile("manifest.json", "utf8"));
const output = `paper-lens-${version}.zip`;
const result = spawnSync(
  "zip",
  ["-q", "-r", output, "main.js", "manifest.json", "styles.css", "resources"],
  { cwd: "dist", stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Installable plugin: dist/${output}`);
