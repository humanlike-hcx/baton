import type { MemoryEntry, TidyStatus } from "@baton/core";
import { describe, expect, it } from "vitest";
import { tempDir, testServer } from "./helpers.ts";

const bytes = (s: string) => Buffer.byteLength(s);
const smallBudget = (st: { budgets: { context: number } }) => (st.budgets.context = 1024);

/** Over 1KB: a repeated line, five detail bullets (long), and short conventions worth keeping. */
const OVERGROWN = [
  "# 房间上下文",
  "",
  "## 目标",
  "- 给团队写一套接入新人用的说明文档",
  "- 给团队写一套接入新人用的说明文档",
  "",
  "## 约定",
  "- 日期统一写成 ISO 8601",
  "- 文档放在 docs/onboarding/ 下",
  "",
  "## 进展细节",
  "- 第一周访谈了五位新人，大家普遍反映找不到本地环境的启动步骤、不知道测试数据从哪里来、也不清楚提交前要跑哪些检查命令",
  "- 第二周整理了现有的十七份零散文档，其中九份已经过时，四份内容重复，剩下的四份可以合并成入门、环境、流程三篇",
  "- 第三周和运维确认了测试数据库的申请流程，需要在工单系统里提交申请并抄送组长，一般一个工作日内开通完毕",
  "- 第四周试读了入门篇的初稿，三位新人都能在半小时内跑起本地环境，但对代码评审的规矩仍然一知半解，需要补一节",
  "- 第五周把环境篇里的截图全部换成了文字步骤，原因是截图跟不上界面改版，上个月有两张截图已经和实际界面对不上了",
  "",
].join("\n");

async function tidied(s: Awaited<ReturnType<typeof testServer>>, label = "tidy to finish") {
  const start = Date.now();
  for (;;) {
    const status = await s.get<TidyStatus>("/api/context/tidy");
    if (status.records[0] && status.records[0].status !== "running") return status;
    if (Date.now() - start > 10_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("HTTP API: tidying the room context (US-42)", () => {
  it("tidies automatically when a save goes over budget, records a diff, and can be undone", async () => {
    const s = await testServer({ settings: smallBudget });
    expect(bytes(OVERGROWN)).toBeGreaterThan(1024);
    await s.put("/api/context", { content: OVERGROWN });

    const status = await tidied(s);
    const record = status.records[0]!;
    expect(record).toMatchObject({ trigger: "auto", status: "applied", budget: 1024, before: OVERGROWN });
    const { content } = await s.get<{ content: string }>("/api/context");
    expect(content).toBe(record.after);
    expect(bytes(content)).toBeLessThanOrEqual(1024);
    expect(status.overBudget).toBe(false);
    expect(content.match(/接入新人用的说明文档/g)).toHaveLength(1);
    expect(content).toContain("日期统一写成 ISO 8601");
    expect(content).not.toContain("第一周访谈");

    expect(record.memories).toHaveLength(5);
    const memory = await s.get<MemoryEntry[]>("/api/memory");
    for (const m of record.memories) {
      expect(memory.find((e) => e.id === m.id)).toMatchObject({ status: "active", text: m.text, author: "整理员 · demo-tidy" });
    }

    const undone = await s.post(`/api/context/tidy/${record.id}/undo`);
    expect(undone.status).toBe("undone");
    expect((await s.get<{ content: string }>("/api/context")).content).toBe(OVERGROWN);
    const after = await s.get<MemoryEntry[]>("/api/memory");
    for (const m of record.memories) expect(after.find((e) => e.id === m.id)?.status).toBe("superseded");

    // Undoing puts the context back over budget, but the text the user chose to keep is not tidied again.
    await new Promise((r) => setTimeout(r, 200));
    const final = await s.get<TidyStatus>("/api/context/tidy");
    expect(final.records).toHaveLength(1);
    expect(final.overBudget).toBe(true);
  });

  it("refuses to undo once the context has changed again", async () => {
    const s = await testServer({ settings: smallBudget });
    await s.put("/api/context", { content: OVERGROWN });
    const record = (await tidied(s)).records[0]!;
    await s.put("/api/context", { content: `${record.after}- 新加的一条约定\n` });

    const res = await s.request("POST", `/api/context/tidy/${record.id}/undo`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("又改过了");
    expect((await s.get<{ content: string }>("/api/context")).content).toContain("新加的一条约定");
  });

  it("tidies after an agent's update_context goes over budget", async () => {
    const s = await testServer({ settings: (st) => (smallBudget(st), (st.confirm.planToImplement = false)) });
    const convention = "所有对外文档都要先给法务过目，".repeat(24);
    const t = await s.post("/api/threads", { title: "长约定", task: `写进上下文：${convention}`, acceptance: ["有说明"], stage: "plan" });
    await s.settled(t.id);

    const record = (await tidied(s)).records[0]!;
    expect(record).toMatchObject({ trigger: "auto", status: "applied" });
    expect(record.before).toContain(convention);
    expect(record.memories.map((m) => m.text)).toContain(convention);
    expect(bytes((await s.get<{ content: string }>("/api/context")).content)).toBeLessThanOrEqual(1024);
  });

  it("leaves the context alone when the model does not answer in format, and does not retry on its own", async () => {
    const s = await testServer({ settings: smallBudget });
    const content = `${OVERGROWN}- 不按格式\n`;
    await s.put("/api/context", { content });
    const status = await tidied(s);
    expect(status.records[0]).toMatchObject({ status: "failed", error: "整理员没有按格式给出整理结果" });
    expect((await s.get<{ content: string }>("/api/context")).content).toBe(content);

    await s.put("/api/context", { content });
    await new Promise((r) => setTimeout(r, 200));
    expect((await s.get<TidyStatus>("/api/context/tidy")).records).toHaveLength(1);

    const manual = await s.request("POST", "/api/context/tidy");
    expect(manual.status).toBe(202);
    expect(manual.body).toMatchObject({ trigger: "manual", status: "running" });
    expect((await tidied(s)).records).toHaveLength(2);
  });

  it("needs DeepSeek outside the demo, and says so instead of tidying", async () => {
    const s = await testServer({ settings: smallBudget });
    await s.post("/api/workspace/open", { path: tempDir("baton-real-ws-") });
    const settings = await s.get("/api/settings");
    await s.put("/api/settings", { ...settings, budgets: { ...settings.budgets, context: 1024 } });
    await s.put("/api/context", { content: OVERGROWN });

    const status = await s.get<TidyStatus>("/api/context/tidy");
    expect(status).toMatchObject({ overBudget: true, records: [] });
    expect(status.unavailable).toContain("DeepSeek");
    const res = await s.request("POST", "/api/context/tidy");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("DeepSeek");
  });

  it("keeps the budget within the hard cap", async () => {
    const s = await testServer();
    const settings = await s.get("/api/settings");
    expect(settings.budgets.context).toBeLessThanOrEqual(8 * 1024);
    const res = await s.request("PUT", "/api/settings", { ...settings, budgets: { ...settings.budgets, context: 9 * 1024 } });
    expect(res.status).toBe(400);
  });
});
