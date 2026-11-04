import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fixture, answer, call, until } from "./helpers.ts";

it("creates a conversation with its first message and rejects invalid drafts without empty records", async () => {
  const f = await fixture([answer("First reply")]);
  try {
    const count = f.state.view().threads.length;
    expect((await f.request("/api/threads/start", "POST", { text: "  ", model: { id: "a" } })).status).toBe(400);
    expect((await f.request("/api/threads/start", "POST", { text: "hello" })).status).toBe(400);
    expect(f.state.view().threads).toHaveLength(count);
    const started = await f.request("/api/threads/start", "POST", { text: "hello", model: { id: "a" } });
    expect(started.status).toBe(202);
    await f.state.wait(started.data.id);
    expect(f.state.view().threads).toHaveLength(count + 1);
    expect(f.state.thread(started.data.id).items.some(i => i.kind === "user" && i.text === "hello")).toBe(true);
    expect(f.state.thread(started.data.id).runs[0].status).toBe("succeeded");
  } finally { await f.close(); }
});

it("persists a project-free chat without exposing project tools or resources", async () => {
  const f = await fixture([
    ctx => { expect(getCurrentTools(ctx.messages)).toHaveLength(0); expect(JSON.stringify(ctx.messages)).not.toContain("PROJECT_ONLY_SECRET"); return answer("Remember CHAT_ORANGE."); },
    ctx => { expect(getCurrentTools(ctx.messages)).toHaveLength(0); expect(JSON.stringify(ctx.messages)).toContain("CHAT_ORANGE"); return answer("Conversation continued."); },
  ]);
  try {
    const rule = path.join(f.projectRoot, "AGENTS.md");
    fs.writeFileSync(rule, "PROJECT_ONLY_SECRET");
    f.state.setResource(f.project.id, { path: rule, kind: "rule", enabled: true });
    const created = await f.request("/api/threads", "POST", { model: { id: "a" } });
    expect(created.status).toBe(200);
    const chat = created.data;
    expect(chat.projectId).toBeUndefined();
    expect((await f.request(`/api/threads/${chat.id}`, "PATCH", { access: "allow" })).status).toBe(400);
    expect((await f.request(`/api/threads/${chat.id}/memory`, "POST", { name: "not-allowed.md", content: "no" })).status).toBe(400);
    await f.request(`/api/threads/${chat.id}/messages`, "POST", { text: "CHAT_ORANGE" });
    await f.state.wait(chat.id);
    const session = f.state.thread(chat.id).sessionFile;
    expect(f.state.thread(chat.id).runs[0].status).toBe("succeeded");
    expect(f.state.thread(chat.id).runs[0].changedFiles).toEqual([]);
    await f.restart();
    await f.request(`/api/threads/${chat.id}/messages`, "POST", { text: "continue" });
    await f.state.wait(chat.id);
    expect(f.state.thread(chat.id).sessionFile).toBe(session);
    expect(f.state.thread(chat.id).runs[1].status).toBe("succeeded");
    expect(f.state.view().projects).toHaveLength(1);
  } finally { await f.close(); }
});

it("archives and restores a conversation across restart without changing project files", async () => {
  const f = await fixture([answer("Saved reply")]);
  try {
    const note = path.join(f.projectRoot, "note.txt"); fs.writeFileSync(note, "user content");
    await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "Remember me" });
    await f.state.wait(f.thread.id);
    const session = f.state.thread(f.thread.id).sessionFile;
    expect((await f.request(`/api/threads/${f.thread.id}/archive`, "POST")).status).toBe(200);
    expect(f.state.view().threads.some(t => t.id === f.thread.id)).toBe(false);
    expect((await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "stale request" })).status).toBe(400);
    expect(f.state.view().archivedThreads.some(t => t.id === f.thread.id)).toBe(true);
    await f.restart();
    expect(f.state.view().threads.some(t => t.id === f.thread.id)).toBe(false);
    const restored = await f.request(`/api/threads/${f.thread.id}/restore`, "POST");
    expect(restored.status).toBe(200);
    expect(f.state.view().archivedThreads).toHaveLength(0);
    expect(restored.data.sessionFile).toBe(session);
    expect(restored.data.items.some((i: { text: string }) => i.text === "Saved reply")).toBe(true);
    expect(fs.readFileSync(note, "utf8")).toBe("user content");
  } finally { await f.close(); }
});

it("refuses archiving an active conversation with an unresolved approval", async () => {
  const f = await fixture([answer([call("write", { path: "new.txt", content: "no" })])]);
  try {
    await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "write" });
    await until(() => f.state.thread(f.thread.id).items.some(i => i.kind === "approval" && i.status === "pending"));
    expect((await f.request(`/api/threads/${f.thread.id}/archive`, "POST")).status).toBe(400);
    expect(f.state.view().threads.some(t => t.id === f.thread.id)).toBe(true);
    await f.request(`/api/threads/${f.thread.id}/cancel`, "POST");
    expect((await f.request(`/api/threads/${f.thread.id}/archive`, "POST")).status).toBe(200);
    expect(fs.existsSync(path.join(f.projectRoot, "new.txt"))).toBe(false);
  } finally { await f.close(); }
});
