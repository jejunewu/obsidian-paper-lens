import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFStream } from "pdf-lib";
import { isPaperLensAnnotation } from "./annotations";
import { digest } from "../translation/protocol";

// Hash the reachable PDF object graph, not its file serialization. Paper Lens
// annotations and their font are excluded; original annotations, content streams,
// images, fonts, page geometry and meaningful document metadata remain included.
export async function translationFingerprint(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const annotationFont = doc.catalog.get(PDFName.of("PaperLensFont"));
  doc.catalog.delete(PDFName.of("PaperLensFont"));
  doc.catalog.delete(PDFName.of("PaperLensFontHash"));
  for (const page of doc.getPages()) {
    const annotations = page.node.Annots();
    if (annotations) {
      const keep = doc.context.obj([]);
      for (let i = 0; i < annotations.size(); i++) {
        const item = annotations.lookup(i);
        if (!(item instanceof PDFDict) || !isPaperLensAnnotation(item)) keep.push(annotations.get(i));
      }
      if (keep.size()) page.node.set(PDFName.of("Annots"), keep);
      else page.node.delete(PDFName.of("Annots"));
    }
    const resources = page.node.Resources();
    const fonts = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (annotationFont && fonts?.get(PDFName.of("PaperLensText")) === annotationFont)
      fonts.delete(PDFName.of("PaperLensText"));
    // pdf-lib may materialize empty resource categories when adding a font.
    for (const category of ["Font", "XObject", "ExtGState"]) {
      const key = PDFName.of(category);
      const value = resources?.lookupMaybe(key, PDFDict);
      if (value && !value.keys().length) resources!.delete(key);
    }
  }
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    // These fields are rewritten by annotation saves, without changing the paper.
    for (const key of ["Creator", "Producer", "CreationDate", "ModDate"])
      info.delete(PDFName.of(key));
  }
  const seen = new Map<PDFObject, number>();
  function canonical(input: PDFObject): unknown {
    const value = doc.context.lookup(input);
    if (!value) throw new Error("PDF 包含无效对象引用");
    if (!(value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream))
      return value.toString();
    const prior = seen.get(value);
    if (prior !== undefined) return ["ref", prior];
    seen.set(value, seen.size);
    if (value instanceof PDFArray)
      return ["array", value.asArray().map(canonical)];
    const dict = value instanceof PDFStream ? value.dict : value;
    const entries = dict.entries().filter(([key]) => !(value instanceof PDFStream && key === PDFName.of("Length")))
      .sort(([a], [b]) => a.toString().localeCompare(b.toString()))
      .map(([key, item]) => [key.toString(), canonical(item)]);
    return value instanceof PDFStream ? ["stream", entries, digest(value.getContents())] : ["dict", entries];
  }
  return digest(Buffer.from(JSON.stringify([canonical(doc.catalog),
    info instanceof PDFDict && info.keys().length ? canonical(info) : null])));
}
