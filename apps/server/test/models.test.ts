import type { Briefing } from "@baton/core";
import { describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

interface Route {
  source: string;
  label: string;
  unavailable?: string;
  error?: string;
  models: { id: string; name: string; family: string }[];
}

describe("HTTP API: one page for accounts and models (US-95)", () => {
  it("lists every account route with its sign-in state and all its models, each tagged with its family", async () => {
    const s = await testServer();
    const { routes } = await s.get<{ routes: Route[] }>("/api/models");
    expect(routes.map((r) => r.source)).toEqual(["chatgpt", "cursor", "demo"]);
    const by = Object.fromEntries(routes.map((r) => [r.source, r]));
    expect(by.chatgpt!.unavailable).toContain("ChatGPT");
    expect(by.chatgpt!.models.length).toBeGreaterThan(0);
    expect(by.chatgpt!.models.every((m) => m.family === "gpt")).toBe(true);
    expect(by.cursor!.unavailable).toBeUndefined();
    expect(by.cursor!.models.map((m) => m.id)).toEqual(["composer-2.5", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high", "gemini-4-argon-medium", "grok-4.7-medium"]);
    expect(by.cursor!.models.find((m) => m.id === "claude-sonnet-5-5-medium")).toMatchObject({ name: "Claude Sonnet 5.5 Medium", family: "claude" });
    expect(by.demo!.models.map((m) => m.family)).toEqual(["demo-chat", "demo-review"]);

    const refreshed = await s.get<{ routes: Route[] }>("/api/models?refresh=1");
    expect(refreshed.routes.find((r) => r.source === "cursor")!.models).toHaveLength(5);
    expect((await s.get("/api/state")).agents).toBeUndefined();
  });

  it("previews the briefing a model would start a chat or review with: each section's source and size, duplicates and the hash", async () => {
    const s = await testServer();
    await s.put("/api/context", { content: "# 房间上下文\n\n- 所有产出写在 notes/ 下\n" });
    const b = await s.get<Briefing>("/api/briefing?source=cursor&model=claude-sonnet-5-5-medium&role=chat");
    expect(b.sections.map((x) => x.key)).toEqual(["base", "role", "runtime", "context", "task"]);
    for (const section of b.sections) {
      expect(section.source).toBeTruthy();
      expect(section.bytes).toBe(Buffer.byteLength(section.content));
    }
    expect(b.sections.find((x) => x.key === "runtime")).toMatchObject({ source: ".baton/rules/runtime-cursor.md" });
    expect(b.sections.find((x) => x.key === "context")!.content).toContain("所有产出写在 notes/ 下");
    expect(b.sections.find((x) => x.key === "task")!.content).toContain("Claude Sonnet 5.5 Medium · Cursor");
    expect(b.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(b.duplicates)).toBe(true);
    expect(b.bytes).toBeLessThanOrEqual(b.budget);

    expect((await s.get<Briefing>("/api/briefing?source=cursor&model=claude-sonnet-5-5-medium&role=chat")).hash).toBe(b.hash);
    const review = await s.get<Briefing>("/api/briefing?source=cursor&model=claude-sonnet-5-5-medium&role=review");
    expect(review.hash).not.toBe(b.hash);
    expect(review.text).toContain("submit_review");

    expect((await s.request("GET", "/api/briefing?source=cursor&model=claude-sonnet-5-5-medium&role=boss")).status).toBe(400);
    expect((await s.request("GET", "/api/briefing?source=cursor&model=gpt-5.6-sol&role=chat")).status).toBe(400);
  });

  it("validates the briefing budget in settings", async () => {
    const s = await testServer();
    const settings = await s.get("/api/settings");
    expect(settings.budgets).toEqual({ briefing: 24 * 1024, context: 6 * 1024 });
    expect(settings.limits).toBeUndefined();
    const res = await s.request("PUT", "/api/settings", { ...settings, budgets: { ...settings.budgets, briefing: 1000 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("启动上下文预算");
  });
});
