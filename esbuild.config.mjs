import * as esbuild from "esbuild";
import { builtinModules } from "node:module";
import { cp, mkdir, copyFile, rm } from "node:fs/promises";

async function resources() {
  await mkdir("dist/resources/pdfjs", { recursive: true });
  await cp("assets", "dist/resources/fonts", { recursive: true });
  await rm("dist/resources/skills", { recursive: true, force: true });
  await cp("skills", "dist/resources/skills", { recursive: true,
    filter: (path) => !path.includes("__pycache__") && !path.endsWith(".pyc") });
  for (const file of ["pdf.mjs", "pdf.worker.mjs"])
    await copyFile(
      `node_modules/pdfjs-dist/build/${file}`,
      `dist/resources/pdfjs/${file}`,
    );
  for (const dir of ["cmaps", "standard_fonts"])
    await cp(`node_modules/pdfjs-dist/${dir}`, `dist/resources/pdfjs/${dir}`, {
      recursive: true,
    });
  await copyFile(
    "node_modules/pdfjs-dist/LICENSE",
    "dist/resources/pdfjs/LICENSE",
  );
  await cp(
    "node_modules/@anthropic-ai/claude-agent-sdk",
    "dist/resources/claude",
    { recursive: true },
  );
  await esbuild.build({
    entryPoints: ["node_modules/pdfjs-dist/build/pdf.mjs"],
    bundle: true,
    platform: "browser",
    format: "cjs",
    target: "es2021",
    outfile: "dist/resources/pdfjs/pdf.cjs",
    define: { "import.meta.url": "__moduleUrl" },
    banner: {
      js: 'var __moduleUrl = require("node:url").pathToFileURL(__filename).href;',
    },
  });
  await esbuild.build({
    entryPoints: ["node_modules/pdfjs-dist/build/pdf.worker.mjs"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2021",
    outfile: "dist/resources/pdfjs/worker.js",
  });
  await esbuild.build({
    entryPoints: ["node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: "dist/resources/claude/sdk.cjs",
    define: { "import.meta.url": "__moduleUrl" },
    banner: {
      js: 'var __moduleUrl = require("node:url").pathToFileURL(__filename).href;',
    },
  });
}
await resources();

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    "node:*",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  plugins: [
    {
      name: "package-resources",
      setup(build) {
        build.onEnd(async (result) => {
          if (!result.errors.length) {
            for (const file of ["main.js", "manifest.json", "styles.css"])
              await copyFile(file, `dist/${file}`);
          }
        });
      },
    },
  ],
  outfile: "main.js",
});

if (production) {
  try {
    await context.rebuild();
  } finally {
    await context.dispose();
  }
} else {
  await context.watch();
}
