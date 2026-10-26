import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Circle, ExternalLink, FolderOpen, Loader2, Play, Plus, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { del, post, put } from "@/lib/api";
import { kb } from "@/lib/format";
import { navigate } from "@/lib/router";
import { useBaton } from "@/lib/store";
import type { CheckResult, WorkspaceSettings } from "@/lib/types";

function errorToast(e: unknown) {
  toast.error((e as Error).message);
}

function Section({ title, description, children, status }: { title: string; description?: ReactNode; children: ReactNode; status?: ReactNode }) {
  return (
    <section className="rounded-xl border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {status}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs", ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
      {ok ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
      {label}
    </span>
  );
}

function useBusy() {
  const [busy, setBusy] = useState<string>();
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(undefined);
    }
  };
  return { busy, run };
}

function AccountsTab() {
  const { state, refresh } = useBaton();
  const { busy, run } = useBusy();
  const [manual, setManual] = useState("");
  const [deepseekKey, setDeepseekKey] = useState("");
  const keyMalformed = deepseekKey.trim() !== "" && !/^sk-[A-Za-z0-9_-]{16,}$/.test(deepseekKey.trim());
  const [cursorCommand, setCursorCommand] = useState("");
  const auth = state?.auth;
  const settings = state?.settings;

  useEffect(() => {
    if (settings) setCursorCommand(settings.cursor.command);
  }, [settings?.cursor.command]);

  useEffect(() => {
    if (!auth?.chatgpt.pending && !auth?.cursor.pending) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [auth?.chatgpt.pending, auth?.cursor.pending, refresh]);

  if (!auth || !settings || !state) return null;
  const usingMock = settings.cursor.command === state.mockCursorCommand;

  const saveCursorCommand = (command: string) =>
    run("cursor-cmd", async () => {
      await put("/api/settings", { ...settings, cursor: { command } });
      await refresh();
      toast.success("已更新 Cursor 命令");
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        用你已有的订阅登录，不用 API key（DeepSeek 除外）。凭据只保存在本机 <code className="rounded bg-muted px-1">~/.baton/credentials.json</code>（权限 0600），不会发给浏览器或工具。
      </p>

      <Section
        title="ChatGPT"
        description="GPT 系模型只从这里接入，跑在 Pi 运行时里。Cursor 里的 GPT 模型不会出现，避免重复。"
        status={<StatusPill ok={auth.chatgpt.loggedIn} label={auth.chatgpt.loggedIn ? "已登录" : "未登录"} />}
      >
        {auth.chatgpt.pending ? (
          <div className="space-y-3">
            <p className="text-sm">
              在浏览器里打开下面的链接完成登录。登录完成后会自动跳回本机 1455 端口。
            </p>
            <a href={auth.chatgpt.pending.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 break-all rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs text-primary hover:underline">
              <ExternalLink className="size-3.5 shrink-0" />
              {auth.chatgpt.pending.url}
            </a>
            <div className="space-y-1.5">
              <Label htmlFor="manual" className="text-xs text-muted-foreground">
                如果浏览器跳转失败（比如工作台跑在另一台机器上），把地址栏里最后的 localhost:1455/… 整个链接粘贴到这里：
              </Label>
              <div className="flex gap-2">
                <Input id="manual" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="http://localhost:1455/auth/callback?code=…" className="font-mono text-xs" />
                <Button
                  disabled={!manual.trim() || busy === "manual"}
                  onClick={() =>
                    run("manual", async () => {
                      await post("/api/auth/chatgpt/manual", { input: manual });
                      setManual("");
                      toast.success("已提交，正在完成登录…");
                    })
                  }
                >
                  提交
                </Button>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => run("cancel", async () => (await post("/api/auth/chatgpt/cancel"), refresh()))}>
              取消登录
            </Button>
          </div>
        ) : auth.chatgpt.loggedIn ? (
          <Button variant="outline" disabled={busy === "logout"} onClick={() => run("logout", async () => (await post("/api/auth/chatgpt/logout"), refresh()))}>
            退出登录
          </Button>
        ) : (
          <Button
            disabled={busy === "login"}
            onClick={() =>
              run("login", async () => {
                const { url } = await post<{ url: string }>("/api/auth/chatgpt/login");
                window.open(url, "_blank", "noopener");
                await refresh();
              })
            }
          >
            {busy === "login" && <Loader2 className="animate-spin" />}用 ChatGPT 登录
          </Button>
        )}
      </Section>

      <Section
        title="Cursor"
        description="Cursor 订阅里的非 GPT 模型（Claude、Gemini、Composer…）通过官方 Cursor Agent CLI 的 ACP 模式接入，每个模型是独立的 agent。"
        status={<StatusPill ok={auth.cursor.loggedIn} label={auth.cursor.loggedIn ? auth.cursor.account ?? "已登录" : auth.cursor.installed ? "未登录" : "未安装 CLI"} />}
      >
        <div className="space-y-3">
          {!auth.cursor.installed && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              没找到 Cursor Agent CLI。安装：<code className="rounded bg-muted px-1">curl https://cursor.com/install -fsS | bash</code>，装好后点「重新检测」。
              {auth.cursor.error && <div className="mt-1 text-xs text-muted-foreground">{auth.cursor.error}</div>}
            </div>
          )}
          {auth.cursor.pending && (
            <a href={auth.cursor.pending.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 break-all rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs text-primary hover:underline">
              <ExternalLink className="size-3.5 shrink-0" />
              {auth.cursor.pending.url}
            </a>
          )}
          <div className="flex flex-wrap gap-2">
            {auth.cursor.installed && !auth.cursor.loggedIn && (
              <Button
                disabled={busy === "cursor-login"}
                onClick={() =>
                  run("cursor-login", async () => {
                    const { url } = await post<{ url: string }>("/api/auth/cursor/login");
                    if (url) window.open(url, "_blank", "noopener");
                    await refresh();
                  })
                }
              >
                {busy === "cursor-login" && <Loader2 className="animate-spin" />}登录 Cursor
              </Button>
            )}
            <Button variant="outline" disabled={busy === "cursor-refresh"} onClick={() => run("cursor-refresh", async () => (await post("/api/auth/cursor/refresh"), refresh()))}>
              <RefreshCw className={cn(busy === "cursor-refresh" && "animate-spin")} /> 重新检测
            </Button>
          </div>
          <div className="space-y-1.5 border-t pt-3">
            <Label htmlFor="cursor-cmd" className="text-xs text-muted-foreground">
              CLI 命令（当前工作区）
            </Label>
            <div className="flex gap-2">
              <Input id="cursor-cmd" value={cursorCommand} onChange={(e) => setCursorCommand(e.target.value)} className="font-mono text-xs" />
              <Button variant="outline" disabled={cursorCommand === settings.cursor.command || busy === "cursor-cmd"} onClick={() => saveCursorCommand(cursorCommand)}>
                保存
              </Button>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch size="sm" checked={usingMock} onCheckedChange={(on) => saveCursorCommand(on ? state.mockCursorCommand : "agent")} />
              用内置的模拟 Cursor（没装 CLI 时体验 ACP 流程，不会调用真实模型）
            </label>
          </div>
        </div>
      </Section>

      <Section
        title="DeepSeek"
        description="唯一用 API key 的来源，用于便宜的实现任务和交接摘要。按实际花费计入每个线程的预算。"
        status={<StatusPill ok={auth.deepseek.configured} label={auth.deepseek.configured ? "已配置" : "未配置"} />}
      >
        {auth.deepseek.configured ? (
          <Button variant="outline" disabled={busy === "ds-clear"} onClick={() => run("ds-clear", async () => (await del("/api/auth/deepseek"), refresh()))}>
            移除 key
          </Button>
        ) : (
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <Input
                type="password"
                value={deepseekKey}
                onChange={(e) => setDeepseekKey(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
                aria-invalid={keyMalformed}
                className="font-mono"
              />
              <Button
                disabled={!deepseekKey.trim() || keyMalformed || busy === "ds"}
                onClick={() =>
                  run("ds", async () => {
                    await post("/api/auth/deepseek", { key: deepseekKey });
                    setDeepseekKey("");
                    await refresh();
                    toast.success("已保存 DeepSeek key");
                  })
                }
              >
                保存
              </Button>
            </div>
            {keyMalformed && <p className="text-xs text-destructive">格式不对：DeepSeek key 以 sk- 开头，后面至少 16 位字母、数字、- 或 _。</p>}
          </div>
        )}
      </Section>
    </div>
  );
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
      toast.success("已切换工作区");
      navigate({ page: "threads" });
    });

  return (
    <div className="space-y-4">
      <Section title="当前工作区" description="所有 agent 在这个目录里读写同一批文件。工作台的状态保存在其中的 .baton/ 目录。">
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{state.workspace.root}</span>
          {state.workspace.demo && <Badge variant="secondary">演示</Badge>}
        </div>
      </Section>
      <Section title="打开其他目录" description="填本机上的绝对路径，比如你的项目仓库。第一次打开会初始化 .baton/、CONTEXT.md、AGENTS.md 里的工作台段落和 .cursor/mcp.json。">
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
        {state.recent.filter((r) => r !== state.workspace.root).length > 0 && (
          <div className="mt-4 space-y-1">
            <div className="text-xs font-medium text-muted-foreground">最近打开</div>
            {state.recent
              .filter((r) => r !== state.workspace.root)
              .map((r) => (
                <button key={r} type="button" disabled={!!busy} onClick={() => open(r)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs hover:bg-muted">
                  {busy === r ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5 text-muted-foreground" />}
                  <span className="truncate">{r}</span>
                </button>
              ))}
          </div>
        )}
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
        description="检查阶段开始前，工作台先在工作区跑这些命令（测试、类型检查、lint…）。有失败时，检查者不能判通过——硬规则，不靠模型自觉。"
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

function RelayTab() {
  const { draft, setDraft, ...bar } = useSettingsDraft();
  if (!draft) return null;
  const limits = (patch: Partial<WorkspaceSettings["limits"]>) => setDraft({ ...draft, limits: { ...draft.limits, ...patch } });
  return (
    <div className="space-y-4">
      <Section title="需要你确认的节点" description="其余交接由工作台按规则自动完成。">
        <div className="divide-y">
          <ToggleRow label="方案 → 实现前确认" hint="看过方案和验收标准再开工，也是你批准写权限的时刻。" checked={draft.confirm.planToImplement} onChange={(v) => setDraft({ ...draft, confirm: { ...draft.confirm, planToImplement: v } })} />
          <ToggleRow label="检查通过后确认完成" hint="关掉则检查通过且命令全绿时自动收尾。" checked={draft.confirm.complete} onChange={(v) => setDraft({ ...draft, confirm: { ...draft.confirm, complete: v } })} />
        </div>
      </Section>
      <Section title="顾问" description="一个干净上下文、只读的强模型，只在特定时刻被请来给建议，不直接动手。">
        <div className="divide-y">
          <ToggleRow label="第二次被退回时" checked={draft.advisor.onSecondSendBack} onChange={(v) => setDraft({ ...draft, advisor: { ...draft.advisor, onSecondSendBack: v } })} />
          <ToggleRow label="同类问题反复出现时" checked={draft.advisor.onRepeatedIssues} onChange={(v) => setDraft({ ...draft, advisor: { ...draft.advisor, onRepeatedIssues: v } })} />
          <ToggleRow label="出方案之前" hint="多一次调用，换一个独立视角。" checked={draft.advisor.beforePlan} onChange={(v) => setDraft({ ...draft, advisor: { ...draft.advisor, beforePlan: v } })} />
        </div>
      </Section>
      <Section title="接力上限" description="超过任何一项就暂停，交给你决定。">
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField label="每线程最多交接" value={draft.limits.maxHops} onChange={(n) => limits({ maxHops: n })} min={1} />
          <NumberField label="最多退回" value={draft.limits.maxSendBacks} onChange={(n) => limits({ maxSendBacks: n })} />
          <NumberField label="连续无进展" value={draft.limits.maxStalls} onChange={(n) => limits({ maxStalls: n })} hint="没有改动文件的运行" min={1} />
        </div>
      </Section>
      <Section title="额度与预算" description="每个线程的上限，按账号分别计算。">
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField label="DeepSeek 花费（元）" value={draft.limits.deepseekCnyPerThread} onChange={(n) => limits({ deepseekCnyPerThread: n })} step={0.5} />
          <NumberField label="ChatGPT 运行次数" value={draft.limits.chatgptRunsPerThread} onChange={(n) => limits({ chatgptRunsPerThread: n })} />
          <NumberField label="Cursor 运行次数" value={draft.limits.cursorRunsPerThread} onChange={(n) => limits({ cursorRunsPerThread: n })} />
        </div>
      </Section>
      <Section title="启动上下文预算" description="每次运行注入的规则、上下文、记忆和交接的总量上限。超了就拦下，提醒你精简，而不是悄悄截断。房间上下文超过自己的预算时，整理员（DeepSeek）会自动整理。">
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            label="方案/顾问（字节）"
            value={draft.budgets.planner}
            onChange={(n) => setDraft({ ...draft, budgets: { ...draft.budgets, planner: n } })}
            step={1024}
            min={2048}
            hint={kb(draft.budgets.planner)}
          />
          <NumberField
            label="实现/检查（字节）"
            value={draft.budgets.executor}
            onChange={(n) => setDraft({ ...draft, budgets: { ...draft.budgets, executor: n } })}
            step={1024}
            min={2048}
            hint={kb(draft.budgets.executor)}
          />
          <NumberField
            label="房间上下文（字节）"
            value={draft.budgets.context}
            onChange={(n) => setDraft({ ...draft, budgets: { ...draft.budgets, context: n } })}
            step={512}
            min={1024}
            max={8192}
            hint={`${kb(draft.budgets.context)}，上限 8KB`}
          />
        </div>
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
  const policy = (key: "exec" | "network", label: string, hint: string) => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={draft.permissions[key]} onValueChange={(v) => perms({ [key]: v })}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="allow">直接允许</SelectItem>
          <SelectItem value="ask">每次问我</SelectItem>
          <SelectItem value="deny">禁止</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
  return (
    <div className="space-y-4">
      <Section title="默认策略" description="工作区级别的上限；单个 agent 的权限只能更严，不能更松。">
        <div className="grid gap-4 sm:grid-cols-2">
          {policy("exec", "运行命令", "不在白名单里的命令按这个处理。")}
          {policy("network", "联网", "Cursor 发起的网络请求。")}
        </div>
        <div className="mt-4 max-w-xs">
          <NumberField label="审批等待（秒）" value={draft.approvalTimeoutSec} onChange={(n) => setDraft({ ...draft, approvalTimeoutSec: n })} hint="超时视为拒绝。" min={10} />
        </div>
      </Section>
      <Section title="命令白名单与黑名单" description="一行一个前缀。白名单只对不含管道、重定向、分号等符号的简单命令生效；黑名单永远优先。">
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
      <Section title="禁止访问的路径" description="glob 写法，相对工作区。agent 读写都会被拒绝；.baton/ 本身总是只读。">
        <ListEditor value={draft.permissions.denyPaths} onChange={(v) => perms({ denyPaths: v })} placeholder={".env*\n**/*.pem\nsecrets/**"} />
      </Section>
      <SaveBar {...bar} />
    </div>
  );
}

const TABS = [
  { value: "accounts", label: "账号" },
  { value: "workspace", label: "工作区" },
  { value: "checks", label: "检查命令" },
  { value: "relay", label: "接力规则" },
  { value: "permissions", label: "权限" },
];

export function SettingsPage({ tab }: { tab?: string }) {
  const { state, error } = useBaton();
  const active = TABS.some((t) => t.value === tab) ? tab! : "accounts";
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <h1 className="text-xl font-semibold">设置</h1>
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
          <TabsContent value="accounts" className="mt-4">
            <AccountsTab />
          </TabsContent>
          <TabsContent value="workspace" className="mt-4">
            <WorkspaceTab />
          </TabsContent>
          <TabsContent value="checks" className="mt-4">
            <ChecksTab />
          </TabsContent>
          <TabsContent value="relay" className="mt-4">
            <RelayTab />
          </TabsContent>
          <TabsContent value="permissions" className="mt-4">
            <PermissionsTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
