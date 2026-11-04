import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function atomic(file: string, content: string | Buffer, mode = 0o600, privateFile = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${id()}.tmp`;
  try {
    fs.writeFileSync(tmp, "", { mode, flag: "wx" });
    if (privateFile && process.platform === "win32") {
      const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
      const acl = spawnSync("icacls.exe", [tmp, "/inheritance:r", "/grant:r", `${principal}:(F)`], { windowsHide: true, stdio: "pipe" });
      if (acl.error || acl.status !== 0) throw new Error("无法限制网关凭据文件的访问权限，配置未保存");
    }
    fs.writeFileSync(tmp, content); fs.renameSync(tmp, file);
  }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw new Error(`本地数据无法读取：${path.basename(file)}；请保留文件排查`); }
}
export function truncateMiddle(text: string, limit: number) {
  const data = Buffer.from(text); if (data.length <= limit) return { text, truncated: false };
  const half = Math.floor(limit / 2);
  return { text: data.subarray(0, half).toString() + "\n…[输出已截断]…\n" + data.subarray(-half).toString(), truncated: true };
}
export function inside(root: string, file: string) { const rel = path.relative(root, file); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); }
/** Resolve every existing ancestor; never trust a lexical prefix or a symlink target. */
export function safePath(root: string, input: string, options: { extraRead?: string[]; write?: boolean } = {}): string {
  if (typeof input !== "string" || input.includes("\0")) throw new Error("无效文件路径");
  const resolved = path.resolve(root, input);
  const roots = [root, ...(!options.write ? options.extraRead ?? [] : [])].map(r => fs.realpathSync(r));
  let ancestor = resolved;
  const tail: string[] = [];
  while (!fs.existsSync(ancestor)) {
    if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("不能访问损坏的符号链接");
    const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error("找不到访问路径");
    tail.unshift(path.basename(ancestor)); ancestor = parent;
  }
  const real = path.join(fs.realpathSync(ancestor), ...tail);
  if (!roots.some(r => inside(r, real))) throw new Error("路径超出本对话已授权的项目范围");
  if (options.write && path.relative(root, real).split(path.sep).some(p => [".git", ".baton", "node_modules"].includes(p))) throw new Error("此目录不在可恢复文件范围内");
  if (options.write && fs.existsSync(real) && fs.statSync(real).isFile() && fs.statSync(real).nlink > 1) throw new Error("硬链接文件无法可靠限制写入范围");
  return real;
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
