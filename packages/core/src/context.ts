import fs from "node:fs";
import { modelFamily } from "./families.ts";
import { listMemory } from "./memory.ts";
import type { Briefing, BriefingSection, ChatAccess, Role, RunAgent, RunRecord, Thread } from "./types.ts";
import { byteLength, sha256, truncateMiddle } from "./util.ts";
import type { Workspace } from "./workspace.ts";

export const ROLE_LABEL: Record<Role, string> = { chat: "对话", review: "检查" };
export const ACCESS_LABEL: Record<ChatAccess, string> = { read: "只读", ask: "每次问我", allow: "允许直接改" };

/** Chat turns quoted verbatim in the next briefing; older turns roll into the thread summary. */
export const CHAT_RECENT_TURNS = 3;

export interface BriefingInput {
  ws: Workspace;
  agent: RunAgent;
  role: Role;
  thread?: Thread;
  /** The user's message (chat) or what to check (review). */
  task?: string;
  /** Extra material for the task card: check results and the diff under review. */
  extra?: string;
  diffSummary?: string;
}

function section(key: string, title: string, source: string, content: string): BriefingSection | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  return { key, title, source, content: trimmed, bytes: byteLength(trimmed) };
}

export function compileBriefing(input: BriefingInput): Briefing {
  const { ws, agent, role, thread } = input;
  const family = modelFamily(agent.model, agent.provider);
  const familyFile = `family-${family}.md`;
  const sections: (BriefingSection | undefined)[] = [
    section("base", "共用底座", ".baton/rules/base.md", ws.readRule("base.md")),
    section("role", `角色规则 · ${ROLE_LABEL[role]}`, `.baton/rules/role-${role}.md`, ws.readRule(`role-${role}.md`)),
    section("runtime", `运行时校准 · ${agent.runtime}`, `.baton/rules/runtime-${agent.runtime}.md`, ws.readRule(`runtime-${agent.runtime}.md`)),
    fs.existsSync(ws.path("rules", familyFile))
      ? section("family", `模型家族 · ${family}`, `.baton/rules/${familyFile}`, ws.readRule(familyFile))
      : undefined,
    section("context", "房间上下文", ".baton/CONTEXT.md", ws.readContext()),
    (() => {
      const pinned = listMemory(ws).filter((m) => m.pinned && m.status === "active");
      return section("memory", "置顶记忆", ".baton/memory/", pinned.length ? `# 置顶记忆\n${pinned.map((m) => `- [${m.id}] ${m.text}`).join("\n")}` : "");
    })(),
    thread ? section("thread", "对话摘要与最近几轮", `.baton/threads/${thread.id}.json`, chatDigest(thread)) : undefined,
    input.diffSummary ? section("diff", "自上次运行以来的改动", "shadow git", `# 自你上次运行以来的文件改动\n${input.diffSummary}`) : undefined,
    section("task", "任务卡", "harness", taskCard(input)),
  ];
  const present = sections.filter((s): s is BriefingSection => s !== undefined);
  const text = present.map((s) => s.content).join("\n\n---\n\n");
  const bytes = byteLength(text);
  const budget = ws.settings().budgets.briefing;
  return { sections: present, text, bytes, budget, overBudget: bytes > budget, duplicates: findDuplicates(present), hash: sha256(text) };
}

/** Finished chat runs, oldest first. Each one is a turn: the user's message and the model's reply. */
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
      return `### 用户\n${truncateMiddle(r.prompt!.trim(), 1500).text}\n\n### ${r.agentName}\n${truncateMiddle(reply, 2500).text}`;
    });
    parts.push(`## 最近几轮原文\n\n${turns.join("\n\n")}`);
  }
  return parts.length > 1 ? parts.join("\n\n") : "";
}

function taskCard(input: BriefingInput): string {
  const { role, thread, agent } = input;
  const lines = ["# 任务卡", `- 角色：${ROLE_LABEL[role]}`, `- 你是：${agent.name}（${agent.model}）`];
  if (thread) lines.push(`- 对话：${thread.title}`);
  if (role === "chat") {
    const write = {
      allow: "允许直接改（仅本对话；开始前已自动快照）",
      ask: "每次问我（仅本对话；每次改文件、执行命令前需要用户确认）",
      deny: "只读，不能改文件、不能执行命令",
    };
    lines.push(`- 权限：${write[agent.permissions.write]}`);
    if (input.task) lines.push("", "## 用户消息", input.task.trim());
  } else {
    lines.push("- 权限：只读；结束前必须调用 submit_review 给出结论");
    if (input.task?.trim()) lines.push("", "## 用户的要求", input.task.trim());
  }
  if (input.extra?.trim()) lines.push("", input.extra.trim());
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
