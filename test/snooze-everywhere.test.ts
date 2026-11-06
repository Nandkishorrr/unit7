// "This is fine" works the same everywhere: the key a thing is hidden by (src/snooze.ts snoozeKeyOf), Warden's panel
// (its item id is the key /api/suggestions filters on), the Map (map.get leaves hidden issues out, and what they flag:
// the red line, the site down; includeHidden brings them back), Home's tasks agreeing with the Map, and the AI, which
// never hides anything itself: it shows a Hide card (ui.hide) and the person's own press hides it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ok, testApp, testOrg } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { get, id, now, run, type DB } from '../src/db.ts';
import { alertKey, eventKey, snooze, snoozeKeyOf, visible } from '../src/snooze.ts';
import { assetIdOf } from '../src/archive.ts';

// the built-in brain on a stand-in model that calls the tool it's told to, then answers with the result; the CLIs
// are stand-ins too, so nothing reaches a real AI
const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
const tmp = mkdtempSync(join(tmpdir(), 'unit7-hide-'));
Object.assign(process.env, { UNIT7_CLAUDE_BIN: FAKE, UNIT7_GEMINI_BIN: FAKE, FAKE_CLI_RECORD: join(tmp, 'record.json'), FAKE_CLI_MODE: '', GEMINI_CLI_HOME: tmp });
let call: { name: string; arguments: object } = { name: 'ui_hide', arguments: {} };
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

// a site down (the outside check) and a domain whose DNS points elsewhere (the last sync), as Unit7 saved them
function seedMap(db: DB, orgId: string) {
  const shop = assetIdOf(orgId, 'vercel:shop'), dom = assetIdOf(orgId, 'domain:api.example.com'), api = assetIdOf(orgId, 'unit7:svc_api');
  const at = now();
  run(db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, 'vercel', 'app', 'shop', 'shop', 'https://shop.example.com', '{}', ?)`, shop, orgId, at);
  run(db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, 'domain', 'domain', 'api.example.com', 'api.example.com', '{"zone":"example.com"}', ?)`, dom, orgId, at);
  run(db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, 'unit7', 'app', 'svc_api', 'api', '{}', ?)`, api, orgId, at);
  run(db, `INSERT INTO edges (id, org_id, source, target, kind, via, status, detail) VALUES (?, ?, ?, ?, 'domain', 'added on Unit7', 'misconfigured', 'DNS says A 198.51.100.7')`, id('edg'), orgId, dom, api);
  run(db, `INSERT INTO watch (org_id, host, kind, status, detail, asset) VALUES (?, 'shop.example.com', 'site', 'down', 'connection refused', ?)`, orgId, shop);
  const issues = [{ severity: 'warning', key: 'dns:domain:api.example.com:unit7:svc_api', about: 'domain:api.example.com', text: 'api.example.com is added to api but its DNS points elsewhere (A 198.51.100.7).' }];
  run(db, `INSERT INTO sync_runs (id, org_id, started_at, finished_at, status, summary) VALUES (?, ?, ?, ?, 'done', ?)`, id('syn'), orgId, at, at, JSON.stringify({ issues, accounts: [], suggestions: [] }));
  return { shop, dom, api };
}

test('the key a thing is hidden by: a count in its id doesn’t matter, nothing else changes', async () => {
  assert.equal(snoozeKeyOf('blocked:srv_abc:3'), 'blocked:srv_abc');
  assert.equal(snoozeKeyOf('subdomains:example.com:8'), 'subdomains:example.com');
  for (const k of ['down:shop.example.com', 'dns:domain:api.example.com:unit7:svc_api', 'vuln:svc_1:0:2', 'harden:srv_abc', 'risk:xray:oom:srv_1:c:web', 'subdomains:example.com'])
    assert.equal(snoozeKeyOf(k), k, `${k} stays as it is`);
  assert.equal(alertKey({ source: 'usage', key: 'cpu', server_id: 'srv_1' }), 'usage:srv_1:cpu');
  assert.equal(eventKey({ type: 'service.down', resource: 'svc_1' }), 'event:service.down:svc_1');

  const app = testApp(), org = (await testOrg(app, 'Sam')).orgId;
  snooze(app.db, org, { key: 'blocked:srv_abc:3', for: '7d', by: 'Sam' });
  assert.equal(get<{ key: string }>(app.db, 'SELECT key FROM snoozes')!.key, 'blocked:srv_abc', 'kept by its stable key');
  assert.deepEqual(visible(app.db, org, [{ id: 'blocked:srv_abc:4' }, { id: 'blocked:srv_xyz:4' }], (x) => x.id), [{ id: 'blocked:srv_xyz:4' }], '4 attackers now: still hidden');
});

test('the Map: a hidden issue leaves map.get, and so does what it flags; Home agrees; includeHidden brings both back', async () => {
  const app = testApp(), o = await testOrg(app, 'Sam');
  const { shop, dom, api } = seedMap(app.db, o.orgId);
  const before = ok(await o.h('map.get'));
  assert.deepEqual(before.issues.map((i: any) => i.key).sort(), ['dns:domain:api.example.com:unit7:svc_api', 'down:shop.example.com']);
  assert.ok(ok<{ tasks: any[] }>(await o.h('home.suggest', { limit: 10 })).tasks.some((t) => t.snoozeKey === 'down:shop.example.com'), 'Home has the site too, by the same key');

  // hidden on the Map (by the issue's key): gone from the map, its red line and its site down, and from Home
  ok(await o.h('snooze.set', { key: 'down:shop.example.com', for: 'tomorrow', severity: 'critical' }));
  ok(await o.h('snooze.set', { key: 'dns:domain:api.example.com:unit7:svc_api', for: '15d' }));
  const m = ok(await o.h('map.get'));
  assert.deepEqual(m.issues, []);
  assert.equal(m.hidden, 2, 'the Hidden (2) toggle');
  assert.equal(m.assets.find((a: any) => a.id === shop).site, undefined, 'the site down no longer counts');
  assert.equal(m.edges.find((e: any) => e.source === dom && e.target === api).status, 'unknown', 'not drawn red');
  assert.ok(!ok<{ tasks: any[] }>(await o.h('home.suggest', { limit: 10 })).tasks.some((t) => t.snoozeKey === 'down:shop.example.com' || t.id === 'site:down:shop.example.com'), 'Home agrees');

  const all = ok(await o.h('map.get', { includeHidden: true }));
  assert.deepEqual(all.issues.map((i: any) => [i.key, i.hidden, typeof i.until]).sort(), [['dns:domain:api.example.com:unit7:svc_api', true, 'string'], ['down:shop.example.com', true, 'string']]);
  assert.equal(all.assets.find((a: any) => a.id === shop).site.status, 'down');
  assert.equal(all.edges.find((e: any) => e.source === dom && e.target === api).status, 'misconfigured');

  // brought back: on the map again
  ok(await o.h('snooze.clear', { key: 'down:shop.example.com' }));
  assert.deepEqual(ok(await o.h('map.get')).issues.map((i: any) => i.key), ['down:shop.example.com']);
  // hidden from Home (its snoozeKey): off the Map too
  ok(await o.h('snooze.set', { key: ok<{ tasks: any[] }>(await o.h('home.suggest', { limit: 10 })).tasks.find((t) => t.id === 'site:down:shop.example.com')!.snoozeKey, for: '7d' }));
  assert.deepEqual(ok(await o.h('map.get')).issues, []);

  // a hosted app's errors today: Home's task for them and the Map's flag hide together
  const at = now();
  run(app.db, `INSERT INTO remote_errors (org_id, asset, fingerprint, kind, message, count, first_seen, last_seen) VALUES (?, ?, 'f1', 'TypeError', 'x is undefined', 9, ?, ?)`, o.orgId, shop, at, at);
  assert.equal(ok(await o.h('map.get')).assets.find((a: any) => a.id === shop).errors.hits, 9);
  ok(await o.h('snooze.set', { key: `remote:${shop}`, for: '7d' }));
  assert.equal(ok(await o.h('map.get')).assets.find((a: any) => a.id === shop).errors, undefined);
  assert.equal(ok(await o.h('map.get', { includeHidden: true })).assets.find((a: any) => a.id === shop).errors.hidden, true);
  assert.ok(!ok<{ tasks: any[] }>(await o.h('home.suggest', { limit: 10 })).tasks.some((t) => t.id === `remote:${shop}`));
});

// --- through the web app, as a person and as the AI -------------------------------------------------------------------
const BASE = 'http://localhost:4800';
async function setup() {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  const server = await new Promise<ReturnType<typeof serve>>((r) => { const s = serve({ fetch: http.fetch, port: 0, hostname: '127.0.0.1' }, (info) => { app.services.listen = { host: '127.0.0.1', port: info.port }; r(s); }); });
  let cookie = '', bind = '';
  const sam = async (method: string, path: string, body?: unknown) => {
    const r = await http.fetch(new Request(`${BASE}${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', origin: BASE, ...(cookie && { cookie, 'x-unit7-bind': bind }) } }));
    const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
    return { status: r.status, body: await r.json() as any };
  };
  await sam('POST', '/api/auth/signup', { email: 'sam@example.com', name: 'Sam', password: 'correct horse battery' });
  const me = (await sam('GET', '/api/me')).body;
  const tool = async (name: string, input: object = {}) => (await sam('POST', `/api/tools/${name}`, { input })).body;
  return { app, sam, me, tool, close: () => server.close() };
}
const wait = async <T>(what: string, f: () => Promise<T | undefined>): Promise<T> => {
  for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`never: ${what}`);
};

test('Warden’s panel: hiding an item by its id takes it out of /api/suggestions and Home at once, and after a reload', async () => {
  const { app, me, sam, tool, close } = await setup();
  try {
    const srv = id('srv');
    run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready', '{}')`, srv, me.org.id);
    const items = (await sam('GET', '/api/suggestions')).body.items as { id: string }[];
    const item = items.find((s) => s.id === `harden:${srv}`)!;
    assert.ok(item, 'Warden suggests locking the server down');
    // what the panel's "Hide for 15 days" sends: the item's own id
    assert.equal((await tool('snooze.set', { key: item.id, for: '15d', title: 'box', kind: 'suggestion' })).status, 'ok');
    assert.ok(!(await sam('GET', '/api/suggestions')).body.items.some((s: { id: string }) => s.id === item.id), 'gone from the panel and the badge');
    assert.ok(!(await tool('home.suggest', { limit: 10 })).output.tasks.some((t: { id: string }) => t.id === item.id), 'gone from Home');
    assert.equal(get<{ by: string }>(app.db, 'SELECT by FROM snoozes WHERE key = ?', item.id)!.by, 'Sam');
  } finally { close(); }
});

test('the AI never hides: asked to, it shows a Hide card; the person’s press hides it as them, and the AI hears back', async () => {
  const { app, me, sam, tool, close } = await setup();
  try {
    seedMap(app.db, me.org.id);
    call = { name: 'ui_hide', arguments: { key: 'down:shop.example.com', for: 'forever', note: 'You said the shop is a test site.' } };
    const { conversationId } = (await sam('POST', '/api/agent/conversations', { message: 'hide the shop alert' })).body;
    const thread = async () => (await sam('GET', `/api/agent/conversations/${conversationId}`)).body as { running: boolean; messages: { id: string; role: string; content: any }[] };
    const ask = await wait('the Hide card', async () => (await thread()).messages.find((m) => m.role === 'ask' && m.content.state === 'waiting'));
    // Unit7's own words and how serious, never the AI's; a critical one is offered for a while, not for good
    assert.deepEqual({ ...ask.content.spec }, { kind: 'hide', title: 'Hide “shop.example.com is down: connection refused”?', note: 'You said the shop is a test site.',
      key: 'down:shop.example.com', what: 'shop.example.com is down: connection refused.', severity: 'critical', itemKind: 'alert', for: '7d' });

    // the AI itself can't (people only), and saying "done" before the person hid it doesn't count
    const { execute } = await import('../src/tools/runtime.ts');
    const ai = await execute(app, me.org.id, { kind: 'agent', id: me.user.id, userId: me.user.id, name: 'Unit7 agent', role: 'agent', agent: 'Unit7 agent' }, 'snooze.set', { key: 'down:shop.example.com', for: '7d' });
    assert.equal(ai.status, 'denied');
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { done: true })).status, 400);

    // the card's Hide it: the person's own snooze.set, then the answer
    assert.equal((await tool('snooze.set', { key: 'down:shop.example.com', for: '7d', title: ask.content.spec.what, kind: 'alert', severity: 'critical' })).status, 'ok');
    assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { done: true })).status, 200);
    const done = await wait('the run to end', async () => { const t = await thread(); return t.running ? undefined : t.messages; });
    const said = JSON.parse(bodies.at(-1).messages.findLast((m: any) => m.role === 'tool').content);
    assert.equal(said.hidden, true);
    assert.equal(said.forGood, false);
    assert.ok(Date.parse(said.until) > Date.now() + 6 * 86400_000);
    assert.equal(done.find((m) => m.id === ask.id)!.content.state, 'answered');
    assert.equal(get<{ by: string }>(app.db, 'SELECT by FROM snoozes WHERE key = ?', 'down:shop.example.com')!.by, 'Sam', 'hidden by the person');
    assert.deepEqual((await tool('map.get')).output.issues.map((i: any) => i.key), ['dns:domain:api.example.com:unit7:svc_api'], 'off the Map');

    // something Unit7 doesn't know: no card, and the AI is told to re-check instead
    call = { name: 'ui_hide', arguments: { key: 'down:nothing.example.com' } };
    const c2 = (await sam('POST', '/api/agent/conversations', { message: 'clear it' })).body.conversationId;
    await wait('the second run', async () => { const t = (await sam('GET', `/api/agent/conversations/${c2}`)).body; return t.running ? undefined : t; });
    const res = JSON.parse(bodies.at(-1).messages.findLast((m: any) => m.role === 'tool').content);
    assert.equal(res.code, 'not_found');
    assert.match(res.error, /alert_recheck/);
  } finally { close(); }
});
