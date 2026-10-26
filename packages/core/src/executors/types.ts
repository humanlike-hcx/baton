import type { ToolContext, ToolSpec } from "../tools.ts";
import type { AgentCard, Briefing, Risk, Role, Thread, Usage } from "../types.ts";

export type ExecutorEvent =
  | { type: "text_delta"; delta: string; thinking?: boolean }
  | { type: "text_end" }
  | { type: "tool_start"; id: string; tool: string; args: unknown }
  | { type: "tool_end"; id: string; tool: string; ok: boolean; result: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string };

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ExecuteRequest {
  runId: string;
  agent: AgentCard;
  role: Role;
  thread?: Thread;
  briefing: Briefing;
  prompt: string;
  tools: ToolSpec[];
  toolContext: ToolContext;
  workspaceRoot: string;
  sessionDir: string;
  signal: AbortSignal;
  emit(event: ExecutorEvent): void;
  requestApproval(req: { risk: Risk; title: string; preview: string }): Promise<boolean>;
  hasHandoff(): boolean;
  mcp?: McpLaunch;
  cursorCommand?: string;
}

export interface ExecuteResult {
  status: "succeeded" | "failed" | "cancelled";
  finalText: string;
  usage?: Usage;
  error?: string;
}

export interface Executor {
  run(req: ExecuteRequest): Promise<ExecuteResult>;
}

export const HANDOFF_REMINDER =
  "你还没有调用 write_handoff。请现在调用一次：做了什么、改了哪些文件、还剩什么、建议下一步（检查角色要给出 verdict）。不要再做别的事。";
