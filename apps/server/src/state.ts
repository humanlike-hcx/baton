import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
  AcpExecutor,
  CHATGPT_PROVIDERS,
  ContextTidier,
  FileCredentialStore,
  Orchestrator,
  PiExecutor,
  Workspace,
  cursorLogin,
  cursorModels,
  cursorStatus,
  deviceId,
  readJson,
  validateModelRoute,
  batonHome,
  chatgptMethod,
  writeFileAtomic,
  DEMO_MODELS,
  ROUTES,
  type AuthStatus,
  type ChatModel,
  type CredentialSource,
  type ChatGptMethod,
  type CursorModel,
  type CursorStatus,
  type OrchestratorEvent,
  type TidyModel,
} from "@baton/core";
import { chooseDirectory, type DirectoryPicker } from "./picker.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
/** Packaged builds (the desktop app) ship the web app, MCP server and mock Cursor here instead of the source tree. */
const RESOURCES = process.env.BATON_RESOURCES;
export const WEB_DIST = RESOURCES ? path.join(RESOURCES, "web") : path.join(REPO_ROOT, "apps/web/dist");
export const MCP_BIN = RESOURCES ? path.join(RESOURCES, "mcp/baton-mcp.mjs") : path.join(REPO_ROOT, "packages/mcp/bin/baton-mcp.mjs");
export const MOCK_CURSOR = RESOURCES ? path.join(RESOURCES, "fixtures/mock-acp-agent.mjs") : path.join(REPO_ROOT, "packages/core/fixtures/mock-acp-agent.mjs");

/** Inside Electron, Baton's own binary only behaves as Node when this is set; outside it is empty. */
export const NODE_ENV_VARS: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};

/** A command line that runs `script` with the same Node that runs Baton, so no separate Node install is needed. */
export function nodeScriptCommand(script: string): string {
  const env = Object.entries(NODE_ENV_VARS).map(([k, v]) => `${k}=${v}`);
  return [...(env.length ? ["env", ...env] : []), `"${process.execPath}"`, `"${script}"`].join(" ");
}

interface Persisted {
  lastWorkspace?: string;
  recent: string[];
}

type Broadcast = (message: unknown) => void;

/** One open workspace: its own orchestrator (write lock, snapshots, approvals) and context tidier. */
export interface Session {
  ws: Workspace;
  orchestrator: Orchestrator;
  tidier: ContextTidier;
  demo: boolean;
}

interface ChatGptLogin {
  method: ChatGptMethod;
  url?: string;
  controller: AbortController;
  manual?: (input: string) => void;
}

export interface ModelOption {
  id: string;
  name: string;
  contextWindow?: number;
}

/** Login errors can quote token responses; keep anything token-like out of what reaches the browser. */
function loginError(error: Error): string {
  return error.message.replace(/[A-Za-z0-9_\-.]{40,}/g, "[已隐藏]").slice(0, 300);
}

export interface AppStateOptions {
  /** Base URL the MCP server and `baton` CLI call back into. */
  baseUrl: string;
  /** Global data directory (credentials, device id, recent workspaces, demo workspace). Defaults to `batonHome()`. */
  home?: string;
  /** Workspace to open on init instead of `BATON_WORKSPACE` / the last one / the demo workspace. */
  workspace?: string;
  demo?: boolean;
  /** Cursor CLI command written into every workspace this state opens. */
  cursorCommand?: string;
  /** Streaming speed of the demo models. */
  demoTokensPerSecond?: number;
  /** Folder dialog for opening a project. Defaults to the system dialog; tests pass their own. */
  pickDirectory?: DirectoryPicker;
}

export class AppState {
  readonly home: string;
  readonly baseUrl: string;
  readonly credentials: FileCredentialStore;
  readonly pi: PiExecutor;
  readonly acp = new AcpExecutor();
  private sessions = new Map<string, Session>();
  private current!: Session;
  private persisted: Persisted;
  private auth: { chatgpt?: ChatGptMethod; deepseek: boolean } = { deepseek: false };
  private chatgptError?: string;
  /** Each project names its own Cursor CLI command, so sign-in state and models are kept per command. */
  private cursorByCommand = new Map<string, CursorStatus>();
  private cursorCheckedAt = 0;
  private cursorModelsCache = new Map<string, { at: number; models: CursorModel[]; error?: string }>();
  private chatgptLogin?: ChatGptLogin;
  private cursorLoginFlow?: { url?: string; cancel: () => void };
  private picking?: Promise<string | undefined>;
  private clients = new Set<Broadcast>();

  constructor(private readonly options: AppStateOptions) {
    this.baseUrl = options.baseUrl;
    this.home = options.home ?? batonHome();
    fs.mkdirSync(this.home, { recursive: true });
    this.credentials = new FileCredentialStore(this.home);
    this.pi = new PiExecutor({ credentials: this.credentials, agentDir: path.join(this.home, "pi-agent"), demoTokensPerSecond: options.demoTokensPerSecond });
    this.persisted = readJson<Persisted>(path.join(this.home, "state.json"), { recent: [] });
  }

  /** The current project: what the management pages show and where a new chat opens by default. */
  get ws(): Workspace {
    return this.current.ws;
  }

  get orchestrator(): Orchestrator {
    return this.current.orchestrator;
  }

  get tidier(): ContextTidier {
    return this.current.tidier;
  }

  get demo(): boolean {
    return this.current.demo;
  }

  /** Open projects in sidebar order. */
  projects(): Session[] {
    return this.persisted.recent.map((root) => this.sessions.get(root)).filter((s): s is Session => Boolean(s));
  }

  sessionByRoot(root: string): Session | undefined {
    return this.sessions.get(root);
  }

  sessionOfThread(threadId: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.orchestrator.getThread(threadId));
  }

  sessionOfRun(runId: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.orchestrator.findRun(runId));
  }

  sessionOfApproval(approvalId: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.orchestrator.hasApproval(approvalId));
  }

  /** Tool calls from the MCP server or `baton` CLI go to the project whose run holds the token. */
  bridgeTool(token: string | undefined, tool: string, args: unknown) {
    const sessions = [...this.sessions.values()];
    if (token) return (sessions.find((s) => s.orchestrator.ownsToken(token)) ?? this.current).orchestrator.bridgeTool(token, tool, args);
    // Without a token, only an unambiguous single Cursor run (across every project) may be guessed.
    const cursor = sessions.filter((s) => s.orchestrator.cursorRunCount() > 0);
    const single = cursor.length === 1 && cursor[0]!.orchestrator.cursorRunCount() === 1 ? cursor[0] : undefined;
    return (single ?? this.current).orchestrator.bridgeTool(undefined, tool, args, { guessCursorRun: Boolean(single) });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.orchestrator.stopAll()));
  }

  subscribe(send: Broadcast): () => void {
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  broadcast(message: unknown): void {
    for (const send of this.clients) send(message);
  }

  async init(): Promise<void> {
    if (process.env.OPENAI_API_KEY) {
      // GPT is only reachable through Sign in with ChatGPT; an API key must never take precedence.
      delete process.env.OPENAI_API_KEY;
      console.log("[baton] ignoring OPENAI_API_KEY: GPT models are only used through ChatGPT login");
    }
    const envWs = this.options.workspace ?? process.env.BATON_WORKSPACE;
    const demoDir = path.join(this.home, "demo-workspace");
    const target = envWs ? path.resolve(envWs) : this.persisted.lastWorkspace && fs.existsSync(this.persisted.lastWorkspace) ? this.persisted.lastWorkspace : demoDir;
    if (target === demoDir) fs.mkdirSync(demoDir, { recursive: true });
    this.openWorkspace(target, { demo: this.options.demo ?? (this.isDemoDir(target) || process.env.BATON_DEMO === "1") });
    // Every project in the sidebar is live, so its chats can be opened and keep running without switching to it.
    for (const root of this.persisted.recent) {
      if (this.sessions.has(root) || !fs.existsSync(root)) continue;
      try {
        this.sessions.set(root, this.createSession(root, this.isDemoDir(root)));
      } catch (error) {
        console.error(`[baton] could not open ${root}:`, (error as Error).message);
      }
    }
    await this.refreshAuth(true);
  }

  /** Makes `root` the current project, opening it first if needed; chats in other projects keep running. */
  openWorkspace(root: string, options: { demo?: boolean; create?: boolean } = {}): void {
    const resolved = path.resolve(root);
    if (!fs.existsSync(resolved)) {
      if (!options.create) throw new Error(`目录不存在：${resolved}`);
      fs.mkdirSync(resolved, { recursive: true });
    }
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`不是目录：${resolved}`);
    let session = this.sessions.get(fs.realpathSync(resolved));
    if (!session) {
      session = this.createSession(resolved, options.demo ?? this.isDemoDir(resolved));
      this.sessions.set(session.ws.root, session);
    }
    this.current = session;
    const opened = session.ws.root;
    this.persisted.lastWorkspace = opened;
    // Sidebar order stays put when switching; a newly opened project goes on top.
    if (!this.persisted.recent.includes(opened)) this.persisted.recent = [opened, ...this.persisted.recent].slice(0, 12);
    this.savePersisted();
    this.broadcast({ type: "state" });
  }

  /** System folder dialog. Undefined when the user cancels; one dialog at a time. */
  pickDirectory(): Promise<string | undefined> {
    if (this.picking) return Promise.reject(new Error("已经有一个文件夹选择框开着"));
    const run = (async () => {
      const picked = (await (this.options.pickDirectory ?? chooseDirectory)())?.trim();
      if (!picked) return undefined;
      return picked.replace(/\/+$/, "") || "/";
    })();
    this.picking = run;
    // The caller awaits `run`; this copy only clears the lock, so its rejection must not surface on its own.
    void run.finally(() => {
      if (this.picking === run) this.picking = undefined;
    }).catch(() => undefined);
    return run;
  }

  /** Takes a project off the list (files untouched); the current one hands over to the next project. */
  closeWorkspace(root: string): void {
    const session = this.sessions.get(root);
    if (!session) throw new Error("这个项目不在列表里");
    if (session.orchestrator.isBusy()) throw new Error("这个项目里有对话在回复，先取消再移除");
    const rest = this.projects().filter((s) => s !== session);
    if (session === this.current) {
      if (!rest.length) throw new Error("至少要留一个项目");
      this.current = rest[0]!;
      this.persisted.lastWorkspace = this.current.ws.root;
    }
    this.sessions.delete(root);
    this.persisted.recent = this.persisted.recent.filter((r) => r !== root);
    this.savePersisted();
    this.broadcast({ type: "state" });
  }

  private savePersisted(): void {
    writeFileAtomic(path.join(this.home, "state.json"), JSON.stringify(this.persisted, null, 2));
  }

  private createSession(root: string, demo: boolean): Session {
    const ws = Workspace.open(root, { demo });
    if (this.options.cursorCommand && ws.settings().cursor.command !== this.options.cursorCommand) {
      ws.saveSettings({ ...ws.settings(), cursor: { command: this.options.cursorCommand } });
    }
    ws.ensureCursorMcp({ command: process.execPath, args: [MCP_BIN], env: { ...NODE_ENV_VARS, BATON_URL: this.baseUrl } });
    const orchestrator: Orchestrator = new Orchestrator({
      ws,
      pi: this.pi,
      acp: this.acp,
      unavailable: (model) => this.unavailable(model.source, session),
      onEvent: (event: OrchestratorEvent) => this.broadcast({ ...event, workspace: ws.root }),
      mcpLaunch: (token) => ({ command: process.execPath, args: [MCP_BIN], env: { ...NODE_ENV_VARS, BATON_URL: this.baseUrl, BATON_TOKEN: token } }),
    });
    const tidier = new ContextTidier(ws, {
      model: () => this.tidyModel(demo),
      unavailableReason: () => "整理员用 DeepSeek，请先到「模型」页填写 DeepSeek API key",
      onChange: () => this.broadcast({ type: "tidy", workspace: ws.root }),
    });
    ws.onContextWrite = () => tidier.maybeAuto();
    const session: Session = { ws, orchestrator, tidier, demo };
    return session;
  }

  /** Workspaces are remembered by real path, so compare real paths (macOS's /tmp is a link to /private/tmp). */
  private isDemoDir(dir: string): boolean {
    const demoDir = path.join(this.home, "demo-workspace");
    if (!fs.existsSync(dir) || !fs.existsSync(demoDir)) return false;
    return fs.realpathSync(dir) === fs.realpathSync(demoDir);
  }

  // ---------- auth ----------

  /** Why a route can't run right now for a chat in `session`, with where to fix it; undefined when it can. */
  unavailable(source: CredentialSource, session: Session = this.current): string | undefined {
    switch (source) {
      case "demo":
        return session.demo ? undefined : "演示模型只在演示工作区里可用";
      case "chatgpt":
        return this.auth.chatgpt ? undefined : "还没有用 ChatGPT 登录，请到「模型」页登录";
      case "deepseek":
        return this.auth.deepseek ? undefined : "还没有配置 DeepSeek API key，请到「模型」页填写";
      case "cursor": {
        const cursor = this.cursorStatusOf(session);
        return cursor.loggedIn ? undefined : cursor.installed ? "Cursor 还没有登录，请到「模型」页登录" : "没有找到 Cursor CLI，请到「模型」页查看安装方法";
      }
      default:
        return "不支持的账号来源";
    }
  }

  private cursorStatusOf(session: Session): CursorStatus {
    return this.cursorByCommand.get(session.ws.settings().cursor.command) ?? { installed: false, loggedIn: false };
  }

  async refreshAuth(includeCursor = false): Promise<void> {
    const deepseek = await this.credentials.read("deepseek");
    this.auth.chatgpt = await chatgptMethod(this.credentials);
    this.auth.deepseek = deepseek?.type === "api_key" && Boolean(deepseek.key);
    const currentCommand = this.ws.settings().cursor.command;
    if (includeCursor || Date.now() - this.cursorCheckedAt > 60_000 || !this.cursorByCommand.has(currentCommand)) {
      this.cursorCheckedAt = Date.now();
      const commands = new Set([currentCommand, ...[...this.sessions.values()].map((s) => s.ws.settings().cursor.command)]);
      const statuses = await Promise.all([...commands].map(async (command) => [command, await cursorStatus(command)] as const));
      this.cursorByCommand = new Map(statuses);
    }
  }

  authStatus(): AuthStatus {
    return {
      chatgpt: {
        loggedIn: Boolean(this.auth.chatgpt),
        method: this.auth.chatgpt,
        pending: this.chatgptLogin?.url ? { url: this.chatgptLogin.url, method: this.chatgptLogin.method } : undefined,
        error: this.chatgptError,
      },
      deepseek: { configured: this.auth.deepseek },
      cursor: { ...this.cursorStatusOf(this.current), pending: this.cursorLoginFlow?.url ? { url: this.cursorLoginFlow.url } : undefined },
    };
  }

  /** Starts a ChatGPT login with either method and resolves with the authorization URL. */
  async startChatGptLogin(method: ChatGptMethod = "chatgpt"): Promise<string> {
    this.chatgptLogin?.controller.abort();
    const controller = new AbortController();
    const flow: ChatGptLogin = { method, controller };
    this.chatgptLogin = flow;
    this.chatgptError = undefined;
    const runtime = await this.pi.runtime();
    const url = new Promise<string>((resolve, reject) => {
      const done = runtime.login(
        CHATGPT_PROVIDERS[method],
        "oauth",
        {
          signal: controller.signal,
          notify: (event) => {
            if (event.type === "auth_url") {
              flow.url = event.url;
              resolve(event.url);
              this.broadcast({ type: "state" });
            }
          },
          prompt: (p: AuthPrompt) =>
            new Promise<string>((res, rej) => {
              // The Codex login first asks browser or device code; Baton always opens the browser.
              if (p.type === "select" && p.options.some((o) => o.id === "browser")) return res("browser");
              if (p.type !== "manual_code") return rej(new Error(`不支持的登录交互：${p.type}`));
              flow.manual = res;
              p.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
            }),
        },
        { getDeviceId: () => deviceId(this.home), agentName: "Baton" },
      );
      done.then(
        async () => {
          if (this.chatgptLogin === flow) this.chatgptLogin = undefined;
          // Keep a single ChatGPT credential so the status always names the method that runs.
          const other = method === "chatgpt" ? "codex" : "chatgpt";
          await this.credentials.delete(CHATGPT_PROVIDERS[other]);
          await this.refreshAuth();
          this.broadcast({ type: "state" });
        },
        (error: Error) => {
          if (this.chatgptLogin !== flow) return reject(error);
          this.chatgptLogin = undefined;
          if (!controller.signal.aborted) this.chatgptError = loginError(error);
          reject(error);
          this.broadcast({ type: "state" });
        },
      );
    });
    return url;
  }

  submitChatGptManual(input: string): void {
    if (!this.chatgptLogin?.manual) throw new Error("没有进行中的 ChatGPT 登录");
    this.chatgptLogin.manual(input.trim());
  }

  cancelChatGptLogin(): void {
    this.chatgptLogin?.controller.abort();
    this.chatgptLogin = undefined;
  }

  async logoutChatGpt(): Promise<void> {
    const runtime = await this.pi.runtime();
    for (const provider of Object.values(CHATGPT_PROVIDERS)) {
      await runtime.logout(provider).catch(() => undefined);
      await this.credentials.delete(provider);
    }
    this.chatgptError = undefined;
    await this.refreshAuth();
  }

  async setDeepSeekKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(trimmed)) throw new Error("DeepSeek API key 格式不对（应以 sk- 开头）");
    await this.credentials.modify("deepseek", async () => ({ type: "api_key", key: trimmed }));
    await this.refreshAuth();
  }

  async clearDeepSeekKey(): Promise<void> {
    await this.credentials.delete("deepseek");
    await this.refreshAuth();
  }

  async startCursorLogin(): Promise<string> {
    this.cursorLoginFlow?.cancel();
    const login = cursorLogin(this.ws.settings().cursor.command);
    const flow: { url?: string; cancel: () => void } = { cancel: login.cancel };
    this.cursorLoginFlow = flow;
    void login.done.then(async () => {
      if (this.cursorLoginFlow === flow) this.cursorLoginFlow = undefined;
      await this.refreshAuth(true);
      this.broadcast({ type: "state" });
    });
    flow.url = await login.url;
    return flow.url;
  }

  async listCursorModels(force = false, session: Session = this.current): Promise<{ models: CursorModel[]; error?: string }> {
    const command = session.ws.settings().cursor.command;
    const cached = this.cursorModelsCache.get(command);
    if (!force && cached && Date.now() - cached.at < 5 * 60_000) return cached;
    const result = await cursorModels(command);
    this.cursorModelsCache.set(command, { at: Date.now(), ...result });
    return result;
  }

  /** GPT models come from the signed-in ChatGPT method, so the list matches what runs can use. */
  async listPiModels(provider: "openai" | "deepseek") {
    const runtime = await this.pi.runtime();
    const piProvider = provider === "openai" && this.auth.chatgpt ? CHATGPT_PROVIDERS[this.auth.chatgpt] : provider;
    return runtime
      .getModels(piProvider)
      .filter((m) => provider !== "openai" || /^(gpt-5|gpt-6|o3|o4)/.test(m.id))
      .map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
  }

  /** Every model a route offers; the demo models only exist in the demo workspace. */
  async models(source: CredentialSource, force = false, session: Session = this.current): Promise<{ models: ModelOption[]; error?: string }> {
    if (source === "demo") return { models: session.demo ? DEMO_MODELS : [] };
    if (source === "cursor") return this.listCursorModels(force, session);
    return { models: await this.listPiModels(source === "chatgpt" ? "openai" : "deepseek") };
  }

  /** A model the user picked for a chat in `session`, checked against its route's live list ("one family, one route" included). */
  async resolveModel(source: string, model: string, session: Session = this.current): Promise<ChatModel> {
    const routeError = validateModelRoute(source, model);
    if (routeError) throw new Error(routeError);
    const route = source as CredentialSource;
    const found = (await this.models(route, false, session)).models.find((m) => m.id === model);
    if (!found) throw new Error(`${ROUTES[route].label} 线路上没有模型 ${model}`);
    return { source: route, model, name: found.name || model };
  }

  private tidyModel(demo: boolean): TidyModel | undefined {
    if (!demo && !this.auth.deepseek) return undefined;
    const model = demo ? "demo-tidy" : "deepseek-v4-pro";
    return {
      name: model,
      complete: (system, prompt) => this.pi.complete({ demo, provider: "deepseek", model, system, prompt }),
    };
  }
}
