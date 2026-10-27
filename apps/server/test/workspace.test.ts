import fs from "node:fs";
import path from "node:path";
import type { Briefing, MemoryEntry, StatRow, Thread } from "@baton/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { AppState } from "../src/state.ts";
import { HOST, tempDir, testServer } from "./helpers.ts";

const implementNow = (st: { confirm: { planToImplement: boolean } }) => (st.confirm.planToImplement = false);

/** Runs a relay thread to its completion card and accepts it. */
async function finish(s: Awaited<ReturnType<typeof testServer>>, id: string): Promise<Thread> {
  let t = await s.settled(id);
  while (t.pending) {
    await s.post(`/api/threads/${id}/decisions/${t.pending.id}`, { approve: true });
    t = await s.settled(id);
  }
  return t;
}

describe("HTTP API: room context (US-40)", () => {
  it("edits CONTEXT.md within its size cap, and agents see and maintain it", async () => {
    const s = await testServer({ settings: implementNow });
    await s.put("/api/context", { content: "# 房间上下文\n\n- 文档一律写中文\n" });
    expect((await s.get<{ content: string }>("/api/context")).content).toContain("文档一律写中文");
    expect(fs.readFileSync(path.join(s.root, ".baton/CONTEXT.md"), "utf8")).toContain("文档一律写中文");

    const tooBig = await s.request("PUT", "/api/context", { content: "x".repeat(8 * 1024 + 1) });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toContain("8KB");
    expect((await s.get<{ content: string }>("/api/context")).content).toContain("文档一律写中文");

    const briefing = await s.get<Briefing>("/api/agents/demo-coder/briefing?role=implement");
    expect(briefing.sections.find((x) => x.key === "context")?.content).toContain("文档一律写中文");

    const created = await s.post("/api/threads", { title: "定约定", task: "整理约定。写进上下文：产出都放在 notes/ 下", acceptance: ["有约定"] });
    const t = await s.settled(created.id);
    expect(t.items.find((i) => i.kind === "tool" && i.tool === "update_context")).toMatchObject({ status: "ok" });
    expect((await s.get<{ content: string }>("/api/context")).content).toContain("产出都放在 notes/ 下");
  });
});

describe("HTTP API: shared memory (US-47)", () => {
  it("adds, pins, supersedes and retires entries, and refuses near-duplicates", async () => {
    const s = await testServer();
    const a = await s.post<MemoryEntry>("/api/memory", { text: "发布前要跑 pnpm test 和 pnpm typecheck", kind: "decision" });
    expect(a).toMatchObject({ kind: "decision", status: "active", pinned: false, author: "user" });

    const dup = await s.request("POST", "/api/memory", { text: "发布前要跑 pnpm test 和 pnpm typecheck。" });
    expect(dup.status).toBe(400);

    await s.request("PATCH", `/api/memory/${a.id}`, { pinned: true });
    let briefing = await s.get<Briefing>("/api/agents/demo-coder/briefing?role=implement");
    expect(briefing.text).toContain("发布前要跑 pnpm test");

    const b = await s.post<MemoryEntry>("/api/memory", { text: "发布前只要求 CI 通过", kind: "decision", supersedes: a.id });
    let list = await s.get<MemoryEntry[]>("/api/memory");
    expect(list.find((m) => m.id === a.id)).toMatchObject({ status: "superseded", supersededBy: b.id });
    expect(list.find((m) => m.id === b.id)).toMatchObject({ status: "active" });
    briefing = await s.get<Briefing>("/api/agents/demo-coder/briefing?role=implement");
    expect(briefing.text).not.toContain("发布前要跑 pnpm test");

    await s.request("PATCH", `/api/memory/${b.id}`, { status: "superseded" });
    list = await s.get<MemoryEntry[]>("/api/memory");
    expect(list).toHaveLength(2);
    expect(list.every((m) => m.status === "superseded")).toBe(true);
    expect((await s.request("PATCH", "/api/memory/mem_missing", { pinned: true })).status).toBe(400);
  });
});

describe("HTTP API: memory switched off (US-48)", () => {
  it("writes no memory in a workspace that turned it off, from the user or from agents", async () => {
    const s = await testServer({ settings: (st) => ((st.confirm.planToImplement = false), (st.memory.enabled = false)) });
    const res = await s.request("POST", "/api/memory", { text: "不该写进去" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("关闭记忆");

    const created = await s.post("/api/threads", { title: "不记", task: "写一份说明", acceptance: ["有说明"] });
    const t = await s.settled(created.id);
    expect(t.items.find((i) => i.kind === "tool" && i.tool === "remember")).toMatchObject({ status: "error" });
    expect(await s.get("/api/memory")).toEqual([]);
    expect(fs.readdirSync(path.join(s.root, ".baton/memory"))).toEqual([]);
  });
});

describe("HTTP API: trying a check command (US-68)", () => {
  it("runs the command in the workspace and reports its status and output", async () => {
    const s = await testServer();
    fs.writeFileSync(path.join(s.root, "marker.txt"), "hi\n");
    const pass = await s.post("/api/checks/try", { name: "列文件", command: "ls marker.txt" });
    expect(pass).toMatchObject({ name: "列文件", status: "pass", exitCode: 0 });
    expect(pass.output).toContain("marker.txt");
    const fail = await s.post("/api/checks/try", { command: "echo boom >&2; exit 3" });
    expect(fail).toMatchObject({ status: "fail", exitCode: 3 });
    expect(fail.output).toContain("boom");
  });
});

describe("HTTP API: the demo workspace on first start (US-83)", () => {
  it("stays the demo workspace after a restart, even when the data directory is reached through a link", async () => {
    const real = tempDir("baton-home-real-");
    const home = path.join(tempDir("baton-home-link-"), "home");
    fs.symlinkSync(real, home);
    const start = async () => {
      const state = new AppState({ baseUrl: "http://127.0.0.1:9", home });
      await state.init();
      const res = await createApp(state).request("/api/state", { headers: { host: HOST } });
      return (await res.json()) as { workspace: { root: string; name: string; demo: boolean } };
    };

    const first = await start();
    expect(first.workspace).toMatchObject({ name: "demo-workspace", demo: true });
    const again = await start();
    expect(again.workspace).toMatchObject({ root: first.workspace.root, demo: true });
  });
});

describe("HTTP API: workspaces (US-75)", () => {
  it("opens and creates workspaces, lists recent ones, and switches back", async () => {
    const s = await testServer();
    const first = fs.realpathSync(s.root);
    const second = path.join(tempDir("baton-ws2-"), "project");

    const missing = await s.request("POST", "/api/workspace/open", { path: second });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("目录不存在");

    await s.post("/api/workspace/open", { path: second, create: true });
    let state = await s.get("/api/state");
    expect(state.workspace.root).toBe(fs.realpathSync(second));
    expect(state.recent).toEqual([fs.realpathSync(second), first]);
    expect(fs.existsSync(path.join(second, ".baton/agents"))).toBe(true);
    expect(await s.get("/api/threads")).toEqual([]);

    await s.post("/api/workspace/open", { path: first });
    state = await s.get("/api/state");
    expect(state.workspace.root).toBe(first);
    expect(state.recent[0]).toBe(first);
    expect((await s.request("POST", "/api/workspace/open", { path: "  " })).status).toBe(400);
  });

  it("refuses to switch while a run is in progress", async () => {
    const s = await testServer({ autoApprove: false });
    const other = tempDir("baton-ws3-");
    const a = await s.post("/api/threads", { title: "占着", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    await s.waitForThread(a.id, (t) => t.items.some((i) => i.kind === "approval" && i.status === "pending"), "command approval");

    const busy = await s.request("POST", "/api/workspace/open", { path: other });
    expect(busy.status).toBe(400);
    expect(busy.body.error).toContain("先取消再切换");
    expect((await s.get("/api/state")).workspace.root).toBe(fs.realpathSync(s.root));

    await s.post(`/api/threads/${a.id}/cancel`);
    await s.settled(a.id);
    await s.post("/api/workspace/open", { path: other });
    expect((await s.get("/api/state")).workspace.root).toBe(fs.realpathSync(other));
  });
});

describe("HTTP API: signing out (US-9)", () => {
  it("signs out of ChatGPT and removes the DeepSeek key", async () => {
    const s = await testServer();
    const file = path.join(s.home, "credentials.json");
    fs.writeFileSync(file, JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
    await s.post("/api/auth/deepseek", { key: "sk-baton0test0secret0key0123456789" });
    let state = await s.get("/api/state");
    expect(state.auth.chatgpt.loggedIn).toBe(true);
    expect(state.auth.deepseek.configured).toBe(true);

    await s.post("/api/auth/chatgpt/logout");
    await s.request("DELETE", "/api/auth/deepseek");
    state = await s.get("/api/state");
    expect(state.auth.chatgpt.loggedIn).toBe(false);
    expect(state.auth.deepseek.configured).toBe(false);
    expect(state.agents.find((a: { id: string }) => a.id === "planner-gpt").available).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({});
  });
});

describe("HTTP API: ChatGPT through the Codex login (US-88)", () => {
  const oauth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000, accountId: "acct" };

  it("runs GPT agents on the Codex login and lists only the models it offers", async () => {
    const s = await testServer();
    const file = path.join(s.home, "credentials.json");
    fs.writeFileSync(file, JSON.stringify({ "openai-codex": oauth }), { mode: 0o600 });
    const state = await s.get("/api/state");
    expect(state.auth.chatgpt).toMatchObject({ loggedIn: true, method: "codex" });

    const models = (await s.get<{ chatgpt: { id: string }[] }>("/api/models")).chatgpt.map((m) => m.id);
    expect(models).toContain("gpt-6.1-sol");
    expect(models).not.toContain("gpt-5.5");

    // A model the Codex login lacks fails before any request, with a fix the user can make.
    const agent = { name: "旧 GPT", runtime: "pi", source: "chatgpt", provider: "openai", model: "gpt-5.5", roles: ["chat"], permissions: { write: "deny", exec: "deny", network: "deny" }, costTier: 3, enabled: true, body: "" };
    await s.put("/api/agents/old-gpt", agent);
    expect((await s.get("/api/state")).agents.find((a: { id: string }) => a.id === "old-gpt").available).toBe(true);
    const created = await s.post<Thread>("/api/threads", { kind: "chat", task: "在吗", agentId: "old-gpt" });
    const t = await s.waitForThread(created.id, (x) => x.runs.length > 0 && x.runs[0]!.status !== "running", "failed run");
    expect(t.runs[0]).toMatchObject({ status: "failed" });
    expect(t.runs[0]!.error).toContain("用 Codex 账号登录时没有 gpt-5.5");

    fs.writeFileSync(file, JSON.stringify({ openai: oauth, "openai-codex": oauth }), { mode: 0o600 });
    expect((await s.get("/api/state")).auth.chatgpt.method).toBe("chatgpt");
    await s.post("/api/auth/chatgpt/logout");
    expect((await s.get("/api/state")).auth.chatgpt.loggedIn).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({});
  });

  it("starts the Codex login and shows why it failed", async () => {
    const s = await testServer();
    expect((await s.request("POST", "/api/auth/chatgpt/login", { method: "apikey" })).status).toBe(400);

    const { url } = await s.post<{ url: string }>("/api/auth/chatgpt/login", { method: "codex" });
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(auth.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(auth.searchParams.get("originator")).toBe("Baton");
    expect((await s.get("/api/state")).auth.chatgpt.pending).toEqual({ url, method: "codex" });

    await s.post("/api/auth/chatgpt/manual", { input: "http://localhost:1455/auth/callback?code=c&state=not-ours" });
    const start = Date.now();
    let chatgpt;
    for (;;) {
      chatgpt = (await s.get("/api/state")).auth.chatgpt;
      if (chatgpt.error || Date.now() - start > 5_000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(chatgpt).toMatchObject({ loggedIn: false, error: "State mismatch" });
    expect(chatgpt.pending).toBeUndefined();
  });
});

describe("HTTP API: stats (US-76)", () => {
  it("counts runs, first-pass and send-backs, decisions and tokens per runtime and model", async () => {
    const s = await testServer();
    await finish(s, (await s.post("/api/threads", { title: "一次通过", task: "写一份说明", acceptance: ["有说明"] })).id);
    await finish(s, (await s.post("/api/threads", { title: "会被退回", task: "写一份说明，检查时退回一次", acceptance: ["有说明"] })).id);

    const rows = await s.get<StatRow[]>("/api/stats");
    const coder = rows.find((r) => r.agentIds.includes("demo-coder"))!;
    expect(coder.stages.implement).toMatchObject({ runs: 3, succeeded: 3, firstPass: 1, sentBack: 1 });
    expect(coder.tokens).toBeGreaterThan(0);
    expect(coder.costUsd).toBe(0);
    const planner = rows.find((r) => r.agentIds.includes("demo-planner"))!;
    expect(planner.stages.plan?.runs).toBe(2);
    expect(planner.accepted).toBe(0);
    expect(coder.accepted).toBe(2);
    const reviewer = rows.find((r) => r.agentIds.includes("demo-reviewer"))!;
    expect(reviewer.stages.review).toMatchObject({ runs: 3, succeeded: 3 });
  });
});
