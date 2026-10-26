import type { Thread, TimelineItem } from "@baton/core";
import { describe, expect, it } from "vitest";
import { startServer } from "../src/serve.ts";
import { testServer } from "./helpers.ts";

type Approval = Extract<TimelineItem, { kind: "approval" }>;
const pendingApproval = (t: Thread) => t.items.find((i): i is Approval => i.kind === "approval" && i.status === "pending");

describe("the service the web version and the desktop app share (US-86, US-87)", () => {
  it("serves the API and live events on 127.0.0.1, and stopping it cancels runs and saves them", async () => {
    const s = await testServer({ autoApprove: false, settings: (st) => (st.confirm.planToImplement = false) });
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

    const a = await s.post("/api/threads", { title: "关窗口", task: "写一份说明", acceptance: ["有说明"], stage: "implement" });
    const approvalId = pendingApproval(await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "command approval"))!.approvalId;

    const closed = new Promise((resolve) => (ws.onclose = resolve));
    await server.close();
    await closed;
    await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();

    const restarted = await testServer({ reuse: { home: s.home, root: s.root } });
    const t = await restarted.thread(a.id);
    // A crash would leave this to restart recovery, which expires the approval and says so.
    expect(t.runs[0]!.status).toBe("cancelled");
    expect(t.status).toBe("paused");
    expect(t.items.find((i) => i.kind === "approval" && i.approvalId === approvalId)).toMatchObject({ status: "denied" });
    expect(t.items.some((i) => i.kind === "notice" && i.text.startsWith("工作台重启"))).toBe(false);
  });
});
