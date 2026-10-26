import type { AgentCard, Role, Stage, ThreadKind, ThreadStatus } from "./types";

export const STAGES: Stage[] = ["plan", "implement", "review", "done"];

export const STAGE_LABEL: Record<Stage, string> = { plan: "方案", implement: "实现", review: "检查", done: "完成", chat: "对话" };
export const ROLE_LABEL: Record<Role, string> = { plan: "方案", implement: "实现", review: "检查", advisor: "顾问", chat: "对话" };

export const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "待开始",
  running: "运行中",
  waiting: "等你确认",
  paused: "已暂停",
  done: "已完成",
};

/** A chat thread that is not replying is simply waiting for the next message. */
export function statusLabel(thread: { kind: ThreadKind; status: ThreadStatus }): string {
  return thread.kind === "chat" && thread.status === "idle" ? "空闲" : STATUS_LABEL[thread.status];
}

export const STATUS_TONE: Record<ThreadStatus, string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  waiting: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  paused: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

export const STAGE_TONE: Record<Stage, string> = {
  plan: "text-violet-600 dark:text-violet-300",
  implement: "text-sky-600 dark:text-sky-300",
  review: "text-amber-600 dark:text-amber-300",
  done: "text-emerald-600 dark:text-emerald-300",
  chat: "text-foreground",
};

export const SOURCE_LABEL: Record<AgentCard["source"], string> = {
  chatgpt: "ChatGPT 登录",
  deepseek: "DeepSeek key",
  cursor: "Cursor 登录",
  demo: "演示",
};

export const RUNTIME_LABEL: Record<AgentCard["runtime"], string> = { pi: "Pi", cursor: "Cursor Agent" };

export function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return "";
  const s = Math.round(diff / 1000);
  if (s < 45) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
