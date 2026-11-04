import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixture, answer, call, until } from "./helpers.ts";
const cleanup: (() => Promise<void>)[] = []; afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });
async function setup(...args: Parameters<typeof fixture>) { const f = await fixture(...args); cleanup.push(() => f.close()); return f; }
const tool = (name: string, args: Parameters<typeof call>[1]) => answer(call(name, args), { stopReason: "toolUse" });
describe("Pi conversation through the HTTP API", () => {
  it("executes Pi file tools, records only this run, preserves dirty files and restores after preview", async () => {
    const f = await setup([tool("read", { path: "a.txt" }), tool("write", { path: "a.txt", content: "agent change" }), tool(process.platform === "win32" ? "powershell" : "bash", { command: process.platform === "win32" ? 'Write-Output "tested"' : 'printf tested' }), answer("done")]);
    fs.writeFileSync(path.join(f.projectRoot, "a.txt"), "user dirty baseline"); fs.writeFileSync(path.join(f.projectRoot, "untouched.txt"), "user work");
    await f.request(`/api/threads/${f.thread.id}`, "PATCH", { access: "allow" });
    const start = await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "edit and test" }); expect(start.status).toBe(202);
    await f.state.wait(f.thread.id);
    const t = (await f.request(`/api/threads/${f.thread.id}`)).data;
    expect(t.runs[0].status, JSON.stringify(t)).toBe("succeeded");
    expect(t.runs[0].changedFiles).toEqual(["a.txt"]);
    expect(t.items.some((i: any) => i.kind === "tool" && i.text.includes("退出码: 0"))).toBe(true);
    expect(fs.readFileSync(path.join(f.projectRoot, "a.txt"), "utf8")).toBe("agent change");
    const preview = await f.request(`/api/runs/${start.data.id}/changes`); expect(preview.data.changes[0].before).toBe("user dirty baseline");
    expect((await f.request(`/api/runs/${start.data.id}/restore`, "POST", { token: preview.data.token })).status).toBe(200);
    expect(fs.readFileSync(path.join(f.projectRoot, "a.txt"), "utf8")).toBe("user dirty baseline");
    expect(fs.readFileSync(path.join(f.projectRoot, "untouched.txt"), "utf8")).toBe("user work");
  });
  it("keeps a continuous Pi session across model switching and service restart", async () => {
    const f = await setup([answer("Remember constraint ORANGE."), (ctx) => { expect(JSON.stringify(ctx.messages)).toContain("ORANGE"); return answer("continued"); }]);
    await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "ORANGE is the constraint" }); await f.state.wait(f.thread.id);
    const file = f.state.thread(f.thread.id).sessionFile!; expect(fs.existsSync(file)).toBe(true);
    await f.request(`/api/threads/${f.thread.id}`, "PATCH", { access: "allow" });
    await f.restart(); expect(f.state.thread(f.thread.id).access).toBe("ask");
    await f.request(`/api/threads/${f.thread.id}`, "PATCH", { model: { id: "b" } });
    await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "continue" }); await f.state.wait(f.thread.id);
    expect(f.state.thread(f.thread.id).sessionFile).toBe(file);
    expect(f.state.thread(f.thread.id).runs[1].status).toBe("succeeded");
    expect(fs.readFileSync(file, "utf8")).toContain("continued");
  });
  it("denies a write and rejects duplicate approvals", async () => {
    const f = await setup([tool("write", { path: "deny.txt", content: "must not exist" }), answer("denied")]);
    await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "write" });
    await until(() => f.state.thread(f.thread.id).items.some(i => i.kind === "approval"));
    const item = f.state.thread(f.thread.id).items.find(i => i.kind === "approval")!;
    expect(item.text).toContain("must not exist");
    expect((await f.request(`/api/approvals/${item.approvalId}`, "POST", { allow: false })).status).toBe(200);
    expect((await f.request(`/api/approvals/${item.approvalId}`, "POST", { allow: true })).status).toBe(400);
    await f.state.wait(f.thread.id); expect(fs.existsSync(path.join(f.projectRoot, "deny.txt"))).toBe(false);
  });
  it("cancels an outstanding approval and never runs the approved operation later", async () => {
    const f = await setup([tool("write", { path: "cancel.txt", content: "no" }), answer("end")]);
    await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "write" });
    await until(() => f.state.thread(f.thread.id).items.some(i => i.kind === "approval"));
    const item = f.state.thread(f.thread.id).items.find(i => i.kind === "approval")!;
    await f.request(`/api/threads/${f.thread.id}/cancel`, "POST", {}); await f.state.wait(f.thread.id);
    expect(f.state.thread(f.thread.id).runs[0].status).toBe("cancelled");
    expect((await f.request(`/api/approvals/${item.approvalId}`, "POST", { allow: true })).status).toBe(400);
    expect(fs.existsSync(path.join(f.projectRoot, "cancel.txt"))).toBe(false);
  });
  it("rejects stale file approval and refuses rollback over a later edit", async () => {
    const f = await setup([tool("write", { path: "a.txt", content: "agent" }), answer("end")]);
    fs.writeFileSync(path.join(f.projectRoot, "a.txt"), "before");
    const run = await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "write" });
    await until(() => f.state.thread(f.thread.id).items.some(i => i.kind === "approval"));
    fs.writeFileSync(path.join(f.projectRoot, "a.txt"), "external");
    const approval = f.state.thread(f.thread.id).items.find(i => i.kind === "approval")!;
    await f.request(`/api/approvals/${approval.approvalId}`, "POST", { allow: true }); await f.state.wait(f.thread.id);
    expect(fs.readFileSync(path.join(f.projectRoot, "a.txt"), "utf8")).toBe("external");
    const preview = await f.request(`/api/runs/${run.data.id}/changes`); expect(preview.data.blocked).toBeTruthy();
    expect((await f.request(`/api/runs/${run.data.id}/restore`, "POST", { token: preview.data.token })).status).toBe(400);
  });
  it("read-only never exposes shell or write tools, and realpath blocks external symlinks", async () => {
    const f = await setup([tool("read", { path: "outside.txt" }), answer("denied")]);
    const outside = path.join(f.root, "outside.txt"); fs.writeFileSync(outside, "secret outside"); fs.symlinkSync(outside, path.join(f.projectRoot, "outside.txt"));
    await f.request(`/api/threads/${f.thread.id}`, "PATCH", { access: "read" });
    await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "read symlink" }); await f.state.wait(f.thread.id);
    expect(JSON.stringify(f.state.thread(f.thread.id).items)).not.toContain("secret outside");
    expect(JSON.stringify(f.state.thread(f.thread.id).items)).toContain("范围");
  });
  it("keeps a nonzero command exit visible even when output is truncated", async () => {
    const f = await setup([tool(process.platform === "win32" ? "powershell" : "bash", { command: process.platform === "win32" ? 'Write-Output ("x" * 30000); exit 7' : "printf '%030000d' 0; exit 7" }), answer("test failed")]);
    await f.request(`/api/threads/${f.thread.id}`, "PATCH", { access: "allow" });
    await f.request(`/api/threads/${f.thread.id}/messages`, "POST", { text: "test" }); await f.state.wait(f.thread.id);
    const item = f.state.thread(f.thread.id).items.find(i => i.kind === "tool")!;
    expect(item.status).toBe("error"); expect(item.text).toContain("退出码: 7"); expect(item.text).toContain("截断");
  });
});
