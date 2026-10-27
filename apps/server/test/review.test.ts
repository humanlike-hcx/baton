import fs from "node:fs";
import path from "node:path";
import type { RunRecord, Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { CURSOR_SONNET, DEMO_CHAT, DEMO_REVIEW, testServer } from "./helpers.ts";

type Server = Awaited<ReturnType<typeof testServer>>;
type ReviewItem = Extract<TimelineItem, { kind: "review" }>;

const lastReview = (t: Thread) => t.items.findLast((i): i is ReviewItem => i.kind === "review");
const reviewRuns = (t: Thread) => t.runs.filter((r) => r.role === "review");

/** A chat whose model has changed a file, ready to be checked. */
async function changedChat(s: Server, text = "写文件：notes/weekly.md") {
  const created = await s.chat(text, { access: "allow" });
  return s.settled(created.id);
}

async function review(s: Server, threadId: string, model = DEMO_REVIEW): Promise<{ thread: Thread; run: RunRecord }> {
  const before = reviewRuns(await s.thread(threadId)).length;
  const res = await s.request("POST", `/api/threads/${threadId}/review`, model);
  expect(res.status, res.text).toBe(202);
  const thread = await s.waitForThread(threadId, (t) => reviewRuns(t).length > before && t.status !== "running", "review");
  return { thread, run: reviewRuns(thread).at(-1)! };
}

describe("「让另一个模型检查」(US-94, US-66, US-67)", () => {
  it("runs the checks first, reviews read-only, and posts the verdict back into the chat", async () => {
    const s = await testServer();
    const chat = await changedChat(s);
    const author = chat.runs[0]!;
    expect(author.changedFiles).toEqual(["notes/weekly.md"]);

    const { thread, run } = await review(s, chat.id);
    expect(run).toMatchObject({ role: "review", agentId: "demo:demo-review", status: "succeeded", changedFiles: [], reviewed: [author.id], review: { verdict: "pass", issues: [] } });
    expect(run.checks).toEqual([expect.objectContaining({ name: "笔记已生成", status: "pass" })]);
    const kinds = thread.items.slice(thread.items.findIndex((i) => i.kind === "notice" && i.text.includes("只读检查"))).map((i) => i.kind);
    expect(kinds.indexOf("checks")).toBeLessThan(kinds.indexOf("run_start"));
    expect(lastReview(thread)).toMatchObject({ runId: run.id, agentName: "检查 · 演示", verdict: { verdict: "pass" } });
    expect(thread.model).toMatchObject(DEMO_CHAT);
    expect(thread.access).toBe("allow");

    const seen = fs.readFileSync(path.join(s.root, ".baton/sessions/briefings", `${run.id}.md`), "utf8");
    expect(seen).toContain("角色：检查");
    expect(seen).toContain("## 用户的要求\n写文件：notes/weekly.md");
    expect(seen).toContain("## 改动的文件\n- notes/weekly.md");
    expect(seen).toContain("+# 对话里写的文件");
    expect(seen).toContain("笔记已生成：通过");
    const reviewTools = thread.items.filter((i) => i.kind === "tool" && i.runId === run.id).map((i) => (i as { tool: string }).tool);
    expect(reviewTools).toEqual(["read_file", "submit_review"]);
  });

  it("fails on a problem in the diff, and never passes over a failed check", async () => {
    const s = await testServer({ settings: (st) => (st.checks = [{ name: "没有 TODO", command: "! grep -rq TODO notes", timeoutSec: 30 }]) });
    const todo = await changedChat(s, "写文件：notes/todo.md TODO 以后补");
    const failed = await review(s, todo.id);
    expect(failed.run.checks?.[0]).toMatchObject({ name: "没有 TODO", status: "fail" });
    expect(failed.run.review?.verdict).toBe("fail");
    expect(lastReview(failed.thread)!.verdict.issues.join("\n")).toContain("TODO");

    const careless = await changedChat(s, "写文件：notes/clean.md 放过检查");
    const overruled = await review(s, careless.id);
    expect(overruled.run.review).toEqual({ verdict: "fail", issues: ["检查命令没有通过：没有 TODO"] });
    expect(lastReview(overruled.thread)!.overruled).toContain("检查 · 演示 给出了通过，但检查命令「没有 TODO」没有通过，按不通过记。");
  });

  it("only checks changes made since the last review, and refuses when there are none", async () => {
    const s = await testServer();
    const empty = await s.settled((await s.chat("只是聊聊")).id);
    const none = await s.request("POST", `/api/threads/${empty.id}/review`, DEMO_REVIEW);
    expect(none.status).toBe(400);
    expect(none.body.error).toContain("还没有改动可以检查");

    const chat = await changedChat(s);
    await review(s, chat.id);
    const again = await s.request("POST", `/api/threads/${chat.id}/review`, DEMO_REVIEW);
    expect(again.body.error).toContain("上次检查之后这个对话没有新的改动");

    const next = await s.say(chat.id, "写文件：notes/second.md");
    const { run } = await review(s, chat.id);
    expect(run.reviewed).toEqual([next.runs.at(-1)!.id]);
    const seen = fs.readFileSync(path.join(s.root, ".baton/sessions/briefings", `${run.id}.md`), "utf8");
    expect(seen).toContain("- notes/second.md");
    expect(seen).not.toContain("- notes/weekly.md");
  });

  it("warns when the reviewer is from the author's family, and refuses models it cannot run", async () => {
    const s = await testServer();
    const chat = await changedChat(s);
    const same = await review(s, chat.id, DEMO_CHAT);
    expect(same.thread.items.some((i) => i.kind === "notice" && i.text.includes("和改动作者同属 demo-chat 家族"))).toBe(true);

    await s.say(chat.id, "写文件：notes/b.md");
    const other = await review(s, chat.id);
    expect(other.thread.items.filter((i) => i.kind === "notice" && i.text.includes("同属")).length).toBe(1);

    for (const [model, error] of [
      [{ source: "cursor", model: "gpt-5.6-sol" }, "GPT 系模型只走 ChatGPT"],
      [{ source: "deepseek", model: "deepseek-v4-pro" }, "现在不能检查"],
    ] as const) {
      await s.say(chat.id, `写文件：notes/${model.source}.md`);
      const res = await s.request("POST", `/api/threads/${chat.id}/review`, model);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(error);
    }
  });

  it("lets a Cursor model review through the bridge, still read-only", async () => {
    const s = await testServer();
    const chat = await changedChat(s);
    const { run } = await review(s, chat.id, CURSOR_SONNET);
    expect(run).toMatchObject({ agentId: "cursor:claude-sonnet-5-5-medium", runtime: "cursor", changedFiles: [] });
    expect(fs.existsSync(path.join(s.root, "notes/cursor-claude-sonnet-5-5-medium.md"))).toBe(false);
    // The test server's bridge URL is unreachable, so the mock gets one reminder and then gives up.
    const t = await s.thread(chat.id);
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("没有给出检查结论"))).toBe(true);
  });
});
