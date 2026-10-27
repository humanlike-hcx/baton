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
  "submit_review",
  {
    title: "给出检查结论",
    description: "检查结束前调用一次：没有问题写 pass，否则写 fail，并在 issues 里逐条列出问题（文件、位置、原因）。检查命令失败时不能写 pass。",
    inputSchema: {
      verdict: z.enum(["pass", "fail"]),
      issues: z.array(z.string()).optional(),
    },
  },
  async (args) => reply("submit_review", args),
);

await server.connect(new StdioServerTransport());
