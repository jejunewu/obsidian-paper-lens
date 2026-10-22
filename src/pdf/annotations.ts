import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  PDFFont,
  PDFRef,
  CustomFontEmbedder,
  rgb,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Annotation } from "../core/types";
import { digest } from "../translation/protocol";

function owned(dict: PDFDict): boolean {
  const name = dict.get(PDFName.of("NM"));
  return (
    (name instanceof PDFString || name instanceof PDFHexString) &&
    name.decodeText().startsWith("paper-lens:")
  );
}
export async function readAnnotations(
  bytes: Uint8Array,
): Promise<Annotation[]> {
  const doc = await PDFDocument.load(bytes);
  const items: Annotation[] = [];
  doc.getPages().forEach((page) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i);
      if (!(dict instanceof PDFDict) || !owned(dict)) continue;
      const data = dict.get(PDFName.of("PaperLensData"));
      if (data instanceof PDFHexString || data instanceof PDFString) {
        try {
          const item = JSON.parse(data.decodeText()) as Annotation;
          if (item.id && item.rects?.length) items.push(item);
        } catch {
          /* Leave unknown annotations intact. */
        }
      }
    }
  });
  return items;
}
export async function withoutPaperLensAnnotations(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  for (const page of doc.getPages()) {
    const old = page.node.Annots();
    if (!old) continue;
    const keep = doc.context.obj([]);
    for (let i = 0; i < old.size(); i++) {
      const dict = old.lookup(i);
      if (!(dict instanceof PDFDict) || !owned(dict)) keep.push(old.get(i));
    }
    page.node.set(PDFName.of("Annots"), keep);
  }
  return doc.save();
}
export async function writeAnnotations(
  bytes: Uint8Array,
  items: Annotation[],
  fontBytes: Uint8Array,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  doc.registerFontkit(fontkit);
  // Embed the complete OpenType font: fontkit's CFF subset is not portable across PDF readers.
  let font: PDFFont | undefined;
  if (items.some((x) => x.kind === "text")) {
    const existing = doc.catalog.get(PDFName.of("PaperLensFont"));
    const hash = doc.catalog.get(PDFName.of("PaperLensFontHash"));
    if (
      existing instanceof PDFRef &&
      hash instanceof PDFString &&
      hash.decodeText() === digest(fontBytes)
    ) {
      font = PDFFont.of(
        existing,
        doc,
        await CustomFontEmbedder.for(fontkit, fontBytes),
      );
    } else {
      font = await doc.embedFont(fontBytes, { subset: false });
      doc.catalog.set(PDFName.of("PaperLensFont"), font.ref);
      doc.catalog.set(
        PDFName.of("PaperLensFontHash"),
        PDFString.of(digest(fontBytes)),
      );
    }
  }
  for (const page of doc.getPages()) {
    const old = page.node.Annots(),
      keep = doc.context.obj([]);
    if (old)
      for (let i = 0; i < old.size(); i++) {
        const dict = old.lookup(i);
        if (!(dict instanceof PDFDict) || !owned(dict)) keep.push(old.get(i));
      }
    page.node.set(PDFName.of("Annots"), keep);
  }
  for (const item of items) {
    const page = doc.getPages()[item.page - 1];
    if (!page) throw new Error("批注页码超出范围");
    const xs = item.rects.flatMap((r) => [r[0], r[2]]),
      ys = item.rects.flatMap((r) => [r[1], r[3]]);
    const rect = [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];
    const width = Math.max(1, rect[2]! - rect[0]!),
      height = Math.max(1, rect[3]! - rect[1]!);
    const common = {
      Type: "Annot",
      Subtype: item.kind === "highlight" ? "Highlight" : "FreeText",
      Rect: rect,
      NM: PDFString.of(`paper-lens:${item.id}`),
      Contents: PDFHexString.fromText(item.text),
      T: PDFHexString.fromText("Paper Lens"),
      F: 4,
      C: item.color,
      PaperLensData: PDFHexString.fromText(JSON.stringify(item)),
    };
    let appearance;
    if (item.kind === "highlight") {
      const commands = item.rects
        .map(
          (r) =>
            `${r[0] - rect[0]!} ${r[1] - rect[1]!} ${r[2] - r[0]} ${r[3] - r[1]} re f`,
        )
        .join("\n");
      appearance = doc.context.register(
        doc.context.flateStream(
          `q /GS gs ${item.color.join(" ")} rg ${commands} Q`,
          {
            Type: "XObject",
            Subtype: "Form",
            BBox: [0, 0, width, height],
            Resources: {
              ExtGState: {
                GS: { Type: "ExtGState", ca: 0.32, BM: "Multiply" },
              },
            },
          },
        ),
      );
    } else if (font) {
      const temp = doc.addPage([width, height]);
      const lines: string[] = [];
      let line = "";
      const size = Math.min(12, height - 4);
      for (const ch of item.text) {
        if (
          ch === "\n" ||
          font.widthOfTextAtSize(line + ch, size) > width - 8
        ) {
          lines.push(line);
          line = ch === "\n" ? "" : ch;
        } else line += ch;
      }
      lines.push(line);
      if (lines.length * size * 1.25 > height - 4)
        throw new Error("文字批注超出区域，请扩大批注或缩短文字");
      temp.drawText(lines.join("\n"), {
        x: 4,
        y: height - size - 2,
        font,
        size,
        lineHeight: size * 1.25,
        color: rgb(0.1, 0.1, 0.1),
      });
      const embedded = await doc.embedPage(temp);
      await embedded.embed();
      appearance = embedded.ref;
      doc.removePage(doc.getPageCount() - 1);
    }
    const extra =
      item.kind === "highlight"
        ? {
            QuadPoints: item.rects.flatMap((r) => [
              r[0],
              r[3],
              r[2],
              r[3],
              r[0],
              r[1],
              r[2],
              r[1],
            ]),
          }
        : { DA: PDFString.of("/F0 12 Tf 0.1 0.1 0.1 rg"), Q: 0 };
    const dict = doc.context.obj({
      ...common,
      ...extra,
      AP: { N: appearance },
    });
    page.node.Annots()!.push(doc.context.register(dict));
  }
  return doc.save();
}
