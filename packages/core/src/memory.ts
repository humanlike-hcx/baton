import fs from "node:fs";
import type { Handoff, Lesson, MemoryEntry, MemoryKind } from "./types.ts";
import { newId, nowIso, parseFrontmatter, readText, searchTerms, similarity, stringifyFrontmatter, writeFileAtomic } from "./util.ts";
import type { Workspace } from "./workspace.ts";

const MAX_MEMORY_CHARS = 600;
const DUPLICATE_THRESHOLD = 0.8;

export function listMemory(ws: Workspace): MemoryEntry[] {
  const dir = ws.path("memory");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { data, body } = parseFrontmatter<MemoryEntry>(readText(`${dir}/${f}`));
      return {
        id: data.id ?? f.replace(/\.md$/, ""),
        kind: data.kind ?? "fact",
        status: data.status ?? "active",
        supersededBy: data.supersededBy,
        author: data.author ?? "user",
        run: data.run,
        pinned: data.pinned ?? false,
        createdAt: data.createdAt ?? "",
        text: body,
      } satisfies MemoryEntry;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function saveMemory(ws: Workspace, entry: MemoryEntry): void {
  const { text, ...data } = entry;
  writeFileAtomic(ws.path("memory", `${entry.id}.md`), stringifyFrontmatter(data, text));
}

export function searchMemory(ws: Workspace, query: string, options: { limit?: number; includeSuperseded?: boolean } = {}) {
  const terms = searchTerms(query);
  const entries = listMemory(ws).filter((e) => options.includeSuperseded || e.status === "active");
  if (terms.length === 0) return entries.slice(-(options.limit ?? 10)).reverse();
  return entries
    .map((entry) => {
      const hay = entry.text.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += t.length > 2 ? 2 : 1;
      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 10)
    .map((s) => s.entry);
}

export type RememberResult =
  | { ok: true; entry: MemoryEntry; similar: MemoryEntry[] }
  | { ok: false; reason: string; similar: MemoryEntry[] };

export function remember(
  ws: Workspace,
  input: { text: string; kind?: MemoryKind; author: string; run?: string; pinned?: boolean; supersedes?: string },
): RememberResult {
  const text = input.text.trim();
  if (!ws.settings().memory.enabled) return { ok: false, reason: "本工作区已关闭记忆", similar: [] };
  if (text.length < 4) return { ok: false, reason: "内容太短", similar: [] };
  if (text.length > MAX_MEMORY_CHARS) return { ok: false, reason: `超过 ${MAX_MEMORY_CHARS} 字，请拆分或精简`, similar: [] };
  const kind = input.kind ?? "fact";
  if (!["fact", "decision", "preference"].includes(kind)) return { ok: false, reason: `kind 只能是 fact / decision / preference`, similar: [] };
  const active = listMemory(ws).filter((e) => e.status === "active");
  const similar = active.filter((e) => e.id !== input.supersedes && similarity(e.text, text) >= 0.5);
  const duplicate = similar.find((e) => similarity(e.text, text) >= DUPLICATE_THRESHOLD);
  if (duplicate) {
    return { ok: false, reason: `与已有记忆 ${duplicate.id} 重复；如需更新请传 supersedes`, similar };
  }
  const entry: MemoryEntry = {
    id: newId("mem"),
    kind,
    status: "active",
    author: input.author,
    run: input.run,
    pinned: input.pinned ?? false,
    createdAt: nowIso(),
    text,
  };
  if (input.supersedes) {
    const old = active.find((e) => e.id === input.supersedes);
    if (!old) return { ok: false, reason: `找不到要替换的记忆 ${input.supersedes}`, similar };
    saveMemory(ws, { ...old, status: "superseded", supersededBy: entry.id });
    entry.pinned = entry.pinned || old.pinned;
  }
  saveMemory(ws, entry);
  return { ok: true, entry, similar };
}

export function updateMemory(ws: Workspace, id: string, patch: { pinned?: boolean; status?: "active" | "superseded" }): MemoryEntry {
  const entry = listMemory(ws).find((e) => e.id === id);
  if (!entry) throw new Error(`找不到记忆 ${id}`);
  const next = { ...entry, ...patch };
  saveMemory(ws, next);
  return next;
}

export function listLessons(ws: Workspace): Lesson[] {
  const dir = ws.path("lessons");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { data, body } = parseFrontmatter<Lesson>(readText(`${dir}/${f}`));
      return {
        id: data.id ?? f.replace(/\.md$/, ""),
        title: data.title ?? "",
        occurrences: data.occurrences ?? 1,
        status: data.status ?? "open",
        hardenedBy: data.hardenedBy,
        createdAt: data.createdAt ?? "",
        updatedAt: data.updatedAt ?? data.createdAt ?? "",
        body,
      } satisfies Lesson;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function saveLesson(ws: Workspace, lesson: Lesson): void {
  const { body, ...data } = lesson;
  writeFileAtomic(ws.path("lessons", `${lesson.id}.md`), stringifyFrontmatter(data, body));
}

/** Records a lesson; a similar open lesson gets its occurrence count bumped instead. */
export function recordLesson(ws: Workspace, input: { title: string; body: string }): { lesson: Lesson; repeated: boolean } {
  const title = input.title.trim();
  if (!title) throw new Error("教训需要标题");
  const existing = listLessons(ws).find((l) => l.status !== "closed" && similarity(l.title, title) >= 0.6);
  if (existing) {
    const lesson = {
      ...existing,
      occurrences: existing.occurrences + 1,
      updatedAt: nowIso(),
      body: `${existing.body}\n\n---\n${nowIso().slice(0, 10)}：${input.body.trim()}`,
    };
    saveLesson(ws, lesson);
    return { lesson, repeated: true };
  }
  const lesson: Lesson = {
    id: newId("lesson"),
    title,
    occurrences: 1,
    status: "open",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    body: input.body.trim(),
  };
  saveLesson(ws, lesson);
  return { lesson, repeated: false };
}

export function updateLesson(ws: Workspace, id: string, patch: Partial<Pick<Lesson, "status" | "hardenedBy" | "title" | "body">>): Lesson {
  const lesson = listLessons(ws).find((l) => l.id === id);
  if (!lesson) throw new Error(`找不到教训 ${id}`);
  const next = { ...lesson, ...patch, updatedAt: nowIso() };
  saveLesson(ws, next);
  return next;
}

export function handoffMarkdown(h: Handoff): string {
  const lines = [
    `# 交接 · ${h.stage} · ${h.agentId}${h.auto ? "（自动生成）" : ""}`,
    "",
    h.verdict ? `**结论**：${h.verdict === "pass" ? "通过" : "不通过"}\n` : "",
    `## 做了什么\n${h.done || "（无）"}`,
    "",
    `## 改了哪些文件\n${h.files.length ? h.files.map((f) => `- ${f}`).join("\n") : "（无）"}`,
    "",
    h.issues?.length ? `## 问题\n${h.issues.map((i) => `- ${i}`).join("\n")}\n` : "",
    `## 还剩什么\n${h.remaining || "（无）"}`,
    "",
    `## 建议下一步\n${h.next || "（无）"}`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function saveHandoff(ws: Workspace, h: Handoff): string {
  const rel = `handoffs/${h.threadId}/${h.runId}.md`;
  const { done: _d, ...meta } = h;
  writeFileAtomic(ws.path(rel), stringifyFrontmatter({ ...meta, files: h.files }, handoffMarkdown(h)));
  return `.baton/${rel}`;
}
