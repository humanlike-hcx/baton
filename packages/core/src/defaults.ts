import type { AgentCard, WorkspaceSettings } from "./types.ts";

export const RULE_FILES: Record<string, string> = {
  "base.md": `# 工作台共用规则

你是工作台里的一个 agent。多个 agent 共用同一个工作区、同一套上下文和记忆，按阶段接力：方案 → 实现 → 检查 → 完成。

## 共享状态
- 房间上下文用 \`read_context\` 读、\`update_context\` 改，只记目标、约束、当前状态这类长期有效的内容。
- 事实、决定、偏好用 \`remember\` 写入记忆；写之前先 \`memory_search\`，已有相近条目就不要重复写。
- 踩过的坑用 \`record_lesson\` 记下来，写清怎么复现。
- 不要直接编辑 \`.baton/\` 下的文件，用对应的工具。

## 交接
- 接力线程里，结束前必须调用一次 \`write_handoff\`：做了什么、改了哪些文件、还剩什么、建议下一步。
- 交接写给没看过你对话的人：写事实，不写过程。

## 工作方式
- 先读再改，改动保持小而完整。
- 命令失败时看退出码和 stderr，不要猜。
- 不确定的地方写进交接，不要自己编。
- 用中文回复。
`,
  "role-plan.md": `# 角色：方案
- 读需求、相关代码和上下文，产出可执行的方案：改哪些文件、怎么改、怎么验证。
- 不改代码。
- 方案定了之后调用 \`handoff_to\`，附上可检验的验收标准。验收标准只能更具体，不能放宽。

## 调度规则
- 你只提议目标阶段，由工作台决定交给哪个 agent。
- 允许的去向：implement（实现）；不需要改代码时可以直接 review（检查）。
`,
  "role-implement.md": `# 角色：实现
- 按交接里的方案和验收标准改代码，改完自己跑一遍相关命令。
- 只做本线程要求的事。发现方案有问题，写进交接的「还剩什么」，不要擅自扩大范围。
- 交接里列出改动的文件，写清楚怎么验证。
`,
  "role-review.md": `# 角色：检查
- 工作台已经先跑了检查命令，结果在任务卡里。跳过的检查不算通过。
- 逐条对照验收标准读改动的文件，必要时跑命令验证。
- 不改代码。
- 在 \`write_handoff\` 里给出 verdict：全部满足写 pass，否则写 fail，并在 issues 里逐条列出问题（文件、位置、原因）。
`,
  "role-advisor.md": `# 角色：顾问
- 你在干净的上下文里只读工作，不改任何文件。
- 输入是一张请教卡：机械事实、对方的判断、对方希望听到的答案。
- 先核对事实，再评价判断，不要顺着对方希望的答案说。
- 输出三段：结论（一句话）、理由、建议的下一步。
`,
  "role-chat.md": `# 角色：对话
- 你在和用户直接对话：回答问题、讨论方案、读代码。不需要验收标准，也不参与接力。
- 默认只读。任务卡写明「写权限：已开放」时才能改文件和执行命令；工作台会在你开始前自动快照，用户随时可以回滚。
- 前面的对话在「对话摘要与最近几轮」里，其中有些回复可能来自别的 agent，接着往下聊即可，不要重复已经说过的内容。
- 对话里形成的事实、决定、偏好，用 \`remember\` 写进共享记忆（先 \`memory_search\` 查重），其他线程和 agent 都能用上。
- 不需要写交接，工作台会根据你的回复自动记录。
`,
  "runtime-pi.md": `# 运行时：Pi
- 只能使用列出的工具，路径相对于工作区根目录。
- shell 输出过长时会截掉中间部分，退出码和 stderr 单独给出。
- 改文件用编辑工具，不要用 shell 重定向写文件。
`,
  "runtime-cursor.md": `# 运行时：Cursor
- 你在 Cursor Agent 里运行，改文件和执行命令都要经过工作台审批。
- 工作台的工具通过 MCP 服务 \`baton\` 提供：read_context、memory_search、remember、write_handoff；也可以用命令行 \`baton\`。
- 结束前必须调用 \`write_handoff\`。
`,
};

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

本工作区由 Baton 管理，多个 agent 共用以下状态：

- \`.baton/CONTEXT.md\`：房间上下文
- \`.baton/memory/\`：记忆（只追加，不覆盖）
- \`.baton/handoffs/\`：交接记录

结束一次工作前写交接（\`write_handoff\` 工具或 \`baton handoff\` 命令）。不要直接改 \`.baton/\` 下的文件。
${AGENTS_MD_END}`;

export function defaultSettings(name: string): WorkspaceSettings {
  return {
    version: 1,
    name,
    checks: [],
    limits: {
      maxHops: 6,
      maxSendBacks: 2,
      maxStalls: 2,
      deepseekCnyPerThread: 5,
      chatgptRunsPerThread: 20,
      cursorRunsPerThread: 20,
    },
    confirm: { planToImplement: true, complete: true },
    advisor: { onSecondSendBack: true, onRepeatedIssues: true, beforePlan: false },
    permissions: {
      exec: "ask",
      network: "ask",
      shellAllow: ["ls", "pwd", "cat", "git status", "git diff", "git log"],
      shellDeny: ["sudo", "rm -rf /", "git push", "curl", "wget"],
      denyPaths: [".env", ".env.*", ".git/**", ".baton/shadow.git/**"],
    },
    memory: { enabled: true },
    budgets: { planner: 24 * 1024, executor: 12 * 1024, context: 6 * 1024 },
    approvalTimeoutSec: 300,
    cursor: { command: "agent" },
  };
}

const readOnly = { write: "deny", exec: "deny", network: "deny" } as const;
const reviewer = { write: "deny", exec: "ask", network: "deny" } as const;
const writer = { write: "allow", exec: "ask", network: "deny" } as const;

export function defaultAgents(demo: boolean): AgentCard[] {
  const real: AgentCard[] = [
    {
      id: "planner-gpt",
      name: "方案 · GPT-5.5",
      runtime: "pi",
      source: "chatgpt",
      provider: "openai",
      model: "gpt-5.5",
      roles: ["plan", "advisor"],
      permissions: { ...readOnly },
      costTier: 3,
      enabled: true,
      body: "负责拆解需求、定方案和验收标准；也担任顾问。推理强，额度贵，只在需要判断方向时用。",
    },
    {
      id: "coder-deepseek",
      name: "实现 · DeepSeek V4 Pro",
      runtime: "pi",
      source: "deepseek",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      roles: ["implement"],
      permissions: { ...writer },
      costTier: 1,
      enabled: true,
      body: "负责按方案写代码。便宜，适合大量改动；复杂架构判断交给方案角色。",
    },
    {
      id: "coder-cursor-composer",
      name: "实现 · Cursor Composer",
      runtime: "cursor",
      source: "cursor",
      provider: "cursor",
      model: "composer-1",
      roles: ["implement"],
      permissions: { ...writer },
      costTier: 2,
      enabled: true,
      body: "在 Cursor Agent 里写代码，适合需要大范围检索代码库的改动。",
    },
    {
      id: "reviewer-cursor-sonnet",
      name: "检查 · Cursor Sonnet",
      runtime: "cursor",
      source: "cursor",
      provider: "cursor",
      model: "sonnet-4.5",
      roles: ["review", "advisor"],
      permissions: { ...reviewer },
      costTier: 2,
      enabled: true,
      body: "负责对照验收标准检查改动，找出问题并逐条列出。也可以担任顾问（只读）。",
    },
  ];
  const demoAgents: AgentCard[] = [
    {
      id: "demo-planner",
      name: "演示 · 方案",
      runtime: "pi",
      source: "demo",
      provider: "demo",
      model: "demo-plan",
      roles: ["plan"],
      permissions: { ...readOnly },
      costTier: 0,
      enabled: demo,
      body: "演示用的方案 agent，不消耗任何额度。",
    },
    {
      id: "demo-coder",
      name: "演示 · 实现",
      runtime: "pi",
      source: "demo",
      provider: "demo",
      model: "demo-code",
      roles: ["implement"],
      permissions: { ...writer },
      costTier: 0,
      enabled: demo,
      body: "演示用的实现 agent，会在 notes/ 下写一份笔记。",
    },
    {
      id: "demo-reviewer",
      name: "演示 · 检查",
      runtime: "pi",
      source: "demo",
      provider: "demo",
      model: "demo-review",
      roles: ["review"],
      permissions: { ...reviewer },
      costTier: 0,
      enabled: demo,
      body: "演示用的检查 agent。任务里写「退回」时第一轮会给出 fail。",
    },
    {
      id: "demo-advisor",
      name: "演示 · 顾问",
      runtime: "pi",
      source: "demo",
      provider: "demo",
      model: "demo-advise",
      roles: ["advisor"],
      permissions: { ...readOnly },
      costTier: 0,
      enabled: demo,
      body: "演示用的顾问，只读。",
    },
  ];
  return [...real, ...demoAgents];
}
