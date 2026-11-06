// V2, the Call Inspector. These replay made-up traffic through the real parser and detectors: each pattern must be found, and each
// look-alike that isn't a problem must stay quiet, because false alarms are the biggest risk here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { dockerAvailable } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { Redactor } from '../src/redact.ts';
import { testApp, testOrg, ok } from './helpers.ts';
import { id, run, get } from '../src/db.ts';
import { analyze, parseHit, parseLog, queryOf, type Hit } from '../src/sentinel/traffic.ts';
import { clientQuality, detect, duplicates, fanOut, longWay, manyCalls, oversized, polling, refused, regularity, retryStorm, topTwoShare, uncached, type Context } from '../src/inspect/detectors.ts';
import { digestLog, fireMinutes, forecast, outsideCalls, outsideDetections, overlaps, patternOf } from '../src/inspect/logs.ts';
import { databaseWindow, dbDetections, graduate, inspectWindow, learning, parseStmts, saveSignals, signalsOf, type Stmt } from '../src/inspect/index.ts';
import { readRow, fixCheck, METRICS } from '../src/handoff/store.ts';
import { unusedStackParts } from '../src/care/reduce.ts';
import type { Inventory } from '../src/discovery/xray.ts';

const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', T0 = Date.UTC(2026, 10, 6, 10);
const hit = (over: Partial<Hit>): Hit => ({ at: T0, ip: '203.0.113.5', method: 'GET', host: 'app.example.com', path: '/api/x', status: 200, ua: CHROME, ms: 20, bytes: 2000, fine: true, ...over });
const ctx = (over: Partial<Context> = {}): Context => ({ minutes: 60, requests: 10_000, self: ['198.51.100.1'], fine: true, ...over });

test('W0: size, referer, query shape and a keyed hash from each log, and the query itself never stays', () => {
  const salt = randomBytes(16);
  const t = parseHit(JSON.stringify({ ClientHost: '203.0.113.5', RequestMethod: 'GET', RequestHost: 'app.example.com', RequestPath: '/rest/v1/profiles?id=eq.5&select=*', DownstreamStatus: 200, DownstreamContentSize: 1234, Duration: 5e6, StartUTC: '2026-11-06T10:00:00.123456789Z', 'request_User-Agent': CHROME, request_Referer: 'https://app.example.com/dashboard?secret=1' }), salt)!;
  assert.equal(t.bytes, 1234); assert.equal(t.ref, '/dashboard'); assert.equal(t.qs, 'id=eq&select'); assert.equal(t.path, '/rest/v1/profiles'); assert.equal(t.fine, true); assert.equal(new Date(t.at).getUTCMilliseconds(), 123);
  assert.ok(!JSON.stringify(t).includes('eq.5') && !JSON.stringify(t).includes('secret'), 'no value stays');
  const other = parseHit(JSON.stringify({ ClientHost: '1.1.1.1', RequestMethod: 'GET', RequestPath: '/rest/v1/profiles?id=eq.6&select=*', DownstreamStatus: 200, StartUTC: '2026-11-06T10:00:00Z' }), salt)!;
  assert.equal(other.qs, t.qs, 'same shape'); assert.notEqual(other.qh, t.qh, 'a different value');
  assert.equal(queryOf('/x?a=1', randomBytes(16)).qh === queryOf('/x?a=1', randomBytes(16)).qh, false, 'the hash means nothing outside this read');
  const ca = parseHit(JSON.stringify({ msg: 'handled request', ts: 1793000000.5, status: 200, size: 99, duration: 0.01, request: { client_ip: '203.0.113.5', method: 'GET', host: 'app.example.com', uri: '/a?b=1', headers: { 'User-Agent': [CHROME], Referer: ['https://other.site/x'] } } }), salt)!;
  assert.equal(ca.bytes, 99); assert.equal(ca.ref, undefined, 'another site’s page says nothing'); assert.equal(ca.qs, 'b'); assert.equal(ca.fine, true);
  const clf = parseHit('203.0.113.5 - - [06/Nov/2026:10:00:00 +0000] "GET /a/b?c=1 HTTP/1.1" 200 5120 "https://app.example.com/page" "curl/8" 12 "r@file" "http://x" 7ms', salt)!;
  assert.equal(clf.bytes, 5120); assert.equal(clf.ms, 7); assert.equal(clf.ua, 'curl/8'); assert.equal(clf.fine, undefined, 'a one-second clock');
  assert.equal(parseLog('203.0.113.5 - - [06/Nov/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 - "-" "x"').hits[0]!.bytes, undefined);
});

test('W1: visitors hidden behind an inside address are counted apart, and your own apps don’t turn detection off', () => {
  const q = clientQuality([...Array.from({ length: 60 }, () => hit({ ip: '10.0.1.1' })), ...Array.from({ length: 40 }, () => hit({})), ...Array.from({ length: 900 }, () => hit({ ip: '10.0.1.1', ua: 'node' }))], ['198.51.100.1']);
  assert.equal(q.maskedShare, 0.6); assert.equal(q.internalShare, 0.9);
  const gap = Array.from({ length: 60 }, (_, i) => hit({ at: T0 + i * 25_000, path: '/api/n' }));
  assert.equal(polling([...gap, ...Array.from({ length: 900 }, (_, i) => hit({ ip: '10.0.1.1', ua: 'node', at: T0 + i }))], ctx()).length, 1, 'a server full of internal calls still sees real visitors');
});

test('the timer maths: steady scores high, random scores low, and a tab that slows down still counts', () => {
  assert.ok(regularity([5000, 5001, 4999, 5000, 5002, 5000, 4998]) > 0.9);
  const random = [1000, 40_000, 3000, 90_000, 500, 12_000, 7000, 60_000, 200, 33_000];
  assert.ok(regularity(random) < 0.7, String(regularity(random)));
  assert.ok(topTwoShare([5000, 5000, 5000, 60_000, 60_000, 5000, 60_000, 5000]) >= 0.8);
  assert.ok(topTwoShare(random) < 0.5);
});

const poll = (ip: string, gap: number, n: number, over: Partial<Hit> = {}) => Array.from({ length: n }, (_, i) => hit({ ip, at: T0 + i * gap, path: '/api/notifications', qh: 'same', ...over }));

test('W2 polling: found, and the honest look-alikes stay quiet', () => {
  const d = polling([...poll('203.0.113.5', 5000, 130), ...poll('203.0.113.6', 5000, 130)], ctx());
  assert.equal(d.length, 1); assert.match(d[0]!.title, /every 5\.0 s/); assert.equal(d[0]!.numbers.clients, 2); assert.equal(d[0]!.confidence, 'high'); assert.match(d[0]!.plain, /about 17,280 calls a day/);
  assert.deepEqual(polling(poll('203.0.113.5', 5000, 20), ctx()), [], 'a few minutes in one tab isn’t news');
  assert.deepEqual(polling(poll('203.0.113.5', 30_000, 60, { ms: 25_000 }), ctx()), [], 'long-polling waits on purpose');
  assert.deepEqual(polling(poll('203.0.113.5', 5000, 200, { ua: 'Uptime Robot monitor' }), ctx()), [], 'a monitor isn’t your site');
  assert.deepEqual(polling(poll('203.0.113.5', 5000, 200, { ua: 'Unit7 uptime check' }), ctx()), []);
  const random = Array.from({ length: 80 }, (_, i) => hit({ at: T0 + Math.floor((i * i * 997) % 3_000_000), path: '/api/n' }));
  assert.deepEqual(polling(random, ctx()), [], 'a person clicking around has no rhythm');
  const hb = polling([...poll('203.0.113.5', 15_000, 120, { path: '/wp-admin/admin-ajax.php' }), ...poll('203.0.113.6', 15_000, 120, { path: '/wp-admin/admin-ajax.php' })], ctx());
  assert.equal(hb[0]!.severity, 'low'); assert.match(hb[0]!.title, /WordPress’s Heartbeat/, 'named, not alarmed');
  assert.deepEqual(polling(poll('203.0.113.5', 5000, 130), ctx({ quiet: [[T0 - 1000, T0 + 7_200_000]] })), [], 'just after a deploy, tabs reconnect');
});

test('W3 duplicates: only with a clock fine enough, and a failed first try is a retry, not a duplicate', () => {
  const twice = (i: number, ms = 200, status = 200) => [hit({ at: T0 + i * 60_000, qh: `q${i}`, path: '/api/me' }), hit({ at: T0 + i * 60_000 + ms, qh: `q${i}`, path: '/api/me', status })];
  const pairs = Array.from({ length: 30 }, (_, i) => twice(i)).flat();
  assert.equal(duplicates(pairs, ctx()).length, 1); assert.equal(duplicates(pairs, ctx())[0]!.numbers.pairs, 30);
  assert.deepEqual(duplicates(pairs, ctx({ fine: false })), [], 'a one-second clock can’t see this');
  assert.deepEqual(duplicates(Array.from({ length: 30 }, (_, i) => [hit({ at: T0 + i * 60_000, qh: `q${i}`, path: '/api/me', status: 500 }), hit({ at: T0 + i * 60_000 + 200, qh: `q${i}`, path: '/api/me' })]).flat(), ctx()), []);
  const post = duplicates(Array.from({ length: 4 }, (_, i) => [hit({ method: 'POST', at: T0 + i * 60_000, path: '/api/order', qh: 'q' }), hit({ method: 'POST', at: T0 + i * 60_000 + 300, path: '/api/order', qh: 'q' })]).flat(), ctx());
  assert.equal(post[0]!.confidence, 'low'); assert.match(post[0]!.title, /double submit/);
});

test('W4 one page, many calls: different ids in a burst, not pagination, not images', () => {
  const burst = (i: number, n = 40, over: Partial<Hit> = {}) => Array.from({ length: n }, (_, k) => hit({ at: T0 + i * 120_000 + k * 20, path: '/rest/v1/items', qs: 'id=eq', qh: `q${i}-${k}`, ms: 30, ref: '/orders', ...over }));
  const d = manyCalls(Array.from({ length: 6 }, (_, i) => burst(i)).flat(), ctx({ requests: 2000 }));
  assert.equal(d.length, 1); assert.match(d[0]!.title, /about 40 calls to fetch 40 items/); assert.match(d[0]!.plain, /from \/orders/); assert.equal(d[0]!.confidence, 'high');
  assert.deepEqual(manyCalls(Array.from({ length: 6 }, (_, i) => burst(i, 40, { qs: 'page&limit' })).flat(), ctx({ requests: 2000 })), [], 'pagination');
  assert.deepEqual(manyCalls(Array.from({ length: 6 }, (_, i) => burst(i, 40, { path: '/_next/image', qs: 'url' })).flat(), ctx({ requests: 2000 })), [], 'a gallery');
  assert.deepEqual(manyCalls(Array.from({ length: 6 }, (_, i) => burst(i, 40, { qh: 'same' })).flat(), ctx({ requests: 2000 })), [], 'the same call repeated is W3, not this');
  assert.deepEqual(manyCalls(burst(0), ctx({ requests: 2000 })), [], 'once is a blip');
});

test('W5 refused: stale tabs and dead routes get different words, and bots probing don’t count', () => {
  const stale = refused([...Array.from({ length: 30 }, (_, i) => hit({ at: T0 + i * 1000, path: '/api/me', status: 401 })), hit({ ip: '203.0.113.9', path: '/api/me', status: 200 })], ctx());
  assert.equal(stale.length, 1); assert.match(stale[0]!.plain, /likely old tabs or an expired sign-in/);
  const dead = refused(Array.from({ length: 30 }, (_, i) => hit({ ip: `203.0.113.${i % 5}`, at: T0 + i * 1000, path: '/api/old', status: 404 })), ctx());
  assert.match(dead[0]!.plain, /works for nobody/); assert.match(dead[0]!.hypotheses[0]!, /renamed or removed/);
  assert.deepEqual(refused(Array.from({ length: 30 }, (_, i) => hit({ at: T0 + i, path: '/wp-login.php', status: 404, ua: undefined })), ctx()), [], 'a scanner');
  assert.deepEqual(refused(Array.from({ length: 19 }, (_, i) => hit({ at: T0 + i, path: '/api/me', status: 401 })), ctx()), []);
  assert.match(refused([hit({ path: '/auth/v1/token', status: 429, method: 'POST' })], ctx())[0]!.title, /rate limit/, 'any 429 here matters');
});

test('W6 retry storm: no back-off is the finding; growing gaps are healthy', () => {
  const storm = (ip: string, gap: (k: number) => number, base: number) => { let at = base; return Array.from({ length: 6 }, (_, k) => { at += gap(k); return hit({ ip, at, path: '/api/pay', status: 503 }); }); };
  const hot = [0, 1, 2].flatMap((i) => storm('203.0.113.5', () => 500, T0 + i * 120_000));
  assert.equal(retryStorm(hot, ctx()).length, 1);
  assert.deepEqual(retryStorm([0, 1, 2].flatMap((i) => storm('203.0.113.5', (k) => 500 * 2 ** k, T0 + i * 120_000)), ctx()), [], 'TanStack-style back-off');
  assert.deepEqual(retryStorm(storm('203.0.113.5', () => 500, T0), ctx()), [], 'one burst from one client is a blip');
});

test('W7 oversized and W8 same file', () => {
  const big = oversized(Array.from({ length: 10 }, (_, i) => hit({ at: T0 + i, path: '/rest/v1/orders', bytes: 2_000_000, ms: 300 })), ctx());
  assert.match(big[0]!.title, /2\.0 MB/); assert.match(big[0]!.hypotheses[0]!, /1,000-row cap/);
  assert.deepEqual(oversized(Array.from({ length: 10 }, () => hit({ path: '/storage/v1/object/x.png', bytes: 2e6, ms: 300 })), ctx()), [], 'media');
  assert.deepEqual(oversized(Array.from({ length: 10 }, () => hit({ path: '/app.js', bytes: 2e6, ms: 300 })), ctx()), []);
  const files = Array.from({ length: 120 }, (_, i) => hit({ ip: `203.0.113.${i % 8}`, path: '/logo.png', bytes: 50_000 }));
  assert.equal(uncached(files, ctx()).length, 1);
  assert.deepEqual(uncached(files.map((h, i) => (i % 5 ? h : { ...h, status: 304 })), ctx()), [], 'browsers are revalidating, so caching works');
  assert.deepEqual(uncached(files.map((h) => ({ ...h, path: '/_next/static/a.js' })), ctx()), []);
});

test('W9 long way round, and a schedule fanning out', () => {
  const inside = longWay(Array.from({ length: 200 }, (_, i) => hit({ ip: '10.0.1.1', ua: 'node', at: T0 + i, path: '/api/data' })), ctx());
  assert.equal(inside.length, 1); assert.equal(inside[0]!.confidence, 'medium');
  assert.deepEqual(longWay(Array.from({ length: 200 }, (_, i) => hit({ ip: '10.0.1.1', ua: 'node', at: T0 + i, path: '/api/cron/daily' })), ctx()), [], 'a cron route is meant to');
  const quiet = Array.from({ length: 60 }, (_, m) => Array.from({ length: 5 }, () => hit({ at: T0 + m * 60_000 + 5000 }))).flat();
  const burst = Array.from({ length: 100 }, () => hit({ at: T0 + 30 * 60_000 + 100, path: '/api/sync' }));
  assert.match(fanOut([...quiet, ...burst], ctx())[0]!.title, /:30/); assert.deepEqual(fanOut(quiet, ctx()), []);
});

test('the shared guards: a whole-window replay on normal traffic says nothing', () => {
  const hits: Hit[] = [];
  let seed = 42; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 4000; i++) hits.push(hit({ ip: `203.0.113.${Math.floor(rnd() * 200)}`, at: T0 + Math.floor(rnd() * 3_600_000), path: ['/', '/pricing', '/api/me', '/orders', '/about'][Math.floor(rnd() * 5)]!, qh: `q${i}`, bytes: 8000 }));
  assert.deepEqual(detect(hits, ctx({ requests: hits.length })).map((d) => d.detector), []);
});

test('W10, W11: only the difference between snapshots counts, and internal queries are left out', () => {
  const s = (id: string, calls: number, ms: number, rows: number, query: string): Stmt => ({ id, calls, ms, rows, query });
  const prev = [s('1', 100, 100, 100, 'select * from profiles where id = $1'), s('2', 5, 5, 0, 'select * from realtime.list_changes($1)'), s('3', 10, 100, 50_000, 'select * from orders'), s('4', 9000, 1, 9000, 'select 1 from x')];
  const cur = [s('1', 20_100, 60_100, 20_100, 'select * from profiles where id = $1'), s('2', 900_000, 5, 0, 'select * from realtime.list_changes($1)'), s('3', 30, 300, 150_000, 'select * from orders'), s('4', 5, 1, 5, 'select 1 from x')];
  const d = dbDetections(prev, cur, { requests: 1000, part: 'p', serverId: 's', minutes: 60 });
  assert.deepEqual(d.map((x) => x.detector).sort(), ['db-big', 'db-many']);
  assert.match(d.find((x) => x.detector === 'db-many')!.title, /about 20 times/); assert.match(d.find((x) => x.detector === 'db-many')!.plain, /Likely, not proven/);
  assert.match(d.find((x) => x.detector === 'db-big')!.title, /5,000 rows/);
  assert.deepEqual(parseStmts([['1', '2', '3.5', '4', 'select 1'], ['bad']]), [{ id: '1', calls: 2, ms: 3.5, rows: 4, query: 'select 1' }]);
});

test('W13 the digest folds lines into patterns, W14 outside services', () => {
  assert.equal(patternOf('2026-11-06T10:00:00Z fetched 42 rows for user 9f8e7d6c5b4a in 120ms from 10.0.0.1'), '<time> fetched <n> rows for user <hex> in <n> from <ip>');
  const log = Array.from({ length: 500 }, (_, i) => `2026-11-06T10:00:${String(i % 60).padStart(2, '0')}Z sync order ${i} done`).join('\n') + '\n' + Array.from({ length: 5 }, (_, i) => `Error: request ${i} failed`).join('\n');
  const d = digestLog(log);
  assert.equal(d.lines, 505); assert.equal(d.patterns[0]!.n, 500); assert.equal(d.patterns[1]!.errors, true); assert.ok(d.patterns.length <= 3, 'a page of patterns, not 505 lines');
  const text = Array.from({ length: 20 }, () => 'POST https://api.carrier.example/track failed with status 403').join('\n') + '\nGET https://api.ok.com/x status 200\nfetch https://api.stripe.com/v1 ECONNRESET\nno host status 500';
  const o = outsideCalls(text, ['crm.example.com']);
  assert.deepEqual(o.map((x) => [x.host, x.failed]), [['api.carrier.example', 20], ['api.stripe.com', 1], ['api.ok.com', 0]]);
  const f = outsideDetections(o, 'CRM', 12);
  assert.equal(f.length, 1); assert.equal(f[0]!.title, 'carrier refuses every call'); assert.equal(f[0]!.who, 'you'); assert.match(f[0]!.plain, /20 of 20/); assert.match(f[0]!.hypotheses[0]!, /key has expired/);
  assert.deepEqual(outsideCalls('https://crm.example.com/x status 500', ['example.com']), [], 'your own address isn’t an outside service');
});

test('W12 what runs when', () => {
  assert.deepEqual(fireMinutes('0 * * * *'), [0]); assert.deepEqual(fireMinutes('*/15 * * * *'), [0, 15, 30, 45]); assert.deepEqual(fireMinutes('5,35 2 * * *'), [5, 35]); assert.deepEqual(fireMinutes('@daily'), [0]); assert.deepEqual(fireMinutes('@reboot'), []); assert.deepEqual(fireMinutes('1-3 * * * *'), [1, 2, 3]);
  const jobs = [{ name: 'a', schedule: '0 * * * *', where: 'x' }, { name: 'b', schedule: '*/30 * * * *', where: 'x' }, { name: 'c', schedule: '0 3 * * *', where: 'y' }, { name: 'off', schedule: '0 * * * *', where: 'y', enabled: false }, { name: 'd', schedule: '* * * * *', where: 'y' }];
  assert.deepEqual(overlaps(jobs), [{ minute: 0, names: ['a', 'b', 'c'] }], 'every-minute jobs overlap with everything, so they don’t count');
});

test('F4 trouble forecast: a steady climb warns, noise and short runs don’t', () => {
  const day = 86400_000, climb = Array.from({ length: 24 * 7 }, (_, i) => ({ at: T0 + i * 3600_000, v: 1e9 + i * 20e6 }));
  const f = forecast(climb, 6e9)!;
  assert.ok(f.days > 0 && f.days < 30, String(f.days));
  assert.equal(forecast(climb.slice(0, 20), 6e9), undefined, 'too few points');
  assert.equal(forecast(climb.map((p, i) => ({ ...p, v: 1e9 + ((i * 7919) % 100) * 1e7 })), 6e9), undefined, 'noise');
  assert.equal(forecast(climb.map((p, i) => ({ ...p, v: 3e9 - i * 1e6 })), 6e9), undefined, 'falling');
  assert.equal(forecast(climb, 400e9), undefined, 'over two months away is not news'); assert.ok(day);
});

test('R7 a part of a stack nobody called, only after a whole counted week', () => {
  const inv = { parts: [{ id: 'sb', kind: 'app', name: 'Supabase CRM', product: { id: 'supabase', name: 'Supabase' }, hosts: ['db.example.com'], internals: [{ name: 'realtime-abc', image: 'x', state: 'running' }, { name: 'storage-abc', image: 'x', state: 'running' }] }] } as unknown as Inventory;
  const now = T0, w = (d: number, stack: Record<string, Record<string, number>>) => ({ at: new Date(now - d * 86400_000).toISOString(), stack });
  const r = unusedStackParts('s', 'vps', inv, [w(7, { 'db.example.com': { rest: 100, storage: 5 } }), w(1, { 'db.example.com': { rest: 100 } })], now);
  assert.equal(r.length, 1); assert.match(r[0]!.title, /Realtime in Supabase CRM had no calls/); assert.equal(r[0]!.safe, false);
  assert.deepEqual(unusedStackParts('s', 'vps', inv, [w(2, { 'db.example.com': { rest: 100 } })], now), [], 'two days isn’t a week');
  assert.deepEqual(unusedStackParts('s', 'vps', inv, [w(7, {}), w(1, {})], now), [], 'no sign the stack is being counted');
  assert.equal(analyze([hit({ path: '/realtime/v1/x' }), hit({ path: '/rest/v1/y' })], { now: T0 + 1000, minutes: 60, anonKnown: false }).stack?.['app.example.com']?.realtime, 1);
});

const world = async () => { const app = testApp(); const o = await testOrg(app); run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES ('srv_calls0000001', ?, 'vps', '198.51.100.1', 'credential://x', 'ready')`, o.orgId); return { app, o, s: { id: 'srv_calls0000001', org_id: o.orgId, name: 'vps', host: '198.51.100.1' } }; };

test('silent first: nothing shows for a week, a signal must repeat in different hours, and a person can look early', async () => {
  const { app, o, s } = await world();
  const d = polling([...poll('203.0.113.5', 5000, 130), ...poll('203.0.113.6', 5000, 130)], ctx())[0]!;
  saveSignals(app.db, o.orgId, s.id, [d], new Date(T0).toISOString());
  assert.equal(signalsOf(app.db, o.orgId, T0)[0]!.shown, false);
  assert.equal(learning(app.db, o.orgId, T0).active, true);
  saveSignals(app.db, o.orgId, s.id, [d], new Date(T0 + 1000).toISOString()); saveSignals(app.db, o.orgId, s.id, [d], new Date(T0 + 2000).toISOString());
  assert.equal(signalsOf(app.db, o.orgId, T0 + 8 * 86400_000 - 3 * 86400_000)[0]!.windows, 3);
  assert.equal(signalsOf(app.db, o.orgId, T0 + 3000)[0]!.hours, 1, 'three windows inside one hour');
  saveSignals(app.db, o.orgId, s.id, [d], new Date(T0 + 3600_000).toISOString());
  assert.equal(signalsOf(app.db, o.orgId, T0 + 3700_000)[0]!.shown, false, 'still in its silent week');
  assert.equal(signalsOf(app.db, o.orgId, T0 + 3700_000 + 7 * 86400_000)[0]!.shown, false, 'and a week-old signal has gone stale');
  saveSignals(app.db, o.orgId, s.id, [d], new Date(T0 + 7.1 * 86400_000).toISOString());
  assert.equal(signalsOf(app.db, o.orgId, T0 + 7.1 * 86400_000)[0]!.shown, true, 'a week on and still happening');
  run(app.db, `UPDATE orgs SET safety = '{"inspector":"show"}' WHERE id = ?`, o.orgId);
  assert.equal(learning(app.db, o.orgId, T0).active, false);
  assert.equal((await o.a('inspect.show', { show: true })).status === 'ok', false, 'only a person');
  assert.equal(ok<{ learning: boolean; shown: unknown[] }>(await o.h('inspect.list', {})).learning, false);
});

test('a finding from the inspector: the fix check reads the same route before and after, and the win is in real numbers', async () => {
  const { app, o, s } = await world();
  run(app.db, `UPDATE orgs SET safety = '{"inspector":"show"}' WHERE id = ?`, o.orgId);
  const d = polling([...poll('203.0.113.5', 5000, 130), ...poll('203.0.113.6', 5000, 130)], ctx())[0]!;
  const nowMs = Date.now(), at = (h: number) => new Date(nowMs + h * 3600_000).toISOString();
  for (const h of [-5, -4, -3]) saveSignals(app.db, o.orgId, s.id, [d], at(h));
  const sig = signalsOf(app.db, o.orgId, nowMs)[0]!;
  assert.equal(sig.shown, true);
  const r = graduate(app.db, o.orgId, sig, 10_000, 60);
  assert.equal(r.check.kind, 'metric'); assert.equal(r.check.before, 26); assert.equal(r.check.target, 5); assert.equal(r.numbers.perHour, 260); assert.equal(r.schema, 'unit7.finding/1');
  run(app.db, `UPDATE findings SET server_id = ?, status = 'watching', deployed_at = ? WHERE id = ?`, s.id, at(-30), r.id);
  // after the deploy: the same route, far fewer calls
  const after = [...poll('203.0.113.5', 600_000, 6), ...Array.from({ length: 4000 }, (_, i) => hit({ ip: `203.0.113.${i % 200}`, at: T0 + i, path: '/orders', qh: `q${i}` }))];
  inspectWindow(app, s, after, 60, nowMs - 26 * 3600_000);
  assert.equal(get<{ calls: number }>(app.db, 'SELECT calls FROM finding_points WHERE finding_id = ?', r.id)!.calls, 6);
  fixCheck(app, o.orgId, nowMs);
  const row = readRow(app.db, o.orgId, r.id)!;
  assert.equal(row.status, 'fixed'); assert.equal(row.win, 'Calls fell from 260 to 6 an hour.');
  assert.ok(METRICS.polling);
  assert.ok(id);
});

test('real Docker: pg_stat_statements read from a real Postgres, and a query repeated between two snapshots shows up', { skip: !dockerAvailable() && 'Docker isn’t available here', timeout: 120_000 }, async () => {
  const c = `unit7-stats-${id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a')}`;
  spawnSync('docker', ['run', '-d', '--name', c, '-e', 'POSTGRES_PASSWORD=x', 'postgres:16-alpine', '-c', 'shared_preload_libraries=pg_stat_statements'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 80 && spawnSync('docker', ['exec', c, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 1000));
    execFileSync('docker', ['exec', c, 'psql', '-U', 'postgres', '-c', 'create extension pg_stat_statements; create table items (id int); insert into items select generate_series(1, 2000); select count(*) from (select * from items) x;']);
    execFileSync('docker', ['exec', c, 'psql', '-q', '-U', 'postgres', '-c', 'select * from items', '-o', '/dev/null']);
    const { app, o, s } = await world();
    ssh(app).exec = ((_s: unknown, command: string) => new Promise((resolve) => {
      const p = spawn('sh', ['-c', command]); let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, truncated: false }));
    })) as never;
    const ctx2 = { app, db: app.db, orgId: o.orgId, redactor: new Redactor(), progress() {}, signal: undefined } as never, server = { ...s, facts: '{}' } as never;
    const part = { id: 'db', kind: 'database', name: 'Postgres', owner: 'coolify', trust: 'seen', engine: 'postgres', image: 'postgres:16-alpine', containers: [c], state: 'running' } as never;
    const first = await databaseWindow(ctx2, server, part);
    assert.equal(first.read, true); assert.deepEqual((first as { detections: unknown[] }).detections, [], 'one snapshot says nothing');
    run(app.db, `UPDATE pg_snapshots SET at = ? WHERE server_id = ?`, new Date(Date.now() - 3600_000).toISOString(), s.id);
    execFileSync('docker', ['exec', c, 'psql', '-q', '-U', 'postgres', '-c', 'select * from items', '-c', 'select * from items', '-c', 'select * from items', '-c', 'select * from items', '-c', 'select * from items', '-c', 'select * from items', '-c', 'select * from items', '-c', 'select * from items', '-c', 'select * from items', '-c', 'select * from items', '-c', 'select * from items', '-o', '/dev/null']);
    const second = await databaseWindow(ctx2, server, part) as { read: true; detections: { detector: string; numbers: Record<string, number> }[] };
    assert.equal(second.read, true);
    const big = second.detections.find((d) => d.detector === 'db-big');
    assert.ok(big, JSON.stringify(second.detections)); assert.equal(big.numbers.rowsPerCall, 2000);
  } finally { spawnSync('docker', ['rm', '-f', c], { stdio: 'ignore' }); }
});
