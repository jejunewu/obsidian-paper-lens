import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class FileView {
    file: { path: string } | null = null;
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
