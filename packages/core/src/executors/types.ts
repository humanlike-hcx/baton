import type { ToolContext, ToolSpec } from "../tools.ts";
import type { Briefing, Risk, Role, RunAgent, Thread, Usage } from "../types.ts";

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
  agent: RunAgent;
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
  /** A review run has called submit_review. */
  hasVerdict(): boolean;
  mcp?: McpLaunch;
  cursorCommand?: string;
}

export interface ExecuteResult {
  status: "succeeded" | "failed" | "cancelled";
  finalText: string;
  usage?: Usage;
  /** How full the context window was when the run ended, if the runtime reports it. */
  context?: { tokens: number; window: number };
  error?: string;
}

export interface Executor {
  run(req: ExecuteRequest): Promise<ExecuteResult>;
}

export const VERDICT_REMINDER = "你还没有调用 submit_review。请现在调用一次给出结论：pass，或 fail 并逐条列出问题。不要再做别的事。";
