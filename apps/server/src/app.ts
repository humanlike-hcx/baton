import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  CONTEXT_MAX_BYTES,
  canWrite,
  listLessons,
  listMemory,
  normalizePermissions,
  recordLesson,
  remember,
  runChecks,
  updateLesson,
  updateMemory,
  validateAgentRoute,
  type AgentCard,
  type Role,
  type Stage,
  type Thread,
  type ThreadKind,
  type WorkspaceSettings,
} from "@baton/core";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { MOCK_CURSOR, REPO_ROOT, WEB_DIST, nodeScriptCommand, type AppState } from "./state.ts";

const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const ALLOWED_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** WebSocket upgrades: only `/ws`, a local Host, and (when the browser sends one) a local Origin. */
export function allowWebSocket(req: { url?: string; host?: string; origin?: string }): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") return false;
  if (req.origin && !ALLOWED_ORIGIN.test(req.origin)) return false;
  return ALLOWED_HOSTS.test(req.host ?? "");
}

function threadSummary(t: Thread) {
  return { id: t.id, kind: t.kind, title: t.title, stage: t.stage, status: t.status, updatedAt: t.updatedAt, pending: t.pending?.title, runs: t.runs.length };
}

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HTTPException(400, { message: "请求体不是合法 JSON" });
  }
}

function bad(message: string): never {
  throw new HTTPException(400, { message });
}

export function createApp(state: AppState): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: err.message || "服务出错" }, 500);
  });

  // DNS-rebinding and CSRF protection: only local Host headers, and a custom header on writes.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!ALLOWED_HOSTS.test(host)) return c.json({ error: "forbidden host" }, 403);
    if (c.req.path.startsWith("/api/") && c.req.method !== "GET" && c.req.header("x-baton") !== "1") {
      return c.json({ error: "缺少 X-Baton 请求头" }, 403);
    }
    await next();
  });

  // ---------- state & workspace ----------

  app.get("/api/state", async (c) => {
    await state.refreshAuth();
    const ws = state.ws;
    return c.json({
      workspace: { root: ws.root, name: ws.settings().name, demo: state.demo },
      recent: state.recent(),
      auth: state.authStatus(),
      settings: ws.settings(),
      agents: ws.listAgents().map((a) => ({ ...a, available: state.available(a), routeError: validateAgentRoute(a) })),
      threads: state.orchestrator.listThreads().map(threadSummary),
      mockCursorCommand: nodeScriptCommand(MOCK_CURSOR),
    });
  });

  app.post("/api/workspace/open", async (c) => {
    const { path: target, create } = await body<{ path: string; create?: boolean }>(c);
    if (!target?.trim()) bad("请填写目录");
    const expanded = target.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
    if (path.resolve(expanded) === REPO_ROOT) bad("不能把工作台自己的源码目录当作工作区");
    try {
      state.openWorkspace(expanded, { create });
    } catch (error) {
      bad((error as Error).message);
    }
    await state.refreshAuth(true);
    return c.json({ ok: true });
  });

  app.get("/api/settings", (c) => c.json(state.ws.settings()));
  app.put("/api/settings", async (c) => {
    const next = await body<WorkspaceSettings>(c);
    const current = state.ws.settings();
    const merged: WorkspaceSettings = {
      ...current,
      ...next,
      limits: { ...current.limits, ...next.limits },
      confirm: { ...current.confirm, ...next.confirm },
      advisor: { ...current.advisor, ...next.advisor },
      permissions: { ...current.permissions, ...next.permissions },
      memory: { ...current.memory, ...next.memory },
      budgets: { ...current.budgets, ...next.budgets },
      cursor: { ...current.cursor, ...next.cursor },
      version: 1,
    };
    if (!Array.isArray(merged.checks) || merged.checks.some((ch) => !ch.name?.trim() || typeof ch.command !== "string")) bad("检查命令需要名字和命令");
    if (merged.budgets.executor < 2048 || merged.budgets.planner < 2048) bad("注入预算不能小于 2KB");
    if (!(merged.budgets.context >= 1024 && merged.budgets.context <= CONTEXT_MAX_BYTES)) bad("房间上下文预算要在 1KB 到 8KB 之间");
    const commandChanged = merged.cursor.command !== current.cursor.command;
    state.ws.saveSettings(merged);
    if (commandChanged) await state.refreshAuth(true);
    if (merged.budgets.context < current.budgets.context) state.tidier.maybeAuto();
    state.broadcast({ type: "state" });
    return c.json(merged);
  });

  app.post("/api/checks/try", async (c) => {
    const { name, command } = await body<{ name?: string; command: string }>(c);
    const [result] = await runChecks([{ name: name ?? "试运行", command, timeoutSec: 120 }], { cwd: state.ws.root });
    return c.json(result);
  });

  // ---------- context, rules, memory, lessons ----------

  app.get("/api/context", (c) => c.json({ content: state.ws.readContext() }));
  app.put("/api/context", async (c) => {
    const { content } = await body<{ content: string }>(c);
    if (typeof content !== "string") bad("缺少 content");
    if (Buffer.byteLength(content) > CONTEXT_MAX_BYTES) bad("房间上下文超过 8KB，请把细节移进记忆");
    state.ws.writeContext(content);
    return c.json({ ok: true });
  });
  app.get("/api/context/tidy", (c) => c.json(state.tidier.status()));
  app.post("/api/context/tidy", (c) => {
    try {
      return c.json(state.tidier.start("manual"), 202);
    } catch (error) {
      bad((error as Error).message);
    }
  });
  app.post("/api/context/tidy/:id/undo", (c) => {
    try {
      return c.json(state.tidier.undo(c.req.param("id")));
    } catch (error) {
      bad((error as Error).message);
    }
  });

  app.get("/api/rules", (c) => c.json(state.ws.listRules()));
  app.put("/api/rules/:name", async (c) => {
    const { content } = await body<{ content: string }>(c);
    state.ws.writeRule(c.req.param("name"), content);
    return c.json({ ok: true });
  });

  app.get("/api/memory", (c) => c.json(listMemory(state.ws).reverse()));
  app.post("/api/memory", async (c) => {
    const input = await body<{ text: string; kind?: "fact" | "decision" | "preference"; pinned?: boolean; supersedes?: string }>(c);
    const result = remember(state.ws, { ...input, author: "user" });
    if (!result.ok) bad(result.reason);
    return c.json(result.entry);
  });
  app.patch("/api/memory/:id", async (c) => {
    const patch = await body<{ pinned?: boolean; status?: "active" | "superseded" }>(c);
    try {
      return c.json(updateMemory(state.ws, c.req.param("id"), patch));
    } catch (error) {
      bad((error as Error).message);
    }
  });

  app.get("/api/lessons", (c) => c.json(listLessons(state.ws)));
  app.post("/api/lessons", async (c) => {
    const input = await body<{ title: string; body: string }>(c);
    return c.json(recordLesson(state.ws, input));
  });
  app.patch("/api/lessons/:id", async (c) => {
    const patch = await body<{ status?: "open" | "hardened" | "closed"; hardenedBy?: string }>(c);
    return c.json(updateLesson(state.ws, c.req.param("id"), patch));
  });

  // ---------- agents ----------

  app.get("/api/agents", (c) => c.json(state.ws.listAgents()));
  app.put("/api/agents/:id", async (c) => {
    const card = await body<AgentCard>(c);
    const agent: AgentCard = { ...card, id: c.req.param("id"), permissions: normalizePermissions(card.permissions) };
    const routeError = validateAgentRoute(agent);
    if (routeError) bad(routeError);
    if (!agent.roles?.length) bad("至少选择一个角色");
    if (agent.roles.includes("advisor") && canWrite(agent.permissions)) bad("顾问必须只读：同时担任顾问的 agent 不能有写权限");
    if (agent.roles.includes("advisor") && agent.permissions.exec === "allow") bad("顾问必须只读：同时担任顾问的 agent 不能直接执行命令");
    state.ws.saveAgent(agent);
    state.broadcast({ type: "state" });
    return c.json(agent);
  });
  app.delete("/api/agents/:id", (c) => {
    state.ws.deleteAgent(c.req.param("id"));
    state.broadcast({ type: "state" });
    return c.json({ ok: true });
  });
  app.get("/api/agents/:id/briefing", async (c) => {
    const role = (c.req.query("role") ?? "implement") as Role;
    if (!["plan", "implement", "review", "advisor", "chat"].includes(role)) bad("role 不合法");
    return c.json(await state.orchestrator.briefingPreview(c.req.param("id"), role, c.req.query("thread") || undefined));
  });

  app.get("/api/models", async (c) => {
    const force = c.req.query("refresh") === "1";
    const [chatgpt, deepseek, cursor] = await Promise.all([state.listPiModels("openai"), state.listPiModels("deepseek"), state.listCursorModels(force)]);
    return c.json({ chatgpt, deepseek, cursor: cursor.models, cursorError: cursor.error });
  });

  app.get("/api/stats", (c) => c.json(state.orchestrator.stats()));

  // ---------- threads ----------

  app.get("/api/threads", (c) => c.json(state.orchestrator.listThreads().map(threadSummary)));
  app.post("/api/threads", async (c) => {
    const input = await body<{ kind?: ThreadKind; title?: string; task?: string; acceptance?: string[]; stage?: Stage; agentId?: string }>(c);
    if (input.kind && !["relay", "chat"].includes(input.kind)) bad("线程类型只能是 relay 或 chat");
    if (input.kind === "chat") {
      if (!input.agentId || !state.ws.getAgent(input.agentId)) bad("请选择一个 agent");
      return c.json(state.orchestrator.createThread({ kind: "chat", title: input.title ?? "", task: input.task ?? "", acceptance: [], agentId: input.agentId }));
    }
    if (input.stage && !["plan", "implement", "review"].includes(input.stage)) bad("起始阶段不合法");
    if (!input.title?.trim()) bad("请填写标题");
    if (!input.acceptance?.some((a) => a.trim())) bad("至少需要一条验收标准");
    const thread = state.orchestrator.createThread({ ...input, kind: "relay", title: input.title, task: input.task ?? "", acceptance: input.acceptance });
    return c.json(thread);
  });
  app.get("/api/threads/:id", (c) => {
    const thread = state.orchestrator.getThread(c.req.param("id"));
    if (!thread) throw new HTTPException(404, { message: "找不到线程" });
    return c.json(thread);
  });
  app.delete("/api/threads/:id", (c) => {
    try {
      state.orchestrator.deleteThread(c.req.param("id"));
    } catch (error) {
      bad((error as Error).message);
    }
    return c.json({ ok: true });
  });
  app.post("/api/threads/:id/messages", async (c) => {
    const { text, agentId } = await body<{ text: string; agentId?: string }>(c);
    if (!text?.trim()) bad("消息不能为空");
    const thread = state.orchestrator.getThread(c.req.param("id"));
    if (!thread) throw new HTTPException(404, { message: "找不到线程" });
    if (agentId && thread.kind !== "chat") bad("接力线程由工作台按规则挑选 agent，不能指定回复的 agent");
    if (agentId && !state.ws.getAgent(agentId)) bad(`找不到 agent ${agentId}`);
    state.orchestrator.postMessage(thread.id, text, agentId);
    return c.json({ ok: true });
  });
  app.post("/api/threads/:id/write", async (c) => {
    const { allow } = await body<{ allow: boolean }>(c);
    const thread = state.orchestrator.getThread(c.req.param("id"));
    if (!thread) throw new HTTPException(404, { message: "找不到线程" });
    if (thread.kind !== "chat") bad("只有对话线程可以临时开放写权限");
    try {
      state.orchestrator.setChatWrite(thread.id, Boolean(allow));
    } catch (error) {
      bad((error as Error).message);
    }
    return c.json({ ok: true });
  });
  const threadOr404 = (id: string) => {
    const thread = state.orchestrator.getThread(id);
    if (!thread) throw new HTTPException(404, { message: "找不到线程" });
    return thread;
  };
  app.post("/api/threads/:id/promote", async (c) => {
    const thread = threadOr404(c.req.param("id"));
    const { agentId } = await body<{ agentId?: string }>(c);
    try {
      state.orchestrator.promoteChat(thread.id, agentId);
    } catch (error) {
      bad((error as Error).message);
    }
    return c.json({ ok: true }, 202);
  });
  app.post("/api/threads/:id/promote/confirm", async (c) => {
    const thread = threadOr404(c.req.param("id"));
    const draft = await body<{ title?: string; task?: string; acceptance?: string[]; stage?: Stage }>(c);
    if (draft.stage && !["plan", "implement", "review"].includes(draft.stage)) bad("起始阶段不合法");
    try {
      return c.json(state.orchestrator.confirmPromotion(thread.id, { title: draft.title ?? "", task: draft.task ?? "", acceptance: Array.isArray(draft.acceptance) ? draft.acceptance : [], stage: draft.stage }), 201);
    } catch (error) {
      bad((error as Error).message);
    }
  });
  app.delete("/api/threads/:id/promote", (c) => {
    const thread = threadOr404(c.req.param("id"));
    try {
      state.orchestrator.discardPromotion(thread.id);
    } catch (error) {
      bad((error as Error).message);
    }
    return c.json({ ok: true });
  });
  app.post("/api/threads/:id/decisions/:decisionId", async (c) => {
    const input = await body<{ approve: boolean; agentId?: string }>(c);
    await state.orchestrator.decide(c.req.param("id"), c.req.param("decisionId"), input).catch((e: Error) => bad(e.message));
    return c.json({ ok: true });
  });
  app.post("/api/threads/:id/cancel", (c) => {
    state.orchestrator.cancel(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/approvals/:id", async (c) => {
    const { allow } = await body<{ allow: boolean }>(c);
    try {
      state.orchestrator.respondApproval(c.req.param("id"), Boolean(allow));
    } catch (error) {
      bad((error as Error).message);
    }
    return c.json({ ok: true });
  });
  app.get("/api/runs/:id/diff", async (c) => c.json({ diff: await state.orchestrator.runDiff(c.req.param("id")) }));
  app.post("/api/runs/:id/rollback", async (c) => c.json({ files: await state.orchestrator.rollback(c.req.param("id")) }));

  // ---------- auth ----------

  app.post("/api/auth/chatgpt/login", async (c) => c.json({ url: await state.startChatGptLogin() }));
  app.post("/api/auth/chatgpt/manual", async (c) => {
    const { input } = await body<{ input: string }>(c);
    state.submitChatGptManual(input);
    return c.json({ ok: true });
  });
  app.post("/api/auth/chatgpt/cancel", (c) => {
    state.cancelChatGptLogin();
    return c.json({ ok: true });
  });
  app.post("/api/auth/chatgpt/logout", async (c) => {
    await state.logoutChatGpt();
    return c.json({ ok: true });
  });
  app.post("/api/auth/deepseek", async (c) => {
    const { key } = await body<{ key: string }>(c);
    await state.setDeepSeekKey(key ?? "").catch((e: Error) => bad(e.message));
    return c.json({ ok: true });
  });
  app.delete("/api/auth/deepseek", async (c) => {
    await state.clearDeepSeekKey();
    return c.json({ ok: true });
  });
  app.post("/api/auth/cursor/refresh", async (c) => {
    await state.refreshAuth(true);
    return c.json(state.authStatus().cursor);
  });
  app.post("/api/auth/cursor/login", async (c) => c.json({ url: await state.startCursorLogin() }));

  // ---------- MCP / baton bridge ----------

  app.post("/api/bridge/tool", async (c) => {
    const { tool, args } = await body<{ tool: string; args?: unknown }>(c);
    const token = c.req.header("x-baton-token") || undefined;
    const out = await state.orchestrator.bridgeTool(token, tool, args ?? {});
    return c.json(out, out.isError ? 422 : 200);
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (process.env.NODE_ENV === "production" && fs.existsSync(WEB_DIST)) {
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), WEB_DIST) }));
    app.get("*", (c) => c.html(fs.readFileSync(path.join(WEB_DIST, "index.html"), "utf8")));
  } else {
    app.get("/", (c) => c.text("Baton API is running. Open the web app (pnpm dev) at http://127.0.0.1:47320"));
  }

  return app;
}
