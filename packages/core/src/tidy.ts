import fs from "node:fs";
import { listMemory, remember, updateMemory } from "./memory.ts";
import type { MemoryKind, TidyMemory, TidyRecord, TidyStatus } from "./types.ts";
import { byteLength, newId, nowIso, readJson, writeFileAtomic } from "./util.ts";
import type { Workspace } from "./workspace.ts";

/** Hard cap on CONTEXT.md: writes above it are refused. The tidy budget (settings) sits below it. */
export const CONTEXT_MAX_BYTES = 8 * 1024;

/** One completion on the tidy model: DeepSeek in real workspaces, a scripted faux model in the demo. */
export interface TidyModel {
  name: string;
  complete(system: string, prompt: string): Promise<{ text: string; costUsd?: number }>;
}

export const TIDY_SYSTEM = "你是 Baton 的整理员，负责让房间上下文（CONTEXT.md）保持精简，同时不丢任何约束和决定。";

export function tidyPrompt(context: string, budget: number, memories: string[]): string {
  return [
    `房间上下文现在有 ${byteLength(context)} 字节，预算是 ${budget} 字节。请整理它：`,
    "1. 合并重复或意思相同的内容；",
    "2. 把细节、过时的进展、具体数值和例子移进记忆，房间上下文里只留长期有效的目标、约束、当前状态和约定；",
    "3. 不要丢掉任何约束或决定：要么留在上下文里，要么移进记忆；",
    "4. 保留原来的标题结构和语言；",
    `5. 整理后的上下文必须少于 ${budget} 字节，最好留出两成余量。`,
    "",
    memories.length ? `已有记忆（不要重复写入）：\n${memories.map((m) => `- ${m}`).join("\n")}` : "现在还没有记忆。",
    "",
    "只输出一个 JSON 代码块，不要别的内容：",
    "```json",
    '{"context": "整理后的完整 CONTEXT.md", "memories": [{"kind": "fact 或 decision 或 preference", "text": "移进记忆的一条，600 字以内"}], "summary": "一句话说明做了什么"}',
    "```",
    "",
    "当前的 CONTEXT.md：",
    "<context>",
    context.trim(),
    "</context>",
  ].join("\n");
}

const KINDS: MemoryKind[] = ["fact", "decision", "preference"];

/** Reads the tidy model's reply: a fenced JSON block, or the outermost JSON object. */
export function parseTidy(text: string): { context: string; memories: TidyMemory[]; summary: string } | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  for (const candidate of [fenced, start >= 0 && end > start ? text.slice(start, end + 1) : undefined]) {
    if (!candidate) continue;
    let data: { context?: unknown; memories?: unknown; summary?: unknown };
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof data.context !== "string" || !data.context.trim()) continue;
    const memories = (Array.isArray(data.memories) ? data.memories : [])
      .map((m: { kind?: unknown; text?: unknown }) => ({
        kind: KINDS.includes(m?.kind as MemoryKind) ? (m.kind as MemoryKind) : "fact",
        text: typeof m?.text === "string" ? m.text.trim() : "",
      }))
      .filter((m) => m.text);
    return { context: data.context.trim(), memories, summary: typeof data.summary === "string" ? data.summary.trim() : "" };
  }
  return undefined;
}

/**
 * Keeps CONTEXT.md under its budget: when a write pushes it over, the tidy model merges duplicates and
 * moves details into memory. The result is applied right away and recorded with the text before and
 * after, so it can be undone.
 */
export class ContextTidier {
  private running?: Promise<void>;

  constructor(
    private readonly ws: Workspace,
    private readonly options: {
      model: () => TidyModel | undefined;
      /** Why `model()` is empty, shown to the user. */
      unavailableReason: () => string;
      onChange: () => void;
    },
  ) {
    for (const record of this.records()) {
      if (record.status !== "running") continue;
      this.save({ ...record, status: "failed", error: "工作台重启，整理被中断了", endedAt: nowIso() });
    }
  }

  budget(): number {
    return Math.min(this.ws.settings().budgets.context, CONTEXT_MAX_BYTES);
  }

  records(): TidyRecord[] {
    const dir = this.ws.path("tidy");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<TidyRecord | undefined>(this.ws.path("tidy", f), undefined))
      .filter((r): r is TidyRecord => r !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  status(): TidyStatus {
    const bytes = byteLength(this.ws.readContext());
    const budget = this.budget();
    return { bytes, budget, overBudget: bytes > budget, unavailable: this.unavailable(), records: this.records().slice(0, 10) };
  }

  /** Called after every write to CONTEXT.md. */
  maybeAuto(): void {
    if (this.running || this.unavailable()) return;
    const context = this.ws.readContext();
    if (byteLength(context) <= this.budget()) return;
    // Text the user already undid, or that the model could not tidy, is not retried on its own.
    const latest = this.records()[0];
    if (latest && latest.status !== "applied" && latest.before === context) return;
    this.start("auto");
  }

  start(trigger: TidyRecord["trigger"]): TidyRecord {
    if (this.running) throw new Error("正在整理，等这一次结束");
    const reason = this.unavailable();
    if (reason) throw new Error(reason);
    const model = this.options.model()!;
    const record: TidyRecord = {
      id: newId("tidy"),
      trigger,
      status: "running",
      model: model.name,
      budget: this.budget(),
      createdAt: nowIso(),
      before: this.ws.readContext(),
      memories: [],
    };
    this.save(record);
    this.running = this.run(record, model).finally(() => {
      this.running = undefined;
      this.options.onChange();
      this.maybeAuto();
    });
    return record;
  }

  /** Resolves once the tidy in progress (if any) has finished. */
  async idle(): Promise<void> {
    await this.running;
  }

  undo(id: string): TidyRecord {
    const record = this.records().find((r) => r.id === id);
    if (!record) throw new Error(`找不到整理记录 ${id}`);
    if (record.status !== "applied") throw new Error("只能撤销已生效的整理");
    if (this.ws.readContext().trim() !== record.after?.trim()) throw new Error("整理之后房间上下文又改过了，不能直接撤销。可以对照整理前的原文手动改回。");
    const undone: TidyRecord = { ...record, status: "undone" };
    // Saved before the write so the write's own auto-tidy check sees this text was undone.
    this.save(undone);
    this.ws.writeContext(record.before);
    for (const m of record.memories) {
      if (m.id) updateMemory(this.ws, m.id, { status: "superseded" });
    }
    this.options.onChange();
    return undone;
  }

  private unavailable(): string | undefined {
    if (!this.ws.settings().memory.enabled) return "本工作区关闭了记忆，整理员没法把细节移进记忆";
    return this.options.model() ? undefined : this.options.unavailableReason();
  }

  private async run(record: TidyRecord, model: TidyModel): Promise<void> {
    const fail = (error: string) => this.save({ ...record, status: "failed", error, endedAt: nowIso() });
    let reply: { text: string; costUsd?: number };
    try {
      const memories = listMemory(this.ws)
        .filter((m) => m.status === "active")
        .map((m) => m.text);
      reply = await model.complete(TIDY_SYSTEM, tidyPrompt(record.before, record.budget, memories));
    } catch (error) {
      return fail(`整理员调用失败：${(error as Error).message}`);
    }
    record.costUsd = reply.costUsd;
    const result = parseTidy(reply.text);
    if (!result) return fail("整理员没有按格式给出整理结果");
    const after = `${result.context}\n`;
    if (byteLength(after) > record.budget) return fail(`整理后仍有 ${byteLength(after)} 字节，超过预算 ${record.budget} 字节`);
    if (this.ws.readContext() !== record.before) return fail("整理期间房间上下文又被改过，已放弃这次整理");

    const memories = result.memories.map((m): TidyMemory => {
      const written = remember(this.ws, { kind: m.kind, text: m.text, author: `整理员 · ${model.name}` });
      return written.ok ? { ...m, id: written.entry.id } : { ...m, skipped: written.reason };
    });
    this.save({ ...record, status: "applied", after, summary: result.summary, memories, endedAt: nowIso() });
    this.ws.writeContext(after);
  }

  private save(record: TidyRecord): void {
    writeFileAtomic(this.ws.path("tidy", `${record.id}.json`), JSON.stringify(record, null, 2));
    this.options.onChange();
  }
}
