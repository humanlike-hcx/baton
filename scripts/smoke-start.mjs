import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-smoke-"));
const mode = process.argv[2] === "dev" ? "dev" : "start";
const label = mode === "dev" ? "development" : "production";
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

const options = {
  cwd: root,
  env: { ...process.env, BATON_PORT: String(port), BATON_HOME: home, BATON_DEMO: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  detached: process.platform !== "win32",
};
const child =
  process.platform === "win32"
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${mode}`], options)
    : spawn("pnpm", [mode], options);
let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

function terminate() {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

try {
  const deadline = Date.now() + 15_000;
  let state;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} server exited with ${child.exitCode}\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        state = await response.json();
        break;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!state) throw new Error(`${label} server did not become ready\n${output}`);
  if (!state.workspace?.demo) throw new Error(`unexpected smoke workspace: ${JSON.stringify(state.workspace)}`);
  console.log(`${label} smoke passed on ${process.platform} (${port})`);
} finally {
  terminate();
  fs.rmSync(home, { recursive: true, force: true });
}
