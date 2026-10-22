export type AgentKind = "codex" | "claude";
export type Rect = [number, number, number, number];
export interface Annotation {
  id: string;
  page: number;
  kind: "highlight" | "text";
  rects: Rect[];
  text: string;
  color: [number, number, number];
}
export interface PageSize {
  width: number;
  height: number;
}
export interface PaperContext {
  documentId: string;
  title: string;
  pages: string[];
  currentPage: number;
  selection: string;
}
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}
export interface ChatSession {
  id?: string;
  messages: ChatMessage[];
}
export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "status"; text: string }
  | { type: "session"; id: string }
  | {
      type: "permission";
      title: string;
      detail: string;
      respond: (allow: boolean) => void;
    }
  | { type: "done" | "cancelled" }
  | { type: "error"; text: string };
export interface AgentTask {
  cwd: string;
  prompt: string;
  sessionId?: string;
  skillPath?: string;
  model?: string;
}
export interface AgentRun {
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
  fontPath: string;
}
