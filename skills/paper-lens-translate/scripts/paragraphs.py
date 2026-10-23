"""Paragraph extraction and bounded reflow; source formula glyphs remain vector PDF objects."""
import math
import re
from statistics import median
import pymupdf as fitz

KEEP = re.compile(r"\[\[PL_KEEP_\d+\]\]")


def union(boxes):
    result = fitz.Rect(boxes[0])
    for box in boxes[1:]:
        result |= fitz.Rect(box)
    return result


def direction(line):
    angle = math.degrees(math.atan2(-line['dir'][1], line['dir'][0])) % 360
    rotation = round(angle / 90) * 90 % 360
    if abs((angle - rotation + 180) % 360 - 180) > 0.1:
        raise ValueError('倾斜文字暂不支持原位翻译，请使用水平或 90° 倍数的文字方向')
    return rotation


def line_size(line):
    return median(s['size'] for s in line['spans'] for _ in range(max(1, len(s['text'].strip()))))


def visual_lines(block, protected=None):
    # Justified PDFs can expose separated words as distinct PDF.js/MuPDF lines.
    # Reconstruct the visual baseline before detecting paragraphs.
    lines = []
    for fragment in block.get('lines', []):
        merged = False
        for line in reversed(lines):
            if direction(line) or direction(fragment):
                continue
            baseline = line['spans'][0]['origin'][1]
            other_baseline = fragment['spans'][0]['origin'][1]
            gap = fragment['bbox'][0] - line['bbox'][2]
            if abs(baseline - other_baseline) < 1 and -0.5 <= gap <= max(line_size(line) * 2.5, (block['bbox'][2] - block['bbox'][0]) * 0.08):
                line['spans'] += fragment['spans']
                line['bbox'] = list(union([line['bbox'], fragment['bbox']]))
                merged = True
                break
        if not merged:
            lines.append({**fragment, 'spans': list(fragment['spans'])})
    # PDF producers often emit a formula's subscript as a separate line.
    # Attach it to its neighboring formula glyphs before paragraph detection.
    if protected:
        for line in lines:
            normalized = []
            for span in line['spans']:
                previous = normalized[-1] if normalized else None
                if (previous and span['font'] == previous['font'] and span['flags'] == previous['flags']
                        and span['color'] == previous['color']
                        and abs(span['size'] - previous['size']) < previous['size'] * 0.03
                        and abs(span['origin'][1] - previous['origin'][1]) < 1
                        and (not protected(span) or not protected(previous))):
                    gap = span['bbox'][0] - previous['bbox'][2]
                    if -0.5 <= gap < span['size']:
                        separator = ' ' if gap > span['size'] * 0.15 and not previous['text'].endswith(' ') and not span['text'].startswith(' ') else ''
                        previous['text'] += separator + span['text']
                        previous['bbox'] = list(union([previous['bbox'], span['bbox']]))
                        continue
                normalized.append({**span})
            line['spans'] = normalized
        for fragment in list(lines):
            if not all(protected(s) for s in fragment['spans']):
                continue
            for line in lines:
                if line is fragment or direction(line) or not any(not protected(s) for s in line['spans']):
                    continue
                near = any(protected(s) and fitz.Rect(s['bbox']).intersects(
                    fitz.Rect(fragment['bbox']) + (-2, -2, 2, 2)) for s in line['spans'])
                baseline = max(line['spans'], key=lambda s: len(s['text']))['origin'][1]
                same_baseline = any(abs(s['origin'][1] - baseline) < 1 for s in fragment['spans'])
                if near and (same_baseline or line_size(fragment) < line_size(line) * 0.8):
                    line['spans'] += fragment['spans']
                    line['spans'].sort(key=lambda s: s['bbox'][0])
                    line['bbox'] = list(union([line['bbox'], fragment['bbox']]))
                    lines.remove(fragment)
                    break
    return lines


def joins(previous, current):
    if direction(previous) or direction(current):
        return False
    a, b = fitz.Rect(previous['bbox']), fitz.Rect(current['bbox'])
    gap = b.y0 - a.y1
    if not -0.4 * a.height <= gap <= 0.9 * max(a.height, b.height):
        return False
    if abs(line_size(previous) - line_size(current)) > 0.15 * line_size(previous):
        return False
    overlap = min(a.x1, b.x1) - max(a.x0, b.x0)
    return overlap > min(a.width, b.width) * 0.5


def alignment(lines, page_width):
    boxes = [fitz.Rect(line['bbox']) for line in lines]
    if len(boxes) < 2:
        box = boxes[0]
        return 'center' if abs((box.x0 + box.x1) / 2 - page_width / 2) < 8 else 'left'
    left = median(b.x0 for b in boxes[1:])
    right = max(b.x1 for b in boxes)
    if all(abs(b.x0 - left) < 3 for b in boxes[1:]) and all(abs(b.x1 - right) < 3 for b in boxes[:-1]):
        return 'justify'
    centers = [(b.x0 + b.x1) / 2 for b in boxes]
    if max(centers) - min(centers) < 4:
        return 'center'
    if max(b.x1 for b in boxes) - min(b.x1 for b in boxes) < 3:
        return 'right'
    return 'left'


def extract_units(page, number, protected):
    units, keep, error = [], [], None
    for block in page.get_text('dict', sort=True)['blocks']:
        groups, group = [], []
        spans = [s for line in block.get('lines', []) for s in line['spans']]
        # Named operators in display equations are mathematics, not prose.
        words = re.findall(r'[A-Za-z]+', ' '.join(s['text'] for s in spans if not protected(s)))
        if (words and all(word in {'exp', 'min', 'max', 'log', 'ln', 'sin', 'cos', 'tan', 'lim', 'softmax'} for word in words)
                and any(protected(s) for s in spans)):
            keep.extend({'text': s['text'], 'bbox': s['bbox']} for s in spans)
            continue
        try:
            lines = visual_lines(block, protected)
        except ValueError as reason:
            error = str(reason)
            continue
        for line in lines:
            try:
                rotation = direction(line)
            except ValueError as reason:
                error = str(reason)
                continue
            if not any(not protected(s) for s in line['spans']):
                if group:
                    groups.append(group); group = []
                keep.extend({'text': s['text'], 'bbox': s['bbox']} for s in line['spans'])
                continue
            if group and not joins(group[-1], line):
                groups.append(group); group = []
            # A new indented line after a sentence usually starts another paragraph.
            if len(group) >= 2 and line['bbox'][0] > median(l['bbox'][0] for l in group) + line_size(line) and re.search(r'[.!?]\s*$', ''.join(s['text'] for s in group[-1]['spans'])):
                groups.append(group); group = []
            group.append(line)
        if group:
            groups.append(group)
        for lines in groups:
            rotation = direction(lines[0])
            spans = [s for line in lines for s in line['spans']]
            box = union([s['bbox'] for s in spans])
            inline, parts = [], []
            for line in lines:
                merged_spans = []
                baseline = max(line['spans'], key=lambda s: len(s['text']))['origin'][1]
                for span in line['spans']:
                    if rotation == 0 and protected(span) and merged_spans and protected(merged_spans[-1]) and -span['size'] <= span['bbox'][0] - merged_spans[-1]['bbox'][2] < span['size']:
                        previous = merged_spans[-1]
                        previous['text'] += span['text']
                        previous['bbox'] = list(union([previous['bbox'], span['bbox']]))
                    else:
                        merged_spans.append({**span, 'origin': (span['bbox'][0], baseline) if protected(span) else span['origin']})
                text, previous = '', None
                for span in merged_spans:
                    value = span['text']
                    if rotation == 0 and protected(span) and value.strip():
                        token = f'[[PL_KEEP_{len(inline)}]]'
                        inline.append({'token': token, 'text': value, 'bbox': span['bbox'], 'origin': span['origin']})
                        value = token
                    if previous and text and not text[-1].isspace() and value and not value[0].isspace() and span['bbox'][0] - previous['bbox'][2] > span['size'] * 0.15:
                        text += ' '
                    text += value
                    previous = span
                if parts and parts[-1].endswith(('-', '\u00ad')):
                    parts[-1] = parts[-1].replace('\u00ad', '') + text.strip()
                else:
                    parts.append(text.strip())
            size = median(s['size'] for s in spans if not protected(s))
            tops = [line['bbox'][1] for line in lines]
            pitch = median(b - a for a, b in zip(tops, tops[1:])) if len(tops) > 1 else box.height
            left = min(l['bbox'][0] for l in lines)
            indent = max(0, lines[0]['bbox'][0] - left) if len(lines) > 1 else 0
            units.append({'id': f'p{number}-b{len(units)+1}', 'text': ' '.join(parts), 'bbox': list(box),
                          'spans': [{'bbox': s['bbox'], 'text': s['text']} for s in spans], 'inline': inline,
                          'size': size, 'color': spans[0]['color'], 'rotation': rotation,
                          'align': alignment(lines, page.rect.width) if not rotation else 'left',
                          'indent': indent, 'lineHeight': pitch,
                          'bold': bool(spans[0]['flags'] & 16), 'lineCount': len(lines)})
    return units, keep, error


def safe_frame(unit, page, obstacles):
    original = fitz.Rect(unit['bbox'])
    if unit['rotation'] or (unit['lineCount'] < 2 and original.width < page.rect.width * 0.5 and not unit.get('bold')):
        return original
    box = fitz.Rect(original)
    # Bounded growth into adjacent whitespace; keep the column's left edge.
    box.x1 = min(page.rect.width - 18, original.x1 + min(32, original.width * 0.08))
    box.y1 = min(page.rect.height - 18, original.y1 + max(24, unit['lineHeight'] * 2))
    for item in obstacles:
        other = fitz.Rect(item)
        if other.is_empty:
            continue
        if other.x0 >= original.x1 - 0.5 and other.y0 < box.y1 and other.y1 > box.y0:
            box.x1 = min(box.x1, max(original.x1, other.x0 - 3))
        if other.y0 >= original.y1 - 0.5 and other.x0 < box.x1 and other.x1 > box.x0:
            box.y1 = min(box.y1, max(original.y1, other.y0 - 3))
        # Objects whose bounding rectangle encloses the paragraph forbid growth.
        if other.intersects(original) and not original.contains(other):
            box = fitz.Rect(original)
            break
    return box


def tokens(text, unit, font, size):
    inline = {item['token']: item for item in unit.get('inline', [])}
    if any(text.count(key) != 1 for key in inline) or any(key not in inline for key in KEEP.findall(text)):
        raise ValueError(f"Inline formula/citation placeholders missing or duplicated in {unit['id']}")
    result = []
    pattern = r'\[\[PL_KEEP_\d+\]\]|[A-Za-z0-9][A-Za-z0-9_.:/@+%\-]*|\s+|[^\s]'
    for value in re.findall(pattern, text):
        if value in inline:
            item = inline[value]
            box = fitz.Rect(item['bbox']); scale = size / unit['size']
            result.append({'text': value, 'width': box.width * scale, 'inline': item, 'scale': scale})
        else:
            value = ' ' if value.isspace() else value
            if any(not font.has_glyph(ord(ch)) for ch in value):
                raise ValueError(f"Missing font glyph in {unit['id']}")
            result.append({'text': value, 'width': font.text_length(value, fontsize=size)})
    # Keep closing punctuation with the preceding glyph/word and opening marks
    # with the following glyph, so reflow does not create orphan punctuation.
    joined = []
    for item in result:
        if joined and 'inline' not in item and 'inline' not in joined[-1] and (
            item['text'] in '。，、！？：；）】》」』”’.,!?;:)]' or joined[-1]['text'] in '（【《「『“‘('):
            joined[-1]['text'] += item['text']
            joined[-1]['width'] += item['width']
        else:
            joined.append(item)
    return joined


def wrap(items, width, indent):
    lines, line, used = [], [], indent
    for item in items:
        if item['text'] == ' ' and not line:
            continue
        if used + item['width'] > width + 0.01:
            if not line or item['width'] > width:
                return None
            while line and line[-1]['text'] == ' ':
                used -= line.pop()['width']
            lines.append((line, used))
            line, used = [], 0
            if item['text'] == ' ':
                continue
        line.append(item); used += item['width']
    if line:
        while line and line[-1]['text'] == ' ':
            used -= line.pop()['width']
        lines.append((line, used))
    return lines


def plan(unit, text, font, frame):
    original = fitz.Rect(unit['bbox'])
    minimum = min(7, unit['size'] * 0.75)
    for candidate in [original, frame]:
        size = unit['size']
        # Prefer unchanged type size; only shrink after trying safe whitespace.
        while size >= minimum:
            width, height = (candidate.height, candidate.width) if unit['rotation'] in (90, 270) else (candidate.width, candidate.height)
            items = tokens(text, unit, font, size)
            lines = wrap(items, width, unit.get('indent', 0))
            ascent, descent = font.ascender * size, -font.descender * size
            for item in items:
                if 'inline' in item:
                    s = item['inline']; b = fitz.Rect(s['bbox']); scale = item['scale']
                    ascent = max(ascent, (s['origin'][1] - b.y0) * scale)
                    descent = max(descent, (b.y1 - s['origin'][1]) * scale)
            pitch = max(ascent + descent, unit['lineHeight'] * size / unit['size'])
            if lines and ascent + descent + (len(lines) - 1) * pitch <= height + 0.1:
                return {'bbox': list(candidate), 'fontSize': size, 'lines': lines, 'pitch': pitch, 'ascent': ascent}
            if candidate == original and candidate != frame:
                break
            size -= 0.25
    raise ValueError(f"Paragraph overflow in {unit['id']}: use concise complete sentences without dropping meaning; safe whitespace and readable compression exhausted")


def point(box, rotation, x, y):
    return {0: (box.x0 + x, box.y0 + y), 90: (box.x0 + y, box.y1 - x),
            180: (box.x1 - x, box.y1 - y), 270: (box.x1 - y, box.y0 + x)}[rotation]


def draw(page, unit, layout, source, source_number):
    box = fitz.Rect(layout['bbox']); size = layout['fontSize']; rotation = unit['rotation']
    width = box.height if rotation in (90, 270) else box.width
    color = tuple(((unit['color'] >> shift) & 255) / 255 for shift in (16, 8, 0))
    shape, sprites = page.new_shape(), []
    for number, (items, used) in enumerate(layout['lines']):
        indent = unit.get('indent', 0) if number == 0 else 0
        align = unit['align']
        x = indent if align in ('left', 'justify') else (width - used) / 2 if align == 'center' else width - used
        extra = max(0, width - used) / (len(items) - 1) if align == 'justify' and number < len(layout['lines']) - 1 and len(items) > 1 else 0
        baseline = layout['ascent'] + number * layout['pitch']
        for item in items:
            if 'inline' in item:
                s = item['inline']; b = fitz.Rect(s['bbox']); scale = item['scale']
                top = baseline - (s['origin'][1] - b.y0) * scale
                target = fitz.Rect(box.x0 + x, box.y0 + top, box.x0 + x + item['width'], box.y0 + top + b.height * scale)
                sprites.append((target, b))
            else:
                shape.insert_text(point(box, rotation, x, baseline), item['text'], fontsize=size, fontname='PLChinese',
                                  color=color, rotate=rotation, render_mode=2 if unit.get('bold') else 0,
                                  border_width=0.015)
            x += item['width'] + extra
    shape.commit()
    for target, clip in sprites:
        page.show_pdf_page(target, source, source_number, clip=clip, keep_proportion=False)
