import fs from "node:fs";
import path from "node:path";
import type { Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

type Approval = Extract<TimelineItem, { kind: "approval" }>;
const pendingApproval = (t: Thread) => t.items.find((i): i is Approval => i.kind === "approval" && i.status === "pending");

describe("HTTP API: one writing chat per workspace (US-31)", () => {
  it("queues a second chat that may write until the first one's reply ends; read-only chats never wait", async () => {
    const s = await testServer({ autoApprove: false });
    const a = await s.chat("写文件：notes/a.md", { access: "ask" });
    let ta = await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "A's write approval");

    const b = await s.chat("写文件：notes/b.md", { access: "allow" });
    let tb = await s.waitForThread(b.id, (t) => t.status === "waiting", "B to queue");
    expect(tb.runs).toHaveLength(0);
    expect(tb.items.some((i) => i.kind === "notice" && i.text.includes("已排队"))).toBe(true);
    const reader = await s.settled((await s.chat("只是问问")).id);
    expect(reader.runs[0]!.status).toBe("succeeded");

    await s.post(`/api/approvals/${pendingApproval(ta)!.approvalId}`, { allow: true });
    ta = await s.waitForThread(a.id, (t) => pendingApproval(t)?.risk === "exec", "A's command approval");
    await s.post(`/api/approvals/${pendingApproval(ta)!.approvalId}`, { allow: true });
    ta = await s.settled(a.id);
    tb = await s.settled(b.id);
    expect(tb.runs[0]).toMatchObject({ status: "succeeded", changedFiles: ["notes/b.md"] });
    expect(tb.runs[0]!.startedAt >= ta.runs[0]!.endedAt!).toBe(true);
  });
});

describe("HTTP API: cancelling (US-33)", () => {
  it("cancels a running reply: the pending change is denied and never happens", async () => {
    const s = await testServer({ autoApprove: false });
    const a = await s.chat("写文件：notes/x.md", { access: "ask" });
    const blocked = await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "write approval");
    const approvalId = pendingApproval(blocked)!.approvalId;

    await s.post(`/api/threads/${a.id}/cancel`);
    const t = await s.settled(a.id);
    expect(t.status).toBe("idle");
    expect(t.runs[0]!.status).toBe("cancelled");
    expect(t.items.find((i) => i.kind === "approval" && i.approvalId === approvalId)).toMatchObject({ status: "denied" });
    expect(fs.existsSync(path.join(s.root, "notes/x.md"))).toBe(false);
    const late = await s.request("POST", `/api/approvals/${approvalId}`, { allow: true });
    expect(late.status).toBe(400);
    expect(late.body.error).toContain("已经处理过");
  });

  it("cancels a queued reply before it starts", async () => {
    const s = await testServer({ autoApprove: false });
    const a = await s.chat("写文件：notes/a.md", { access: "ask" });
    await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "A's write approval");
    const b = await s.chat("写文件：notes/b.md", { access: "ask" });
    await s.waitForThread(b.id, (t) => t.status === "waiting", "B to queue");

    await s.post(`/api/threads/${b.id}/cancel`);
    const tb = await s.thread(b.id);
    expect(tb.status).toBe("paused");
    expect(tb.items.at(-1)).toMatchObject({ kind: "notice", text: "已取消排队。" });

    await s.post(`/api/threads/${a.id}/cancel`);
    await s.settled(a.id);
    expect((await s.thread(b.id)).runs).toHaveLength(0);
  });
});

describe("HTTP API: restart (US-35)", () => {
  it("marks an interrupted chat paused, and a message answers what was left plus the new message", async () => {
    const first = await testServer({ autoApprove: false });
    const a = await first.chat("写文件：notes/a.md", { access: "ask" });
    await first.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "write approval");

    const s = await testServer({ reuse: { home: first.home, root: first.root } });
    let t = await s.thread(a.id);
    expect(t.status).toBe("paused");
    expect(t.access).toBe("read");
    expect(t.runs[0]!.status).toBe("cancelled");
    expect(t.items.some((i) => i.kind === "approval" && i.status === "expired")).toBe(true);
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("工作台重启"))).toBe(true);
    expect((await s.get<{ id: string; status: string }[]>("/api/threads")).find((x) => x.id === a.id)?.status).toBe("paused");

    t = await s.say(a.id, "继续");
    expect(t.runs[1]).toMatchObject({ status: "succeeded", prompt: "写文件：notes/a.md\n\n继续" });
  });

  it("drops relay threads saved by earlier versions, and keeps old chats readable until a model is picked", async () => {
    const s = await testServer();
    const dir = path.join(s.root, ".baton/threads");
    const base = { status: "done", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", summary: "", runs: [], notes: [] };
    fs.writeFileSync(path.join(dir, "th_relay.json"), JSON.stringify({ ...base, id: "th_relay", kind: "relay", title: "旧接力", items: [] }));
    fs.writeFileSync(
      path.join(dir, "th_chat.json"),
      JSON.stringify({
        ...base,
        id: "th_chat",
        kind: "chat",
        title: "旧对话",
        approvedLevel: 2,
        pinnedAgents: { chat: "demo-planner" },
        items: [
          { id: "it1", at: base.createdAt, kind: "user", text: "以前的问题" },
          { id: "it2", at: base.createdAt, kind: "handoff", runId: "r", handoff: {} },
          { id: "it3", at: base.createdAt, kind: "run_start", runId: "r", agentId: "demo-planner", agentName: "旧 agent", stage: "chat", model: "demo-plan", runtime: "pi", briefingBytes: 1 },
        ],
      }),
    );
    const restarted = await testServer({ reuse: { home: s.home, root: s.root } });
    const list = await restarted.get<{ id: string }[]>("/api/threads");
    expect(list.map((x) => x.id)).toEqual(["th_chat"]);
    const old = await restarted.thread("th_chat");
    expect(old).toMatchObject({ status: "idle", access: "read" });
    expect(old.model).toBeUndefined();
    expect(old.items.map((i) => i.kind)).toEqual(["user", "run_start"]);
    expect(old.items[1]).toMatchObject({ role: "chat" });
    const res = await restarted.request("POST", "/api/threads/th_chat/messages", { text: "还在吗" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("请先选择一个模型");
    const t = await restarted.say("th_chat", "还在吗", { source: "demo", model: "demo-chat" });
    expect(t.runs[0]).toMatchObject({ status: "succeeded", agentId: "demo:demo-chat" });
  });
});

describe("HTTP API: approvals (US-59)", () => {
  it("shows the full command and treats an unanswered approval as denied", async () => {
    const s = await testServer({ autoApprove: false, settings: (st) => (st.approvalTimeoutSec = 0.2) });
    const a = await s.chat("写文件：notes/a.md", { access: "ask" });
    const blocked = await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "write approval");
    const write = pendingApproval(blocked)!;
    expect(write.risk).toBe("write");

    const t = await s.waitForThread(a.id, (x) => x.items.some((i) => i.kind === "approval" && i.risk === "exec" && i.status === "expired"), "both approvals to expire");
    expect(t.items.find((i) => i.kind === "approval" && i.approvalId === write.approvalId)).toMatchObject({ status: "expired" });
    expect(t.items.find((i) => i.kind === "approval" && i.risk === "exec")).toMatchObject({ preview: "wc -l notes/a.md" });
    const done = await s.settled(a.id);
    expect(done.items.find((i) => i.kind === "tool" && i.tool === "shell")).toMatchObject({ status: "denied" });
    expect(fs.existsSync(path.join(s.root, "notes/a.md"))).toBe(false);
  });
});

describe("HTTP API: audit log (US-65)", () => {
  it("records every tool call and approval with its run and model", async () => {
    const s = await testServer();
    const t = await s.settled((await s.chat("写文件：notes/audit.md", { access: "ask" })).id);
    const run = t.runs[0]!;
    const log = fs
      .readFileSync(path.join(s.root, ".baton/audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.every((e) => typeof e.at === "string")).toBe(true);
    const tools = log.filter((e) => e.run === run.id && e.tool);
    expect(tools.map((e) => e.tool)).toEqual(expect.arrayContaining(["write_file", "shell"]));
    expect(tools.every((e) => e.agent === "demo:demo-chat")).toBe(true);
    const approval = t.items.find((i): i is Approval => i.kind === "approval" && i.risk === "exec")!;
    expect(log.some((e) => e.approval === approval.approvalId && e.run === run.id && e.risk === "exec")).toBe(true);
    expect(log.some((e) => e.approval === approval.approvalId && e.status === "allowed")).toBe(true);
    expect(log.some((e) => e.run === run.id && e.briefingHash === run.briefingHash)).toBe(true);
  });
});
