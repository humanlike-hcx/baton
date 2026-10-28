import { spawn } from "node:child_process";
import { truncateMiddle } from "./util.ts";

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV.test(k) || k.startsWith("BATON_")) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export interface ShellResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

function powershellCommand(command: string): { file: string; args: string[] } {
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$commandText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedCommand}'))
$global:LASTEXITCODE = 0
try {
  Invoke-Expression $commandText
} catch [System.Management.Automation.CommandNotFoundException] {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 127
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit 0
`.trim();
  return {
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}

function shellCommand(command: string): { file: string; args: string[] } {
  return process.platform === "win32" ? powershellCommand(command) : { file: "bash", args: ["-c", command] };
}

function killShell(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function runShell(
  command: string,
  options: { cwd: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<ShellResult> {
  const started = Date.now();
  const maxBytes = options.maxBytes ?? 16 * 1024;
  return new Promise((resolve) => {
    const shell = shellCommand(command);
    const child = spawn(shell.file, shell.args, {
      cwd: options.cwd,
      env: options.env ?? scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    const cap = 4 * 1024 * 1024;
    child.stdout.on("data", (d: Buffer) => {
      if (outBytes < cap) out.push(d);
      outBytes += d.length;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (errBytes < cap) err.push(d);
      errBytes += d.length;
    });
    let timedOut = false;
    const kill = () => killShell(child);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? 120_000);
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null, signal: string | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const stdout = truncateMiddle(Buffer.concat(out).toString("utf8"), maxBytes);
      const stderr = truncateMiddle(Buffer.concat(err).toString("utf8"), Math.floor(maxBytes / 2));
      resolve({
        exitCode,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (e) => {
      err.push(Buffer.from(String(e)));
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export function formatShellResult(command: string, r: ShellResult): string {
  const parts = [`$ ${command}`, `退出码: ${r.exitCode ?? "无"}${r.signal ? `（信号 ${r.signal}）` : ""}${r.timedOut ? "（超时被终止）" : ""}`];
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trimEnd()}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push("（无输出）");
  return parts.join("\n");
}
