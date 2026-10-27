import type { Thread } from "@baton/core";
import { describe, expect, it } from "vitest";
import { CURSOR_COMPOSER, testServer } from "./helpers.ts";

interface Route {
  source: string;
  models: { id: string; thinking?: string[]; fastMode?: boolean; variant?: { base: string; effort?: string; reasoning: boolean; fast: boolean } }[];
}

describe("HTTP API: thinking levels (US-100)", () => {
  it("lists each model's own levels, merges Cursor's variants by base, and records the level a chat picks", async () => {
    const s = await testServer();
    const { routes } = await s.get<{ routes: Route[] }>("/api/models");
    const models = routes.find((r) => r.source === "chatgpt")!.models;
    const gpt = models.find((m) => m.id === "gpt-6.1-sol")!;
    expect(gpt.thinking).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models.find((m) => m.id === "gpt-5.6-luna")!.thinking).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(models.find((m) => m.id === "gpt-5.6-luna")).toMatchObject({ fastMode: true });
    expect(routes.find((r) => r.source === "demo")!.models.every((m) => !m.fastMode)).toBe(true);
    expect(routes.find((r) => r.source === "demo")!.models.every((m) => !m.thinking)).toBe(true);
    const cursor = routes.find((r) => r.source === "cursor")!.models;
    expect(cursor.find((m) => m.id === "claude-sonnet-5-5-medium")!.variant).toEqual({ base: "claude-sonnet-5-5", baseName: "Claude Sonnet 5.5", effort: "medium", reasoning: false, fast: false });
    expect(cursor.find((m) => m.id === "claude-sonnet-5-5-high")!.variant).toMatchObject({ base: "claude-sonnet-5-5", effort: "high" });
    expect(cursor.find((m) => m.id === "composer-2.5")!.variant).toMatchObject({ base: "composer-2.5", reasoning: false, fast: false });

    const t = await s.post<Thread>("/api/threads", { task: "", source: "chatgpt", model: "gpt-6.1-sol", thinking: "high" });
    expect(t.model).toMatchObject({ source: "chatgpt", model: "gpt-6.1-sol", thinking: "high" });
    for (const [pick, error] of [
      [{ source: "chatgpt", model: "gpt-6.1-sol", thinking: "turbo" }, "不支持思考档位 turbo"],
      [{ source: "demo", model: "demo-chat", thinking: "high" }, "不支持思考档位 high"],
    ] as const) {
      const res = await s.request("POST", "/api/threads", { task: "", ...pick });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(error);
    }

    await s.post(`/api/threads/${t.id}/messages`, { text: "换个档位", source: "chatgpt", model: "gpt-6.1-sol", thinking: "low" });
    const after = await s.thread(t.id);
    expect(after.model?.thinking).toBe("low");
    expect(after.items.some((i) => i.kind === "notice" && i.text === "思考档位从「高」改成「低」。")).toBe(true);

    const fast = await s.post<Thread>("/api/threads", { task: "", source: "chatgpt", model: "gpt-5.6-luna", fast: true });
    expect(fast.model).toMatchObject({ model: "gpt-5.6-luna", fast: true });
    await s.post(`/api/threads/${fast.id}/messages`, { text: "关掉快速", source: "chatgpt", model: "gpt-5.6-luna", fast: false });
    const slowed = await s.thread(fast.id);
    expect(slowed.model?.fast).toBeUndefined();
    expect(slowed.items.some((i) => i.kind === "notice" && i.text === "快速已关闭。")).toBe(true);
    const refused = await s.request("POST", "/api/threads", { task: "", source: "demo", model: "demo-chat", fast: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("没有快速模式");
  });
});

describe("HTTP API: context window usage (US-98)", () => {
  it("records how full the window was after a Pi reply, and nothing for a runtime that doesn't report it", async () => {
    const s = await testServer();
    const demo = await s.settled((await s.chat("你好")).id);
    const context = demo.runs[0]!.context!;
    expect(context.window).toBe(128_000);
    expect(context.tokens).toBeGreaterThan(100);
    expect(context.tokens).toBeLessThan(context.window);

    const cursor = await s.settled((await s.chat("看看 notes 目录", { model: CURSOR_COMPOSER })).id);
    expect(cursor.runs[0]!.status).toBe("succeeded");
    expect(cursor.runs[0]!.context).toBeUndefined();
  });
});
