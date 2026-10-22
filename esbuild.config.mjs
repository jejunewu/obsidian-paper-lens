import * as esbuild from "esbuild";
import { builtinModules } from "node:module";

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
