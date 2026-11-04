import { useEffect, useState } from "react";
import { Cable, Blocks, BookOpen, Plug, FileInput, Folder, RefreshCw, Plus } from "lucide-react";
import { toast } from "sonner";
import type { Project, Resource, Thread } from "@baton/core/types";
import { api, post, put } from "@/lib/api";
import { useBaton } from "@/lib/store";
import { GatewaySettings } from "./gateway-settings";
type ImportPreview = { source: string; destination: string; content: string; current?: string; conflict: boolean; token: string };
export function Settings({ project, thread, onThread }: { project?: Project; thread?: Thread; onThread: () => void }) {
  const { state, refresh } = useBaton();
  const [tab, setTab] = useState("gateway"), [busy, setBusy] = useState(false);
  const [resourcePath, setResourcePath] = useState(""), [kind, setKind] = useState<Resource["kind"]>("skill");
  const [memory, setMemory] = useState<{ name: string; content: string }[]>([]), [name, setName] = useState("project.md"), [content, setContent] = useState("");
  const [mcp, setMcp] = useState("[]"), [source, setSource] = useState(""), [importKind, setImportKind] = useState<"memory" | "rule">("memory"), [preview, setPreview] = useState<ImportPreview>();
  useEffect(() => { setMcp(JSON.stringify(project?.mcp ?? [], null, 2)); }, [project?.id]);
  useEffect(() => { if (project && tab === "memory") void api<{ name: string; content: string }[]>(`/api/projects/${project.id}/memory`).then(setMemory).catch(e => toast.error(e.message)); }, [project?.id, tab, state?.threads]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await refresh(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const tabs = [{id: "gateway", title: "连接与模型", icon: Cable}, {id: "resources", title: "规则与 Skills", icon: Blocks}, {id: "memory", title: "项目记忆", icon: BookOpen}, {id: "mcp", title: "MCP 工具", icon: Plug}, {id: "import", title: "导入 Markdown", icon: FileInput}];
  return <div className="settings-page"><div className="settings-shell"><nav className="settings-nav" aria-label="设置分类"><h1>设置</h1>{tabs.map(({id, title, icon: Icon}) => <button key={id} aria-current={tab === id ? "page" : undefined} className={tab === id ? "selected" : ""} onClick={() => setTab(id)}><Icon size={18}/>{title}</button>)}<p>{project ? `项目：${project.name}` : "选择项目后管理项目资源"}</p></nav><div className="settings-content">
    {tab === "gateway" ? <GatewaySettings/> : !project ? <div className="settings-section"><h2>请先选择项目</h2><p>项目规则、记忆、Skills 和 MCP 设置只属于所选项目。</p></div> : <>
      <div className="project-heading" title={project.root}><Folder size={14}/><strong>{project.name}</strong><span>{project.root}</span></div>
      {tab === "resources" && <section className="settings-section">
        <div className="section-heading"><h2>规则与 Skills</h2><button disabled={busy} aria-label="重新发现资源" onClick={() => void act(() => api(`/api/projects/${project.id}/resources`))}><RefreshCw size={14}/>刷新</button></div>
        <p>选择此项目使用的规则、Skills 和扩展。启用后从下一次运行生效。</p>
        <div className="resource-list">
          {!project.resources.length && <div className="resource-empty"><Blocks size={28} strokeWidth={1.3}/><strong>还没有项目资源</strong><p>添加本地文件，或刷新以发现项目中的资源。</p></div>}
          {project.resources.map(r => <label className="resource-row" key={r.id}><input type="checkbox" checked={r.enabled} disabled={busy} onChange={e => void act(() => put(`/api/projects/${project.id}/resources`, { id: r.id, enabled: e.target.checked }))}/><span><strong>{r.kind === "rule" ? "规则" : r.kind === "skill" ? "Skill" : "扩展"}</strong><small>{r.path}</small>{r.error && <small className="error-text">{r.error}</small>}</span></label>)}
        </div>
        <div className="resource-add"><h3>添加本地资源</h3><div className="resource-input-group">
          <select aria-label="资源类型" value={kind} onChange={e => setKind(e.target.value as Resource["kind"])}><option value="skill">Skill</option><option value="rule">规则</option><option value="extension">扩展</option></select>
          <input aria-label="资源路径" value={resourcePath} onChange={e => setResourcePath(e.target.value)} placeholder="粘贴文件的完整路径"/>
          <button disabled={busy || !resourcePath} onClick={() => void act(async () => { await put(`/api/projects/${project.id}/resources`, { path: resourcePath, kind, enabled: false }); setResourcePath(""); })}><Plus size={16}/>添加</button>
        </div><p>添加后再选择是否启用。扩展会在本机执行代码，只启用你信任且兼容 Baton 的扩展。</p></div>
      </section>}
      {tab === "memory" && <section className="settings-section"><h2>项目记忆</h2><p>明确保存的记忆可在本项目新对话中按需读取。修改或删除不会抹除历史消息中的副本。保存按当前对话权限执行。</p><div className="memory-list">{memory.map(m => <button key={m.name} onClick={() => { setName(m.name); setContent(m.content); }}>{m.name}</button>)}</div><label>文件名<input aria-label="文件名" value={name} onChange={e => setName(e.target.value)}/></label><textarea aria-label="记忆内容" className="code-editor" rows={12} value={content} onChange={e => setContent(e.target.value)} placeholder="记录明确的项目约定、决策或偏好"/><div className="row"><button className="primary" disabled={busy || !thread} onClick={() => void act(async () => { await post(`/api/threads/${thread!.id}/memory`, { name, content }); onThread(); })}>保存记忆</button><button disabled={busy || !thread || !memory.some(m => m.name === name)} onClick={() => void act(async () => { await post(`/api/threads/${thread!.id}/memory`, { name }); onThread(); })}>删除此记忆</button></div>{!thread && <p>先选择一个对话，以便按其权限保存或删除。</p>}</section>}
      {tab === "mcp" && <section className="settings-section"><h2>外部 MCP 服务</h2><p>手动配置已安装的服务，可使用 stdio 命令或 HTTP 地址。启用代表信任服务进程；其工具调用仍受对话权限控制，自报只读不会免除审批。保存后在下一次运行连接。</p><p className="muted">示例：[{`{"name":"local-tools","command":"node","args":["/path/server.mjs"],"enabled":false}`} ]</p><textarea className="code-editor" aria-label="MCP 配置" rows={14} value={mcp} onChange={e => setMcp(e.target.value)}/><button className="primary" disabled={busy} onClick={() => void act(() => put(`/api/projects/${project.id}/mcp`, { servers: JSON.parse(mcp) }))}>保存服务配置</button><button disabled={busy || !thread} onClick={() => void act(async () => { await post(`/api/threads/${thread!.id}/mcp/check`); onThread(); })}>检查连接与工具状态</button><p>连接或工具调用失败会显示在对话执行记录中，不会改用其他模型。</p></section>}
      {tab === "import" && <section className="settings-section"><h2>导入 Markdown</h2><p>旧数据继续保留。只导入你选定的规则或记忆，并在写入前预览已有内容。</p><input aria-label="导入来源" placeholder="旧 Markdown 文件的完整路径" value={source} onChange={e => { setSource(e.target.value); setPreview(undefined); }}/><div className="row"><select aria-label="导入类型" value={importKind} onChange={e => { setImportKind(e.target.value as "memory" | "rule"); setPreview(undefined); }}><option value="memory">项目记忆</option><option value="rule">项目规则</option></select><input aria-label="文件名" value={name} onChange={e => { setName(e.target.value); setPreview(undefined); }}/></div><button disabled={busy || !source} onClick={() => void act(async () => setPreview(await post<ImportPreview>(`/api/projects/${project.id}/import/preview`, { source, name, kind: importKind })))}>预览导入</button>{preview && <><p>{preview.destination}</p>{preview.conflict && <p className="error-text">目标已存在，导入会替换以下内容：</p>}<div className="diff-columns"><pre>{preview.current ?? "[目标不存在]"}</pre><pre>{preview.content}</pre></div><button disabled={busy || !thread} className="primary" onClick={() => void act(async () => { await post(`/api/threads/${thread!.id}/import`, { source, name, kind: importKind, token: preview.token }); onThread(); })}>导入已预览内容</button>{!thread && <p>请先选择一个对话，以便按其权限执行导入。</p>}</>}</section>}
    </>}
  </div></div></div>;
}
