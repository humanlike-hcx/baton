import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { Role, Thread } from "../types.ts";
import { slugify } from "../util.ts";

/**
 * Scripted responses for the demo models, so the whole flow (tools, approvals, handoffs,
 * send-backs, rollback) runs without any account.
 */
export function demoScript(role: Role, thread: Thread | undefined, prompt: string): FauxResponseStep[] {
  const title = thread?.title ?? "演示任务";
  const slug = thread ? `${slugify(thread.title, 24)}-${thread.id.slice(-4)}` : "demo";
  const note = `notes/${slug}.md`;
  const acceptance = thread?.acceptance.length ? thread.acceptance : ["生成一份说明笔记"];
  const toolUse = { stopReason: "toolUse" as const };
  const wantsSendBack = /退回/.test(thread?.task ?? "") && (thread?.sendBacks ?? 0) === 0;

  if (role === "plan") {
    return [
      fauxAssistantMessage([fauxText("先看一下房间上下文和已有记忆。"), fauxToolCall("read_context", {}), fauxToolCall("memory_search", { query: title })], toolUse),
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
    steps.push(
      fauxAssistantMessage([fauxText("确认一下文件内容。"), fauxToolCall("shell", { command: `wc -l ${note}` })], toolUse),
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
