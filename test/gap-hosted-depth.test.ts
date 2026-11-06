// Past the first deploy on a hosted platform, offline, one fake per host: roll back on Railway, Fly.io and Heroku; a database or a cron
// job on Render; a database on Railway; a domain on a DigitalOcean app; buying and resizing a Droplet. For each: the exact calls, what a
// refused key says, and that an AI can't start anything that costs money. A database's address must never come back in a result or the audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { all, get, id, run } from '../src/db.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { dnsLook } from '../src/connectors/dnswrite.ts';
import { buyDeps } from '../src/fleet/care.ts';
import { liveTiming } from '../src/live/vercel.ts';
import { PROFILES } from '../src/ops/index.ts';
import { deployTiming } from '../src/tools/clouds-deploy.ts';
import { thingsFrom } from '../src/tools/links.ts';
import { decideApproval, getTool } from '../src/tools/runtime.ts';
import { vpsTiming } from '../src/tools/vps.ts';
import type { App } from '../src/app.ts';

deployTiming.pollMs = 1; liveTiming.pollMs = 1; vpsTiming.pollMs = 1; vpsTiming.waitMs = 200;
process.env.UNIT7_SKIP_NET_PROBE = '1';
buyDeps.listening = async () => true;
buyDeps.sleep = async () => undefined;

type O = Awaited<ReturnType<typeof testOrg>>;
type R = Req & { p: string; q: URLSearchParams; json: any };
const BASES: Record<string, string> = { UNIT7_RENDER_API: 'render', UNIT7_RAILWAY_API: 'railway', UNIT7_FLY_API: 'fly', UNIT7_HEROKU_API: 'heroku', UNIT7_DIGITALOCEAN_API: 'do' };
// with no fake up, these are a closed port and never unset: an unset one means the real provider, and a test that timed out ends late
const NOWHERE = 'http://127.0.0.1:9';
for (const k of [...Object.keys(BASES), 'UNIT7_FLY_HOST']) process.env[k] = NOWHERE;
async function world(routes: Record<string, (r: R) => unknown>) {
  const app = testApp(), o = await testOrg(app);
  const api = await fakeApi((r: Req) => {
    const u = new URL(r.path, 'http://x'), [, prefix = '', ...rest] = u.pathname.split('/');
    if (prefix === 'site') return rest[0] === 'down' ? [503, { error: 'down' }] : 'fine';
    let json: any; try { json = r.body ? JSON.parse(r.body) : undefined; } catch { /* not JSON */ }
    return routes[prefix]?.({ ...r, p: `/${rest.join('/')}`, q: u.searchParams, json });
  });
  for (const [k, v] of Object.entries(BASES)) process.env[k] = `${api.base}/${v}`;
  return { app, o, api, acc: (provider: string, value = 'demo-token', name = provider) => account(app, o.orgId, provider, value, name),
    close: () => { api.close(); for (const [k, v] of Object.entries(BASES)) if (process.env[k] === `${api.base}/${v}`) process.env[k] = NOWHERE; } };
}
const refused = (r: any, re: RegExp) => { assert.equal(r.status, 'error', JSON.stringify(r)); assert.match(r.error.message, re); assert.doesNotMatch(r.error.message, /undefined|\[object|—/); return r; };
const said = (r: any) => (r.status === 'approval_required' || r.status === 'denied' ? r.why : assert.fail(JSON.stringify(r)));
const writes = (api: { calls: Req[] }, prefix: string) => api.calls.filter((c) => c.method !== 'GET' && c.path.startsWith(prefix));
const yes = (app: App, o: O, r: any, confirm?: string): Promise<any> => decideApproval(app, o.orgId, o.human, r.approvalId, true, confirm);
const asset = (app: App, o: O, row: { id: string; acc: string; provider: string; ext: string; name: string; url?: string; end?: object; kind?: string }) =>
  run(app.db, `INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-11-07')`, row.id, o.orgId, row.acc, row.provider, row.kind ?? 'app', row.ext, row.name, row.url ?? null, JSON.stringify({ end: row.end }));
// what was kept of a run: anything secret here would sit in the database
const kept = (app: App, o: O) => JSON.stringify(all(app.db, 'SELECT input, output, error FROM audit WHERE org_id = ?', o.orgId));

// --- Railway: roll back -------------------------------------------------------------------------------------------------------
function railwayGql(st: { deployments: any[]; after?: string[]; refuse?: boolean; rolled?: string[]; redeployed?: string[] }) {
  return ({ json }: R) => {
    const { query, variables: v } = json as { query: string; variables: any };
    if (query.includes('{ me { id } }')) return st.refuse ? [401, { errors: [{ message: 'Not Authorized' }] }] : { data: { me: { id: 'u1' } } };
    if (st.refuse) return { errors: [{ message: 'Not Authorized' }] };
    if (query.includes('deployments(input')) { assert.deepEqual(v.i, { projectId: 'p1', environmentId: 'e1', serviceId: 's1' }); return { data: { deployments: { edges: st.deployments.map((node) => ({ node })) } } }; }
    if (query.includes('deployment(id')) return { data: { deployment: { status: st.after?.shift() ?? 'SUCCESS' } } };
    if (query.includes('deploymentRollback')) {
      (st.rolled ??= []).push(v.id);
      for (const d of st.deployments) if (d.status === 'SUCCESS') d.status = 'REMOVED';
      st.deployments.unshift({ id: `r-${v.id}`, status: 'SUCCESS', canRollback: true });
      return { data: { deploymentRollback: { id: `r-${v.id}`, status: 'INITIALIZING' } } };
    }
    if (query.includes('deploymentRedeploy')) { (st.redeployed ??= []).push(v.id); return { data: { deploymentRedeploy: { id: 'new-1', status: 'BUILDING' } } }; }
    return undefined;
  };
}
const RAILWAY_END = { kind: 'railway', project: 'p1', environment: 'e1', service: 's1' };

test('Railway rolls back to the last good version, skipping what failed, says settings go back too, and Undo puts today’s back', async () => {
  const st: any = { deployments: [{ id: 'd5', status: 'FAILED', canRollback: false }, { id: 'd4', status: 'SUCCESS', canRollback: true }, { id: 'd3', status: 'CRASHED', canRollback: true }, { id: 'd2', status: 'REMOVED', canRollback: true }, { id: 'd1', status: 'REMOVED', canRollback: false }], after: ['DEPLOYING', 'SUCCESS'] };
  const w = await world({ railway: railwayGql(st) }), acc = w.acc('railway');
  try {
    asset(w.app, w.o, { id: 'ast_railwayshop1', acc, provider: 'railway', ext: 'e1/s1', name: 'shop', url: `${w.api.base}/site/ok`, end: { ...RAILWAY_END, accountId: acc } });
    assert.deepEqual(ok(await w.o.h('cloud.app_actions', { asset: 'ast_railwayshop1' })).modes, ['redeploy', 'rollback']);
    const asked = await w.o.a('cloud.redeploy', { asset: 'ast_railwayshop1', mode: 'rollback' });
    assert.equal(asked.status, 'approval_required', 'it changes what’s live');
    assert.match(said(asked), /settings go back too/);
    assert.equal(st.rolled, undefined, 'nothing ran');
    const r = ok(await w.o.h('cloud.redeploy', { asset: 'ast_railwayshop1', mode: 'rollback' }));
    assert.deepEqual(st.rolled, ['d2']);
    assert.equal(r.said, 'the previous version is live');
    assert.equal(r.verified.fixed, true);
    assert.deepEqual(r.undo, { tool: 'cloud.redeploy', input: { asset: 'ast_railwayshop1', mode: 'rollback', to: 'd4' } });
    ok(await w.o.h(r.undo.tool, r.undo.input));
    assert.deepEqual(st.rolled, ['d2', 'd4']);
  } finally { w.close(); }
});

test('Railway: a crashed version counts as what’s on, a failed roll back says the site didn’t change, a redeploy waits, and a refused key stops it', async () => {
  const st: any = { deployments: [{ id: 'd3', status: 'CRASHED', canRollback: true }, { id: 'd2', status: 'REMOVED', canRollback: true }], after: ['FAILED'] };
  const w = await world({ railway: railwayGql(st) }), acc = w.acc('railway');
  try {
    asset(w.app, w.o, { id: 'ast_railwayshop1', acc, provider: 'railway', ext: 'e1/s1', name: 'shop', end: { ...RAILWAY_END, accountId: acc } });
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_railwayshop1', mode: 'rollback' }), /Railway couldn’t put that version of shop back \(failed\)\. The live site didn’t change/);
    assert.deepEqual(st.rolled, ['d2'], 'not the crashed one again');
    st.deployments = [{ id: 'd9', status: 'SUCCESS', canRollback: true }]; st.after = ['BUILDING', 'SUCCESS'];
    assert.equal(ok(await w.o.h('cloud.redeploy', { asset: 'ast_railwayshop1' })).version, 'new-1');
    assert.deepEqual(st.redeployed, ['d9']);
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_railwayshop1', mode: 'rollback' }), /no earlier working version/);
    asset(w.app, w.o, { id: 'ast_railwaynoend', acc, provider: 'railway', ext: 'e1/s2', name: 'old' });
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_railwaynoend', mode: 'rollback' }), /Refresh the map/);
    st.refuse = true;
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_railwayshop1', mode: 'rollback' }), /Railway: Not Authorized/);
  } finally { w.close(); }
  // a key that was never good: Railway's three kinds all say no
  const bad = await world({ railway: railwayGql({ deployments: [], refuse: true }) }), acc2 = bad.acc('railway', 'bad-token');
  try {
    asset(bad.app, bad.o, { id: 'ast_railwayshop1', acc: acc2, provider: 'railway', ext: 'e1/s1', name: 'shop', end: { ...RAILWAY_END, accountId: acc2 } });
    refused(await bad.o.h('cloud.redeploy', { asset: 'ast_railwayshop1', mode: 'rollback' }), /Railway didn’t accept this token/);
  } finally { bad.close(); }
});

// --- Heroku: roll back --------------------------------------------------------------------------------------------------------
test('Heroku rolls back with a new release of the last good one, never an expired one, and Undo goes forward again', async () => {
  const REL = [
    { id: 'r12', version: 12, current: true, status: 'succeeded', eligible_for_rollback: true, slug: { id: 's3' } }, { id: 'r11', version: 11, status: 'failed', slug: { id: 's2' } },
    { id: 'r10', version: 10, status: 'succeeded', eligible_for_rollback: true, slug: { id: 's2' } }, { id: 'r9', version: 9, status: 'expired', eligible_for_rollback: false, slug: { id: 's1' } },
    { id: 'r1', version: 1, status: 'succeeded', eligible_for_rollback: true, slug: null },
  ];
  const st: any = { list: [...REL], posted: [] as any[], next: ['pending', 'succeeded'] };
  const w = await world({ heroku: ({ p, method, json, headers }: R) => {
    if (st.refuse) return [401, { id: 'unauthorized', message: 'Invalid credentials provided.' }];
    if (p === '/apps/app-uuid/releases' && method === 'GET') { assert.equal(headers.range, 'version ..; order=desc,max=20', 'newest first'); assert.match(String(headers.accept), /version=3/); return [206, st.list]; }
    if (p === '/apps/app-uuid/releases' && method === 'POST') { st.posted.push(json); return [201, { id: `n-${json.release}`, status: 'pending' }]; }
    if (p.startsWith('/apps/app-uuid/releases/n-')) return { id: 'n', status: st.next.shift() ?? 'succeeded' };
    return undefined;
  } }), acc = w.acc('heroku');
  try {
    asset(w.app, w.o, { id: 'ast_herokushop01', acc, provider: 'heroku', ext: 'app-uuid', name: 'shop', url: `${w.api.base}/site/ok`, end: { kind: 'heroku', accountId: acc, app: 'app-uuid' } });
    const can = ok(await w.o.h('cloud.app_actions', { asset: 'ast_herokushop01' }));
    assert.deepEqual(can.modes, ['rollback']);
    assert.match(can.impact.rollback, /Add-ons and the data in them don’t change/);
    assert.match(said(await w.o.a('cloud.redeploy', { asset: 'ast_herokushop01', mode: 'rollback' })), /settings go back too/);
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_herokushop01' }), /Heroku builds what it’s sent.*live\.put/);
    const r = ok(await w.o.h('cloud.redeploy', { asset: 'ast_herokushop01', mode: 'rollback' }));
    assert.deepEqual(st.posted, [{ release: 'r10' }]);
    assert.equal(r.undo.input.to, 'r12');
    assert.equal(r.verified.fixed, true);
    st.list = [{ id: 'n-r10', version: 13, current: true, status: 'succeeded', eligible_for_rollback: true, slug: { id: 's2' } }, ...REL.map((x) => ({ ...x, current: false }))];
    ok(await w.o.h(r.undo.tool, r.undo.input));
    assert.deepEqual(st.posted, [{ release: 'r10' }, { release: 'r12' }]);
    st.next = ['failed'];
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_herokushop01', mode: 'rollback' }), /its release failed\)\. The live site didn’t change/);
    st.list = [REL[0], REL[3], REL[4]];
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_herokushop01', mode: 'rollback' }), /no earlier working version/);
    st.refuse = true;
    const n = st.posted.length;
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_herokushop01', mode: 'rollback' }), /Heroku: Invalid credentials provided/);
    assert.equal(st.posted.length, n);
  } finally { w.close(); }
});

// --- Fly.io: roll back --------------------------------------------------------------------------------------------------------
const IMG = (n: number) => `registry.fly.io/shop:deployment-${n}`;
function flyApi(st: { machines: any[]; versions: Record<string, { version: string; user_config?: { image?: string } }[]>; updates?: any[]; failOn?: string; state?: string; refuse?: boolean }) {
  return ({ p, method, json }: R) => {
    if (st.refuse) return [401, { error: 'unauthorized' }];
    if (p === '/apps/shop/machines' && method === 'GET') return st.machines;
    const v = /^\/apps\/shop\/machines\/(\w+)\/versions$/.exec(p);
    if (v) return st.versions[v[1]!] ?? [];
    const one = /^\/apps\/shop\/machines\/(\w+)$/.exec(p);
    if (one && method === 'POST') {
      if (st.failOn === one[1]) return [422, { error: 'that image is gone' }];
      (st.updates ??= []).push({ id: one[1], body: json });
      const m = st.machines.find((x) => x.id === one[1]);
      m.config = json.config; m.instance_id = `02${m.instance_id}`; m.state = st.state ?? 'started';
      return { ok: true };
    }
    return undefined;
  };
}
const flyWorld = () => {
  const config = (n: number) => ({ image: IMG(n), guest: { cpu_kind: 'shared', memory_mb: 256 }, services: [{ internal_port: 8080 }], env: { MODE: 'live' } });
  return {
    machines: [{ id: 'm1', state: 'started', instance_id: '01D', config: config(3) }, { id: 'm2', state: 'stopped', instance_id: '01X', config: config(3) }, { id: 'old', state: 'destroyed', instance_id: '01Z', config: config(1) }],
    // out of order, as nothing promises any. 01C is a settings change: the same image as what's live
    versions: { m1: [{ version: '01B', user_config: { image: IMG(2) } }, { version: '01D', user_config: { image: IMG(3) } }, { version: '01A', user_config: { image: IMG(1) } }, { version: '01C', user_config: { image: IMG(3) } }] },
  } as any;
};

test('Fly.io rolls back every machine to the image before this one, keeps the rest of each config, and Undo goes forward', async () => {
  const st = flyWorld(), w = await world({ fly: flyApi(st) }), acc = w.acc('fly');
  try {
    asset(w.app, w.o, { id: 'ast_flyshop00001', acc, provider: 'fly', ext: 'fly-id', name: 'shop', url: `${w.api.base}/site/ok`, end: { kind: 'fly', accountId: acc, app: 'shop' } });
    const can = ok(await w.o.h('cloud.app_actions', { asset: 'ast_flyshop00001' }));
    assert.deepEqual(can.modes, ['rollback']);
    assert.match(can.why, /live\.put/);
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_flyshop00001' }), /Fly\.io runs a ready image/);
    assert.match(said(await w.o.a('cloud.redeploy', { asset: 'ast_flyshop00001' })), /Fly\.io runs a ready image/, 'an approval card never promises a build');
    assert.equal((await w.o.a('cloud.redeploy', { asset: 'ast_flyshop00001', mode: 'rollback' })).status, 'approval_required');
    const r = ok(await w.o.h('cloud.redeploy', { asset: 'ast_flyshop00001', mode: 'rollback' }));
    assert.deepEqual(st.updates.map((u: any) => [u.id, u.body.config.image]), [['m1', IMG(2)], ['m2', IMG(2)]], 'skips the settings change, and a destroyed machine');
    assert.deepEqual(st.updates[0].body.config.guest, { cpu_kind: 'shared', memory_mb: 256 }, 'an update wants the whole config');
    assert.deepEqual(st.updates[0].body.config.env, { MODE: 'live' });
    assert.equal(r.said, 'the previous version is live');
    assert.equal(r.undo.input.to, '01D');
    assert.equal(r.verified.fixed, true);
    st.updates = [];
    ok(await w.o.h(r.undo.tool, r.undo.input));
    assert.deepEqual(st.updates.map((u: any) => u.body.config.image), [IMG(3), IMG(3)]);
  } finally { w.close(); }
});

test('Fly.io failures: part way says how to finish, a version it dropped, a machine that won’t start, nothing to go back to, a refused key', async () => {
  const st = flyWorld(), w = await world({ fly: flyApi(st) }), acc = w.acc('fly');
  try {
    asset(w.app, w.o, { id: 'ast_flyshop00001', acc, provider: 'fly', ext: 'fly-id', name: 'shop', end: { kind: 'fly', accountId: acc, app: 'shop' } });
    st.failOn = 'm2';
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_flyshop00001', mode: 'rollback' }), /stopped after 1 of 2 machines, so shop is running two versions.*to: 01B/);
    assert.equal(st.machines[0].config.image, IMG(2));
    delete st.failOn;
    refused(await w.o.h('cloud.redeploy', { asset: 'ast_flyshop00001', mode: 'rollback', to: '01ZZZ' }), /doesn’t keep that version/);
    const down = flyWorld(); down.state = 'failed';
    const w2 = await world({ fly: flyApi(down) }), acc2 = w2.acc('fly');
    try {
      asset(w2.app, w2.o, { id: 'ast_flyshop00002', acc: acc2, provider: 'fly', ext: 'fly-id', name: 'shop', end: { kind: 'fly', accountId: acc2, app: 'shop' } });
      refused(await w2.o.h('cloud.redeploy', { asset: 'ast_flyshop00002', mode: 'rollback' }), /Fly\.io couldn’t put that version of shop back \(a machine failed to start\)/);
    } finally { w2.close(); }
  } finally { w.close(); }
  const one = flyWorld(); one.versions = { m1: [{ version: '01D', user_config: { image: IMG(3) } }, { version: '01C', user_config: { image: IMG(3) } }] };
  const w3 = await world({ fly: flyApi(one) }), acc3 = w3.acc('fly');
  try {
    asset(w3.app, w3.o, { id: 'ast_flyshop00003', acc: acc3, provider: 'fly', ext: 'fly-id', name: 'shop', end: { kind: 'fly', accountId: acc3, app: 'shop' } });
    refused(await w3.o.h('cloud.redeploy', { asset: 'ast_flyshop00003', mode: 'rollback' }), /no earlier working version/);
    assert.equal(one.updates, undefined, 'a settings change is no version to go back to');
    one.machines = [];
    refused(await w3.o.h('cloud.redeploy', { asset: 'ast_flyshop00003', mode: 'rollback' }), /no machine on Fly\.io/);
    one.refuse = true;
    refused(await w3.o.h('cloud.redeploy', { asset: 'ast_flyshop00003', mode: 'rollback' }), /Fly\.io: Unauthorized/);
  } finally { w3.close(); }
});

// --- Render: a Postgres -------------------------------------------------------------------------------------------------------
const PASSWORD = 'pg-pass-Zk39xQ';
function renderApi(st: { dbs?: any[]; made?: any[]; env?: { key: string; value: string }[]; put?: any[]; refuse?: unknown; status?: string[]; region?: string; refuseEnv?: boolean; services?: any[] }) {
  st.dbs ??= []; st.made ??= []; st.env ??= []; st.put ??= []; st.services ??= [];
  return ({ p, method, json }: R) => {
    if (p === '/owners') return [{ owner: { id: 'own-1', name: 'Demo' }, cursor: 'c' }];
    if (p === '/postgres' && method === 'GET') return st.dbs!.map((postgres) => ({ postgres, cursor: 'c' }));
    if (p === '/postgres' && method === 'POST') {
      st.made!.push(json);
      if (st.refuse) return st.refuse;
      const db = { id: 'dpg-1', name: json.name, plan: json.plan, region: json.region ?? 'oregon', dashboardUrl: 'https://dashboard.render.example/d/dpg-1', ...(json.plan === 'free' && { expiresAt: '2026-12-07T00:00:00Z' }) };
      st.dbs!.push(db);
      return [201, { ...db, status: 'creating' }];
    }
    if (p === '/postgres/dpg-1/connection-info') return { password: PASSWORD, internalConnectionString: `postgres://u:${PASSWORD}@dpg-1-a/shop`, externalConnectionString: `postgres://u:${PASSWORD}@dpg-1-a.frankfurt-postgres.render.example/shop`, psqlCommand: `psql ${PASSWORD}` };
    if (p === '/postgres/dpg-1') return { ...st.dbs!.find((d) => d.id === 'dpg-1'), status: st.status?.shift() ?? 'available' };
    if (p === '/services/srv-1') return { id: 'srv-1', name: 'shop', ownerId: 'own-2', serviceDetails: { region: st.region ?? 'frankfurt' } };
    if (p === '/services/srv-1/env-vars') return st.env!.map((envVar) => ({ envVar, cursor: 'c' }));
    const one = /^\/services\/srv-1\/env-vars\/(\w+)$/.exec(p);
    if (one && method === 'PUT') { if (st.refuseEnv) return [403, { message: 'not yours' }]; st.put!.push({ key: one[1], value: json.value }); return {}; }
    if (p === '/services' && method === 'GET') return st.services!.map((service) => ({ service, cursor: 'c' }));
    return undefined;
  };
}

test('a free Postgres on Render: an AI can make one, it only creates, and the result says it runs out', async () => {
  const st: any = { status: ['creating', 'available'] }, w = await world({ render: renderApi(st) }), acc = w.acc('render');
  try {
    assert.equal(getTool('render.create_database')!.green instanceof Function && (getTool('render.create_database')!.green as any)({ plan: 'free' }), true);
    const r = ok(await w.o.a('render.create_database', { accountId: acc, name: 'shop-db' }));
    assert.deepEqual(st.made, [{ name: 'shop-db', plan: 'free', version: '18', ownerId: 'own-1' }], 'nothing about storage: free is always 1 GB');
    assert.equal(r.database, 'dpg-1');
    assert.equal(r.expires, '2026-12-07T00:00:00Z');
    assert.match(r.note, /stops working after 30 days.*deletes it 14 days later.*no backups/);
    assert.equal(r.status, 'available');
    refused(await w.o.a('render.create_database', { accountId: acc, name: 'shop-db' }), /already exists on Render.*give into/);
    assert.equal(st.made.length, 1);
  } finally { w.close(); }
});

test('a paid Postgres on Render is a person’s: an AI is denied every paid plan, and a person sees the price and says yes', async () => {
  const st: any = {}, w = await world({ render: renderApi(st) }), acc = w.acc('render');
  try {
    const plans = ok(await w.o.a('hosted.plans', {})).render.postgres.filter((p: any) => p.paid);
    assert.ok(plans.length >= 4);
    for (const p of plans) {
      const ai = await w.o.a('render.create_database', { accountId: acc, name: 'big', plan: p.id });
      assert.equal(ai.status, 'denied', p.id);
      assert.match(said(ai), /only a person/);
    }
    assert.equal(st.made.length, 0);
    assert.equal((await w.o.h('render.create_database', { accountId: acc, name: 'big', plan: 'pro_128gb' })).status, 'error', 'a plan with no price here can’t slip past');
    const asked = await w.o.h('render.create_database', { accountId: acc, name: 'big', plan: '0.5c-1g', diskGb: 10 });
    assert.equal(asked.status, 'approval_required');
    assert.match(said(asked), /\$19 a month, plus \$0\.30 per GB of storage/);
    assert.equal(st.made.length, 0);
    const r = ok(await yes(w.app, w.o, asked));
    assert.deepEqual(st.made, [{ name: 'big', plan: '0.5c-1g', version: '18', ownerId: 'own-1', diskSizeGB: 10 }]);
    assert.equal(r.expires, undefined);
    assert.equal(r.note, undefined);
    assert.equal(get<any>(w.app.db, `SELECT action FROM audit WHERE tool = 'render.create_database' AND result = 'success'`).action, 'provider_purchase');
    assert.equal((await w.o.a('render.create_database', { accountId: acc, name: 'x', diskGb: 7 })).status, 'error', '1 or a multiple of 5');
  } finally { w.close(); }
});

test('giving a Render database to an app: straight into its settings, in its region, never shown, and never over what’s there', async () => {
  const st: any = {}, w = await world({ render: renderApi(st) }), acc = w.acc('render');
  try {
    const asked = await w.o.a('render.create_database', { accountId: acc, name: 'shop-db', into: 'srv-1' });
    assert.equal(asked.status, 'approval_required', 'it changes an app, so it isn’t green');
    assert.match(said(asked), /puts its address in the app’s settings as DATABASE_URL/);
    const r = ok(await yes(w.app, w.o, asked));
    assert.equal(st.made[0].region, 'frankfurt', 'the app’s region: the private address only works there');
    assert.equal(st.made[0].ownerId, 'own-2', 'the app’s workspace, for the same reason');
    assert.deepEqual(st.put, [{ key: 'DATABASE_URL', value: `postgres://u:${PASSWORD}@dpg-1-a/shop` }]);
    assert.equal(r.connected, 'srv-1');
    assert.match(r.next, /Redeploy/);
    assert.deepEqual(r.undo.input, { to: 'render', accountId: acc, project: 'srv-1', op: 'unset', key: 'DATABASE_URL' });
    assert.doesNotMatch(JSON.stringify(r), new RegExp(PASSWORD));
    assert.doesNotMatch(kept(w.app, w.o), new RegExp(PASSWORD));
  } finally { w.close(); }
  const had: any = { env: [{ key: 'DATABASE_URL', value: 'postgres://their-live-database' }] }, w2 = await world({ render: renderApi(had) }), acc2 = w2.acc('render');
  try {
    refused(await w2.o.h('render.create_database', { accountId: acc2, name: 'shop-db', into: 'srv-1' }), /shop already has a setting called DATABASE_URL, so Unit7 changed nothing/);
    assert.equal(had.made.length, 0, 'found out before anything was made');
    assert.deepEqual(had.put, []);
    ok(await w2.o.h('render.create_database', { accountId: acc2, name: 'shop-db', into: 'srv-1', key: 'NEW_DATABASE_URL' }));
    assert.equal(had.put[0].key, 'NEW_DATABASE_URL');
  } finally { w2.close(); }
  // a database that's already there and elsewhere: connected without a second one, by its public address
  const far: any = { dbs: [{ id: 'dpg-1', name: 'shop-db', plan: 'free', region: 'oregon' }] }, w3 = await world({ render: renderApi(far) }), acc3 = w3.acc('render');
  try {
    const r = ok(await w3.o.h('render.create_database', { accountId: acc3, name: 'shop-db', into: 'srv-1' }));
    assert.equal(far.made.length, 0);
    assert.match(far.put[0].value, /frankfurt-postgres\.render\.example/);
    assert.equal(r.plan, 'free');
  } finally { w3.close(); }
  // the app refuses: the database stays, and running it again connects it rather than making a second
  const stuck: any = { refuseEnv: true }, w4 = await world({ render: renderApi(stuck) }), acc4 = w4.acc('render');
  try {
    refused(await w4.o.h('render.create_database', { accountId: acc4, name: 'shop-db', into: 'srv-1' }), /shop-db is made, but shop didn’t take its address.*Run this again/);
    stuck.refuseEnv = false;
    ok(await w4.o.h('render.create_database', { accountId: acc4, name: 'shop-db', into: 'srv-1' }));
    assert.equal(stuck.made.length, 1);
    assert.equal(stuck.put.length, 1);
  } finally { w4.close(); }
});

test('Render says no: a refused key, a second free database, no card on file, and a database that takes too long', async () => {
  const st: any = { refuse: [401, { message: 'unauthorized' }] }, w = await world({ render: renderApi(st) }), acc = w.acc('render');
  try {
    refused(await w.o.h('render.create_database', { accountId: acc, name: 'db' }), /Render refused this key \(unauthorized\)\. Check it in Connections/);
    st.refuse = [400, { message: 'cannot have more than one active free tier database' }];
    refused(await w.o.h('render.create_database', { accountId: acc, name: 'db' }), /Render refused to create the database: cannot have more than one/);
    st.refuse = [402, { message: 'add a card' }];
    refused(await w.o.h('render.create_database', { accountId: acc, name: 'db' }), /Render wants a payment method first.*dashboard\.render\.com\/billing/);
    delete st.refuse;
    const slow = liveTiming.pollMs;
    st.status = Array(100000).fill('creating');
    const real = Date.now;
    let t = real();
    Date.now = () => (t += 120_000);
    try { refused(await w.o.h('render.create_database', { accountId: acc, name: 'db2' }), /Render is still making db2\. It finishes by itself on Render’s dashboard/); } finally { Date.now = real; liveTiming.pollMs = slow; }
  } finally { w.close(); }
});

// --- Render: a cron job -------------------------------------------------------------------------------------------------------
function gitRepo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'remote-')), work = mkdtempSync(join(tmpdir(), 'work-'));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(work, k), v);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...a], { cwd: work, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'first');
  mkdirSync(join(root, 'demo'));
  execFileSync('git', ['clone', '-q', '--bare', work, join(root, 'demo', 'shop.git')], { stdio: 'pipe' });
  process.env.UNIT7_GITHUB_URL = `file://${root}`;
}
const CRON = { name: 'nightly', schedule: '0 3 * * *', command: 'node sync.js', repo: 'demo/shop' };
function cronApi(st: any) {
  const base = renderApi(st);
  return (r: R) => {
    if (r.p === '/services' && r.method === 'POST') { st.made.push(r.json); return st.refuse ?? [201, { service: { id: 'crn-1', name: r.json.name, dashboardUrl: 'https://dashboard.render.example/c/crn-1' }, deployId: 'dep-1' }]; }
    return base(r);
  };
}

test('a cron job on Render costs money, so it’s a person’s: built from their repo, on their schedule, with its price said first', async () => {
  gitRepo({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' }, dependencies: { express: '5.0.0' } }), 'sync.js': 'x' });
  const st: any = {}, w = await world({ render: cronApi(st) }), acc = w.acc('render');
  try {
    assert.equal((await w.o.a('render.create_cron', { accountId: acc, ...CRON })).status, 'denied');
    assert.match(said(await w.o.a('render.create_cron', { accountId: acc, ...CRON })), /at least \$1 a month/);
    assert.equal(st.made.length, 0);
    assert.equal((await w.o.h('render.create_cron', { accountId: acc, ...CRON, schedule: 'every day' })).status, 'error', 'not a cron line');
    const asked = await w.o.h('render.create_cron', { accountId: acc, ...CRON });
    assert.equal(asked.status, 'approval_required');
    assert.match(said(asked), /runs node sync\.js at 0 3 \* \* \* \(UTC\).*\$0\.00016 a minute/);
    const r = ok(await yes(w.app, w.o, asked));
    const b = st.made[0];
    assert.equal(b.type, 'cron_job');
    assert.equal(b.repo, 'https://github.com/demo/shop');
    assert.equal(b.branch, 'main');
    assert.equal(b.ownerId, 'own-1');
    assert.equal(b.serviceDetails.schedule, '0 3 * * *');
    assert.equal(b.serviceDetails.plan, '0.5c-512mb', 'Render has no free plan for these');
    assert.equal(b.serviceDetails.runtime, 'node');
    assert.deepEqual(b.serviceDetails.envSpecificDetails, { buildCommand: 'npm install && npm run build', startCommand: 'node sync.js' });
    assert.equal(r.cronJob, 'crn-1');
    assert.equal(r.times, 'UTC');
    st.services.push({ id: 'crn-1', name: 'nightly', type: 'cron_job' });
    refused(await yes(w.app, w.o, await w.o.h('render.create_cron', { accountId: acc, ...CRON })), /nightly already exists on Render/);
    assert.equal(st.made.length, 1);
  } finally { w.close(); delete process.env.UNIT7_GITHUB_URL; }
});

test('a cron job: a Dockerfile runs the command in its image, a repo Render can’t read says what to do, code it can’t build says so, and a refused key', async () => {
  gitRepo({ Dockerfile: 'FROM node:24\nCMD ["node","a.js"]\n', 'a.js': 'x' });
  const st: any = {}, w = await world({ render: cronApi(st) }), acc = w.acc('render');
  try {
    ok(await yes(w.app, w.o, await w.o.h('render.create_cron', { accountId: acc, ...CRON })));
    assert.equal(st.made[0].serviceDetails.runtime, 'docker');
    assert.deepEqual(st.made[0].serviceDetails.envSpecificDetails, { dockerfilePath: './Dockerfile', dockerCommand: 'node sync.js' });
    st.refuse = [400, { message: 'could not access repo' }];
    refused(await yes(w.app, w.o, await w.o.h('render.create_cron', { accountId: acc, ...CRON })), /Render can’t read demo\/shop.*GitHub connected on Render’s dashboard/);
    st.refuse = [401, { message: 'unauthorized' }];
    refused(await yes(w.app, w.o, await w.o.h('render.create_cron', { accountId: acc, ...CRON })), /Render refused this key/);
    refused(await yes(w.app, w.o, await w.o.h('render.create_cron', { accountId: acc, ...CRON, repo: 'demo/gone' })), /couldn’t read demo\/gone/);
  } finally { w.close(); delete process.env.UNIT7_GITHUB_URL; }
  gitRepo({ 'index.html': '<h1>hi</h1>' });
  const st2: any = {}, w2 = await world({ render: cronApi(st2) }), acc2 = w2.acc('render');
  try {
    refused(await yes(w2.app, w2.o, await w2.o.h('render.create_cron', { accountId: acc2, ...CRON })), /can’t tell how to build this static code/);
    assert.equal(st2.made.length, 0);
  } finally { w2.close(); delete process.env.UNIT7_GITHUB_URL; }
});

// --- Railway: a database ------------------------------------------------------------------------------------------------------
function railwayDb(st: any) {
  st.services ??= ['s1']; st.vars ??= {}; st.upserts ??= []; st.deployed ??= [];
  return ({ json }: R) => {
    const { query, variables: v } = json as { query: string; variables: any };
    if (query.includes('{ me { id } }')) return { data: { me: { id: 'u1' } } };
    if (st.refuse) return { errors: [{ message: 'Not Authorized' }] };
    if (query.includes('variables(projectId')) return { data: { variables: st.vars } };
    if (query.includes('volumes')) return { data: { project: { services: { edges: st.services.map((id: string) => ({ node: { id } })) }, volumes: { edges: [] } } } };
    if (query.includes('template(code')) {
      if (st.noTemplate) return { data: { template: null } };
      return { data: { template: { id: `uuid-${v.c}`, serializedConfig: { services: { abc: { name: 'x', variables: { POSTGRES_PASSWORD: { defaultValue: '${{secret(32)}}', isOptional: false }, PGUSER: { value: 'postgres', defaultValue: 'other' }, NOTE: { isOptional: true } } } } } } } };
    }
    if (query.includes('templateDeployV2')) { st.deployed.push(v.i); if (!st.never) st.later = 2; return { data: { templateDeployV2: { projectId: 'p1', workflowId: 'w1' } } }; }
    if (query.includes('service(id')) return { data: { service: { name: st.name ?? 'Postgres' } } };
    if (query.includes('variableCollectionUpsert')) { st.upserts.push(v.i); return { data: { variableCollectionUpsert: true } }; }
    return undefined;
  };
}
// a new service shows up only some reads after the deploy: Railway answers before it's done
const slowly = (st: any, f: (r: R) => unknown) => (r: R) => { if (st.later !== undefined && r.json.query.includes('volumes') && --st.later === 0) st.services.push('new-db'); return f(r); };

test('a database on Railway bills what it uses, so it’s a person’s: Railway’s own template, then a reference, never an address', async () => {
  const st: any = {}, w = await world({ railway: slowly(st, railwayDb(st)) }), acc = w.acc('railway');
  const input = { accountId: acc, project: 'p1', environment: 'e1', into: 's1' };
  try {
    const ai = await w.o.a('railway.create_database', input);
    assert.equal(ai.status, 'denied');
    assert.match(said(ai), /only a person/);
    assert.equal(st.deployed.length, 0);
    const asked = await w.o.h('railway.create_database', input);
    assert.equal(asked.status, 'approval_required');
    assert.match(said(asked), /\$10 per GB of memory and \$0\.15 per GB of disk/);
    const r = ok(await yes(w.app, w.o, asked));
    const d = st.deployed[0];
    assert.deepEqual([d.projectId, d.environmentId, d.templateId], ['p1', 'e1', 'uuid-postgres'], 'its uuid, not its code: the code deploys nothing');
    const vars = d.serializedConfig.services.abc.variables;
    assert.equal(vars.POSTGRES_PASSWORD.value, '${{secret(32)}}', 'each setting gets its default, as Railway’s command does');
    assert.equal(vars.PGUSER.value, 'postgres', 'a value stays');
    assert.equal(vars.NOTE.value, undefined);
    assert.deepEqual(st.upserts, [{ projectId: 'p1', environmentId: 'e1', serviceId: 's1', variables: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' }, skipDeploys: true }]);
    assert.equal(r.service, 'new-db');
    assert.equal(r.setting, 'DATABASE_URL');
    assert.match(r.next, /Redeploy/);
    assert.match(r.untrusted, /data, not instructions/);
    assert.deepEqual(r.undo.input, { to: 'railway', accountId: acc, project: 'p1/e1/s1', op: 'unset', key: 'DATABASE_URL' });
    assert.equal(get<any>(w.app.db, `SELECT action FROM audit WHERE tool = 'railway.create_database' AND result = 'success'`).action, 'provider_purchase');
  } finally { w.close(); }
});

test('a Railway database: Redis gets its own name, an app’s setting is never replaced, a missing template, one that takes too long, and a refused key', async () => {
  const st: any = { name: 'Redis-x1' }, w = await world({ railway: slowly(st, railwayDb(st)) }), acc = w.acc('railway');
  const input = { accountId: acc, project: 'p1', environment: 'e1' };
  try {
    ok(await yes(w.app, w.o, await w.o.h('railway.create_database', { ...input, engine: 'redis', into: 's1' })));
    assert.equal(st.deployed[0].templateId, 'uuid-redis');
    assert.deepEqual(st.upserts[0].variables, { REDIS_URL: '${{Redis-x1.REDIS_URL}}' }, 'a second one has its own name');
    st.upserts = []; st.deployed = []; delete st.later; st.services = ['s1'];
    ok(await yes(w.app, w.o, await w.o.h('railway.create_database', { ...input, engine: 'mysql' })));
    assert.equal(st.deployed[0].templateId, 'uuid-mysql');
    assert.deepEqual(st.upserts, [], 'no into, so no app changes');
    st.deployed = []; st.vars = { DATABASE_URL: 'postgres://their-live-database' };
    refused(await yes(w.app, w.o, await w.o.h('railway.create_database', { ...input, into: 's1' })), /already has a setting called DATABASE_URL, so Unit7 changed nothing/);
    assert.equal(st.deployed.length, 0, 'found out before anything was made');
    st.vars = {}; st.noTemplate = true;
    refused(await yes(w.app, w.o, await w.o.h('railway.create_database', input)), /Railway has no postgres template right now/);
    delete st.noTemplate; st.never = true; delete st.later;
    const real = Date.now;
    let t = real();
    Date.now = () => (t += 120_000);
    try { refused(await yes(w.app, w.o, await w.o.h('railway.create_database', { ...input, into: 's1' })), /Railway is still adding Postgres\. It finishes by itself.*link\.create/); } finally { Date.now = real; }
    assert.deepEqual(st.upserts, []);
    st.refuse = true;
    refused(await yes(w.app, w.o, await w.o.h('railway.create_database', input)), /Railway: Not Authorized/);
  } finally { w.close(); }
});

// --- DigitalOcean: a domain on an app ---------------------------------------------------------------------------------------
function doApps(st: any) {
  return ({ p, method, json, q }: R) => {
    if (st.refuse) return [401, { id: 'Unauthorized', message: 'Unable to authenticate you' }];
    if (p === '/apps/app-1' && method === 'GET') return { app: st.app };
    if (p === '/apps/app-1' && method === 'PUT') { (st.puts ??= []).push(json); st.app.spec = json.spec; return { app: st.app }; }
    if (p === '/domains/example.com/records' && method === 'GET') { assert.ok(q.get('name')); return { domain_records: [] }; }
    if (p === '/domains/example.com/records' && method === 'POST') { (st.records ??= []).push(json); return [201, { domain_record: { id: 1 } }]; }
    if (p === '/domains/example.com') return { domain: { name: 'example.com' } };
    return undefined;
  };
}
const SPEC = () => ({ name: 'shop', envs: [{ key: 'API_KEY', type: 'SECRET', value: 'EV[1:sealed]' }], services: [{ name: 'web', http_port: 3000 }] });

test('a domain on a DigitalOcean app: it goes in the spec with the rest left as it was, DNS follows, and only one name is the main one', async () => {
  dnsLook.host = async () => ({ zone: 'example.com', host: 'digitalocean', nameservers: [] }) as never;
  const st: any = { app: { id: 'app-1', spec: SPEC(), default_ingress: 'https://shop-a1b2.ondigitalocean.example' } };
  const w = await world({ do: doApps(st) }), acc = w.acc('digitalocean');
  const target = { digitalocean: { accountId: acc, app: 'app-1' } };
  try {
    const asked = await w.o.a('domain.point', { hostname: 'app.example.com', ...target });
    assert.equal(asked.status, 'approval_required', 'a name leaving Unit7’s hands waits for a person');
    const r = ok(await w.o.h('domain.point', { hostname: 'app.example.com', ...target }));
    assert.deepEqual(st.puts[0].spec.domains, [{ domain: 'app.example.com', type: 'PRIMARY' }]);
    assert.deepEqual(st.puts[0].spec.envs, SPEC().envs, 'a sealed value goes back as it came');
    assert.deepEqual(st.puts[0].spec.services, SPEC().services);
    assert.deepEqual(r.dns, ['digitalocean: CNAME app.example.com → shop-a1b2.ondigitalocean.example']);
    assert.deepEqual(st.records, [{ type: 'CNAME', name: 'app', data: 'shop-a1b2.ondigitalocean.example.', ttl: 300 }]);
    assert.equal(get<any>(w.app.db, `SELECT status FROM domains WHERE hostname = 'app.example.com'`).status !== undefined, true);
    // a second name is an alias, and asking again changes nothing
    ok(await w.o.h('domain.point', { hostname: 'www.example.com', ...target }));
    assert.deepEqual(st.puts[1].spec.domains.map((d: any) => d.type), ['PRIMARY', 'ALIAS']);
    ok(await w.o.h('domain.point', { hostname: 'www.example.com', ...target }));
    assert.equal(st.puts.length, 2);
    // the bare domain can't be a CNAME: App Platform's own address
    const apex = ok(await w.o.h('domain.point', { hostname: 'example.com', ...target }));
    assert.deepEqual(apex.dns, ['digitalocean: A example.com → 162.159.140.98']);
  } finally { w.close(); }
});

test('a DigitalOcean app with no address yet, a refused key, and what the map and the links make of an app there', async () => {
  dnsLook.host = async () => ({ zone: 'example.com', host: 'digitalocean', nameservers: [] }) as never;
  const st: any = { app: { id: 'app-1', spec: SPEC() } }, w = await world({ do: doApps(st) }), acc = w.acc('digitalocean');
  const target = { digitalocean: { accountId: acc, app: 'app-1' } };
  try {
    refused(await w.o.h('domain.point', { hostname: 'app.example.com', ...target }), /no address on DigitalOcean yet/);
    assert.equal(st.puts, undefined, 'nothing changed');
    st.refuse = true;
    refused(await w.o.h('domain.point', { hostname: 'app.example.com', ...target }), /DigitalOcean: Unable to authenticate you/);
    const end = { kind: 'digitalocean' as const, accountId: acc, app: 'app-1' };
    assert.deepEqual(thingsFrom([{ provider: 'digitalocean', kind: 'app', extId: 'app-app-1', name: 'shop', end, envKeys: [] }]), [], 'no link reaches it yet, so none is suggested');
    assert.ok(getTool('domain.point')!.input.safeParse({ hostname: 'a.example.com', digitalocean: { accountId: acc, app: 'app-1' } }).success, 'what live.put hands over');
  } finally { w.close(); }
});

// --- DigitalOcean: buying and resizing a Droplet ------------------------------------------------------------------------------
const SIZES = [
  { slug: 's-2vcpu-4gb', vcpus: 2, memory: 4096, disk: 80, price_monthly: 24, regions: ['nyc3', 'ams3'], available: true },
  { slug: 's-1vcpu-512mb-10gb', vcpus: 1, memory: 512, disk: 10, price_monthly: 4, regions: ['ams3'], available: true },
  { slug: 's-1vcpu-1gb', vcpus: 1, memory: 1024, disk: 25, price_monthly: 6, regions: ['nyc3'], available: true },
  { slug: 's-1vcpu-2gb', vcpus: 1, memory: 2048, disk: 50, price_monthly: 12, regions: ['nyc3'], available: true },
  { slug: 's-8vcpu-16gb', vcpus: 8, memory: 16384, disk: 320, price_monthly: 96, regions: ['nyc3'], available: true },
  { slug: 'gone-1', vcpus: 1, memory: 1024, disk: 25, price_monthly: 1, regions: ['nyc3'], available: false },
];
const REGIONS = [{ slug: 'nyc3', name: 'New York 3', available: true }, { slug: 'old1', name: 'Closed', available: false }, { slug: 'ams3', name: 'Amsterdam 3', available: true }];
function droplets(st: any) {
  st.log ??= []; st.bodies ??= [];
  return ({ p, method, json }: R) => {
    if (st.refuse) return [401, { id: 'Unauthorized', message: 'Unable to authenticate you' }];
    if (p === '/sizes') return { sizes: SIZES, links: {} };
    if (p === '/regions') return { regions: REGIONS, links: {} };
    if (p === '/account/keys') { st.key = json; return [201, { ssh_key: { id: 7 } }]; }
    if (p === '/droplets' && method === 'POST') { st.created = json; return [202, { droplet: { id: 55 } }]; }
    if (p === '/droplets/55') return { droplet: { id: 55, status: st.polls-- > 0 ? 'new' : 'active', networks: { v4: [{ ip_address: '10.0.0.5', type: 'private' }, { ip_address: '203.0.113.55', type: 'public' }] } } };
    if (p === '/droplets/9') return { droplet: st.box };
    if (p === '/droplets/9/actions' && method === 'POST') {
      st.log.push(json.type); st.bodies.push(json);
      if (json.type === 'shutdown' && !st.hangs) st.box.status = 'off';
      if (json.type === 'resize') { if (st.refuseResize) return [422, { id: 'unprocessable_entity', message: 'cannot resize to that size' }]; if (!st.fails) st.box.size_slug = json.size; st.box.status = 'off'; }
      if (json.type === 'power_on') st.box.status = 'active';
      return [201, { action: { id: 77, status: 'in-progress' } }];
    }
    if (p === '/droplets/9/actions/77') return { action: { status: st.steps?.shift() ?? (st.fails ? 'errored' : 'completed') } };
    return undefined;
  };
}
async function dropletWorld(st: any) {
  const w = await world({ do: droplets(st) }), acc = w.acc('digitalocean'), sid = id('srv'), keys = ssh2.utils.generateKeyPairSync('ed25519');
  st.box ??= { size_slug: 's-1vcpu-2gb', disk: 50, status: 'active', region: { slug: 'nyc3' } };
  w.app.vault.put(w.o.orgId, 'credential://ssh/drop/private-key', keys.private, { kind: 'ssh_key', by: 'test' });
  run(w.app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts, provider_ref, account_id) VALUES (?, ?, 'drop', '203.0.113.9', 'root', 'credential://ssh/drop/private-key', 'ready', ?, 'digitalocean:droplet:9', ?)`, sid, w.o.orgId, JSON.stringify({ sudo: 'root', cpus: 1, mem_total: 2e9, mem_available: 1e9, disk_total: 50e9, disk_used: 10e9 }), acc);
  ssh(w.app).exec = async () => ({ code: 1, stdout: '', stderr: 'not here', truncated: false });
  return { ...w, acc, sid };
}

test('a Droplet to buy: the four cheapest at today’s price, an AI may look but never buy, and a person’s yes gets one running and connected', { timeout: 60_000 }, async () => {
  const st: any = { polls: 2 }, w = await world({ do: droplets(st) }), acc = w.acc('digitalocean');
  try {
    const offers = ok(await w.o.a('server.offers', {})).offers;
    assert.deepEqual(offers.map((x: any) => [x.plan, x.monthly, x.location, x.where]), [['s-1vcpu-512mb-10gb', 4, 'ams3', 'Amsterdam 3'], ['s-1vcpu-1gb', 6, 'nyc3', 'New York 3'], ['s-1vcpu-2gb', 12, 'nyc3', 'New York 3'], ['s-2vcpu-4gb', 24, 'nyc3', 'New York 3']], 'not one that’s sold out');
    assert.equal(offers[1].provider, 'digitalocean');
    assert.equal(offers[1].memoryGb, 1);
    const input = { provider: 'digitalocean', accountId: acc, plan: 's-1vcpu-1gb', location: 'nyc3' };
    const ai = await w.o.a('server.buy', input);
    assert.equal(ai.status, 'denied', 'never an AI, not even with approval');
    assert.equal(st.created, undefined);
    refused(await yes(w.app, w.o, await w.o.h('server.buy', { provider: 'digitalocean', accountId: acc })), /Pick a plan from server\.offers/);
    // what the box says it is: nothing there yet, so it prepares itself
    ssh(w.app).exec = async (_s, c, x = {}) => {
      const stdin = String(x.stdin ?? '');
      if (c.includes('os_id=')) return { code: 0, stdout: 'os=Ubuntu 24.04\ncpus=1\nmem_total=1000000000\nmem_available=800000000\ndisk_total=25000000000\ndisk_used=1000000000\ndocker=27.0.1\nhas=ufw\nuser=root\nsudo=root\nports=22,\n', stderr: '', truncated: false };
      if (stdin.includes('s ctrs')) return { code: 0, stdout: '@@unit7:host\nos=Ubuntu\n@@unit7:ports\ntcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))\n', stderr: '', truncated: false };
      return { code: 0, stdout: '', stderr: '', truncated: false };
    };
    const asked = await w.o.h('server.buy', input);
    assert.equal(asked.status, 'approval_required', 'it waits for the person’s explicit yes');
    assert.match(said(asked), /Buys a server at DigitalOcean.*costs money every month/);
    const r = ok(await yes(w.app, w.o, asked));
    assert.equal(r.connected, true, JSON.stringify(r));
    assert.deepEqual(st.created, { name: r.bought, region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64', ssh_keys: [7] });
    assert.match(st.key.public_key, /^ssh-/);
    assert.doesNotMatch(JSON.stringify(st.key), /PRIVATE KEY/);
    const srv = get<any>(w.app.db, `SELECT * FROM servers WHERE provider_ref = 'digitalocean:droplet:55'`);
    assert.equal(srv.host, '203.0.113.55', 'the public address, not the private one');
    assert.equal(get<any>(w.app.db, `SELECT action FROM audit WHERE tool = 'server.buy' AND result = 'success'`).action, 'provider_purchase');
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE KEY/);
  } finally { w.close(); }
});

test('a Droplet that never starts says the money is spent and where it is, and a refused key buys nothing', { timeout: 30_000 }, async () => {
  const st: any = { polls: 1e9 }, w = await world({ do: droplets(st) }), acc = w.acc('digitalocean');
  const waited = buyDeps.waitMs;
  buyDeps.waitMs = 1;
  try {
    const input = { provider: 'digitalocean', accountId: acc, plan: 's-1vcpu-1gb', location: 'nyc3', name: 'box' };
    refused(await yes(w.app, w.o, await w.o.h('server.buy', input)), /DigitalOcean made the Droplet \(box\) but it isn’t running yet.*connect it from Servers/);
    st.refuse = true;
    const before = st.created;
    st.created = undefined;
    refused(await yes(w.app, w.o, await w.o.h('server.buy', input)), /DigitalOcean: Unable to authenticate you/);
    assert.equal(st.created, undefined);
    assert.ok(before);
  } finally { buyDeps.waitMs = waited; w.close(); }
});

test('a Droplet resize: what fits, an AI never does it, the power off is said first, and a person’s yes stops it, moves it and starts it', { timeout: 30_000 }, async () => {
  const st: any = { steps: ['in-progress', 'completed'] }, w = await dropletWorld(st);
  try {
    const r = ok(await w.o.a('server.resize', { serverId: w.sid }));
    assert.equal(r.how.tool, 'server.resize', 'no page to go to any more');
    assert.deepEqual(r.plans.map((p: any) => [p.plan, p.fits]), [['s-1vcpu-1gb', false], ['s-1vcpu-2gb', true], ['s-2vcpu-4gb', true], ['s-8vcpu-16gb', true]], 'only this region’s, and a smaller disk doesn’t fit');
    assert.match(r.plans[0].why, /can’t make a 50 GB disk smaller/);
    assert.ok(r.plans[1].current);
    const ai = await w.o.a('server.resize', { serverId: w.sid, plan: 's-2vcpu-4gb' });
    assert.equal(ai.status, 'denied');
    assert.deepEqual(st.log, []);
    const asked = await w.o.h('server.resize', { serverId: w.sid, plan: 's-2vcpu-4gb' });
    assert.equal(asked.status, 'approval_required');
    assert.match(said(asked), /has to be powered off first, so everything on it stops/);
    assert.deepEqual(st.log, [], 'nothing stops before the person says yes');
    await assert.rejects(yes(w.app, w.o, asked), /Type the name/, 'a person types its name');
    const out = await yes(w.app, w.o, asked, 'drop') as any;
    assert.equal(out.status, 'ok', JSON.stringify(out));
    assert.deepEqual(st.log, ['shutdown', 'resize', 'power_on']);
    assert.deepEqual(st.bodies[1], { type: 'resize', size: 's-2vcpu-4gb', disk: false }, 'the disk stays, so it can come back down');
    assert.equal(st.box.status, 'active');
    assert.equal(out.output.resized, true);
    assert.match(out.output.note, /disk stayed the same/);
    const srv = get<any>(w.app.db, 'SELECT monthly_price, price_source FROM servers WHERE id = ?', w.sid);
    assert.deepEqual([srv.monthly_price, srv.price_source], [24, 'DigitalOcean'], 'its price follows');
    const again = await yes(w.app, w.o, await w.o.h('server.resize', { serverId: w.sid, plan: 's-1vcpu-1gb' }), 'drop') as any;
    assert.match(again.error.message, /too small/);
    assert.deepEqual(st.log, ['shutdown', 'resize', 'power_on'], 'nothing happened');
  } finally { w.close(); }
});

test('a Droplet resize that fails doesn’t stay off, a clean stop that hangs doesn’t stop it, an off one needs no stop, and a refused key changes nothing', { timeout: 30_000 }, async () => {
  const bad: any = { fails: true }, w = await dropletWorld(bad);
  try {
    refused(await yes(w.app, w.o, await w.o.h('server.resize', { serverId: w.sid, plan: 's-2vcpu-4gb' }), 'drop'), /DigitalOcean couldn’t move it to s-2vcpu-4gb, so it stays on its old plan/);
    assert.deepEqual(bad.log, ['shutdown', 'resize', 'power_on']);
    assert.equal(bad.box.status, 'active');
  } finally { w.close(); }
  const no: any = { refuseResize: true }, w2 = await dropletWorld(no);
  try {
    refused(await yes(w2.app, w2.o, await w2.o.h('server.resize', { serverId: w2.sid, plan: 's-2vcpu-4gb' }), 'drop'), /DigitalOcean: cannot resize to that size/);
    assert.deepEqual(no.log, ['shutdown', 'resize', 'power_on'], 'turned back on');
  } finally { w2.close(); }
  const hung: any = { hangs: true }, w3 = await dropletWorld(hung);
  try {
    ok(await yes(w3.app, w3.o, await w3.o.h('server.resize', { serverId: w3.sid, plan: 's-2vcpu-4gb' }), 'drop'));
    assert.deepEqual(hung.log, ['shutdown', 'resize', 'power_on'], 'DigitalOcean powers it down itself for the resize');
  } finally { w3.close(); }
  const off: any = { box: { size_slug: 's-1vcpu-2gb', disk: 50, status: 'off', region: { slug: 'nyc3' } } }, w4 = await dropletWorld(off);
  try {
    ok(await yes(w4.app, w4.o, await w4.o.h('server.resize', { serverId: w4.sid, plan: 's-2vcpu-4gb' }), 'drop'));
    assert.deepEqual(off.log, ['resize', 'power_on']);
  } finally { w4.close(); }
  const refusedKey: any = {}, w5 = await dropletWorld(refusedKey);
  try {
    refusedKey.refuse = true;
    refused(await w5.o.h('server.resize', { serverId: w5.sid }), /DigitalOcean: Unable to authenticate you/);
    assert.deepEqual(refusedKey.log, []);
  } finally { w5.close(); }
});

test('an app’s buttons say what a person can add beside it, and where it goes', async () => {
  const w = await world({}), ren = w.acc('render'), rw = w.acc('railway'), fl = w.acc('fly');
  try {
    asset(w.app, w.o, { id: 'ast_renderapp001', acc: ren, provider: 'render', ext: 'srv-1', name: 'shop' });
    asset(w.app, w.o, { id: 'ast_renderdb0001', acc: ren, provider: 'render', ext: 'dpg-1', name: 'shop-db', kind: 'database' });
    asset(w.app, w.o, { id: 'ast_railwayapp01', acc: rw, provider: 'railway', ext: 'e1/s1', name: 'shop', end: { ...RAILWAY_END, accountId: rw } });
    asset(w.app, w.o, { id: 'ast_flyapp000001', acc: fl, provider: 'fly', ext: 'fly-id', name: 'shop', end: { kind: 'fly', accountId: fl, app: 'shop' } });
    const render = ok(await w.o.h('cloud.app_actions', { asset: 'ast_renderapp001' })).adds;
    assert.deepEqual(render.database, { tool: 'render.create_database', input: { accountId: ren, into: 'srv-1' } });
    assert.equal(render.cron.tool, 'render.create_cron');
    assert.deepEqual(ok(await w.o.h('cloud.app_actions', { asset: 'ast_railwayapp01' })).adds, { database: { tool: 'railway.create_database', input: { accountId: rw, project: 'p1', environment: 'e1', into: 's1' } } });
    assert.equal(ok(await w.o.h('cloud.app_actions', { asset: 'ast_flyapp000001' })).adds, undefined);
    assert.equal(ok(await w.o.h('cloud.app_actions', { asset: 'ast_renderdb0001' })).adds, undefined, 'a database gets none');
    // each button’s input is what its tool takes
    assert.ok(getTool('render.create_database')!.input.safeParse({ ...render.database.input, name: 'shop-db' }).success);
    assert.ok(getTool('railway.create_database')!.input.safeParse({ accountId: rw, project: 'p1', environment: 'e1', into: 's1' }).success);
  } finally { w.close(); }
});

test('hosted.plans gives a person every price with where it stands, and the AI’s small key can reach what’s free and no more', async () => {
  const w = await world({});
  try {
    const p = ok(await w.o.a('hosted.plans', {}));
    assert.deepEqual(p.render.postgres.map((x: any) => [x.id, !!x.paid]), [['free', false], ['0.1c-256mb', true], ['0.5c-1g', true], ['1c-2g', true], ['1c-4g', true]]);
    assert.ok(p.render.cron.every((x: any) => x.paid && /at least \$1 a month/.test(x.price)), 'Render has no free cron job');
    assert.match(p.railway.price, /\$10 per GB/);
    assert.match(p.render.freePostgres, /30 days/);
  } finally { w.close(); }
  for (const t of ['cloud.redeploy', 'hosted.plans', 'render.create_database']) assert.ok(PROFILES.ops!.includes(t), t);
  for (const name of Object.keys(PROFILES)) for (const t of ['render.create_cron', 'railway.create_database', 'server.buy']) assert.ok(!PROFILES[name]!.includes(t), `${name}: ${t} can only be a person’s`);
  for (const t of ['render.create_cron', 'railway.create_database']) assert.equal(typeof (getTool(t)!.peopleOnly as any)({}), 'string', t);
});
