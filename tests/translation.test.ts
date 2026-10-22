import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import {
  TranslationManager,
  type TranslationCallbacks,
} from "../src/translation/manager";
import { AgentService } from "../src/agents/service";
import { digest } from "../src/translation/protocol";
import type { JobManifest } from "../src/core/types";

const roots: string[] = [];
const managers: TranslationManager[] = [];
afterEach(async () => {
  managers.splice(0).forEach((m) => m.dispose());
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "paper-lens-job-"));
  roots.push(root);
  const d = await PDFDocument.create();
  d.addPage([600, 800]);
  const bytes = await d.save();
  const source = join(root, "paper.pdf");
  await writeFile(source, bytes);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const agents = new AgentService();
  vi.spyOn(agents, "run").mockResolvedValue({ done, cancel: finish });
  const manager = new TranslationManager(agents);
  managers.push(manager);
  const received: number[] = [],
    saved: string[] = [];
  const callbacks: TranslationCallbacks = {
    event: () => {},
    sourceBytes: async () => readFile(source),
    page: async (page) => {
      received.push(page);
    },
    progress: () => {},
    saved: async (path) => {
      saved.push(path);
    },
  };
  const options = {
    documentId: "paper",
    sourcePath: source,
    bytes,
    sizes: [{ width: 600, height: 800 }],
    root,
    fontPath: "font",
    skillPath: "skill",
    sdkPath: "sdk",
    kind: "codex" as const,
    cliPath: "",
  };
  await manager.start(options, callbacks);
  const folder = manager.job!.outputDir;
  const manifest: JobManifest = {
    version: 1,
    jobId: manager.job!.id,
    sourceHash: digest(bytes),
    status: "running",
    pages: [
      {
        page: 1,
        status: "completed",
        artifact: {
          page: 1,
          path: "page.pdf",
          width: 600,
          height: 800,
          sha256: digest(bytes),
          warnings: [],
        },
      },
    ],
  };
  await writeFile(join(folder, "page.pdf"), bytes);
  return {
    manager,
    options,
    callbacks,
    manifest,
    folder,
    bytes,
    source,
    received,
    saved,
  };
}
async function check(manager: TranslationManager) {
  for (let i = 0; i < 20; i++) {
    await manager.check();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
describe("translation checkpoints", () => {
  it("prevents concurrent translation in another tab but allows checkpoint restoration", async () => {
    const s = await setup();
    const another = new TranslationManager(new AgentService());
    managers.push(another);
    await expect(another.start(s.options, s.callbacks)).rejects.toThrow(
      "另一个",
    );
    await another.start(s.options, s.callbacks, true);
    expect(another.active).toBe(false);
    await s.manager.cancel();
  });
  it("delivers duplicate notifications once and saves only a complete validated final", async () => {
    const s = await setup();
    await writeFile(
      join(s.folder, "manifest.json"),
      JSON.stringify(s.manifest),
    );
    await check(s.manager);
    expect(s.received).toEqual([1]);
    expect(s.saved).toEqual([]);
    await check(s.manager);
    expect(s.received).toEqual([1]);
    s.manifest.status = "completed";
    s.manifest.final = { path: "final.pdf", sha256: digest(s.bytes) };
    await writeFile(join(s.folder, "final.pdf"), s.bytes);
    await writeFile(
      join(s.folder, "manifest.json"),
      JSON.stringify(s.manifest),
    );
    await check(s.manager);
    expect(s.saved).toHaveLength(1);
    expect(await readFile(s.saved[0]!)).toEqual(Buffer.from(s.bytes));
  });
  it("refuses stale source versions and keeps completed pages after cancellation", async () => {
    const s = await setup();
    s.manifest.status = "completed";
    s.manifest.final = { path: "final.pdf", sha256: digest(s.bytes) };
    await writeFile(s.source, "externally changed");
    await writeFile(join(s.folder, "final.pdf"), s.bytes);
    await writeFile(
      join(s.folder, "manifest.json"),
      JSON.stringify(s.manifest),
    );
    await check(s.manager);
    expect(s.saved).toEqual([]);
    expect(s.received).toEqual([1]);
    await s.manager.cancel();
    expect(await readFile(join(s.folder, "page.pdf"))).toEqual(
      Buffer.from(s.bytes),
    );
    expect(await readFile(join(s.folder, "cancelled"), "utf8")).toBe(
      "cancelled",
    );
  });
  it("ignores half-written manifests until atomically published valid data arrives", async () => {
    const s = await setup();
    await writeFile(join(s.folder, "manifest.json"), '{"version":');
    await check(s.manager);
    expect(s.received).toEqual([]);
    await writeFile(
      join(s.folder, "manifest.json"),
      JSON.stringify(s.manifest),
    );
    await check(s.manager);
    expect(s.received).toEqual([1]);
  });
});
