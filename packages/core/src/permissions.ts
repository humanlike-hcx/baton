import fs from "node:fs";
import path from "node:path";
import type { AgentCard, AgentPermissions, Policy, WorkspaceSettings } from "./types.ts";
import { globToRegExp } from "./util.ts";

export class PermissionError extends Error {}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathOfNearest(target: string): string {
  let current = target;
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...rest);
}

export function matchesDeny(rel: string, patterns: string[]): string | undefined {
  const normalized = rel.split(path.sep).join("/");
  const base = path.posix.basename(normalized);
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    if (re.test(normalized)) return pattern;
    if (!pattern.includes("/") && re.test(base)) return pattern;
    if (pattern.endsWith("/**") && (normalized === pattern.slice(0, -3) || normalized.startsWith(pattern.slice(0, -2)))) return pattern;
  }
  return undefined;
}

/**
 * Resolves a tool-supplied path against the workspace. Rejects anything that leaves the
 * workspace (including through symlinks), denylisted paths, and writes into `.baton/`.
 */
export function resolveWorkspacePath(
  root: string,
  input: string,
  settings: WorkspaceSettings,
  mode: "read" | "write",
): { abs: string; rel: string } {
  if (typeof input !== "string" || input.includes("\0")) throw new PermissionError("路径不合法");
  const abs = path.resolve(root, input || ".");
  if (!isInside(root, abs)) throw new PermissionError(`路径越出工作区：${input}`);
  const real = realpathOfNearest(abs);
  if (!isInside(root, real)) throw new PermissionError(`路径经符号链接逃出工作区：${input}`);
  const rel = path.relative(root, abs).split(path.sep).join("/") || ".";
  const denied = matchesDeny(rel, settings.permissions.denyPaths);
  if (denied) throw new PermissionError(`路径被拒绝（规则 ${denied}）：${rel}`);
  if (mode === "write" && (rel === ".baton" || rel.startsWith(".baton/"))) {
    throw new PermissionError("不能直接写 .baton/，请用 update_context / remember / write_handoff 等工具");
  }
  return { abs, rel };
}

const SHELL_META = /[;&|`<>]|\$\(/;

export function shellPolicy(command: string, settings: WorkspaceSettings, agent: AgentCard): { policy: Policy; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) return { policy: "deny", reason: "空命令" };
  for (const deny of settings.permissions.shellDeny) {
    const re = new RegExp(`(^|[\\s;&|(])${deny.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$|[;&|)])`);
    if (re.test(trimmed)) return { policy: "deny", reason: `命中黑名单：${deny}` };
  }
  if (agent.permissions.exec === "deny") return { policy: "deny", reason: `${agent.name} 没有执行命令的权限` };
  if (!SHELL_META.test(trimmed)) {
    for (const allow of settings.permissions.shellAllow) {
      if (trimmed === allow || trimmed.startsWith(`${allow} `)) return { policy: "allow", reason: `白名单：${allow}` };
    }
  }
  if (agent.permissions.exec === "allow") return { policy: "allow", reason: `${agent.name} 被允许直接执行命令` };
  return { policy: "ask", reason: "执行命令需要确认" };
}

/** "ask" still counts as able to write: the user confirms each change. */
export function canWrite(permissions: Pick<AgentPermissions, "write">): boolean {
  return permissions.write !== "deny";
}

const POLICIES: Policy[] = ["allow", "ask", "deny"];

/** Cards saved before write became a policy stored `write: true / false`. */
export function normalizePermissions(raw: Partial<Record<keyof AgentPermissions, unknown>> | undefined): AgentPermissions {
  const policy = (value: unknown, fallback: Policy): Policy =>
    value === true ? "allow" : value === false ? "deny" : POLICIES.includes(value as Policy) ? (value as Policy) : fallback;
  return { write: policy(raw?.write, "deny"), exec: policy(raw?.exec, "ask"), network: policy(raw?.network, "deny") };
}

export function permissionLevel(agent: Pick<AgentCard, "permissions">): number {
  if (agent.permissions.exec === "allow") return 3;
  if (canWrite(agent.permissions)) return 2;
  if (agent.permissions.exec === "ask") return 1;
  return 0;
}
