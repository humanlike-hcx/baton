import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type, type TSchema } from "typebox";
import { modelFamily } from "./families.ts";
import { listMemory, recordLesson, remember, searchMemory } from "./memory.ts";
import { applyChunks, parsePatch } from "./patch.ts";
import { PermissionError, canWrite, matchesDeny, resolveWorkspacePath, shellPolicy } from "./permissions.ts";
import { formatShellResult, runShell } from "./shell.ts";
import { CONTEXT_MAX_BYTES } from "./tidy.ts";
import type { AgentCard, Handoff, Risk, Role, Stage } from "./types.ts";
import { byteLength, globToRegExp, truncateMiddle } from "./util.ts";
import type { Workspace } from "./workspace.ts";

export interface ToolContext {
  ws: Workspace;
  agent: AgentCard;
  run: { id: string; threadId: string; stage: Stage; role: Role };
  signal?: AbortSignal;
  requestApproval(req: { risk: Risk; title: string; preview: string }): Promise<boolean>;
  onHandoff(h: Omit<Handoff, "runId" | "threadId" | "agentId" | "stage" | "createdAt" | "auto">): void;
  onHandoffTo(p: { stage: Stage; reason: string; acceptance: string[] }): void;
  onDecision(): void;
  onFileWrite(rel: string): void;
}

export interface ToolOutput {
  text: string;
  isError?: boolean;
}

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  risk: Risk;
  mcp?: boolean;
  /** What an approval card shows before a write runs. */
  preview?(params: any, ctx: ToolContext): string;
  execute(params: any, ctx: ToolContext): Promise<ToolOutput>;
}

/** Line diff that keeps the common head and tail and shows the changed middle. */
function changePreview(rel: string, before: string | undefined, after: string): string {
  if (before === undefined) return [`新建 ${rel}`, ...after.split("\n").map((l) => `+${l}`)].join("\n");
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return [
    `--- ${rel}`,
    `+++ ${rel}`,
    `@@ 第 ${head + 1} 行 @@`,
    ...a.slice(Math.max(0, head - 2), head).map((l) => ` ${l}`),
    ...a.slice(head, a.length - tail).map((l) => `-${l}`),
    ...b.slice(head, b.length - tail).map((l) => `+${l}`),
    ...a.slice(a.length - tail, a.length - tail + 2).map((l) => ` ${l}`),
  ].join("\n");
}

function readIfExists(ctx: ToolContext, input: string): { rel: string; text?: string } {
  const { abs, rel } = resolveWorkspacePath(ctx.ws.root, input, ctx.ws.settings(), "write");
  return { rel, text: fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined };
}

const MAX_READ_BYTES = 48 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".turbo", "coverage", "shadow.git", "sessions"]);

function ok(text: string): ToolOutput {
  return { text };
}
function fail(text: string): ToolOutput {
  return { text, isError: true };
}

function walk(root: string, start: string, maxEntries: number, maxDepth: number): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (out.length >= maxEntries || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        visit(abs, depth + 1);
      } else if (e.isFile()) out.push(rel);
    }
  };
  visit(start, 0);
  return out;
}

function hasRipgrep(): boolean {
  try {
    return fs.existsSync("/usr/bin/rg") || fs.existsSync("/usr/local/bin/rg") || fs.existsSync("/opt/homebrew/bin/rg");
  } catch {
    return false;
  }
}

async function searchFiles(root: string, start: string, pattern: string, glob: string | undefined, settingsDeny: string[]): Promise<string[]> {
  if (hasRipgrep()) {
    const args = ["-n", "--no-heading", "--color=never", "-m", "20", "--max-columns=300", "-g", "!.baton/shadow.git", "-g", "!.git"];
    for (const deny of settingsDeny) args.push("-g", `!${deny}`);
    if (glob) args.push("-g", glob);
    args.push("-e", pattern, path.relative(root, start) || ".");
    return new Promise((resolve) => {
      const child = spawn("rg", args, { cwd: root });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        if (out.length < 200_000) out += d.toString("utf8");
      });
      child.on("close", () => resolve(out.split("\n").filter(Boolean).slice(0, 200)));
      child.on("error", () => resolve([]));
    });
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  const results: string[] = [];
  const globRe = glob ? globToRegExp(glob.includes("/") ? glob : `**/${glob}`) : undefined;
  for (const rel of walk(root, start, 5000, 12)) {
    if (rel.endsWith("/") || results.length >= 200) continue;
    if (globRe && !globRe.test(rel) && !globToRegExp(glob!).test(path.posix.basename(rel))) continue;
    if (matchesDeny(rel, settingsDeny)) continue;
    let text: string;
    try {
      const abs = path.join(root, rel);
      if (fs.statSync(abs).size > 1024 * 1024) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, idx) => {
      if (results.length < 200 && re.test(line)) results.push(`${rel}:${idx + 1}:${line.slice(0, 300)}`);
    });
  }
  return results;
}

function writeFile(ctx: ToolContext, rel: string, abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  ctx.onFileWrite(rel);
}

export const readFileTool: ToolSpec = {
  name: "read_file",
  label: "读文件",
  description: "读取工作区内的文本文件，返回带行号的内容。大文件请用 offset/limit 分段读取。",
  parameters: Type.Object({
    path: Type.String({ description: "相对于工作区根目录的路径" }),
    offset: Type.Optional(Type.Number({ description: "起始行号（从 1 开始）" })),
    limit: Type.Optional(Type.Number({ description: "最多读取的行数，默认 400" })),
  }),
  risk: "read",
  async execute(p: { path: string; offset?: number; limit?: number }, ctx) {
    const { abs, rel } = resolveWorkspacePath(ctx.ws.root, p.path, ctx.ws.settings(), "read");
    if (!fs.existsSync(abs)) return fail(`文件不存在：${rel}`);
    if (fs.statSync(abs).isDirectory()) return fail(`${rel} 是目录，请用 list_files`);
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    const start = Math.max(1, Math.floor(p.offset ?? 1));
    const limit = Math.min(2000, Math.max(1, Math.floor(p.limit ?? 400)));
    const slice = lines.slice(start - 1, start - 1 + limit);
    let text = slice.map((l, i) => `${String(start + i).padStart(5)}|${l}`).join("\n");
    text = truncateMiddle(text, MAX_READ_BYTES).text;
    const more = start - 1 + limit < lines.length ? `\n（共 ${lines.length} 行，用 offset=${start + limit} 继续读）` : "";
    return ok(`${rel}\n${text}${more}`);
  },
};

export const listFilesTool: ToolSpec = {
  name: "list_files",
  label: "列目录",
  description: "列出工作区内的文件和目录（跳过 .git、node_modules 等）。",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "起始目录，默认工作区根目录" })),
    depth: Type.Optional(Type.Number({ description: "递归深度，默认 3" })),
  }),
  risk: "read",
  async execute(p: { path?: string; depth?: number }, ctx) {
    const { abs, rel } = resolveWorkspacePath(ctx.ws.root, p.path ?? ".", ctx.ws.settings(), "read");
    if (!fs.existsSync(abs)) return fail(`目录不存在：${rel}`);
    const entries = walk(ctx.ws.root, abs, 500, Math.min(8, Math.max(0, (p.depth ?? 3) - 1)));
    return ok(entries.length ? entries.join("\n") + (entries.length >= 500 ? "\n…（已截断到 500 项）" : "") : "（空目录）");
  },
};

export const searchTool: ToolSpec = {
  name: "search",
  label: "搜索",
  description: "在工作区里按正则搜索文本，返回 文件:行号:内容。",
  parameters: Type.Object({
    pattern: Type.String({ description: "正则表达式" }),
    path: Type.Optional(Type.String({ description: "限定目录" })),
    glob: Type.Optional(Type.String({ description: "文件名过滤，如 *.ts" })),
  }),
  risk: "read",
  async execute(p: { pattern: string; path?: string; glob?: string }, ctx) {
    const settings = ctx.ws.settings();
    const { abs } = resolveWorkspacePath(ctx.ws.root, p.path ?? ".", settings, "read");
    const results = await searchFiles(ctx.ws.root, abs, p.pattern, p.glob, settings.permissions.denyPaths);
    return ok(results.length ? results.join("\n") : "没有匹配");
  },
};

export const editFileTool: ToolSpec = {
  name: "edit_file",
  label: "编辑文件",
  description: "把文件中的一段文本替换成新文本。old_string 必须在文件中唯一出现（或设置 replace_all）。新建文件请用 write_file。",
  parameters: Type.Object({
    path: Type.String(),
    old_string: Type.String({ description: "要替换的原文，需包含足够上下文保证唯一" }),
    new_string: Type.String({ description: "替换后的文本" }),
    replace_all: Type.Optional(Type.Boolean()),
  }),
  risk: "write",
  preview(p: { path: string; old_string: string; new_string: string; replace_all?: boolean }, ctx) {
    const { rel, text } = readIfExists(ctx, p.path);
    if (text === undefined || !p.old_string) return `${rel}\n${[...p.old_string.split("\n").map((l) => `-${l}`), ...p.new_string.split("\n").map((l) => `+${l}`)].join("\n")}`;
    return changePreview(rel, text, p.replace_all ? text.split(p.old_string).join(p.new_string) : text.replace(p.old_string, () => p.new_string));
  },
  async execute(p: { path: string; old_string: string; new_string: string; replace_all?: boolean }, ctx) {
    const { abs, rel } = resolveWorkspacePath(ctx.ws.root, p.path, ctx.ws.settings(), "write");
    if (!fs.existsSync(abs)) return fail(`文件不存在：${rel}（新建文件请用 write_file）`);
    const text = fs.readFileSync(abs, "utf8");
    if (p.old_string === "") return fail("old_string 不能为空");
    const count = text.split(p.old_string).length - 1;
    if (count === 0) return fail(`在 ${rel} 中找不到 old_string。请先 read_file 确认原文（注意空格和缩进）。`);
    if (count > 1 && !p.replace_all) return fail(`old_string 在 ${rel} 中出现了 ${count} 次，请加上更多上下文，或设置 replace_all`);
    const next = p.replace_all ? text.split(p.old_string).join(p.new_string) : text.replace(p.old_string, () => p.new_string);
    writeFile(ctx, rel, abs, next);
    return ok(`已修改 ${rel}（替换 ${p.replace_all ? count : 1} 处）`);
  },
};

export const applyPatchTool: ToolSpec = {
  name: "apply_patch",
  label: "应用补丁",
  description: [
    "用补丁格式修改文件，可以一次改多个文件。格式：",
    "*** Begin Patch",
    "*** Update File: path/to/file",
    "@@",
    " 上下文行",
    "-删除的行",
    "+新增的行",
    "*** Add File: path/to/new",
    "+新文件内容",
    "*** Delete File: path/to/old",
    "*** End Patch",
  ].join("\n"),
  parameters: Type.Object({ patch: Type.String({ description: "完整补丁文本" }) }),
  risk: "write",
  preview: (p: { patch: string }) => p.patch,
  async execute(p: { patch: string }, ctx) {
    const settings = ctx.ws.settings();
    const ops = parsePatch(p.patch);
    const planned: { rel: string; abs: string; content: string | null }[] = [];
    for (const op of ops) {
      const { abs, rel } = resolveWorkspacePath(ctx.ws.root, op.path, settings, "write");
      if (op.type === "add") {
        if (fs.existsSync(abs)) return fail(`${rel} 已存在，请用 Update File`);
        planned.push({ rel, abs, content: op.content });
      } else if (op.type === "delete") {
        if (!fs.existsSync(abs)) return fail(`要删除的文件不存在：${rel}`);
        planned.push({ rel, abs, content: null });
      } else {
        if (!fs.existsSync(abs)) return fail(`要修改的文件不存在：${rel}`);
        const content = applyChunks(fs.readFileSync(abs, "utf8"), op.chunks, rel);
        if (op.moveTo) {
          const target = resolveWorkspacePath(ctx.ws.root, op.moveTo, settings, "write");
          planned.push({ rel, abs, content: null }, { rel: target.rel, abs: target.abs, content });
        } else planned.push({ rel, abs, content });
      }
    }
    for (const item of planned) {
      if (item.content === null) {
        fs.rmSync(item.abs, { force: true });
        ctx.onFileWrite(item.rel);
      } else writeFile(ctx, item.rel, item.abs, item.content);
    }
    return ok(`补丁已应用：\n${planned.map((x) => `${x.content === null ? "删除" : "写入"} ${x.rel}`).join("\n")}`);
  },
};

export const writeFileTool: ToolSpec = {
  name: "write_file",
  label: "写文件",
  description: "新建文件或整体覆盖文件内容。修改已有文件的一部分请用编辑工具。",
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  risk: "write",
  preview(p: { path: string; content: string }, ctx) {
    const { rel, text } = readIfExists(ctx, p.path);
    return changePreview(rel, text, p.content);
  },
  async execute(p: { path: string; content: string }, ctx) {
    const { abs, rel } = resolveWorkspacePath(ctx.ws.root, p.path, ctx.ws.settings(), "write");
    const existed = fs.existsSync(abs);
    writeFile(ctx, rel, abs, p.content);
    return ok(`${existed ? "已覆盖" : "已创建"} ${rel}（${byteLength(p.content)} 字节）`);
  },
};

export const shellTool: ToolSpec = {
  name: "shell",
  label: "执行命令",
  description: "在工作区根目录用 bash 执行命令。输出过长时保留开头和结尾；退出码和 stderr 单独返回。不要用它写文件。",
  parameters: Type.Object({
    command: Type.String(),
    timeout_sec: Type.Optional(Type.Number({ description: "超时秒数，默认 120，最大 600" })),
  }),
  risk: "exec",
  async execute(p: { command: string; timeout_sec?: number }, ctx) {
    const decision = shellPolicy(p.command, ctx.ws.settings(), ctx.agent);
    if (decision.policy === "deny") return fail(`命令被拒绝：${decision.reason}`);
    if (decision.policy === "ask") {
      const allowed = await ctx.requestApproval({ risk: "exec", title: "执行命令", preview: p.command });
      if (!allowed) return fail("用户拒绝了这条命令。换一种做法，或在交接里说明需要执行什么。");
    }
    const timeoutMs = Math.min(600, Math.max(1, p.timeout_sec ?? 120)) * 1000;
    const result = await runShell(p.command, { cwd: ctx.ws.root, timeoutMs, signal: ctx.signal });
    const text = formatShellResult(p.command, result);
    return result.exitCode === 0 ? ok(text) : fail(text);
  },
};

export const readContextTool: ToolSpec = {
  name: "read_context",
  label: "读上下文",
  description: "读取房间上下文（CONTEXT.md）和置顶记忆。",
  parameters: Type.Object({}),
  risk: "read",
  mcp: true,
  async execute(_p, ctx) {
    const pinned = listMemory(ctx.ws).filter((m) => m.pinned && m.status === "active");
    const mem = pinned.length ? `\n\n## 置顶记忆\n${pinned.map((m) => `- [${m.id}] ${m.text}`).join("\n")}` : "";
    return ok(`${ctx.ws.readContext().trim()}${mem}`);
  },
};


export const updateContextTool: ToolSpec = {
  name: "update_context",
  label: "改上下文",
  description: "整体替换房间上下文 CONTEXT.md。只写长期有效的目标、约束、当前状态；临时细节放交接，事实放记忆。上限 8KB。",
  parameters: Type.Object({ content: Type.String({ description: "完整的新内容（Markdown）" }) }),
  risk: "memory",
  async execute(p: { content: string }, ctx) {
    if (byteLength(p.content) > CONTEXT_MAX_BYTES) return fail(`上下文超过 ${CONTEXT_MAX_BYTES} 字节，请合并重复内容，把细节移进记忆`);
    ctx.ws.writeContext(p.content);
    ctx.onDecision();
    return ok("房间上下文已更新");
  },
};

export const memorySearchTool: ToolSpec = {
  name: "memory_search",
  label: "查记忆",
  description: "按关键词检索记忆（事实、决定、偏好）。不传 query 时返回最近的条目。",
  parameters: Type.Object({ query: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
  risk: "read",
  mcp: true,
  async execute(p: { query?: string; limit?: number }, ctx) {
    const found = searchMemory(ctx.ws, p.query ?? "", { limit: Math.min(30, p.limit ?? 10) });
    if (!found.length) return ok("没有相关记忆");
    return ok(found.map((m) => `[${m.id}] (${m.kind}${m.pinned ? "，置顶" : ""}) ${m.text}`).join("\n"));
  },
};

export const rememberTool: ToolSpec = {
  name: "remember",
  label: "写记忆",
  description: "写入一条记忆。kind：fact（事实）/ decision（决定）/ preference（偏好）。更新旧条目时传 supersedes。",
  parameters: Type.Object({
    text: Type.String({ description: "一句话说清楚，600 字以内" }),
    kind: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("decision"), Type.Literal("preference")])),
    supersedes: Type.Optional(Type.String({ description: "被替换的记忆 id" })),
  }),
  risk: "memory",
  mcp: true,
  async execute(p: { text: string; kind?: "fact" | "decision" | "preference"; supersedes?: string }, ctx) {
    const result = remember(ctx.ws, { text: p.text, kind: p.kind, supersedes: p.supersedes, author: ctx.agent.id, run: ctx.run.id });
    const similar = result.similar.length ? `\n相近条目：\n${result.similar.map((m) => `[${m.id}] ${m.text}`).join("\n")}` : "";
    if (!result.ok) return fail(`没有写入：${result.reason}${similar}`);
    if (result.entry.kind === "decision") ctx.onDecision();
    return ok(`已记住 [${result.entry.id}]${similar}`);
  },
};

export const recordLessonTool: ToolSpec = {
  name: "record_lesson",
  label: "记教训",
  description: "记录一个踩过的坑：标题 + 怎么复现、怎么避免。同类问题会累计次数。",
  parameters: Type.Object({ title: Type.String(), body: Type.String() }),
  risk: "memory",
  async execute(p: { title: string; body: string }, ctx) {
    const { lesson, repeated } = recordLesson(ctx.ws, p);
    return ok(
      repeated
        ? `同类教训已出现 ${lesson.occurrences} 次（${lesson.id}）。建议把它固化成检查命令、权限规则或测试。`
        : `已记录教训 ${lesson.id}`,
    );
  },
};

export const writeHandoffTool: ToolSpec = {
  name: "write_handoff",
  label: "写交接",
  description: "结束前写交接：做了什么、改了哪些文件、还剩什么、建议下一步。检查角色必须给出 verdict（pass / fail），fail 时在 issues 里逐条列问题。",
  parameters: Type.Object({
    done: Type.String({ description: "做了什么（事实）" }),
    files: Type.Optional(Type.Array(Type.String(), { description: "改动的文件" })),
    remaining: Type.Optional(Type.String({ description: "还剩什么、风险" })),
    next: Type.Optional(Type.String({ description: "建议下一步" })),
    verdict: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail")])),
    issues: Type.Optional(Type.Array(Type.String())),
  }),
  risk: "memory",
  mcp: true,
  async execute(
    p: { done: string; files?: string[]; remaining?: string; next?: string; verdict?: "pass" | "fail"; issues?: string[] },
    ctx,
  ) {
    if (!p.done?.trim()) return fail("done 不能为空");
    if (ctx.run.role === "review" && !p.verdict) return fail("检查角色必须给出 verdict：pass 或 fail");
    if (p.verdict === "fail" && !p.issues?.length) return fail("verdict 为 fail 时必须在 issues 里列出问题");
    ctx.onHandoff({
      done: p.done.trim(),
      files: p.files ?? [],
      remaining: p.remaining?.trim() ?? "",
      next: p.next?.trim() ?? "",
      verdict: ctx.run.role === "review" ? p.verdict : undefined,
      issues: p.issues,
    });
    return ok("交接已记录");
  },
};

export const handoffToTool: ToolSpec = {
  name: "handoff_to",
  label: "提议接力",
  description: "提议线程进入下一个阶段（implement 或 review），由工作台挑选 agent。必须附上可检验的验收标准。",
  parameters: Type.Object({
    stage: Type.Union([Type.Literal("implement"), Type.Literal("review")]),
    reason: Type.String(),
    acceptance: Type.Array(Type.String(), { minItems: 1 }),
  }),
  risk: "memory",
  async execute(p: { stage: Stage; reason: string; acceptance: string[] }, ctx) {
    if (!p.acceptance?.filter((a) => a.trim()).length) return fail("必须附上验收标准");
    ctx.onHandoffTo({ stage: p.stage, reason: p.reason, acceptance: p.acceptance.map((a) => a.trim()).filter(Boolean) });
    return ok(`已提议进入 ${p.stage} 阶段。请继续写交接（write_handoff），然后结束。`);
  },
};

export const ALL_TOOLS: ToolSpec[] = [
  readFileTool,
  listFilesTool,
  searchTool,
  editFileTool,
  applyPatchTool,
  writeFileTool,
  shellTool,
  readContextTool,
  updateContextTool,
  memorySearchTool,
  rememberTool,
  recordLessonTool,
  writeHandoffTool,
  handoffToTool,
];

export const MCP_TOOLS = ALL_TOOLS.filter((t) => t.mcp);

const ROLE_TOOLS: Record<Role, string[]> = {
  plan: ["read_file", "list_files", "search", "read_context", "update_context", "memory_search", "remember", "record_lesson", "write_handoff", "handoff_to"],
  implement: ["read_file", "list_files", "search", "edit", "write_file", "shell", "read_context", "update_context", "memory_search", "remember", "record_lesson", "write_handoff"],
  review: ["read_file", "list_files", "search", "shell", "read_context", "memory_search", "remember", "record_lesson", "write_handoff"],
  advisor: ["read_file", "list_files", "search", "read_context", "memory_search"],
  // Write and exec tools drop out unless the user opened writes for the thread (see chatPermissions).
  chat: ["read_file", "list_files", "search", "edit", "write_file", "shell", "read_context", "memory_search", "remember", "record_lesson"],
};

/** Tools offered to a native (Pi) run: by role, capped by the agent's permissions, edit format by family. */
export function toolsFor(agent: AgentCard, role: Role): ToolSpec[] {
  const family = modelFamily(agent.model, agent.provider);
  return ROLE_TOOLS[role]
    .map((name) => (name === "edit" ? (family === "gpt" ? "apply_patch" : "edit_file") : name))
    .map((name) => ALL_TOOLS.find((t) => t.name === name)!)
    .filter((t) => {
      if (t.risk === "write") return canWrite(agent.permissions);
      if (t.risk === "exec") return agent.permissions.exec !== "deny";
      return true;
    });
}

export async function runTool(tool: ToolSpec, params: unknown, ctx: ToolContext): Promise<ToolOutput> {
  try {
    if (tool.risk === "write" && !canWrite(ctx.agent.permissions)) return fail(`${ctx.agent.name} 没有写文件的权限`);
    if (tool.risk === "write" && ctx.agent.permissions.write === "ask") {
      const p = (params ?? {}) as { path?: string };
      const preview = tool.preview ? tool.preview(params ?? {}, ctx) : summarizeArgs(params, 4000);
      const allowed = await ctx.requestApproval({ risk: "write", title: p.path ? `改文件：${p.path}` : "改文件", preview });
      ctx.ws.audit({ run: ctx.run.id, agent: ctx.agent.id, tool: tool.name, risk: tool.risk, params: summarizeArgs(params), approved: allowed });
      if (!allowed) return fail("用户拒绝了这次改动。换一种做法，或在交接里说明想改什么。");
    }
    const out = await tool.execute(params ?? {}, ctx);
    ctx.ws.audit({ run: ctx.run.id, agent: ctx.agent.id, tool: tool.name, risk: tool.risk, params: summarizeArgs(params), ok: !out.isError });
    return out;
  } catch (error) {
    const message = error instanceof PermissionError ? `权限拒绝：${error.message}` : `工具出错：${(error as Error).message}`;
    ctx.ws.audit({ run: ctx.run.id, agent: ctx.agent.id, tool: tool.name, risk: tool.risk, params: summarizeArgs(params), ok: false, error: message });
    return fail(message);
  }
}

export function summarizeArgs(params: unknown, max = 400): string {
  const text = typeof params === "string" ? params : JSON.stringify(params ?? {});
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
