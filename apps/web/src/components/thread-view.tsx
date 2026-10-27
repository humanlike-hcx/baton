import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, ClipboardCheck, CircleStop, FileDiff, FolderOpen, Hash, Loader2, PanelRight, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { familyLabel } from "@baton/core/families";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { del, post } from "@/lib/api";
import { ACCESS_LABEL, ROLE_LABEL, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, kb, tokens } from "@/lib/format";
import { findModel, rememberModel, sameModel, toChatModel, usableModels, useModels } from "@/lib/models";
import { projectOfThread, useSwitchProject } from "@/lib/projects";
import { navigate } from "@/lib/router";
import { useBaton, useThread } from "@/lib/store";
import type { ChatAccess, ChatModel, Thread } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AccessSwitch } from "./access-switch";
import { DiffDialog } from "./diff-dialog";
import { ModelPicker } from "./model-picker";
import { TimelineView } from "./timeline";

const busy = (thread: Thread) => thread.status === "running" || thread.status === "waiting";

/** Whether the chat has changes a review hasn't seen yet, and the family of the model that made the latest of them. */
function reviewable(thread: Thread): { reason?: string; authorFamily?: string } {
  if (busy(thread)) return { reason: "正在回复，等这一轮结束再检查" };
  const lastReview = thread.runs.findLastIndex((r) => r.role === "review" && r.review);
  const changed = (runs: Thread["runs"]) => runs.filter((r) => r.role === "chat" && r.changedFiles.length > 0);
  if (changed(thread.runs).length === 0) return { reason: "这个对话还没有改动可以检查" };
  const pending = changed(thread.runs.slice(lastReview + 1));
  if (pending.length === 0) return { reason: "上次检查之后这个对话没有新的改动" };
  return { authorFamily: pending.at(-1)!.family };
}

function RunsPanel({ thread, onDiff }: { thread: Thread; onDiff: (runId: string, title: string) => void }) {
  const total = thread.runs.reduce((acc, r) => ({ tokens: acc.tokens + (r.usage?.totalTokens ?? 0), cost: acc.cost + (r.usage?.costUsd ?? 0) }), { tokens: 0, cost: 0 });
  return (
    <div className="space-y-5 text-sm">
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">这个对话</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">模型</dt>
          <dd>{thread.model ? `${thread.model.name} · ${SOURCE_LABEL[thread.model.source]}` : "还没选"}</dd>
          <dt className="text-muted-foreground">权限</dt>
          <dd>{ACCESS_LABEL[thread.access]}（服务重启后回到只读）</dd>
          <dt className="text-muted-foreground">用量</dt>
          <dd>
            {tokens(total.tokens)} tokens{total.cost > 0 ? ` · DeepSeek $${total.cost.toFixed(4)}` : ""}
          </dd>
        </dl>
      </section>
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">运行记录</h3>
        {thread.runs.length === 0 && <p className="text-xs text-muted-foreground">还没有回复。</p>}
        <div className="space-y-2">
          {thread.runs.map((r) => (
            <div key={r.id} className="rounded-lg border p-2">
              <div className="flex items-center gap-1.5">
                <span className={cn("text-xs font-medium", r.role === "review" && "text-amber-600 dark:text-amber-300")}>{ROLE_LABEL[r.role]}</span>
                <span className="truncate">{r.agentName}</span>
                <span
                  className={cn(
                    "ml-auto shrink-0 text-xs",
                    r.status === "succeeded" ? "text-emerald-600" : r.status === "running" ? "text-sky-600" : r.status === "failed" ? "text-red-600" : "text-muted-foreground",
                  )}
                >
                  {r.review ? (r.review.verdict === "pass" ? "通过" : "不通过") : { succeeded: "完成", running: "运行中", failed: "失败", cancelled: "取消" }[r.status]}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                <span>
                  {r.runtime === "cursor" ? "Cursor" : "Pi"} · {r.model} · {familyLabel(r.family)}
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

/** 「让另一个模型检查」: pick a reviewer, by default one from a different family than the model that made the changes. */
function ReviewDialog({ thread, authorFamily, open, onOpenChange }: { thread: Thread; authorFamily?: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { state } = useBaton();
  const { routes } = useModels();
  const [picked, setPicked] = useState<ChatModel>();
  const [starting, setStarting] = useState(false);
  const usable = usableModels(routes, state?.workspace.demo ?? false);
  const fallback = usable.find((m) => m.option.family !== authorFamily) ?? usable[0];
  const reviewer = picked ?? (fallback ? toChatModel(fallback) : undefined);
  const reviewerFamily = findModel(routes, reviewer)?.option.family;
  const sameFamily = Boolean(authorFamily && reviewerFamily === authorFamily);

  useEffect(() => {
    if (open) setPicked(undefined);
  }, [open]);

  const start = async () => {
    if (!reviewer) return;
    setStarting(true);
    try {
      await post(`/api/threads/${thread.id}/review`, { source: reviewer.source, model: reviewer.model });
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>让另一个模型检查</DialogTitle>
          <DialogDescription>
            先在工作区跑配置的检查命令，再由它只读地审查这个对话里还没检查过的改动，给出通过或不通过和具体问题。检查命令失败时结论不能是通过。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <ModelPicker
            value={reviewer}
            onChange={setPicked}
            authorFamily={authorFamily}
            title="选择检查的模型"
            description={authorFamily ? `改动是 ${familyLabel(authorFamily)} 家族的模型做的，推荐选别的家族。` : "推荐选和改动作者不同家族的模型。"}
            size="default"
            className="flex w-full"
          />
          {sameFamily && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              它和改动作者同属 {familyLabel(authorFamily!)} 家族，容易看不出自己家族的盲点。可以检查，但更推荐换一个家族。
            </p>
          )}
          {state && state.settings.checks.length === 0 && <p className="text-xs text-muted-foreground">这个工作区还没有配置检查命令，只做模型审查。可以到「设置 → 检查命令」添加。</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!reviewer || starting} onClick={() => void start()}>
            {starting && <Loader2 className="animate-spin" />}开始检查
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function composerHint(thread: Thread): string {
  if (thread.status === "running") return "正在回复。现在发的消息会在这一轮结束后接着回复。";
  if (thread.status === "waiting") return "排队中：另一个对话正在改文件。现在发的消息会一起带上。";
  if (thread.status === "paused") return "已暂停。发消息继续。";
  return "接着聊…";
}

export function ThreadView({ threadId }: { threadId: string }) {
  const { thread, error, loading } = useThread(threadId);
  const { state } = useBaton();
  const project = projectOfThread(state, threadId);
  const projectRoot = project?.root;
  const switchProject = useSwitchProject();
  // The management pages and the model list follow the project of the chat being viewed.
  useEffect(() => {
    if (projectRoot) switchProject(projectRoot).catch((e: Error) => toast.error(e.message));
  }, [projectRoot, switchProject]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [picked, setPicked] = useState<ChatModel>();
  const [diff, setDiff] = useState<{ runId: string; title: string }>();
  const [rollbackRun, setRollbackRun] = useState<string>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const replyModel = picked ?? thread?.model;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread]);

  useEffect(() => {
    stick.current = true;
    setPicked(undefined);
  }, [threadId]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const send = async () => {
    if (!text.trim() || !thread) return;
    if (!replyModel) return toast.error("请先选择一个模型");
    setSending(true);
    try {
      const switching = !sameModel(replyModel, thread.model);
      await post(`/api/threads/${thread.id}/messages`, { text, ...(switching ? { source: replyModel.source, model: replyModel.model } : {}) });
      rememberModel(replyModel);
      setPicked(undefined);
      setText("");
      stick.current = true;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const setAccess = (access: ChatAccess) => act(() => post(`/api/threads/${threadId}/access`, { access }));

  const doRollback = async () => {
    if (!rollbackRun) return;
    await act(async () => {
      const res = await post<{ files: string[] }>(`/api/runs/${rollbackRun}/rollback`);
      toast.success(`已回滚，恢复了 ${res.files.length} 个文件`);
    });
    setRollbackRun(undefined);
  };

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="link" onClick={() => navigate({ page: "threads" })}>
            开始新对话
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

  const review = reviewable(thread);
  const panel = <RunsPanel thread={thread} onDiff={(runId, title) => setDiff({ runId, title })} />;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b px-4 py-3 sm:px-6">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold sm:text-lg">{thread.title}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Badge className={cn("border-0", STATUS_TONE[thread.status])}>
                  {thread.status === "running" && <Loader2 className="animate-spin" />}
                  {STATUS_LABEL[thread.status]}
                </Badge>
                {thread.access !== "read" && (
                  <Badge className={cn("border-0", thread.access === "allow" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-sky-500/10 text-sky-700 dark:text-sky-300")}>
                    {ACCESS_LABEL[thread.access]}
                  </Badge>
                )}
                {thread.model && (
                  <span className="text-xs text-muted-foreground">
                    {thread.model.name} · {SOURCE_LABEL[thread.model.source]}
                  </span>
                )}
                {project && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={project.root}>
                    <FolderOpen className="size-3.5" />
                    {project.name}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {busy(thread) && (
                <Button size="sm" variant="outline" onClick={() => void act(() => post(`/api/threads/${threadId}/cancel`))}>
                  <CircleStop /> 取消
                </Button>
              )}
              <span title={review.reason}>
                <Button size="sm" variant="outline" disabled={Boolean(review.reason)} onClick={() => setReviewOpen(true)}>
                  <ClipboardCheck /> <span className="hidden sm:inline">让另一个模型检查</span>
                </Button>
              </span>
              <Button size="icon-sm" variant="ghost" className="xl:hidden" onClick={() => setPanelOpen(true)} aria-label="运行详情">
                <PanelRight />
              </Button>
              {!busy(thread) && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void act(async () => (await del(`/api/threads/${threadId}`), navigate({ page: "threads" })))}
                  aria-label="删除对话"
                  title="删除对话（不影响工作区文件）"
                >
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
            <TimelineView thread={thread} actions={{ showDiff: (runId, title) => setDiff({ runId, title }), rollback: setRollbackRun }} />
            {thread.status === "running" && (
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> 正在回复…
              </div>
            )}
          </div>
        </div>

        <div className="border-t px-4 py-3 sm:px-6">
          <div className="mx-auto mb-2 flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2">
            <ModelPicker value={replyModel} onChange={setPicked} className="max-w-80 min-w-48" />
            {picked && !sameModel(picked, thread.model) && <span className="text-xs text-muted-foreground">下一条消息由它接着回复</span>}
            <div className="ml-auto">
              <AccessSwitch value={thread.access} onChange={(a) => void setAccess(a)} disabled={thread.status === "running"} />
            </div>
          </div>
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
            <Button size="icon-lg" disabled={!text.trim() || sending} onClick={() => void send()} aria-label="发送">
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

      <ReviewDialog thread={thread} authorFamily={review.authorFamily} open={reviewOpen} onOpenChange={setReviewOpen} />
      <DiffDialog runId={diff?.runId} title={diff?.title} onOpenChange={(open) => !open && setDiff(undefined)} />
      <Dialog open={Boolean(rollbackRun)} onOpenChange={(open) => !open && setRollbackRun(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>回到这次回复之前？</DialogTitle>
            <DialogDescription>
              工作区文件会恢复到这次回复开始前的快照，之后所有回复的改动都会被撤销（回滚前会再存一个快照）。记忆和对话记录不受影响。发消息说明要怎么改即可接着聊。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRollbackRun(undefined)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void doRollback()}>
              回滚
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
