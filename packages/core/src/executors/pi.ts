import fs from "node:fs";
import path from "node:path";
import { getSupportedThinkingLevels, type CredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { CHATGPT_PROVIDERS, chatgptMethod } from "../credentials.ts";
import { keyTemplate, type KeyAccount } from "../keys.ts";
import { runTool, type ToolSpec } from "../tools.ts";
import type { ThinkingLevel } from "../types.ts";
import { newId } from "../util.ts";
import { DEMO_CONTEXT_WINDOW, demoComplete, demoScript } from "./demo.ts";
import { VERDICT_REMINDER, type ExecuteRequest, type ExecuteResult, type Executor } from "./types.ts";

function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

export class PiExecutor implements Executor {
  private runtimePromise?: Promise<ModelRuntime>;

  constructor(
    private readonly options: {
      credentials: CredentialStore;
      agentDir: string;
      demoTokensPerSecond?: number;
    },
  ) {
    fs.mkdirSync(options.agentDir, { recursive: true });
  }

  runtime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create({ credentials: this.options.credentials, modelsPath: null, refreshOnCreate: false });
    return this.runtimePromise;
  }

  /**
   * Makes a key account's models runnable. Accounts on a Pi catalog under the catalog's own id need
   * nothing; the rest are registered: OpenAI's catalog under another id (its own is the ChatGPT
   * login's), and custom endpoints with the models they listed.
   */
  async registerKeyAccount(account: KeyAccount): Promise<void> {
    const runtime = await this.runtime();
    const template = keyTemplate(account.template);
    if (template?.catalog && template.catalog === account.provider) return;
    const models = template?.catalog
      ? runtime.getModels(template.catalog).map((m) => {
          const { provider: _provider, ...config } = m as unknown as Record<string, unknown>;
          return config;
        })
      : (account.models ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          api: account.api,
          baseUrl: account.baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128_000,
          maxTokens: 16_384,
        }));
    if (runtime.getRegisteredProviderIds().includes(account.provider)) runtime.unregisterProvider(account.provider);
    runtime.registerProvider(account.provider, { name: account.label, baseUrl: account.baseUrl ?? template?.baseUrl, api: (account.api ?? template?.api) as never, models: models as never });
  }

  async unregisterKeyAccount(provider: string): Promise<void> {
    const runtime = await this.runtime();
    if (runtime.getRegisteredProviderIds().includes(provider)) runtime.unregisterProvider(provider);
  }

  /** Models of a Pi provider with the thinking levels each supports (none when it doesn't reason). */
  async providerModels(provider: string): Promise<{ id: string; name: string; contextWindow?: number; thinking?: ThinkingLevel[] }[]> {
    const runtime = await this.runtime();
    return runtime.getModels(provider).map((m) => {
      const levels = (m as { reasoning?: boolean }).reasoning ? (getSupportedThinkingLevels(m) as ThinkingLevel[]).filter((l) => l !== "off") : [];
      return { id: m.id, name: m.name, contextWindow: m.contextWindow, thinking: levels.length ? levels : undefined };
    });
  }

  /** One completion outside any run (the context tidier). The demo answers from a script instead of a model. */
  async complete(req: { demo: boolean; provider: string; model: string; system: string; prompt: string }): Promise<{ text: string; costUsd?: number }> {
    const runtime = await this.runtime();
    let cleanup = () => {};
    let model;
    if (req.demo) {
      const providerId = `demo-${newId("once")}`;
      const faux = fauxProvider({ provider: providerId, models: [{ id: req.model, name: req.model, contextWindow: DEMO_CONTEXT_WINDOW, maxTokens: 8_000 }], tokensPerSecond: 100_000 });
      faux.setResponses([fauxAssistantMessage(demoComplete(req.prompt))]);
      runtime.registerNativeProvider(faux.provider);
      cleanup = () => runtime.unregisterProvider(providerId);
      model = runtime.getModel(providerId, req.model);
    } else {
      model = runtime.getModel(req.provider, req.model);
    }
    try {
      if (!model) throw new Error(`找不到模型 ${req.provider}/${req.model}`);
      const reply = await runtime.completeSimple(model, {
        systemPrompt: req.system,
        messages: [{ role: "user", content: [{ type: "text", text: req.prompt }], timestamp: Date.now() }],
      });
      if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? "模型没有返回结果");
      const text = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      return { text, costUsd: req.demo ? 0 : reply.usage?.cost?.total };
    } finally {
      cleanup();
    }
  }

  async run(req: ExecuteRequest): Promise<ExecuteResult> {
    const runtime = await this.runtime();
    const { agent } = req;
    let cleanup = () => {};
    let model;
    if (agent.source === "demo") {
      const providerId = `demo-${req.runId}`;
      const faux = fauxProvider({
        provider: providerId,
        models: [{ id: agent.model, name: agent.name, contextWindow: DEMO_CONTEXT_WINDOW, maxTokens: 8_000 }],
        tokensPerSecond: this.options.demoTokensPerSecond ?? 200,
      });
      faux.setResponses(demoScript(req.role, req.prompt, req.briefing.text));
      runtime.registerNativeProvider(faux.provider);
      cleanup = () => runtime.unregisterProvider(providerId);
      model = runtime.getModel(providerId, agent.model);
    } else if (agent.source === "chatgpt") {
      const method = await chatgptMethod(this.options.credentials);
      if (!method) return { status: "failed", finalText: "", error: "还没有用 ChatGPT 登录。请到「模型」页登录。" };
      model = runtime.getModel(CHATGPT_PROVIDERS[method], agent.model);
      if (!model && method === "codex") {
        return { status: "failed", finalText: "", error: `用 Codex 账号登录时没有 ${agent.model}。请在对话里换一个列表里的 GPT 模型。` };
      }
    } else {
      const credential = await this.options.credentials.read(agent.provider);
      if (credential?.type !== "api_key") {
        return { status: "failed", finalText: "", error: "这个 API key 账号没有 key 或已经删除。请到「模型」页添加。" };
      }
      model = runtime.getModel(agent.provider, agent.model);
    }
    if (!model) {
      cleanup();
      return { status: "failed", finalText: "", error: `找不到模型 ${agent.provider}/${agent.model}` };
    }

    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = new DefaultResourceLoader({
      cwd: req.workspaceRoot,
      agentDir: this.options.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: req.briefing.text,
    });
    await resourceLoader.reload();
    fs.mkdirSync(req.sessionDir, { recursive: true });

    const customTools = req.tools.map((tool: ToolSpec) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const out = await runTool(tool, params, { ...req.toolContext, signal: signal ?? req.signal });
        if (out.isError) throw new Error(out.text);
        return { content: [{ type: "text" as const, text: out.text }], details: undefined };
      },
    }));

    const { session } = await createAgentSession({
      cwd: req.workspaceRoot,
      agentDir: this.options.agentDir,
      modelRuntime: runtime,
      model,
      ...(agent.thinking ? { thinkingLevel: agent.thinking } : {}),
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.create(req.workspaceRoot, path.resolve(req.sessionDir)),
      noTools: "builtin",
      customTools: customTools as never,
    });
    await session.bindExtensions({});

    let lastError: string | undefined;
    let inText = false;
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "message_update": {
          const e = event.assistantMessageEvent;
          if (e.type === "text_delta") {
            inText = true;
            req.emit({ type: "text_delta", delta: e.delta });
          } else if (e.type === "thinking_delta") {
            req.emit({ type: "text_delta", delta: e.delta, thinking: true });
          }
          break;
        }
        case "message_end": {
          const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string };
          if (msg.role === "assistant") {
            if (msg.stopReason === "error") lastError = msg.errorMessage ?? "模型调用出错";
            if (inText) req.emit({ type: "text_end" });
            inText = false;
          }
          break;
        }
        case "tool_execution_start":
          req.emit({ type: "tool_start", id: event.toolCallId, tool: event.toolName, args: event.args });
          break;
        case "tool_execution_end":
          req.emit({ type: "tool_end", id: event.toolCallId, tool: event.toolName, ok: !event.isError, result: resultText(event.result) });
          break;
        case "compaction_end":
          if (event.result) req.emit({ type: "notice", level: "info", text: "Pi 压缩了这次运行的上下文，较早的工具输出已折叠成摘要。" });
          else if (event.errorMessage) req.emit({ type: "notice", level: "warn", text: `Pi 压缩上下文失败：${event.errorMessage}` });
          break;
        case "auto_retry_start":
          req.emit({ type: "notice", level: "warn", text: `模型调用失败，第 ${event.attempt} 次重试：${event.errorMessage}` });
          break;
      }
    });

    const onAbort = () => void session.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(req.prompt);
      if (!req.signal.aborted && !lastError && req.role === "review" && !req.hasVerdict()) {
        req.emit({ type: "notice", level: "warn", text: "检查没有给出结论，追加一次提醒。" });
        await session.prompt(VERDICT_REMINDER);
      }
      const stats = session.getSessionStats();
      const usage = {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        totalTokens: stats.tokens.total,
        costUsd: agent.source === "demo" || agent.source === "chatgpt" ? 0 : stats.cost,
      };
      const window = session.getContextUsage();
      const context = window && window.tokens !== null ? { tokens: window.tokens, window: window.contextWindow } : undefined;
      const finalText = session.getLastAssistantText() ?? "";
      if (req.signal.aborted) return { status: "cancelled", finalText, usage, context };
      if (lastError) return { status: "failed", finalText, usage, context, error: lastError };
      return { status: "succeeded", finalText, usage, context };
    } catch (error) {
      if (req.signal.aborted) return { status: "cancelled", finalText: "" };
      return { status: "failed", finalText: "", error: (error as Error).message };
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
      cleanup();
    }
  }
}
