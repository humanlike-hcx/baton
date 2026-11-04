import path from "node:path";
import { Type } from "typebox";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { CredentialStore, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { atomic, errorText, now, readJson } from "./util.ts";
import type { GatewayPublic, ModelOption, ModelPick, Thinking } from "./types.ts";

const LEVELS: Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const emptyCredentials: CredentialStore = { read: async () => undefined, list: async () => [], modify: async () => { throw new Error("Baton 不保存供应商凭据"); }, delete: async () => {} };
type Config = { url: string; token: string; models: ModelOption[] };
const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;

export class Gateway {
  private config: Config;
  private status = "未检查";
  private error?: string;
  private readonly file: string;
  constructor(home: string) {
    this.file = path.join(home, "gateway.json");
    this.config = readJson(this.file, { url: "", token: "", models: [] });
  }
  public(): GatewayPublic { return { url: this.config.url, configured: !!this.config.url, hasToken: !!this.config.token, status: this.status, error: this.error, models: this.config.models }; }
  redact(value: string) { return this.config.token ? value.split(this.config.token).join("[网关凭据已隐藏]") : value; }
  configure(input: { url: string; token?: string }) {
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("请输入不含账号、查询参数的 Magpie HTTP(S) 地址");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("远程 Magpie 请使用 HTTPS");
    const base = url.href.replace(/\/+$/, "");
    const changed = this.config.url !== base || (input.token !== undefined && input.token !== this.config.token);
    this.config = { url: base, token: input.token ?? (this.config.url === base ? this.config.token : ""), models: changed ? [] : this.config.models };
    this.status = "未检查"; this.error = undefined; this.save();
  }
  private save() { atomic(this.file, JSON.stringify(this.config, null, 2), 0o600, true); }
  async refresh() {
    try {
      if (!this.config.url) throw new Error("请先配置独立运行的 Magpie 地址");
      const response = await fetch(`${this.config.url}/models`, { headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}, redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Magpie 鉴权失败，请检查网关凭据" : `Magpie 服务返回 HTTP ${response.status}`);
      const payload = await response.json() as { data?: Record<string, unknown>[] };
      if (!Array.isArray(payload.data)) throw new Error("Magpie 模型目录格式不受支持");
      this.config.models = payload.data.flatMap(raw => {
        if (typeof raw.id !== "string" || raw.tool_call !== true) return [];
        const endpoints = Array.isArray(raw.native_endpoints) ? raw.native_endpoints : [];
        const api = endpoints.includes("/v1/chat/completions") ? "openai-completions" : endpoints.includes("/v1/responses") ? "openai-responses" : undefined;
        if (!api) return [];
        const old = this.config.models.find(m => m.id === raw.id && m.api === api);
        const supported = Array.isArray(raw.reasoning_levels) ? raw.reasoning_levels : [];
        const thinking = LEVELS.filter(level => supported.includes(level) || level === "off" && supported.includes("none"));
        return [{ id: raw.id, name: String(raw.display_name ?? raw.id), api, contextWindow: positive(raw.context_window ?? raw.context_length), maxTokens: positive(raw.max_output_tokens), thinking, verified: old?.verified ?? false, verifiedAt: old?.verifiedAt } satisfies ModelOption];
      });
      this.status = "目录已连接"; this.error = undefined; this.save();
    } catch (e) {
      this.status = "连接失败";
      this.error = /fetch failed|ECONN|timeout|abort/i.test(errorText(e)) ? "无法连接 Magpie，请检查地址和服务是否运行" : this.redact(errorText(e));
      throw new Error(this.error);
    }
    return this.public();
  }
  pick(pick: ModelPick, requireVerified = true): ModelOption {
    const model = this.config.models.find(m => m.id === pick.id);
    if (!model) throw new Error("保存的模型不在当前目录，请刷新并重新选择");
    if (requireVerified && !model.verified) throw new Error("此模型尚未通过流式文本与工具调用连接测试");
    if (pick.thinking && !model.thinking.includes(pick.thinking)) throw new Error("此思考档位未经网关确认");
    return model;
  }
  normalize(pick: ModelPick): ModelPick {
    const model = this.pick(pick);
    return { id: pick.id, ...(model.thinking.length ? { thinking: pick.thinking ?? model.thinking[0] } : {}) };
  }
  async runtime() {
    const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider("baton-magpie", {
      name: "Magpie", api: "openai-completions", apiKey: "baton-gateway-only", baseUrl: this.config.url,
      models: this.config.models.map(m => ({ id: m.id, name: m.name, api: m.api, baseUrl: this.config.url, input: ["text"], reasoning: m.thinking.some(l => l !== "off"), thinkingLevelMap: Object.fromEntries(LEVELS.map(l => [l, m.thinking.includes(l) ? l : null])), contextWindow: m.contextWindow ?? 32768, maxTokens: Math.min(m.maxTokens ?? 4096, 16384), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: m.api === "openai-completions" ? { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: m.thinking.length > 0, maxTokensField: "max_tokens" } : { supportsStore: false } })),
      streamSimple: (model, context, options) => this.stream(model, context, options),
    });
    // Route every SDK request (including compaction and Responses models) through the same transport.
    for (const method of ["stream", "streamSimple", "complete", "completeSimple"] as const) {
      (runtime as unknown as Record<string, unknown>)[method] = (model: Model<string>, context: Parameters<typeof normalizeContext>[0], options?: SimpleStreamOptions) => {
        if (model.provider !== "baton-magpie") throw new Error("模型请求必须经过配置的 Magpie");
        const result = this.stream(model, normalizeContext(context), options);
        return method.startsWith("complete") ? result.result() : result;
      };
    }
    return runtime;
  }
  stream(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) {
    if (model.provider !== "baton-magpie") throw new Error("不允许绕过 Magpie");
    const selected = this.pick({ id: model.id }, false);
    const base = this.config.url;
    const gatewayFetch: typeof fetch = async (input, init) => {
      const requestUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (requestUrl.href !== `${base}/${selected.api === "openai-responses" ? "responses" : "chat/completions"}`) throw new Error("拒绝向未配置的模型地址发送请求");
      const headers = new Headers(init?.headers);
      if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`); else headers.delete("Authorization");
      const response = await fetch(input, { ...init, headers, redirect: "error" });
      if (!response.ok) return new Response(JSON.stringify({ error: { message: response.status === 401 || response.status === 403 ? "Magpie 鉴权失败" : `Magpie 请求失败（HTTP ${response.status}）` } }), { status: response.status, headers: { "content-type": "application/json" } });
      if (!response.body) throw new Error("Magpie 未返回流式响应");
      let tail = "", completed = false;
      const decoder = new TextDecoder();
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-131072);
          if (selected.api === "openai-completions" ? /data:\s*\[DONE\]/.test(tail) : /"type"\s*:\s*"response\.(completed|failed|incomplete)"/.test(tail)) completed = true;
          controller.enqueue(chunk);
        },
        flush() { if (!completed) throw new Error("Magpie 流式连接提前结束，未收到完成标记"); },
      }));
      return new Response(stream, { status: response.status, headers: response.headers });
    };
    const opts = { ...options, apiKey: "baton-gateway-only", env: {}, fetch: gatewayFetch, maxRetries: 0, timeoutMs: 120000, transport: "sse" as const };
    const fixed = { ...model, baseUrl: base, headers: undefined };
    return selected.api === "openai-responses" ? responses(fixed as Model<"openai-responses">, context, opts) : completions(fixed as Model<"openai-completions">, context, opts);
  }
  async verify(modelId: string) {
    const candidate = this.pick({ id: modelId }, false);
    const runtime = await this.runtime();
    const model = runtime.getModel("baton-magpie", modelId)!;
    const signal = AbortSignal.timeout(60000);
    try {
      const context = normalizeContext({ messages: [{ role: "user", content: "Connection test. Call baton_probe with value 7 exactly once. Do not answer before calling it.", timestamp: Date.now() }], tools: [{ name: "baton_probe", description: "A harmless connection test that returns the supplied number.", parameters: Type.Object({ value: Type.Number() }) }] });
      const stream = this.stream(model, context, { signal, maxTokens: 2048, reasoning: candidate.thinking.includes("low") ? "low" : undefined });
      let streamed = false; for await (const event of stream) if (event.type === "toolcall_delta") streamed = true;
      const reply = await stream.result();
      const call = reply.content.find(c => c.type === "toolCall");
      if (!streamed || !call || call.name !== "baton_probe" || call.arguments.value !== 7 || reply.stopReason !== "toolUse") throw new Error("网关未返回预期的流式工具调用");
      const finish = this.stream(model, normalizeContext({ messages: [...context.messages, reply, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "Probe succeeded: 7. Reply BATON_OK." }], isError: false, timestamp: Date.now() }] }), { signal, maxTokens: 2048, reasoning: candidate.thinking.includes("low") ? "low" : undefined });
      let text = ""; for await (const event of finish) if (event.type === "text_delta") text += event.delta;
      const final = await finish.result();
      if (!text.includes("BATON_OK") || final.stopReason !== "stop") throw new Error("工具结果回传后的流式回复未通过");
      candidate.verified = true; candidate.verifiedAt = now(); candidate.error = undefined;
    } catch (e) { candidate.verified = false; candidate.error = this.redact(errorText(e)); throw new Error(candidate.error); }
    finally { this.save(); }
    return candidate;
  }
}
