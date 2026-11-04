import fs from "node:fs";
import path from "node:path";
import { id, hash, safePath } from "./util.ts";
import type { Project, Resource } from "./types.ts";

export function discover(project: Project, globalDir: string) {
  const found: Resource[] = [];
  const add = (kind: Resource["kind"], file: string) => {
    if (!fs.existsSync(file)) return;
    const real = fs.realpathSync(file);
    const previous = project.resources.find(r => r.path === real && r.kind === kind);
    found.push(previous ?? { id: id(), path: real, kind, enabled: false });
  };
  add("rule", path.join(project.root, "AGENTS.md"));
  for (const base of [globalDir, path.join(project.root, ".baton-v2")]) {
    const rules = path.join(base, "rules");
    if (fs.existsSync(rules)) for (const file of fs.readdirSync(rules).sort()) if (file.endsWith(".md")) add("rule", path.join(rules, file));
    const skills = path.join(base, "skills");
    if (fs.existsSync(skills)) for (const name of fs.readdirSync(skills).sort()) add("skill", path.join(skills, name, "SKILL.md"));
    const extensions = path.join(base, "extensions");
    if (fs.existsSync(extensions)) for (const name of fs.readdirSync(extensions).sort()) if (/\.(ts|js|mjs)$/.test(name)) add("extension", path.join(extensions, name));
  }
  project.resources = [...found, ...project.resources.filter(r => !found.some(f => f.id === r.id))];
  return project.resources;
}
export function enableResource(resource: Resource, enabled: boolean) {
  if (!enabled) { resource.enabled = false; return; }
  const stat = fs.statSync(resource.path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("资源必须是小于 1MB 的文件");
  const text = fs.readFileSync(resource.path, "utf8");
  if (resource.kind === "extension") {
    // An explicit host declaration narrows support; it is not a security certification.
    const manifest = JSON.parse(fs.readFileSync(`${resource.path}.baton.json`, "utf8"));
    if (manifest.host !== "baton-v2" || manifest.ui !== "none") throw new Error("首版仅启用声明 baton-v2 / ui:none 的无终端交互扩展");
    resource.compatible = true;
  }
  resource.hash = hash(text); resource.enabled = true; resource.error = undefined;
}
export function currentResources(project: Project) {
  return project.resources.filter(r => r.enabled).filter(r => {
    try {
      const content = fs.readFileSync(r.path, "utf8");
      if (r.kind === "extension" && hash(content) !== r.hash) throw new Error("扩展代码已变化，请重新确认启用");
      return true;
    } catch (e) { r.error = (e as Error).message; return false; }
  });
}
export function memoryPath(project: Project, name: string) {
  if (!/^[\p{L}\p{N}_ .-]{1,100}\.md$/u.test(name) || name.includes("..")) throw new Error("记忆名称必须是普通 Markdown 文件名");
  return safePath(project.root, path.join(".baton-v2/memory", name), { write: true });
}
export function memories(project: Project) {
  const dir = safePath(project.root, ".baton-v2/memory");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith(".md")).map(name => ({ name, content: fs.readFileSync(memoryPath(project, name), "utf8") }));
}
