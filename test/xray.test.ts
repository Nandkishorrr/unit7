// The server X-ray: captured probe output from made-up servers becomes projects → parts with an owner and a
// trust level; usage rolls up per project with a cost split; the map draws projects as frames; every run is
// stored and a failed one hands back the last good one; Unit7 refuses to change Coolify's containers itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import {
  buildInventory, fingerprint, parseSentinel, parseDockerStats, rollup, parseSizes, sizeTargets, ownerOf, scheduleInWords, xrayFound, XRAY_PROBE, USAGE_PROBE, SIZES_PROBE,
  type Inventory,
} from '../src/discovery/xray.ts';
import { mergeFound, resolve, type Found } from '../src/discovery/model.ts';
import { lastXray, saveXray } from '../src/tools/xray.ts';
import { COOLIFY_HOST, COMPOSE_HOST, PM2_HOST, COOLIFY_CONTAINERS, ctr, probe } from './xray-fixtures.ts';

const part = (inv: Inventory, id: string) => inv.parts.find((p) => p.id === id)!;
const names = (inv: Inventory, projectId: string) => inv.projects.find((p) => p.id === projectId)!.parts.map((id) => part(inv, id)).filter((p) => p.kind !== 'volume').map((p) => p.name).sort();
const SECRETS = /r3layDBpass|sup3rs3cretdbpass|jwts3cret|s3ntinelt0ken|c0mposepw|pm2s3cret|sk_live_|eyJhbGciOiJIUzI1NiJ9/;

test('a Coolify server: 4 projects with both label generations, Supabase as one part each, Coolify itself apart', () => {
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
  const own = inv.projects.filter((p) => !p.system);
  assert.deepEqual(own.map((p) => p.name), ['crm', 'ledger', 'relay', 'shop']);
  assert.ok(own.every((p) => p.owner === 'coolify' && p.trust === 'understood' && p.how === 'Coolify labels' && p.environments?.[0] === 'production'));

  // three Supabase stacks of 13 containers each, collapsed; new labels (shop, ledger) and old numeric ones (crm)
  const supa = inv.parts.filter((p) => p.product?.id === 'supabase');
  assert.deepEqual(supa.map((p) => [p.id, p.name, p.containers!.length, p.coolify!.labels]).sort(), [
    ['coolify:crmsupa01', 'crm-supabase', 13, 'legacy'], ['coolify:ledgsupa01', 'ledger-supabase', 13, 'uuid'], ['coolify:shopsupa01', 'shop-supabase', 13, 'uuid']]);
  assert.ok(supa.every((p) => p.kind === 'database' && p.engine === 'postgres' && p.version === '15.8' && p.internals!.length === 13));
  assert.deepEqual(names(inv, 'coolify:shop'), ['api.shop.example.com', 'shop-supabase', 'shop-web', 'shop.example.com']);

  // relay's Postgres: old labels, keyed by its compose project (the resource uuid), and open to the internet
  const db = part(inv, 'coolify:relaydb01');
  assert.equal(db.kind, 'database');
  assert.equal(db.engine, 'postgres');
  assert.equal(db.version, '16');
  assert.equal(db.exposed, true, 'Docker-published 0.0.0.0:5432 skips the firewall');
  assert.equal(db.coolify!.labels, 'legacy');
  assert.equal(part(inv, 'coolify:shopapp01').coolify!.labels, 'legacy');
  assert.equal(part(inv, 'coolify:relayweb01').coolify!.labels, 'uuid');
  assert.deepEqual(part(inv, 'coolify:relayweb01').uses, ['coolify:relaydb01'], 'its DATABASE_URL names the database container');
  assert.deepEqual(part(inv, 'coolify:shopapp01').hosts, ['shop.example.com'], 'domains from its Traefik labels');
  assert.equal(part(inv, 'd:shop.example.com').target, 'coolify:shopapp01');

  // Coolify's own containers, proxy included, are "Coolify itself"
  const sys = inv.projects.find((p) => p.system)!;
  assert.equal(sys.name, 'Coolify itself');
  assert.deepEqual(names(inv, sys.id), ['coolify', 'coolify-db', 'coolify-proxy', 'coolify-realtime', 'coolify-redis', 'coolify-sentinel']);
  assert.ok(sys.parts.map((x) => part(inv, x)).every((p) => p.kind === 'service' || p.kind === 'volume'), 'Coolify’s own Postgres is not one of your databases');

  // health in words; a cron job lands in the project whose container it uses; leftovers apart
  assert.deepEqual(part(inv, 'coolify:crmapp01').health, { status: 'warn', reason: 'crm-web ran out of memory and restarted 3 times' });
  const job = inv.parts.find((p) => p.kind === 'job')!;
  assert.equal(job.project, 'coolify:relay');
  assert.equal(job.when, 'every day at 03:00');
  assert.ok(!inv.parts.some((p) => p.file?.includes('e2scrub')), 'distribution cron jobs are left out');
  assert.deepEqual(inv.loose.sort(), ['c:old-test', 'v:orphan-data']);
  assert.equal(part(inv, 'v:orphan-data').health?.reason, 'nothing uses it');

  assert.deepEqual(inv.coolify, { version: '4.4.0', dashboard: 'https://coolify.example.com', apiPort: 8000, sentinel: true, proxy: true });
  assert.deepEqual(inv.paas, [{ id: 'coolify', name: 'Coolify' }]);
  assert.equal(inv.disk?.reclaimable, 5_000_000_000, 'unused images (their own layers) plus build cache');
  assert.match(inv.summary, /^Runs 4 projects \(3 with their own Supabase\), 1 database and 5 domains, run by Coolify\./);
  assert.match(inv.summary, /relay-db is open to the internet/);
  assert.doesNotMatch(JSON.stringify(inv), SECRETS, 'setting values never leave the parser');
  assert.ok(part(inv, 'coolify:relayweb01').envKeys!.includes('DATABASE_URL') && !part(inv, 'coolify:relayweb01').envKeys!.includes('COOLIFY_FQDN'));

  // once Coolify is connected with a deploy-capable token, its things are managed through it
  const managed = buildInventory(COOLIFY_HOST, { coolify: { accountId: 'acc_x', managed: true, abilities: ['read', 'deploy'] } });
  assert.ok(managed.projects.filter((p) => p.owner === 'coolify').every((p) => p.trust === 'managed'));
  assert.equal(managed.coolify?.connected, 'acc_x');
});

test('who runs a container: both Coolify label generations, compose, Dokku, Kamal, Unit7, nothing', () => {
  const c = (labels: Record<string, string>, name = 'x', image = 'img') => ownerOf({ name, image, labels });
  assert.deepEqual([c({ 'coolify.managed': 'true', 'coolify.type': 'application', 'coolify.applicationUuid': 'u1' }).part, c({ 'coolify.managed': 'true', 'coolify.type': 'application', 'coolify.applicationId': '4', 'com.docker.compose.project': 'u1' }).part], ['coolify:u1', 'coolify:u1']);
  assert.equal(c({ 'coolify.managed': 'true', 'coolify.type': 'database', 'coolify.databaseId': '2', 'com.docker.compose.project': 'db9' }).coolify?.labels, 'legacy');
  assert.equal(c({ 'coolify.managed': 'true', 'coolify.type': 'application', 'coolify.applicationUuid': 'u1', 'coolify.pullRequestId': '12' }).coolify?.preview, 12);
  assert.equal(c({}, 'coolify-proxy').group, 'coolify:system');
  assert.equal(c({ 'com.dokku.app-name': 'blog' }).owner, 'dokku');
  assert.equal(ownerOf({ name: 'web-1', image: 'x', labels: { service: 'blog', role: 'web', destination: 'production' } }, new Set(['kamal'])).group, 'kamal:blog-production');
  assert.equal(c({ 'unit7.service': 'svc_abc' }).owner, 'unit7');
  assert.equal(c({ 'com.docker.compose.project': 'p' }).owner, 'compose');
  assert.equal(c({}).owner, 'unmanaged');
  assert.equal(scheduleInWords('*/15 * * * *'), 'every 15 minutes');
  assert.equal(scheduleInWords('30 2 * * 1'), 'every Monday at 02:30');
});

test('health in words: stopped is not broken; a crash, a memory kill and a failing check are', () => {
  const inv = buildInventory(probe({ host: 'cpus=2', ctrs: JSON.stringify([
    ctr({ name: 'stopped', image: 'app:1', state: 'exited', exit: 137, health: 'unhealthy' }), // docker stop, with a stale health status
    ctr({ name: 'oom', image: 'app:1', state: 'exited', exit: 137, oom: true }),
    ctr({ name: 'gave-up', image: 'app:1', state: 'exited', exit: 1, policy: 'on-failure' }),
    ctr({ name: 'sick', image: 'app:1', health: 'unhealthy' }),
    ctr({ name: 'looping', image: 'app:1', state: 'restarting', restarts: 40 }),
  ]) }));
  const h = (n: string) => part(inv, `c:${n}`).health;
  assert.deepEqual(h('stopped'), { status: 'off', reason: 'stopped' });
  assert.deepEqual(h('oom'), { status: 'bad', reason: 'oom ran out of memory and stopped' });
  assert.deepEqual(h('gave-up'), { status: 'bad', reason: 'gave-up crashed and stopped (exit code 1)' });
  assert.deepEqual(h('sick'), { status: 'bad', reason: 'sick fails its health check' });
  assert.deepEqual(h('looping'), { status: 'bad', reason: 'looping keeps restarting' });
});

test('a Docker Compose server: the app with its database and cache, nginx in front, a git checkout, self-hosted Supabase as one', () => {
  const inv = buildInventory(COMPOSE_HOST);
  assert.deepEqual(inv.projects.filter((p) => !p.system).map((p) => [p.name, p.owner, p.how]), [['shop', 'compose', 'Docker Compose labels'], ['supabase', 'compose', 'Docker Compose labels']]);
  assert.deepEqual(names(inv, 'compose:shop'), ['db', 'redis', 'shop.example.com', 'web', 'www.shop.example.com']);
  const web = part(inv, 'c:shop-web-1');
  assert.deepEqual(web.uses?.sort(), ['c:shop-db-1', 'c:shop-redis-1'], 'its settings name db and redis on its own network');
  assert.equal(part(inv, 'd:shop.example.com').via, 'nginx on the server', 'nginx → upstream → 127.0.0.1:3000 → the container that publishes it');
  assert.equal(part(inv, 'c:shop-db-1').exposed, false);
  assert.equal(inv.projects.find((p) => p.id === 'compose:shop')!.git?.dirty, 3, '3 files edited directly on the server');
  const supa = inv.parts.filter((p) => p.product?.id === 'supabase');
  assert.equal(supa.length, 1);
  assert.equal(supa[0]!.name, 'Supabase');
  assert.equal(supa[0]!.containers!.length, 5);
  assert.equal(supa[0]!.exposed, false, 'only its gateway is published, not the database');
  assert.equal(inv.projects.find((p) => p.system)!.name, 'Web server');
  assert.deepEqual(inv.disk, { method: 'docker-cli', images: 3_200_000_000, imagesUnused: 1_100_000_000, buildCache: 800_000_000, reclaimable: 1_900_000_000 });
  assert.doesNotMatch(JSON.stringify(inv), SECRETS);
});

test('a PM2 server: the app, its worker, the host Postgres it uses and a cron job are one project; a stray program is a leftover', () => {
  const inv = buildInventory(PM2_HOST);
  const api = inv.projects.find((p) => p.name === 'api')!;
  assert.equal(api.owner, 'pm2');
  assert.equal(api.how, 'the same folder');
  assert.deepEqual(names(inv, api.id), ['api', 'api.example.com', 'cd /var/www/api &&', 'postgresql@16-main', 'worker']);
  assert.deepEqual(part(inv, 'pm2:api').uses, ['unit:postgresql@16-main.service'], 'localhost:5432 is the host Postgres');
  assert.equal(part(inv, 'pm2:api').pm2?.instances, 2);
  assert.equal(part(inv, 'd:api.example.com').target, 'pm2:api', 'Caddy → localhost:3000 → the process in its folder');
  assert.equal(part(inv, 'unit:worker.service').owner, 'systemd');
  assert.ok(!inv.parts.some((p) => p.id === 'unit:cron.service'), 'distribution services are left out');
  assert.deepEqual(inv.loose, ['p:python3:8888']);
  assert.equal(part(inv, 'p:python3:8888').name, 'python3 on port 8888');
  assert.equal(part(inv, 'p:python3:8888').trust, 'seen');
  assert.doesNotMatch(JSON.stringify(inv), SECRETS);
});

const host = { cpus: 4, cpu: 30, memTotal: 16_000_000_000, memUsed: 7_000_000_000, diskTotal: 200_000_000_000, diskUsed: 59_000_000_000 };
test('usage from Coolify’s monitor, rolled up per project, with the server itself, free room and a cost split', () => {
  const inv = buildInventory(COOLIFY_HOST);
  // Sentinel 1.0.2 /api/containers/current: CPU percent as a string, keyed by container name or coolify.name
  const sentinel = JSON.stringify([
    { id: 'shopapp01-101530000002', cpu: { percent: '40.0' }, memory: { used: 1_000_000_000 }, network: { rxBytesPerSec: 1000, txBytesPerSec: 2000 } },
    { id: 'supabase-db-shopsupa01', cpu: { percent: '20.0' }, memory: { used: 1_400_000_000 }, network: { rxBytesPerSec: 10, txBytesPerSec: 20 } },
    { id: 'relayweb01', cpu: { percent: '8' }, memory: { used: 500_000_000 } },
    { id: 'coolify-proxy', cpu: { percent: '4' }, memory: { used: 100_000_000 } },
  ]);
  const u = rollup(inv, host, parseSentinel(sentinel), 'sentinel', { price: { monthly: 20, currency: 'USD', source: 'you' } });
  const shop = u.projects.find((p) => p.name === 'shop')!;
  assert.equal(shop.mem, 2_400_000_000);
  assert.equal(shop.cpu, 15, '60% of one core on a 4-core server');
  assert.equal(shop.rx, 1010);
  assert.equal(u.projects.find((p) => p.name === 'relay')!.mem, 500_000_000, 'matched by its coolify.name');
  assert.equal(u.projects.find((p) => p.name === 'Coolify itself')!.system, true);
  assert.equal(u.system.mem, 7_000_000_000 - 3_000_000_000, 'the rest of what’s used is the server itself');
  assert.equal(u.free.mem, 9_000_000_000);
  const shares = [...u.projects, u.loose, u.system].reduce((s, x) => s + (x.cost ?? 0), 0);
  assert.ok(Math.abs(shares + u.free.cost! - 20) < 0.05, 'project costs plus free room make the price');
  assert.equal(shop.cost, Math.round(20 * (0.5 * 2.4 / 16 + 0.5 * 0.15) * 100) / 100);
  assert.match(u.price!.basis, /not a bill/);

  // the fallback: docker stats (CPU of one core as text, memory as text, network totals)
  const stats = ['{"Name":"shopapp01-101530000002","CPUPerc":"40.00%","MemUsage":"953.7MiB / 15.6GiB","NetIO":"1.2MB / 3.4MB"}', '{"Name":"crmapp01-101530000003","CPUPerc":"4.00%","MemUsage":"1.5GiB / 15.6GiB","NetIO":"10kB / 0B"}'].join('\n');
  const d = rollup(inv, host, parseDockerStats(stats), 'docker-stats');
  assert.equal(d.projects.find((p) => p.name === 'shop')!.mem, Math.round(953.7 * 1024 ** 2));
  assert.equal(d.projects.find((p) => p.name === 'crm')!.mem, Math.round(1.5 * 1024 ** 3));
  assert.equal(d.projects.find((p) => p.name === 'shop')!.netTotal, 4_600_000);
  assert.equal(d.price, undefined);
  assert.equal(d.reclaimable, 5_000_000_000);
});

test('sizes: volumes, databases measured inside their containers, per project, and what can be cleaned up', () => {
  const inv = buildInventory(COOLIFY_HOST);
  const targets = sizeTargets(inv);
  assert.ok(targets.includes('pg:relaydb01') && targets.includes('pg:supabase-db-shopsupa01'));
  assert.ok(!targets.some((t) => /^bind:\/(etc|var\/run)/.test(t)));
  const out = [
    '\n@@unit7:df', JSON.stringify({ Volumes: [{ Name: 'postgres-data-relaydb01', UsageData: { Size: 800_000_000 } }, { Name: 'shopsupa01_supabase-db-data', UsageData: { Size: 2_000_000_000 } }, { Name: 'orphan-data', UsageData: { Size: 300_000_000 } }],
      Containers: [{ Names: ['/relayweb01-101530000001'], SizeRw: 50_000_000 }], Images: [{ Id: 'sha256:a', Size: 4_000_000_000, SharedSize: 1_000_000_000, Containers: 0 }], BuildCache: [{ Size: 2_000_000_000, InUse: false }] }),
    '@@unit7:logs', '/relayweb01-101530000001 20000000', '@@unit7:items', 'db relaydb01 700000000 postgres', 'db supabase-db-shopsupa01 1500000000 postgres',
  ].join('\n');
  const s = parseSizes(out, inv);
  assert.equal(s.projects.find((p) => p.name === 'relay')!.bytes, 800_000_000 + 50_000_000 + 20_000_000);
  assert.equal(s.projects.find((p) => p.name === 'shop')!.bytes, 2_000_000_000);
  assert.deepEqual(s.databases.map((d) => [d.part, d.bytes]), [['coolify:relaydb01', 700_000_000], ['coolify:shopsupa01', 1_500_000_000]]);
  assert.equal(s.loose, 300_000_000);
  assert.equal(s.reclaimable, 3_000_000_000 + 2_000_000_000 + 300_000_000);
});

test('on the map: projects are frames on their server, parts carry their owner, domains reach their app', () => {
  const inv = buildInventory(COOLIFY_HOST);
  const { found, refs } = xrayFound('srv_test0000000a', inv);
  const server: Found = { provider: 'unit7', kind: 'server', extId: 'srv_test0000000a', name: 'box', ips: ['203.0.113.9'], platform: 'unit7' };
  const shop = found.find((f) => f.kind === 'project' && f.name === 'shop')!;
  assert.equal(shop.owner, 'coolify');
  assert.equal(shop.server, 'unit7:srv_test0000000a');
  assert.deepEqual(shop.parts?.sort(), ['coolify:srv_test0000000a/coolify:shopapp01', 'coolify:srv_test0000000a/coolify:shopsupa01', 'coolify:srv_test0000000a/v:shopsupa01_supabase-db-data']);
  const app = found.find((f) => f.extId === 'srv_test0000000a/coolify:shopapp01')!;
  assert.equal(app.project, 'coolify:srv_test0000000a/p/coolify:shop');
  assert.deepEqual(app.hosts, ['shop.example.com']);
  const dns = [{ from: 'domain:shop.example.com', kind: 'dns' as const, via: 'A 203.0.113.9', ip: '203.0.113.9' }];
  const { edges } = resolve(mergeFound([server, ...found, { provider: 'domain', kind: 'domain', extId: 'shop.example.com', name: 'shop.example.com', dns: 'cloudflare' }]), [...refs, ...dns]);
  assert.ok(edges.some((e) => e.from === 'domain:shop.example.com' && e.to === app.provider + ':' + app.extId && e.kind === 'domain' && e.status === 'ok' && e.via === 'routed by Coolify'));
  assert.ok(edges.some((e) => e.kind === 'uses' && e.from.endsWith('coolify:relayweb01') && e.to.endsWith('coolify:relaydb01')));
  assert.ok(edges.some((e) => e.kind === 'runs_on' && e.from.endsWith('coolify:relaydb01') && e.to === 'unit7:srv_test0000000a'));
});

// --- the tools, against a server that answers with captured output ----------------------------------
const done = (stdout = '', code = 0) => ({ code, stdout, stderr: '', truncated: false });
function fakeServer(app: App, reply: (command: string, o: ExecOptions) => ReturnType<typeof done> | undefined) {
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, o = {}) => { seen.push(command); const r = reply(command, o); if (!r) throw new Error(`unexpected command: ${command}`); return r; };
  return seen;
}
async function server(app: App) {
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ sudo: 'root', publicIp: '203.0.113.9' }));
  return { o, srv };
}
const probeIs = (o: ExecOptions, p: string) => o.stdin === p;

test('X-rays are stored (append-only migration); a failed run keeps and returns the last good one', async () => {
  const app = testApp();
  const cols = all<{ name: string }>(app.db, `PRAGMA table_info(xrays)`).map((c) => c.name);
  assert.deepEqual(cols, ['id', 'org_id', 'server_id', 'kind', 'ok', 'note', 'ms', 'data', 'created_at']);
  assert.ok(all<{ name: string }>(app.db, `PRAGMA table_info(servers)`).some((c) => c.name === 'monthly_price'));
  const { o, srv } = await server(app);
  let up = true;
  const seen = fakeServer(app, (c, x) => (probeIs(x, XRAY_PROBE) && up ? done(COOLIFY_HOST) : undefined));
  const r = ok(await o.h('server.xray', { serverId: srv }));
  assert.equal(r.projects.filter((p: { system?: boolean }) => !p.system).length, 4);
  assert.match(r.next, /coolify\.connect/);
  assert.equal(seen[0], 'sh -s', 'the probe goes over stdin, not on a command line');
  assert.doesNotMatch(JSON.stringify(get(app.db, 'SELECT data FROM xrays WHERE server_id = ?', srv)), SECRETS, 'nothing secret is stored');

  up = false;
  const stale = ok(await o.h('server.xray', { serverId: srv }));
  assert.ok(stale.stale?.since, 'marked stale');
  assert.equal(stale.projects.length, r.projects.length, 'the last good X-ray comes back');
  const rows = all<{ ok: number; note: string | null }>(app.db, 'SELECT ok, note FROM xrays WHERE server_id = ? ORDER BY created_at', srv);
  assert.deepEqual(rows.map((x) => x.ok), [1, 0]);
  assert.match(rows[1]!.note!, /unexpected command/);
  assert.equal(lastXray(app.db, o.orgId, srv)!.data.projects.length, r.projects.length);
  for (let i = 0; i < 205; i++) saveXray(app.db, o.orgId, srv, 'fast', undefined, 'x');
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM xrays WHERE server_id = ?', srv)!.n, 200, 'old runs are pruned');
});

test('server.usage reads Sentinel when it runs, splits the price; server.sizes runs once and is cached', async () => {
  const app = testApp();
  const { o, srv } = await server(app);
  const sentinel = JSON.stringify([{ id: 'shopapp01-101530000002', cpu: { percent: '40.0' }, memory: { used: 1_000_000_000 }, network: { rxBytesPerSec: 1000, txBytesPerSec: 2000 } }]);
  const usage = ['@@unit7:host', 'cpu  100 0 100 800 0 0 0 0 0 0', 'cpu  130 0 130 940 0 0 0 0 0 0', 'cpus=4', 'mem_total=16000000000', 'mem_available=9000000000', 'disk_total=200000000000', 'disk_used=59000000000', '@@unit7:sentinel', sentinel].join('\n');
  let sizesRuns = 0;
  const seen = fakeServer(app, (c, x) => {
    if (probeIs(x, XRAY_PROBE)) return done(COOLIFY_HOST);
    if (probeIs(x, USAGE_PROBE)) return done(`\n${usage}`);
    if (probeIs(x, SIZES_PROBE)) { sizesRuns++; return done(`\n@@unit7:df\n{"Volumes":[]}\n@@unit7:items\ndb relaydb01 700000000 postgres`); }
  });
  ok(await o.h('server.price', { serverId: srv, monthly: 24, currency: 'EUR' }));
  const u = ok(await o.h('server.usage', { serverId: srv }));
  assert.equal(u.source, 'sentinel');
  assert.equal(u.server.cpu, 30);
  assert.equal(u.projects.find((p: { name: string }) => p.name === 'shop').mem, 1_000_000_000);
  assert.deepEqual([u.price.monthly, u.price.currency, u.price.source], [24, 'EUR', 'you']);
  assert.match(u.next, /server\.sizes/);
  const a = ok(await o.h('server.sizes', { serverId: srv }));
  assert.equal(a.cached, false);
  assert.ok(seen.some((c) => c.startsWith("sh '-s' '--'") && c.includes("'pg:relaydb01'")), 'what to measure goes as quoted arguments');
  assert.equal(ok(await o.h('server.sizes', { serverId: srv })).cached, true);
  assert.equal(sizesRuns, 1);
  assert.ok(ok(await o.h('server.usage', { serverId: srv })).disk, 'usage now includes when disk was measured');
  // the server stops answering: the last reading comes back, marked stale, and only one reading is kept
  ssh(app).exec = async () => { throw new Error('connect ETIMEDOUT'); };
  const stale = ok(await o.h('server.usage', { serverId: srv }));
  assert.ok(stale.stale?.since && /ETIMEDOUT/.test(stale.stale.why));
  assert.equal(stale.projects.find((p: { name: string }) => p.name === 'shop').mem, 1_000_000_000);
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM xrays WHERE server_id = ? AND kind = 'usage'`, srv)!.n, 1);
});

test('the map: a sync draws each X-rayed server’s projects as frames, and keeps old fields as they were', async () => {
  const app = testApp();
  const { o, srv } = await server(app);
  const inv = buildInventory(COOLIFY_HOST);
  // domains would send the sync to public DNS: this test is about frames
  inv.parts = inv.parts.filter((p) => p.kind !== 'domain');
  for (const p of inv.parts) delete p.hosts;
  saveXray(app.db, o.orgId, srv, 'fast', inv);
  ok(await o.h('sync.run', {}));
  const m = ok(await o.h('map.get', {}));
  const box = m.assets.find((a: { kind: string }) => a.kind === 'server');
  assert.equal(box.name, 'box');
  assert.deepEqual(box.projects.map((p: { name: string }) => p.name).sort(), ['Coolify itself', 'crm', 'ledger', 'relay', 'shop']);
  const shop = box.projects.find((p: { name: string }) => p.name === 'shop');
  const parts = shop.parts.map((pid: string) => m.assets.find((a: { id: string }) => a.id === pid));
  assert.deepEqual(parts.map((a: { name: string; kind: string }) => `${a.kind}:${a.name}`).sort(), ['app:shop-web', 'database:shop-supabase', 'volume:shopsupa01_supabase-db-data']);
  assert.ok(parts.every((a: { owner: string; trust: string; project: string; server: string }) => a.owner === 'coolify' && a.trust === 'understood' && a.project === shop.id && a.server === box.id));
  assert.equal(parts.find((a: { kind: string }) => a.kind === 'database').product.id, 'supabase');
  assert.equal(box.loose.length, 2, 'Not part of a project');
  const relayDb = m.assets.find((a: { name: string }) => a.name === 'relay-db');
  assert.equal(relayDb.exposed, true);
  assert.ok(m.edges.some((e: { kind: string; target: string }) => e.kind === 'uses' && e.target === relayDb.id));
  assert.ok(m.edges.some((e: { kind: string; source: string; target: string }) => e.kind === 'runs_on' && e.source === relayDb.id && e.target === box.id), 'apps and databases sit on their server as before');
  assert.deepEqual(Object.keys(m).sort(), ['accounts', 'assets', 'autoSync', 'counts', 'edges', 'hidden', 'issues', 'running', 'suggestions', 'syncedAt'].sort(), 'the map’s shape is unchanged (hidden: how many issues a person hid)');
});

test('Unit7 refuses to change a container Coolify runs, and says what to use instead', async () => {
  const app = testApp();
  const { o, srv } = await server(app);
  const labels = (COOLIFY_CONTAINERS.find((c) => c.Name === '/relaydb01')!.Config.Labels);
  const seen = fakeServer(app, (c) => (c.startsWith("docker 'inspect'") ? done(JSON.stringify(c.includes("'old-test'") ? {} : labels)) : c.startsWith("docker 'restart'") ? done() : undefined));
  const r = await o.h('docker.restart', { serverId: srv, container: 'relaydb01' });
  assert.equal(r.status, 'error');
  assert.equal((r as { error: { code: string } }).error.code, 'owned_by_paas');
  assert.match((r as { error: { message: string } }).error.message, /Change this through Coolify: use coolify\.control/);
  assert.ok(!seen.some((c) => c.startsWith("docker 'restart'")), 'nothing was restarted');
  ok(await o.h('docker.restart', { serverId: srv, container: 'old-test' })); // a container nobody runs restarts as before
  assert.ok(seen.some((c) => c === "docker 'restart' 'old-test'"));
});


test('Supabase is known by its gateway, from Docker Hub or the official Kong image', () => {
  assert.equal(fingerprint('kong:2.8.1')?.id, 'supabase');
  assert.equal(fingerprint('kong/kong:3.4')?.id, 'supabase');
  assert.notEqual(fingerprint('kongregate/app:1')?.id, 'supabase');
});
