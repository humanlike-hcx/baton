import fs from "node:fs";
import path from "node:path";
import { atomic, hash, inside, readJson, safePath } from "./util.ts";
import type { ChangePreview, FileChange } from "./types.ts";

export const EXCLUDED = [".git", ".baton", "node_modules"];
type Entry = { hash: string; mode: number; kind: "file" | "link"; link?: string };
type Tree = Record<string, Entry>;
type Journal = { before: Tree; after?: Tree; blocked?: string; restored?: boolean };
const same = (a?: Entry, b?: Entry) => JSON.stringify(a) === JSON.stringify(b);
const changed = (a: Tree, b: Tree) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k])).sort();

/** Content-addressed per-run baselines; unrelated dirty Git files remain part of the baseline. */
export class Snapshots {
  constructor(readonly root: string, private directory: string) { if (inside(root, directory)) throw new Error("改动记录必须保存在项目目录之外"); }
  private object(hashValue: string) { return path.join(this.directory, "objects", hashValue); }
  private file(run: string) { if (!/^[a-f0-9-]{36}$/.test(run)) throw new Error("无效运行编号"); return path.join(this.directory, `${run}.json`); }
  scan(store = true): Tree {
    const result: Tree = {}; let bytes = 0; let count = 0;
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir).sort()) {
        if (EXCLUDED.includes(name)) continue;
        const file = path.join(dir, name), rel = path.relative(this.root, file);
        const stat = fs.lstatSync(file);
        if (++count > 30000) throw new Error("项目超过 30000 个条目，无法可靠建立改动基线");
        if (stat.isSymbolicLink()) { const link = fs.readlinkSync(file); result[rel] = { kind: "link", link, hash: hash(link), mode: stat.mode & 0o777 }; }
        else if (stat.isDirectory()) walk(file);
        else if (stat.isFile()) {
          if (stat.nlink > 1) throw new Error(`存在硬链接，不能可靠追踪：${rel}`);
          bytes += stat.size;
          if (stat.size > 16 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error(`文件基线超过限制（单文件 16MB / 总计 256MB）：${rel}`);
          const content = fs.readFileSync(file), after = fs.lstatSync(file);
          if (stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino || stat.size !== after.size) throw new Error(`建立基线时文件发生变化：${rel}`);
          const digest = hash(content); result[rel] = { kind: "file", hash: digest, mode: stat.mode & 0o777 };
          if (store && !fs.existsSync(this.object(digest))) atomic(this.object(digest), content);
        } else throw new Error(`无法追踪特殊文件：${rel}`);
      }
    };
    walk(this.root); return result;
  }
  begin(run: string) { const before = this.scan(); if (changed(before, this.scan(false)).length) throw new Error("项目正在被外部程序修改，无法建立稳定基线"); atomic(this.file(run), JSON.stringify({ before })); return before; }
  finish(run: string, blocked?: string) { const journal = this.load(run); journal.after = this.scan(); journal.blocked = blocked; atomic(this.file(run), JSON.stringify(journal)); return changed(journal.before, journal.after); }
  private load(run: string) { const j = readJson<Journal | null>(this.file(run), null); if (!j) throw new Error("该运行没有可靠文件基线"); return j; }
  differences(a: Tree, b: Tree) { return changed(a, b); }
  preview(run: string): ChangePreview {
    const j = this.load(run); if (!j.after) throw new Error("运行还没有结束或退出前未完成改动记录");
    const current = this.scan(false), paths = changed(j.before, j.after);
    const conflicts = paths.filter(p => !same(current[p], j.after![p]));
    const changes: FileChange[] = paths.map(p => {
      const a = j.before[p], b = j.after![p];
      const before = a?.kind === "file" ? fs.readFileSync(this.object(a.hash)) : a ? Buffer.from(`symbolic link → ${a.link}`) : undefined;
      const after = b?.kind === "file" ? fs.readFileSync(this.object(b.hash)) : b ? Buffer.from(`symbolic link → ${b.link}`) : undefined;
      const binary = !!before?.includes(0) || !!after?.includes(0) || (before?.length ?? 0) > 200000 || (after?.length ?? 0) > 200000;
      return { path: p, before: binary ? undefined : before?.toString(), after: binary ? undefined : after?.toString(), binary, kind: !a ? "add" : !b ? "delete" : "modify" };
    });
    let blocked = j.blocked;
    if (j.restored) blocked = "该运行已撤销";
    if (paths.some(p => j.before[p]?.kind === "link" || j.after![p]?.kind === "link")) blocked ??= "涉及符号链接变更，请手动核对恢复";
    return { runId: run, changes, conflicts, token: hash(JSON.stringify({ run, current, after: j.after })), blocked, excluded: EXCLUDED };
  }
  restore(run: string, token: string) {
    const preview = this.preview(run);
    if (preview.blocked || preview.conflicts.length || preview.token !== token) throw new Error(preview.blocked ?? `撤销预览已过期或文件冲突：${preview.conflicts.join("、")}`);
    const j = this.load(run), paths = changed(j.before, j.after!);
    // Validate every target before the first mutation. Revalidate each file immediately before writing.
    for (const p of paths) safePath(this.root, p, { write: true });
    const restored: string[] = [];
    try {
      for (const p of paths) {
        const current = this.scan(false);
        if (!same(current[p], j.after![p])) throw new Error(`恢复期间文件被修改：${p}`);
        const dest = safePath(this.root, p, { write: true }), entry = j.before[p];
        if (entry) { atomic(dest, fs.readFileSync(this.object(entry.hash)), entry.mode); fs.chmodSync(dest, entry.mode); }
        else if (fs.existsSync(dest)) fs.unlinkSync(dest);
        restored.push(p);
      }
      const current = this.scan(false);
      if (paths.some(p => !same(current[p], j.before[p]))) throw new Error("恢复后回读不一致");
      j.restored = true; atomic(this.file(run), JSON.stringify(j));
    } catch (e) { j.blocked = `恢复未全部完成；已恢复：${restored.join("、") || "无"}；${(e as Error).message}`; atomic(this.file(run), JSON.stringify(j)); throw new Error(j.blocked); }
    return restored;
  }
}
