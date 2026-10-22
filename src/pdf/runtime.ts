import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import type * as PdfJs from "pdfjs-dist";
let loaded: Promise<typeof PdfJs> | undefined;
export function disposePdfRuntime(): void {
  const current = loaded;
  loaded = undefined;
  if (current)
    void current
      .then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerPort?.terminate();
        pdfjs.GlobalWorkerOptions.workerPort = null;
      })
      .catch(() => {});
}
export function pdfRuntime(resourceRoot: string): Promise<typeof PdfJs> {
  loaded ??= Promise.resolve().then(() => {
    const pdfjs = require(`${resourceRoot}/pdfjs/pdf.cjs`) as typeof PdfJs;
    const url = URL.createObjectURL(
      new Blob([readFileSync(`${resourceRoot}/pdfjs/worker.js`, "utf8")], {
        type: "text/javascript",
      }),
    );
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(url);
    URL.revokeObjectURL(url);
    return pdfjs;
  });
  return loaded;
}
export async function openPdf(
  bytes: Uint8Array,
  root: string,
): Promise<PdfJs.PDFDocumentProxy> {
  const pdfjs = await pdfRuntime(root);
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: pathToFileURL(`${root}/pdfjs/cmaps/`).href,
    cMapPacked: true,
    standardFontDataUrl: pathToFileURL(`${root}/pdfjs/standard_fonts/`).href,
    isEvalSupported: false,
  }).promise;
}
