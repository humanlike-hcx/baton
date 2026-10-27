import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { useBaton } from "./store";
import type { ChatModel, ModelOption, ModelRoute } from "./types";

export type ModelRef = Pick<ChatModel, "source" | "model" | "provider" | "thinking">;

interface Snapshot {
  key?: string;
  routes?: ModelRoute[];
  error?: string;
  loading: boolean;
}

let snapshot: Snapshot = { loading: false };
const listeners = new Set<() => void>();
const set = (next: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) l();
};

async function load(key: string, refresh: boolean) {
  set({ key, loading: true, error: undefined, ...(snapshot.key === key ? {} : { routes: undefined }) });
  try {
    const { routes } = await api<{ routes: ModelRoute[] }>(`/api/models${refresh ? "?refresh=1" : ""}`);
    if (snapshot.key === key) set({ routes, loading: false });
  } catch (e) {
    if (snapshot.key === key) set({ error: (e as Error).message, loading: false });
  }
}

/** Every account route and its models, shared across the app and reloaded when sign-in state, key accounts or the project change. */
export function useModels() {
  const { state } = useBaton();
  const key = state
    ? [
        state.workspace.root,
        state.auth.chatgpt.loggedIn,
        state.auth.chatgpt.method,
        state.auth.cursor.loggedIn,
        state.settings.cursor.command,
        state.auth.keys.map((k) => `${k.provider}:${k.configured}`).join(","),
      ].join("|")
    : undefined;
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
  useEffect(() => {
    if (key && snapshot.key !== key) void load(key, false);
  }, [key]);
  const refresh = useCallback(() => (key ? load(key, true) : Promise.resolve()), [key]);
  const current = snap.key === key;
  return { routes: current ? snap.routes : undefined, error: current ? snap.error : undefined, loading: snap.loading, refresh };
}

/** One route per subscription, one per key account. */
export function routeKey(route: Pick<ModelRoute, "source" | "provider">): string {
  return route.provider ? `${route.source}:${route.provider}` : route.source;
}

export interface ModelPick {
  route: ModelRoute;
  option: ModelOption;
}

export function findModel(routes: ModelRoute[] | undefined, ref: ModelRef | undefined): ModelPick | undefined {
  if (!routes || !ref) return undefined;
  const route = routes.find((r) => r.source === ref.source && (r.source !== "key" || r.provider === ref.provider));
  const option = route?.models.find((m) => m.id === ref.model);
  return route && option ? { route, option } : undefined;
}

/** Same account and model; the thinking level may differ. */
export function sameModel(a?: ModelRef, b?: ModelRef): boolean {
  return Boolean(a && b && a.source === b.source && a.model === b.model && (a.provider ?? "") === (b.provider ?? ""));
}

export function toChatModel(p: ModelPick): ChatModel {
  return {
    source: p.route.source,
    model: p.option.id,
    name: p.option.name,
    ...(p.route.source === "key" ? { provider: p.route.provider, account: p.route.label } : {}),
  };
}

/** What a model pick sends to the server. */
export function pickBody(model: ModelRef): Record<string, string> {
  return { source: model.source, model: model.model, ...(model.provider ? { provider: model.provider } : {}), ...(model.thinking ? { thinking: model.thinking } : {}) };
}

/** Usable models in route order; the demo route first in the demo workspace. */
export function usableModels(routes: ModelRoute[] | undefined, demo: boolean): ModelPick[] {
  const ordered = [...(routes ?? [])].sort((a, b) => (demo ? Number(b.source === "demo") - Number(a.source === "demo") : 0));
  return ordered.filter((r) => !r.unavailable).flatMap((route) => route.models.map((option) => ({ route, option })));
}

/** The server's unavailable reason without its pointer to the 「模型」 page, for places that link there themselves. */
export function shortReason(reason: string): string {
  return reason.replace(/，请到「模型」页.*$/, "");
}

const LAST_MODEL = "baton.lastModel";

export function rememberModel(model: ChatModel): void {
  try {
    localStorage.setItem(LAST_MODEL, JSON.stringify({ source: model.source, model: model.model, provider: model.provider, thinking: model.thinking }));
  } catch {
    /* storage unavailable */
  }
}

export function lastModel(): ModelRef | undefined {
  try {
    const raw = localStorage.getItem(LAST_MODEL);
    return raw ? (JSON.parse(raw) as ModelRef) : undefined;
  } catch {
    return undefined;
  }
}
