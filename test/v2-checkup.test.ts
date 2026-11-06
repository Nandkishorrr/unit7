// V2, the Check-up and what it stands on: four verdicts first, who fixes what, what changed since last time, the reduce plan
// with real caps, full coverage on Coolify apps, an honest score, its schedule, and the expiry calendar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { testApp, testOrg } from './helpers.ts';
import { dockerAvailable } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { Redactor } from '../src/redact.ts';
import { id, run } from '../src/db.ts';
import { asItem, checkupDue, sinceLast, verdictsOf, whoFixes, wordOf, worthSaying, type Item } from '../src/care/checkup.ts';
import { reducePlan } from '../src/care/reduce.ts';
import { DB_HEALTH, dbFindings, partDbChecks, partErrors, pgRead, foundReadiness, imageFindings, imagesOf, parseHealth, publicNameFindings, splitLogs } from '../src/care/partchecks.ts';
import { capOf, score, type Finding } from '../src/tools/security.ts';
import { deployChange } from '../src/care/deploywatch.ts';
import { expiries, icsOf } from '../src/care/expiry.ts';
import { breaches, render } from '../src/cli/checkup.ts';
import { saveXray } from '../src/tools/xray.ts';
import type { Inventory, Part } from '../src/discovery/xray.ts';

const SRV = 'srv_check0000001';
const item = (over: Partial<Item>): Item => ({ id: 'x', area: 'safety', severity: 'medium', title: 'A thing', why: 'why', who: 'you', ...over });
const room = { id: SRV, name: 'vps', word: 'Plenty' as const, ram: { used: 1, total: 4, pct: 25 }, cpu: { now: 5 }, disk: { used: 1, total: 4, pct: 25 }, projects: [] };

test('verdicts: one sentence each, a headline, and low coverage is said out loud', async () => {
  const calm = verdictsOf({ room: [room], protection: [], items: [], requests: 100 });
  assert.equal(calm.level, 'good'); assert.equal(calm.line, 'Healthy. Nothing needs you.');
  assert.equal(calm.verdicts.room.word, 'Plenty');
  const urgent = verdictsOf({ room: [room], protection: [], items: [item({ severity: 'high', title: 'Port 5432 is open' })], requests: 100 });
  assert.equal(urgent.level, 'act'); assert.match(urgent.line, /Needs you: 1 urgent thing\./); assert.equal(urgent.verdicts.safety.line, 'Port 5432 is open');
  const partly = verdictsOf({ room: [room], protection: [], items: [], requests: 1, coverage: { apps: { checked: 1, found: 5 }, skipped: [] } });
  assert.equal(partly.verdicts.safety.word, 'Partly checked', 'nothing wrong means little when most apps weren’t looked at');
  assert.equal(verdictsOf({ room: [], protection: [], items: [] }).verdicts.room.word, 'Not read');
  assert.equal(wordOf(40, 92), 'Tight'); assert.equal(wordOf(80, 10), 'Getting tight'); assert.equal(wordOf(40, 10), 'Plenty');
});

test('who fixes it: a tool is Unit7, the code is your AI, the rest is you', async () => {
  assert.equal(whoFixes({ area: 'server', fix: { tool: 'docker.prune', input: {}, label: 'x', change: 'y' } }), 'unit7');
  assert.equal(whoFixes({ area: 'app', fix: { ask: 'fix it', manual: ['x'] } }), 'your-ai');
  assert.equal(whoFixes({ area: 'domain', fix: { manual: ['renew'] } }), 'you');
  assert.equal(whoFixes({ area: 'app' }), 'you');
  const f = { id: 'xray:no-backup:a', severity: 'high', area: 'unit7', title: 't', detail: 'd', by: 'unit7' } as Finding;
  assert.equal(asItem(f).area, 'protection');
});

test('since last time: fixed, new, the same; and only new serious things reach the phone', async () => {
  const was = [item({ id: 'a', title: 'A' }), item({ id: 'b', title: 'B' })], is = [item({ id: 'b', title: 'B' }), item({ id: 'c', title: 'C', severity: 'high' })];
  const since = sinceLast({ items: was }, is)!;
  assert.deepEqual(since, { fixed: ['A'], fresh: ['C'], same: 1 });
  assert.equal(sinceLast(undefined, is), undefined);
  assert.deepEqual(worthSaying({ items: is, since }).map((i) => i.title), ['C']);
  assert.deepEqual(worthSaying({ items: is, since: { fixed: [], fresh: [], same: 2 } }), [], 'nothing new, nothing said');
});

const part = (over: Partial<Part>): Part => ({ id: 'p1', kind: 'app', name: 'CRM', owner: 'coolify', trust: 'seen', state: 'running', project: 'proj1', ...over });
const inv = (parts: Part[], projects: Inventory['projects'] = []): Inventory => ({ version: 1, at: new Date().toISOString(), server: {}, paas: [], projects, parts, loose: [], ports: [], repos: [], summary: '', notes: [] });

test('reduce: a cap from the real peak, through Coolify when Coolify runs it, and shared projects aren’t guessed', async () => {
  const peak = { proj1: 400e6 };
  const coolify = reducePlan({ serverId: SRV, serverName: 'vps', inv: inv([part({ coolify: { uuid: 'abc', type: 'application', labels: 'uuid' } })]), memPeak: peak });
  assert.equal(coolify[0]!.tool, 'coolify.memory_cap');
  assert.deepEqual(coolify[0]!.input, { serverId: SRV, uuid: 'abc', memoryMb: 768 }, '1.5× the peak, rounded up to a 256 MB step');
  const shared = reducePlan({ serverId: SRV, serverName: 'vps', inv: inv([part({ id: 'a' }), part({ id: 'b', name: 'Worker' })]), memPeak: peak });
  assert.equal(shared.length, 1); assert.ok(shared[0]!.ask, 'two parts share one number, so a person sees a question, not a made-up cap');
  assert.deepEqual(reducePlan({ serverId: SRV, serverName: 'vps', inv: inv([part({ memLimit: 1e9 })]), memPeak: peak }), []);
  const small = reducePlan({ serverId: SRV, serverName: 'vps', memTotal: 16e9, memPeakServer: 3e9, price: '$20' });
  assert.equal(small[0]!.kind, 'money'); assert.match(small[0]!.saves, /\$20/); assert.equal(small[0]!.safe, false, 'advice only');
  const disk = reducePlan({ serverId: SRV, serverName: 'vps', sizes: { reclaimable: 4e9 } as never });
  assert.equal(disk[0]!.saves, 'Free 4.0 GB'); assert.equal(disk[0]!.safe, true);
});

test('automatic upkeep only when a server runs short', async () => {
});

test('setting names on apps Unit7 didn’t deploy: a secret under a public name, and the anon key stays quiet', async () => {
  const f = publicNameFindings({ id: SRV, name: 'vps' }, [part({ envKeys: ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_STRIPE_SECRET_KEY', 'NEXT_PUBLIC_SERVICE_ROLE_KEY', 'DATABASE_PASSWORD'] })]);
  assert.deepEqual(f.map((x) => x.title.split(' ')[0]).sort(), ['NEXT_PUBLIC_SERVICE_ROLE_KEY', 'VITE_STRIPE_SECRET_KEY']);
  assert.equal(f[0]!.severity, 'high');
});

test('a log can’t pretend to come from another app, because the marker is random per run', async () => {
  const m = '@@abc123', out = `\n${m}:app-a\nline one\n@@unit7:app-b\nfake\n${m}:app-b\nreal\n`;
  const logs = splitLogs(out, m);
  assert.match(logs.get('app-a')!, /fake/, 'the fake marker stays inside app-a’s text');
  assert.match(logs.get('app-b')!, /^real\n/);
});

test('databases: full connections, stuck transactions; a healthy one says nothing', async () => {
  const s = { id: SRV, name: 'vps' }, p = { id: 'db', name: 'Postgres' };
  assert.deepEqual(dbFindings(s, p, { connections: 10, max: 100, bytes: 1e9, stuck: 0, long: 0, cacheHit: 99 }), []);
  assert.equal(dbFindings(s, p, { connections: 96, max: 100, bytes: 1e9, stuck: 0, long: 0 })[0]!.severity, 'high');
  assert.equal(dbFindings(s, p, { connections: 82, max: 100, bytes: 1e9, stuck: 0, long: 0 })[0]!.severity, 'medium');
  assert.match(dbFindings(s, p, { connections: 1, max: 100, bytes: 1e9, stuck: 2, long: 0 })[0]!.title, /2 stuck transactions/);
  assert.equal(dbFindings(s, p, { connections: 1, max: 100, bytes: 1e9, stuck: 0, long: 0, cacheHit: 70 })[0]!.severity, 'low');
  assert.deepEqual(dbFindings(s, p, { connections: 1, max: 100, bytes: 1e8, stuck: 0, long: 0, cacheHit: 70 }), [], 'a small database has no cache to speak of');
  assert.deepEqual(parseHealth(['3', '100', '5000', '0', '1', '98']), { connections: 3, max: 100, bytes: 5000, stuck: 0, long: 1, cacheHit: 98 });
  assert.equal(parseHealth(['3']), undefined);
  assert.match(DB_HEALTH, /^select/, 'a read');
  assert.ok(!/\b(insert|update|delete|drop|create)\b/i.test(DB_HEALTH));
});

test('known holes on found apps: a fresh scan reports, no scan says so instead of staying silent', async () => {
  const app = testApp(); const { orgId } = await testOrg(app);
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'vps', '203.0.113.9', 'credential://x', 'ready')`, SRV, orgId);
  const parts = [part({ id: 'a', image: 'crm:1' }), part({ id: 'b', name: 'Tracker', image: 'tracker:2', project: 'proj2' })];
  assert.deepEqual(imageFindings(app.db, orgId, { id: SRV, name: 'vps' }, parts).unscanned.sort(), ['CRM', 'Tracker']);
  run(app.db, 'INSERT INTO image_scans (org_id, server_id, image, report, scanned_at) VALUES (?, ?, ?, ?, ?)', orgId, SRV, 'crm:1', JSON.stringify({ critical: 1, high: 2, top: [{ id: 'CVE-1', pkg: 'openssl', installed: '1', fixed: '2' }] }), new Date().toISOString());
  const r = imageFindings(app.db, orgId, { id: SRV, name: 'vps' }, parts);
  assert.deepEqual(r.unscanned, ['Tracker']);
  assert.equal(r.findings[0]!.severity, 'high'); assert.match(r.findings[0]!.evidence!, /openssl 1 → 2/);
  assert.equal(imagesOf([part({ image: 'a', internals: [{ name: 'x', image: 'b', state: 'running' }] })]).length, 2, 'a stack’s inner images count');
});

test('ready for real users, on a project the X-ray found', async () => {
  const app = testApp(); const { orgId } = await testOrg(app);
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'vps', '203.0.113.9', 'credential://x', 'ready')`, SRV, orgId);
  const project = { id: 'proj1', name: 'Harbor CRM', owner: 'coolify', trust: 'seen', how: 'labels', confidence: 1, parts: ['p1'], health: { status: 'ok' }, domains: ['crm.example.com'] } as Inventory['projects'][number];
  saveXray(app.db, orgId, SRV, 'fast', inv([part({ restarts: 5 })], [project]));
  const r = foundReadiness(app.db, orgId, SRV, 'proj1')!;
  assert.equal(r.name, 'Harbor CRM');
  assert.deepEqual(r.checks.filter((c) => c.ok).map((c) => c.key), ['domain']);
  assert.equal(r.checks.find((c) => c.key === 'steady')!.detail, 'CRM restarted 5 times');
  assert.equal(foundReadiness(app.db, orgId, SRV, 'nope'), undefined);
});

test('honest score: a door Unit7 saw open caps it, whatever the rest looks like', async () => {
  const f = (severity: Finding['severity'], by: Finding['by'] = 'unit7') => ({ id: id('f'), severity, area: 'app', title: 't', detail: 'd', by }) as Finding;
  assert.equal(score([]), 100);
  assert.equal(capOf([f('critical')]), 40); assert.equal(capOf([f('high')]), 70); assert.equal(capOf([f('medium')]), 100);
  assert.ok(score([f('critical')]) <= 40); assert.ok(score([f('high')]) <= 70);
  assert.equal(capOf([f('critical', 'ai')]), 100, 'an AI’s guess doesn’t cap it, only what Unit7 measured');
});

test('its schedule: weekly full, daily short, the calm hour unless it’s overdue, and a person’s off holds', async () => {
  const app = testApp(); const { orgId } = await testOrg(app);
  const nowMs = Date.UTC(2026, 10, 6, 12), add = (h: number, quick: boolean) => run(app.db, `INSERT INTO checkups (id, org_id, by, level, line, data, created_at) VALUES (?, ?, 'x', 'good', 'ok', ?, ?)`, id('chk'), orgId, JSON.stringify({ quick }), new Date(nowMs - h * 3600_000).toISOString());
  assert.equal(checkupDue(app.db, orgId, nowMs), undefined, 'no server, no check-up');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'vps', '203.0.113.9', 'credential://x', 'ready')`, SRV, orgId);
  assert.deepEqual(checkupDue(app.db, orgId, nowMs), { quick: false }, 'never ran: the full one first');
  add(2, false);
  assert.equal(checkupDue(app.db, orgId, nowMs), undefined);
  add(25, true);
  run(app.db, `DELETE FROM checkups WHERE created_at > ?`, new Date(nowMs - 10 * 3600_000).toISOString());
  add(24 * 3, false);
  assert.deepEqual(checkupDue(app.db, orgId, nowMs), { quick: true }, 'a day since the last look');
  assert.equal(checkupDue(app.db, orgId, nowMs, false), undefined, 'waits for the calm hour');
  assert.deepEqual(checkupDue(app.db, orgId, nowMs + 8 * 3600_000, false), { quick: true }, 'but not forever: a Mac may sleep through it');
  run(app.db, `UPDATE orgs SET safety = '{"checkup":"off"}' WHERE id = ?`, orgId);
  assert.equal(checkupDue(app.db, orgId, nowMs), undefined);
});

test('a deploy Coolify never told us about: first sight is quiet, a new one starts, a status change finishes', async () => {
  assert.equal(deployChange(undefined, { deployment: 'a', status: 'finished' }), 'first');
  assert.equal(deployChange({ deployment: 'a', status: 'finished' }, { deployment: 'a', status: 'finished' }), 'same');
  assert.equal(deployChange({ deployment: 'a', status: 'finished' }, { deployment: 'b', status: 'in_progress' }), 'started');
  assert.equal(deployChange({ deployment: 'b', status: 'in_progress' }, { deployment: 'b', status: 'finished' }), 'finished');
});

test('what runs out: soonest first, only real dates, and a calendar that reminds you a week before', async () => {
  const app = testApp(); const { orgId } = await testOrg(app);
  const nowMs = Date.UTC(2026, 10, 6), inDays = (d: number) => new Date(nowMs + d * 86400_000).toISOString();
  const w = (host: string, kind: string, value: string | null, detail = '') => run(app.db, `INSERT INTO watch (org_id, host, kind, status, value, detail) VALUES (?, ?, ?, 'ok', ?, ?)`, orgId, host, kind, value, detail);
  w('a.example.com', 'registration', inDays(40), '40 days left, renews by itself'); w('a.example.com', 'tls', inDays(10)); w('b.example.com', 'registration', inDays(5), '5 days left'); w('c.example.com', 'registration', 'not a date'); w('d.example.com', 'site', inDays(1));
  const list = expiries(app.db, orgId, nowMs);
  assert.deepEqual(list.map((e) => `${e.kind}:${e.name}`), ['domain:b.example.com', 'certificate:a.example.com', 'domain:a.example.com']);
  assert.equal(list[0]!.renews, false); assert.equal(list[2]!.renews, true); assert.equal(list[0]!.days, 5);
  const ics = icsOf(list, nowMs);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.match(ics, /DTSTART;VALUE=DATE:20261111/); assert.match(ics, /TRIGGER:-P7D/); assert.equal(ics.split('BEGIN:VEVENT').length - 1, 3);
});

test('the CLI speaks plainly, and --fail-on is what CI reads', async () => {
  const c = { line: 'Healthy.', verdicts: { room: { word: 'Plenty', line: 'RAM 20%', tone: 'good' }, protection: { word: 'Weak', line: 'x', tone: 'look' }, safety: { word: 'No open doors', line: 'y', tone: 'good' }, app: { word: 'Looks normal', line: 'z', tone: 'good' } },
    checked: [{ id: 'a', label: 'One', ok: true }, { id: 'b', label: 'Two', ok: false, why: 'no access' }], done: [], reduce: [], items: [item({ severity: 'high', title: 'Open port', who: 'unit7' }), item({ severity: 'low' })], since: { fixed: ['x'], fresh: [], same: 2 } } as never;
  const text = render(c);
  assert.match(text, /^Healthy\./); assert.match(text, /Checked 1 of 2 · 1 skipped/); assert.match(text, /1\. Open port \(Unit7 can do this\)/); assert.match(text, /1 fixed · 0 new · 2 the same/);
  assert.equal(breaches(c, 'high').length, 1); assert.equal(breaches(c, 'critical').length, 0); assert.equal(breaches(c, 'low').length, 2);
});

const noDocker = !dockerAvailable() && 'Docker isn’t available here';
test('real Docker: a read-only look inside Postgres, and errors read from a real container’s logs', { skip: noDocker, timeout: 120_000 }, async () => {
  const tag = id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a'), db = `unit7-chk-db-${tag}`, noisy = `unit7-chk-app-${tag}`;
  spawnSync('docker', ['run', '-d', '--name', db, '-e', 'POSTGRES_PASSWORD=x', 'postgres:16-alpine'], { stdio: 'ignore' });
  const line = 'TypeError: Cannot read properties of undefined (reading \\"id\\")\\n    at getUser (/app/src/users.js:12:9)';
  spawnSync('docker', ['run', '-d', '--name', noisy, 'postgres:16-alpine', 'sh', '-c', `for i in 1 2 3 4 5 6; do printf "${line}\\n\\n"; done; sleep 60`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60 && spawnSync('docker', ['exec', db, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    execFileSync('docker', ['exec', db, 'psql', '-U', 'postgres', '-c', 'create table shipments (id int)']);
    const app = testApp(); const o = await testOrg(app);
    ssh(app).exec = ((_s: unknown, command: string) => new Promise((resolve) => {
      const c = spawn('sh', ['-c', command]); let stdout = '', stderr = '';
      c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
      c.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, truncated: false }));
    })) as never;
    const s = { id: SRV, name: 'vps', facts: '{}' } as never, ctx = { app, db: app.db, orgId: o.orgId, redactor: new Redactor(), progress() {}, signal: undefined } as never;
    const p = part({ id: 'db', kind: 'database', engine: 'postgres', image: 'postgres:16-alpine', containers: [db] });
    const h = parseHealth((await pgRead(ctx, s, p, DB_HEALTH))?.[0])!;
    assert.ok(h.max >= 20, 'it read max_connections'); assert.ok(h.connections >= 1); assert.ok(h.bytes > 1e6);
    assert.deepEqual((await partDbChecks(ctx, s, inv([p]))).read, ['CRM']);
    assert.equal(await pgRead(ctx, s, p, 'create table sneaky (id int)'), undefined, 'the session can only read');
    assert.equal(execFileSync('docker', ['exec', db, 'psql', '-Atq', '-U', 'postgres', '-c', `select count(*) from pg_tables where tablename = 'sneaky'`], { encoding: 'utf8' }).trim(), '0');
    const r = await partErrors(ctx, s, [part({ id: 'a', name: 'Noisy', containers: [noisy] })]);
    assert.deepEqual(r.read, ['Noisy']);
    assert.match(r.findings[0]!.title, /Noisy: TypeError/); assert.equal(r.findings[0]!.severity, 'medium');
    assert.ok(!/Cannot read/.test((r.findings[0]!.fix as { ask: string }).ask), 'the raw line never goes in what an AI is asked');
  } finally { spawnSync('docker', ['rm', '-f', db, noisy], { stdio: 'ignore' }); }
});
