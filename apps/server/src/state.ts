import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
  AcpExecutor,
  FileCredentialStore,
  Orchestrator,
  PiExecutor,
  Workspace,
  cursorLogin,
  cursorModels,
  cursorStatus,
  deviceId,
  readJson,
  batonHome,
  writeFileAtomic,
  type AgentCard,
  type AuthStatus,
  type CursorModel,
  type CursorStatus,
  type OrchestratorEvent,
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
  url?: string;
  controller: AbortController;
  manual?: (input: string) => void;
  error?: string;
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
  demo = false;
  private persisted: Persisted;
  private auth = { chatgpt: false, deepseek: false };
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
    this.openWorkspace(target, { demo: this.options.demo ?? (target === demoDir || process.env.BATON_DEMO === "1") });
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
    const demo = options.demo ?? (path.resolve(resolved) === path.join(this.home, "demo-workspace"));
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
      available: (agent) => this.available(agent),
      onEvent: (event: OrchestratorEvent) => this.broadcast(event),
      mcpLaunch: (token) => ({ command: process.execPath, args: [MCP_BIN], env: { ...NODE_ENV_VARS, BATON_URL: this.baseUrl, BATON_TOKEN: token } }),
      summarize: (prompt) => this.summarize(prompt),
    });
    this.persisted.lastWorkspace = ws.root;
    this.persisted.recent = [ws.root, ...this.persisted.recent.filter((r) => r !== ws.root)].slice(0, 8);
    writeFileAtomic(path.join(this.home, "state.json"), JSON.stringify(this.persisted, null, 2));
    this.broadcast({ type: "state" });
  }

  recent(): string[] {
    return this.persisted.recent.filter((r) => fs.existsSync(r));
  }

  // ---------- auth ----------

  available(agent: AgentCard): boolean {
    switch (agent.source) {
      case "demo":
        return true;
      case "chatgpt":
        return this.auth.chatgpt;
      case "deepseek":
        return this.auth.deepseek;
      case "cursor":
        return this.cursor.loggedIn;
      default:
        return false;
    }
  }

  async refreshAuth(includeCursor = false): Promise<void> {
    const openai = await this.credentials.read("openai");
    const deepseek = await this.credentials.read("deepseek");
    this.auth.chatgpt = openai?.type === "oauth";
    this.auth.deepseek = deepseek?.type === "api_key" && Boolean(deepseek.key);
    if (includeCursor || Date.now() - this.cursorCheckedAt > 60_000) {
      this.cursorCheckedAt = Date.now();
      this.cursor = await cursorStatus(this.ws.settings().cursor.command);
    }
  }

  authStatus(): AuthStatus {
    return {
      chatgpt: { loggedIn: this.auth.chatgpt, pending: this.chatgptLogin?.url ? { url: this.chatgptLogin.url } : undefined },
      deepseek: { configured: this.auth.deepseek },
      cursor: { ...this.cursor, pending: this.cursorLoginFlow?.url ? { url: this.cursorLoginFlow.url } : undefined },
    };
  }

  /** Starts Sign in with ChatGPT and resolves with the authorization URL. */
  async startChatGptLogin(): Promise<string> {
    this.chatgptLogin?.controller.abort();
    const controller = new AbortController();
    const flow: ChatGptLogin = { controller };
    this.chatgptLogin = flow;
    const runtime = await this.pi.runtime();
    const url = new Promise<string>((resolve, reject) => {
      const done = runtime.login(
        "openai",
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
          await this.refreshAuth();
          this.broadcast({ type: "state" });
        },
        (error: Error) => {
          if (this.chatgptLogin === flow) this.chatgptLogin = undefined;
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
    await runtime.logout("openai").catch(() => this.credentials.delete("openai"));
    await this.credentials.delete("openai");
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

  async listPiModels(provider: "openai" | "deepseek") {
    const runtime = await this.pi.runtime();
    return runtime
      .getModels(provider)
      .filter((m) => provider !== "openai" || /^(gpt-5|gpt-6|o3|o4)/.test(m.id))
      .map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
  }

  private async summarize(prompt: string): Promise<string | undefined> {
    if (!this.auth.deepseek) return undefined;
    const runtime = await this.pi.runtime();
    const model = runtime.getModel("deepseek", "deepseek-flash");
    if (!model) return undefined;
    const reply = await runtime.completeSimple(model, {
      systemPrompt: "你负责把 agent 的输出整理成简短、只含事实的交接。",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
    });
    const text = reply.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
    return text || undefined;
  }
}
