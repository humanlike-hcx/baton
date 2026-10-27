import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { ChatGptMethod } from "./types.ts";
import { readJson, writeFileAtomic } from "./util.ts";

export function batonHome(): string {
  return process.env.BATON_HOME ?? path.join(os.homedir(), ".baton");
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
  }

  private load(): Record<string, Credential> {
    return readJson<Record<string, Credential>>(this.file, {});
  }

  private save(data: Record<string, Credential>): void {
    writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
    fs.chmodSync(this.file, 0o600);
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

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.serial(async () => {
      const data = this.load();
      const next = await fn(data[providerId]);
      if (next) {
        data[providerId] = next;
        this.save(data);
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

/** Stable per-installation UUID; Sign in with ChatGPT requires one. */
export function deviceId(home = batonHome()): string {
  const file = path.join(home, "device.json");
  const saved = readJson<{ id?: string }>(file, {});
  if (saved.id) return saved.id;
  const id = randomUUID();
  writeFileAtomic(file, `${JSON.stringify({ id }, null, 2)}\n`, 0o600);
  return id;
}
