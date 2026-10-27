import { useEffect, useState, type ReactNode } from "react";
import { Bot, BookText, Boxes, ChartColumn, ChevronRight, Folder, FolderOpen, FolderPlus, Menu, Plus, Settings, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { STATUS_LABEL, timeAgo } from "@/lib/format";
import { useSwitchProject } from "@/lib/projects";
import { href, navigate, type Route } from "@/lib/router";
import { useBaton } from "@/lib/store";
import type { Project, ThreadSummary } from "@/lib/types";

const NAV: { route: Route; label: string; icon: typeof Bot; match: Route["page"][] }[] = [
  { route: { page: "models" }, label: "模型", icon: Boxes, match: ["models"] },
  { route: { page: "context" }, label: "上下文与记忆", icon: BookText, match: ["context"] },
  { route: { page: "stats" }, label: "统计", icon: ChartColumn, match: ["stats"] },
  { route: { page: "settings" }, label: "设置", icon: Settings, match: ["settings"] },
];

const STATUS_DOT: Record<string, string> = {
  idle: "bg-zinc-300",
  running: "bg-sky-500 animate-pulse",
  waiting: "bg-amber-500",
  paused: "bg-zinc-400",
};

const COLLAPSED_KEY = "baton.collapsedProjects";
const SHOWN = 6;

function readCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function ThreadLink({ t, active, onNavigate }: { t: ThreadSummary; active: boolean; onNavigate?: () => void }) {
  return (
    <a
      href={href({ page: "threads", threadId: t.id })}
      onClick={onNavigate}
      className={cn("block rounded-md py-1.5 pr-2 pl-7 transition-colors", active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60")}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[t.status])} />
        <span className="truncate text-sm">{t.title}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-4 text-xs text-muted-foreground">
        <span className="truncate">{t.model?.name ?? "未选模型"}</span>
        {t.status !== "idle" && (
          <>
            <span>·</span>
            <span className="shrink-0">{STATUS_LABEL[t.status]}</span>
          </>
        )}
        <span className="ml-auto shrink-0">{timeAgo(t.updatedAt)}</span>
      </div>
    </a>
  );
}

function ProjectGroup({
  project,
  current,
  activeThread,
  collapsed,
  onToggle,
  onNavigate,
}: {
  project: Project;
  current: boolean;
  activeThread?: string;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}) {
  const switchProject = useSwitchProject();
  const [showAll, setShowAll] = useState(false);
  const busy = project.threads.filter((t) => t.status !== "idle").length;
  const shown = showAll ? project.threads : project.threads.slice(0, SHOWN);
  const newChat = async () => {
    try {
      await switchProject(project.root);
      navigate({ page: "threads" });
      onNavigate?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="pb-1">
      <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent/60">
        <button type="button" onClick={onToggle} title={project.root} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left">
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} />
          {collapsed ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <FolderOpen className="size-4 shrink-0 text-muted-foreground" />}
          <span className={cn("truncate text-sm", current ? "font-semibold" : "text-muted-foreground")}>{project.name}</span>
          {project.demo && <Badge variant="secondary">演示</Badge>}
          {collapsed && busy > 0 && <span className="size-2 shrink-0 rounded-full bg-sky-500" title={`${busy} 个对话在进行`} />}
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 opacity-60 group-hover:opacity-100"
          onClick={() => void newChat()}
          aria-label={`在 ${project.name} 里新建对话`}
          title={`在 ${project.name} 里新建对话`}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      {!collapsed && (
        <div className="space-y-0.5">
          {project.threads.length === 0 && <p className="py-1 pl-7 text-xs text-muted-foreground">还没有对话</p>}
          {shown.map((t) => (
            <ThreadLink key={t.id} t={t} active={activeThread === t.id} onNavigate={onNavigate} />
          ))}
          {project.threads.length > SHOWN && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="py-1 pl-7 text-xs text-muted-foreground hover:text-foreground">
              {showAll ? "收起" : `显示全部 ${project.threads.length} 个`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Sidebar({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const { state, connected } = useBaton();
  const activeThread = route.page === "threads" ? route.threadId : undefined;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (root: string) => {
    const next = collapsed.includes(root) ? collapsed.filter((r) => r !== root) : [...collapsed, root];
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  };
  const auth = state?.auth;
  const accounts = [
    { label: "ChatGPT", ok: auth?.chatgpt.loggedIn, off: "未登录" },
    { label: "DeepSeek", ok: auth?.deepseek.configured, off: "未配置" },
    { label: "Cursor", ok: auth?.cursor.loggedIn, off: auth?.cursor.installed === false ? "未安装 CLI" : "未登录" },
  ];
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="size-4.5" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">Baton</div>
          <div className="text-xs text-muted-foreground">多模型对话工作台</div>
        </div>
      </div>

      <div className="px-3">
        <Button asChild className="w-full justify-start" onClick={onNavigate}>
          <a href={href({ page: "threads" })}>
            <Plus /> 新对话
          </a>
        </Button>
      </div>

      <nav className="mt-3 space-y-0.5 px-3">
        {NAV.map((item) => {
          const active = item.match.includes(route.page);
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

      <div className="mt-4 flex items-center justify-between pr-3 pl-5">
        <span className="text-xs font-medium text-muted-foreground">项目</span>
        <Button asChild variant="ghost" size="icon" className="size-6" title="打开或新建项目">
          <a href={href({ page: "settings", tab: "workspace" })} onClick={onNavigate} aria-label="打开或新建项目">
            <FolderPlus className="size-3.5" />
          </a>
        </Button>
      </div>
      <ScrollArea className="mt-1 min-h-0 flex-1 px-3">
        {!state && <p className="px-2 py-3 text-xs text-muted-foreground">加载中…</p>}
        <div className="pb-3">
          {state?.projects.map((p) => (
            <ProjectGroup
              key={p.root}
              project={p}
              current={p.root === state.workspace.root}
              activeThread={activeThread}
              collapsed={collapsed.includes(p.root)}
              onToggle={() => toggle(p.root)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </ScrollArea>

      <div className="border-t px-4 py-3">
        <a href={href({ page: "models" })} onClick={onNavigate} className="flex flex-wrap items-center gap-1.5">
          {accounts.map((a) => (
            <span
              key={a.label}
              title={`${a.label}：${a.ok ? "可用" : a.off}`}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                a.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground",
              )}
            >
              <span className={cn("size-1.5 rounded-full", a.ok ? "bg-emerald-500" : "bg-zinc-300")} />
              {a.label}
              <span className="sr-only">：{a.ok ? "可用" : a.off}</span>
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

function DisconnectedBanner() {
  const { connected } = useBaton();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(timer);
  }, [connected]);
  if (!show) return null;
  return (
    <div role="status" className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      <WifiOff className="size-4 shrink-0" />
      和本地服务的连接断开了，正在自动重连。请确认 Baton 服务还在运行。
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
          <span className="text-sm font-semibold">Baton</span>
        </header>
        <DisconnectedBanner />
        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
