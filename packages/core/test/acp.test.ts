import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cursorLogin, cursorModels, cursorStatus, parseCursorModels } from "../src/cursor-cli.ts";
import { filterCursorModels } from "../src/families.ts";
import { CURSOR_COMPOSER, CURSOR_SONNET, DEMO_CHAT, MOCK_ACP, demoSetup, waitFor, waitForSettled } from "./helpers.ts";

const mockCommand = `node ${MOCK_ACP}`;

describe("Cursor CLI helpers", () => {
  it("parses status, models (dropping GPT and Auto) and the login URL", async () => {
    expect(await cursorStatus(mockCommand)).toMatchObject({ installed: true, loggedIn: true, account: "demo@example.com" });
    const { models } = await cursorModels(mockCommand);
    const ids = models.map((m) => m.id);
    expect(ids).toEqual(["composer-2.5", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high", "gemini-4-argon-medium", "grok-4.7-medium"]);
    expect(models.find((m) => m.id === "claude-sonnet-5-5-medium")?.name).toBe("Claude Sonnet 5.5 Medium");
    const login = cursorLogin(mockCommand);
    expect(await login.url).toBe("https://cursor.com/loginDeepControl?challenge=mock&mode=login");
    expect(await login.done).toBe(true);
  });

  it("reports a missing CLI", async () => {
    expect(await cursorStatus("definitely-not-a-cursor-cli")).toMatchObject({ installed: false, loggedIn: false });
  });

  it("filters GPT-family, DeepSeek-family and auto entries from arbitrary listings", () => {
    const parsed = parseCursorModels("- auto\n- o3 - o3\n- claude-opus-4.1 - Opus\n- gpt-5-mini\n- deepseek-v41-flash-1017-high\n");
    expect(filterCursorModels(parsed).map((m) => m.id)).toEqual(["claude-opus-4.1"]);
  });
});

describe("ACP executor with a mock Cursor agent", () => {
  it("routes permission requests to approvals and records changed files once writes are open", async () => {
    const { orch, root } = demoSetup({
      mutate: (ws) => {
        const s = ws.settings();
        s.cursor.command = mockCommand;
        ws.saveSettings(s);
      },
    });
    const thread = orch.createThread({ task: "开个头", model: CURSOR_COMPOSER });
    let t = await waitForSettled(orch, thread.id);
    expect(t.runs[0]!.changedFiles).toEqual([]);
    expect(fs.existsSync(path.join(root, "notes"))).toBe(false);

    orch.setAccess(thread.id, "ask");
    orch.postMessage(thread.id, "让 Cursor 写文件");
    await waitFor(() => orch.getThread(thread.id)!.runs.length === 2, 20_000, "second run");
    t = await waitForSettled(orch, thread.id);
    const run = t.runs[1]!;
    expect(run).toMatchObject({ agentId: "cursor:composer-2.5", runtime: "cursor", status: "succeeded" });
    expect(run.changedFiles).toEqual(["notes/cursor-composer-2.5.md"]);
    expect(fs.existsSync(path.join(root, "notes/cursor-composer-2.5.md"))).toBe(true);
    expect(t.items.some((i) => i.kind === "approval" && i.preview === "find notes -type f" && i.status === "allowed")).toBe(true);
    expect(t.items.some((i) => i.kind === "text" && i.text.includes("模拟 Cursor"))).toBe(true);
  });

  it("keeps a reviewer from editing (ask mode) and reminds it once when it gives no verdict", async () => {
    const { orch, root } = demoSetup({
      mutate: (ws) => {
        const s = ws.settings();
        s.cursor.command = mockCommand;
        ws.saveSettings(s);
      },
    });
    const thread = orch.createThread({ task: "开个头", model: DEMO_CHAT });
    await waitForSettled(orch, thread.id);
    orch.setAccess(thread.id, "allow");
    orch.postMessage(thread.id, "写文件：notes/x.md");
    await waitFor(() => orch.getThread(thread.id)!.runs.length === 2, 20_000, "second run");
    await waitForSettled(orch, thread.id);

    const review = (await orch.review(thread.id, CURSOR_SONNET))!;
    expect(review).toMatchObject({ agentId: "cursor:claude-sonnet-5-5-medium", role: "review", changedFiles: [] });
    expect(fs.existsSync(path.join(root, "notes/cursor-claude-sonnet-5-5-medium.md"))).toBe(false);
    // No MCP bridge in a bare orchestrator, so the mock cannot call submit_review.
    expect(review.review).toBeUndefined();
    const t = orch.getThread(thread.id)!;
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("追加一次提醒"))).toBe(true);
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("没有给出检查结论"))).toBe(true);
  });
});
