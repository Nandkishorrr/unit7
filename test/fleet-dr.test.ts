// A warm standby (src/fleet/dr.ts), proven with fakes: the restore cadence, when Warden may switch by itself (autonomy,
// how long the main server has been down, a standby that answers), the promise maths, the setup (database copies under
// the same names, data from a fresh backup with the password never on a command line, the app out of rotation with its
// jobs off), the switch and the switch back (DNS, the data coming home after a fresh backup), and the drill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok, setAutonomy } from './helpers.ts';
import { all, get, id, run } from '../src/db.ts';
import { ssh, type ExecOptions, type ServerRow } from '../src/connectors/ssh.ts';
import { makeRef } from '../src/vault.ts';
import { DOWN_MINUTES, drDeps, drillDue, drTick, failoverDecision, promiseOf, quietHour, refreshDue } from '../src/fleet/dr.ts';
import { fleetDeps, type DnsHost } from '../src/fleet/traffic.ts';
import { shares, targetsOf } from '../src/fleet/model.ts';
import type { App } from '../src/app.ts';
import type { ServiceRow } from '../src/deploy/deployer.ts';

const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
const SUM = 'a'.repeat(64), PW = 'pw-Sam-db-secret-123';
fleetDeps.sleep = async () => undefined;

// --- the decisions -------------------------------------------------------------------------------------------------------
test('the restore cadence: every N hours, only while the standby is ready', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 8, 0) - h * 3600_000).toISOString();
  const nowMs = Date.UTC(2026, 9, 8, 0);
  assert.equal(refreshDue({ status: 'ready', hours: 6, refreshed_at: null }, nowMs), true, 'never copied');
  assert.equal(refreshDue({ status: 'ready', hours: 6, refreshed_at: at(5) }, nowMs), false);
  assert.equal(refreshDue({ status: 'ready', hours: 6, refreshed_at: at(6) }, nowMs), true);
  assert.equal(refreshDue({ status: 'ready', hours: 2, refreshed_at: at(3) }, nowMs), true);
  assert.equal(refreshDue({ status: 'active', hours: 6, refreshed_at: at(30) }, nowMs), false, 'serving visitors: its data is the live data');
});

test('when to switch: 5 minutes down, a standby that answers, and by itself only at Production autonomy or higher', () => {
  const nowMs = 10_000_000, since = (m: number) => new Date(nowMs - m * 60_000).toISOString();
  const d = (o: Partial<Parameters<typeof failoverDecision>[0]>) => failoverDecision({ status: 'ready', standbyHealthy: true, mainDownSince: since(6), nowMs, autonomy: 3, ...o }).act;
  assert.equal(d({ mainDownSince: null }), 'none');
  assert.equal(d({ mainDownSince: since(4) }), 'wait', `under ${DOWN_MINUTES} minutes: wait`);
  assert.equal(d({}), 'failover');
  assert.equal(d({ autonomy: 4 }), 'failover');
  assert.equal(d({ autonomy: 2 }), 'ask', 'below Production autonomy a person taps');
  assert.equal(d({ autonomy: 0 }), 'ask');
  assert.equal(d({ standbyHealthy: false }), 'alert', 'never to a standby that doesn’t answer');
  assert.equal(d({ status: 'active' }), 'none');
  assert.equal(d({ status: 'preparing' }), 'none');
});

test('the promise: minutes from the switch and the last drill, hours from the restore cadence', () => {
  const base = { status: 'ready', hours: 6, nowMs: Date.UTC(2026, 9, 8, 12), auto: true, dnsEditable: true, hasData: true, main: 'box-a', name: 'shop.example.com', standbyIp: '203.0.113.11',
    dataAt: new Date(Date.UTC(2026, 9, 8, 10)).toISOString(), drill: { at: '', ok: true, answerMs: 180, requests: 5, failed: 0, note: '' } };
  const p = promiseOf(base);
  assert.deepEqual([p.minutes, p.hoursLost], [7, 6]);
  assert.equal(p.words, 'If box-a dies, you’re back in about 7 minutes, losing at most 6 hours of data.');
  assert.equal(promiseOf({ ...base, auto: false }).words, 'If box-a dies, you’re back about 2 minutes after you tap Switch to the standby, losing at most 6 hours of data.');
  assert.equal(promiseOf({ ...base, drill: null }).minutes, 7, 'untested: the standby’s answer counts as up to a minute');
  assert.equal(promiseOf({ ...base, dataAt: new Date(Date.UTC(2026, 9, 7, 12)).toISOString() }).hoursLost, 24, 'copies failing for a day: the promise says so');
  assert.equal(promiseOf({ ...base, hours: 1 }).words, 'If box-a dies, you’re back in about 7 minutes, losing at most 2 hours of data.', 'the copy is 2 hours old right now');
  assert.match(promiseOf({ ...base, hasData: false }).words, /losing nothing it keeps on that server/);
  assert.equal(promiseOf({ ...base, dnsEditable: false }).words, 'If box-a dies, point shop.example.com at 203.0.113.11 and you’re back as soon as that reaches visitors, losing at most 6 hours of data.');
  assert.equal(promiseOf({ ...base, status: 'preparing' }).ready, false);
});

test('the drill: monthly, in a quiet hour on the server’s clock, a day after setting up at the earliest', () => {
  const night = Date.UTC(2026, 9, 8, 3, 30), day = Date.UTC(2026, 9, 8, 14);
  assert.equal(quietHour(night), true);
  assert.equal(quietHour(day), false);
  assert.equal(quietHour(Date.UTC(2026, 9, 8, 1, 30), 120), true, 'UTC+2: 03:30 there');
  const r = { status: 'ready' as const, created_at: new Date(night - 2 * 86400_000).toISOString(), drill: null as string | null };
  assert.equal(drillDue(r, night), true, 'first drill a day or more after setting up');
  assert.equal(drillDue(r, day), false, 'not in a busy hour');
  assert.equal(drillDue({ ...r, drill: JSON.stringify({ at: new Date(night - 10 * 86400_000).toISOString() }) }, night), false);
  assert.equal(drillDue({ ...r, drill: JSON.stringify({ at: new Date(night - 31 * 86400_000).toISOString() }) }, night), true);
  assert.equal(drillDue({ ...r, status: 'active' as const }, night), false);
});

// --- on stand-in servers ------------------------------------------------------------------------------------------------
async function world(app: App) {
  const o = await testOrg(app);
  run(app.db, `UPDATE orgs SET offsite = 'off' WHERE id = ?`, o.orgId); // no background copies off the server in this test
  const proj = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] }));
  const envId = proj.environments[0].id as string;
  const [a, b] = ['box-a', 'box-b'].map((name, k) => {
    const sid = id('srv');
    run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, ?, ?, 'root', 'credential://ssh/box/private-key', 'ready', ?)`, sid, o.orgId, name, `203.0.113.${10 + k}`, JSON.stringify({ web: 'unit7-caddy|caddy:2', publicIp: `203.0.113.${10 + k}` }));
    return sid;
  }) as [string, string];
  const svcId = id('svc'), depId = id('dep'), dbId = id('svc');
  const env6 = envId.slice(-6).toLowerCase();
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status, current_deployment_id) VALUES (?, ?, ?, ?, ?, 'shop', 'shop', 'app', ?, 'healthy', ?)`,
    svcId, o.orgId, proj.projectId ?? proj.id, envId, a, JSON.stringify({ port: 3000, healthPath: '/health' }), depId);
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, image, container, plan) VALUES (?, ?, ?, 42, 'live', 'unit7/shop:42', ?, ?)`, depId, o.orgId, svcId, `unit7-shop-${env6}-42`, JSON.stringify({ port: 3000, healthPath: '/health' }));
  const pwRef = makeRef('postgres', dbId, 'password');
  app.vault.put(o.orgId, pwRef, PW, { kind: 'db_password', by: 'test' });
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status) VALUES (?, ?, ?, ?, ?, 'shop-db', 'shop-db', 'postgres', ?, 'healthy')`,
    dbId, o.orgId, proj.projectId ?? proj.id, envId, a, JSON.stringify({ engine: 'postgres', container: `unit7-shop-db-${env6}`, database: 'app', port: 5432, passwordRef: pwRef, volume: `unit7-shop-db-${env6}-data` }));
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls, tls_mode) VALUES (?, ?, 'shop.example.com', ?, 'active', 'active', 'auto')`, id('dom'), o.orgId, svcId);
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, status) VALUES (?, ?, 'cloudflare', 'Cloudflare', 'cf', 'verified')`, id('acc'), o.orgId);
  const svc = () => get<ServiceRow>(app.db, 'SELECT * FROM services WHERE id = ?', svcId)!;
  const dr = () => get<any>(app.db, 'SELECT * FROM dr_standbys WHERE service_id = ?', svcId);
  return { o, envId, a, b, svcId, dbId, svc, dr, db: `unit7-shop-db-${env6}` };
}
function fakeServers(app: App) {
  const seen: { server: string; command: string; stdin: string }[] = [], relays: { from: string; to: string; what: string }[] = [];
  ssh(app).exec = async (s: ServerRow, command: string, o: ExecOptions = {}) => {
    seen.push({ server: s.name, command, stdin: String(o.stdin ?? '') });
    if (command.includes('{{.Config.Image}}')) return done('postgres:17-alpine');
    if (command.includes('wc -c <')) return done(`2048\n${SUM}`);
    if (command.includes('gunzip -t')) return done(SUM);
    if (command.includes('docker image inspect')) return done('yes');
    if (command.includes(`'inspect'`) && command.includes('OOMKilled')) return done('running 0 false 0');
    if (command.includes('curlimages/curl') || command.includes('curl -sk')) return done('200');
    return done();
  };
  ssh(app).relay = async (from, what, to) => { relays.push({ from: from.name, to: to.name, what }); };
  return { seen, relays };
}
function fakeDns(start: string[]) {
  const records = new Map([['shop.example.com', [...start]]]);
  const dns: DnsHost = {
    list: async (n) => [...(records.get(n) ?? [])],
    add: async (n, ip) => { records.set(n, [...(records.get(n) ?? []), ip]); },
    remove: async (n, ip) => { records.set(n, (records.get(n) ?? []).filter((x) => x !== ip)); },
  };
  return { dns, records };
}

test('setting up a standby: database copies under the same names, data from a fresh backup, the app out of rotation with its jobs off', { timeout: 60_000 }, async () => {
  const app = testApp();
  const w = await world(app);
  const f = fakeServers(app);
  const out = ok(await w.o.h('dr.setup', { serviceId: w.svcId, serverId: w.b }));
  assert.equal(out.standby.status, 'ready');
  assert.equal(out.standby.hours, 6);
  assert.deepEqual(out.undo.tool, 'dr.remove');
  const onB = f.seen.filter((x) => x.server === 'box-b');
  // the database copy: the same container name and volume, the password only in a 0600 file
  const dbRun = onB.find((x) => x.command.includes('docker run -d') && x.command.includes(w.db))!;
  assert.ok(dbRun.command.includes(`'${w.db}-data'`) && dbRun.command.includes('--env-file') && dbRun.command.includes(`'postgres:17-alpine'`));
  // (the main server's own backup, backups.ts takeBackup, is the one older command that still passes it as an argument)
  assert.ok(!f.seen.some((x) => x.command.includes(PW) && !x.command.includes('pg_dump -U "$4"')), 'the standby’s commands never carry the password');
  assert.ok(onB.some((x) => x.stdin.includes(`POSTGRES_PASSWORD=${PW}`) && x.command.includes('umask 077')), 'it goes into a file only root reads');
  // the data: a fresh backup on the main server, sent over, checked, loaded with the password on stdin
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM backups WHERE service_id = ? AND reason = 'for the standby copy'`, w.dbId)!.n, 1);
  assert.deepEqual(f.relays.map((r) => [r.from, r.to]), [['box-a', 'box-b']]);
  const restore = onB.find((x) => x.command.includes('psql'))!;
  assert.ok(restore.stdin.startsWith(`${PW}\n`) && restore.command.includes(`'${w.db}'`));
  assert.ok(onB.some((x) => x.command.includes('rm -f') && x.command.includes('/var/lib/unit7/backups/')), 'the copy of the backup doesn’t stay there');
  // the app: started there with its jobs off, answering its names on that server's own proxy, out of rotation
  assert.ok(onB.some((x) => x.stdin.includes('UNIT7_RUN_JOBS=0')));
  assert.ok(onB.some((x) => x.command.includes('tee') && x.command.includes('shop.example.com')), 'ready for the day DNS points there');
  const ts = targetsOf(app.db, w.svc());
  assert.deepEqual(ts.map((t) => [t.role, t.state, t.number]), [['primary', 'in', 42], ['standby', 'out', 42]]);
  assert.deepEqual(shares(ts), { [w.a]: 100, [w.b]: 0 }, 'no visitors for the standby');
  assert.ok(w.dr().data_at);
  // the promise, in words
  const st = ok(await w.o.h('dr.status', { serviceId: w.svcId }));
  assert.equal(st.promise.words, 'If box-a dies, you’re back in about 7 minutes, losing at most 6 hours of data.');
  // a person can't put the standby into rotation by hand: that's the switch
  const r = await w.o.h('fleet.rotate', { serviceId: w.svcId, serverId: w.b, out: false });
  assert.match((r as any).error.message, /warm copy .*switch to the standby/);
});

test('the switch: Warden by itself at Production autonomy after 5 minutes down; asks below; any other AI asks; a person taps', { timeout: 90_000 }, async () => {
  const app = testApp();
  const w = await world(app);
  fakeServers(app);
  ok(await w.o.h('dr.setup', { serviceId: w.svcId, serverId: w.b }));
  fleetDeps.probe = async () => true;
  const d = fakeDns(['203.0.113.10']);
  fleetDeps.dns = async () => d.dns;
  const down = (m: number) => run(app.db, `UPDATE servers SET status = 'unreachable', facts = json_set(facts, '$.wardenDown', ?) WHERE id = ?`, new Date(Date.now() - m * 60_000).toISOString(), w.a);
  // below Production autonomy: Warden asks (an approval, one tap on the phone)
  setAutonomy(app, w.envId, 2);
  down(6);
  await drTick(app);
  assert.equal(w.dr().status, 'ready');
  assert.equal(get<any>(app.db, `SELECT tool FROM approvals WHERE org_id = ? AND status = 'pending'`, w.o.orgId)?.tool, 'dr.failover');
  // any other AI asks too, at any autonomy
  setAutonomy(app, w.envId, 4);
  assert.equal((await w.o.a('dr.failover', { serviceId: w.svcId })).status, 'approval_required');
  // Production autonomy, down 4 minutes: wait; 6 minutes: by itself
  const app2 = testApp();
  const w2 = await world(app2);
  const f2 = fakeServers(app2);
  ok(await w2.o.h('dr.setup', { serviceId: w2.svcId, serverId: w2.b }));
  setAutonomy(app2, w2.envId, 3);
  run(app2.db, `UPDATE servers SET status = 'unreachable', facts = json_set(facts, '$.wardenDown', ?) WHERE id = ?`, new Date(Date.now() - 4 * 60_000).toISOString(), w2.a);
  await drTick(app2);
  assert.equal(w2.dr().status, 'ready', 'not yet: under 5 minutes');
  run(app2.db, `UPDATE servers SET facts = json_set(facts, '$.wardenDown', ?) WHERE id = ?`, new Date(Date.now() - 6 * 60_000).toISOString(), w2.a);
  f2.seen.length = 0;
  await drTick(app2);
  assert.equal(w2.dr().status, 'active');
  assert.deepEqual(d.records.get('shop.example.com'), ['203.0.113.11'], 'DNS points at the standby only');
  assert.ok(f2.seen.some((x) => x.server === 'box-b' && x.stdin.includes('PORT=3000') && !x.stdin.includes('UNIT7_RUN_JOBS')), 'the standby takes the scheduled jobs');
  assert.deepEqual(targetsOf(app2.db, w2.svc()).map((t) => t.state), ['out', 'in']);
  const ev = get<any>(app2.db, `SELECT message, severity FROM events WHERE type = 'dr.failover'`);
  assert.equal(ev.severity, 'critical', 'a phone alert');
  assert.match(ev.message, /^Unit7 moved shop’s visitors to the standby on box-b: box-a hadn’t answered for 5 minutes/);
  assert.equal(get<any>(app2.db, `SELECT actor_id FROM audit WHERE tool = 'dr.failover' AND result = 'success'`).actor_id, 'warden');
});

test('a person switches in one tap, and back: the standby’s new data goes home after a fresh backup, then DNS', { timeout: 90_000 }, async () => {
  const app = testApp();
  const w = await world(app);
  const f = fakeServers(app);
  ok(await w.o.h('dr.setup', { serviceId: w.svcId, serverId: w.b }));
  fleetDeps.probe = async () => true;
  const d = fakeDns(['203.0.113.10']);
  fleetDeps.dns = async () => d.dns;
  ok(await w.o.h('dr.failover', { serviceId: w.svcId }));
  assert.equal(w.dr().status, 'active');
  assert.equal((await w.o.a('dr.failover', { serviceId: w.svcId, back: true })).status, 'approval_required', 'an AI never switches back alone');
  f.seen.length = 0; f.relays.length = 0;
  const backups = get<{ n: number }>(app.db, 'SELECT count(*) n FROM backups WHERE service_id = ?', w.dbId)!.n;
  ok(await w.o.h('dr.failover', { serviceId: w.svcId, back: true }));
  const i = (pred: (x: { server: string; command: string; stdin: string }) => boolean) => f.seen.findIndex(pred);
  const stopB = i((x) => x.server === 'box-b' && x.command.includes('docker stop'));
  const dumpB = i((x) => x.server === 'box-b' && x.command.includes('pg_dump'));
  const restoreA = i((x) => x.server === 'box-a' && x.command.includes('psql'));
  assert.ok(stopB >= 0 && stopB < dumpB && dumpB < restoreA, 'visits stop, the data is saved there, then loaded at home');
  assert.ok(f.seen[dumpB]!.stdin.startsWith(`${PW}\n`) && f.seen[restoreA]!.stdin.startsWith(`${PW}\n`));
  assert.deepEqual(f.relays.map((r) => [r.from, r.to]), [['box-b', 'box-a']]);
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM backups WHERE service_id = ?', w.dbId)!.n, backups + 1, 'a fresh backup of the main database first');
  assert.deepEqual(d.records.get('shop.example.com'), ['203.0.113.10'], 'DNS home again');
  assert.equal(w.dr().status, 'ready');
  assert.deepEqual(targetsOf(app.db, w.svc()).map((t) => t.state), ['in', 'out']);
  assert.ok(f.seen.some((x) => x.server === 'box-b' && x.stdin.includes('UNIT7_RUN_JOBS=0')), 'the standby sleeps again');
});

test('the drill: only with a healthy standby; fresh data, then the real name over HTTPS at the standby; the result and the promise are kept', { timeout: 60_000 }, async () => {
  const app = testApp();
  const w = await world(app);
  fakeServers(app);
  ok(await w.o.h('dr.setup', { serviceId: w.svcId, serverId: w.b }));
  fleetDeps.probe = async () => false;
  const no = await w.o.h('dr.drill', { serviceId: w.svcId });
  assert.match((no as any).error.message, /doesn’t answer right now, so the drill didn’t run/);
  fleetDeps.probe = async () => true;
  const asked: string[] = [];
  drDeps.ask = async (ip, host, path, tls) => { asked.push(`${tls ? 'https' : 'http'}://${host}${path} @ ${ip}`); return { code: 200, ms: 180 }; };
  const r = ok(await w.o.h('dr.drill', { serviceId: w.svcId }));
  assert.equal(r.drill.ok, true);
  assert.equal(r.drill.answerMs, 180);
  assert.equal(asked.length, 5);
  assert.equal(asked[0], 'https://shop.example.com/health @ 203.0.113.11', 'the real name, at the standby’s address');
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM backups WHERE service_id = ? AND reason = 'for the standby copy'`, w.dbId)!.n, 2, 'the drill copies fresh data first');
  assert.match(get<any>(app.db, `SELECT message FROM events WHERE type = 'dr.drill'`).message, /^Drill passed for shop: The standby answered shop\.example\.com 5 times out of 5, in 180 ms.*If box-a dies, you’re back in about 7 minutes/);
  // the cadence through Warden: due after 6 hours (one explicit clock for both, a day hour so it's a refresh, not a drill)
  const tick = Date.UTC(2026, 9, 8, 14);
  run(app.db, `UPDATE dr_standbys SET refreshed_at = ? WHERE service_id = ?`, new Date(tick - 7 * 3600_000).toISOString(), w.svcId);
  await drTick(app, undefined, tick);
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM backups WHERE service_id = ? AND reason = 'for the standby copy'`, w.dbId)!.n, 3, 'Warden refreshed it');
  assert.ok(all(app.db, `SELECT 1 FROM audit WHERE tool = 'dr.refresh' AND actor_id = 'warden'`).length >= 1);
});
