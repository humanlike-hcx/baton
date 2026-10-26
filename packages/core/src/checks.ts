import { runShell } from "./shell.ts";
import type { CheckCommand, CheckResult } from "./types.ts";
import { globToRegExp } from "./util.ts";

export interface CheckOptions {
  cwd: string;
  changedFiles?: string[];
  signal?: AbortSignal;
}

function applies(check: CheckCommand & { paths?: string[] }, changed: string[] | undefined): boolean {
  if (!check.paths?.length || !changed) return true;
  const res = check.paths.map((p) => globToRegExp(p));
  return changed.some((f) => res.some((re) => re.test(f)));
}

/** Runs configured checks. Skipped never counts as passed; a command that cannot run is an error, not a failure. */
export async function runChecks(checks: (CheckCommand & { paths?: string[] })[], options: CheckOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (!check.command.trim() || check.command.trim().startsWith("#")) {
      results.push({ name: check.name, command: check.command, status: "skipped", exitCode: null, durationMs: 0, output: "命令为空或被注释" });
      continue;
    }
    if (!applies(check, options.changedFiles)) {
      results.push({ name: check.name, command: check.command, status: "skipped", exitCode: null, durationMs: 0, output: "本次改动不涉及这项检查的路径" });
      continue;
    }
    const r = await runShell(check.command, { cwd: options.cwd, timeoutMs: (check.timeoutSec ?? 300) * 1000, maxBytes: 8 * 1024, signal: options.signal });
    const output = [r.stdout.trim(), r.stderr.trim() ? `stderr:\n${r.stderr.trim()}` : ""].filter(Boolean).join("\n");
    let status: CheckResult["status"];
    if (r.timedOut || r.exitCode === null || r.exitCode === 126 || r.exitCode === 127) status = "error";
    else status = r.exitCode === 0 ? "pass" : "fail";
    results.push({
      name: check.name,
      command: check.command,
      status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      output: r.timedOut ? `超时（${check.timeoutSec ?? 300} 秒）\n${output}` : output,
    });
  }
  return results;
}

export function formatChecks(results: CheckResult[]): string {
  if (!results.length) return "## 检查命令\n本工作区没有配置检查命令（这不等于通过）。";
  const label = { pass: "通过", fail: "失败", skipped: "跳过（不算通过）", error: "出错" } as const;
  return [
    "## 检查命令结果",
    ...results.map((r) => `- ${r.name}：${label[r.status]}（\`${r.command}\`，退出码 ${r.exitCode ?? "无"}）${r.status === "pass" ? "" : `\n  ${r.output.split("\n").slice(-12).join("\n  ")}`}`),
  ].join("\n");
}
