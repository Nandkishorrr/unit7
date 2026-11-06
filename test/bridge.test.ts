// The bridge: your own Claude Code answers Unit7's web command box over MCP, with no API key.
// This test plays both sides: the person typing in the web UI (session) and Claude Code running
// `/unit7 watch` (an agent token calling unit7_inbox_next / unit7_say over /mcp).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { createToken } from '../src/auth.ts';

const BASE = 'http://localhost:4800';
process.env.OLLAMA_URL = 'http://127.0.0.1:9/v1'; // make sure no local model is "connected"

test('web UI → inbox → your Claude Code picks it up, narrates, finishes — same thread', async () => {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  let cookie = '', bind = ''; // a browser session is the cookie plus the page's header
  const web = async (method: string, path: string, body?: unknown) => {
    const r = await http.fetch(new Request(`${BASE}${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', origin: BASE, ...(cookie && { cookie, 'x-unit7-bind': bind }) } }));
    const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
    return { status: r.status, body: await r.json() as any };
  };
  await web('POST', '/api/auth/signup', { email: 'ada@x.com', name: 'Ada', password: 'correct horse battery' });
  const me = (await web('GET', '/api/me')).body;
  const token = createToken(app.db, { user: me.user, org: me.org, role: 'owner', via: 'session' } as any, 'claude-code', 'agent').token;
  const call = async (name: string, args: unknown) => {
    const r = await http.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
    return JSON.parse((await r.json() as any).result.content[0].text);
  };

  // nobody watching yet, and no model: the box still accepts, and says it's waiting for your AI
  const st0 = (await web('GET', '/api/agent/status')).body;
  assert.equal(st0.ready, false);
  assert.equal(st0.bridge.watching, false);

  // Claude Code starts watching (long-poll) BEFORE anything is typed…
  const waiting = call('unit7_inbox_next', { wait: true });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await web('GET', '/api/agent/status')).body.bridge.watching, true, 'a waiting watcher counts as listening');

  // …the person types in the web UI…
  const sent = (await web('POST', '/api/agent/conversations', { message: 'why is prod slow?' })).body;
  assert.equal(sent.via, 'your-ai');
  assert.equal(sent.watching, true);

  // …and the watcher wakes immediately with that request
  const t0 = Date.now();
  const task = await waiting;
  assert.ok(Date.now() - t0 < 2000, 'the long-poll wakes on enqueue, not after its timeout');
  assert.equal(task.output.message, 'why is prod slow?');
  assert.equal(task.output.conversationId, sent.conversationId);

  // the conversation is "running" while your AI holds it
  assert.equal((await web('GET', `/api/agent/conversations/${sent.conversationId}`)).body.running, true);

  // Claude Code narrates, then answers; both land in the same web thread
  assert.equal((await call('unit7_say', { conversationId: task.output.conversationId, text: 'Checking the server metrics…' })).ok, true);
  await call('unit7_say', { conversationId: task.output.conversationId, text: 'CPU is pinned by one container. I added a second copy behind the load balancer.', final: true });
  const conv = (await web('GET', `/api/agent/conversations/${sent.conversationId}`)).body;
  const texts = conv.messages.map((m: any) => `${m.role}:${m.content.text}`);
  assert.deepEqual(texts, ['user:why is prod slow?', 'assistant:Checking the server metrics…', 'assistant:CPU is pinned by one container. I added a second copy behind the load balancer.']);
  assert.equal(conv.running, false, 'final=true closes the request');

  // dropping a request by id works (and the id passes the tenant check)
  const t2conv = (await web('POST', '/api/agent/conversations', { message: 'never mind' })).body.conversationId;
  const taskId = (app.db.prepare('SELECT id FROM agent_tasks WHERE conversation_id = ?').get(t2conv) as { id: string }).id;
  assert.equal((await call('unit7_inbox_done', { taskId })).ok, true);
  assert.equal((await web('GET', `/api/agent/conversations/${t2conv}`)).body.running, false);

  // an empty inbox returns quickly when not waiting
  assert.equal((await call('unit7_inbox_next', { wait: false })).output.empty, true);

  // a conversation started from the terminal (/unit7 <request>) shows in the web app too
  const th = (await call('unit7_thread', { message: 'deploy this folder' })).output;
  const list = (await web('GET', '/api/agent/conversations')).body;
  assert.ok(list.some((c: any) => c.id === th.conversationId && c.title === 'deploy this folder'));
});

test('a watcher in another org never sees your requests', async () => {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  const { signup } = await import('../src/auth.ts');
  const a = await signup(app.db, { email: 'a@x.com', name: 'A', password: 'correct horse battery' });
  const b = await signup(app.db, { email: 'b@x.com', name: 'B', password: 'correct horse battery' });
  const { enqueue } = await import('../src/agent/bridge.ts');
  const { id, run } = await import('../src/db.ts');
  const conv = id('cnv');
  run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conv, a.orgId, a.userId, 'secret');
  enqueue(app, a.orgId, conv, 'org A only', a.userId);
  const tokenB = createToken(app.db, { user: { id: b.userId, email: 'b@x.com', name: 'B' }, org: { id: b.orgId, name: 'B', slug: 'b' }, role: 'owner', via: 'session' } as any, 'cc', 'agent').token;
  const r = await http.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unit7_inbox_next', arguments: { wait: false } } }) }));
  assert.equal(JSON.parse((await r.json() as any).result.content[0].text).output.empty, true);
  // and B can't post into A's conversation
  await http.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'unit7_say', arguments: { conversationId: conv, text: 'hijack', final: true } } }) }));
  const msgs = app.db.prepare('SELECT count(*) n FROM messages WHERE conversation_id = ?').get(conv) as { n: number };
  assert.equal(msgs.n, 0);
});

// Anthropic's terms: your subscription does your own work. A teammate's request must not be answered
// by your Claude Code; it waits for theirs. Warden's incidents (your own infrastructure) are fine.
test('your watcher answers only your requests (and Warden incidents), never a teammate\'s', async () => {
  resetRateLimits();
  const app = testApp();
  const { signup } = await import('../src/auth.ts');
  const { enqueue, nextTask, watcherActive, WARDEN } = await import('../src/agent/bridge.ts');
  const { id, run } = await import('../src/db.ts');
  const owner = await signup(app.db, { email: 'o@x.com', name: 'O', password: 'correct horse battery' });
  const mate = 'usr_teammate0001';
  const conv = (user: string) => { const c = id('cnv'); run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', c, owner.orgId, user, 't'); return c; };
  enqueue(app, owner.orgId, conv(mate), 'teammate asks', mate);
  assert.equal(await nextTask(app, owner.orgId, owner.userId, 0), undefined, 'owner\'s watcher skips the teammate');
  enqueue(app, owner.orgId, conv(WARDEN), 'incident on your server', WARDEN);
  assert.equal((await nextTask(app, owner.orgId, owner.userId, 0))?.message, 'incident on your server');
  enqueue(app, owner.orgId, conv(owner.userId), 'my own request', owner.userId);
  assert.equal((await nextTask(app, owner.orgId, owner.userId, 0))?.message, 'my own request');
  assert.equal((await nextTask(app, owner.orgId, mate, 0))?.message, 'teammate asks', 'the teammate\'s own watcher gets it');
  assert.equal(watcherActive(app, owner.orgId, 'usr_nobody000001'), false);
});
