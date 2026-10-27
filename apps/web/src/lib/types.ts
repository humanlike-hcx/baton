export type {
  AuthStatus,
  Briefing,
  ChatAccess,
  ChatModel,
  CheckResult,
  CredentialSource,
  KeyAccountStatus,
  Lesson,
  MemoryEntry,
  ReviewVerdict,
  ThinkingLevel,
  Role,
  RunRecord,
  Thread,
  ThreadStatus,
  TidyRecord,
  TidyStatus,
  TimelineItem,
  WorkspaceSettings,
} from "@baton/core/types";

import type { CursorVariant } from "@baton/core/families";
import type { AuthStatus, ChatModel, CredentialSource, ThinkingLevel, ThreadStatus, WorkspaceSettings } from "@baton/core/types";

export interface ThreadSummary {
  id: string;
  title: string;
  status: ThreadStatus;
  updatedAt: string;
  runs: number;
  model?: ChatModel;
}

/** An open workspace in the sidebar, with its chats. */
export interface Project {
  root: string;
  name: string;
  demo: boolean;
  threads: ThreadSummary[];
}

export interface AppStateResponse {
  /** The current project: what the management pages show and where a new chat opens. */
  workspace: { root: string; name: string; demo: boolean };
  projects: Project[];
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
  /** Pi routes: the thinking levels the model supports; absent when it doesn't reason. */
  thinking?: ThinkingLevel[];
  /** Cursor: which variant of a model this id is. */
  variant?: CursorVariant;
}

/** One account route from `/api/models`: why it can't be used right now (if so), and every model it offers. */
export interface ModelRoute {
  source: CredentialSource;
  /** Key routes: the account's Pi provider, and which service template it came from. */
  provider?: string;
  template?: string;
  label: string;
  unavailable?: string;
  error?: string;
  models: ModelOption[];
}

export interface StatRow {
  key: string;
  runtime: string;
  source: CredentialSource;
  provider?: string;
  account?: string;
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
