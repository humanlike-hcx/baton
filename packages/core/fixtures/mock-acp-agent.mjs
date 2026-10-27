#!/usr/bin/env node
// Stand-in for the Cursor CLI (`agent`) used by tests and the demo workspace.
// Supports `status`, `models`, `login`, and `acp` (JSON-RPC 2.0 over stdio).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
const modelIdx = argv.indexOf("--model");
const model = modelIdx >= 0 ? argv[modelIdx + 1] : "mock";
const command = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--model")[0];

if (command === "status") {
  console.log("✓ Logged in as demo@example.com");
  process.exit(0);
}
if (command === "models") {
  console.log(
    "Available models\n\nauto - Auto\ncomposer-2.5 - Composer 2.5\nclaude-sonnet-5-5-medium - Claude Sonnet 5.5 Medium (current)\nclaude-sonnet-5-5-high - Claude Sonnet 5.5 High\ngpt-5.6-sol - GPT-5.6 Sol\ngpt-5.3-codex - GPT-5.3 Codex\ngemini-4-argon-medium - Gemini 4 Argon Medium\ngrok-4.7-medium - Grok 4.7 Medium\ndeepseek-v41-flash-1017-medium - DeepSeek V4.1 Flash Medium\n",
  );
  process.exit(0);
}
if (command === "login") {
  console.log("Open the following URL to log in: https://cursor.com/loginDeepControl?challenge=mock&mode=login");
  setTimeout(() => {
    console.log("Login successful");
    process.exit(0);
  }, 1500);
} else if (command !== "acp") {
  console.error(`mock agent: unknown command ${command}`);
  process.exit(2);
}

let nextId = 1;
const pending = new Map();
const sessions = new Map();
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `a${nextId++}`;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stream(sessionId, text) {
  for (const chunk of text.match(/.{1,6}/gs) ?? []) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
    await sleep(15);
  }
}

async function callBridge(session, tool, args) {
  const server = session.mcpServers.find((s) => s.name === "baton");
  if (!server) return false;
  const env = Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]));
  if (!env.BATON_URL) return false;
  try {
    const res = await fetch(`${env.BATON_URL}/api/bridge/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-baton": "1", "x-baton-token": env.BATON_TOKEN ?? "" },
      body: JSON.stringify({ tool, args }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function listNotes(cwd) {
  try {
    return fs.readdirSync(path.join(cwd, "notes")).map((f) => `notes/${f}`).join("\n") || "(empty)";
  } catch {
    return "find: 'notes': No such file or directory";
  }
}

async function permission(sessionId, toolCall) {
  const res = await request("session/request_permission", {
    sessionId,
    toolCall,
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
  return res?.outcome?.outcome === "selected" && res.outcome.optionId === "allow";
}

async function prompt(params) {
  const session = sessions.get(params.sessionId);
  const text = params.prompt.map((p) => p.text ?? "").join("\n");
  session.cancelled = false;
  if (text.startsWith("你还没有调用 submit_review")) {
    await stream(params.sessionId, "（模拟）没有可用的 MCP 工具，给不出结论。");
    return { stopReason: "end_turn" };
  }
  const isReview = text.includes("角色：检查");
  await stream(params.sessionId, `（模拟 Cursor · ${model}）收到，开始${isReview ? "检查" : "工作"}。`);
  if (session.cancelled) return { stopReason: "cancelled" };
  const files = [];
  if (session.mode !== "ask" && !isReview) {
    const rel = `notes/cursor-${model}.md`;
    const toolCall = { toolCallId: "t1", title: `Write ${rel}`, kind: "edit", status: "pending", locations: [{ path: rel }] };
    update(params.sessionId, { sessionUpdate: "tool_call", ...toolCall });
    if (await permission(params.sessionId, toolCall)) {
      fs.mkdirSync(path.join(session.cwd, "notes"), { recursive: true });
      fs.writeFileSync(path.join(session.cwd, rel), `# 由模拟 Cursor（${model}）写入\n\n${new Date().toISOString()}\n`);
      files.push(rel);
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: `wrote ${rel}` } }] });
    } else {
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ type: "content", content: { type: "text", text: "permission denied" } }] });
    }
  }
  if (text.includes("联网")) {
    const web = { toolCallId: "t3", title: "Fetch https://example.com/docs", kind: "fetch", status: "pending", rawInput: { url: "https://example.com/docs" } };
    update(params.sessionId, { sessionUpdate: "tool_call", ...web });
    const fetched = await permission(params.sessionId, web);
    update(params.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t3",
      status: fetched ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: fetched ? "<html>example docs</html>" : "rejected" } }],
    });
  }
  const run = { toolCallId: "t2", title: "Run find notes -type f", kind: "execute", status: "pending", rawInput: { command: "find notes -type f" } };
  update(params.sessionId, { sessionUpdate: "tool_call", ...run });
  const allowed = await permission(params.sessionId, run);
  update(params.sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t2",
    status: allowed ? "completed" : "failed",
    content: [{ type: "content", content: { type: "text", text: allowed ? listNotes(session.cwd) : "rejected" } }],
  });
  if (session.cancelled) return { stopReason: "cancelled" };
  if (isReview) {
    const viaBridge = await callBridge(session, "submit_review", { verdict: "pass", issues: [] });
    await stream(params.sessionId, viaBridge ? "已通过 baton MCP 给出结论：通过。" : "完成。");
  } else {
    await stream(params.sessionId, `完成，写入了 ${files.join("、") || "无"}。`);
  }
  return { stopReason: "end_turn" };
}

const handlers = {
  initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] }),
  "session/new": async (params) => {
    const sessionId = `s${sessions.size + 1}`;
    sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers ?? [], mode: "agent", cancelled: false });
    return { sessionId, modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "ask", name: "Ask" }] } };
  },
  "session/set_mode": async (params) => {
    sessions.get(params.sessionId).mode = params.modeId;
    return {};
  },
  "session/prompt": prompt,
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method && msg.id !== undefined) {
    const handler = handlers[msg.method];
    if (!handler) return send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
    try {
      send({ id: msg.id, result: await handler(msg.params ?? {}) });
    } catch (e) {
      send({ id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
    }
  } else if (msg.method === "session/cancel") {
    const s = sessions.get(msg.params?.sessionId);
    if (s) s.cancelled = true;
  } else if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }
});
rl.on("close", () => process.exit(0));
