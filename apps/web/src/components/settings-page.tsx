import { useEffect, useState } from "react";
import { FolderOpen, Loader2, Play, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { post, put } from "@/lib/api";
import { kb } from "@/lib/format";
import { navigate } from "@/lib/router";
import { useBaton } from "@/lib/store";
import type { CheckResult, WorkspaceSettings } from "@/lib/types";
import { ProjectChip, Section, useBusy } from "./section";

function errorToast(e: unknown) {
  toast.error((e as Error).message);
}

function WorkspaceTab() {
  const { state, refresh } = useBaton();
  const [target, setTarget] = useState("");
  const { busy, run } = useBusy();
  if (!state) return null;

  const open = (path: string, create = false) =>
    run(path, async () => {
      await post("/api/workspace/open", { path, create });
      await refresh();
      setTarget("");
      navigate({ page: "threads" });
    });
  const remove = (root: string) =>
    run(`remove:${root}`, async () => {
      await post("/api/workspace/close", { path: root });
      await refresh();
      toast.success("已从列表移除，目录里的文件和对话记录都还在");
    });

  return (
    <div className="space-y-4">
      <Section
        title="项目"
        description="每个对话属于一个项目，模型在项目目录里读写文件，上下文、记忆、规则和检查命令也按项目分开，保存在项目的 .baton/ 目录。不同项目的对话可以同时在跑。这里和下面几个分页显示的是当前项目。"
      >
        <div className="space-y-1">
          {state.projects.map((p) => {
            const current = p.root === state.workspace.root;
            const running = p.threads.filter((t) => t.status === "running" || t.status === "waiting").length;
            return (
              <div key={p.root} className={cn("flex items-center gap-2 rounded-lg border px-3 py-2", current ? "bg-muted/60" : "bg-background")}>
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{p.name}</span>
                    {p.demo && <Badge variant="secondary">演示</Badge>}
                    {current && <Badge variant="outline">当前</Badge>}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{p.root}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.threads.length} 个对话{running > 0 && `，${running} 个在进行`}
                  </div>
                </div>
                {!current && (
                  <Button size="sm" variant="outline" disabled={!!busy} onClick={() => open(p.root)}>
                    {busy === p.root && <Loader2 className="animate-spin" />}切换
                  </Button>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!!busy || state.projects.length < 2 || running > 0}
                  title={running > 0 ? "有对话在进行，先取消再移除" : state.projects.length < 2 ? "至少要留一个项目" : "从列表移除（不删除文件）"}
                  aria-label={`从列表移除 ${p.name}`}
                  onClick={() => remove(p.root)}
                >
                  {busy === `remove:${p.root}` ? <Loader2 className="animate-spin" /> : <X />}
                </Button>
              </div>
            );
          })}
        </div>
      </Section>
      <Section title="打开或新建项目" description="填本机上的绝对路径，比如你的项目仓库。第一次打开会初始化 .baton/、CONTEXT.md、AGENTS.md 里的工作台段落和 .cursor/mcp.json。">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="~/code/my-project" className="font-mono text-xs" />
          <div className="flex gap-2">
            <Button disabled={!target.trim() || !!busy} onClick={() => open(target)}>
              打开
            </Button>
            <Button variant="outline" disabled={!target.trim() || !!busy} onClick={() => open(target, true)}>
              新建并打开
            </Button>
          </div>
        </div>
      </Section>
    </div>
  );
}

function useSettingsDraft() {
  const { state, refresh } = useBaton();
  const [draft, setDraft] = useState<WorkspaceSettings>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (state?.settings) setDraft(structuredClone(state.settings));
  }, [state?.settings]);
  const dirty = !!draft && !!state && JSON.stringify(draft) !== JSON.stringify(state.settings);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await put("/api/settings", draft);
      await refresh();
      toast.success("设置已保存");
    } catch (e) {
      errorToast(e);
    } finally {
      setSaving(false);
    }
  };
  const reset = () => state && setDraft(structuredClone(state.settings));
  return { draft, setDraft, dirty, saving, save, reset };
}

function SaveBar({ dirty, saving, save, reset }: { dirty: boolean; saving: boolean; save: () => void; reset: () => void }) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
      <span className="mr-auto text-xs text-muted-foreground">有未保存的修改</span>
      <Button variant="ghost" onClick={reset}>
        还原
      </Button>
      <Button onClick={save} disabled={saving}>
        {saving && <Loader2 className="animate-spin" />}保存
      </Button>
    </div>
  );
}

function ChecksTab() {
  const { draft, setDraft, ...bar } = useSettingsDraft();
  const [results, setResults] = useState<Record<number, CheckResult | "running">>({});
  if (!draft) return null;
  const update = (i: number, patch: Partial<WorkspaceSettings["checks"][number]>) => setDraft({ ...draft, checks: draft.checks.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const tryRun = async (i: number) => {
    setResults((r) => ({ ...r, [i]: "running" }));
    try {
      const result = await post<CheckResult>("/api/checks/try", draft.checks[i]);
      setResults((r) => ({ ...r, [i]: result }));
    } catch (e) {
      errorToast(e);
      setResults((r) => {
        const next = { ...r };
        delete next[i];
        return next;
      });
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title="检查命令"
        description="「让另一个模型检查」时，工作台先在工作区跑这些命令（测试、类型检查、lint…）。有失败时，结论不能是通过——硬规则，不靠模型自觉。"
      >
        <div className="space-y-3">
          {draft.checks.length === 0 && <p className="text-sm text-muted-foreground">还没有检查命令。至少加一个能证明改动没坏的命令。</p>}
          {draft.checks.map((c, i) => {
            const result = results[i];
            return (
              <div key={i} className="rounded-lg border p-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input value={c.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="名字，例如 单元测试" className="sm:w-40" />
                  <Input value={c.command} onChange={(e) => update(i, { command: e.target.value })} placeholder="pnpm test" className="flex-1 font-mono text-xs" />
                  <div className="flex gap-1">
                    <Button variant="outline" size="icon" onClick={() => tryRun(i)} disabled={result === "running" || !c.command.trim()} title="在工作区试运行">
                      {result === "running" ? <Loader2 className="animate-spin" /> : <Play />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDraft({ ...draft, checks: draft.checks.filter((_, j) => j !== i) })} aria-label="删除">
                      <X />
                    </Button>
                  </div>
                </div>
                {result && result !== "running" && (
                  <div className="mt-2">
                    <div className={cn("text-xs font-medium", result.status === "pass" ? "text-emerald-600" : result.status === "skipped" ? "text-muted-foreground" : "text-destructive")}>
                      {{ pass: "通过", fail: "失败", skipped: "跳过", error: "无法运行" }[result.status]}
                      {result.exitCode !== null && ` · 退出码 ${result.exitCode}`} · {(result.durationMs / 1000).toFixed(1)}s
                    </div>
                    {result.output && <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] whitespace-pre-wrap">{result.output}</pre>}
                  </div>
                )}
              </div>
            );
          })}
          <Button variant="outline" size="sm" onClick={() => setDraft({ ...draft, checks: [...draft.checks, { name: "", command: "" }] })}>
            <Plus /> 添加命令
          </Button>
        </div>
      </Section>
      <SaveBar {...bar} />
    </div>
  );
}

function NumberField({ label, value, onChange, hint, step = 1, min = 0, max }: { label: string; value: number; onChange: (n: number) => void; hint?: string; step?: number; min?: number; max?: number }) {
  return (
    <div className="space-y-1">
      <Label className="text-sm">{label}</Label>
      <Input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-32" />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-4 py-2">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

function BudgetsTab() {
  const { draft, setDraft, ...bar } = useSettingsDraft();
  if (!draft) return null;
  const budgets = (patch: Partial<WorkspaceSettings["budgets"]>) => setDraft({ ...draft, budgets: { ...draft.budgets, ...patch } });
  return (
    <div className="space-y-4">
      <Section
        title="启动上下文预算"
        description="每次回复或检查开场注入的规则、上下文、记忆和对话摘要的总量上限。超了就拦下，提醒你精简，而不是悄悄截断。房间上下文超过自己的预算时，整理员（DeepSeek）会自动整理。"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="启动上下文（字节）" value={draft.budgets.briefing} onChange={(n) => budgets({ briefing: n })} step={1024} min={2048} hint={kb(draft.budgets.briefing)} />
          <NumberField
            label="房间上下文（字节）"
            value={draft.budgets.context}
            onChange={(n) => budgets({ context: n })}
            step={512}
            min={1024}
            max={8192}
            hint={`${kb(draft.budgets.context)}，上限 8KB`}
          />
        </div>
      </Section>
      <Section title="记忆" description="关掉后模型和整理员都不能再写新的记忆；已有的记忆照常可查。">
        <ToggleRow label="启用记忆" checked={draft.memory.enabled} onChange={(v) => setDraft({ ...draft, memory: { enabled: v } })} />
      </Section>
      <SaveBar {...bar} />
    </div>
  );
}

function ListEditor({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  return <Textarea rows={5} value={value.join("\n")} onChange={(e) => onChange(e.target.value.split("\n"))} onBlur={() => onChange(value.map((s) => s.trim()).filter(Boolean))} placeholder={placeholder} className="font-mono text-xs" />;
}

function PermissionsTab() {
  const { draft, setDraft, ...bar } = useSettingsDraft();
  if (!draft) return null;
  const perms = (patch: Partial<WorkspaceSettings["permissions"]>) => setDraft({ ...draft, permissions: { ...draft.permissions, ...patch } });
  return (
    <div className="space-y-4">
      <Section title="审批" description="每个对话用输入框旁的开关设定权限（只读 / 每次问我 / 允许直接改）。下面的黑名单和禁止访问的路径在任何档位下都生效。">
        <div className="max-w-xs">
          <NumberField label="审批等待（秒）" value={draft.approvalTimeoutSec} onChange={(n) => setDraft({ ...draft, approvalTimeoutSec: n })} hint="「每次问我」时等你决定的时间，超时视为拒绝。" min={10} />
        </div>
      </Section>
      <Section title="命令白名单与黑名单" description="一行一个前缀。「每次问我」时白名单里的简单命令（不含管道、重定向、分号等符号）不用问；黑名单永远优先，任何档位都禁止。">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-sm">直接允许</Label>
            <ListEditor value={draft.permissions.shellAllow} onChange={(v) => perms({ shellAllow: v })} placeholder={"ls\ncat\ngit status"} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">永远禁止</Label>
            <ListEditor value={draft.permissions.shellDeny} onChange={(v) => perms({ shellDeny: v })} placeholder={"rm -rf /\ngit push\nsudo"} />
          </div>
        </div>
      </Section>
      <Section title="禁止访问的路径" description="glob 写法，相对工作区。模型读写都会被拒绝；.baton/ 本身总是只读。">
        <ListEditor value={draft.permissions.denyPaths} onChange={(v) => perms({ denyPaths: v })} placeholder={".env*\n**/*.pem\nsecrets/**"} />
      </Section>
      <SaveBar {...bar} />
    </div>
  );
}

const TABS = [
  { value: "workspace", label: "项目" },
  { value: "checks", label: "检查命令" },
  { value: "budgets", label: "上下文预算" },
  { value: "permissions", label: "权限" },
];

export function SettingsPage({ tab }: { tab?: string }) {
  const { state, error } = useBaton();
  const active = TABS.some((t) => t.value === tab) ? tab! : "workspace";
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          设置 <ProjectChip />
        </h1>
        {error && !state && <p className="mt-4 text-sm text-destructive">{error}</p>}
        <Tabs value={active} onValueChange={(v) => navigate({ page: "settings", tab: v })} className="mt-6">
          <div className="overflow-x-auto">
            <TabsList>
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="workspace" className="mt-4">
            <WorkspaceTab />
          </TabsContent>
          <TabsContent value="checks" className="mt-4">
            <ChecksTab />
          </TabsContent>
          <TabsContent value="budgets" className="mt-4">
            <BudgetsTab />
          </TabsContent>
          <TabsContent value="permissions" className="mt-4">
            <PermissionsTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
