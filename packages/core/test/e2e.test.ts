import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listMemory } from "../src/memory.ts";
import { DEMO_CHAT, DEMO_REVIEW, demoSetup, waitFor, waitForSettled } from "./helpers.ts";

describe("demo chat end to end", () => {
  it("chats read-only, changes a file once access is opened, and another model reviews it", async () => {
    const { orch, root, ws } = demoSetup();
    const thread = orch.createThread({ task: "记住：周报放在 notes/ 下", model: DEMO_CHAT });
    let t = await waitForSettled(orch, thread.id);
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ role: "chat", source: "demo", model: "demo-chat", agentId: "demo:demo-chat", status: "succeeded" });
    expect(listMemory(ws).some((m) => m.text.includes("周报放在 notes/"))).toBe(true);

    orch.postMessage(thread.id, "写文件：notes/weekly.md");
    t = await waitForSettled(orch, thread.id);
    expect(t.runs[1]!.changedFiles).toEqual([]);
    expect(fs.existsSync(path.join(root, "notes/weekly.md"))).toBe(false);
    expect(t.items.some((i) => i.kind === "approval")).toBe(false);
    await expect(orch.review(thread.id, DEMO_REVIEW)).rejects.toThrow("还没有改动");

    orch.setAccess(thread.id, "ask");
    orch.postMessage(thread.id, "写文件：notes/weekly.md");
    await waitFor(() => orch.getThread(thread.id)!.runs.length === 3, 20_000, "third run");
    t = await waitForSettled(orch, thread.id);
    expect(t.runs[2]!.changedFiles).toEqual(["notes/weekly.md"]);
    expect(fs.existsSync(path.join(root, "notes/weekly.md"))).toBe(true);
    expect(t.items.some((i) => i.kind === "approval" && i.status === "allowed")).toBe(true);

    const review = (await orch.review(thread.id, DEMO_REVIEW))!;
    t = orch.getThread(thread.id)!;
    expect(review).toMatchObject({ role: "review", model: "demo-review", review: { verdict: "pass", issues: [] }, reviewed: [t.runs[2]!.id] });
    expect(review.checks?.[0]?.status).toBe("pass");
    expect(review.changedFiles).toEqual([]);
    expect(t.items.at(-1)).toMatchObject({ kind: "review", verdict: { verdict: "pass" } });
    expect(t.model).toEqual(DEMO_CHAT);
    await expect(orch.review(thread.id, DEMO_REVIEW)).rejects.toThrow("没有新的改动");
    expect(fs.readFileSync(ws.path("audit.jsonl"), "utf8")).toContain("write_file");
  });

  it("never records a pass over a failed check, and fails a diff that still has a TODO", async () => {
    const { orch } = demoSetup({
      mutate: (ws) => {
        const s = ws.settings();
        s.checks = [{ name: "没有 TODO", command: "! grep -rq TODO notes", timeoutSec: 30 }];
        ws.saveSettings(s);
      },
    });
    const thread = orch.createThread({ task: "开个头", model: DEMO_CHAT });
    await waitForSettled(orch, thread.id);
    orch.setAccess(thread.id, "allow");
    orch.postMessage(thread.id, "写文件：notes/todo.md TODO 以后补");
    await waitFor(() => orch.getThread(thread.id)!.runs.length === 2, 20_000, "second run");
    await waitForSettled(orch, thread.id);

    const review = (await orch.review(thread.id, DEMO_REVIEW))!;
    expect(review.checks?.[0]?.status).toBe("fail");
    expect(review.review?.verdict).toBe("fail");
    expect(review.review?.issues.join("\n")).toContain("TODO");
  });

  it("overrules a reviewer that passes despite a failed check", async () => {
    const { orch } = demoSetup({
      mutate: (ws) => {
        const s = ws.settings();
        s.checks = [{ name: "总是失败", command: "false", timeoutSec: 30 }];
        ws.saveSettings(s);
      },
    });
    const thread = orch.createThread({ task: "开个头", model: DEMO_CHAT });
    await waitForSettled(orch, thread.id);
    orch.setAccess(thread.id, "allow");
    orch.postMessage(thread.id, "写文件：notes/ok.md 放过检查");
    await waitFor(() => orch.getThread(thread.id)!.runs.length === 2, 20_000, "second run");
    await waitForSettled(orch, thread.id);
    const review = (await orch.review(thread.id, DEMO_REVIEW))!;
    expect(review.review).toEqual({ verdict: "fail", issues: ["检查命令没有通过：总是失败"] });
    const item = orch.getThread(thread.id)!.items.findLast((i) => i.kind === "review");
    if (item?.kind !== "review") throw new Error("no review item");
    expect(item.overruled).toContain("给出了通过");
  });

  it("denies a change when the user rejects the approval, and rolls back a reply", async () => {
    const { orch, root } = demoSetup({ autoApprove: false });
    const thread = orch.createThread({ task: "开个头", model: DEMO_CHAT });
    await waitForSettled(orch, thread.id);
    orch.setAccess(thread.id, "ask");
    orch.postMessage(thread.id, "写文件：notes/a.md");
    await waitFor(() => orch.getThread(thread.id)!.items.some((i) => i.kind === "approval" && i.status === "pending"), 20_000, "approval");
    const item = orch.getThread(thread.id)!.items.find((i) => i.kind === "approval" && i.status === "pending");
    if (item?.kind !== "approval") throw new Error("no approval");
    expect(item.title).toBe("改文件：notes/a.md");
    orch.respondApproval(item.approvalId, false);
    await waitFor(() => orch.getThread(thread.id)!.items.some((i) => i.kind === "tool" && i.status === "denied"), 20_000, "denied tool");
    await waitFor(() => orch.getThread(thread.id)!.items.some((i) => i.kind === "approval" && i.status === "pending"), 20_000, "command approval");
    const command = orch.getThread(thread.id)!.items.find((i) => i.kind === "approval" && i.status === "pending");
    if (command?.kind !== "approval") throw new Error("no command approval");
    expect(command.preview).toBe("wc -l notes/a.md");
    orch.respondApproval(command.approvalId, false);
    let t = await waitForSettled(orch, thread.id);
    expect(fs.existsSync(path.join(root, "notes/a.md"))).toBe(false);

    orch.setAccess(thread.id, "allow");
    orch.postMessage(thread.id, "写文件：notes/b.md");
    await waitFor(() => orch.getThread(thread.id)!.runs.length === 3, 20_000, "third run");
    t = await waitForSettled(orch, thread.id);
    const run = t.runs[2]!;
    expect(run.changedFiles).toEqual(["notes/b.md"]);
    expect(await orch.runDiff(run.id)).toContain("notes/b.md");
    await orch.rollback(run.id);
    expect(fs.existsSync(path.join(root, "notes/b.md"))).toBe(false);
  });

  it("refuses to start when the briefing is over budget", async () => {
    const { orch } = demoSetup({
      mutate: (ws) => {
        const s = ws.settings();
        s.budgets.briefing = 512;
        ws.saveSettings(s);
      },
    });
    const thread = orch.createThread({ task: "x", model: DEMO_CHAT });
    const t = await waitForSettled(orch, thread.id);
    expect(t.runs).toHaveLength(0);
    expect(t.status).toBe("paused");
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("超过"))).toBe(true);
  });
});
