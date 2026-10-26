import { useState, type ReactNode } from "react";
import { Bot, BookText, ChartColumn, FolderOpen, Menu, MessagesSquare, Plus, Settings, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { STAGE_LABEL, STATUS_LABEL, timeAgo } from "@/lib/format";
import { href, type Route } from "@/lib/router";
import { useWorkbench } from "@/lib/store";

const NAV: { route: Route; label: string; icon: typeof Bot; match: Route["page"][] }[] = [
  { route: { page: "threads" }, label: "线程", icon: MessagesSquare, match: ["threads", "new"] },
  { route: { page: "agents" }, label: "Agents", icon: Bot, match: ["agents"] },
  { route: { page: "context" }, label: "上下文与记忆", icon: BookText, match: ["context"] },
  { route: { page: "stats" }, label: "统计", icon: ChartColumn, match: ["stats"] },
  { route: { page: "settings" }, label: "设置", icon: Settings, match: ["settings"] },
];

const STATUS_DOT: Record<string, string> = {
  idle: "bg-zinc-300",
  running: "bg-sky-500 animate-pulse",
  waiting: "bg-amber-500",
  paused: "bg-zinc-400",
  done: "bg-emerald-500",
};

function Sidebar({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const { state, connected } = useWorkbench();
  const activeThread = route.page === "threads" ? route.threadId : undefined;
  const auth = state?.auth;
  const accounts = [
    { label: "ChatGPT", ok: auth?.chatgpt.loggedIn },
    { label: "DeepSeek", ok: auth?.deepseek.configured },
    { label: "Cursor", ok: auth?.cursor.loggedIn },
  ];
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="size-4.5" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">Workbench</div>
          <div className="text-xs text-muted-foreground">个人 agent 工作台</div>
        </div>
      </div>

      <a
        href={href({ page: "settings", tab: "workspace" })}
        onClick={onNavigate}
        className="mx-3 mb-3 flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-left transition-colors hover:bg-muted"
        title={state?.workspace.root}
      >
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{state?.workspace.name ?? "加载中…"}</span>
            {state?.workspace.demo && <Badge variant="secondary">演示</Badge>}
          </div>
          <div className="truncate text-xs text-muted-foreground">{state?.workspace.root}</div>
        </div>
      </a>

      <div className="px-3">
        <Button asChild className="w-full justify-start" onClick={onNavigate}>
          <a href={href({ page: "new" })}>
            <Plus /> 新线程
          </a>
        </Button>
      </div>

      <nav className="mt-3 space-y-0.5 px-3">
        {NAV.map((item) => {
          const active = item.match.includes(route.page) && !(item.route.page === "threads" && activeThread);
          return (
            <a
              key={item.label}
              href={href(item.route)}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="mt-4 px-5 text-xs font-medium text-muted-foreground">最近的线程</div>
      <ScrollArea className="mt-1 min-h-0 flex-1 px-3">
        {state && state.threads.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">还没有线程。点「新线程」交给 agent 一件事。</p>}
        <div className="space-y-0.5 pb-3">
          {state?.threads.map((t) => (
            <a
              key={t.id}
              href={href({ page: "threads", threadId: t.id })}
              onClick={onNavigate}
              className={cn(
                "block rounded-md px-2.5 py-2 transition-colors",
                activeThread === t.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[t.status])} />
                <span className="truncate text-sm">{t.title}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 pl-4 text-xs text-muted-foreground">
                <span>{STAGE_LABEL[t.stage]}</span>
                <span>·</span>
                <span>{t.pending ? "等你确认" : STATUS_LABEL[t.status]}</span>
                <span className="ml-auto">{timeAgo(t.updatedAt)}</span>
              </div>
            </a>
          ))}
        </div>
      </ScrollArea>

      <div className="border-t px-4 py-3">
        <a href={href({ page: "settings", tab: "accounts" })} onClick={onNavigate} className="flex flex-wrap items-center gap-1.5">
          {accounts.map((a) => (
            <span
              key={a.label}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                a.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground",
              )}
            >
              <span className={cn("size-1.5 rounded-full", a.ok ? "bg-emerald-500" : "bg-zinc-300")} />
              {a.label}
            </span>
          ))}
        </a>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5 text-destructive" />}
          {connected ? "已连接本地服务" : "正在重连本地服务…"}
        </div>
      </div>
    </div>
  );
}

export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <aside className="hidden w-72 shrink-0 border-r lg:block">
        <Sidebar route={route} />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-80 p-0">
          <SheetTitle className="sr-only">导航</SheetTitle>
          <Sidebar route={route} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b px-3 lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="打开导航">
            <Menu />
          </Button>
          <span className="text-sm font-semibold">Workbench</span>
        </header>
        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
