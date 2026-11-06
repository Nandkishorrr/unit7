// "In use": visitors aren't the only sign. An API other servers call, an app that reaches it, data going in and out:
// Clean up never lists it, and says why. A person's "it's in use / important" mark keeps it off Clean up and the savings
// ideas for good, shows on the map, reaches the AI's brief, and makes an AI ask before changing it in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testApp, testOrg, ok, setAutonomy } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { assetIdOf } from '../src/archive.ts';
import { importantTouched } from '../src/kept.ts';
import { analyze, type Hit } from '../src/sentinel/traffic.ts';
import { savingsFor } from '../src/care/radar.ts';
import { graph } from '../src/tools/core.ts';
import { INSTRUCTIONS } from '../src/mcp/server.ts';
import type { Inventory, Part } from '../src/discovery/xray.ts';

type Org = Awaited<ReturnType<typeof testOrg>>;
const DAY = 86400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const LINE = 'Things marked important are in use even without visitors; never suggest archiving or deleting them, and take extra care before changing them.';

// one server with four Coolify projects, each one app: an API other servers call (no people), an API another app on the
// server reaches, a worker that only moves data, and a toy nobody touched in four months
async function box() {
  const app = testApp();
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready')`, srv, o.orgId);
  const old = { at: ago(120 * DAY), status: 'finished' };
  const part = (name: string, extra: Partial<Part> = {}): Part => ({ id: `c:${name}`, kind: 'app', name, owner: 'coolify', trust: 'seen', project: name, hosts: [`${name}.example.com`], coolify: { uuid: `u-${name}`, type: 'application', labels: 'uuid', lastDeploy: old }, ...extra });
  const parts = [part('api'), part('api2'), part('worker'), part('toy'), part('web', { uses: ['c:api2'], coolify: { uuid: 'u-web', type: 'application', labels: 'uuid', lastDeploy: { at: ago(2 * DAY) } } })];
  const inv: Inventory = { version: 1, at: ago(0), server: {}, paas: [], loose: [], ports: [], repos: [], summary: '', notes: [],
    projects: parts.map((p) => ({ id: p.name, name: p.name, owner: 'coolify', trust: 'seen', how: 'Coolify labels', confidence: 1, parts: [p.id], health: { status: 'ok' }, domains: [], coolify: { uuid: `p-${p.name}` } })), parts };
  run(app.db, `INSERT INTO xrays (id, org_id, server_id, kind, ok, data) VALUES (?, ?, ?, 'fast', 1, ?)`, id('xry'), o.orgId, srv, JSON.stringify(inv));
  const keys: Record<string, string> = {};
  for (const p of parts) {
    keys[p.name] = assetIdOf(o.orgId, `coolify:${srv}/p/${p.name}`);
    run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, 'coolify', 'project', ?, ?, ?, ?)`, keys[p.name]!, o.orgId, `${srv}/p/${p.name}`, p.name,
      JSON.stringify({ server: `unit7:${srv}`, owner: 'coolify', parts: [`coolify:${srv}/${p.id}`], hosts: p.hosts }), ago(0));
    run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, 'coolify', 'app', ?, ?, ?, ?)`, assetIdOf(o.orgId, `coolify:${srv}/${p.id}`), o.orgId, `${srv}/${p.id}`, p.name,
      JSON.stringify({ server: `unit7:${srv}`, owner: 'coolify', project: `coolify:${srv}/p/${p.name}`, hosts: p.hosts }), ago(0));
  }
  // the server's access log, read an hour ago: the API answered 40 calls from programs, nobody visited the others
  const summary = { hosts: [{ host: 'api.example.com', n: 52, s5xx: 0 }, { host: 'scan.example.org', n: 9, s5xx: 0 }], errors: [],
    callers: [{ host: 'api.example.com', people: 0, programs: 40, api: 5 }] };
  run(app.db, `INSERT INTO traffic_windows (id, org_id, server_id, at, minutes, summary) VALUES (?, ?, ?, ?, 30, ?)`, id('trw'), o.orgId, srv, ago(3600_000), JSON.stringify(summary));
  // the worker sends and receives data (5 KB a second over the last hour)
  run(app.db, `INSERT INTO usage_points (org_id, server_id, scope, name, res, at, net, net_max) VALUES (?, ?, 'worker', 'worker', '1h', ?, 5000, 9000)`, o.orgId, srv, ago(2 * 3600_000));
  return { app, o, srv, keys };
}

test('the access log says who calls a site: people, programs and other servers, API paths; scanners and failures don’t count', () => {
  const now = Date.now();
  const hit = (h: Partial<Hit>): Hit => ({ at: now - 60_000, ip: '198.51.100.7', method: 'GET', path: '/', status: 200, ...h });
  const s = analyze([
    hit({ host: 'shop.example.com', ua: 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605' }),
    hit({ host: 'api.example.com', path: '/api/orders?token=x', ua: 'node-fetch/1.0' }),
    hit({ host: 'api.example.com', path: '/v1/health', method: 'POST' }), // no user agent: a program
    hit({ host: 'api.example.com', path: '/api/me', ua: 'Mozilla/5.0 Chrome/129' }), // the site's own page calling its API
    hit({ host: 'api.example.com', path: '/.env', ua: 'curl/8' }),       // a scanner: not a caller
    hit({ host: 'api.example.com', path: '/api/orders', status: 404, ua: 'python-requests/2' }), // didn't answer
  ], { minutes: 30, anonKnown: false, now });
  assert.deepEqual(Object.fromEntries((s.callers ?? []).map((c) => [c.host, [c.people, c.programs, c.api]])), { 'shop.example.com': [1, 0, 0], 'api.example.com': [0, 2, 1] });
});

test('Clean up: an API only other servers call, one another app reaches, a worker moving data: in use; the idle one is listed with why', async () => {
  const { o, keys } = await box();
  const r = ok(await o.h('asset.cleanup'));
  assert.deepEqual(r.items.map((x: any) => x.name), ['toy'], 'only the toy');
  // each looked quiet by visitors and deploys alone (the old rules listed them): left out, and the list says why
  assert.deepEqual(r.left.map((x: any) => [x.name, x.why]), [
    ['api', 'It’s in use: 45 calls from other servers, apps or scripts in the last 7 days.'], ['api2', 'It’s in use: used by web.'],
    ['web', 'It’s in use: last deploy 2 days ago.'], ['worker', 'It’s in use: sends and receives data.']]);
  const toy = r.items[0];
  assert.equal(toy.why, 'No visitors and no other app uses it, last deploy 4 months ago.');
  assert.deepEqual(toy.reasons, [`No deploy since ${new Date(Date.now() - 120 * DAY).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`, 'No visitors in the last 7 days', 'No domain of yours points at it']);

  // why each one isn't listed, when asked
  const api = ok(await o.h('asset.usage', { key: keys.api }));
  assert.equal(api.inUse, true);
  assert.equal(api.listed, false);
  assert.equal(api.why, 'It’s in use: 45 calls from other servers, apps or scripts in the last 7 days.');
  assert.deepEqual(api.pulse, { label: 'Used', at: api.signals[0].at, detail: ['45 calls from other servers, apps or scripts in the last 7 days'] }, 'its signs of use, not the old deploy');
  assert.match(ok(await o.h('asset.usage', { key: keys.api2 })).why, /^It’s in use: used by web\.$/);
  assert.match(ok(await o.h('asset.usage', { key: keys.worker })).why, /^It’s in use: sends and receives data\.$/);
  assert.equal(ok(await o.h('asset.usage', { key: keys.toy })).listed, true);
  // the web app deployed two days ago: in use (work on it), and its card says so
  const web = ok(await o.h('asset.usage', { key: keys.web }));
  assert.equal(web.pulse.label, 'Deployed');

  // the cards' pulse: nothing for the toy (nothing known says it's used), a line for the rest
  const p = ok(await o.h('asset.pulse')).pulse;
  assert.equal(p[keys.api!].label, 'Used');
  assert.deepEqual([p[keys.api2!].label, p[keys.api2!].by], ['Used', 1]);
  assert.equal(p[keys.toy!], undefined);
});

test('“It’s in use” and “important”: off Clean up for good, marked on the map, with undo; an AI asks a person first, either way', async () => {
  const { app, o, srv, keys } = await box();
  const toy = keys.toy!;
  const r = ok(await o.h('asset.keep', { key: toy }));
  assert.equal(r.kept, true);
  assert.equal(r.important, false);
  assert.deepEqual(r.undo, { tool: 'asset.keep', input: { key: toy, kept: false } });
  assert.deepEqual(ok(await o.h('asset.cleanup')).items, [], 'never suggested again');
  assert.equal(ok(await o.h('asset.usage', { key: toy })).why, 'You said it’s in use, so Unit7 doesn’t suggest it.');

  // the AI: marking it important, or taking the mark off, waits for a person
  const asked = await o.a('asset.keep', { key: toy, important: true });
  assert.equal(asked.status, 'approval_required');
  assert.equal((await o.a('asset.keep', { key: toy, kept: false })).status, 'approval_required');
  assert.equal(get<{ important: number }>(app.db, 'SELECT important FROM kept WHERE key = ?', toy)!.important, 0, 'nothing changed yet');

  // the person marks it important: the map shows it on the project and on the app inside it
  const imp = ok(await o.h('asset.keep', { key: toy, important: true, note: 'called by the billing server' }));
  assert.deepEqual(imp.undo, { tool: 'asset.keep', input: { key: toy, important: false } });
  const m = ok(await o.h('map.get'));
  const of = (k: string) => m.assets.find((a: any) => a.id === k);
  assert.deepEqual([of(toy).kept, of(toy).important], [true, true]);
  assert.deepEqual([of(assetIdOf(o.orgId, `coolify:${srv}/c:toy`)).kept, of(assetIdOf(o.orgId, `coolify:${srv}/c:toy`)).important], [true, true]);
  assert.equal(of(keys.api!).kept, undefined);
  const u = ok(await o.h('asset.usage', { key: toy }));
  assert.deepEqual([u.important, u.note], [true, 'called by the billing server']);
  assert.match(u.why, /^You marked it important/);
  // the delete pop-up says so first
  assert.deepEqual(ok(await o.h('asset.impact', { key: toy })).use, { kept: true, important: true, signs: [] });

  // and taking it off brings it back to Clean up
  ok(await o.h('asset.keep', { key: toy, kept: false }));
  assert.deepEqual(ok(await o.h('asset.cleanup')).items.map((x: any) => x.key), [toy]);
});

async function ledger(app: App, o: Org, name: string, envs = ['production']) {
  const p = ok(await o.h('project.create', { name, environments: envs }));
  const svcs = p.environments.map((e: any) => { const s = id('svc'); run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, status) VALUES (?, ?, ?, ?, ?, ?, 'app', 'healthy')`, s, o.orgId, p.projectId, e.id, `${name}-${e.kind}`, `${name}-${e.kind}`.toLowerCase()); return s; });
  const kinds: string[] = p.environments.map((e: any) => e.kind);
  return { projectId: p.projectId as string, envs: p.environments.map((e: any) => e.id as string), svcs: svcs as string[], of: (k: string) => ({ env: p.environments[kinds.indexOf(k)].id as string, svc: svcs[kinds.indexOf(k)] as string }) };
}

test('the savings ideas skip a project marked in use or with a sign of use (a scheduled job)', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const at = Date.now();
  const idle = async (name: string) => {
    const l = await ledger(app, o, name);
    run(app.db, 'UPDATE projects SET created_at = ? WHERE id = ?', ago(200 * DAY), l.projectId);
    run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, started_at, finished_at) VALUES (?, ?, ?, 1, 'live', ?, ?)`, id('dep'), o.orgId, l.svcs[0]!, ago(120 * DAY), ago(120 * DAY));
    return l;
  };
  const a = await idle('Alpha'), b = await idle('Beta'), c = await idle('Gamma');
  run(app.db, `INSERT INTO jobs (id, org_id, service_id, name, schedule, command, last_run_at) VALUES (?, ?, ?, 'nightly', '0 3 * * *', 'node sync.js', ?)`, id('job'), o.orgId, c.svcs[0]!, ago(DAY));
  ok(await o.h('asset.keep', { key: b.projectId }));
  const ideas = savingsFor(app.db, o.orgId, at, { share: new Map(), priced: [] }).filter((s) => s.kind === 'idle').map((s) => s.id);
  assert.deepEqual(ideas, [`idle:${a.projectId}`], 'only Alpha: Beta is marked in use, Gamma runs a nightly job');
  // and Clean up agrees
  assert.deepEqual(ok(await o.h('asset.cleanup')).items.map((x: any) => x.name), ['Alpha']);
  assert.equal(ok(await o.h('asset.usage', { key: c.projectId })).why, 'It’s in use: runs a scheduled job.');
});

test('important production: an AI asks a person before changing it, even on Full autopilot; restarts-level healing, people and test copies are as before', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const imp = await ledger(app, o, 'Ledger', ['staging', 'production']);
  const other = await ledger(app, o, 'Other');
  const stagingSvc = imp.of('staging').svc, prodSvc = imp.of('production').svc;
  ok(await o.h('asset.keep', { key: imp.projectId, important: true }));
  // graph.get and the brief show it to the AI
  assert.equal(graph({ db: app.db, orgId: o.orgId }).projects.find((p: any) => p.id === imp.projectId)!.important, true);
  assert.ok(INSTRUCTIONS.includes(LINE), 'the MCP brief (and so the Claude/Gemini brief) says it');
  assert.ok(readFileSync(new URL('../src/agent/brain.ts', import.meta.url), 'utf8').includes(LINE), 'the API-key brain’s brief says it');

  const set = (svc: string) => o.a('env.set', { serviceId: svc, key: 'FEATURE_X', value: 'on' });
  assert.equal((await set(other.svcs[0]!)).status, 'ok', 'a change an AI may make in production…');
  const r = await set(prodSvc);
  assert.equal(r.status, 'approval_required', '…waits for a person on the important one');
  assert.match((r as { why: string }).why, /Ledger-production is marked important, so an AI asks a person before changing it/);
  setAutonomy(app, imp.of('production').env, 4);
  assert.equal((await set(prodSvc)).status, 'approval_required', 'even on Full autopilot');
  assert.equal((await o.a('env.set', { environmentId: imp.of('production').env, key: 'FEATURE_Y', value: 'on' })).status, 'approval_required', 'its production environment too');
  assert.equal((await set(stagingSvc)).status, 'ok', 'its test copy is as before');
  assert.equal((await o.h('env.set', { serviceId: prodSvc, key: 'FEATURE_X', value: 'on' })).status, 'ok', 'a person is as before');

  // what the gate recognises: a part on a server or its Coolify id, a map item by key
  const { o: o2, app: app2, srv, keys } = await box();
  ok(await o2.h('asset.keep', { key: keys.api!, important: true }));
  assert.equal(importantTouched(app2.db, o2.orgId, { serverId: srv, part: 'c:api' }), 'api');
  assert.equal(importantTouched(app2.db, o2.orgId, { serverId: srv, uuid: 'u-api' }), 'api');
  assert.equal(importantTouched(app2.db, o2.orgId, { key: keys.api }), 'api');
  assert.equal(importantTouched(app2.db, o2.orgId, { serverId: srv, part: 'c:toy' }), undefined);
  const archive = await o2.a('asset.archive', { key: keys.api! });
  assert.equal(archive.status, 'approval_required');
  assert.match((archive as { why: string }).why, /^api is marked important/);
  // healing that comes back by itself (a restart: easy to undo) isn't held up
  const restart = await o.a('service.restart', { serviceId: prodSvc });
  assert.notEqual(restart.status, 'approval_required', JSON.stringify(restart));
});

test('Home’s “no visitors, stop it?” leaves out a test copy the person marked in use', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { suggestions } = await import('../src/suggestions.ts');
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready')`, srv, o.orgId);
  const l = await ledger(app, o, 'Hooks', ['staging']);
  const svc = l.of('staging').svc, dep = id('dep');
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, started_at, finished_at) VALUES (?, ?, ?, 1, 'live', ?, ?)`, dep, o.orgId, svc, ago(3 * DAY), ago(3 * DAY));
  run(app.db, 'UPDATE services SET server_id = ?, current_deployment_id = ? WHERE id = ?', srv, dep, svc);
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls) VALUES (?, ?, 'hooks.example.com', ?, 'active', 'active')`, id('dom'), o.orgId, svc);
  // Warden watched the whole two days (a sample a minute)
  for (let i = 0; i < 2900; i++) run(app.db, 'INSERT INTO metrics (server_id, at) VALUES (?, ?)', srv, ago(i * 59_000));
  assert.ok(suggestions(app, o.orgId).some((s) => s.id === `idle:${svc}`), 'no visitors in two days: stop it?');
  ok(await o.h('asset.keep', { key: l.projectId }));
  assert.ok(!suggestions(app, o.orgId).some((s) => s.id === `idle:${svc}`), 'the person said it’s in use (a webhook receiver nobody visits)');
});
