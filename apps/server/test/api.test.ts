import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowWebSocket } from "../src/app.ts";
import { isPrivateFile, testServer } from "./helpers.ts";

describe("HTTP API: local-only access", () => {
  it("refuses requests whose Host is not local", async () => {
    const s = await testServer();
    for (const host of ["evil.example.com", "192.168.1.5:47321", "127.0.0.1.nip.io"]) {
      const res = await s.request("GET", "/api/state", undefined, { host });
      expect(res.status).toBe(403);
    }
    expect((await s.request("GET", "/api/state", undefined, { host: "localhost:47320" })).status).toBe(200);
  });

  it("requires the X-Baton header on every write", async () => {
    const s = await testServer();
    const writes: [string, string, unknown][] = [
      ["POST", "/api/threads", { task: "t", source: "demo", model: "demo-chat" }],
      ["PUT", "/api/context", { content: "# x" }],
      ["POST", "/api/memory", { text: "一条不该写进去的记忆" }],
      ["POST", "/api/auth/deepseek", { key: "sk-abcdefghijklmnopqrstuvwxyz" }],
      ["PUT", "/api/settings", { name: "被改了" }],
    ];
    for (const [method, url, body] of writes) {
      const res = await s.request(method, url, body, { "x-baton": "" });
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect(await s.get("/api/threads")).toEqual([]);
    expect(await s.get("/api/memory")).toEqual([]);
    expect((await s.get("/api/settings")).name).not.toBe("被改了");
  });

  it("only upgrades local WebSocket connections on /ws", () => {
    expect(allowWebSocket({ url: "/ws", host: "127.0.0.1:47321", origin: "http://127.0.0.1:47320" })).toBe(true);
    expect(allowWebSocket({ url: "/ws", host: "localhost:47321" })).toBe(true);
    expect(allowWebSocket({ url: "/ws", host: "127.0.0.1:47321", origin: "https://evil.example.com" })).toBe(false);
    expect(allowWebSocket({ url: "/ws", host: "evil.example.com", origin: "http://127.0.0.1:47320" })).toBe(false);
    expect(allowWebSocket({ url: "/other", host: "127.0.0.1:47321" })).toBe(false);
  });
});

describe("HTTP API: credentials", () => {
  it("stores the DeepSeek key with mode 0600 and never returns it", async () => {
    const s = await testServer();
    const key = "sk-baton0test0secret0key0123456789";
    const bad = await s.request("POST", "/api/auth/deepseek", { key: "not-a-key" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("格式不对");

    await s.post("/api/auth/deepseek", { key });
    const state = await s.get("/api/state");
    expect(state.auth.keys).toEqual([expect.objectContaining({ template: "deepseek", label: "DeepSeek", provider: "deepseek", configured: true })]);
    const deepseek = (await s.get<{ routes: { source: string; provider?: string; unavailable?: string }[] }>("/api/models")).routes.find((r) => r.provider === "deepseek")!;
    expect(deepseek).toMatchObject({ source: "key" });
    expect(deepseek.unavailable).toBeUndefined();
    for (const url of ["/api/settings", "/api/threads", "/api/memory", "/api/context"]) await s.get(url);
    expect(s.responses.some((r) => r.includes(key))).toBe(false);

    const file = path.join(s.home, "credentials.json");
    expect(fs.readFileSync(file, "utf8")).toContain(key);
    expect(isPrivateFile(file)).toBe(true);

    await s.request("DELETE", "/api/auth/deepseek");
    expect((await s.get("/api/state")).auth.keys).toEqual([]);
  });

  it("drops OPENAI_API_KEY from the environment on start", async () => {
    process.env.OPENAI_API_KEY = "sk-should-never-be-used";
    const s = await testServer();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const state = await s.get("/api/state");
    expect(state.auth.chatgpt.loggedIn).toBe(false);
    const chatgpt = (await s.get<{ routes: { source: string; unavailable?: string }[] }>("/api/models")).routes.find((r) => r.source === "chatgpt")!;
    expect(chatgpt.unavailable).toContain("ChatGPT");
  });

  it("tightens an existing credentials file when the service starts", async () => {
    const s = await testServer({
      prepare: ({ home }) => fs.writeFileSync(path.join(home, "credentials.json"), "{}\n"),
    });
    expect(isPrivateFile(path.join(s.home, "credentials.json"))).toBe(true);
  });
});
