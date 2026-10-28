import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { Role } from "../types.ts";

export const DEMO_CONTEXT_WINDOW = 128_000;

/** Scripted responses for the demo models, so chat, tools, approvals, review and rollback run without any account. */
export function demoScript(role: Role, prompt: string, briefing = ""): FauxResponseStep[] {
  return role === "review" ? demoReview(briefing) : demoChat(prompt, briefing);
}

/**
 * Reads the first changed file, then fails when a check failed or the diff still has a TODO.
 *「放过检查」in the request makes it ignore the checks, as a careless reviewer would.
 */
function demoReview(briefing: string): FauxResponseStep[] {
  const toolUse = { stopReason: "toolUse" as const };
  const files = [...(briefing.split("## 改动的文件")[1] ?? "").matchAll(/^- (\S+)/gm)].map((m) => m[1]!);
  const checkFailed = /^- .+：(失败|出错|跳过)/m.test(briefing) && !briefing.includes("放过检查");
  const todo = /^\+.*TODO/m.test(briefing);
  const issues = [
    ...(checkFailed ? ["有检查命令没有通过，先修好再检查。"] : []),
    ...(todo ? [`${files[0] ?? "改动"} 里还留着 TODO。`] : []),
  ];
  const verdict = issues.length ? "fail" : "pass";
  return [
    fauxAssistantMessage(
      files.length
        ? [fauxText("检查命令已经跑过，我再读一遍改动。"), fauxToolCall("read_file", { path: files[0]! })]
        : [fauxText("这个对话里还没有改动，看看上下文。"), fauxToolCall("read_context", {})],
      toolUse,
    ),
    fauxAssistantMessage([fauxToolCall("submit_review", { verdict, issues })], toolUse),
    fauxAssistantMessage(verdict === "pass" ? "（演示检查）没发现问题，结论：通过。" : "（演示检查）有问题没解决，结论：不通过。"),
  ];
}

/** One-off completions in the demo; today only the context tidier asks. */
export function demoComplete(prompt: string): string {
  const context = /<context>\n([\s\S]*)\n<\/context>/.exec(prompt)?.[1];
  return context === undefined ? "（演示模型）" : demoTidy(context);
}

/**
 * Drops repeated lines and moves long bullets (details) into memory, keeping headings that still
 * have content.「不按格式」in the context makes it answer in prose instead.
 */
function demoTidy(context: string): string {
  if (context.includes("不按格式")) return "（演示整理员）我觉得可以把细节挪到记忆里，但这次先不给结果。";
  const seen = new Set<string>();
  const kept: string[] = [];
  const memories: { kind: "fact"; text: string }[] = [];
  let duplicates = 0;
  for (const line of context.split("\n")) {
    const key = line.trim().replace(/^[-*]\s*/, "");
    if (key && !line.trim().startsWith("#")) {
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
    }
    if (/^\s*[-*]\s/.test(line) && key.length > 40) memories.push({ kind: "fact", text: key });
    else kept.push(line);
  }
  const lines = kept.filter((line, i) => !(line.startsWith("#") && (kept.slice(i + 1).find((l) => l.trim()) ?? "#").startsWith("#") && i > 0));
  const tidied = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const result = { context: tidied, memories, summary: `合并了 ${duplicates} 行重复内容，把 ${memories.length} 条细节移进了记忆。` };
  return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

/**
 * Demo chat: quotes the previous user turn from its own briefing (so switching models visibly
 * carries the conversation over), and reacts to「记住：」「写进上下文：」「查记忆：」「写文件：」.
 */
function demoChat(prompt: string, briefing: string): FauxResponseStep[] {
  const toolUse = { stopReason: "toolUse" as const };
  const recent = briefing.split("## 最近几轮原文")[1] ?? "";
  const previous = recent.split("### 用户\n").slice(-1)[0]?.split("\n\n### ")[0]?.trim();
  const said = `你说「${prompt.trim().slice(0, 60)}」`;
  const reply = previous && recent ? `（演示对话）接着前面的话题：上一轮用户说「${previous.slice(0, 60)}」。这一轮${said}。` : `（演示对话）收到，${said}。`;

  const memo = /记住[:：]\s*(.+)/.exec(prompt)?.[1]?.trim();
  if (memo) {
    return [
      fauxAssistantMessage([fauxText("先写进共享记忆。"), fauxToolCall("remember", { kind: "fact", text: memo })], toolUse),
      fauxAssistantMessage(`${reply}\n\n已经记下：${memo}`),
    ];
  }
  const convention = /写进上下文[:：]\s*(.+)/.exec(prompt)?.[1]?.trim();
  if (convention) {
    return [
      fauxAssistantMessage([fauxText("这条是长期约定，写进房间上下文。"), fauxToolCall("update_context", { content: `# 房间上下文\n\n## 约定\n- ${convention}\n` })], toolUse),
      fauxAssistantMessage(`${reply}\n\n已经写进房间上下文。`),
    ];
  }
  const query = /查记忆[:：]\s*(.+)/.exec(prompt)?.[1]?.trim();
  if (query) {
    return [
      fauxAssistantMessage([fauxToolCall("memory_search", { query })], toolUse),
      fauxAssistantMessage(`${reply}\n\n查过共享记忆了，结果见上面的工具输出。`),
    ];
  }
  const target = /写文件[:：]\s*(\S+)/.exec(prompt)?.[1];
  if (target) {
    return [
      fauxAssistantMessage([fauxText(`试着写 ${target}。`), fauxToolCall("write_file", { path: target, content: `# 对话里写的文件\n\n${prompt.trim()}\n` })], toolUse),
      fauxAssistantMessage([fauxToolCall("shell", { command: "node --version" })], toolUse),
      fauxAssistantMessage(`${reply}\n\n写文件的结果见上面的工具调用。`),
    ];
  }
  return [fauxAssistantMessage(reply)];
}
