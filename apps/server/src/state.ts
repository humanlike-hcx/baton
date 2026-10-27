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
}

export class AppState {
  readonly home: string;
  readonly baseUrl: string;
  readonly credentials: FileCredentialStore;
  readonly pi: PiExecutor;
  readonly acp = new AcpExecutor();
  orchestrator!: Orchestrator;
  tidier!: ContextTidier;
  demo = false;
  private persisted: Persisted;
  private auth: { chatgpt?: ChatGptMethod; deepseek: boolean } = { deepseek: false };
  private chatgptError?: string;
  private cursor: CursorStatus = { installed: false, loggedIn: false };
  private cursorCheckedAt = 0;
  private cursorModelsCache?: { at: number; command: string; models: CursorModel[]; error?: string };
  private chatgptLogin?: ChatGptLogin;
  private cursorLoginFlow?: { url?: string; cancel: () => void };
  private clients = new Set<Broadcast>();

  constructor(private readonly options: AppStateOptions) {
    this.baseUrl = options.baseUrl;
    this.home = options.home ?? batonHome();
    fs.mkdirSync(this.home, { recursive: true });
    this.credentials = new FileCredentialStore(this.home);
    this.pi = new PiExecutor({ credentials: this.credentials, agentDir: path.join(this.home, "pi-agent"), demoTokensPerSecond: options.demoTokensPerSecond });
    this.persisted = readJson<Persisted>(path.join(this.home, "state.json"), { recent: [] });
  }

  get ws(): Workspace {
    return this.orchestrator.ws;
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
    await this.refreshAuth(true);
  }

  openWorkspace(root: string, options: { demo?: boolean; create?: boolean } = {}): void {
    if (this.orchestrator?.isBusy()) throw new Error("当前工作区有运行在进行，先取消再切换");
    const resolved = path.resolve(root);
    if (!fs.existsSync(resolved)) {
      if (!options.create) throw new Error(`目录不存在：${resolved}`);
      fs.mkdirSync(resolved, { recursive: true });
    }
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`不是目录：${resolved}`);
    const demo = options.demo ?? this.isDemoDir(resolved);
    const ws = Workspace.open(resolved, { demo });
    if (this.options.cursorCommand && ws.settings().cursor.command !== this.options.cursorCommand) {
      ws.saveSettings({ ...ws.settings(), cursor: { command: this.options.cursorCommand } });
    }
    ws.ensureCursorMcp({ command: process.execPath, args: [MCP_BIN], env: { ...NODE_ENV_VARS, BATON_URL: this.baseUrl } });
    this.demo = demo;
    this.orchestrator = new Orchestrator({
      ws,
      pi: this.pi,
      acp: this.acp,
      unavailable: (model) => this.unavailable(model.source),
      onEvent: (event: OrchestratorEvent) => this.broadcast(event),
      mcpLaunch: (token) => ({ command: process.execPath, args: [MCP_BIN], env: { ...NODE_ENV_VARS, BATON_URL: this.baseUrl, BATON_TOKEN: token } }),
    });
    this.tidier = new ContextTidier(ws, {
      model: () => this.tidyModel(),
      unavailableReason: () => "整理员用 DeepSeek，请先到「设置 → 账号」里填 DeepSeek API key",
      onChange: () => this.broadcast({ type: "tidy" }),
    });
    ws.onContextWrite = () => this.tidier.maybeAuto();
    this.persisted.lastWorkspace = ws.root;
    this.persisted.recent = [ws.root, ...this.persisted.recent.filter((r) => r !== ws.root)].slice(0, 8);
    writeFileAtomic(path.join(this.home, "state.json"), JSON.stringify(this.persisted, null, 2));
    this.broadcast({ type: "state" });
  }

  /** Workspaces are remembered by real path, so compare real paths (macOS's /tmp is a link to /private/tmp). */
  private isDemoDir(dir: string): boolean {
    const demoDir = path.join(this.home, "demo-workspace");
    if (!fs.existsSync(dir) || !fs.existsSync(demoDir)) return false;
    return fs.realpathSync(dir) === fs.realpathSync(demoDir);
  }

  recent(): string[] {
    return this.persisted.recent.filter((r) => fs.existsSync(r));
  }

  // ---------- auth ----------

  /** Why a route can't run right now, with where to fix it; undefined when it can. */
  unavailable(source: CredentialSource): string | undefined {
    switch (source) {
      case "demo":
        return this.demo ? undefined : "演示模型只在演示工作区里可用";
      case "chatgpt":
        return this.auth.chatgpt ? undefined : "还没有用 ChatGPT 登录，请到「模型」页登录";
      case "deepseek":
        return this.auth.deepseek ? undefined : "还没有配置 DeepSeek API key，请到「模型」页填写";
      case "cursor":
        return this.cursor.loggedIn ? undefined : this.cursor.installed ? "Cursor 还没有登录，请到「模型」页登录" : "没有找到 Cursor CLI，请到「模型」页查看安装方法";
      default:
        return "不支持的账号来源";
    }
  }

  async refreshAuth(includeCursor = false): Promise<void> {
    const deepseek = await this.credentials.read("deepseek");
    this.auth.chatgpt = await chatgptMethod(this.credentials);
    this.auth.deepseek = deepseek?.type === "api_key" && Boolean(deepseek.key);
    if (includeCursor || Date.now() - this.cursorCheckedAt > 60_000) {
      this.cursorCheckedAt = Date.now();
      this.cursor = await cursorStatus(this.ws.settings().cursor.command);
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
      cursor: { ...this.cursor, pending: this.cursorLoginFlow?.url ? { url: this.cursorLoginFlow.url } : undefined },
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

  async listCursorModels(force = false): Promise<{ models: CursorModel[]; error?: string }> {
    const command = this.ws.settings().cursor.command;
    const cached = this.cursorModelsCache;
    if (!force && cached && cached.command === command && Date.now() - cached.at < 5 * 60_000) return cached;
    const result = await cursorModels(command);
    this.cursorModelsCache = { at: Date.now(), command, ...result };
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
  async models(source: CredentialSource, force = false): Promise<{ models: ModelOption[]; error?: string }> {
    if (source === "demo") return { models: this.demo ? DEMO_MODELS : [] };
    if (source === "cursor") return this.listCursorModels(force);
    return { models: await this.listPiModels(source === "chatgpt" ? "openai" : "deepseek") };
  }

  /** A model the user picked, checked against its route's live list ("one family, one route" included). */
  async resolveModel(source: string, model: string): Promise<ChatModel> {
    const routeError = validateModelRoute(source, model);
    if (routeError) throw new Error(routeError);
    const route = source as CredentialSource;
    const found = (await this.models(route)).models.find((m) => m.id === model);
    if (!found) throw new Error(`${ROUTES[route].label} 线路上没有模型 ${model}`);
    return { source: route, model, name: found.name || model };
  }

  private tidyModel(): TidyModel | undefined {
    const demo = this.demo;
    if (!demo && !this.auth.deepseek) return undefined;
    const model = demo ? "demo-tidy" : "deepseek-v4-pro";
    return {
      name: model,
      complete: (system, prompt) => this.pi.complete({ demo, provider: "deepseek", model, system, prompt }),
    };
  }
}
