"""Run with Paper Lens's cached Python / PyMuPDF; uses synthetic PDF data only."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

import pymupdf as fitz

sys.dont_write_bytecode = True

repo = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("translate", repo / "skills/paper-lens-translate/scripts/translate.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class RotatedTranslationTest(unittest.TestCase):
    def test_cardinal_labels_keep_direction_and_bounds(self):
        with tempfile.TemporaryDirectory(prefix="paper-lens-rotation-") as directory:
            root = Path(directory)
            doc = fitz.open()
            for rotation in (0, 90, 180, 270):
                page = doc.new_page(width=400, height=400)
                page.insert_text((200, 200), "Output tokens (k)", fontsize=12, rotate=rotation)
                page.insert_text((40, 350), "x = y + 1", fontname="cour", fontsize=12)
                page.draw_rect(fitz.Rect(40, 260, 160, 300), color=(0, 0, 1))
            source = root / "source.pdf"
            doc.save(source)
            job = {"sourcePath": str(source), "sourceHash": tool.sha(source.read_bytes()), "pageCount": 4,
                   "fontPath": str(repo / "assets/NotoSansCJKsc-Regular.otf")}
            tool.extract(job, root)
            layout = tool.read_json(root / "layout.json")
            self.assertEqual(layout["extractionVersion"], 2)
            for number, data in enumerate(layout["pages"], 1):
                unit = data["units"][0]
                self.assertEqual(unit["rotation"], (number - 1) * 90)
                tool.write_json(root / "translations" / f"{number}.json", {unit["id"]: "输出词元（千）"})
                tool.render(job, root, number)
                with fitz.open(root / "drafts" / f"{number}.pdf") as draft:
                    page = draft[0]
                    self.assertEqual(page.rect, doc[number - 1].rect)
                    self.assertIn("输出词元", page.get_text())
                    self.assertNotIn("Output tokens", page.get_text())
                    self.assertIn("x = y + 1", page.get_text())
                    self.assertEqual(len(page.get_drawings()), 1)
                    lines = [line for block in page.get_text("dict")["blocks"] for line in block.get("lines", [])
                             if any("输出" in span["text"] for span in line["spans"])]
                    self.assertEqual(tool.text_rotation(lines[0]["dir"]), unit["rotation"])
                    box = fitz.Rect(unit["bbox"])
                    box += (-0.5, -0.5, 0.5, 0.5)
                    self.assertTrue(box.contains(fitz.Rect(lines[0]["bbox"])))
                    preview = fitz.Pixmap(root / "previews" / f"{number}.png")
                    self.assertEqual(preview.samples, page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).samples)

    def test_skewed_text_fails_only_its_page(self):
        with tempfile.TemporaryDirectory(prefix="paper-lens-skew-") as directory:
            root = Path(directory)
            doc = fitz.open()
            doc.new_page().insert_text((100, 100), "Normal prose")
            page = doc.new_page()
            point = fitz.Point(100, 100)
            page.insert_text(point, "Skewed prose", morph=(point, fitz.Matrix(15)))
            source = root / "source.pdf"
            doc.save(source)
            job = {"sourcePath": str(source), "sourceHash": tool.sha(source.read_bytes()), "pageCount": 2}
            tool.extract(job, root)
            pages = tool.read_json(root / "layout.json")["pages"]
            self.assertIsNone(pages[0]["error"])
            self.assertIn("倾斜文字", pages[1]["error"])
            self.assertEqual(len(pages[0]["units"]), 1)
            with self.assertRaisesRegex(ValueError, "倾斜文字"):
                tool.render(job, root, 2)


if __name__ == "__main__":
    unittest.main()
