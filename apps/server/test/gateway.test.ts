import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { Gateway } from "@baton/core";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(stops.splice(0).map(fn => fn())); });
async function mock() {
  const requests: { url: string; authorization?: string; body: any }[] = [];
  let mode = "normal";
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : undefined;
    requests.push({ url: req.url!, authorization: req.headers.authorization, body: payload });
    if (mode === "unauthorized") { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"server quoted gateway-secret-token"}'); return; }
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [
        { id: "fixture-a", display_name: "Fixture A", tool_call: true, native_endpoints: ["/v1/chat/completions"], reasoning_levels: ["none", "low", "ultra"], context_window: 32768, service_tiers: mode === "no-fast" ? [] : [{ id: "priority", name: "Fast" }] },
        { id: "unknown-capability", context_window: 12345 },
        { id: "responses-fixture", tool_call: true, native_endpoints: ["/v1/responses"], service_tiers: [{ id: "priority", name: "Fast" }] },
        { id: "no-fast", display_name: "Flash is only a name", tool_call: true, native_endpoints: ["/v1/chat/completions"], service_tiers: [null, "priority", { id: "auto" }, { name: "Fast" }] },
      ] })); return;
    }
    res.setHeader("content-type", "text/event-stream");
    const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (req.url === "/v1/responses") {
      chunk({ type: "response.completed", response: { id: "r", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } });
      res.end(); return;
    }
    if (mode === "disconnect") { chunk({ id: "x", choices: [{ index: 0, delta: { content: "unfinished" } }] }); res.end(); return; }
    if (payload?.messages?.some((m: any) => m.role === "tool")) {
      chunk({ id: "x", choices: [{ index: 0, delta: { role: "assistant", content: "BATON_OK" }, finish_reason: null }] });
      chunk({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      chunk({ id: "x", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
    } else {
      chunk({ id: "x", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "baton_probe", arguments: '{"value":' } }] }, finish_reason: null }] });
      chunk({ id: "x", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "7}" } }] }, finish_reason: null }] });
      chunk({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    }
    res.end("data: [DONE]\n\n");
  };
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-gateway-test-"));
  const gateway = new Gateway(root); gateway.configure({ url: `http://127.0.0.1:${address.port}/v1`, token: "gateway-secret-token" });
  stops.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  return { gateway, requests, setMode(next: string) { mode = next; } };
}
it("discovers explicit capabilities, proves a streamed tool round trip, and sends only gateway credentials", async () => {
  const m = await mock(); const result = await m.gateway.refresh();
  expect(result.models.map(m => m.id)).toEqual(["fixture-a", "responses-fixture", "no-fast"]);
  expect(result.models[0].thinking).toEqual(["off", "low"]);
  expect(result.models.map(m => m.fastMode)).toEqual([true, true, false]);
  expect(result.models.every(m => !m.verified)).toBe(true);
  expect(() => m.gateway.pick({ id: "fixture-a" })).toThrow("尚未通过");
  await m.gateway.verify("fixture-a");
  expect(m.gateway.pick({ id: "fixture-a" }).verified).toBe(true);
  expect(m.requests.map(r => r.url)).toEqual(["/v1/models", "/v1/chat/completions", "/v1/chat/completions"]);
  expect(m.requests.every(r => r.authorization === "Bearer gateway-secret-token")).toBe(true);
  expect(JSON.stringify(m.gateway.public())).not.toContain("gateway-secret-token");
  expect(JSON.stringify(m.requests.map(r => r.body))).not.toContain("gateway-secret-token");
  m.gateway.configure({ url: "http://127.0.0.1:1/v1" }); expect(m.gateway.public().models).toEqual([]);
});
it("reports auth failure without quoting secrets, rejects unconfirmed parameters and provider fallback", async () => {
  const m = await mock(); await m.gateway.refresh();
  expect(() => m.gateway.pick({ id: "fixture-a", thinking: "high" }, false)).toThrow("未经网关确认");
  const runtime = await m.gateway.runtime(); const builtin = runtime.getModels().find(m => m.provider !== "baton-magpie")!;
  expect(() => runtime.completeSimple(builtin, { messages: [] })).toThrow("必须经过");
  m.setMode("unauthorized"); await expect(m.gateway.refresh()).rejects.toThrow("鉴权失败");
  expect(JSON.stringify(m.gateway.public())).not.toContain("gateway-secret-token");
});
it("does not report a truncated SSE stream as completed work", async () => {
  const m = await mock(); await m.gateway.refresh(); m.setMode("disconnect");
  const runtime = await m.gateway.runtime(), model = runtime.getModel("baton-magpie", "fixture-a")!;
  const stream = m.gateway.stream(model, normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 1 }] }));
  const response = await stream.result(); expect(response.stopReason).toBe("error");
});
it("clearly reports an unavailable gateway and rejects URL credentials", async () => {
  const m = await mock(); expect(() => m.gateway.configure({ url: "http://user:secret@localhost/v1" })).toThrow();
  m.gateway.configure({ url: "http://127.0.0.1:1/v1" });
  await expect(m.gateway.refresh()).rejects.toThrow("无法连接");
  expect(m.gateway.public().status).toBe("连接失败");
});

it("validates explicit fast capability and preserves the selected tier without inferring it from names", async () => {
  const m = await mock(); await m.gateway.refresh(); await m.gateway.verify("fixture-a");
  expect(m.gateway.normalize({ id: "fixture-a", serviceTier: "priority" })).toEqual({ id: "fixture-a", thinking: "off", serviceTier: "priority" });
  expect(m.gateway.normalize({ id: "fixture-a" })).not.toHaveProperty("serviceTier");
  expect(() => m.gateway.pick({ id: "no-fast", serviceTier: "priority" }, false)).toThrow("快速模式未经网关确认");
  expect(() => m.gateway.pick({ id: "fixture-a", serviceTier: "auto" as "priority" }, false)).toThrow("快速模式未经网关确认");
  const fast = await m.gateway.runtime({ id: "fixture-a", serviceTier: "priority" });
  m.setMode("no-fast"); await m.gateway.refresh();
  const count = m.requests.length;
  expect(() => fast.completeSimple(fast.getModel("baton-magpie", "fixture-a")!, { messages: [] })).toThrow("快速模式未经网关确认");
  expect(m.requests).toHaveLength(count);
});

it("sends priority through both protocols only for the selected runtime, including subsequent tool turns", async () => {
  const m = await mock(); await m.gateway.refresh();
  const context = { messages: [{ role: "user" as const, content: "test", timestamp: 1 }] };
  for (const id of ["fixture-a", "responses-fixture"]) {
    const fast = await m.gateway.runtime({ id, serviceTier: "priority" });
    const normal = await m.gateway.runtime({ id });
    const model = fast.getModel("baton-magpie", id)!;
    const offset = m.requests.length;
    const [reply, regular] = await Promise.all([
      fast.completeSimple(model, context),
      normal.completeSimple(model, context, { onPayload: p => ({ ...p as object, service_tier: "priority" }) }),
    ]);
    expect(reply.stopReason).not.toBe("error"); expect(regular.stopReason).not.toBe("error");
    const sent = m.requests.slice(offset);
    expect(sent).toHaveLength(2);
    expect(sent.filter(r => r.body.service_tier === "priority")).toHaveLength(1);
    expect(sent.filter(r => !("service_tier" in r.body))).toHaveLength(1);
    if (id === "fixture-a") {
      const call = reply.content.find(c => c.type === "toolCall")!;
      const finish = await fast.completeSimple(model, { messages: [...context.messages, reply, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "7" }], isError: false, timestamp: 2 }] });
      expect(finish.stopReason).toBe("stop");
      expect(m.requests.at(-1)!.body.service_tier).toBe("priority");
    }
    // Pi's compression path uses complete; it must inherit the same session selection.
    await fast.complete(model, context);
    expect(m.requests.at(-1)!.body.service_tier).toBe("priority");
  }
});
