// Smaller tightenings: wrong root passwords are counted per address from the audit (a restart or re-adding the server
// gives no extra tries); "important" also covers a map item, a deployment, a port and a domain; Uptime Kuma's stored
// login only goes to the Uptime Kuma it belongs to; Warden's own fixes never file approvals; and the billing export Unit7
// reads is pinned, shown, and only changed by a person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account } from './clouds-fakes.ts';
import { all, get, id, json, run } from '../src/db.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { importantTouched } from '../src/kept.ts';
import { assetIdOf } from '../src/archive.ts';
import { saveXray } from '../src/tools/xray.ts';
import { madeSet } from '../src/tools/staging.ts';
import { kumaRef } from '../src/tools/uptime.ts';
import { serverFindings } from '../src/tools/security.ts';
import { Warden } from '../src/sentinel/warden.ts';
import { fakeKuma, isKumaTrip, runInKuma } from './kuma-fixture.ts';

process.env.UNIT7_SKIP_NET_PROBE = '1';
process.env.UNIT7_GCLOUD_BIN = fileURLToPath(new URL('./fake-cloud-cli.mjs', import.meta.url));
const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
const server = (app: ReturnType<typeof testApp>, orgId: string, host = '203.0.113.9', extra = '') => {
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts, ssh_block) VALUES (?, ?, ?, ?, 'root', 'credential://ssh/box/private-key', 'ready', '{}', ?)`,
    srv, orgId, `box-${srv.slice(-4)}`, host, extra || null);
  return srv;
};

// --- L1 -------------------------------------------------------------------------------------------------------------------
test('three wrong root passwords for an address stop the next try, after a restart and on a re-added server too', async () => {
  const app = testApp(), o = await testOrg(app);
  const fails = (host: string, minutesAgo: number, n = 3) => {
    for (let k = 0; k < n; k++) run(app.db, `INSERT INTO audit (id, org_id, actor_kind, actor_id, actor_name, tool, action, risk, input, result, error, resources, created_at) VALUES (?, ?, 'user', ?, 'Ada', 'server.install_key_with_password', 'server_write', 'write', '{}', 'error', 'wrong_password: no', ?, ?)`,
      id('aud'), o.orgId, o.userId, JSON.stringify([`ssh:${host}:22`]), new Date(Date.now() - minutesAgo * 60_000).toISOString());
  };
  const tryIt = (serverId: string) => o.h('server.install_key_with_password', { serverId, password: 'not-it', fingerprint: `SHA256:${'A'.repeat(43)}` });
  // the old server's three wrong tries (Unit7 restarted since: nothing in memory), then the server removed and added again
  fails('203.0.113.50', 2);
  const readded = server(app, o.orgId, '203.0.113.50', 'host_key');
  const r = await tryIt(readded);
  assert.equal(r.status === 'error' && r.error.code, 'too_many_tries', JSON.stringify(r));
  // tries older than 10 minutes, or another address, don't count (it goes on, here to the host-key check)
  fails('203.0.113.51', 11);
  const other = await tryIt(server(app, o.orgId, '203.0.113.51', 'host_key'));
  assert.equal(other.status === 'error' && other.error.code, 'host_key_changed');
  const tryRow = get<{ resources: string }>(app.db, `SELECT resources FROM audit WHERE tool = 'server.install_key_with_password' AND error LIKE 'host_key%'`)!;
  assert.deepEqual(json(tryRow.resources, []), ['ssh:203.0.113.51:22'], 'each try records its address');
});

// --- L2 -------------------------------------------------------------------------------------------------------------------
test('important: a map item, a deployment, the part behind a port and a domain (or its www sibling) are recognised', async () => {
  const app = testApp(), o = await testOrg(app);
  const p = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] }));
  const svc = ok(await o.h('service.create', { environmentId: p.environments[0].id, name: 'web', source: { type: 'git', repo: 'sam/shop' } })).serviceId;
  const dep = id('dep');
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status) VALUES (?, ?, ?, 1, 'live')`, dep, o.orgId, svc);
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls) VALUES (?, ?, 'shop.example.com', ?, 'active', 'active')`, id('dom'), o.orgId, svc);
  const srv = server(app, o.orgId);
  saveXray(app.db, o.orgId, srv, 'fast', { version: 1, at: new Date().toISOString(), server: {}, paas: [], projects: [], loose: [], ports: [], repos: [], summary: '', notes: [],
    parts: [{ id: 'c:api', kind: 'app', name: 'api', owner: 'compose', trust: 'seen', containers: ['api-1'], ports: [{ port: 8080, proto: 'tcp', ip: '0.0.0.0', public: true }] }] });
  const asset = (provider: string, kind: string, ext: string, name: string, meta = {}) => {
    const a = assetIdOf(o.orgId, `${provider}:${ext}`);
    run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, a, o.orgId, provider, kind, ext, name, JSON.stringify(meta), new Date().toISOString());
    return a;
  };
  const run1 = asset('gcp', 'app', 'shop-prod/run/api', 'cloud api'), part = asset('compose', 'app', `${srv}/c:api`, 'api'), blog = asset('domain', 'domain', 'blog.example.com', 'blog.example.com');
  const found = asset('compose', 'app', `${srv}/c:docs`, 'docs', { hosts: ['docs.example.com'] });
  for (const key of [p.projectId, run1, part, blog, found]) run(app.db, `INSERT INTO kept (org_id, key, name, kind, important) VALUES (?, ?, 'x', 'app', 1)`, o.orgId, key);
  assert.equal(importantTouched(app.db, o.orgId, { asset: run1, mode: 'redeploy' }), 'cloud api');
  assert.equal(importantTouched(app.db, o.orgId, { deploymentId: dep }), 'web');
  assert.equal(importantTouched(app.db, o.orgId, { serverId: srv, port: 8080 }), 'api');
  assert.equal(importantTouched(app.db, o.orgId, { serverId: srv, port: 9999 }), undefined);
  assert.equal(importantTouched(app.db, o.orgId, { domain: 'www.shop.example.com', prefer: 'www' }), 'web', 'the apex serves an important app');
  assert.equal(importantTouched(app.db, o.orgId, { domain: 'blog.example.com' }), 'blog.example.com');
  assert.equal(importantTouched(app.db, o.orgId, { domain: 'docs.example.com' }), 'docs');
  assert.equal(importantTouched(app.db, o.orgId, { domain: 'other.example.com' }), undefined);
});

// --- L3 -------------------------------------------------------------------------------------------------------------------
test('Uptime Kuma: the stored login goes only to the Uptime Kuma it belongs to', async () => {
  const PW = 'U7akumaAdminPw0123456789abcdef0123456';
  const kuma = fakeKuma({ users: [{ username: 'admin', password: PW }] });
  const app = testApp(), o = await testOrg(app);
  const srv = server(app, o.orgId);
  saveXray(app.db, o.orgId, srv, 'fast', { parts: [
    { id: 'c:kuma', kind: 'app', name: 'uptime-kuma', product: { id: 'uptimekuma', name: 'Uptime Kuma' }, containers: ['kuma-1'], hosts: ['status.example.com'] },
    { id: 'c:mine', kind: 'app', name: 'uptime-kuma', product: { id: 'uptimekuma', name: 'Uptime Kuma' }, containers: ['uptime-kuma-kuma01'], hosts: ['uptime.example.com'] },
  ] } as never);
  madeSet({ db: app.db, orgId: o.orgId }, 'addon', `${srv}:uptime-kuma`, { via: 'coolify', uuid: 'kuma01', url: 'https://uptime.example.com', creds: [] });
  app.vault.put(o.orgId, kumaRef(srv), PW, { kind: 'addon_credential', meta: { addon: 'uptime-kuma', label: 'Admin password (user admin)', people: true, user: 'admin' } });
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, opt: ExecOptions = {}) => { seen.push(command); return isKumaTrip(command) ? runInKuma(kuma.dir, String(opt.stdin ?? '')) : done(); };
  // an AI picks the other Uptime Kuma on the box: refused, and nothing is sent to it
  for (const r of [await o.a('uptime.sync', { serverId: srv, part: 'c:kuma' }), await o.h('uptime.sync', { serverId: srv, part: 'kuma-1' })]) {
    assert.equal(r.status === 'error' && r.error.code, 'other_kuma', JSON.stringify(r));
  }
  assert.ok(!seen.some(isKumaTrip), 'the login never left');
  // the one Unit7 installed: as before
  assert.equal(ok(await o.a('uptime.sync', { serverId: srv })).synced, true);
  assert.equal(seen.filter(isKumaTrip).length, 1);
  assert.ok(seen.find(isKumaTrip)!.endsWith(`'uptime-kuma-kuma01'`));
});

// --- L5 -------------------------------------------------------------------------------------------------------------------
test('Warden’s own fixes: one the gate would ask about is left as a suggestion, with no approval and nothing on the phone', async () => {
  const app = testApp(), o = await testOrg(app);
  const srv = server(app, o.orgId);
  run(app.db, `UPDATE servers SET facts = ? WHERE id = ?`, JSON.stringify({ web: 'unit7-caddy|caddy:2', sudo: 'root' }), srv);
  const audit = '@@unit7 ufw\nStatus: active\n@@unit7 docker\nshop-db|postgres:16|0.0.0.0:5432->5432/tcp\n@@unit7 end';
  const { findings } = serverFindings({ id: srv, name: 'box', port: 22, provider_ref: null }, { web: 'unit7-caddy|caddy:2' }, audit);
  run(app.db, `INSERT INTO security_reports (id, org_id, server_id, by, score, counts, findings, notes, fresh, ms, created_at) VALUES (?, ?, NULL, 'Warden', 50, '{}', ?, '[]', '[]', 1, ?)`, id('sec'), o.orgId, JSON.stringify(findings), new Date().toISOString());
  ssh(app).exec = async (_s, c: string) => (c.includes('unit7-close-') ? done('done') : done());
  // a person made closing ports something they confirm: Warden doesn't ask every day, it leaves it
  run(app.db, `UPDATE orgs SET rules = ? WHERE id = ?`, JSON.stringify({ server_write: 'restricted' }), o.orgId);
  await new Warden(app).autofixNow();
  assert.equal(all(app.db, 'SELECT 1 FROM approvals').length, 0, 'no approval filed');
  assert.equal(all(app.db, `SELECT 1 FROM events WHERE type IN ('approval.requested', 'autofix.applied')`).length, 0, 'nothing on the phone');
  assert.equal(all(app.db, 'SELECT 1 FROM autofixes').length, 0);
  // allowed again: it fixes it by itself, as before (the switch stays on by default)
  run(app.db, `UPDATE orgs SET rules = '{}' WHERE id = ?`, o.orgId);
  await new Warden(app).autofixNow();
  assert.deepEqual(all<{ status: string }>(app.db, 'SELECT status FROM autofixes').map((r) => r.status), ['applied']);
});

// --- L6 -------------------------------------------------------------------------------------------------------------------
test('the billing export is pinned when first found, shown on the card, and never switched without a person', async () => {
  const state = { tables: { 'shop-prod': ['gcp_billing_export_v1_0A0A0A_1B1B1B_2C2C2C'], 'shared-by-someone': [] as string[] } as Record<string, string[]> };
  const api = await fakeApi(({ method, path }) => {
    const p = new URL(path, 'http://x').pathname;
    if (p === '/cloudresourcemanager/v1/projects') return { projects: [{ projectId: 'shared-by-someone' }, { projectId: 'shop-prod' }] };
    if (p.startsWith('/cloudbilling/')) return {};
    const ds = /^\/bigquery\/bigquery\/v2\/projects\/([^/]+)\/datasets$/.exec(p);
    if (ds) return { datasets: [{ datasetReference: { datasetId: 'billing', projectId: ds[1] }, location: 'EU' }] };
    const tb = /^\/bigquery\/bigquery\/v2\/projects\/([^/]+)\/datasets\/billing\/tables$/.exec(p);
    if (tb) return { tables: (state.tables[tb[1]!] ?? []).map((tableId) => ({ tableReference: { tableId } })) };
    if (/\/queries$/.test(p) && method === 'POST') return { jobComplete: true, totalBytesBilled: '10485760', schema: { fields: ['day', 'project', 'service', 'currency', 'cost'].map((name) => ({ name })) }, rows: [] };
  });
  process.env.UNIT7_GOOGLE_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const g = account(app, o.orgId, 'gcp', JSON.stringify({ cli: 'gcloud', account: 'sam@example.com' }), 'Google Cloud');
    const first = ok(await o.h('cloud.billing', { accountId: g }));
    assert.deepEqual([first.export.found, first.export.from], [true, 'shop-prod.billing'], 'the card says where costs come from');
    assert.match(first.note, /^Reading costs from shop-prod\.billing\./);
    assert.deepEqual(json(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', g)!.meta, {} as any).billingExport,
      { project: 'shop-prod', dataset: 'billing', table: 'gcp_billing_export_v1_0A0A0A_1B1B1B_2C2C2C' }, 'pinned on first discovery');

    // the pinned table goes away and another project (shared with this sign-in) has one: nothing is read from it
    state.tables['shop-prod'] = [];
    state.tables['shared-by-someone'] = ['gcp_billing_export_v1_9Z9Z9Z_8Y8Y8Y_7X7X7X'];
    const look = ok(await o.h('cloud.billing_export', { accountId: g }));
    assert.equal(look.found, false);
    assert.equal(look.pinned, 'shop-prod.billing.gcp_billing_export_v1_0A0A0A_1B1B1B_2C2C2C');
    assert.equal(look.other, 'shared-by-someone.billing.gcp_billing_export_v1_9Z9Z9Z_8Y8Y8Y_7X7X7X');
    const bill = ok(await o.h('cloud.billing', { accountId: g }));
    assert.deepEqual([bill.export.found, bill.spend], [false, null], 'never switched by itself');
    assert.match(bill.note, /reads costs only from shop-prod\.billing/);
    assert.ok(!api.calls.some((c) => c.path.includes('/projects/shared-by-someone/queries')), 'the other table was never queried');

    // a person confirms it (an AI can't)
    assert.equal((await o.a('cloud.billing_export_use', look.confirm.input)).status, 'denied');
    ok(await o.h('cloud.billing_export_use', look.confirm.input));
    assert.equal(ok(await o.h('cloud.billing', { accountId: g })).export.from, 'shared-by-someone.billing');
  } finally { api.close(); delete process.env.UNIT7_GOOGLE_API; }
});
