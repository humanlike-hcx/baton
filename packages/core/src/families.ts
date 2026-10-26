/**
 * Model families. One family = one access route: GPT only via ChatGPT login in Pi,
 * DeepSeek only via its API key in Pi, everything else Cursor offers via ACP.
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

/** Cursor's model list minus GPT (only via ChatGPT) and Auto (unknown family). */
export function filterCursorModels<T extends { id: string }>(models: T[]): T[] {
  return models.filter((m) => {
    const id = m.id.toLowerCase();
    if (id === "auto" || id.startsWith("auto-") || id === "default") return false;
    return modelFamily(m.id) !== "gpt";
  });
}

/** Enforces "one family, one route" on an agent card. Returns an error message, or undefined. */
export function validateAgentRoute(agent: { runtime: string; source: string; provider: string; model: string }): string | undefined {
  const family = modelFamily(agent.model, agent.provider);
  if (!agent.model.trim()) return "请选择模型";
  switch (agent.source) {
    case "chatgpt":
      if (agent.runtime !== "pi" || agent.provider !== "openai") return "ChatGPT 登录只能跑在 Pi 运行时（provider openai）";
      if (family !== "gpt") return "ChatGPT 登录只能使用 GPT 系模型";
      return undefined;
    case "deepseek":
      if (agent.runtime !== "pi" || agent.provider !== "deepseek") return "DeepSeek 只能跑在 Pi 运行时（provider deepseek）";
      if (family !== "deepseek") return "DeepSeek key 只能使用 DeepSeek 模型";
      return undefined;
    case "cursor":
      if (agent.runtime !== "cursor" || agent.provider !== "cursor") return "Cursor 登录只能跑在 Cursor 运行时";
      if (family === "gpt") return "GPT 系模型只走 ChatGPT 登录，不能通过 Cursor 使用";
      if (/^auto$/i.test(agent.model)) return "不提供 Auto：每个 agent 必须明确模型";
      return undefined;
    case "demo":
      if (agent.runtime !== "pi" || agent.provider !== "demo") return "演示模型只能跑在 Pi 运行时";
      return undefined;
    default:
      return `不支持的账号来源：${agent.source}`;
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
