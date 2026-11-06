// Archive, impact and delete: an archived thing leaves the map and Unit7 stops watching, suggesting and finding things
// about it; the impact names the domains, wiring and data; delete calls the provider's own endpoint, only for a person
// who typed the exact name, and never takes data unless asked. Providers are fakes (fetch, and a stand-in Coolify).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { assetIdOf, touchesArchived } from '../src/archive.ts';
import { targets } from '../src/sentinel/watch.ts';
import { suggestions } from '../src/suggestions.ts';
import { serverFindings } from '../src/discovery/findings.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { CURL } from '../src/connectors/coolify.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import type { Inventory } from '../src/discovery/xray.ts';

type Org = Awaited<ReturnType<typeof testOrg>>;
const online = (host: string) => lookup(host).then(() => true, () => false);

function account(app: App, o: Org, provider: string, slug: string, meta: object = {}) {
  const acc = id('acc');
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status) VALUES (?, ?, ?, ?, ?, ?, 'verified')`, acc, o.orgId, provider, `${provider} ${slug}`, slug, JSON.stringify(meta));
  app.vault.put(o.orgId, `credential://${provider}/${slug}/token`, `${provider}-test-token-123`, { kind: 'api_token', accountId: acc });
  return acc;
}
function asset(app: App, o: Org, f: { provider: string; kind: string; extId: string; name: string; url?: string; accountId?: string; meta?: object }) {
  const aid = assetIdOf(o.orgId, `${f.provider}:${f.extId}`);
  run(app.db, `INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    aid, o.orgId, f.accountId ?? null, f.provider, f.kind, f.extId, f.name, f.url ?? null, JSON.stringify(f.meta ?? {}), new Date().toISOString());
  return aid;
}
const edge = (app: App, o: Org, source: string, target: string, kind: string, via: string) =>
  run(app.db, `INSERT INTO edges (id, org_id, source, target, kind, via, status) VALUES (?, ?, ?, ?, ?, ?, 'ok')`, id('edg'), o.orgId, source, target, kind, via);

// a shop: its site on Vercel (shop.example.com points at it), its Neon database, wired by DATABASE_URL
async function shop() {
  const app = testApp();
  const o = await testOrg(app);
  const vAcc = account(app, o, 'vercel', 'sam'), nAcc = account(app, o, 'neon', 'sam');
  const site = asset(app, o, { provider: 'vercel', kind: 'app', extId: 'prj_v1', name: 'shop-site', url: 'https://shop.example.com', accountId: vAcc, meta: { hosts: ['shop.example.com', 'shop-site.vercel.app'], end: { kind: 'vercel', accountId: vAcc, project: 'prj_v1', team: 'team_1' }, platform: 'vercel' } });
  const db = asset(app, o, { provider: 'neon', kind: 'database', extId: 'np-1', name: 'shop-db', accountId: nAcc, meta: { end: { kind: 'neon', accountId: nAcc, project: 'np-1' } } });
  const dom = asset(app, o, { provider: 'domain', kind: 'domain', extId: 'shop.example.com', name: 'shop.example.com', meta: { zone: 'example.com', dns: 'cloudflare' } });
  edge(app, o, dom, site, 'domain', 'added on Vercel');
  edge(app, o, site, db, 'env', 'DATABASE_URL');
  return { app, o, vAcc, nAcc, site, db, dom };
}

function fakeFetch(answer: (method: string, url: string, body: any) => unknown = () => ({})) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined, method = init.method ?? 'GET';
    calls.push({ method, url, body });
    const a = answer(method, url, body);
    if (a instanceof Response) return a;
    return method === 'DELETE' && a === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(a ?? {}), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('archived: off the map (unless asked), not watched, no suggestions, no findings; Warden leaves it alone', async () => {
  const { app, o, site, dom } = await shop();
  const before = ok(await o.h('map.get'));
  assert.ok(before.assets.some((a: any) => a.id === site));
  assert.ok(targets(app, o.orgId).some((t) => t.host === 'shop.example.com'));

  const r = ok(await o.h('asset.archive', { key: site }));
  assert.match(r.note, /won’t watch, alert on or change it\. It keeps running where it is/);
  const m = ok(await o.h('map.get'));
  assert.ok(!m.assets.some((a: any) => a.id === site), 'left out of the map');
  assert.ok(!m.edges.some((e: any) => e.target === site || e.source === site), 'and its lines');
  assert.ok(m.assets.some((a: any) => a.id === dom), 'the domain itself stays on the map');
  const all_ = ok(await o.h('map.get', { includeArchived: true }));
  assert.equal(all_.assets.find((a: any) => a.id === site).archived, true, 'shown and marked when asked');
  assert.ok(!targets(app, o.orgId).some((t) => t.asset === site), 'Watch stops checking it');
  assert.deepEqual(ok(await o.h('asset.archived')).map((x: any) => [x.key, x.name, x.onMap]), [[site, 'shop-site', true]]);
  // a connection Unit7 made to it isn't re-synced or rotated by Warden
  const vAcc = get<{ id: string }>(app.db, `SELECT id FROM accounts WHERE provider = 'vercel'`)!.id, lnk = id('lnk');
  run(app.db, `INSERT INTO links (id, org_id, source, target) VALUES (?, ?, ?, ?)`, lnk, o.orgId, JSON.stringify({ kind: 'supabase', accountId: 'acc_x', ref: 'r' }), JSON.stringify({ team: 'team_1', kind: 'vercel', project: 'prj_v1', accountId: vAcc }));
  assert.ok(touchesArchived(app.db, o.orgId, { linkId: lnk }), 'its connection is left alone too');

  // a Unit7 project: its database without backups is a suggestion, until the project is archived
  const env = ok(await o.h('project.create', { name: 'Ledger', environments: ['production'] }));
  const svc = id('svc');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind) VALUES (?, ?, ?, ?, 'ledger-db', 'ledger-db', 'postgres')`, svc, o.orgId, env.projectId, env.environments[0].id);
  assert.ok(suggestions(app, o.orgId).some((s) => s.id === `backup:${svc}`));
  ok(await o.h('asset.archive', { key: env.projectId }));
  assert.ok(!suggestions(app, o.orgId).some((s) => JSON.stringify(s).includes(svc)), 'no suggestions about it');
  assert.ok(touchesArchived(app.db, o.orgId, { serviceId: svc }), 'Warden skips its reflexes and background changes');
  assert.ok(!touchesArchived(app.db, o.orgId, { serviceId: 'svc_other1234567' }));

  // something the X-ray found on a server: an open database is a finding, until its project is archived
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready')`, srv, o.orgId);
  const inv: Inventory = { version: 1, at: new Date().toISOString(), server: {}, paas: [], loose: [], ports: [], repos: [], summary: '', notes: [],
    projects: [{ id: 'shop', name: 'shop', owner: 'compose', trust: 'seen', how: 'Docker Compose labels', confidence: 1, parts: ['c:shop-db'], health: { status: 'ok' }, domains: [] }],
    parts: [{ id: 'c:shop-db', kind: 'database', name: 'shop-db', owner: 'compose', trust: 'seen', project: 'shop', engine: 'postgres', exposed: true, ports: [{ port: 5432, proto: 'tcp', ip: '0.0.0.0', public: true }] }] };
  run(app.db, `INSERT INTO xrays (id, org_id, server_id, kind, ok, data) VALUES (?, ?, ?, 'fast', 1, ?)`, id('xry'), o.orgId, srv, JSON.stringify(inv));
  const seen = serverFindings(app.db, o.orgId, { id: srv, name: 'box' });
  assert.ok(seen.some((f) => f.id === `server:port:${srv}:5432`) && seen.some((f) => f.id.startsWith('xray:no-backup:')));
  const proj = asset(app, o, { provider: 'compose', kind: 'project', extId: `${srv}/p/shop`, name: 'shop', meta: { server: `unit7:${srv}`, owner: 'compose', parts: [`compose:${srv}/c:shop-db`] } });
  ok(await o.h('asset.archive', { key: proj }));
  assert.deepEqual(serverFindings(app.db, o.orgId, { id: srv, name: 'box' }).filter((f) => f.bucket === 'risk').map((f) => f.id), [], 'findings skip it');
  asset(app, o, { provider: 'compose', kind: 'database', extId: `${srv}/c:shop-db`, name: 'shop-db', meta: { server: `unit7:${srv}`, owner: 'compose', project: `compose:${srv}/p/shop` } });
  assert.ok(touchesArchived(app.db, o.orgId, { serverId: srv, part: 'c:shop-db' }), 'and Warden doesn’t restart what’s in it');

  // bring it back
  ok(await o.h('asset.archive', { key: site, archived: false }));
  assert.ok(ok(await o.h('map.get')).assets.some((a: any) => a.id === site));
});

test('an AI archiving production asks first; any AI archive tells Activity and the phone, with Undo; a person archives in one click', async () => {
  const { app, o, site } = await shop();
  const { subscribeUrl } = setupNtfy(app, o.orgId);
  // the Vercel site says nothing about its environment, so it counts as production: the AI asks a person
  const asked = await o.a('asset.archive', { key: site });
  assert.equal(asked.status, 'approval_required');
  assert.ok(!get(app.db, 'SELECT 1 FROM archived WHERE key = ?', site), 'nothing archived yet');
  // a Unit7 project is production too
  const p = ok(await o.h('project.create', { name: 'Ledger', environments: ['production'] }));
  assert.equal((await o.a('asset.archive', { key: p.projectId })).status, 'approval_required');
  // a preview copy: the AI may, but it's never quiet
  const preview = asset(app, o, { provider: 'vercel', kind: 'app', extId: 'prj_v2', name: 'shop-preview', meta: { environment: 'preview' } });
  ok(await o.a('asset.archive', { key: preview }));
  const ev = get<{ type: string; severity: string; message: string; data: string }>(app.db, `SELECT type, severity, message, data FROM events WHERE type = 'asset.ai_archived'`)!;
  assert.match(ev.message, /^Your AI \(Unit7 agent\) archived shop-preview: Unit7 stopped watching it · Undo$/);
  assert.equal(ev.severity, 'warning');
  assert.deepEqual(JSON.parse(ev.data).undo, { tool: 'asset.archive', input: { key: preview, archived: false }, label: 'Undo' });
  const sent: { url: string; init: RequestInit }[] = [];
  const row = get<any>(app.db, `SELECT * FROM events WHERE type = 'asset.ai_archived'`)!;
  assert.equal(await deliver(app, { ...row, data: JSON.parse(row.data) }, async (url, init) => { sent.push({ url, init }); }), 1);
  assert.equal(sent[0]!.url, subscribeUrl);
  assert.match(String(sent[0]!.init.body), /Your AI \(Unit7 agent\) archived shop-preview/);
  // the person: one click, no phone alert about their own choice
  ok(await o.h('asset.archive', { key: site }));
  assert.ok(get(app.db, 'SELECT 1 FROM archived WHERE key = ?', site));
  assert.equal(all(app.db, `SELECT 1 FROM events WHERE type = 'asset.ai_archived'`).length, 1);
  // and brings it back in one click too
  ok(await o.h('asset.archive', { key: site, archived: false }));
  assert.ok(!get(app.db, 'SELECT 1 FROM archived WHERE key = ?', site));
});

test('impact: the domain that stops working, the app that uses the database, the data, and what stays', async () => {
  const { app, o, site, db } = await shop();
  // Unit7 also wired the database into one of its own apps
  const p = ok(await o.h('project.create', { name: 'Admin', environments: ['production'] }));
  const svc = id('svc');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind) VALUES (?, ?, ?, ?, 'admin', 'admin', 'app')`, svc, o.orgId, p.projectId, p.environments[0].id);
  const nAcc = get<{ id: string }>(app.db, `SELECT id FROM accounts WHERE provider = 'neon'`)!.id;
  run(app.db, `INSERT INTO links (id, org_id, source, target, vars) VALUES (?, ?, ?, ?, ?)`, id('lnk'), o.orgId, JSON.stringify({ kind: 'neon', accountId: nAcc, project: 'np-1' }), JSON.stringify({ kind: 'unit7', serviceId: svc }), JSON.stringify([{ key: 'DATABASE_URL' }]));

  const d = ok(await o.h('asset.impact', { key: db }));
  assert.deepEqual(d.breaks.map((b: any) => b.name).sort(), ['admin', 'shop-site']);
  assert.match(d.breaks.find((b: any) => b.name === 'shop-site').detail, /DATABASE_URL/);
  assert.match(d.breaks.find((b: any) => b.name === 'admin').detail, /Unit7 connected it \(DATABASE_URL\)/);
  assert.equal(d.dataGoes, 'always', 'a Neon project is its data');
  assert.deepEqual(d.data.map((x: any) => x.name), ['shop-db']);
  assert.ok(d.stays.some((s: any) => /7 days/.test(s.name)), 'Neon can recover it for a week');
  assert.equal(d.can.delete, true);

  const s = ok(await o.h('asset.impact', { key: site }));
  assert.deepEqual(s.breaks.map((b: any) => b.name), ['shop.example.com']);
  assert.deepEqual(s.stays.filter((x: any) => /registered/.test(x.detail)).map((x: any) => x.name), ['example.com'], 'the domain stays registered');
  assert.ok(s.stays.some((x: any) => x.name === 'shop-db' && /stays, with its data/.test(x.detail)), 'the database it only uses stays');
  assert.equal(s.dataGoes, 'never');
  assert.match(s.can.how, /Vercel/);

  // things Unit7 can't delete say so, in words
  const vm = asset(app, o, { provider: 'compose', kind: 'app', extId: 'srv_x/c:blog', name: 'blog', meta: { server: 'unit7:srv_x', owner: 'compose' } });
  const v = ok(await o.h('asset.impact', { key: vm }));
  assert.equal(v.can.delete, false);
  assert.match(v.can.why, /didn’t set it up/);
});

test('delete: the exact provider endpoint, the typed name, people only, never data unless asked, and Activity says what went', async (t) => {
  if (!(await online('api.vercel.com'))) return t.skip('offline');
  const { app, o, site, db } = await shop();
  const f = fakeFetch();
  try {
    assert.equal((await o.a('asset.delete', { key: site, confirmName: 'shop-site' })).status, 'denied', 'an AI never deletes, even with approval');
    const wrong = await o.h('asset.delete', { key: site, confirmName: 'shop' });
    assert.equal(wrong.status === 'error' && wrong.error.code, 'confirm_name');
    assert.equal(f.calls.length, 0, 'nothing was asked of Vercel');

    const r = ok(await o.h('asset.delete', { key: site, confirmName: 'shop-site' }));
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url}`), ['DELETE https://api.vercel.com/v9/projects/prj_v1?teamId=team_1']);
    assert.deepEqual(r.removed, ['shop-site on Vercel']);
    assert.ok(!get(app.db, 'SELECT 1 FROM assets WHERE id = ?', site), 'gone from the map at once');
    assert.ok(!get(app.db, 'SELECT 1 FROM edges WHERE source = ? OR target = ?', site, site));
    const ev = get<{ message: string; data: string }>(app.db, `SELECT message, data FROM events WHERE type = 'asset.deleted'`)!;
    assert.match(ev.message, /deleted shop-site \(vercel sam\): removed shop-site on Vercel/);
    assert.ok(get(app.db, `SELECT 1 FROM audit WHERE tool = 'asset.delete' AND result = 'success'`), 'and the audit');

    // a database: refused without "also delete its data", then Neon's own delete
    f.calls.length = 0;
    const keep = await o.h('asset.delete', { key: db, confirmName: 'shop-db' });
    assert.equal(keep.status === 'error' && keep.error.code, 'data_goes');
    assert.equal(f.calls.length, 0, 'no data deleted unless asked');
    ok(await o.h('asset.delete', { key: db, confirmName: 'shop-db', alsoData: true }));
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url}`), ['DELETE https://console.neon.tech/api/v2/projects/np-1']);
  } finally { f.restore(); }
});

test('delete at Netlify, Render, Railway, Fly.io and Heroku; a token that may not delete is said plainly', async (t) => {
  if (!(await online('api.netlify.com'))) return t.skip('offline');
  const app = testApp();
  const o = await testOrg(app);
  const acc = (p: string) => account(app, o, p, 'sam');
  const nl = acc('netlify'), rn = acc('render'), rw = acc('railway'), fl = acc('fly'), hk = acc('heroku');
  run(app.db, `UPDATE accounts SET meta = json_set(meta, '$.railway', 'account') WHERE id = ?`, rw);
  const k = {
    netlify: asset(app, o, { provider: 'netlify', kind: 'app', extId: 'site-1', name: 'blog', accountId: nl, meta: { end: { kind: 'netlify', accountId: nl, site: 'site-1' } } }),
    render: asset(app, o, { provider: 'render', kind: 'app', extId: 'srv-1', name: 'api', accountId: rn, meta: { end: { kind: 'render', accountId: rn, service: 'srv-1' } } }),
    railway: asset(app, o, { provider: 'railway', kind: 'app', extId: 'e1/s1', name: 'shop / web', accountId: rw, meta: { end: { kind: 'railway', accountId: rw, project: 'p1', environment: 'e1', service: 's1' } } }),
    railway2: asset(app, o, { provider: 'railway', kind: 'app', extId: 'e1/s2', name: 'shop / worker', accountId: rw, meta: { end: { kind: 'railway', accountId: rw, project: 'p1', environment: 'e1', service: 's2' } } }),
    fly: asset(app, o, { provider: 'fly', kind: 'app', extId: 'fly-1', name: 'pinger', accountId: fl, meta: { end: { kind: 'fly', accountId: fl, app: 'pinger' } } }),
    heroku: asset(app, o, { provider: 'heroku', kind: 'app', extId: 'hk-1', name: 'old-crm', accountId: hk, meta: { end: { kind: 'heroku', accountId: hk, app: 'hk-1' } } }),
    railway3: asset(app, o, { provider: 'railway', kind: 'app', extId: 'e2/s3', name: 'notes / web', accountId: rw, meta: { end: { kind: 'railway', accountId: rw, project: 'p2', environment: 'e2', service: 's3' } } }),
    fly2: asset(app, o, { provider: 'fly', kind: 'app', extId: 'fly-2', name: 'cron', accountId: fl, meta: { end: { kind: 'fly', accountId: fl, app: 'cron' } } }),
    heroku2: asset(app, o, { provider: 'heroku', kind: 'app', extId: 'hk-2', name: 'old-cms', accountId: hk, meta: { end: { kind: 'heroku', accountId: hk, app: 'hk-2' } } }),
  };
  let flyVolumes: unknown[] = [];
  // what Railway says is in each project right now (the fresh read before a delete)
  const inRailway: Record<string, { services: string[]; volumes: { name: string; services: string[] }[] }> = { p1: { services: ['s1', 's2'], volumes: [] }, p2: { services: ['s3'], volumes: [{ name: 'orphan-data', services: [] }] } };
  const f = fakeFetch((method, url, body) => {
    if (url.endsWith('/v1/apps/pinger/volumes')) return flyVolumes;
    if (url.endsWith('/v1/apps/cron/volumes')) return [];
    if (url.endsWith('/apps/hk-1/addons')) return [{ id: 'ad1', name: 'postgresql-curly-123', addon_service: { name: 'heroku-postgresql' }, config_vars: ['DATABASE_URL'] }];
    if (url.endsWith('/apps/hk-2/addons')) return new Response('{"id":"forbidden"}', { status: 403 });
    if (url === 'https://api.render.com/v1/services/srv-1' && method === 'GET') return { id: 'srv-1', serviceDetails: {} };
    if (url.startsWith('https://backboard.railway.com') && body.query.includes('volumes')) {
      const p = inRailway[body.variables.id]!;
      return { data: { project: { services: { edges: p.services.map((id) => ({ node: { id } })) }, volumes: { edges: p.volumes.map((v) => ({ node: { name: v.name, volumeInstances: { edges: v.services.map((serviceId) => ({ node: { serviceId } })) } } })) } } } };
    }
    if (url.startsWith('https://backboard.railway.com')) return { data: body.query.includes('serviceDelete') ? { serviceDelete: true } : { projectDelete: true } };
    if (url.includes('api.netlify.com') && method === 'DELETE') return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
    return undefined;
  });
  try {
    const del = (key: string, name: string, alsoData = false) => o.h('asset.delete', { key, confirmName: name, alsoData });
    const no = await del(k.netlify, 'blog');
    assert.equal(no.status === 'error' && no.error.code, 'not_allowed');
    assert.match(no.status === 'error' ? no.error.message : '', /Netlify didn’t let Unit7 delete blog: the connected token isn’t allowed to/);
    assert.ok(get(app.db, 'SELECT 1 FROM assets WHERE id = ?', k.netlify), 'still on the map');
    assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM accounts WHERE id = ?', nl)!.status, 'verified', 'a refusal to delete doesn’t mark the account broken');

    f.calls.length = 0;
    ok(await del(k.render, 'api'));
    assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.url === 'https://api.render.com/v1/services/srv-1'));

    // two services in the Railway project: just this one, in its environment; the project only once Railway itself says it's empty
    const mutations = () => f.calls.filter((c) => /^mutation/.test(c.body?.query ?? ''));
    f.calls.length = 0;
    ok(await del(k.railway, 'shop / web'));
    assert.deepEqual(mutations().map((c) => c.body?.variables), [{ id: 's1', e: 'e1' }]);
    assert.match(mutations()[0]!.body.query, /serviceDelete\(id: \$id, environmentId: \$e\)/);
    inRailway.p1!.services = ['s2'];
    f.calls.length = 0;
    ok(await del(k.railway2, 'shop / worker'));
    assert.match(mutations()[0]!.body.query, /projectDelete\(id: \$id\)/);
    assert.deepEqual(mutations()[0]!.body.variables, { id: 'p1' });
    // a volume mounted on the service itself is its data
    inRailway.p2!.volumes = [{ name: 'notes-data', services: ['s3'] }];
    const rwData = await del(k.railway3, 'notes / web');
    assert.equal(rwData.status === 'error' && rwData.error.code, 'data_goes');
    assert.match(rwData.status === 'error' ? rwData.error.message : '', /notes-data/);
    // the only service, but the project still holds a volume of no service: just the service, the volume stays
    inRailway.p2!.volumes = [{ name: 'orphan-data', services: [] }];
    f.calls.length = 0;
    ok(await del(k.railway3, 'notes / web'));
    assert.deepEqual(mutations().map((c) => c.body?.variables), [{ id: 's3', e: 'e2' }]);

    // Fly: no volumes, no "also delete its data": deleted without force, so Fly.io's own checks stay in the way
    f.calls.length = 0;
    ok(await del(k.fly2, 'cron'));
    assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.url === 'https://api.machines.dev/v1/apps/cron'));
    // its volumes go with the app, so they're named and need "also delete its data"
    flyVolumes = [{ id: 'vol_1', name: 'pinger_data', size_gb: 1, state: 'created' }];
    f.calls.length = 0;
    const vol = await del(k.fly, 'pinger');
    assert.equal(vol.status === 'error' && vol.error.code, 'data_goes');
    assert.match(vol.status === 'error' ? vol.error.message : '', /pinger_data/);
    assert.ok(!f.calls.some((c) => c.method === 'DELETE'));
    ok(await del(k.fly, 'pinger', true));
    assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.url === 'https://api.machines.dev/v1/apps/pinger?force=true'));

    // Heroku: deleting the app destroys its Postgres add-on
    f.calls.length = 0;
    const hkKeep = await del(k.heroku, 'old-crm');
    assert.equal(hkKeep.status === 'error' && hkKeep.error.code, 'data_goes');
    ok(await del(k.heroku, 'old-crm', true));
    assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.url === 'https://api.heroku.com/apps/hk-1'));
    // a data lookup that fails is never "no data": nothing is deleted
    f.calls.length = 0;
    const unknown = await del(k.heroku2, 'old-cms');
    assert.equal(unknown.status === 'error' && unknown.error.code, 'data_unknown');
    assert.match(unknown.status === 'error' ? unknown.error.message : '', /couldn’t check what data old-cms has at Heroku, so nothing was deleted/);
    assert.ok(!f.calls.some((c) => c.method === 'DELETE'));
    assert.ok(get(app.db, 'SELECT 1 FROM assets WHERE id = ?', k.heroku2), 'still on the map');
    assert.equal(all(app.db, `SELECT 1 FROM events WHERE type = 'asset.deleted'`).length, 7);
  } finally { f.restore(); }
});

test('Supabase: pause instead of delete, Pause comes first in the impact', async (t) => {
  if (!(await online('api.supabase.com'))) return t.skip('offline');
  const app = testApp();
  const o = await testOrg(app);
  const sAcc = account(app, o, 'supabase', 'sam');
  const ref = 'abcdefghijklmnopqrst';
  const key = asset(app, o, { provider: 'supabase', kind: 'database', extId: ref, name: 'side-project', accountId: sAcc, meta: { end: { kind: 'supabase', accountId: sAcc, ref } } });
  const f = fakeFetch();
  try {
    const i = ok(await o.h('asset.impact', { key }));
    assert.equal(i.can.pause, true);
    assert.deepEqual(i.can.stop.map((s: any) => s.tool), ['asset.pause'], 'archive and pause it');
    ok(await o.a('asset.pause', { key }));
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url}`), [`POST https://api.supabase.com/v1/projects/${ref}/pause`]);
    f.calls.length = 0;
    ok(await o.h('asset.delete', { key, confirmName: 'side-project', alsoData: true }));
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url}`), [`DELETE https://api.supabase.com/v1/projects/${ref}`]);
  } finally { f.restore(); }
});

// a stand-in Coolify v4 reached over the server's SSH (real curl, like Unit7 sends it)
async function fakeCoolify(app: App) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x'), path = url.pathname.replace(/^\/api\/v1/, '');
    seen.push(`${req.method} ${path}${url.search}`);
    const send = (b: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && path === '/applications/app01') return send({ uuid: 'app01', name: 'Shop web' });
    if (req.method === 'DELETE') return send({ message: 'Application deleted.' });
    res.writeHead(404); res.end('{}');
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    if (command !== CURL) throw new Error(`unexpected command: ${command}`);
    return new Promise((resolve) => {
      const p = spawn('curl', ['-K', '-']);
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
      p.stdin.end(String(o.stdin ?? '').replace(/http:\/\/127\.0\.0\.1:\d+\//, `http://127.0.0.1:${port}/`));
    });
  };
  return { seen, close: () => server.close() };
}

test('Coolify: deleting an app keeps its volumes unless asked, through Coolify’s own API', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ sudo: 'root' }));
  account(app, o, 'coolify', 'box', { serverId: srv, apiPort: '8000' });
  const inv: Inventory = { version: 1, at: new Date().toISOString(), server: {}, paas: [], loose: [], ports: [], repos: [], summary: '', notes: [], projects: [],
    parts: [{ id: 'coolify:app01', kind: 'app', name: 'Shop web', owner: 'coolify', trust: 'seen', volumes: ['v:shop-data'], coolify: { uuid: 'app01', type: 'application', labels: 'uuid' } }] };
  run(app.db, `INSERT INTO xrays (id, org_id, server_id, kind, ok, data) VALUES (?, ?, ?, 'fast', 1, ?)`, id('xry'), o.orgId, srv, JSON.stringify(inv));
  const key = asset(app, o, { provider: 'coolify', kind: 'app', extId: `${srv}/coolify:app01`, name: 'Shop web', meta: { server: `unit7:${srv}`, owner: 'coolify' } });
  const c = await fakeCoolify(app);
  try {
    const i = ok(await o.h('asset.impact', { key }));
    assert.equal(i.dataGoes, 'optional');
    assert.ok(i.stays.some((s: any) => /stays unless you choose/.test(s.detail)), 'says its data stays');
    assert.deepEqual(i.can.stop.map((s: any) => s.tool), ['part.stop'], 'archive and stop it goes through part.stop');
    const r = ok(await o.h('asset.delete', { key, confirmName: 'Shop web' }));
    assert.equal(r.dataKept, true);
    assert.deepEqual(c.seen.filter((s) => s.startsWith('DELETE')), ['DELETE /applications/app01?delete_volumes=false'], 'Coolify deletes volumes by default, so Unit7 says false');
    assert.match(get<{ message: string }>(app.db, `SELECT message FROM events WHERE type = 'asset.deleted'`)!.message, /its data was kept/);
  } finally { c.close(); }
});

test('clean up: what looks abandoned, with why', async () => {
  const { app, o, db } = await shop();
  // an old site: no domain of its own, paused
  const acc = get<{ id: string }>(app.db, `SELECT id FROM accounts WHERE provider = 'vercel'`)!.id;
  const old = asset(app, o, { provider: 'vercel', kind: 'app', extId: 'prj_old', name: 'weekend-toy', accountId: acc, meta: { status: 'paused', end: { kind: 'vercel', accountId: acc, project: 'prj_old' } } });
  const r = ok(await o.h('asset.cleanup'));
  const toy = r.items.find((x: any) => x.key === old);
  assert.ok(toy, 'listed');
  assert.deepEqual(toy.reasons, ['No domain of yours points at it', 'It’s paused already']);
  assert.ok(!r.items.some((x: any) => x.key === db), 'the shop’s database is used by the site');
  ok(await o.h('asset.archive', { key: old }));
  assert.ok(!ok(await o.h('asset.cleanup')).items.some((x: any) => x.key === old), 'archived things leave the list');
});
