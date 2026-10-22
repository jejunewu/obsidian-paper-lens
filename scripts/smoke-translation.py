"""Run with the bootstrapped Python; creates synthetic PDF fixtures, not user data."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import pymupdf as fitz

root = Path(tempfile.mkdtemp(prefix="paper-lens-layout-"))
repo = Path(__file__).resolve().parent.parent
tool = repo / "skills/paper-lens-translate/scripts/translate.py"
doc = fitz.open()
for i in range(2):
    page = doc.new_page(width=600, height=800)
    page.insert_text((40, 60), "Attention in neural networks", fontsize=18)
    page.insert_text((40, 120), "The model represents relationships.", fontsize=12)
    page.insert_text((330, 120), "Results show improved accuracy.", fontsize=12)
    page.insert_text((40, 160), "x = y + 1", fontname="cour", fontsize=12)
    page.draw_rect(fitz.Rect(40, 240, 260, 360), color=(0, 0, 1))
    page.insert_text((40, 390), "Figure: Model architecture", fontsize=12)
source = root / "source.pdf"
doc.save(source)
job = {"version": 1, "id": "smoke", "documentId": "synthetic", "sourceHash": hashlib.sha256(source.read_bytes()).hexdigest(),
       "sourcePath": str(source), "pageCount": 2, "sizes": [{"width": 600, "height": 800}] * 2,
       "outputDir": str(root), "fontPath": str(repo / "assets/NotoSansCJKsc-Regular.otf")}
(root / "job.json").write_text(json.dumps(job))


def run(command, *args, success=True):
    result = subprocess.run([sys.executable, str(tool), command, "--job", str(root / "job.json"), *args], capture_output=True, text=True)
    if success and result.returncode:
        raise AssertionError(result.stderr)
    if not success and not result.returncode:
        raise AssertionError("Expected rejection")
    print(command, result.stdout.strip() or result.stderr.splitlines()[-1])


run("extract")
layout = json.loads((root / "layout.json").read_text())
mapping = {"Attention in neural networks": "神经网络中的注意力", "The model represents relationships.": "模型表示关系。",
           "Results show improved accuracy.": "结果显示准确率提高。", "Figure: Model architecture": "图：模型结构"}
(root / "translations").mkdir()
for page in layout["pages"]:
    number = page["page"]
    (root / "translations" / f"{number}.json").write_text(json.dumps({u["id"]: mapping[u["text"]] for u in page["units"]}))
    run("render", "--page", str(number))
    draft = fitz.open(root / "drafts" / f"{number}.pdf")
    expected_preview = draft[0].get_pixmap(matrix=fitz.Matrix(1.5, 1.5))
    actual_preview = fitz.Pixmap(root / "previews" / f"{number}.png")
    assert actual_preview.samples == expected_preview.samples, "Preview differs from the saved translation PDF"
    run("publish", "--page", str(number), success=False)
    run("publish", "--page", str(number), "--reviewed")
run("merge")
final = fitz.open(root / "final.zh-CN.pdf")
assert len(final) == 2
for page in final:
    assert "模型" in page.get_text() and "x = y + 1" in page.get_text()
    assert len(page.get_drawings()) == len(doc[0].get_drawings())
    assert page.rect == doc[0].rect
print(f"Translation smoke passed: {root}")
