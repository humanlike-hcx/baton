import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { ChatGptMethod } from "./types.ts";
import { readJson, writeFileAtomic } from "./util.ts";

export function batonHome(): string {
  return process.env.BATON_HOME ?? path.join(os.homedir(), ".baton");
}

/** Keep a local data file private even on Windows, where chmod does not change the ACL. */
function restrictFile(file: string): void {
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    return;
  }
  const user = os.userInfo().username;
  const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  const result = spawnSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `${principal}:(F)`], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`无法限制凭据文件权限：${(result.stderr || result.stdout || "icacls 失败").trim()}`);
  }
}

/**
 * Credentials live in ~/.baton/credentials.json (mode 0600). They never reach the
 * browser, tools, or shell environments.
 */
export class FileCredentialStore implements CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;

  constructor(home = batonHome()) {
    this.file = path.join(home, "credentials.json");
    if (fs.existsSync(this.file)) restrictFile(this.file);
  }

  private load(): Record<string, Credential> {
    return readJson<Record<string, Credential>>(this.file, {});
  }

  private save(data: Record<string, Credential>): void {
    writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
    restrictFile(this.file);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  /** Called after a credential is saved. Used to mirror a refreshed Codex token back to Codex CLI. */
  onSaved?: (providerId: string, previous: Credential | undefined, next: Credential) => void;

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.serial(async () => {
      const data = this.load();
      const previous = data[providerId];
      const next = await fn(previous);
      if (next) {
        data[providerId] = next;
        this.save(data);
        this.onSaved?.(providerId, previous, next);
      }
      return data[providerId];
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serial(async () => {
      const data = this.load();
      delete data[providerId];
      this.save(data);
    });
  }
}

/**
 * Pi provider behind each ChatGPT sign-in method. Agent cards always name "openai";
 * runs use whichever method is signed in, preferring Sign in with ChatGPT.
 */
export const CHATGPT_PROVIDERS: Record<ChatGptMethod, string> = { chatgpt: "openai", codex: "openai-codex" };

export async function chatgptMethod(credentials: CredentialStore): Promise<ChatGptMethod | undefined> {
  for (const method of ["chatgpt", "codex"] as const) {
    if ((await credentials.read(CHATGPT_PROVIDERS[method]))?.type === "oauth") return method;
  }
  return undefined;
}

/** Codex CLI's ChatGPT login. The ChatGPT desktop app does not write this file. */
export function defaultCodexAuthFile(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return json && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Codex CLI login, in Pi's oauth shape, when `file` is a ChatGPT-account login
 * (`auth_mode` absent or `"chatgpt"`, with an access token and a refresh token).
 * An API-key Codex file is not a subscription and is ignored.
 */
export function readCodexCredential(file: string): Extract<Credential, { type: "oauth" }> | undefined {
  const doc = readJson<Record<string, unknown> | undefined>(file, undefined);
  if (!doc || (doc.auth_mode !== undefined && doc.auth_mode !== "chatgpt")) return undefined;
  const tokens = doc.tokens;
  if (!tokens || typeof tokens !== "object") return undefined;
  const access = (tokens as { access_token?: unknown }).access_token;
  const refresh = (tokens as { refresh_token?: unknown }).refresh_token;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) return undefined;
  const fromFile = (tokens as { account_id?: unknown }).account_id;
  const claim = jwtPayload(access)?.[OPENAI_AUTH_CLAIM];
  const fromJwt = claim && typeof claim === "object" ? (claim as { chatgpt_account_id?: unknown }).chatgpt_account_id : undefined;
  const accountId = typeof fromFile === "string" && fromFile ? fromFile : typeof fromJwt === "string" ? fromJwt : undefined;
  const exp = jwtPayload(access)?.exp;
  return {
    type: "oauth",
    access,
    refresh,
    expires: typeof exp === "number" ? exp * 1000 : 0,
    ...(accountId ? { accountId } : {}),
  };
}

/** Copies a Codex CLI login into Baton when Baton has no ChatGPT login of its own. */
export async function importCodexLogin(credentials: CredentialStore, file: string): Promise<boolean> {
  if (await chatgptMethod(credentials)) return false;
  const credential = readCodexCredential(file);
  if (!credential) return false;
  await credentials.modify(CHATGPT_PROVIDERS.codex, async () => credential);
  return true;
}

/**
 * After Baton refreshes a token it imported, write the new access and refresh tokens back
 * so Codex CLI is not left holding a refresh token the server has already rotated.
 * Does nothing when the file's refresh token is no longer the one that was refreshed.
 */
export function writeCodexRefresh(file: string, previousRefresh: string, next: { access: string; refresh: string; accountId?: string }): void {
  const doc = readJson<Record<string, unknown> | undefined>(file, undefined);
  const tokens = doc?.tokens;
  if (!doc || !tokens || typeof tokens !== "object") return;
  const current = tokens as { refresh_token?: unknown; access_token?: string; account_id?: string };
  if (current.refresh_token !== previousRefresh) return;
  current.access_token = next.access;
  current.refresh_token = next.refresh;
  if (next.accountId) current.account_id = next.accountId;
  doc.last_refresh = new Date().toISOString();
  writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
  restrictFile(file);
}

/** Stable per-installation UUID; Sign in with ChatGPT requires one. */
export function deviceId(home = batonHome()): string {
  const file = path.join(home, "device.json");
  const saved = readJson<{ id?: string }>(file, {});
  if (saved.id) return saved.id;
  const id = randomUUID();
  writeFileAtomic(file, `${JSON.stringify({ id }, null, 2)}\n`, 0o600);
  restrictFile(file);
  return id;
}
