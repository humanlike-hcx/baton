import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WEB_DIST, type AppState } from "./state.ts";

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
function sameOrigin(origin: string, host: string) {
  try { const u = new URL(origin); return u.protocol === "http:" && (u.host === host || u.origin === "http://127.0.0.1:47320"); } catch { return false; }
}
export function allowWebSocket(req: { url?: string; host?: string; origin?: string }) {
  return req.url === "/ws" && LOCAL.test(req.host ?? "") && (!req.origin || sameOrigin(req.origin, req.host ?? ""));
}
async function body(c: Context): Promise<any> {
  try { const value = await c.req.json(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw new Error("请求体必须是 JSON 对象"); }
}
function string(value: unknown, label: string) { if (typeof value !== "string") throw new Error(`缺少 ${label}`); return value; }
export function createApp(state: AppState) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: state.gateway.redact(e.message) }, 400));
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!LOCAL.test(host)) return c.json({ error: "拒绝非本机 Host" }, 403);
    const origin = c.req.header("origin");
    if (origin && !sameOrigin(origin, host)) return c.json({ error: "拒绝跨站请求" }, 403);
    if (c.req.path.startsWith("/api/") && c.req.method !== "GET" && c.req.header("x-baton") !== "1") return c.json({ error: "缺少 X-Baton 请求头" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.get("/api/state", c => c.json(state.view()));
  app.put("/api/gateway", async c => { const b = await body(c); return c.json(state.configureGateway({ url: string(b.url, "地址"), ...(b.token !== undefined ? { token: string(b.token, "网关凭据") } : {}) })); });
  app.post("/api/gateway/check", async c => { const result = await state.gateway.refresh(); state.broadcast(); return c.json(result); });
  app.put("/api/gateway/selection", async c => { const b = await body(c); return c.json(state.gateway.selectModels(b.ids)); });
  app.post("/api/projects", async c => { const b = await body(c); return c.json(state.openProject(string(b.path, "项目路径"))); });
  app.post("/api/projects/pick", async c => c.json({ path: await state.pickDirectory() }));
  app.delete("/api/projects/:id", c => { state.removeProject(c.req.param("id")); return c.json({ ok: true }); });
  app.post("/api/threads", async c => { const b = await body(c); return c.json(state.createThread(b.projectId == null ? undefined : string(b.projectId, "项目"), b.model)); });
  app.post("/api/threads/start", async c => { const b = await body(c); return c.json(state.startThread({ projectId: b.projectId == null ? undefined : string(b.projectId, "项目"), model: b.model, access: b.access, text: string(b.text, "消息") }), 202); });
  app.post("/api/threads/:id/archive", c => { state.archiveThread(c.req.param("id")); return c.json({ ok: true }); });
  app.post("/api/threads/:id/restore", c => c.json(state.restoreThread(c.req.param("id"))));
  app.get("/api/threads/:id", c => c.json(state.thread(c.req.param("id"))));
  app.patch("/api/threads/:id", async c => c.json(state.updateThread(c.req.param("id"), await body(c))));
  app.post("/api/threads/:id/messages", async c => { const b = await body(c); return c.json(state.send(c.req.param("id"), string(b.text, "消息")), 202); });
  app.post("/api/threads/:id/inject", async c => { const b = await body(c); await state.inject(c.req.param("id"), string(b.text, "消息"), b.mode); return c.json({ ok: true }); });
  app.post("/api/threads/:id/cancel", async c => { await state.cancel(c.req.param("id")); return c.json({ ok: true }); });
  app.post("/api/threads/:id/compact", async c => { const b = await body(c); return c.json(state.compact(c.req.param("id"), b.instructions ?? "保留任务目标、用户约束、已验证结果和下一步。"), 202); });
  app.post("/api/approvals/:id", async c => { const b = await body(c); if (typeof b.allow !== "boolean") throw new Error("审批结果必须为允许或拒绝"); state.resolveApproval(c.req.param("id"), b.allow); return c.json({ ok: true }); });
  app.get("/api/runs/:id/changes", c => c.json(state.preview(c.req.param("id"))));
  app.post("/api/runs/:id/restore", async c => { const b = await body(c); return c.json(state.restore(c.req.param("id"), string(b.token, "预览标识"))); });
  app.get("/api/projects/:id/resources", c => c.json(state.resources(c.req.param("id"))));
  app.put("/api/projects/:id/resources", async c => c.json(state.setResource(c.req.param("id"), await body(c))));
  app.put("/api/projects/:id/mcp", async c => { const b = await body(c); return c.json(state.setMcp(c.req.param("id"), b.servers)); });
  app.post("/api/threads/:id/mcp/check", c => c.json(state.inspectMcp(c.req.param("id")), 202));
  app.get("/api/projects/:id/memory", c => c.json(state.memories(c.req.param("id"))));
  app.post("/api/threads/:id/memory", async c => { const b = await body(c); if (b.content !== undefined) string(b.content, "记忆内容"); return c.json(state.changeMemory(c.req.param("id"), string(b.name, "记忆名称"), b.content), 202); });
  app.post("/api/projects/:id/import/preview", async c => { const b = await body(c); return c.json(state.importPreview(c.req.param("id"), string(b.source, "来源路径"), string(b.name, "名称"), b.kind)); });
  app.post("/api/threads/:id/import", async c => c.json(state.importMarkdown(c.req.param("id"), await body(c)), 202));
  app.all("/api/*", c => c.json({ error: "接口不存在" }, 404));
  if (process.env.NODE_ENV === "production" && fs.existsSync(path.join(WEB_DIST, "index.html"))) {
    app.use("/*", serveStatic({ root: WEB_DIST }));
    app.get("*", c => c.html(fs.readFileSync(path.join(WEB_DIST, "index.html"), "utf8")));
  }
  return app;
}
