import type { ChatModel, CredentialSource, RuntimeKind } from "./types.ts";

/**
 * Model families. Between the two subscriptions one family has one route: GPT only via ChatGPT
 * login in Pi, everything else Cursor offers via ACP. API key accounts may offer any family.
 */
export function modelFamily(model: string, provider?: string): string {
  const id = model.toLowerCase();
  if (provider === "demo") return id;
  if (/^(gpt|o\d|chatgpt|codex)/.test(id) || id.includes("codex")) return "gpt";
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("claude") || /^(sonnet|opus|haiku)/.test(id)) return "claude";
  if (id.includes("gemini")) return "gemini";
  if (id.includes("grok")) return "grok";
  if (id.includes("kimi")) return "kimi";
  if (id.includes("composer")) return "composer";
  if (id.includes("qwen")) return "qwen";
  return id.split(/[-_.:]/)[0] || id;
}

/** Cursor's model list minus GPT (only via ChatGPT), DeepSeek (via an API key) and Auto (unknown family). */
export function filterCursorModels<T extends { id: string }>(models: T[]): T[] {
  return models.filter((m) => {
    const id = m.id.toLowerCase();
    if (id === "auto" || id.startsWith("auto-") || id === "default") return false;
    return !["gpt", "deepseek"].includes(modelFamily(m.id));
  });
}

/** Each account route runs on one runtime; key accounts each bring their own Pi provider. */
export const ROUTES: Record<CredentialSource, { runtime: RuntimeKind; provider: string; label: string }> = {
  chatgpt: { runtime: "pi", provider: "openai", label: "ChatGPT" },
  cursor: { runtime: "cursor", provider: "cursor", label: "Cursor" },
  key: { runtime: "pi", provider: "key", label: "API key" },
  demo: { runtime: "pi", provider: "demo", label: "演示" },
};

/** The Pi provider (or "cursor") a chat model runs on. */
export function modelProvider(model: Pick<ChatModel, "source" | "provider">): string {
  return model.source === "key" ? (model.provider ?? "") : ROUTES[model.source].provider;
}

/** The account a model is on, for labels: the key account's name, or the route's. */
export function routeLabel(model: Pick<ChatModel, "source" | "account">): string {
  return model.source === "key" ? (model.account ?? ROUTES.key.label) : ROUTES[model.source].label;
}

/** Enforces "one family, one route" between the subscriptions. Returns an error message, or undefined. */
export function validateModelRoute(source: string, model: string): string | undefined {
  if (!(source in ROUTES)) return `不支持的账号来源：${source}`;
  if (!model.trim()) return "请选择模型";
  const family = modelFamily(model, ROUTES[source as CredentialSource].provider);
  switch (source) {
    case "chatgpt":
      return family === "gpt" ? undefined : "ChatGPT 登录只能使用 GPT 系模型";
    case "cursor":
      if (family === "gpt") return "GPT 系模型只走 ChatGPT 登录，不能通过 Cursor 使用";
      if (family === "deepseek") return "DeepSeek 系模型通过 API key 使用，不能通过 Cursor 使用";
      if (/^auto$/i.test(model)) return "不提供 Auto：必须明确模型";
      return undefined;
    default:
      return undefined;
  }
}

export function familyLabel(family: string): string {
  const labels: Record<string, string> = {
    gpt: "GPT",
    deepseek: "DeepSeek",
    claude: "Claude",
    gemini: "Gemini",
    grok: "Grok",
    kimi: "Kimi",
    composer: "Composer",
    qwen: "Qwen",
  };
  return labels[family] ?? family;
}
