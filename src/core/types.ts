export type Rect = [number, number, number, number];
export interface Annotation {
  id: string;
  page: number;
  kind: "highlight" | "text";
  rects: Rect[];
  text: string;
  color: [number, number, number];
  fontSize?: number;
}
export interface PageSize {
  width: number;
  height: number;
}
export type TranslationEvent =
  | { type: "status"; text: string }
  | { type: "progress"; stage: string; percent: number; current: number; total: number }
  | { type: "done" | "cancelled" }
  | { type: "error"; text: string };
export interface TranslationRun {
  done: Promise<void>;
  cancel: () => void;
}
export type PageState = "pending" | "running" | "completed" | "failed";
export interface PageArtifact extends PageSize {
  page: number;
  path: string;
  sha256: string;
  warnings: string[];
}
export interface JobManifest {
  version: 1;
  jobId: string;
  sourceHash: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  pages: {
    page: number;
    status: PageState;
    artifact?: PageArtifact;
    error?: string;
  }[];
  final?: { path: string; sha256: string };
  error?: string;
}
export interface TranslationJob {
  version: 1;
  id: string;
  documentId: string;
  sourceHash: string;
  sourcePath: string;
  pageCount: number;
  sizes: PageSize[];
  sourceLanguage: "en";
  targetLanguage: "zh-CN";
  outputDir: string;
  toolDir: string;
}
