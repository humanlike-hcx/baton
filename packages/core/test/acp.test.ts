import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cursorLogin, cursorModels, cursorStatus, parseCursorModels } from "../src/cursor-cli.ts";
import { filterCursorModels } from "../src/families.ts";
import { MOCK_ACP, demoSetup, waitForSettled } from "./helpers.ts";

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
  it("routes permission requests to approvals, records changed files and auto-writes the missing handoff", async () => {
    const { orch, root } = demoSetup({
      mutate: (ws) => {
        const s = ws.settings();
        s.cursor.command = mockCommand;
        ws.saveSettings(s);
        for (const a of ws.listAgents()) if (a.source === "demo" && a.roles.includes("implement")) ws.saveAgent({ ...a, enabled: false });
      },
    });
    const thread = orch.createThread({ title: "Cursor 实现", task: "让 Cursor 写文件", acceptance: ["notes 下有文件"], stage: "implement", agentId: "coder-cursor-composer" });
    const t = await waitForSettled(orch, thread.id);
    const run = t.runs[0]!;
    expect(run.agentId).toBe("coder-cursor-composer");
    expect(run.status).toBe("succeeded");
    expect(run.changedFiles).toEqual(["notes/cursor-composer-2.5.md"]);
    expect(fs.existsSync(path.join(root, "notes/cursor-composer-2.5.md"))).toBe(true);
    expect(run.handoff?.auto).toBe(true);
    expect(t.items.some((i) => i.kind === "approval" && i.preview === "find notes -type f" && i.status === "allowed")).toBe(true);
    expect(t.items.some((i) => i.kind === "text" && i.text.includes("模拟 Cursor"))).toBe(true);
  });

  it("keeps read-only roles from editing (ask mode + rejected edits)", async () => {
    const { orch, root } = demoSetup({
      mutate: (ws) => {
        const s = ws.settings();
        s.cursor.command = mockCommand;
        ws.saveSettings(s);
      },
    });
    const thread = orch.createThread({ title: "Cursor 检查", task: "检查", acceptance: ["无"], stage: "review", agentId: "reviewer-cursor-sonnet" });
    const t = await waitForSettled(orch, thread.id);
    expect(t.runs[0]!.agentId).toBe("reviewer-cursor-sonnet");
    expect(t.runs[0]!.changedFiles).toEqual([]);
    expect(fs.existsSync(path.join(root, "notes"))).toBe(false);
  });
});
