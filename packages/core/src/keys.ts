/** Wire protocols a key account can speak; the same ones Pi's own catalog uses for these services. */
export type KeyApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface KeyTemplate {
  id: string;
  label: string;
  /** Pi's built-in provider whose catalog (models, context windows, prices, thinking levels) the key uses. */
  catalog?: string;
  /** Registered under this provider id instead of the catalog's, when the catalog's id is taken by a subscription. */
  provider?: string;
  api?: KeyApi;
  baseUrl?: string;
  /** The user types (or may change) the endpoint; models come from its `/models`. */
  customUrl?: boolean;
  /** Local servers that accept any key. */
  keyless?: boolean;
  /** Only prefixes a single service issues, so detection never guesses between services. */
  prefix?: RegExp;
  hint: string;
}

export const KEY_TEMPLATES: KeyTemplate[] = [
  { id: "openai", label: "OpenAI", catalog: "openai", provider: "openai-key", api: "openai-responses", baseUrl: "https://api.openai.com/v1", prefix: /^sk-(proj|svcacct|admin)-/, hint: "sk-proj-…，按量计费，和 ChatGPT 订阅分开" },
  { id: "anthropic", label: "Anthropic（Claude）", catalog: "anthropic", prefix: /^sk-ant-/, hint: "sk-ant-…" },
  { id: "google", label: "Google Gemini", catalog: "google", prefix: /^AIza/, hint: "AIza…，在 Google AI Studio 创建" },
  { id: "deepseek", label: "DeepSeek", catalog: "deepseek", hint: "sk-…，在 platform.deepseek.com 创建" },
  { id: "moonshotai-cn", label: "Kimi（月之暗面·国内）", catalog: "moonshotai-cn", hint: "sk-…，在 platform.moonshot.cn 创建" },
  { id: "moonshotai", label: "Kimi（Moonshot·国际）", catalog: "moonshotai", hint: "sk-…，在 platform.moonshot.ai 创建" },
  { id: "zai-coding-cn", label: "智谱 GLM Coding（国内）", catalog: "zai-coding-cn", hint: "在 open.bigmodel.cn 创建" },
  { id: "zai", label: "Z.ai GLM（国际）", catalog: "zai", hint: "在 z.ai 创建" },
  { id: "qwen", label: "通义千问（阿里云百炼）", api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", hint: "sk-…，在百炼控制台创建" },
  { id: "openrouter", label: "OpenRouter", catalog: "openrouter", prefix: /^sk-or-/, hint: "sk-or-…" },
  { id: "xai", label: "xAI（Grok）", catalog: "xai", prefix: /^xai-/, hint: "xai-…" },
  { id: "mistral", label: "Mistral", catalog: "mistral", hint: "在 console.mistral.ai 创建" },
  { id: "groq", label: "Groq", catalog: "groq", prefix: /^gsk_/, hint: "gsk_…" },
  { id: "together", label: "Together AI", catalog: "together", hint: "在 api.together.ai 创建" },
  { id: "fireworks", label: "Fireworks", catalog: "fireworks", prefix: /^fw_/, hint: "fw_…" },
  { id: "minimax-cn", label: "MiniMax（国内）", catalog: "minimax-cn", hint: "在 platform.minimaxi.com 创建" },
  { id: "siliconflow", label: "硅基流动", api: "openai-completions", baseUrl: "https://api.siliconflow.cn/v1", hint: "sk-…，在 cloud.siliconflow.cn 创建" },
  { id: "ollama", label: "本地 Ollama", api: "openai-completions", baseUrl: "http://localhost:11434/v1", customUrl: true, keyless: true, hint: "本机服务，不需要 key" },
  { id: "openai-compatible", label: "其他 OpenAI 兼容服务", api: "openai-completions", customUrl: true, hint: "填服务地址（通常以 /v1 结尾）和 key" },
  { id: "anthropic-compatible", label: "其他 Anthropic 兼容服务", api: "anthropic-messages", customUrl: true, hint: "填服务地址和 key" },
];

export function keyTemplate(id: string): KeyTemplate | undefined {
  return KEY_TEMPLATES.find((t) => t.id === id);
}

/** The one template whose prefix the key carries; undefined when none or several could match. */
export function detectKeyTemplate(key: string): KeyTemplate | undefined {
  const matches = KEY_TEMPLATES.filter((t) => t.prefix?.test(key.trim()));
  return matches.length === 1 ? matches[0] : undefined;
}

/** A key account, as stored in `keys.json`. The key itself lives only in the credential store, under `provider`. */
export interface KeyAccount {
  id: string;
  template: string;
  label: string;
  /** Pi provider the account's runs use; also the credential store slot of its key. */
  provider: string;
  api?: KeyApi;
  baseUrl?: string;
  /** Endpoints without a Pi catalog: the models their `/models` listed (or the user typed). */
  models?: { id: string; name: string; contextWindow?: number }[];
  addedAt: string;
}

/** Messages from a service can quote the request; keep anything key-like out of them. */
export function maskSecrets(text: string): string {
  return text.replace(/[A-Za-z0-9_\-.]{24,}/g, "[已隐藏]").slice(0, 300);
}

/** The models an OpenAI- or Anthropic-compatible endpoint lists at `/models`. */
export async function discoverModels(input: { api: KeyApi; baseUrl: string; key: string; timeoutMs?: number }): Promise<{ id: string; name: string; contextWindow?: number }[]> {
  const url = `${input.baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> =
    input.api === "anthropic-messages" ? { "x-api-key": input.key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${input.key}` };
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(input.timeoutMs ?? 15_000) });
  } catch (error) {
    throw new Error(`连不上 ${url}：${maskSecrets((error as Error).message)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} 返回 HTTP ${res.status}：${maskSecrets(text) || "没有内容"}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} 返回的不是 JSON，地址可能不对`);
  }
  const list = (body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models;
  if (!Array.isArray(list)) throw new Error(`${url} 的返回里没有模型列表`);
  const models = list
    .map((m: { id?: unknown; name?: unknown; display_name?: unknown; context_length?: unknown; context_window?: unknown }) => {
      const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
      const name = typeof m.display_name === "string" ? m.display_name : id;
      const window = Number(m.context_length ?? m.context_window);
      return { id, name, contextWindow: Number.isFinite(window) && window > 0 ? window : undefined };
    })
    .filter((m) => m.id);
  if (!models.length) throw new Error(`${url} 没有列出任何模型`);
  return models;
}
