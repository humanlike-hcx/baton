import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { RELAY_DRAFT_PROMPT } from "../promote.ts";
import type { Role, Thread } from "../types.ts";
import { slugify } from "../util.ts";

export const DEMO_CONTEXT_WINDOW = 128_000;

/** A task that mentions「压缩」makes the demo compact after a few hundred tokens instead of near the window. */
function wantsCompaction(thread: Thread | undefined): boolean {
  return /压缩/.test(thread?.task ?? "");
}

export function demoSettings(thread: Thread | undefined): Record<string, unknown> {
  return wantsCompaction(thread) ? { compaction: { reserveTokens: DEMO_CONTEXT_WINDOW - 300, keepRecentTokens: 120 } } : {};
}

/** Pi's compaction request: a single user message wrapping the serialized conversation. */
function summaryRequest(messages: { role: string; content?: unknown }[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== "user") return undefined;
  const text = Array.isArray(last.content) ? last.content.map((c: { text?: string }) => c.text ?? "").join("") : String(last.content ?? "");
  return text.startsWith("<conversation>") || text.startsWith("# Conversation\n") ? text : undefined;
}

/**
 * Serves the script in order, but answers Pi's compaction requests (which arrive through the same
 * model, whenever Pi decides to compact) with a summary instead of consuming a script step.
 */
function withSummaries(steps: FauxResponseStep[], summary: (prompt: string) => string): FauxResponseStep[] {
  const queue = [...steps];
  const serve: FauxResponseStep = (context, options, state, model) => {
    const request = summaryRequest(context.messages);
    if (request !== undefined) return fauxAssistantMessage(summary(request));
    const next = queue.shift() ?? fauxAssistantMessage("（演示脚本已结束）");
    return typeof next === "function" ? next(context, options, state, model) : next;
  };
  return Array.from({ length: steps.length + 6 }, () => serve);
}

/**
 * Scripted responses for the demo models, so the whole flow (tools, approvals, handoffs,
 * send-backs, rollback, compaction) runs without any account.
 */
export function demoScript(role: Role, thread: Thread | undefined, prompt: string, briefing = ""): FauxResponseStep[] {
  if (role === "chat") return demoChat(prompt, briefing);
  const title = thread?.title ?? "演示任务";
  const slug = thread ? `${slugify(thread.title, 24)}-${thread.id.slice(-4)}` : "demo";
  const note = `notes/${slug}.md`;
  const summary = (request: string) =>
    /## Progress So Far/.test(request)
      ? [`## Original Request`, title, "", "## Progress So Far", `- 创建了 ${note}，写好了背景和做法`, "", "## Context Needed to Continue", `- 产出在 ${note}`].join("\n")
      : [
          "## Goal",
          title,
          "",
          "## Progress",
          "### Done",
          `- [x] 创建了 ${note}，写好了背景和做法`,
          "",
          "### In Progress",
          `- [ ] 核对 ${note} 的内容`,
          "",
          "## Next Steps",
          "1. 交给检查阶段对照验收标准核对",
        ].join("\n");
  return withSummaries(relayScript(role, thread, prompt, title, note), summary);
}

function relayScript(role: Role, thread: Thread | undefined, prompt: string, title: string, note: string): FauxResponseStep[] {
  const acceptance = thread?.acceptance.length ? thread.acceptance : ["生成一份说明笔记"];
  const toolUse = { stopReason: "toolUse" as const };
  const wantsSendBack = /退回/.test(thread?.task ?? "") && (thread?.sendBacks ?? 0) === 0;

  if (role === "plan") {
    const convention = /写进上下文[:：]\s*(.+)/.exec(thread?.task ?? "")?.[1]?.trim();
    return [
      fauxAssistantMessage([fauxText("先看一下房间上下文和已有记忆。"), fauxToolCall("read_context", {}), fauxToolCall("memory_search", { query: title })], toolUse),
      ...(convention
        ? [fauxAssistantMessage([fauxText("这条是长期约定，写进房间上下文。"), fauxToolCall("update_context", { content: `# 房间上下文\n\n## 约定\n- ${convention}\n` })], toolUse)]
        : []),
      fauxAssistantMessage(
        [
          fauxText(`方案：在 \`${note}\` 写一份说明，包含背景、做法和验证方式；检查阶段逐条对照验收标准。`),
          fauxToolCall("remember", { kind: "decision", text: `线程「${title}」的产出写在 ${note}。` }),
          fauxToolCall("handoff_to", { stage: "implement", reason: "方案已定，可以开始实现", acceptance }),
        ],
        toolUse,
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("write_handoff", {
            done: `定了方案：产出写在 ${note}，分为背景、做法、验证方式三节。`,
            files: [],
            remaining: "尚未开始实现。",
            next: `实现阶段创建 ${note}。`,
          }),
        ],
        toolUse,
      ),
      fauxAssistantMessage("方案已经写进交接，等工作台安排实现。"),
    ];
  }

  if (role === "implement") {
    const fixing = (thread?.sendBacks ?? 0) > 0;
    const content = [
      `# ${title}`,
      "",
      "## 背景",
      thread?.task ?? prompt.slice(0, 200),
      "",
      "## 做法",
      ...acceptance.map((a) => `- ${a}`),
      "",
    ].join("\n");
    const steps: FauxResponseStep[] = [
      fauxAssistantMessage([fauxText(fixing ? "根据检查意见补上缺的部分。" : "按方案开始实现，先看看目录。"), fauxToolCall("list_files", { path: ".", depth: 2 })], toolUse),
    ];
    if (fixing) {
      steps.push(
        fauxAssistantMessage(
          [fauxToolCall("edit_file", { path: note, old_string: "## 做法", new_string: "## 验证方式\n- 运行 `ls notes` 能看到这份笔记\n\n## 做法" })],
          toolUse,
        ),
      );
    } else {
      const withVerify = wantsSendBack ? content : `${content}\n## 验证方式\n- 运行 \`ls notes\` 能看到这份笔记\n`;
      steps.push(fauxAssistantMessage([fauxToolCall("write_file", { path: note, content: withVerify })], toolUse));
    }
    steps.push(fauxAssistantMessage([fauxText("确认一下文件内容。"), fauxToolCall("shell", { command: `wc -l ${note}` })], toolUse));
    if (wantsCompaction(thread)) {
      // Like a long run whose early turns were compacted away: the handoff only remembers the end.
      steps.push(
        fauxAssistantMessage("文件行数确认过了。"),
        fauxAssistantMessage([fauxToolCall("write_handoff", { done: `确认了 ${note} 的行数。`, files: [note], remaining: "", next: "" })], toolUse),
        fauxAssistantMessage("交接已写好。"),
      );
      return steps;
    }
    steps.push(
      fauxAssistantMessage(
        [
          fauxToolCall("write_handoff", {
            done: fixing ? `在 ${note} 补上了「验证方式」一节。` : `创建了 ${note}。`,
            files: [note],
            remaining: "无",
            next: "交给检查阶段对照验收标准核对。",
          }),
        ],
        toolUse,
      ),
      fauxAssistantMessage(`已完成：${note}。`),
    );
    return steps;
  }

  if (role === "review") {
    const verdict = wantsSendBack ? "fail" : "pass";
    const implemented = [...(thread?.runs ?? [])].reverse().find((r) => r.stage === "implement")?.changedFiles[0];
    return [
      fauxAssistantMessage([fauxText("检查命令已经跑过，我再读一遍改动。"), fauxToolCall("read_file", { path: implemented ?? note })], toolUse),
      fauxAssistantMessage(
        [
          fauxToolCall("write_handoff", {
            done: `核对了 ${note} 与验收标准。`,
            files: [],
            verdict,
            ...(verdict === "fail" ? { issues: [`${note} 缺少「验证方式」一节，读者不知道怎么确认结果。`] } : {}),
            remaining: verdict === "fail" ? "需要补上验证方式。" : "无",
            next: verdict === "fail" ? "退回实现阶段补充。" : "可以标记完成。",
          }),
        ],
        toolUse,
      ),
      fauxAssistantMessage(verdict === "pass" ? "全部验收标准都满足，结论：通过。" : "有一处没满足，结论：不通过。"),
    ];
  }

  return [
    fauxAssistantMessage(
      [
        "**结论**：先补齐验证方式，再继续推进。",
        "",
        "**理由**：请教卡里的机械事实显示，问题集中在同一处；反复退回说明验收标准与实现之间缺一条可检验的验证路径。",
        "",
        "**建议的下一步**：让实现阶段只做这一处修改，并在交接里写清怎么验证。",
      ].join("\n"),
    ),
  ];
}

/** Drafts a relay task from the user's turns in the briefing;「不按格式」in the conversation makes it answer in prose instead. */
function demoRelayDraft(briefing: string): string {
  const recent = (briefing.split("## 最近几轮原文")[1] ?? "")
    .split("### 用户\n")
    .slice(1)
    .map((turn) => turn.split("\n\n### ")[0]!.trim());
  const older = [...briefing.matchAll(/^- 用户：(.+?) → /gm)].map((m) => m[1]!.trim());
  const said = [...older, ...recent].filter((t) => t && !t.startsWith("请把我们前面讨论清楚的事"));
  if (said.some((t) => t.includes("不按格式"))) return "（演示对话）我觉得可以先写一份说明，再看看要不要拆成几步。";
  const topic = said[0]?.replace(/\s+/g, " ").slice(0, 20) || "整理对话结论";
  const draft = {
    title: topic,
    task: ["把对话里定下的事写成一份说明，放在 notes/ 下。", "", "对话要点：", ...said.map((t) => `- ${t}`)].join("\n"),
    acceptance: ["notes/ 下有一份说明，写清对话里定下的做法", "说明逐条回应了对话要点"],
  };
  return `\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\``;
}

/**
 * Demo chat: quotes the previous user turn from its own briefing (so switching agents visibly
 * carries the conversation over), and reacts to「记住：」「查记忆：」「写文件：」.
 */
function demoChat(prompt: string, briefing: string): FauxResponseStep[] {
  const toolUse = { stopReason: "toolUse" as const };
  const recent = briefing.split("## 最近几轮原文")[1] ?? "";
  const previous = recent.split("### 用户\n").slice(-1)[0]?.split("\n\n### ")[0]?.trim();
  if (prompt.trim() === RELAY_DRAFT_PROMPT) return [fauxAssistantMessage(demoRelayDraft(briefing))];
  const said = `你说「${prompt.trim().slice(0, 60)}」`;
  const reply = previous && recent ? `（演示对话）接着前面的话题：上一轮用户说「${previous.slice(0, 60)}」。这一轮${said}。` : `（演示对话）收到，${said}。`;

  const memo = /记住[:：]\s*(.+)/.exec(prompt)?.[1]?.trim();
  if (memo) {
    return [
      fauxAssistantMessage([fauxText("先写进共享记忆。"), fauxToolCall("remember", { kind: "fact", text: memo })], toolUse),
      fauxAssistantMessage(`${reply}\n\n已经记下：${memo}`),
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
      fauxAssistantMessage([fauxToolCall("shell", { command: `wc -l ${target}` })], toolUse),
      fauxAssistantMessage(`${reply}\n\n写文件的结果见上面的工具调用。`),
    ];
  }
  return [fauxAssistantMessage(reply)];
}
