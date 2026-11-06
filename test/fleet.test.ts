// Many servers (src/fleet), proven with fakes: readiness rules, the rolling order with stop-on-failure and rollback, the
// image transfer, the private network's commands (keys never leave their server), the front proxy's config, DNS rotation
// by health, take out / put back with a drain, and version drift. Real servers: test/fleet-real.test.ts (needs Docker).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions, type ServerRow } from '../src/connectors/ssh.ts';
import { get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import type { Actor, Ctx } from '../src/tools/runtime.ts';
import { scaleRisks } from '../src/connectors/detect.ts';
import { renderSite, putSite } from '../src/deploy/caddy.ts';
import { readinessChecks, fleetReadiness } from '../src/fleet/readiness.ts';
import { drift, shares, targetsOf } from '../src/fleet/model.ts';
import { planBatches, roll, IMAGE, sendImage, copyTo, type Lane, type RollDeps } from '../src/fleet/rolling.ts';
import { WG_KEYGEN, wgConfig, ufwScript, providerAddress, connectServers, isWgKey } from '../src/fleet/network.ts';
import { renderEdge, inFlight, dnsRotate, fleetDeps, fleetTick, type DnsHost } from '../src/fleet/traffic.ts';
import type { ServiceRow } from '../src/deploy/deployer.ts';

const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
type Reply = (command: string, o: ExecOptions, s: ServerRow) => ReturnType<typeof done> | undefined;
function fakeServers(app: App, reply: Reply = () => undefined) {
  const seen: { server: string; command: string; stdin: string }[] = [];
  ssh(app).exec = async (s, command, o = {}) => { seen.push({ server: s.name, command, stdin: String(o.stdin ?? '') }); return reply(command, o, s) ?? done(); };
  return seen;
}
const KEY_A = 'uL0F0q3n4lJ8mAX3bqK2HcD0fY7tQ1wRzS5vN9eP2kM=', KEY_B = 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3a4bE=';
fleetDeps.sleep = async () => undefined; // drains and waits are instant here
const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };

// an organisation with an app live on server A, and server B (and C) ready
async function world(app: App, o: { mode?: 'front' | 'dns'; servers?: number; risks?: string[]; healthPath?: string } = {}) {
  const org = await testOrg(app);
  const proj = ok(await org.h('project.create', { name: 'Shop', environments: ['production'] }));
  const envId = proj.environments[0].id as string;
  const servers = Array.from({ length: o.servers ?? 2 }, (_, k) => {
    const sid = id('srv');
    run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, ?, ?, 'root', 'credential://ssh/box/private-key', 'ready', ?)`,
      sid, org.orgId, `box-${'abc'[k]}`, `203.0.113.${10 + k}`, JSON.stringify({ web: 'unit7-caddy|caddy:2' }));
    return sid;
  });
  const svcId = id('svc'), depId = id('dep'), prevId = id('dep');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status, current_deployment_id) VALUES (?, ?, ?, ?, ?, 'shop', 'shop', 'app', ?, 'healthy', ?)`,
    svcId, org.orgId, proj.projectId ?? proj.id, envId, servers[0], JSON.stringify({ port: 3000, healthPath: o.healthPath ?? '/health', detection: { stack: 'node', builder: 'railpack', port: 3000, needs: [], envKeys: [], healthPath: '/health', notes: [], scaleRisks: o.risks ?? [] } }), depId);
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, image, container, plan) VALUES (?, ?, ?, 41, 'stopped', 'unit7/shop:41', ?, ?)`, prevId, org.orgId, svcId, `unit7-shop-${envId.slice(-6).toLowerCase()}-41`, JSON.stringify({ port: 3000, healthPath: '/health' }));
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, image, container, plan) VALUES (?, ?, ?, 42, 'live', 'unit7/shop:42', ?, ?)`, depId, org.orgId, svcId, `unit7-shop-${envId.slice(-6).toLowerCase()}-42`, JSON.stringify({ port: 3000, healthPath: '/health' }));
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls, tls_mode) VALUES (?, ?, 'shop.example.com', ?, 'active', 'active', 'auto')`, id('dom'), org.orgId, svcId);
  const svc = () => get<ServiceRow>(app.db, 'SELECT * FROM services WHERE id = ?', svcId)!;
  const row = (sid: string) => get<ServerRow>(app.db, 'SELECT * FROM servers WHERE id = ?', sid)!;
  const ctx = (actor: Actor = org.human): Ctx => ({ app, db: app.db, orgId: org.orgId, actor, env: undefined, projectId: undefined, signal: new AbortController().signal, redactor: { add() {}, redact: (s: string) => s } as never, resources: [], secret: () => '', credentialFor: () => { throw new Error('no'); }, progress() {}, emit: (type, message, x) => app.events.emit(org.orgId, type, message, x) });
  // a fleet already in place: B joined on v42, on the private network
  const join = (mode: 'front' | 'dns' = o.mode ?? 'front') => {
    run(app.db, `INSERT INTO fleets (service_id, org_id, mode, why, edge_port) VALUES (?, ?, ?, 'test', 7001)`, svcId, org.orgId, mode);
    servers.forEach((sid, k) => {
      run(app.db, `INSERT INTO service_targets (service_id, server_id, org_id, role, state, deployment_id) VALUES (?, ?, ?, ?, 'in', ?)`, svcId, sid, org.orgId, k ? 'replica' : 'primary', depId);
      run(app.db, `INSERT INTO fleet_net (server_id, org_id, kind, address, public_key, endpoint) VALUES (?, ?, 'wireguard', ?, ?, ?)`, sid, org.orgId, `10.77.0.${k + 1}`, k ? KEY_B : KEY_A, `203.0.113.${10 + k}`);
    });
  };
  return { org, envId, servers, svcId, depId, prevId, svc, row, ctx, join };
}

// --- D0: ready for many servers ----------------------------------------------------------------------------------------------
test('readiness: each rule from the code that would break on a second server, with its fix', () => {
  const facts = (deps: Record<string, string>, traits = '') => ({ files: ['package.json'], manifests: { 'package.json': JSON.stringify({ dependencies: deps }) }, traits });
  const base = { name: 'shop', serviceId: 'svc_x', environmentId: 'env_x', serverName: 'box-a', envKeys: [], healthRoute: false, healthPath: '/health', disk: [], sameServerDbs: [], hasRedis: false, deployed: true };
  const clean = readinessChecks({ ...base, scaleRisks: scaleRisks(facts({ express: '5' })) });
  assert.equal(clean.length, 6);
  assert.ok(clean.every((c) => c.ok), 'a plain app is ready');

  const risky = readinessChecks({ ...base, scaleRisks: scaleRisks(facts({ 'express-session': '1', 'node-cron': '3', 'better-sqlite3': '9', multer: '1' }, 'multer({ dest')), sameServerDbs: ['shop-db'], healthPath: '/' });
  const by = Object.fromEntries(risky.map((c) => [c.key, c]));
  assert.equal(risky.filter((c) => c.ok).length, 0, 'every rule trips');
  assert.match(by.sessions!.detail, /signed out/);
  assert.deepEqual(by.sessions!.fix, { tool: 'database.create', input: { environmentId: 'env_x', engine: 'redis', name: 'shop-sessions', injectInto: 'svc_x' }, label: 'Add Redis' }, 'one click: Redis, wired in');
  assert.match((by.files!.fix as { ask: string }).ask, /R2/);
  assert.match(by.jobs!.detail, /UNIT7_RUN_JOBS=0/);
  assert.match(by.database!.detail, /shop-db runs on box-a/);
  assert.match((by.database!.fix as { label: string }).label, /one database/);
  // a store for sessions in the code: no risk; jobs that listen to the flag: fine
  const fixed = readinessChecks({ ...base, envKeys: ['UNIT7_RUN_JOBS'], scaleRisks: scaleRisks(facts({ 'express-session': '1', 'connect-redis': '7', 'node-cron': '3' })) });
  assert.ok(fixed.every((c) => c.ok));
  // a volume from the X-ray counts as files on the server
  assert.equal(readinessChecks({ ...base, scaleRisks: [], disk: ['shop_uploads'] }).find((c) => c.key === 'files')!.ok, false);
});

test('readiness from Unit7’s records: a database on the same server is flagged; the tool answers', async () => {
  const app = testApp();
  const w = await world(app);
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind) VALUES (?, ?, (SELECT project_id FROM services WHERE id = ?), ?, ?, 'shop-db', 'shop-db', 'postgres')`, id('svc'), w.org.orgId, w.svcId, w.envId, w.servers[0]);
  const r = fleetReadiness(app.db, w.org.orgId, w.svc());
  assert.equal(r.total, 6);
  assert.equal(r.done, 5);
  assert.equal(r.checks.find((c) => !c.ok)!.key, 'database');
  assert.equal(ok(await w.org.h('fleet.readiness', { serviceId: w.svcId })).done, 5);
});

test('adding a server: refused while not ready; skipping the checks is a person’s call, never an AI’s', async () => {
  const app = testApp();
  const w = await world(app, { risks: ['logins are kept in memory (sessions)'] });
  const r = await w.org.h('fleet.add_server', { serviceId: w.svcId, serverId: w.servers[1] });
  assert.equal(r.status, 'error');
  assert.match((r as { error: { message: string } }).error.message, /isn’t ready for a second server yet \(5 of 6\)/);
  const ai = await w.org.a('fleet.add_server', { serviceId: w.svcId, serverId: w.servers[1], skipChecks: true });
  assert.equal(ai.status, 'denied', 'an AI can’t skip the checks');
});

// --- D1: the rolling order --------------------------------------------------------------------------------------------------
function fakeRoll(failOn: string[] = [], controls: ('running' | 'paused' | 'cancelled')[] = []) {
  const calls: string[] = [], lanes: Record<string, Partial<Lane>> = {};
  let n = 0;
  const deps: RollDeps = {
    deployOn: async (sid) => { calls.push(`deploy ${sid}`); if (failOn.includes(sid)) throw new Error(`${sid} is unhealthy`); return { from: `old-${sid}` }; },
    undo: async (sid, from) => { calls.push(`undo ${sid} → ${from}`); },
    control: () => controls[n++] ?? 'running',
    wait: async () => undefined,
    lane: (sid, p) => { lanes[sid] = { ...lanes[sid], ...p }; },
  };
  return { calls, lanes, deps };
}

test('rolling: the main server first and alone, then the rest in batches', () => {
  assert.deepEqual(planBatches(['A', 'B', 'C', 'D', 'E'], 'A', 1), [['A'], ['B'], ['C'], ['D'], ['E']]);
  assert.deepEqual(planBatches(['A', 'B', 'C', 'D', 'E'], 'A', 2), [['A'], ['B', 'C'], ['D', 'E']]);
  assert.deepEqual(planBatches(['B', 'C'], 'A', 1), [['B'], ['C']], 'bringing others along: no build');
});

test('rolling: the first failure stops it, and the servers already done go back, newest first', async () => {
  const f = fakeRoll(['C']);
  const r = await roll(planBatches(['A', 'B', 'C', 'D'], 'A', 1), f.deps);
  assert.equal(r.status, 'failed');
  assert.equal(r.failed, 'C');
  assert.deepEqual(f.calls, ['deploy A', 'deploy B', 'deploy C', 'undo B → old-B', 'undo A → old-A']);
  assert.equal(f.lanes.D!.state, 'skipped', 'D never started');
  assert.equal(f.lanes.C!.state, 'failed');
  assert.equal(f.lanes.A!.state, 'undone');
  assert.deepEqual(r.undone, ['B', 'A']);
});

test('rolling: in a batch, one failure puts its neighbour back too', async () => {
  const f = fakeRoll(['C']);
  const r = await roll(planBatches(['A', 'B', 'C', 'D', 'E'], 'A', 2), f.deps);
  assert.equal(r.status, 'failed');
  assert.ok(f.calls.includes('undo B → old-B') && f.calls.includes('undo A → old-A'));
  assert.ok(!f.calls.some((c) => c.startsWith('deploy D')));
});

test('rolling: pause waits between servers; cancel rolls back everything done', async () => {
  const f = fakeRoll([], ['running', 'paused', 'paused', 'cancelled']);
  const r = await roll(planBatches(['A', 'B', 'C'], 'A', 1), f.deps);
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(f.calls, ['deploy A', 'undo A → old-A']);
  assert.equal(f.lanes.B!.state, 'skipped');
  // after a plain deploy of the main server (deployment.create on a fleet app): a failure takes the main one back too
  const g = fakeRoll(['B']);
  await roll([['B']], g.deps, [{ id: 'A', from: 'v41' }]);
  assert.deepEqual(g.calls, ['deploy B', 'undo A → v41']);
});

// --- D1: the image, server to server -------------------------------------------------------------------------------------
test('the image goes from the main server to the next through Unit7: save there, load here, checked after', async () => {
  const app = testApp();
  const w = await world(app);
  let arrived = false;
  const seen = fakeServers(app, (c) => (c.includes('docker image inspect') ? done(arrived ? 'yes' : 'no') : undefined));
  const relays: { from: string; save: string; to: string; load: string }[] = [];
  ssh(app).relay = async (from, save, to, load) => { relays.push({ from: from.name, save, to: to.name, load }); arrived = true; };
  assert.equal(IMAGE.save('unit7/shop:42'), `sh -c 'docker save "$1" | gzip -1' unit7 'unit7/shop:42'`);
  assert.equal(IMAGE.load(), `sh -c 'gunzip | docker load >/dev/null' unit7`);
  assert.equal(await sendImage(w.ctx(), w.row(w.servers[0]!), w.row(w.servers[1]!), 'unit7/shop:42'), 'copied');
  assert.deepEqual(relays, [{ from: 'box-a', save: IMAGE.save('unit7/shop:42'), to: 'box-b', load: IMAGE.load() }]);
  assert.equal(await sendImage(w.ctx(), w.row(w.servers[0]!), w.row(w.servers[1]!), 'unit7/shop:42'), 'already there', 'nothing sent twice');
  arrived = false;
  assert.equal(await sendImage(w.ctx(), w.row(w.servers[0]!), w.row(w.servers[1]!), 'nginx:1.27'), 'pulled', 'a registry image is pulled there');
  assert.ok(seen.some((x) => x.server === 'box-b' && x.command === `docker 'pull' 'nginx:1.27'`));
  // a save that failed (gzip says 0) is caught by the check afterwards
  ssh(app).relay = async () => undefined;
  await assert.rejects(sendImage(w.ctx(), w.row(w.servers[0]!), w.row(w.servers[1]!), 'unit7/shop:43'), /didn’t arrive/);
});

test('one more server: the release starts beside the old one, is checked, the edge switches, the old one stops', { timeout: 30_000 }, async () => {
  const app = testApp();
  const w = await world(app);
  w.join('front');
  run(app.db, 'UPDATE service_targets SET deployment_id = ? WHERE server_id = ?', w.prevId, w.servers[1]);
  const seen = fakeServers(app, (c) => {
    if (c.includes('docker image inspect')) return done('yes');
    if (c.includes('{{.State.Status}}')) return done('running 0 false 0');
    if (c.includes('curlimages/curl')) return done('200');
    return undefined;
  });
  const steps: string[] = [];
  const r = await copyTo(w.ctx(), w.svc(), w.row(w.servers[1]!), w.depId, (k) => steps.push(k));
  assert.equal(r.from, w.prevId);
  assert.deepEqual(steps.filter((s, i, a) => a.indexOf(s) === i), ['image', 'start', 'check', 'switch']);
  const onB = seen.filter((x) => x.server === 'box-b');
  const runAt = onB.findIndex((x) => /docker run -d --name/.test(x.command) && x.command.includes('-42'));
  const edgeAt = onB.findIndex((x) => x.command.includes('Caddyfile.next') && x.command.includes('-42:3000'));
  const stopAt = onB.findIndex((x) => /docker stop/.test(x.command) && x.command.includes('-41'));
  assert.ok(runAt >= 0 && edgeAt > runAt && stopAt > edgeAt, 'start, then switch, then stop the old one');
  assert.ok(onB.some((x) => x.stdin.includes('UNIT7_RUN_JOBS=0')), 'scheduled jobs stay on the main server');
  assert.equal(get<{ deployment_id: string }>(app.db, 'SELECT deployment_id FROM service_targets WHERE server_id = ?', w.servers[1])!.deployment_id, w.depId);
});

// --- D2: the private network -------------------------------------------------------------------------------------------------
test('WireGuard: keys are made on each server and only the public key comes back; configs carry no private key', async () => {
  const app = testApp();
  const w = await world(app);
  const keys: Record<string, string> = { 'box-a': KEY_A, 'box-b': KEY_B };
  const seen = fakeServers(app, (c, _o, s) => (c.includes('wg pubkey') ? done(keys[s.name]) : c.includes('ip -4 -o addr') ? done('eth0 203.0.113.10/24') : undefined));
  const out = await connectServers(w.ctx(), [w.row(w.servers[0]!), w.row(w.servers[1]!)]);
  assert.deepEqual([...out.values()], ['10.77.0.1', '10.77.0.2']);
  // the key file is only ever written on the server, tested for, piped into `wg pubkey`, or loaded by wg itself
  for (const x of seen) for (const m of x.command.matchAll(/.{0,24}\/etc\/wireguard\/unit7\.key.{0,2}/g)) {
    assert.match(m[0], /wg genkey > \/etc\/wireguard\/unit7\.key|-s \/etc\/wireguard\/unit7\.key|wg pubkey < \/etc\/wireguard\/unit7\.key|private-key \/etc\/wireguard\/unit7\.key/, `the private key is never read out: ${m[0]}`);
  }
  assert.ok(!seen.some((x) => /PrivateKey/.test(x.command)), 'no PrivateKey line in any config');
  const confA = seen.find((x) => x.server === 'box-a' && x.command.includes('wg0.conf'))!.command;
  assert.ok(confA.includes(`PublicKey = ${KEY_B}`) && confA.includes('AllowedIPs = 10.77.0.2/32') && confA.includes('Endpoint = 203.0.113.11:51820'));
  assert.ok(!confA.includes(KEY_A), 'a server lists only its peers');
  assert.deepEqual({ ...get<object>(app.db, 'SELECT kind, address, public_key FROM fleet_net WHERE server_id = ?', w.servers[1]) }, { kind: 'wireguard', address: '10.77.0.2', public_key: KEY_B });
  // a server answering with something that isn't a key stops it
  fakeServers(app, (c) => (c.includes('wg pubkey') ? done('-----BEGIN PRIVATE KEY-----') : undefined));
  await assert.rejects(connectServers(w.ctx(), [w.row(w.servers[0]!), w.row(w.servers[1]!)]), /WireGuard public key/);
  assert.ok(isWgKey(KEY_A) && !isWgKey('not a key'));
  assert.match(WG_KEYGEN, /wg genkey > \/etc\/wireguard\/unit7\.key/);
  assert.throws(() => wgConfig({ address: '10.77.0.1' }, [{ publicKey: 'x', address: '10.77.0.2', endpoint: '203.0.113.11' }]), /isn’t a WireGuard key/);
});

test('the firewall lets WireGuard in only from the peers, and clears its old rules first; off stays off', () => {
  const s = ufwScript([{ address: '10.77.0.2', endpoint: '203.0.113.11' }, { address: '10.77.0.3', endpoint: '203.0.113.12' }]);
  assert.match(s, /ufw status 2>\/dev\/null \| grep -q '\^Status: active' \|\| exit 0/, 'never switches a firewall on');
  assert.match(s, /awk -F'\[\]\[\]' '\/unit7-fleet\/[^\n]*ufw --force delete/, 'old peers lose their way in');
  assert.match(s, /ufw allow proto udp from 203\.0\.113\.11 to any port 51820 comment unit7-fleet/);
  assert.match(s, /ufw allow in on wg0 from 10\.77\.0\.3 comment unit7-fleet/);
  assert.ok(!/from any|0\.0\.0\.0|Anywhere/.test(s), 'nothing for everyone');
  assert.throws(() => ufwScript([{ address: '10.77.0.2', endpoint: '1.2.3.4; reboot' }]));
});

test('the provider’s own private network is used when every server is on it', async () => {
  assert.equal(providerAddress('lo 127.0.0.1/8\neth0 203.0.113.10/24\ndocker0 172.17.0.1/16\nens10 10.0.0.2/32'), '10.0.0.2');
  assert.equal(providerAddress('eth0 203.0.113.10/24\nwg0 10.77.0.1/24'), undefined);
  const app = testApp();
  const w = await world(app);
  const priv: Record<string, string> = { 'box-a': 'eth0 203.0.113.10/24\nens10 10.0.0.2/32', 'box-b': 'eth0 203.0.113.11/24\nens10 10.0.0.3/32' };
  const seen = fakeServers(app, (c, _o, s) => (c.includes('ip -4 -o addr') ? done(priv[s.name]) : c.includes('ping') ? done('ok') : undefined));
  const out = await connectServers(w.ctx(), [w.row(w.servers[0]!), w.row(w.servers[1]!)]);
  assert.deepEqual([...out.values()], ['10.0.0.2', '10.0.0.3']);
  assert.ok(!seen.some((x) => /wg genkey|wg0\.conf/.test(x.command)), 'no WireGuard when the provider network works');
});

// --- D2: the front proxy -----------------------------------------------------------------------------------------------------
test('the front proxy’s site lists the copies on the other servers, with active health checks', async () => {
  const site = renderSite({ hostname: 'shop.example.com', upstream: 'unit7-shop-abc123-42', remotes: ['10.77.0.2:7001', '10.77.0.3:7001'], port: 3000, healthPath: '/health', tls: 'auto' });
  assert.match(site, /reverse_proxy unit7-shop-abc123-42:3000 10\.77\.0\.2:7001 10\.77\.0\.3:7001 \{/);
  assert.match(site, /lb_policy least_conn/);
  assert.match(site, /health_uri \/health/);
  assert.match(site, /health_fails 3/);
  assert.throws(() => renderSite({ hostname: 'shop.example.com', upstream: 'a', remotes: ['10.77.0.2:7001 evil.example.com:80'], port: 3000, tls: 'auto' }));
  // every caller of putSite keeps the fleet: the copies come from Unit7's records
  const app = testApp();
  const w = await world(app);
  w.join('front');
  const seen = fakeServers(app);
  await putSite(app, w.row(w.servers[0]!), { hostname: 'shop.example.com', upstream: 'unit7-shop-x-42', port: 3000, healthPath: '/health', tls: 'auto' });
  assert.ok(seen.some((x) => x.command.includes('reverse_proxy unit7-shop-x-42:3000 10.77.0.2:7001')));
  // on another server (not the main one), nothing is added
  seen.length = 0;
  await putSite(app, w.row(w.servers[1]!), { hostname: 'shop.example.com', upstream: 'unit7-shop-x-42', port: 3000, tls: 'auto' });
  assert.ok(seen.some((x) => x.command.includes('reverse_proxy unit7-shop-x-42:3000 {')));
});

test('the edge on each other server: one private port per app, its containers by name', () => {
  const e = renderEdge([{ port: 7001, upstreams: ['unit7-shop-abc123-42', 'unit7-shop-abc123-42-r2'], appPort: 3000 }]);
  assert.match(e, /:7001 \{\n\treverse_proxy unit7-shop-abc123-42:3000 unit7-shop-abc123-42-r2:3000/);
  assert.match(e, /auto_https off/);
  assert.match(e, /trusted_proxies static 10\.0\.0\.0\/8/);
  assert.throws(() => renderEdge([{ port: 80, upstreams: ['a'], appPort: 3000 }]), /private ports/);
  assert.throws(() => renderEdge([{ port: 7001, upstreams: ['a; rm -rf /'], appPort: 3000 }]));
  assert.equal(inFlight('[{"address":"unit7-shop-x-42:3000","num_requests":2},{"address":"unit7-blog-y-3:3000","num_requests":5}]', ['unit7-shop-x-42']), 2);
});

// --- D2: take out, put back ---------------------------------------------------------------------------------------------------
test('take out for maintenance: the front stops sending visitors, in-flight requests finish, then it’s free; put back', async () => {
  const app = testApp();
  const w = await world(app);
  w.join('front');
  let polls = 0;
  const seen = fakeServers(app, (c) => (c.includes('reverse_proxy/upstreams') ? done(JSON.stringify([{ address: `unit7-shop-${w.envId.slice(-6).toLowerCase()}-42:3000`, num_requests: polls++ < 2 ? 3 : 0 }])) : undefined));
  fleetDeps.sleep = async () => undefined;
  const out = ok(await w.org.h('fleet.rotate', { serviceId: w.svcId, serverId: w.servers[1], out: true }));
  assert.equal(out.state, 'out');
  assert.ok(polls >= 3, 'waited until nothing was in flight');
  const site = seen.filter((x) => x.server === 'box-a' && x.command.includes('reverse_proxy')).pop()!.command;
  assert.ok(!site.includes('10.77.0.2:7001'), 'the front no longer sends it visitors');
  assert.deepEqual(out.undo, { tool: 'fleet.rotate', input: { serviceId: w.svcId, serverId: w.servers[1], out: false }, label: 'Put box-b back' });
  assert.deepEqual(shares(targetsOf(app.db, w.svc())), { [w.servers[0]!]: 100, [w.servers[1]!]: 0 });
  // the front server itself can't leave
  const front = await w.org.h('fleet.rotate', { serviceId: w.svcId, serverId: w.servers[0], out: true });
  assert.match((front as { error: { message: string } }).error.message, /front server/);
  ok(await w.org.h('fleet.rotate', { serviceId: w.svcId, serverId: w.servers[1], out: false }));
  assert.ok(seen.filter((x) => x.server === 'box-a' && x.command.includes('reverse_proxy')).pop()!.command.includes('10.77.0.2:7001'), 'back in');
});

// --- D2: DNS with health ------------------------------------------------------------------------------------------------------
function fakeDns(start: Record<string, string[]>) {
  const records = new Map(Object.entries(start).map(([k, v]) => [k, [...v]]));
  const log: string[] = [];
  const dns: DnsHost = {
    list: async (n) => [...(records.get(n) ?? [])],
    add: async (n, ip) => { log.push(`+${ip}`); records.set(n, [...(records.get(n) ?? []), ip]); },
    remove: async (n, ip) => { log.push(`-${ip}`); records.set(n, (records.get(n) ?? []).filter((x) => x !== ip)); },
  };
  return { dns, records, log };
}

test('DNS rotation touches only the fleet’s own addresses, and never removes the last one', async () => {
  const f = fakeDns({ 'shop.example.com': ['203.0.113.10', '203.0.113.11', '198.51.100.7'] });
  await dnsRotate(f.dns, ['shop.example.com'], ['203.0.113.10'], ['203.0.113.10', '203.0.113.11']);
  assert.deepEqual(f.records.get('shop.example.com'), ['203.0.113.10', '198.51.100.7'], 'a record that isn’t the fleet’s stays');
  await dnsRotate(f.dns, ['shop.example.com'], ['203.0.113.10', '203.0.113.11'], ['203.0.113.10', '203.0.113.11']);
  assert.deepEqual(f.records.get('shop.example.com'), ['203.0.113.10', '198.51.100.7', '203.0.113.11'], 'back on recovery');
  const g = fakeDns({ 'shop.example.com': ['203.0.113.10', '203.0.113.11'] });
  await dnsRotate(g.dns, ['shop.example.com'], [], ['203.0.113.10', '203.0.113.11']);
  assert.equal(g.records.get('shop.example.com')!.length, 1, 'every server sick: one record stays');
});

test('Warden takes a sick server’s record out after two failed checks, and puts it back after two good ones', async () => {
  const app = testApp();
  const w = await world(app);
  w.join('dns');
  fakeServers(app);
  const f = fakeDns({ 'shop.example.com': ['203.0.113.10', '203.0.113.11'] });
  fleetDeps.dns = async () => f.dns;
  fleetDeps.sleep = async () => undefined;
  let bSick = true;
  fleetDeps.probe = async (_c, _s, t) => !(t.serverId === w.servers[1] && bSick);
  const acts: unknown[] = [];
  const act = async (orgId: string, tool: string, input: unknown) => { acts.push(input); const { execute } = await import('../src/tools/runtime.ts'); return execute(app, orgId, WARDEN, tool, input); };
  await fleetTick(app, act);
  assert.equal(acts.length, 0, 'one bad look decides nothing');
  await fleetTick(app, act);
  assert.deepEqual(acts, [{ serviceId: w.svcId, serverId: w.servers[1], out: true }]);
  assert.deepEqual(f.records.get('shop.example.com'), ['203.0.113.10']);
  assert.equal(targetsOf(app.db, w.svc())[1]!.state, 'sick', 'health took it out, not a person');
  bSick = false;
  await fleetTick(app, act);
  await fleetTick(app, act);
  assert.deepEqual(acts.at(-1), { serviceId: w.svcId, serverId: w.servers[1], out: false });
  assert.deepEqual(f.records.get('shop.example.com'), ['203.0.113.10', '203.0.113.11']);
  // a server a person took out stays out, however healthy
  ok(await w.org.h('fleet.rotate', { serviceId: w.svcId, serverId: w.servers[1], out: true }));
  await fleetTick(app, act); await fleetTick(app, act);
  assert.equal(targetsOf(app.db, w.svc())[1]!.state, 'out');
  // with DNS the main server can leave too, but never the last one
  const last = await w.org.h('fleet.rotate', { serviceId: w.svcId, serverId: w.servers[0], out: true });
  assert.match((last as { error: { message: string } }).error.message, /only server taking visitors/);
});

// --- version drift ---------------------------------------------------------------------------------------------------------
test('version drift: who is behind the main server, in words', () => {
  const t = (serverId: string, number: number | null, primary = false) => ({ serverId, name: serverId, primary, number });
  assert.deepEqual(drift([t('a', 42, true), t('b', 42), t('c', 42)]), { same: true, main: 42, behind: [], versions: [{ number: 42, servers: ['a', 'b', 'c'] }], words: undefined });
  const d = drift([t('a', 42, true), t('b', 42), t('c', 41), t('d', null)]);
  assert.equal(d.same, false);
  assert.deepEqual(d.behind, ['c', 'd']);
  assert.equal(d.words, '2 servers on v42, 1 server on v41, 1 server on nothing yet');
});

test('fleet.get: one server reads as before; a fleet shows versions, shares and the way visitors are spread', async () => {
  const app = testApp();
  const w = await world(app, { servers: 3 });
  const single = ok(await w.org.h('fleet.get', { serviceId: w.svcId }));
  assert.equal(single.many, false);
  assert.equal(single.mode, 'single');
  assert.equal(single.candidates.length, 2);
  w.join('front');
  run(app.db, 'UPDATE service_targets SET deployment_id = ? WHERE server_id = ?', w.prevId, w.servers[2]);
  const g = ok(await w.org.h('fleet.get', { serviceId: w.svcId }));
  assert.equal(g.many, true);
  assert.deepEqual(g.servers.map((s: { version: number }) => s.version), [42, 42, 41]);
  assert.equal(g.drift.same, false);
  assert.deepEqual(g.servers.map((s: { share: number }) => s.share), [34, 33, 33]);
  const t = ok(await w.org.h('fleet.traffic', {}));
  assert.equal(t.fleets.length, 1);
  assert.match(t.fleets[0].servers[0].assetId, /^ast_/);
});

test('a rollout through the tool: box-c fails its check, so box-b goes back to v41 and the record says so', { timeout: 60_000 }, async () => {
  const app = testApp();
  const w = await world(app, { servers: 3 });
  w.join('front');
  run(app.db, 'UPDATE service_targets SET deployment_id = ? WHERE server_id != ?', w.prevId, w.servers[0]);
  const seen = fakeServers(app, (c, _o, s) => {
    if (c.includes('docker image inspect')) return done('yes');
    if (c.includes('{{.State.Status}}')) return done(s.name === 'box-c' ? 'exited 1 false 0' : 'running 0 false 0');
    if (c.includes('curlimages/curl')) return done('200');
    return undefined;
  });
  const r = await w.org.h('fleet.deploy', { serviceId: w.svcId, servers: [w.servers[1], w.servers[2]] });
  assert.equal(r.status, 'error');
  assert.match((r as { error: { message: string } }).error.message, /stopped at box-c.*put the 1 server already done back on the version before/s);
  const ts = targetsOf(app.db, w.svc());
  assert.deepEqual(ts.map((t) => t.number), [42, 41, 41], 'nobody is left half on the new version');
  assert.ok(seen.some((x) => x.server === 'box-b' && x.command.includes(`docker 'start'`) && x.command.includes('-41')), 'box-b started its old version again');
  const g = ok(await w.org.h('fleet.get', { serviceId: w.svcId }));
  assert.equal(g.run.status, 'failed');
  assert.deepEqual(g.run.lanes.map((l: { state: string }) => l.state), ['undone', 'failed']);
  // nothing is rolling now, so a new rollout may start; control says so
  const c = await w.org.h('fleet.control', { serviceId: w.svcId, action: 'pause' });
  assert.match((c as { error: { message: string } }).error.message, /Nothing is rolling out/);
});
