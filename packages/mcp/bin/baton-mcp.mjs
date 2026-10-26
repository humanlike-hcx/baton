#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callTool } from "./bridge.mjs";

const server = new McpServer({ name: "baton", version: "0.1.0" });

const reply = async (tool, args) => {
  const out = await callTool(tool, args);
  return { content: [{ type: "text", text: out.text }], isError: out.isError };
};

server.registerTool(
  "read_context",
  { title: "读上下文", description: "读取工作台的房间上下文（CONTEXT.md）和置顶记忆。", inputSchema: {} },
  async () => reply("read_context", {}),
);

server.registerTool(
  "memory_search",
  {
    title: "查记忆",
    description: "按关键词检索工作台记忆（事实、决定、偏好）。不传 query 时返回最近的条目。",
    inputSchema: { query: z.string().optional(), limit: z.number().optional() },
  },
  async (args) => reply("memory_search", args),
);

server.registerTool(
  "remember",
  {
    title: "写记忆",
    description: "写入一条记忆。kind：fact / decision / preference。更新旧条目时传 supersedes（旧条目 id）。写之前先 memory_search。",
    inputSchema: {
      text: z.string().describe("一句话说清楚，600 字以内"),
      kind: z.enum(["fact", "decision", "preference"]).optional(),
      supersedes: z.string().optional(),
    },
  },
  async (args) => reply("remember", args),
);

server.registerTool(
  "write_handoff",
  {
    title: "写交接",
    description: "结束前写交接：做了什么、改了哪些文件、还剩什么、建议下一步。检查角色必须给出 verdict（pass / fail），fail 时在 issues 里逐条列问题。",
    inputSchema: {
      done: z.string(),
      files: z.array(z.string()).optional(),
      remaining: z.string().optional(),
      next: z.string().optional(),
      verdict: z.enum(["pass", "fail"]).optional(),
      issues: z.array(z.string()).optional(),
    },
  },
  async (args) => reply("write_handoff", args),
);

await server.connect(new StdioServerTransport());
