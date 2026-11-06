// D3 canary releases, proven with fakes: the weights in the proxy's config (one server and across a fleet), the steps
// and the decisions (step up, promote, roll back by itself), the controls (hold, resume, share, promote, roll back, the
// phone's two buttons), and the plain refusals. The deploy itself runs against a stand-in Docker host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, run } from '../src/db.ts';
import { ssh, type ExecResult } from '../src/connectors/ssh.ts';
import { canaryWeights, renderSite, withCanary } from '../src/deploy/caddy.ts';
import { containerName } from '../src/deploy/deployer.ts';
import { canaryDeps, canaryNext, canaryRefusal, canaryTick, canaryWords, handleCanaryTap, planSteps, splitHits } from '../src/fleet/canary.ts';
import { parseHit, type Hit } from '../src/sentinel/traffic.ts';
import { phoneCode } from '../src/sentinel/phone.ts';
import type { App } from '../src/app.ts';
import type { ServiceRow } from '../src/deploy/deployer.ts';

const res = (stdout = '', code = 0): ExecResult => ({ code, stdout, stderr: '', truncated: false });
function fakeHost(app: App, answer: (c: string) => ExecResult | undefined = () => undefined) {
  const calls: string[] = [];
  ssh(app).exec = async (_s, command) => {
    calls.push(command);
    const r = answer(command);
    if (r) return r;
    if (command.includes(`'inspect'`) && command.includes('OOMKilled')) return res('running 0 false 0');
    if (command.includes('curlimages/curl')) return res('200');
    return res();
  };
  return calls;
}
const sites = (calls: string[]) => calls.filter((c) => c.includes('tee') && c.includes('reverse_proxy'));

async function imageApp() {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === 'development').id;
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ publicIp: '203.0.113.9' }));
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', serverId: srv, source: { type: 'image', image: 'nginx:alpine' }, port: 80 })).serviceId;
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls_mode) VALUES (?, ?, 'shop.example.com', ?, 'active', 'off')`, id('dom'), o.orgId, svc);
  const row = () => get<ServiceRow>(app.db, 'SELECT * FROM services WHERE id = ?', svc)!;
  const canary = () => get<any>(app.db, 'SELECT * FROM canaries WHERE service_id = ? ORDER BY created_at DESC LIMIT 1', svc);
  return { app, o, env, srv, svc, row, canary, name: (n: number) => containerName(row(), n) };
}
// a proxy log line that says which copy answered
const hit = (upstream: string, status = 200, ms = 40, at = Date.now()): Hit => parseHit(JSON.stringify({ msg: 'handled request', ts: at / 1000, status, duration: ms / 1000, upstream,
  request: { client_ip: '198.51.100.7', method: 'GET', host: 'shop.example.com', uri: '/', headers: { 'User-Agent': ['Mozilla/5.0'] } } }))!;

// --- the weights ---------------------------------------------------------------------------------------------------------
test('weights: the new copies together get exactly their share, in the smallest whole numbers', () => {
  assert.deepEqual(canaryWeights(1, 1, 10), { wNew: 1, wOld: 9 });
  assert.deepEqual(canaryWeights(1, 1, 50), { wNew: 1, wOld: 1 });
  assert.deepEqual(canaryWeights(1, 3, 10), { wNew: 1, wOld: 3 }, 'one new copy, three old ones: 1 vs 3×3');
  for (const [n, m, p] of [[1, 2, 10], [2, 3, 25], [3, 1, 50], [4, 4, 7], [1, 5, 33]] as const) {
    const w = canaryWeights(n, m, p)!;
    assert.equal(Math.round((n * w.wNew / (n * w.wNew + m * w.wOld)) * 1000) / 10, p, `${n} new, ${m} old at ${p}%`);
  }
  assert.equal(canaryWeights(0, 2, 10), undefined, 'nothing new: no split');
  assert.equal(canaryWeights(1, 0, 10), undefined);
  assert.equal(canaryWeights(1, 1, 100), undefined, '100%: the plain proxy');
});

test('the site: weighted round robin over new and old copies, and which copy answered goes into the log', () => {
  const site = withCanary({ hostname: 'shop.example.com', upstream: 'web-2', port: 80, healthPath: '/health', tls: 'auto' }, ['web-1'], 10);
  assert.deepEqual(site.replicas, ['web-1'], 'the old copy stays in the proxy');
  const caddy = renderSite(site);
  assert.match(caddy, /reverse_proxy web-2:80 web-1:80 \{/);
  assert.match(caddy, /lb_policy weighted_round_robin 1 9\n/);
  assert.match(caddy, /\tlog_append upstream \{rp\.upstream\.hostport\}\n/);
  assert.match(caddy, /health_uri \/health/, 'the health checks stay');
  // across a fleet with a front proxy: the other servers (old) weigh like old copies
  const fleet = renderSite(withCanary({ hostname: 'shop.example.com', upstream: 'web-2', remotes: ['10.77.0.2:7001', '10.77.0.3:7001'], port: 80, tls: 'auto' }, ['web-1'], 10));
  assert.match(fleet, /reverse_proxy web-2:80 web-1:80 10\.77\.0\.2:7001 10\.77\.0\.3:7001 \{/);
  assert.match(fleet, /lb_policy weighted_round_robin 1 3 3 3\n/, '1 of 10 visits to the new copy');
  // a route back to the old version during the canary: no split, the plain proxy
  const back = withCanary({ hostname: 'shop.example.com', upstream: 'web-1', port: 80, tls: 'auto' }, ['web-1'], 10);
  assert.equal(back.weights, undefined);
  assert.match(renderSite(back), /lb_policy|reverse_proxy web-1:80 \{/);
  assert.ok(!renderSite({ hostname: 'shop.example.com', upstream: 'web-1', replicas: ['web-1-r2'], port: 80, tls: 'auto' }).includes('log_append'), 'without a canary the site is as before');
  assert.throws(() => renderSite({ hostname: 'shop.example.com', upstream: 'a', port: 80, tls: 'auto', weights: [1, 2] }), /weights/);
});

// --- the decisions ---------------------------------------------------------------------------------------------------------
test('the steps, the split by version, and what each look decides', () => {
  assert.deepEqual(planSteps(), [10, 50, 100]);
  assert.deepEqual(planSteps(5, [25, 50, 25, 200]), [5, 25, 50, 100], 'rising, whole, ending at 100');
  const { neu, old } = splitHits([hit('web-2:80'), hit('web-2:80', 502), hit('web-1:80'), hit('10.77.0.2:7001', 500), { ...hit('web-1:80'), upstream: undefined }], ['web-2']);
  assert.deepEqual([neu.requests, neu.errors, old.requests, old.errors], [2, 1, 2, 1], 'the proxy’s own answers count for neither');
  const c = { status: 'running', step: 0, steps: [10, 50, 100], stepAt: new Date(0).toISOString(), holdMinutes: 5 };
  assert.deepEqual(canaryNext(c, { act: 'wait' }, 60_000), { act: 'wait', msLeft: 240_000 }, 'inside the hold');
  assert.deepEqual(canaryNext(c, { act: 'ok' }, 300_000), { act: 'step', share: 50, step: 1 });
  assert.deepEqual(canaryNext({ ...c, step: 1 }, { act: 'ok' }, 300_000), { act: 'finish' }, 'the step after 50 is 100: promote');
  assert.deepEqual(canaryNext(c, { act: 'rollback', reason: 'errors jumped to 6%' }, 1), { act: 'rollback', reason: 'errors jumped to 6%' }, 'worse rolls back at once, hold or not');
  assert.deepEqual(canaryNext({ ...c, status: 'held' }, { act: 'rollback', reason: 'x' }, 1).act, 'rollback', 'even while held');
  assert.deepEqual(canaryNext({ ...c, status: 'held' }, { act: 'ok' }, 900_000), { act: 'wait', msLeft: null }, 'held stays put');
  assert.equal(canaryWords({ newRate: 0.1, oldRate: 0.2 }, { status: 'running', next: 50, msLeft: 210_000 }), 'New version: 0.1% errors vs 0.2% usual · next step to 50% in 4 min');
  assert.equal(canaryWords(undefined, { status: 'held', next: 50 }), 'New version: no visits yet · held here until you carry on');
});

// --- the whole thing, on a stand-in host -------------------------------------------------------------------------------
test('a canary: the new version gets 10% beside the old one, steps to 50%, then takes everything; the old one drains and stops', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  let calls = fakeHost(t.app);
  const started = ok(await t.o.h('fleet.canary', { serviceId: t.svc }));
  assert.equal(started.canary.status, 'running');
  assert.equal(started.canary.share, 10);
  const first = sites(calls).at(-1)!;
  assert.ok(first.includes(`reverse_proxy ${t.name(2)}:80 ${t.name(1)}:80`) && first.includes('weighted_round_robin 1 9'), 'the switch itself wrote the split');
  assert.ok(!calls.some((c) => c.includes('docker stop') && c.includes(t.name(1))), 'the old version keeps serving');
  const dep2 = get<any>(t.app.db, 'SELECT plan FROM deployments WHERE service_id = ? AND number = 2', t.svc);
  const steps = JSON.parse(dep2.plan).steps;
  assert.match(steps.find((s: any) => s.key === 'drain').note, /keeps 90% of visitors/);
  assert.match(steps.find((s: any) => s.key === 'watch').note, /Tried on 10% of visitors first/);
  // another deploy waits for the canary
  const again = await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true });
  assert.match((again as any).error.message, /Promote it or roll it back first/);

  // the looks: the new copy does as well as the old one
  let clock = Date.now();
  canaryDeps.now = () => clock;
  canaryDeps.sleep = async () => undefined;
  canaryDeps.readLog = async () => ({ now: clock, hits: [...Array(40)].map(() => hit(`${t.name(2)}:80`)).concat([...Array(400)].map((_, k) => hit(`${t.name(1)}:80`, k < 2 ? 500 : 200))) });
  canaryDeps.probe = async () => [{ path: '/', code: 200, ms: 5 }];
  await canaryTick(t.app);
  assert.equal(t.canary().share, 10, 'still inside the hold');
  assert.equal(JSON.parse(t.canary().points).length, 1, 'each look is a point on the two lines');
  clock += 5 * 60_000 + 1000;
  calls = fakeHost(t.app);
  await canaryTick(t.app);
  assert.equal(t.canary().share, 50, 'stepped up after the hold');
  assert.ok(sites(calls).at(-1)!.includes('weighted_round_robin 1 1'));
  clock += 5 * 60_000 + 1000;
  calls = fakeHost(t.app);
  await canaryTick(t.app);
  assert.equal(t.canary().status, 'done');
  const last = sites(calls).at(-1)!;
  assert.ok(last.includes(`reverse_proxy ${t.name(2)}:80 {`) && !last.includes('weighted'), 'all visitors on the new version, the plain proxy again');
  const stop = calls.findIndex((c) => c.includes('docker stop -t') && c.includes(t.name(1)));
  assert.ok(stop > calls.indexOf(last), 'the old version stops after it left the proxy');
  assert.ok(all(t.app.db, `SELECT 1 FROM events WHERE type = 'fleet.canary_done'`).length === 1);
});

test('worse on its share: Warden rolls it back by itself, through the gate, and says why', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const first = get<any>(t.app.db, 'SELECT id FROM deployments WHERE service_id = ? AND number = 1', t.svc).id;
  ok(await t.o.h('fleet.canary', { serviceId: t.svc, share: 20 }));
  const calls = fakeHost(t.app);
  canaryDeps.now = () => Date.now();
  canaryDeps.readLog = async () => ({ now: Date.now(), hits: [...Array(40)].map((_, k) => hit(`${t.name(2)}:80`, k < 8 ? 502 : 200)).concat([...Array(200)].map(() => hit(`${t.name(1)}:80`))) });
  canaryDeps.probe = async () => [{ path: '/', code: 200, ms: 5 }];
  await canaryTick(t.app);
  const c = t.canary();
  assert.equal(c.status, 'rolled_back');
  assert.match(c.reason, /^Errors jumped to 20% \(usually 0%\) on 20% of visitors$/);
  assert.equal(t.row().current_deployment_id, first, 'every visitor on the old version again');
  const site = sites(calls).at(-1)!;
  assert.ok(site.includes(`reverse_proxy ${t.name(1)}:80 {`) && !site.includes('weighted'));
  const ev = get<any>(t.app.db, `SELECT message FROM events WHERE type = 'fleet.canary_rolled_back'`);
  assert.match(ev.message, /^Rolled back web v2: errors jumped/);
  assert.equal(get<any>(t.app.db, `SELECT actor_id FROM audit WHERE tool = 'fleet.canary_control' ORDER BY created_at DESC LIMIT 1`).actor_id, 'warden');
});

test('controls: hold freezes the steps, resume carries on, a share is set by hand, and the phone’s buttons only work with Unit7’s code', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  ok(await t.o.h('fleet.canary', { serviceId: t.svc }));
  ok(await t.o.h('fleet.canary_control', { serviceId: t.svc, action: 'hold' }));
  let clock = Date.now() + 60 * 60_000;
  canaryDeps.now = () => clock;
  canaryDeps.readLog = async () => ({ now: clock, hits: [] });
  canaryDeps.probe = async () => [{ path: '/', code: 200, ms: 5 }];
  await canaryTick(t.app);
  assert.equal(t.canary().share, 10, 'held: no step however long');
  ok(await t.o.h('fleet.canary_control', { serviceId: t.svc, action: 'resume' }));
  assert.equal(t.canary().status, 'running');
  const calls = fakeHost(t.app);
  ok(await t.o.h('fleet.canary_control', { serviceId: t.svc, action: 'share', share: 30 }));
  assert.ok(sites(calls).at(-1)!.includes('weighted_round_robin 3 7'));
  assert.equal(t.canary().step, 0, '30% sits on the first step: the next one up is 50%');
  // the phone: a made-up code does nothing, Unit7's own promotes as the person
  const c = t.canary();
  assert.match(await handleCanaryTap(t.app, { orgId: t.o.orgId, approver: t.o.userId }, `canary ${c.id} promote ${'x'.repeat(22)}`), /wasn’t from Unit7/);
  assert.equal(t.canary().status, 'running');
  const said = await handleCanaryTap(t.app, { orgId: t.o.orgId, approver: t.o.userId }, `canary ${c.id} promote ${phoneCode(t.app, t.o.orgId, `canary:${c.id}:promote`)}`);
  assert.match(said, /^Promoted/);
  assert.equal(t.canary().status, 'done');
  assert.match(get<any>(t.app.db, `SELECT actor_name FROM audit WHERE tool = 'fleet.canary_control' ORDER BY created_at DESC LIMIT 1`).actor_name, /\(from phone\)/);
  assert.match(await handleCanaryTap(t.app, { orgId: t.o.orgId, approver: t.o.userId }, `canary ${c.id} rollback ${phoneCode(t.app, t.o.orgId, `canary:${c.id}:rollback`)}`), /already over/, 'an old button can’t act again');
});

test('refusals in plain words: a worker, DNS spreading, Coolify’s proxy, a canary already going', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const svc = t.row();
  assert.match(canaryRefusal(t.app.db, { ...svc, kind: 'worker' })!, /no visitors to split/);
  run(t.app.db, `INSERT INTO fleets (service_id, org_id, mode) VALUES (?, ?, 'dns')`, t.svc, t.o.orgId);
  const other = id('srv');
  run(t.app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'box-b', '203.0.113.10', 'credential://ssh/b/private-key', 'ready')`, other, t.o.orgId);
  run(t.app.db, `INSERT INTO service_targets (service_id, server_id, org_id, role, state, deployment_id) VALUES (?, ?, ?, 'replica', 'in', ?)`, t.svc, other, t.o.orgId, svc.current_deployment_id);
  assert.match(canaryRefusal(t.app.db, svc)!, /DNS, which can’t split them precisely.*front proxy/s);
  run(t.app.db, 'DELETE FROM service_targets'); run(t.app.db, 'DELETE FROM fleets');
  run(t.app.db, `UPDATE servers SET facts = ? WHERE id = ?`, JSON.stringify({ web: 'coolify-proxy|traefik:v3.1' }), t.srv);
  assert.match(canaryRefusal(t.app.db, svc)!, /Coolify’s proxy/);
  run(t.app.db, `UPDATE servers SET facts = '{}' WHERE id = ?`, t.srv);
  assert.equal(canaryRefusal(t.app.db, svc), undefined);
  const r = await t.o.h('fleet.canary', { serviceId: t.svc, share: 80 });
  assert.equal(r.status, 'error', 'a first share above 50% isn’t a canary');
});
