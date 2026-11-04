import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { FileDiff, Minimize2, ChevronDown, ShieldCheck, Terminal, FileText, CircleAlert, ChevronRight, History, Cpu, Folder } from "lucide-react";
import { toast } from "sonner";
import type { ChangePreview, Item, Thread } from "@baton/core/types";
import { api, patch, post } from "@/lib/api";
import { useBaton } from "@/lib/store";
import { RichText } from "./rich-text";
import { ControlMenu, Modal } from "./surfaces";
import { Composer } from "./composer";

const status: Record<string, string> = { queued: "等待项目任务结束", running: "执行中", succeeded: "已完成", failed: "失败", cancelled: "已停止", interrupted: "退出前未完成", ok: "完成", error: "失败", pending: "等待批准", allowed: "已允许", denied: "已拒绝", expired: "已失效" };
const toolNames: Record<string, string> = { read: "读取文件", edit: "编辑文件", write: "写入文件", bash: "运行命令", ls: "浏览目录", grep: "搜索内容", find: "查找文件" };
function ToolItem({ item, busy, decide }: { item: Item; busy: boolean; decide: (allow: boolean) => void }) {
  const pending = item.kind === "approval" && item.status === "pending";
  const args = item.args as Record<string, unknown> | undefined;
  const target = args?.path ?? args?.command ?? args?.pattern;
  const shortTarget = args?.path && typeof target === "string" ? target.split(/[\\/]/).slice(-2).join("/") : String(target ?? "");
  const Icon = item.tool === "bash" ? Terminal : FileText;
  return <details className={`activity ${item.kind === "approval" ? "approval" : ""} ${pending ? "awaiting" : ""}`} open={pending ? true : undefined}>
    <summary><ChevronRight className="disclosure-icon" size={14}/>{pending ? <ShieldCheck size={16}/> : <Icon size={16}/>}<span className="activity-title">{pending ? "需要你的批准" : toolNames[item.tool ?? ""] ?? item.tool}</span>{!pending && target ? <span className="activity-target" title={String(target)}>{shortTarget}</span> : null}<span className={`activity-status ${item.status === "error" ? "error-text" : ""}`}>{status[item.status ?? ""] ?? item.status}</span></summary>
    <div className="activity-content">
      {pending && <div className="approval-action"><strong>{toolNames[item.tool ?? ""] ?? item.tool}</strong>{target ? <code>{String(target)}</code> : null}</div>}
      {item.kind === "tool" && item.args !== undefined && <details className="arguments"><summary>调用参数</summary><pre>{JSON.stringify(item.args, null, 2)}</pre></details>}
      <pre className="tool-output">{item.text}</pre>
      {pending && <div className="approval-actions"><span>仅批准这次操作</span><button disabled={busy} onClick={() => decide(false)}>拒绝</button><button className="primary" disabled={busy} onClick={() => decide(true)}>允许这次操作</button></div>}
    </div>
  </details>;
}

export function Chat({ thread, text, onText: setText, onSettings }: { thread: Thread; text: string; onText: Dispatch<SetStateAction<string>>; onSettings: () => void }) {
  const { state, refresh } = useBaton();
  const [mode, setMode] = useState<"steer" | "followUp">("steer"), [busy, setBusy] = useState(false), [changes, setChanges] = useState<ChangePreview>();
  const end = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), following = useRef(true);
  const active = thread.status !== "idle", models = state?.gateway.models ?? [], selected = models.find(m => m.id === thread.model?.id);
  const project = state?.projects.find(p => p.id === thread.projectId);
  const latest = thread.runs.at(-1), empty = !thread.items.length;
  useEffect(() => { if (following.current) end.current?.scrollIntoView({ behavior: "instant", block: "end" }); }, [thread.items.length, thread.items.at(-1)?.text]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await refresh(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const send = () => act(async () => { await post(`/api/threads/${thread.id}/${active ? "inject" : "messages"}`, active ? { text, mode } : { text }); setText(current => current === text ? "" : current); following.current = true; });
  return <div className={`chat-layout ${empty ? "is-empty" : ""}`}>
    <div className="conversation" ref={scroll} onScroll={() => { const e = scroll.current!; following.current = e.scrollHeight - e.scrollTop - e.clientHeight < 120; }}>
      <div className="conversation-content">
        {empty && <div className="chat-empty"><h1>想一起完成什么？</h1><p>从一个问题、一个改动，或一个新想法开始。</p></div>}
        {thread.items.map(item => item.kind === "assistant" && !item.text && item.status !== "running" ? null : item.kind === "user" || item.kind === "assistant" ? <article key={item.id} className={`message ${item.kind}`} aria-label={item.kind === "user" ? "你的消息" : "Baton 的回复"}>{item.kind === "assistant" && <div className="assistant-label">Baton</div>}{item.text ? <RichText text={item.text}/> : item.status === "running" ? <span className="muted">正在思考…</span> : null}</article>
          : item.kind === "notice" ? <div key={item.id} className="notice"><CircleAlert size={16}/><RichText text={item.text}/></div>
          : <ToolItem key={item.id} item={item} busy={busy} decide={allow => void act(() => post(`/api/approvals/${item.approvalId}`, { allow }))}/>)}
        {!!thread.pending.length && <div className="pending-messages">{thread.pending.map((p, i) => <p key={i}><span>{p.mode === "steer" ? "等待补充到当前任务" : "完成后继续"}</span>{p.text}</p>)}</div>}
        {!!thread.runs.length && <details className="run-history" open={latest && ["failed", "interrupted"].includes(latest.status) ? true : undefined}><summary><History size={14}/>运行记录<span>{thread.runs.length}</span>{latest && ["failed", "interrupted"].includes(latest.status) && <span className="error-text">{status[latest.status]}</span>}<ChevronDown size={14}/></summary><div>{thread.runs.map(run => <div key={run.id} className="run-line"><span className={run.status === "failed" ? "error-text" : ""}>{status[run.status]}</span><span className="run-model">{run.model.id}{run.model.thinking ? ` (${run.model.thinking})` : ""}</span>{run.changedFiles.length > 0 && <button disabled={active} onClick={() => void act(async () => setChanges(await api<ChangePreview>(`/api/runs/${run.id}/changes`)))}><FileDiff size={14}/>{run.changedFiles.length} 个文件{run.restoredAt ? "（已撤销）" : ""}</button>}{run.error && <p className="error-text">{run.error}</p>}{run.restoreBlocked && <p className="error-text">{run.restoreBlocked}</p>}</div>)}</div></details>}
        {!active && latest && latest.changedFiles.length > 0 && <button className="change-summary" onClick={() => void act(async () => setChanges(await api<ChangePreview>(`/api/runs/${latest.id}/changes`)))}><FileDiff size={16}/><span>{latest.changedFiles.length} 个文件已{latest.restoredAt ? "恢复" : "修改"}</span><span className="muted">查看改动</span><ChevronRight size={16}/></button>}
        <div ref={end}/>
      </div>
    </div>
    <div className="composer-wrap"><div className="composer-inner">
      {active && <div className="running-status"><span>{thread.items.some(i => i.kind === "approval" && i.status === "pending") ? "等待你的批准" : status[thread.status]}</span><button className="text-button" onClick={() => void act(() => post(`/api/threads/${thread.id}/cancel`))}>停止任务</button></div>}
      <Composer text={text} onText={setText} onSend={() => void send()} busy={busy} model={thread.model} onModel={model => void act(() => patch(`/api/threads/${thread.id}`, { model }))} project={project} access={thread.access} onAccess={access => void act(() => patch(`/api/threads/${thread.id}`, { access }))} active={active} onCancel={() => void act(() => post(`/api/threads/${thread.id}/cancel`))} onSettings={onSettings} tray={<span className="composer-project" title={project?.root}><Folder size={16}/>{project?.name ?? "未选择项目"}</span>}>
        {active && <div className="queue-controls"><label><input type="radio" name="injection" checked={mode === "steer"} onChange={() => setMode("steer")}/>{project ? "影响当前任务" : "补充当前话题"}</label><label><input type="radio" name="injection" checked={mode === "followUp"} onChange={() => setMode("followUp")}/>{project ? "完成后再处理" : "回复后继续"}</label>{project && <span>不会立即打断已执行的命令</span>}</div>}
      </Composer>
      <footer className="composer-meta"><ControlMenu label="上下文与用量" trigger={<><Cpu size={14}/><span>上下文</span><ChevronDown size={12}/></>}><div className="context-info"><h3>上下文与用量</h3><dl><dt>上下文窗口</dt><dd>{selected?.contextWindow?.toLocaleString() ?? "未知"}</dd><dt>最近运行用量</dt><dd>{latest?.usage?.total !== undefined ? `${latest.usage.total.toLocaleString()} tokens` : "未知"}</dd><dt>费用</dt><dd>未知</dd></dl><p>用量为上游返回值，不代表当前上下文占用。</p><button disabled={active || !thread.sessionFile || busy} title="压缩当前上下文，保留完整历史" onClick={() => void act(() => post(`/api/threads/${thread.id}/compact`))}><Minimize2 size={14}/>压缩上下文</button></div></ControlMenu><span>{!thread.projectId ? "未连接项目" : thread.access === "read" ? "只读模式" : thread.access === "ask" ? "关键操作前询问" : "直接执行仅限本对话"}</span><span className="keyboard-hint">Enter 发送，Shift + Enter 换行</span></footer>
    </div></div>
    {changes && <Modal title="本次运行的文件改动" wide onClose={() => setChanges(undefined)}><p className="modal-description">保留运行前已有的修改。排除目录：{changes.excluded.join("、")}。撤销不影响聊天历史或外部系统。</p>{(changes.blocked || changes.conflicts.length > 0) && <div className="error-banner">{changes.blocked ?? `后续修改冲突：${changes.conflicts.join("、")}`}</div>}{changes.changes.map(file => <details className="file-change" key={file.path} open><summary><FileText size={16}/>{file.path}<span>{file.kind === "add" ? "新增" : file.kind === "delete" ? "删除" : "修改"}</span></summary>{file.binary ? <p>二进制或大文件，仅展示变更记录。</p> : <div className="diff-columns"><div><span>运行前</span><pre className="removed">{file.before ?? "[文件原先不存在]"}</pre></div><div><span>运行后</span><pre className="added">{file.after ?? "[文件已删除]"}</pre></div></div>}</details>)}<div className="modal-actions"><button className="danger" disabled={busy || !!changes.blocked || changes.conflicts.length > 0} onClick={() => void act(async () => { await post(`/api/runs/${changes.runId}/restore`, { token: changes.token }); setChanges(undefined); toast.success("文件已恢复并回读确认"); })}>撤销这次运行的文件改动</button></div></Modal>}
  </div>;
}
