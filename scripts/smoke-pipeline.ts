import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { AgentService } from "../src/agents/service";
import { TranslationManager } from "../src/translation/manager";
import type { AgentEvent } from "../src/core/types";

const root = resolve(process.argv[2] ?? "/tmp/paper-lens-pipeline-smoke");
const kind = process.argv[3] === "claude" ? "claude" : "codex";
const concurrency = Number(process.argv[4] ?? 2);
await mkdir(root, { recursive: true });
const source = join(root, "parallel.pdf");
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 2; i++) {
  const page = pdf.addPage([600, 800]);
  page.drawText(`Paper Lens Translation - Page ${i}`, { x: 40, y: 740, size: 18, font });
  page.drawText(i === 1 ? "Abstract: Attention models capture relationships in data."
    : "Results: Accuracy improved from 70% to 82% on Dataset Aurora.", { x: 40, y: 690, size: 12, font });
  page.drawRectangle({ x: 40, y: 300, width: 240, height: 100, borderWidth: 1 });
}
const bytes = await pdf.save(); await writeFile(source, bytes);
const agents = new AgentService();
const sdkPath = resolve("dist/resources/claude/sdk.cjs");
try {
  const models = await agents.models(kind, "", sdkPath, root);
  console.log(`${kind} model catalog: ${models.map((m) => m.id).join(", ")}`);
} catch (e) { console.log(`Model catalog unavailable: ${String(e)}`); }
const manager = new TranslationManager(agents);
let terminal!: () => void;
const completed = new Promise<void>((resolve) => { terminal = resolve; });
let success = false;
const timer = setTimeout(() => { void manager.cancel(); }, 300000);
process.once("SIGINT", () => { void manager.cancel(); });
try {
  await manager.start({ documentId: source, sourcePath: source, bytes,
    sizes: [{ width: 600, height: 800 }, { width: 600, height: 800 }], root,
    fontPath: resolve("assets/NotoSansCJKsc-Regular.otf"),
    skillPath: resolve("skills/paper-lens-translate/SKILL.md"), sdkPath,
    kind, cliPath: "", fullAccess: true, concurrency,
    ...(process.env.PAPER_LENS_SMOKE_MODEL ? { model: process.env.PAPER_LENS_SMOKE_MODEL } : {}),
    ...(process.env.PAPER_LENS_SMOKE_EFFORT ? { effort: process.env.PAPER_LENS_SMOKE_EFFORT } : {}),
  }, { event: (event: AgentEvent) => {
    if (event.type === "status" || event.type === "error") console.log(event.text);
    if (event.type === "permission") { console.log("UNEXPECTED PERMISSION"); event.respond(false); }
    if (event.type === "done") { success = true; terminal(); }
    if (event.type === "error" || event.type === "cancelled") terminal();
  }, progress: () => {}, page: async (page) => { console.log(`PAGE ${page} DISPLAYED`); },
    sourceBytes: () => readFile(source), saved: async (path) => { console.log(`SAVED ${path}`); } });
  await completed;
  console.log("TIMING", await readFile(join(manager.job!.outputDir, "timing.json"), "utf8"));
} finally { clearTimeout(timer); manager.dispose(); agents.dispose(); }
if (!success) process.exitCode = 1;
