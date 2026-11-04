import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, ChevronRight, Folder, FolderPlus, MessageCircle, RotateCcw, Search, ShieldCheck, Square, Zap } from "lucide-react";
import { Slider } from "radix-ui";
import type { Access, ModelPick, Project, Thinking } from "@baton/core/types";
import { useBaton } from "@/lib/store";
import { ControlMenu } from "./surfaces";

const thinkingLabels: Record<Thinking, string> = { off: "关闭", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
const accessOptions: { id: Access; title: string; description: string }[] = [
  { id: "read", title: "只读", description: "浏览代码，不修改文件或运行命令" },
  { id: "ask", title: "操作前询问", description: "修改、命令和外部工具需批准" },
  { id: "allow", title: "直接执行", description: "仅本对话，重启后收回授权" },
];

export function rememberedModel(): ModelPick | undefined {
  try { const value = JSON.parse(localStorage.getItem("baton:last-model") ?? "null"); return value && typeof value.id === "string" ? value : undefined; } catch { return undefined; }
}
export function rememberModel(model: ModelPick) {
  try { localStorage.setItem("baton:last-model", JSON.stringify(model)); } catch { /* The selected model still works for this view. */ }
}

export function ModelMenu({ value, onChange, disabled, onSettings }: { value?: ModelPick; onChange: (value: ModelPick) => void; disabled?: boolean; onSettings?: () => void }) {
  const { state } = useBaton();
  const [open, setOpen] = useState(false), [panel, setPanel] = useState<"effort" | "models">("effort"), [search, setSearch] = useState("");
  const models = state?.gateway.models.filter(m => m.enabled) ?? [];
  const selected = state?.gateway.models.find(m => m.id === value?.id);
  const supportsFast = selected?.fastMode === true;
  const fastEnabled = supportsFast && value?.serviceTier === "priority";
  const thinking = selected?.thinking.includes(value?.thinking as Thinking) ? value?.thinking : selected?.thinking[0];
  const [preview, setPreview] = useState(thinking);
  useEffect(() => { setPreview(thinking); }, [thinking, open]);
  const filtered = models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase()));
  const change = (model: ModelPick) => { onChange(model); rememberModel(model); };
  const changeThinking = (next: Thinking) => { if (selected) change({ id: selected.id, thinking: next, ...(fastEnabled ? { serviceTier: "priority" } : {}) }); };
  const levels = selected?.thinking ?? [];
  const selectedOption = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open && panel === "models") selectedOption.current?.focus({ preventScroll: true }); }, [open, panel]);
  if (!models.length) return null;
  return <ControlMenu label="模型与推理强度" align="end" className={panel === "effort" && selected && (thinking || supportsFast) ? "effort-menu" : "model-menu"} disabled={disabled} open={open} onOpenChange={next => { setOpen(next); if (next) setPanel(selected && (thinking || supportsFast) ? "effort" : "models"); else setSearch(""); }} trigger={<>{supportsFast && <Zap size={15} className={fastEnabled ? "fast-indicator enabled" : "fast-indicator"} aria-label={fastEnabled ? "快速模式已开启" : "快速模式未开启"}/>}<span className="model-name">{selected?.name ?? "选择模型"}</span>{thinking && <span className="model-effort">{thinkingLabels[thinking]}</span>}<ChevronDown size={13}/></>}>
    {panel === "effort" && selected && (thinking || supportsFast) ? <div key="effort" className="picker-panel">
      <div className="effort-heading">
        {supportsFast && <button className="icon effort-fast" aria-label="快速模式" aria-pressed={fastEnabled} disabled={disabled} title={fastEnabled ? "关闭快速模式" : "开启快速模式，可能增加用量"} onClick={() => change({ id: selected.id, thinking, ...(!fastEnabled ? { serviceTier: "priority" } : {}) })}><Zap size={17}/></button>}
        <strong>{thinking ? thinkingLabels[preview ?? thinking] : "快速模式"}</strong>
        {thinking && <button className="icon" aria-label="恢复默认推理强度" title="恢复默认推理强度" disabled={disabled || thinking === levels[0]} onClick={() => changeThinking(levels[0])}><RotateCcw size={16}/></button>}
      </div>
      <button className="effort-model" disabled={disabled} onClick={() => setPanel("models")}>{selected.name}<ChevronRight size={14}/></button>
      {levels.length > 1 ? <>
        <Slider.Root className="effort-slider" aria-label="推理强度" disabled={disabled} min={0} max={levels.length - 1} step={1} value={[Math.max(0, levels.indexOf((preview ?? thinking)!))]} onValueChange={values => setPreview(levels[values[0]])} onValueCommit={values => changeThinking(levels[values[0]])}>
          <Slider.Track className="effort-track">
            <Slider.Range className="effort-range"/>
            <span className="effort-ticks" aria-hidden="true">{levels.map((level, index) => <span key={level} style={{ left: `${index / (levels.length - 1) * 100}%` }}/>)}</span>
          </Slider.Track>
          <Slider.Thumb className="effort-thumb" aria-label="推理强度" aria-valuetext={thinkingLabels[(preview ?? thinking)!]}/>
        </Slider.Root>
      </> : <p className="effort-note">{thinking ? "当前模型提供此推理档位" : "此模型未提供推理档位"}</p>}
    </div> : <div key="models" className="picker-panel">
      <div className="model-menu-heading"><span>选择模型</span>{onSettings && <button className="text-button" onClick={() => { setOpen(false); onSettings(); }}>管理</button>}</div>
      {models.length > 6 && <label className="model-search"><Search size={15}/><input aria-label="搜索模型" placeholder="搜索模型" value={search} onChange={e => setSearch(e.target.value)}/></label>}
      <div className="model-options" role="group" aria-label="可用模型">
        {filtered.map(m => <button key={m.id} ref={m.id === selected?.id ? selectedOption : undefined} className="model-option" disabled={disabled} aria-pressed={m.id === value?.id} title={m.id} onClick={() => {
          change({ id: m.id, thinking: m.thinking.includes(thinking as Thinking) ? thinking : m.thinking[0], ...(m.id === selected?.id && fastEnabled ? { serviceTier: "priority" } : {}) }); setOpen(false);
        }}><span>{m.name}</span>{m.id === value?.id && <Check size={17}/>}</button>)}
        {!filtered.length && <p className="menu-empty">没有匹配的模型</p>}
      </div>
    </div>}
  </ControlMenu>;
}

export function ProjectMenu({ project, onSelect, onOpen }: { project?: Project; onSelect: (project?: Project) => void; onOpen: () => void }) {
  const { state } = useBaton();
  const [open, setOpen] = useState(false);
  return <ControlMenu label="选择项目" className="project-menu" open={open} onOpenChange={setOpen} trigger={<><Folder size={17}/><span>{project?.name ?? "选择项目"}</span><ChevronDown size={13}/></>}>
    <p className="menu-heading">用于这次对话</p>
    <button className="menu-option" aria-pressed={!project} onClick={() => { onSelect(); setOpen(false); }}><span>不选择项目</span>{!project && <Check size={15}/>}</button>
    {state?.projects.filter(p => !p.removed).map(p => <button key={p.id} className="menu-option project-option" title={p.root} aria-pressed={p.id === project?.id} onClick={() => { onSelect(p); setOpen(false); }}><Folder size={16}/><span>{p.name}</span>{p.id === project?.id && <Check size={15}/>}</button>)}
    <button className="menu-option open-project-option" onClick={() => { setOpen(false); onOpen(); }}><span><FolderPlus size={16}/>打开本地文件夹</span></button>
  </ControlMenu>;
}

export function Composer({ text, onText, onSend, busy, model, onModel, project, access, onAccess, active, onCancel, children, tray, onSettings }: {
  text: string; onText: (text: string) => void; onSend: () => void; busy: boolean;
  model?: ModelPick; onModel: (model: ModelPick) => void; project?: Project;
  access: Access; onAccess: (access: Access) => void; active?: boolean; onCancel?: () => void;
  children?: ReactNode; tray?: ReactNode; onSettings?: () => void;
}) {
  const [accessOpen, setAccessOpen] = useState(false);
  const canSend = !!text.trim() && !!model && !busy;
  return <div className={`composer-dock ${tray ? "with-tray" : ""}`}>
    <div className="composer">
      <textarea aria-label="消息" rows={2} value={text} placeholder={active ? "补充要求，或安排下一步…" : project ? "描述任务，一起开始…" : "提问、讨论，或一起理清一个想法…"} onChange={e => onText(e.target.value)} onKeyDown={e => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) onSend(); }
      }}/>
      <div className="composer-controls">
        {project ? <ControlMenu label="对话权限" disabled={active || busy} open={accessOpen} onOpenChange={setAccessOpen} trigger={<><ShieldCheck size={17}/><span>{accessOptions.find(a => a.id === access)?.title}</span><ChevronDown size={13}/></>}>
          <p className="menu-heading">对话权限</p>{accessOptions.map(a => <button key={a.id} className="menu-option" aria-pressed={a.id === access} onClick={() => { setAccessOpen(false); onAccess(a.id); }}><span><strong>{a.title}</strong><small>{a.description}</small></span>{a.id === access && <Check size={16}/>}</button>)}
        </ControlMenu> : <span className="conversation-kind"><MessageCircle size={16}/>普通聊天</span>}
        <div className="composer-spacer"/>
        <ModelMenu value={model} onChange={onModel} disabled={active || busy} onSettings={onSettings}/>
        {active && <button className="stop icon" aria-label="停止运行" onClick={onCancel}><Square size={16}/></button>}
        <button className="send icon" aria-label={active ? "提交补充" : "发送消息"} disabled={!canSend} onClick={onSend}><ArrowUp size={20}/></button>
      </div>
      {children}
    </div>
    {tray && <div className="composer-tray">{tray}</div>}
  </div>;
}
