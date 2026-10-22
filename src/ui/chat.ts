import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentKind,
  AgentEvent,
  AgentRun,
  ChatSession,
  PaperContext,
} from "../core/types";
import { questionPrompt } from "../core/context";
import type PaperLensPlugin from "../main";

export class ChatPanel {
  private transcript: HTMLElement;
  private permissions: HTMLElement;
  private input: HTMLTextAreaElement;
  private status: HTMLElement;
  private session: ChatSession = { messages: [] };
  private context?: PaperContext;
  private kind: AgentKind = "codex";
  private run?: AgentRun;
  private cwd = "";
  private generation = 0;
  private disposed = false;
  private requestEpoch = 0;
  private sendButton: HTMLButtonElement;
  private saveQueue = Promise.resolve();
  private pendingPermissions = new Set<(allow: boolean) => void>();
  constructor(
    private el: HTMLElement,
    private plugin: PaperLensPlugin,
    private navigate: (page: number) => void,
  ) {
    const header = el.createDiv({ cls: "pl-chat-header" });
    header.createEl("strong", { text: "论文对话" });
    const fresh = header.createEl("button", { text: "新建会话" });
    fresh.addEventListener("click", () => {
      this.stop();
      this.session = { messages: [] };
      this.render();
      void this.save();
    });
    this.transcript = el.createDiv({
      cls: "pl-transcript",
      attr: { role: "log", "aria-label": "论文聊天记录" },
    });
    this.permissions = el.createDiv({ cls: "pl-permissions" });
    this.status = el.createDiv({
      cls: "pl-chat-status",
      attr: { role: "status" },
    });
    const composer = el.createDiv({ cls: "pl-composer" });
    this.input = composer.createEl("textarea", {
      attr: {
        "aria-label": "论文问题",
        placeholder: "询问方法、结果或选中的文字…",
        rows: "3",
      },
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    const actions = composer.createDiv({ cls: "pl-chat-actions" });
    this.sendButton = actions.createEl("button", {
      text: "发送",
      cls: "mod-cta",
    });
    this.sendButton.addEventListener("click", () => {
      void this.send();
    });
    const stop = actions.createEl("button", { text: "停止生成" });
    stop.addEventListener("click", () => this.stop());
  }
  updateContext(context: PaperContext): void {
    this.context = context;
  }
  async load(context: PaperContext, kind: AgentKind): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    this.context = context;
    this.kind = kind;
    const key = createHash("sha256")
      .update(context.documentId + kind)
      .digest("hex");
    this.cwd = join(this.plugin.workRoot, "documents", key, "chat");
    await mkdir(this.cwd, { recursive: true });
    let session: ChatSession;
    try {
      session = JSON.parse(
        await readFile(join(this.cwd, "session.json"), "utf8"),
      ) as ChatSession;
      if (!Array.isArray(session.messages)) throw new Error("Invalid session");
    } catch {
      session = { messages: [] };
    }
    if (generation !== this.generation || this.disposed) return;
    this.session = session;
    this.status.textContent = `${kind === "codex" ? "Codex" : "Claude Code"} · 依据原文回答，引用可跳转`;
    this.render();
  }
  private async save(): Promise<void> {
    const path = join(this.cwd, "session.json"),
      value = JSON.stringify(this.session);
    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(async () => {
        await writeFile(path + ".tmp", value);
        await rename(path + ".tmp", path);
      });
    await this.saveQueue;
  }
  private renderMessage(el: HTMLElement, text: string): void {
    el.replaceChildren();
    let start = 0;
    for (const match of text.matchAll(/\[p\.\s*(\d+)\]/g)) {
      const index = match.index;
      el.append(document.createTextNode(text.slice(start, index)));
      const page = Number(match[1]);
      if (page >= 1 && page <= (this.context?.pages.length ?? 0)) {
        const button = el.createEl("button", {
          text: `第 ${page} 页`,
          cls: "pl-citation",
        });
        button.addEventListener("click", () => this.navigate(page));
      } else el.append(document.createTextNode(match[0]));
      start = index + match[0].length;
    }
    el.append(document.createTextNode(text.slice(start)));
  }
  private render(): void {
    this.transcript.replaceChildren();
    for (const message of this.session.messages) {
      const row = this.transcript.createDiv({
        cls: `pl-message pl-message-${message.role}`,
      });
      row.createEl("small", {
        text:
          message.role === "user"
            ? "你"
            : this.kind === "codex"
              ? "Codex"
              : "Claude Code",
      });
      this.renderMessage(
        row.createDiv({ cls: "pl-message-body" }),
        message.text,
      );
    }
    if (!this.session.messages.length)
      this.transcript.createEl("p", {
        text: "打开论文后即可提问。选中文字会作为当前问题的参考。",
        cls: "pl-empty",
      });
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }
  private async send(): Promise<void> {
    if (
      this.run ||
      this.sendButton.disabled ||
      !this.context ||
      !this.input.value.trim() ||
      this.disposed
    )
      return;
    const question = this.input.value.trim(),
      context = structuredClone(this.context),
      generation = this.generation,
      epoch = ++this.requestEpoch;
    this.input.value = "";
    this.session.messages.push(
      { role: "user", text: question },
      { role: "assistant", text: "" },
    );
    const answer = this.session.messages[this.session.messages.length - 1]!;
    this.render();
    this.sendButton.disabled = true;
    this.status.textContent = "正在连接 Agent…";
    try {
      await writeFile(
        join(this.cwd, "paper-context.json"),
        JSON.stringify(context),
      );
      await this.save();
      if (
        epoch !== this.requestEpoch ||
        generation !== this.generation ||
        this.disposed
      )
        return;
      const run = await this.plugin.agents.run(
        this.kind,
        this.plugin.cliPath(this.kind),
        this.plugin.sdkPath,
        {
          cwd: this.cwd,
          prompt: questionPrompt(context, question),
          sessionId: this.session.id,
          model: this.plugin.model(this.kind),
        },
        (e) => {
          if (
            epoch !== this.requestEpoch ||
            generation !== this.generation ||
            this.disposed
          ) {
            if (e.type === "permission") e.respond(false);
            return;
          }
          if (e.type === "delta") {
            answer.text += e.text;
            this.render();
          }
          if (e.type === "session") this.session.id = e.id;
          if (e.type === "permission") this.permission(e);
          if (e.type === "status") this.status.textContent = e.text;
          if (e.type === "error") this.status.textContent = e.text;
          if (e.type === "done") this.status.textContent = "回答完成";
          if (e.type === "cancelled")
            this.status.textContent = "已停止，已生成内容保留";
        },
      );
      if (
        epoch !== this.requestEpoch ||
        generation !== this.generation ||
        this.disposed
      ) {
        run.cancel();
        return;
      }
      this.run = run;
      await run.done;
      if (
        epoch !== this.requestEpoch ||
        generation !== this.generation ||
        this.disposed
      )
        return;
      this.run = undefined;
      await this.save();
    } catch (e) {
      if (generation === this.generation) this.status.textContent = String(e);
    } finally {
      if (generation === this.generation && epoch === this.requestEpoch) {
        this.sendButton.disabled = false;
        this.clearPermissions();
      }
    }
  }
  permission(event: Extract<AgentEvent, { type: "permission" }>): void {
    this.pendingPermissions.add(event.respond);
    const box = this.permissions.createDiv({ cls: "pl-permission" });
    box.createEl("strong", { text: event.title });
    box.createEl("pre", { text: event.detail });
    for (const [label, allow] of [
      ["允许本次操作", true],
      ["拒绝", false],
    ] as const) {
      const button = box.createEl("button", { text: label });
      button.addEventListener("click", () => {
        event.respond(allow);
        this.pendingPermissions.delete(event.respond);
        box.remove();
      });
    }
  }
  private clearPermissions(): void {
    for (const respond of this.pendingPermissions) respond(false);
    this.pendingPermissions.clear();
    this.permissions.replaceChildren();
  }
  stop(): void {
    this.requestEpoch++;
    this.run?.cancel();
    this.run = undefined;
    this.clearPermissions();
    this.sendButton.disabled = false;
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.stop();
  }
}
