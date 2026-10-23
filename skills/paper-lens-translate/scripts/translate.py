"""Positioned translation and atomic page delivery. Translation is supplied by the Agent."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile

import pymupdf as fitz
from paragraphs import extract_units, safe_frame, plan, draw


def sha(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".paper-lens-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_json(path, value):
    atomic(path, json.dumps(value, ensure_ascii=False, indent=2).encode())


def read_json(path):
    return json.loads(path.read_text())


def protected(span):
    text = span["text"].strip()
    font = span["font"].lower()
    return (not text or bool(re.search(r"symbol|math|cmmi|cmsy|cmex|msam|msbm|courier|mono", font))
            or not re.search(r"[A-Za-z]{2,}", text)
            or bool(re.fullmatch(r"\[?[\d,\s–\-]+\]?", text)))


def text_rotation(direction):
    angle = math.degrees(math.atan2(-direction[1], direction[0])) % 360
    rotation = (round(angle / 90) * 90) % 360
    if abs((angle - rotation + 180) % 360 - 180) > 0.1:
        raise ValueError("倾斜文字暂不支持原位翻译，请使用水平或 90° 倍数的文字方向")
    return rotation


def extract(job, root):
    data = Path(job["sourcePath"]).read_bytes()
    if sha(data) != job["sourceHash"]:
        raise ValueError("Source snapshot hash mismatch")
    doc = fitz.open(stream=data, filetype="pdf")
    if doc.needs_pass or len(doc) != job["pageCount"]:
        raise ValueError("Encrypted PDF or mismatched page count")
    pages = []
    for number, page in enumerate(doc, 1):
        error = None
        if not page.get_text().strip():
            error = "本页没有可选文字；暂不支持扫描页 OCR"
        units, keep, layout_error = extract_units(page, number, protected)
        error = error or layout_error
        if any((fitz.Rect(unit['bbox']) + (0.1, 0.1, -0.1, -0.1)).intersects(fitz.Rect(item['bbox']))
               for unit in units for item in keep if item['text'].strip()):
            error = error or "本页存在跨行/跨块公式与正文交叠，暂无法安全重排；保留原文，继续翻译其他页"
        warnings = []
        pages.append({"page": number, "width": page.rect.width, "height": page.rect.height,
                      "units": units, "protected": keep, "text": page.get_text(sort=True), "warnings": warnings,
                      "error": error})
    write_json(root / "layout.json", {"version": 1, "extractionVersion": 3, "sourceHash": job["sourceHash"], "pages": pages})
    print(f"Extracted {len(pages)} pages. Translate all positioned units using adjacent context.")


def manifest(job, root):
    path = root / "manifest.json"
    if path.exists():
        value = read_json(path)
        if value["jobId"] != job["id"] or value["sourceHash"] != job["sourceHash"]:
            raise ValueError("Manifest identity mismatch")
        return value
    return {"version": 1, "jobId": job["id"], "sourceHash": job["sourceHash"], "status": "running",
            "pages": [{"page": n, "status": "pending"} for n in range(1, job["pageCount"] + 1)]}


def one_page(job, number):
    source = fitz.open(job["sourcePath"])
    doc = fitz.open()
    doc.insert_pdf(source, from_page=number - 1, to_page=number - 1)
    return doc


def render(job, root, number):
    layout = read_json(root / "layout.json")
    if layout["sourceHash"] != job["sourceHash"]:
        raise ValueError("Stale page layout")
    page_data = layout["pages"][number - 1]
    if page_data.get("error"):
        raise ValueError(page_data["error"])
    translations = read_json(root / "translations" / f"{number}.json")
    missing = [u["id"] for u in page_data["units"] if not isinstance(translations.get(u["id"]), str) or not translations[u["id"]].strip()]
    if missing:
        raise ValueError(f"Missing translations: {missing}")
    doc = one_page(job, number)
    page = doc[0]
    font_path = Path(job["fontPath"])
    font = fitz.Font(fontfile=str(font_path))
    if not font.has_glyph(ord("中")):
        raise ValueError("Chinese font missing required glyphs")
    fixed = [p["bbox"] for p in page_data["protected"] if p["text"].strip()]
    fixed += [image["bbox"] for image in page.get_image_info()]
    fixed += [list(fitz.Rect(item["rect"]) + (-0.5, -0.5, 0.5, 0.5)) for item in page.get_drawings()]
    layouts = []
    reserved = []
    for unit in page_data["units"]:
        if any((fitz.Rect(unit["bbox"]) + (0.1, 0.1, -0.1, -0.1)).intersects(fitz.Rect(p["bbox"]))
               for p in page_data["protected"] if p["text"].strip()):
            raise ValueError(f"Separate protected glyphs inside {unit['id']}; cannot safely reflow this formula/prose mixture")
        obstacles = fixed + reserved + [u["bbox"] for u in page_data["units"] if u["id"] != unit["id"]]
        layout = plan(unit, translations[unit["id"]].strip(), font, safe_frame(unit, page, obstacles))
        layouts.append(layout)
        reserved.append(layout["bbox"])
    # Redact only original glyph areas; leave figures and separate equations intact.
    for unit in page_data["units"]:
        for span in unit["spans"]:
            box = fitz.Rect(span["bbox"]) + (0.1, 0.1, -0.1, -0.1)
            if any(box.intersects(fitz.Rect(p["bbox"])) for p in page_data["protected"] if p["text"].strip()):
                raise ValueError(f"Protected formula overlaps {unit['id']}; cannot safely redact this paragraph")
            page.add_redact_annot(box, fill=False, cross_out=False)
    page.apply_redactions(images=0, graphics=0, text=0)
    page.insert_font(fontname="PLChinese", fontfile=str(font_path))
    report = {"page": number, "units": [], "warnings": page_data["warnings"]}
    with fitz.open(job["sourcePath"]) as source:
        for unit, layout in zip(page_data["units"], layouts):
            draw(page, unit, layout, source, number - 1)
            report["units"].append({"id": unit["id"], "fontSize": layout["fontSize"], "bbox": layout["bbox"],
                                    "sourceBbox": unit["bbox"], "rotation": unit["rotation"], "align": unit["align"],
                                    "lineCount": len(layout["lines"]), "sourceLineCount": unit["lineCount"]})
    # Ensure protected symbols survived as text (do not rely on a successful write).
    output_text = page.get_text()
    for item in page_data["protected"]:
        if item["text"].strip() and item["text"].strip() not in output_text:
            raise ValueError(f"Protected text missing: {item['text']}")
    data = doc.tobytes(garbage=4, deflate=True)
    atomic(root / "drafts" / f"{number}.pdf", data)
    # Serialization rewrites font/object references. Render the delivered bytes,
    # rather than the stale page object, so visual review matches the artifact.
    with fitz.open(stream=data, filetype="pdf") as delivered:
        atomic(root / "previews" / f"{number}.png", delivered[0].get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).tobytes("png"))
    write_json(root / "reports" / f"{number}.json", report)
    print(f"Rendered page {number}. Visually review previews/{number}.png before publishing.")


def publish(job, root, number, warnings):
    data = (root / "drafts" / f"{number}.pdf").read_bytes()
    doc = fitz.open(stream=data, filetype="pdf")
    size = job["sizes"][number - 1]
    if len(doc) != 1 or abs(doc[0].rect.width - size["width"]) > 0.5 or abs(doc[0].rect.height - size["height"]) > 0.5:
        raise ValueError("Page geometry mismatch")
    report = read_json(root / "reports" / f"{number}.json")
    relative = f"pages/{number}.pdf"
    atomic(root / relative, data)
    m = manifest(job, root)
    m["status"] = "running"
    m["pages"][number - 1] = {"page": number, "status": "completed", "artifact": {
        "page": number, "path": relative, "width": size["width"], "height": size["height"],
        "sha256": sha(data), "warnings": report["warnings"] + warnings}}
    m.pop("final", None)
    write_json(root / "manifest.json", m)
    print(f"Published page {number}")


def merge(job, root):
    m = manifest(job, root)
    if len(m["pages"]) != job["pageCount"] or any(p["status"] != "completed" for p in m["pages"]):
        raise ValueError("Cannot merge: some pages are incomplete")
    doc = fitz.open()
    for number, entry in enumerate(m["pages"], 1):
        artifact = entry["artifact"]
        if entry["page"] != number or artifact["page"] != number:
            raise ValueError("Invalid page sequence")
        path = (root / artifact["path"]).resolve()
        if not path.is_relative_to(root.resolve()):
            raise ValueError("Page path escapes job")
        data = path.read_bytes()
        page = fitz.open(stream=data, filetype="pdf")
        size = job["sizes"][number - 1]
        if sha(data) != artifact["sha256"] or len(page) != 1 or abs(page[0].rect.width - size["width"]) > 0.5 or abs(page[0].rect.height - size["height"]) > 0.5:
            raise ValueError(f"Invalid artifact for page {number}")
        doc.insert_pdf(page)
    data = doc.tobytes(garbage=4, deflate=True)
    if len(fitz.open(stream=data, filetype="pdf")) != job["pageCount"]:
        raise ValueError("Final page count mismatch")
    atomic(root / "final.zh-CN.pdf", data)
    m["status"] = "completed"
    m["final"] = {"path": "final.zh-CN.pdf", "sha256": sha(data)}
    write_json(root / "manifest.json", m)
    print("Validated merged translation published")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["extract", "render", "preview", "publish", "fail", "merge"])
    parser.add_argument("--job", required=True)
    parser.add_argument("--page", type=int)
    parser.add_argument("--reviewed", action="store_true")
    parser.add_argument("--warning", action="append", default=[])
    parser.add_argument("--reason", default="Page could not meet layout or translation checks")
    args = parser.parse_args()
    job = read_json(Path(args.job))
    root = Path(job["outputDir"])
    if (root / "cancelled").exists():
        raise ValueError("Job cancelled; stop execution")
    if args.command not in ["extract", "merge"] and (not args.page or not 1 <= args.page <= job["pageCount"]):
        parser.error("--page must be a valid source page number")
    if args.command == "extract":
        extract(job, root)
    elif args.command == "render":
        render(job, root, args.page)
    elif args.command == "preview":
        doc = one_page(job, args.page)
        atomic(root / "previews" / f"source-{args.page}.png", doc[0].get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).tobytes("png"))
    elif args.command == "publish":
        if not args.reviewed:
            parser.error("Publish requires visual review and --reviewed")
        publish(job, root, args.page, args.warning)
    elif args.command == "fail":
        m = manifest(job, root)
        m["status"] = "failed"
        m["pages"][args.page - 1] = {"page": args.page, "status": "failed", "error": args.reason}
        write_json(root / "manifest.json", m)
    else:
        merge(job, root)


if __name__ == "__main__":
    main()
