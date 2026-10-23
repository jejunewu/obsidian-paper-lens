import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class FileView {
    file: { path: string } | null = null;
    app = { workspace: { requestSaveLayout: vi.fn() } };
    allowNoFile = false;
    getState() { return { file: this.file?.path }; }
    async setState(state: { file: string }) {
      this.file = { path: state.file };
      await (this as unknown as { onLoadFile(file: { path: string }): Promise<void> })
        .onLoadFile(this.file);
    }
  }
  return { FileView, Notice: class {}, TFile: class {},
    Modal: class {}, SuggestModal: class {} };
});

import { FileView } from "obsidian";
import { PaperLensView } from "../src/ui/view";
import type { Position } from "../src/core/geometry";

function view() {
  return new PaperLensView({} as never, {
    settings: { defaultAgent: "codex" }, agents: {},
  } as never);
}

describe("Paper Lens file context", () => {
  it("restores an old tab and exposes its PDF to other plugins", async () => {
    const reader = view();
    await reader.setState({ path: "papers/old.pdf", chatOpen: true }, {});
    expect(reader).toBeInstanceOf(FileView);
    expect(reader.file?.path).toBe("papers/old.pdf");
    expect(reader.getState()).toMatchObject({ file: "papers/old.pdf" });
    expect(reader.getState()).not.toHaveProperty("chatOpen");
    expect(reader.getState()).not.toHaveProperty("path");
  });

  it("keeps the current file authoritative over stale legacy context", async () => {
    const reader = view();
    await reader.setState({
      file: "papers/current.pdf", path: "papers/previous.pdf", agent: "claude",
      position: { page: 2, fraction: 0.25 }, zoom: 1.2, translationOpen: true,
    }, {});
    expect(reader.file?.path).toBe("papers/current.pdf");
    expect(reader.getState()).toMatchObject({
      file: "papers/current.pdf", position: { page: 2, fraction: 0.25 },
      agent: "claude", zoom: 1.2, translationOpen: true,
    });
    expect(reader.canAcceptExtension("PDF")).toBe(true);
    expect(reader.canAcceptExtension("md")).toBe(false);
  });
});

function scrollControls() {
  const reader = view();
  const pane = () => {
    let pos = { page: 1, fraction: 0 };
    return { sizes: Array(6).fill({ width: 600, height: 800 }),
      position: () => pos, navigate: vi.fn((next: Position) => { pos = next; }),
      scroll: (next: Position) => { pos = next; } };
  };
  const source = pane(), translation = pane();
  const attributes = new Map<string, string>();
  const scrollButton = { textContent: "", disabled: false, title: "",
    setAttribute: (key: string, value: string) => attributes.set(key, value) };
  const pageInput = { value: "1" };
  Object.assign(reader, { source, translation, scrollButton, pageInput, ready: true,
    translationOpen: true, translationPanel: {}, translateDivider: {} });
  const controls = reader as unknown as {
    readerPosition(pane: "source" | "translation", pos: Position): void;
    setScrollLinked(linked: boolean): void;
    navigate(page: number, fraction?: number): void;
  };
  const scroll = (side: "source" | "translation", pos: Position) => {
    (side === "source" ? source : translation).scroll(pos);
    controls.readerPosition(side, pos);
  };
  return { reader, controls, source, translation, scroll, scrollButton, attributes, pageInput };
}

describe("two-pane scrolling", () => {
  it("links matching page-relative positions in both directions by default", () => {
    const s = scrollControls();
    s.scroll("source", { page: 2, fraction: 0.35 });
    expect(s.translation.position()).toEqual({ page: 2, fraction: 0.35 });
    s.scroll("translation", { page: 4, fraction: 0.6 });
    expect(s.source.position()).toEqual({ page: 4, fraction: 0.6 });
    expect(s.pageInput.value).toBe("4");
  });

  it("keeps both positions independent and routes page jumps to the last used pane", () => {
    const s = scrollControls();
    s.controls.setScrollLinked(false);
    s.scroll("source", { page: 2, fraction: 0.35 });
    s.scroll("translation", { page: 4, fraction: 0.6 });
    expect(s.source.position()).toEqual({ page: 2, fraction: 0.35 });
    expect(s.translation.position()).toEqual({ page: 4, fraction: 0.6 });
    s.controls.navigate(5);
    expect(s.translation.position()).toEqual({ page: 5, fraction: 0 });
    expect(s.source.position().page).toBe(2);
    expect(s.scrollButton.textContent).toBe("独立滚动");
    expect(s.attributes.get("aria-pressed")).toBe("false");
    expect(s.reader.getState()).toMatchObject({ scrollLinked: false,
      position: { page: 2, fraction: 0.35 }, translationPosition: { page: 5, fraction: 0 }, activePane: "translation" });
  });

  it("rejoins at the last read pane without changing its position", () => {
    const s = scrollControls();
    s.controls.setScrollLinked(false);
    s.scroll("source", { page: 2, fraction: 0.35 });
    s.scroll("translation", { page: 4, fraction: 0.6 });
    s.controls.setScrollLinked(true);
    expect(s.source.position()).toEqual({ page: 4, fraction: 0.6 });
    expect(s.translation.position()).toEqual({ page: 4, fraction: 0.6 });
    expect(s.scrollButton.textContent).toBe("同步滚动");
    expect(s.attributes.get("aria-pressed")).toBe("true");
    s.controls.navigate(6);
    expect(s.source.position().page).toBe(6);
    expect(s.translation.position().page).toBe(6);
  });

  it("restores independent mode and both positions while keeping legacy tabs linked", async () => {
    const reader = view();
    await reader.setState({ file: "paper.pdf", translationOpen: true, scrollLinked: false,
      activePane: "translation", position: { page: 2, fraction: 0.35 },
      translationPosition: { page: 4, fraction: 0.6 } }, {});
    expect(reader.getState()).toMatchObject({ scrollLinked: false, activePane: "translation",
      position: { page: 2, fraction: 0.35 }, translationPosition: { page: 4, fraction: 0.6 } });
    await reader.setState({ file: "paper.pdf" }, {});
    expect(reader.getState()).toMatchObject({ scrollLinked: true, activePane: "source" });
  });
});
