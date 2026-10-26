import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { shellPolicy } from "../permissions.ts";
import type { Risk } from "../types.ts";
import { HANDOFF_REMINDER, type ExecuteRequest, type ExecuteResult, type Executor } from "./types.ts";

type Json = Record<string, any>;

/** Minimal JSON-RPC 2.0 over newline-delimited stdio, as ACP specifies. */
export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private notificationHandler: (method: string, params: Json) => void = () => {};
  private requestHandler: (method: string, params: Json) => Promise<unknown> = async (method) => {
    throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
  };
  stderr = "";

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-8000);
    });
    const failAll = (reason: string) => {
      for (const p of this.pending.values()) p.reject(new Error(reason));
      this.pending.clear();
    };
    child.on("exit", (code, signal) => failAll(`Cursor Agent 进程已退出（code ${code ?? "无"}${signal ? `，信号 ${signal}` : ""}）${this.stderr ? `：${this.stderr.trim().slice(-500)}` : ""}`));
    child.on("error", (e) => failAll(`无法启动 Cursor Agent：${e.message}`));
  }

  onNotification(handler: (method: string, params: Json) => void): void {
    this.notificationHandler = handler;
  }

  onRequest(handler: (method: string, params: Json) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  private send(message: Json): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private handleLine(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      this.requestHandler(msg.method, msg.params ?? {}).then(
        (result) => this.send({ id: msg.id, result: result ?? null }),
        (error: Error & { code?: number }) => this.send({ id: msg.id, error: { code: error.code ?? -32603, message: error.message } }),
      );
    } else if (msg.method) {
      this.notificationHandler(msg.method, msg.params ?? {});
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? "ACP 错误"), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
    }
  }

  request<T = any>(method: string, params: Json): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.send({ method, params });
  }

  close(): void {
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill("SIGTERM");
    }, 1500).unref();
  }
}

export function splitCommand(command: string): { file: string; args: string[] } {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((p) => p.replace(/^["']|["']$/g, "")) ?? [];
  return { file: parts[0] ?? "agent", args: parts.slice(1) };
}

function riskOfKind(kind: string | undefined): Risk {
  switch (kind) {
    case "read":
    case "search":
    case "think":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "write";
    case "fetch":
      return "network";
    default:
      return "exec";
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: Json) => {
      if (c.type === "content" && c.content?.type === "text") return c.content.text;
      if (c.type === "diff") return `diff ${c.path}`;
      if (c.type === "terminal") return `[terminal ${c.terminalId}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export class AcpExecutor implements Executor {
  async run(req: ExecuteRequest): Promise<ExecuteResult> {
    const { agent } = req;
    const { file, args } = splitCommand(req.cursorCommand ?? "agent");
    const child = spawn(file, [...args, "--model", agent.model, "acp"], {
      cwd: req.workspaceRoot,
      env: { ...process.env, NO_OPEN_BROWSER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const conn = new AcpConnection(child);
    const readOnly = !agent.permissions.write || req.role === "review" || req.role === "advisor" || req.role === "plan";
    let finalText = "";
    let currentText = "";
    const toolTitles = new Map<string, string>();

    conn.onNotification((method, params) => {
      if (method !== "session/update") return;
      const u = params.update ?? {};
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content?.type === "text") {
            currentText += u.content.text;
            req.emit({ type: "text_delta", delta: u.content.text });
          }
          break;
        case "agent_thought_chunk":
          if (u.content?.type === "text") req.emit({ type: "text_delta", delta: u.content.text, thinking: true });
          break;
        case "tool_call": {
          if (currentText) {
            finalText = currentText;
            currentText = "";
            req.emit({ type: "text_end" });
          }
          const title = String(u.title ?? u.kind ?? "tool");
          toolTitles.set(u.toolCallId, title);
          req.emit({ type: "tool_start", id: u.toolCallId, tool: title, args: u.rawInput ?? { kind: u.kind, locations: u.locations } });
          if (u.status === "completed" || u.status === "failed") {
            req.emit({ type: "tool_end", id: u.toolCallId, tool: title, ok: u.status === "completed", result: contentText(u.content) });
          }
          break;
        }
        case "tool_call_update":
          if (u.status === "completed" || u.status === "failed") {
            const out = contentText(u.content) || (u.rawOutput ? JSON.stringify(u.rawOutput).slice(0, 4000) : "");
            req.emit({ type: "tool_end", id: u.toolCallId, tool: toolTitles.get(u.toolCallId) ?? "tool", ok: u.status === "completed", result: out });
          }
          break;
        case "plan":
          if (Array.isArray(u.entries)) {
            req.emit({ type: "notice", level: "info", text: `Cursor 计划：\n${u.entries.map((e: Json) => `- [${e.status}] ${e.content}`).join("\n")}` });
          }
          break;
      }
    });

    conn.onRequest(async (method, params) => {
      if (method !== "session/request_permission") {
        throw Object.assign(new Error(`工作台不提供 ${method}`), { code: -32601 });
      }
      const options: Json[] = params.options ?? [];
      const pick = (kinds: string[]) => options.find((o) => kinds.includes(o.kind))?.optionId;
      const allowId = pick(["allow_once", "allow_always"]);
      const rejectId = pick(["reject_once", "reject_always"]);
      const answer = (allowed: boolean) =>
        allowed && allowId ? { outcome: { outcome: "selected", optionId: allowId } } : rejectId ? { outcome: { outcome: "selected", optionId: rejectId } } : { outcome: { outcome: "cancelled" } };
      if (req.signal.aborted) return { outcome: { outcome: "cancelled" } };
      const call: Json = params.toolCall ?? {};
      const risk = riskOfKind(call.kind);
      const command = typeof call.rawInput?.command === "string" ? call.rawInput.command : undefined;
      const preview = command ?? [call.title, call.rawInput ? JSON.stringify(call.rawInput, null, 2).slice(0, 2000) : ""].filter(Boolean).join("\n");
      req.toolContext.ws.audit({ run: req.runId, agent: agent.id, acpPermission: call.kind, title: call.title });
      if (risk === "read") return answer(true);
      if (risk === "write") {
        if (readOnly) return answer(false);
        return answer(true);
      }
      if (risk === "network") {
        if (agent.permissions.network === "deny") return answer(false);
        if (agent.permissions.network === "allow") return answer(true);
        return answer(await req.requestApproval({ risk, title: call.title ?? "联网", preview }));
      }
      const policy = command ? shellPolicy(command, req.toolContext.ws.settings(), agent).policy : agent.permissions.exec;
      if (policy === "deny") return answer(false);
      if (policy === "allow") return answer(true);
      return answer(await req.requestApproval({ risk, title: call.title ?? "执行命令", preview }));
    });

    const onAbort = () => {
      if (sessionId) conn.notify("session/cancel", { sessionId });
      setTimeout(() => conn.close(), 3000).unref();
    };
    let sessionId: string | undefined;
    req.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await conn.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "baton", title: "Baton", version: "0.1.0" },
      });
      const mcpServers = req.mcp
        ? [{ name: "baton", command: req.mcp.command, args: req.mcp.args, env: Object.entries(req.mcp.env).map(([name, value]) => ({ name, value })) }]
        : [];
      let created: Json;
      try {
        created = await conn.request("session/new", { cwd: req.workspaceRoot, mcpServers });
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (code === -32000) throw new Error("Cursor 还没有登录。请到「设置 → 账号」里登录 Cursor。");
        throw error;
      }
      sessionId = created.sessionId;
      if (readOnly) {
        const modes: Json[] = created.modes?.availableModes ?? [];
        const ask = modes.find((m) => /ask|read/i.test(`${m.id} ${m.name}`));
        if (ask) await conn.request("session/set_mode", { sessionId, modeId: ask.id }).catch(() => undefined);
      }
      const text = `<baton-briefing>\n${req.briefing.text}\n</baton-briefing>\n\n${req.prompt}`;
      const result: Json = await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      if (currentText) {
        finalText = currentText;
        currentText = "";
        req.emit({ type: "text_end" });
      }
      if (result.stopReason === "end_turn" && !req.hasHandoff() && req.role !== "advisor" && !req.signal.aborted) {
        req.emit({ type: "notice", level: "warn", text: "运行没有写交接，追加一次提醒。" });
        await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: HANDOFF_REMINDER }] });
        if (currentText) {
          finalText = currentText;
          req.emit({ type: "text_end" });
        }
      }
      if (req.signal.aborted || result.stopReason === "cancelled") return { status: "cancelled", finalText };
      if (result.stopReason === "refusal") return { status: "failed", finalText, error: "模型拒绝了这次请求" };
      return { status: "succeeded", finalText };
    } catch (error) {
      if (req.signal.aborted) return { status: "cancelled", finalText };
      const message = (error as Error).message;
      const hint = /ENOENT|无法启动/.test(message) ? "（没有找到 Cursor CLI，请先安装：curl https://cursor.com/install -fsS | bash）" : "";
      return { status: "failed", finalText, error: `${message}${hint}` };
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      conn.close();
    }
  }
}
