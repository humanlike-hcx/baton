import type { ChatAccess, ChatModel, CredentialSource, Role, ThreadStatus } from "./types";

export const ROLE_LABEL: Record<Role, string> = { chat: "对话", review: "检查" };

export const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "空闲",
  running: "回复中",
  waiting: "排队中",
  paused: "已暂停",
};

export const STATUS_TONE: Record<ThreadStatus, string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  waiting: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  paused: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
};

export const ACCESS: { value: ChatAccess; label: string; hint: string }[] = [
  { value: "read", label: "只读", hint: "只能读文件、读上下文、查和写记忆，不能改文件、不能执行命令" },
  { value: "ask", label: "每次问我", hint: "改文件、执行命令前都先问你" },
  { value: "allow", label: "允许直接改", hint: "直接改文件和执行命令；危险命令黑名单和禁止访问的路径照常生效" },
];

export const ACCESS_LABEL: Record<ChatAccess, string> = { read: "只读", ask: "每次问我", allow: "允许直接改" };

export const SOURCE_LABEL: Record<CredentialSource, string> = {
  chatgpt: "ChatGPT",
  cursor: "Cursor",
  key: "API key",
  demo: "演示",
};

/** The account a model runs on: a key account's own name, or the subscription's. */
export function accountLabel(model: Pick<ChatModel, "source" | "account">): string {
  return model.source === "key" ? (model.account ?? SOURCE_LABEL.key) : SOURCE_LABEL[model.source];
}

export const USD_TO_CNY = 7.2;

/** Key accounts bill per use (shown in yuan); subscriptions are already paid for. */
export function costLabel(source: CredentialSource, usd: number, digits = 2): string {
  if (source === "key") return `¥${(usd * USD_TO_CNY).toFixed(digits)}`;
  return source === "demo" ? "免费" : "订阅内";
}

export const RUNTIME_LABEL: Record<string, string> = { pi: "Pi", cursor: "Cursor Agent" };

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
