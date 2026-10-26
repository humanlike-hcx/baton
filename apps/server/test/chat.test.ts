import fs from "node:fs";
import path from "node:path";
import type { Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

type Server = Awaited<ReturnType<typeof testServer>>;

const replies = (t: Thread) => t.items.filter((i): i is Extract<TimelineItem, { kind: "text" }> => i.kind === "text" && !i.thinking).map((i) => i.text);
const tools = (t: Thread, name: string) => t.items.filter((i): i is Extract<TimelineItem, { kind: "tool" }> => i.kind === "tool" && i.tool === name);
const briefing = (s: Server, runId: string) => fs.readFileSync(path.join(s.root, ".baton/sessions/briefings", `${runId}.md`), "utf8");

async function say(s: Server, threadId: string, text: string, agentId?: string): Promise<Thread> {
  const before = (await s.thread(threadId)).runs.length;
  await s.post(`/api/threads/${threadId}/messages`, { text, agentId });
  return s.waitForThread(threadId, (t) => t.runs.length > before && t.status !== "running", "chat reply");
}

describe("chat threads: start a conversation (US-17)", () => {
  it("creates a chat thread without acceptance criteria and answers the first message", async () => {
    const s = await testServer();
    const created = await s.post<Thread>("/api/threads", { kind: "chat", task: "这个仓库的目录结构是怎样的？", agentId: "demo-planner" });
    expect(created.kind).toBe("chat");
    expect(created.acceptance).toEqual([]);
    expect(created.title).toBe("这个仓库的目录结构是怎样的？");

    const t = await s.settled(created.id);
    expect(t.status).toBe("idle");
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ role: "chat", stage: "chat", agentId: "demo-planner", status: "succeeded", prompt: "这个仓库的目录结构是怎样的？" });
    expect(replies(t).join("")).toContain("收到");
    expect(t.items.some((i) => i.kind === "handoff" || i.kind === "decision")).toBe(false);
    expect(t.runs[0]!.handoff?.done).toContain("这个仓库的目录结构");

    const list = await s.get<{ id: string; kind: string }[]>("/api/threads");
    expect(list.find((x) => x.id === t.id)?.kind).toBe("chat");
  });

  it("requires an agent, and keeps relay threads strict", async () => {
    const s = await testServer();
    expect((await s.request("POST", "/api/threads", { kind: "chat", task: "hi" })).status).toBe(400);
    expect((await s.request("POST", "/api/threads", { kind: "chat", task: "hi", agentId: "nope" })).status).toBe(400);
    expect((await s.request("POST", "/api/threads", { kind: "board", title: "x", acceptance: ["y"] })).status).toBe(400);
    expect((await s.request("POST", "/api/threads", { title: "接力", task: "x" })).status).toBe(400);
  });

  it("refuses to answer with a disabled agent and says why", async () => {
    const s = await testServer();
    const agent = (await s.get<{ id: string }[]>("/api/agents")).find((a) => a.id === "demo-reviewer")!;
    await s.put("/api/agents/demo-reviewer", { ...agent, enabled: false });
    const created = await s.post<Thread>("/api/threads", { kind: "chat", task: "在吗", agentId: "demo-reviewer" });
    const t = await s.waitForThread(created.id, (x) => x.status === "paused", "refusal");
    expect(t.runs).toHaveLength(0);
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("已停用"))).toBe(true);
  });
});

describe("chat threads: switch agents mid-conversation (US-18)", () => {
  it("hands the conversation to another agent and another runtime", async () => {
    const s = await testServer();
    const created = await s.post<Thread>("/api/threads", { kind: "chat", task: "我们在讨论周报模板的格式", agentId: "demo-planner" });
    await s.settled(created.id);

    let t = await say(s, created.id, "换你来接着说", "demo-reviewer");
    expect(t.pinnedAgents.chat).toBe("demo-reviewer");
    expect(t.runs[1]!.agentId).toBe("demo-reviewer");
    expect(replies(t).at(-1)).toContain("上一轮用户说「我们在讨论周报模板的格式」");
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("换成 演示 · 检查 接着聊"))).toBe(true);

    t = await say(s, created.id, "Cursor 也来看看", "reviewer-cursor-sonnet");
    const cursorRun = t.runs[2]!;
    expect(cursorRun).toMatchObject({ agentId: "reviewer-cursor-sonnet", runtime: "cursor", status: "succeeded" });
    const seen = briefing(s, cursorRun.id);
    expect(seen).toContain("## 最近几轮原文");
    expect(seen).toContain("我们在讨论周报模板的格式");
    expect(seen).toContain("换你来接着说");
    expect(seen).toContain("上一轮用户说「我们在讨论周报模板的格式」");
    expect(seen).toContain("角色：对话");
  });

  it("quotes the last few turns verbatim and rolls older ones into a summary", async () => {
    const s = await testServer();
    const created = await s.post<Thread>("/api/threads", { kind: "chat", task: "第1条：最早的话题", agentId: "demo-planner" });
    await s.settled(created.id);
    for (let i = 2; i <= 5; i++) await say(s, created.id, `第${i}条消息`);

    const t = await s.thread(created.id);
    expect(t.runs).toHaveLength(5);
    expect(t.summary).toContain("第1条：最早的话题");
    expect(t.summary).not.toContain("第3条消息");
    const last = briefing(s, t.runs[4]!.id);
    const [older, recent] = last.split("## 最近几轮原文");
    expect(older).toContain("## 更早的对话（摘要）");
    expect(older).toContain("第1条：最早的话题");
    expect(recent).toContain("第2条消息");
    expect(recent).toContain("第4条消息");
    expect(recent).not.toContain("### 用户\n第1条：最早的话题");

    const preview = await s.get<{ text: string }>(`/api/agents/demo-reviewer/briefing?role=chat&thread=${t.id}`);
    expect(preview.text).toContain("第5条消息");
    expect(preview.text).toContain("第1条：最早的话题");
  });

  it("queues a message sent while the agent is still replying and answers it next", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.post<Thread>("/api/threads", { kind: "chat", agentId: "demo-coder" });
    await s.post(`/api/threads/${created.id}/write`, { allow: true });
    await s.post(`/api/threads/${created.id}/messages`, { text: "写文件：notes/a.md" });
    const blocked = await s.waitForThread(created.id, (t) => t.items.some((i) => i.kind === "approval" && i.status === "pending"), "command approval");
    await s.post(`/api/threads/${created.id}/messages`, { text: "顺便说一下，第二条" });
    const approval = blocked.items.find((i) => i.kind === "approval" && i.status === "pending");
    if (approval?.kind !== "approval") throw new Error("no approval");
    await s.post(`/api/approvals/${approval.approvalId}`, { allow: true });

    const t = await s.waitForThread(created.id, (x) => x.runs.length === 2 && x.status === "idle", "second reply");
    expect(t.runs.map((r) => r.prompt)).toEqual(["写文件：notes/a.md", "顺便说一下，第二条"]);
    expect(t.notes).toEqual([]);
  });
});

describe("chat threads: read-only by default, writes opened per thread (US-19)", () => {
  it("cannot write until writes are opened, then snapshots and can roll back", async () => {
    const s = await testServer();
    const created = await s.post<Thread>("/api/threads", { kind: "chat", task: "写文件：notes/chat.md", agentId: "demo-coder" });
    let t = await s.settled(created.id);
    expect(fs.existsSync(path.join(s.root, "notes/chat.md"))).toBe(false);
    expect(t.runs[0]!.changedFiles).toEqual([]);
    expect(tools(t, "write_file").every((i) => i.status !== "ok")).toBe(true);
    expect(fs.readFileSync(path.join(s.root, ".baton/sessions/briefings", `${t.runs[0]!.id}.md`), "utf8")).toContain("写权限：只读");

    await s.post(`/api/threads/${t.id}/write`, { allow: true });
    t = await say(s, t.id, "写文件：notes/chat.md");
    const run = t.runs[1]!;
    expect(run.status).toBe("succeeded");
    expect(run.changedFiles).toEqual(["notes/chat.md"]);
    expect(run.snapshotBefore).toBeTruthy();
    expect(fs.existsSync(path.join(s.root, "notes/chat.md"))).toBe(true);
    expect(t.items.some((i) => i.kind === "approval" && i.preview === "wc -l notes/chat.md" && i.status === "allowed")).toBe(true);

    const { diff } = await s.get<{ diff: string }>(`/api/runs/${run.id}/diff`);
    expect(diff).toContain("notes/chat.md");
    await s.post(`/api/runs/${run.id}/rollback`);
    expect(fs.existsSync(path.join(s.root, "notes/chat.md"))).toBe(false);

    await s.post(`/api/threads/${t.id}/write`, { allow: false });
    t = await say(s, t.id, "写文件：notes/again.md");
    expect(fs.existsSync(path.join(s.root, "notes/again.md"))).toBe(false);
  });

  it("only opens writes for that thread, never beyond the agent's own card, and not after a restart", async () => {
    const s = await testServer();
    const chat = await s.post<Thread>("/api/threads", { kind: "chat", agentId: "demo-planner" });
    const other = await s.post<Thread>("/api/threads", { kind: "chat", agentId: "demo-coder" });
    await s.post(`/api/threads/${chat.id}/write`, { allow: true });

    let t = await say(s, chat.id, "写文件：notes/planner.md");
    expect(fs.existsSync(path.join(s.root, "notes/planner.md"))).toBe(false);
    t = await say(s, other.id, "写文件：notes/other.md");
    expect(fs.existsSync(path.join(s.root, "notes/other.md"))).toBe(false);

    await s.post(`/api/threads/${other.id}/write`, { allow: true });
    const relay = await s.post<Thread>("/api/threads", { title: "接力", task: "x", acceptance: ["y"] });
    expect((await s.request("POST", `/api/threads/${relay.id}/write`, { allow: true })).status).toBe(400);
    expect((await s.request("POST", `/api/threads/${relay.id}/messages`, { text: "x", agentId: "demo-coder" })).status).toBe(400);
    await s.settled(relay.id);

    const restarted = await testServer({ reuse: { home: s.home, root: s.root } });
    t = await restarted.thread(other.id);
    expect(t.approvedLevel).toBe(0);
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("已收回这个对话的写权限"))).toBe(true);
  });

  it("keeps a Cursor agent read-only in chat: no edits, no commands", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.post<Thread>("/api/threads", { kind: "chat", task: "看看 notes 目录", agentId: "coder-cursor-composer" });
    const t = await s.settled(created.id);
    expect(t.runs[0]).toMatchObject({ runtime: "cursor", status: "succeeded", changedFiles: [] });
    expect(fs.existsSync(path.join(s.root, "notes"))).toBe(false);
    expect(t.items.some((i) => i.kind === "approval")).toBe(false);
    expect(t.items.some((i) => i.kind === "tool" && i.tool.includes("find notes") && i.status !== "ok")).toBe(true);
  });
});

describe("chat threads: shared context and memory (US-20)", () => {
  it("reads the room context and writes memory another thread can find", async () => {
    const s = await testServer();
    await s.put("/api/context", { content: "# 房间上下文\n\n- 约定：周报用中文写，标记 CTX-42\n" });
    const first = await s.post<Thread>("/api/threads", { kind: "chat", task: "记住：周报每周五下午五点前发出", agentId: "demo-planner" });
    const t1 = await s.settled(first.id);
    expect(briefing(s, t1.runs[0]!.id)).toContain("CTX-42");
    expect(tools(t1, "remember")[0]?.status).toBe("ok");
    const memory = await s.get<{ text: string; author: string; run?: string }[]>("/api/memory");
    expect(memory.find((m) => m.text === "周报每周五下午五点前发出")).toMatchObject({ author: "demo-planner", run: t1.runs[0]!.id });

    const second = await s.post<Thread>("/api/threads", { kind: "chat", task: "查记忆：周报", agentId: "demo-reviewer" });
    const t2 = await s.settled(second.id);
    expect(tools(t2, "memory_search")[0]?.result).toContain("周报每周五下午五点前发出");
  });
});

describe("chat threads: live replies, tool calls and approvals (US-21)", () => {
  it("streams the reply and broadcasts tool calls and approval requests as they happen", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.post<Thread>("/api/threads", { kind: "chat", agentId: "demo-coder" });
    await s.post(`/api/threads/${created.id}/write`, { allow: true });
    await s.post(`/api/threads/${created.id}/messages`, { text: "写文件：notes/live.md" });

    const blocked = await s.waitForThread(created.id, (t) => t.items.some((i) => i.kind === "approval" && i.status === "pending"), "command approval");
    const updates = () => s.events.filter((e) => e.type === "thread" && (e.thread as Thread).id === created.id).map((e) => e.thread as Thread);
    expect(updates().some((t) => t.items.some((i) => i.kind === "approval" && i.status === "pending" && i.preview === "wc -l notes/live.md"))).toBe(true);
    expect(updates().some((t) => tools(t, "write_file").some((i) => i.status === "ok"))).toBe(true);

    const approval = blocked.items.find((i) => i.kind === "approval" && i.status === "pending");
    if (approval?.kind !== "approval") throw new Error("no approval");
    await s.post(`/api/approvals/${approval.approvalId}`, { allow: false });
    const t = await s.settled(created.id);
    expect(tools(t, "shell")[0]?.status).toBe("denied");
    const deltas = s.events.filter((e) => e.type === "delta" && e.threadId === created.id);
    expect(deltas.length).toBeGreaterThan(0);
    expect(replies(t).join("")).toContain("写文件的结果见上面的工具调用");
  });
});
