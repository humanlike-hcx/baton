#!/usr/bin/env node
// Command-line access to the baton tools; costs less context than MCP for agents with a shell.
import { parseArgs } from "node:util";
import { callTool } from "./bridge.mjs";

const USAGE = `用法：
  baton context                      读房间上下文和置顶记忆
  baton memory [关键词]               检索记忆
  baton remember <内容> [--kind decision] [--supersedes <id>]
  baton review pass|fail [--issues "问题1;问题2"]   检查时给出结论

环境变量：BATON_URL（默认 http://127.0.0.1:47321），BATON_TOKEN（运行令牌，可选）`;

const [command, ...rest] = process.argv.slice(2);
const list = (v) => (v ? v.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : undefined);

async function main() {
  switch (command) {
    case "context":
      return callTool("read_context", {});
    case "memory":
      return callTool("memory_search", { query: rest.join(" ") || undefined });
    case "remember": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { kind: { type: "string" }, supersedes: { type: "string" } } });
      return callTool("remember", { text: positionals.join(" "), kind: values.kind, supersedes: values.supersedes });
    }
    case "review": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { issues: { type: "string" } } });
      return callTool("submit_review", { verdict: positionals[0], issues: list(values.issues) });
    }
    default:
      return { text: USAGE, isError: command !== undefined && command !== "help" && command !== "--help" };
  }
}

const out = await main();
(out.isError ? process.stderr : process.stdout).write(`${out.text}\n`);
process.exit(out.isError ? 1 : 0);
