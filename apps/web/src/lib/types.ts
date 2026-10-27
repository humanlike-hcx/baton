export type {
  AuthStatus,
  Briefing,
  ChatAccess,
  ChatModel,
  CheckResult,
  CredentialSource,
  Lesson,
  MemoryEntry,
  ReviewVerdict,
  Role,
  RunRecord,
  Thread,
  ThreadStatus,
  TidyRecord,
  TidyStatus,
  TimelineItem,
  WorkspaceSettings,
} from "@baton/core/types";

import type { AuthStatus, ChatModel, CredentialSource, ThreadStatus, WorkspaceSettings } from "@baton/core/types";

export interface ThreadSummary {
  id: string;
  title: string;
  status: ThreadStatus;
  updatedAt: string;
  runs: number;
  model?: ChatModel;
}

export interface AppStateResponse {
  workspace: { root: string; name: string; demo: boolean };
  recent: string[];
  auth: AuthStatus;
  settings: WorkspaceSettings;
  threads: ThreadSummary[];
  mockCursorCommand: string;
}

export interface ModelOption {
  id: string;
  name: string;
  contextWindow?: number;
  family: string;
}

/** One account route from `/api/models`: why it can't be used right now (if so), and every model it offers. */
export interface ModelRoute {
  source: CredentialSource;
  label: string;
  unavailable?: string;
  error?: string;
  models: ModelOption[];
}

export interface StatRow {
  key: string;
  runtime: string;
  source: CredentialSource;
  model: string;
  family: string;
  runs: number;
  succeeded: number;
  failed: number;
  changes: number;
  reviewsGiven: number;
  reviewedPass: number;
  reviewedFail: number;
  costUsd: number;
  tokens: number;
}
