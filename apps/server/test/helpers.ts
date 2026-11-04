import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { AppState } from "../src/state.ts";
import { createApp } from "../src/app.ts";
export { fauxAssistantMessage as answer, fauxToolCall as call };
export async function fixture(steps: FauxResponseStep[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-v2-test-")), home = path.join(root, "data"), projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(home, "v2"), { recursive: true }); fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(home, "v2/gateway.json"), JSON.stringify({ url: "http://127.0.0.1:1/v1", token: "", models: ["a", "b"].map(id => ({ id, name: id, api: "openai-completions", verified: true, thinking: [], contextWindow: 32768 })) }));
  const faux = fauxProvider({ provider: "baton-magpie", models: ["a", "b"].map(id => ({ id, contextWindow: 32768, maxTokens: 4096 })), tokensPerSecond: 100000 });
  faux.setResponses(steps);
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} } });
  runtime.registerNativeProvider(faux.provider);
  const makeState = () => new AppState({ home, runtime: async () => runtime, approvalTimeoutMs: 5000 });
  let state = makeState(); await state.init(); let app = createApp(state);
  const request = async (url: string, method = "GET", body?: unknown, extraHeaders = {}) => {
    const response = await app.request(`http://127.0.0.1${url}`, { method, headers: { host: "127.0.0.1", "x-baton": "1", "content-type": "application/json", ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  const p = await request("/api/projects", "POST", { path: projectRoot });
  const t = await request("/api/threads", "POST", { projectId: p.data.id, model: { id: "a" } });
  return { root, home, projectRoot, project: p.data, thread: t.data, faux, request, get state() { return state; }, async restart() { await state.stopAll(); state = makeState(); await state.init(); app = createApp(state); }, async close() { await state.stopAll(); fs.rmSync(root, { recursive: true, force: true }); } };
}
export async function until(fn: () => unknown, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error("condition timed out"); }
