import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  ClipboardCheck,
  FileDiff,
  Info,
  Loader2,
  RotateCcw,
  ShieldQuestion,
  Terminal,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { post } from "@/lib/api";
import { clockTime, kb, tokens } from "@/lib/format";
import type { CheckResult, Thread, TimelineItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RichText } from "./rich-text";

type Item<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;

export interface TimelineActions {
  showDiff: (runId: string, title: string) => void;
  rollback: (runId: string) => void;
}

const CHECK_LABEL: Record<CheckResult["status"], string> = { pass: "通过", fail: "失败", skipped: "跳过（不算通过）", error: "出错" };
const CHECK_ICON: Record<CheckResult["status"], typeof Check> = { pass: CircleCheck, fail: CircleX, skipped: CircleDashed, error: CircleAlert };
const CHECK_TONE: Record<CheckResult["status"], string> = {
  pass: "text-emerald-600",
  fail: "text-red-600",
  skipped: "text-zinc-500",
  error: "text-amber-600",
};

function UserBubble({ item }: { item: Item<"user"> }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground">
        <RichText text={item.text} />
      </div>
    </div>
  );
}

function RunStart({ item }: { item: Item<"run_start"> }) {
  return (
    <div className="flex items-center gap-3 pt-3">
      <div className="h-px flex-1 bg-border" />
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {item.role === "review" && <span className="font-semibold text-amber-600 dark:text-amber-300">检查</span>}
        <span className="font-medium text-foreground">{item.agentName}</span>
        <span>
          {item.runtime === "cursor" ? "Cursor" : "Pi"} · {item.model}
        </span>
        <span title="这次回复开场注入的上下文大小">开场 {kb(item.briefingBytes)}</span>
        <span>{clockTime(item.at)}</span>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function TextBlock({ item }: { item: Item<"text"> }) {
  if (item.thinking) {
    return (
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" /> 思考过程
        </CollapsibleTrigger>
        <CollapsibleContent>
          <RichText text={item.text} className="mt-1 border-l-2 pl-3 text-muted-foreground italic" />
        </CollapsibleContent>
      </Collapsible>
    );
  }
  if (!item.text.trim()) return null;
  return <RichText text={item.text} className="max-w-3xl" />;
}

function ToolRow({ item }: { item: Item<"tool"> }) {
  const icon =
    item.status === "running" ? (
      <Loader2 className="size-3.5 animate-spin text-sky-600" />
    ) : item.status === "ok" ? (
      <Check className="size-3.5 text-emerald-600" />
    ) : item.status === "denied" ? (
      <CircleSlash className="size-3.5 text-amber-600" />
    ) : (
      <CircleX className="size-3.5 text-red-600" />
    );
  let argsPreview = item.args;
  try {
    const parsed = JSON.parse(item.args) as Record<string, unknown>;
    const main = parsed.path ?? parsed.command ?? parsed.query ?? parsed.pattern ?? parsed.text ?? parsed.verdict;
    argsPreview = typeof main === "string" ? main : Object.keys(parsed).length ? JSON.stringify(parsed) : "";
  } catch {
    /* not JSON */
  }
  return (
    <Collapsible className="rounded-lg border bg-muted/20">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs">
        {icon}
        {item.tool === "shell" ? <Terminal className="size-3.5 text-muted-foreground" /> : <Wrench className="size-3.5 text-muted-foreground" />}
        <span className="font-mono font-medium">{item.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{argsPreview}</span>
        {item.tokens !== undefined && <span className="shrink-0 text-muted-foreground tabular-nums" title="工具结果占用的 token 估算">≈{tokens(item.tokens)} tok</span>}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 border-t px-3 py-2">
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground uppercase">参数</div>
            <pre className="max-h-60 overflow-auto rounded bg-background p-2 font-mono text-xs whitespace-pre-wrap break-all">{item.args}</pre>
          </div>
          {item.result !== undefined && (
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground uppercase">结果</div>
              <pre className="max-h-80 overflow-auto rounded bg-background p-2 font-mono text-xs whitespace-pre-wrap break-all">{item.result || "（空）"}</pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ApprovalCard({ item }: { item: Item<"approval"> }) {
  const [busy, setBusy] = useState(false);
  const respond = async (allow: boolean) => {
    setBusy(true);
    try {
      await post(`/api/approvals/${item.approvalId}`, { allow });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pending = item.status === "pending";
  const statusText = { pending: "等你决定", allowed: "已允许", denied: "已拒绝", expired: "已超时（按拒绝处理）" }[item.status];
  return (
    <div className={cn("rounded-xl border p-3", pending ? "border-amber-500/50 bg-amber-500/5 shadow-sm" : "bg-muted/20")}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldQuestion className={cn("size-4", pending ? "text-amber-600" : "text-muted-foreground")} />
        需要审批：{item.title}
        <Badge variant="outline" className="ml-auto">
          {statusText}
        </Badge>
      </div>
      <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-background p-2 font-mono text-xs whitespace-pre-wrap break-all">{item.preview}</pre>
      {pending && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => respond(true)}>
            允许这一次
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => respond(false)}>
            拒绝
          </Button>
        </div>
      )}
    </div>
  );
}

function RunEnd({ item, actions, run }: { item: Item<"run_end">; actions: TimelineActions; run?: Thread["runs"][number] }) {
  const tone = item.status === "succeeded" ? "text-emerald-600" : item.status === "cancelled" ? "text-zinc-500" : "text-red-600";
  const label = { succeeded: run?.role === "review" ? "检查结束" : "回复结束", failed: "运行失败", cancelled: "已取消", running: "运行中" }[item.status];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/30 px-3 py-2 text-xs">
      <span className={cn("font-medium", tone)}>{label}</span>
      <span className="text-muted-foreground">{item.changedFiles.length ? `改了 ${item.changedFiles.length} 个文件` : "没有改文件"}</span>
      {item.usage && item.usage.totalTokens > 0 && (
        <span className="text-muted-foreground tabular-nums">
          {tokens(item.usage.totalTokens)} tokens{item.usage.costUsd > 0 ? ` · $${item.usage.costUsd.toFixed(4)}` : ""}
        </span>
      )}
      {run?.role === "chat" && run.snapshotBefore && (
        <span className="ml-auto flex gap-1">
          {item.changedFiles.length > 0 && (
            <Button size="xs" variant="ghost" onClick={() => actions.showDiff(item.runId, item.changedFiles.join("、"))}>
              <FileDiff /> 查看改动
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => actions.rollback(item.runId)}>
            <RotateCcw /> 回到这次之前
          </Button>
        </span>
      )}
    </div>
  );
}

function ChecksCard({ item }: { item: Item<"checks"> }) {
  return (
    <div className="rounded-xl border p-3">
      <div className="text-sm font-medium">检查命令（先于模型审查运行，失败时结论不能是通过）</div>
      <div className="mt-2 space-y-1.5">
        {item.results.map((r) => {
          const Icon = CHECK_ICON[r.status];
          return (
            <Collapsible key={r.name}>
              <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left text-sm">
                <Icon className={cn("size-4", CHECK_TONE[r.status])} />
                <span className="font-medium">{r.name}</span>
                <span className={cn("text-xs", CHECK_TONE[r.status])}>{CHECK_LABEL[r.status]}</span>
                <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{r.command}</code>
                <span className="text-xs text-muted-foreground tabular-nums">{(r.durationMs / 1000).toFixed(1)}s</span>
                <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
                  退出码 {r.exitCode ?? "无"}
                  {"\n"}
                  {r.output || "（无输出）"}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}

function ReviewCard({ item }: { item: Item<"review"> }) {
  const pass = item.verdict.verdict === "pass";
  return (
    <div className={cn("rounded-xl border p-3", pass ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5")}>
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <ClipboardCheck className={cn("size-4", pass ? "text-emerald-600" : "text-red-600")} />
        {item.agentName} 的检查结论
        <Badge className={pass ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}>{pass ? "通过" : "不通过"}</Badge>
      </div>
      {item.overruled && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {item.overruled}
        </p>
      )}
      {item.verdict.issues.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
          {item.verdict.issues.map((issue, i) => (
            <li key={i}>
              <RichText text={issue} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Notice({ item }: { item: Item<"notice"> }) {
  const Icon = item.level === "error" ? CircleX : item.level === "warn" ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        "flex items-start gap-2 text-xs",
        item.level === "error" ? "rounded-lg border border-red-500/30 bg-red-500/5 p-2 text-red-700 dark:text-red-300" : item.level === "warn" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <RichText text={item.text} className="text-xs" />
    </div>
  );
}

export function TimelineView({ thread, actions }: { thread: Thread; actions: TimelineActions }) {
  return (
    <div className="space-y-3">
      {thread.items.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserBubble key={item.id} item={item} />;
          case "run_start":
            return <RunStart key={item.id} item={item} />;
          case "text":
            return <TextBlock key={item.id} item={item} />;
          case "tool":
            return <ToolRow key={item.id} item={item} />;
          case "approval":
            return <ApprovalCard key={item.id} item={item} />;
          case "run_end":
            return <RunEnd key={item.id} item={item} actions={actions} run={thread.runs.find((r) => r.id === item.runId)} />;
          case "checks":
            return <ChecksCard key={item.id} item={item} />;
          case "review":
            return <ReviewCard key={item.id} item={item} />;
          case "notice":
            return <Notice key={item.id} item={item} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
