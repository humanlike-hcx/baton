import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import type { AppStateResponse, Thread, ThreadSummary } from "./types";

type ServerMessage =
  | { type: "hello" }
  | { type: "state" }
  | { type: "threads"; workspace: string }
  | { type: "tidy"; workspace: string }
  | { type: "thread"; thread: Thread; workspace: string }
  | { type: "delta"; threadId: string; itemId: string; delta: string; workspace: string };

function summary(t: Thread): ThreadSummary {
  return { id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt, runs: t.runs.length, model: t.model };
}

const upsert = (list: ThreadSummary[], t: ThreadSummary) => [t, ...list.filter((x) => x.id !== t.id)];

/** Folds a live chat update into the project it belongs to (and the current project's list). */
function withThread(s: AppStateResponse, thread: Thread, workspace: string): AppStateResponse {
  const t = summary(thread);
  return {
    ...s,
    projects: s.projects.map((p) => (p.root === workspace ? { ...p, threads: upsert(p.threads, t) } : p)),
    threads: workspace === s.workspace.root ? upsert(s.threads, t) : s.threads,
  };
}

type Listener = (msg: ServerMessage) => void;

interface StoreValue {
  state?: AppStateResponse;
  error?: string;
  connected: boolean;
  refresh: () => Promise<void>;
  subscribe: (listener: Listener) => () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function BatonProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppStateResponse>();
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setState(await api<AppStateResponse>("/api/state"));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh(), 150);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let closed = false;
    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${window.location.host}/ws`);
      socket.onopen = () => {
        setConnected(true);
        void refresh();
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        if (msg.type === "state" || msg.type === "threads") scheduleRefresh();
        if (msg.type === "thread") setState((s) => s && withThread(s, msg.thread, msg.workspace));
        for (const l of listeners.current) l(msg);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [refresh, scheduleRefresh]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return <StoreContext.Provider value={{ state, error, connected, refresh, subscribe }}>{children}</StoreContext.Provider>;
}

export function useBaton(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useBaton must be used inside BatonProvider");
  return value;
}

/** Loads a thread and keeps it live from WebSocket updates and streaming deltas. */
export function useThread(id: string | undefined) {
  const { subscribe } = useBaton();
  const [thread, setThread] = useState<Thread>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) {
      setThread(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    api<Thread>(`/api/threads/${id}`)
      .then((t) => !cancelled && setThread(t))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    const unsubscribe = subscribe((msg) => {
      if (msg.type === "thread" && msg.thread.id === id) setThread(msg.thread);
      if (msg.type === "delta" && msg.threadId === id) {
        setThread((t) => {
          if (!t) return t;
          const items = t.items.map((item) => (item.id === msg.itemId && item.kind === "text" ? { ...item, text: item.text + msg.delta } : item));
          if (!items.some((i) => i.id === msg.itemId)) {
            items.push({ id: msg.itemId, at: new Date().toISOString(), kind: "text", runId: "", text: msg.delta });
          }
          return { ...t, items };
        });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [id, subscribe]);

  return { thread, error, loading };
}
