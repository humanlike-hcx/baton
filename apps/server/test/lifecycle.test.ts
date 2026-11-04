import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AppState } from "../src/state.ts";
import { fixture, answer, call, until } from "./helpers.ts";
const cleanup: (() => Promise<void>)[] = []; afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });
async function setup(...args: Parameters<typeof fixture>) { const f = await fixture(...args); cleanup.push(() => f.close()); return f; }
const write = (file: string) => answer(call("write", { path: file, content: "new" }), { stopReason: "toolUse" });
it("queues a second project writer, runs a different project, and keeps approvals attached to their thread", async () => {
  const f = await setup([write("first.txt"), answer("other project"), answer("first done"), write("second.txt"), answer("second done")]);
  const second = (await f.request("/api/threads", "POST", { projectId: f.project.id, model: { id: "a" } })).data;
  const otherRoot = path.join(f.root, "other"); fs.mkdirSync(otherRoot);
  const project = (await f.request("/api/projects", "POST", { path: otherRoot })).data;
  const other = (await f.request("/api/threads", "POST", { projectId: project.id, model: { id: "a" } })).data;
  await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "first" });
  await until(() => f.state.thread(f.thread.id).items.some(i => i.kind === "approval"));
  await f.request(`/api/threads/${second.id}`, "PATCH", { access: "allow" });
  await f.request(`/api/threads/${second.id}/messages`, "POST", { text: "second" });
  expect(f.state.thread(second.id).status).toBe("queued");
  await f.request(`/api/threads/${other.id}/messages`, "POST", { text: "other" }); await f.state.wait(other.id);
  expect(f.state.thread(other.id).runs[0].status).toBe("succeeded");
  expect(f.state.thread(second.id).status).toBe("queued");
  const approval = f.state.thread(f.thread.id).items.find(i => i.kind === "approval")!;
  await f.request(`/api/approvals/${approval.approvalId}`, "POST", { allow: true });
  await f.state.wait(f.thread.id); await f.state.wait(second.id);
  expect(fs.existsSync(path.join(f.projectRoot, "first.txt"))).toBe(true); expect(fs.existsSync(path.join(f.projectRoot, "second.txt"))).toBe(true);
  expect(fs.existsSync(path.join(otherRoot, "first.txt"))).toBe(false);
});
it("preserves later edits and invalidates a stale restore preview", async () => {
  const f = await setup([write("a.txt"), answer("done")]);
  fs.writeFileSync(path.join(f.projectRoot, "a.txt"), "original");
  await f.request(`/api/threads/${f.thread.id}`, "PATCH", { access: "allow" });
  const run = (await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "edit" })).data; await f.state.wait(f.thread.id);
  const preview = (await f.request(`/api/runs/${run.id}/changes`)).data;
  fs.writeFileSync(path.join(f.projectRoot, "a.txt"), "later work");
  expect((await f.request(`/api/runs/${run.id}/restore`, "POST", { token: preview.token })).status).toBe(400);
  expect(fs.readFileSync(path.join(f.projectRoot, "a.txt"), "utf8")).toBe("later work");
});
it("keeps new data isolated, lets users explicitly import Markdown, and reads updated project memory only", async () => {
  const f = await setup();
  const legacy = path.join(f.home, "auth.json"); fs.writeFileSync(legacy, '{"legacy":"leave intact"}');
  fs.mkdirSync(path.join(f.projectRoot, ".baton")); fs.writeFileSync(path.join(f.projectRoot, ".baton/old.md"), "legacy memory");
  await f.request(`/api/threads/${f.thread.id}`, "PATCH", { access: "allow" });
  const source = path.join(f.projectRoot, ".baton/old.md");
  const preview = (await f.request(`/api/projects/${f.project.id}/import/preview`, "POST", { source, name: "imported.md", kind: "memory" })).data;
  await f.request(`/api/threads/${f.thread.id}/import`, "POST", { source, name: "imported.md", kind: "memory", token: preview.token }); await f.state.wait(f.thread.id);
  expect((await f.request(`/api/projects/${f.project.id}/memory`)).data).toEqual([{ name: "imported.md", content: "legacy memory" }]);
  await f.request(`/api/threads/${f.thread.id}/memory`, "POST", { name: "imported.md", content: "current" }); await f.state.wait(f.thread.id);
  expect((await f.request(`/api/projects/${f.project.id}/memory`)).data[0].content).toBe("current");
  await f.request(`/api/threads/${f.thread.id}/memory`, "POST", { name: "imported.md" }); await f.state.wait(f.thread.id);
  expect((await f.request(`/api/projects/${f.project.id}/memory`)).data).toEqual([]);
  await f.restart(); expect(fs.readFileSync(legacy, "utf8")).toContain("leave intact"); expect(fs.readFileSync(source, "utf8")).toBe("legacy memory");
});
it("does not load unapproved resources; enabled rules and Skills enter Pi's system context", async () => {
  const f = await setup([(ctx) => { expect(JSON.stringify(ctx.messages)).not.toContain("PRIVATE_RULE_42"); return answer("before"); }, (ctx) => { expect(JSON.stringify(ctx.messages)).toContain("PRIVATE_RULE_42"); expect(JSON.stringify(ctx.messages)).toContain("fixture-skill"); return answer("after"); }]);
  fs.writeFileSync(path.join(f.projectRoot, "AGENTS.md"), "PRIVATE_RULE_42");
  fs.mkdirSync(path.join(f.projectRoot, ".baton-v2/skills/fixture"), { recursive: true });
  fs.writeFileSync(path.join(f.projectRoot, ".baton-v2/skills/fixture/SKILL.md"), "---\nname: fixture-skill\ndescription: Demonstrate a fixture skill.\n---\nExplain first.");
  const resources = (await f.request(`/api/projects/${f.project.id}/resources`)).data;
  expect(resources.every((r: any) => !r.enabled)).toBe(true);
  await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "before enabling" }); await f.state.wait(f.thread.id);
  for (const r of resources) expect((await f.request(`/api/projects/${f.project.id}/resources`, "PUT", { id: r.id, enabled: true })).status).toBe(200);
  await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "after enabling" }); await f.state.wait(f.thread.id);
  expect(f.state.thread(f.thread.id).runs.every(r => r.status === "succeeded")).toBe(true);
});
it("keeps history on compaction failure and records interrupted runs after an unclean restart", async () => {
  const f = await setup([answer("A long conversation constraint must survive"), answer("recent turn"), answer("", { stopReason: "error", errorMessage: "compaction offline" })]);
  await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "keep this context" }); await f.state.wait(f.thread.id);
  await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "keep the constraint and continue\n" + "reference entry with no actionable content\n".repeat(1200) }); await f.state.wait(f.thread.id);
  const file = f.state.thread(f.thread.id).sessionFile!, original = fs.readFileSync(file, "utf8");
  await f.request(`/api/threads/${f.thread.id}/compact`, "POST", {}); await f.state.wait(f.thread.id);
  expect(f.state.thread(f.thread.id).runs.at(-1)?.status).toBe("failed");
  expect(f.state.thread(f.thread.id).runs.at(-1)?.error).toContain("compaction offline");
  expect(fs.readFileSync(file, "utf8")).toContain("keep this context"); expect(original).toContain("keep this context");
  f.state.thread(f.thread.id).runs.at(-1)!.status = "running"; f.state.save(); await f.restart();
  expect(f.state.thread(f.thread.id).runs.at(-1)?.status).toBe("interrupted");
});
it("blocks cross-site requests and rejects the removed vendor and review routes", async () => {
  const f = await setup();
  expect((await f.request("/api/state", "GET", undefined, { origin: "https://attacker.test" })).status).toBe(403);
  expect((await f.request("/api/state", "GET", undefined, { host: "attacker.test" })).status).toBe(403);
  expect((await f.request("/api/auth", "GET")).status).toBe(404);
  expect((await f.request(`/api/threads/${f.thread.id}/review`, "POST", {})).status).toBe(404);
});

it("does not silently recreate a missing persisted Pi conversation", async () => {
  const f = await setup([answer("preserved history"), answer("must not run")]);
  await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "first turn" }); await f.state.wait(f.thread.id);
  const file = f.state.thread(f.thread.id).sessionFile!; fs.unlinkSync(file);
  await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "continue" }); await f.state.wait(f.thread.id);
  expect(f.state.thread(f.thread.id).runs.at(-1)?.status).toBe("failed");
  expect(f.state.thread(f.thread.id).runs.at(-1)?.error).toContain("会话文件缺失");
  expect(f.faux.getPendingResponseCount()).toBe(1);
});
it("delivers steering before a queued follow-up within one persistent run", async () => {
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup([async () => { entered = true; await gate; return answer("initial response"); }, ctx => {
    expect(JSON.stringify(ctx.messages)).toContain("steer-now");
    expect(JSON.stringify(ctx.messages)).not.toContain("follow-later");
    return answer("steering applied");
  }, ctx => { expect(JSON.stringify(ctx.messages)).toContain("follow-later"); return answer("follow up completed"); }]);
  await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "start" }); await until(() => entered);
  try {
    expect((await f.request(`/api/threads/${f.thread.id}/inject`, "POST", { text: "steer-now", mode: "steer" })).status).toBe(200);
    expect((await f.request(`/api/threads/${f.thread.id}/inject`, "POST", { text: "follow-later", mode: "followUp" })).status).toBe(200);
  } finally { release(); }
  await f.state.wait(f.thread.id);
  const t = f.state.thread(f.thread.id);
  expect(t.runs).toHaveLength(1); expect(t.runs[0].status).toBe("succeeded"); expect(t.pending).toEqual([]);
  expect(t.items.filter(i => i.kind === "user").map(i => i.text)).toEqual(["start", "steer-now", "follow-later"]);
});
it("keeps shell edits visible but refuses automatic restoration when authorship cannot be established", async () => {
  const f = await setup([answer(call(process.platform === "win32" ? "powershell" : "bash", { command: process.platform === "win32" ? "Set-Content shell.txt changed" : "printf changed > shell.txt" }), { stopReason: "toolUse" }), answer("done")]);
  await f.request(`/api/threads/${f.thread.id}`, "PATCH", { access: "allow" });
  const run = (await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "change via shell" })).data;
  await f.state.wait(f.thread.id);
  expect(f.state.thread(f.thread.id).runs[0].changedFiles).toContain("shell.txt");
  const preview = (await f.request(`/api/runs/${run.id}/changes`)).data;
  expect(preview.blocked).toContain("归属");
  expect((await f.request(`/api/runs/${run.id}/restore`, "POST", { token: preview.token })).status).toBe(400);
});

it("refuses another process owner before touching persisted sessions", async () => {
  const f = await setup([answer("saved")]);
  await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "persist me" }); await f.state.wait(f.thread.id);
  const before = fs.readFileSync(path.join(f.home, "v2/state.json"), "utf8");
  const second = new AppState({ home: f.home });
  await expect(second.init()).rejects.toThrow("另一个进程");
  expect(fs.readFileSync(path.join(f.home, "v2/state.json"), "utf8")).toBe(before);
});
