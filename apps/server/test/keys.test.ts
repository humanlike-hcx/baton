import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Thread } from "@baton/core";
import { afterEach, describe, expect, it } from "vitest";
import { testServer } from "./helpers.ts";

interface Route {
  source: string;
  provider?: string;
  label: string;
  unavailable?: string;
  models: { id: string; name: string; family: string; contextWindow?: number }[];
}

/** A local stand-in for an OpenAI-compatible service: `/v1/models`, and one streamed chat reply. */
async function fakeOpenAiCompatible(models: string[]) {
  const seen: { path: string; auth?: string; body?: unknown }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish: string | null, usage?: object) =>
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
        res.write(chunk({ role: "assistant", content: "来自兼容服务的回复" }, null));
        res.write(chunk({}, "stop", { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208 }));
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  servers.push(server);
  return { url, seen };
}

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("HTTP API: any API key, assembled automatically (US-101)", () => {
  it("recognizes a key by its prefix, uses the service's model catalog, and never returns or logs the key", async () => {
    const s = await testServer();
    const key = "sk-ant-baton0test0anthropic0key0000000000";
    const ambiguous = await s.request("POST", "/api/keys", { key: "sk-baton0test0plain0key0000000000" });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toContain("请先选择服务");

    const added = await s.post("/api/keys", { key });
    expect(added).toMatchObject({ template: "anthropic", provider: "anthropic", label: "Anthropic（Claude）", configured: true });
    const { routes } = await s.get<{ routes: Route[] }>("/api/models");
    expect(routes.map((r) => r.provider ?? r.source)).toEqual(["chatgpt", "cursor", "anthropic", "demo"]);
    const anthropic = routes.find((r) => r.provider === "anthropic")!;
    expect(anthropic).toMatchObject({ source: "key", label: "Anthropic（Claude）" });
    expect(anthropic.unavailable).toBeUndefined();
    expect(anthropic.models.length).toBeGreaterThan(3);
    expect(anthropic.models.every((m) => m.family === "claude" && m.contextWindow)).toBe(true);

    // Same family as on Cursor, kept on both routes (2026-10-27).
    const claude = anthropic.models[0]!.id;
    const thread = await s.post<Thread>("/api/threads", { task: "", source: "key", provider: "anthropic", model: claude });
    expect(thread.model).toMatchObject({ source: "key", provider: "anthropic", account: "Anthropic（Claude）", model: claude });

    const templates = await s.get<{ id: string }[]>("/api/keys/templates");
    expect(templates.map((t) => t.id)).toEqual(expect.arrayContaining(["openai", "anthropic", "google", "deepseek", "qwen", "openrouter", "siliconflow", "ollama", "openai-compatible"]));
    await s.get("/api/state");
    expect([...s.responses, ...s.events.map((e) => JSON.stringify(e))].join("\n")).not.toContain(key);
    const file = path.join(s.home, "credentials.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(s.home, "keys.json"), "utf8")).not.toContain(key);

    await s.request("DELETE", `/api/keys/${(added as { id: string }).id}`);
    expect((await s.get<{ routes: Route[] }>("/api/models")).routes.some((r) => r.provider === "anthropic")).toBe(false);
    expect((await s.get("/api/state")).auth.keys).toEqual([]);
  });

  it("runs GPT through an OpenAI key without touching the ChatGPT login", async () => {
    const s = await testServer();
    const file = path.join(s.home, "credentials.json");
    fs.writeFileSync(file, JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
    await s.post("/api/keys", { key: "sk-proj-baton0test0openai0key000000000" });
    const routes = (await s.get<{ routes: Route[] }>("/api/models")).routes;
    const openai = routes.find((r) => r.provider === "openai-key")!;
    expect(openai).toMatchObject({ source: "key", label: "OpenAI" });
    expect(openai.models.some((m) => m.family === "gpt")).toBe(true);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored.openai.type).toBe("oauth");
    expect(stored["openai-key"].type).toBe("api_key");
    expect((await s.get("/api/state")).auth.chatgpt.loggedIn).toBe(true);
  });

  it("lists an OpenAI-compatible endpoint's models and chats through it with the key", async () => {
    const fake = await fakeOpenAiCompatible(["qwen-max", "qwen-plus"]);
    const s = await testServer();
    const key = "sk-baton0test0compatible0key00000000";
    const missing = await s.request("POST", "/api/keys", { template: "openai-compatible", key });
    expect(missing.body.error).toContain("服务地址");

    const added = await s.post<{ provider: string; label: string }>("/api/keys", { template: "openai-compatible", key, baseUrl: `${fake.url}/`, label: "公司网关" });
    expect(added.provider).toMatch(/^custom-/);
    expect(fake.seen[0]).toMatchObject({ path: "/v1/models", auth: `Bearer ${key}` });
    const route = (await s.get<{ routes: Route[] }>("/api/models")).routes.find((r) => r.provider === added.provider)!;
    expect(route).toMatchObject({ label: "公司网关" });
    expect(route.models.map((m) => m.id)).toEqual(["qwen-max", "qwen-plus"]);

    const created = await s.post<Thread>("/api/threads", { task: "你好", source: "key", provider: added.provider, model: "qwen-max" });
    const t = await s.settled(created.id);
    expect(t.runs[0]).toMatchObject({ status: "succeeded", source: "key", provider: added.provider, model: "qwen-max", family: "qwen" });
    expect(t.runs[0]!.agentName).toBe("qwen-max · 公司网关");
    expect(t.runs[0]!.context).toMatchObject({ window: 128_000 });
    expect(t.runs[0]!.context!.tokens).toBeGreaterThan(1000);
    expect(t.items.some((i) => i.kind === "text" && i.text.includes("来自兼容服务的回复"))).toBe(true);
    const chat = fake.seen.find((r) => r.path === "/v1/chat/completions")!;
    expect(chat).toMatchObject({ auth: `Bearer ${key}`, body: expect.objectContaining({ model: "qwen-max" }) });
    expect(s.responses.join("\n")).not.toContain(key);

    const unreachable = await s.request("POST", "/api/keys", { template: "openai-compatible", key, baseUrl: "http://127.0.0.1:9/v1" });
    expect(unreachable.status).toBe(400);
    expect(unreachable.body.error).toContain("连不上");
    expect(unreachable.body.error).not.toContain(key);
    const typed = await s.post<{ provider: string }>("/api/keys", { template: "openai-compatible", key, baseUrl: "http://127.0.0.1:9/v1", models: ["my-model"] });
    const typedRoute = (await s.get<{ routes: Route[] }>("/api/models")).routes.find((r) => r.provider === typed.provider)!;
    expect(typedRoute.models.map((m) => m.id)).toEqual(["my-model"]);
  });

  it("turns a DeepSeek key saved before any key could be added into an account, and old DeepSeek chats with it", async () => {
    const first = await testServer();
    await first.post("/api/auth/deepseek", { key: "sk-baton0test0secret0key0123456789" });
    fs.rmSync(path.join(first.home, "keys.json"));
    const threadFile = path.join(first.root, ".baton/threads/th_old.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      threadFile,
      JSON.stringify({
        id: "th_old",
        title: "旧 DeepSeek 对话",
        status: "idle",
        createdAt: now,
        updatedAt: now,
        summary: "",
        access: "read",
        notes: [],
        items: [],
        model: { source: "deepseek", model: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        runs: [],
      }),
    );

    const s = await testServer({ reuse: { home: first.home, root: first.root } });
    expect((await s.get("/api/state")).auth.keys).toEqual([expect.objectContaining({ template: "deepseek", provider: "deepseek", configured: true })]);
    expect((await s.thread("th_old")).model).toEqual({ source: "key", provider: "deepseek", account: "DeepSeek", model: "deepseek-v4-pro", name: "DeepSeek V4 Pro" });
  });
});
