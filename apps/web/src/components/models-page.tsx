import { useEffect, useState } from "react";
import { Eye, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { familyLabel } from "@baton/core/families";
import { detectKeyTemplate } from "@baton/core/keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, del, post, put } from "@/lib/api";
import { ROLE_LABEL, kb, tokens } from "@/lib/format";
import { shortReason, useModels } from "@/lib/models";
import { useBaton } from "@/lib/store";
import type { Briefing, CredentialSource, Role } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Section, StatusPill, useBusy } from "./section";

interface Inspecting {
  source: CredentialSource;
  provider?: string;
  model: string;
  name: string;
}

/** One route's models: whether they can be used right now, and a way to see what each starts a chat with. */
function RouteModels({ source, provider, onInspect }: { source: CredentialSource; provider?: string; onInspect: (m: Inspecting) => void }) {
  const { routes, error } = useModels();
  const route = routes?.find((r) => r.source === source && r.provider === provider);
  if (!route) {
    return <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">{error ?? "正在读取模型列表…"}</p>;
  }
  return (
    <div className="mt-4 border-t pt-3">
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        <span className="font-medium">模型（{route.models.length}）</span>
        <span className={cn(route.unavailable ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300")}>
          {route.unavailable ? `${shortReason(route.unavailable)}，这些模型暂时不能选` : "都可以在对话里直接选"}
        </span>
      </div>
      {route.error && !route.unavailable && <p className="mb-1.5 text-xs text-destructive">读不到模型列表：{route.error}</p>}
      {route.models.length === 0 && !route.error && <p className="text-xs text-muted-foreground">这个账号下没有可用模型。</p>}
      <div className="max-h-72 divide-y overflow-y-auto rounded-lg border">
        {route.models.map((m) => (
          <div key={m.id} className={cn("flex items-center gap-2 px-3 py-1.5 text-sm", route.unavailable && "text-muted-foreground")}>
            <span className="truncate">{m.name}</span>
            {m.name !== m.id && <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{m.id}</span>}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {familyLabel(m.family)}
              {m.contextWindow ? ` · ${tokens(m.contextWindow)}` : ""}
            </span>
            <Button variant="ghost" size="icon-sm" onClick={() => onInspect({ source, provider, model: m.id, name: m.name })} aria-label={`查看 ${m.name} 的启动上下文`} title="查看启动上下文">
              <Eye />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** What a model actually receives when it starts a chat reply or a review: each section's source and size, duplicates, and the hash. */
function BriefingInspector({ target, onOpenChange }: { target?: Inspecting; onOpenChange: (o: boolean) => void }) {
  const [role, setRole] = useState<Role>("chat");
  const [briefing, setBriefing] = useState<Briefing>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<string>();

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setBriefing(undefined);
    setError(undefined);
    const query = new URLSearchParams({ source: target.source, model: target.model, role, ...(target.provider ? { provider: target.provider } : {}) });
    api<Briefing>(`/api/briefing?${query}`)
      .then((b) => !cancelled && setBriefing(b))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [target, role]);

  const pct = briefing ? Math.min(100, Math.round((briefing.bytes / briefing.budget) * 100)) : 0;

  return (
    <Sheet open={!!target} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>启动上下文 · {target?.name}</SheetTitle>
          <SheetDescription>它在这个工作区开始回复时实际收到的内容：每段的来源、大小，以及有没有重复。</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <Tabs value={role} onValueChange={(v) => setRole(v as Role)}>
            <TabsList>
              {(["chat", "review"] as const).map((r) => (
                <TabsTrigger key={r} value={r}>
                  {r === "chat" ? "在对话里回复" : "检查别人的改动"}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

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
                    {ROLE_LABEL[role]} · {kb(briefing.bytes)} / {kb(briefing.budget)}
                  </span>
                  <span className={cn("text-xs", briefing.overBudget ? "text-destructive" : "text-muted-foreground")}>{briefing.overBudget ? "超出预算，回复会被拦下" : `预算的 ${pct}%`}</span>
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

interface KeyTemplateInfo {
  id: string;
  label: string;
  hint: string;
  baseUrl?: string;
  customUrl: boolean;
  keyless: boolean;
  catalog: boolean;
}

const AUTO = "auto";

/** API key accounts of any common service: the template fills in the endpoint and protocol, and the models come by themselves. */
function KeyAccounts({ onInspect }: { onInspect: (m: Inspecting) => void }) {
  const { state, refresh } = useBaton();
  const { refresh: refreshModels } = useModels();
  const { busy, run } = useBusy();
  const [templates, setTemplates] = useState<KeyTemplateInfo[]>([]);
  const [template, setTemplate] = useState(AUTO);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [models, setModels] = useState("");

  useEffect(() => {
    void api<KeyTemplateInfo[]>("/api/keys/templates").then(setTemplates);
  }, []);

  const detected = template === AUTO && key.trim() ? detectKeyTemplate(key) : undefined;
  const chosen = templates.find((t) => t.id === (template === AUTO ? detected?.id : template));
  const endpoint = chosen && !chosen.catalog;
  const ready = Boolean(chosen && (chosen.keyless || key.trim()) && (!chosen.customUrl || baseUrl.trim() || chosen.baseUrl));
  const keys = state?.auth.keys ?? [];
  const templateLabel = (id: string) => templates.find((t) => t.id === id)?.label ?? id;

  const add = () =>
    run("key-add", async () => {
      const added = await post<{ label: string }>("/api/keys", {
        template: chosen?.id,
        key,
        label: label.trim() || undefined,
        baseUrl: endpoint ? baseUrl.trim() || chosen?.baseUrl : undefined,
        models: endpoint && models.trim() ? models.split(/[\s,，]+/).filter(Boolean) : undefined,
      });
      setKey("");
      setLabel("");
      setModels("");
      setBaseUrl("");
      setTemplate(AUTO);
      await refresh();
      toast.success(`已添加「${added.label}」，它的模型已经能在对话里选`);
    });

  return (
    <Section
      title="API key"
      description="按量计费，花费按实际用量折成人民币显示。常见服务的 key 都能加：选服务，或直接粘贴 key 自动认出是哪家；地址、协议和模型列表自动装配。key 只存在本机凭据文件里，不会再显示出来。"
      status={<StatusPill ok={keys.some((k) => k.configured)} label={keys.length ? `${keys.length} 个账号` : "还没添加"} />}
    >
      <div className="space-y-4">
        {keys.map((k) => (
          <div key={k.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{k.label}</span>
              {k.label !== templateLabel(k.template) && <span className="text-xs text-muted-foreground">{templateLabel(k.template)}</span>}
              {k.baseUrl && <span className="truncate font-mono text-xs text-muted-foreground">{k.baseUrl}</span>}
              <span className="ml-auto flex gap-1">
                {k.baseUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === `refresh-${k.id}`}
                    onClick={() =>
                      run(`refresh-${k.id}`, async () => {
                        const res = await post<{ models: number }>(`/api/keys/${k.id}/refresh`);
                        await refreshModels();
                        toast.success(`重新拉到 ${res.models} 个模型`);
                      })
                    }
                  >
                    <RefreshCw className={cn(busy === `refresh-${k.id}` && "animate-spin")} /> 刷新模型
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy === `remove-${k.id}`} onClick={() => run(`remove-${k.id}`, async () => (await del(`/api/keys/${k.id}`), refresh()))}>
                  移除
                </Button>
              </span>
            </div>
            <RouteModels source="key" provider={k.provider} onInspect={onInspect} />
          </div>
        ))}

        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <div className="text-sm font-medium">添加 API key</div>
          <div className="grid gap-2 sm:grid-cols-[14rem_1fr]">
            <Select value={template} onValueChange={setTemplate}>
              <SelectTrigger aria-label="服务" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>按 key 自动认出</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={chosen?.keyless ? "不需要 key，可以留空" : "粘贴 API key"} autoComplete="off" className="font-mono" aria-label="API key" />
          </div>
          <p className="text-xs text-muted-foreground">
            {template === AUTO && key.trim()
              ? chosen
                ? `认出是 ${chosen.label}。${chosen.hint}`
                : "从前缀认不出是哪家（很多服务都用 sk- 开头），请在左边选择服务。不会拿这个 key 去挨个试。"
              : (chosen?.hint ?? "选服务，或直接粘贴 key。")}
          </p>
          {endpoint && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={chosen?.baseUrl ?? "服务地址，例如 https://example.com/v1"} className="font-mono text-xs" aria-label="服务地址" />
              <Input value={models} onChange={(e) => setModels(e.target.value)} placeholder="模型名（可选，服务没有 /models 时手填，逗号分隔）" className="text-xs" aria-label="模型名" />
            </div>
          )}
          <div className="flex gap-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`显示名（可选，默认「${chosen?.label ?? "服务名"}」）`} className="text-xs" aria-label="显示名" />
            <Button disabled={!ready || busy === "key-add"} onClick={add}>
              {busy === "key-add" && <Loader2 className="animate-spin" />}添加
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

function Accounts({ onInspect }: { onInspect: (m: Inspecting) => void }) {
  const { state, refresh } = useBaton();
  const { busy, run } = useBusy();
  const [manual, setManual] = useState("");
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

      <Section
        title="ChatGPT"
        description="用 ChatGPT 订阅使用 GPT 系模型，跑在 Pi 运行时里。Cursor 里的 GPT 模型不会出现，避免重复；想按量用 GPT，可以在下面添加 OpenAI 的 API key。"
        status={<StatusPill ok={auth.chatgpt.loggedIn} label={auth.chatgpt.loggedIn ? (auth.chatgpt.method === "codex" ? "已登录 · Codex 账号" : "已登录") : "未登录"} />}
      >
        {auth.chatgpt.error && !auth.chatgpt.pending && !auth.chatgpt.loggedIn && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            登录失败：{auth.chatgpt.error}
            <div className="mt-1 text-xs text-muted-foreground">如果这个账号能登录 Codex CLI，可以改用「用 Codex 账号登录」。</div>
          </div>
        )}
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
                如果浏览器跳转失败（比如工作台跑在另一台机器上），把地址栏里最后的 …:1455/auth/callback… 整个链接粘贴到这里：
              </Label>
              <div className="flex gap-2">
                <Input id="manual" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="http://127.0.0.1:1455/auth/callback?code=…" className="font-mono text-xs" />
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
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["chatgpt", "用 ChatGPT 登录", "default"],
                  ["codex", "用 Codex 账号登录", "outline"],
                ] as const
              ).map(([method, label, variant]) => (
                <Button
                  key={method}
                  variant={variant}
                  disabled={Boolean(busy?.startsWith("login"))}
                  onClick={() =>
                    run(`login-${method}`, async () => {
                      const { url } = await post<{ url: string }>("/api/auth/chatgpt/login", { method });
                      window.open(url, "_blank", "noopener");
                      await refresh();
                    })
                  }
                >
                  {busy === `login-${method}` && <Loader2 className="animate-spin" />}
                  {label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">两种方式都用你的 ChatGPT 订阅。「Codex 账号」和 Codex CLI 是同一套登录，Sign in with ChatGPT 对你的账号不可用时用它。</p>
          </div>
        )}
        <RouteModels source="chatgpt" onInspect={onInspect} />
      </Section>

      <Section
        title="Cursor"
        description="Cursor 订阅里的非 GPT、非 DeepSeek 模型（Claude、Gemini、Composer…）通过官方 Cursor Agent CLI 的 ACP 模式接入。DeepSeek 请用 API key。"
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
        <RouteModels source="cursor" onInspect={onInspect} />
      </Section>

      <KeyAccounts onInspect={onInspect} />
      {state.workspace.demo && (
        <Section title="演示" description="脚本化的假模型，只在演示工作区里可用，不消耗任何额度。" status={<StatusPill ok label="可用" />}>
          <RouteModels source="demo" onInspect={onInspect} />
        </Section>
      )}
    </div>
  );
}

/** Accounts and models in one place: sign-in state, every model of each account, and what each starts with. */
export function ModelsPage() {
  const { state, error } = useBaton();
  const { loading, refresh } = useModels();
  const [inspecting, setInspecting] = useState<Inspecting>();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">模型</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              登录订阅或添加 API key 后，它下面的全部模型都能在对话里直接选，不需要任何配置。两个订阅之间一个模型家族只走一条线路（GPT 走 ChatGPT，其余走 Cursor）；API key 可以接任何服务，和订阅重复的模型也保留，按账号区分。凭据只保存在本机{" "}
              <code className="rounded bg-muted px-1">~/.baton/credentials.json</code>（权限 0600），不会发给浏览器或工具。
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className={cn(loading && "animate-spin")} /> 刷新模型列表
          </Button>
        </div>
        {error && !state && <p className="mt-6 text-sm text-destructive">{error}</p>}
        <div className="mt-6">
          <Accounts onInspect={setInspecting} />
        </div>
      </div>
      <BriefingInspector target={inspecting} onOpenChange={(o) => !o && setInspecting(undefined)} />
    </div>
  );
}
