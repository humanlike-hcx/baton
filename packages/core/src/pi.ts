import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession, createReadTool, createWriteTool, createEditTool, createLsTool, createGrepTool, createFindTool,
  createBashTool, createPowerShellTool, createMcpExtension, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent, type ExtensionFactory, type ModelRuntime, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Gateway } from "./gateway.ts";
import { currentResources, memories, memoryPath } from "./resources.ts";
import { hash, safePath, errorText } from "./util.ts";
import { runShell, formatShellResult } from "./shell.ts";
import type { Project, Run, Thread } from "./types.ts";

export interface PiHooks {
  signal: AbortSignal;
  approve(tool: string, args: unknown, preview: string): Promise<void>;
  before(write: boolean): void;
  after(write: boolean, expected?: string[]): void;
  event(event: AgentSessionEvent): void;
  notice(text: string): void;
  usage(usage: NonNullable<Run["usage"]>): void;
  persist(): void;
}
const BASIC = new Set(["read", "ls", "grep", "find", "write", "edit", "bash", "powershell", "memory_list", "memory_write", "memory_delete"]);
const READ = new Set(["read", "ls", "grep", "find", "memory_list"]);
const textResult = (text: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text }], details });
const fingerprint = (file: string) => fs.existsSync(file) ? hash(fs.readFileSync(file)) : "absent";

export async function openPi(input: { home: string; project: Project; thread: Thread; gateway: Gateway; hooks: PiHooks; runtime?: ModelRuntime }) {
  const { project, thread, gateway, hooks } = input;
  const conversationOnly = !thread.projectId;
  const resources = conversationOnly ? [] : currentResources(project);
  const agentDir = path.join(input.home, "pi", thread.id);
  fs.mkdirSync(agentDir, { recursive: true });
  const sessionDir = path.join(input.home, "sessions", thread.id);
  fs.mkdirSync(sessionDir, { recursive: true });
  if (thread.sessionFile && !fs.existsSync(thread.sessionFile) && thread.items.some(i => i.kind === "user")) throw new Error("已保存的 Pi 会话文件缺失；为避免丢失上下文，已停止运行，请先恢复会话文件");
  const manager = thread.sessionFile && fs.existsSync(thread.sessionFile) ? SessionManager.open(thread.sessionFile, sessionDir, project.root) : SessionManager.create(project.root, sessionDir);
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 8192 }, retry: { enabled: false }, transport: "sse" });
  const readRoots = resources.filter(r => r.kind === "skill" || r.kind === "rule").map(r => r.kind === "skill" ? path.dirname(r.path) : r.path);
  const resolveRead = (p: string) => safePath(project.root, p, { extraRead: readRoots });
  const resolveWrite = (p: string) => safePath(project.root, p, { write: true });
  const readOps = { readFile: async (p: string) => fs.readFileSync(resolveRead(p)), access: async (p: string) => { fs.accessSync(resolveRead(p)); } };
  const writeOps = { writeFile: async (p: string, content: string) => { fs.writeFileSync(resolveWrite(p), content); }, mkdir: async (p: string) => { fs.mkdirSync(resolveWrite(p), { recursive: true }); } };
  const tools = [
    createReadTool(project.root, { operations: readOps }),
    createWriteTool(project.root, { operations: writeOps }),
    createEditTool(project.root, { operations: { ...readOps, writeFile: writeOps.writeFile } }),
    createLsTool(project.root), createGrepTool(project.root, { operations: { isDirectory: p => fs.statSync(resolveRead(p)).isDirectory(), readFile: p => fs.readFileSync(resolveRead(p), "utf8") } }), createFindTool(project.root),
  ];
  // Keep Pi's shell schema; adapt execution to report exit status and own child cleanup on both platforms.
  const shell = process.platform === "win32" ? createPowerShellTool(project.root) : createBashTool(project.root);
  shell.execute = async (_call, args, signal) => {
    const result = await runShell(args.command, { cwd: project.root, signal: signal ?? hooks.signal, timeoutMs: Math.max(1, Math.min(args.timeout ?? 120, 600)) * 1000 });
    const text = formatShellResult(args.command, result);
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error(text), { details: result });
    return textResult(text, result);
  };
  tools.push(shell as unknown as typeof tools[number]);
  const definitions: ToolDefinition[] = tools.map(tool => ({ ...tool, label: tool.name, executionMode: "sequential", async execute(call, originalArgs, signal, update) {
    const args = structuredClone(originalArgs) as Record<string, unknown>;
    const write = !READ.has(tool.name);
    const fileTool = ["read", "write", "edit", "ls", "grep", "find"].includes(tool.name);
    const target = fileTool ? (write ? resolveWrite : resolveRead)(String(args.path ?? ".")) : undefined;
    if (target) args.path = target;
    const before = target && write ? fingerprint(target) : undefined;
    const preview = target && write ? `目标：${target}\n原文件：\n${fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "[新建]"}\n操作：\n${JSON.stringify(args, null, 2)}` : String(args.command ?? JSON.stringify(args));
    if (write) await hooks.approve(tool.name, args, preview);
    hooks.signal.throwIfAborted(); signal?.throwIfAborted();
    if (target && ((write ? resolveWrite : resolveRead)(target) !== target || write && fingerprint(target) !== before)) throw new Error("审批后目标文件或链接已变化，请重新发起操作");
    hooks.before(write);
    try { return await tool.execute(call, args as never, signal, update as never); }
    finally { hooks.after(write, target && write ? [path.relative(project.root, target)] : undefined); }
  } })) as ToolDefinition[];
  definitions.push({ name: "memory_list", label: "项目记忆", description: "读取当前项目显式保存的 Markdown 记忆；不读取其他项目。", parameters: Type.Object({}), async execute() { return textResult(JSON.stringify(memories(project))); } });
  for (const remove of [false, true]) definitions.push({ name: remove ? "memory_delete" : "memory_write", label: remove ? "删除记忆" : "保存记忆", description: remove ? "明确删除一条项目 Markdown 记忆。" : "仅在用户明确要求记住时保存项目 Markdown 记忆。", parameters: Type.Object({ name: Type.String(), content: Type.Optional(Type.String()) }), async execute(_call, raw) {
    const args = raw as { name: string; content?: string };
    const file = memoryPath(project, args.name), before = fingerprint(file);
    if (!remove && typeof args.content !== "string") throw new Error("缺少记忆内容");
    await hooks.approve(remove ? "memory_delete" : "memory_write", args, `${file}\n${remove ? "删除此记忆" : args.content}`);
    hooks.signal.throwIfAborted();
    if (memoryPath(project, args.name) !== file || fingerprint(file) !== before) throw new Error("记忆已被修改，请重新操作");
    hooks.before(true);
    try { if (remove) fs.unlinkSync(file); else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, args.content!); } return textResult("项目记忆已更新；历史消息中的旧副本仍然保留。"); }
    finally { hooks.after(true, [path.relative(project.root, file)]); }
  } });
  const policy: ExtensionFactory = pi => {
    pi.on("tool_call", async event => {
      if (BASIC.has(event.toolName)) return;
      try { await hooks.approve(event.toolName, event.input, JSON.stringify(event.input, null, 2)); hooks.signal.throwIfAborted(); hooks.before(true); }
      catch (e) { return { block: true, reason: errorText(e), terminate: hooks.signal.aborted }; }
    });
    pi.on("tool_result", async event => { if (!BASIC.has(event.toolName)) hooks.after(true); });
    pi.on("provider_stream_event", event => {
      const raw = event.data as { usage?: Record<string, number>; response?: { usage?: Record<string, number> } };
      const usage = raw.usage ?? raw.response?.usage;
      if (usage) hooks.usage({ input: usage.input_tokens ?? usage.prompt_tokens, output: usage.output_tokens ?? usage.completion_tokens, total: usage.total_tokens, source: "reported" });
    });
    pi.on("session_compact", () => hooks.notice("Pi 已压缩上下文；完整会话记录保留，摘要可能省略细节。"));
    pi.on("session_compact_failed", event => hooks.notice(`上下文压缩失败，历史已保留：${JSON.stringify(event)}`));
  };
  const mcp = createMcpExtension({ loadConfig: () => ({ servers: project.mcp.filter(m => m.enabled).map(m => ({ name: m.name, source: "Baton settings", scope: "global" as const, config: m.url ? { url: m.url, exposure: "direct" as const, timeout: 20 } : { command: m.command!, args: m.args ?? [], cwd: project.root, exposure: "direct" as const, timeout: 20 } })), errors: [], autoEnableCodemode: false }), startupWaitMs: 3000, logPath: path.join(agentDir, "mcp.log"), openUrl: () => { throw new Error("此桌面适配暂不支持 MCP OAuth，请配置已可用的服务"); } });
  const loader = new DefaultResourceLoader({ cwd: project.root, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: resources.filter(r => r.kind === "skill").map(r => r.path),
    additionalExtensionPaths: resources.filter(r => r.kind === "extension").map(r => r.path),
    extensionFactories: conversationOnly ? [policy] : [mcp, policy],
    agentsFilesOverride: () => ({ agentsFiles: resources.filter(r => r.kind === "rule").map(r => ({ path: r.path, content: fs.readFileSync(r.path, "utf8") })) }),
    appendSystemPrompt: [conversationOnly ? "You are Baton, a helpful conversational assistant. This is an ordinary chat with no selected project and no tools. Answer questions, discuss ideas, and explain code supplied in the conversation. You cannot access local files, run commands, or use project resources. Ask the user to open a project in Baton when those capabilities are needed." : "You are Baton, a coding assistant. Work only in the selected project. Use memory_list when project memory is relevant; save memory only when explicitly asked. Tool execution is controlled by the user's conversation permission. Commands run with local user privileges. Do not claim tests passed without actual successful tool results. Never read external application credentials. Skills and extensions are enabled explicitly. File restoration covers tracked project files only; external effects are not reversible."],
  });
  for (const resource of resources) resource.error = undefined;
  await loader.reload();
  for (const extension of loader.getExtensions().extensions) {
    for (const name of extension.tools.keys()) if (BASIC.has(name)) throw new Error(`扩展不能替换受保护的基础工具：${name}`);
  }
  for (const problem of [...loader.getExtensions().errors, ...loader.getSkills().diagnostics]) {
    const resource = resources.find(r => r.path === problem.path);
    if (resource) resource.error = "error" in problem ? problem.error : problem.message;
    hooks.notice(`资源加载问题：${JSON.stringify(problem)}`);
  }
  hooks.persist();
  if (!thread.model) throw new Error("请先选择模型");
  const runtime = input.runtime ?? await gateway.runtime(thread.model);
  const model = runtime.getModel("baton-magpie", thread.model.id);
  if (!model) throw new Error("模型已不可用，请重新选择");
  const { session } = await createAgentSession({ cwd: project.root, agentDir, modelRuntime: runtime, model, thinkingLevel: thread.model.thinking ?? "off", settingsManager: settings, resourceLoader: loader, sessionManager: manager, noTools: "builtin", customTools: conversationOnly ? [] : definitions, ...(conversationOnly ? { tools: [] } : thread.access === "read" ? { tools: [...READ], excludeTools: ["mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] } : {}) });
  session.agent.toolExecution = "sequential";
  thread.sessionFile = manager.getSessionFile(); hooks.persist();
  session.subscribe(hooks.event);
  const headless = session.extensionRunner.getUIContext();
  const ui = { ...headless, notify: (message: string) => hooks.notice(message), setStatus: (_key: string, text: string | undefined) => { if (text) hooks.notice(text); }, select: async () => { throw new Error("此扩展需要未适配的终端选择交互"); }, confirm: async () => { throw new Error("此扩展需要未适配的确认交互"); }, input: async () => { throw new Error("此扩展需要未适配的终端输入交互"); }, custom: async () => { throw new Error("此扩展需要未适配的终端 UI"); } };
  try {
    await session.bindExtensions({ uiContext: ui, mode: "rpc", onError: error => { const resource = resources.find(r => r.path === error.extensionPath); if (resource) { resource.error = error.error; hooks.persist(); } hooks.notice(`扩展错误：${JSON.stringify(error)}`); }, abortHandler: () => { void session.abort(); } });
  } catch (error) {
    try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); }
    throw error;
  }
  // SDK's default headless UI is deliberately not advertised as terminal-compatible.
  return { session, manager, async close() { try { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); } } };
}
export type OpenPi = Awaited<ReturnType<typeof openPi>>;
