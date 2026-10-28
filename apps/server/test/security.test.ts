import fs from "node:fs";
import path from "node:path";
import type { MemoryEntry, Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { CURSOR_COMPOSER, isPrivateFile, testServer } from "./helpers.ts";

type Approval = Extract<TimelineItem, { kind: "approval" }>;
type Server = Awaited<ReturnType<typeof testServer>>;
const pendingApproval = (t: Thread) => t.items.find((i): i is Approval => i.kind === "approval" && i.status === "pending");

const bridge = (s: Server, tool: string, args: unknown, token?: string) =>
  s.request<{ text: string; isError?: boolean }>("POST", "/api/bridge/tool", { tool, args }, token ? { "x-baton-token": token } : {});

/** Starts a Cursor chat at「每次问我」and waits until it asks for its first approval. */
async function cursorRunWaiting(s: Server, task = "写一份说明", access: "read" | "ask" = "ask") {
  const created = await s.chat(task, { model: CURSOR_COMPOSER, access });
  const blocked = await s.waitForThread(created.id, (t) => Boolean(pendingApproval(t)), "Cursor approval");
  return { id: created.id, approval: pendingApproval(blocked)! };
}

async function approveAll(s: Server, id: string, allow = true) {
  for (;;) {
    const t = await s.thread(id);
    if (!t.runs.some((r) => r.status === "running")) return s.settled(id);
    const pending = pendingApproval(t);
    if (pending) await s.post(`/api/approvals/${pending.approvalId}`, { allow });
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("HTTP API: one tool set for every route (US-52)", () => {
  it("lets a Cursor run call Baton's tools through the bridge as its own model and run", async () => {
    const s = await testServer({ autoApprove: false });
    const { id } = await cursorRunWaiting(s);

    const remembered = await bridge(s, "remember", { text: "Cursor 经 MCP 记下的一条约定", kind: "decision" });
    expect(remembered.body.isError, remembered.body.text).toBeFalsy();
    expect((await bridge(s, "remember", { text: "x", kind: "convention" })).body.isError).toBe(true);
    expect((await bridge(s, "read_context", {})).body.isError).toBeFalsy();
    expect((await bridge(s, "submit_review", { verdict: "pass" })).body).toMatchObject({ isError: true, text: "只有检查运行可以给出检查结论" });
    expect((await bridge(s, "remember", { text: "y" }, "not-a-run-token")).body).toMatchObject({ isError: true, text: "运行令牌无效或运行已结束" });
    expect((await bridge(s, "shell", { command: "ls" })).body).toMatchObject({ isError: true, text: "未知工具：shell" });

    const t = await approveAll(s, id);
    const run = t.runs[0]!;
    expect((await s.get<MemoryEntry[]>("/api/memory")).find((m) => m.text.includes("经 MCP"))).toMatchObject({ author: "cursor:composer-2.5", run: run.id });

    expect((await bridge(s, "submit_review", { verdict: "pass" })).body).toMatchObject({ isError: true, text: "当前没有进行中的检查，无法给出结论" });
    expect((await bridge(s, "memory_search", { query: "MCP" })).body.text).toContain("经 MCP 记下的一条约定");
  });

  it("applies the same permission checks on the bridge as on native tools", async () => {
    const s = await testServer({ settings: (st) => (st.memory.enabled = false) });
    const native = await s.settled((await s.chat("记住：不该写进去")).id);
    const piRemember = native.items.find((i) => i.kind === "tool" && i.tool === "remember") as Extract<TimelineItem, { kind: "tool" }>;
    const viaBridge = await bridge(s, "remember", { text: "不该写进去" });
    expect(viaBridge.body.isError).toBe(true);
    expect(piRemember.result).toBe(viaBridge.body.text);
    expect(await s.get("/api/memory")).toEqual([]);
  });
});

describe("HTTP API: tool calls show their token cost (US-56)", () => {
  it("estimates the tokens every finished tool call adds to the context", async () => {
    const s = await testServer();
    const t = await s.settled((await s.chat("写文件：notes/cost.md", { access: "allow" })).id);
    const tools = t.items.filter((i): i is Extract<TimelineItem, { kind: "tool" }> => i.kind === "tool" && i.status !== "running");
    expect(tools.length).toBeGreaterThanOrEqual(2);
    for (const item of tools) expect(item.tokens, item.tool).toBeGreaterThan(0);
  });
});

describe("HTTP API: network policy follows the chat's access (US-61)", () => {
  const webApprovals = (t: Thread) => t.items.filter((i): i is Approval => i.kind === "approval" && i.risk === "network");

  it("asks before a Cursor model's web request in a read-only or「每次问我」chat", async () => {
    const s = await testServer({ autoApprove: false });
    const first = await cursorRunWaiting(s, "联网查一下文档", "read");
    expect(first.approval).toMatchObject({ risk: "network", title: "Fetch https://example.com/docs" });
    expect(first.approval.preview).toContain("https://example.com/docs");
    await s.post(`/api/approvals/${first.approval.approvalId}`, { allow: false });
    const refused = await approveAll(s, first.id);
    expect(JSON.stringify(refused.items)).not.toContain("example docs");
  });

  it("allows it outright at「允许直接改」, and refuses it without asking during a review", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.chat("联网查一下文档再写说明", { model: CURSOR_COMPOSER, access: "allow" });
    const t = await approveAll(s, created.id);
    expect(webApprovals(t)).toEqual([]);
    expect(JSON.stringify(t.items)).toContain("example docs");

    const res = await s.request("POST", `/api/threads/${created.id}/review`, { source: "cursor", model: "claude-sonnet-5-5-medium" });
    expect(res.status).toBe(202);
    const reviewed = await s.waitForThread(created.id, (x) => x.runs.some((r) => r.role === "review" && r.status !== "running") && x.status !== "running", "review");
    expect(webApprovals(reviewed)).toEqual([]);
    const reviewRun = reviewed.runs.find((r) => r.role === "review")!;
    const fetches = reviewed.items.filter((i) => i.kind === "tool" && i.runId === reviewRun.id && i.tool.startsWith("Fetch"));
    expect(fetches).toEqual([expect.objectContaining({ status: expect.not.stringMatching(/^ok$/) })]);
  });
});

describe("HTTP API: credentials stay on this machine (US-62)", () => {
  it("never sends a ChatGPT token or DeepSeek key to the browser, even while models run", async () => {
    const s = await testServer();
    const secrets = { access: "baton-test-access-token-0001", refresh: "baton-test-refresh-token-0002", key: "sk-baton0test0secret0key0123456789" };
    fs.writeFileSync(
      path.join(s.home, "credentials.json"),
      JSON.stringify({ openai: { type: "oauth", access: secrets.access, refresh: secrets.refresh, expires: Date.now() + 3_600_000 } }),
      { mode: 0o600 },
    );
    await s.post("/api/auth/deepseek", { key: secrets.key });
    expect(isPrivateFile(path.join(s.home, "credentials.json"))).toBe(true);
    const chat = await s.settled((await s.chat("写文件：notes/run.md", { access: "allow" })).id);
    await s.post(`/api/threads/${chat.id}/review`, { source: "demo", model: "demo-review" });
    await s.waitForThread(chat.id, (t) => t.runs.length === 2 && t.status !== "running", "review");
    for (const url of ["/api/state", "/api/settings", "/api/models", "/api/threads", "/api/stats", "/api/memory", "/api/context", `/api/threads/${chat.id}`]) await s.get(url);

    const seen = [...s.responses, ...s.events.map((e) => JSON.stringify(e))].join("\n");
    for (const secret of Object.values(secrets)) expect(seen).not.toContain(secret);
    expect(fs.readFileSync(path.join(s.root, ".baton/audit.jsonl"), "utf8")).not.toContain(secrets.key);
  });
});

describe("HTTP API: nothing leaves this machine (US-64)", () => {
  it("runs a demo chat and review without any outbound request and keeps its data in the workspace and data directory", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const s = await testServer();
      let t = await s.settled((await s.chat("写文件：notes/offline.md", { access: "allow" })).id);
      await s.post(`/api/threads/${t.id}/review`, { source: "demo", model: "demo-review" });
      t = await s.waitForThread(t.id, (x) => x.runs.length === 2 && x.status !== "running", "review");
      expect(t.runs[1]!.review?.verdict).toBe("pass");
      expect(calls).toEqual([]);
      expect(fs.existsSync(path.join(s.root, ".baton/threads", `${t.id}.json`))).toBe(true);
      expect(fs.existsSync(path.join(s.home, "state.json"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("HTTP API: Cursor CLI missing (US-5)", () => {
  it("reports a missing CLI and switches to the built-in mock Cursor", async () => {
    const s = await testServer();
    const settings = await s.get("/api/settings");
    await s.put("/api/settings", { ...settings, cursor: { command: "baton-no-such-cursor-cli" } });
    let state = await s.get("/api/state");
    expect(state.auth.cursor).toMatchObject({ installed: false, loggedIn: false });
    const cursorRoute = async () => (await s.get<{ routes: { source: string; unavailable?: string; models: unknown[] }[] }>("/api/models")).routes.find((r) => r.source === "cursor")!;
    expect((await cursorRoute()).unavailable).toContain("没有找到 Cursor CLI");

    await s.put("/api/settings", { ...settings, cursor: { command: state.mockCursorCommand } });
    state = await s.get("/api/state");
    expect(state.auth.cursor).toMatchObject({ installed: true, loggedIn: true, account: "demo@example.com" });
    const route = await cursorRoute();
    expect(route.unavailable).toBeUndefined();
    expect(route.models.length).toBeGreaterThan(0);
  });
});
