import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

describe("HTTP API: interjections", () => {
  it("carries a message posted during a run into the next run's briefing", async () => {
    const s = await testServer({ autoApprove: false, settings: (st) => (st.confirm.planToImplement = false) });
    const created = await s.post("/api/threads", { title: "插话", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });

    const blocked = await s.waitForThread(created.id, (t) => t.items.some((i) => i.kind === "approval" && i.status === "pending"), "command approval");
    const implRun = blocked.runs[0]!;
    await s.post(`/api/threads/${created.id}/messages`, { text: "检查时顺便看看标题是否清楚" });
    const approval = blocked.items.find((i) => i.kind === "approval" && i.status === "pending");
    if (approval?.kind !== "approval") throw new Error("no approval");
    await s.post(`/api/approvals/${approval.approvalId}`, { allow: true });

    const t = await s.settled(created.id);
    const review = t.runs.find((r) => r.stage === "review");
    expect(review).toBeDefined();
    const briefing = (runId: string) => fs.readFileSync(path.join(s.root, ".baton/sessions/briefings", `${runId}.md`), "utf8");
    expect(briefing(implRun.id)).not.toContain("检查时顺便看看标题是否清楚");
    expect(briefing(review!.id)).toContain("检查时顺便看看标题是否清楚");
    expect(t.notes).toEqual([]);
  });
});
