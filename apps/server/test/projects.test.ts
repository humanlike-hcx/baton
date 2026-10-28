import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Thread } from "@baton/core";
import { CURSOR_COMPOSER, tempDir, testServer } from "./helpers.ts";

interface Project {
  root: string;
  demo: boolean;
  threads: { id: string }[];
}

const pendingApproval = (t: Thread) => t.items.find((i) => i.kind === "approval" && i.status === "pending");

describe("HTTP API: the system folder dialog (US-97)", () => {
  it("returns the chosen directory, a cancellation, and refuses a second dialog while one is open", async () => {
    const chosen = fs.realpathSync(tempDir("baton-picked-"));
    const s = await testServer({ pickDirectory: async () => `${chosen}/` });
    expect(await s.post("/api/workspace/pick")).toEqual({ path: chosen });

    const cancelled = await testServer({ pickDirectory: async () => undefined });
    expect(await cancelled.post("/api/workspace/pick")).toEqual({ cancelled: true });

    let release: (path: string) => void = () => {};
    let opened: () => void = () => {};
    const dialogOpen = new Promise<void>((resolve) => (opened = resolve));
    const held = await testServer({
      pickDirectory: () => {
        opened();
        return new Promise<string>((resolve) => (release = resolve));
      },
    });
    const first = held.request("POST", "/api/workspace/pick");
    await dialogOpen;
    const second = await held.request("POST", "/api/workspace/pick");
    expect(second.status).toBe(400);
    expect(second.body.error).toContain("已经有一个文件夹选择框开着");
    release(chosen);
    expect((await first).body).toEqual({ path: chosen });

    const broken = await testServer({ pickDirectory: async () => Promise.reject(new Error("文件夹选择框没有打开，请手填目录路径")) });
    const failed = await broken.request("POST", "/api/workspace/pick");
    expect(failed.status).toBe(400);
    expect(failed.body.error).toContain("手填目录路径");
  });
});

describe("HTTP API: one chat, one project (US-96)", () => {
  it("keeps a chat in another project running, answerable and on its own files while a different project is current", async () => {
    const s = await testServer({ autoApprove: false });
    const demoRoot = fs.realpathSync(s.root);
    const a = await s.chat("写文件：notes/busy.md", { access: "ask" });
    await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "write approval");

    const other = fs.realpathSync(tempDir("baton-project-"));
    await s.post("/api/workspace/open", { path: other });
    const state = await s.get<{ workspace: { root: string }; projects: Project[] }>("/api/state");
    expect(state.workspace.root).toBe(other);
    expect(state.projects.map((p) => p.root)).toEqual([other, demoRoot]);
    expect(state.projects[1]!.threads.map((t) => t.id)).toEqual([a.id]);
    expect(state.projects[0]!.threads).toEqual([]);
    expect(await s.get("/api/threads")).toEqual([]);

    // The demo chat asks twice (the write, then `node --version`); both are answered while the other project is current.
    for (let answered = 0; answered < 2; ) {
      const approval = pendingApproval(await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "approval"));
      if (approval?.kind !== "approval") continue;
      await s.post(`/api/approvals/${approval.approvalId}`, { allow: true });
      answered++;
    }
    const done = await s.settled(a.id);
    expect(done.runs.at(-1)!.status).toBe("succeeded");
    expect(fs.existsSync(path.join(demoRoot, "notes/busy.md"))).toBe(true);
    expect(fs.existsSync(path.join(other, "notes/busy.md"))).toBe(false);

    // The demo models stay usable for the demo project's chat, but not for a new chat in a real project.
    const again = await s.say(a.id, "再聊一句");
    expect(again.runs.at(-1)).toMatchObject({ status: "succeeded", model: "demo-chat" });
    expect((await s.request("POST", "/api/threads", { task: "hi", source: "demo", model: "demo-chat" })).status).toBe(400);
    const demoHere = await s.request("POST", "/api/threads", { task: "hi", source: "demo", model: "demo-chat", workspace: demoRoot });
    expect(demoHere.status).toBe(200);

    const b = await s.post<Thread>("/api/threads", { task: "看看 notes 目录", ...CURSOR_COMPOSER, workspace: other });
    await s.settled(b.id);
    const after = await s.get<{ projects: Project[] }>("/api/state");
    expect(after.projects[0]!.threads.map((t) => t.id)).toEqual([b.id]);
    expect(after.projects[1]!.threads.map((t) => t.id)).not.toContain(b.id);
    expect(s.events.some((e) => e.type === "thread" && (e.thread as Thread).id === b.id && e.workspace === other)).toBe(true);
    expect(s.events.some((e) => e.type === "thread" && (e.thread as Thread).id === a.id && e.workspace === demoRoot)).toBe(true);

    const notOpen = await s.request("POST", "/api/threads", { task: "hi", ...CURSOR_COMPOSER, workspace: tempDir("baton-closed-") });
    expect(notOpen.status).toBe(400);
  });

  it("removes a project from the list without touching its files, and refuses while it has a reply in progress", async () => {
    const s = await testServer({ autoApprove: false });
    const first = fs.realpathSync(s.root);
    const a = await s.chat("写文件：notes/busy.md", { access: "ask" });
    await s.waitForThread(a.id, (t) => Boolean(pendingApproval(t)), "write approval");
    const second = fs.realpathSync(tempDir("baton-project-"));
    await s.post("/api/workspace/open", { path: second });

    const busy = await s.request("POST", "/api/workspace/close", { path: first });
    expect(busy.status).toBe(400);
    expect(busy.body.error).toContain("先取消再移除");

    await s.post(`/api/threads/${a.id}/cancel`);
    await s.settled(a.id);
    await s.post("/api/workspace/close", { path: first });
    const state = await s.get<{ projects: Project[] }>("/api/state");
    expect(state.projects.map((p) => p.root)).toEqual([second]);
    expect((await s.request("GET", `/api/threads/${a.id}`)).status).toBe(404);
    expect(fs.existsSync(path.join(first, ".baton/threads", `${a.id}.json`))).toBe(true);

    const last = await s.request("POST", "/api/workspace/close", { path: second });
    expect(last.status).toBe(400);
    expect(last.body.error).toContain("至少要留一个项目");

    await s.post("/api/workspace/open", { path: first });
    expect((await s.thread(a.id)).id).toBe(a.id);
    await s.post("/api/workspace/close", { path: first });
    expect((await s.get("/api/state")).workspace.root).toBe(second);
  });

  it("checks Cursor sign-in and models against each project's own CLI command", async () => {
    const s = await testServer();
    const other = fs.realpathSync(tempDir("baton-project-"));
    await s.post("/api/workspace/open", { path: other });
    const b = await s.post<Thread>("/api/threads", { task: "你好", ...CURSOR_COMPOSER });
    await s.settled(b.id);

    await s.post("/api/workspace/open", { path: s.root });
    const settings = await s.get("/api/settings");
    await s.put("/api/settings", { ...settings, cursor: { command: path.join(tempDir("baton-no-cli-"), "agent") } });
    expect((await s.get("/api/state")).auth.cursor.installed).toBe(false);
    expect((await s.request("POST", "/api/threads", { task: "hi", ...CURSOR_COMPOSER })).status).toBe(400);

    const again = await s.say(b.id, "再看看");
    expect(again.runs.at(-1)).toMatchObject({ status: "succeeded", model: "composer-2.5" });
  });

  it("reopens every project in the list after a restart, with its chats", async () => {
    const s = await testServer();
    const other = fs.realpathSync(tempDir("baton-project-"));
    await s.post("/api/workspace/open", { path: other });
    const b = await s.post<Thread>("/api/threads", { task: "你好", ...CURSOR_COMPOSER });
    await s.settled(b.id);

    const restarted = await testServer({ reuse: { home: s.home, root: s.root } });
    const state = await restarted.get<{ workspace: { root: string }; projects: Project[] }>("/api/state");
    expect(state.workspace.root).toBe(fs.realpathSync(s.root));
    expect(state.projects.map((p) => p.root)).toEqual([other, fs.realpathSync(s.root)]);
    expect(state.projects[0]!.threads.map((t) => t.id)).toEqual([b.id]);
    expect((await restarted.thread(b.id)).runs).toHaveLength(1);
  });
});
