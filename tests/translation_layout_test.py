"""Run with Paper Lens's cached Python / PyMuPDF; uses synthetic PDF data only."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

import pymupdf as fitz

sys.dont_write_bytecode = True

repo = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(repo / "skills/paper-lens-translate/scripts"))
spec = importlib.util.spec_from_file_location("translate", repo / "skills/paper-lens-translate/scripts/translate.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class RotatedTranslationTest(unittest.TestCase):
    def test_wrapped_sentence_is_one_paragraph_and_reflows_with_source_justification(self):
        with tempfile.TemporaryDirectory(prefix="paper-lens-paragraph-") as directory:
            root = Path(directory)
            doc = fitz.open(); page = doc.new_page(width=500, height=500)
            original = "Attention models understand complete sentences even when a PDF wraps the sentence across several visual lines. They keep relationships between words and produce a coherent paragraph."
            page.insert_textbox(fitz.Rect(40, 60, 300, 170), original, fontsize=12, align=fitz.TEXT_ALIGN_JUSTIFY)
            page.draw_rect(fitz.Rect(40, 220, 300, 260), color=(0, 0, 1))
            source = root / "source.pdf"; doc.save(source)
            job = {"sourcePath": str(source), "sourceHash": tool.sha(source.read_bytes()), "pageCount": 1,
                   "fontPath": str(repo / "assets/NotoSansCJKsc-Regular.otf")}
            tool.extract(job, root)
            units = tool.read_json(root / "layout.json")["pages"][0]["units"]
            self.assertEqual(len(units), 1)
            self.assertGreater(units[0]["lineCount"], 2)
            self.assertNotIn("\n", units[0]["text"])
            self.assertIn("even when a PDF wraps the sentence across several visual lines", units[0]["text"])
            self.assertEqual(units[0]["align"], "justify")
            translated = "注意力模型能够理解完整句子，即使一个句子在 PDF 中被换成多行，也能保持词语之间的联系，并生成语义连贯的段落。" * 2
            tool.write_json(root / "translations/1.json", {units[0]["id"]: translated})
            tool.render(job, root, 1)
            report = tool.read_json(root / "reports/1.json")["units"][0]
            self.assertEqual(report["align"], "justify")
            with fitz.open(root / "drafts/1.pdf") as draft:
                lines = [line for block in draft[0].get_text('dict')['blocks'] for line in block.get('lines', [])]
                self.assertGreater(len(lines), 1)
                # Every full line reaches the same paragraph right edge; the last line remains natural.
                self.assertLess(max(line['bbox'][2] for line in lines[:-1]) - min(line['bbox'][2] for line in lines[:-1]), 1)
                self.assertLess(lines[-1]['bbox'][2], report['bbox'][2])
                self.assertEqual(len(draft[0].get_drawings()), 1)

    def test_inline_formula_survives_paragraph_reflow_as_vector_text(self):
        with tempfile.TemporaryDirectory(prefix="paper-lens-inline-") as directory:
            root = Path(directory)
            doc = fitz.open(); page = doc.new_page(width=500, height=400)
            page.insert_text((40, 80), "The value", fontsize=12)
            page.insert_text((100, 80), "x = y + 1", fontsize=12, fontname="cour")
            page.insert_text((180, 80), "remains unchanged.", fontsize=12)
            page.insert_text((40, 96), "The next sentence explains the same relation.", fontsize=12)
            source = root / "source.pdf"; doc.save(source)
            job = {"sourcePath": str(source), "sourceHash": tool.sha(source.read_bytes()), "pageCount": 1,
                   "fontPath": str(repo / "assets/NotoSansCJKsc-Regular.otf")}
            tool.extract(job, root)
            units = tool.read_json(root / "layout.json")["pages"][0]["units"]
            self.assertEqual(len(units), 1)
            self.assertEqual(units[0]['inline'][0]['text'].strip(), "x = y + 1")
            text = "保持 [[PL_KEEP_0]] 不变。下一句解释相同的关系。"
            tool.write_json(root / "translations/1.json", {units[0]['id']: text})
            tool.render(job, root, 1)
            with fitz.open(root / "drafts/1.pdf") as draft:
                result = draft[0].get_text()
                self.assertIn("x = y + 1", result)
                self.assertNotIn("The value", result)
                self.assertNotIn("[[PL_KEEP", result)
                self.assertEqual(result.count("x = y + 1"), 1)
                self.assertEqual(len(draft[0].get_images()), 0)

    def test_long_paragraph_uses_whitespace_but_stops_at_neighboring_column(self):
        from paragraphs import plan, safe_frame
        doc = fitz.open(); page = doc.new_page(width=500, height=500)
        font = fitz.Font(fontfile=str(repo / "assets/NotoSansCJKsc-Regular.otf"))
        unit = {'id': 'p1-b1', 'bbox': [40, 60, 160, 92], 'rotation': 0, 'lineCount': 2,
                'size': 12, 'lineHeight': 16, 'align': 'justify', 'indent': 0, 'inline': []}
        frame = safe_frame(unit, page, [[175, 40, 300, 200], [40, 130, 160, 160]])
        self.assertLess(frame.x1, 175)
        self.assertLess(frame.y1, 130)
        layout = plan(unit, '这是需要连贯表达的较长中文段落。' * 3, font, frame)
        self.assertGreater(layout['bbox'][3], unit['bbox'][3])
        self.assertGreaterEqual(layout['fontSize'], 7)
        self.assertLessEqual(layout['fontSize'], 12)

    def test_separate_subscript_moves_with_inline_formula_and_display_operators_stay_fixed(self):
        with tempfile.TemporaryDirectory(prefix="paper-lens-subscript-") as directory:
            root = Path(directory)
            doc = fitz.open(); page = doc.new_page(width=500, height=400)
            page.insert_text((40, 80), "The value", fontsize=12)
            page.insert_text((100, 80), "x", fontname="cour", fontsize=12)
            page.insert_text((108, 84), "i", fontname="cour", fontsize=8)
            page.insert_text((116, 80), "remains fixed.", fontsize=12)
            page.insert_text((40, 96), "This sentence describes the formula.", fontsize=12)
            page.insert_text((40, 160), "x =", fontname="cour", fontsize=12)
            page.insert_text((70, 160), "exp", fontsize=12)
            page.insert_text((94, 160), "(y)", fontname="cour", fontsize=12)
            source = root / "source.pdf"; doc.save(source)
            job = {"sourcePath": str(source), "sourceHash": tool.sha(source.read_bytes()), "pageCount": 1,
                   "fontPath": str(repo / "assets/NotoSansCJKsc-Regular.otf")}
            tool.extract(job, root)
            units = tool.read_json(root / "layout.json")["pages"][0]["units"]
            self.assertEqual(len(units), 1)
            self.assertEqual(units[0]['inline'][0]['text'].strip(), 'xi')
            tool.write_json(root / "translations/1.json", {units[0]['id']: "保持 [[PL_KEEP_0]] 不变。这句话解释该公式。"})
            tool.render(job, root, 1)
            with fitz.open(root / "drafts/1.pdf") as draft:
                self.assertIn("exp", draft[0].get_text())
                self.assertNotIn("The value", draft[0].get_text())
                spans = [s for b in draft[0].get_text('dict')['blocks'] for l in b.get('lines', []) for s in l['spans']]
                x = next(s for s in spans if s['text'] == 'x')
                i = next(s for s in spans if s['text'] == 'i')
                self.assertGreater(i['origin'][1], x['origin'][1])
                self.assertLess(i['size'], x['size'])

    def test_full_width_single_line_continuation_can_wrap_without_shrinking(self):
        from paragraphs import plan, safe_frame
        doc = fitz.open(); page = doc.new_page(width=500, height=500)
        font = fitz.Font(fontfile=str(repo / "assets/NotoSansCJKsc-Regular.otf"))
        unit = {'id': 'p1-b1', 'bbox': [40, 360, 460, 372], 'rotation': 0, 'lineCount': 1,
                'size': 12, 'lineHeight': 12, 'align': 'left', 'indent': 0, 'inline': []}
        frame = safe_frame(unit, page, [[240, 420, 260, 440]])
        layout = plan(unit, '这是跨页续句，它应在安全空白处按完整含义自然换行，并保持原来的可读字号。' * 2, font, frame)
        self.assertEqual(layout['fontSize'], 12)
        self.assertEqual(len(layout['lines']), 2)

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
            self.assertEqual(layout["extractionVersion"], 3)
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
