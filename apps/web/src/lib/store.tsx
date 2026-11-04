import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { AppView } from "@baton/core/types";
import { api } from "./api";
const Context = createContext<{ state?: AppView; connected: boolean; error?: string; refresh: () => Promise<void> }>({ connected: false, refresh: async () => {} });
export function BatonProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppView>(), [connected, setConnected] = useState(false), [error, setError] = useState<string>();
  const refresh = useCallback(async () => { try { setState(await api<AppView>("/api/state")); setError(undefined); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => {
    let stopped = false, socket: WebSocket, timer: ReturnType<typeof setTimeout>, update: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      socket.onopen = () => { setConnected(true); void refresh(); };
      socket.onmessage = () => { if (!update) update = setTimeout(() => { update = undefined; void refresh(); }, 80); };
      socket.onclose = () => { setConnected(false); if (!stopped) timer = setTimeout(connect, 1500); };
      socket.onerror = () => socket.close();
    };
    void refresh(); connect();
    return () => { stopped = true; clearTimeout(timer); clearTimeout(update); socket.close(); };
  }, [refresh]);
  return <Context.Provider value={{ state, connected, error, refresh }}>{children}</Context.Provider>;
}
export const useBaton = () => useContext(Context);
