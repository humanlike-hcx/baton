import path from "node:path";
import fs from "node:fs";
import { Type } from "typebox";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { CredentialStore, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { atomic, errorText, hash, now, readJson } from "./util.ts";
import type { GatewayPublic, ModelOption, ModelPick, Thinking } from "./types.ts";

const LEVELS: Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const emptyCredentials: CredentialStore = { read: async () => undefined, list: async () => [], modify: async () => { throw new Error("Baton 不保存供应商凭据"); }, delete: async () => {} };
type Config = { url: string; token: string; models: ModelOption[]; enabledModelIds?: string[]; catalogKey?: string };
type Connection = { url: string; token: string; model?: string };
const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;

export class Gateway {
  private config: Config;
  private status = "未检查";
  private error?: string;
  private readonly file: string;
  private readonly managedFile: string;
  private managed?: Connection;
  private managedText?: string;
  private managedError?: string;
  private refreshedAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private automatic = false;
  private stopped = false;
  private epoch = 0;
  private pending: string[] = [];
  private checks = new Map<string, { promise: Promise<ModelOption>; controller: AbortController }>();
  private allChecks = new Set<Promise<ModelOption>>();
  private discovery?: Promise<GatewayPublic>;
  private discoveryController?: AbortController;
  constructor(home: string, private changed: () => void = () => {}) {
    this.file = path.join(home, "gateway.json");
    this.managedFile = path.join(home, "magpie.json");
    this.config = readJson(this.file, { url: "", token: "", models: [] });
    // Keep the pre-upgrade picker as an explicit initial selection; new models stay unchecked.
    this.config.enabledModelIds ??= this.config.models.filter(m => m.verified).map(m => m.id);
    this.config.catalogKey ??= this.connectionKey(this.config);
  }
  private connection(): Connection { if (this.managedError) throw new Error(this.managedError); return this.managed ?? this.config; }
  private connectionKey(c: Connection) { return hash(JSON.stringify([c.url, c.token])); }
  public(): GatewayPublic {
    const connection = this.managed ?? this.config;
    return { url: connection.url, configured: !!connection.url, hasToken: !!connection.token, status: this.status, error: this.managedError ?? this.error, managed: !!this.managed || !!this.managedError, defaultModelId: this.managed?.model,
      models: this.config.models.map(m => ({ ...m, enabled: this.config.enabledModelIds!.includes(m.id), checkStatus: this.checks.has(m.id) ? "checking" : this.pending.includes(m.id) ? "pending" : m.verified ? "ready" : m.error ? "failed" : "pending" })) };
  }
  redact(value: string) { for (const token of [this.config.token, this.managed?.token]) if (token) value = value.split(token).join("[网关凭据已隐藏]"); return value; }
  private address(input: string) {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("请输入不含账号、查询参数的 Magpie HTTP(S) 地址");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("远程 Magpie 请使用 HTTPS");
    return url.href.replace(/\/+$/, "");
  }
  private invalidateConnection() {
    const key = this.connectionKey(this.connection());
    if (key === this.config.catalogKey) return false;
    this.epoch++; this.discoveryController?.abort(); this.discovery = undefined;
    for (const check of this.checks.values()) check.controller.abort();
    this.checks.clear();
    this.pending = []; this.config.models = []; this.config.catalogKey = key;
    this.status = "未检查"; this.error = undefined; this.save(); this.changed();
    return true;
  }
  start(canReload: () => boolean = () => true) {
    if (this.automatic) return;
    this.automatic = true;
    this.reloadManaged();
    if (!this.managedError && this.connection().url) void this.refresh().catch(() => {});
    this.timer = setInterval(() => {
      if (!canReload()) return;
      const changed = this.reloadManaged();
      if (!this.managedError && this.connection().url && (changed || Date.now() - this.refreshedAt >= 60000)) void this.refresh().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  private reloadManaged() {
    try {
      const text = fs.existsSync(this.managedFile) ? fs.readFileSync(this.managedFile, "utf8") : "";
      if (text === this.managedText && !this.managedError) return false;
      const value = text ? JSON.parse(text) : {};
      let managed: Connection | undefined;
      if (value.enabled === true) {
        if (typeof value.gateway?.url !== "string" || typeof value.gateway?.key !== "string") throw new Error("Magpie 接入文件缺少连接信息");
        managed = { url: this.address(value.gateway.url), token: value.gateway.key, model: typeof value.model === "string" ? value.model : undefined };
      }
      const recovered = !!this.managedError;
      this.managedError = undefined; this.managed = managed; this.managedText = text;
      const changed = this.invalidateConnection(); this.changed(); return changed || recovered;
    } catch {
      if (!this.managedError) { this.managedError = "无法读取 Magpie 接入配置，请在 Magpie 中重新连接 Baton"; this.changed(); }
      return false;
    }
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.pending = [];
    this.discoveryController?.abort();
    for (const check of this.checks.values()) check.controller.abort();
    await Promise.allSettled([...this.allChecks, ...(this.discovery ? [this.discovery] : [])]);
  }
  selectModels(ids: unknown) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("模型选择格式无效");
    const next = [...new Set(ids)] as string[];
    for (const id of next) if (!this.config.models.some(m => m.id === id && (m.verified || this.config.enabledModelIds!.includes(id)))) throw new Error("只能选择已检测可用的模型");
    this.config.enabledModelIds = next; this.save(); this.changed(); return this.public();
  }
  retry(modelId: string) {
    const candidate = this.pick({ id: modelId }, false);
    if (!this.checks.has(modelId)) { candidate.error = undefined; candidate.checkedAt = undefined; this.enqueue([modelId]); }
    return this.public();
  }
  private enqueue(ids: string[]) {
    for (const id of ids) if (!this.pending.includes(id) && !this.checks.has(id)) this.pending.push(id);
    this.pump(); this.changed();
  }
  private pump() {
    while (!this.stopped && this.checks.size < 2 && this.pending.length) {
      const id = this.pending.shift()!;
      if (this.config.models.some(m => m.id === id)) void this.verify(id).catch(() => {});
    }
  }
  configure(input: { url: string; token?: string }) {
    if (this.managed) throw new Error("连接由 Magpie 管理，请在那里修改或关闭接入");
    const base = this.address(input.url);
    this.config = { ...this.config, url: base, token: input.token ?? (this.config.url === base ? this.config.token : "") };
    this.invalidateConnection(); this.save(); this.changed();
    if (this.automatic) void this.refresh().catch(() => {});
  }
  private save() { atomic(this.file, JSON.stringify(this.config, null, 2), 0o600, true); }
  refresh(): Promise<GatewayPublic> {
    if (this.managedError) return Promise.reject(new Error(this.managedError));
    if (this.discovery) return this.discovery;
    this.refreshedAt = Date.now();
    const controller = new AbortController();
    this.discoveryController = controller;
    const task = this.discover(this.epoch, { ...this.connection() }, controller.signal);
    this.discovery = task;
    void task.finally(() => { if (this.discovery === task) this.discovery = undefined; }).catch(() => {});
    return task;
  }
  private async discover(epoch: number, connection: Connection, signal: AbortSignal) {
    try {
      if (!connection.url) throw new Error("请先配置独立运行的 Magpie 地址");
      const response = await fetch(`${connection.url}/models`, { headers: { ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}), "User-Agent": "Baton" }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Magpie 鉴权失败，请检查网关凭据" : `Magpie 服务返回 HTTP ${response.status}`);
      const payload = await response.json() as { data?: Record<string, unknown>[] };
      if (!Array.isArray(payload.data)) throw new Error("Magpie 模型目录格式不受支持");
      if (epoch !== this.epoch || this.stopped) return this.public();
      this.config.models = payload.data.flatMap(raw => {
        if (typeof raw.id !== "string" || raw.tool_call !== true) return [];
        const endpoints = Array.isArray(raw.native_endpoints) ? raw.native_endpoints : [];
        const api = endpoints.includes("/v1/chat/completions") ? "openai-completions" : endpoints.includes("/v1/responses") ? "openai-responses" : undefined;
        if (!api) return [];
        const old = this.config.models.find(m => m.id === raw.id && m.api === api);
        const supported = Array.isArray(raw.reasoning_levels) ? raw.reasoning_levels : [];
        const thinking = LEVELS.filter(level => supported.includes(level) || level === "off" && supported.includes("none"));
        const fastMode = Array.isArray(raw.service_tiers) && raw.service_tiers.some(tier => tier !== null && typeof tier === "object" && tier.id === "priority");
        return [Object.assign(old ?? { verified: false }, { id: raw.id, name: String(raw.display_name ?? raw.id), api, contextWindow: positive(raw.context_window ?? raw.context_length), maxTokens: positive(raw.max_output_tokens), thinking, fastMode }) as ModelOption];
      });
      this.status = "目录已连接"; this.error = undefined; this.save();
      if (this.automatic) this.enqueue(this.config.models.filter(m => !m.verified && !m.error && !m.checkedAt).map(m => m.id));
    } catch (e) {
      if (epoch !== this.epoch || this.stopped) return this.public();
      this.status = "连接失败";
      this.error = /fetch failed|ECONN|timeout|abort/i.test(errorText(e)) ? "无法连接 Magpie，请检查地址和服务是否运行" : this.redact(errorText(e));
      throw new Error(this.error);
    } finally { this.changed(); }
    return this.public();
  }
  pick(pick: ModelPick, requireVerified = true): ModelOption {
    const model = this.config.models.find(m => m.id === pick.id);
    if (!model) throw new Error("保存的模型不在当前目录，请刷新并重新选择");
    if (requireVerified && !model.verified) throw new Error("此模型尚未通过流式文本与工具调用连接测试");
    if (pick.thinking && !model.thinking.includes(pick.thinking)) throw new Error("此思考档位未经网关确认");
    if (pick.serviceTier !== undefined && (pick.serviceTier !== "priority" || !model.fastMode)) throw new Error("此模型的快速模式未经网关确认，请关闭快速模式或重新选择模型");
    return model;
  }
  normalize(pick: ModelPick): ModelPick {
    const model = this.pick(pick);
    return { id: pick.id, ...(model.thinking.length ? { thinking: pick.thinking ?? model.thinking[0] } : {}), ...(pick.serviceTier ? { serviceTier: pick.serviceTier } : {}) };
  }
  async runtime(pick?: ModelPick) {
    if (pick) this.pick(pick, false);
    // Capture per-session selection so parallel conversations never share a tier setting.
    const serviceTier = pick?.serviceTier;
    const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider("baton-magpie", {
      name: "Magpie", api: "openai-completions", apiKey: "baton-gateway-only", baseUrl: this.connection().url,
      models: this.config.models.map(m => ({ id: m.id, name: m.name, api: m.api, baseUrl: this.connection().url, input: ["text"], reasoning: m.thinking.some(l => l !== "off"), thinkingLevelMap: Object.fromEntries(LEVELS.map(l => [l, m.thinking.includes(l) ? l : null])), contextWindow: m.contextWindow ?? 32768, maxTokens: Math.min(m.maxTokens ?? 4096, 16384), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: m.api === "openai-completions" ? { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: m.thinking.length > 0, maxTokensField: "max_tokens" } : { supportsStore: false } })),
      streamSimple: (model, context, options) => this.stream(model, context, options, serviceTier),
    });
    // Route every SDK request (including compaction and Responses models) through the same transport.
    for (const method of ["stream", "streamSimple", "complete", "completeSimple"] as const) {
      (runtime as unknown as Record<string, unknown>)[method] = (model: Model<string>, context: Parameters<typeof normalizeContext>[0], options?: SimpleStreamOptions) => {
        if (model.provider !== "baton-magpie") throw new Error("模型请求必须经过配置的 Magpie");
        const result = this.stream(model, normalizeContext(context), options, serviceTier);
        return method.startsWith("complete") ? result.result() : result;
      };
    }
    return runtime;
  }
  stream(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions, serviceTier?: ModelPick["serviceTier"]) {
    if (model.provider !== "baton-magpie") throw new Error("不允许绕过 Magpie");
    const selected = this.pick({ id: model.id, serviceTier }, false);
    const { url: base, token } = this.connection();
    const gatewayFetch: typeof fetch = async (input, init) => {
      const requestUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (requestUrl.href !== `${base}/${selected.api === "openai-responses" ? "responses" : "chat/completions"}`) throw new Error("拒绝向未配置的模型地址发送请求");
      const headers = new Headers(init?.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`); else headers.delete("Authorization");
      headers.set("User-Agent", "Baton");
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
    const opts: SimpleStreamOptions = { ...options, apiKey: "baton-gateway-only", env: {}, fetch: gatewayFetch, maxRetries: 0, timeoutMs: 120000, transport: "sse", onPayload: async (payload, model) => {
      const value = await options?.onPayload?.(payload, model) ?? payload;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型请求参数格式无效");
      const request = { ...value } as Record<string, unknown>;
      // Both supported protocols accept service_tier. The user selection is authoritative.
      delete request.service_tier;
      if (serviceTier) request.service_tier = serviceTier;
      return request;
    } };
    const fixed = { ...model, baseUrl: base, headers: undefined };
    return selected.api === "openai-responses" ? responses(fixed as Model<"openai-responses">, context, opts) : completions(fixed as Model<"openai-completions">, context, opts);
  }
  verify(modelId: string): Promise<ModelOption> {
    const running = this.checks.get(modelId);
    if (running) return running.promise;
    if (this.stopped) return Promise.reject(new Error("应用正在退出"));
    const controller = new AbortController();
    const promise = this.probe(modelId, controller.signal, this.epoch);
    const job = { promise, controller };
    this.checks.set(modelId, job); this.allChecks.add(promise); this.changed();
    void promise.finally(() => {
      if (this.checks.get(modelId) === job) this.checks.delete(modelId);
      this.allChecks.delete(promise); this.changed(); this.pump();
    }).catch(() => {});
    return promise;
  }
  private async probe(modelId: string, cancellation: AbortSignal, epoch: number) {
    const candidate = this.pick({ id: modelId }, false);
    const current = () => epoch === this.epoch && !this.stopped && this.config.models.includes(candidate);
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(60000)]);
    try {
      const runtime = await this.runtime();
      signal.throwIfAborted();
      const model = runtime.getModel("baton-magpie", modelId)!;
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
      if (current()) { candidate.verified = true; candidate.verifiedAt = now(); candidate.error = undefined; }
    } catch (e) {
      const message = this.redact(errorText(e));
      if (current()) { candidate.verified = false; candidate.error = message; }
      throw new Error(message);
    } finally { if (current()) { candidate.checkedAt = now(); this.save(); } }
    return candidate;
  }
}
