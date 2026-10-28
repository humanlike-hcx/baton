import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChecks } from "../src/checks.ts";
import { compileBriefing } from "../src/context.ts";
import { RULE_FILES, defaultSettings } from "../src/defaults.ts";
import { FileCredentialStore, readCodexCredential, writeCodexRefresh } from "../src/credentials.ts";
import { cursorVariant, defaultThinkingLevel, distinctThinkingLevels, modelFamily, normalizeThinkingLevel, supportsFastTier, thinkingLabel, validateModelRoute } from "../src/families.ts";
import { listLessons, listMemory, recordLesson, remember } from "../src/memory.ts";
import { applyChunks, parsePatch } from "../src/patch.ts";
import { REVIEW_PERMISSIONS, PermissionError, accessPermissions, resolveWorkspacePath, shellPolicy } from "../src/permissions.ts";
import { runShell } from "../src/shell.ts";
import { ALL_TOOLS, toolsFor } from "../src/tools.ts";
import { runAgent } from "../src/orchestrator.ts";
import type { RunAgent, Thread } from "../src/types.ts";
import { truncateMiddle } from "../src/util.ts";
import { Workspace } from "../src/workspace.ts";
import { createDirectoryLink, tempDir } from "./helpers.ts";

function agent(partial: Partial<RunAgent> & Pick<RunAgent, "id" | "model">): RunAgent {
  return {
    name: partial.id,
    runtime: "pi",
    source: "demo",
    provider: "x",
    permissions: { write: "allow", exec: "ask", network: "deny" },
    ...partial,
  };
}

function thread(partial: Partial<Thread> = {}): Thread {
  return { id: "th_test", title: "t", status: "idle", createdAt: "", updatedAt: "", summary: "", runs: [], items: [], access: "read", notes: [], ...partial };
}

describe("model families", () => {
  it("groups models by access route", () => {
    expect(modelFamily("gpt-5.5")).toBe("gpt");
    expect(modelFamily("o3")).toBe("gpt");
    expect(modelFamily("gpt-5-codex")).toBe("gpt");
    expect(modelFamily("deepseek-v4-pro")).toBe("deepseek");
    expect(modelFamily("sonnet-4.5")).toBe("claude");
    expect(modelFamily("claude-opus-4.1")).toBe("claude");
    expect(modelFamily("composer-1")).toBe("composer");
    expect(modelFamily("demo-chat", "demo")).toBe("demo-chat");
  });

  it("keeps each family on its one subscription route, and lets API keys offer any family", () => {
    expect(validateModelRoute("chatgpt", "gpt-5.5")).toBeUndefined();
    expect(validateModelRoute("chatgpt", "deepseek-v4-pro")).toMatch(/ChatGPT/);
    expect(validateModelRoute("key", "deepseek-v4-pro")).toBeUndefined();
    expect(validateModelRoute("key", "gpt-5.5")).toBeUndefined();
    expect(validateModelRoute("key", "claude-opus-4-5")).toBeUndefined();
    expect(validateModelRoute("cursor", "claude-sonnet-5-5-medium")).toBeUndefined();
    expect(validateModelRoute("cursor", "gpt-5.6-sol")).toBeDefined();
    expect(validateModelRoute("cursor", "auto")).toBeDefined();
    expect(validateModelRoute("openrouter", "x")).toMatch(/不支持/);
  });
});

describe("Cursor model variants (US-100)", () => {
  it("splits effort, thinking and fast off the id in either order, and the matching words off the name", () => {
    expect(cursorVariant("claude-opus-5-thinking-high-fast", "Claude Opus 5 1M Thinking Fast")).toEqual({ base: "claude-opus-5", baseName: "Claude Opus 5 1M", effort: "high", reasoning: true, fast: true });
    expect(cursorVariant("claude-4.6-opus-high-thinking", "Claude Opus 4.6 1M Thinking")).toMatchObject({ base: "claude-4.6-opus", effort: "high", reasoning: true, fast: false });
    expect(cursorVariant("claude-opus-5-5-xhigh-fast", "Claude Opus 5.5 1M Extra High Fast")).toMatchObject({ base: "claude-opus-5-5", baseName: "Claude Opus 5.5 1M", effort: "xhigh", fast: true });
    expect(cursorVariant("grok-4.7-low-fast", "Grok 4.7  Low Fast\u200b\u200b")).toMatchObject({ base: "grok-4.7", baseName: "Grok 4.7", effort: "low" });
    expect(cursorVariant("claude-fable-5-thinking-max", "Claude Fable 5 1M Max Thinking (NO ZDR)")).toMatchObject({ base: "claude-fable-5", baseName: "Claude Fable 5 1M (NO ZDR)", effort: "max", reasoning: true });
    expect(cursorVariant("claude-haiku-5-5-low", "Claude Haiku 5.5  Low No Thinking")).toMatchObject({ base: "claude-haiku-5-5", baseName: "Claude Haiku 5.5", effort: "low", reasoning: false });
    expect(cursorVariant("composer-2.5-fast", "Composer 2.5 Fast")).toEqual({ base: "composer-2.5", baseName: "Composer 2.5", reasoning: false, fast: true });
    expect(cursorVariant("gemini-3.1-pro", "Gemini 3.1 Pro")).toEqual({ base: "gemini-3.1-pro", baseName: "Gemini 3.1 Pro", reasoning: false, fast: false });
    expect(thinkingLabel("xhigh")).toBe("极高");
    expect(thinkingLabel(undefined)).toBe("默认");
  });

  it("lists only the efforts a model can actually send, without aliases", () => {
    // Codex catalog names xhigh/max and maps minimal onto low; the missing ordinary levels are real.
    expect(distinctThinkingLevels(true, { xhigh: "xhigh", max: "max", minimal: "low" })).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    // GPT-6.1 cannot turn thinking off, and minimal is the same request as low.
    expect(distinctThinkingLevels(true, { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" })).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The API catalog for GPT-5.6: none, low, medium, high, xhigh, max. minimal is explicitly absent.
    expect(distinctThinkingLevels(true, { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" })).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(distinctThinkingLevels(true, { minimal: null, low: null, medium: null, high: "high", max: "max" })).toEqual(["off", "high", "max"]);
    expect(distinctThinkingLevels(false, { high: "high" })).toBeUndefined();
    expect(defaultThinkingLevel(["off", "low", "medium", "high"])).toBe("medium");
    expect(defaultThinkingLevel(["off", "high", "max"])).toBe("high");
    expect(normalizeThinkingLevel("minimal", ["off", "low", "medium", "high"])).toBe("low");
    expect(normalizeThinkingLevel(undefined, ["low", "medium", "high"])).toBe("medium");
    expect(supportsFastTier("gpt-5.6-luna")).toBe(true);
    expect(supportsFastTier("gpt-6.1-sol")).toBe(true);
    expect(supportsFastTier("gpt-5.5")).toBe(false);
    expect(supportsFastTier("deepseek-v4-pro")).toBe(false);
  });
});

describe("permissions", () => {
  const root = fs.realpathSync(tempDir());
  const outside = fs.realpathSync(tempDir());
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  createDirectoryLink(outside, path.join(root, "escape"));
  const settings = defaultSettings("t");

  it("allows paths inside the workspace", () => {
    expect(resolveWorkspacePath(root, "src/a.ts", settings, "write").rel).toBe("src/a.ts");
  });
  it("rejects traversal, symlink escapes, denylisted files and .baton writes", () => {
    expect(() => resolveWorkspacePath(root, "../x", settings, "read")).toThrow(PermissionError);
    expect(() => resolveWorkspacePath(root, "/etc/passwd", settings, "read")).toThrow(PermissionError);
    expect(() => resolveWorkspacePath(root, "escape/passwd", settings, "read")).toThrow(/符号链接/);
    expect(() => resolveWorkspacePath(root, ".env", settings, "read")).toThrow(/拒绝/);
    expect(() => resolveWorkspacePath(root, "sub/.env.local", settings, "read")).toThrow(/拒绝/);
    expect(() => resolveWorkspacePath(root, ".git/config", settings, "read")).toThrow(/拒绝/);
    expect(() => resolveWorkspacePath(root, ".baton/CONTEXT.md", settings, "write")).toThrow(/\.baton/);
    expect(resolveWorkspacePath(root, ".baton/CONTEXT.md", settings, "read").rel).toBe(".baton/CONTEXT.md");
  });
  it("applies shell allow/deny lists and agent overrides", () => {
    const a = agent({ id: "a", model: "m" });
    expect(shellPolicy("ls -la", settings, a).policy).toBe("allow");
    expect(shellPolicy("ls; rm -rf x", settings, a).policy).toBe("ask");
    expect(shellPolicy("sudo ls", settings, a).policy).toBe("deny");
    expect(shellPolicy("echo hi && git push origin main", settings, a).policy).toBe("deny");
    expect(shellPolicy("npm test", settings, a).policy).toBe("ask");
    expect(shellPolicy("npm test", settings, { ...a, permissions: { ...a.permissions, exec: "allow" } }).policy).toBe("allow");
    expect(shellPolicy("ls", settings, { ...a, permissions: { ...a.permissions, exec: "deny" } }).policy).toBe("deny");
  });
});

describe("access levels and tools per role", () => {
  it("maps a chat's access level to permissions, and a review to read-only", () => {
    expect(accessPermissions("read")).toEqual({ write: "deny", exec: "deny", network: "ask" });
    expect(accessPermissions("ask")).toEqual({ write: "ask", exec: "ask", network: "ask" });
    expect(accessPermissions("allow")).toEqual({ write: "allow", exec: "allow", network: "allow" });
    const allow = runAgent({ source: "key", provider: "deepseek", account: "DeepSeek", model: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }, accessPermissions("allow"));
    expect(allow).toMatchObject({ id: "key:deepseek:deepseek-v4-pro", name: "DeepSeek V4 Pro · DeepSeek", runtime: "pi", provider: "deepseek" });
    const settings = defaultSettings("t");
    expect(shellPolicy("npm test", settings, allow).policy).toBe("allow");
    expect(shellPolicy("sudo npm test", settings, allow).policy).toBe("deny");
    expect(shellPolicy("git push", settings, allow).policy).toBe("deny");
  });

  it("gives GPT the patch format, others text replacement, and drops write tools when read-only", () => {
    const gpt = agent({ id: "g", model: "gpt-5.5" });
    const ds = agent({ id: "d", model: "deepseek-v4-pro" });
    expect(toolsFor(gpt, "chat").map((t) => t.name)).toContain("apply_patch");
    expect(toolsFor(ds, "chat").map((t) => t.name)).toContain("edit_file");
    expect(toolsFor(ds, "chat").map((t) => t.name)).not.toContain("submit_review");
    const readOnly = agent({ id: "r", model: "x", permissions: accessPermissions("read") });
    expect(toolsFor(readOnly, "chat").map((t) => t.name)).toEqual(["read_file", "list_files", "search", "read_context", "update_context", "memory_search", "remember", "record_lesson"]);
    const reviewer = agent({ id: "v", model: "x", permissions: REVIEW_PERMISSIONS });
    expect(toolsFor(reviewer, "review").map((t) => t.name)).toEqual(["read_file", "list_files", "search", "read_context", "memory_search", "record_lesson", "submit_review"]);
  });

  it("gives Pi models no network tool, even with network allowed", () => {
    expect(ALL_TOOLS.filter((t) => t.risk === "network")).toEqual([]);
    const online = agent({ id: "n", model: "deepseek-v4-pro", permissions: accessPermissions("allow") });
    for (const role of ["chat", "review"] as const) {
      expect(toolsFor(online, role).every((t) => t.risk !== "network"), role).toBe(true);
    }
  });
});

describe("apply_patch", () => {
  it("adds, updates and deletes files", () => {
    const ops = parsePatch(
      ["*** Begin Patch", "*** Add File: a.txt", "+hello", "*** Update File: b.txt", "@@", " one", "-two", "+TWO", " three", "*** Delete File: c.txt", "*** End Patch"].join("\n"),
    );
    expect(ops.map((o) => o.type)).toEqual(["add", "update", "delete"]);
    const update = ops[1]!;
    if (update.type !== "update") throw new Error();
    expect(applyChunks("one\ntwo\nthree\n", update.chunks, "b.txt")).toBe("one\nTWO\nthree\n");
    expect(() => applyChunks("x\n", update.chunks, "b.txt")).toThrow(/找不到/);
  });
});

describe("shell", () => {
  it("returns the exit code separately, keeps stderr and truncates the middle", async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, "truncate.js"),
      // process.exit() skips the stdout flush, so Linux can drop the tail this test requires.
      `console.log("start"); for (let i = 1; i <= 20000; i++) console.log(i); console.error("oops"); process.exitCode = 3;\n`,
    );
    const r = await runShell('node "truncate.js"', { cwd, maxBytes: 2000 });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("oops");
    expect(r.truncated).toBe(true);
    expect(r.stdout.startsWith("start")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("20000")).toBe(true);
    expect(r.stdout).toContain("省略中间");
  });
  it("does not leak secrets into the environment", async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, "env.js"), `process.stdout.write(Object.keys(process.env).sort().join("\\n"));\n`);
    process.env.TEST_API_KEY = "sk-secret";
    const r = await runShell('node "env.js"', { cwd });
    expect(r.stdout).not.toContain("sk-secret");
    delete process.env.TEST_API_KEY;
  });
  it("truncateMiddle keeps both ends", () => {
    const t = truncateMiddle("a".repeat(100) + "b".repeat(100), 50);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith("a")).toBe(true);
    expect(t.text.endsWith("b")).toBe(true);
  });
});

describe("checks", () => {
  it("distinguishes pass, fail, skipped and error, and every check can go red", async () => {
    const results = await runChecks(
      [
        { name: "ok", command: `node -e "process.exit(0)"` },
        { name: "bad", command: `node -e "process.exit(1)"` },
        { name: "skip", command: "# disabled" },
        { name: "missing", command: "no-such-command-xyz" },
        { name: "scoped", command: `node -e "process.exit(0)"`, paths: ["src/**"] } as never,
      ],
      { cwd: tempDir(), changedFiles: ["docs/readme.md"] },
    );
    expect(results.map((r) => r.status)).toEqual(["pass", "fail", "skipped", "error", "skipped"]);
  });
});

describe("workspace, memory, lessons and briefing", () => {
  it("initializes the workspace and maintains AGENTS.md idempotently", () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Mine\n\nKeep this.\n");
    const ws = Workspace.open(root);
    Workspace.open(root);
    const text = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(text).toContain("Keep this.");
    expect(text.match(/baton:begin/g)).toHaveLength(1);
    expect(fs.existsSync(ws.path("agents"))).toBe(false);
  });

  it("replaces relay-era default rules and drops the relay-only ones, keeping rules the user wrote", () => {
    const root = tempDir();
    const ws = Workspace.open(root);
    fs.writeFileSync(ws.path("rules", "base.md"), "# 旧规则\n按阶段接力：方案 → 实现 → 检查\n");
    fs.writeFileSync(ws.path("rules", "role-plan.md"), "# 角色：方案\n");
    fs.writeFileSync(ws.path("rules", "role-chat.md"), "# 我自己的对话规则\n");
    Workspace.open(root);
    expect(fs.readFileSync(ws.path("rules", "base.md"), "utf8")).toBe(RULE_FILES["base.md"]);
    expect(fs.existsSync(ws.path("rules", "role-plan.md"))).toBe(false);
    expect(fs.readFileSync(ws.path("rules", "role-chat.md"), "utf8")).toBe("# 我自己的对话规则\n");
  });

  it("rejects duplicate memories and supersedes instead of overwriting", () => {
    const ws = Workspace.open(tempDir());
    const first = remember(ws, { text: "前端统一使用 pnpm 管理依赖", author: "a" });
    expect(first.ok).toBe(true);
    const dup = remember(ws, { text: "前端统一使用 pnpm 管理依赖", author: "b" });
    expect(dup.ok).toBe(false);
    if (!first.ok) throw new Error();
    const next = remember(ws, { text: "前端统一使用 bun 管理依赖", author: "b", supersedes: first.entry.id });
    expect(next.ok).toBe(true);
    const all = listMemory(ws);
    expect(all).toHaveLength(2);
    expect(all.find((m) => m.id === first.entry.id)?.status).toBe("superseded");
  });

  it("counts repeated lessons", () => {
    const ws = Workspace.open(tempDir());
    recordLesson(ws, { title: "shell 输出截断后丢了退出码", body: "a" });
    const second = recordLesson(ws, { title: "shell 输出截断后丢失退出码", body: "b" });
    expect(second.repeated).toBe(true);
    expect(listLessons(ws)[0]!.occurrences).toBe(2);
  });

  it("composes the briefing by role × runtime in a fixed order with budget and hash", () => {
    const ws = Workspace.open(tempDir(), { demo: true });
    const chat = compileBriefing({ ws, agent: runAgent({ source: "demo", model: "demo-chat", name: "对话" }, accessPermissions("read")), role: "chat", task: "你好" });
    expect(chat.sections.map((s) => s.key)).toEqual(["base", "role", "runtime", "context", "task"]);
    expect(chat.budget).toBe(24 * 1024);
    expect(chat.overBudget).toBe(false);
    expect(chat.text).toContain("只读，不能改文件");
    expect(chat.hash).toMatch(/^[0-9a-f]{64}$/);
    const t = thread({ summary: "- 用户：早先的话题 → 演示：好" });
    const review = compileBriefing({ ws, agent: runAgent({ source: "demo", model: "demo-review", name: "检查" }, REVIEW_PERMISSIONS), role: "review", thread: t, task: "写周报", extra: "## 改动的文件\n- notes/a.md" });
    expect(review.sections.map((s) => s.key)).toEqual(["base", "role", "runtime", "context", "thread", "task"]);
    expect(review.text).toContain("submit_review");
    expect(review.text).toContain("早先的话题");
    expect(review.text).toContain("notes/a.md");
  });

  it("reads a Codex CLI ChatGPT login and writes a refresh back only for that token (US-102)", async () => {
    const jwt = (payload: object) => {
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${part({ alg: "none" })}.${part(payload)}.x`;
    };
    const access = jwt({ exp: 2_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct_from_jwt" } });
    const file = path.join(tempDir(), "auth.json");
    fs.writeFileSync(file, JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "keep-me", access_token: access, refresh_token: "refresh-old", account_id: "acct_file" }, last_refresh: "then" }));
    expect(readCodexCredential(file)).toMatchObject({ type: "oauth", access, refresh: "refresh-old", accountId: "acct_file", expires: 2_000_000_000_000 });
    expect(readCodexCredential(path.join(tempDir(), "missing.json"))).toBeUndefined();
    fs.writeFileSync(path.join(path.dirname(file), "apikey.json"), JSON.stringify({ auth_mode: "apikey", tokens: { access_token: access, refresh_token: "refresh-old" } }));
    expect(readCodexCredential(path.join(path.dirname(file), "apikey.json"))).toBeUndefined();

    writeCodexRefresh(file, "someone-else", { access: "nope", refresh: "nope" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).tokens.refresh_token).toBe("refresh-old");
    writeCodexRefresh(file, "refresh-old", { access: "access-new", refresh: "refresh-new", accountId: "acct_file" });
    const updated = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(updated.tokens).toMatchObject({ id_token: "keep-me", access_token: "access-new", refresh_token: "refresh-new", account_id: "acct_file" });
    expect(updated.auth_mode).toBe("chatgpt");

    const store = new FileCredentialStore(tempDir());
    const seen: string[] = [];
    store.onSaved = (providerId) => seen.push(providerId);
    await store.modify("openai-codex", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }));
    expect(seen).toEqual(["openai-codex"]);
  });
});
