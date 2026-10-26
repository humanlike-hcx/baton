import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listMemory } from "../src/memory.ts";
import { demoSetup, waitFor, waitForSettled } from "./helpers.ts";

describe("demo flow end to end", () => {
  it("plans, asks before implementing, implements, checks, reviews and asks before completing", async () => {
    const { orch, root, ws } = demoSetup();
    const thread = orch.createThread({ title: "写一份周报模板", task: "写一份周报模板", acceptance: ["包含本周进展和下周计划"] });

    let t = await waitForSettled(orch, thread.id);
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]!.stage).toBe("plan");
    expect(t.runs[0]!.handoff?.auto).toBe(false);
    expect(t.runs[0]!.proposedNext?.stage).toBe("implement");
    expect(t.pending?.kind).toBe("start_stage");
    expect(t.pending?.agentId).toBe("demo-coder");
    expect(listMemory(ws).some((m) => m.kind === "decision")).toBe(true);

    await orch.decide(t.id, t.pending!.id, { approve: true });
    t = await waitForSettled(orch, thread.id);
    const stages = t.runs.map((r) => r.stage);
    expect(stages).toEqual(["plan", "implement", "review"]);
    const impl = t.runs[1]!;
    expect(impl.changedFiles.some((f) => f.startsWith("notes/"))).toBe(true);
    expect(fs.existsSync(path.join(root, impl.changedFiles.find((f) => f.startsWith("notes/"))!))).toBe(true);
    const review = t.runs[2]!;
    expect(review.family).not.toBe(impl.family);
    expect(review.checks?.[0]?.status).toBe("pass");
    expect(review.handoff?.verdict).toBe("pass");
    expect(t.pending?.kind).toBe("complete");

    await orch.decide(t.id, t.pending!.id, { approve: true });
    t = orch.getThread(thread.id)!;
    expect(t.status).toBe("done");
    expect(t.items.some((i) => i.kind === "approval" && i.status === "allowed")).toBe(true);
    expect(fs.readFileSync(ws.path("audit.jsonl"), "utf8")).toContain("write_file");
  });

  it("consults the advisor before the plan sets direction, sends back after a failed review, and can roll back", async () => {
    const { orch, root } = demoSetup({
      mutate: (ws) => {
        const s = ws.settings();
        s.confirm.planToImplement = false;
        s.advisor.beforePlan = true;
        ws.saveSettings(s);
      },
    });
    const thread = orch.createThread({ title: "退回演示", task: "写一份说明，演示退回", acceptance: ["包含验证方式"] });
    let t = await waitForSettled(orch, thread.id);
    expect(t.pending?.kind).toBe("start_stage");
    expect(t.pending?.advice).toContain("结论");
    const advisorRun = t.runs.find((r) => r.role === "advisor")!;
    expect(advisorRun.agentId).toBe("demo-advisor");
    expect(advisorRun.handoff).toBeUndefined();
    expect(t.items.some((i) => i.kind === "advisor")).toBe(true);

    await orch.decide(t.id, t.pending!.id, { approve: true });
    t = await waitForSettled(orch, thread.id, 40_000);
    const runs = t.runs.filter((r) => r.role !== "advisor");
    expect(runs.map((r) => r.stage)).toEqual(["plan", "implement", "review", "implement", "review"]);
    expect(t.sendBacks).toBe(1);
    expect(runs[2]!.handoff?.verdict).toBe("fail");
    expect(runs[4]!.handoff?.verdict).toBe("pass");
    expect(t.pending?.kind).toBe("complete");

    const note = runs[1]!.changedFiles.find((f) => f.startsWith("notes/"))!;
    expect(fs.readFileSync(path.join(root, note), "utf8")).toContain("验证方式");
    const diff = await orch.runDiff(runs[3]!.id);
    expect(diff).toContain("验证方式");

    await orch.decide(t.id, t.pending!.id, { approve: false });
    await orch.rollback(runs[1]!.id);
    expect(fs.existsSync(path.join(root, note))).toBe(false);
  });

  it("denies a command when the user rejects the approval", async () => {
    const { orch } = demoSetup({
      autoApprove: false,
      mutate: (ws) => {
        const s = ws.settings();
        s.confirm.planToImplement = false;
        ws.saveSettings(s);
      },
    });
    const thread = orch.createThread({ title: "拒绝命令", task: "演示拒绝", acceptance: ["无"] });
    await waitFor(() => orch.getThread(thread.id)!.items.some((i) => i.kind === "approval" && i.status === "pending"), 20_000, "approval");
    const item = orch.getThread(thread.id)!.items.find((i) => i.kind === "approval" && i.status === "pending");
    if (item?.kind !== "approval") throw new Error("no approval");
    expect(item.preview).toMatch(/^wc -l notes\//);
    orch.respondApproval(item.approvalId, false);
    await waitFor(() => orch.getThread(thread.id)!.items.some((i) => i.kind === "tool" && i.status === "denied"), 20_000, "denied tool");
    await waitForSettled(orch, thread.id);
  });

  it("refuses to start when the briefing is over budget", async () => {
    const { orch } = demoSetup({
      mutate: (ws) => {
        const s = ws.settings();
        s.budgets.planner = 512;
        ws.saveSettings(s);
      },
    });
    const thread = orch.createThread({ title: "超预算", task: "x", acceptance: ["y"] });
    const t = await waitForSettled(orch, thread.id);
    expect(t.runs).toHaveLength(0);
    expect(t.status).toBe("paused");
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("超过"))).toBe(true);
  });
});
