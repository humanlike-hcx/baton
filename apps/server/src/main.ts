import { DEFAULT_PORT, HOST, startServer } from "./serve.ts";
import { AppState } from "./state.ts";

const PORT = Number(process.env.BATON_PORT ?? DEFAULT_PORT);

const state = new AppState({ baseUrl: `http://${HOST}:${PORT}` });
await state.init();

const server = await startServer(state, PORT).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") console.error(`[baton] port ${PORT} is already in use — is another Baton (web or desktop) running?`);
  else console.error(error);
  process.exit(1);
});
console.log(`[baton] API listening on ${server.url}`);
console.log(`[baton] workspace: ${state.ws.root}${state.demo ? " (demo)" : ""}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
