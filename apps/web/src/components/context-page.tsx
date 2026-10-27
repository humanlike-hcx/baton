import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pin, PinOff, Plus, Search, Sparkles, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, patch, post, put } from "@/lib/api";
import { kb, timeAgo } from "@/lib/format";
import { navigate } from "@/lib/router";
import { useBaton } from "@/lib/store";
import type { Lesson, MemoryEntry, TidyRecord, TidyStatus } from "@/lib/types";

const CONTEXT_LIMIT = 8 * 1024;
const USD_TO_CNY = 7.2;
const MEMORY_KIND = { fact: "事实", decision: "决定", preference: "偏好" } as const;
const LESSON_STATUS = { open: "待固化", hardened: "已固化", closed: "已关闭" } as const;

const bytes = (s: string) => new TextEncoder().encode(s).length;
/** Exact, so「over budget」never reads as two equal rounded numbers. */
const byteCount = (n: number) => `${n.toLocaleString()} 字节`;

function useLoad<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

function LoadState({ error, loading }: { error?: string; loading: boolean }) {
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (loading)
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  return null;
}

function ContextTab() {
  const { subscribe } = useBaton();
  const { data, error, reload } = useLoad<{ content: string }>("/api/context");
  const tidy = useLoad<TidyStatus>("/api/context/tidy");
  const [content, setContent] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dirty = data !== undefined && content !== data.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (data) setContent(data.content);
  }, [data]);
  // A tidy (or its undo) rewrites CONTEXT.md; pick that up unless the user is mid-edit.
  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.type !== "tidy") return;
        void tidy.reload();
        if (!dirtyRef.current) void reload();
      }),
    [subscribe, reload, tidy.reload],
  );

  const size = bytes(content ?? "");
  const budget = tidy.data?.budget;
  const running = tidy.data?.records.find((r) => r.status === "running");

  const save = async () => {
    setSaving(true);
    try {
      await put("/api/context", { content });
      await reload();
      toast.success(budget && size > budget && !tidy.data?.unavailable ? "已保存。超过了预算，整理员开始整理" : "已保存 CONTEXT.md");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const startTidy = async () => {
    try {
      await post("/api/context/tidy", {});
      await tidy.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (content === undefined) return <LoadState error={error} loading />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        房间上下文：项目是什么、当前目标、约定。每个模型开始回复时都会读到，模型也可以用 <code className="rounded bg-muted px-1">update_context</code> 维护它。保持精简，细节放进记忆；超过预算时，整理员会合并重复内容、把细节移进记忆，改动可以撤销。
      </p>
      <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={18} className="font-mono text-xs leading-relaxed" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={cn("text-xs tabular-nums", size > CONTEXT_LIMIT ? "text-destructive" : budget && size > budget ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          {byteCount(size)}
          {budget !== undefined && ` · 预算 ${byteCount(budget)}`} · 上限 {byteCount(CONTEXT_LIMIT)}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={startTidy} disabled={dirty || Boolean(running) || Boolean(tidy.data?.unavailable)} title={tidy.data?.unavailable}>
            {running ? <Loader2 className="animate-spin" /> : <Sparkles />}现在整理
          </Button>
          <Button onClick={save} disabled={!dirty || saving || size > CONTEXT_LIMIT}>
            {saving && <Loader2 className="animate-spin" />}保存
          </Button>
        </div>
      </div>
      {tidy.data && <TidyPanel status={tidy.data} onChange={() => void Promise.all([tidy.reload(), reload()])} />}
    </div>
  );
}

const TIDY_STATUS: Record<TidyRecord["status"], { label: string; tone: string }> = {
  running: { label: "整理中", tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  applied: { label: "已生效", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  failed: { label: "没整理成", tone: "bg-red-500/15 text-red-700 dark:text-red-300" },
  undone: { label: "已撤销", tone: "bg-muted text-muted-foreground" },
};

function TidyPanel({ status, onChange }: { status: TidyStatus; onChange: () => void }) {
  const [open, setOpen] = useState<string>();
  const undo = async (id: string) => {
    try {
      await post(`/api/context/tidy/${id}/undo`, {});
      toast.success("已撤销这次整理，移进记忆的条目已标为过时");
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-2 pt-2">
      {status.overBudget && status.unavailable && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">房间上下文超过了预算，但现在没法自动整理：{status.unavailable}。</p>
      )}
      {status.records.length > 0 && <h3 className="text-sm font-medium">整理记录</h3>}
      {status.records.map((r, i) => (
        <div key={r.id} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={cn("rounded px-1.5 py-0.5 text-xs", TIDY_STATUS[r.status].tone)}>{TIDY_STATUS[r.status].label}</span>
            <span className="text-xs text-muted-foreground">
              {r.trigger === "auto" ? "超预算自动整理" : "手动整理"} · {r.model} · {timeAgo(r.createdAt)}
              {r.costUsd ? ` · ¥${(r.costUsd * USD_TO_CNY).toFixed(3)}` : ""}
            </span>
            <div className="ml-auto flex gap-1">
              {r.after !== undefined && (
                <Button variant="ghost" size="sm" onClick={() => setOpen(open === r.id ? undefined : r.id)}>
                  {open === r.id ? "收起" : "查看改动"}
                </Button>
              )}
              {r.status === "applied" && i === status.records.findIndex((x) => x.status === "applied") && (
                <Button variant="outline" size="sm" onClick={() => undo(r.id)}>
                  <Undo2 />
                  撤销
                </Button>
              )}
            </div>
          </div>
          {r.status === "running" && <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />正在合并重复内容、把细节移进记忆…</p>}
          {r.summary && <p className="mt-1.5 text-sm">{r.summary}</p>}
          {r.error && <p className="mt-1.5 text-sm text-destructive">{r.error}</p>}
          {r.after !== undefined && <p className="mt-1 text-xs text-muted-foreground tabular-nums">{byteCount(bytes(r.before))} → {byteCount(bytes(r.after))}（预算 {byteCount(r.budget)}）</p>}
          {open === r.id && r.after !== undefined && (
            <div className="mt-3 space-y-3">
              <pre className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5">
                {lineDiff(r.before, r.after).map((line, k) => (
                  <div
                    key={k}
                    className={cn(
                      "break-all whitespace-pre-wrap",
                      line.op === "+" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
                      line.op === "-" && "bg-red-500/10 text-red-800 dark:text-red-300",
                    )}
                  >
                    {`${line.op === " " ? " " : line.op} ${line.text}`}
                  </div>
                ))}
              </pre>
              {r.memories.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">移进记忆 {r.memories.filter((m) => m.id).length} 条</p>
                  <ul className="mt-1 space-y-1 text-sm">
                    {r.memories.map((m, k) => (
                      <li key={k} className={cn("flex gap-2", m.skipped && "text-muted-foreground")}>
                        <Badge variant="secondary" className="shrink-0">{MEMORY_KIND[m.kind]}</Badge>
                        <span>
                          {m.text}
                          {m.skipped && <span className="text-xs">（没写入：{m.skipped}）</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Line diff by longest common subsequence; CONTEXT.md is at most 8KB, so the table stays small. */
function lineDiff(before: string, after: string): { op: " " | "+" | "-"; text: string }[] {
  const a = before.trimEnd().split("\n");
  const b = after.trimEnd().split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { op: " " | "+" | "-"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i++] });
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < a.length) out.push({ op: "-", text: a[i++] });
  while (j < b.length) out.push({ op: "+", text: b[j++] });
  return out;
}

function MemoryTab() {
  const { data, error, reload } = useLoad<MemoryEntry[]>("/api/memory");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MemoryEntry["kind"]>("fact");
  const [query, setQuery] = useState("");
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [adding, setAdding] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter((m) => (showSuperseded || m.status === "active") && (!q || m.text.toLowerCase().includes(q)));
  }, [data, query, showSuperseded]);
  const supersededCount = (data ?? []).filter((m) => m.status === "superseded").length;

  const add = async () => {
    if (!text.trim()) return;
    setAdding(true);
    try {
      await post("/api/memory", { text, kind });
      setText("");
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const update = async (id: string, body: Partial<Pick<MemoryEntry, "pinned" | "status">>) => {
    try {
      await patch(`/api/memory/${id}`, body);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        长期记忆：值得以后复用的事实、决定、偏好。置顶的会注入每次启动上下文，其余由模型按需用 <code className="rounded bg-muted px-1">memory_search</code> 检索。重复或过长的条目会被拒绝。
      </p>

      <div className="rounded-lg border p-3">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="例如：所有日期统一用 ISO 8601，前端只做展示格式化。" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(v) => setKind(v as MemoryEntry["kind"])}>
            <SelectTrigger size="sm" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(MEMORY_KIND).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground tabular-nums">{text.length}/600</span>
          <Button size="sm" className="ml-auto" onClick={add} disabled={adding || !text.trim() || text.length > 600}>
            {adding ? <Loader2 className="animate-spin" /> : <Plus />}记住
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选记忆" className="pl-8" />
        </div>
        {supersededCount > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setShowSuperseded(!showSuperseded)}>
            {showSuperseded ? "隐藏" : "显示"}已被取代的 {supersededCount} 条
          </Button>
        )}
      </div>

      <LoadState error={error} loading={!data} />
      {data && visible.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{data.length ? "没有匹配的记忆。" : "还没有记忆。模型做出重要决定时会自己记下来，你也可以在上面添加。"}</p>}
      <div className="space-y-2">
        {visible.map((m) => (
          <div key={m.id} className={cn("rounded-lg border p-3", m.status === "superseded" && "opacity-55")}>
            <div className="flex items-start gap-2">
              <p className={cn("flex-1 text-sm whitespace-pre-wrap", m.status === "superseded" && "line-through")}>{m.text}</p>
              {m.status === "active" && (
                <Button variant="ghost" size="icon-sm" onClick={() => update(m.id, { pinned: !m.pinned })} title={m.pinned ? "取消置顶" : "置顶：注入每次启动上下文"}>
                  {m.pinned ? <PinOff /> : <Pin />}
                </Button>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{MEMORY_KIND[m.kind]}</Badge>
              {m.pinned && <Badge>置顶</Badge>}
              <span>{m.author}</span>
              <span>·</span>
              <span>{timeAgo(m.createdAt)}</span>
              <span className="font-mono">{m.id}</span>
              {m.status === "active" ? (
                <button type="button" className="ml-auto hover:text-foreground" onClick={() => update(m.id, { status: "superseded" })}>
                  标记为过时
                </button>
              ) : (
                <button type="button" className="ml-auto hover:text-foreground" onClick={() => update(m.id, { status: "active" })}>
                  恢复
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LessonsTab() {
  const { data, error, reload } = useLoad<Lesson[]>("/api/lessons");
  const [hardening, setHardening] = useState<Record<string, string>>({});

  const update = async (id: string, body: Partial<Pick<Lesson, "status" | "hardenedBy">>) => {
    try {
      await patch(`/api/lessons/${id}`, body);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        教训：反复出现的问题。模型用 <code className="rounded bg-muted px-1">record_lesson</code> 记录，同一问题会累加次数。出现两次以上的，应该固化成规则、检查命令或测试，而不是继续靠提醒。
      </p>
      <LoadState error={error} loading={!data} />
      {data && data.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">还没有教训。检查不通过、或者同一个问题再次出现时会记在这里。</p>}
      <div className="space-y-2">
        {data?.map((l) => (
          <div key={l.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{l.title}</span>
              <Badge variant={l.status === "open" ? (l.occurrences >= 2 ? "destructive" : "secondary") : "outline"}>{LESSON_STATUS[l.status]}</Badge>
              <span className="text-xs text-muted-foreground">出现 {l.occurrences} 次 · {timeAgo(l.updatedAt)}</span>
            </div>
            {l.body && <p className="mt-1.5 text-sm whitespace-pre-wrap text-muted-foreground">{l.body}</p>}
            {l.hardenedBy && <p className="mt-1.5 text-xs">固化为：<span className="font-mono">{l.hardenedBy}</span></p>}
            {l.status === "open" && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Input
                  className="h-7 min-w-48 flex-1 text-xs"
                  placeholder="固化到哪里：检查命令名、规则文件或测试路径"
                  value={hardening[l.id] ?? ""}
                  onChange={(e) => setHardening({ ...hardening, [l.id]: e.target.value })}
                />
                <Button size="sm" disabled={!hardening[l.id]?.trim()} onClick={() => update(l.id, { status: "hardened", hardenedBy: hardening[l.id].trim() })}>
                  标记已固化
                </Button>
                <Button size="sm" variant="ghost" onClick={() => update(l.id, { status: "closed" })}>
                  关闭
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RulesTab() {
  const { data, error, reload } = useLoad<{ name: string; content: string }[]>("/api/rules");
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const current = data?.find((r) => r.name === selected) ?? data?.[0];

  useEffect(() => {
    if (current) {
      setSelected(current.name);
      setDraft(current.content);
    }
  }, [current?.name, current?.content]);

  const save = async () => {
    if (!current) return;
    setSaving(true);
    try {
      await put(`/api/rules/${current.name}`, { content: draft });
      await reload();
      toast.success(`已保存 ${current.name}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <LoadState error={error} loading />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">规则分层组装：通用规则 + 角色规则（对话 / 检查）+ 运行时规则 + 模型家族规则。改这里会影响之后所有回复的启动上下文。</p>
      <div className="flex flex-col gap-3 md:flex-row">
        <div className="flex gap-1 overflow-x-auto md:w-48 md:shrink-0 md:flex-col">
          {data.map((r) => (
            <button
              key={r.name}
              type="button"
              onClick={() => setSelected(r.name)}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1.5 text-left font-mono text-xs transition-colors",
                current?.name === r.name ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {r.name}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={18} className="font-mono text-xs leading-relaxed" />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground tabular-nums">{kb(bytes(draft))}</span>
            <Button onClick={save} disabled={saving || draft === current?.content}>
              {saving && <Loader2 className="animate-spin" />}保存
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { value: "context", label: "房间上下文" },
  { value: "memory", label: "记忆" },
  { value: "lessons", label: "教训" },
  { value: "rules", label: "规则" },
];

export function ContextPage({ tab }: { tab?: string }) {
  const active = TABS.some((t) => t.value === tab) ? tab! : "context";
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <h1 className="text-xl font-semibold">上下文与记忆</h1>
        <p className="mt-1 text-sm text-muted-foreground">所有模型共享的这一套：它们读同一份上下文、写同一份记忆，在同一个工作区里改同一批文件。</p>
        <Tabs value={active} onValueChange={(v) => navigate({ page: "context", tab: v })} className="mt-6">
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="context" className="mt-4">
            <ContextTab />
          </TabsContent>
          <TabsContent value="memory" className="mt-4">
            <MemoryTab />
          </TabsContent>
          <TabsContent value="lessons" className="mt-4">
            <LessonsTab />
          </TabsContent>
          <TabsContent value="rules" className="mt-4">
            <RulesTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
