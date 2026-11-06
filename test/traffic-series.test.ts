// The server page's traffic graph: stored checks become visits per hour (or per day) with errors, the usual band for
// each hour of the week, a gap where no check ran, the busiest pages and who's calling over the range, and deploys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { id, run } from '../src/db.ts';
import { analyze, parseLog, trafficSeries, type Hit, type Summary } from '../src/sentinel/traffic.ts';

const NOW = Date.parse('2026-10-07T12:10:00Z');
const H = 3600_000, M = 60_000;
// one half-hour check ending at `end`: n visits from people, a few from a bot and a scanner, some errors
function check(end: number, n: number, o: { errors?: number; anon?: number } = {}): Summary {
  const hits: Hit[] = [];
  for (let i = 0; i < n; i++) hits.push({ at: end - (i % 29) * M, ip: `198.51.100.${i % 50}`, method: 'GET', host: 'shop.example.com', path: i % 3 ? '/' : '/pricing', status: i < (o.errors ?? 0) ? 502 : 200, ua: 'Mozilla/5.0 Chrome/124.0', anon: i < (o.anon ?? 0) });
  hits.push({ at: end - M, ip: '192.0.2.7', method: 'GET', path: '/.env', status: 404, ua: 'zgrab/0.x', anon: true });
  hits.push({ at: end - M, ip: '192.0.2.8', method: 'GET', path: '/', status: 200, ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)', anon: true });
  return analyze(hits, { now: end, minutes: 30, anonKnown: true });
}
// four weeks of checks every half hour: 100 visits each, except none between 09:00 and 10:00 today (Unit7 was off)
const history = (): Summary[] => {
  const out: Summary[] = [];
  for (let t = NOW - 28 * 24 * H; t <= NOW; t += 30 * M) if (!(t >= Date.parse('2026-10-07T09:00Z') && t < Date.parse('2026-10-07T10:00Z'))) out.push(check(t, 100, { errors: t > NOW - 30 * M ? 9 : 0, anon: 10 }));
  return out;
};

test('traffic series: visits per hour with errors, a usual band, a gap where no check ran, totals over the range', () => {
  const s = trafficSeries(history(), '24h', NOW);
  assert.equal(s.step, '1h');
  assert.equal(s.points.length, 24);
  assert.equal(s.points.at(-1)!.at, '2026-10-07T12:00:00.000Z', 'the newest hour is the current one');
  const full = s.points.at(-3)!; // 10:00–11:00: two whole checks
  assert.equal(full.minutes, 60);
  assert.equal(full.visits, 2 * 102);
  assert.ok(full.band && Math.abs(full.band.mid - 204) <= 1, 'the usual for this hour is what this hour of the week usually sees');
  assert.ok(full.band!.lo <= 204 && full.band!.hi >= 204);
  const gap = s.points.find((p) => p.at === '2026-10-07T09:00:00.000Z')!;
  assert.equal(gap.visits, null, 'no check, no number: a gap, not a zero');
  assert.equal(gap.band, null);
  const latest = s.points.at(-1)!;
  assert.equal(latest.errors, 9, 'server errors land in their hour');
  assert.ok(latest.anon >= 10);
  // totals: every check whose middle falls in the last 24 hours
  assert.equal(s.totals.checks, s.points.reduce((n, p) => n + p.minutes, 0) / 30);
  assert.equal(s.totals.visits, s.points.reduce((n, p) => n + (p.visits ?? 0), 0));
  assert.equal(s.callers.people + s.callers.bots + s.callers.scanners, s.totals.visits, 'everyone who called is counted once');
  assert.equal(s.callers.scanners, s.totals.checks, 'one probe for /.env per check');
  assert.deepEqual(s.topPaths.slice(0, 2).map((p) => p.path), ['/', '/pricing']);
  assert.ok(s.usual && Math.abs(s.usual - s.points.reduce((n, p) => n + (p.band?.mid ?? 0), 0)) < 1);
  assert.ok(s.agents.some((a) => a.bot), 'bots are marked');
});

test('traffic series: 7 days hourly, 30 days by day without a band, nothing stored is all gaps', () => {
  const h = history();
  const week = trafficSeries(h, '7d', NOW);
  assert.equal(week.points.length, 168);
  const month = trafficSeries(h, '30d', NOW);
  assert.equal(month.step, '1d');
  assert.equal(month.points.length, 30);
  assert.ok(month.points.every((p) => p.band === null));
  assert.equal(month.usual, undefined);
  assert.equal(month.points.at(-2)!.minutes, 48 * 30, 'yesterday: 48 checks');
  assert.equal(month.points.at(-1)!.minutes, (24 + 1 - 2) * 30, 'today so far: 00:10 to 12:10, without the hour Unit7 was off');
  const none = trafficSeries([], '24h', NOW);
  assert.ok(none.points.every((p) => p.visits === null));
  assert.deepEqual(none.totals, { visits: 0, errors: 0, refused: 0, anon: 0, checks: 0, minutes: 0 });
});

test('server.traffic_series reads the stored checks of one server and marks its deploys', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const srv = id('srv'), other = id('srv');
  for (const [s, name] of [[srv, 'box'], [other, 'other']]) run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status) VALUES (?, ?, ?, '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready')`, s, o.orgId, name);
  const now = Date.now();
  for (let t = now - 30 * H; t <= now; t += 30 * M) {
    const w = check(t, 40);
    run(app.db, 'INSERT INTO traffic_windows (id, org_id, server_id, at, minutes, summary, findings) VALUES (?, ?, ?, ?, 30, ?, ?)', id('twn'), o.orgId, srv, w.at, JSON.stringify(w), '[]');
  }
  const big = check(now, 5000);
  run(app.db, 'INSERT INTO traffic_windows (id, org_id, server_id, at, minutes, summary, findings) VALUES (?, ?, ?, ?, 30, ?, ?)', id('twn'), o.orgId, other, big.at, JSON.stringify(big), '[]');
  app.events.emit(o.orgId, 'coolify.action', 'deploy of application shopapp01 through Coolify on box: finished', { resource: srv });
  const r = ok(await o.h('server.traffic_series', { serverId: srv }));
  assert.equal(r.serverName, 'box');
  assert.equal(r.points.length, 24);
  assert.ok(r.totals.visits > 0 && r.totals.visits < 5000, 'only this server’s checks');
  assert.ok(r.lastCheck);
  assert.equal(r.deploys.length, 1);
  assert.equal(r.deploys[0].kind, 'deploy');
  assert.equal(ok(await o.h('server.traffic_series', { serverId: srv, range: '30d' })).step, '1d');
  assert.equal((await o.h('server.traffic_series', { serverId: srv, range: '1y' })).status, 'error');
});

test('a visit’s query string is never kept or shown, whatever the log holds (keys and reset links travel there)', () => {
  const at = new Date(NOW - 5 * M).toISOString();
  const text = [
    JSON.stringify({ ClientHost: '198.51.100.4', RequestMethod: 'GET', RequestHost: 'db.example.com', RequestPath: '/realtime/v1/websocket?apikey=eyJsecretAnonKey123&vsn=1.0.0', DownstreamStatus: 101, time: at, RouterName: 'r' }),
    JSON.stringify({ level: 'info', msg: 'handled request', ts: (NOW - 4 * M) / 1000, request: { client_ip: '198.51.100.5', method: 'GET', host: 'app.example.com', uri: '/reset?token=resetToken987#frag' }, status: 200 }),
    `198.51.100.6 - - [07/Oct/2026:12:06:00 +0000] "GET /magic?code=magicCode555 HTTP/1.1" 200 12 "-" "curl/8.0"`,
  ].join('\n');
  const { hits } = parseLog(text);
  assert.deepEqual(hits.map((h) => h.path), ['/realtime/v1/websocket', '/reset', '/magic'], 'gone from the moment it’s read');
  const out = JSON.stringify(analyze(hits, { now: NOW, minutes: 30, anonKnown: false }));
  for (const s of ['apikey', 'eyJsecretAnonKey123', 'resetToken987', 'magicCode555', '?']) assert.ok(!out.includes(s), `nothing of it in what’s stored (${s})`);
});
