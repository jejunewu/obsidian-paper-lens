"""Paper Lens protocol adapter; translation and layout are upstream implementations.

Credentials arrive through stdin and are never written to settings or job files.
Imports are deferred so publishing/validation can be tested without the ML runtime.
"""
import asyncio
import hashlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import sys
import time
import uuid

PREFIX = "PAPER_LENS_EVENT "
SECRET = ""


def clean(value):
    text = str(value)
    return text.replace(SECRET, "[REDACTED]") if SECRET else text


def emit(event):
    print(PREFIX + clean(json.dumps(event, ensure_ascii=False)), flush=True)


def atomic_json(path, value):
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, path)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def publish(job, output):
    import pymupdf
    folder = Path(job["outputDir"])
    output = Path(output).resolve(strict=True)
    if not output.is_relative_to(folder.resolve()):
        raise ValueError("Engine output is outside the job directory")
    if sha(Path(job["sourcePath"]).read_bytes()) != job["sourceHash"]:
        raise ValueError("Source snapshot hash mismatch")
    data = output.read_bytes()
    pages = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        if len(doc) != job["pageCount"]:
            raise ValueError("Translated PDF page count mismatch")
        # Validate every page before publishing any completed manifest.
        for i, page in enumerate(doc):
            expected = job["sizes"][i]
            actual = page.mediabox
            if abs(actual.width - expected["width"]) > 0.5 or abs(actual.height - expected["height"]) > 0.5:
                raise ValueError(f"Translated PDF page {i + 1} size mismatch")
        for i, page in enumerate(doc):
            name = f"page-{i + 1:04d}.pdf"
            with pymupdf.open() as single:
                single.insert_pdf(doc, from_page=i, to_page=i)
                page_data = single.tobytes(garbage=4, deflate=True)
            (folder / name).write_bytes(page_data)
            pages.append({"page": i + 1, "status": "completed", "artifact": {
                "page": i + 1, "path": name, "sha256": sha(page_data),
                **job["sizes"][i], "warnings": [],
            }})
    (folder / "final.pdf").write_bytes(data)
    atomic_json(folder / "manifest.json", {
        "version": 1, "jobId": job["id"], "sourceHash": job["sourceHash"],
        "status": "completed", "pages": pages,
        "final": {"path": "final.pdf", "sha256": sha(data)},
    })


class EngineLog(logging.Handler):
    def __init__(self):
        super().__init__(logging.WARNING)
        self.paragraph_errors = []

    def emit(self, record):
        message = clean(record.getMessage())
        # BabelDOC otherwise logs paragraph failures and still emits a finished PDF.
        if "il_translator" in record.name and (
            record.levelno >= logging.ERROR or "ContentFilterError" in message
        ):
            self.paragraph_errors.append(message[:1000])
        if record.levelno >= logging.WARNING:
            emit({"type": "status", "text": message[:1000]})


def verified_vector_text_pdf(source):
    """Only bypass image-similarity heuristics for visibly native, image-free PDFs.

    Removing sparse text changes too few pixels for BabelDOC's 0.95 SSIM cutoff.
    Images (including inline images) and invisible OCR layers keep upstream checks.
    """
    import pymupdf
    with pymupdf.open(source) as doc:
        if not len(doc):
            return False
        for page in doc:
            if page.get_image_info():
                return False
            visible = sum(
                1 for span in page.get_texttrace()
                if span.get("type") in (0, 1) and span.get("opacity", 1) > 0
                for char in span.get("chars", ())
                if 0 <= char[0] <= 0x10FFFF and chr(char[0]).isalnum()
            )
            if visible < 20:
                return False
    return True


def engine_settings(api, output, skip_scanned_detection=False):
    return {
        "basic": {},
        "translation": {
            "lang_in": "en", "lang_out": "zh", "output": str(output),
            "qps": api["concurrency"], "pool_max_workers": api["concurrency"],
            # Upstream's shared cache does not include provider URL in its key.
            "ignore_cache": True,
            "no_auto_extract_glossary": not api["autoGlossary"],
            "save_auto_extracted_glossary": api["autoGlossary"],
        },
        "pdf": {"no_dual": True, "watermark_output_mode": "no_watermark",
                "skip_scanned_detection": skip_scanned_detection,
                "translate_table_text": True},
        "translate_engine_settings": {
            "translate_engine_type": "OpenAI", "openai_model": api["model"],
            "openai_base_url": api["baseUrl"], "openai_api_key": api["apiKey"],
            "openai_timeout": str(api["timeout"]), "openai_enable_json_mode": False,
            "openai_send_temprature": False,
            "openai_reasoning_effort": api.get("effort") or None,
            "openai_send_reasoning_effort": bool(api.get("effort")),
        },
    }


async def translate(job, api):
    started = time.monotonic()
    emit({"type": "status", "text": "正在加载本地识别模型；首次运行会下载模型和字体…"})
    from pdf2zh_next.config.model import SettingsModel
    from pdf2zh_next.high_level import create_babeldoc_config
    from babeldoc.format.pdf.high_level import async_translate
    handler = EngineLog()
    logging.basicConfig(level=logging.WARNING, handlers=[handler], force=True)
    for name in ("openai", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    output = Path(job["outputDir"]) / "engine-output"
    output.mkdir(exist_ok=True)
    native_text = verified_vector_text_pdf(job["sourcePath"])
    if native_text:
        emit({"type": "status", "text": "已确认 PDF 包含可见原生文字，继续翻译…"})
    settings = SettingsModel.model_validate(engine_settings(api, output, native_text))
    settings.validate_settings()
    # The bridge already runs in a dedicated process. Running the upstream core
    # here avoids a second Python spawn and keeps paragraph error logs observable.
    config = create_babeldoc_config(settings, Path(job["sourcePath"]))
    result = None
    async for event in async_translate(config):
        kind = event.get("type")
        if kind in ("progress_start", "progress_update", "progress_end"):
            emit({"type": "progress", "stage": event.get("stage", ""),
                  "percent": event.get("overall_progress", 0),
                  "current": event.get("stage_current", 0), "total": event.get("stage_total", 0)})
        elif kind == "error":
            error = clean(event.get("error", "Translation engine error"))
            if "Scanned PDF" in error:
                error = "检测到扫描 PDF 或图片文字，当前翻译引擎需要原生可提取文字；请先对扫描页进行 OCR。"
            raise RuntimeError(error)
        elif kind == "finish":
            result = event.get("translate_result")
            # BabelDOC's progress iterator does not close itself after finish.
            break
    if result is None or not getattr(result, "mono_pdf_path", None):
        raise RuntimeError("Engine exited without a finished translated PDF")
    if handler.paragraph_errors:
        raise RuntimeError(f"{len(handler.paragraph_errors)} paragraph translations failed; incomplete PDF was not published: "
                           + handler.paragraph_errors[0])
    emit({"type": "status", "text": "正在校验并生成逐页译文…"})
    publish(job, result.mono_pdf_path)
    emit({"type": "status", "text": f"引擎总耗时 {time.monotonic() - started:.1f} 秒"})
    emit({"type": "done"})


def main():
    global SECRET
    if sys.argv[1:] == ["--check"]:
        expected = {"pdf2zh-next": "2.9.0", "babeldoc": "0.6.2", "pymupdf": "1.25.2",
                    "bitstring": "4.3.1", "onnxruntime": "1.31.0"}
        for name, version in expected.items():
            if importlib.metadata.version(name) != version:
                raise RuntimeError(f"Incompatible dependency: {name}")
        # Catch the known BitStream import break without loading the ML model.
        from bitstring import BitStream
        import pymupdf
        print("Paper Lens PDFMathTranslate runtime ready", flush=True)
        return
    payload = json.load(sys.stdin)
    api = payload["api"]
    SECRET = api["apiKey"]
    job = json.loads(Path(payload["jobPath"]).read_text(encoding="utf-8"))
    try:
        asyncio.run(translate(job, api))
    except Exception as error:
        emit({"type": "error", "text": clean(error)[:2500]})
        sys.exit(1)


if __name__ == "__main__":
    main()
