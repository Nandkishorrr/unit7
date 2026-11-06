// Autopilot: one switch stops every AI actor from changing anything; people keep full control; and
// what AI did on its own is listed with an undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok, setAutonomy } from './helpers.ts';
import { decideApproval } from '../src/tools/runtime.ts';
import { weeklyBlocked } from '../src/tools/activity.ts';
import { all, run } from '../src/db.ts';
import { autopilotView } from '../src/tools/autopilot.ts';

test('pause stops AI writes (not reads, not people); only a person can flip it', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'Shop', environments: ['staging'] })).environments[0].id;
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'ada/shop' } })).serviceId;

  // an AI can't pause or resume Autopilot
  assert.notEqual((await o.a('autopilot.set', { paused: true })).status, 'ok');
  ok(await o.h('autopilot.set', { paused: true }));
  assert.equal(autopilotView(app.db, o.orgId).paused, true);

  const write = await o.a('service.settings', { serviceId: svc, previews: false });
  assert.equal(write.status, 'denied');
  assert.match((write as any).why, /Autopilot is paused/);
  assert.equal((await o.a('service.get', { serviceId: svc })).status, 'ok', 'reads still work');
  assert.equal((await o.h('service.settings', { serviceId: svc, previews: false })).status, 'ok', 'a person still acts');

  ok(await o.h('autopilot.set', { paused: false }));
  assert.equal((await o.a('service.settings', { serviceId: svc, autoDeploy: false })).status, 'ok');
});

test('what AI did on its own shows up with an undo that restores the old values', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'Shop', environments: ['staging'] })).environments[0].id;
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'ada/shop' }, port: 3000 })).serviceId;
  const r = ok(await o.a('service.settings', { serviceId: svc, autoDeploy: false, port: 8080 }));
  assert.deepEqual(r.undo.input, { serviceId: svc, autoDeploy: true, port: 3000 });
  const view = autopilotView(app.db, o.orgId);
  const row = view.actions.find((a) => a.tool === 'service.settings')!;
  assert.equal(row.undo!.label, 'Put the previous settings back');
  // a person clicks Undo
  ok(await o.h(row.undo!.tool, row.undo!.input));
  const now = ok(await o.h('service.get', { serviceId: svc }));
  assert.equal(now.autoDeploy, true);
  assert.equal(now.port, 3000);
  // people's own actions aren't in the "on its own" list
  assert.ok(!view.actions.some((a) => a.who === 'Ada'));
});

test('what Unit7 blocked: denials, people-only refusals, rejected approvals; one alert a week', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Api' }));
  const prod = environments.find((e: any) => e.kind === 'production').id;
  assert.equal(ok(await o.a('audit.blocked')).total, 0);

  assert.notEqual((await o.a('autopilot.set', { paused: true })).status, 'ok'); // people-only
  setAutonomy(app, prod, 2);
  const r = await o.a('env.set', { environmentId: prod, key: 'LOG_LEVEL', value: 'debug' });
  assert.equal(r.status, 'approval_required');
  await decideApproval(app, o.orgId, o.human, (r as any).approvalId, false);
  ok(await o.h('autopilot.set', { paused: true }));
  assert.equal((await o.a('env.set', { environmentId: prod, key: 'A', value: 'b' })).status, 'denied');
  assert.equal((await o.a('env.set', { environmentId: prod, key: 'A', value: 'c' })).status, 'denied');

  const s = autopilotView(app.db, o.orgId).blocked;
  assert.deepEqual([s.total, s.denied, s.rejected, s.expired], [4, 3, 1, 0]);
  assert.equal(s.reasons[0]!.tool, 'env.set');
  assert.equal(s.reasons[0]!.count, 2);
  assert.match(s.reasons.find((x) => x.tool === 'autopilot.set')!.why, /Only a person/);

  const sent = () => all(app.db, `SELECT message FROM events WHERE org_id = ? AND type = 'safety.weekly'`, o.orgId) as { message: string }[];
  weeklyBlocked(app);
  assert.equal(sent().length, 0, 'not before the first week is up');
  run(app.db, 'UPDATE orgs SET created_at = ? WHERE id = ?', new Date(Date.now() - 8 * 86400_000).toISOString(), o.orgId);
  weeklyBlocked(app);
  weeklyBlocked(app);
  assert.equal(sent().length, 1, 'once a week');
  assert.match(sent()[0]!.message, /stopped 4 risky actions/);
});

test('people-only actions: an AI is denied outright, nothing lands in the approval queue', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Api' }));
  const prod = environments.find((e: any) => e.kind === 'production').id;
  setAutonomy(app, prod, 1); // Recommend: every AI write would normally wait for approval
  const r = await o.a('environment.policy', { environmentId: prod, autonomy: 4 });
  assert.equal(r.status, 'denied');
  assert.match((r as any).why, /Only a person/);
  assert.equal(all(app.db, `SELECT 1 FROM approvals WHERE org_id = ?`, o.orgId).length, 0);
  ok(await o.h('environment.policy', { environmentId: prod, autonomy: 2 })); // a person still can
});
