import fs from "node:fs";
import path from "node:path";
import type { Thread } from "@baton/core";
import { describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

type Server = Awaited<ReturnType<typeof testServer>>;

async function say(s: Server, threadId: string, text: string): Promise<Thread> {
  const before = (await s.thread(threadId)).runs.length;
  await s.post(`/api/threads/${threadId}/messages`, { text });
  return s.waitForThread(threadId, (t) => t.runs.length > before && t.status !== "running", "chat reply");
}

async function chat(s: Server, messages: string[], agentId = "demo-planner"): Promise<Thread> {
  const created = await s.post<Thread>("/api/threads", { kind: "chat", task: messages[0], agentId });
  let t = await s.settled(created.id);
  for (const m of messages.slice(1)) t = await say(s, created.id, m);
  return t;
}

const drafted = (s: Server, id: string) => s.waitForThread(id, (t) => Boolean(t.promotion) && t.promotion!.status !== "drafting" && t.status !== "running", "relay draft");

describe("chat → relay (US-22)", () => {
  it("drafts the task and acceptance from the conversation, and starts the relay only once I confirm", async () => {
    const s = await testServer();
    const c = await chat(s, ["我们要给项目写一份发布说明", "范围只写 1.0 版本的变化"]);

    expect((await s.request("POST", `/api/threads/${c.id}/promote`, { agentId: "demo-advisor" })).status).toBe(202);
    const t = await drafted(s, c.id);
    expect(t.promotion).toMatchObject({ status: "ready", agentId: "demo-advisor" });
    expect(t.pinnedAgents.chat).toBe("demo-advisor");
    const draft = t.promotion!.draft;
    expect(draft.task).toContain("我们要给项目写一份发布说明");
    expect(draft.task).toContain("范围只写 1.0 版本的变化");
    expect(draft.acceptance.length).toBeGreaterThanOrEqual(2);
    expect(t.runs.at(-1)).toMatchObject({ role: "chat", agentId: "demo-advisor", status: "succeeded" });
    expect((await s.get<{ id: string }[]>("/api/threads")).map((x) => x.id)).toEqual([c.id]);

    const confirmed = { title: "写 1.0 发布说明", task: draft.task, acceptance: [...draft.acceptance, "说明里不提 1.0 以外的版本"] };
    const relay = await s.post<Thread>(`/api/threads/${c.id}/promote/confirm`, confirmed);
    expect(relay).toMatchObject({ kind: "relay", title: "写 1.0 发布说明", fromChat: c.id, acceptance: confirmed.acceptance, stage: "plan" });

    const after = await s.thread(c.id);
    expect(after.promotion).toBeUndefined();
    expect(after.relays).toEqual([relay.id]);
    expect(after.items.some((i) => i.kind === "notice" && i.text.includes("已转成接力线程「写 1.0 发布说明」"))).toBe(true);

    const r = await s.settled(relay.id);
    expect(r.items[0]).toMatchObject({ kind: "notice", text: expect.stringContaining(`由对话「${c.title}」转来`) });
    const plan = r.runs.find((x) => x.stage === "plan")!;
    const briefing = fs.readFileSync(path.join(s.root, ".baton/sessions/briefings", `${plan.id}.md`), "utf8");
    expect(briefing).toContain("范围只写 1.0 版本的变化");
    expect(briefing).toContain("说明里不提 1.0 以外的版本");
  });

  it("lets me fill in the draft myself when the agent does not produce one", async () => {
    const s = await testServer();
    const c = await chat(s, ["随便聊聊，不按格式也行"]);
    await s.post(`/api/threads/${c.id}/promote`);
    const t = await drafted(s, c.id);
    expect(t.promotion).toMatchObject({ status: "failed", error: "agent 没有按格式给出任务和验收标准" });
    expect(t.promotion!.draft).toMatchObject({ title: c.title, task: "- 随便聊聊，不按格式也行", acceptance: [] });
    expect(t.items.some((i) => i.kind === "notice" && i.level === "warn" && i.text.includes("可以自己填写后确认"))).toBe(true);

    const empty = await s.request("POST", `/api/threads/${c.id}/promote/confirm`, { ...t.promotion!.draft });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toContain("验收标准");
    expect((await s.thread(c.id)).promotion?.status).toBe("failed");

    const relay = await s.post<Thread>(`/api/threads/${c.id}/promote/confirm`, { title: "写说明", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    expect(relay).toMatchObject({ fromChat: c.id, stage: "implement" });
  });

  it("refuses to promote what is not a finished conversation, and can discard a draft", async () => {
    const s = await testServer({ settings: (st) => (st.confirm.planToImplement = false) });
    const relay = await s.post<Thread>("/api/threads", { title: "接力", task: "写一份说明", acceptance: ["有说明"] });
    const notChat = await s.request("POST", `/api/threads/${relay.id}/promote`, {});
    expect(notChat.status).toBe(400);
    expect(notChat.body.error).toContain("只有对话线程");
    expect((await s.request("POST", "/api/threads/th_missing/promote", {})).status).toBe(404);

    const silent = await s.post<Thread>("/api/threads", { kind: "chat", title: "空对话", task: "", agentId: "demo-planner" });
    const refused = await s.request("POST", `/api/threads/${silent.id}/promote`, {});
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("先聊几句");
    expect((await s.request("POST", `/api/threads/${silent.id}/promote/confirm`, { title: "x", task: "x", acceptance: ["x"] })).status).toBe(400);

    const c = await chat(s, ["写一份说明"]);
    await s.post(`/api/threads/${c.id}/promote`);
    await drafted(s, c.id);
    expect((await s.request("POST", `/api/threads/${c.id}/promote/confirm`, { title: "x", task: "x", acceptance: ["x"], stage: "done" })).status).toBe(400);
    await s.request("DELETE", `/api/threads/${c.id}/promote`);
    expect((await s.thread(c.id)).promotion).toBeUndefined();
    expect((await s.request("POST", `/api/threads/${c.id}/promote/confirm`, { title: "x", task: "x", acceptance: ["x"] })).status).toBe(400);
    expect((await s.get<{ id: string }[]>("/api/threads")).length).toBe(3);
  });

  it("marks a draft interrupted by a restart as failed, keeping the starting point", async () => {
    const s = await testServer();
    const c = await chat(s, ["写一份说明"]);
    const file = path.join(s.root, ".baton/threads", `${c.id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Thread;
    saved.promotion = { status: "drafting", agentId: "demo-planner", draft: { title: c.title, task: "- 写一份说明", acceptance: [] } };
    saved.status = "running";
    fs.writeFileSync(file, JSON.stringify(saved));

    const restarted = await testServer({ reuse: { home: s.home, root: s.root } });
    const t = await restarted.thread(c.id);
    expect(t.promotion).toMatchObject({ status: "failed", error: "工作台重启，整理被中断了", draft: { task: "- 写一份说明" } });
  });
});
