import { afterEach, describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import {
  readFile,
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAnnotations,
  writeAnnotations,
  withoutPaperLensAnnotations,
} from "../src/pdf/annotations";
import {
  validateManifest,
  artifactBytes,
  digest,
  saveExclusive,
} from "../src/translation/protocol";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function root() {
  const p = await mkdtemp(join(tmpdir(), "paper-lens-test-"));
  roots.push(p);
  return p;
}
async function pdf(pages = 1) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([600, 800]);
  return d.save();
}

describe("PDF annotations", () => {
  it("preserves colored highlights and transparent text with its chosen size", async () => {
    const items = [
      { id: "green", page: 1, kind: "highlight" as const,
        rects: [[10, 10, 100, 30] as [number, number, number, number]],
        text: "highlight", color: [0.2, 1, 0.4] as [number, number, number] },
      { id: "red", page: 1, kind: "text" as const,
        rects: [[40, 80, 280, 180] as [number, number, number, number]],
        text: "红色文字", color: [0.8, 0.1, 0.1] as [number, number, number], fontSize: 24 },
    ];
    const result = await writeAnnotations(await pdf(), items,
      await readFile("assets/NotoSansCJKsc-Regular.otf"));
    expect(await readAnnotations(result)).toEqual(items);
    const loaded = await PDFDocument.load(result);
    const text = loaded.getPage(0).node.Annots()!.lookup(1, PDFDict);
    expect(text.get(PDFName.of("C"))).toBeUndefined(); // No background fill color.
    expect(text.lookup(PDFName.of("DA"), PDFString).decodeText())
      .toBe("/PaperLensText 24 Tf 0.8 0.1 0.1 rg");
    expect(loaded.getPage(0).node.Resources()!.lookup(PDFName.of("Font"), PDFDict)
      .has(PDFName.of("PaperLensText"))).toBe(true);
    await expect(writeAnnotations(result, [{ ...items[1]!, rects: [[0, 0, 30, 10]] }],
      await readFile("assets/NotoSansCJKsc-Regular.otf")))
      .rejects.toThrow("文字批注超出区域");
  }, 20000);
  it("exports Chinese appearance streams and preserves unrelated annotations", async () => {
    const d = await PDFDocument.create();
    const page = d.addPage([600, 800]);
    const original = d.context.register(
      d.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [1, 1, 20, 20],
        Contents: PDFString.of("existing"),
      }),
    );
    page.node.set(PDFName.of("Annots"), d.context.obj([original]));
    const item = {
      id: "one",
      page: 1,
      kind: "text" as const,
      rects: [[40, 50, 240, 90] as [number, number, number, number]],
      text: "中文 annotation",
      color: [1, 1, 0] as [number, number, number],
    };
    const result = await writeAnnotations(
      await d.save(),
      [item],
      await readFile("assets/NotoSansCJKsc-Regular.otf"),
    );
    expect(await readAnnotations(result)).toEqual([item]);
    const loaded = await PDFDocument.load(result);
    expect(loaded.getPage(0).node.Annots()?.size()).toBe(2);
    const resaved = await writeAnnotations(
      result,
      [{ ...item, text: "第二次中文编辑" }],
      await readFile("assets/NotoSansCJKsc-Regular.otf"),
    );
    expect(resaved.length - result.length).toBeLessThan(1000000);
    expect((await readAnnotations(resaved))[0]?.text).toBe("第二次中文编辑");
    const editable = await withoutPaperLensAnnotations(result);
    expect(
      (await PDFDocument.load(editable)).getPage(0).node.Annots()?.size(),
    ).toBe(1);
    const removed = await writeAnnotations(
      result,
      [],
      await readFile("assets/NotoSansCJKsc-Regular.otf"),
    );
    expect(
      (await PDFDocument.load(removed)).getPage(0).node.Annots()?.size(),
    ).toBe(1);
  }, 20000);
});

describe("translation delivery", () => {
  it("rejects duplicate, missing and out-of-range manifest pages", () => {
    const good = {
      version: 1,
      jobId: "j",
      sourceHash: "h",
      status: "running",
      pages: [{ page: 1, status: "pending" }],
    };
    expect(validateManifest(good, "j", "h", 1).pages).toHaveLength(1);
    expect(() =>
      validateManifest({ ...good, pages: [] }, "j", "h", 1),
    ).toThrow();
    expect(() =>
      validateManifest(
        { ...good, pages: [good.pages[0], good.pages[0]] },
        "j",
        "h",
        2,
      ),
    ).toThrow();
    expect(() =>
      validateManifest({ ...good, jobId: "other" }, "j", "h", 1),
    ).toThrow();
  });
  it("validates single-page PDFs, digests, dimensions and contained real paths", async () => {
    const dir = await root();
    const bytes = await pdf();
    await writeFile(join(dir, "page.pdf"), bytes);
    const a = {
      page: 1,
      path: "page.pdf",
      width: 600,
      height: 800,
      sha256: digest(bytes),
      warnings: [],
    };
    expect(await artifactBytes(dir, a, { width: 600, height: 800 })).toEqual(
      Buffer.from(bytes),
    );
    await expect(
      artifactBytes(dir, { ...a, path: "../outside.pdf" }, a),
    ).rejects.toThrow();
    await expect(
      artifactBytes(dir, { ...a, sha256: "bad" }, a),
    ).rejects.toThrow();
    await writeFile(join(dir, "page.pdf"), await pdf(2));
    await expect(
      artifactBytes(
        dir,
        { ...a, sha256: digest(await readFile(join(dir, "page.pdf"))) },
        a,
      ),
    ).rejects.toThrow();
    const outside = await root();
    await writeFile(join(outside, "secret.pdf"), bytes);
    await symlink(join(outside, "secret.pdf"), join(dir, "link.pdf"));
    await expect(
      artifactBytes(dir, { ...a, path: "link.pdf" }, a),
    ).rejects.toThrow();
  });
  it("never overwrites existing translated files and reports write failures", async () => {
    const dir = await root();
    await writeFile(join(dir, "paper.zh-CN.pdf"), "existing");
    const output = await saveExclusive(
      join(dir, "paper.zh-CN.pdf"),
      Buffer.from("translation"),
    );
    expect(output).toBe(join(dir, "paper.zh-CN.1.pdf"));
    expect(await readFile(join(dir, "paper.zh-CN.pdf"), "utf8")).toBe(
      "existing",
    );
    await mkdir(join(dir, "directory.pdf"));
    await expect(
      saveExclusive(join(dir, "missing", "out.pdf"), Buffer.from("x")),
    ).rejects.toThrow();
  });
});
