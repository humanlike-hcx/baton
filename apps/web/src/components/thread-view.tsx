import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Check, CircleStop, FileDiff, Hash, Loader2, PanelRight, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { del, post } from "@/lib/api";
import { ROLE_LABEL, STAGES, STAGE_LABEL, STATUS_LABEL, STATUS_TONE, kb, tokens } from "@/lib/format";
import { navigate } from "@/lib/router";
import { useThread, useWorkbench } from "@/lib/store";
import type { Thread } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DiffDialog } from "./diff-dialog";
import { TimelineView } from "./timeline";

function StageStepper({ thread }: { thread: Thread }) {
  const current = STAGES.indexOf(thread.stage);
  return (
    <ol className="flex items-center gap-1 text-xs">
      {STAGES.map((stage, i) => {
        const done = i < current || thread.status === "done";
        const active = i === current && thread.status !== "done";
        return (
          <li key={stage} className="flex items-center gap-1">
            {i > 0 && <span className={cn("h-px w-4 sm:w-6", done || active ? "bg-foreground/40" : "bg-border")} />}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                active && "bg-primary text-primary-foreground",
                done && "text-foreground",
                !active && !done && "text-muted-foreground",
              )}
            >
              {done && <Check className="size-3" />}
              {STAGE_LABEL[stage]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function RunsPanel({ thread, onDiff }: { thread: Thread; onDiff: (runId: string, title: string) => void }) {
  return (
    <div className="space-y-5 text-sm">
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">验收标准</h3>
        <ol className="list-decimal space-y-1 pl-5">
          {thread.acceptance.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ol>
      </section>
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">接力</h3>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            ["自动接力", `${thread.hops} 跳`],
            ["退回", `${thread.sendBacks} 轮`],
            ["空转", `${thread.stalls} 次`],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border px-2 py-1.5">
              <div className="text-[11px] text-muted-foreground">{k}</div>
              <div className="font-medium tabular-nums">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          花费：DeepSeek ¥{thread.spend.deepseekCny.toFixed(2)} · ChatGPT {thread.spend.chatgptRuns} 次 · Cursor {thread.spend.cursorRuns} 次
        </div>
      </section>
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">运行记录</h3>
        {thread.runs.length === 0 && <p className="text-xs text-muted-foreground">还没有运行。</p>}
        <div className="space-y-2">
          {thread.runs.map((r) => (
            <div key={r.id} className="rounded-lg border p-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium">{ROLE_LABEL[r.role]}</span>
                <span className="truncate">{r.agentName}</span>
                <span
                  className={cn(
                    "ml-auto text-xs",
                    r.status === "succeeded" ? "text-emerald-600" : r.status === "running" ? "text-sky-600" : r.status === "failed" ? "text-red-600" : "text-muted-foreground",
                  )}
                >
                  {{ succeeded: "完成", running: "运行中", failed: "失败", cancelled: "取消" }[r.status]}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                <span>
                  {r.runtime === "cursor" ? "Cursor" : "Pi"} · {r.model}
                </span>
                <span title={`开场上下文哈希 ${r.briefingHash}`} className="inline-flex items-center gap-0.5">
                  <Hash className="size-3" />
                  {r.briefingHash.slice(0, 8)} · {kb(r.briefingBytes)}
                </span>
                {r.usage && r.usage.totalTokens > 0 && <span>{tokens(r.usage.totalTokens)} tok</span>}
              </div>
              {r.changedFiles.length > 0 && (
                <Button size="xs" variant="ghost" className="mt-1 -ml-1.5" onClick={() => onDiff(r.id, r.changedFiles.join("、"))}>
                  <FileDiff /> {r.changedFiles.length} 个文件
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function composerHint(thread: Thread): string {
  if (thread.status === "running") return "运行中。补充的要求会带给下一次运行。";
  if (thread.pending) return "等你确认上面的卡片。补充的要求会带给下一次运行。";
  if (thread.status === "done") return "线程已完成。发消息会重新打开它，从「实现」继续。";
  if (thread.status === "paused") return `已暂停。发消息后从「${STAGE_LABEL[thread.stage]}」继续。`;
  return "补充要求…";
}

export function ThreadView({ threadId }: { threadId: string }) {
  const { thread, error, loading } = useThread(threadId);
  const { state } = useWorkbench();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [diff, setDiff] = useState<{ runId: string; title: string }>();
  const [rollbackRun, setRollbackRun] = useState<string>();
  const [panelOpen, setPanelOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread]);

  useEffect(() => {
    stick.current = true;
  }, [threadId]);

  const send = async () => {
    if (!text.trim() || !thread) return;
    setSending(true);
    try {
      await post(`/api/threads/${thread.id}/messages`, { text });
      setText("");
      stick.current = true;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    try {
      await post(`/api/threads/${threadId}/cancel`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const doRollback = async () => {
    if (!rollbackRun) return;
    try {
      const res = await post<{ files: string[] }>(`/api/runs/${rollbackRun}/rollback`);
      toast.success(`已回滚，恢复了 ${res.files.length} 个文件`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRollbackRun(undefined);
    }
  };

  const remove = async () => {
    try {
      await del(`/api/threads/${threadId}`);
      navigate({ page: "threads" });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="link" onClick={() => navigate({ page: "threads" })}>
            回到线程列表
          </Button>
        </div>
      </div>
    );
  }
  if (!thread || loading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-3/4" />
      </div>
    );
  }

  const panel = <RunsPanel thread={thread} onDiff={(runId, title) => setDiff({ runId, title })} />;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b px-4 py-3 sm:px-6">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold sm:text-lg">{thread.title}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <StageStepper thread={thread} />
                <Badge className={cn("border-0", STATUS_TONE[thread.status])}>
                  {thread.status === "running" && <Loader2 className="animate-spin" />}
                  {STATUS_LABEL[thread.status]}
                </Badge>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {thread.status === "running" && (
                <Button size="sm" variant="outline" onClick={cancel}>
                  <CircleStop /> 取消
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" className="xl:hidden" onClick={() => setPanelOpen(true)} aria-label="运行详情">
                <PanelRight />
              </Button>
              {thread.status !== "running" && (
                <Button size="icon-sm" variant="ghost" onClick={remove} aria-label="删除线程" title="删除线程（不影响工作区文件）">
                  <Trash2 />
                </Button>
              )}
            </div>
          </div>
        </div>

        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto max-w-4xl">
            <TimelineView thread={thread} agents={state?.agents ?? []} actions={{ showDiff: (runId, title) => setDiff({ runId, title }), rollback: setRollbackRun }} />
            {thread.status === "running" && (
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> agent 正在工作…
              </div>
            )}
          </div>
        </div>

        <div className="border-t px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-4xl items-end gap-2">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={composerHint(thread)}
              className="max-h-40 min-h-11 resize-none"
              rows={1}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button size="icon-lg" disabled={!text.trim() || sending} onClick={send} aria-label="发送">
              {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </div>
        </div>
      </div>

      <aside className="hidden w-80 shrink-0 overflow-y-auto border-l p-4 xl:block">{panel}</aside>
      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>运行详情</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">{panel}</div>
        </SheetContent>
      </Sheet>

      <DiffDialog runId={diff?.runId} title={diff?.title} onOpenChange={(open) => !open && setDiff(undefined)} />
      <Dialog open={Boolean(rollbackRun)} onOpenChange={(open) => !open && setRollbackRun(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>回到这次运行之前？</DialogTitle>
            <DialogDescription>
              工作区文件会恢复到这次运行开始前的快照，之后所有运行的改动都会被撤销（回滚前会再存一个快照）。记忆、交接和线程记录不受影响。线程会暂停，发消息说明要怎么改即可重新开始。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRollbackRun(undefined)}>
              取消
            </Button>
            <Button variant="destructive" onClick={doRollback}>
              回滚
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
