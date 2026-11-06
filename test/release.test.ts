// Zero-downtime releases (src/deploy/release.ts and the deploy that uses it): drain, readiness and warm-up, the measured
// proof, the watch window and rolling back by itself as Warden, workers' grace and the job lock. The decisions are pure
// functions; the deploy runs against a stand-in Docker host that answers like Caddy and the containers would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run, all } from '../src/db.ts';
import { ssh, type ExecResult } from '../src/connectors/ssh.ts';
import { containerName, healthCheck } from '../src/deploy/deployer.ts';
import { Redactor } from '../src/redact.ts';
import { parseLog } from '../src/sentinel/traffic.ts';
import {
  drainWait, openConnections, healthWaitMs, warmPaths, rates, watchVerdict, proofOf, stepper, watching, watchTick, stopWatch, drainLimit, PROBE_UA, STEP_KEYS,
} from '../src/deploy/release.ts';
import type { App } from '../src/app.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';

const res = (stdout = '', code = 0): ExecResult => ({ code, stdout, stderr: '', truncated: false });
type Call = { command: string };
function fakeHost(app: App, answer: (c: string) => ExecResult | Promise<ExecResult> | undefined = () => undefined) {
  const calls: Call[] = [];
  ssh(app).exec = async (_s, command) => {
    calls.push({ command });
    const r = await answer(command);
    if (r) return r;
    if (command.includes(`'inspect'`) && command.includes('OOMKilled')) return res('running 0 false 0');
    if (command.includes(`'inspect'`) && command.includes('State.Status')) return res('running 0 0'); // a worker's stay-up check
    if (command.includes('curlimages/curl')) return res('200');
    return res();
  };
  return calls;
}
// one Caddy access log line
const line = (o: { ts: number; host?: string; uri?: string; status?: number; ms?: number; ua?: string; method?: string }) => JSON.stringify({
  level: 'info', ts: o.ts, logger: 'http.log.access', msg: 'handled request',
  request: { remote_ip: '198.51.100.7', client_ip: '198.51.100.7', method: o.method ?? 'GET', host: o.host ?? 'shop.example.com', uri: o.uri ?? '/', headers: { 'User-Agent': [o.ua ?? 'Mozilla/5.0 Chrome/120'] } },
  duration: (o.ms ?? 40) / 1000, status: o.status ?? 200,
});
const isLogRead = (c: string) => c.includes('handled request') && c.includes('docker logs --since');
const isPaths = (c: string) => c.includes('for p in "$@"');
const isCount = (c: string) => c.includes('/proc/') && c.includes('net/tcp');
const isSwitchCheck = (c: string) => c.includes(PROBE_UA) && c.includes('docker run -d');

async function imageApp(kind: 'app' | 'worker' = 'app') {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === 'development').id;
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ publicIp: '203.0.113.9' }));
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', kind, serverId: srv, source: { type: 'image', image: 'nginx:alpine' }, port: 80 })).serviceId;
  const row = () => get<any>(app.db, 'SELECT * FROM services WHERE id = ?', svc);
  const deps = () => all<any>(app.db, 'SELECT * FROM deployments WHERE service_id = ? ORDER BY number', svc);
  const plan = (n: number) => JSON.parse(deps()[n - 1].plan);
  const domain = () => { run(app.db, 'DELETE FROM domains'); run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls_mode) VALUES (?, ?, 'shop.example.com', ?, 'active', 'off')`, id('dom'), o.orgId, svc); };
  return { app, o, env, srv, svc, row, deps, plan, domain, name: (n: number) => containerName(row(), n) };
}

// --- drain ----------------------------------------------------------------------------------------------------------

test('drain waits until the old version has no open connections, or the limit, and says when it couldn’t count', async () => {
  let t = 0;
  const clock = { sleep: async (ms: number) => { t += ms; }, now: () => t };
  const counts = [3, 2, 0], seen: number[] = [];
  assert.deepEqual(await drainWait(async () => counts.shift()!, { limitMs: 30_000, everyMs: 1000, onCount: (n) => seen.push(n), ...clock }), { ms: 2000, open: 0, why: 'empty' });
  assert.deepEqual(seen, [3, 2], 'each count is shown while it waits');
  t = 0;
  assert.deepEqual(await drainWait(async () => 4, { limitMs: 5000, everyMs: 1000, ...clock }), { ms: 5000, open: 4, why: 'limit' }, 'never longer than the limit');
  t = 0;
  assert.deepEqual(await drainWait(async () => null, { limitMs: 30_000, settleMs: 10_000, ...clock }), { ms: 10_000, open: null, why: 'unknown' }, 'unknown: a short settle, not the whole limit');
  t = 0;
  assert.equal((await drainWait(async () => { throw new Error('ssh dropped'); }, { limitMs: 3000, settleMs: 10_000, ...clock })).why, 'unknown');
  assert.equal(t, 3000, 'the settle never passes the limit');
  assert.equal(drainLimit(undefined, false), 30);
  assert.equal(drainLimit(undefined, true), 120, 'live connections (websockets) get longer');
  assert.equal(drainLimit({ drainSeconds: 45 }, true), 45, 'a person’s setting wins');
});

test('open connections are read from /proc/net/tcp: established, on the app’s port only', () => {
  const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11 1 0 100 0 0 10 0
   1: 0200140A:0BB8 0300140A:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 12 1 0 20 4 30 10 -1
   2: 0200140A:0BB8 0300140A:D2F2 01 00000000:00000000 00:00000000 00000000  1000        0 13 1 0 20 4 30 10 -1
   3: 0200140A:9C40 0500140A:1538 01 00000000:00000000 00:00000000 00000000  1000        0 14 1 0 20 4 30 10 -1
   4: 0200140A:0BB8 0300140A:D2F4 08 00000000:00000000 00:00000000 00000000  1000        0 15 1 0 20 4 30 10 -1`;
  assert.equal(openConnections(tcp, 3000), 2, 'the listener, the app’s own database connection and a closing one don’t count');
  assert.equal(openConnections('', 3000), 0);
  assert.equal(openConnections(`${tcp}\nUNREADABLE`, 3000), null, 'one copy unreadable: unknown, never 0');
});

// --- readiness ------------------------------------------------------------------------------------------------------

test('readiness: the startup wait comes from history, and warm-up picks the busiest real pages', () => {
  assert.equal(healthWaitMs([]), 90_000);
  assert.equal(healthWaitMs([4000, 70_000]), 210_000, 'three times the slowest start');
  assert.equal(healthWaitMs([400_000]), 300_000, 'never more than 5 minutes');
  const { hits } = parseLog([
    ...Array.from({ length: 5 }, (_, i) => line({ ts: 1, uri: `/pricing?ref=${i}` })),
    ...Array.from({ length: 3 }, () => line({ ts: 1, uri: '/about' })),
    ...Array.from({ length: 9 }, () => line({ ts: 1, uri: '/assets/app.js' })),
    ...Array.from({ length: 9 }, () => line({ ts: 1, uri: '/.env', status: 404 })),
    ...Array.from({ length: 9 }, () => line({ ts: 1, uri: '/api/cart', method: 'POST' })),
    ...Array.from({ length: 9 }, () => line({ ts: 1, uri: '/broken', status: 500 })),
    ...Array.from({ length: 9 }, () => line({ ts: 1, uri: '/health', ua: PROBE_UA })),
    line({ ts: 1, uri: '/docs' }),
  ].join('\n'));
  assert.deepEqual(warmPaths(hits), ['/pricing', '/about', '/docs'], 'GET pages that worked; no files, scanners, writes, errors or Unit7’s own checks; no query strings');
  assert.deepEqual(warmPaths(hits, ['/users/:id', '/faq', '/pricing'], 5), ['/pricing', '/about', '/docs', '/faq'], 'the traffic checks fill in, never a page with an id in it');
  assert.deepEqual(warmPaths([]), ['/'], 'nothing known: the home page');
});

test('the deploy finds the app’s own health page, warms its busiest pages, and remembers how long it took to start', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  t.domain();
  const calls = fakeHost(t.app, (c) => {
    if (isLogRead(c) && c.includes(`'30m'`)) return res(`@@now 1700000000.0\n${[...Array(4)].map(() => line({ ts: 1699999990, uri: '/pricing' })).join('\n')}`);
    if (isPaths(c) && c.includes(`'/healthz'`)) return res('404 0.010 /health\n200 0.012 /healthz\n404 0.010 /api/health\n404 0.010 /up');
    if (isPaths(c) && c.includes(`'/pricing'`)) return res('200 0.120 /pricing\n200 0.340 /docs');
    return undefined;
  });
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const p = t.plan(2);
  assert.equal(p.readyPath, '/healthz', 'found by asking');
  assert.equal(p.healthPath, '/', 'Caddy’s own checks stay as they were (a page it never watched could take a working site down)');
  assert.ok(!calls.some((c) => c.command.includes('tee') && c.command.includes('health_uri')));
  assert.equal(p.warm.slowestMs, 340);
  assert.equal(typeof p.startMs, 'number');
  assert.match(p.steps.find((s: any) => s.key === 'check').note, /^Checked 2 pages · slowest 340 ms$/);
  stopWatch(t.app, t.svc, 'test over');
});

test('a page that works on the live version but fails on the new one stops the deploy before the switch', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  t.domain();
  const calls = fakeHost(t.app, (c) => {
    if (isLogRead(c)) return res(`@@now 1700000000.0\n${line({ ts: 1699999990, uri: '/checkout' })}`);
    if (isPaths(c) && c.includes(`'/checkout'`)) return res('500 0.050 /checkout');
    return undefined;
  });
  const r = await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true });
  assert.equal(r.status, 'error');
  assert.match((r as any).error.message, /answered 500 on \/checkout, a page that works on the live version/);
  assert.equal(calls.filter((c) => isPaths(c.command) && c.command.includes(`'/checkout'`)).length, 2, 'asked twice before deciding');
  assert.ok(!calls.some((c) => c.command.includes('tee') && c.command.includes(t.name(2))), 'visitors never moved');
  assert.equal(t.row().current_deployment_id, t.deps()[0].id);
  assert.equal(t.plan(2).steps.find((s: any) => s.key === 'check').state, 'failed', 'the timeline shows where it stopped');
});

test('a page that must contain a text: a good answer without it isn’t healthy', async () => {
  const t = await imageApp();
  const s = get<any>(t.app.db, 'SELECT * FROM servers WHERE id = ?', t.srv);
  const ctx = { app: t.app, db: t.app.db, redactor: new Redactor() } as any;
  fakeHost(t.app, (c) => (c.includes('grep -qF') ? res('200 missing') : undefined));
  const bad = await healthCheck(ctx, s, 'web-1', 80, '/', () => undefined, { timeoutMs: 1, contains: 'Welcome back' });
  assert.equal(bad.healthy, false);
  assert.match(bad.detail, /HTTP 200, but the page doesn’t contain “Welcome back”/);
  const calls = fakeHost(t.app, (c) => (c.includes('grep -qF') ? res('200 found') : undefined));
  assert.equal((await healthCheck(ctx, s, 'web-1', 80, '/', () => undefined, { timeoutMs: 10_000, contains: 'Welcome back' })).healthy, true);
  assert.ok(calls[1]!.command.endsWith(`'Welcome back'`), 'the text goes in as an argument, never as shell');
});

// --- the switch, the drain and the proof ------------------------------------------------------------------------------

test('the switch: the old version drains, then stops with time to finish; the proof is counted from Caddy’s log', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  assert.equal(t.deps()[0].downtime_seconds, null, 'a first deploy has nothing to switch from: not measured');
  t.domain();
  let counts = 0;
  const calls = fakeHost(t.app, (c) => {
    if (isSwitchCheck(c)) return res('@@now 1700000000.000');
    if (isCount(c)) return res(++counts === 1 ? '   1: 0200140A:0050 0300140A:D2F0 01 0 0 0 0 0 0 1' : '');
    if (isLogRead(c) && c.includes(`'1699999999'`)) {
      return res(['@@now 1700000004.5', ...Array.from({ length: 16 }, (_, i) => line({ ts: 1700000000 + i * 0.25, uri: '/', ua: PROBE_UA })),
        line({ ts: 1700000001.2, uri: '/pricing', status: 502 }), line({ ts: 1700000001.7, uri: '/', status: 502, ua: PROBE_UA }), line({ ts: 1699999000, uri: '/', status: 502 })].join('\n'));
    }
    return undefined;
  });
  const out = ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const two = t.deps()[1];
  assert.equal(two.failed_requests, 2, 'only requests inside the switch window count');
  assert.equal(two.downtime_seconds, 1, 'seconds in which a request failed');
  assert.deepEqual(out.proof, { measured: true, requests: 18, failed: 2, downtimeSeconds: 1 });
  const i = (f: (c: string) => boolean) => calls.findIndex((c) => f(c.command));
  const site = i((c) => c.includes('tee') && c.includes(t.name(2)));
  const check = i(isSwitchCheck), count = i(isCount);
  const stop = i((c) => c.includes('docker stop -t') && c.includes(`'${t.name(1)}'`));
  assert.ok(check >= 0 && check < site, 'Unit7’s own check runs before traffic moves');
  assert.ok(site < count && count < stop, 'the old version stops only after the drain');
  assert.equal(calls.filter((c) => isCount(c.command)).length, 2, 'it waited for the open connection to finish');
  assert.ok(calls[stop]!.command.includes(`'30' '${t.name(1)}'`), 'SIGTERM with 30 s of Docker grace, every copy');
  assert.ok(calls.some((c, k) => k > stop && c.command.includes('docker rm -f "$1"') && c.command.includes('unit7-switchcheck-')), 'the check is removed afterwards');
  // the timeline, in order, with the drain told plainly
  const steps = t.plan(2).steps;
  assert.deepEqual(steps.map((s: any) => s.key), [...STEP_KEYS.slice(0, 8)]);
  assert.deepEqual(steps.map((s: any) => s.state), ['done', 'skipped', 'skipped', 'done', 'done', 'done', 'done', 'active']);
  assert.match(steps.find((s: any) => s.key === 'drain').note, /^The old version (finished its last request after \d+ s|had nothing left to finish)$/);
  assert.match(out.watching, /^Watching for 5 min/);
  stopWatch(t.app, t.svc, 'test over');
});

test('a proxy log that can’t be read is “not measured”, never 0', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  t.domain();
  fakeHost(t.app, (c) => (isSwitchCheck(c) ? res('@@now 1700000000.000') : isLogRead(c) ? res('@@nolog') : undefined));
  const out = ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  assert.equal(out.proof.measured, false);
  assert.equal(t.deps()[1].downtime_seconds, null);
  assert.equal(t.deps()[1].failed_requests, null);
  const one = ok(await t.o.h('service.get', { serviceId: t.svc }));
  assert.equal(one.deployments[0].proof_measured, 0, 'the app page can say “Not measured”');
  assert.deepEqual(one.release.proof, { deploys: 2, measured: 0, downtimeSeconds: 0, failedRequests: 0 }, '“Last 20 deploys” counts only what was measured');
  assert.equal(proofOf(null, 0, 1).measured, false);
  stopWatch(t.app, t.svc, 'test over');
});

// --- the watch window ---------------------------------------------------------------------------------------------------

test('the watch decides: enough requests, clearly worse than usual, or a failing health check', () => {
  const base = { requests: 400, errors: 4, p95: 200 }; // 1%
  assert.equal(watchVerdict(base, { requests: 20, errors: 20 }, { healthFails: 0, done: false }).act, 'wait', 'too few requests to judge');
  assert.equal(watchVerdict(base, { requests: 100, errors: 2 }, { healthFails: 0, done: false }).act, 'wait', '2% is under max(2%, 3 × 1%)');
  assert.deepEqual(watchVerdict(base, { requests: 100, errors: 6 }, { healthFails: 0, done: false }), { act: 'rollback', reason: 'errors jumped to 6% (usually 1%)' });
  assert.equal(watchVerdict({ requests: 400, errors: 40 }, { requests: 100, errors: 25 }, { healthFails: 0, done: false }).act, 'wait', 'a noisy app: 25% is under 3 × its usual 10%');
  assert.deepEqual(watchVerdict(undefined, { requests: 40, errors: 3 }, { healthFails: 0, done: false }), { act: 'rollback', reason: 'errors jumped to 7.5%' }, 'no baseline: over 2%');
  assert.deepEqual(watchVerdict(base, { requests: 60, errors: 0, p95: 2400 }, { healthFails: 0, done: false }), { act: 'rollback', reason: 'pages got slow: 2.4 s instead of the usual 200 ms' });
  assert.equal(watchVerdict(base, { requests: 60, errors: 0, p95: 900 }, { healthFails: 0, done: false }).act, 'wait', '900 ms is not 3 × slower and a second more');
  assert.deepEqual(watchVerdict(base, { requests: 0, errors: 0 }, { healthFails: 3, done: false }), { act: 'rollback', reason: 'it stopped answering its health check' });
  assert.equal(watchVerdict(base, { requests: 0, errors: 0 }, { healthFails: 2, done: true }).act, 'ok', 'the window ends calm');
  const r = rates(parseLog([line({ ts: 10 }), line({ ts: 11, status: 500 }), line({ ts: 12, status: 101 }), line({ ts: 13, ua: PROBE_UA })].join('\n')).hits);
  assert.deepEqual([r.requests, r.errors, r.websockets], [3, 1, true], 'Unit7’s own checks never count as visitors');
});

async function watchedApp() {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  t.domain();
  // the live version's usual: 100 requests, 1 error
  fakeHost(t.app, (c) => {
    if (isLogRead(c) && c.includes(`'30m'`)) return res(['@@now 1700000000.0', ...Array.from({ length: 100 }, (_, i) => line({ ts: 1699999000 + i, status: i === 0 ? 500 : 200 }))].join('\n'));
    if (isSwitchCheck(c)) return res('@@now 1700000001.000');
    if (isLogRead(c)) return res('@@now 1700000005.0');
    return undefined;
  });
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const w = watching(t.svc)!;
  assert.ok(w, 'the deploy returned and the watch runs on');
  return { ...t, w };
}
const worse = (app: App) => fakeHost(app, (c) => {
  if (isLogRead(c)) return res(['@@now 1700000100.0', ...Array.from({ length: 40 }, (_, i) => line({ ts: 1700000010 + i, status: i % 6 === 0 ? 500 : 200 }))].join('\n'));
  if (isPaths(c)) return res('200 0.020 /');
  return undefined;
});

test('errors jump after the switch: Warden rolls back through the gate and says why, and the phone hears it', async () => {
  const t = await watchedApp();
  assert.deepEqual(t.w.base && [t.w.base.requests, t.w.base.errors], [100, 1]);
  worse(t.app);
  const v = await watchTick(t.app, t.w);
  assert.equal(v.act, 'rollback');
  assert.equal(t.row().current_deployment_id, t.deps()[0].id, 'the version before is live again');
  const audit = get<any>(t.app.db, `SELECT actor_name, actor_kind, result, reason FROM audit WHERE tool = 'deployment.rollback' ORDER BY created_at DESC LIMIT 1`);
  assert.deepEqual([audit.actor_name, audit.actor_kind, audit.result], ['Warden', 'agent', 'success'], 'through the one gate, as Warden');
  assert.match(audit.reason, /errors jumped to 17.5% \(usually 1%\) after the deploy/);
  const ev = get<any>(t.app.db, `SELECT message, severity, project_id FROM events WHERE type = 'deployment.rolled_back'`);
  assert.equal(ev.message, 'Rolled back web: errors jumped to 17.5% (usually 1%) after the deploy');
  assert.ok(ev.project_id, 'with the project, so “Show me” opens the app');
  const p = t.plan(2);
  assert.equal(p.watch.status, 'rolled_back');
  assert.equal(p.steps.find((s: any) => s.key === 'watch').state, 'failed');
  assert.equal(watching(t.svc), undefined);
  // the phone: "Rolled back web: errors jumped to 17.5% … · Show me"
  const { subscribeUrl } = setupNtfy(t.app, t.o.orgId);
  const sent: { url: string; init: RequestInit }[] = [];
  const e = get<any>(t.app.db, `SELECT * FROM events WHERE type = 'deployment.rolled_back'`);
  process.env.UNIT7_URL = 'https://unit7.example.com';
  try { assert.equal(await deliver(t.app, { ...e, data: {} }, async (url, init) => { sent.push({ url, init }); }), 1); } finally { delete process.env.UNIT7_URL; }
  const h = sent.find((x) => x.url === subscribeUrl)!.init.headers as Record<string, string>;
  assert.equal(h.Title, 'Unit7: Rolled back by itself');
  assert.match(String(sent[0]!.init.body), /^Rolled back web: errors jumped to 17.5% \(usually 1%\) after the deploy/);
  assert.equal(h.Actions, `view, Show me, https://unit7.example.com/projects/${e.project_id}/services/${t.svc}, clear=true`);
});

test('after a database change, or with rolling back turned off, the watch warns instead', async () => {
  const t = await watchedApp();
  t.w.migrated = true;
  worse(t.app);
  assert.equal((await watchTick(t.app, t.w)).act, 'rollback');
  assert.equal(t.row().current_deployment_id, t.deps()[1].id, 'still on the new version');
  assert.match(get<any>(t.app.db, `SELECT message FROM events WHERE type = 'deployment.watch_bad'`).message, /didn’t roll back by itself because this deploy changed the database/);
  assert.equal(t.plan(2).watch.status, 'bad');
});

test('a calm window ends “looks good”; a person can stop it early; a rollback or a newer deploy ends it', async () => {
  const t = await watchedApp();
  fakeHost(t.app, (c) => (isPaths(c) ? res('200 0.020 /') : isLogRead(c) ? res('@@now 1700000100.0') : undefined));
  assert.equal((await watchTick(t.app, t.w, t.w.until - 1)).act, 'wait');
  assert.equal((await watchTick(t.app, t.w, t.w.until + 1)).act, 'ok');
  assert.equal(t.plan(2).watch.status, 'ok');
  assert.deepEqual(t.plan(2).steps.slice(-2).map((s: any) => [s.key, s.state]), [['watch', 'done'], ['done', 'done']]);
  assert.ok(get(t.app.db, `SELECT 1 FROM events WHERE type = 'deployment.watch_ok'`));

  const u = await watchedApp();
  const agent = await u.o.a('deployment.watch_stop', { serviceId: u.svc });
  assert.equal(agent.status, 'error', 'turning off the safety net is for people');
  assert.equal(ok(await u.o.h('deployment.watch_stop', { serviceId: u.svc })).stopped, true);
  assert.equal(u.plan(2).watch.status, 'stopped');

  const v = await watchedApp();
  ok(await v.o.h('deployment.rollback', { serviceId: v.svc }));
  assert.equal(watching(v.svc), undefined, 'rolled back: nothing left to watch');
  assert.match(v.plan(2).steps.find((s: any) => s.key === 'watch').note, /Stopped watching: rolled back/);
});

test('release settings: safe defaults, people-only to turn a safety off', async () => {
  const t = await imageApp();
  const r0 = ok(await t.o.h('service.get', { serviceId: t.svc })).release;
  assert.deepEqual([r0.drainSeconds, r0.watchMinutes, r0.autoRollback, r0.mustContain, r0.workerGraceSeconds], [30, 5, true, '', 60]);
  for (const off of [{ autoRollback: false }, { watchMinutes: 0 }]) {
    const r = await t.o.a('release.settings', { serviceId: t.svc, ...off });
    assert.equal(r.status, 'error');
    assert.match((r as any).error.message, /for people only/);
  }
  ok(await t.o.a('release.settings', { serviceId: t.svc, watchMinutes: 10, mustContain: 'Welcome' }));
  const off = ok(await t.o.h('release.settings', { serviceId: t.svc, autoRollback: false }));
  assert.equal(off.release.autoRollback, false);
  assert.deepEqual(off.undo.input, { serviceId: t.svc, autoRollback: true });
  assert.equal((await t.o.a('release.settings', { serviceId: t.svc, mustContain: '' })).status, 'error', 'removing the page check is a person’s call too');
  const cfg = JSON.parse(t.row().config).release;
  assert.deepEqual(cfg, { watchMinutes: 10, mustContain: 'Welcome', autoRollback: false });
});

// --- workers and jobs ---------------------------------------------------------------------------------------------------

test('a worker: the new one starts first, the old one gets SIGTERM and its grace time to finish the job', async () => {
  const t = await imageApp('worker');
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  ok(await t.o.h('release.settings', { serviceId: t.svc, workerGraceSeconds: 120 }));
  const calls = fakeHost(t.app);
  const out = ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const start = calls.findIndex((c) => c.command.includes('docker run -d --name') && c.command.includes(t.name(2)));
  const stop = calls.findIndex((c) => c.command.includes('docker stop -t') && c.command.includes(`'120' '${t.name(1)}'`));
  assert.ok(start >= 0 && stop > start, 'started, checked, then the old one is told to stop');
  assert.ok(!calls.some((c) => isCount(c.command)), 'workers take no web traffic to drain');
  const steps = t.plan(2).steps;
  assert.match(steps.find((s: any) => s.key === 'drain').note, /^Old worker finished its job \(\d+ s\), then stopped$/);
  assert.equal(steps.find((s: any) => s.key === 'watch').state, 'skipped');
  assert.equal(out.watching, undefined);
});

test('a job never runs twice at once: a second start is skipped, here or on the server', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const job = ok(await t.o.h('job.schedule', { serviceId: t.svc, name: 'report', schedule: 'hourly', command: 'node report.js' })).jobId;
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  fakeHost(t.app, (c) => (c.includes('docker run --rm --name') ? held.then(() => res('done')) : undefined));
  const first = t.o.h('job.run', { jobId: job });
  await new Promise((r) => setTimeout(r, 30));
  const second = ok(await t.o.h('job.run', { jobId: job }));
  assert.match(second.skipped, /already running/);
  release();
  assert.equal(ok(await first).ok, true);
  // the name on the server is taken (a run from before a restart): skipped, and recorded as such
  fakeHost(t.app, (c) => (c.includes('docker run --rm --name') ? res('docker: Error response from daemon: Conflict. The container name "/unit7-job-x" is already in use by container "abc".', 125) : undefined));
  const third = ok(await t.o.h('job.run', { jobId: job }));
  assert.match(third.skipped, /already running on the server/);
  assert.equal(get<any>(t.app.db, 'SELECT last_status FROM jobs WHERE id = ?', job).last_status, 'skipped (already running)');
});

test('the timeline records each step with its time, and the release tool reads it back', () => {
  let now = 1_000;
  const saved: any[] = [];
  const st = stepper((s) => saved.push(JSON.parse(JSON.stringify(s))), () => saved.length, () => now);
  st.go('build'); now += 500; st.note('Built the app');
  st.skip('test', 'No tests found in the code');
  st.go('database'); now += 250; st.fail('The migration failed');
  const last = saved.at(-1);
  assert.deepEqual(last.map((s: any) => [s.key, s.state, s.ms, s.note]), [['build', 'done', 500, 'Built the app'], ['test', 'skipped', 0, 'No tests found in the code'], ['database', 'failed', 250, 'The migration failed']]);
});
