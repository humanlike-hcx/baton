import type { IncomingMessage } from "node:http";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { allowWebSocket, createApp } from "./app.ts";
import { AppState } from "./state.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.BATON_PORT ?? 47321);

const state = new AppState({ baseUrl: `http://${HOST}:${PORT}` });
await state.init();
const app = createApp(state);

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[baton] API listening on http://${HOST}:${info.port}`);
  console.log(`[baton] workspace: ${state.ws.root}${state.demo ? " (demo)" : ""}`);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req: IncomingMessage, socket, head) => {
  if (!allowWebSocket({ url: req.url, host: req.headers.host, origin: req.headers.origin })) {
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
