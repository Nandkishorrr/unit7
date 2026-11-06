// V2 Phase 0, the Truth pass: every number Unit7 shows has to be real. Each test here is a wrong number or a false alarm
// measured on a real install, so none of them can come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { testApp, testOrg } from './helpers.ts';
import { all, get, id, run } from '../src/db.ts';
import { execute, getTool, type Actor } from '../src/tools/runtime.ts';
import { parseSentinel, rollup, buildInventory, USAGE_PROBE } from '../src/discovery/xray.ts';
import { SAMPLE_PROBE } from '../src/sentinel/usage.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { ERROR_LINES, agentOf, analyze, isBot, trafficFindings, type Hit, type Summary } from '../src/sentinel/traffic.ts';
import { checkSites, roundVerdict } from '../src/sentinel/watch.ts';
import { blindMs, gapsIn, noteAlive, overlapMs } from '../src/sentinel/gaps.ts';
import { briefStats, composeBrief, downtimeBySite } from '../src/story/brief.ts';
import { detect, type Point, type Series } from '../src/sentinel/anomaly.ts';
import { explainFinding, subjectOf } from '../src/explain.ts';
import { rankTasks, rootOf } from '../src/tools/home.ts';
import { brainFor } from '../src/tools/routines.ts';
import { myBrain } from '../src/agent/subscription.ts';
import { ROOM_PROBE, roomVerdict } from '../src/tools/manage.ts';

const H = 3600_000, M = 60_000;
const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };

test('T1: Sentinel lists containers with no numbers when metrics are off: that is no reading, not a zero', () => {
  const rows = [{ id: 'web', cpu: null, memory: null, status: { state: 'running' } }, { id: 'db', cpu: { percent: '4.5' }, memory: { used: 1000 } }];
  assert.deepEqual([...parseSentinel(JSON.stringify(rows)).keys()], ['db']);
  // the probes only trust a list that holds numbers, else docker stats or cgroups answer
  for (const probe of [USAGE_PROBE, SAMPLE_PROBE]) assert.match(probe, /'\['\*'"percent"'\*\) s sentinel/);
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
  const name = inv.parts.flatMap((p) => p.containers ?? [])[0]!;
  const u = rollup(inv, { cpus: 4, cpu: 10, memTotal: 8e9, memUsed: 2e9, diskTotal: 1e11, diskUsed: 1e10 }, parseSentinel(JSON.stringify([{ id: name, cpu: { percent: '40' }, memory: { used: 5e8 } }])), 'sentinel');
  assert.ok(u.projects.some((p) => p.mem === 5e8), 'a real row reaches its project');
});

test('T2: a log line that answered is never an error, whatever its URL says', () => {
  const log = [
    '172.17.0.10 - - [05/Nov/2026:07:19:12 +0000] "GET /rest/v1/exceptions?select=id HTTP/1.1" 200 45200 "-" "node"',
    '10.0.2.10 - - [05/Nov/2026:19:00:07 +0000] "GET /rest/v1/subscription_state?select=answer,last_error HTTP/1.1" 200 713 "-" "node"',
    '10.0.2.10 - - [05/Nov/2026:19:00:08 +0000] "GET /errors HTTP/1.1" 404 12 "-" "node"',
    'level=info msg="no errors found"',
    '{"level":30,"msg":"error budget is fine"}',
    'TypeError: Cannot read properties of null',
    'time="2026" level=error msg="database is down"',
    '10.0.2.10 - - [05/Nov/2026:19:00:09 +0000] "GET /boom HTTP/1.1" 500 12 "-" "exception"',
  ].join('\n');
  const kept = execFileSync('/bin/sh', ['-c', `printf '%s\\n' "$LOG" | ${ERROR_LINES}`], { encoding: 'utf8', env: { ...process.env, LOG: log } }).trim().split('\n');
  assert.equal(kept.length, 3, kept.join('\n'));
  assert.match(kept[0]!, /TypeError/); assert.match(kept[1]!, /level=error/); assert.match(kept[2]!, /" 500 /);
});

const hit = (over: Partial<Hit>): Hit => ({ at: Date.now(), ip: '45.1.2.3', method: 'GET', path: '/', status: 200, ua: 'Mozilla/5.0 (Macintosh)', host: 'shop.example.com', ...over });

test('T3 and T4: Unit7 is not a person, and requests are not visitors', () => {
  assert.equal(isBot('Unit7 uptime check'), true);
  assert.equal(agentOf('Unit7 uptime check'), 'Unit7’s own checks');
  const hits = [
    ...Array.from({ length: 6 }, () => hit({ ip: '198.51.100.86', ua: 'Unit7 uptime check' })),
    ...Array.from({ length: 50 }, () => hit({ ip: '10.0.1.1', ua: 'node', path: '/rest/v1/profiles' })),
    ...Array.from({ length: 4 }, () => hit({ ip: '203.0.113.9', ua: 'curl/8.5.0', path: '/api/cron' })),
    ...Array.from({ length: 3 }, () => hit({ ip: '106.1.1.1', ua: 'okhttp/4.12' })),
    ...Array.from({ length: 9 }, () => hit({ ip: '45.1.2.3' })),
    hit({ ip: '45.9.9.9' }),
    hit({ ip: '66.1.1.1', ua: 'Googlebot/2.1' }),
  ];
  const s = analyze(hits, { minutes: 30, anonKnown: false, self: ['203.0.113.9'] });
  assert.deepEqual(s.who, { people: 10, visitors: 2, own: 54, programs: 3, bots: 1, unit7: 6 });
  assert.equal(s.requests, 74);
  assert.deepEqual(s.callers?.find((c) => c.host === 'shop.example.com')?.people, 10, 'the uptime check is no longer a person');
});

test('T5: when Unit7 itself is offline nothing about a site changes, and nobody is told a site is down', async () => {
  assert.equal(roundVerdict(13, 0, undefined), 'fine');
  assert.equal(roundVerdict(13, 13, false), 'offline');
  assert.equal(roundVerdict(13, 13, true), 'many');
  assert.equal(roundVerdict(13, 1, true), 'some');
  const app = testApp(); const o = await testOrg(app);
  const asset = (name: string) => run(app.db, 'INSERT INTO assets (id, org_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id('ast'), o.orgId, 'vercel', 'app', name, name, `https://${name}.example.com`, '{}', new Date().toISOString());
  ['a', 'b', 'c', 'd'].forEach(asset);
  const real = globalThis.fetch; let failing = true;
  globalThis.fetch = (async () => { if (failing) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); return new Response('ok'); }) as typeof fetch;
  process.env.UNIT7_ALLOW_PRIVATE_FOR_TESTS = '1';
  const events = (type: string) => all<{ message: string; severity: string }>(app.db, 'SELECT message, severity FROM events WHERE type = ?', type);
  try {
    const offline = { neutral: async () => false, inside: async () => new Set<string>() };
    for (let i = 0; i < 4; i++) await checkSites(app, o.orgId, offline);
    assert.deepEqual(events('site.down'), [], 'four rounds offline: no site is down');
    assert.equal(events('watch.offline').length, 1, 'said once');
    assert.match(events('watch.offline')[0]!.message, /says nothing about your sites/);
    // online, but this computer can't reach them while the server itself answers: most likely this computer's route
    const route = { neutral: async () => true, inside: async (hosts: string[]) => new Set(hosts) };
    for (let i = 0; i < 3; i++) await checkSites(app, o.orgId, route);
    assert.deepEqual(events('site.down'), []);
    assert.equal(events('watch.route').length, 1);
    assert.equal(events('watch.route')[0]!.severity, 'warning');
    // and when the server can't vouch for them, it's real
    const real2 = { neutral: async () => true, inside: async () => new Set<string>() };
    for (let i = 0; i < 2; i++) await checkSites(app, o.orgId, real2);
    assert.equal(events('site.down').length, 4);
  } finally { globalThis.fetch = real; failing = false; delete process.env.UNIT7_ALLOW_PRIVATE_FOR_TESTS; }
});

test('T6: uptime leaves out the hours nobody was watching, and the brief says how long that was', async () => {
  const app = testApp(); const o = await testOrg(app);
  const t0 = Date.UTC(2026, 10, 5, 0, 0);
  noteAlive(app.db, t0); noteAlive(app.db, t0 + 5 * M);
  assert.equal(gapsIn(app.db, t0 - H, t0 + H).length, 0);
  noteAlive(app.db, t0 + 9 * H);
  const gaps = gapsIn(app.db, t0, t0 + 24 * H);
  assert.equal(gaps.length, 1);
  assert.equal(blindMs(gaps), 9 * H - 5 * M);
  assert.equal(overlapMs(gaps, t0 + 2 * H, t0 + 3 * H), H);
  // a site marked down just before the Mac slept, back when it woke: only the watched minutes count
  const evs = [{ at: t0 + 3 * M, host: 'a', down: true }, { at: t0 + 9 * H + M, host: 'a', down: false }];
  assert.equal(downtimeBySite(evs, t0, t0 + 24 * H, gaps).get('a'), 3 * M, 'two minutes before, one after');
  const s = briefStats(app.db, o.orgId, t0 + 33 * H);
  assert.equal(Math.round(s.blindHours), 9);
  assert.equal(composeBrief({ ...s, sites: 1, uptime: 1 }).lines[1]!.key, 'blind');
});

test('T7 and T13: a run that changed nothing is no action, and Warden’s repeated reads keep no output', async () => {
  const app = testApp(); const o = await testOrg(app);
  assert.equal(getTool('link.autoconnect')!.idle!({ created: [] }), true);
  assert.equal(getTool('link.autoconnect')!.idle!({ created: ['a → b'] }), false);
  const r = await execute(app, o.orgId, WARDEN, 'link.autoconnect', {}, { reason: 'test' });
  assert.equal(r.status, 'ok');
  assert.equal(get(app.db, `SELECT 1 FROM audit WHERE tool = 'link.autoconnect'`), undefined, 'not an action');
  assert.equal(get(app.db, `SELECT 1 FROM events WHERE type = 'action.completed'`), undefined);
  await execute(app, o.orgId, WARDEN, 'project.list', {}, { reason: 'test' });
  const row = get<{ output: string | null }>(app.db, `SELECT output FROM audit WHERE tool = 'project.list'`);
  assert.equal(row?.output, null, 'the row says it happened; the output stays out');
});

const pts = (from: number, n: number, v: (i: number) => Partial<Point>, step = 5 * M): Point[] => Array.from({ length: n }, (_, i) => ({ at: new Date(from + i * step).toISOString(), cpu: null, mem: null, net: null, restarts: 0, oom: 0, ...v(i) }));

test('T12: above its usual but in no danger shows on the page, and stays off the phone', () => {
  const now = Date.UTC(2026, 10, 5, 12, 0);
  const hourly = Array.from({ length: 24 * 14 }, (_, i) => ({ at: new Date(now - (i + 3) * H).toISOString(), cpu: 14, mem: 2e9, net: 1e4, restarts: 0, oom: 0 }));
  const series = (recent: Point[]): Series => ({ scope: 'server', name: 'server', recent, hourly });
  const a = detect(series(pts(now - 15 * M, 3, () => ({ cpu: 29 }))), {}, now).find((x) => x.kind === 'high')!;
  assert.equal(a.quiet, true, 'CPU at 29% for 15 minutes is not worth a buzz');
  const b = detect(series(pts(now - 15 * M, 3, () => ({ cpu: 92 }))), {}, now).find((x) => x.kind === 'high')!;
  assert.equal(b.quiet, false); assert.equal(b.severity, 'critical');
  const c = detect(series(pts(now - 45 * M, 9, () => ({ cpu: 29 }))), {}, now).find((x) => x.kind === 'high')!;
  assert.equal(c.quiet, false, 'it lasted');
  const d = detect(series(pts(now - 5 * M, 1, () => ({ net: 2e6 }))), {}, now).find((x) => x.kind === 'spike')!;
  assert.equal(d.quiet, true, '2 MB/s is a small number, however many times the usual');
});

test('T11: a surge is measured against the last days too, and an empty check teaches nothing', () => {
  const at = '2026-11-05T12:01:48.675Z';
  const sum = (a: string, requests: number): Summary => ({ at: a, minutes: 30, requests, ips: 3, status: { s2xx: requests, s3xx: 0, s4xx: 0, s5xx: 0 }, topPaths: [], topAgents: [], topIps: [], hosts: [], bots: 0, scanners: { n: 0, ips: 0 }, logins: { n: 0, failed: 0, ips: 0 }, anon: { n: 0, ips: 0, how: 'headers' }, errors: [], sources: [] });
  // old weeks at this hour were quiet (the log had just been turned on), the last two days run at about 400
  const old = [3, 4, 5, 6].map((w) => sum(new Date(Date.parse(at) - w * 7 * 24 * H).toISOString(), 16));
  const lately = Array.from({ length: 48 }, (_, i) => sum(new Date(Date.parse(at) - (i + 1) * 30 * M).toISOString(), 400)).reverse();
  const c = { serverId: 'srv_1', serverName: 'box' };
  assert.deepEqual(trafficFindings(sum(at, 570), [...old, ...lately], c).filter((f) => f.id.startsWith('traffic:surge')), [], '570 is a normal half hour here');
  assert.equal(trafficFindings(sum(at, 3000), [...old, ...lately], c).filter((f) => f.id.startsWith('traffic:surge')).length, 1, 'a real surge still is one');
});

test('T9: one root cause is one row on Home', () => {
  assert.equal(rootOf('risk:domain:tls:a.example.com'), 'a.example.com');
  assert.equal(rootOf('site:down:a.example.com'), 'a.example.com');
  assert.equal(rootOf('backup:svc_1'), undefined);
  const c = (id: string, text: string) => ({ id, text, why: '', source: 'problem' as const, label: '', icon: 'alert', severity: 'alert' as const });
  const out = rankTasks([c('risk:domain:tls:a.example.com', 'Fix the certificate'), c('site:down:a.example.com', 'Get it answering'), c('site:tls:a.example.com', 'Renew it'), c('site:down:b.example.com', 'Get b answering')]);
  assert.equal(out.length, 2);
  assert.equal(out.find((t) => t.related)?.related, 2);
});

test('T10: words that were wrong', () => {
  assert.equal(subjectOf({ title: 'Anyone can send email pretending to be shop.example.com', about: { name: 'shop.example.com' } }), 'shop.example.com');
  const tls = explainFinding({ id: 'domain:tls:x.example.com', title: 'x.example.com’s HTTPS certificate is broken', severity: 'high', fix: { tool: 'watch.check', input: {}, label: 'Check again' } } as never);
  assert.doesNotMatch(tls.next, /renew it now/);
});

test('T17 and T18: nobody watching means no personal subscription, and a Gemini pick from before is simply no pick', async () => {
  const app = testApp(); const o = await testOrg(app);
  run(app.db, `UPDATE memberships SET brain = 'gemini' WHERE org_id = ? AND user_id = ?`, o.orgId, o.userId);
  assert.equal(myBrain(app, o.orgId, o.userId), undefined);
  run(app.db, `UPDATE memberships SET brain = 'claude' WHERE org_id = ? AND user_id = ?`, o.orgId, o.userId);
  assert.equal(myBrain(app, o.orgId, o.userId), 'claude');
  const scheduled = await brainFor(app, o.orgId, o.userId, 'schedule');
  assert.equal(scheduled.kind, 'none');
  assert.match((scheduled as { why: string }).why, /personal subscription only answers what you type/);
});

test('T23: a backup never fills the disk: machines keep 15% free, a person can go lower', () => {
  const GB = 1e9;
  assert.equal(roomVerdict(`${200 * GB} ${181 * GB}`, false), undefined);
  assert.match(roomVerdict(`${200 * GB} ${20 * GB}`, false)!, /only 20\.0 GB free, and Unit7 keeps 30\.0 GB free/);
  assert.equal(roomVerdict(`${200 * GB} ${20 * GB}`, true), undefined, 'a person may need that copy before a risky change');
  assert.match(roomVerdict(`${200 * GB} ${0.4 * GB}`, true)!, /only 0\.4 GB/);
  assert.equal(roomVerdict('', false), undefined, 'unreadable: the dump itself will say');
  // the probe walks up to a folder that exists, because the backup folder may not yet
  const out = execFileSync('/bin/sh', ['-c', ROOM_PROBE, 'sh', '/tmp/unit7-no-such/folder'], { encoding: 'utf8' }).trim().split(' ');
  assert.equal(out.length, 2); assert.ok(Number(out[0]) > 0);
});
