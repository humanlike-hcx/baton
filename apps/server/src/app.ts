import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  CHAT_ACCESS,
  CONTEXT_MAX_BYTES,
  KEY_TEMPLATES,
  ROUTES,
  cursorVariant,
  supportsFastTier,
  listLessons,
  listMemory,
  modelFamily,
  recordLesson,
  remember,
  runChecks,
  updateLesson,
  updateMemory,
  type ChatAccess,
  type ChatGptMethod,
  type CredentialSource,
  type Role,
  type Thread,
  type WorkspaceSettings,
} from "@baton/core";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { MOCK_CURSOR, REPO_ROOT, WEB_DIST, nodeScriptCommand, type AddKeyInput, type AppState, type ModelPickInput, type Session } from "./state.ts";

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
  return { id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt, runs: t.runs.length, model: t.model };
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
      projects: state.projects().map((s) => ({ root: s.ws.root, name: s.ws.settings().name, demo: s.demo, threads: s.orchestrator.listThreads().map(threadSummary) })),
      auth: state.authStatus(),
      settings: ws.settings(),
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
    await state.refreshAuth();
    return c.json({ ok: true });
  });
  app.post("/api/workspace/pick", async (c) => {
    try {
      const picked = await state.pickDirectory();
      return c.json(picked ? { path: picked } : { cancelled: true });
    } catch (error) {
      bad((error as Error).message);
    }
  });
  app.post("/api/workspace/close", async (c) => {
    const { path: root } = await body<{ path: string }>(c);
    try {
      state.closeWorkspace(root ?? "");
    } catch (error) {
      bad((error as Error).message);
    }
    return c.json({ ok: true });
  });

  app.get("/api/settings", (c) => c.json(state.ws.settings()));
  app.put("/api/settings", async (c) => {
    const next = await body<WorkspaceSettings>(c);
    const current = state.ws.settings();
    const merged: WorkspaceSettings = {
      version: 1,
      name: next.name ?? current.name,
      checks: next.checks ?? current.checks,
      permissions: { ...current.permissions, ...next.permissions },
      memory: { ...current.memory, ...next.memory },
      budgets: { ...current.budgets, ...next.budgets },
      approvalTimeoutSec: next.approvalTimeoutSec ?? current.approvalTimeoutSec,
      cursor: { ...current.cursor, ...next.cursor },
    };
    if (!Array.isArray(merged.checks) || merged.checks.some((ch) => !ch.name?.trim() || typeof ch.command !== "string")) bad("检查命令需要名字和命令");
    if (!(merged.budgets.briefing >= 2048)) bad("启动上下文预算不能小于 2KB");
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

  // ---------- models ----------

  /** Every route with its sign-in state and models: the subscriptions, one route per API key account, and the demo only in the demo workspace. */
  app.get("/api/models", async (c) => {
    const force = c.req.query("refresh") === "1";
    const routes: { source: CredentialSource; provider?: string; template?: string }[] = [
      { source: "chatgpt" },
      { source: "cursor" },
      ...state.listKeyAccounts().map((a) => ({ source: "key" as const, provider: a.provider, template: a.template })),
      ...(state.demo ? [{ source: "demo" as const }] : []),
    ];
    const listed = await Promise.all(
      routes.map(async (route) => {
        const { models, error } = await state.models(route.source, force, undefined, route.provider).catch((e: Error) => ({ models: [], error: e.message }));
        const provider = route.provider ?? ROUTES[route.source].provider;
        return {
          ...route,
          label: route.provider ? (state.keyAccount(route.provider)?.label ?? ROUTES.key.label) : ROUTES[route.source].label,
          unavailable: state.unavailable(route.source, undefined, route.provider),
          error,
          models: models.map((m) => ({
            ...m,
            family: modelFamily(m.id, provider),
            ...(route.source === "cursor" ? { variant: cursorVariant(m.id, m.name) } : {}),
            ...(supportsFastTier(m.id) && (route.source === "chatgpt" || route.template === "openai") ? { fastMode: true } : {}),
          })),
        };
      }),
    );
    return c.json({ routes: listed });
  });
  app.get("/api/briefing", async (c) => {
    const role = (c.req.query("role") ?? "chat") as Role;
    if (role !== "chat" && role !== "review") bad("role 只能是 chat 或 review");
    const threadId = c.req.query("thread") || undefined;
    const session = (threadId && state.sessionOfThread(threadId)) || state.sessionByRoot(state.ws.root)!;
    const pick = { source: c.req.query("source"), model: c.req.query("model"), provider: c.req.query("provider"), thinking: c.req.query("thinking"), fast: c.req.query("fast") ?? undefined };
    const model = await state.resolveModel(pick, session).catch((e: Error) => bad(e.message));
    return c.json(await session.orchestrator.briefingPreview(model, role, threadId));
  });

  // ---------- API key accounts ----------

  app.get("/api/keys/templates", (c) =>
    c.json(KEY_TEMPLATES.map((t) => ({ id: t.id, label: t.label, hint: t.hint, baseUrl: t.baseUrl, customUrl: Boolean(t.customUrl), keyless: Boolean(t.keyless), catalog: Boolean(t.catalog) }))),
  );
  app.post("/api/keys", async (c) => {
    const input = await body<AddKeyInput>(c);
    return c.json(await state.addKey(input).catch((e: Error) => bad(e.message)));
  });
  app.delete("/api/keys/:id", async (c) => {
    await state.removeKey(c.req.param("id")).catch((e: Error) => bad(e.message));
    return c.json({ ok: true });
  });
  app.post("/api/keys/:id/refresh", async (c) => c.json({ models: await state.refreshKeyModels(c.req.param("id")).catch((e: Error) => bad(e.message)) }));

  app.get("/api/stats", (c) => c.json(state.orchestrator.stats()));

  // ---------- threads ----------
  // A chat, approval or run belongs to one project; these routes find it there, whichever project is current.

  const threadOr404 = (id: string): { session: Session; thread: Thread } => {
    const session = state.sessionOfThread(id);
    const thread = session?.orchestrator.getThread(id);
    if (!session || !thread) throw new HTTPException(404, { message: "找不到对话" });
    return { session, thread };
  };
  const sessionOfRun = (id: string): Session => {
    const session = state.sessionOfRun(id);
    if (!session) throw new HTTPException(404, { message: "找不到这次运行" });
    return session;
  };

  app.get("/api/threads", (c) => c.json(state.orchestrator.listThreads().map(threadSummary)));
  app.post("/api/threads", async (c) => {
    const input = await body<ModelPickInput & { title?: string; task?: string; workspace?: string }>(c);
    const session = input.workspace ? state.sessionByRoot(input.workspace) : state.sessionByRoot(state.ws.root);
    if (!session) bad("这个项目没有打开，请先在左边的项目列表里打开它");
    const model = await state.resolveModel(input, session).catch((e: Error) => bad(e.message));
    return c.json(session.orchestrator.createThread({ title: input.title, task: input.task ?? "", model }));
  });
  app.get("/api/threads/:id", (c) => c.json(threadOr404(c.req.param("id")).thread));
  app.delete("/api/threads/:id", (c) => {
    const { session, thread } = threadOr404(c.req.param("id"));
    try {
      session.orchestrator.deleteThread(thread.id);
    } catch (error) {
      bad((error as Error).message);
    }
    return c.json({ ok: true });
  });
  app.post("/api/threads/:id/messages", async (c) => {
    const { text, ...pick } = await body<ModelPickInput & { text: string }>(c);
    if (!text?.trim()) bad("消息不能为空");
    const { session, thread } = threadOr404(c.req.param("id"));
    const picked = pick.source || pick.model ? await state.resolveModel(pick, session).catch((e: Error) => bad(e.message)) : undefined;
    if (!picked && !thread.model) bad("请先选择一个模型");
    session.orchestrator.postMessage(thread.id, text, picked);
    return c.json({ ok: true });
  });
  app.post("/api/threads/:id/access", async (c) => {
    const { access } = await body<{ access: ChatAccess }>(c);
    if (!CHAT_ACCESS.includes(access)) bad("权限只能是 read、ask 或 allow");
    const { session, thread } = threadOr404(c.req.param("id"));
    try {
      session.orchestrator.setAccess(thread.id, access);
    } catch (error) {
      bad((error as Error).message);
    }
    return c.json({ ok: true });
  });
  app.post("/api/threads/:id/review", async (c) => {
    const pick = await body<ModelPickInput>(c);
    const { session, thread } = threadOr404(c.req.param("id"));
    const reviewer = await state.resolveModel(pick, session).catch((e: Error) => bad(e.message));
    try {
      session.orchestrator.checkReview(thread.id, reviewer);
    } catch (error) {
      bad((error as Error).message);
    }
    void session.orchestrator.review(thread.id, reviewer).catch((error: Error) => console.error("[baton] review failed:", error));
    return c.json({ ok: true }, 202);
  });
  app.post("/api/threads/:id/cancel", (c) => {
    const { session, thread } = threadOr404(c.req.param("id"));
    session.orchestrator.cancel(thread.id);
    return c.json({ ok: true });
  });
  app.post("/api/approvals/:id", async (c) => {
    const { allow } = await body<{ allow: boolean }>(c);
    const session = state.sessionOfApproval(c.req.param("id"));
    if (!session) bad("这个审批已经处理过或已超时");
    session.orchestrator.respondApproval(c.req.param("id"), Boolean(allow));
    return c.json({ ok: true });
  });
  app.get("/api/runs/:id/diff", async (c) => c.json({ diff: await sessionOfRun(c.req.param("id")).orchestrator.runDiff(c.req.param("id")) }));
  app.post("/api/runs/:id/rollback", async (c) => c.json({ files: await sessionOfRun(c.req.param("id")).orchestrator.rollback(c.req.param("id")) }));

  // ---------- auth ----------

  app.post("/api/auth/chatgpt/login", async (c) => {
    const { method = "chatgpt" } = await body<{ method?: ChatGptMethod }>(c);
    if (method !== "chatgpt" && method !== "codex") bad("登录方式只能是 chatgpt 或 codex");
    return c.json({ url: await state.startChatGptLogin(method) });
  });
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
    const out = await state.bridgeTool(token, tool, args ?? {});
    return c.json(out, out.isError ? 422 : 200);
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (process.env.NODE_ENV === "production" && fs.existsSync(WEB_DIST)) {
    // index.html names the hashed bundle of this build; a cached copy would run the previous build against this API.
    app.use("/*", async (c, next) => {
      await next();
      if (!c.req.path.startsWith("/assets/")) c.header("Cache-Control", "no-cache");
    });
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), WEB_DIST) }));
    app.get("*", (c) => c.html(fs.readFileSync(path.join(WEB_DIST, "index.html"), "utf8")));
  } else {
    app.get("/", (c) => c.text("Baton API is running. Open the web app (pnpm dev) at http://127.0.0.1:47320"));
  }

  return app;
}
