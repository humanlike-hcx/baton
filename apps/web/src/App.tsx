import { useEffect, useState, type SetStateAction } from "react";
import { FolderOpen, FolderPlus, SquarePen, Settings2, Trash2, PanelLeft, X, ChevronRight, Folder, Cable, Check, MessageCircle, ChevronDown, Plus, Archive, ArchiveRestore, Search } from "lucide-react";
import type { Project, Thread } from "@baton/core/types";
import { BatonProvider, useBaton } from "@/lib/store";
import { post, del } from "@/lib/api";
import { Chat } from "@/components/chat";
import { Draft } from "@/components/draft";
import { Settings } from "@/components/settings";
import { Modal } from "@/components/surfaces";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

function ThreadRow({ thread: t, selected, onSelect, onArchive }: { thread: Thread; selected: boolean; onSelect: () => void; onArchive: () => void }) {
  return <div className={`thread-row ${selected ? "selected" : ""}`}>
    <button aria-current={selected ? "page" : undefined} className={`thread-link ${!t.projectId ? "general-thread" : ""}`} onClick={onSelect}>{!t.projectId && <MessageCircle size={14}/>}<span>{t.title}</span>{t.items.some(i => i.kind === "approval" && i.status === "pending") ? <small className="pending-label">待批准</small> : t.status !== "idle" ? <small>{t.status === "queued" ? "排队" : "运行中"}</small> : null}</button>
    <button className="icon thread-archive" aria-label={`归档对话：${t.title}`} title={t.status === "idle" ? "归档对话" : "请先停止任务"} disabled={t.status !== "idle"} onClick={onArchive}><Archive size={14}/></button>
  </div>;
}

function Shell() {
  const { state, connected, error, refresh } = useBaton();
  const [tid, setTid] = useState<string>(), [pid, setPid] = useState<string>();
  const [archiveOpen, setArchiveOpen] = useState(false), [archiveSearch, setArchiveSearch] = useState("");
  const [settings, setSettings] = useState(false), [mobile, setMobile] = useState(false);
  const [opening, setOpening] = useState(false), [folder, setFolder] = useState(""), [draftText, setDraftText] = useState("");
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});
  const setThreadDraft = (id: string, value: SetStateAction<string>) => setChatDrafts(drafts => ({
    ...drafts, [id]: typeof value === "function" ? value(drafts[id] ?? "") : value,
  }));
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem("baton:collapsed-projects") ?? "[]"); return Array.isArray(saved) ? saved.filter(x => typeof x === "string") : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem("baton:collapsed-projects", JSON.stringify(collapsed)); } catch { /* Preferences remain usable in memory. */ } }, [collapsed]);
  const thread = state?.threads.find(t => t.id === tid);
  const project = state?.projects.find(p => p.id === (thread ? thread.projectId : pid) && !p.removed);
  const select = (p?: Project, t?: Thread) => { setPid(p?.id); setTid(t?.id); setSettings(false); setMobile(false); };
  const create = (p?: Project) => { select(p); };
  const threads = state?.threads.filter(t => t.items.length > 0 || t.runs.length > 0) ?? [];
  const archiveThread = async (t: Thread) => {
    try {
      await post(`/api/threads/${t.id}/archive`);
      if (t.id === tid) select();
      await refresh();
      toast("对话已归档", { duration: 7000, action: { label: "撤销", onClick: () => {
        void post<Thread>(`/api/threads/${t.id}/restore`).then(async restored => { await refresh(); select(state?.projects.find(p => p.id === restored.projectId), restored); }).catch(e => toast.error(e.message));
      } } });
    } catch (e) { toast.error((e as Error).message); }
  };
  const open = async (target: string) => {
    try { const p = await post<Project>("/api/projects", { path: target }); await refresh(); select(p); setOpening(false); toast.message("项目规则、Skills 和扩展需在资源设置中确认启用。"); }
    catch (e) { toast.error((e as Error).message); }
  };
  return <div className="baton-layout">
    {mobile && <button className="sidebar-scrim" aria-label="收起侧栏" onClick={() => setMobile(false)}/>}
    <aside className={`baton-sidebar ${mobile ? "mobile-open" : ""}`} aria-label="项目与对话">
      <div className="brand"><strong>Baton</strong><button className="icon mobile-close" aria-label="关闭侧栏" onClick={() => setMobile(false)}><X size={20}/></button><span className="brand-caption">本地工作空间</span></div>
      <button className="nav-action" onClick={() => create()}><SquarePen size={18}/>新建对话</button>
      <button className="nav-action" onClick={() => setOpening(true)}><FolderPlus size={18}/>打开项目</button>
      <div className="project-list">
        <div className="sidebar-section-label section-with-action"><span>普通聊天</span><button className="icon" aria-label="新建普通聊天" title="不选择项目，直接聊天" onClick={() => void create()}><Plus size={16}/></button></div>
        {threads.filter(t => !t.projectId).slice().reverse().map(t => <ThreadRow key={t.id} thread={t} selected={t.id === tid && !settings} onSelect={() => select(undefined, t)} onArchive={() => void archiveThread(t)}/>)}
        <div className="sidebar-section-label">项目</div>
        {!state && <div className="sidebar-empty">正在载入工作空间…</div>}
        {state && !state.projects.some(p => !p.removed) && <div className="sidebar-empty">打开文件夹后，项目和对话会显示在这里。</div>}
        {state?.projects.filter(p => !p.removed).map(p => <section key={p.id}>
          <div className={`project-label ${p.id === project?.id ? "current" : ""}`}>
            <button className="icon project-toggle" aria-label={`${collapsed.includes(p.id) ? "展开" : "折叠"} ${p.name} 的对话`} aria-expanded={!collapsed.includes(p.id)} onClick={() => setCollapsed(ids => ids.includes(p.id) ? ids.filter(id => id !== p.id) : [...ids, p.id])}>{collapsed.includes(p.id) ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}</button><button className="project-select" title={p.root} onClick={() => select(p)}><Folder size={16}/><span>{p.name}</span></button>
            <div className="project-actions"><button className="icon" aria-label={`在 ${p.name} 新建对话`} title="新建对话" onClick={() => void create(p)}><SquarePen size={16}/></button><button className="icon" aria-label={`移除 ${p.name} 入口`} title="移除入口，保留文件和历史" onClick={() => void del(`/api/projects/${p.id}`).then(refresh).catch(e => toast.error(e.message))}><Trash2 size={16}/></button></div>
          </div>
          {!collapsed.includes(p.id) && <div className="project-threads">{threads.filter(t => t.projectId === p.id).slice().reverse().map(t => <ThreadRow key={t.id} thread={t} selected={t.id === tid && !settings} onSelect={() => select(p, t)} onArchive={() => void archiveThread(t)}/>)}</div>}
        </section>)}
      </div>
      <div className="sidebar-bottom">
        <button className="nav-action" onClick={() => { setArchiveSearch(""); setArchiveOpen(true); setMobile(false); }}><Archive size={18}/>已归档</button>
        <button className={`nav-action ${settings ? "selected" : ""}`} onClick={() => { setSettings(true); setMobile(false); }}><Settings2 size={18}/>设置<span className="nav-caption">连接与项目</span></button>
        <div className="connection">{connected ? <Check size={14}/> : <Cable size={14}/>}<span>{connected ? "本地服务已连接" : "正在重新连接…"}</span></div>
      </div>
    </aside>
    <main className="baton-main" id="main">
      <header className="topbar">
        <button className="icon mobile-menu" onClick={() => setMobile(true)} aria-label="打开侧栏"><PanelLeft size={20}/></button>
        <div className="breadcrumb"><span>{project?.name ?? (thread ? "普通聊天" : "Baton")}</span><ChevronRight size={14}/><strong>{settings ? "设置" : thread?.title ?? "新对话"}</strong></div>
        {project && <button className="header-action" aria-label="新建对话" title={project.root} onClick={() => void create(project)}><SquarePen size={16}/><span>新建对话</span></button>}
      </header>
      {error && <div role="alert" className="error-banner">{error}<button onClick={() => void refresh()}>重新连接</button></div>}
      {settings ? <Settings project={project} thread={thread} onThread={() => setSettings(false)}/>
        : thread ? <Chat key={thread.id} thread={thread} text={chatDrafts[thread.id] ?? ""} onText={value => setThreadDraft(thread.id, value)} onSettings={() => setSettings(true)}/>
        : <Draft text={draftText} onText={setDraftText} project={project} onProject={p => setPid(p?.id)} onOpen={() => setOpening(true)} onSettings={() => setSettings(true)} onStarted={t => { setDraftText(current => current === t.runs[0]?.prompt ? "" : current); select(state?.projects.find(p => p.id === t.projectId), t); }}/>}
    </main>
    {archiveOpen && <Modal title="已归档" onClose={() => setArchiveOpen(false)}>
      <label className="archive-search"><Search size={16}/><input aria-label="搜索已归档对话" placeholder="搜索对话" value={archiveSearch} onChange={e => setArchiveSearch(e.target.value)}/></label>
      <div className="archive-list">{state?.archivedThreads.filter(t => t.title.toLowerCase().includes(archiveSearch.toLowerCase())).slice().reverse().map(t => {
        const owner = state.projects.find(p => p.id === t.projectId);
        return <div className="archive-row" key={t.id}><div><strong>{t.title}</strong><span>{owner?.name ?? "普通聊天"}{owner?.removed ? "（项目已移除）" : ""}</span></div><button aria-label={`恢复对话：${t.title}`} disabled={owner?.removed} title={owner?.removed ? "重新打开项目后可恢复" : "恢复到侧栏"} onClick={() => { void post<Thread>(`/api/threads/${t.id}/restore`).then(async restored => { await refresh(); setArchiveOpen(false); select(owner, restored); }).catch(e => toast.error(e.message)); }}><ArchiveRestore size={16}/>恢复</button></div>;
      })}{!state?.archivedThreads.some(t => t.title.toLowerCase().includes(archiveSearch.toLowerCase())) && <p className="archive-empty">{archiveSearch ? "没有匹配的对话" : "还没有归档的对话"}</p>}</div>
    </Modal>}
    {opening && <Modal title="打开本地项目" onClose={() => setOpening(false)}><p className="modal-description">选择要一起工作的文件夹。</p><label className="field-label">项目路径<input aria-label="项目路径" autoFocus placeholder="本地文件夹路径" value={folder} onChange={e => setFolder(e.target.value)}/></label><div className="modal-actions"><button onClick={() => void post<{ path?: string }>("/api/projects/pick").then(r => { if (r.path) setFolder(r.path); }).catch(e => toast.error(e.message))}><FolderOpen size={16}/>选择文件夹</button><button className="primary" disabled={!folder.trim()} onClick={() => void open(folder)}>打开项目</button></div></Modal>}
  </div>;
}
export default function App() { return <BatonProvider><Shell/><Toaster position="top-center" richColors/></BatonProvider>; }
