import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { formatChecks, runChecks } from "./checks.ts";
import { CHAT_RECENT_TURNS, STAGE_LABEL, chatTurns, compileBriefing } from "./context.ts";
import type { AcpExecutor } from "./executors/acp.ts";
import type { PiExecutor } from "./executors/pi.ts";
import type { ExecutorEvent, McpLaunch } from "./executors/types.ts";
import { modelFamily } from "./families.ts";
import { compactionProgress, mergeProgress, saveHandoff } from "./memory.ts";
import { canWrite, permissionLevel } from "./permissions.ts";
import {
  ADVISOR_TRIGGER_LABEL,
  USD_TO_CNY,
  advisorTrigger,
  chatPermissions,
  isStall,
  lastRun,
  needsEscalationApproval,
  nextTransition,
  roleForStage,
  selectAgent,
  type Transition,
} from "./router.ts";
import { RELAY_DRAFT_PROMPT, fallbackDraft, parseRelayDraft } from "./promote.ts";
import { ShadowGit } from "./snapshot.ts";
import { MCP_TOOLS, runTool, toolsFor, type ToolContext, type ToolOutput } from "./tools.ts";
import type {
  AdvisorCard,
  AgentCard,
  Briefing,
  Handoff,
  PendingDecision,
  RelayDraft,
  Risk,
  Role,
  RunRecord,
  Stage,
  Thread,
  ThreadKind,
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
  available: (agent: AgentCard) => boolean;
  onEvent: (event: OrchestratorEvent) => void;
  mcpLaunch?: (runToken: string) => McpLaunch | undefined;
  /** Summarizes a transcript into a handoff when an agent did not write one (DeepSeek when configured). */
  summarize?: (prompt: string) => Promise<string | undefined>;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  token: string;
  ctx: ToolContext;
  runtime: AgentCard["runtime"];
}

interface PendingApproval {
  threadId: string;
  runId: string;
  itemId: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

interface QueuedRun {
  agentId: string;
  stage: Stage;
  sendBack: boolean;
}

export interface NewThreadInput {
  kind?: ThreadKind;
  title: string;
  /** Relay: the task. Chat: the first message (optional). */
  task: string;
  acceptance: string[];
  stage?: Stage;
  /** Relay: first agent for the starting stage. Chat: the agent to talk to (required). */
  agentId?: string;
}

export class Orchestrator {
  readonly ws: Workspace;
  readonly shadow: ShadowGit;
  private threads = new Map<string, Thread>();
  private active = new Map<string, ActiveRun>();
  private approvals = new Map<string, PendingApproval>();
  private writeLock?: string;
  private writeQueue: { threadId: string; run: QueuedRun }[] = [];
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: OrchestratorOptions) {
    this.ws = options.ws;
    this.shadow = new ShadowGit(this.ws.root, this.ws.path("shadow.git"));
    for (const thread of this.ws.listThreads()) {
      const t = migrateThread(thread);
      let changed = false;
      if (t.status === "running" || t.status === "waiting") {
        t.status = "paused";
        const text = t.kind === "chat" ? "工作台重启，上一次回复被中断。再发一条消息即可继续。" : "工作台重启，上一次运行被中断。发消息即可从当前阶段继续。";
        this.push(t, { kind: "notice", level: "warn", text }, false);
        for (const item of t.items) if (item.kind === "approval" && item.status === "pending") item.status = "expired";
        for (const run of t.runs) if (run.status === "running") run.status = "cancelled";
        changed = true;
      }
      if (t.promotion?.status === "drafting") {
        t.notes = t.notes.filter((n) => n !== RELAY_DRAFT_PROMPT);
        t.promotion = { ...t.promotion, status: "failed", error: "工作台重启，整理被中断了" };
        changed = true;
      }
      if (t.kind === "chat" && t.approvedLevel >= 2) {
        t.approvedLevel = 0;
        this.push(t, { kind: "notice", level: "info", text: "工作台重启，已收回这个对话的写权限。需要时重新开放。" }, false);
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

  createThread(input: NewThreadInput): Thread {
    if (input.kind === "chat") return this.createChat(input);
    return this.createRelay(input);
  }

  private createRelay(input: NewThreadInput, fromChat?: Thread): Thread {
    const title = input.title.trim();
    const acceptance = input.acceptance.map((a) => a.trim()).filter(Boolean);
    if (!title) throw new Error("请填写标题");
    if (!acceptance.length) throw new Error("至少需要一条验收标准");
    const settings = this.ws.settings();
    const thread = newThread({
      kind: "relay",
      title,
      task: input.task.trim() || title,
      acceptance,
      stage: input.stage ?? "plan",
      approvedLevel: settings.confirm.planToImplement ? 0 : 2,
    });
    if (input.agentId) thread.pinnedAgents[thread.stage] = input.agentId;
    this.threads.set(thread.id, thread);
    if (fromChat) {
      thread.fromChat = fromChat.id;
      this.push(thread, { kind: "notice", level: "info", text: `由对话「${fromChat.title}」转来，任务和验收标准已经你确认。` }, false);
    }
    this.push(thread, { kind: "user", text: `${thread.task}\n\n验收标准：\n${acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}` }, false);
    this.save(thread);
    this.options.onEvent({ type: "threads" });
    void this.begin(thread, thread.stage, { userInitiated: true });
    return thread;
  }

  /** A chat thread: no stages, no acceptance criteria; read-only until the user opens writes. */
  private createChat(input: NewThreadInput): Thread {
    const agent = input.agentId ? this.ws.getAgent(input.agentId) : undefined;
    if (!agent) throw new Error("请选择一个 agent");
    const message = input.task.trim();
    const title = input.title.trim() || message.replace(/\s+/g, " ").slice(0, 40) || "新对话";
    const thread = newThread({ kind: "chat", title, task: title, acceptance: [], stage: "chat", approvedLevel: 0 });
    thread.pinnedAgents.chat = agent.id;
    this.threads.set(thread.id, thread);
    this.save(thread);
    this.options.onEvent({ type: "threads" });
    if (message) this.postMessage(thread.id, message);
    return thread;
  }

  /** Opens or closes writes (and commands) for one chat thread. Lasts until closed or the service restarts. */
  setChatWrite(threadId: string, allow: boolean): void {
    const thread = this.mustThread(threadId);
    if (thread.kind !== "chat") throw new Error("只有对话线程可以临时开放写权限");
    if (this.active.has(threadId)) throw new Error("正在回复，等这一轮结束再切换写权限");
    if ((thread.approvedLevel >= 2) === allow) return;
    thread.approvedLevel = allow ? 2 : 0;
    this.notice(
      thread,
      allow ? "warn" : "info",
      allow
        ? "已为这个对话开放写权限：agent 可以改文件、执行命令（命令照常审批），每次回复前自动快照，可以随时回滚。只对本线程有效，服务重启后自动收回。"
        : "已收回写权限，对话恢复只读。",
    );
  }

  deleteThread(id: string): void {
    if (this.active.has(id)) throw new Error("线程正在运行，先取消");
    this.threads.delete(id);
    fs.rmSync(this.ws.path("threads", `${id}.json`), { force: true });
    this.options.onEvent({ type: "threads" });
  }

  /**
   * User message. Relay: queued as a note for the next run, or restarts a paused/finished thread.
   * Chat: answered by `agentId` (switching the thread's agent) or by the thread's current agent.
   */
  postMessage(threadId: string, text: string, agentId?: string): void {
    const thread = this.mustThread(threadId);
    const body = text.trim();
    if (!body) return;
    if (thread.kind === "chat") return this.postChat(thread, body, agentId);
    if (agentId) throw new Error("接力线程由工作台按规则挑选 agent，不能指定回复的 agent");
    this.push(thread, { kind: "user", text: body });
    thread.notes.push(body);
    if (this.active.has(threadId) || thread.pending) {
      this.notice(thread, "info", thread.pending ? "已记下，会带给下一次运行。" : "已记下，会在当前运行结束后带给下一次运行。");
      return;
    }
    const stage: Stage = thread.stage === "done" ? "implement" : thread.stage;
    thread.stalls = 0;
    void this.begin(thread, stage, { userInitiated: true });
  }

  private switchChatAgent(thread: Thread, agentId: string | undefined): void {
    if (!agentId || agentId === thread.pinnedAgents.chat) return;
    const agent = this.ws.getAgent(agentId);
    if (!agent) throw new Error(`找不到 agent ${agentId}`);
    const previous = thread.pinnedAgents.chat ? this.ws.getAgent(thread.pinnedAgents.chat)?.name : undefined;
    thread.pinnedAgents.chat = agent.id;
    this.push(thread, { kind: "notice", level: "info", text: `换成 ${agent.name} 接着聊${previous ? `（之前是 ${previous}）` : ""}。它会看到前面对话的摘要和最近几轮原文。` }, false);
  }

  private postChat(thread: Thread, body: string, agentId?: string): void {
    this.switchChatAgent(thread, agentId);
    this.push(thread, { kind: "user", text: body });
    thread.notes.push(body);
    if (this.active.has(thread.id) || thread.status === "waiting") {
      this.notice(thread, "info", "已记下，这一轮回复结束后接着回复。");
      return;
    }
    void this.beginChat(thread);
  }

  /** Runs the thread's chosen agent on the queued messages, if its account and quota allow. */
  private async beginChat(thread: Thread): Promise<void> {
    const agentId = thread.pinnedAgents.chat;
    const selection = selectAgent("chat", { thread, agents: this.ws.listAgents(), settings: this.ws.settings(), available: this.options.available });
    const agent = selection.candidates.find((a) => a.id === agentId);
    if (!agent) {
      const known = agentId ? this.ws.getAgent(agentId) : undefined;
      const reason = selection.rejected.find((r) => r.id === agentId)?.reason ?? "找不到这个 agent";
      thread.status = "paused";
      this.notice(thread, "error", `${known?.name ?? agentId ?? "agent"} 现在不能回复：${reason}。换一个 agent 再发一次即可。`);
      if (thread.promotion?.status === "drafting") {
        thread.notes = thread.notes.filter((n) => n !== RELAY_DRAFT_PROMPT);
        thread.promotion = { ...thread.promotion, status: "failed", error: `${known?.name ?? "agent"} 现在不能整理：${reason}` };
        this.save(thread);
      }
      return;
    }
    thread.status = "running";
    await this.startRun(thread, agent, "chat", { sendBack: false });
  }

  /**
   * Chat → relay, step 1: the chat agent drafts a relay task and acceptance criteria from the
   * conversation. Nothing starts until the user confirms the draft.
   */
  promoteChat(threadId: string, agentId?: string): void {
    const thread = this.mustThread(threadId);
    if (thread.kind !== "chat") throw new Error("只有对话线程可以转成接力线程");
    if (this.active.has(threadId) || thread.status === "waiting") throw new Error("正在回复，等这一轮结束再转");
    if (thread.notes.length) throw new Error("还有没回复的消息，等回复后再转");
    if (!chatTurns(thread).some((r) => r.status === "succeeded")) throw new Error("先聊几句，再把讨论清楚的事转成接力线程");
    this.switchChatAgent(thread, agentId);
    const agent = thread.pinnedAgents.chat ? this.ws.getAgent(thread.pinnedAgents.chat) : undefined;
    if (!agent) throw new Error("请选择一个 agent");
    thread.promotion = { status: "drafting", agentId: agent.id, draft: fallbackDraft(thread) };
    this.notice(thread, "info", `请 ${agent.name} 根据前面的对话整理接力任务和验收标准。整理好后由你确认，确认前不会开始接力。`);
    thread.notes.push(RELAY_DRAFT_PROMPT);
    void this.beginChat(thread);
  }

  /** Chat → relay, step 2: starts the relay with the confirmed (and possibly edited) draft. */
  confirmPromotion(threadId: string, draft: RelayDraft & { stage?: Stage }): Thread {
    const chat = this.mustThread(threadId);
    if (chat.kind !== "chat" || !chat.promotion) throw new Error("这个对话没有待确认的接力任务");
    if (chat.promotion.status === "drafting") throw new Error("还在整理，等整理完再确认");
    const relay = this.createRelay({ kind: "relay", title: draft.title, task: draft.task, acceptance: draft.acceptance ?? [], stage: draft.stage }, chat);
    chat.relays = [...(chat.relays ?? []), relay.id];
    chat.promotion = undefined;
    this.notice(chat, "info", `已转成接力线程「${relay.title}」，接力已开始。`);
    this.save(chat);
    return relay;
  }

  discardPromotion(threadId: string): void {
    const thread = this.mustThread(threadId);
    if (!thread.promotion) return;
    if (thread.promotion.status === "drafting") throw new Error("还在整理，先取消这次回复");
    thread.promotion = undefined;
    this.save(thread);
  }

  private finishDraft(thread: Thread, run: RunRecord): void {
    const promotion = thread.promotion!;
    const draft = run.status === "succeeded" ? parseRelayDraft(run.finalText) : undefined;
    if (draft) {
      thread.promotion = { ...promotion, status: "ready", runId: run.id, draft };
      this.notice(thread, "info", "接力任务草稿整理好了，请核对、修改后确认，确认后才开始接力。");
      return;
    }
    const error =
      run.status === "cancelled" ? "整理被取消了" : run.status === "failed" ? `整理失败：${run.error ?? "未知错误"}` : "agent 没有按格式给出任务和验收标准";
    thread.promotion = { ...promotion, status: "failed", runId: run.id, error };
    this.notice(thread, "warn", `${error}。可以自己填写后确认，或重新整理。`);
  }

  cancel(threadId: string): void {
    const active = this.active.get(threadId);
    if (active) {
      active.controller.abort();
      for (const [id, a] of this.approvals) if (a.runId === active.runId) this.resolveApproval(id, false, "denied");
    }
    this.writeQueue = this.writeQueue.filter((q) => q.threadId !== threadId);
    const thread = this.threads.get(threadId);
    if (thread && !active && thread.status === "waiting") {
      thread.status = "paused";
      this.notice(thread, "info", "已取消排队。");
    }
  }

  private mustThread(id: string): Thread {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`找不到线程 ${id}`);
    return thread;
  }

  // ---------- decisions ----------

  private requestDecision(thread: Thread, decision: Omit<PendingDecision, "id" | "createdAt">): void {
    const full: PendingDecision = { id: newId("dec"), createdAt: nowIso(), ...decision };
    thread.pending = full;
    thread.status = "waiting";
    this.push(thread, { kind: "decision", decision: full });
  }

  async decide(threadId: string, decisionId: string, input: { approve: boolean; agentId?: string }): Promise<void> {
    const thread = this.mustThread(threadId);
    const decision = thread.pending;
    if (!decision || decision.id !== decisionId) throw new Error("这个确认已经处理过了");
    thread.pending = undefined;
    const item = thread.items.find((i) => i.kind === "decision" && i.decision.id === decisionId);
    if (item && item.kind === "decision") item.resolution = input.approve ? "approved" : "rejected";
    if (!input.approve) {
      thread.status = "paused";
      this.notice(thread, "info", "已暂停。可以发消息补充要求，线程会从当前阶段继续。");
      return;
    }
    if (decision.kind === "complete") {
      this.markDone(thread);
      return;
    }
    if (decision.kind === "violation") {
      if (/跳数/.test(decision.title)) thread.extraHops += 2;
      if (/空转/.test(decision.title)) thread.stalls = 0;
      if (/退回次数/.test(decision.title)) thread.sendBacks = Math.max(0, thread.sendBacks - 1);
    }
    const stage = decision.stage ?? lastRun(thread)?.stage ?? thread.stage;
    const agentId = input.agentId ?? decision.agentId;
    const sendBack = decision.detail.startsWith("[退回]");
    void this.begin(thread, stage, { agentId, userInitiated: true, sendBack });
  }

  private markDone(thread: Thread): void {
    thread.stage = "done";
    thread.status = "done";
    this.notice(thread, "info", "线程已完成。");
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

  /** Picks an agent for the stage and either runs it or asks the user first. */
  private async begin(thread: Thread, stage: Stage, opts: { agentId?: string; userInitiated?: boolean; sendBack?: boolean } = {}): Promise<void> {
    thread.status = "running";
    const agents = this.ws.listAgents();
    const selection = selectAgent(stage, { thread, agents, settings: this.ws.settings(), available: this.options.available }, { preferred: opts.agentId });
    const agent = selection.chosen;
    if (!agent) {
      const reasons = selection.rejected.map((r) => `- ${r.name}：${r.reason}`).join("\n") || "- 没有任何 agent 承担这个角色";
      thread.status = "paused";
      this.notice(thread, "error", `没有可用的 agent 承担「${STAGE_LABEL[stage]}」：\n${reasons}`);
      return;
    }
    if (opts.userInitiated) thread.approvedLevel = Math.max(thread.approvedLevel, permissionLevel(agent));
    await this.startRun(thread, agent, stage, { sendBack: opts.sendBack ?? false });
  }

  private async startRun(thread: Thread, agent: AgentCard, stage: Stage, opts: { sendBack: boolean }): Promise<void> {
    if (this.active.has(thread.id)) {
      this.notice(thread, "warn", "这个线程已经有运行在进行。");
      return;
    }
    const role = roleForStage(stage);
    const writes = role === "implement" || (role === "chat" && canWrite(chatPermissions(thread, agent)));
    if (writes && this.writeLock && this.writeLock !== thread.id) {
      thread.status = "waiting";
      this.writeQueue.push({ threadId: thread.id, run: { agentId: agent.id, stage, sendBack: opts.sendBack } });
      this.notice(thread, "info", "同一工作区同时只能有一个写运行，已排队，等另一个写运行结束后自动开始。");
      return;
    }
    if (opts.sendBack) thread.sendBacks++;
    thread.stage = stage;
    if (writes) this.writeLock = thread.id;
    try {
      await this.executeRun(thread, agent, role);
    } finally {
      if (this.writeLock === thread.id) {
        this.writeLock = undefined;
        const next = this.writeQueue.shift();
        if (next) {
          const t = this.threads.get(next.threadId);
          const a = this.ws.getAgent(next.run.agentId);
          if (t && a) void this.startRun(t, a, next.run.stage, { sendBack: next.run.sendBack });
        }
      }
    }
  }

  private taskFor(thread: Thread, role: Role): { task: string; extra?: string } {
    if (role === "chat") return { task: thread.notes.join("\n\n") || "（用户的下一条消息）" };
    const notes = thread.notes.length ? `## 用户补充\n${thread.notes.map((n) => `- ${n}`).join("\n")}` : "";
    const prevReview = lastRun(thread, "review");
    if (role === "plan") return { task: `为下面的任务制定方案，然后用 handoff_to 提议下一阶段：\n\n${thread.task}`, extra: notes };
    if (role === "implement") {
      const issues =
        prevReview?.handoff?.verdict === "fail" || prevReview?.checks?.some((c) => c.status === "fail" || c.status === "error")
          ? `## 上一轮检查的问题（必须逐条处理）\n${(prevReview.handoff?.issues ?? []).map((i) => `- ${i}`).join("\n")}\n${prevReview.checks ? formatChecks(prevReview.checks) : ""}`
          : "";
      return { task: `按最近的交接完成实现：\n\n${thread.task}`, extra: [issues, notes].filter(Boolean).join("\n\n") };
    }
    return { task: `对照验收标准检查实现：\n\n${thread.task}`, extra: notes };
  }

  private async executeRun(thread: Thread, card: AgentCard, role: Role, advisor?: { card: AdvisorCard }): Promise<RunRecord | undefined> {
    const agent = role === "chat" ? { ...card, permissions: chatPermissions(thread, card) } : card;
    const stage = thread.stage;
    const settings = this.ws.settings();
    let checksResults: RunRecord["checks"];
    let checksText = "";
    if (role === "review") {
      const impl = lastRun(thread, "implement");
      const results = await runChecks(settings.checks, { cwd: this.ws.root, changedFiles: impl?.changedFiles });
      checksResults = results;
      checksText = formatChecks(results);
      if (results.length) this.push(thread, { kind: "checks", results });
    }

    const consumedNotes = thread.notes.length;
    const { task, extra } = advisor
      ? { task: `## 请教卡\n### 机械事实\n${advisor.card.facts}\n\n### 我的判断\n${advisor.card.judgement}\n\n### 我希望听到的答案\n${advisor.card.hoping}`, extra: "" }
      : this.taskFor(thread, role);
    const previous = [...thread.runs].reverse().find((r) => r.agentId === agent.id && r.snapshotAfter);
    const diffSummary = previous?.snapshotAfter ? await this.shadow.diffStat(previous.snapshotAfter).catch(() => "") : "";
    const briefing = compileBriefing({
      ws: this.ws,
      agent,
      role,
      thread: advisor ? undefined : thread,
      task,
      extra: [checksText, extra].filter(Boolean).join("\n\n"),
      diffSummary,
    });
    if (briefing.overBudget) {
      const biggest = [...briefing.sections].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
      thread.status = "paused";
      this.notice(
        thread,
        "error",
        `开场上下文 ${(briefing.bytes / 1024).toFixed(1)}KB，超过「${role}」的预算 ${(briefing.budget / 1024).toFixed(0)}KB，运行没有启动。最大的几段：\n${biggest.map((s) => `- ${s.title}（${s.source}）${(s.bytes / 1024).toFixed(1)}KB`).join("\n")}`,
      );
      return undefined;
    }

    const run: RunRecord = {
      id: newId("run"),
      threadId: thread.id,
      agentId: agent.id,
      agentName: agent.name,
      runtime: agent.runtime,
      model: agent.model,
      family: modelFamily(agent.model, agent.provider),
      stage,
      role,
      status: "running",
      startedAt: nowIso(),
      briefingHash: briefing.hash,
      briefingBytes: briefing.bytes,
      changedFiles: [],
      decisions: 0,
      finalText: "",
      checks: checksResults,
      prompt: role === "chat" ? task : undefined,
    };
    try {
      run.snapshotBefore = await this.shadow.snapshot(`before ${run.id} ${agent.id} ${stage}`);
    } catch (error) {
      this.notice(thread, "warn", `快照失败（无法回滚这次运行）：${(error as Error).message}`);
    }
    thread.runs.push(run);
    thread.status = "running";
    this.ws.audit({ run: run.id, thread: thread.id, agent: agent.id, role, briefingHash: briefing.hash, briefingBytes: briefing.bytes });
    this.writeBriefingRecord(run, briefing);
    this.push(thread, { kind: "run_start", runId: run.id, agentId: agent.id, agentName: agent.name, stage, model: agent.model, runtime: agent.runtime, briefingBytes: briefing.bytes });

    let handoffDraft: Omit<Handoff, "runId" | "threadId" | "agentId" | "stage" | "createdAt" | "auto"> | undefined;
    const touched = new Set<string>();
    const controller = new AbortController();
    const token = randomBytes(18).toString("base64url");
    const ctx: ToolContext = {
      ws: this.ws,
      agent,
      run: { id: run.id, threadId: thread.id, stage, role },
      signal: controller.signal,
      requestApproval: (req) => this.requestApproval(thread, run.id, req),
      onHandoff: (h) => {
        handoffDraft = h;
        if (h.verdict) run.decisions++;
      },
      onHandoffTo: (p) => {
        run.proposedNext = p;
        run.decisions++;
      },
      onDecision: () => {
        run.decisions++;
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
      } else if (e.type === "compaction") {
        textItem = undefined;
        run.progress = compactionProgress(e.summary, run.progress);
        const counts = `已完成 ${run.progress.done.length} 项、进行中 ${run.progress.remaining.length} 项`;
        this.notice(thread, "info", `上下文接近上限，Pi 压缩了较早的对话。摘要里的进展（${counts}）已同步到交接草稿，写交接时会补上遗漏的部分。`);
      }
    };

    const executor = agent.runtime === "cursor" ? this.options.acp : this.options.pi;
    const result = await executor.run({
      runId: run.id,
      agent,
      role,
      thread,
      briefing,
      prompt: task,
      tools: toolsFor(agent, role),
      toolContext: ctx,
      workspaceRoot: this.ws.root,
      sessionDir: this.ws.path("sessions", agent.runtime),
      signal: controller.signal,
      emit,
      requestApproval: ctx.requestApproval,
      hasHandoff: () => handoffDraft !== undefined,
      mcp: agent.runtime === "cursor" ? this.options.mcpLaunch?.(token) : undefined,
      cursorCommand: settings.cursor.command,
    });
    this.active.delete(thread.id);
    for (const [id, a] of this.approvals) if (a.runId === run.id) this.resolveApproval(id, false, "expired");

    run.status = result.status;
    run.finalText = result.finalText;
    run.error = result.error;
    run.usage = result.usage;
    run.endedAt = nowIso();
    try {
      run.snapshotAfter = await this.shadow.snapshot(`after ${run.id}`);
      run.changedFiles = run.snapshotBefore ? await this.shadow.changedFiles(run.snapshotBefore, run.snapshotAfter) : [...touched];
    } catch {
      run.changedFiles = [...touched];
    }

    if (agent.source === "deepseek") thread.spend.deepseekCny += (result.usage?.costUsd ?? 0) * USD_TO_CNY;
    if (agent.source === "chatgpt") thread.spend.chatgptRuns++;
    if (agent.source === "cursor") thread.spend.cursorRuns++;

    if (role !== "advisor" && result.status !== "cancelled") {
      const auto = !handoffDraft;
      handoffDraft ??= role === "chat" ? chatHandoff(task, result.finalText, run.changedFiles) : await this.autoHandoff(run, result.finalText, run.changedFiles);
      run.handoff = { ...mergeProgress(handoffDraft, run.progress), runId: run.id, threadId: thread.id, agentId: agent.id, stage, createdAt: nowIso(), auto };
      const missing = run.changedFiles.filter((f) => !run.handoff!.files.includes(f));
      if (missing.length) run.handoff.files = [...run.handoff.files, ...missing];
      saveHandoff(this.ws, run.handoff);
      // In a chat the reply itself is on the timeline; the handoff only feeds later briefings.
      if (role !== "chat") this.push(thread, { kind: "handoff", runId: run.id, handoff: run.handoff }, false);
    }
    if (result.status === "failed") this.push(thread, { kind: "notice", level: "error", text: `运行失败：${result.error ?? "未知错误"}` }, false);
    this.push(thread, { kind: "run_end", runId: run.id, status: run.status, changedFiles: run.changedFiles, usage: run.usage, error: run.error }, false);
    if (role !== "advisor") {
      if (role !== "chat") thread.stalls = result.status === "succeeded" && isStall(run) ? thread.stalls + 1 : result.status === "succeeded" ? 0 : thread.stalls;
      thread.notes = thread.notes.slice(consumedNotes);
      thread.summary = role === "chat" ? rollChatSummary(thread) : rollSummary(thread);
    }
    if (role === "chat" && thread.promotion?.status === "drafting" && task === RELAY_DRAFT_PROMPT) this.finishDraft(thread, run);
    if (role === "chat") thread.status = "idle";
    this.save(thread);
    if (role === "chat") {
      if (run.status !== "cancelled" && thread.notes.length) await this.beginChat(thread);
    } else if (role !== "advisor") await this.afterRun(thread, run);
    return run;
  }

  private writeBriefingRecord(run: RunRecord, briefing: Briefing): void {
    writeFileAtomic(this.ws.path("sessions", "briefings", `${run.id}.md`), `<!-- hash ${briefing.hash} -->\n${briefing.text}\n`);
  }

  private async autoHandoff(run: RunRecord, finalText: string, files: string[]) {
    let done = "";
    if (this.options.summarize && finalText.trim()) {
      done =
        (await this.options
          .summarize(`把下面这次 agent 运行的最后输出整理成交接的「做了什么」，只写事实，150 字以内：\n\n${finalText.slice(-6000)}`)
          .catch(() => undefined)) ?? "";
    }
    if (!done) done = finalText.trim() ? truncateMiddle(finalText.trim(), 1200).text : run.status === "failed" ? `运行失败：${run.error ?? ""}` : "（没有输出）";
    const remaining = [...(run.progress?.remaining ?? []).map((r) => `- ${r}`), "（agent 没有写交接，以上为自动生成）"].join("\n");
    return { done, files, remaining, next: "", verdict: undefined, issues: undefined };
  }

  private async afterRun(thread: Thread, run: RunRecord): Promise<void> {
    const settings = this.ws.settings();
    if (run.stage === "review" && run.status === "succeeded") {
      thread.reviewIssueRounds = run.handoff?.verdict === "fail" && run.handoff.issues?.length ? thread.reviewIssueRounds + 1 : 0;
    }
    const transition = nextTransition(thread, run, settings);
    const trigger = run.status === "succeeded" ? advisorTrigger(thread, run, transition, settings) : undefined;
    let advice: string | undefined;
    if (trigger) advice = await this.consultAdvisor(thread, run, transition, ADVISOR_TRIGGER_LABEL[trigger]);

    switch (transition.kind) {
      case "pause":
        thread.status = "paused";
        this.notice(thread, run.status === "failed" ? "error" : "info", `${transition.reason}。可以发消息补充后继续，或在右侧换一个 agent。`);
        return;
      case "complete":
        if (settings.confirm.complete || advice) {
          this.requestDecision(thread, { kind: "complete", title: "标记完成？", detail: transition.reason, advice });
        } else this.markDone(thread);
        return;
      case "violation":
        this.requestDecision(thread, {
          kind: "violation",
          title: transition.rule,
          detail: `${transition.sendBack ? "[退回] " : ""}${transition.detail}`,
          stage: transition.to,
          advice,
        });
        return;
      case "advance":
        await this.advance(thread, run, transition, advice);
    }
  }

  private async advance(thread: Thread, run: RunRecord, t: Extract<Transition, { kind: "advance" }>, advice?: string): Promise<void> {
    const settings = this.ws.settings();
    const agents = this.ws.listAgents();
    if (t.to === "implement" && run.proposedNext?.acceptance.length) {
      const merged = [...thread.acceptance];
      for (const a of run.proposedNext.acceptance) if (!merged.includes(a)) merged.push(a);
      thread.acceptance = merged;
    }
    const selection = selectAgent(t.to, { thread, agents, settings, available: this.options.available });
    const next = selection.chosen;
    if (!next) {
      this.requestDecision(thread, {
        kind: "violation",
        title: "没有可用的 agent",
        detail: `${t.sendBack ? "[退回] " : ""}「${STAGE_LABEL[t.to]}」没有可用的 agent：\n${selection.rejected.map((r) => `- ${r.name}：${r.reason}`).join("\n") || "- 没有 agent 承担这个角色"}`,
        stage: t.to,
        advice,
      });
      return;
    }
    const prefix = t.sendBack ? "[退回] " : "";
    const candidates = selection.candidates.map((c) => c.id);
    if (run.stage === "plan" && t.to === "implement" && settings.confirm.planToImplement) {
      this.requestDecision(thread, { kind: "start_stage", title: `开始实现？交给 ${next.name}`, detail: `${prefix}${t.reason}`, stage: t.to, agentId: next.id, candidates, advice });
      return;
    }
    if (needsEscalationApproval(thread, next)) {
      this.requestDecision(thread, {
        kind: "start_stage",
        title: `${next.name} 需要更高的权限`,
        detail: `${prefix}${t.reason}。下一步需要${canWrite(next.permissions) ? "写文件" : ""}${next.permissions.exec === "allow" ? "、直接执行命令" : ""}的权限，超出了本线程已批准的范围。`,
        stage: t.to,
        agentId: next.id,
        candidates,
        advice,
      });
      return;
    }
    if (advice) {
      this.requestDecision(thread, { kind: "start_stage", title: `顾问给出了意见，继续交给 ${next.name}？`, detail: `${prefix}${t.reason}`, stage: t.to, agentId: next.id, candidates, advice });
      return;
    }
    thread.hops++;
    this.notice(thread, "info", `${STAGE_LABEL[run.stage]} → ${STAGE_LABEL[t.to]}：交给 ${next.name}（${t.reason}）`);
    await this.startRun(thread, next, t.to, { sendBack: t.sendBack ?? false });
  }

  private async consultAdvisor(thread: Thread, run: RunRecord, transition: Transition, triggerLabel: string): Promise<string | undefined> {
    const agents = this.ws.listAgents();
    const selection = selectAgent(thread.stage, { thread, agents, settings: this.ws.settings(), available: this.options.available }, { role: "advisor" });
    const advisor = selection.chosen;
    if (!advisor) {
      this.notice(thread, "warn", `触发了顾问（${triggerLabel}），但没有可用的顾问 agent。`);
      return undefined;
    }
    const card: AdvisorCard = {
      facts: [
        `- 线程：${thread.title}；阶段 ${STAGE_LABEL[run.stage]}；已退回 ${thread.sendBacks} 次；已接力 ${thread.hops} 跳`,
        `- 改动文件：${run.changedFiles.join("、") || "无"}`,
        run.checks?.length ? `- 检查命令：${run.checks.map((c) => `${c.name}=${c.status}`).join("，")}` : "",
        run.handoff?.issues?.length ? `- 检查报出的问题：\n${run.handoff.issues.map((i) => `  - ${i}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      judgement: run.handoff?.done ?? run.finalText.slice(0, 600),
      hoping: transition.kind === "advance" ? `希望确认可以进入「${STAGE_LABEL[transition.to]}」` : "希望知道下一步怎么做才能收敛",
    };
    this.notice(thread, "info", `触发顾问（${triggerLabel}）：请 ${advisor.name} 在干净上下文里只读评估。`);
    const advisorRun = await this.executeRun(thread, advisor, "advisor", { card });
    if (!advisorRun || advisorRun.status !== "succeeded") return undefined;
    const advice = advisorRun.finalText.trim();
    this.push(thread, { kind: "advisor", runId: advisorRun.id, agentName: advisor.name, card, advice });
    return advice;
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
    const { thread, run } = found;
    if (thread.kind === "chat") {
      this.notice(thread, "warn", `已回滚到「${run.agentName}」这次回复之前，恢复了 ${files.length} 个文件。`);
      return files;
    }
    thread.stage = run.stage;
    thread.status = "paused";
    this.notice(thread, "warn", `已回滚到「${run.agentName}」这次运行之前，恢复了 ${files.length} 个文件。发消息说明要怎么改，线程会从「${STAGE_LABEL[run.stage]}」重新开始。`);
    return files;
  }

  // ---------- inspector & bridge ----------

  async briefingPreview(agentId: string, role: Role, threadId?: string): Promise<Briefing> {
    const agent = this.ws.getAgent(agentId);
    if (!agent) throw new Error(`找不到 agent ${agentId}`);
    const thread = threadId ? this.threads.get(threadId) : undefined;
    const { task, extra } = thread ? this.taskFor(thread, role) : { task: "（运行时这里是具体任务）", extra: "" };
    const previous = thread ? [...thread.runs].reverse().find((r) => r.agentId === agent.id && r.snapshotAfter) : undefined;
    const diffSummary = previous?.snapshotAfter ? await this.shadow.diffStat(previous.snapshotAfter).catch(() => "") : "";
    return compileBriefing({ ws: this.ws, agent, role, thread: role === "advisor" ? undefined : thread, task, extra, diffSummary });
  }

  /** Tool calls from the MCP server or the `baton` CLI. */
  async bridgeTool(token: string | undefined, toolName: string, args: unknown): Promise<ToolOutput> {
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (!tool) return { text: `未知工具：${toolName}`, isError: true };
    let active = token ? [...this.active.values()].find((a) => a.token === token) : undefined;
    if (!active && !token) {
      const cursorRuns = [...this.active.values()].filter((a) => a.runtime === "cursor");
      if (cursorRuns.length === 1) active = cursorRuns[0];
    }
    if (token && !active) return { text: "运行令牌无效或运行已结束", isError: true };
    if (active) return runTool(tool, args, active.ctx);
    if (tool.name === "write_handoff") return { text: "当前没有进行中的运行，无法写交接", isError: true };
    const user: AgentCard = {
      id: "user",
      name: "用户",
      runtime: "pi",
      source: "demo",
      provider: "user",
      model: "user",
      roles: [],
      permissions: { write: "deny", exec: "deny", network: "deny" },
      costTier: 0,
      enabled: true,
      body: "",
    };
    const ctx: ToolContext = {
      ws: this.ws,
      agent: user,
      run: { id: "manual", threadId: "", stage: "plan", role: "plan" },
      requestApproval: async () => false,
      onHandoff: () => {},
      onHandoffTo: () => {},
      onDecision: () => {},
      onFileWrite: () => {},
    };
    return runTool(tool, args, ctx);
  }

  stats(): StatRow[] {
    const rows = new Map<string, StatRow & { ids: Set<string> }>();
    const decisions = new Map<string, { approved: number; rejected: number }>();
    for (const thread of this.threads.values()) {
      for (const item of thread.items) {
        if (item.kind !== "decision" || item.decision.kind !== "start_stage" || !item.decision.agentId || !item.resolution) continue;
        const d = decisions.get(item.decision.agentId) ?? { approved: 0, rejected: 0 };
        d[item.resolution]++;
        decisions.set(item.decision.agentId, d);
      }
      const runs = thread.runs.filter((r) => r.role !== "advisor");
      runs.forEach((run, idx) => {
        const key = `${run.runtime}:${run.model}`;
        const row = rows.get(key) ?? emptyRow(run);
        rows.set(key, row);
        const s = row.stages[run.stage] ?? { runs: 0, succeeded: 0, firstPass: 0, sentBack: 0 };
        row.stages[run.stage] = s;
        s.runs++;
        if (run.status === "succeeded") s.succeeded++;
        row.costUsd += run.usage?.costUsd ?? 0;
        row.tokens += run.usage?.totalTokens ?? 0;
        row.runs++;
        if (run.stage === "implement") {
          const review = runs.slice(idx + 1).find((r) => r.stage === "review" && r.status === "succeeded");
          const firstImplement = runs.findIndex((r) => r.stage === "implement") === idx;
          if (review?.handoff?.verdict === "pass" && firstImplement) s.firstPass++;
          if (review?.handoff?.verdict === "fail") s.sentBack++;
        }
        row.ids.add(run.agentId);
      });
    }
    return [...rows.values()].map(({ ids, ...row }) => {
      let approved = 0;
      let rejected = 0;
      for (const id of ids) {
        approved += decisions.get(id)?.approved ?? 0;
        rejected += decisions.get(id)?.rejected ?? 0;
      }
      return { ...row, agentIds: [...ids], accepted: approved, declined: rejected };
    });
  }
}

export interface StatRow {
  key: string;
  runtime: string;
  model: string;
  family: string;
  runs: number;
  costUsd: number;
  tokens: number;
  stages: Partial<Record<Stage, { runs: number; succeeded: number; firstPass: number; sentBack: number }>>;
  agentIds: string[];
  accepted: number;
  declined: number;
}

function emptyRow(run: RunRecord): StatRow & { ids: Set<string> } {
  return { key: `${run.runtime}:${run.model}`, runtime: run.runtime, model: run.model, family: run.family, runs: 0, costUsd: 0, tokens: 0, stages: {}, agentIds: [], ids: new Set(), accepted: 0, declined: 0 };
}

function chatHandoff(prompt: string, reply: string, files: string[]) {
  const said = truncateMiddle(prompt.trim(), 600).text;
  const answered = reply.trim() ? truncateMiddle(reply.trim(), 1200).text : "（没有回复）";
  return { done: `用户：${said}\n\n回复：${answered}`, files, remaining: "", next: "", verdict: undefined, issues: undefined };
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

function rollSummary(thread: Thread): string {
  const withHandoff = thread.runs.filter((r) => r.handoff);
  const older = withHandoff.slice(0, -3);
  return older.map((r) => `- [${STAGE_LABEL[r.stage]} · ${r.agentName}] ${r.handoff!.done.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
}

function newThread(fields: Pick<Thread, "kind" | "title" | "task" | "acceptance" | "stage" | "approvedLevel">): Thread {
  return {
    id: newId("th"),
    ...fields,
    status: "idle",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    hops: 0,
    sendBacks: 0,
    stalls: 0,
    summary: "",
    runs: [],
    items: [],
    pinnedAgents: {},
    spend: { deepseekCny: 0, chatgptRuns: 0, cursorRuns: 0 },
    reviewIssueRounds: 0,
    extraHops: 0,
    notes: [],
  };
}

function migrateThread(t: Thread): Thread {
  return {
    ...t,
    kind: t.kind ?? "relay",
    pinnedAgents: t.pinnedAgents ?? {},
    spend: t.spend ?? { deepseekCny: 0, chatgptRuns: 0, cursorRuns: 0 },
    reviewIssueRounds: t.reviewIssueRounds ?? 0,
    approvedLevel: t.approvedLevel ?? 0,
    extraHops: t.extraHops ?? 0,
    notes: t.notes ?? [],
  };
}
