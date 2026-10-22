import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSource } from "../src/pdf/source";
import { digest } from "../src/translation/protocol";

describe("original PDF persistence", () => {
  it("preserves the first backup and refuses externally modified sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paper-lens-save-"));
    const path = join(dir, "paper.pdf");
    try {
      await writeFile(path, "original");
      const expected = digest(Buffer.from("original"));
      const saved = await saveSource(path, expected, Buffer.from("annotated"));
      expect(await readFile(path, "utf8")).toBe("annotated");
      expect(await readFile(path + ".paper-lens.bak", "utf8")).toBe("original");
      await saveSource(path, saved, Buffer.from("second save"));
      expect(await readFile(path + ".paper-lens.bak", "utf8")).toBe("original");
      await writeFile(path, "external edit");
      await expect(
        saveSource(path, saved, Buffer.from("stale")),
      ).rejects.toThrow("外部修改");
      expect(await readFile(path, "utf8")).toBe("external edit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
