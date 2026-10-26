import fs from "node:fs";
import path from "node:path";
import type { Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

type Approval = Extract<TimelineItem, { kind: "approval" }>;
const pendingApproval = (t: Thread) => t.items.find((i): i is Approval => i.kind === "approval" && i.status === "pending");
const implementNow = (st: { confirm: { planToImplement: boolean } }) => (st.confirm.planToImplement = false);

describe("HTTP API: one write run per workspace (US-31)", () => {
  it("queues a second write run until the first one ends", async () => {
    const s = await testServer({ autoApprove: false, settings: implementNow });
    const a = await s.post("/api/threads", { title: "甲", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    let ta = await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "A's command approval");

    const b = await s.post("/api/threads", { title: "乙", task: "写另一份说明", acceptance: ["有说明"], stage: "implement" });
    let tb = await s.waitForThread(b.id, (t) => t.status === "waiting", "B to queue");
    expect(tb.runs).toHaveLength(0);
    expect(tb.items.some((i) => i.kind === "notice" && i.text.includes("已排队"))).toBe(true);

    await s.post(`/api/approvals/${pendingApproval(ta)!.approvalId}`, { allow: true });
    tb = await s.waitForThread(b.id, (t) => Boolean(pendingApproval(t)), "B to start after A");
    ta = await s.thread(a.id);
    const aImpl = ta.runs.find((r) => r.stage === "implement")!;
    expect(aImpl.status).toBe("succeeded");
    expect(tb.runs[0]!.startedAt >= aImpl.endedAt!).toBe(true);

    await s.post(`/api/approvals/${pendingApproval(tb)!.approvalId}`, { allow: true });
    tb = await s.settled(b.id);
    expect(tb.runs.find((r) => r.stage === "implement")?.status).toBe("succeeded");
  });
});

describe("HTTP API: cancelling (US-33)", () => {
  it("cancels a running run: the pending command is denied and never runs", async () => {
    const s = await testServer({ autoApprove: false, settings: implementNow });
    const a = await s.post("/api/threads", { title: "取消", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    const blocked = await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "command approval");
    const approvalId = pendingApproval(blocked)!.approvalId;

    await s.post(`/api/threads/${a.id}/cancel`);
    const t = await s.settled(a.id);
    expect(t.status).toBe("paused");
    expect(t.runs[0]!.status).toBe("cancelled");
    expect(t.items.find((i) => i.kind === "approval" && i.approvalId === approvalId)).toMatchObject({ status: "denied" });
    const shell = t.items.find((i) => i.kind === "tool" && i.tool === "shell");
    expect(shell).toMatchObject({ status: "denied" });
    const late = await s.request("POST", `/api/approvals/${approvalId}`, { allow: true });
    expect(late.status).toBe(400);
    expect(late.body.error).toContain("已经处理过");
  });

  it("cancels a queued run before it starts", async () => {
    const s = await testServer({ autoApprove: false, settings: implementNow });
    const a = await s.post("/api/threads", { title: "甲", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "A's command approval");
    const b = await s.post("/api/threads", { title: "乙", task: "写另一份说明", acceptance: ["有说明"], stage: "implement" });
    await s.waitForThread(b.id, (t) => t.status === "waiting", "B to queue");

    await s.post(`/api/threads/${b.id}/cancel`);
    const tb = await s.thread(b.id);
    expect(tb.status).toBe("paused");
    expect(tb.items.at(-1)).toMatchObject({ kind: "notice", text: "已取消排队。" });

    await s.post(`/api/approvals/${pendingApproval(await s.thread(a.id))!.approvalId}`, { allow: true });
    await s.settled(a.id);
    expect((await s.thread(b.id)).runs).toHaveLength(0);
  });
});

describe("HTTP API: restart (US-35)", () => {
  it("marks an interrupted thread paused, and a message continues it from the same stage", async () => {
    const first = await testServer({ autoApprove: false, settings: implementNow });
    const a = await first.post("/api/threads", { title: "重启", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    await first.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "command approval");

    const s = await testServer({ reuse: { home: first.home, root: first.root } });
    let t = await s.thread(a.id);
    expect(t.status).toBe("paused");
    expect(t.runs[0]!.status).toBe("cancelled");
    expect(t.items.some((i) => i.kind === "approval" && i.status === "expired")).toBe(true);
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("工作台重启"))).toBe(true);
    expect((await s.get<{ id: string; status: string }[]>("/api/threads")).find((x) => x.id === a.id)?.status).toBe("paused");

    await s.post(`/api/threads/${a.id}/messages`, { text: "继续" });
    t = await s.settled(a.id);
    expect(t.runs[1]).toMatchObject({ stage: "implement", status: "succeeded" });
  });
});

describe("HTTP API: live timeline (US-36)", () => {
  it("broadcasts streamed text, tool calls, approvals, handoffs, checks and the advisor while a relay runs", async () => {
    const s = await testServer({ settings: (st) => ((st.confirm.planToImplement = false), (st.advisor.beforePlan = true)) });
    const a = await s.post("/api/threads", { title: "可见性", task: "写一份说明", acceptance: ["有说明"] });
    let t = await s.settled(a.id);
    expect(t.items.some((i) => i.kind === "advisor")).toBe(true);
    while (t.pending && t.pending.kind !== "complete") {
      await s.post(`/api/threads/${a.id}/decisions/${t.pending.id}`, { approve: true });
      t = await s.settled(a.id);
    }
    expect(t.pending?.kind).toBe("complete");

    const deltas = s.events.filter((e) => e.type === "delta" && e.threadId === a.id);
    expect(deltas.length).toBeGreaterThan(0);
    const seen = new Set(
      s.events.flatMap((e) => (e.type === "thread" && (e.thread as Thread).id === a.id ? (e.thread as Thread).items.map((i) => i.kind) : [])),
    );
    for (const kind of ["user", "run_start", "text", "tool", "approval", "handoff", "checks", "run_end", "decision", "advisor"]) expect(seen, kind).toContain(kind);
  });
});

describe("HTTP API: approvals (US-59)", () => {
  it("shows the full command and treats an unanswered approval as denied", async () => {
    const s = await testServer({ autoApprove: false, settings: (st) => ((st.confirm.planToImplement = false), (st.approvalTimeoutSec = 0.2)) });
    const a = await s.post("/api/threads", { title: "超时", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    const blocked = await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "command approval");
    const approval = pendingApproval(blocked)!;
    expect(approval.risk).toBe("exec");
    expect(approval.preview).toMatch(/^wc -l notes\/.+\.md$/);

    const t = await s.waitForThread(a.id, (x) => x.items.some((i) => i.kind === "approval" && i.approvalId === approval.approvalId && i.status === "expired"), "approval to expire");
    await s.settled(a.id);
    const shell = (await s.thread(a.id)).items.find((i) => i.kind === "tool" && i.tool === "shell");
    expect(shell).toMatchObject({ status: "denied" });
    expect(t.items.find((i) => i.kind === "approval" && i.approvalId === approval.approvalId)).toMatchObject({ status: "expired" });
  });
});

describe("HTTP API: audit log (US-65)", () => {
  it("records every tool call and approval with its run and agent", async () => {
    const s = await testServer({ settings: implementNow });
    const a = await s.post("/api/threads", { title: "审计", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    const t = await s.settled(a.id);
    const impl = t.runs.find((r) => r.stage === "implement")!;
    const log = fs
      .readFileSync(path.join(s.root, ".baton/audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.every((e) => typeof e.at === "string")).toBe(true);
    const tools = log.filter((e) => e.run === impl.id && e.tool);
    expect(tools.map((e) => e.tool)).toEqual(expect.arrayContaining(["list_files", "write_file", "shell", "write_handoff"]));
    expect(tools.every((e) => e.agent === impl.agentId)).toBe(true);
    const approval = t.items.find((i): i is Approval => i.kind === "approval")!;
    expect(log.some((e) => e.approval === approval.approvalId && e.run === impl.id && e.risk === "exec")).toBe(true);
    expect(log.some((e) => e.approval === approval.approvalId && e.status === "allowed")).toBe(true);
    expect(log.some((e) => e.run === impl.id && e.briefingHash === impl.briefingHash)).toBe(true);
  });
});
