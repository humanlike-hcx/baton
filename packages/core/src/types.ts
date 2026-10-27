/** "chat" answers the user; "review" is the read-only check another model runs on a chat's changes. */
export type Role = "chat" | "review";
export type RuntimeKind = "pi" | "cursor";
/** Two subscriptions, any number of API key accounts, and the offline demo. */
export type CredentialSource = "chatgpt" | "cursor" | "key" | "demo";
/** Pi's reasoning levels; each model supports a subset. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Policy = "allow" | "ask" | "deny";
export type Risk = "read" | "write" | "exec" | "network" | "memory";
/** What a chat lets its model do: read only, ask before each change, or change directly. */
export type ChatAccess = "read" | "ask" | "allow";

export interface AgentPermissions {
  write: Policy;
  exec: Policy;
  network: Policy;
}

/** A model on one account route. */
export interface ChatModel {
  source: CredentialSource;
  model: string;
  /** Display name from the route's model list. */
  name: string;
  /** Key routes: the account's Pi provider ("deepseek", "anthropic", "custom-…"). */
  provider?: string;
  /** Key routes: the account's label, shown next to the model. */
  account?: string;
  /** Pi routes: the reasoning level; absent means the model's default. */
  thinking?: ThinkingLevel;
}

/** Who answers a run: a model on its route, with the permissions this run allows. Built per run, never stored. */
export interface RunAgent {
  /** `<source>:<model>`. */
  id: string;
  name: string;
  runtime: RuntimeKind;
  source: CredentialSource;
  /** Pi provider id ("openai", "deepseek", "custom-…", "demo"); "cursor" for the ACP runtime. */
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
  permissions: AgentPermissions;
}

export interface CheckCommand {
  name: string;
  command: string;
  timeoutSec?: number;
}

export interface WorkspaceSettings {
  version: 1;
  name: string;
  checks: CheckCommand[];
  permissions: {
    shellAllow: string[];
    shellDeny: string[];
    denyPaths: string[];
  };
  memory: { enabled: boolean };
  /** `context` is CONTEXT.md's tidy budget; `briefing` caps the whole briefing of a run. */
  budgets: { briefing: number; context: number };
  approvalTimeoutSec: number;
  cursor: { command: string };
}

export type MemoryKind = "fact" | "decision" | "preference";

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  status: "active" | "superseded";
  supersededBy?: string;
  author: string;
  run?: string;
  pinned: boolean;
  createdAt: string;
  text: string;
}

export interface Lesson {
  id: string;
  title: string;
  occurrences: number;
  status: "open" | "hardened" | "closed";
  hardenedBy?: string;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  totalTokens: number;
  costUsd: number;
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ReviewVerdict {
  verdict: "pass" | "fail";
  issues: string[];
}

export interface RunRecord {
  id: string;
  threadId: string;
  agentId: string;
  agentName: string;
  source: CredentialSource;
  /** Key routes: the account's Pi provider. */
  provider?: string;
  runtime: RuntimeKind;
  model: string;
  family: string;
  thinking?: ThinkingLevel;
  role: Role;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  snapshotBefore?: string;
  snapshotAfter?: string;
  briefingHash: string;
  briefingBytes: number;
  usage?: Usage;
  /** How full the model's context window was at the end of the run; absent when the runtime doesn't say (Cursor). */
  context?: { tokens: number; window: number };
  changedFiles: string[];
  finalText: string;
  error?: string;
  /** Chat runs: the user's message(s) this run answered. */
  prompt?: string;
  /** Review runs: the check commands run first, and the reviewer's verdict (never "pass" over a failed check). */
  checks?: CheckResult[];
  review?: ReviewVerdict;
  /** Review runs: the runs whose changes were reviewed. */
  reviewed?: string[];
}

export type CheckStatus = "pass" | "fail" | "skipped" | "error";

export interface CheckResult {
  name: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/** "waiting": queued behind another chat's write run. */
export type ThreadStatus = "idle" | "running" | "waiting" | "paused";

export type TimelineItem =
  | { id: string; at: string; kind: "user"; text: string }
  | { id: string; at: string; kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { id: string; at: string; kind: "run_start"; runId: string; agentId: string; agentName: string; role: Role; model: string; runtime: RuntimeKind; briefingBytes: number }
  | { id: string; at: string; kind: "text"; runId: string; text: string; thinking?: boolean }
  | {
      id: string;
      at: string;
      kind: "tool";
      runId: string;
      tool: string;
      args: string;
      status: "running" | "ok" | "error" | "denied";
      result?: string;
      tokens?: number;
    }
  | { id: string; at: string; kind: "approval"; runId: string; approvalId: string; risk: Risk; title: string; preview: string; status: "pending" | "allowed" | "denied" | "expired" }
  | { id: string; at: string; kind: "run_end"; runId: string; status: RunStatus; changedFiles: string[]; usage?: Usage; error?: string }
  | { id: string; at: string; kind: "checks"; runId?: string; results: CheckResult[] }
  | { id: string; at: string; kind: "review"; runId: string; agentName: string; verdict: ReviewVerdict; overruled?: string };

export interface Thread {
  id: string;
  title: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  summary: string;
  runs: RunRecord[];
  items: TimelineItem[];
  /** The model that answers the next message. */
  model?: ChatModel;
  /** Lasts until changed or the service restarts. */
  access: ChatAccess;
  /** Messages waiting for the next reply. */
  notes: string[];
}

export interface BriefingSection {
  key: string;
  title: string;
  source: string;
  content: string;
  bytes: number;
}

export interface Briefing {
  sections: BriefingSection[];
  text: string;
  bytes: number;
  budget: number;
  overBudget: boolean;
  duplicates: { line: string; sections: string[] }[];
  hash: string;
}

/** "chatgpt" is Sign in with ChatGPT; "codex" is the ChatGPT login the Codex CLI uses. Both bill the ChatGPT subscription. */
export type ChatGptMethod = "chatgpt" | "codex";

/** A key account as the browser sees it: never the key. */
export interface KeyAccountStatus {
  id: string;
  template: string;
  label: string;
  provider: string;
  baseUrl?: string;
  configured: boolean;
}

export interface AuthStatus {
  chatgpt: { loggedIn: boolean; method?: ChatGptMethod; pending?: { url: string; method: ChatGptMethod }; error?: string };
  cursor: { installed: boolean; loggedIn: boolean; account?: string; pending?: { url: string }; error?: string };
  keys: KeyAccountStatus[];
}

export interface TidyMemory {
  kind: MemoryKind;
  text: string;
  /** Set once written; absent when the memory store refused it (`skipped` says why). */
  id?: string;
  skipped?: string;
}

export interface TidyRecord {
  id: string;
  trigger: "auto" | "manual";
  status: "running" | "applied" | "failed" | "undone";
  model: string;
  budget: number;
  createdAt: string;
  endedAt?: string;
  before: string;
  after?: string;
  summary?: string;
  memories: TidyMemory[];
  error?: string;
  costUsd?: number;
}

export interface TidyStatus {
  bytes: number;
  budget: number;
  overBudget: boolean;
  /** Why tidying is unavailable right now (no DeepSeek key, memory off); absent when it can run. */
  unavailable?: string;
  records: TidyRecord[];
}
