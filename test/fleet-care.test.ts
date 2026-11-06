// D4 fleet care and D5 regions, proven with fakes: settings drift (fingerprints made on each server) and bringing a
// server back onto the current settings out of rotation; restarts one server at a time, each out of rotation first, and
// Warden waiting while a server is the last one serving; a server bought only by a person (Hetzner's API stood in for);
// certificates; and the region strip's numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { ssh, type ExecOptions, type ServerRow } from '../src/connectors/ssh.ts';
import { buyDeps, certPlan, copyCerts, envDrift, envPrint, pickPlans, restartWouldDown, wantEnv } from '../src/fleet/care.ts';
import { countriesFromHits, regionView, READ_COPIES } from '../src/fleet/regions.ts';
import { fleetDeps } from '../src/fleet/traffic.ts';
import { rebootDeps, restarting } from '../src/tools/reboot.ts';
import { parseHit } from '../src/sentinel/traffic.ts';
import type { App } from '../src/app.ts';
import { decideApproval, type Ctx } from '../src/tools/runtime.ts';
import type { ServiceRow } from '../src/deploy/deployer.ts';

const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
fleetDeps.sleep = async () => undefined;
const KEY_A = 'uL0F0q3n4lJ8mAX3bqK2HcD0fY7tQ1wRzS5vN9eP2kM=', KEY_B = 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3a4bE=';

async function fleet(app: App) {
  const o = await testOrg(app);
  const proj = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] }));
  const envId = proj.environments[0].id as string;
  const servers = ['box-a', 'box-b'].map((name, k) => {
    const sid = id('srv');
    run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, ?, ?, 'root', 'credential://ssh/box/private-key', 'ready', ?)`, sid, o.orgId, name, `203.0.113.${10 + k}`, JSON.stringify({ web: 'unit7-caddy|caddy:2', cpus: 2, mem_total: 4 * 1024 ** 3, arch: 'x86_64' }));
    return sid;
  }) as [string, string];
  const svcId = id('svc'), depId = id('dep');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status, current_deployment_id) VALUES (?, ?, ?, ?, ?, 'shop', 'shop', 'app', ?, 'healthy', ?)`,
    svcId, o.orgId, proj.projectId ?? proj.id, envId, servers[0], JSON.stringify({ port: 3000, healthPath: '/health' }), depId);
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, image, container, plan) VALUES (?, ?, ?, 42, 'live', 'unit7/shop:42', ?, ?)`, depId, o.orgId, svcId, `unit7-shop-${envId.slice(-6).toLowerCase()}-42`, JSON.stringify({ port: 3000, healthPath: '/health' }));
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls, tls_mode) VALUES (?, ?, 'shop.example.com', ?, 'active', 'active', 'auto')`, id('dom'), o.orgId, svcId);
  run(app.db, `INSERT INTO fleets (service_id, org_id, mode, why, edge_port) VALUES (?, ?, 'front', 'test', 7001)`, svcId, o.orgId);
  servers.forEach((sid, k) => {
    run(app.db, `INSERT INTO service_targets (service_id, server_id, org_id, role, state, deployment_id) VALUES (?, ?, ?, ?, 'in', ?)`, svcId, sid, o.orgId, k ? 'replica' : 'primary', depId);
    run(app.db, `INSERT INTO fleet_net (server_id, org_id, kind, address, public_key, endpoint) VALUES (?, ?, 'wireguard', ?, ?, ?)`, sid, o.orgId, `10.77.0.${k + 1}`, k ? KEY_B : KEY_A, `203.0.113.${10 + k}`);
  });
  const svc = () => get<ServiceRow>(app.db, 'SELECT * FROM services WHERE id = ?', svcId)!;
  const ctx = (): Ctx => ({ app, db: app.db, orgId: o.orgId, actor: o.human, env: undefined, projectId: undefined, signal: new AbortController().signal, redactor: { add() {}, redact: (s: string) => s } as never, resources: [], secret: () => '', credentialFor: () => { throw new Error('no'); }, progress() {}, emit: (type, message, x) => app.events.emit(o.orgId, type, message, x) });
  return { o, envId, servers, svcId, depId, svc, ctx };
}
function fakeServers(app: App, reply: (c: string, s: ServerRow, o: ExecOptions) => ReturnType<typeof done> | undefined = () => undefined) {
  const seen: { server: string; command: string; stdin: string }[] = [];
  ssh(app).exec = async (s, command, o = {}) => {
    seen.push({ server: s.name, command, stdin: String(o.stdin ?? '') });
    return reply(command, s, o) ?? (command.includes(`'inspect'`) && command.includes('OOMKilled') ? done('running 0 false 0') : command.includes('curlimages/curl') ? done('200') : done());
  };
  return seen;
}

// --- settings drift ----------------------------------------------------------------------------------------------------
test('settings drift: a fingerprint of sorted lines, so order never counts; a server Unit7 can’t read is unknown, never “same”', () => {
  assert.equal(envPrint({ A: '1', B: '2' }), envPrint({ B: '2', A: '1' }));
  assert.notEqual(envPrint({ A: '1' }), envPrint({ A: '2' }));
  const w = envPrint({ A: '1' });
  assert.deepEqual(envDrift([{ serverId: 'a', name: 'box-a', want: w, have: w }, { serverId: 'b', name: 'box-b', want: w, have: w }]).same, true);
  const d = envDrift([{ serverId: 'a', name: 'box-a', want: w, have: w }, { serverId: 'b', name: 'box-b', want: w, have: envPrint({ A: '0' }) }, { serverId: 'c', name: 'box-c', want: w, have: null }]);
  assert.deepEqual([d.same, d.differs, d.unknown], [false, ['b'], ['c']]);
  assert.equal(d.words, 'box-b runs with older settings');
});

test('drift on real files: worked out on each server; bringing one back takes it out, restarts its copies with the current settings, checks, puts it back', { timeout: 60_000 }, async () => {
  const app = testApp();
  const w = await fleet(app);
  const want = (k: number) => envPrint(wantEnv(w.ctx(), w.svc(), { primary: k === 0, deploymentId: w.depId }));
  let bCurrent = false;
  const seen = fakeServers(app, (c, s) => {
    if (c.includes('LC_ALL=C sort')) return done(s.name === 'box-a' || bCurrent ? want(s.name === 'box-a' ? 0 : 1) : envPrint({ PORT: '3000', UNIT7_RUN_JOBS: '0', OLD: 'yes' }));
    if (c.includes('reverse_proxy/upstreams')) return done('[]');
    return undefined;
  });
  assert.ok(seen.length === 0);
  const care = ok(await w.o.h('fleet.care', { serviceId: w.svcId }));
  assert.equal(care.settings.same, false);
  assert.deepEqual(care.settings.differs, [w.servers[1]]);
  assert.equal(care.settings.words, 'box-b runs with older settings');
  assert.ok(!seen.some((x) => x.command.includes('cat "$f"') && !x.command.includes('sha256sum')), 'only the fingerprint comes back, never the file');
  assert.equal(care.certs.how, 'front', 'with a front proxy the one certificate covers every server');
  seen.length = 0;
  const r = ok(await w.o.h('fleet.sync_settings', { serviceId: w.svcId }));
  bCurrent = true;
  assert.deepEqual(r, { via: 'restart', servers: ['box-b'] });
  const i = (f: (x: { server: string; command: string; stdin: string }) => boolean) => seen.findIndex(f);
  const out = i((x) => x.server === 'box-a' && x.command.includes('reverse_proxy') && !x.command.includes('10.77.0.2:7001'));
  const restart = i((x) => x.server === 'box-b' && x.command.includes('docker run -d') && x.command.includes('-42'));
  const back = seen.findLastIndex((x) => x.server === 'box-a' && x.command.includes('reverse_proxy') && x.command.includes('10.77.0.2:7001'));
  assert.ok(out >= 0 && out < restart && restart < back, 'out of rotation, restarted, back in');
  assert.ok(seen.some((x) => x.server === 'box-b' && x.stdin.includes('UNIT7_RUN_JOBS=0')), 'with the settings written fresh');
  assert.equal(ok(await w.o.h('fleet.care', { serviceId: w.svcId })).settings.same, true);
});

// --- restarts, one server at a time ---------------------------------------------------------------------------------------
const BOOT_A = '0b5e6c1e-1f6e-4a63-9a64-3f2b3a3e9d10', BOOT_B = '7d2f1a44-0c3e-4b7a-8a51-2e9f6b1c0d22';
test('OS restarts: one server at a time, each out of rotation first and back after; Warden waits while a server is the last one serving', { timeout: 60_000 }, async () => {
  const app = testApp();
  const w = await fleet(app);
  let rebooted = false, downChecks = 0;
  const seen = fakeServers(app, (c) => {
    if (c.includes('reboot-required')) return done(`reboot=yes\noffset=+0000\nboot=${rebooted ? BOOT_B : BOOT_A}`);
    if (c.includes('systemctl reboot')) { rebooted = true; return done('ok'); }
    if (c.includes('reverse_proxy/upstreams')) return done('[]');
    return undefined;
  });
  Object.assign(rebootDeps, {
    pollMs: 1, downMs: 50, upMs: 200, sitesMs: 50, sleep: async () => undefined,
    listening: async () => (!rebooted ? true : downChecks++ >= 1),
    probe: async () => ({ ok: true, ms: 1 }),
  });
  // another server of the organisation restarting right now: this one waits its turn
  restarting.add(w.o.orgId);
  const second = await w.o.h('server.reboot', { serverId: w.servers[1] });
  assert.match((second as any).error.message, /One at a time/, 'one server restarts at a time');
  restarting.delete(w.o.orgId);
  const r = ok(await w.o.h('server.reboot', { serverId: w.servers[1] }));
  assert.equal(r.restarted, true);
  const i = (f: (x: { server: string; command: string }) => boolean) => seen.findIndex(f);
  const out = i((x) => x.server === 'box-a' && x.command.includes('reverse_proxy') && !x.command.includes('10.77.0.2:7001'));
  const boot = i((x) => x.command.includes('systemctl reboot'));
  const back = seen.findLastIndex((x) => x.server === 'box-a' && x.command.includes('reverse_proxy') && x.command.includes('10.77.0.2:7001'));
  assert.ok(out >= 0 && out < boot && boot < back, 'out of rotation before the restart, back after');
  assert.equal(get<any>(app.db, 'SELECT state FROM service_targets WHERE server_id = ?', w.servers[1]).state, 'in');
  // box-b sick: box-a is the last one serving shop, so a scheduled restart of it waits
  assert.deepEqual(restartWouldDown(app.db, w.servers[0]), []);
  run(app.db, `UPDATE service_targets SET health = 'bad' WHERE server_id = ?`, w.servers[1]);
  assert.deepEqual(restartWouldDown(app.db, w.servers[0]), ['shop']);
  assert.deepEqual(restartWouldDown(app.db, w.servers[1]), [], 'the sick one may restart: the other serves');
});

// --- buying a server ---------------------------------------------------------------------------------------------------
function fakeHetzner() {
  const seen: { method: string; path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = req.url!.replace(/^\/hz/, '').split('?')[0]!;
    seen.push({ method: req.method!, path, body });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== 'Bearer hz-test-token') return send(401, { error: { message: 'unauthorized' } });
    if (req.method === 'GET' && path === '/server_types') return send(200, { server_types: [
      { name: 'cx22', cores: 2, memory: 4, disk: 40, architecture: 'x86', prices: [{ location: 'nbg1', price_monthly: { gross: '4.5900' } }] },
      { name: 'cx32', cores: 4, memory: 8, disk: 80, architecture: 'x86', prices: [{ location: 'nbg1', price_monthly: { gross: '7.9900' } }] },
      { name: 'cax11', cores: 2, memory: 4, disk: 40, architecture: 'arm', prices: [{ location: 'nbg1', price_monthly: { gross: '3.9900' } }] },
      { name: 'cx11', cores: 1, memory: 2, disk: 20, architecture: 'x86', prices: [{ location: 'nbg1', price_monthly: { gross: '3.2900' } }] },
    ], meta: {} });
    if (req.method === 'GET' && path === '/locations') return send(200, { locations: [{ name: 'nbg1', city: 'Nuremberg', country: 'DE' }] });
    if (req.method === 'POST' && path === '/ssh_keys') return send(201, { ssh_key: { id: 9 } });
    if (req.method === 'POST' && path === '/servers') return send(201, { server: { id: 77, public_net: { ipv4: { ip: '127.0.0.1' } } } });
    if (req.method === 'GET' && path === '/servers/77') return send(200, { server: { id: 77, status: 'running', public_net: { ipv4: { ip: '127.0.0.1' } } } });
    send(404, { error: { message: 'not found' } });
  });
  return new Promise<{ base: string; seen: typeof seen; close: () => void }>((r) => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() })));
}

test('buying a server: offers sized like the main server; the purchase is a person’s own (an AI is refused outright); Unit7’s key goes in at creation', { timeout: 90_000 }, async () => {
  assert.deepEqual(pickPlans([{ cores: 1, memoryGb: 2, monthly: 3 }, { cores: 2, memoryGb: 4, monthly: 5 }, { cores: 2, memoryGb: 4, monthly: 4, arch: 'arm' }, { cores: 4, memoryGb: 8, monthly: 8 }], { cores: 2, memoryGb: 3.8, arch: 'x86' }).map((p) => p.monthly), [5, 8]);
  const api = await fakeHetzner();
  process.env.UNIT7_HETZNER_API = `${api.base}/hz`;
  try {
    const app = testApp();
    const w = await fleet(app);
    const acc = id('acc');
    run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, status, meta) VALUES (?, ?, 'hetzner', 'Hetzner', 'hz', 'verified', ?)`, acc, w.o.orgId, JSON.stringify({ ref: 'credential://hetzner/hz/token' }));
    app.vault.put(w.o.orgId, 'credential://hetzner/hz/token', 'hz-test-token', { kind: 'api_token', by: 'test', accountId: acc } as never);
    fakeServers(app);
    const offers = ok(await w.o.h('fleet.server_offers', { serviceId: w.svcId }));
    assert.deepEqual(offers.offers.map((x: any) => [x.plan, x.monthly, x.where]), [['cx22', 4.59, 'Nuremberg, DE'], ['cx32', 7.99, 'Nuremberg, DE']], 'big enough, same processor, cheapest first');
    const before = api.seen.length;
    const ai = await w.o.a('fleet.buy_server', { serviceId: w.svcId, provider: 'hetzner', accountId: acc, plan: 'cx22', location: 'nbg1' });
    assert.equal(ai.status, 'denied', 'an AI never buys, not even with an approval');
    assert.equal(api.seen.length, before, 'Hetzner never heard of it');
    buyDeps.listening = async () => true;
    buyDeps.sleep = async () => undefined;
    // a person's purchase in production is restricted: it waits for their explicit OK (the Approvals card), then runs
    const asked = await w.o.h('fleet.buy_server', { serviceId: w.svcId, provider: 'hetzner', accountId: acc, plan: 'cx22', location: 'nbg1' });
    assert.equal(asked.status, 'approval_required');
    assert.ok(!api.seen.some((x) => x.method === 'POST'), 'nothing bought before the OK');
    const r = ok(await decideApproval(app, w.o.orgId, w.o.human, (asked as { approvalId: string }).approvalId, true, 'shop') as never); // hard to undo: the person types the app's name
    assert.equal(r.bought, 'shop-3');
    const key = api.seen.find((x) => x.path === '/ssh_keys')!.body;
    assert.match(key.public_key, /^ssh-ed25519 /);
    assert.deepEqual(api.seen.find((x) => x.path === '/servers' && x.method === 'POST')!.body, { name: 'shop-3', server_type: 'cx22', image: 'ubuntu-24.04', location: 'nbg1', ssh_keys: [9], labels: { 'managed-by': 'unit7' }, start_after_create: true });
    const srv = get<any>(app.db, `SELECT * FROM servers WHERE provider_ref = 'hetzner:server:77'`);
    assert.equal(srv.host, '127.0.0.1');
    assert.ok(app.vault.list(w.o.orgId, srv.key_ref).length === 1, 'its private key is in the vault');
    assert.equal(get<any>(app.db, `SELECT action FROM audit WHERE tool = 'fleet.buy_server' AND actor_kind = 'user'`).action, 'provider_purchase');
  } finally { api.close(); delete process.env.UNIT7_HETZNER_API; }
});

// --- certificates ----------------------------------------------------------------------------------------------------------
test('certificates: the front server’s covers all; with DNS (or a standby) Unit7 copies the main one’s, through its own connection', async () => {
  assert.equal(certPlan({ mode: 'front', cloudflare: false, dnsPlugin: false }).how, 'front');
  assert.equal(certPlan({ mode: 'dns', cloudflare: true, dnsPlugin: true }).how, 'dns-check');
  const copy = certPlan({ mode: 'dns', cloudflare: false, dnsPlugin: false });
  assert.equal(copy.how, 'copy');
  assert.match(copy.words, /Connecting Cloudflare \(free\) lets every server prove the name itself/);
  assert.equal(certPlan({ mode: 'single', cloudflare: false, dnsPlugin: false, standby: true }).how, 'copy');
  const app = testApp();
  const w = await fleet(app);
  const seen = fakeServers(app, (c) => (c.includes('for d in */"$h"') ? done('acme-v02.api.letsencrypt.org-directory/shop.example.com\n../../etc/passwd\n') : undefined));
  const relays: string[] = [];
  ssh(app).relay = async (from, a, to, b) => { relays.push(`${from.name} ${a} -> ${to.name} ${b}`); };
  const row = (sid: string) => get<ServerRow>(app.db, 'SELECT * FROM servers WHERE id = ?', sid)!;
  assert.deepEqual(await copyCerts(w.ctx(), row(w.servers[0]), row(w.servers[1]), ['shop.example.com', 'bad name; rm -rf /']), { copied: 1 });
  assert.equal(relays.length, 1);
  assert.ok(relays[0]!.includes(`'acme-v02.api.letsencrypt.org-directory/shop.example.com'`) && !relays[0]!.includes('passwd'), 'only real certificate folders travel');
  assert.ok(seen.some((x) => x.server === 'box-b' && x.command.includes('caddy reload') && x.command.includes('--force')), 'the proxy there picks it up');
});

// --- regions -----------------------------------------------------------------------------------------------------------------
test('regions: countries from Cloudflare’s header in the log, servers by region with their share and speed, read copies as guidance', () => {
  const line = (country?: string) => JSON.stringify({ msg: 'handled request', ts: 1, status: 200, duration: 0.05, request: { client_ip: '198.51.100.7', method: 'GET', host: 'shop.example.com', uri: '/', headers: { 'User-Agent': ['Mozilla/5.0'], ...(country && { 'Cf-Ipcountry': [country] }) } } });
  assert.equal(countriesFromHits([parseHit(line())!]), null, 'no Cloudflare in front: unknown, not zero');
  const hits = [...Array(6)].map(() => parseHit(line('DE'))!).concat([...Array(3)].map(() => parseHit(line('US'))!), [parseHit(line('IN'))!, parseHit(line('XX'))!]);
  const c = countriesFromHits(hits)!;
  assert.deepEqual(c.map((x) => [x.code, x.requests]), [['DE', 6], ['US', 3], ['IN', 1]]);
  assert.equal(c[0]!.name, 'Germany');
  const v = regionView([
    { serverId: 'a', name: 'box-a', region: 'Frankfurt', share: 50, p95: 120, requests: 900, state: 'in', primary: true, role: 'primary' },
    { serverId: 'b', name: 'box-b', region: 'Virginia', share: 30, p95: 340, requests: 500, state: 'in', primary: false, role: 'replica' },
    { serverId: 'c', name: 'box-c', region: 'Frankfurt', share: 20, p95: 180, requests: 300, state: 'in', primary: false, role: 'replica' },
  ], c, 'traffic');
  assert.deepEqual(v.regions.map((r) => [r.region, r.share, r.p95, r.servers.length]), [['Frankfurt', 70, 180, 2], ['Virginia', 30, 340, 1]]);
  assert.deepEqual(v.countries.map((x) => x.pct), [60, 30, 10]);
  assert.equal(v.words, 'Most visitors come from Germany (60%), then United States (30%).');
  assert.match(regionView([], null, 'unknown').words, /doesn’t know where visitors come from yet/);
  assert.deepEqual(READ_COPIES.map((r) => r.name), ['Neon', 'Supabase', 'Amazon RDS']);
  assert.match(v.readCopyNote, /doesn’t set up read copies yet/);
});
