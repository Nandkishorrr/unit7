// "Ready for real users": every tick from Unit7's own records, checks that don't apply drop out, and each unticked one
// carries its fix (a tool through the gate, a page, or a request for the AI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { id, run } from '../src/db.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import { isTestHost, apexOf } from '../src/care/readiness.ts';

const iso = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400_000).toISOString();

// a project with a live app on its own domain and a Postgres database, everything in order
async function readyProject(o: { db?: boolean } = {}) {
  const app = testApp();
  const org = await testOrg(app);
  const p = ok(await org.h('project.create', { name: 'Shop', environments: ['production'] }));
  const pid = p.projectId as string;
  const env = p.environments[0].id as string;
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/k', 'ready')`, srv, org.orgId);
  const web = id('svc'), dep = id('dep');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, status, current_deployment_id) VALUES (?, ?, ?, ?, ?, 'web', 'web', 'app', 'healthy', ?)`, web, org.orgId, pid, env, srv, dep);
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, source, container, log) VALUES (?, ?, ?, 1, 'live', '{"type":"git"}', 'shop-web-1', 'Cloning…\nSecret scan: clean.\nLive.')`, dep, org.orgId, web);
  const dom = id('dom');
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, zone, status, tls) VALUES (?, ?, 'shop.example.com', ?, 'example.com', 'active', 'active')`, dom, org.orgId, web);
  const watch = (host: string, kind: string, status: string) => run(app.db, `INSERT INTO watch (org_id, host, kind, status, checked_at) VALUES (?, ?, ?, ?, ?)`, org.orgId, host, kind, status, iso());
  watch('shop.example.com', 'site', 'up'); watch('shop.example.com', 'tls', 'ok'); watch('example.com', 'email', 'ok');
  let pg: string | undefined, bak: string | undefined;
  if (o.db !== false) {
    pg = id('svc'); bak = id('bak');
    run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, status) VALUES (?, ?, ?, ?, ?, 'db', 'db', 'postgres', 'healthy')`, pg, org.orgId, pid, env, srv);
    run(app.db, `INSERT INTO backup_schedules (id, org_id, service_id, frequency) VALUES (?, ?, ?, 'daily')`, id('bks'), org.orgId, pg);
    run(app.db, `INSERT INTO backups (id, org_id, service_id, kind, reason, status, verify_ok, verified_at, offsite) VALUES (?, ?, ?, 'pg_dump', 'scheduled', 'done', 1, ?, ?)`, bak, org.orgId, pg, iso(2), JSON.stringify({ local: '/x', at: iso(2) }));
  }
  setupNtfy(app, org.orgId, org.userId);
  // phone alerts count once the phone proved it gets them (a test got through)
  run(app.db, `UPDATE accounts SET meta = json_set(meta, '$.proof', json(?)) WHERE provider = 'ntfy'`, JSON.stringify({ at: iso() }));
  ok(await org.h('budget.set', { monthly: 50 }));
  ok(await org.h('environment.policy', { environmentId: env, autonomy: 3 }));
  const check = async () => ok(await org.h('project.readiness', { projectId: pid }));
  return { app, org, projectId: pid, env, web, dom, pg, bak, check };
}
const byKey = (r: any, key: string) => r.checks.find((c: any) => c.key === key);

test('a project with everything in order is ready: 11 of 11', async () => {
  const { check } = await readyProject();
  const r = await check();
  assert.deepEqual(r.checks.filter((c: any) => !c.ok).map((c: any) => `${c.key}: ${c.detail}`), []);
  assert.equal(r.total, 11);
  assert.equal(r.done, 11);
  assert.equal(r.ready, true);
  assert.deepEqual(r.checks.map((c: any) => c.key), ['domain', 'https', 'email', 'backups', 'offsite', 'alerts', 'uptime', 'errors', 'budget', 'secrets', 'autonomy']);
  assert.ok(r.checks.every((c: any) => !c.fix), 'a ticked item has nothing to fix');
});

test('no database: the backup checks drop out of the count (9 of 9)', async () => {
  const { check } = await readyProject({ db: false });
  const r = await check();
  assert.equal(r.total, 9);
  assert.equal(r.ready, true);
});

test('each gap is computed from the records and carries the right fix', async () => {
  const { app, org, projectId, web, dom, pg, bak, check } = await readyProject();
  // email not protected, certificate broken, backups never tested, last copy only on the server
  run(app.db, `UPDATE watch SET status = 'unprotected', detail = 'DMARC missing' WHERE host = 'example.com' AND kind = 'email'`);
  run(app.db, `UPDATE watch SET status = 'broken', detail = 'certificate has expired' WHERE kind = 'tls'`);
  run(app.db, 'UPDATE backups SET verify_ok = NULL, offsite = NULL WHERE id = ?', bak!);
  let r = await check();
  assert.equal(r.done, 7);
  assert.equal(r.ready, false);
  assert.deepEqual(byKey(r, 'email').fix, { tool: 'domain.protect_email', input: { domain: 'example.com' }, label: 'Protect email' });
  assert.deepEqual(byKey(r, 'https').fix, { tool: 'domain.check', input: { domainId: dom }, label: 'Check again' });
  assert.match(byKey(r, 'https').detail, /certificate has expired/);
  assert.deepEqual(byKey(r, 'backups').fix, { tool: 'backup.verify', input: { serviceId: pg }, label: 'Test a restore' });
  assert.deepEqual(byKey(r, 'offsite').fix, { tool: 'backup.offsite_copy', input: { backupId: bak }, label: 'Copy it off' });

  // no schedule at all: schedule daily first; no phone alerts, no budget: the right pages
  run(app.db, 'DELETE FROM backup_schedules');
  // a channel that never proved it reaches the phone doesn't count as set up
  run(app.db, `UPDATE accounts SET meta = json_remove(meta, '$.proof') WHERE provider = 'ntfy'`);
  assert.equal(byKey(await check(), 'alerts').ok, false, 'set up but never proved: not on yet');
  run(app.db, `DELETE FROM accounts WHERE provider = 'ntfy'`);
  run(app.db, 'UPDATE orgs SET budget_monthly = NULL');
  r = await check();
  assert.deepEqual(byKey(r, 'backups').fix, { tool: 'backup.schedule', input: { serviceId: pg, frequency: 'daily' }, label: 'Back up daily' });
  assert.deepEqual(byKey(r, 'alerts').fix, { href: '/connections#alerts', label: 'Set up phone alerts' });
  assert.equal(byKey(r, 'budget').fix.href, '/autopilot');

  // a credential found in the code by the last deploy's scan; Unit7 couldn't read the app's logs
  run(app.db, `UPDATE deployments SET log = 'Secret scan: 2 credentials found in the code.'`);
  run(app.db, `INSERT INTO audit (id, org_id, actor_kind, actor_name, tool, action, risk, input, result) VALUES (?, ?, 'system', 'Warden', 'errors.scan', 'read', 'read', ?, 'error')`,
    id('aud'), org.orgId, JSON.stringify({ serviceId: web }));
  r = await check();
  assert.match(byKey(r, 'secrets').detail, /written in the code/);
  assert.match(byKey(r, 'secrets').fix.ask, /move the secrets out of web/);
  assert.equal(byKey(r, 'errors').ok, false);
  assert.equal(byKey(r, 'errors').fix.tool, 'errors.scan');

  // every project's score at once (for the cards)
  const all = ok(await org.h('project.readiness', {}));
  assert.deepEqual(all.projects.map((p: any) => [p.projectId, p.total, p.ready]), [[projectId, 11, false]]);
});

test('only a test address: not its own domain, and the email check does not apply', async () => {
  const { app, check } = await readyProject();
  run(app.db, `UPDATE domains SET hostname = 'web-abc.203-0-113-9.sslip.io', zone = NULL`);
  run(app.db, `UPDATE watch SET host = 'web-abc.203-0-113-9.sslip.io' WHERE kind IN ('site', 'tls')`);
  const r = await check();
  assert.equal(byKey(r, 'domain').ok, false);
  assert.match(byKey(r, 'domain').detail, /Only a test address/);
  assert.match(byKey(r, 'domain').fix.ask, /Connect my own domain to Shop/);
  assert.equal(byKey(r, 'email'), undefined);
  assert.equal(r.total, 10);
});

test('the autonomy tick needs a person’s choice, and an AI can still read the checklist', async () => {
  const { app, org, projectId, check } = await readyProject();
  run(app.db, `DELETE FROM audit WHERE tool = 'environment.policy'`);
  assert.equal(byKey(await check(), 'autonomy').ok, false);
  assert.equal((await org.a('project.readiness', { projectId })).status, 'ok');
});

test('test addresses and apexes', () => {
  for (const h of ['shop.vercel.app', 'x.netlify.app', 'a.pages.dev', 'web-1.203-0-113-9.sslip.io', 'svc.up.railway.app', '203.0.113.9']) assert.ok(isTestHost(h), h);
  for (const h of ['shop.example.com', 'example.com']) assert.ok(!isTestHost(h), h);
  assert.equal(apexOf('www.shop.example.com'), 'example.com');
  assert.equal(apexOf('www.shop.example.co.uk', 'shop.example.co.uk'), 'shop.example.co.uk');
});
