import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { post, put } from "@/lib/api";
import { useBaton } from "@/lib/store";

export function GatewaySettings() {
  const { state, refresh } = useBaton(), gateway = state?.gateway;
  const [url, setUrl] = useState(gateway?.url ?? "http://127.0.0.1:3425/v1"), [token, setToken] = useState("");
  const [busy, setBusy] = useState(false), [search, setSearch] = useState("");
  useEffect(() => { if (gateway?.url) setUrl(gateway.url); }, [gateway?.url]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await refresh(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const models = gateway?.models ?? [], selected = models.filter(m => m.enabled).map(m => m.id);
  const choose = (ids: string[]) => void act(() => put("/api/gateway/selection", { ids }));
  return <>
    <section className="settings-section">
      <h1>连接与模型</h1>
      <p>{gateway?.managed ? "连接由 Magpie 管理。在 Magpie 的 Baton 一行选择新对话的默认模型。" : "连接独立运行的 Magpie，模型目录会自动同步并检测。"}</p>
      <label>API 基础地址（包含 /v1）<input disabled={gateway?.managed} value={url} onChange={e => setUrl(e.target.value)}/></label>
      {!gateway?.managed && <label>网关鉴权信息<input type="password" autoComplete="off" value={token} placeholder={gateway?.hasToken ? "已保存；留空保留" : "本机网关无需鉴权时留空"} onChange={e => setToken(e.target.value)}/></label>}
      <div className="row">
        {!gateway?.managed && <button className="primary" disabled={busy} onClick={() => void act(async () => { await put("/api/gateway", { url, ...(token ? { token } : {}) }); setToken(""); })}>保存连接</button>}
        <button disabled={busy || !gateway?.configured} onClick={() => void act(() => post("/api/gateway/check"))}>刷新模型目录</button>
        {!gateway?.managed && gateway?.hasToken && <button disabled={busy} onClick={() => void act(() => put("/api/gateway", { url, token: "" }))}>清除网关凭据</button>}
      </div>
      <div className={`connection-result ${gateway?.error ? "error-text" : "muted"}`}>{gateway?.error ?? gateway?.status}</div>
    </section>
    <section className="settings-section">
      <h2>聊天框中的模型</h2>
      <p>勾选你想在聊天框切换的模型。新增模型会自动检测，检测会发送少量请求；通过后由你决定是否加入。</p>
      <div className="model-selection-actions">
        <button disabled={busy || !models.some(m => m.verified)} onClick={() => choose(models.filter(m => m.verified).map(m => m.id))}>全选</button>
        <button disabled={busy || !selected.length} onClick={() => choose([])}>全不选</button>
        <span>已选 {selected.length} 个</span>
      </div>
      <label className="settings-search"><Search size={16}/><input aria-label="搜索模型" placeholder="搜索模型名称或 ID" value={search} onChange={e => setSearch(e.target.value)}/></label>
      <div className="model-list">
        {!models.length && <div className="settings-empty">{gateway?.configured ? "正在读取模型目录…" : "连接 Magpie 后，模型会显示在这里。"}</div>}
        {models.filter(m => `${m.id} ${m.name}`.toLowerCase().includes(search.toLowerCase())).map(m => <div className="model-selection-row" key={m.id}>
          <input type="checkbox" aria-label={`在聊天框显示 ${m.name}`} disabled={busy || (!m.verified && !m.enabled)} checked={!!m.enabled} onChange={e => choose(e.target.checked ? [...selected, m.id] : selected.filter(id => id !== m.id))}/>
          <div><strong>{m.name}</strong><small>{m.id}</small><small className={m.checkStatus === "failed" ? "error-text" : ""}>{m.checkStatus === "checking" ? "检测中…" : m.checkStatus === "pending" ? "等待检测" : m.verified ? "可用" : "检测失败"}{m.fastMode ? "，支持快速模式" : ""}</small>{m.error && m.checkStatus === "failed" && <p className="error-text">{m.error}</p>}</div>
          {m.checkStatus === "failed" && <button disabled={busy} onClick={() => void act(() => post("/api/gateway/verify", { id: m.id }))}>重试</button>}
        </div>)}
      </div>
    </section>
  </>;
}
