import { ArrowRight, ClipboardCheck, Hammer, Lightbulb, Plus, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { STAGE_LABEL, STATUS_LABEL, STATUS_TONE, timeAgo } from "@/lib/format";
import { href } from "@/lib/router";
import { useBaton } from "@/lib/store";
import { cn } from "@/lib/utils";

const FLOW = [
  { icon: Lightbulb, title: "方案", text: "读需求和代码，定方案与验收标准，提议下一阶段。不改代码。" },
  { icon: Hammer, title: "实现", text: "按交接改代码。开始前自动快照，随时可以回滚。" },
  { icon: ClipboardCheck, title: "检查", text: "先跑检查命令，再由另一个模型家族对照验收标准审查。" },
  { icon: ShieldCheck, title: "你来确认", text: "方案→实现、标记完成、触发规则时停下来等你。" },
];

export function ThreadsHome() {
  const { state, error } = useBaton();
  if (error && !state) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <p className="text-sm font-medium">连不上本地服务</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  const available = state.agents.filter((a) => a.enabled && a.available);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">线程</h1>
            <p className="mt-1 text-sm text-muted-foreground">一件事一个线程。agent 只提议下一阶段，交给谁由规则决定。</p>
          </div>
          <Button asChild>
            <a href={href({ page: "new" })}>
              <Plus /> 新线程
            </a>
          </Button>
        </div>

        {state.workspace.demo && (
          <div className="mt-6 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 text-sm">
            <div className="font-medium">这是演示工作区</div>
            <p className="mt-1 text-muted-foreground">
              四个「演示」agent 用脚本化的假模型跑完整流程（工具调用、审批、交接、退回、顾问、回滚），不消耗任何额度。在任务里写「退回」可以看到检查不通过时的退回。
              接入真实模型请到
              <a className="mx-1 underline" href={href({ page: "settings", tab: "accounts" })}>
                设置 → 账号
              </a>
              登录，再打开你自己的项目目录。
            </p>
          </div>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FLOW.map((f, i) => (
            <Card key={f.title} className="py-4">
              <CardContent className="px-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <f.icon className="size-4 text-muted-foreground" />
                  {f.title}
                  {i < FLOW.length - 1 && <ArrowRight className="ml-auto hidden size-3.5 text-muted-foreground lg:block" />}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{f.text}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">全部线程</h2>
            <span className="text-xs text-muted-foreground">可用 agent：{available.length} 个</span>
          </div>
          {state.threads.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed p-8 text-center">
              <p className="text-sm font-medium">还没有线程</p>
              <p className="mt-1 text-sm text-muted-foreground">写下要做的事和验收标准，工作台会按「方案 → 实现 → 检查」安排 agent 接力。</p>
              <Button asChild className="mt-4" variant="outline">
                <a href={href({ page: "new" })}>创建第一个线程</a>
              </Button>
            </div>
          ) : (
            <div className="mt-3 divide-y rounded-xl border">
              {state.threads.map((t) => (
                <a key={t.id} href={href({ page: "threads", threadId: t.id })} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {STAGE_LABEL[t.stage]} · {t.runs} 次运行 · {timeAgo(t.updatedAt)}
                    </div>
                  </div>
                  {t.pending && <span className="hidden text-xs text-amber-700 sm:inline">{t.pending}</span>}
                  <Badge className={cn("border-0", STATUS_TONE[t.status])}>{STATUS_LABEL[t.status]}</Badge>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
