/** Relay stages, plus "chat" for every run of a chat thread (which has no stages). */
export type Stage = "plan" | "implement" | "review" | "done" | "chat";
export type Role = "plan" | "implement" | "review" | "advisor" | "chat";
export type ThreadKind = "relay" | "chat";
export type RuntimeKind = "pi" | "cursor";
export type CredentialSource = "chatgpt" | "deepseek" | "cursor" | "demo";
export type Policy = "allow" | "ask" | "deny";
export type Risk = "read" | "write" | "exec" | "network" | "memory";

export interface AgentPermissions {
  write: Policy;
  exec: Policy;
  network: Policy;
}

export interface AgentCard {
  id: string;
  name: string;
  runtime: RuntimeKind;
  source: CredentialSource;
  /** Pi provider id ("openai", "deepseek", "demo"); "cursor" for the ACP runtime. */
  provider: string;
  model: string;
  roles: Role[];
  permissions: AgentPermissions;
  /** 0 = free (demo), 1 = cheap, 2 = medium, 3 = expensive. */
  costTier: number;
  enabled: boolean;
  /** Body of the card: the agent's own duties, injected into its briefing. */
  body: string;
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
  limits: {
    maxHops: number;
    maxSendBacks: number;
    maxStalls: number;
    deepseekCnyPerThread: number;
    chatgptRunsPerThread: number;
    cursorRunsPerThread: number;
  };
  confirm: {
    planToImplement: boolean;
    complete: boolean;
  };
  advisor: {
    onSecondSendBack: boolean;
    onRepeatedIssues: boolean;
    beforePlan: boolean;
  };
  permissions: {
    exec: Policy;
    network: Policy;
    shellAllow: string[];
    shellDeny: string[];
    denyPaths: string[];
  };
  memory: { enabled: boolean };
  /** `context` is CONTEXT.md's tidy budget; the others cap the whole briefing per role. */
  budgets: { planner: number; executor: number; context: number };
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

export interface Handoff {
  runId: string;
  threadId: string;
  agentId: string;
  stage: Stage;
  createdAt: string;
  auto: boolean;
  done: string;
  files: string[];
  remaining: string;
  next: string;
  verdict?: "pass" | "fail";
  issues?: string[];
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  totalTokens: number;
  costUsd: number;
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  threadId: string;
  agentId: string;
  agentName: string;
  runtime: RuntimeKind;
  model: string;
  family: string;
  stage: Stage;
  role: Role;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  snapshotBefore?: string;
  snapshotAfter?: string;
  briefingHash: string;
  briefingBytes: number;
  handoff?: Handoff;
  usage?: Usage;
  changedFiles: string[];
  decisions: number;
  finalText: string;
  error?: string;
  proposedNext?: { stage: Stage; reason: string; acceptance: string[] };
  checks?: CheckResult[];
  /** Chat runs: the user's message(s) this run answered. */
  prompt?: string;
  /** Handoff draft taken from the latest in-run compaction summary (Pi only). */
  progress?: CompactionProgress;
}

export interface CompactionProgress {
  compactions: number;
  done: string[];
  remaining: string[];
  next: string[];
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

export type ThreadStatus = "idle" | "running" | "waiting" | "paused" | "done";

export type DecisionKind = "start_stage" | "complete" | "violation";

export interface PendingDecision {
  id: string;
  kind: DecisionKind;
  title: string;
  detail: string;
  stage?: Stage;
  agentId?: string;
  candidates?: string[];
  advice?: string;
  createdAt: string;
}

export type TimelineItem =
  | { id: string; at: string; kind: "user"; text: string }
  | { id: string; at: string; kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { id: string; at: string; kind: "run_start"; runId: string; agentId: string; agentName: string; stage: Stage; model: string; runtime: RuntimeKind; briefingBytes: number }
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
  | { id: string; at: string; kind: "handoff"; runId: string; handoff: Handoff }
  | { id: string; at: string; kind: "checks"; runId?: string; results: CheckResult[] }
  | { id: string; at: string; kind: "decision"; decision: PendingDecision; resolution?: "approved" | "rejected" }
  | { id: string; at: string; kind: "advisor"; runId: string; agentName: string; card: AdvisorCard; advice: string };

export interface AdvisorCard {
  facts: string;
  judgement: string;
  hoping: string;
}

export interface Thread {
  id: string;
  kind: ThreadKind;
  title: string;
  task: string;
  acceptance: string[];
  stage: Stage;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  hops: number;
  sendBacks: number;
  stalls: number;
  summary: string;
  runs: RunRecord[];
  items: TimelineItem[];
  pending?: PendingDecision;
  /** Preferred agent per stage, chosen by the user. Chat threads keep the agent that replies under "chat". */
  pinnedAgents: Partial<Record<Stage, string>>;
  spend: { deepseekCny: number; chatgptRuns: number; cursorRuns: number };
  reviewIssueRounds: number;
  /** Highest agent permission level the user has consented to in this thread. Chat threads may write only at ≥ 2. */
  approvedLevel: number;
  /** Extra automatic hops granted by the user after hitting the hop limit. */
  extraHops: number;
  /** User notes queued for the next run. */
  notes: string[];
  /** Chat only: a relay task being drafted from the conversation, waiting for the user's confirmation. */
  promotion?: Promotion;
  /** Chat only: relay threads started from this conversation. */
  relays?: string[];
  /** Relay only: the chat thread this relay was started from. */
  fromChat?: string;
}

export interface RelayDraft {
  title: string;
  task: string;
  acceptance: string[];
}

export interface Promotion {
  status: "drafting" | "ready" | "failed";
  agentId: string;
  runId?: string;
  /** What the agent drafted, or a starting point taken from the conversation when it could not. */
  draft: RelayDraft;
  error?: string;
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

export interface AuthStatus {
  chatgpt: { loggedIn: boolean; pending?: { url: string } };
  deepseek: { configured: boolean };
  cursor: { installed: boolean; loggedIn: boolean; account?: string; pending?: { url: string }; error?: string };
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
