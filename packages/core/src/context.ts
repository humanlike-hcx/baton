import fs from "node:fs";
import { modelFamily } from "./families.ts";
import { handoffMarkdown, listMemory } from "./memory.ts";
import type { AgentCard, Briefing, BriefingSection, Role, RunRecord, Stage, Thread } from "./types.ts";
import { byteLength, sha256, truncateMiddle } from "./util.ts";
import type { Workspace } from "./workspace.ts";

export const STAGE_LABEL: Record<Stage, string> = { plan: "方案", implement: "实现", review: "检查", done: "完成", chat: "对话" };
export const ROLE_LABEL: Record<Role, string> = { plan: "方案", implement: "实现", review: "检查", advisor: "顾问", chat: "对话" };

/** Chat turns quoted verbatim in the next briefing; older turns roll into the thread summary. */
export const CHAT_RECENT_TURNS = 3;

export interface BriefingInput {
  ws: Workspace;
  agent: AgentCard;
  role: Role;
  thread?: Thread;
  /** Shown in the task card: what this run must do. */
  task?: string;
  acceptance?: string[];
  /** Extra material for the task card: check results, user notes, consult card. */
  extra?: string;
  diffSummary?: string;
}

function section(key: string, title: string, source: string, content: string): BriefingSection | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  return { key, title, source, content: trimmed, bytes: byteLength(trimmed) };
}

export function budgetFor(role: Role, ws: Workspace): number {
  const { budgets } = ws.settings();
  return role === "plan" || role === "advisor" || role === "chat" ? budgets.planner : budgets.executor;
}

export function compileBriefing(input: BriefingInput): Briefing {
  const { ws, agent, role, thread } = input;
  const family = modelFamily(agent.model, agent.provider);
  const familyFile = `family-${family}.md`;
  const clean = role === "advisor";
  const sections: (BriefingSection | undefined)[] = [
    section("base", "共用底座", ".baton/rules/base.md", ws.readRule("base.md")),
    section("role", `角色规则 · ${ROLE_LABEL[role]}`, `.baton/rules/role-${role}.md`, ws.readRule(`role-${role}.md`)),
    section("runtime", `运行时校准 · ${agent.runtime}`, `.baton/rules/runtime-${agent.runtime}.md`, ws.readRule(`runtime-${agent.runtime}.md`)),
    fs.existsSync(ws.path("rules", familyFile))
      ? section("family", `模型家族 · ${family}`, `.baton/rules/${familyFile}`, ws.readRule(familyFile))
      : undefined,
    section(
      "agent",
      "职责说明",
      `.baton/agents/${agent.id}.md`,
      `# 你是谁\n${agent.name}（运行时 ${agent.runtime}，模型 ${agent.model}）\n\n${agent.body}`,
    ),
    section("context", "房间上下文", ".baton/CONTEXT.md", ws.readContext()),
    (() => {
      const pinned = listMemory(ws).filter((m) => m.pinned && m.status === "active");
      return section("memory", "置顶记忆", ".baton/memory/", pinned.length ? `# 置顶记忆\n${pinned.map((m) => `- [${m.id}] ${m.text}`).join("\n")}` : "");
    })(),
    !clean && thread
      ? thread.kind === "chat"
        ? section("thread", "对话摘要与最近几轮", `.baton/threads/${thread.id}.json`, chatDigest(thread))
        : section("thread", "线程摘要与最近交接", `.baton/handoffs/${thread.id}/`, threadDigest(thread))
      : undefined,
    !clean && input.diffSummary ? section("diff", "自上次运行以来的改动", "shadow git", `# 自你上次运行以来的文件改动\n${input.diffSummary}`) : undefined,
    section("task", "任务卡", "harness", taskCard(input)),
  ];
  const present = sections.filter((s): s is BriefingSection => s !== undefined);
  const text = present.map((s) => s.content).join("\n\n---\n\n");
  const bytes = byteLength(text);
  const budget = budgetFor(role, ws);
  return { sections: present, text, bytes, budget, overBudget: bytes > budget, duplicates: findDuplicates(present), hash: sha256(text) };
}

function threadDigest(thread: Thread): string {
  const handoffs = thread.runs.filter((r) => r.handoff).slice(-3);
  const parts = [`# 线程：${thread.title}`];
  if (thread.summary.trim()) parts.push(`## 更早的进展\n${thread.summary.trim()}`);
  for (const run of handoffs) parts.push(handoffMarkdown(run.handoff!).replace(/^# /, "## "));
  return parts.length > 1 ? parts.join("\n\n") : "";
}

/** Finished chat runs, oldest first. Each one is a turn: the user's message and the agent's reply. */
export function chatTurns(thread: Thread): RunRecord[] {
  return thread.runs.filter((r) => r.role === "chat" && r.status !== "running" && r.prompt !== undefined);
}

function chatDigest(thread: Thread): string {
  const recent = chatTurns(thread).slice(-CHAT_RECENT_TURNS);
  const parts = [`# 对话：${thread.title}`];
  if (thread.summary.trim()) parts.push(`## 更早的对话（摘要）\n${thread.summary.trim()}`);
  if (recent.length) {
    const turns = recent.map((r) => {
      const reply = r.finalText.trim() || (r.status === "failed" ? `（运行失败：${r.error ?? "未知错误"}）` : r.status === "cancelled" ? "（用户取消了这次回复）" : "（没有回复）");
      return `### 用户\n${truncateMiddle(r.prompt!.trim(), 1500).text}\n\n### ${r.agentName}（${r.model}）\n${truncateMiddle(reply, 2500).text}`;
    });
    parts.push(`## 最近几轮原文\n\n${turns.join("\n\n")}`);
  }
  return parts.length > 1 ? parts.join("\n\n") : "";
}

function taskCard(input: BriefingInput): string {
  const { role, thread, agent } = input;
  const lines = ["# 任务卡", `- 角色：${ROLE_LABEL[role]}`, `- 你是：${agent.name}`];
  if (role === "chat") {
    if (thread) lines.push(`- 对话：${thread.title}`);
    const write = { allow: "已开放（仅本线程；开始前已自动快照）", ask: "已开放（仅本线程；每次改文件前需要用户确认）", deny: "只读，不能改文件、不能执行命令" };
    lines.push(`- 写权限：${write[agent.permissions.write]}`);
    if (input.task) lines.push("", "## 用户消息", input.task.trim());
    return lines.join("\n");
  }
  if (thread) lines.push(`- 线程：${thread.title}（第 ${thread.hops + 1} 跳，已退回 ${thread.sendBacks} 次）`);
  if (input.task) lines.push("", "## 要做的事", input.task.trim());
  const acceptance = input.acceptance ?? thread?.acceptance ?? [];
  if (acceptance.length) lines.push("", "## 验收标准", ...acceptance.map((a, i) => `${i + 1}. ${a}`));
  if (input.extra?.trim()) lines.push("", input.extra.trim());
  if (role === "implement" || role === "review") {
    lines.push("", "你不能决定交给谁。需要别的阶段处理的事，写进交接的「建议下一步」。");
  }
  return lines.join("\n");
}

function normalizeLine(line: string): string {
  return line.trim().replace(/^[-*>\d.\s]+/, "").replace(/\s+/g, " ");
}

function findDuplicates(sections: BriefingSection[]): Briefing["duplicates"] {
  const seen = new Map<string, Set<string>>();
  for (const s of sections) {
    for (const raw of s.content.split("\n")) {
      const line = normalizeLine(raw);
      if (line.length < 16 || line.startsWith("#")) continue;
      if (!seen.has(line)) seen.set(line, new Set());
      seen.get(line)!.add(s.key);
    }
  }
  return [...seen.entries()].filter(([, keys]) => keys.size > 1).map(([line, keys]) => ({ line, sections: [...keys] }));
}
