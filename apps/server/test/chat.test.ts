import fs from "node:fs";
import path from "node:path";
import type { Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { CURSOR_COMPOSER, CURSOR_SONNET, DEMO_CHAT, DEMO_REVIEW, testServer } from "./helpers.ts";

type Server = Awaited<ReturnType<typeof testServer>>;
type Approval = Extract<TimelineItem, { kind: "approval" }>;

const replies = (t: Thread) => t.items.filter((i): i is Extract<TimelineItem, { kind: "text" }> => i.kind === "text" && !i.thinking).map((i) => i.text);
const tools = (t: Thread, name: string) => t.items.filter((i): i is Extract<TimelineItem, { kind: "tool" }> => i.kind === "tool" && i.tool === name);
const pendingApproval = (t: Thread) => t.items.find((i): i is Approval => i.kind === "approval" && i.status === "pending");
const briefing = (s: Server, runId: string) => fs.readFileSync(path.join(s.root, ".baton/sessions/briefings", `${runId}.md`), "utf8");

describe("chats: start a conversation (US-17)", () => {
  it("opens a chat on a model and answers the first message, no acceptance criteria needed", async () => {
    const s = await testServer();
    const created = await s.post<Thread>("/api/threads", { task: "这个仓库的目录结构是怎样的？", ...DEMO_CHAT });
    expect(created).toMatchObject({ title: "这个仓库的目录结构是怎样的？", access: "read", model: { source: "demo", model: "demo-chat", name: "对话" } });

    const t = await s.settled(created.id);
    expect(t.status).toBe("idle");
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ role: "chat", agentId: "demo:demo-chat", source: "demo", model: "demo-chat", status: "succeeded", prompt: "这个仓库的目录结构是怎样的？" });
    expect(replies(t).join("")).toContain("收到");

    const list = await s.get<{ id: string; model: { model: string } }[]>("/api/threads");
    expect(list.find((x) => x.id === t.id)?.model.model).toBe("demo-chat");
  });

  it("opens an empty chat without running anything", async () => {
    const s = await testServer();
    const created = await s.post<Thread>("/api/threads", { ...DEMO_CHAT });
    expect(created).toMatchObject({ title: "新对话", runs: [], status: "idle" });
  });
});

describe("chats: pick any model a signed-in account offers (US-92)", () => {
  it("only accepts models the route lists, one family per route, and records only account + model", async () => {
    const s = await testServer();
    const cases: [Record<string, string>, string][] = [
      [{}, "不支持的账号来源"],
      [{ source: "openrouter", model: "x" }, "不支持的账号来源"],
      [{ source: "cursor", model: "gpt-5.6-sol" }, "GPT 系模型只走 ChatGPT"],
      [{ source: "cursor", model: "auto" }, "不提供 Auto"],
      [{ source: "cursor", model: "deepseek-v41-flash-1017-medium" }, "DeepSeek 系模型通过 API key 使用"],
      [{ source: "chatgpt", model: "claude-sonnet-5-5-medium" }, "只能使用 GPT 系模型"],
      [{ source: "key", model: "gpt-5.5" }, "没有这个 API key 账号"],
      [{ source: "key", provider: "anthropic", model: "claude-opus-4-5" }, "没有这个 API key 账号"],
      [{ source: "cursor", model: "no-such-model" }, "Cursor 线路上没有模型 no-such-model"],
      [{ source: "demo", model: "demo-plan" }, "没有模型 demo-plan"],
    ];
    for (const [pick, reason] of cases) {
      const res = await s.request("POST", "/api/threads", { task: "hi", ...pick });
      expect(res.status, JSON.stringify(pick)).toBe(400);
      expect(res.body.error).toContain(reason);
    }
    expect(await s.get("/api/threads")).toEqual([]);

    const created = await s.post<Thread>("/api/threads", { task: "看看 notes 目录", source: "cursor", model: "gemini-4-argon-medium" });
    const t = await s.settled(created.id);
    expect(t.model).toEqual({ source: "cursor", model: "gemini-4-argon-medium", name: "Gemini 4 Argon Medium" });
    expect(t.runs[0]).toMatchObject({ agentId: "cursor:gemini-4-argon-medium", runtime: "cursor", source: "cursor", family: "gemini", status: "succeeded" });
    expect(fs.existsSync(path.join(s.root, ".baton/agents"))).toBe(false);
  });

  it("refuses a model whose account is not signed in, and says where to sign in", async () => {
    const s = await testServer();
    const models = await s.get<{ routes: { source: string; unavailable?: string; models: { id: string }[] }[] }>("/api/models");
    const chatgpt = models.routes.find((r) => r.source === "chatgpt")!;
    expect(chatgpt.unavailable).toContain("ChatGPT");
    const created = await s.post<Thread>("/api/threads", { task: "在吗", source: "chatgpt", model: chatgpt.models[0]!.id });
    const t = await s.waitForThread(created.id, (x) => x.status === "paused", "refusal");
    expect(t.runs).toHaveLength(0);
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("现在不能回复") && i.text.includes("「模型」页"))).toBe(true);
  });
});

describe("chats: switch models mid-conversation (US-18)", () => {
  it("hands the conversation to another model and another runtime", async () => {
    const s = await testServer();
    const created = await s.post<Thread>("/api/threads", { task: "我们在讨论周报模板的格式", ...DEMO_CHAT });
    await s.settled(created.id);

    let t = await s.say(created.id, "换你来接着说", DEMO_REVIEW);
    expect(t.model?.model).toBe("demo-review");
    expect(t.runs[1]!.agentId).toBe("demo:demo-review");
    expect(replies(t).at(-1)).toContain("上一轮用户说「我们在讨论周报模板的格式」");
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("换成 检查 · 演示 接着聊（之前是 对话 · 演示）"))).toBe(true);

    t = await s.say(created.id, "Cursor 也来看看", CURSOR_SONNET);
    const cursorRun = t.runs[2]!;
    expect(cursorRun).toMatchObject({ agentId: "cursor:claude-sonnet-5-5-medium", runtime: "cursor", status: "succeeded" });
    const seen = briefing(s, cursorRun.id);
    expect(seen).toContain("## 最近几轮原文");
    expect(seen).toContain("我们在讨论周报模板的格式");
    expect(seen).toContain("换你来接着说");
    expect(seen).toContain("上一轮用户说「我们在讨论周报模板的格式」");
    expect(seen).toContain("角色：对话");

    t = await s.say(created.id, "还是你来");
    expect(t.runs[3]!.agentId).toBe("cursor:claude-sonnet-5-5-medium");
  });

  it("quotes the last few turns verbatim and rolls older ones into a summary", async () => {
    const s = await testServer();
    const created = await s.post<Thread>("/api/threads", { task: "第1条：最早的话题", ...DEMO_CHAT });
    await s.settled(created.id);
    for (let i = 2; i <= 5; i++) await s.say(created.id, `第${i}条消息`);

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

    const preview = await s.get<{ text: string }>(`/api/briefing?source=demo&model=demo-review&role=chat&thread=${t.id}`);
    expect(preview.text).toContain("第5条消息");
    expect(preview.text).toContain("第1条：最早的话题");
  });

  it("queues a message sent while the model is still replying and answers it next", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.chat("写文件：notes/a.md", { access: "ask" });
    let blocked = await s.waitForThread(created.id, (t) => Boolean(pendingApproval(t)), "write approval");
    await s.post(`/api/threads/${created.id}/messages`, { text: "顺便说一下，第二条" });
    await s.post(`/api/approvals/${pendingApproval(blocked)!.approvalId}`, { allow: true });
    blocked = await s.waitForThread(created.id, (t) => t.items.filter((i) => i.kind === "approval").length === 2 && Boolean(pendingApproval(t)), "command approval");
    await s.post(`/api/approvals/${pendingApproval(blocked)!.approvalId}`, { allow: true });

    const t = await s.waitForThread(created.id, (x) => x.runs.length === 2 && x.status === "idle", "second reply");
    expect(t.runs.map((r) => r.prompt)).toEqual(["写文件：notes/a.md", "顺便说一下，第二条"]);
    expect(briefing(s, t.runs[0]!.id)).not.toContain("顺便说一下，第二条");
    expect(briefing(s, t.runs[1]!.id)).toContain("顺便说一下，第二条");
    expect(t.notes).toEqual([]);
  });
});

describe("chats: one access switch per chat (US-93, US-19)", () => {
  it("is read-only by default, asks before each change at「每次问我」, and snapshots so a reply can be rolled back", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.chat("写文件：notes/chat.md");
    let t = await s.settled(created.id);
    expect(fs.existsSync(path.join(s.root, "notes/chat.md"))).toBe(false);
    expect(t.runs[0]!.changedFiles).toEqual([]);
    expect(tools(t, "write_file").every((i) => i.status !== "ok")).toBe(true);
    expect(briefing(s, t.runs[0]!.id)).toContain("权限：只读");

    await s.post(`/api/threads/${t.id}/access`, { access: "ask" });
    expect((await s.thread(t.id)).items.at(-1)).toMatchObject({ kind: "notice", text: expect.stringContaining("每次问我") });
    await s.post(`/api/threads/${t.id}/messages`, { text: "写文件：notes/chat.md" });
    const blocked = await s.waitForThread(t.id, (x) => Boolean(pendingApproval(x)), "write approval");
    const approval = pendingApproval(blocked)!;
    expect(approval).toMatchObject({ risk: "write", title: "改文件：notes/chat.md" });
    expect(approval.preview).toMatch(/^新建 notes\/chat\.md\n\+# 对话里写的文件/);
    await s.post(`/api/approvals/${approval.approvalId}`, { allow: true });
    const command = await s.waitForThread(t.id, (x) => pendingApproval(x)?.risk === "exec", "command approval");
    expect(pendingApproval(command)!.preview).toBe("node --version");
    await s.post(`/api/approvals/${pendingApproval(command)!.approvalId}`, { allow: false });
    t = await s.settled(t.id);
    const run = t.runs[1]!;
    expect(run).toMatchObject({ status: "succeeded", changedFiles: ["notes/chat.md"] });
    expect(run.snapshotBefore).toBeTruthy();
    expect(briefing(s, run.id)).toContain("权限：每次问我");
    expect(tools(t, "shell").at(-1)).toMatchObject({ runId: run.id, status: "denied" });

    const { diff } = await s.get<{ diff: string }>(`/api/runs/${run.id}/diff`);
    expect(diff).toContain("notes/chat.md");
    await s.post(`/api/runs/${run.id}/rollback`);
    expect(fs.existsSync(path.join(s.root, "notes/chat.md"))).toBe(false);

    await s.post(`/api/threads/${t.id}/access`, { access: "read" });
    t = await s.say(t.id, "写文件：notes/again.md");
    expect(fs.existsSync(path.join(s.root, "notes/again.md"))).toBe(false);
    expect((await s.request("POST", `/api/threads/${t.id}/access`, { access: "root" })).status).toBe(400);
  });

  it("changes files and runs commands without asking at「允许直接改」", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.chat("写文件：notes/direct.md", { access: "allow" });
    const t = await s.settled(created.id);
    expect(t.runs[0]).toMatchObject({ status: "succeeded", changedFiles: ["notes/direct.md"] });
    expect(t.items.some((i) => i.kind === "approval")).toBe(false);
    expect(tools(t, "shell")[0]).toMatchObject({ status: "ok" });
    expect(briefing(s, t.runs[0]!.id)).toContain("权限：允许直接改");
  });

  it("only applies to that chat, and goes back to read-only after a restart", async () => {
    const s = await testServer();
    const open = await s.chat("", { access: "allow" });
    const other = await s.chat("写文件：notes/other.md");
    await s.settled(other.id);
    expect(fs.existsSync(path.join(s.root, "notes/other.md"))).toBe(false);
    expect((await s.thread(open.id)).access).toBe("allow");

    const restarted = await testServer({ reuse: { home: s.home, root: s.root } });
    const t = await restarted.thread(open.id);
    expect(t.access).toBe("read");
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("已恢复只读"))).toBe(true);
  });

  it("keeps a Cursor model read-only by default: no edits, no commands", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.chat("看看 notes 目录", { model: CURSOR_COMPOSER });
    const t = await s.settled(created.id);
    expect(t.runs[0]).toMatchObject({ runtime: "cursor", status: "succeeded", changedFiles: [] });
    expect(fs.existsSync(path.join(s.root, "notes"))).toBe(false);
    expect(t.items.some((i) => i.kind === "approval")).toBe(false);
    expect(t.items.some((i) => i.kind === "tool" && i.tool.includes("find notes") && i.status !== "ok")).toBe(true);
  });

  it("sends a Cursor model's file edits to an approval at「每次问我」", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.chat("写一份说明", { model: CURSOR_COMPOSER, access: "ask" });
    const blocked = await s.waitForThread(created.id, (t) => Boolean(pendingApproval(t)), "Cursor edit approval");
    const approval = pendingApproval(blocked)!;
    expect(approval).toMatchObject({ risk: "write", title: "Write notes/cursor-composer-2.5.md" });
    await s.post(`/api/approvals/${approval.approvalId}`, { allow: false });
    await s.waitForThread(created.id, (t) => t.items.some((i) => i.kind === "approval" && i.approvalId !== approval.approvalId), "the command request");
    expect(fs.existsSync(path.join(s.root, "notes/cursor-composer-2.5.md"))).toBe(false);
    await s.post(`/api/threads/${created.id}/cancel`);
  });
});

describe("chats: shared context and memory (US-20)", () => {
  it("reads the room context and writes memory another chat can find", async () => {
    const s = await testServer();
    await s.put("/api/context", { content: "# 房间上下文\n\n- 约定：周报用中文写，标记 CTX-42\n" });
    const t1 = await s.settled((await s.chat("记住：周报每周五下午五点前发出")).id);
    expect(briefing(s, t1.runs[0]!.id)).toContain("CTX-42");
    expect(tools(t1, "remember")[0]?.status).toBe("ok");
    const memory = await s.get<{ text: string; author: string; run?: string }[]>("/api/memory");
    expect(memory.find((m) => m.text === "周报每周五下午五点前发出")).toMatchObject({ author: "demo:demo-chat", run: t1.runs[0]!.id });

    const t2 = await s.settled((await s.chat("查记忆：周报", { model: DEMO_REVIEW })).id);
    expect(tools(t2, "memory_search")[0]?.result).toContain("周报每周五下午五点前发出");
  });
});

describe("chats: live replies, tool calls and approvals (US-21)", () => {
  it("streams the reply and broadcasts tool calls and approval requests as they happen", async () => {
    const s = await testServer({ autoApprove: false });
    const created = await s.chat("写文件：notes/live.md", { access: "ask" });
    let blocked = await s.waitForThread(created.id, (t) => Boolean(pendingApproval(t)), "write approval");
    await s.post(`/api/approvals/${pendingApproval(blocked)!.approvalId}`, { allow: true });
    blocked = await s.waitForThread(created.id, (t) => pendingApproval(t)?.risk === "exec", "command approval");

    const updates = () => s.events.filter((e) => e.type === "thread" && (e.thread as Thread).id === created.id).map((e) => e.thread as Thread);
    expect(updates().some((t) => t.items.some((i) => i.kind === "approval" && i.status === "pending" && i.preview === "node --version"))).toBe(true);
    expect(updates().some((t) => tools(t, "write_file").some((i) => i.status === "ok"))).toBe(true);

    await s.post(`/api/approvals/${pendingApproval(blocked)!.approvalId}`, { allow: false });
    const t = await s.settled(created.id);
    expect(tools(t, "shell")[0]?.status).toBe("denied");
    expect(s.events.filter((e) => e.type === "delta" && e.threadId === created.id).length).toBeGreaterThan(0);
    expect(replies(t).join("")).toContain("写文件的结果见上面的工具调用");
    const seen = new Set(updates().flatMap((x) => x.items.map((i) => i.kind)));
    for (const kind of ["user", "run_start", "text", "tool", "approval", "run_end"]) expect(seen, kind).toContain(kind);
  });
});
