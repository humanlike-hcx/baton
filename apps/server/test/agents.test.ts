import fs from "node:fs";
import path from "node:path";
import type { AgentCard, Briefing, Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

type Approval = Extract<TimelineItem, { kind: "approval" }>;
const pendingApproval = (t: Thread) => t.items.find((i): i is Approval => i.kind === "approval" && i.status === "pending");
const implementNow = (st: { confirm: { planToImplement: boolean } }) => (st.confirm.planToImplement = false);

async function updateAgent(s: Awaited<ReturnType<typeof testServer>>, id: string, patch: (a: AgentCard) => void) {
  const agent = (await s.get<AgentCard[]>("/api/agents")).find((a) => a.id === id)!;
  patch(agent);
  return s.request("PUT", `/api/agents/${id}`, agent);
}

/** The mock Cursor CLI makes the Cursor implementer available too; keep demo-coder the only one. */
async function onlyDemoCoder(s: Awaited<ReturnType<typeof testServer>>) {
  await updateAgent(s, "coder-cursor-composer", (a) => (a.enabled = false));
}

describe("HTTP API: agent routes (US-11)", () => {
  const card = (over: Partial<AgentCard>): AgentCard => ({
    id: "x",
    name: "新 agent",
    runtime: "cursor",
    source: "cursor",
    provider: "cursor",
    model: "sonnet-4.5",
    roles: ["review"],
    permissions: { write: "deny", exec: "ask", network: "deny" },
    costTier: 2,
    enabled: true,
    body: "",
    ...over,
  });

  it("refuses a card that breaks one family, one route, and says why", async () => {
    const s = await testServer();
    const cases: [Partial<AgentCard>, string][] = [
      [{ model: "gpt-5.5" }, "GPT 系模型只走 ChatGPT"],
      [{ model: "auto" }, "不提供 Auto"],
      [{ model: "deepseek-v41-flash-1017-medium" }, "DeepSeek 系模型只走 DeepSeek key"],
      [{ source: "chatgpt", runtime: "pi", provider: "openai", model: "sonnet-4.5" }, "只能使用 GPT 系模型"],
      [{ source: "deepseek", runtime: "pi", provider: "deepseek", model: "gpt-5.5" }, "只能使用 DeepSeek 模型"],
      [{ source: "chatgpt", runtime: "cursor", provider: "cursor", model: "gpt-5.5" }, "只能跑在 Pi 运行时"],
      [{ roles: [] }, "至少选择一个角色"],
    ];
    for (const [over, reason] of cases) {
      const res = await s.request("PUT", "/api/agents/x", card(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.body.error).toContain(reason);
    }
    expect((await s.get<AgentCard[]>("/api/agents")).some((a) => a.id === "x")).toBe(false);

    const saved = await s.request("PUT", "/api/agents/x", card({}));
    expect(saved.status).toBe(200);
    const state = await s.get<{ agents: (AgentCard & { routeError?: string })[] }>("/api/state");
    const x = state.agents.find((a) => a.id === "x")!;
    expect(x.model).toBe("sonnet-4.5");
    expect(x.routeError).toBeUndefined();
  });
});

describe("HTTP API: per-agent permissions (US-12)", () => {
  it("asks before each file change when writes are set to ask, with a preview of the change", async () => {
    const s = await testServer({ autoApprove: false, settings: implementNow });
    expect((await updateAgent(s, "demo-coder", (a) => (a.permissions.write = "ask"))).status).toBe(200);
    const created = await s.post("/api/threads", { title: "问我再写", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });

    const blocked = await s.waitForThread(created.id, (t) => Boolean(pendingApproval(t)), "write approval");
    const approval = pendingApproval(blocked)!;
    expect(approval).toMatchObject({ risk: "write" });
    expect(approval.title).toMatch(/^改文件：notes\/.+\.md$/);
    expect(approval.preview).toMatch(/^新建 notes\/.+\.md\n\+# 问我再写/);
    const note = approval.title.replace("改文件：", "");

    await s.post(`/api/approvals/${approval.approvalId}`, { allow: false });
    const next = await s.waitForThread(created.id, (t) => t.items.some((i) => i.kind === "approval" && i.approvalId !== approval.approvalId && i.status === "pending"), "next approval");
    expect(fs.existsSync(path.join(s.root, note))).toBe(false);
    expect(next.items.find((i) => i.kind === "tool" && i.tool === "write_file")).toMatchObject({ status: "denied" });
    await s.post(`/api/threads/${created.id}/cancel`);
  });

  it("sends a Cursor agent's file edits to an approval when its writes are set to ask", async () => {
    const s = await testServer({ autoApprove: false, settings: implementNow });
    await updateAgent(s, "coder-cursor-composer", (a) => (a.permissions.write = "ask"));
    const created = await s.post("/api/threads", { title: "Cursor 问我", task: "写一份说明", acceptance: ["有说明"], stage: "implement", agentId: "coder-cursor-composer" });
    const blocked = await s.waitForThread(created.id, (t) => Boolean(pendingApproval(t)), "Cursor edit approval");
    const approval = pendingApproval(blocked)!;
    expect(approval).toMatchObject({ risk: "write" });
    expect(approval.title).toMatch(/^Write notes\/cursor-.+\.md$/);
    const rel = approval.title.replace("Write ", "");

    await s.post(`/api/approvals/${approval.approvalId}`, { allow: false });
    await s.waitForThread(created.id, (t) => t.items.some((i) => i.kind === "approval" && i.approvalId !== approval.approvalId), "the command request");
    expect(fs.existsSync(path.join(s.root, rel))).toBe(false);
    await s.post(`/api/threads/${created.id}/cancel`);
  });

  it("refuses an implementer without write permission, and runs commands directly when exec is allowed", async () => {
    const s = await testServer({ autoApprove: false, settings: implementNow });
    await onlyDemoCoder(s);
    await updateAgent(s, "demo-coder", (a) => (a.permissions.write = "deny"));
    const denied = await s.post("/api/threads", { title: "不能写", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    let t = await s.settled(denied.id);
    expect(t.status).toBe("paused");
    expect(t.items.at(-1)).toMatchObject({ kind: "notice", level: "error" });
    expect((t.items.at(-1) as { text: string }).text).toContain("演示 · 实现：没有写权限");

    await updateAgent(s, "demo-coder", (a) => ((a.permissions.write = "allow"), (a.permissions.exec = "allow")));
    const direct = await s.post("/api/threads", { title: "直接执行", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    t = await s.waitForThread(direct.id, (x) => x.runs.some((r) => r.stage === "implement" && r.status !== "running"), "implement to finish");
    const impl = t.runs.find((r) => r.stage === "implement")!;
    expect(t.items.some((i) => i.kind === "approval" && i.runId === impl.id)).toBe(false);
    expect(t.items.find((i) => i.kind === "tool" && i.tool === "shell" && i.runId === impl.id)).toMatchObject({ status: "ok" });
  });

  it("reads cards saved with the old boolean write flag", async () => {
    const s = await testServer();
    const file = path.join(s.root, ".baton/agents/demo-coder.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/write: \S+/, "write: true"));
    fs.writeFileSync(path.join(s.root, ".baton/agents/old-reader.md"), "---\nname: 旧卡片\nsource: demo\nruntime: pi\nprovider: demo\nmodel: demo-review\nroles: [review]\npermissions:\n  write: false\n---\n");
    const agents = await s.get<AgentCard[]>("/api/agents");
    expect(agents.find((a) => a.id === "demo-coder")?.permissions.write).toBe("allow");
    expect(agents.find((a) => a.id === "old-reader")?.permissions).toEqual({ write: "deny", exec: "ask", network: "deny" });
  });
});

describe("HTTP API: disabling an agent (US-14)", () => {
  it("keeps a disabled agent's card but never picks it", async () => {
    const s = await testServer({ settings: implementNow });
    await onlyDemoCoder(s);
    await updateAgent(s, "demo-coder", (a) => (a.enabled = false));
    expect(fs.existsSync(path.join(s.root, ".baton/agents/demo-coder.md"))).toBe(true);
    const created = await s.post("/api/threads", { title: "停用", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    let t = await s.settled(created.id);
    expect(t.runs).toHaveLength(0);
    expect((t.items.at(-1) as { text: string }).text).toContain("演示 · 实现：已停用");

    await updateAgent(s, "demo-coder", (a) => (a.enabled = true));
    await s.post(`/api/threads/${created.id}/messages`, { text: "重新启用了，继续" });
    t = await s.settled(created.id);
    expect(t.runs[0]).toMatchObject({ agentId: "demo-coder", stage: "implement" });
  });
});

describe("HTTP API: briefing preview (US-15)", () => {
  it("lists each section's source and size, duplicates and the hash an agent would start with", async () => {
    const s = await testServer();
    await s.put("/api/context", { content: "# 房间上下文\n\n- 所有产出写在 notes/ 下\n" });
    const b = await s.get<Briefing>("/api/agents/demo-coder/briefing?role=implement");
    expect(b.sections.map((x) => x.key)).toEqual(expect.arrayContaining(["base", "role", "context", "task"]));
    for (const section of b.sections) {
      expect(section.source).toBeTruthy();
      expect(section.bytes).toBe(Buffer.byteLength(section.content));
    }
    expect(b.sections.find((x) => x.key === "context")).toMatchObject({ source: ".baton/CONTEXT.md" });
    expect(b.sections.find((x) => x.key === "context")!.content).toContain("所有产出写在 notes/ 下");
    expect(b.hash).toMatch(/^[0-9a-f]{8,}$/);
    expect(Array.isArray(b.duplicates)).toBe(true);
    expect(b.bytes).toBeLessThanOrEqual(b.budget);
    const again = await s.get<Briefing>("/api/agents/demo-coder/briefing?role=implement");
    expect(again.hash).toBe(b.hash);
    expect((await s.get<Briefing>("/api/agents/demo-coder/briefing?role=review")).hash).not.toBe(b.hash);
    expect((await s.request("GET", "/api/agents/demo-coder/briefing?role=boss")).status).toBe(400);
  });
});

describe("HTTP API: advisors stay read-only (US-16)", () => {
  it("refuses an advisor card that can write or run commands directly", async () => {
    const s = await testServer();
    for (const patch of [(a: AgentCard) => (a.permissions.write = "ask"), (a: AgentCard) => (a.permissions.exec = "allow")]) {
      const res = await updateAgent(s, "demo-advisor", patch);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("顾问必须只读");
    }
    expect((await s.get<AgentCard[]>("/api/agents")).find((a) => a.id === "demo-advisor")?.permissions).toMatchObject({ write: "deny", exec: "deny" });
  });

  it("gives an advisor run no write or command tools", async () => {
    const s = await testServer({ settings: (st) => ((st.confirm.planToImplement = false), (st.advisor.beforePlan = true)) });
    const created = await s.post("/api/threads", { title: "请教", task: "写一份说明", acceptance: ["有说明"] });
    const t = await s.settled(created.id);
    const advisor = t.runs.find((r) => r.role === "advisor")!;
    expect(advisor).toBeDefined();
    const briefing = fs.readFileSync(path.join(s.root, ".baton/sessions/briefings", `${advisor.id}.md`), "utf8");
    expect(briefing).toContain("顾问");
    const tools = t.items.filter((i) => i.kind === "tool" && i.runId === advisor.id).map((i) => (i as { tool: string }).tool);
    expect(tools.filter((x) => ["write_file", "edit_file", "apply_patch", "shell"].includes(x))).toEqual([]);
    expect(advisor.changedFiles).toEqual([]);
  });
});
