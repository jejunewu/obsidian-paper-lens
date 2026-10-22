import { describe, expect, it } from "vitest";
import { AnnotationStore } from "../src/core/annotations";
import {
  locatePosition,
  positionOffset,
  pdfPoint,
  viewportPoint,
} from "../src/core/geometry";
import { JsonLines } from "../src/agents/json-lines";
import { retrievePages, citationPages } from "../src/core/context";

describe("page coordinates", () => {
  it("syncs page-relative positions across different heights", () => {
    const pos = locatePosition(340, [
      { top: 0, height: 200 },
      { top: 220, height: 400 },
    ]);
    expect(pos).toEqual({ page: 2, fraction: 0.3 });
    expect(
      positionOffset(pos, [
        { top: 0, height: 500 },
        { top: 520, height: 800 },
      ]),
    ).toBe(760);
  });
  it.each([0, 90, 180, 270])(
    "round trips cropped, rotated pages at %i degrees",
    (rotation) => {
      const box = { x: 20, y: 40, width: 600, height: 800, rotation };
      expect(pdfPoint(viewportPoint([130, 270], box, 1.7), box, 1.7)).toEqual([
        130, 270,
      ]);
    },
  );
});

describe("annotation undo", () => {
  it("restores edited and deleted annotations and resets after save", () => {
    const store = new AnnotationStore([]);
    const item = {
      id: "a",
      page: 1,
      kind: "text" as const,
      rects: [[10, 20, 100, 50] as [number, number, number, number]],
      text: "中文",
      color: [1, 1, 0] as [number, number, number],
    };
    store.upsert(item);
    store.upsert({ ...item, text: "edited" });
    store.remove("a");
    store.undo();
    expect(store.items[0]?.text).toBe("edited");
    store.undo();
    expect(store.items[0]?.text).toBe("中文");
    store.saved();
    expect(store.dirty).toBe(false);
    expect(store.undo()).toBe(false);
  });
});

describe("agent framing", () => {
  it("decodes JSON and Chinese characters split across chunks", () => {
    const events: unknown[] = [];
    const parser = new JsonLines((x) => events.push(x));
    const bytes = Buffer.from('{"delta":"中文"}\n{"done":true}\n');
    for (const b of bytes) parser.push(Buffer.from([b]));
    expect(events).toEqual([{ delta: "中文" }, { done: true }]);
  });
  it("reports malformed records without swallowing a following valid event", () => {
    const events: unknown[] = [];
    const errors: Error[] = [];
    const parser = new JsonLines(
      (x) => events.push(x),
      (x) => errors.push(x),
    );
    parser.push(Buffer.from('broken\n{"ok":true}\n'));
    expect(errors).toHaveLength(1);
    expect(events).toEqual([{ ok: true }]);
  });
});

describe("paper context", () => {
  it("retrieves relevant pages with bounded context", () => {
    const pages = [
      "abstract overview",
      "attention transformer architecture",
      "references",
    ];
    expect(retrievePages(pages, "transformer", 1).map((p) => p.page)).toContain(
      2,
    );
  });
  it("only accepts citations in range", () =>
    expect(citationPages("[p. 2] [p. 99] [p. 0]", 4)).toEqual([2]));
});
