import type { IncomingMessage } from "node:http";
import { serve, type ServerType } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { allowWebSocket, createApp } from "./app.ts";
import type { AppState } from "./state.ts";

export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 47321;

export interface RunningServer {
  url: string;
  /** Cancels runs in progress, saves every thread, and stops listening. */
  close(): Promise<void>;
}

/**
 * Serves the HTTP API, the WebSocket events and (in production) the web app on 127.0.0.1.
 * The web version (`pnpm start` / `pnpm dev`) and the desktop app both start Baton through here.
 * Rejects with code `EADDRINUSE` when another Baton (or anything else) already holds the port.
 */
export function startServer(state: AppState, port = DEFAULT_PORT): Promise<RunningServer> {
  const app = createApp(state);
  const wss = new WebSocketServer({ noServer: true });
  return new Promise((resolve, reject) => {
    let server: ServerType;
    const onError = (error: Error) => reject(error);
    server = serve({ fetch: app.fetch, hostname: HOST, port }, (info) => {
      server.off("error", onError);
      resolve({
        url: `http://${HOST}:${info.port}`,
        async close() {
          await state.orchestrator.stopAll();
          for (const client of wss.clients) client.terminate();
          wss.close();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
    server.once("error", onError);
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
  });
}
