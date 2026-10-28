import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let stopping = false;

function startPackage(name) {
  const args = ["--filter", name, "dev"];
  const options = {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
  };
  return process.platform === "win32"
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], options)
    : spawn("pnpm", args, options);
}

function terminate(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) terminate(child);
  setTimeout(() => process.exit(code), 300);
}

for (const name of ["@baton/server", "@baton/web"]) {
  const child = startPackage(name);
  children.push(child);
  child.on("error", (error) => {
    console.error(`[baton dev] ${name}: ${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[baton dev] ${name} exited (${code ?? signal ?? "unknown"})`);
    shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
