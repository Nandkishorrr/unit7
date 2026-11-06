// Changing secrets without breaking anything: the API side learns the new key first and keeps accepting the
// old one for a day; a secret found in code maps to the right fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, id, run } from '../src/db.ts';
import { leakPlan } from '../src/tools/autopilot.ts';

const reveal = async (o: Awaited<ReturnType<typeof testOrg>>, serviceId: string, key: string) => ok(await o.h('env.reveal', { serviceId, key })).value as string;

async function linked() {
  const app = testApp(); const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'Biz', environments: ['production'] })).environments[0].id;
  const crm = ok(await o.h('service.create', { environmentId: env, name: 'crm', source: { type: 'git', repo: 'ada/crm' } })).serviceId;
  const web = ok(await o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'ada/web' } })).serviceId;
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status) VALUES (?, ?, 'crm.shop.test', ?, 'active')`, id('dom'), o.orgId, crm);
  const l = ok(await o.a('link.create', { from: { kind: 'unit7', serviceId: crm }, to: { kind: 'unit7', serviceId: web } }));
  return { app, o, crm, web, linkId: l.linkId as string };
}

test('a key change: the API takes the new key first and still accepts the old one; then the old one is retired', async () => {
  const { app, o, crm, web, linkId } = await linked();
  const old = await reveal(o, web, 'CRM_API_KEY');
  const r = ok(await o.a('link.rotate', { linkId }));
  assert.deepEqual(r.set, ['CRM_API_KEY']);
  const fresh = await reveal(o, web, 'CRM_API_KEY');
  assert.notEqual(fresh, old);
  assert.equal(await reveal(o, crm, 'WEB_API_KEY'), fresh, 'the API accepts the new key');
  assert.equal(await reveal(o, crm, 'WEB_API_KEY_PREVIOUS'), old, '…and the old one, for a day');
  // the API side was set before the client switched
  const order = all<{ input: string }>(app.db, `SELECT input FROM audit WHERE tool = 'env.set' AND reason = 'link' ORDER BY created_at, rowid`).map((a) => JSON.parse(a.input).key);
  assert.ok(order.lastIndexOf('WEB_API_KEY') < order.lastIndexOf('CRM_API_KEY'));

  ok(await o.a('link.retire_previous', { linkId }));
  const retired = await reveal(o, crm, 'WEB_API_KEY_PREVIOUS');
  assert.ok(retired !== old && retired.length >= 32, 'the old key no longer works, and the value is never empty');
});

test('a secret found in code: a connection key, a database password, or "revoke it yourself"', async () => {
  const { app, o, web, linkId } = await linked();
  const env = all<{ id: string }>(app.db, 'SELECT id FROM environments')[0]!.id;
  const pg = id('svc');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, config) SELECT ?, org_id, project_id, id, 'db', 'db', 'postgres', '{"passwordRef":"credential://postgres/db/password"}' FROM environments WHERE id = ?`, pg, env);
  ok(await o.h('env.set', { serviceId: web, key: 'DATABASE_URL', value: 'credential://postgres/db/url' }));
  ok(await o.h('env.set', { serviceId: web, key: 'STRIPE_SECRET_KEY', value: 'sk_live_not_really_123456' }));
  const { plan, manual } = leakPlan(app.db, o.orgId, web, ['CRM_API_KEY', 'DATABASE_URL', 'STRIPE_SECRET_KEY']);
  assert.deepEqual(plan.map((p) => [p.tool, p.input.linkId ?? p.input.serviceId]), [['link.rotate', linkId], ['database.rotate_password', pg]]);
  assert.deepEqual(manual, ['STRIPE_SECRET_KEY']);
});
