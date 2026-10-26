import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { AcpExecutor } from "../src/executors/acp.ts";
import { PiExecutor } from "../src/executors/pi.ts";
import { Orchestrator, type OrchestratorEvent } from "../src/orchestrator.ts";
import type { Thread } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

export function tempDir(prefix = "wb-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function memoryCredentials(): CredentialStore {
  const mem = new Map<string, any>();
  return {
    async read(id) {
      return mem.get(id);
    },
    async list() {
      return [...mem.entries()].map(([providerId, c]) => ({ providerId, type: c.type }));
    },
    async modify(id, fn) {
      const next = await fn(mem.get(id));
      if (next) mem.set(id, next);
      return mem.get(id);
    },
    async delete(id) {
      mem.delete(id);
    },
  };
}

export const MOCK_ACP = path.resolve(import.meta.dirname, "../fixtures/mock-acp-agent.mjs");

export function demoSetup(options: { autoApprove?: boolean; mutate?: (ws: Workspace) => void } = {}) {
  const root = tempDir();
  const ws = Workspace.open(root, { demo: true });
  options.mutate?.(ws);
  const events: OrchestratorEvent[] = [];
  let orch!: Orchestrator;
  orch = new Orchestrator({
    ws,
    pi: new PiExecutor({ credentials: memoryCredentials(), agentDir: tempDir("wb-agent-"), demoTokensPerSecond: 100_000 }),
    acp: new AcpExecutor(),
    available: (agent) => agent.source === "demo" || (agent.source === "cursor" && ws.settings().cursor.command.includes("mock-acp")),
    onEvent: (e) => {
      events.push(e);
      if (options.autoApprove !== false && e.type === "thread") {
        for (const item of e.thread.items) {
          if (item.kind === "approval" && item.status === "pending") {
            queueMicrotask(() => {
              try {
                orch.respondApproval(item.approvalId, true);
              } catch {
                /* already handled */
              }
            });
          }
        }
      }
    },
  });
  return { root, ws, orch, events };
}

export async function waitFor(fn: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function waitForSettled(orch: Orchestrator, threadId: string, timeoutMs = 30_000): Promise<Thread> {
  await waitFor(
    () => {
      const t = orch.getThread(threadId)!;
      return t.status === "waiting" || t.status === "paused" || t.status === "done" || (t.status === "idle" && t.runs.length > 0);
    },
    timeoutMs,
    `thread ${threadId} to settle`,
  );
  await new Promise((r) => setTimeout(r, 30));
  return orch.getThread(threadId)!;
}
