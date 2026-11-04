export type Access = "read" | "ask" | "allow";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface ModelOption {
  id: string; name: string; api: "openai-completions" | "openai-responses";
  contextWindow?: number; maxTokens?: number; thinking: Thinking[]; fastMode?: boolean;
  verified: boolean; verifiedAt?: string; error?: string;
  checkedAt?: string; enabled?: boolean; checkStatus?: "pending" | "checking" | "ready" | "failed";
}
export interface ModelPick { id: string; thinking?: Thinking; serviceTier?: "priority" }
export interface GatewayPublic { url: string; configured: boolean; hasToken: boolean; status: string; error?: string; models: ModelOption[]; managed?: boolean; defaultModelId?: string }
export interface Resource { id: string; kind: "rule" | "skill" | "extension"; path: string; enabled: boolean; error?: string; hash?: string; compatible?: boolean }
export interface McpConfig { name: string; command?: string; args?: string[]; url?: string; enabled: boolean }
export interface Project { id: string; root: string; name: string; removed?: boolean; resources: Resource[]; mcp: McpConfig[] }
export interface Run {
  id: string; threadId: string; projectId?: string; model: ModelPick; status: Status;
  prompt: string; startedAt: string; endedAt?: string; error?: string;
  changedFiles: string[]; restoreBlocked?: string; restoredAt?: string;
  usage?: { input?: number; output?: number; total?: number; source: "reported"; costUsd?: number };
}
export interface Item {
  id: string; at: string; kind: "user" | "assistant" | "tool" | "approval" | "notice";
  runId?: string; text: string; tool?: string; args?: unknown; details?: unknown;
  status?: string; approvalId?: string;
}
export interface Thread {
  id: string; projectId?: string; title: string; access: Access; model?: ModelPick;
  status: "idle" | "queued" | "running"; createdAt: string; updatedAt: string;
  archivedAt?: string; sessionFile?: string; runs: Run[]; items: Item[];
  pending: { text: string; mode: "steer" | "followUp" }[];
}
export interface AppView { projects: Project[]; threads: Thread[]; archivedThreads: Pick<Thread, "id" | "projectId" | "title" | "archivedAt" | "updatedAt">[]; gateway: GatewayPublic; closing: boolean }
export interface FileChange { path: string; before?: string; after?: string; binary: boolean; kind: "add" | "delete" | "modify" }
export interface ChangePreview { runId: string; changes: FileChange[]; token: string; conflicts: string[]; blocked?: string; excluded: string[] }
