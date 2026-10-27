import fs from "node:fs";
import path from "node:path";
import type { Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { startServer } from "../src/serve.ts";
import { WEB_DIST } from "../src/state.ts";
import { HOST, testServer } from "./helpers.ts";

type Approval = Extract<TimelineItem, { kind: "approval" }>;
const pendingApproval = (t: Thread) => t.items.find((i): i is Approval => i.kind === "approval" && i.status === "pending");

describe("the service the web version and the desktop app share (US-86, US-87)", () => {
  it("serves the API and live events on 127.0.0.1, and stopping it cancels runs and saves them", async () => {
    const s = await testServer({ autoApprove: false });
    const server = await startServer(s.state, 0);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${server.url}/api/state`, { headers: { "x-baton": "1" } });
    expect(res.status).toBe(200);
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`);
    const hello = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("websocket failed"));
    });
    expect(JSON.parse(hello)).toEqual({ type: "hello" });

    const a = await s.chat("写文件：notes/close.md", { access: "ask" });
    const approvalId = pendingApproval(await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "write approval"))!.approvalId;

    const closed = new Promise((resolve) => (ws.onclose = resolve));
    await server.close();
    await closed;
    await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();

    const restarted = await testServer({ reuse: { home: s.home, root: s.root } });
    const t = await restarted.thread(a.id);
    // A crash would leave this to restart recovery, which expires the approval and says so.
    expect(t.runs[0]!.status).toBe("cancelled");
    expect(t.status).toBe("idle");
    expect(t.items.find((i) => i.kind === "approval" && i.approvalId === approvalId)).toMatchObject({ status: "denied" });
    expect(t.items.some((i) => i.kind === "notice" && i.text.includes("上一次回复被中断"))).toBe(false);
  });
});

describe("the web app in production mode (US-84)", () => {
  it.skipIf(!fs.existsSync(path.join(WEB_DIST, "index.html")))("never lets the browser keep an index.html that names a previous build's bundle", async () => {
    const s = await testServer();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const app = createApp(s.state);
    process.env.NODE_ENV = previous;
    const page = await app.request("/", { headers: { host: HOST } });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const bundle = /assets\/[^"]+\.js/.exec(await page.text())![0];
    const asset = await app.request(`/${bundle}`, { headers: { host: HOST } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBeNull();
    expect((await app.request("/threads/x", { headers: { host: HOST } })).headers.get("cache-control")).toBe("no-cache");
  });
});
