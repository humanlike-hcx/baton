import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  return `${prefix}_${time}${randomBytes(3).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Rough token estimate: ~4 bytes per token for ASCII, ~1.5 chars per token for CJK. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[\u3400-\u9fff]/.test(ch)) cjk++;
  const rest = text.length - cjk;
  return Math.ceil(rest / 4 + cjk / 1.5);
}

export function writeFileAtomic(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

export function readText(file: string, fallback = ""): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function parseFrontmatter<T extends object>(text: string): { data: Partial<T>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  const data = (YAML.parse(match[1]!) ?? {}) as Partial<T>;
  return { data, body: match[2]!.trim() };
}

export function stringifyFrontmatter(data: object, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  return `---\n${YAML.stringify(clean).trimEnd()}\n---\n\n${body.trim()}\n`;
}

/** Keep the head and tail, cut the middle. */
export function truncateMiddle(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  const buf = Buffer.from(text, "utf8");
  const head = buf.subarray(0, half).toString("utf8").replace(/\uFFFD+$/, "");
  const tail = buf.subarray(buf.length - half).toString("utf8").replace(/^\uFFFD+/, "");
  const omitted = buf.length - 2 * half;
  return { text: `${head}\n…[省略中间 ${omitted} 字节]…\n${tail}`, truncated: true };
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "item").slice(0, max);
}

/** Character bigrams for CJK, lowercase words for everything else. */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9_.-]{2,}/g) ?? []) terms.push(word);
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) terms.push(run);
    for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}

export function similarity(a: string, b: string): number {
  const ta = new Set(searchTerms(a));
  const tb = new Set(searchTerms(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / Math.min(ta.size, tb.size);
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
