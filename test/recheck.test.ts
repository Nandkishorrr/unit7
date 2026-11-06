// Alerts that go away when the thing is fixed: a fix rechecks just what it touched (no full sync) and says verified
// { fixed, still }; "Check again" re-runs one alert's check; server.routes reads which app answers a name, read-only at
// every level; the brains are told never to say "fixed" on a guess; every alert gets a way forward. All offline:
// a fake hosting account (its own scanner), Unit7's own app and domain, a fake SSH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { account } from './clouds-fakes.ts';
import { all, get, id, run } from '../src/db.ts';
import { SCANNERS } from '../src/discovery/scanners.ts';
import { INSTRUCTIONS } from '../src/mcp/server.ts';
import { ASK_RULES } from '../src/agent/asks.ts';
import { resolveIncidents, routesFrom, targetsOf } from '../src/tools/recheck.ts';
import { alertActions, askFallback, taskCheck } from '../web/src/lib/alertActions.ts';

// a hosting account whose apps can have shop.example.net added; its DNS (also here) points the name at it
const host = { apps: ['a1'] as string[], scans: 0 };
SCANNERS.testhost = async (_ctx, acc) => {
  host.scans++;
  return {
    found: [...host.apps.map((x) => ({ provider: 'testhost', kind: 'app' as const, extId: x, name: `shop-${x}`, accountId: acc, hosts: ['shop.example.net'], platform: 'vercel' })),
      { provider: 'domain', kind: 'domain' as const, extId: 'shop.example.net', name: 'shop.example.net', accountId: acc, dns: 'testhost', zone: 'example.net' }],
    refs: [...host.apps.map((x) => ({ from: `testhost:${x}`, kind: 'domain' as const, via: 'added on testhost', host: 'shop.example.net' })),
      { from: 'domain:shop.example.net', kind: 'dns' as const, via: 'A 76.76.21.21', ip: '76.76.21.21' }],
  };
};
// an account the alert has nothing to do with: a recheck never scans it
let others = 0;
SCANNERS.testother = async () => { others++; return { found: [], refs: [] }; };

async function estate() {
  const app = testApp(), o = await testOrg(app);
  host.apps = ['a1']; host.scans = 0; others = 0;
  const acc = account(app, o.orgId, 'testhost', 'tok-1', 'Sam’s host');
  account(app, o.orgId, 'testother', 'tok-2', 'Elsewhere');
  // Unit7 serves the same name for one of its own apps: the name is added to two apps
  const p = ok(await o.h('project.create', { name: 'shop', environments: ['production'] }));
  const svc = id('svc'), dom = id('dom');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, status) VALUES (?, ?, ?, ?, 'shop-old', 'shop-old', 'app', 'healthy')`, svc, o.orgId, p.projectId, p.environments[0].id);
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls) VALUES (?, ?, 'shop.example.net', ?, 'active', 'active')`, dom, o.orgId, svc);
  ok(await o.h('sync.run'));
  return { app, o, acc, dom };
}
const issues = async (o: Awaited<ReturnType<typeof testOrg>>) => (ok(await o.h('map.get')).issues as { key: string; text: string }[]);
const syncs = (app: ReturnType<typeof testApp>, orgId: string) => get<{ n: number }>(app.db, 'SELECT count(*) n FROM sync_runs WHERE org_id = ?', orgId)!.n;

test('a fix clears its issue at once, without a sync, and says verified: fixed', async () => {
  const { app, o, dom } = await estate();
  assert.ok((await issues(o)).some((i) => i.key === 'dup:domain:shop.example.net'), 'added to two apps');
  const before = syncs(app, o.orgId), scans = host.scans;

  // the fix: Unit7 stops serving the name for its old app
  const r = ok(await o.h('domain.remove', { domainId: dom }));
  assert.equal(r.removed, 'shop.example.net');
  assert.equal(r.verified.fixed, true, JSON.stringify(r.verified));
  assert.ok(r.verified.cleared.some((t: string) => /added to 2 apps/.test(t)));
  assert.ok(!(await issues(o)).some((i) => i.key.startsWith('dup:')), 'gone from the map right away');
  assert.equal(syncs(app, o.orgId), before, 'no new sync: the last result was rewritten in place');
  assert.equal(host.scans, scans + 1, 'only the account that holds the name was scanned again');
  assert.equal(others, 1, 'the unrelated account was not');
  const cleared = all<{ message: string }>(app.db, `SELECT message FROM events WHERE org_id = ? AND type = 'alert.cleared'`, o.orgId);
  assert.ok(cleared.some((e) => /^Cleared: shop\.example\.net is added to 2 apps/.test(e.message)), 'Activity says Cleared');
});

test('a fix the check still sees through says so: verified fixed false, with why', async () => {
  const { o, dom } = await estate();
  host.apps = ['a1', 'a2']; // meanwhile a second hosted app took the name too
  ok(await o.h('alert.recheck', { key: 'dup:domain:shop.example.net' }));
  const r = ok(await o.h('domain.remove', { domainId: dom }));
  assert.equal(r.verified.fixed, false);
  assert.match(r.verified.still, /shop\.example\.net is added to 2 apps \(shop-a1, shop-a2\)/);
});

test('"Check again" re-runs one alert’s check, read-only, at any level, and clears it when it’s gone', async () => {
  const { app, o } = await estate();
  const before = syncs(app, o.orgId), otherScans = others;
  // still there: says why
  const still = ok(await o.h('alert.recheck', { key: 'dup:domain:shop.example.net' }));
  assert.equal(still.fixed, false);
  assert.match(still.still, /added to 2 apps/);
  // fixed outside Unit7 (the name came off the hosted app): Check again sees it, and the map follows
  host.apps = [];
  run(app.db, 'UPDATE orgs SET autonomy = 0 WHERE id = ?', o.orgId);
  const r = await o.a('alert.recheck', { key: 'dup:domain:shop.example.net' });
  assert.equal(r.status, 'ok', 'a read: no approval even at Watch only');
  assert.equal((r as any).output.fixed, true);
  assert.ok(!(await issues(o)).some((i) => i.key.startsWith('dup:')));
  assert.equal(syncs(app, o.orgId), before, 'no full sync');
  assert.equal(others, otherScans, 'only what the alert is about');
  assert.equal(get(app.db, `SELECT 1 FROM approvals WHERE org_id = ?`, o.orgId), undefined);
});

test('what a change touched: ids, hostnames, URLs and a record named relative to its zone', async () => {
  const { app, o, acc, dom } = await estate();
  const t = targetsOf(app.db, o.orgId, { zone: 'example.net', name: 'shop', type: 'A' });
  assert.ok(t.hosts.has('shop.example.net') && t.accounts.has(acc) && t.unit7);
  const u = targetsOf(app.db, o.orgId, { domainId: dom, url: 'https://shop.example.net/path' });
  assert.deepEqual([...u.hosts], ['shop.example.net']);
  assert.equal(targetsOf(app.db, o.orgId, { op: 'list', kind: 'application' }).hosts.size, 0);
});

// --- server.routes ----------------------------------------------------------------------------------------------
const PROBE_OUT = [
  '', '@@unit7:caddy', '', '@@unit7:traefik',
  '##/data/coolify/proxy/dynamic/old-test.yaml',
  'http:', '  routers:', '    old-test:', '      rule: Host(`test.example.com`)', '      service: old-test',
  '  services:', '    old-test:', '      loadBalancer:', '        servers:', "          - url: 'http://old-test-app:3000'",
  '@@unit7:nginx', '', '@@unit7:labels',
  `/web-abc123\t${JSON.stringify({ 'coolify.managed': 'true', 'coolify.type': 'application', 'coolify.applicationId': '7', 'coolify.name': 'shop-web', 'traefik.http.routers.http-0-web.rule': 'Host(`api.example.com`)' })}`,
  '',
].join('\n');

test('server.routes finds a Traefik route for a name, says it reaches nothing running, and is a read at every level', async () => {
  const app = testApp(), o = await testOrg(app);
  const calls: string[] = [];
  app.services.ssh = { exec: async (_s: unknown, cmd: string, opt: { stdin?: string }) => { calls.push(opt?.stdin?.includes('@@unit7') || opt?.stdin?.includes('s labels') ? 'probe' : cmd); return { code: 0, stdout: opt?.stdin?.includes('s labels') ? PROBE_OUT : '', stderr: '' }; } };
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready')`, srv, o.orgId);
  for (const level of [0, 1, 2, 3, 4]) {
    run(app.db, 'UPDATE orgs SET autonomy = ? WHERE id = ?', level, o.orgId);
    const r = await o.a('server.routes', { serverId: srv, host: 'test.example.com' });
    assert.equal(r.status, 'ok', `level ${level}: ${JSON.stringify(r)}`);
    const out = (r as any).output;
    assert.equal(out.routes.length, 1);
    assert.deepEqual({ host: out.routes[0].host, via: out.routes[0].via, file: out.routes[0].file, live: out.routes[0].live }, { host: 'test.example.com', via: 'a Traefik file on the server', file: '/data/coolify/proxy/dynamic/old-test.yaml', live: false });
    assert.match(out.answer, /has a route on box, but it reaches nothing running/);
    assert.match(out.routes[0].ask, /Remove that route/);
  }
  assert.equal(get(app.db, 'SELECT 1 FROM approvals WHERE org_id = ?', o.orgId), undefined, 'never an approval');
  // the labels too: a Coolify app answers api.example.com
  const all_ = ok(await o.h('server.routes', { serverId: srv }));
  const api = all_.routes.find((x: any) => x.host === 'api.example.com');
  assert.deepEqual({ via: api.via, live: api.live, name: api.serves.name }, { via: 'Coolify', live: true, name: 'shop-web' });
});

test('a route nobody needs gets its fix: off the Coolify app (with undo), or the Unit7 route', () => {
  const inv = { parts: [{ id: 'coolify:u1', kind: 'app', name: 'shop-web', owner: 'coolify', trust: 'managed', containers: ['web-abc123'], hosts: ['api.example.com', 'test.example.com'], coolify: { uuid: 'u1', type: 'application', labels: 'uuid' } }], ports: [] } as never;
  const out = PROBE_OUT.replace('api.example.com`)', 'api.example.com`) || Host(`test.example.com`)');
  const r = routesFrom(out, { serverId: 'srv_1', serverName: 'box', inv, coolifyConnected: true, unit7: [{ host: 'old.example.com', service: 'shop-old', domainId: 'dom_1' }] });
  const test_ = r.find((x) => x.host === 'test.example.com' && x.via === 'Coolify')!;
  assert.deepEqual(test_.fix?.input, { serverId: 'srv_1', uuid: 'u1', domains: ['api.example.com'], replace: true });
  assert.equal(test_.fix?.label, 'Remove the old route');
  assert.deepEqual(test_.fix?.undo?.input, { serverId: 'srv_1', uuid: 'u1', domains: ['api.example.com', 'test.example.com'], replace: true });
  assert.deepEqual(r.find((x) => x.host === 'old.example.com')?.fix?.input, { domainId: 'dom_1' });
});

// --- the brains, and every alert's way forward ----------------------------------------------------------------------
test('the brief tells every brain to check before saying fixed', () => {
  const rule = "After a fix, re-check with the matching read tool before saying it's fixed. If the check still shows the problem, say so plainly and offer the next fix. Never say 'fixed' on a guess.";
  assert.ok(INSTRUCTIONS.includes(rule) && ASK_RULES.includes(rule));
  assert.match(INSTRUCTIONS, /server_routes/);
  assert.match(INSTRUCTIONS, /never server_exec/);
});

test('an alert with no fix still gets "Check again" and "Ask Unit7 to fix it"; one with a real fix gets no ask', () => {
  const bare = alertActions({ text: 'shop.example.com is slow (4200 ms).' });
  assert.deepEqual(bare.map((a) => a.kind), ['check', 'ask']);
  assert.equal((bare[1] as { prompt: string }).prompt, askFallback('shop.example.com is slow (4200 ms).'));
  assert.match((bare[1] as { prompt: string }).prompt, /^shop\.example\.com is slow \(4200 ms\)\. Fix it for me: show me what changes first, and check afterwards that it’s gone\.$/);
  const fixable = alertActions({ text: 'x', fix: { tool: 'domain.protect_email', input: { domain: 'example.com' }, label: 'Protect it' } });
  assert.deepEqual(fixable.map((a) => a.kind), ['fix', 'check']);
  const look = alertActions({ text: 'x', fix: [{ tool: 'server.routes', input: {}, label: 'Find the old route', look: true }], open: { label: 'Reconnect', href: '/connections' } });
  assert.deepEqual(look.map((a) => a.kind), ['fix', 'open', 'check', 'ask'], 'a look is not a fix: Unit7 is offered too');
  assert.deepEqual(taskCheck({ id: 'site:down:shop.example.com', about: { kind: 'app', id: 'ast_1' } }), { key: 'down:shop.example.com', about: 'ast_1' });
  assert.deepEqual(taskCheck({ id: 'risk:server:port:srv_9:5432' }), { key: 'server:port:srv_9:5432', serverId: 'srv_9' });
  assert.deepEqual(taskCheck({ id: 'watch:srv_9:mem:web' }), { key: 'mem:web', serverId: 'srv_9' });
  assert.equal(taskCheck({ id: 'budget' }), undefined);
});

test('an incident closes when every alert behind it cleared, and Activity says so', async () => {
  const app = testApp(), o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'k', 'ready')`, srv, o.orgId);
  run(app.db, `INSERT INTO incidents (id, org_id, title, status, severity) VALUES ('inc_1', ?, 'Memory keeps climbing on box', 'investigated', 'warning')`, o.orgId);
  run(app.db, `INSERT INTO watch_alerts (id, org_id, server_id, source, key, severity, title, data, first_at, last_at, incident_id) VALUES ('wal_1', ?, ?, 'usage', 'leak:web', 'critical', 't', '{}', '2026-10-08', '2026-10-08', 'inc_1')`, o.orgId, srv);
  assert.equal(resolveIncidents(app, o.orgId), 0, 'its alert is still open');
  run(app.db, `UPDATE watch_alerts SET cleared_at = '2026-10-08T01:00:00Z' WHERE id = 'wal_1'`);
  assert.equal(resolveIncidents(app, o.orgId), 1);
  assert.equal(get<{ status: string }>(app.db, `SELECT status FROM incidents WHERE id = 'inc_1'`)!.status, 'resolved');
  assert.ok(get(app.db, `SELECT 1 FROM events WHERE type = 'alert.cleared' AND message = 'Cleared: Memory keeps climbing on box'`));
});
