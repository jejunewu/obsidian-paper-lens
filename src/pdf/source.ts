import { readFile, writeFile, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../translation/protocol";
export async function saveSource(
  path: string,
  expected: string,
  bytes: Uint8Array,
): Promise<string> {
  const original = await readFile(path);
  if (digest(original) !== expected)
    throw new Error(
      "原 PDF 已被外部修改。待保存批注已保留，请重新打开新版本后处理",
    );
  const backup = `${path}.paper-lens.bak`;
  try {
    await writeFile(backup, original, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    if (digest(await readFile(path)) !== expected)
      throw new Error("保存期间原 PDF 被修改，已取消写回");
    await rename(temporary, path);
    return digest(bytes);
  } catch (e) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw e;
  }
}
