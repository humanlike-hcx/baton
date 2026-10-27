import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { formatChecks, runChecks } from "./checks.ts";
import { CHAT_RECENT_TURNS, chatTurns, compileBriefing } from "./context.ts";
import type { AcpExecutor } from "./executors/acp.ts";
import type { PiExecutor } from "./executors/pi.ts";
import type { ExecutorEvent, McpLaunch } from "./executors/types.ts";
import { ROUTES, modelFamily, modelProvider, routeLabel, thinkingLabel } from "./families.ts";
import { REVIEW_PERMISSIONS, accessPermissions, canWrite } from "./permissions.ts";
import { ShadowGit } from "./snapshot.ts";
import { MCP_TOOLS, runTool, toolsFor, type ToolContext, type ToolOutput } from "./tools.ts";
import type {
  Briefing,
  ChatAccess,
  ChatModel,
  CredentialSource,
  ReviewVerdict,
  Risk,
  Role,
  RunAgent,
  RunRecord,
  Thread,
  TimelineItem,
} from "./types.ts";
import { estimateTokens, newId, nowIso, truncateMiddle, writeFileAtomic } from "./util.ts";
import type { Workspace } from "./workspace.ts";

export type OrchestratorEvent =
  | { type: "thread"; thread: Thread }
  | { type: "delta"; threadId: string; itemId: string; delta: string }
  | { type: "threads" };

export interface OrchestratorOptions {
  ws: Workspace;
  pi: PiExecutor;
  acp: AcpExecutor;
  /** Why the model's account can't run right now (not signed in); undefined when it can. */
  unavailable: (model: ChatModel) => string | undefined;
  onEvent: (event: OrchestratorEvent) => void;
  mcpLaunch?: (runToken: string) => McpLaunch | undefined;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  token: string;
  ctx: ToolContext;
  runtime: RunAgent["runtime"];
}

interface PendingApproval {
  threadId: string;
  runId: string;
  itemId: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

export interface NewThreadInput {
  title?: string;
  /** The first message; may be empty to open a chat without sending anything. */
  task: string;
  model: ChatModel;
}

/** Timeline kinds this version renders; items left by the relay (handoffs, decisions, advisors) are dropped on load. */
const ITEM_KINDS = new Set<TimelineItem["kind"]>(["user", "notice", "run_start", "text", "tool", "approval", "run_end", "checks", "review"]);
const REVIEW_DIFF_BYTES = 16 * 1024;

export function runAgent(model: ChatModel, permissions: RunAgent["permissions"]): RunAgent {
  const route = ROUTES[model.source];
  const provider = modelProvider(model);
  return {
    id: model.source === "key" ? `key:${provider}:${model.model}` : `${model.source}:${model.model}`,
    name: `${model.name} · ${routeLabel(model)}`,
    runtime: route.runtime,
    source: model.source,
    provider,
    model: model.model,
    thinking: model.thinking,
    fast: model.fast,
    permissions,
  };
}

/** Same account, model, thinking level and fast tier. */
export function sameChatModel(a: ChatModel | undefined, b: ChatModel | undefined): boolean {
  return Boolean(a && b && a.source === b.source && a.model === b.model && (a.provider ?? "") === (b.provider ?? "") && (a.thinking ?? "") === (b.thinking ?? "") && Boolean(a.fast) === Boolean(b.fast));
}

export class Orchestrator {
  readonly ws: Workspace;
  readonly shadow: ShadowGit;
  private threads = new Map<string, Thread>();
  private active = new Map<string, ActiveRun>();
  private approvals = new Map<string, PendingApproval>();
  private writeLock?: string;
  private writeQueue: string[] = [];
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: OrchestratorOptions) {
    this.ws = options.ws;
    this.shadow = new ShadowGit(this.ws.root, this.ws.path("shadow.git"));
    for (const saved of this.ws.listThreads()) {
      if ((saved as { kind?: string }).kind === "relay") continue;
      const t = migrateThread(saved);
      let changed = t !== saved;
      if (t.status === "running" || t.status === "waiting") {
        t.status = "paused";
        this.push(t, { kind: "notice", level: "warn", text: "工作台重启，上一次回复被中断。再发一条消息即可继续。" }, false);
        for (const item of t.items) if (item.kind === "approval" && item.status === "pending") item.status = "expired";
        for (const run of t.runs) if (run.status === "running") run.status = "cancelled";
        changed = true;
      }
      if (t.access !== "read") {
        t.access = "read";
        this.push(t, { kind: "notice", level: "info", text: "工作台重启，这个对话已恢复只读。需要时重新放开。" }, false);
        changed = true;
      }
      if (changed) this.ws.saveThread(t);
      this.threads.set(t.id, t);
    }
  }

  listThreads(): Thread[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getThread(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  isBusy(): boolean {
    return this.active.size > 0;
  }

  /** Whether a run in progress here was handed `token` for the MCP server and `baton` CLI. */
  ownsToken(token: string): boolean {
    return [...this.active.values()].some((a) => a.token === token);
  }

  cursorRunCount(): number {
    return [...this.active.values()].filter((a) => a.runtime === "cursor").length;
  }

  hasApproval(approvalId: string): boolean {
    return this.approvals.has(approvalId);
  }

  // ---------- persistence & events ----------

  private save(thread: Thread, immediate = true): void {
    thread.updatedAt = nowIso();
    const flush = () => {
      this.saveTimers.delete(thread.id);
      this.ws.saveThread(thread);
    };
    const pending = this.saveTimers.get(thread.id);
    if (immediate) {
      if (pending) clearTimeout(pending);
      flush();
      this.options.onEvent({ type: "thread", thread });
    } else if (!pending) {
      this.saveTimers.set(thread.id, setTimeout(flush, 400));
    }
  }

  /** Service shutdown: cancels every run in progress, waits for them to wind down, and writes every thread to disk. */
  async stopAll(timeoutMs = 3000): Promise<void> {
    for (const id of [...this.active.keys()]) this.cancel(id);
    // A run leaves `active` before its snapshot and status bookkeeping finish, so wait on the threads themselves.
    const busy = () => this.active.size > 0 || [...this.threads.values()].some((t) => t.status === "running");
    const start = Date.now();
    while (busy() && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 50));
    for (const [id, timer] of this.saveTimers) {
      clearTimeout(timer);
      this.saveTimers.delete(id);
      const thread = this.threads.get(id);
      if (thread) this.ws.saveThread(thread);
    }
  }

  private push<T extends Omit<TimelineItem, "id" | "at">>(thread: Thread, item: T, save = true): TimelineItem {
    const full = { id: newId("it"), at: nowIso(), ...item } as unknown as TimelineItem;
    thread.items.push(full);
    if (save) this.save(thread);
    return full;
  }

  private notice(thread: Thread, level: "info" | "warn" | "error", text: string): void {
    this.push(thread, { kind: "notice", level, text });
  }

  // ---------- threads ----------

  /** A new chat on a model, read-only until the user opens access. */
  createThread(input: NewThreadInput): Thread {
    const message = input.task.trim();
    const title = input.title?.trim() || message.replace(/\s+/g, " ").slice(0, 40) || "新对话";
    const thread: Thread = {
      id: newId("th"),
      title,
      status: "idle",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      summary: "",
      runs: [],
      items: [],
      model: input.model,
      access: "read",
      notes: [],
    };
    this.threads.set(thread.id, thread);
    this.save(thread);
    this.options.onEvent({ type: "threads" });
    if (message) this.postMessage(thread.id, message);
    return thread;
  }

  /** Sets what this chat's model may do. Lasts until changed or the service restarts. */
  setAccess(threadId: string, access: ChatAccess): void {
    const thread = this.mustThread(threadId);
    if (this.active.has(threadId)) throw new Error("正在回复，等这一轮结束再切换权限");
    if (thread.access === access) return;
    thread.access = access;
    const scope = "只对这个对话有效，服务重启后恢复只读。";
    const text = {
      read: "已改成只读：模型不能改文件、不能执行命令。",
      ask: `已改成「每次问我」：每次改文件、执行命令前都会先问你，回复前自动快照。${scope}`,
      allow: `已改成「允许直接改」：模型可以直接改文件、执行命令（危险命令黑名单和工作区边界照常生效），每次回复前自动快照，可以随时回滚。${scope}`,
    }[access];
    this.notice(thread, access === "allow" ? "warn" : "info", text);
  }

  deleteThread(id: string): void {
    if (this.active.has(id)) throw new Error("对话正在运行，先取消");
    this.threads.delete(id);
    this.writeQueue = this.writeQueue.filter((q) => q !== id);
    fs.rmSync(this.ws.path("threads", `${id}.json`), { force: true });
    this.options.onEvent({ type: "threads" });
  }

  /** A user message, answered by `model` (switching the chat's model) or by the chat's current model. */
  postMessage(threadId: string, text: string, model?: ChatModel): void {
    const thread = this.mustThread(threadId);
    const body = text.trim();
    if (!body) return;
    if (!model && !thread.model) throw new Error("请先选择一个模型");
    this.switchModel(thread, model);
    this.push(thread, { kind: "user", text: body });
    thread.notes.push(body);
    if (this.active.has(thread.id) || thread.status === "waiting" || thread.status === "running") {
      this.notice(thread, "info", "已记下，这一轮结束后接着回复。");
      return;
    }
    void this.beginChat(thread);
  }

  private switchModel(thread: Thread, model: ChatModel | undefined): void {
    if (!model || sameChatModel(model, thread.model)) return;
    const before = thread.model;
    const sameModel = Boolean(before && before.source === model.source && before.model === model.model && (before.provider ?? "") === (model.provider ?? ""));
    if (before && sameModel) {
      thread.model = model;
      const notes: string[] = [];
      if ((before.thinking ?? "") !== (model.thinking ?? "")) notes.push(`思考档位从「${thinkingLabel(before.thinking)}」改成「${thinkingLabel(model.thinking)}」。`);
      if (Boolean(before.fast) !== Boolean(model.fast)) notes.push(model.fast ? "快速已打开。" : "快速已关闭。");
      if (notes.length) this.push(thread, { kind: "notice", level: "info", text: notes.join("") }, false);
      return;
    }
    const previous = thread.model ? runAgent(thread.model, REVIEW_PERMISSIONS).name : undefined;
    thread.model = model;
    const name = runAgent(model, REVIEW_PERMISSIONS).name;
    this.push(thread, { kind: "notice", level: "info", text: `换成 ${name} 接着聊${previous ? `（之前是 ${previous}）` : ""}。它会看到前面对话的摘要和最近几轮原文。` }, false);
  }

  /** Answers the queued messages with the chat's model, if its account allows. */
  private async beginChat(thread: Thread): Promise<void> {
    const model = thread.model;
    if (!model) return;
    const agent = runAgent(model, accessPermissions(thread.access));
    const reason = this.options.unavailable(model);
    if (reason) {
      thread.status = "paused";
      this.notice(thread, "error", `${agent.name} 现在不能回复：${reason}。换一个模型再发一次即可。`);
      return;
    }
    if (this.active.has(thread.id)) return;
    const writes = canWrite(agent.permissions) || agent.permissions.exec !== "deny";
    if (writes && this.writeLock && this.writeLock !== thread.id) {
      thread.status = "waiting";
      if (!this.writeQueue.includes(thread.id)) this.writeQueue.push(thread.id);
      this.notice(thread, "info", "同一工作区同时只能有一个对话在改文件，已排队，等另一个对话这一轮结束后自动开始。");
      return;
    }
    thread.status = "running";
    if (writes) this.writeLock = thread.id;
    let run: RunRecord | undefined;
    try {
      const task = thread.notes.join("\n\n");
      run = await this.executeRun(thread, agent, "chat", { task, prompt: task });
    } finally {
      if (this.writeLock === thread.id) {
        this.writeLock = undefined;
        const next = this.writeQueue.shift();
        const t = next ? this.threads.get(next) : undefined;
        if (t) void this.beginChat(t);
      }
    }
    if (run && run.status !== "cancelled" && thread.notes.length) await this.beginChat(thread);
  }

  /**
   * Another model checks the chat's changes since the last review: the harness runs the checks
   * first, the reviewer reads only and must call submit_review. A failed check is never a pass.
   */
  async review(threadId: string, model: ChatModel): Promise<RunRecord | undefined> {
    const { thread, changed } = this.checkReview(threadId, model);
    const agent = runAgent(model, REVIEW_PERMISSIONS);

    const files = [...new Set(changed.flatMap((r) => r.changedFiles))];
    const authors = [...new Set(changed.map((r) => r.family))];
    const family = modelFamily(model.model, modelProvider(model));
    const same = authors.includes(family) ? `（和改动作者同属 ${family} 家族，可能看不出自己的盲点）` : "";
    thread.status = "running";
    this.notice(thread, "info", `请 ${agent.name} 只读检查这个对话里的改动${same}：先跑检查命令，再读改动。`);
    const checks = await runChecks(this.ws.settings().checks, { cwd: this.ws.root, changedFiles: files });
    if (checks.length) this.push(thread, { kind: "checks", results: checks });

    const from = changed[0]!.snapshotBefore!;
    const to = changed.at(-1)!.snapshotAfter;
    const diff = await this.shadow.diff(from, to).catch(() => "");
    const extra = [
      formatChecks(checks),
      `## 改动的文件\n${files.map((f) => `- ${f}`).join("\n")}`,
      diff.trim() ? `## 改动（diff）\n\`\`\`diff\n${truncateMiddle(diff, REVIEW_DIFF_BYTES).text}\n\`\`\`` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const task = changed.map((r) => r.prompt?.trim()).filter(Boolean).join("\n\n");
    const run = await this.executeRun(thread, agent, "review", { task, extra, checks, reviewed: changed.map((r) => r.id) });
    if (thread.notes.length) await this.beginChat(thread);
    return run;
  }

  /** Throws when `review` could not start now; returns the chat runs it would check. */
  checkReview(threadId: string, model: ChatModel): { thread: Thread; changed: RunRecord[] } {
    const thread = this.mustThread(threadId);
    if (this.active.has(threadId) || thread.status === "waiting" || thread.status === "running") throw new Error("正在运行，等这一轮结束再检查");
    const lastReview = thread.runs.findLastIndex((r) => r.role === "review" && r.review);
    const changed = thread.runs.slice(lastReview + 1).filter((r) => r.role === "chat" && r.changedFiles.length && r.snapshotBefore);
    if (!changed.length) throw new Error(lastReview >= 0 ? "上次检查之后这个对话没有新的改动" : "这个对话还没有改动可以检查");
    const reason = this.options.unavailable(model);
    if (reason) throw new Error(`${runAgent(model, REVIEW_PERMISSIONS).name} 现在不能检查：${reason}`);
    return { thread, changed };
  }

  cancel(threadId: string): void {
    const active = this.active.get(threadId);
    if (active) {
      active.controller.abort();
      for (const [id, a] of this.approvals) if (a.runId === active.runId) this.resolveApproval(id, false, "denied");
    }
    const queued = this.writeQueue.includes(threadId);
    this.writeQueue = this.writeQueue.filter((q) => q !== threadId);
    const thread = this.threads.get(threadId);
    if (thread && !active && queued) {
      thread.status = "paused";
      this.notice(thread, "info", "已取消排队。");
    }
  }

  private mustThread(id: string): Thread {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`找不到对话 ${id}`);
    return thread;
  }

  // ---------- approvals ----------

  private requestApproval(thread: Thread, runId: string, req: { risk: Risk; title: string; preview: string }): Promise<boolean> {
    const approvalId = newId("ap");
    const item = this.push(thread, { kind: "approval", runId, approvalId, risk: req.risk, title: req.title, preview: truncateMiddle(req.preview, 8000).text, status: "pending" });
    this.ws.audit({ run: runId, approval: approvalId, risk: req.risk, preview: req.preview.slice(0, 500) });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.resolveApproval(approvalId, false, "expired"), this.ws.settings().approvalTimeoutSec * 1000);
      this.approvals.set(approvalId, { threadId: thread.id, runId, itemId: item.id, resolve, timer });
    });
  }

  respondApproval(approvalId: string, allow: boolean): void {
    if (!this.approvals.has(approvalId)) throw new Error("这个审批已经处理过或已超时");
    this.resolveApproval(approvalId, allow, allow ? "allowed" : "denied");
  }

  private resolveApproval(approvalId: string, allow: boolean, status: "allowed" | "denied" | "expired"): void {
    const pending = this.approvals.get(approvalId);
    if (!pending) return;
    this.approvals.delete(approvalId);
    clearTimeout(pending.timer);
    const thread = this.threads.get(pending.threadId);
    const item = thread?.items.find((i) => i.id === pending.itemId);
    if (thread && item && item.kind === "approval") {
      item.status = status;
      this.save(thread);
    }
    this.ws.audit({ approval: approvalId, status });
    pending.resolve(allow);
  }

  // ---------- running ----------

  private async executeRun(
    thread: Thread,
    agent: RunAgent,
    role: Role,
    input: { task: string; prompt?: string; extra?: string; checks?: RunRecord["checks"]; reviewed?: string[] },
  ): Promise<RunRecord | undefined> {
    const settings = this.ws.settings();
    const consumedNotes = role === "chat" ? thread.notes.length : 0;
    const previous = [...thread.runs].reverse().find((r) => r.agentId === agent.id && r.snapshotAfter);
    const diffSummary = role === "chat" && previous?.snapshotAfter ? await this.shadow.diffStat(previous.snapshotAfter).catch(() => "") : "";
    const briefing = compileBriefing({ ws: this.ws, agent, role, thread, task: input.task, extra: input.extra, diffSummary });
    if (briefing.overBudget) {
      const biggest = [...briefing.sections].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
      thread.status = "paused";
      this.notice(
        thread,
        "error",
        `开场上下文 ${(briefing.bytes / 1024).toFixed(1)}KB，超过预算 ${(briefing.budget / 1024).toFixed(0)}KB，运行没有启动。最大的几段：\n${biggest.map((s) => `- ${s.title}（${s.source}）${(s.bytes / 1024).toFixed(1)}KB`).join("\n")}`,
      );
      return undefined;
    }

    const run: RunRecord = {
      id: newId("run"),
      threadId: thread.id,
      agentId: agent.id,
      agentName: agent.name,
      source: agent.source,
      provider: agent.source === "key" ? agent.provider : undefined,
      runtime: agent.runtime,
      model: agent.model,
      family: modelFamily(agent.model, agent.provider),
      thinking: agent.thinking,
      fast: agent.fast || undefined,
      role,
      status: "running",
      startedAt: nowIso(),
      briefingHash: briefing.hash,
      briefingBytes: briefing.bytes,
      changedFiles: [],
      finalText: "",
      prompt: input.prompt,
      checks: input.checks,
      reviewed: input.reviewed,
    };
    try {
      run.snapshotBefore = await this.shadow.snapshot(`before ${run.id} ${agent.id} ${role}`);
    } catch (error) {
      this.notice(thread, "warn", `快照失败（无法回滚这次运行）：${(error as Error).message}`);
    }
    thread.runs.push(run);
    thread.status = "running";
    this.ws.audit({ run: run.id, thread: thread.id, agent: agent.id, role, briefingHash: briefing.hash, briefingBytes: briefing.bytes });
    this.writeBriefingRecord(run, briefing);
    this.push(thread, { kind: "run_start", runId: run.id, agentId: agent.id, agentName: agent.name, role, model: agent.model, runtime: agent.runtime, briefingBytes: briefing.bytes });

    let verdict: ReviewVerdict | undefined;
    const touched = new Set<string>();
    const controller = new AbortController();
    const token = randomBytes(18).toString("base64url");
    const ctx: ToolContext = {
      ws: this.ws,
      agent,
      run: { id: run.id, threadId: thread.id, role },
      signal: controller.signal,
      requestApproval: (req) => this.requestApproval(thread, run.id, req),
      onReview: (v) => {
        verdict = v;
      },
      onFileWrite: (rel) => touched.add(rel),
    };
    this.active.set(thread.id, { runId: run.id, controller, token, ctx, runtime: agent.runtime });

    let textItem: Extract<TimelineItem, { kind: "text" }> | undefined;
    const toolItems = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
    const emit = (e: ExecutorEvent) => {
      if (e.type === "text_delta") {
        if (!textItem || Boolean(textItem.thinking) !== Boolean(e.thinking)) {
          textItem = this.push(thread, { kind: "text", runId: run.id, text: "", thinking: e.thinking || undefined }) as typeof textItem;
        }
        textItem!.text += e.delta;
        this.options.onEvent({ type: "delta", threadId: thread.id, itemId: textItem!.id, delta: e.delta });
        this.save(thread, false);
      } else if (e.type === "text_end") {
        textItem = undefined;
        this.save(thread, false);
      } else if (e.type === "tool_start") {
        textItem = undefined;
        const args = typeof e.args === "string" ? e.args : JSON.stringify(e.args ?? {}, null, 1);
        const item = this.push(thread, { kind: "tool", runId: run.id, tool: e.tool, args: truncateMiddle(args, 6000).text, status: "running" }) as Extract<TimelineItem, { kind: "tool" }>;
        toolItems.set(e.id, item);
      } else if (e.type === "tool_end") {
        const item = toolItems.get(e.id);
        if (item) {
          item.status = e.ok ? "ok" : /^(用户拒绝|权限拒绝|命令被拒绝)/.test(e.result) ? "denied" : "error";
          item.result = truncateMiddle(e.result, 6000).text;
          item.tokens = estimateTokens(e.result);
          this.save(thread);
        }
      } else if (e.type === "notice") {
        textItem = undefined;
        this.notice(thread, e.level, e.text);
      }
    };

    const executor = agent.runtime === "cursor" ? this.options.acp : this.options.pi;
    const result = await executor.run({
      runId: run.id,
      agent,
      role,
      thread,
      briefing,
      prompt: input.task || "（请开始）",
      tools: toolsFor(agent, role),
      toolContext: ctx,
      workspaceRoot: this.ws.root,
      sessionDir: this.ws.path("sessions", agent.runtime),
      signal: controller.signal,
      emit,
      requestApproval: ctx.requestApproval,
      hasVerdict: () => verdict !== undefined,
      mcp: agent.runtime === "cursor" ? this.options.mcpLaunch?.(token) : undefined,
      cursorCommand: settings.cursor.command,
    });
    this.active.delete(thread.id);
    for (const [id, a] of this.approvals) if (a.runId === run.id) this.resolveApproval(id, false, "expired");

    run.status = result.status;
    run.finalText = result.finalText;
    run.error = result.error;
    run.usage = result.usage;
    run.context = result.context;
    run.endedAt = nowIso();
    try {
      run.snapshotAfter = await this.shadow.snapshot(`after ${run.id}`);
      run.changedFiles = run.snapshotBefore ? await this.shadow.changedFiles(run.snapshotBefore, run.snapshotAfter) : [...touched];
    } catch {
      run.changedFiles = [...touched];
    }

    if (result.status === "failed") this.push(thread, { kind: "notice", level: "error", text: `运行失败：${result.error ?? "未知错误"}` }, false);
    this.push(thread, { kind: "run_end", runId: run.id, status: run.status, changedFiles: run.changedFiles, usage: run.usage, error: run.error }, false);
    if (role === "review") this.finishReview(thread, run, verdict);
    if (role === "chat") {
      thread.notes = thread.notes.slice(consumedNotes);
      thread.summary = rollChatSummary(thread);
    }
    thread.status = "idle";
    this.save(thread);
    return run;
  }

  private finishReview(thread: Thread, run: RunRecord, verdict: ReviewVerdict | undefined): void {
    if (run.status === "cancelled") return;
    if (!verdict) {
      this.push(thread, { kind: "notice", level: "warn", text: `${run.agentName} 没有给出检查结论${run.status === "failed" ? "（运行失败）" : ""}。可以换一个模型再检查一次。` }, false);
      return;
    }
    const failed = (run.checks ?? []).filter((c) => c.status !== "pass");
    let overruled: string | undefined;
    if (verdict.verdict === "pass" && failed.length) {
      const names = failed.map((c) => c.name).join("、");
      overruled = `${run.agentName} 给出了通过，但检查命令「${names}」没有通过，按不通过记。`;
      verdict = { verdict: "fail", issues: [...verdict.issues, `检查命令没有通过：${names}`] };
    }
    run.review = verdict;
    this.push(thread, { kind: "review", runId: run.id, agentName: run.agentName, verdict, overruled }, false);
  }

  private writeBriefingRecord(run: RunRecord, briefing: Briefing): void {
    writeFileAtomic(this.ws.path("sessions", "briefings", `${run.id}.md`), `<!-- hash ${briefing.hash} -->\n${briefing.text}\n`);
  }

  // ---------- runs: diff & rollback ----------

  findRun(runId: string): { thread: Thread; run: RunRecord } | undefined {
    for (const thread of this.threads.values()) {
      const run = thread.runs.find((r) => r.id === runId);
      if (run) return { thread, run };
    }
    return undefined;
  }

  async runDiff(runId: string): Promise<string> {
    const found = this.findRun(runId);
    if (!found?.run.snapshotBefore) throw new Error("这次运行没有快照");
    return this.shadow.diff(found.run.snapshotBefore, found.run.snapshotAfter);
  }

  /** Rewind: restore the work tree to before the run. Later runs' changes are lost too. */
  async rollback(runId: string): Promise<string[]> {
    const found = this.findRun(runId);
    if (!found?.run.snapshotBefore) throw new Error("这次运行没有快照");
    if (this.isBusy()) throw new Error("有运行在进行，先取消再回滚");
    await this.shadow.snapshot(`before rollback to ${runId}`);
    const files = await this.shadow.rollback(found.run.snapshotBefore);
    this.notice(found.thread, "warn", `已回滚到「${found.run.agentName}」这次回复之前，恢复了 ${files.length} 个文件。`);
    return files;
  }

  // ---------- inspector & bridge ----------

  /** What `model` would receive at the start of a run: in `threadId` when given, with that chat's access. */
  async briefingPreview(model: ChatModel, role: Role, threadId?: string): Promise<Briefing> {
    const thread = threadId ? this.threads.get(threadId) : undefined;
    const agent = runAgent(model, role === "review" ? REVIEW_PERMISSIONS : accessPermissions(thread?.access ?? "read"));
    const previous = thread ? [...thread.runs].reverse().find((r) => r.agentId === agent.id && r.snapshotAfter) : undefined;
    const diffSummary = role === "chat" && previous?.snapshotAfter ? await this.shadow.diffStat(previous.snapshotAfter).catch(() => "") : "";
    const task = role === "chat" ? thread?.notes.join("\n\n") || "（运行时这里是你的消息）" : "（运行时这里是对话里提出的要求）";
    const extra = role === "review" ? "（运行时这里是检查命令结果、改动的文件和 diff）" : undefined;
    return compileBriefing({ ws: this.ws, agent, role, thread, task, extra, diffSummary });
  }

  /** Tool calls from the MCP server or the `baton` CLI. */
  async bridgeTool(token: string | undefined, toolName: string, args: unknown, options: { guessCursorRun?: boolean } = {}): Promise<ToolOutput> {
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (!tool) return { text: `未知工具：${toolName}`, isError: true };
    let active = token ? [...this.active.values()].find((a) => a.token === token) : undefined;
    if (!active && !token && options.guessCursorRun !== false) {
      const cursorRuns = [...this.active.values()].filter((a) => a.runtime === "cursor");
      if (cursorRuns.length === 1) active = cursorRuns[0];
    }
    if (token && !active) return { text: "运行令牌无效或运行已结束", isError: true };
    if (active) return runTool(tool, args, active.ctx);
    if (tool.name === "submit_review") return { text: "当前没有进行中的检查，无法给出结论", isError: true };
    const user: RunAgent = {
      id: "user",
      name: "用户",
      runtime: "pi",
      source: "demo",
      provider: "user",
      model: "user",
      permissions: { write: "deny", exec: "deny", network: "deny" },
    };
    const ctx: ToolContext = {
      ws: this.ws,
      agent: user,
      run: { id: "manual", threadId: "", role: "chat" },
      requestApproval: async () => false,
      onReview: () => {},
      onFileWrite: () => {},
    };
    return runTool(tool, args, ctx);
  }

  /** Per model: chat replies, reviews it gave, and how its changes fared when another model checked them. */
  stats(): StatRow[] {
    const rows = new Map<string, StatRow>();
    const row = (run: RunRecord) => {
      const source = run.source ?? sourceOf(run);
      const key = run.provider ? `${run.runtime}:${run.provider}:${run.model}` : `${run.runtime}:${run.model}`;
      let r = rows.get(key);
      if (!r) {
        r = { key, runtime: run.runtime, source, provider: run.provider, account: run.source === "key" ? run.agentName.split(" · ").at(-1) : undefined, model: run.model, family: run.family, runs: 0, succeeded: 0, failed: 0, changes: 0, reviewsGiven: 0, reviewedPass: 0, reviewedFail: 0, costUsd: 0, tokens: 0 };
        rows.set(key, r);
      }
      return r;
    };
    for (const thread of this.threads.values()) {
      const byId = new Map(thread.runs.map((r) => [r.id, r]));
      for (const run of thread.runs) {
        const r = row(run);
        r.runs++;
        if (run.status === "succeeded") r.succeeded++;
        if (run.status === "failed") r.failed++;
        if (run.role === "chat" && run.changedFiles.length) r.changes++;
        r.costUsd += run.usage?.costUsd ?? 0;
        r.tokens += run.usage?.totalTokens ?? 0;
        if (run.role !== "review" || !run.review) continue;
        r.reviewsGiven++;
        const authors = new Set((run.reviewed ?? []).map((id) => byId.get(id)).filter((a): a is RunRecord => a !== undefined).map(row));
        for (const author of authors) {
          if (run.review.verdict === "pass") author.reviewedPass++;
          else author.reviewedFail++;
        }
      }
    }
    return [...rows.values()];
  }
}

export interface StatRow {
  key: string;
  runtime: string;
  source: CredentialSource;
  /** Key routes: the account's Pi provider and label. */
  provider?: string;
  account?: string;
  model: string;
  family: string;
  /** Chat replies and reviews. */
  runs: number;
  succeeded: number;
  failed: number;
  /** Chat replies that changed files. */
  changes: number;
  reviewsGiven: number;
  /** Reviews by other models of this model's changes. */
  reviewedPass: number;
  reviewedFail: number;
  costUsd: number;
  tokens: number;
}

/** Runs recorded before chat-first carry no source; the runtime and model family still tell the route. */
function sourceOf(run: RunRecord): CredentialSource {
  if (run.runtime === "cursor") return "cursor";
  if (run.family === "gpt") return "chatgpt";
  if (run.family === "deepseek") return "key";
  return "demo";
}

/** Before any API key could be added, DeepSeek was its own route; it is now the key account on provider "deepseek". */
function migrateDeepSeek<T extends { source?: string; provider?: string }>(x: T): boolean {
  if ((x.source as string) !== "deepseek") return false;
  x.source = "key";
  x.provider = "deepseek";
  return true;
}

const CHAT_SUMMARY_MAX_TURNS = 30;

/** One line per chat turn older than the ones quoted verbatim; the oldest drop off past a cap. */
function rollChatSummary(thread: Thread): string {
  const older = chatTurns(thread).slice(0, -CHAT_RECENT_TURNS);
  const oneLine = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  };
  const lines = older.slice(-CHAT_SUMMARY_MAX_TURNS).map((r) => `- 用户：${oneLine(r.prompt ?? "", 80)} → ${r.agentName}：${oneLine(r.finalText || "（没有回复）", 160)}`);
  const dropped = older.length - lines.length;
  return [dropped > 0 ? `（更早的 ${dropped} 轮已省略）` : "", ...lines].filter(Boolean).join("\n");
}

/**
 * Chats saved before chat-first named their model through an agent card, which is gone; they stay
 * readable and answer again once the user picks a model.
 */
function migrateThread(saved: Thread): Thread {
  const t = saved as Thread & { kind?: string; access?: ChatAccess };
  const items = (t.items ?? []).filter((i) => ITEM_KINDS.has(i.kind));
  let moved = t.model ? migrateDeepSeek(t.model) : false;
  if (moved && t.model) t.model.account ??= "DeepSeek";
  for (const run of t.runs ?? []) moved = migrateDeepSeek(run) || moved;
  if (t.access && t.notes && items.length === t.items.length) return moved ? { ...t } : t;
  for (const item of items) if (item.kind === "run_start" && !item.role) (item as { role: Role }).role = "chat";
  return {
    id: t.id,
    title: t.title,
    status: t.status === "running" || t.status === "waiting" || t.status === "paused" ? t.status : "idle",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    summary: t.summary ?? "",
    runs: (t.runs ?? []).filter((r) => r.role === "chat" || r.role === "review"),
    items,
    model: t.model,
    access: t.access ?? "read",
    notes: t.notes ?? [],
  };
}

