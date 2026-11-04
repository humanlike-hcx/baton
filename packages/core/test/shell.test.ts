import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runShell } from "../src/shell.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function project() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-shell-")); roots.push(root); return root; }
async function waitFor(file: string) { const end = Date.now() + 4000; while (!fs.existsSync(file)) { if (Date.now() > end) throw new Error("process did not start"); await new Promise(r => setTimeout(r, 10)); } }
it("cancels a running command and closes its output pipes", async () => {
  const cwd = project(), controller = new AbortController();
  fs.writeFileSync(path.join(cwd, "child.cjs"), "require('fs').writeFileSync('started', String(process.pid)); setInterval(()=>{}, 1000);");
  const promise = runShell("node child.cjs", { cwd, signal: controller.signal, timeoutMs: 8000 });
  await waitFor(path.join(cwd, "started")); controller.abort();
  const result = await promise;
  expect(result.exitCode === 0).toBe(false); expect(result.timedOut).toBe(false); expect(result.durationMs).toBeLessThan(6000);
});
it.skipIf(process.platform === "win32")("cleans up background descendants when their shell exits normally", async () => {
  const cwd = project();
  const result = await runShell("sleep 30 & printf started; exit 0", { cwd, timeoutMs: 8000 });
  expect(result.exitCode).toBe(0); expect(result.stdout).toBe("started"); expect(result.timedOut).toBe(false); expect(result.durationMs).toBeLessThan(3000);
});
