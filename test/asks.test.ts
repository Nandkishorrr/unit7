// The AI asks with pickers in the Home chat (src/agent/asks.ts, src/tools/ui.ts): a ui.* call shows an ask in the
// conversation and waits for the person's answer, which goes back to the AI. Covers the built-in brain (a fake
// model), a subscription run (test/fake-cli.mjs) and everyone who must not be able to answer or ask.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { testApp } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { acceptInvite, createInvite, createToken } from '../src/auth.ts';
import { all, id, now, run } from '../src/db.ts';
import { askWindow } from '../src/agent/asks.ts';

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
const tmp = mkdtempSync(join(tmpdir(), 'unit7-asks-'));
const RECORD = join(tmp, 'record.json');
Object.assign(process.env, { UNIT7_CLAUDE_BIN: FAKE, FAKE_CLI_RECORD: RECORD, FAKE_CLI_MODE: '' });

// a model that calls the tool it's told to, then answers with what the tool returned
let call: { name: string; arguments: object } = { name: 'ui_choose', arguments: {} };
const bodies: any[] = [];
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
    const b = JSON.parse(raw); bodies.push(b);
    const tool = b.messages.findLast((m: any) => m.role === 'tool');
    res.end(JSON.stringify({ choices: [{ message: tool ? { role: 'assistant', content: `Done: ${tool.content}` }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] }));
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
process.env.OLLAMA_URL = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
after(() => { model.close(); rmSync(tmp, { recursive: true, force: true }); });

const BASE = 'http://localhost:4800';
async function setup() {
  resetRateLimits();
  rmSync(RECORD, { force: true });
  const app = testApp();
  const http = createHttp(app);
  const server = await new Promise<ReturnType<typeof serve>>((r) => {
    const s = serve({ fetch: http.fetch, port: 0, hostname: '127.0.0.1' }, (info) => { app.services.listen = { host: '127.0.0.1', port: info.port }; r(s); });
  });
  const browser = () => {
    let cookie = '', bind = '';
    return async (method: string, path: string, body?: unknown, bearer?: string) => {
      const r = await http.fetch(new Request(`${BASE}${path}`, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : { origin: BASE, ...(cookie && { cookie, 'x-unit7-bind': bind }) }) } }));
      const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
      return { status: r.status, body: await r.json() as any };
    };
  };
  const sam = browser();
  await sam('POST', '/api/auth/signup', { email: 'sam@example.com', name: 'Sam', password: 'correct horse battery' });
  const me = (await sam('GET', '/api/me')).body;
  // the map found two domains (one with subdomains) and Unit7 manages a third name
  const asset = (name: string, meta: object) => run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, 'domain', 'domain', ?, ?, ?, ?)`, id('ast'), me.org.id, name, name, JSON.stringify(meta), now());
  asset('example.com', { dns: 'cloudflare', zone: 'example.com' });
  asset('www.example.com', { dns: 'cloudflare', zone: 'example.com' });
  asset('shop.example.com', { dns: 'cloudflare', zone: 'example.com' });
  asset('example.org', { dns: 'hostinger' });
  asset('web-abc.203-0-113-10.sslip.io', {});
  const owner = { user: me.user, org: me.org, role: 'owner', via: 'session' } as any;
  return { app, sam, me, owner, browser, port: (app.services.listen as any).port as number, close: () => server.close() };
}
type Web = Awaited<ReturnType<typeof setup>>['sam'];

const wait = async <T>(what: string, f: () => Promise<T | undefined> | T | undefined): Promise<T> => {
  for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`never: ${what}`);
};
const thread = async (web: Web, c: string) => (await web('GET', `/api/agent/conversations/${c}`)).body as { running: boolean; messages: { id: string; role: string; content: any }[] };
const askIn = (web: Web, c: string) => wait('an ask', async () => (await thread(web, c)).messages.find((m) => m.role === 'ask' && m.content.state === 'waiting'));
const settle = (web: Web, c: string) => wait('the run to end', async () => { const t = await thread(web, c); return t.running ? undefined : t.messages; });
const lastToolResult = () => JSON.parse(bodies.at(-1).messages.findLast((m: any) => m.role === 'tool').content);

test('built-in brain: the domain picker shows live data, only the person’s valid pick reaches the AI', async () => {
  const { app, sam, owner, browser, close } = await setup();
  try {
    call = { name: 'ui_choose', arguments: { title: 'Which domain?', source: 'domains', allowNew: { label: 'Add a new domain' } } };
    const { conversationId, via } = (await sam('POST', '/api/agent/conversations', { message: 'connect a domain to my website' })).body;
    assert.equal(via, 'unit7');
    const ask = await askIn(sam, conversationId);
    assert.equal(ask.id, ask.content.askId);
    assert.deepEqual(ask.content.spec, { kind: 'choose', title: 'Which domain?', source: 'domains', allowNew: { label: 'Add a new domain' } });
    assert.ok(Date.parse(ask.content.expiresAt) > Date.now() + 9 * 60_000);
    assert.ok(!(await thread(sam, conversationId)).messages.some((m) => m.role === 'tool'), 'an ask is its own card, not a step');

    // the picker's live data: one card per root, its DNS host and subdomains; Unit7's stand-in addresses left out
    const { options } = (await sam('GET', `/api/agent/asks/${ask.id}/options`)).body;
    assert.deepEqual(options.map((o: any) => [o.id, o.logo, o.count]), [['example.com', 'cloudflare', 2], ['example.org', 'hostinger', 0]]);

    // nobody else answers: a teammate, an API token (an AI), and nothing that isn't on the list
    await acceptInvite(app.db, createInvite(app.db, owner, 'teammate@example.com', 'admin'), { name: 'Teammate', password: 'correct horse battery' });
    const mate = browser();
    await mate('POST', '/api/auth/login', { email: 'teammate@example.com', password: 'correct horse battery' });
    assert.equal((await mate('POST', `/api/agent/asks/${ask.id}`, { choice: ['example.com'] })).status, 404);
    const token = createToken(app.db, owner, 'some agent', 'agent').token;
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { choice: ['example.com'] }, token)).status, 403);
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { choice: ['evil.example'] })).status, 400);
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { choice: ['example.com', 'example.org'] })).status, 400, 'one pick only');
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { ok: true })).status, 400, 'not an answer to a pick');

    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { choice: ['example.com'] })).status, 200);
    const done = await settle(sam, conversationId);
    // the AI gets ids, labels from Unit7's own data, and what to pass on next
    assert.deepEqual(lastToolResult(), { choice: ['example.com'], labels: ['example.com'],
      items: [{ id: 'example.com', label: 'example.com', hostname: 'example.com', dns: 'cloudflare', subdomains: ['shop.example.com', 'www.example.com'] }] });
    const answered = done.find((m) => m.id === ask.id)!;
    assert.equal(answered.content.state, 'answered');
    assert.deepEqual(answered.content.answer.labels, ['example.com']);
    assert.equal(done.at(-1)!.role, 'assistant');
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { choice: ['example.com'] })).status, 409, 'answered once');
    // the next request knows what was picked
    call = { name: 'graph_get', arguments: {} };
    await sam('POST', '/api/agent/conversations', { message: 'and www too', conversationId });
    await settle(sam, conversationId);
    assert.ok(bodies.at(-1).messages.some((m: any) => m.role === 'assistant' && m.content === '(I asked: Which domain? → they picked example.com)'));
  } finally { close(); }
});

test('an ask expires after its window, and Stop cancels one that is waiting', async () => {
  const { sam, close } = await setup();
  try {
    call = { name: 'ui_confirm', arguments: { title: 'Point example.com at web?', changes: [{ label: 'DNS for example.com', before: 'Nothing', after: 'web' }], undo: 'Remove the record.' } };
    askWindow.ms = 300;
    const a = (await sam('POST', '/api/agent/conversations', { message: 'connect it' })).body.conversationId;
    const t = await settle(sam, a);
    assert.equal(t.find((m) => m.role === 'ask')!.content.state, 'expired');
    assert.equal(lastToolResult().expired, true);
    askWindow.ms = 10 * 60_000;

    const b = (await sam('POST', '/api/agent/conversations', { message: 'connect it' })).body.conversationId;
    const ask = await askIn(sam, b);
    await sam('POST', `/api/agent/conversations/${b}/stop`, {});
    const t2 = await settle(sam, b);
    assert.equal(t2.find((m) => m.id === ask.id)!.content.state, 'cancelled');
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { ok: true })).status, 409);
  } finally { askWindow.ms = 10 * 60_000; close(); }
});

test('a form’s secret goes to the vault: the AI and the thread only see its reference', async () => {
  const { app, sam, me, close } = await setup();
  try {
    call = { name: 'ui_form', arguments: { title: 'Your API', fields: [{ id: 'name', label: 'Name', type: 'text', required: true }, { id: 'region', label: 'Region', type: 'select', options: ['eu', 'us'] }, { id: 'apiKey', label: 'API key', type: 'secret', required: true }] } };
    const c = (await sam('POST', '/api/agent/conversations', { message: 'wire my API' })).body.conversationId;
    const ask = await askIn(sam, c);
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { values: { name: 'api' } })).status, 400, 'the key is required');
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { values: { name: 'api', region: 'mars', apiKey: 'x' } })).status, 400, 'not a choice');
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { values: { name: ' api ', region: 'eu', apiKey: 'sk-very-secret-value', extra: 'dropped' } })).status, 200);
    await settle(sam, c);
    const { values } = lastToolResult();
    assert.equal(values.name, 'api');
    assert.equal(values.region, 'eu');
    assert.match(values.apiKey, /^credential:\/\/chat\/[a-z0-9-]+\/apikey$/);
    assert.equal(app.vault.resolve(me.org.id, values.apiKey), 'sk-very-secret-value');
    const stored = JSON.stringify([all(app.db, 'SELECT content FROM messages'), all(app.db, 'SELECT input, output FROM audit'), bodies.at(-1)]);
    assert.ok(!stored.includes('sk-very-secret-value'));
  } finally { close(); }
});

test('ui tools only work in the ask box: an outside AI or a person calling them is refused', async () => {
  const { app, sam, owner, port, close } = await setup();
  try {
    const token = createToken(app.db, owner, 'Claude Code (terminal)', 'agent').token;
    const mcp = async (method: string, params: object) => (await (await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as any).result;
    assert.ok(!(await mcp('tools/list', {})).tools.some((t: any) => t.name.startsWith('ui_')), 'not even listed');
    const r = await mcp('tools/call', { name: 'ui_choose', arguments: { title: 'Which domain?', source: 'domains' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /only works in Unit7’s ask box/);
    const mine = await sam('POST', '/api/tools/ui.confirm', { input: { title: 'Sure?', changes: [{ label: 'x', after: 'y' }] } });
    assert.match(mine.body.error.message, /only works in Unit7’s ask box/);
  } finally { close(); }
});

test('a subscription run asks through its own token: the pick goes back to the CLI, long waits allowed', async () => {
  const { sam, close } = await setup();
  try {
    process.env.FAKE_CLI_MODE = 'ask';
    assert.equal((await sam('POST', '/api/agent/brain', { brain: 'claude' })).status, 200);
    const { conversationId, via } = (await sam('POST', '/api/agent/conversations', { message: 'connect a domain to my website' })).body;
    assert.equal(via, 'subscription');
    const ask = await askIn(sam, conversationId);
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { choice: ['example.org'] })).status, 200);
    const t = await settle(sam, conversationId);
    const rec = JSON.parse(readFileSync(RECORD, 'utf8'));
    assert.deepEqual(rec.listed, ['ui_choose', 'ui_confirm', 'ui_form', 'ui_folder', 'ui_hide', 'ui_delete'], 'the run’s own token sees the ui tools');
    assert.deepEqual(JSON.parse(rec.answer).output.labels, ['example.org']);
    assert.deepEqual(t.filter((m) => m.role !== 'user').map((m) => m.role === 'ask' ? `ask:${m.content.state}` : `${m.role}:${m.content.text}${m.content.final ? ' (final)' : ''}`),
      ['assistant:Which one?', 'ask:answered', 'assistant:Connecting example.org. (final)']);
    // an ask can wait 10 minutes: the CLI's MCP call is allowed longer than that, and the brief teaches asking
    assert.equal(rec.config.mcpServers.unit7.timeout, 35 * 60_000);
    assert.ok(rec.env.includes('MCP_TOOL_TIMEOUT'));
    assert.match(rec.args[rec.args.indexOf('--append-system-prompt') + 1], /call ui_choose with that source/);
    assert.ok(rec.args.includes('--include-partial-messages'));
  } finally { process.env.FAKE_CLI_MODE = ''; close(); }
});

test('streaming: the reply grows in one message, a few updates a second, then is marked final', async () => {
  const { app, sam, me, close } = await setup();
  try {
    process.env.FAKE_CLI_MODE = 'stream';
    await sam('POST', '/api/agent/brain', { brain: 'claude' });
    const seen: { id: string; text: string }[] = [];
    const off = app.events.on((e) => { const m = (e.data as any).message; if (e.org_id === me.org.id && e.type === 'agent.message' && m?.role === 'assistant') seen.push({ id: m.id, text: m.content.text }); });
    const { conversationId } = (await sam('POST', '/api/agent/conversations', { message: 'how are my apps?' })).body;
    const t = await settle(sam, conversationId);
    off();
    const replies = t.filter((m) => m.role === 'assistant');
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0]!.content, { text: 'Your three apps are up and answering quickly.', final: true });
    assert.ok(seen.every((s) => s.id === replies[0]!.id), 'one message, updated in place');
    assert.ok(seen.length >= 3 && seen.length <= 6, `throttled, got ${seen.length} updates`);
    assert.ok(seen.every((s, i) => i === 0 || s.text.startsWith(seen[i - 1]!.text)), 'each update extends the last');
  } finally { process.env.FAKE_CLI_MODE = ''; close(); }
});

