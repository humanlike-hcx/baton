import type { WorkspaceSettings } from "./types.ts";

export const RULE_FILES: Record<string, string> = {
  "base.md": `# 工作台共用规则

你是工作台里的一个模型。用户在对话里可以随时换模型，所有模型共用同一个工作区、同一套上下文和记忆。

## 共享状态
- 房间上下文用 \`read_context\` 读、\`update_context\` 改，只记目标、约束、当前状态这类长期有效的内容。
- 事实、决定、偏好用 \`remember\` 写入记忆；写之前先 \`memory_search\`，已有相近条目就不要重复写。
- 踩过的坑用 \`record_lesson\` 记下来，写清怎么复现。
- 不要直接编辑 \`.baton/\` 下的文件，用对应的工具。

## 工作方式
- 先读再改，改动保持小而完整。
- 命令失败时看退出码和 stderr，不要猜。
- 不确定的地方直接说明，不要自己编。
- 用中文回复。
`,
  "role-chat.md": `# 角色：对话
- 你在和用户直接对话：回答问题、讨论方案、读代码，需要时改文件。
- 能做什么以任务卡里的「权限」为准：只读时不能改文件、不能执行命令；「每次问我」时每次改动和命令都要用户确认；「允许直接改」时可以直接改。工作台在你开始前自动快照，用户随时可以回滚。
- 前面的对话在「对话摘要与最近几轮」里，其中有些回复可能来自别的模型，接着往下聊即可，不要重复已经说过的内容。
- 对话里形成的事实、决定、偏好，用 \`remember\` 写进共享记忆（先 \`memory_search\` 查重），其他对话和模型都能用上。
`,
  "role-review.md": `# 角色：检查
- 用户请你检查这个对话里的改动。你只读，不改文件、不执行命令。
- 工作台已经先跑了检查命令，结果和改动的 diff 都在任务卡里。跳过的检查不算通过。
- 逐个读改动的文件，对照用户在对话里的要求找问题：错误、遗漏、和要求不符的地方。
- 结束前必须调用一次 \`submit_review\`：没有问题写 pass，否则写 fail，并在 issues 里逐条列出问题（文件、位置、原因）。检查命令失败时不能写 pass。
`,
  "runtime-pi.md": `# 运行时：Pi
- 只能使用列出的工具，路径相对于工作区根目录。
- shell 输出过长时会截掉中间部分，退出码和 stderr 单独给出。
- 改文件用编辑工具，不要用 shell 重定向写文件。
`,
  "runtime-cursor.md": `# 运行时：Cursor
- 你在 Cursor Agent 里运行，改文件和执行命令都要经过工作台审批。
- 工作台的工具通过 MCP 服务 \`baton\` 提供：read_context、memory_search、remember、submit_review；也可以用命令行 \`baton\`。
`,
};

/** Rule files only the relay used; dropped from workspaces created before chat-first. */
export const RETIRED_RULE_FILES = ["role-plan.md", "role-implement.md", "role-advisor.md"];

export const CONTEXT_TEMPLATE = `# 房间上下文

## 目标
（这个工作区要做成什么）

## 约束
- （必须遵守的限制）

## 当前状态
- （进展到哪了）
`;

export const AGENTS_MD_BEGIN = "<!-- baton:begin -->";
export const AGENTS_MD_END = "<!-- baton:end -->";
export const AGENTS_MD_SECTION = `${AGENTS_MD_BEGIN}
## Baton

本工作区由 Baton 管理，所有模型共用以下状态：

- \`.baton/CONTEXT.md\`：房间上下文
- \`.baton/memory/\`：记忆（只追加，不覆盖）

不要直接改 \`.baton/\` 下的文件，用 \`baton\` 命令或对应的工具。
${AGENTS_MD_END}`;

export function defaultSettings(name: string): WorkspaceSettings {
  return {
    version: 1,
    name,
    checks: [],
    permissions: {
      shellAllow: ["ls", "pwd", "cat", "git status", "git diff", "git log"],
      shellDeny: ["sudo", "rm -rf /", "git push", "curl", "wget"],
      denyPaths: [".env", ".env.*", ".git/**", ".baton/shadow.git/**"],
    },
    memory: { enabled: true },
    budgets: { briefing: 24 * 1024, context: 6 * 1024 },
    approvalTimeoutSec: 300,
    cursor: { command: "agent" },
  };
}

/** The demo models: scripted, free, and only offered in the demo workspace. */
export const DEMO_MODELS = [
  { id: "demo-chat", name: "对话" },
  { id: "demo-review", name: "检查" },
];
