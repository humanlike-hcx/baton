import type { IncomingMessage } from "node:http";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import { AppState } from "./state.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.WORKBENCH_PORT ?? 47321);
const ALLOWED_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

if (process.env.OPENAI_API_KEY) {
  // GPT is only reachable through Sign in with ChatGPT; an API key must never take precedence.
  delete process.env.OPENAI_API_KEY;
  console.log("[workbench] ignoring OPENAI_API_KEY: GPT models are only used through ChatGPT login");
}

const state = new AppState(`http://${HOST}:${PORT}`);
await state.init();
const app = createApp(state);

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[workbench] API listening on http://${HOST}:${info.port}`);
  console.log(`[workbench] workspace: ${state.ws.root}${state.demo ? " (demo)" : ""}`);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req: IncomingMessage, socket, head) => {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws" || (origin && !ALLOWED_ORIGIN.test(origin)) || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const unsubscribe = state.subscribe((message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    });
    ws.on("close", unsubscribe);
    ws.send(JSON.stringify({ type: "hello" }));
  });
});

const shutdown = () => {
  wss.close();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
