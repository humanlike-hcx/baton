import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Eye, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { familyLabel, modelFamily, validateAgentRoute } from "@baton/core/families";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, del, put } from "@/lib/api";
import { kb, ROLE_LABEL, RUNTIME_LABEL, SOURCE_LABEL } from "@/lib/format";
import { href } from "@/lib/router";
import { useBaton } from "@/lib/store";
import type { AgentCard, AgentView, Briefing, ModelOption, ModelsResponse, Role } from "@/lib/types";

const ROLES: Role[] = ["plan", "implement", "review", "advisor"];
const COST_LABEL = ["免费", "便宜", "中等", "贵"];
const POLICY_LABEL = { allow: "直接允许", ask: "每次问我", deny: "禁止" } as const;
const DEMO_MODELS: ModelOption[] = ["demo-plan", "demo-code", "demo-review", "demo-advise"].map((id) => ({ id, name: id }));

const ROUTE: Record<AgentCard["source"], Pick<AgentCard, "runtime" | "provider">> = {
  chatgpt: { runtime: "pi", provider: "openai" },
  deepseek: { runtime: "pi", provider: "deepseek" },
  cursor: { runtime: "cursor", provider: "cursor" },
  demo: { runtime: "pi", provider: "demo" },
};

function blankAgent(): AgentCard {
  return {
    id: "",
    name: "",
    runtime: "cursor",
    source: "cursor",
    provider: "cursor",
    model: "",
    roles: ["implement"],
    permissions: { write: "allow", exec: "ask", network: "ask" },
    costTier: 2,
    enabled: true,
    body: "",
  };
}

function modelsFor(source: AgentCard["source"], models?: ModelsResponse): ModelOption[] {
  if (source === "demo") return DEMO_MODELS;
  if (!models) return [];
  return models[source];
}

function PermissionChips({ agent }: { agent: AgentCard }) {
  const chips = [
    { label: agent.permissions.write === "deny" ? "只读" : `写文件：${POLICY_LABEL[agent.permissions.write]}`, warn: agent.permissions.write === "allow" },
    { label: `命令：${POLICY_LABEL[agent.permissions.exec]}`, warn: agent.permissions.exec === "allow" },
    { label: `联网：${POLICY_LABEL[agent.permissions.network]}`, warn: agent.permissions.network === "allow" },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c.label} className={cn("rounded border px-1.5 py-0.5 text-[11px]", c.warn ? "border-amber-500/30 text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

function AgentCardView({ agent, onEdit, onInspect }: { agent: AgentView; onEdit: () => void; onInspect: () => void }) {
  const family = familyLabel(modelFamily(agent.model, agent.provider));
  return (
    <div className={cn("flex flex-col rounded-xl border bg-card p-4", !agent.enabled && "opacity-60")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{agent.name}</span>
            {!agent.enabled && <Badge variant="outline">已停用</Badge>}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{agent.id}</div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onInspect} aria-label="查看启动上下文" title="查看启动上下文">
          <Eye />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="编辑" title="编辑">
          <Pencil />
        </Button>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">运行时</dt>
        <dd>{RUNTIME_LABEL[agent.runtime]}</dd>
        <dt className="text-muted-foreground">账号</dt>
        <dd className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", agent.available ? "bg-emerald-500" : "bg-zinc-300")} />
          {SOURCE_LABEL[agent.source]}
          {!agent.available && agent.enabled && (
            <a href={href({ page: "settings", tab: "accounts" })} className="text-xs text-primary underline-offset-2 hover:underline">
              去登录
            </a>
          )}
        </dd>
        <dt className="text-muted-foreground">模型</dt>
        <dd className="truncate">
          <span className="font-mono text-xs">{agent.model}</span>
          <span className="ml-1.5 text-xs text-muted-foreground">{family}</span>
        </dd>
        <dt className="text-muted-foreground">成本</dt>
        <dd>{COST_LABEL[agent.costTier] ?? agent.costTier}</dd>
      </dl>

      <div className="mt-3 flex flex-wrap gap-1">
        {agent.roles.map((r) => (
          <Badge key={r} variant="secondary">
            {ROLE_LABEL[r]}
          </Badge>
        ))}
      </div>
      <div className="mt-2">
        <PermissionChips agent={agent} />
      </div>
      {agent.routeError && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {agent.routeError}
        </p>
      )}
    </div>
  );
}

function AgentEditor({ agent, isNew, open, onOpenChange, demo }: { agent: AgentCard; isNew: boolean; open: boolean; onOpenChange: (o: boolean) => void; demo: boolean }) {
  const [draft, setDraft] = useState(agent);
  const [models, setModels] = useState<ModelsResponse>();
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [customModel, setCustomModel] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(agent);
      setError(undefined);
      setCustomModel(false);
    }
  }, [open, agent]);

  const loadModels = async (refresh = false) => {
    setLoadingModels(true);
    try {
      setModels(await api<ModelsResponse>(`/api/models${refresh ? "?refresh=1" : ""}`));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (open && !models) void loadModels();
  }, [open, models]);

  const options = modelsFor(draft.source, models);
  const routeError = validateAgentRoute(draft);
  const readOnlyAdvisor = draft.roles.includes("advisor") && draft.permissions.write !== "deny";
  const showCustom = customModel || (draft.source === "cursor" && !!models && options.length === 0);

  const setSource = (source: AgentCard["source"]) => setDraft((d) => ({ ...d, source, ...ROUTE[source], model: "" }));
  const toggleRole = (role: Role, on: boolean) => setDraft((d) => ({ ...d, roles: on ? [...d.roles, role] : d.roles.filter((r) => r !== role) }));

  const save = async () => {
    setError(undefined);
    const id = draft.id.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return setError("ID 只能用小写字母、数字和短横线");
    if (!draft.name.trim()) return setError("请填写名字");
    if (routeError) return setError(routeError);
    if (!draft.roles.length) return setError("至少选择一个角色");
    if (readOnlyAdvisor) return setError("顾问必须只读：担任顾问时请把写文件设为禁止");
    setSaving(true);
    try {
      await put(`/api/agents/${id}`, { ...draft, id });
      toast.success(isNew ? "已添加 agent" : "已保存");
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`删除 ${draft.name}？它的卡片文件会从 .baton/agents 里移除。`)) return;
    try {
      await del(`/api/agents/${agent.id}`);
      toast.success("已删除");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "添加 agent" : `编辑 ${agent.name}`}</DialogTitle>
          <DialogDescription>一个 agent = 角色 + 运行时 + 账号来源 + 具体模型。同一模型家族只有一条接入路线。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">名字</Label>
              <Input id="agent-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：Sonnet 审查" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-id">ID</Label>
              <Input
                id="agent-id"
                value={draft.id}
                disabled={!isNew}
                onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase() })}
                placeholder="reviewer-cursor-opus"
                className="font-mono"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>账号来源</Label>
              <Select value={draft.source} onValueChange={(v) => setSource(v as AgentCard["source"])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chatgpt">ChatGPT 登录 · Pi 运行时</SelectItem>
                  <SelectItem value="deepseek">DeepSeek key · Pi 运行时</SelectItem>
                  <SelectItem value="cursor">Cursor 登录 · Cursor Agent</SelectItem>
                  {demo && <SelectItem value="demo">演示模型 · Pi 运行时</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>模型</Label>
                <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => void loadModels(true)}>
                  <RefreshCw className={cn("size-3", loadingModels && "animate-spin")} />
                  刷新
                </button>
              </div>
              {showCustom ? (
                <Input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value.trim() })} placeholder="模型 ID，例如 sonnet-4.5" className="font-mono" />
              ) : (
                <Select value={draft.model || undefined} onValueChange={(v) => setDraft({ ...draft, model: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={loadingModels ? "加载模型列表…" : "选择模型"} />
                  </SelectTrigger>
                  <SelectContent>
                    {draft.model && !options.some((m) => m.id === draft.model) && <SelectItem value={draft.model}>{draft.model}</SelectItem>}
                    {options.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name !== m.id ? `${m.name} (${m.id})` : m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                {draft.source === "cursor" && (models?.cursorError ? `读不到 Cursor 模型列表：${models.cursorError}` : "已去掉 GPT 系（只走 ChatGPT）和 Auto。")}
                {draft.source === "chatgpt" && "只列出 GPT 系，用你的 ChatGPT 订阅。"}
                {draft.source === "deepseek" && "唯一用 API key 的来源。"}
                {draft.source === "demo" && "离线脚本模型，用来体验流程。"}{" "}
                {draft.source === "cursor" && !showCustom && (
                  <button type="button" className="text-primary hover:underline" onClick={() => setCustomModel(true)}>
                    手动填写
                  </button>
                )}
              </p>
            </div>
          </div>
          {draft.model && routeError && <p className="text-xs text-destructive">{routeError}</p>}

          <div className="space-y-1.5">
            <Label>角色</Label>
            <div className="flex flex-wrap gap-4">
              {ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={draft.roles.includes(r)} onCheckedChange={(v) => toggleRole(r, v === true)} />
                  {ROLE_LABEL[r]}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">检查者会自动避开实现者的模型家族；顾问只读，只在卡住时被请来。</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {(["write", "exec", "network"] as const).map((k) => (
              <div key={k} className="space-y-1">
                <Label className="text-xs text-muted-foreground">{k === "write" ? "写文件" : k === "exec" ? "运行命令" : "联网"}</Label>
                <Select value={draft.permissions[k]} onValueChange={(v) => setDraft({ ...draft, permissions: { ...draft.permissions, [k]: v } })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(POLICY_LABEL).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          {readOnlyAdvisor && <p className="text-xs text-destructive">担任顾问的 agent 必须只读。</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>成本档位</Label>
              <Select value={String(draft.costTier)} onValueChange={(v) => setDraft({ ...draft, costTier: Number(v) })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COST_LABEL.map((label, i) => (
                    <SelectItem key={label} value={String(i)}>
                      {i} · {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">同等条件下优先选便宜的。</p>
            </div>
            <label className="flex items-center justify-between gap-2 self-start rounded-lg border px-3 py-2 text-sm sm:mt-6">
              启用
              <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
            </label>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-body">职责说明</Label>
            <Textarea id="agent-body" rows={4} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="这个 agent 擅长什么、要注意什么。会注入它的启动上下文。" />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {!isNew ? (
            <Button variant="ghost" className="text-destructive" onClick={remove}>
              <Trash2 /> 删除
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BriefingInspector({ agent, onOpenChange }: { agent?: AgentView; onOpenChange: (o: boolean) => void }) {
  const [role, setRole] = useState<Role>("implement");
  const [briefing, setBriefing] = useState<Briefing>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<string>();

  useEffect(() => {
    if (agent) setRole(agent.roles[0] ?? "implement");
  }, [agent]);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    setBriefing(undefined);
    setError(undefined);
    api<Briefing>(`/api/agents/${agent.id}/briefing?role=${role}`)
      .then((b) => !cancelled && setBriefing(b))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [agent, role]);

  const pct = briefing ? Math.min(100, Math.round((briefing.bytes / briefing.budget) * 100)) : 0;

  return (
    <Sheet open={!!agent} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>启动上下文 · {agent?.name}</SheetTitle>
          <SheetDescription>这个 agent 开工时实际收到的内容：每段的来源、大小，以及有没有重复。</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agent?.roles.map((r) => (
                <SelectItem key={r} value={r}>
                  以「{ROLE_LABEL[r]}」角色启动
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {!briefing && !error && (
            <div className="space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}
          {briefing && (
            <>
              <div className="rounded-lg border p-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium">
                    {kb(briefing.bytes)} / {kb(briefing.budget)}
                  </span>
                  <span className={cn("text-xs", briefing.overBudget ? "text-destructive" : "text-muted-foreground")}>{briefing.overBudget ? "超出预算，运行会被拦下" : `预算的 ${pct}%`}</span>
                </div>
                <Progress value={pct} className={cn("mt-2", briefing.overBudget && "[&>[data-slot=progress-indicator]]:bg-destructive")} />
                <div className="mt-2 font-mono text-[11px] text-muted-foreground">sha256 {briefing.hash.slice(0, 16)}…</div>
              </div>

              {briefing.duplicates.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                  <div className="font-medium text-amber-700 dark:text-amber-300">发现 {briefing.duplicates.length} 处重复内容</div>
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {briefing.duplicates.slice(0, 6).map((d, i) => (
                      <li key={i}>
                        「{d.line.slice(0, 60)}」出现在 {d.sections.join("、")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-2">
                {briefing.sections.map((s) => (
                  <div key={s.key} className="rounded-lg border">
                    <button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left" onClick={() => setExpanded(expanded === s.key ? undefined : s.key)}>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{s.title}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">{s.source}</div>
                      </div>
                      <div className="w-20 shrink-0 text-right">
                        <div className="text-xs tabular-nums">{kb(s.bytes)}</div>
                        <div className="mt-1 h-1 rounded bg-muted">
                          <div className="h-1 rounded bg-primary/70" style={{ width: `${Math.max(2, Math.round((s.bytes / briefing.bytes) * 100))}%` }} />
                        </div>
                      </div>
                    </button>
                    {expanded === s.key && <pre className="max-h-80 overflow-auto border-t bg-muted/40 px-3 py-2 text-xs whitespace-pre-wrap">{s.content}</pre>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function AgentsPage() {
  const { state, error } = useBaton();
  const [editing, setEditing] = useState<{ agent: AgentCard; isNew: boolean }>();
  const [inspecting, setInspecting] = useState<AgentView>();

  const groups = useMemo(() => {
    const agents = state?.agents ?? [];
    return (["chatgpt", "deepseek", "cursor", "demo"] as const)
      .map((source) => ({ source, agents: agents.filter((a) => a.source === source) }))
      .filter((g) => g.agents.length > 0);
  }, [state]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Agents</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              每张卡片是一个能力单元。接力时工作台按角色、权限、账号是否可用、额度和成本挑人，检查者不会和实现者同一个模型家族。
            </p>
          </div>
          <Button onClick={() => setEditing({ agent: blankAgent(), isNew: true })}>
            <Plus /> 添加 agent
          </Button>
        </div>

        {error && !state && <p className="mt-6 text-sm text-destructive">{error}</p>}
        {!state && !error && (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-52 rounded-xl" />
            ))}
          </div>
        )}
        {state && state.agents.length === 0 && (
          <div className="mt-6 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">还没有 agent。添加一个，或者在设置里先登录账号。</div>
        )}

        {groups.map((g) => (
          <section key={g.source} className="mt-8">
            <h2 className="text-sm font-medium text-muted-foreground">{SOURCE_LABEL[g.source]}</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {g.agents.map((a) => (
                <AgentCardView key={a.id} agent={a} onEdit={() => setEditing({ agent: a, isNew: false })} onInspect={() => setInspecting(a)} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <AgentEditor
        agent={editing?.agent ?? blankAgent()}
        isNew={editing?.isNew ?? true}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(undefined)}
        demo={state?.workspace.demo ?? false}
      />
      <BriefingInspector agent={inspecting} onOpenChange={(o) => !o && setInspecting(undefined)} />
    </div>
  );
}
