import { chatTurns } from "./context.ts";
import type { RelayDraft, Thread } from "./types.ts";

/** Sent to the chat agent as the user's turn when the user asks to turn the conversation into a relay. */
export const RELAY_DRAFT_PROMPT = [
  "请把我们前面讨论清楚的事整理成一个接力任务，交给接力流程（方案 → 实现 → 检查）去做。",
  "只输出一个 JSON 代码块，不要别的内容：",
  "```json",
  '{"title": "一句话标题，20 字以内", "task": "任务说明：要做什么、范围、已经定下的做法和约束", "acceptance": ["一条可以核对的验收标准"]}',
  "```",
  "验收标准写 2 到 5 条，每条都要能检查（看文件、跑命令或对照行为）。还没讨论清楚的地方写进 task 的「待确认」里，不要替我拍板。",
].join("\n");

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];

/** Reads the agent's draft: a fenced JSON block, or the outermost JSON object in the reply. */
export function parseRelayDraft(text: string): RelayDraft | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidates = [fenced, start >= 0 && end > start ? text.slice(start, end + 1) : undefined].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    let data: { title?: unknown; task?: unknown; acceptance?: unknown };
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }
    const title = typeof data.title === "string" ? data.title.trim() : "";
    const task = typeof data.task === "string" ? data.task.trim() : "";
    const acceptance = strings(data.acceptance);
    if (task && acceptance.length) return { title: title || task.replace(/\s+/g, " ").slice(0, 40), task, acceptance };
  }
  return undefined;
}

/** A starting point for the form when the agent could not draft one: the user's own messages. */
export function fallbackDraft(thread: Thread): RelayDraft {
  const said = chatTurns(thread)
    .map((r) => r.prompt?.trim() ?? "")
    .filter((p) => p && p !== RELAY_DRAFT_PROMPT);
  return { title: thread.title, task: said.map((p) => `- ${p}`).join("\n"), acceptance: [] };
}
