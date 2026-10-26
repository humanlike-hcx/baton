export type {
  AgentCard,
  AuthStatus,
  Briefing,
  CheckResult,
  Handoff,
  Lesson,
  MemoryEntry,
  PendingDecision,
  Role,
  RunRecord,
  Stage,
  Thread,
  ThreadKind,
  ThreadStatus,
  TimelineItem,
  WorkspaceSettings,
} from "@baton/core/types";

import type { AgentCard, AuthStatus, Stage, ThreadKind, ThreadStatus, WorkspaceSettings } from "@baton/core/types";

export interface AgentView extends AgentCard {
  available: boolean;
  routeError?: string;
}

export interface ThreadSummary {
  id: string;
  kind: ThreadKind;
  title: string;
  stage: Stage;
  status: ThreadStatus;
  updatedAt: string;
  pending?: string;
  runs: number;
}

export interface AppStateResponse {
  workspace: { root: string; name: string; demo: boolean };
  recent: string[];
  auth: AuthStatus;
  settings: WorkspaceSettings;
  agents: AgentView[];
  threads: ThreadSummary[];
  mockCursorCommand: string;
}

export interface ModelOption {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface ModelsResponse {
  chatgpt: ModelOption[];
  deepseek: ModelOption[];
  cursor: ModelOption[];
  cursorError?: string;
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
