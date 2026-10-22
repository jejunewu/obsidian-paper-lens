import { StringDecoder } from "node:string_decoder";
export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(
    private emit: (value: unknown) => void,
    private fail: (error: Error) => void = () => {},
  ) {}
  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.fail(new Error("Agent 消息过大"));
      this.buffer = "";
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        this.emit(JSON.parse(line));
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
  end(): void {
    this.push(Buffer.from(this.decoder.end() + "\n"));
  }
}
