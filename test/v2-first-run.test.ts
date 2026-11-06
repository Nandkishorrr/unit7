// What V2's first run on a real server found, and no made-up data had: an alert title that could never be sent, a "usual level"
// of zero from before usage was measured right, and a temporary address's certificate called urgent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, testApp, testOrg } from './helpers.ts';
import { run } from '../src/db.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import { deliver, headerSafe } from '../src/sentinel/notify.ts';
import { detect, type Point } from '../src/sentinel/anomaly.ts';
import { levelOf, runLadder, type Guarded } from '../src/care/safetynet.ts';
import type { Unit7Event } from '../src/events.ts';

const ev = (orgId: string, type: string): Unit7Event => ({ id: 'evt', org_id: orgId, type, severity: 'critical', message: 'The backup of shop didn’t restore', project_id: null, environment_id: null,
  resource: `r-${Math.random()}`, data: {}, created_at: new Date().toISOString() });

test('every alert kind with an apostrophe in its title really gets sent (real Headers, as fetch builds them)', async () => {
  const app = testApp(), o = await testOrg(app);
  setupNtfy(app, o.orgId, o.userId);
  const titles: (string | null)[] = [];
  const send = (async (_u: string, i?: RequestInit) => { titles.push(new Headers(i?.headers).get('Title')); return new Response('{}'); }) as typeof fetch;
  for (const type of ['backup.verify_failed', 'routine.failed', 'watch.route']) assert.equal(await deliver(app, ev(o.orgId, type), (u, i) => send(u, i)), 1, type);
  assert.deepEqual(titles, ['Unit7: Backup won\'t restore', 'Unit7: Routine didn\'t work', 'Unit7: Can\'t reach your sites from here']);
});

test('a header can\'t break on any title', () => {
  assert.equal(headerSafe('Backup won’t “restore” — ok ✓'), 'Backup won\'t "restore"  ok ');
  assert.doesNotThrow(() => new Headers({ Title: headerSafe('日本語 ’') }));
});

const NOW = Date.parse('2026-11-06T05:00:00Z'), H = 3600_000, M = 60_000, iso = (t: number) => new Date(t).toISOString();
const hourly = (mem: number): Point[] => Array.from({ length: 24 * 30 }, (_, i) => ({ at: iso(NOW - (i + 3) * H), cpu: 10, cpuMax: 12, mem, memMax: mem, net: 1e3, netMax: 2e3, restarts: 0, oom: 0 }));
const recent = (mem: number): Point[] => Array.from({ length: 12 }, (_, i) => ({ at: iso(NOW - (11 - i) * 5 * M), cpu: 10, mem, net: 1e3, restarts: 0, oom: 0 }));
const series = (usual: number) => ({ scope: 'coolify:demo-crm', name: 'Demo CRM', recent: recent(1.6e9), hourly: hourly(usual) });

test('memory that was never measured is no baseline: no "1561759744× its usual level"', () => {
  assert.deepEqual(detect(series(0), { memTotal: 16e9 }, NOW).filter((a) => a.metric === 'mem'), []);
});
test('memory measured all along still gets noticed', () => {
  const [a] = detect(series(400e6), { memTotal: 16e9 }, NOW).filter((x) => x.metric === 'mem');
  assert.match(a!.reason, /Memory of Demo CRM is 4× its usual level/);
});

test('a temporary address’s certificate isn’t urgent, and a real domain’s still is', async () => {
  const app = testApp(), o = await testOrg(app), at = new Date().toISOString();
  run(app.db, `INSERT INTO watch (org_id, host, kind, status, detail, checked_at) VALUES (?, 'abc.203.0.113.9.sslip.io', 'tls', 'broken', 'DEPTH_ZERO_SELF_SIGNED_CERT', ?), (?, 'shop.example.com', 'tls', 'broken', 'expired', ?)`, o.orgId, at, o.orgId, at);
  const ids = ok<{ findings: { id: string }[] }>(await o.h('security.check', {})).findings.map((f) => f.id).filter((x) => x.startsWith('domain:tls:'));
  assert.deepEqual(ids, ['domain:tls:shop.example.com']);
});

const recentAt = new Date(Date.now() - 3600_000).toISOString(), later = new Date().toISOString();
test('a failed test restore shows until a later one works', () => {
  const failed = { at: recentAt, off: { local: '/x' }, verifiedAt: recentAt, verifyOk: 0, verifyNote: '2 of 166 tables came back short' };
  assert.equal(levelOf([failed], undefined).failed, '2 of 166 tables came back short');
  assert.equal(levelOf([failed], undefined).level, 'protected', 'the copy is still off the server');
  assert.equal(levelOf([{ ...failed, verifiedAt: later, verifyOk: 1 }, failed], undefined).failed, undefined);
  assert.equal(levelOf([{ at: recentAt, off: { local: '/x' } }], undefined).failed, undefined, 'never tried isn’t failed');
});

test('a test restore that comes back short doesn’t stop files and settings being copied, and the run still counts as failed', async () => {
  const app = testApp(), o = await testOrg(app), tools: string[] = [];
  const g = { key: 'k', serverId: '', serverName: 'box', part: 'p', name: 'demo-db', engine: 'postgres', important: true, why: [], by: 'unit7', level: 'protected', copies: { here: 1, off: 1, mine: 1 }, lastCopy: recentAt, provenAt: null, where: [], schedule: { frequency: 'daily', keep: 7 }, extrasAt: null, next: '' } as unknown as Guarded;
  const act = (async (_o: string, tool: string) => { tools.push(tool); return tool === 'part.verify' ? { status: 'error', error: { code: 'bad_backup', message: 'came back short' } } : { status: 'ok', output: {} }; }) as never;
  const r = await runLadder(app, o.orgId, g, act);
  assert.deepEqual(tools, ['part.verify', 'part.copy_extras']);
  assert.deepEqual(r, { ok: false, done: ['files and settings'], why: 'came back short' });
});
