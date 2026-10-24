import { join } from "node:path";
import type { TranslationEvent, TranslationRun, TranslationJob } from "../core/types";
import type { TranslationOptions } from "./manager";
import { runTool } from "./tools";
import { testConnection, validateApi } from "./api";

const preparing = new Map<string, Promise<void>>();
export function startTranslation(options: TranslationOptions, job: TranslationJob,
  emit: (event: TranslationEvent) => void): TranslationRun {
  const controller = new AbortController();
  const done = (async () => {
    try {
      const api = validateApi(options.api);
      emit({ type: "status", text: "正在验证模型 API…" });
      await testConnection(api, controller.signal);
      emit({ type: "status", text: "正在准备 PDFMathTranslate 本地运行环境…" });
      while (preparing.has(job.toolDir)) {
        await preparing.get(job.toolDir)!.catch(() => {});
        if (controller.signal.aborted) throw new Error("翻译已取消");
      }
      const setup = runTool("/bin/bash", [join(options.runtimePath, "bootstrap.sh"), job.toolDir],
        job.outputDir, process.env, controller.signal);
      preparing.set(job.toolDir, setup);
      try { await setup; }
      finally { if (preparing.get(job.toolDir) === setup) preparing.delete(job.toolDir); }
      let finished = false, failure = "";
      await runTool(join(job.toolDir, "venv/bin/python"), [join(options.runtimePath, "bridge.py")],
        job.outputDir, { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" },
        controller.signal, {
          input: JSON.stringify({ jobPath: join(job.outputDir, "job.json"), api }), secret: api.apiKey,
          line: (line) => {
            if (!line.startsWith("PAPER_LENS_EVENT ")) return;
            let event: TranslationEvent;
            try { event = JSON.parse(line.slice("PAPER_LENS_EVENT ".length)); }
            catch { failure = "翻译引擎返回了无效的进度数据"; return; }
            if (!event || typeof event !== "object") { failure = "翻译引擎返回了无效事件"; return; }
            if (event.type === "done") finished = true;
            else if (event.type === "error") failure = event.text;
            else if (event.type === "status" || event.type === "progress") emit(event);
          },
        }).catch((error) => { throw new Error(failure || String(error)); });
      if (failure || !finished) throw new Error(failure || "翻译引擎结束，但未返回完整 PDF");
      emit({ type: "done" });
    } catch (error) {
      if (!controller.signal.aborted) emit({ type: "error", text: String(error) });
    }
  })();
  return { done, cancel: () => controller.abort() };
}
