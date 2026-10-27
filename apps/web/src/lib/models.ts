import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { costLabel } from "./format";
import { useBaton } from "./store";
import type { ChatModel, ModelOption, ModelRoute, Thread } from "./types";

export type ModelRef = Pick<ChatModel, "source" | "model" | "provider" | "thinking" | "fast">;

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

/** Same account, model, thinking level and fast tier. */
export function sameChoice(a?: ModelRef, b?: ModelRef): boolean {
  return sameModel(a, b) && (a?.thinking ?? "") === (b?.thinking ?? "") && Boolean(a?.fast) === Boolean(b?.fast);
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
export function pickBody(model: ModelRef): Record<string, string | boolean> {
  return { source: model.source, model: model.model, ...(model.provider ? { provider: model.provider } : {}), ...(model.thinking ? { thinking: model.thinking } : {}), ...(model.fast ? { fast: true } : {}) };
}

/** One row of the picker: a model, or for Cursor every variant of one base model. */
export interface ModelEntry {
  key: string;
  route: ModelRoute;
  name: string;
  family: string;
  options: ModelOption[];
}

export function routeEntries(route: ModelRoute): ModelEntry[] {
  const entries = new Map<string, ModelEntry>();
  for (const m of route.models) {
    const base = m.variant?.base ?? m.id;
    const name = m.variant?.baseName ?? m.name;
    const entry = entries.get(base);
    if (entry) {
      entry.options.push(m);
      if (name.length < entry.name.length) entry.name = name;
    } else {
      entries.set(base, { key: `${routeKey(route)}:${base}`, route, name, family: m.family, options: [m] });
    }
  }
  return [...entries.values()];
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_EFFORT = [undefined, "medium", "high", "low", "xhigh", "max", "minimal"];

export function effortRank(effort: string | undefined): number {
  return effort ? EFFORT_ORDER.indexOf(effort) : -1;
}

/** The variant to start a Cursor model on: like `like` where it can be, otherwise not fast, not thinking, a middle effort. */
export function pickVariant(options: ModelOption[], like?: Partial<Pick<NonNullable<ModelOption["variant"]>, "effort" | "reasoning" | "fast">>): ModelOption {
  const score = (m: ModelOption) => {
    const v = m.variant;
    if (!v) return 0;
    const effort = like?.effort !== undefined ? Math.abs(effortRank(v.effort) - effortRank(like.effort)) : DEFAULT_EFFORT.indexOf(v.effort);
    return (v.fast === (like?.fast ?? false) ? 0 : 100) + (v.reasoning === (like?.reasoning ?? false) ? 0 : 50) + effort;
  };
  return [...options].sort((a, b) => score(a) - score(b))[0]!;
}

/** The entry a chosen model belongs to. */
export function entryOf(routes: ModelRoute[] | undefined, ref: ModelRef | undefined): { entry: ModelEntry; option: ModelOption } | undefined {
  const found = findModel(routes, ref);
  if (!found) return undefined;
  const entry = routeEntries(found.route).find((e) => e.options.includes(found.option));
  return entry ? { entry, option: found.option } : undefined;
}

/** The context ring's numbers: the last reply on this model, or this model's window before it has replied. */
export function chatContext(model: ModelRef | undefined, option: ModelOption | undefined, thread?: Thread): { used?: number; window?: number; unknown?: string } {
  if (model?.source === "cursor") return { unknown: "Cursor 不报告上下文用量，这里没法显示。" };
  const last = thread ? [...thread.runs].reverse().find((r) => r.role === "chat" && r.context) : undefined;
  if (last?.context && model && last.model === model.model && (last.provider ?? "") === (model.provider ?? "")) return { used: last.context.tokens, window: last.context.window };
  if (option?.contextWindow) return { window: option.contextWindow };
  return { unknown: model ? "这个模型没有提供上下文窗口大小。" : "还没选模型。" };
}

/** What a chat has cost: key accounts in yuan, subscriptions already paid for. */
export function chatCost(thread: Thread | undefined, model: ModelRef | undefined): string | undefined {
  const runs = thread?.runs ?? [];
  const keyRuns = runs.filter((r) => r.source === "key");
  if (keyRuns.length) return costLabel("key", keyRuns.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0));
  if (runs.length) return runs.every((r) => r.source === "demo") ? "免费" : "订阅内";
  if (!model) return undefined;
  return model.source === "key" ? "按量计费" : costLabel(model.source, 0);
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
    localStorage.setItem(LAST_MODEL, JSON.stringify({ source: model.source, model: model.model, provider: model.provider, thinking: model.thinking, fast: model.fast }));
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
