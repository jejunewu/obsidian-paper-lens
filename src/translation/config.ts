import { homedir } from "node:os";
import { join } from "node:path";

export interface PaperLensSettings {
  apiBaseUrl: string;
  apiModel: string;
  apiKeySecret: string;
  apiTimeout: number;
  translationConcurrency: number;
  reasoningEffort: string;
  autoGlossary: boolean;
  workDir: string;
}
export interface ModelApiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeout: number;
  concurrency: number;
  effort: string;
  autoGlossary: boolean;
}
export const DEFAULT_SETTINGS: PaperLensSettings = {
  apiBaseUrl: "https://api.openai.com/v1", apiModel: "", apiKeySecret: "paper-lens-api-key",
  apiTimeout: 60, translationConcurrency: 4, reasoningEffort: "", autoGlossary: false,
  workDir: join(homedir(), "Library/Application Support/Paper Lens"),
};
export function normalizeSettings(raw: unknown): PaperLensSettings {
  const old = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of ["apiBaseUrl", "apiModel", "apiKeySecret", "reasoningEffort", "workDir"] as const)
    if (typeof old[key] === "string") settings[key] = old[key].trim() || DEFAULT_SETTINGS[key];
  if (!/^[a-z0-9-]+$/.test(settings.apiKeySecret)) settings.apiKeySecret = DEFAULT_SETTINGS.apiKeySecret;
  if (!["", "minimal", "low", "medium", "high"].includes(settings.reasoningEffort)) settings.reasoningEffort = "";
  if (typeof old.apiTimeout === "number" && Number.isFinite(old.apiTimeout) && old.apiTimeout > 0)
    settings.apiTimeout = Math.max(10, Math.min(600, Math.round(old.apiTimeout)));
  if (typeof old.translationConcurrency === "number" && Number.isFinite(old.translationConcurrency))
    settings.translationConcurrency = Math.max(1, Math.min(4, Math.round(old.translationConcurrency)));
  if (typeof old.autoGlossary === "boolean") settings.autoGlossary = old.autoGlossary;
  return settings;
}
