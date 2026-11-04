import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fixture, answer, call, until } from './helpers.ts';
const cleanup: (() => Promise<void>)[] = []; afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });
async function setup(...args: Parameters<typeof fixture>) { const f = await fixture(...args); cleanup.push(() => f.close()); return f; }
it('uses Pi MCP client, displays status, asks even for self-declared readonly tools, and closes the service', async () => {
  const f = await setup([answer(call('mcp__fixture__echo', { text: 'MCP_OK' }), { stopReason: 'toolUse' }), answer('complete')]);
  const fixtureFile = path.resolve('packages/core/fixtures/mcp-server.mjs');
  expect((await f.request(`/api/projects/${f.project.id}/mcp`, 'PUT', { servers: [{ name: 'fixture', command: process.execPath, args: [fixtureFile], enabled: true }] })).status).toBe(200);
  await f.request(`/api/threads/${f.thread.id}/mcp/check`, 'POST', {}); await f.state.wait(f.thread.id);
  expect(JSON.stringify(f.state.thread(f.thread.id).items)).toContain('mcp__fixture__echo');
  await f.request(`/api/threads/${f.thread.id}/messages`, 'POST', { text: 'use MCP' });
  await until(() => f.state.thread(f.thread.id).items.some(i => i.kind === 'approval'));
  const approval = f.state.thread(f.thread.id).items.find(i => i.kind === 'approval')!;
  expect(approval.tool).toBe('mcp__fixture__echo');
  await f.request(`/api/approvals/${approval.approvalId}`, 'POST', { allow: true }); await f.state.wait(f.thread.id);
  const tool = f.state.thread(f.thread.id).items.find(i => i.kind === 'tool')!;
  expect(tool.text).toContain('MCP_OK'); expect(tool.status).toBe('ok');
});
it('an unavailable MCP service does not block an unrelated conversation', async () => {
  const f = await setup([answer('ordinary response')]);
  await f.request(`/api/projects/${f.project.id}/mcp`, 'PUT', { servers: [{ name: 'broken', command: '/does-not-exist-baton-test', enabled: true }] });
  await f.request(`/api/threads/${f.thread.id}/messages`, 'POST', { text: 'ordinary task' }); await f.state.wait(f.thread.id);
  expect(f.state.thread(f.thread.id).runs[0].status).toBe('succeeded');
  expect(JSON.stringify(f.state.thread(f.thread.id).items)).toContain('broken');
});
it('loads only a confirmed compatible extension and applies approvals to its tools', async () => {
  const f = await setup([answer(call('fixture_echo', { text: 'extension result' }), { stopReason: 'toolUse' }), answer('finished')]);
  const extension = path.join(f.projectRoot, 'extension.mjs');
  fs.writeFileSync(extension, `export default function(pi) { pi.registerTool({ name: "fixture_echo", label: "Fixture", description: "Echo a test string", parameters: { type: "object", properties: { text: {type: "string"} }, required: ["text"] }, execute: async (_id, args) => ({content:[{type:"text",text:args.text}]}) }); }`);
  const added = (await f.request(`/api/projects/${f.project.id}/resources`, 'PUT', { path: extension, kind: 'extension', enabled: false })).data;
  expect((await f.request(`/api/projects/${f.project.id}/resources`, 'PUT', { id: added.id, enabled: true })).status).toBe(400);
  fs.writeFileSync(`${extension}.baton.json`, JSON.stringify({ host: 'baton-v2', ui: 'none' }));
  expect((await f.request(`/api/projects/${f.project.id}/resources`, 'PUT', { id: added.id, enabled: true })).status).toBe(200);
  await f.request(`/api/threads/${f.thread.id}/messages`, 'POST', { text: 'use extension' });
  await until(() => f.state.thread(f.thread.id).items.some(i => i.kind === 'approval'));
  const approval = f.state.thread(f.thread.id).items.find(i => i.kind === 'approval')!;
  await f.request(`/api/approvals/${approval.approvalId}`, 'POST', { allow: false }); await f.state.wait(f.thread.id);
  expect(f.state.thread(f.thread.id).items.find(i => i.kind === 'tool')?.status).toBe('error');
});
