import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Gateway, Snapshots, atomic, currentResources, discover, enableResource, errorText, hash, id, inside, memories, memoryPath, now, openPi, readJson, safePath,
  type Access, type AppView, type Item, type McpConfig, type ModelPick, type OpenPi, type PiHooks, type Project, type Resource, type Run, type Thread } from "@baton/core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { chooseDirectory, type DirectoryPicker } from "./picker.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
export const WEB_DIST = process.env.BATON_RESOURCES ? path.join(process.env.BATON_RESOURCES, "web") : path.join(REPO_ROOT, "apps/web/dist");
interface Data { projects: Project[]; threads: Thread[] }
interface Active { controller: AbortController; promise: Promise<void>; pi?: OpenPi; run: Run }
interface Approval { thread: Thread; item: Item; resolve(allow: boolean): void }
export interface AppStateOptions { baseUrl?: string; home?: string; pickDirectory?: DirectoryPicker; runtime?: () => Promise<ModelRuntime>; approvalTimeoutMs?: number }

export class AppState {
  readonly home: string;
  readonly gateway: Gateway;
  private data: Data;
  private lockToken?: string;
  private clients = new Set<(event: unknown) => void>();
  private active = new Map<string, Active>();
  private queues = new Map<string, Promise<void>>();
  private approvals = new Map<string, Approval>();
  private picking?: Promise<string | undefined>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  closing = false;
  constructor(private options: AppStateOptions = {}) {
    this.home = path.join(options.home ?? process.env.BATON_HOME ?? path.join(os.homedir(), ".baton"), "v2");
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.gateway = new Gateway(this.home, () => this.broadcast());
    this.data = { projects: [], threads: [] };
  }
  async init() {
    const file = path.join(this.home, "instance.lock");
    const token = id();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); this.lockToken = token; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = readJson<{ pid?: number }>(file, {});
        if (!owner.pid) throw new Error("Baton 数据目录的锁文件无效，请保留并排查，未修改会话");
        try { process.kill(owner.pid, 0); throw new Error("此 Baton 数据目录已经由另一个进程使用，请先退出它"); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
        fs.unlinkSync(file);
      }
    }
    if (!this.lockToken) throw new Error("无法取得 Baton 数据目录锁");
    try {
      this.data = readJson(path.join(this.home, "state.json"), { projects: [], threads: [] });
    for (const t of this.data.threads) {
      if (t.access === "allow") t.access = "ask";
      t.status = "idle";
      for (const run of t.runs) if (["running", "queued"].includes(run.status)) { run.status = "interrupted"; run.endedAt = now(); run.error = "应用退出前未完成；未自动重放命令"; }
      for (const item of t.items) if (item.kind === "approval" && item.status === "pending") item.status = "expired";
      if (t.pending.length) this.item(t, { kind: "notice", text: "上次未投递的插话仍保留，请确认后手动重新发送。" });
    }
    this.save();
    if (!this.options.runtime) this.gateway.start(() => !this.active.size);
    } catch (error) { this.releaseLock(); throw error; }
  }
  private releaseLock() {
    if (!this.lockToken) return;
    const file = path.join(this.home, "instance.lock");
    if (readJson<{ token?: string }>(file, {}).token === this.lockToken) fs.unlinkSync(file);
    this.lockToken = undefined;
  }
  view(): AppView { return { ...this.data, threads: this.data.threads.filter(t => !t.archivedAt), archivedThreads: this.data.threads.filter(t => t.archivedAt).map(({ id, projectId, title, archivedAt, updatedAt }) => ({ id, projectId, title, archivedAt, updatedAt })), gateway: this.gateway.public(), closing: this.closing }; }
  subscribe(fn: (event: unknown) => void) { this.clients.add(fn); return () => { this.clients.delete(fn); }; }
  broadcast(event: unknown = { type: "state" }) { for (const fn of this.clients) fn(event); }
  private changed() { this.broadcast(); if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 40); }
  save() { if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = undefined; atomic(path.join(this.home, "state.json"), JSON.stringify(this.data)); }
  private requireOpen() { if (this.closing) throw new Error("应用正在退出"); }
  project(pid?: string) { if (!pid) throw new Error("此操作需要先打开项目"); const p = this.data.projects.find(p => p.id === pid); if (!p || p.removed) throw new Error("项目不存在或已移除"); return p; }
  thread(tid: string) { const t = this.data.threads.find(t => t.id === tid); if (!t || t.archivedAt) throw new Error("对话不存在或已归档"); if (t.projectId) this.project(t.projectId); return t; }
  private context(thread: Thread): Project {
    if (thread.projectId) return this.project(thread.projectId);
    // Pi needs a cwd for session metadata; ordinary chats expose no filesystem tools.
    const root = path.join(this.home, "chats", thread.id);
    fs.mkdirSync(root, { recursive: true });
    return { id: `chat:${thread.id}`, root, name: "普通聊天", resources: [], mcp: [] };
  }
  private idleProject(pid: string) { if ([...this.active.values()].some(a => a.run.projectId === pid)) throw new Error("项目仍有运行或排队任务，请先停止后再操作"); }
  async pickDirectory() { if (this.picking) throw new Error("文件夹选择框已打开"); this.picking = (this.options.pickDirectory ?? chooseDirectory)(); try { return await this.picking; } finally { this.picking = undefined; } }
  openProject(root: string) {
    this.requireOpen(); root = fs.realpathSync(root.replace(/^~(?=$|[/\\])/, os.homedir()));
    if (!fs.statSync(root).isDirectory()) throw new Error("请选择项目文件夹");
    if (inside(root, this.home) || inside(this.home, root)) throw new Error("项目不能包含 Baton 数据目录");
    const existing = this.data.projects.find(p => p.root === root);
    if (existing) { existing.removed = false; this.save(); this.changed(); return existing; }
    const project: Project = { id: id(), root, name: path.basename(root), resources: [], mcp: [] };
    discover(project, path.join(this.home, "resources")); this.data.projects.push(project); this.save(); this.changed(); return project;
  }
  removeProject(pid: string) { this.idleProject(pid); this.project(pid).removed = true; this.save(); this.changed(); }
  createThread(pid?: string, model?: ModelPick) {
    this.requireOpen(); if (pid !== undefined) this.project(pid); if (model) model = this.gateway.normalize(model);
    const thread: Thread = { id: id(), projectId: pid, title: "新对话", access: pid ? "ask" : "read", model, status: "idle", createdAt: now(), updatedAt: now(), runs: [], items: [], pending: [] };
    this.data.threads.push(thread); this.save(); this.changed(); return thread;
  }
  archiveThread(tid: string) {
    this.requireOpen();
    const thread = this.thread(tid);
    if (this.active.has(tid)) throw new Error("请先停止这段对话的任务，再归档对话");
    thread.archivedAt = now(); this.save(); this.changed();
  }
  restoreThread(tid: string) {
    this.requireOpen();
    const thread = this.data.threads.find(t => t.id === tid);
    if (!thread) throw new Error("对话不存在");
    if (thread.projectId) this.project(thread.projectId);
    delete thread.archivedAt; this.save(); this.changed(); return thread;
  }
  startThread(input: { projectId?: string; model: ModelPick; access?: Access; text: string }) {
    if (!input.text.trim()) throw new Error("请输入消息");
    if (!input.model || typeof input.model.id !== "string") throw new Error("请选择已验证模型");
    this.gateway.normalize(input.model);
    const access = input.projectId ? input.access ?? "ask" : "read";
    if (!["read", "ask", "allow"].includes(access)) throw new Error("无效权限档位");
    const thread = this.createThread(input.projectId, input.model);
    thread.access = access;
    this.send(thread.id, input.text);
    return thread;
  }
  updateThread(tid: string, patch: { title?: string; access?: Access; model?: ModelPick }) {
    const thread = this.thread(tid); if (this.active.has(tid)) throw new Error("请在本次运行结束后切换模型或权限");
    if (patch.title !== undefined) thread.title = patch.title.slice(0, 120);
    if (patch.access) { if (!["read", "ask", "allow"].includes(patch.access)) throw new Error("无效权限档位"); if (!thread.projectId && patch.access !== "read") throw new Error("普通聊天不开放项目工具，请先打开项目"); thread.access = patch.access; }
    if (patch.model) { thread.model = this.gateway.normalize(patch.model); }
    this.save(); this.changed(); return thread;
  }
  configureGateway(input: { url: string; token?: string }) { if (this.active.size) throw new Error("运行结束后才能修改网关连接"); this.gateway.configure(input); this.changed(); return this.gateway.public(); }
  item(thread: Thread, value: Omit<Item, "id" | "at">) { const item = { id: id(), at: now(), ...value, text: this.gateway.redact(value.text) }; thread.items.push(item); thread.updatedAt = now(); this.changed(); return item; }
  private snapshots(project: Project) { return new Snapshots(project.root, path.join(this.home, "changes", project.id)); }
  private async approve(thread: Thread, run: Run, signal: AbortSignal, tool: string, args: unknown, preview: string) {
    signal.throwIfAborted();
    if (thread.access === "read") throw new Error("当前对话为只读，不能修改文件、执行命令或调用外部工具");
    if (thread.access === "allow") return;
    const approvalId = id();
    const item = this.item(thread, { kind: "approval", approvalId, runId: run.id, tool, args, text: preview, status: "pending" });
    const allowed = await new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (allow: boolean, status: string) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); item.status = status; this.approvals.delete(approvalId); this.save(); this.changed(); resolve(allow); };
      const abort = () => finish(false, "expired");
      const timer = setTimeout(abort, this.options.approvalTimeoutMs ?? 10 * 60_000);
      this.approvals.set(approvalId, { thread, item, resolve: allow => finish(allow, allow ? "allowed" : "denied") });
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
    signal.throwIfAborted(); if (!allowed) throw new Error("用户拒绝或审批已失效；此次操作未执行");
  }
  resolveApproval(aid: string, allow: boolean) { const approval = this.approvals.get(aid); if (!approval) throw new Error("审批已处理、取消或失效"); approval.resolve(allow); }
  private queue(thread: Thread, prompt: string, task: (active: Active, project: Project) => Promise<void>) {
    this.requireOpen(); if (this.active.has(thread.id)) throw new Error("当前对话已有任务，请使用插话或排队消息");
    const project = this.context(thread);
    const run: Run = { id: id(), projectId: thread.projectId, threadId: thread.id, model: thread.model ?? { id: "local" }, status: "queued", prompt, startedAt: now(), changedFiles: [] };
    thread.runs.push(run); thread.status = "queued";
    const active: Active = { run, controller: new AbortController(), promise: Promise.resolve() };
    this.active.set(thread.id, active);
    const previous = this.queues.get(project.id) ?? Promise.resolve();
    active.promise = previous.catch(() => {}).then(async () => {
      try { active.controller.signal.throwIfAborted(); run.status = "running"; thread.status = "running"; this.save(); this.changed(); await task(active, project); if (active.controller.signal.aborted) run.status = "cancelled"; else if (run.status === "running") run.status = "succeeded"; }
      catch (e) { run.status = active.controller.signal.aborted ? "cancelled" : "failed"; run.error = this.gateway.redact(errorText(e)); this.item(thread, { kind: "notice", runId: run.id, text: run.error }); }
      finally { if (active.pi) await active.pi.close().catch(e => this.item(thread, { kind: "notice", text: `会话清理失败：${errorText(e)}` })); run.endedAt = now(); thread.status = "idle"; this.active.delete(thread.id); this.save(); this.changed(); }
    });
    this.queues.set(project.id, active.promise); this.save(); this.changed(); return run;
  }
  send(tid: string, prompt: string) {
    const thread = this.thread(tid); if (!prompt.trim()) throw new Error("请输入任务"); if (!thread.model) throw new Error("请选择已验证模型"); thread.model = this.gateway.normalize(thread.model);
    if (thread.title === "新对话") thread.title = prompt.slice(0, 60);
    return this.queue(thread, prompt, async (active, project) => {
      const { run, controller } = active, signal = controller.signal;
      const snapshots = this.snapshots(project), writable = !!thread.projectId && thread.access !== "read";
      let lastTree = writable ? snapshots.begin(run.id) : undefined;
      let blocked: string | undefined;
      let pendingWrites = 0;
      const hooks: PiHooks = {
        signal, persist: () => this.save(),
        approve: (tool, args, preview) => this.approve(thread, run, signal, tool, args, preview),
        before: write => {
          signal.throwIfAborted();
          if (write && !writable) throw new Error("只读运行不能执行写操作");
          if (lastTree && pendingWrites === 0) { const current = snapshots.scan(); if (snapshots.differences(lastTree, current).length) blocked = "运行期间检测到非工具改动，无法确定归属，请手动恢复"; lastTree = current; }
          if (write) pendingWrites++;
        },
        after: (write, expected) => {
          if (!lastTree) return;
          const current = snapshots.scan(); const differences = snapshots.differences(lastTree, current);
          if (((!write || !expected) && differences.length) || (expected && differences.some(p => !expected.includes(p)))) blocked = "运行期间出现无法确定归属的改动，请手动恢复";
          if (write) pendingWrites = Math.max(0, pendingWrites - 1);
          lastTree = current;
        },
        notice: text => this.item(thread, { kind: "notice", runId: run.id, text }),
        usage: usage => { const previous = run.usage; run.usage = { source: "reported", input: usage.input === undefined ? undefined : (previous?.input ?? 0) + usage.input, output: usage.output === undefined ? undefined : (previous?.output ?? 0) + usage.output, total: usage.total === undefined ? undefined : (previous?.total ?? 0) + usage.total }; },
        event: event => {
          if (event.type === "message_start" && event.message.role === "user") {
            const text = typeof event.message.content === "string" ? event.message.content : event.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
            this.item(thread, { kind: "user", runId: run.id, text });
            const i = thread.pending.findIndex(p => p.text === text); if (i >= 0) thread.pending.splice(i, 1);
          }
          if (event.type === "message_start" && event.message.role === "assistant") this.item(thread, { kind: "assistant", runId: run.id, text: "", status: "running" });
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") { const item = thread.items.findLast(i => i.kind === "assistant" && i.runId === run.id); if (item) item.text += this.gateway.redact(event.assistantMessageEvent.delta); this.changed(); }
          if (event.type === "message_end" && event.message.role === "assistant") {
            const item = thread.items.findLast(i => i.kind === "assistant" && i.runId === run.id); if (item) item.status = event.message.stopReason;
            if (["error", "aborted"].includes(event.message.stopReason)) { run.status = signal.aborted ? "cancelled" : "failed"; run.error = this.gateway.redact(event.message.errorMessage ?? "模型响应失败"); }
          }
          if (event.type === "tool_execution_start") this.item(thread, { kind: "tool", runId: run.id, tool: event.toolName, args: event.args, text: "", status: "running" });
          if (event.type === "tool_execution_end") { const item = thread.items.findLast(i => i.kind === "tool" && i.runId === run.id && i.tool === event.toolName && i.status === "running"); if (item) { item.text = this.gateway.redact(JSON.stringify(event.result, null, 2)); item.status = event.isError ? "error" : "ok"; } this.changed(); }
        },
      };
      try {
        active.pi = await openPi({ home: this.home, project, thread, gateway: this.gateway, hooks, runtime: await this.options.runtime?.() });
        signal.throwIfAborted();
        const abort = () => { void active.pi?.session.abort(); }; signal.addEventListener("abort", abort, { once: true });
        try { await active.pi.session.prompt(prompt, { expandPromptTemplates: false }); }
        finally { signal.removeEventListener("abort", abort); }
      } finally {
        if (active.pi) { await active.pi.close(); active.pi = undefined; }
        if (writable) {
          try { const current = snapshots.scan(); if (lastTree && snapshots.differences(lastTree, current).length) blocked ??= "工具结束后出现外部编辑，请手动核对恢复"; run.changedFiles = snapshots.finish(run.id, blocked); run.restoreBlocked = blocked; }
          catch (e) { run.restoreBlocked = `改动记录未完成：${errorText(e)}`; hooks.notice(run.restoreBlocked); }
        }
      }
    });
  }
  async inject(tid: string, text: string, mode: "steer" | "followUp") {
    const thread = this.thread(tid), active = this.active.get(tid);
    if (!active?.pi || !active.pi.session.isStreaming) throw new Error("模型尚未运行或已经结束，请直接发送新消息");
    if (!["steer", "followUp"].includes(mode) || !text.trim()) throw new Error("无效的插话消息");
    thread.pending.push({ text, mode }); this.save();
    await (mode === "steer" ? active.pi.session.steer(text) : active.pi.session.followUp(text)); this.changed();
  }
  async cancel(tid: string) { const active = this.active.get(tid); if (!active) return; active.controller.abort(); await active.pi?.session.abort(); this.changed(); }
  async wait(tid: string) { await this.active.get(tid)?.promise; }
  preview(rid: string) { const thread = this.data.threads.find(t => t.runs.some(r => r.id === rid)); if (!thread) throw new Error("运行不存在"); const project = this.project(thread.projectId); this.idleProject(project.id); return this.snapshots(project).preview(rid); }
  restore(rid: string, token: string) {
    const thread = this.data.threads.find(t => t.runs.some(r => r.id === rid)); if (!thread) throw new Error("运行不存在"); const project = this.project(thread.projectId); this.idleProject(project.id);
    const restored = this.snapshots(project).restore(rid, token); thread.runs.find(r => r.id === rid)!.restoredAt = now();
    this.item(thread, { kind: "notice", runId: rid, text: `已撤销 ${restored.length} 个文件改动；聊天历史保留，外部副作用不在恢复范围内。` }); this.save(); return { restored };
  }
  compact(tid: string, instructions: string) {
    const thread = this.thread(tid); if (!thread.model || !thread.sessionFile) throw new Error("此对话尚无可压缩的 Pi 历史"); this.gateway.pick(thread.model);
    return this.queue(thread, "手动压缩上下文", async active => {
      active.pi = await openPi({ home: this.home, project: this.context(thread), thread, gateway: this.gateway, runtime: await this.options.runtime?.(), hooks: { signal: active.controller.signal, persist: () => this.save(), approve: async () => { throw new Error("压缩不执行工具"); }, before() {}, after() {}, event() {}, usage() {}, notice: text => this.item(thread, { kind: "notice", text }) } });
      const abort = () => active.pi?.session.abortCompaction(); active.controller.signal.addEventListener("abort", abort, { once: true });
      try { active.controller.signal.throwIfAborted(); await active.pi.session.compact(instructions); this.item(thread, { kind: "notice", text: "上下文压缩已完成，完整历史仍保存在 Pi 会话中。" }); }
      finally { active.controller.signal.removeEventListener("abort", abort); }
    });
  }
  resources(pid: string) { const project = this.project(pid); discover(project, path.join(this.home, "resources")); currentResources(project); this.save(); return project.resources; }
  inspectMcp(tid: string) {
    const thread = this.thread(tid); this.project(thread.projectId); if (!thread.model) throw new Error("请先为此对话选择模型，连接检查本身不会请求模型");
    return this.queue(thread, "检查 MCP 连接", async active => {
      active.pi = await openPi({ home: this.home, project: this.project(thread.projectId), thread, gateway: this.gateway, runtime: await this.options.runtime?.(), hooks: { signal: active.controller.signal, persist: () => this.save(), approve: async () => { throw new Error("连接检查不调用工具"); }, before() {}, after() {}, event() {}, usage() {}, notice: text => this.item(thread, { kind: "notice", runId: active.run.id, text }) } });
      await active.pi.session.prompt("/mcp");
      const names = active.pi.session.getAllTools().map(t => t.name).filter(n => n.startsWith("mcp__"));
      this.item(thread, { kind: "notice", runId: active.run.id, text: `MCP 已注册工具：${names.join("、") || "无；请查看连接状态与错误"}` });
    });
  }
  setResource(pid: string, input: { id?: string; path?: string; kind?: Resource["kind"]; enabled: boolean }) {
    this.idleProject(pid); const project = this.project(pid);
    let resource = project.resources.find(r => r.id === input.id);
    if (!resource) { if (!input.path || !input.kind || !["rule", "skill", "extension"].includes(input.kind)) throw new Error("请提供资源类型和路径"); resource = { id: id(), path: fs.realpathSync(input.path), kind: input.kind, enabled: false }; project.resources.push(resource); }
    enableResource(resource, input.enabled); this.save(); this.changed(); return resource;
  }
  setMcp(pid: string, configs: McpConfig[]) {
    this.idleProject(pid); const project = this.project(pid);
    if (!Array.isArray(configs) || configs.length > 20) throw new Error("MCP 配置应为不超过 20 项的列表");
    for (const m of configs) {
      if (!/^[a-zA-Z0-9_-]{1,60}$/.test(m.name) || typeof m.enabled !== "boolean" || !!m.command === !!m.url || m.args?.some(x => typeof x !== "string")) throw new Error("MCP 需要唯一名称以及 command 或 url");
      if (m.url) { const url = new URL(m.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("无效 MCP 地址"); }
    }
    if (new Set(configs.map(m => m.name)).size !== configs.length) throw new Error("MCP 名称不能重复");
    project.mcp = configs.map(m => ({ name: m.name, command: m.command, args: m.args, url: m.url, enabled: m.enabled })); this.save(); this.changed(); return project.mcp;
  }
  memories(pid: string) { return memories(this.project(pid)); }
  changeMemory(tid: string, name: string, content?: string) {
    const thread = this.thread(tid), project = this.project(thread.projectId), file = memoryPath(project, name);
    if (thread.access === "read") throw new Error("当前对话为只读，请切换权限后保存记忆");
    if (content && Buffer.byteLength(content) > 1024 * 1024) throw new Error("记忆超过 1MB");
    return this.queue(thread, content === undefined ? "删除项目记忆" : "保存项目记忆", async active => {
      const snapshots = this.snapshots(project); snapshots.begin(active.run.id);
      try { const before = fs.existsSync(file) ? hash(fs.readFileSync(file)) : "absent"; await this.approve(thread, active.run, active.controller.signal, "memory", { name, content }, `${file}\n${content ?? "删除此文件"}`); if ((fs.existsSync(file) ? hash(fs.readFileSync(file)) : "absent") !== before || memoryPath(project, name) !== file) throw new Error("记忆在审批期间发生变化"); active.controller.signal.throwIfAborted(); if (content === undefined) fs.unlinkSync(file); else atomic(file, content); this.item(thread, { kind: "notice", text: "项目记忆已更新，下次读取使用新内容。" }); }
      finally { active.run.changedFiles = snapshots.finish(active.run.id); }
    });
  }
  importPreview(pid: string, source: string, name: string, kind: "memory" | "rule") {
    const project = this.project(pid);
    if (!["memory", "rule"].includes(kind) || !source.endsWith(".md")) throw new Error("仅允许手动选择 Markdown 规则或记忆");
    const file = fs.realpathSync(source); if (fs.statSync(file).size > 1024 * 1024) throw new Error("导入文件超过 1MB");
    const dest = kind === "memory" ? memoryPath(project, name) : safePath(project.root, path.join(".baton-v2/rules", path.basename(memoryPath(project, name))), { write: true });
    const content = fs.readFileSync(file, "utf8"), current = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : undefined;
    return { source: file, destination: dest, content, current, conflict: current !== undefined, token: hash(JSON.stringify({ file, dest, content, current })) };
  }
  importMarkdown(tid: string, input: { source: string; name: string; kind: "memory" | "rule"; token: string }) {
    const thread = this.thread(tid), project = this.project(thread.projectId);
    const preview = this.importPreview(project.id, input.source, input.name, input.kind);
    if (preview.token !== input.token) throw new Error("导入预览已过期，请重新预览");
    return this.queue(thread, "导入 Markdown", async active => {
      const snapshots = this.snapshots(project); snapshots.begin(active.run.id);
      try { await this.approve(thread, active.run, active.controller.signal, "import", input, `${preview.destination}\n原内容：${preview.current ?? "[无]"}\n导入内容：${preview.content}`); if (this.importPreview(project.id, input.source, input.name, input.kind).token !== input.token) throw new Error("导入期间文件发生变化"); active.controller.signal.throwIfAborted(); atomic(preview.destination, preview.content); this.item(thread, { kind: "notice", text: "已导入选定 Markdown；规则需在资源设置中确认启用。" }); }
      finally { active.run.changedFiles = snapshots.finish(active.run.id); }
    });
  }
  async stopAll() { if (this.closing) return; this.closing = true; const jobs = [...this.active.values()]; for (const a of jobs) { a.controller.abort(); a.pi?.session.abortCompaction(); void a.pi?.session.abort(); } await Promise.allSettled([this.gateway.stop(), ...jobs.map(a => a.promise)]); if (this.lockToken) { try { this.save(); } finally { this.releaseLock(); } } }
}
