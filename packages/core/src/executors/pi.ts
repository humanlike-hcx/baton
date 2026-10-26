import fs from "node:fs";
import path from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { runTool, type ToolSpec } from "../tools.ts";
import { DEMO_CONTEXT_WINDOW, demoScript, demoSettings } from "./demo.ts";
import { HANDOFF_REMINDER, expectsHandoff, type ExecuteRequest, type ExecuteResult, type Executor } from "./types.ts";

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
      faux.setResponses(demoScript(req.role, req.thread, req.prompt, req.briefing.text));
      runtime.registerNativeProvider(faux.provider);
      cleanup = () => runtime.unregisterProvider(providerId);
      model = runtime.getModel(providerId, agent.model);
    } else {
      const credential = await this.options.credentials.read(agent.provider);
      if (agent.source === "chatgpt" && credential?.type !== "oauth") {
        return { status: "failed", finalText: "", error: "还没有用 ChatGPT 登录。请到「设置 → 账号」里登录。" };
      }
      if (agent.source === "deepseek" && credential?.type !== "api_key") {
        return { status: "failed", finalText: "", error: "还没有配置 DeepSeek API key。请到「设置 → 账号」里填写。" };
      }
      model = runtime.getModel(agent.provider, agent.model);
    }
    if (!model) {
      cleanup();
      return { status: "failed", finalText: "", error: `找不到模型 ${agent.provider}/${agent.model}` };
    }

    const settingsManager = SettingsManager.inMemory(agent.source === "demo" ? demoSettings(req.thread) : {});
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
          if (event.result) req.emit({ type: "compaction", summary: event.result.summary });
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
      if (!req.signal.aborted && !lastError && !req.hasHandoff() && expectsHandoff(req.role)) {
        req.emit({ type: "notice", level: "warn", text: "运行没有写交接，追加一次提醒。" });
        await session.prompt(HANDOFF_REMINDER);
      }
      const stats = session.getSessionStats();
      const usage = {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        totalTokens: stats.tokens.total,
        costUsd: agent.source === "demo" || agent.source === "chatgpt" ? 0 : stats.cost,
      };
      const finalText = session.getLastAssistantText() ?? "";
      if (req.signal.aborted) return { status: "cancelled", finalText, usage };
      if (lastError) return { status: "failed", finalText, usage, error: lastError };
      return { status: "succeeded", finalText, usage };
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
