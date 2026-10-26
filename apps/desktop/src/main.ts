import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import type { RunningServer } from "@baton/server/serve";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(process.env.BATON_HOME ?? path.join(os.homedir(), ".baton"), "desktop.log");

function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : String(p))).join(" ")}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line);
  } catch {
    // logging must never take the app down
  }
}

/** Apps opened from Finder get launchd's minimal PATH, which has neither the Cursor CLI nor git. */
function adoptLoginShellPath(): void {
  const dirs = new Set<string>();
  try {
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "__BATON_PATH__%s" "$PATH"'], { encoding: "utf8", timeout: 5000 });
    for (const dir of out.split("__BATON_PATH__").pop()!.trim().split(":")) if (dir) dirs.add(dir);
  } catch (error) {
    log("could not read the login shell PATH:", error);
  }
  const home = os.homedir();
  for (const dir of [...(process.env.PATH ?? "").split(":"), path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    if (dir) dirs.add(dir);
  }
  process.env.PATH = [...dirs].join(":");
}

function openOutside(url: string): void {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

let server: RunningServer | undefined;
let window: BrowserWindow | undefined;
let stopping = false;

function createWindow(url: string): void {
  window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 380,
    minHeight: 520,
    title: "Baton",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.once("ready-to-show", () => window?.show());
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openOutside(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin === new URL(url).origin) return;
    event.preventDefault();
    openOutside(target);
  });
  window.on("closed", () => {
    window = undefined;
  });
  void window.loadURL(url);
}

async function start(): Promise<void> {
  adoptLoginShellPath();
  process.env.NODE_ENV = "production";
  process.env.BATON_RESOURCES ??= path.join(here, "resources");
  // state.ts reads BATON_RESOURCES when it loads, so the server bundle is only imported after it is set.
  const { AppState, DEFAULT_PORT, HOST, startServer } = (await import(pathToFileURL(path.join(here, "server.mjs")).href)) as typeof import("./server.ts");
  const port = Number(process.env.BATON_PORT ?? DEFAULT_PORT);
  const state = new AppState({ baseUrl: `http://${HOST}:${port}` });
  await state.init();
  try {
    server = await startServer(state, port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      dialog.showErrorBox("Baton 已经在运行", `端口 ${port} 已被占用，可能是网页版（pnpm dev / pnpm start）或另一个 Baton 还开着。先关掉它，再打开桌面版。`);
      app.exit(1);
      return;
    }
    throw error;
  }
  log(`service listening on ${server.url}, workspace ${state.ws.root}, PATH ${process.env.PATH}`);
  createWindow(server.url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("Baton");
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  // Closing the window ends Baton — on macOS too — so the service never lingers in the background.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!server) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    log("stopping service");
    void server
      .close()
      .catch((error) => log("error while stopping:", error))
      .finally(() => app.exit(0));
  });
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
    try {
      await start();
    } catch (error) {
      log("failed to start:", error);
      dialog.showErrorBox("Baton 启动失败", `${error instanceof Error ? error.message : String(error)}\n\n详细日志：${LOG}`);
      app.exit(1);
    }
  });
}
