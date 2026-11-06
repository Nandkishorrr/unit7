// The server watch: usage samples become 5-minute, hourly and daily rollups; the "normal for this time" band
// and the jump rules on a normal day, a spike, a leak, a restart loop, a filling disk; access logs from Caddy,
// Traefik and nginx; calls without signing in, login hammering and scanners; findings from an X-ray; alerts
// said once; scheduling decisions; and the tools on top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { buildInventory, type Sizes } from '../src/discovery/xray.ts';
import { saveXray } from '../src/tools/xray.ts';
import { storeRows, prune, readPoints, bucket, parseSample, between, toRows, SAMPLE_PROBE, sample } from '../src/sentinel/usage.ts';
import { bandOf, median, mad, linearFit, hourOfWeek } from '../src/sentinel/baseline.ts';
import { detect, diskForecast, type Point, type Series } from '../src/sentinel/anomaly.ts';
import { parseHit, parseLog, traefikAccess, analyze, trafficFindings, readProbe, normPath, TRAFFIC_PROBE, type Hit, type Summary } from '../src/sentinel/traffic.ts';
import { findingsFor } from '../src/discovery/findings.ts';
import { track, announce, digestText, weeklyDigest, investigate, tick, anomaliesOf, subjectOf, trafficServer } from '../src/sentinel/watcher.ts';
import { due, digestDue, inQuiet, investigateDue, saveSettings, settingsOf } from '../src/sentinel/schedule.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import { COOLIFY_HOST, COMPOSE_HOST, PM2_HOST, probe } from './xray-fixtures.ts';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const H = 3600_000, M = 60_000;
const iso = (t: number) => new Date(t).toISOString();
// a fixed-seed wobble, so the fixtures are the same on every run
const rng = (seed = 7) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;

// 30 days of hourly history with a daily rhythm: CPU 5–25%, memory around 500 MB, network around 100 KB/s
function history(o: { cpu?: (h: number) => number; mem?: number; net?: number } = {}): Point[] {
  const r = rng();
  const out: Point[] = [];
  for (let t = NOW - 30 * 24 * H; t < NOW - 3 * H; t += H) {
    const h = new Date(t).getUTCHours();
    const cpu = (o.cpu ?? ((x) => 15 + 10 * Math.sin((2 * Math.PI * x) / 24)))(h) + r() * 2;
    const mem = (o.mem ?? 500e6) + r() * 20e6, net = (o.net ?? 100e3) + r() * 10e3;
    out.push({ at: iso(t), cpu, cpuMax: cpu + 2, mem, memMax: mem + 10e6, net, netMax: net * 1.5, restarts: 0, oom: 0 });
  }
  return out;
}
// the last 12 hours in 5-minute points, the same rhythm, with `last` overriding the newest few
function recent(n = 144, f: (p: Point, i: number) => Partial<Point> = () => ({})): Point[] {
  const r = rng(11);
  return Array.from({ length: n }, (_, i) => {
    const t = NOW - (n - 1 - i) * 5 * M, h = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
    const p: Point = { at: iso(t), cpu: 15 + 10 * Math.sin((2 * Math.PI * h) / 24) + r(), mem: 500e6 + r() * 10e6, net: 100e3 + r() * 5e3, restarts: 0, oom: 0, disk: 150e9 };
    return { ...p, ...f(p, i) };
  });
}
const series = (rec: Point[], o: Partial<Series> = {}): Series => ({ scope: 'coolify:shop', name: 'shop', recent: rec, hourly: history(), ...o });

// --- rollups ----------------------------------------------------------------------------------------------
async function server(app: App) {
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ sudo: 'root', publicIp: '203.0.113.9' }));
  return { o, srv };
}

test('rollups: 5-minute, hourly and daily points; averages, peaks and restarts add up; old points go', async () => {
  const app = testApp();
  const { o, srv } = await server(app);
  const at = (min: number) => iso(NOW + min * M);
  storeRows(app.db, o.orgId, srv, at(0), [{ scope: 'server', name: 'The whole server', cpu: 10, mem: 1e9, net: 100, restarts: 0, oom: 0, disk: 50e9 }]);
  storeRows(app.db, o.orgId, srv, at(5), [{ scope: 'server', name: 'The whole server', cpu: 30, mem: 3e9, net: null, restarts: 2, oom: 1, disk: 51e9 }]);
  storeRows(app.db, o.orgId, srv, at(10), [{ scope: 'server', name: 'The whole server', cpu: null, mem: 2e9, net: 300, restarts: 1, oom: 0, disk: null }]);
  const rows = (res: string) => all<any>(app.db, `SELECT * FROM usage_points WHERE server_id = ? AND res = ? ORDER BY at`, srv, res);
  assert.equal(rows('5m').length, 3);
  const h = rows('1h')[0];
  assert.equal(h.at, bucket(NOW, '1h'));
  assert.equal(h.n, 3);
  assert.equal(h.cpu, 20, 'a missing CPU reading doesn’t drag the average down');
  assert.equal(h.cpu_max, 30);
  assert.equal(h.mem, 2e9);
  assert.equal(h.mem_max, 3e9);
  assert.equal(h.restarts, 3);
  assert.equal(h.oom, 1);
  assert.equal(h.disk, 51e9, 'disk keeps the last reading');
  assert.equal(rows('1d').length, 1);
  assert.equal(readPoints(app.db, srv, '5m', NOW - H).get('server')!.points.length, 3);
  // three days on: the 5-minute points are gone, the hourly and daily stay
  prune(app.db, NOW + 3 * 86400_000);
  assert.deepEqual([rows('5m').length, rows('1h').length, rows('1d').length], [0, 1, 1]);
  prune(app.db, NOW + 400 * 86400_000);
  assert.deepEqual([rows('1h').length, rows('1d').length], [0, 0]);
});

test('the sampler: one SSH trip, cgroup counters become rates, restarts are deltas, rows per project', async () => {
  const cg = (usec: number, mem: number, oom = 0, rx = 1000, tx = 2000) => `${'a'.repeat(64)} ${usec} ${mem} 100000000 ${oom} ${rx} ${tx}`;
  const out = (o: { usec: number; restarts: number; oomKilled?: boolean; rx: number; ticks: [number, number] }) => probe({
    host: [`cpu  ${o.ticks[0]} 0 0 ${o.ticks[1]} 0 0 0 0 0 0`, `cpu  ${o.ticks[0]} 0 0 ${o.ticks[1]} 0 0 0 0 0 0`, 'cpus=4', 'mem_total=16000000000', 'mem_available=9000000000', 'disk_total=200000000000', 'disk_used=59000000000', `net_rx=${o.rx}`, 'net_tx=0'].join('\n'),
    ctrs: `${'a'.repeat(64)}|/crmapp01-101530000003|${o.restarts}|${o.oomKilled ? 'true' : 'false'}|running`,
    cg: cg(o.usec, 900_000_000, 0, o.rx, 0),
  });
  const a = parseSample(out({ usec: 1_000_000, restarts: 3, rx: 1_000_000, ticks: [100, 900] }), NOW);
  assert.equal(a.source, 'cgroup');
  assert.equal(a.cg.get('a'.repeat(64))!.mem, 800_000_000, 'memory.current minus inactive_file, like docker stats');
  const b = parseSample(out({ usec: 31_000_000, restarts: 5, oomKilled: true, rx: 4_000_000, ticks: [400, 1500] }), NOW + 300_000);
  const t = between(a, b);
  assert.equal(t.per.get('crmapp01-101530000003')!.cpu, 10, '30 CPU-seconds in 300 seconds is 10% of one core');
  assert.equal(t.restarts.get('crmapp01-101530000003'), 2);
  assert.equal(t.oom.get('crmapp01-101530000003'), 2, 'it was killed for memory, so both restarts count');
  assert.equal(t.host.cpu, 33.3, 'host CPU over the whole 5 minutes');
  assert.equal(t.host.net, 10_000);
  const inv = buildInventory(COOLIFY_HOST);
  const rows = toRows(t, inv);
  const crm = rows.find((r) => r.scope === 'coolify:crm')!;
  assert.equal(crm.cpu, 2.5, 'a project’s CPU is a share of the whole server (4 cores)');
  assert.equal(crm.mem, 800_000_000);
  assert.equal(crm.restarts, 2);
  assert.equal(rows[0]!.scope, 'server');
  assert.equal(rows[0]!.restarts, 2);
  // the first sample has no earlier one: CPU per container is unknown (null), never a made-up number
  assert.equal(toRows(between(undefined, a), inv).find((r) => r.scope === 'coolify:crm')!.cpu, null);

  // over a fake server, twice: the second sample has rates, and both are stored
  const app = testApp();
  const { o, srv } = await server(app);
  saveXray(app.db, o.orgId, srv, 'fast', inv);
  let n = 0;
  ssh(app).exec = async (_s, command, x: ExecOptions = {}) => {
    assert.equal(command, 'sh -s');
    assert.equal(x.stdin, SAMPLE_PROBE);
    n++;
    return { code: 0, stdout: out(n === 1 ? { usec: 1_000_000, restarts: 3, rx: 1e6, ticks: [100, 900] } : { usec: 2_000_000, restarts: 3, rx: 2e6, ticks: [200, 1800] }), stderr: '', truncated: false };
  };
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', srv);
  await sample(app, s, inv);
  const second = await sample(app, s, inv);
  assert.equal(second.source, 'cgroup');
  assert.ok(second.rows.length > 4);
  assert.ok(get<{ n: number }>(app.db, `SELECT count(*) n FROM usage_points WHERE server_id = ? AND res = '1h'`, srv)!.n >= 5);
  // docker stats as the last resort: network totals become a rate between samples
  const ds = (net: string) => probe({ host: 'cpu  1 0 0 9 0 0 0 0\ncpu  2 0 0 18 0 0 0 0\ncpus=2\nmem_total=4000000000\nmem_available=2000000000', ctrs: `${'b'.repeat(64)}|/web|0|false|running`, stats: `{"Name":"web","CPUPerc":"12.5%","MemUsage":"100MiB / 1GiB","NetIO":"${net} / 0B"}` });
  const d = between(parseSample(ds('1MB'), NOW), parseSample(ds('4MB'), NOW + 100_000));
  assert.equal(d.source, 'docker-stats');
  assert.deepEqual([d.per.get('web')!.cpu, d.per.get('web')!.rx], [12.5, 30_000]);
});

// --- baselines and jumps ---------------------------------------------------------------------------------
test('baseline maths: median, MAD, a band per hour of the week, a straight-line fit', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(Math.round(mad([1, 2, 3, 4, 100]) * 1000) / 1000, 1.483, 'one wild value barely moves it');
  const h = history();
  const b = bandOf(h.map((p) => ({ at: p.at, v: p.cpu, max: p.cpuMax })), iso(NOW), (m) => Math.max(3, 0.25 * m))!;
  assert.equal(b.basis, 'week', 'four weeks give each hour of the week its own band');
  assert.ok(b.mid > 13 && b.mid < 17, `noon UTC is mid-rhythm (${b.mid})`);
  assert.ok(b.hi > b.mid && b.lo < b.mid);
  assert.equal(bandOf([{ at: iso(NOW), v: 1 }], iso(NOW), () => 1), undefined, 'not enough history: no band yet');
  assert.equal(hourOfWeek('2026-10-04T05:30:00Z'), 5, 'Sunday 05:30 UTC is hour 5 of the week');
  const fit = linearFit([{ at: 0, v: 10 }, { at: H, v: 20 }, { at: 2 * H, v: 30 }]);
  assert.deepEqual([fit.slope, fit.r2], [10, 1]);
});

test('jumps: a normal day says nothing; a spike, a leak, a restart loop, a filling disk and a network burst each say why', () => {
  // a normal day
  assert.deepEqual(detect(series(recent()), { memTotal: 16e9 }, NOW), []);

  // CPU at 80% for the last 15 minutes, where noon is usually ~15%
  const spike = detect(series(recent(144, (_, i) => (i >= 141 ? { cpu: 80 } : {}))), {}, NOW);
  const cpu = spike.find((a) => a.kind === 'high' && a.metric === 'cpu')!;
  assert.ok(cpu, 'flagged');
  assert.equal(cpu.severity, 'critical', 'over 4× the usual');
  assert.match(cpu.reason, /^CPU of shop is 5\.\d× its usual level for this time of day \(80%, usually 1\d%\) for 15 minutes\.$/);
  assert.equal(cpu.since, iso(NOW - 10 * M));
  // one 5-minute blip isn't 10 minutes
  assert.deepEqual(detect(series(recent(144, (_, i) => (i === 143 ? { cpu: 80 } : {}))), {}, NOW).filter((a) => a.metric === 'cpu'), []);
  // a small rise inside the band isn't news either
  assert.deepEqual(detect(series(recent(144, (p, i) => (i >= 138 ? { cpu: p.cpu! + 3 } : {}))), {}, NOW), []);

  // memory climbing steadily for 6 hours, 450 MB → 1.15 GB
  const leak = detect(series(recent(144, (_, i) => (i >= 72 ? { mem: 450e6 + ((i - 72) / 71) * 700e6 } : {}))), { memTotal: 4e9, memUsed: 3.2e9 }, NOW);
  const l = leak.find((a) => a.kind === 'leak')!;
  assert.ok(l, 'a leak');
  assert.match(l.reason, /^Memory of shop has climbed steadily for 6 hours \(from 4\d\d MB to 1\.\d GB\) without levelling off: it may be leaking\.$/);
  assert.match(l.forecast!, /At this rate the server runs out of memory in about \d+ hours\./);
  // told once: the leak, not also "memory is high" for the same project
  assert.deepEqual(anomaliesOf([series(recent(144, (_, i) => (i >= 72 ? { mem: 450e6 + ((i - 72) / 71) * 700e6 } : {})))], { memTotal: 4e9 }, NOW).map((a) => a.kind), ['leak']);
  // the same climb with a restart in it (memory reset) isn't a leak
  assert.ok(!detect(series(recent(144, (_, i) => (i >= 72 ? { mem: 450e6 + ((i - 72) / 71) * 700e6, restarts: i === 100 ? 1 : 0 } : {}))), {}, NOW).some((a) => a.kind === 'leak'));

  // 4 restarts in the last half hour, out of memory twice
  const loop = detect(series(recent(144, (_, i) => (i >= 139 && i <= 142 ? { restarts: 1, oom: i === 140 || i === 142 ? 1 : 0 } : {}))), {}, NOW);
  const r = loop.find((a) => a.kind === 'restarts')!;
  assert.match(r.reason, /^shop restarted 4 times in the last 30 minutes \(ran out of memory 2 times in the last hour\)\.$/);

  // the disk: usually +0.5 GB a day, now +2 GB an hour, with 38 GB left
  const daily = Array.from({ length: 30 }, (_, d) => ({ at: iso(NOW - (30 - d) * 86400_000), cpu: null, mem: null, net: null, restarts: 0, oom: 0, disk: 130e9 + d * 0.5e9 }));
  const disk = detect({ scope: 'server', name: 'The whole server', hourly: history(), daily, recent: recent(144, (p, i) => ({ disk: i >= 72 ? 150e9 + ((i - 72) * 5 / 60) * 2e9 : 150e9 })) }, { diskTotal: 200e9 }, NOW);
  const dk = disk.find((a) => a.kind === 'disk')!;
  assert.match(dk.reason, /^The disk is filling \d+× faster than usual: \+1\d\.\d GB in the last 6 hours\.$/);
  assert.equal(dk.forecast, 'At this rate it’s full in about 19 hours.'.replace('’', "'"));
  assert.equal(dk.severity, 'critical', 'full within a day');

  // a network burst: 5 MB/s where it's usually ~100 KB/s
  const net = detect(series(recent(144, (_, i) => (i === 143 ? { net: 5e6 } : {}))), {}, NOW).find((a) => a.kind === 'spike')!;
  assert.match(net.reason, /^Network traffic of shop jumped to 5 MB\/s, \d+× the usual for this time of day \(\d+ KB\/s\)\.$/);
  assert.equal(net.severity, 'warning', '5 MB/s is big against the usual, small in itself');
  assert.equal(net.quiet, true);

  // stale data: nothing claimed about "now"
  assert.deepEqual(detect(series(recent(144, (_, i) => (i >= 141 ? { cpu: 80 } : {}))), {}, NOW + H), []);
  // the long view for findings
  assert.equal(Math.round(diskForecast(daily, 200e9)!.days!), 111);
});

// --- access logs ------------------------------------------------------------------------------------------
const TS = NOW / 1000 - 60;
const CADDY = JSON.stringify({ level: 'info', ts: TS, logger: 'http.log.access', msg: 'handled request', request: { remote_ip: '198.51.100.7', client_ip: '198.51.100.7', method: 'GET', host: 'shop.example.com', uri: '/api/items/12345?token=abc', headers: { 'User-Agent': ['Mozilla/5.0 (Macintosh) Chrome/120.0 Safari/537.36'], Cookie: ['REDACTED'] } }, duration: 0.012, status: 200 });
const TRAEFIK_CLF = '198.51.100.8 - - [07/Oct/2026:11:58:00 +0000] "POST /login HTTP/1.1" 401 17 "-" "python-requests/2.31.0" 1234 "https-0-shopapp01@docker" "http://10.0.1.5:3000" 5ms';
const TRAEFIK_JSON = JSON.stringify({ ClientHost: '198.51.100.9', RequestMethod: 'GET', RequestHost: 'api.shop.example.com', RequestPath: '/rest/v1/orders', DownstreamStatus: 502, Duration: 2_500_000, RouterName: 'https-0-shopsupa01@docker', time: '2026-10-07T11:59:00Z', 'request_User-Agent': 'curl/8.4.0' });
const NGINX = '203.0.113.50 - - [07/Oct/2026:11:57:00 +0000] "GET /wp-login.php HTTP/1.1" 404 162 "-" "Mozilla/5.0 zgrab/0.x"';

test('access logs: Caddy JSON, Traefik common and JSON, nginx combined; Coolify’s access log on or off', () => {
  assert.partialDeepStrictEqual(parseHit(CADDY), { at: TS * 1000, ip: '198.51.100.7', method: 'GET', host: 'shop.example.com', path: '/api/items/12345', status: 200, ua: 'Mozilla/5.0 (Macintosh) Chrome/120.0 Safari/537.36', ms: 12, anon: false });
  assert.partialDeepStrictEqual(parseHit(TRAEFIK_CLF), { at: Date.parse('2026-10-07T11:58:00Z'), ip: '198.51.100.8', method: 'POST', path: '/login', status: 401, ua: 'python-requests/2.31.0', router: 'https-0-shopapp01@docker', ms: 5 });
  assert.partialDeepStrictEqual(parseHit(TRAEFIK_JSON), { at: Date.parse('2026-10-07T11:59:00Z'), ip: '198.51.100.9', method: 'GET', host: 'api.shop.example.com', path: '/rest/v1/orders', status: 502, ua: 'curl/8.4.0', ms: 2.5, router: 'https-0-shopsupa01@docker' });
  assert.partialDeepStrictEqual(parseHit(NGINX), { at: Date.parse('2026-10-07T11:57:00Z'), ip: '203.0.113.50', method: 'GET', path: '/wp-login.php', status: 404, ua: 'Mozilla/5.0 zgrab/0.x' });
  assert.equal(parseHit('time="2026-10-07" level=error msg="some Traefik error"'), undefined, 'the proxy’s own messages are not requests');
  assert.equal(parseLog(`${CADDY}\nnot a line\n${CADDY}`).hits.length, 2);
  assert.equal(parseLog(CADDY).anonKnown, true, 'Caddy records which calls carried a sign-in');
  assert.equal(parseLog(TRAEFIK_CLF).anonKnown, false);
  assert.equal(normPath('/api/items/12345/orders/9f8e7d6c5b4a3210?x=1'), '/api/items/:id/orders/:id');

  assert.deepEqual(traefikAccess(JSON.stringify(['--ping=true', '--api.dashboard=true', '--providers.docker=true'])), { on: false, file: undefined, format: 'common', headers: false });
  assert.deepEqual(traefikAccess(JSON.stringify(['--accesslog=true', '--accesslog.format=json', '--accesslog.filepath=/traefik/access.log', '--accesslog.fields.headers.names.Cookie=redact'])), { on: true, file: '/traefik/access.log', format: 'json', headers: true });
  assert.equal(traefikAccess(JSON.stringify(['--accesslog=false'])).on, false);
});

// --- traffic: the usual vs now ----------------------------------------------------------------------------
const hits = (n: number, f: (i: number) => Partial<Hit>): Hit[] => Array.from({ length: n }, (_, i) => ({ at: NOW - 20 * M + i, ip: `198.51.100.${i % 200}`, method: 'GET', host: 'shop.example.com', path: '/', status: 200, ua: 'Mozilla/5.0 Chrome/120.0', anon: false, ...f(i) }));
// two weeks of quiet half hours: about 200 requests, a few without signing in
const pastWindows = (): Summary[] => Array.from({ length: 28 * 48 }, (_, k) => {
  const at = NOW - (k + 1) * 30 * M;
  return { ...analyze(hits(200, (i) => ({ at: at - i * 1000, anon: i % 20 === 0 })), { now: at, minutes: 30, anonKnown: true }), at: iso(at) };
});
const ctx = { serverId: 'srv_test0000000a', serverName: 'box' };

test('calls without signing in: one address hammering is blockable; a crowd gets rate-limit advice; quiet traffic says nothing', () => {
  const past = pastWindows();
  const quiet = analyze(hits(200, (i) => ({ anon: i % 20 === 0 })), { now: NOW, minutes: 30, anonKnown: true });
  assert.deepEqual(trafficFindings(quiet, past, ctx), []);

  // one address: 900 anonymous calls of 1,100
  const one = analyze([...hits(200, () => ({})), ...hits(900, () => ({ ip: '203.0.113.66', anon: true, path: '/api/search?q=secret-token-123', ua: 'python-requests/2.31' }))], { now: NOW, minutes: 30, anonKnown: true });
  const f = trafficFindings(one, past, ctx);
  const a = f.find((x) => x.id.startsWith('traffic:anon-one'))!;
  assert.equal(a.title, 'One address made 900 calls without signing in');
  assert.deepEqual(a.fix, { tool: 'shield.block', input: { serverId: ctx.serverId, ip: '203.0.113.66', reason: 'many calls without signing in' }, label: 'Block 203.0.113.66', safe: true,
    change: 'Blocks 203.0.113.66 for 15 minutes, longer if it comes back. It lifts by itself.', undo: { tool: 'shield.unblock', input: { serverId: ctx.serverId, ip: '203.0.113.66' }, label: 'Unblock it' } });
  const surge = f.find((x) => x.id.startsWith('traffic:surge'))!;
  assert.match(surge.title, /^1\.1k requests in the last 30 minutes, 5\.\d× the usual$/);
  assert.ok(!JSON.stringify(f).includes('secret-token-123'), 'query strings never reach the evidence');
  assert.equal(one.topAgents.find((x) => x.agent === 'Python script')!.bot, true);

  // a crowd: 1,500 anonymous calls from 150 addresses, each one modest
  const crowd = analyze([...hits(200, () => ({})), ...hits(1500, (i) => ({ ip: `192.0.2.${i % 150}`, anon: true, path: '/api/search' }))], { now: NOW, minutes: 30, anonKnown: true });
  const c = trafficFindings(crowd, past, ctx).find((x) => x.id.startsWith('traffic:anon-many'))!;
  assert.match(c.title, /^1\.5k calls without signing in from 1\d\d addresses, \d+× the usual$/);
  assert.ok('manual' in c.fix! && /rate limit/.test(c.fix.manual[0]!));
  assert.ok(!trafficFindings(crowd, past, ctx).some((x) => x.id.startsWith('traffic:anon-one')));

  // without sign-in headers (Traefik's common format), refused calls stand in for anonymous ones
  const refused = analyze(hits(400, () => ({ ip: '203.0.113.77', status: 401, anon: undefined })), { now: NOW, minutes: 30, anonKnown: false });
  assert.equal(refused.anon.how, 'refused');
  assert.equal(trafficFindings(refused, [], ctx).find((x) => x.id.startsWith('traffic:anon-one'))!.title, 'One address made 400 calls refused for not being signed in');
});

test('login hammering, server errors, scanners and app errors become findings with fixes', () => {
  const w = analyze([
    ...hits(300, () => ({})),
    ...hits(45, () => ({ ip: '203.0.113.80', method: 'POST', path: '/login', status: 401, ua: 'python-requests/2.31' })),
    ...hits(60, (i) => ({ path: '/checkout', status: i % 2 ? 502 : 500 })),
    ...hits(30, (i) => ({ ip: '203.0.113.90', path: i % 2 ? '/.env' : '/wp-login.php', status: 404, ua: 'Mozilla/5.0 zgrab/0.x' })),
  ], { now: NOW, minutes: 30, anonKnown: true, errors: [{ container: 'shop-web', n: 140, sample: ['Error: connect ECONNREFUSED 10.0.1.9:5432 at /api/orders?session=abc123'] }] });
  const f = trafficFindings(w, [], ctx);
  const login = f.find((x) => x.id.startsWith('traffic:login-one'))!;
  assert.equal(login.title, '203.0.113.80 tried to sign in 45 times in 30 minutes');
  assert.equal((login.fix as { tool: string }).tool, 'shield.block');
  const e5 = f.find((x) => x.id.startsWith('traffic:5xx'))!;
  assert.equal(e5.title, '60 requests failed with a server error (14%)');
  assert.equal(e5.severity, 'high');
  assert.equal(e5.evidence, 'Most on /checkout (60)');
  const scan = f.find((x) => x.id.startsWith('traffic:scan'))!;
  assert.deepEqual([scan.bucket, scan.severity], ['tip', 'low']);
  const errs = f.find((x) => x.id.startsWith('logs:errors'))!;
  assert.equal(errs.title, 'shop-web wrote 140 error lines in the last 30 minutes');
  assert.doesNotMatch(errs.evidence!, /abc123/, 'query values are cut from log samples');
});

test('the traffic probe output: Coolify’s access log off is explained with steps, never switched on behind its back', () => {
  const sec = { proxies: 'coolify-proxy', traefik_args: JSON.stringify(['--ping=true', '--providers.docker=true']), app_errors: '##shop-web 3\nError: boom' };
  const { summary, traefik } = readProbe(sec, { now: NOW, minutes: 30 });
  assert.equal(traefik!.on, false);
  assert.deepEqual(summary.sources, [{ id: 'coolify-traefik', name: 'Coolify’s proxy', lines: 0, note: 'its access log is off' }]);
  assert.deepEqual(summary.errors, [{ container: 'shop-web', n: 3, sample: ['Error: boom'] }]);
  assert.doesNotMatch(TRAFFIC_PROBE, /docker (restart|update|compose|rm|stop)|sed -i|> \/data/, 'nothing in the probe changes anything');
  const on = readProbe({ proxies: 'coolify-proxy', traefik_args: JSON.stringify(['--accesslog=true']), traefik_log: [TRAEFIK_CLF, TRAEFIK_CLF].join('\n') }, { now: NOW, minutes: 30 });
  assert.equal(on.summary.requests, 2);
  assert.match(on.summary.sources[0]!.note!, /doesn’t record sign-in headers/);
});

// --- findings from an X-ray --------------------------------------------------------------------------------
test('findings from a Coolify X-ray: open database and proxy dashboard, out of memory, no backups, waste, each with its fix', () => {
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
  const f = findingsFor({ serverId: 'srv_test0000000a', serverName: 'box', inv, history: { memMax: { 'coolify:crm': 1.1e9 }, restarts: {}, oom: { 'coolify:crm': 3 }, daily: [] } });
  const byId = (x: string) => f.find((y) => y.id === x);
  const db = byId('server:port:srv_test0000000a:5432')!;
  assert.deepEqual([db.bucket, db.severity, db.title], ['risk', 'high', 'relay-db (PostgreSQL) answers the internet on port 5432']);
  // Coolify itself on its API port: its allowed-IPs list believes any address a caller claims, so a tip says keep it closed
  const api = byId('xray:coolify-port:srv_test0000000a')!;
  assert.deepEqual([api.bucket, api.severity, api.title], ['tip', 'low', 'Coolify answers the internet on port 8000']);
  assert.match(api.detail, /keep port 8000 closed to the internet/);
  assert.deepEqual(db.fix, { tool: 'server.close_port', input: { serverId: 'srv_test0000000a', port: 5432 }, label: 'Close this port', safe: true,
    change: 'Blocks port 5432 from the internet at the server’s own firewall. Your apps still reach it inside the server; you can open it again.', undo: { tool: 'server.close_port', input: { serverId: 'srv_test0000000a', port: 5432, open: true }, label: 'Open it again' } });
  assert.match(db.detail, /Make it publicly available/);
  assert.equal(byId('server:port:srv_test0000000a:8080')!.title, 'Coolify’s proxy dashboard is open to the internet on port 8080');
  const oom = byId('xray:oom:srv_test0000000a:coolify:crmapp01')!;
  assert.equal(oom.title, 'crm-web keeps running out of memory');
  assert.match(oom.detail, /Give it a memory cap a little above what it normally uses/, 'crm’s peak includes its Supabase, so no number');
  const solo = findingsFor({ serverId: 'srv_test0000000a', serverName: 'box', inv: { ...inv, parts: inv.parts.filter((p) => p.id !== 'coolify:crmsupa01') }, history: { memMax: { 'coolify:crm': 1.1e9 }, restarts: {}, oom: {}, daily: [] } });
  assert.match(solo.find((x) => x.id === 'xray:oom:srv_test0000000a:coolify:crmapp01')!.detail, /Give it a 1\.8 GB memory cap and a restart rule/, '1.5× its peak, rounded up');
  // out of memory in ledger's history, with no container saying which: one finding, about its app
  const led = findingsFor({ serverId: 'srv_l', serverName: 'box', inv, history: { memMax: {}, restarts: {}, oom: { 'coolify:ledger': 2 }, daily: [] } }).filter((x) => x.id.startsWith('xray:oom:'));
  assert.deepEqual(led.map((x) => x.title).sort(), ['crm-web keeps running out of memory', 'ledger-web keeps running out of memory']);
  assert.equal(led.find((x) => x.title.startsWith('ledger'))!.evidence, '2 out-of-memory restarts this week in ledger');
  assert.ok('manual' in oom.fix! && /Resource limits/.test(oom.fix.manual[0]!), 'Coolify’s things change through Coolify');
  // relay's database has a nightly pg_dump in cron: backed up. The Supabase stacks: nothing Unit7 can see
  assert.ok(!byId('xray:no-backup:srv_test0000000a:coolify:relaydb01'));
  assert.deepEqual(f.filter((x) => x.id.startsWith('xray:no-backup')).map((x) => [x.title, x.severity]).sort(), [
    ['crm-supabase has no backups Unit7 can see', 'medium'], ['ledger-supabase has no backups Unit7 can see', 'medium'], ['shop-supabase has no backups Unit7 can see', 'medium']]);
  const reclaim = byId('xray:reclaim:srv_test0000000a')!;
  assert.deepEqual([reclaim.bucket, reclaim.title, (reclaim.fix as { tool: string; safe: boolean }).tool, (reclaim.fix as { safe: boolean }).safe], ['waste', '5.0 GB of old images and build cache nobody uses', 'docker.prune', true]);
  const vol = byId('xray:volume:srv_test0000000a:v:orphan-data')!;
  assert.deepEqual([vol.bucket, vol.title, vol.fix], ['waste', 'orphan-data is data nothing uses', { tool: 'part.remove', input: { serverId: 'srv_test0000000a', part: 'v:orphan-data' }, label: 'Move to the trash', typeName: 'orphan-data',
    change: 'Copies it into a 7-day trash, then removes it. Undo brings it back; after 7 days it’s gone for good.' }], 'each leftover volume: the 7-day trash, the person types its name');
  assert.ok(!f.some((x) => x.about?.name !== 'box'));
  // ordered: risks, then waste, then tips; worst first inside each
  const order = f.map((x) => x.bucket);
  assert.deepEqual(order, [...order].sort((a, b) => ['risk', 'waste', 'tip'].indexOf(a) - ['risk', 'waste', 'tip'].indexOf(b)));

  // disk details, a forecast and the last security check join in
  const sizes = { logs: { 'crmapp01-101530000003': 2.3e9, 'relaydb01': 10e6 }, layers: { 'shopapp01-101530000002': 1.4e9 }, volumes: { 'orphan-data': 3e9 }, reclaimable: 9.4e9 } as unknown as Sizes;
  const daily = Array.from({ length: 10 }, (_, d) => ({ at: iso(NOW - (10 - d) * 86400_000), cpu: null, mem: null, net: null, restarts: 0, oom: 0, disk: 180e9 + d * 1e9 }));
  const g = findingsFor({ serverId: 'srv_x', serverName: 'box', inv, sizes, diskTotal: 200e9, history: { memMax: {}, restarts: {}, oom: {}, daily },
    security: [{ id: 'server:ssh-password:srv_x', severity: 'high', area: 'server', title: 'box accepts passwords to sign in', detail: 'd', by: 'unit7', serverId: 'srv_x' }] });
  assert.equal(g.find((x) => x.id === 'xray:logs:srv_x')!.title, 'Logs take 2.3 GB and keep growing');
  assert.equal(g.find((x) => x.id === 'xray:layer:srv_x:shopapp01-101530000002')!.title, 'shopapp01-101530000002 keeps 1.4 GB inside its container');
  const fc = g.find((x) => x.id === 'xray:disk-forecast:srv_x')!;
  assert.deepEqual([fc.bucket, fc.severity, fc.title], ['risk', 'medium', 'The disk is full in about 11 days at this rate']);
  assert.ok(g.some((x) => x.id === 'server:ssh-password:srv_x' && x.bucket === 'risk'));
});

test('findings from compose and PM2 X-rays: files changed on the server, apps without a memory cap', () => {
  const c = findingsFor({ serverId: 'srv_c', serverName: 'c', inv: buildInventory(COMPOSE_HOST) });
  const git = c.find((x) => x.id === 'xray:git-dirty:srv_c:/srv/shop')!;
  assert.deepEqual([git.bucket, git.title], ['tip', '3 files were changed directly on the server in /srv/shop']);
  assert.match(c.find((x) => x.id === 'xray:no-caps:srv_c')!.title, /^\d apps? ha(s|ve) no memory cap$/);
  assert.deepEqual(c.filter((x) => x.id.startsWith('xray:no-backup:')).map((x) => [x.title, x.severity]), [['db in shop has no backups Unit7 can see', 'high'], ['Supabase has no backups Unit7 can see', 'high']], 'Redis (a cache) is left out');
  const p = findingsFor({ serverId: 'srv_p', serverName: 'p', inv: buildInventory(PM2_HOST) });
  assert.equal(p.find((x) => x.id === 'xray:git-dirty:srv_p:/var/www/api')!.title, '2 files were changed directly on the server in /var/www/api');
});

// --- alerts -------------------------------------------------------------------------------------------------
test('alerts: open until cleared, said once in one message per server, at most every 15 minutes; quiet hours keep the phone still', async () => {
  const app = testApp();
  const { o, srv } = await server(app);
  const events: { type: string; message: string; severity: string }[] = [];
  app.events.on((e) => { if (e.type.startsWith('watch.')) events.push(e); });
  const s = { id: srv, name: 'box' };
  const t0 = NOW;
  const a1 = { key: 'coolify:crm:high:mem', severity: 'warning', title: 'Memory of crm is 2.3× its usual level for this time of day (2.1 GB, usually 900 MB) for 15 minutes.' };
  assert.equal(track(app, o.orgId, srv, 'usage', [a1], iso(t0)).fresh.length, 1);
  assert.equal(track(app, o.orgId, srv, 'usage', [a1], iso(t0 + 5 * M)).fresh.length, 0, 'the same thing again is the same alert');
  announce(app, o.orgId, s, 'usage', t0 + 5 * M);
  assert.equal(events.length, 1);
  assert.match(events[0]!.message, /^box: Memory of crm is 2\.3×/);
  assert.equal(events[0]!.type, 'watch.anomaly');
  // a second thing 5 minutes later waits for the 15-minute gap, then goes out alone
  const a2 = { key: 'server:spike:net', severity: 'critical', title: 'Network traffic jumped to 5.0 MB/s.' };
  track(app, o.orgId, srv, 'usage', [a1, a2], iso(t0 + 10 * M));
  assert.equal(announce(app, o.orgId, s, 'usage', t0 + 10 * M), undefined);
  assert.match(announce(app, o.orgId, s, 'usage', t0 + 21 * M)!, /^box: Network traffic jumped/);
  assert.equal(events.length, 2);
  assert.equal(events[1]!.severity, 'critical');
  assert.equal(announce(app, o.orgId, s, 'usage', t0 + 60 * M), undefined, 'nothing new: nothing said');
  // it clears; if it comes back it's a new alert
  const { cleared } = track(app, o.orgId, srv, 'usage', [a2], iso(t0 + 30 * M));
  assert.deepEqual(cleared.map((c) => c.key), [a1.key]);
  assert.equal(track(app, o.orgId, srv, 'usage', [a1, a2], iso(t0 + 35 * M)).fresh.length, 1);
  assert.equal(all(app.db, 'SELECT 1 FROM watch_alerts WHERE server_id = ?', srv).length, 3);

  // quiet hours: a warning stays off the phone, a critical one still rings
  const { subscribeUrl } = setupNtfy(app, o.orgId);
  const sent: string[] = [];
  const send = async (url: string) => { sent.push(url); };
  const ev = (severity: 'warning' | 'critical', resource: string) => ({ id: 'e', org_id: o.orgId, type: 'watch.anomaly', severity, message: 'box: Memory…', project_id: null, environment_id: null, resource, data: {}, created_at: iso(Date.now()) });
  const h = new Date().getUTCHours();
  saveSettings(app.db, o.orgId, { quiet: { from: `${String(h).padStart(2, '0')}:00`, to: `${String((h + 2) % 24).padStart(2, '0')}:00`, tz: 'UTC' } });
  assert.equal(await deliver(app, ev('warning', 'srv_q1'), send), 0);
  assert.equal(await deliver(app, ev('critical', 'srv_q2'), send), 1);
  assert.deepEqual(sent, [subscribeUrl]);
  saveSettings(app.db, o.orgId, { quiet: null });
  assert.equal(await deliver(app, ev('warning', 'srv_q3'), send), 1);
});

// --- scheduling --------------------------------------------------------------------------------------------
test('scheduling decisions: due, quiet hours across midnight, the Monday digest, one investigation per 6 hours', () => {
  assert.equal(due(undefined, 30, NOW), true);
  assert.equal(due(null, 30, NOW), true, 'an empty table (max() is null) is due');
  assert.equal(due('not a time', 30, NOW), true);
  assert.equal(due(NOW - 29 * M, 30, NOW), false);
  assert.equal(due(NOW - 29.6 * M, 30, NOW), true, 'the minute sweep is coarse: half a minute early counts');
  assert.equal(due(iso(NOW - 61 * M), 60, NOW), true);
  const q = { from: '22:00', to: '07:00', tz: 'UTC' };
  assert.equal(inQuiet(q, Date.parse('2026-10-07T23:30:00Z')), true);
  assert.equal(inQuiet(q, Date.parse('2026-10-07T06:59:00Z')), true);
  assert.equal(inQuiet(q, Date.parse('2026-10-07T07:00:00Z')), false);
  assert.equal(inQuiet({ from: '22:00', to: '07:00', tz: 'Asia/Kolkata' }, Date.parse('2026-10-07T17:00:00Z')), true, '22:30 in India');
  assert.equal(inQuiet(null, NOW), false);
  const mon = Date.parse('2026-10-05T09:00:00Z'); // a Monday
  assert.equal(digestDue({ digest: true }, mon), true);
  assert.equal(digestDue({ digest: true }, Date.parse('2026-10-05T07:00:00Z')), false, 'not before 08:00');
  assert.equal(digestDue({ digest: true }, NOW), false, 'not on a Wednesday');
  assert.equal(digestDue({ digest: true, lastDigest: iso(mon - H) }, mon), false, 'once a week');
  assert.equal(digestDue({ digest: false }, mon), false);
  assert.equal(investigateDue(undefined, NOW), true);
  assert.equal(investigateDue(iso(NOW - 2 * H), NOW), false);
});

test('the weekly digest in plain words', async () => {
  assert.equal(digestText([{ name: 'box', requests: 12_400, topHost: { host: 'shop.example.com', n: 9100 }, problems: 2, open: 0, oom: [{ name: 'crm', n: 2 }], restarts: 3, disk: 1.2e9, updates: 3 }]),
    'box: 12k requests (shop.example.com 9.1k), 2 unusual things spotted, all cleared, crm ran out of memory twice, disk +1.2 GB, 3 security updates waiting.');
  assert.equal(digestText([{ name: 'quiet', requests: 0, problems: 0, open: 0, oom: [], restarts: 0 }]), 'quiet: nothing unusual.');
  const app = testApp();
  const { o } = await server(app);
  const seen: string[] = [];
  app.events.on((e) => { if (e.type === 'watch.digest') seen.push(e.message); });
  weeklyDigest(app, o.orgId);
  assert.deepEqual(seen, ['This week: box: nothing unusual.']);
  assert.ok(settingsOf(app.db, o.orgId).lastDigest);
});

// --- the tools ------------------------------------------------------------------------------------------------
test('tools: server.trends with bands and markers, server.findings, server.traffic over a fake server, watch.settings', async () => {
  const app = testApp();
  const { o, srv } = await server(app);
  const inv = buildInventory(COOLIFY_HOST);
  saveXray(app.db, o.orgId, srv, 'fast', inv);
  // two weeks of hourly history and today's 5-minute points, with crm's memory high for the last 20 minutes
  const now = Date.now();
  for (let t = now - 14 * 86400_000; t < now - 3 * H; t += H) storeRows(app.db, o.orgId, srv, iso(t), [{ scope: 'server', name: 'The whole server', cpu: 20, mem: 6e9, net: 1e5, restarts: 0, oom: 0, disk: 59e9 }, { scope: 'coolify:crm', name: 'crm', cpu: 2, mem: 500e6, net: 1e4, restarts: 0, oom: 0 }]);
  for (let t = now - 2 * H; t <= now; t += 5 * M) storeRows(app.db, o.orgId, srv, iso(t), [{ scope: 'server', name: 'The whole server', cpu: 20, mem: 6e9, net: 1e5, restarts: 0, oom: 0, disk: 59e9 }, { scope: 'coolify:crm', name: 'crm', cpu: 2, mem: t > now - 20 * M ? 1.6e9 : 500e6, net: 1e4, restarts: t > now - 10 * M ? 1 : 0, oom: 0 }]);
  app.events.emit(o.orgId, 'coolify.action', 'deploy of application crmapp01 through Coolify on box: finished', { resource: srv });
  const tr = ok(await o.h('server.trends', { serverId: srv, range: '24h' }));
  assert.deepEqual(tr.series.map((x: { scope: string }) => x.scope), ['server', 'coolify:crm']);
  const crm = tr.series[1];
  assert.equal(crm.points.length, crm.band.mem.length);
  assert.ok(crm.band.mem.at(-1).hi < 1.6e9 && crm.band.mem.at(-1).mid === 500e6, 'the band is crm’s usual, not today’s jump');
  assert.ok(tr.events.some((e: { kind: string }) => e.kind === 'deploy'), 'the deploy is marked');
  assert.ok(tr.events.some((e: { kind: string; label: string }) => e.kind === 'restart' && /crm restarted/.test(e.label)));
  assert.equal(tr.learning, false);
  assert.equal(ok(await o.h('server.trends', { serverId: srv, range: '7d', scope: 'coolify:crm' })).series.length, 1);

  const fd = ok(await o.h('server.findings', { serverId: srv }));
  assert.ok(fd.risks.some((f: { id: string }) => f.id === `server:port:${srv}:5432`));
  assert.ok(fd.waste.some((f: { id: string }) => f.id === `xray:reclaim:${srv}`));
  assert.equal(fd.counts.risks, fd.risks.length);

  // the traffic check: Unit7's Caddy has a burst of anonymous calls from one address
  const line = (i: number, ip: string, anon: boolean) => JSON.stringify({ level: 'info', ts: Date.now() / 1000 - 60 + i / 1000, msg: 'handled request', request: { client_ip: ip, method: 'GET', host: 'shop.example.com', uri: '/api/search', headers: { 'User-Agent': ['curl/8'], ...(!anon && { Cookie: ['REDACTED'] }) } }, status: 200, duration: 0.01 });
  const caddy = [...Array.from({ length: 100 }, (_, i) => line(i, `198.51.100.${i}`, false)), ...Array.from({ length: 700 }, (_, i) => line(i, '203.0.113.66', true))].join('\n');
  let commands: string[] = [];
  ssh(app).exec = async (_s, command, x: ExecOptions = {}) => {
    commands.push(command);
    if (x.stdin === TRAFFIC_PROBE) return { code: 0, stdout: probe({ proxies: 'unit7-caddy', caddy_log: caddy, app_errors: '' }), stderr: '', truncated: false };
    throw new Error(`unexpected: ${command}`);
  };
  const tw = ok(await o.h('server.traffic', { serverId: srv }));
  assert.equal(commands[0], "sh '-s' '--' '30'", 'the window goes as a quoted argument');
  assert.equal(tw.summary.requests, 800);
  assert.equal(tw.summary.anon.n, 700);
  assert.ok(tw.findings.some((f: { id: string }) => f.id === `traffic:anon-one:${srv}:203.0.113.66`));
  assert.ok(all(app.db, `SELECT 1 FROM watch_alerts WHERE server_id = ? AND source = 'traffic' AND cleared_at IS NULL`, srv).length >= 1, 'it’s an open alert');
  commands = [];
  ok(await o.h('server.traffic', { serverId: srv }));
  assert.deepEqual(commands, [], 'a recent check is reused');
  assert.ok(ok(await o.h('server.findings', { serverId: srv })).risks.some((f: { id: string }) => f.id.startsWith('traffic:anon-one')), 'traffic findings join the server’s findings');
  const an = ok(await o.h('watch.anomalies', {}));
  assert.ok(an.open.some((x: { serverName: string; source: string }) => x.serverName === 'box' && x.source === 'traffic'));

  // settings: read, change (an AI may: it's a watch setting), bad values refused
  const st = ok(await o.h('watch.settings', {}));
  assert.deepEqual([st.every, st.usage, st.traffic, st.quiet], [30, true, true, null]);
  const changed = ok(await o.a('watch.settings', { every: 60, quiet: { from: '22:00', to: '07:00', tz: 'Not/AZone' } }));
  assert.deepEqual([changed.every, changed.quiet], [60, { from: '22:00', to: '07:00' }]);
  assert.equal((await o.h('watch.settings', { every: 45 })).status, 'error');
});

test('a serious jump gets a read-only AI look only when a brain is listening, at most every 6 hours', async () => {
  const app = testApp();
  const { o, srv } = await server(app);
  const s = { id: srv, name: 'box' };
  const crit = (key: string) => track(app, o.orgId, srv, 'usage', [{ key, severity: 'critical', title: 'Memory of crm has climbed steadily for 6 hours: it may be leaking.' }]).fresh;
  // nobody to ask: nothing is opened (the page offers "Investigate with AI" instead)
  await investigate(app, o.orgId, s, crit('a'), settingsOf(app.db, o.orgId));
  assert.equal(all(app.db, 'SELECT 1 FROM incidents WHERE org_id = ?', o.orgId).length, 0);
  // your AI is listening through the inbox: it gets the brief, fenced as data, and the alert links to it
  run(app.db, `INSERT INTO agent_tasks (id, org_id, conversation_id, message, user_id, status, claimed_by, claimed_at) VALUES ('task_x', ?, 'cnv_x', 'm', ?, 'done', ?, ?)`, o.orgId, o.userId, o.userId, iso(Date.now()));
  await investigate(app, o.orgId, s, crit('b'), settingsOf(app.db, o.orgId));
  const inc = get<{ title: string }>(app.db, 'SELECT title FROM incidents WHERE org_id = ?', o.orgId)!;
  assert.equal(inc.title, 'Memory of crm has climbed steadily for 6 hours: it may be leaking on box');
  const task = get<{ message: string }>(app.db, `SELECT message FROM agent_tasks WHERE org_id = ? AND id != 'task_x'`, o.orgId)!;
  assert.match(task.message, /Investigate it read-only[\s\S]*Don't change anything[\s\S]*<untrusted source="the server watch">/);
  assert.ok(get<{ c: string }>(app.db, `SELECT conversation_id c FROM watch_alerts WHERE key = 'b'`)!.c);
  // a second one within 6 hours waits; a warning never triggers it; switched off, never
  await investigate(app, o.orgId, s, crit('c'), settingsOf(app.db, o.orgId));
  assert.equal(all(app.db, 'SELECT 1 FROM incidents WHERE org_id = ?', o.orgId).length, 1);
});

test('the minute tick: a ready server is sampled and its logs checked on schedule, once', async () => {
  const app = testApp();
  const { o, srv } = await server(app);
  saveXray(app.db, o.orgId, srv, 'fast', buildInventory(COOLIFY_HOST));
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, x: ExecOptions = {}) => {
    seen.push(x.stdin === SAMPLE_PROBE ? 'sample' : x.stdin === TRAFFIC_PROBE ? 'traffic' : command);
    const out = x.stdin === SAMPLE_PROBE ? probe({ host: 'cpu  1 0 0 9 0 0 0 0\ncpu  2 0 0 18 0 0 0 0\ncpus=2\nmem_total=4000000000\nmem_available=2000000000\ndisk_total=100\ndisk_used=50' }) : probe({ proxies: '', app_errors: '' });
    return { code: 0, stdout: out, stderr: '', truncated: false };
  };
  const busy = new Set<string>();
  tick(app, busy);
  tick(app, busy); // still running: not started twice
  for (let i = 0; i < 50 && busy.size; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen.sort(), ['sample', 'traffic']);
  assert.ok(get(app.db, 'SELECT 1 FROM usage_points WHERE server_id = ?', srv));
  assert.ok(get(app.db, 'SELECT 1 FROM traffic_windows WHERE server_id = ?', srv));
  tick(app, busy); // just ran: not due
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, 2);
  saveSettings(app.db, o.orgId, { usage: false, traffic: false, logs: false, findings: false });
});

test('plain words for what cleared, and Traefik’s routers named by their domains', async () => {
  assert.equal(subjectOf({ scope: 'coolify:crm', name: 'crm', metric: 'mem' }), 'crm’s memory');
  assert.equal(subjectOf({ scope: 'server', metric: 'cpu' }), 'The server’s CPU');
  assert.equal(subjectOf({ scope: 'server', metric: 'disk' }), 'The disk');
  const app = testApp();
  const { o, srv } = await server(app);
  saveXray(app.db, o.orgId, srv, 'fast', buildInventory(COOLIFY_HOST));
  const now = new Date();
  const stamp = `${String(now.getUTCDate()).padStart(2, '0')}/${now.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}/${now.getUTCFullYear()}:${now.toISOString().slice(11, 19)} +0000`;
  const line = `198.51.100.8 - - [${stamp}] "GET / HTTP/1.1" 200 17 "-" "Mozilla/5.0 Chrome/120" 1 "https-0-shopapp01@docker" "http://10.0.1.5:3000" 5ms`;
  ssh(app).exec = async (_s, _c, x: ExecOptions = {}) => ({ code: 0, stdout: x.stdin === TRAFFIC_PROBE ? probe({ proxies: 'coolify-proxy', traefik_args: JSON.stringify(['--accesslog=true']), traefik_log: [line, line, line].join('\n') }) : '', stderr: '', truncated: false });
  const r = await trafficServer(app, get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', srv));
  assert.deepEqual(r.summary.hosts, [{ host: 'shop.example.com', n: 3, s5xx: 0 }]);
});
