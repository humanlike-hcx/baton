import { useMemo, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import { ROLE_LABEL, SOURCE_LABEL } from "@/lib/format";
import { navigate } from "@/lib/router";
import { useBaton } from "@/lib/store";
import type { Role, Stage, Thread } from "@/lib/types";

const START_STAGES: { value: Stage; label: string; hint: string }[] = [
  { value: "plan", label: "从方案开始", hint: "推荐。先定方案和验收标准，再交给实现。" },
  { value: "implement", label: "直接实现", hint: "需求已经很清楚时用。" },
  { value: "review", label: "只做检查", hint: "审查工作区里现有的改动。" },
];

export function NewThread() {
  const { state } = useBaton();
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [criteria, setCriteria] = useState<string[]>([""]);
  const [stage, setStage] = useState<Stage>("plan");
  const [agentId, setAgentId] = useState<string>("auto");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const role: Role = stage === "plan" ? "plan" : stage === "review" ? "review" : "implement";
  const candidates = useMemo(() => (state?.agents ?? []).filter((a) => a.roles.includes(role) && a.enabled), [state, role]);
  const filled = criteria.map((c) => c.trim()).filter(Boolean);

  const submit = async () => {
    setError(undefined);
    if (!title.trim()) return setError("请填写标题");
    if (!filled.length) return setError("至少写一条验收标准：完成时怎么判断做对了");
    setSubmitting(true);
    try {
      const thread = await post<Thread>("/api/threads", {
        title,
        task: task || title,
        acceptance: filled,
        stage,
        agentId: agentId === "auto" ? undefined : agentId,
      });
      navigate({ page: "threads", threadId: thread.id });
    } catch (e) {
      setError((e as Error).message);
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <h1 className="text-xl font-semibold">新线程</h1>
        <p className="mt-1 text-sm text-muted-foreground">写清楚要做什么、做完怎么验收。agent 会在 {state?.workspace.name ?? "当前工作区"} 里接力完成。</p>

        <div className="mt-6 space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="title">标题</Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：给设置页加上导出配置的按钮" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task">要做的事</Label>
            <Textarea
              id="task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={5}
              placeholder="背景、约束、相关文件……写给一个没看过这个项目的人。"
            />
          </div>

          <div className="space-y-1.5">
            <Label>验收标准</Label>
            <p className="text-xs text-muted-foreground">每条都要能检验。检查阶段会逐条对照；没有验收标准的交接不会被接受。</p>
            <div className="space-y-2">
              {criteria.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <span className="mt-2 w-5 text-right text-sm text-muted-foreground tabular-nums">{i + 1}.</span>
                  <Input
                    value={c}
                    onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? e.target.value : x)))}
                    placeholder={i === 0 ? "例如：点击按钮后下载 baton.json" : "再加一条"}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        setCriteria([...criteria.slice(0, i + 1), "", ...criteria.slice(i + 1)]);
                      }
                    }}
                  />
                  {criteria.length > 1 && (
                    <Button variant="ghost" size="icon" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))} aria-label="删除这条">
                      <X />
                    </Button>
                  )}
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setCriteria([...criteria, ""])}>
                <Plus /> 添加一条
              </Button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>起始阶段</Label>
              <Select value={stage} onValueChange={(v) => setStage(v as Stage)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {START_STAGES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{START_STAGES.find((s) => s.value === stage)?.hint}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{ROLE_LABEL[role]} agent</Label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">按规则挑选（最便宜的可用 agent）</SelectItem>
                  {candidates.map((a) => (
                    <SelectItem key={a.id} value={a.id} disabled={!a.available}>
                      {a.name} · {SOURCE_LABEL[a.source]}
                      {!a.available ? "（未登录）" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">后续阶段由工作台按能力、权限、额度、成本挑选。</p>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 className="animate-spin" />}开始
            </Button>
            <Button variant="ghost" onClick={() => history.back()}>
              取消
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
