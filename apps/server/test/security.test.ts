import fs from "node:fs";
import path from "node:path";
import type { AgentCard, MemoryEntry, Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

type Approval = Extract<TimelineItem, { kind: "approval" }>;
const pendingApproval = (t: Thread) => t.items.find((i): i is Approval => i.kind === "approval" && i.status === "pending");
const implementNow = (st: { confirm: { planToImplement: boolean } }) => (st.confirm.planToImplement = false);

async function updateAgent(s: Awaited<ReturnType<typeof testServer>>, id: string, patch: (a: AgentCard) => void) {
  const agent = (await s.get<AgentCard[]>("/api/agents")).find((a) => a.id === id)!;
  patch(agent);
  const res = await s.request("PUT", `/api/agents/${id}`, agent);
  expect(res.status, res.text).toBe(200);
}

const bridge = (s: Awaited<ReturnType<typeof testServer>>, tool: string, args: unknown, token?: string) =>
  s.request<{ text: string; isError?: boolean }>("POST", "/api/bridge/tool", { tool, args }, token ? { "x-baton-token": token } : {});

/** Starts a Cursor implementer run and waits until it asks for its first approval. */
async function cursorRunWaiting(s: Awaited<ReturnType<typeof testServer>>, task = "写一份说明") {
  const created = await s.post("/api/threads", { title: "Cursor", task, acceptance: ["有说明"], stage: "implement", agentId: "coder-cursor-composer" });
  const blocked = await s.waitForThread(created.id, (t) => Boolean(pendingApproval(t)), "Cursor approval");
  return { id: created.id as string, approval: pendingApproval(blocked)! };
}

async function approveAll(s: Awaited<ReturnType<typeof testServer>>, id: string, allow = true) {
  for (;;) {
    const t = await s.thread(id);
    if (!t.runs.some((r) => r.status === "running")) return s.settled(id);
    const pending = pendingApproval(t);
    if (pending) await s.post(`/api/approvals/${pending.approvalId}`, { allow });
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("HTTP API: one tool set for every route (US-52)", () => {
  it("lets a Cursor run call Baton's tools through the bridge with its own card and run", async () => {
    const s = await testServer({ autoApprove: false, settings: implementNow });
    const { id } = await cursorRunWaiting(s);

    const handoff = await bridge(s, "write_handoff", { done: "经 MCP 写的交接", files: [], next: "交给检查" });
    expect(handoff.status).toBe(200);
    expect(handoff.body.isError).toBeFalsy();
    const remembered = await bridge(s, "remember", { text: "Cursor 经 MCP 记下的一条约定", kind: "decision" });
    expect(remembered.body.isError, remembered.body.text).toBeFalsy();
    expect((await bridge(s, "remember", { text: "x", kind: "convention" })).body.isError).toBe(true);
    expect((await bridge(s, "read_context", {})).body.isError).toBeFalsy();
    expect((await bridge(s, "write_handoff", { done: "x" }, "not-a-run-token")).body).toMatchObject({ isError: true, text: "运行令牌无效或运行已结束" });
    expect((await bridge(s, "shell", { command: "ls" })).body).toMatchObject({ isError: true, text: "未知工具：shell" });

    const t = await approveAll(s, id);
    const run = t.runs.find((r) => r.stage === "implement")!;
    expect(run.handoff).toMatchObject({ done: "经 MCP 写的交接", auto: false });
    expect((await s.get<MemoryEntry[]>("/api/memory")).find((m) => m.text.includes("经 MCP"))).toMatchObject({ author: "coder-cursor-composer", run: run.id });

    expect((await bridge(s, "write_handoff", { done: "x" })).body).toMatchObject({ isError: true, text: "当前没有进行中的运行，无法写交接" });
    expect((await bridge(s, "memory_search", { query: "MCP" })).body.text).toContain("经 MCP 记下的一条约定");
  });

  it("applies the same permission checks on the bridge as on native tools", async () => {
    const s = await testServer({ settings: (st) => ((st.confirm.planToImplement = false), (st.memory.enabled = false)) });
    const native = await s.settled((await s.post("/api/threads", { title: "Pi", task: "写一份说明", acceptance: ["有说明"] })).id);
    const piRemember = native.items.find((i) => i.kind === "tool" && i.tool === "remember") as Extract<TimelineItem, { kind: "tool" }>;
    const viaBridge = await bridge(s, "remember", { text: "不该写进去" });
    expect(viaBridge.body.isError).toBe(true);
    expect(piRemember.result).toBe(viaBridge.body.text);
    expect(await s.get("/api/memory")).toEqual([]);
  });
});

describe("HTTP API: tool calls show their token cost (US-56)", () => {
  it("estimates the tokens every finished tool call adds to the context", async () => {
    const s = await testServer({ settings: implementNow });
    const t = await s.settled((await s.post("/api/threads", { title: "估算", task: "写一份说明", acceptance: ["有说明"] })).id);
    const tools = t.items.filter((i): i is Extract<TimelineItem, { kind: "tool" }> => i.kind === "tool" && i.status !== "running");
    expect(tools.length).toBeGreaterThan(3);
    for (const item of tools) expect(item.tokens, item.tool).toBeGreaterThan(0);
  });
});

describe("HTTP API: network policy (US-61)", () => {
  const webApprovals = (t: Thread) => t.items.filter((i): i is Approval => i.kind === "approval" && i.risk === "network");

  it("refuses a Cursor agent's web request when its network policy is deny, without asking", async () => {
    const s = await testServer({ autoApprove: false, settings: implementNow });
    await updateAgent(s, "coder-cursor-composer", (a) => (a.permissions.network = "deny"));
    const { id } = await cursorRunWaiting(s, "联网查一下文档再写说明");
    const t = await approveAll(s, id);
    expect(webApprovals(t)).toEqual([]);
    const audit = fs.readFileSync(path.join(s.root, ".baton/audit.jsonl"), "utf8");
    expect(audit).toContain('"acpPermission":"fetch"');
    expect(JSON.stringify(t.items)).not.toContain("example docs");
  });

  it("asks before a web request when the policy is ask, and allows it outright when allow", async () => {
    const s = await testServer({ autoApprove: false, settings: implementNow });
    await updateAgent(s, "coder-cursor-composer", (a) => (a.permissions.network = "ask"));
    const first = await cursorRunWaiting(s, "联网查一下文档再写说明");
    expect(first.approval).toMatchObject({ risk: "network", title: "Fetch https://example.com/docs" });
    expect(first.approval.preview).toContain("https://example.com/docs");
    await s.post(`/api/approvals/${first.approval.approvalId}`, { allow: false });
    const refused = await approveAll(s, first.id);
    expect(JSON.stringify(refused.items)).not.toContain("example docs");

    await updateAgent(s, "coder-cursor-composer", (a) => (a.permissions.network = "allow"));
    const second = await cursorRunWaiting(s, "联网查一下文档再写说明");
    const t = await approveAll(s, second.id);
    expect(webApprovals(t)).toEqual([]);
    expect(JSON.stringify(t.items)).toContain("example docs");
  });
});

describe("HTTP API: credentials stay on this machine (US-62)", () => {
  it("never sends a ChatGPT token or DeepSeek key to the browser, even while agents run", async () => {
    const s = await testServer({ settings: implementNow });
    const secrets = { access: "baton-test-access-token-0001", refresh: "baton-test-refresh-token-0002", key: "sk-baton0test0secret0key0123456789" };
    fs.writeFileSync(
      path.join(s.home, "credentials.json"),
      JSON.stringify({ openai: { type: "oauth", access: secrets.access, refresh: secrets.refresh, expires: Date.now() + 3_600_000 } }),
      { mode: 0o600 },
    );
    await s.post("/api/auth/deepseek", { key: secrets.key });
    expect(fs.statSync(path.join(s.home, "credentials.json")).mode & 0o777).toBe(0o600);
    await s.settled((await s.post("/api/threads", { title: "跑一下", task: "写一份说明", acceptance: ["有说明"] })).id);
    for (const url of ["/api/state", "/api/settings", "/api/agents", "/api/threads", "/api/stats", "/api/memory", "/api/context"]) await s.get(url);

    const seen = [...s.responses, ...s.events.map((e) => JSON.stringify(e))].join("\n");
    for (const secret of Object.values(secrets)) expect(seen).not.toContain(secret);
    expect(fs.readFileSync(path.join(s.root, ".baton/audit.jsonl"), "utf8")).not.toContain(secrets.key);
  });
});

describe("HTTP API: nothing leaves this machine (US-64)", () => {
  it("runs a whole relay without any outbound request and keeps its data in the workspace and data directory", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const s = await testServer({ settings: implementNow });
      let t = await s.settled((await s.post("/api/threads", { title: "离线", task: "写一份说明", acceptance: ["有说明"] })).id);
      while (t.pending) {
        await s.post(`/api/threads/${t.id}/decisions/${t.pending.id}`, { approve: true });
        t = await s.settled(t.id);
      }
      expect(t.status).toBe("done");
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
    expect(state.agents.filter((a: AgentCard & { available: boolean }) => a.runtime === "cursor").every((a: { available: boolean }) => !a.available)).toBe(true);

    await s.put("/api/settings", { ...settings, cursor: { command: state.mockCursorCommand } });
    state = await s.get("/api/state");
    expect(state.auth.cursor).toMatchObject({ installed: true, loggedIn: true, account: "demo@example.com" });
    expect(state.agents.find((a: { id: string }) => a.id === "coder-cursor-composer").available).toBe(true);
  });
});
