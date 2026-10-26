import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowWebSocket } from "../src/app.ts";
import { testServer } from "./helpers.ts";

describe("HTTP API: relay threads", () => {
  it("runs a demo relay thread from creation to done", async () => {
    const s = await testServer();
    const created = await s.post("/api/threads", { title: "写一份周报模板", task: "写一份周报模板", acceptance: ["包含本周进展和下周计划"] });

    let t = await s.settled(created.id);
    expect(t.pending?.kind).toBe("start_stage");
    await s.post(`/api/threads/${t.id}/decisions/${t.pending!.id}`, { approve: true });

    t = await s.settled(t.id);
    expect(t.runs.map((r) => r.stage)).toEqual(["plan", "implement", "review"]);
    expect(t.runs[2]!.family).not.toBe(t.runs[1]!.family);
    expect(t.pending?.kind).toBe("complete");
    const impl = t.runs[1]!;
    const { diff } = await s.get<{ diff: string }>(`/api/runs/${impl.id}/diff`);
    expect(diff).toContain(impl.changedFiles[0]);

    await s.post(`/api/threads/${t.id}/decisions/${t.pending!.id}`, { approve: true });
    t = await s.thread(t.id);
    expect(t.status).toBe("done");
    const list = await s.get<{ id: string; status: string }[]>("/api/threads");
    expect(list.find((x) => x.id === t.id)?.status).toBe("done");
  });

  it("rejects a relay thread without acceptance criteria", async () => {
    const s = await testServer();
    const res = await s.request("POST", "/api/threads", { title: "没有验收标准", task: "x", acceptance: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("验收标准");
  });
});

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
      ["POST", "/api/threads", { title: "t", task: "t", acceptance: ["a"] }],
      ["PUT", "/api/context", { content: "# x" }],
      ["POST", "/api/memory", { text: "一条不该写进去的记忆" }],
      ["POST", "/api/auth/deepseek", { key: "sk-abcdefghijklmnopqrstuvwxyz" }],
      ["DELETE", "/api/agents/demo-coder", undefined],
    ];
    for (const [method, url, body] of writes) {
      const res = await s.request(method, url, body, { "x-baton": "" });
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect(await s.get("/api/threads")).toEqual([]);
    expect(await s.get("/api/memory")).toEqual([]);
    expect((await s.get("/api/agents")).some((a: { id: string }) => a.id === "demo-coder")).toBe(true);
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
    expect(state.auth.deepseek.configured).toBe(true);
    expect(state.agents.find((a: { id: string }) => a.id === "coder-deepseek").available).toBe(true);
    for (const url of ["/api/settings", "/api/agents", "/api/threads", "/api/memory", "/api/context"]) await s.get(url);
    expect(s.responses.some((r) => r.includes(key))).toBe(false);

    const file = path.join(s.home, "credentials.json");
    expect(fs.readFileSync(file, "utf8")).toContain(key);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    await s.request("DELETE", "/api/auth/deepseek");
    expect((await s.get("/api/state")).auth.deepseek.configured).toBe(false);
  });

  it("drops OPENAI_API_KEY from the environment on start", async () => {
    process.env.OPENAI_API_KEY = "sk-should-never-be-used";
    const s = await testServer();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const state = await s.get("/api/state");
    expect(state.auth.chatgpt.loggedIn).toBe(false);
    expect(state.agents.find((a: { id: string }) => a.id === "planner-gpt").available).toBe(false);
  });
});
