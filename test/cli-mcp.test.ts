// The MCP server (what Claude Code/Cursor talk to) and the CLI's HTTP surface, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { handleMcp, toolList } from '../src/mcp/server.ts';
import { signup, createToken, fromToken } from '../src/auth.ts';

const BASE = 'http://localhost:4800';

async function setup() {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  const { userId, orgId } = await signup(app.db, { email: `a${Math.random().toString(36).slice(2)}@x.com`, name: 'Ada', password: 'correct horse battery' });
  const p = { user: { id: userId, email: 'a@x.com', name: 'Ada' }, org: { id: orgId, name: 'Org', slug: 'org' }, role: 'owner' as const, via: 'session' as const };
  const agentToken = createToken(app.db, p, 'claude-code', 'agent').token;
  const readToken = createToken(app.db, p, 'reader', 'readonly').token;
  return { app, http, agentToken, readToken };
}

const mcp = (http: any, token: string, msg: unknown) => http.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(msg) }));

test('MCP: tools/list exposes every Unit7 tool with input schemas', () => {
  const tools = toolList();
  assert.ok(tools.length > 20);
  const deploy = tools.find((t) => t.name === 'deployment_create');
  assert.ok(deploy && deploy.inputSchema, 'deployment_create is exposed with a schema');
  assert.ok(tools.every((t) => !t.name.includes('.')), 'names are wire-safe (underscores)');
});

test('MCP: initialize, list and a real tool call through the gate', async () => {
  const { http, agentToken } = await setup();
  const init = await (await mcp(http, agentToken, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /credential/);
  const prompts = await (await mcp(http, agentToken, { jsonrpc: '2.0', id: 9, method: 'prompts/list' })).json();
  assert.ok(prompts.result.prompts.some((p: any) => p.name === 'deploy'));
  const got = await (await mcp(http, agentToken, { jsonrpc: '2.0', id: 10, method: 'prompts/get', params: { name: 'deploy', arguments: { what: 'my api' } } })).json();
  assert.match(got.result.messages[0].content.text, /deploy my api/);
  const list = await (await mcp(http, agentToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.ok(list.result.tools.some((t: any) => t.name === 'project_create'));
  // a write via the agent token runs (bookkeeping allowed) and returns structured content
  const call = await (await mcp(http, agentToken, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_create', arguments: { name: 'From MCP' } } })).json();
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.ok(payload.output.projectId);
});

test('MCP: unauthenticated and read-only behave correctly', async () => {
  const { http, readToken } = await setup();
  const noauth = await mcp(http, 'nope', { jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(noauth.status, 401);
  // a readonly token can list tools and read, but a write is denied through the gate
  const call = await (await mcp(http, readToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'project_create', arguments: { name: 'x' } } })).json();
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.ok(payload.denied, 'readonly write is denied');
});

test('upload endpoint stores a tarball for unit7 deploy', async () => {
  const { http, agentToken } = await setup();
  const body = Buffer.from('fake-tarball-bytes');
  const res = await http.fetch(new Request(`${BASE}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/gzip' }, body }));
  assert.equal(res.status, 200);
  const j = await res.json() as any;
  assert.match(j.uploadId, /^upl_/);
  assert.equal(j.size, body.length);
});
