"""Positioned translation and atomic page delivery. Translation is supplied by the Agent."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

import pymupdf as fitz


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


def extract(job, root):
    data = Path(job["sourcePath"]).read_bytes()
    if sha(data) != job["sourceHash"]:
        raise ValueError("Source snapshot hash mismatch")
    doc = fitz.open(stream=data, filetype="pdf")
    if doc.needs_pass or len(doc) != job["pageCount"]:
        raise ValueError("Encrypted PDF or mismatched page count")
    pages = []
    for number, page in enumerate(doc, 1):
        if not page.get_text().strip():
            raise ValueError(f"Page {number} has no selectable text; OCR is not supported")
        units, keep, warnings = [], [], []
        for block in page.get_text("dict", sort=True)["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    if protected(span):
                        keep.append({"text": span["text"], "bbox": span["bbox"]})
                    else:
                        if tuple(line["dir"]) != (1.0, 0.0):
                            raise ValueError(f"Page {number}: rotated prose is not supported")
                        units.append({"id": f"p{number}-u{len(units)+1}", "text": span["text"],
                                      "bbox": span["bbox"], "size": span["size"], "font": span["font"],
                                      "color": span["color"]})
        pages.append({"page": number, "width": page.rect.width, "height": page.rect.height,
                      "units": units, "protected": keep, "text": page.get_text(sort=True), "warnings": warnings})
    write_json(root / "layout.json", {"version": 1, "sourceHash": job["sourceHash"], "pages": pages})
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
    translations = read_json(root / "translations" / f"{number}.json")
    missing = [u["id"] for u in page_data["units"] if not isinstance(translations.get(u["id"]), str) or not translations[u["id"]].strip()]
    if missing:
        raise ValueError(f"Missing translations: {missing}")
    doc = one_page(job, number)
    page = doc[0]
    # Shrink span redactions to avoid adjacent formula glyphs being removed by intersection.
    for unit in page_data["units"]:
        box = fitz.Rect(unit["bbox"])
        box.x0 += 0.1
        box.x1 -= 0.1
        box.y0 += 0.1
        box.y1 -= 0.1
        if any(box.intersects(fitz.Rect(p["bbox"])) for p in page_data["protected"] if p["text"].strip()):
            raise ValueError(f"Protected formula overlaps {unit['id']}; cannot safely redact this span")
        page.add_redact_annot(box, fill=False, cross_out=False)
    page.apply_redactions(images=0, graphics=0, text=0)
    font_path = Path(job["fontPath"])
    font = fitz.Font(fontfile=str(font_path))
    if not font.has_glyph(ord("中")):
        raise ValueError("Chinese font missing required glyphs")
    page.insert_font(fontname="PLChinese", fontfile=str(font_path))
    report = {"page": number, "units": [], "warnings": page_data["warnings"]}
    for unit in page_data["units"]:
        text = translations[unit["id"]].strip()
        if any(not font.has_glyph(ord(ch)) for ch in text if not ch.isspace()):
            raise ValueError(f"Missing font glyph in {unit['id']}")
        box = fitz.Rect(unit["bbox"])
        size = min(unit["size"], (box.height / 1.2), 14)
        minimum = min(7, unit["size"] * 0.75)
        while size >= minimum and font.text_length(text, fontsize=size) > box.width:
            size -= 0.25
        if size < minimum or "\n" in text:
            raise ValueError(f"Translation overflow in {unit['id']}: shorten accurately to fit original line")
        color = tuple(((unit["color"] >> shift) & 255) / 255 for shift in (16, 8, 0))
        page.insert_text((box.x0, box.y0 + size), text, fontsize=size, fontname="PLChinese", color=color)
        report["units"].append({"id": unit["id"], "fontSize": size, "bbox": list(box)})
    # Ensure protected symbols survived as text (do not rely on a successful write).
    output_text = page.get_text()
    for item in page_data["protected"]:
        if item["text"].strip() and item["text"].strip() not in output_text:
            raise ValueError(f"Protected text missing: {item['text']}")
    atomic(root / "drafts" / f"{number}.pdf", doc.tobytes(garbage=4, deflate=True))
    atomic(root / "previews" / f"{number}.png", page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).tobytes("png"))
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
