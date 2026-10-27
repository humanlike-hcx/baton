import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Thread, WorkspaceSettings } from "@baton/core";
import { createApp } from "../src/app.ts";
import { AppState, MOCK_CURSOR, nodeScriptCommand } from "../src/state.ts";

export const HOST = "127.0.0.1:47321";
export const MOCK_CURSOR_COMMAND = nodeScriptCommand(MOCK_CURSOR);

export interface ModelRef {
  source: string;
  model: string;
}

export const DEMO_CHAT: ModelRef = { source: "demo", model: "demo-chat" };
export const DEMO_REVIEW: ModelRef = { source: "demo", model: "demo-review" };
export const CURSOR_COMPOSER: ModelRef = { source: "cursor", model: "composer-2.5" };
export const CURSOR_SONNET: ModelRef = { source: "cursor", model: "claude-sonnet-5-5-medium" };

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  text: string;
}

/**
 * A complete Baton service in-process: temporary data directory and workspace, demo models,
 * the mock Cursor CLI, and no listening port. Every response body is recorded so tests can
 * assert on what ever reached the browser.
 */
export async function testServer(
  options: {
    autoApprove?: boolean;
    settings?: (s: WorkspaceSettings) => void;
    /** Restart on an earlier server's directories. */
    reuse?: { home: string; root: string };
    /** Folder dialog stand-in; the default refuses instead of opening a real dialog. */
    pickDirectory?: () => Promise<string | undefined>;
    /** Runs after the temp directories exist and before the service starts. */
    prepare?: (dirs: { home: string; root: string }) => void;
    /** Codex CLI auth.json. Defaults to a file that is not there, so a real login is never imported. */
    codexAuthFile?: string | ((home: string) => string);
  } = {},
) {
  const home = options.reuse?.home ?? tempDir("baton-home-");
  const root = options.reuse?.root ?? tempDir("baton-ws-");
  options.prepare?.({ home, root });
  // Port 9 (discard) is never served, so the mock Cursor's MCP callbacks fail fast instead of reaching a dev server.
  const state = new AppState({
    baseUrl: "http://127.0.0.1:9",
    home,
    workspace: root,
    demo: true,
    cursorCommand: MOCK_CURSOR_COMMAND,
    demoTokensPerSecond: 100_000,
    pickDirectory: options.pickDirectory ?? (async () => Promise.reject(new Error("测试没有配置文件夹选择"))),
    codexAuthFile: (typeof options.codexAuthFile === "function" ? options.codexAuthFile(home) : options.codexAuthFile) ?? path.join(home, "no-such-codex-auth.json"),
  });
  await state.init();
  const app = createApp(state);
  const responses: string[] = [];
  const events: { type: string; [k: string]: unknown }[] = [];

  async function request<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const res = await app.request(url, {
      method,
      headers: { host: HOST, "x-baton": "1", "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    responses.push(text);
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T, text };
  }

  async function ok<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await request<T>(method, url, body);
    if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${res.text}`);
    return res.body;
  }

  state.subscribe((message) => {
    const event = message as { type: string; thread?: Thread };
    events.push(event);
    if (options.autoApprove === false || event.type !== "thread" || !event.thread) return;
    for (const item of event.thread.items) {
      if (item.kind === "approval" && item.status === "pending") {
        setTimeout(() => void request("POST", `/api/approvals/${item.approvalId}`, { allow: true }), 0);
      }
    }
  });

  if (options.settings) {
    const s = await ok<WorkspaceSettings>("GET", "/api/settings");
    options.settings(s);
    await ok("PUT", "/api/settings", s);
  }

  const thread = (id: string) => ok<Thread>("GET", `/api/threads/${id}`);

  async function waitForThread(id: string, predicate: (t: Thread) => boolean, label = "thread condition", timeoutMs = 30_000): Promise<Thread> {
    const start = Date.now();
    for (;;) {
      const t = await thread(id);
      if (predicate(t)) return t;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}; status ${t.status}, ${t.runs.length} runs`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Waits until no run is in progress and the thread is waiting for the user. */
  const settled = (id: string, timeoutMs?: number) =>
    waitForThread(
      id,
      (t) => !t.runs.some((r) => r.status === "running") && (t.status === "waiting" || t.status === "paused" || (t.status === "idle" && t.runs.length > 0 && t.notes.length === 0)),
      "thread to settle",
      timeoutMs,
    );

  /** Opens a chat on `model`, optionally sets its access, and sends `task` if given. */
  async function chat(task: string, options: { model?: ModelRef; access?: "read" | "ask" | "allow" } = {}): Promise<Thread> {
    const created = await ok<Thread>("POST", "/api/threads", { task: options.access ? "" : task, ...(options.model ?? DEMO_CHAT) });
    if (options.access) {
      await ok("POST", `/api/threads/${created.id}/access`, { access: options.access });
      if (task) await ok("POST", `/api/threads/${created.id}/messages`, { text: task });
    }
    return created;
  }

  /** Sends a message and waits for the reply to it. */
  async function say(threadId: string, text: string, model?: ModelRef): Promise<Thread> {
    const before = (await thread(threadId)).runs.length;
    await ok("POST", `/api/threads/${threadId}/messages`, { text, ...model });
    return waitForThread(threadId, (t) => t.runs.length > before && !t.runs.some((r) => r.status === "running") && t.status !== "running", "chat reply");
  }

  return {
    state,
    app,
    home,
    root,
    responses,
    events,
    request,
    get: <T = any>(url: string) => ok<T>("GET", url),
    post: <T = any>(url: string, body: unknown = {}) => ok<T>("POST", url, body),
    put: <T = any>(url: string, body: unknown) => ok<T>("PUT", url, body),
    thread,
    waitForThread,
    settled,
    chat,
    say,
  };
}
