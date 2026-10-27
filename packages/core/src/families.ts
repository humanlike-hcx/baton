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

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** GPT-5.6 and GPT-6 can run in OpenAI fast mode: the same model and effort, on the fast service tier. */
export function supportsFastTier(modelId: string): boolean {
  return /^(gpt-5\.6|gpt-6)([.-]|$)/.test(modelId);
}

const THINKING_LABELS: Record<string, string> = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };

export function thinkingLabel(level: string | undefined): string {
  return level ? (THINKING_LABELS[level] ?? level) : "默认";
}

/**
 * The levels a model can actually be asked for. A catalog map marks an unsupported level `null`.
 * `xhigh` and `max` count only when the map names them. A level that sends the same value as
 * another (Codex maps `minimal` to `low`) is not listed again. No map means the ordinary levels,
 * not the extended ones.
 */
export function distinctThinkingLevels(
  reasoning: boolean,
  map?: Partial<Record<(typeof THINKING_LEVELS)[number], string | null>>,
): ThinkingLevelName[] | undefined {
  if (!reasoning) return undefined;
  const supported = new Map<ThinkingLevelName, string>();
  for (const level of THINKING_LEVELS) {
    const mapped = map?.[level];
    if (mapped === null) continue;
    if ((level === "xhigh" || level === "max") && mapped === undefined) continue;
    supported.set(level, mapped ?? level);
  }
  const chosen: ThinkingLevelName[] = [];
  const used = new Set<string>();
  for (const level of THINKING_LEVELS) {
    const wire = supported.get(level);
    if (!wire || used.has(wire)) continue;
    const canonName = wire === "none" ? "off" : wire;
    const canon = (THINKING_LEVELS as readonly string[]).includes(canonName) && supported.has(canonName as ThinkingLevelName) ? (canonName as ThinkingLevelName) : level;
    if (level !== canon) continue;
    used.add(wire);
    chosen.push(canon);
  }
  return chosen.some((level) => level !== "off") ? chosen : undefined;
}

/** A stored level the model no longer lists (an alias, or nothing picked) shown as the level that actually runs. */
export function normalizeThinkingLevel(level: string | undefined, levels: readonly string[]): ThinkingLevelName | undefined {
  if (level && levels.includes(level)) return level as ThinkingLevelName;
  if (level === "minimal" && levels.includes("low")) return "low";
  if ((level === "none" || level === "off") && levels.includes("off")) return "off";
  return defaultThinkingLevel(levels);
}

/** What runs when a chat has not picked a level: Pi's own default is medium, clamped to a level the model has. */
export function defaultThinkingLevel(levels: readonly string[]): ThinkingLevelName | undefined {
  const order: ThinkingLevelName[] = [...THINKING_LEVELS];
  const has = (level: ThinkingLevelName) => levels.includes(level);
  const start = order.indexOf("medium");
  for (let i = start; i < order.length; i++) if (has(order[i]!)) return order[i];
  for (let i = start - 1; i >= 0; i--) if (has(order[i]!)) return order[i];
  return undefined;
}

type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** One of the variants Cursor lists a model as: its effort, whether it thinks, whether it's the fast one. */
export interface CursorVariant {
  /** Id without the variant suffixes; variants with the same base are one model. */
  base: string;
  /** Display name without the variant words. */
  baseName: string;
  effort?: string;
  reasoning: boolean;
  fast: boolean;
}

const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/;
const NAME_WORDS = /\s+(Fast|No Thinking|Thinking|Minimal|Low|Medium|High|Extra High|Max)$/i;

/** Splits a Cursor model id like `claude-opus-5-thinking-high-fast` or `claude-4.6-opus-high-thinking` into base and variant. */
export function cursorVariant(id: string, name: string): CursorVariant {
  let rest = id;
  let effort: string | undefined;
  let reasoning = false;
  let fast = false;
  for (;;) {
    if (!fast && rest.endsWith("-fast")) {
      fast = true;
      rest = rest.slice(0, -5);
    } else if (!reasoning && rest.endsWith("-thinking")) {
      reasoning = true;
      rest = rest.slice(0, -9);
    } else if (!effort && EFFORT_SUFFIX.test(rest)) {
      effort = EFFORT_SUFFIX.exec(rest)![1];
      rest = rest.replace(EFFORT_SUFFIX, "");
    } else break;
  }
  const clean = name.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
  const note = /\s*(\([^)]*\))$/.exec(clean)?.[1];
  let baseName = note ? clean.slice(0, -note.length).trim() : clean;
  while (NAME_WORDS.test(baseName)) baseName = baseName.replace(NAME_WORDS, "");
  return { base: rest || id, baseName: note ? `${baseName} ${note}` : baseName, effort, reasoning, fast };
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
