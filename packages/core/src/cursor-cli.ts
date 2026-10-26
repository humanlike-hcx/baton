import { spawn } from "node:child_process";
import { splitCommand } from "./executors/acp.ts";
import { filterCursorModels } from "./families.ts";

function runCli(command: string, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string; missing: boolean }> {
  const { file, args: base } = splitCommand(command);
  return new Promise((resolve) => {
    const child = spawn(file, [...base, ...args], { env: { ...process.env, NO_OPEN_BROWSER: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, out: e.message, missing: e.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: stripAnsi(out), missing: false });
    });
  });
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

export interface CursorStatus {
  installed: boolean;
  loggedIn: boolean;
  account?: string;
  error?: string;
}

export async function cursorStatus(command: string): Promise<CursorStatus> {
  const r = await runCli(command, ["status"]);
  if (r.missing) return { installed: false, loggedIn: false, error: "没有找到 Cursor CLI" };
  const text = r.out;
  if (/not (logged|authenticated|signed)/i.test(text)) return { installed: true, loggedIn: false };
  const account = /([\w.+-]+@[\w-]+(\.[\w-]+)+)/.exec(text)?.[1];
  if (/logged in|authenticated|signed in/i.test(text) || account) return { installed: true, loggedIn: true, account };
  return { installed: true, loggedIn: false, error: text.trim().slice(0, 300) || undefined };
}

export interface CursorLogin {
  url: Promise<string>;
  done: Promise<boolean>;
  cancel(): void;
}

/** Runs `agent login` without opening a browser and surfaces the login URL. */
export function cursorLogin(command: string): CursorLogin {
  const { file, args } = splitCommand(command);
  const child = spawn(file, [...args, "login"], { env: { ...process.env, NO_OPEN_BROWSER: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let resolveUrl!: (u: string) => void;
  let rejectUrl!: (e: Error) => void;
  const url = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  url.catch(() => undefined);
  let out = "";
  const onData = (d: Buffer) => {
    out += stripAnsi(d.toString("utf8"));
    const match = /https:\/\/\S+/.exec(out);
    if (match) resolveUrl(match[0].replace(/[).,]+$/, ""));
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const done = new Promise<boolean>((resolve) => {
    child.on("error", (e) => {
      rejectUrl(new Error(`无法启动 Cursor CLI：${e.message}`));
      resolve(false);
    });
    child.on("close", (code) => {
      rejectUrl(new Error(out.trim().slice(-300) || "登录进程已退出"));
      resolve(code === 0);
    });
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
  void done.then(() => clearTimeout(timer));
  return { url, done, cancel: () => child.kill("SIGTERM") };
}

export interface CursorModel {
  id: string;
  name: string;
}

export function parseCursorModels(text: string): CursorModel[] {
  const models: CursorModel[] = [];
  for (const raw of stripAnsi(text).split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    const match = /^([a-z0-9][a-z0-9._-]*[a-z0-9])(?:\s+[-–—:]\s+(.+?))?(?:\s+\((current|default)\))?$/i.exec(line);
    if (!match) continue;
    const id = match[1]!;
    if (/^(available|models?|usage|tip)$/i.test(id)) continue;
    models.push({ id, name: (match[2] ?? id).replace(/\s*\((current|default)\)\s*$/i, "").trim() });
  }
  return models;
}

export async function cursorModels(command: string): Promise<{ models: CursorModel[]; error?: string }> {
  const r = await runCli(command, ["models"]);
  if (r.missing) return { models: [], error: "没有找到 Cursor CLI" };
  if (r.code !== 0) return { models: [], error: r.out.trim().slice(0, 300) };
  return { models: filterCursorModels(parseCursorModels(r.out)) };
}
