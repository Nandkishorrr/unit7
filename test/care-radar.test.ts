// The cost radar: one monthly number, split by provider, project and client without counting anything twice, the
// month against the last, and "save" ideas from real signals whose actions are a person's to take. No provider is
// asked anything; exchange rates are a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, run } from '../src/db.ts';
import { saveXray } from '../src/tools/xray.ts';
import { getTool } from '../src/tools/runtime.ts';
import { costRadar } from '../src/care/radar.ts';

const AT = new Date('2026-10-16T00:00:00Z'); // 15 of 31 days gone
const ago = (days: number) => new Date(AT.getTime() - days * 86400_000).toISOString();
const fx = async (from: string[], to: string) => ({ [to]: 1, EUR: 1.1 }) as Record<string, number>;

async function world() {
  const app = testApp();
  const o = await testOrg(app);
  const db = app.db;
  const cost = (provider: string, label: string, amount: number, kind: string) => run(db, `INSERT INTO costs (org_id, provider, account, label, amount, currency, kind, at) VALUES (?, ?, 'main', ?, ?, 'USD', ?, ?)`, o.orgId, provider, label, amount, kind, ago(0));
  cost('vercel', 'team (usage this month)', 30, 'spent');
  cost('cloudflare', 'example.com (Pro)', 20, 'monthly');
  cost('hostinger', 'KVM 2', 12, 'monthly'); // the VPS below: counted once
  const srvA = id('srv'), srvB = id('srv');
  run(db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, provider_ref, monthly_price, price_currency, price_source) VALUES (?, ?, 'box-a', '203.0.113.1', 'credential://ssh/a/k', 'ready', 'hostinger:vm:1', 12, 'USD', 'Hostinger')`, srvA, o.orgId);
  run(db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, monthly_price, price_currency, price_source) VALUES (?, ?, 'box-b', '203.0.113.2', 'credential://ssh/b/k', 'ready', 10, 'EUR', 'you')`, srvB, o.orgId);

  const project = async (name: string, created: number) => {
    const p = ok(await o.h('project.create', { name, environments: ['production'] }));
    run(db, 'UPDATE projects SET created_at = ? WHERE id = ?', ago(created), p.projectId);
    return { id: p.projectId as string, env: p.environments[0].id as string };
  };
  const svc = (p: { id: string; env: string }, name: string, kind = 'app') => { const s = id('svc'); run(db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'healthy')`, s, o.orgId, p.id, p.env, srvA, name, name, kind); return s; };
  const deployed = (s: string, days: number) => run(db, `INSERT INTO deployments (id, org_id, service_id, number, status, started_at, finished_at) VALUES (?, ?, ?, 1, 'live', ?, ?)`, id('dep'), o.orgId, s, ago(days), ago(days));
  const shop = await project('Shop', 300);
  deployed(svc(shop, 'web'), 3);
  svc(shop, 'db', 'postgres'); svc(shop, 'db-old', 'postgres'); // two of the same database in one place
  const old = await project('Old', 200);
  const oldWeb = svc(old, 'web'); deployed(oldWeb, 120);
  run(db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls) VALUES (?, ?, 'old.example.com', ?, 'active', 'active')`, id('dom'), o.orgId, oldWeb);
  const busy = await project('Busy', 200);
  const busyWeb = svc(busy, 'web'); deployed(busyWeb, 150);
  run(db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls) VALUES (?, ?, 'busy.example.com', ?, 'active', 'active')`, id('dom'), o.orgId, busyWeb);
  run(db, `INSERT INTO traffic (server_id, hostname, at, requests, errors, p95_ms, static_hits, static_uncached) VALUES (?, 'busy.example.com', ?, 40, 0, 90, 0, 0)`, srvA, ago(1));

  // box-a's last usage reading: Shop half, a blog a quarter, the server itself a tenth
  saveXray(db, o.orgId, srvA, 'usage', { server: { memTotal: 8e9 }, projects: [{ id: 'unit7:shop', name: 'Shop', share: 0.5 }, { id: 'compose:blog', name: 'blog', share: 0.25 }, { id: 'unit7:system', name: 'Unit7 itself', share: 0.1, system: true }] });
  // and 25 quiet days: never above 10% CPU or 1 GB of its 8 GB
  for (let d = 1; d <= 25; d++) run(db, `INSERT INTO usage_points (org_id, server_id, scope, name, res, at, cpu, cpu_max, mem, mem_max) VALUES (?, ?, 'server', 'The whole server', '1d', ?, 5, 10, 8e8, 1e9)`, o.orgId, srvA, ago(d));
  // 5 GB of old images on box-b
  saveXray(db, o.orgId, srvB, 'fast', { version: 1, at: ago(0), server: {}, paas: [], projects: [], parts: [], loose: [], ports: [], repos: [], disk: { method: 'docker-cli', reclaimable: 5e9 }, summary: '', notes: [] });
  run(db, `INSERT INTO cost_months (org_id, month, total, currency, at) VALUES (?, '2026-09', 90, 'USD', ?)`, o.orgId, ago(20));
  return { app, o, shop, old, busy, srvA, srvB };
}

test('one monthly number, split by provider and project, nothing counted twice', async () => {
  const { app, o, shop } = await world();
  const r = await costRadar({ db: app.db, orgId: o.orgId }, { fx, at: AT });
  // Vercel's 30 so far is on course for 62; Hostinger's plan is box-a (once); box-b is 10 EUR = 11 USD
  assert.deepEqual(r.byProvider.map((l) => [l.provider, l.amount, !!l.estimate]), [['vercel', 62, true], ['cloudflare', 20, false], ['hostinger', 12, false], ['servers', 11, false]]);
  assert.equal(r.total, 105);
  assert.equal(r.lastMonth, 90);
  assert.equal(r.currency, 'USD');
  assert.equal(r.estimate, true);
  const p = Object.fromEntries(r.byProject.map((l) => [l.name, l.amount]));
  assert.deepEqual(p, { 'Accounts not tied to one project': 82, 'box-b (not split yet)': 11, Shop: 6, blog: 3, 'Spare room on your servers': 3 });
  assert.equal(r.byProject.reduce((n, l) => n + l.amount, 0), r.total, 'the split adds up to the total');
  assert.equal(r.byProject.find((l) => l.name === 'Shop')!.projectId, shop.id);
  assert.ok(r.byProject.filter((l) => l.key !== 'shared').every((l) => l.estimate), 'a share of a server is an estimate');
  assert.deepEqual(r.byClient, [], 'no client spaces yet');
  assert.equal(get<{ total: number }>(app.db, `SELECT total FROM cost_months WHERE org_id = ? AND month = '2026-10'`, o.orgId)!.total, 105, 'this month is kept for next month');
});

test('the same project name on two servers says which server', async () => {
  const { app, o, srvB } = await world();
  saveXray(app.db, o.orgId, srvB, 'usage', { server: { memTotal: 8e9 }, projects: [{ id: 'compose:blog', name: 'blog', share: 0.5 }] });
  const r = await costRadar({ db: app.db, orgId: o.orgId }, { fx, at: AT });
  assert.deepEqual(r.byProject.filter((l) => l.name.startsWith('blog')).map((l) => l.name).sort(), ['blog · box-a', 'blog · box-b']);
});

test('by client, once projects belong to one', async () => {
  const { app, o, shop } = await world();
  const c = id('cli');
  run(app.db, `INSERT INTO clients (id, org_id, name) VALUES (?, ?, 'Acme')`, c, o.orgId);
  run(app.db, `INSERT INTO client_members (org_id, key, client_id) VALUES (?, ?, ?)`, o.orgId, shop.id, c);
  const r = await costRadar({ db: app.db, orgId: o.orgId }, { fx, at: AT });
  assert.deepEqual(r.byClient.map((l) => [l.name, l.amount]), [['Your own', 99], ['Acme', 6]]);
});

test('save ideas come from real signals, and each action is a person’s', async () => {
  const { app, o, old, srvA, srvB } = await world();
  const r = await costRadar({ db: app.db, orgId: o.orgId }, { fx, at: AT });
  const kinds = r.savings.map((s) => s.id);
  assert.ok(kinds.includes(`idle:${old.id}`), 'no deploy in 120 days and no visits');
  assert.ok(!r.savings.some((s) => /Busy|Shop/.test(s.title) && s.kind === 'idle'), 'visited or just deployed: not idle');
  const idle = r.savings.find((s) => s.id === `idle:${old.id}`)!;
  assert.deepEqual(idle.action, { kind: 'lifecycle', item: { key: old.id, name: 'Old', kind: 'project', projectId: old.id } });
  const big = r.savings.find((s) => s.id === `oversized:${srvA}`)!;
  assert.equal(big.amount, 6);
  assert.deepEqual(big.action, { kind: 'open', href: `/servers/${srvA}`, label: 'See the server' });
  assert.match(big.detail, /Unit7 never changes it/);
  assert.ok(r.savings.some((s) => s.kind === 'duplicate' && /2 postgres databases/.test(s.title)));
  const clean = r.savings.find((s) => s.kind === 'cleanup')!;
  assert.deepEqual(clean.action, { kind: 'tool', tool: 'docker.prune', input: { serverId: srvB }, label: 'Clean up safely' });
  assert.equal(r.save, 6);

  // no money moves: nothing buys, resizes or deletes; the only tool action is a safe cleanup through the gate
  for (const s of r.savings) {
    if (s.action.kind !== 'tool') continue;
    const t = getTool(s.action.tool)!;
    assert.notEqual(t.action, 'provider_purchase');
    assert.notEqual(typeof t.risk === 'function' ? t.risk(s.action.input as never) : t.risk, 'destructive');
  }
  assert.ok(!r.savings.some((s) => s.action.kind === 'tool' && /server\.(resize|upgrade)|plan|buy/.test(s.action.tool)));
});

test('an AI may read the radar but never set the budget; reading changes nothing else', async () => {
  const app = testApp();
  const o = await testOrg(app);
  run(app.db, `INSERT INTO costs (org_id, provider, account, label, amount, currency, kind, at) VALUES (?, 'cloudflare', 'main', 'plan', 20, 'USD', 'monthly', ?)`, o.orgId, new Date().toISOString());
  const r = ok(await o.a('cost.radar', {}));
  assert.equal(r.total, 20);
  assert.equal(r.lastMonth, null);
  assert.equal((await o.a('budget.set', { monthly: 1 })).status, 'denied');
  assert.equal(all(app.db, `SELECT 1 FROM audit WHERE risk != 'read' AND result = 'success'`).length, 0);
  assert.equal(all(app.db, 'SELECT 1 FROM approvals').length, 0);
});
