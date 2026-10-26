import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChecks } from "../src/checks.ts";
import { compileBriefing } from "../src/context.ts";
import { defaultSettings } from "../src/defaults.ts";
import { modelFamily } from "../src/families.ts";
import { compactionProgress, listLessons, listMemory, mergeProgress, recordLesson, remember } from "../src/memory.ts";
import { applyChunks, parsePatch } from "../src/patch.ts";
import { PermissionError, resolveWorkspacePath, shellPolicy } from "../src/permissions.ts";
import { isStall, nextTransition, selectAgent } from "../src/router.ts";
import { runShell } from "../src/shell.ts";
import { toolsFor } from "../src/tools.ts";
import type { AgentCard, RunRecord, Thread } from "../src/types.ts";
import { truncateMiddle } from "../src/util.ts";
import { Workspace } from "../src/workspace.ts";
import { tempDir } from "./helpers.ts";

function agent(partial: Partial<AgentCard> & Pick<AgentCard, "id" | "model">): AgentCard {
  return {
    name: partial.id,
    runtime: "pi",
    source: "demo",
    provider: "x",
    roles: ["implement"],
    permissions: { write: true, exec: "ask", network: "deny" },
    costTier: 1,
    enabled: true,
    body: "",
    ...partial,
  };
}

function thread(partial: Partial<Thread> = {}): Thread {
  return {
    id: "th_test",
    kind: "relay",
    title: "t",
    task: "t",
    acceptance: ["a"],
    stage: "plan",
    status: "idle",
    createdAt: "",
    updatedAt: "",
    hops: 0,
    sendBacks: 0,
    stalls: 0,
    summary: "",
    runs: [],
    items: [],
    pinnedAgents: {},
    spend: { deepseekCny: 0, chatgptRuns: 0, cursorRuns: 0 },
    reviewIssueRounds: 0,
    approvedLevel: 0,
    extraHops: 0,
    notes: [],
    ...partial,
  };
}

function run(partial: Partial<RunRecord>): RunRecord {
  return {
    id: "run_x",
    threadId: "th_test",
    agentId: "a",
    agentName: "a",
    runtime: "pi",
    model: "m",
    family: "m",
    stage: "implement",
    role: "implement",
    status: "succeeded",
    startedAt: "",
    briefingHash: "",
    briefingBytes: 0,
    changedFiles: [],
    decisions: 0,
    finalText: "",
    ...partial,
  };
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
    expect(modelFamily("demo-code", "demo")).toBe("demo-code");
  });
});

describe("permissions", () => {
  const root = fs.realpathSync(tempDir());
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.symlinkSync("/etc", path.join(root, "escape"));
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

describe("tools per role", () => {
  it("gives GPT the patch format, others text replacement, and hides routing from executors", () => {
    const gpt = agent({ id: "g", model: "gpt-5.5", roles: ["implement", "plan"] });
    const ds = agent({ id: "d", model: "deepseek-v4-pro" });
    expect(toolsFor(gpt, "implement").map((t) => t.name)).toContain("apply_patch");
    expect(toolsFor(ds, "implement").map((t) => t.name)).toContain("edit_file");
    expect(toolsFor(ds, "implement").map((t) => t.name)).not.toContain("handoff_to");
    expect(toolsFor(gpt, "plan").map((t) => t.name)).toContain("handoff_to");
    expect(toolsFor(gpt, "plan").map((t) => t.name)).not.toContain("write_file");
    expect(toolsFor(gpt, "advisor").map((t) => t.name)).toEqual(["read_file", "list_files", "search", "read_context", "memory_search"]);
    const readOnly = agent({ id: "r", model: "x", permissions: { write: false, exec: "deny", network: "deny" } });
    expect(toolsFor(readOnly, "implement").map((t) => t.name)).not.toContain("shell");
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

describe("compaction progress", () => {
  const full = [
    "## Goal",
    "导出配置",
    "## Progress",
    "### Done",
    "- [x] 加了 `exportConfig()`",
    "- [x] 写了 src/export.test.ts",
    "### In Progress",
    "- [ ] 设置页按钮",
    "### Blocked",
    "- (none)",
    "## Key Decisions",
    "- **格式**：JSON",
    "## Next Steps",
    "1. 接上按钮",
    "",
    "---",
    "",
    "**Turn Context (split turn):**",
    "",
    "## Progress So Far",
    "- 跑过一次 pnpm test",
    "",
    "<modified-files>",
    "src/export.ts",
    "</modified-files>",
  ].join("\n");

  it("reads done, remaining and next from both summary formats", () => {
    const p = compactionProgress(full);
    expect(p).toEqual({ compactions: 1, done: ["加了 `exportConfig()`", "写了 src/export.test.ts", "跑过一次 pnpm test"], remaining: ["设置页按钮"], next: ["接上按钮"] });
    expect(compactionProgress("## Progress\n### Done\n- [x] a", p).compactions).toBe(2);
  });

  it("adds only what the handoff left out and keeps what the agent wrote", () => {
    const p = compactionProgress(full);
    const merged = mergeProgress({ done: "加了 exportConfig()。", remaining: "", next: "交给检查" }, p);
    expect(merged.done).toContain("压缩前的进展");
    expect(merged.done).toContain("写了 src/export.test.ts");
    expect(merged.done.match(/exportConfig/g)).toHaveLength(1);
    expect(merged.remaining).toBe("- 设置页按钮");
    expect(merged.next).toBe("交给检查");
    expect(mergeProgress({ done: "x", remaining: "", next: "" }, undefined)).toEqual({ done: "x", remaining: "", next: "" });
  });
});

describe("shell", () => {
  it("returns the exit code separately, keeps stderr and truncates the middle", async () => {
    const r = await runShell("echo start; seq 1 20000; echo oops >&2; exit 3", { cwd: tempDir(), maxBytes: 2000 });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("oops");
    expect(r.truncated).toBe(true);
    expect(r.stdout.startsWith("start")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("20000")).toBe(true);
    expect(r.stdout).toContain("省略中间");
  });
  it("does not leak secrets into the environment", async () => {
    process.env.TEST_API_KEY = "sk-secret";
    const r = await runShell("env", { cwd: tempDir() });
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
        { name: "ok", command: "true" },
        { name: "bad", command: "false" },
        { name: "skip", command: "# disabled" },
        { name: "missing", command: "no-such-command-xyz" },
        { name: "scoped", command: "true", paths: ["src/**"] } as never,
      ],
      { cwd: tempDir(), changedFiles: ["docs/readme.md"] },
    );
    expect(results.map((r) => r.status)).toEqual(["pass", "fail", "skipped", "error", "skipped"]);
  });
});

describe("router", () => {
  const settings = defaultSettings("t");
  const coderGpt = agent({ id: "coder-gpt", model: "gpt-5.5", costTier: 3 });
  const coderDs = agent({ id: "coder-ds", model: "deepseek-v4-pro", costTier: 1 });
  const reviewerGpt = agent({ id: "rev-gpt", model: "gpt-5.5", roles: ["review"], permissions: { write: false, exec: "ask", network: "deny" } });
  const reviewerClaude = agent({ id: "rev-claude", model: "sonnet-4.5", roles: ["review"], costTier: 2, permissions: { write: false, exec: "ask", network: "deny" } });
  const all = [coderGpt, coderDs, reviewerGpt, reviewerClaude];

  it("picks the cheapest available agent that owns the role", () => {
    const s = selectAgent("implement", { thread: thread(), agents: all, settings, available: () => true });
    expect(s.chosen?.id).toBe("coder-ds");
    const s2 = selectAgent("implement", { thread: thread(), agents: all, settings, available: (a) => a.id !== "coder-ds" });
    expect(s2.chosen?.id).toBe("coder-gpt");
    expect(s2.rejected.find((r) => r.id === "coder-ds")?.reason).toMatch(/登录/);
  });

  it("never lets a model family review its own implementation", () => {
    const t = thread({ runs: [run({ stage: "implement", family: "gpt" })] });
    const s = selectAgent("review", { thread: t, agents: all, settings, available: () => true });
    expect(s.chosen?.id).toBe("rev-claude");
    expect(s.rejected.find((r) => r.id === "rev-gpt")?.reason).toMatch(/gpt/);
  });

  it("respects spending caps", () => {
    const t = thread({ spend: { deepseekCny: 99, chatgptRuns: 0, cursorRuns: 0 } });
    const s = selectAgent("implement", { thread: t, agents: [{ ...coderDs, source: "deepseek" }], settings, available: () => true });
    expect(s.chosen).toBeUndefined();
    expect(s.rejected[0]?.reason).toMatch(/上限/);
  });

  it("enforces stage transitions and limits", () => {
    expect(nextTransition(thread(), run({ stage: "implement" }), settings)).toMatchObject({ kind: "advance", to: "review" });
    expect(nextTransition(thread(), run({ stage: "review", handoff: { verdict: "pass" } as never }), settings)).toMatchObject({ kind: "complete" });
    expect(nextTransition(thread(), run({ stage: "review", handoff: { verdict: "fail", issues: ["x"] } as never }), settings)).toMatchObject({ kind: "advance", to: "implement", sendBack: true });
    expect(nextTransition(thread({ sendBacks: 2 }), run({ stage: "review", handoff: { verdict: "fail", issues: ["x"] } as never }), settings)).toMatchObject({ kind: "violation" });
    expect(nextTransition(thread(), run({ stage: "review", handoff: { verdict: "pass" } as never, checks: [{ status: "fail" } as never] }), settings)).toMatchObject({ kind: "advance", sendBack: true });
    expect(nextTransition(thread(), run({ stage: "review" }), settings)).toMatchObject({ kind: "violation", rule: "检查没有给出结论" });
    expect(nextTransition(thread({ hops: 6 }), run({ stage: "implement" }), settings)).toMatchObject({ kind: "violation", rule: "接力跳数已达上限" });
    expect(nextTransition(thread({ stalls: 2 }), run({ stage: "implement" }), settings)).toMatchObject({ kind: "violation", rule: "连续空转" });
    expect(nextTransition(thread(), run({ stage: "plan", proposedNext: { stage: "plan", reason: "", acceptance: ["a"] } }), settings)).toMatchObject({ kind: "violation" });
    expect(nextTransition(thread(), run({ status: "failed", error: "boom" }), settings)).toMatchObject({ kind: "pause" });
  });

  it("detects stalls", () => {
    expect(isStall(run({}))).toBe(true);
    expect(isStall(run({ changedFiles: ["a"] }))).toBe(false);
    expect(isStall(run({ decisions: 1 }))).toBe(false);
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
    expect(ws.listAgents().length).toBeGreaterThan(3);
    expect(ws.listAgents().filter((a) => a.source === "demo").every((a) => !a.enabled)).toBe(true);
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
    const a = ws.getAgent("demo-coder")!;
    const b = compileBriefing({ ws, agent: a, role: "implement", task: "do it", acceptance: ["x"] });
    expect(b.sections.map((s) => s.key)).toEqual(["base", "role", "runtime", "agent", "context", "task"]);
    expect(b.budget).toBe(12 * 1024);
    expect(b.overBudget).toBe(false);
    expect(b.text).toContain("你不能决定交给谁");
    expect(b.hash).toMatch(/^[0-9a-f]{64}$/);
    const advisor = compileBriefing({ ws, agent: ws.getAgent("demo-advisor")!, role: "advisor", thread: thread({ summary: "secret history" }) });
    expect(advisor.text).not.toContain("secret history");
    expect(advisor.budget).toBe(24 * 1024);
  });
});
