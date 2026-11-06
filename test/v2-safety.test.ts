// V2, the Safety Net: something important with no safe copy gets one by itself, and everything it does only creates or
// copies. These pin the promise: what counts as important, what each level means, that the gate lets green through and
// nothing else, that a calm server is required, that a failure rests, and that Unit7's test restore really restores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, run } from '../src/db.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { saveXray } from '../src/tools/xray.ts';
import { manageDirs } from '../src/tools/manage.ts';
import { getTool } from '../src/tools/runtime.ts';
import { colourOf, decide } from '../src/policy.ts';
import { inBusyHours, judge, ladderFor, levelOf, loadOk, protectionOf, quietHourOf, refreshCoolifySeen, runLadder, safetyTick, type Guarded } from '../src/care/safetynet.ts';
import { extrasOf, extrasScript } from '../src/tools/partbackup.ts';
import { serverFindings } from '../src/discovery/findings.ts';
import { dockerAvailable } from './fixture.ts';
import type { Inventory, Part } from '../src/discovery/xray.ts';

const H = 3600_000, DAY = 24 * H;
const SRV = 'srv_safe00000001', WARDEN = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' } as const;
const iso = (ms: number) => new Date(ms).toISOString();

test('what matters: real signals, a person’s word first, and a test copy never counts by itself', () => {
  const base = { name: 'Harbor CRM', domains: [], traffic: 0, money: false };
  assert.equal(judge(base).important, false, 'nothing says it matters');
  const dom = judge({ ...base, domains: ['admin.myshop.co'] });
  assert.equal(dom.important, true); assert.match(dom.why[0]!, /own domain \(admin\.myshop\.co\)/);
  assert.equal(judge({ ...base, domains: ['shop.203.0.113.9.sslip.io'] }).important, false, 'a test address isn’t your own domain');
  assert.equal(judge({ ...base, money: true }).important, true);
  assert.equal(judge({ ...base, traffic: 500 }).important, false, 'one signal alone isn’t enough');
  assert.equal(judge({ ...base, traffic: 500, bytes: 2e9 }).important, true);
  assert.deepEqual(judge({ ...base, name: 'Harbor Preview', domains: ['harbor.example.com'] }), { important: false, why: ['Its name says it’s a test copy'], by: 'unit7' });
  assert.equal(judge({ ...base, name: 'Harbor Preview', marked: true }).by, 'you');
  assert.equal(judge({ ...base, domains: ['a.example.com'], marked: false }).important, false, 'the person decides');
});

test('levels: no copy, only here, off the server, proven; old copies stop counting', () => {
  const now = Date.UTC(2026, 10, 6), recent = iso(now - DAY), old = iso(now - 30 * DAY);
  assert.equal(levelOf([], undefined, now).level, 'unprotected');
  assert.equal(levelOf([{ at: old, off: { local: '/x' } }], undefined, now).level, 'unprotected', 'a month-old copy is no protection');
  assert.equal(levelOf([{ at: recent, off: null }], undefined, now).level, 'weak');
  assert.deepEqual(levelOf([], { count: 10, lastOk: recent, offServer: false }, now).where, ['this server'], 'Coolify’s own copies, same disk');
  assert.equal(levelOf([], { count: 10, lastOk: recent, offServer: false }, now).level, 'weak');
  assert.equal(levelOf([], { count: 10, lastOk: recent, offServer: true }, now).level, 'protected');
  assert.equal(levelOf([{ at: recent, off: { local: '/x' } }], undefined, now).level, 'protected');
  const proven = levelOf([{ at: recent, off: { local: '/x', bucket: 'b' }, verifyOk: 1, verifiedAt: recent }], undefined, now);
  assert.equal(proven.level, 'proven'); assert.deepEqual(proven.where, ['this server', 'this computer', 'your bucket']);
  assert.equal(levelOf([{ at: recent, off: { local: '/x' }, verifyOk: 0, verifiedAt: recent }], undefined, now).level, 'protected', 'a failed proof proves nothing');
});

test('the ladder asks only for what’s missing, in order', () => {
  const base = { serverId: SRV, part: 'p', extrasAt: null, provenAt: null, copies: { here: 0, off: 0, mine: 0 } } as Parameters<typeof ladderFor>[0];
  const fresh = iso(Date.now() - DAY), mine = { here: 3, off: 0, mine: 3 }, daily = { frequency: 'daily', keep: 7 };
  assert.deepEqual(ladderFor({ ...base, level: 'unprotected' }).map((s) => s.tool), ['part.backup_schedule', 'part.verify', 'part.copy_extras']);
  assert.deepEqual(ladderFor({ ...base, level: 'unprotected', schedule: daily }).map((s) => s.tool), ['part.backup', 'part.verify', 'part.copy_extras']);
  assert.deepEqual(ladderFor({ ...base, level: 'protected', extrasAt: fresh, copies: mine }).map((s) => s.tool), ['part.verify']);
  assert.deepEqual(ladderFor({ ...base, level: 'proven', extrasAt: fresh, provenAt: fresh }), []);
  assert.deepEqual(ladderFor({ ...base, level: 'unprotected', service: 'svc_1' }).map((s) => s.tool), ['backup.schedule', 'backup.create']);
  // it has to end, or the database gets dumped every 15 minutes
  assert.deepEqual(ladderFor({ ...base, level: 'weak', schedule: daily, extrasAt: fresh, provenAt: fresh, copies: mine }), [], 'copies only on this server: taking more doesn’t help');
  assert.deepEqual(ladderFor({ ...base, level: 'weak', service: 'svc_1', schedule: daily, extrasAt: fresh }), []);
  // Coolify's own copies are off the server, and Unit7 has no file of its own to test
  assert.deepEqual(ladderFor({ ...base, level: 'protected', extrasAt: fresh, copies: { here: 5, off: 0, mine: 0 } }), []);
});

test('colours: green only creates or copies, and green is a tool’s own promise', () => {
  for (const t of ['part.backup', 'part.verify', 'part.copy_extras', 'backup.create', 'backup.offsite_copy', 'safety.copy', 'safety.protect']) assert.ok(getTool(t)!.green, `${t} is green`);
  for (const t of ['part.restore', 'backup.restore', 'backup.prune', 'docker.prune', 'server.close_port', 'domain.point', 'env.set', 'deployment.create']) assert.ok(!getTool(t)!.green, `${t} isn’t green`);
  assert.equal((getTool('part.backup_schedule')!.green as (i: unknown) => boolean)({ off: false }), true);
  assert.equal((getTool('part.backup_schedule')!.green as (i: unknown) => boolean)({ off: true }), false, 'stopping backups is no green move');
  assert.equal(colourOf('backup', 'write', true), 'green');
  assert.equal(colourOf('restart_service', 'write'), 'yellow');
  assert.equal(colourOf('restore', 'destructive'), 'red');
  assert.equal(colourOf('drop_database', 'write'), 'red');
  const agent = { actor: 'agent' as const, role: 'agent' as const, risk: 'write' as const, action: 'backup', green: true };
  const env = (autonomy: number) => ({ kind: 'production' as const, autonomy, rules: {}, name: 'x', orgWide: true });
  assert.equal(decide({ ...agent, env: env(1) }).decision, 'allow', 'from Recommend up');
  assert.equal(decide({ ...agent, env: env(0) }).decision, 'deny', 'Observe means hands off');
  assert.equal(decide({ ...agent, green: false, env: env(1) }).decision, 'approve');
  assert.equal(decide({ ...agent, risk: 'destructive', env: env(2) }).decision, 'approve', 'a destructive tool can’t call itself green');
});

test('calm: busy hours, the quietest hour from real traffic, and no fresh reading means wait', async () => {
  const app = testApp(); const o = await testOrg(app);
  assert.equal(inBusyHours({ busy: { from: '09:00', to: '18:00', tz: 'UTC' } }, Date.UTC(2026, 10, 6, 10)), true);
  assert.equal(inBusyHours({ busy: { from: '09:00', to: '18:00', tz: 'UTC' } }, Date.UTC(2026, 10, 6, 20)), false);
  assert.equal(inBusyHours({ busy: { from: '22:00', to: '06:00', tz: 'UTC' } }, Date.UTC(2026, 10, 6, 2)), true, 'across midnight');
  assert.equal(inBusyHours({}, Date.now()), false);
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'web-1', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', '{}')`, SRV, o.orgId);
  const now = Date.UTC(2026, 10, 6, 14);
  assert.equal(quietHourOf(app.db, SRV, now).known, false, 'too little history');
  for (let d = 1; d <= 3; d++) for (let h = 0; h < 24; h++) run(app.db, 'INSERT INTO traffic_windows (id, org_id, server_id, at, minutes, summary, findings) VALUES (?, ?, ?, ?, 30, ?, ?)', id('twn'), o.orgId, SRV, iso(now - d * DAY + (h - 14) * H), JSON.stringify({ requests: h === 3 ? 5 : h >= 9 && h <= 17 ? 900 : 100, minutes: 30 }), '[]');
  const q = quietHourOf(app.db, SRV, now);
  assert.equal(q.hour, 3); assert.equal(q.calmNow, false, '14:00 is a busy hour');
  assert.equal(quietHourOf(app.db, SRV, Date.UTC(2026, 10, 6, 3)).calmNow, true);
  assert.equal(loadOk(app.db, SRV, now), false, 'no reading: wait');
  const reading = (cpu: number, used: number) => run(app.db, 'INSERT INTO metrics (server_id, at, cpu, mem_used, mem_total, disk_used, disk_total) VALUES (?, ?, ?, ?, ?, 1, 2)', SRV, iso(now - 60_000), cpu, used, 16e9);
  reading(95, 4e9); assert.equal(loadOk(app.db, SRV, now), false, 'busy CPU');
  run(app.db, 'DELETE FROM metrics'); reading(20, 15.8e9); assert.equal(loadOk(app.db, SRV, now), false, 'no memory to spare');
  run(app.db, 'DELETE FROM metrics'); reading(20, 6e9); assert.equal(loadOk(app.db, SRV, now), true);
});

const part = (over: Partial<Part>): Part => ({ id: 'coolify:shopdb', kind: 'database', name: 'shop-supabase', owner: 'coolify', trust: 'understood', engine: 'postgres', image: 'supabase/postgres:15', project: 'coolify:shop', containers: ['supabase-db-shopdb'], ...over } as Part);
const inventory = (parts: Part[], projects: Inventory['projects'] = [{ id: 'coolify:shop', name: 'Shop', owner: 'coolify', trust: 'understood', how: '', confidence: 1, parts: parts.map((p) => p.id), health: { status: 'healthy' }, domains: ['shop.example.com'] } as never]) =>
  ({ server: {}, parts, projects, ports: [], coolify: { connected: true } }) as unknown as Inventory;

async function world(parts: Part[], projects?: Inventory['projects']) {
  const app = testApp(), o = await testOrg(app, 'Sam');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'web-1', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', '{}')`, SRV, o.orgId);
  saveXray(app.db, o.orgId, SRV, 'fast', inventory(parts, projects));
  run(app.db, 'INSERT INTO metrics (server_id, at, cpu, mem_used, mem_total, disk_used, disk_total) VALUES (?, ?, 10, ?, ?, 1, 2)', SRV, new Date().toISOString(), 4e9, 16e9);
  return { app, o };
}

test('an important database with no copy gets one with no click, a test copy doesn’t, and Observe or Pause stops it all', async () => {
  const { app, o } = await world([part({}), part({ id: 'coolify:previewdb', name: 'preview-db', project: 'coolify:preview', containers: ['preview-db'] })],
    [{ id: 'coolify:shop', name: 'Shop', domains: ['shop.example.com'] }, { id: 'coolify:preview', name: 'Shop Preview', domains: ['preview.example.com'] }] as never);
  const calls: [string, Record<string, unknown>][] = [];
  const act = async (_o: string, tool: string, input: unknown) => { calls.push([tool, input as Record<string, unknown>]); return { status: 'ok', output: {}, auditId: '', durationMs: 1 } as const; };
  await safetyTick(app, act);
  assert.deepEqual(calls.map((c) => c[0]).filter((t) => t !== 'coolify.backup'), ['part.backup_schedule', 'part.verify', 'part.copy_extras']);
  assert.ok(calls.every(([, i]) => i.part !== 'coolify:previewdb'), 'a preview is left alone');
  const e = all<{ message: string; severity: string }>(app.db, `SELECT message, severity FROM events WHERE type = 'safety.protected'`);
  assert.equal(e.length, 1); assert.match(e[0]!.message, /^shop-supabase had no safe copy\. Unit7 made daily copies, a test restore, files and settings\. Nothing else changed\.$/);

  calls.length = 0;
  run(app.db, 'UPDATE orgs SET autonomy = 0'); await safetyTick(app, act); assert.deepEqual(calls, [], 'Observe');
  run(app.db, 'UPDATE orgs SET autonomy = 3, paused_at = ?', new Date().toISOString()); await safetyTick(app, act); assert.deepEqual(calls, [], 'Pause everything');
  run(app.db, 'UPDATE orgs SET paused_at = NULL, safety_net = 0'); await safetyTick(app, act); assert.deepEqual(calls, [], 'turned off');
  run(app.db, 'UPDATE orgs SET safety_net = 1'); run(app.db, 'DELETE FROM metrics'); await safetyTick(app, act);
  assert.deepEqual(calls.filter((c) => c[0] !== 'coolify.backup'), [], 'no fresh reading of the server: it waits');
  void o;
});

test('a failed step stops the ladder, rests six hours, and speaks up the second time', async () => {
  const { app, o } = await world([part({})]);
  const g = protectionOf(app.db, o.orgId)[0]!;
  assert.equal(g.important, true);
  const fail = async () => ({ status: 'error', error: { code: 'no_room', message: 'only 2 GB free' } }) as const;
  assert.equal((await runLadder(app, o.orgId, g, fail)).ok, false);
  assert.equal(get(app.db, `SELECT 1 FROM events WHERE type = 'safety.failed'`), undefined, 'one failure is said in the run, not on the phone');
  let tried = 0;
  await safetyTick(app, async (_o, tool) => { if (tool !== 'coolify.backup') tried++; return { status: 'ok', output: [], auditId: '', durationMs: 1 } as never; });
  assert.equal(tried, 0, 'it rests');
  await runLadder(app, o.orgId, g, fail);
  assert.match(get<{ message: string }>(app.db, `SELECT message FROM events WHERE type = 'safety.failed'`)!.message, /couldn’t protect shop-supabase: only 2 GB free/);
});

test('what Coolify keeps counts as weak, and the finding says so instead of "no backups"', async () => {
  const { app, o } = await world([part({ id: 'coolify:tracking', name: 'tracking-db', coolify: { uuid: 'tracking', type: 'database', labels: 'uuid' } })]);
  await refreshCoolifySeen(app, o.orgId, async () => ({ status: 'ok', output: [{ offServer: false, recent: [{ status: 'success', at: new Date(Date.now() - H).toISOString().replace('Z', '+00:00') }] }], auditId: '', durationMs: 1 }) as never);
  const g = protectionOf(app.db, o.orgId)[0]!;
  assert.equal(g.level, 'weak'); assert.deepEqual(g.where, ['this server']);
  const f = serverFindings(app.db, o.orgId, { id: SRV, name: 'web-1' });
  assert.ok(f.some((x) => /is backed up by Coolify, but only on this server/.test(x.title)));
  assert.ok(!f.some((x) => /no backups Unit7 can see/.test(x.title)));
});

test('what a dump misses: uploads and other folders, never the database’s own files, and Coolify’s keys', () => {
  const p = part({ binds: ['/data/coolify/services/shop/volumes/storage', '/data/coolify/services/shop/volumes/db/data', '/var/run/docker.sock', '/etc/localtime'], volumes: ['shop_supabase-db-data', 'shop_uploads', 'shop_deno-cache'], internals: [{ name: 'supabase-db-shop', image: 'x', state: 'running' }, { name: 'supabase-kong-shop', image: 'x', state: 'running' }] });
  const e = extrasOf(inventory([p]), p);
  assert.deepEqual(e.paths, ['/data/coolify/services/shop/volumes/storage']);
  assert.deepEqual(e.volumes, ['shop_uploads']);
  assert.ok(e.containers.includes('supabase-kong-shop'));
  const sys = part({ id: 'c:coolify-db', kind: 'service', project: 'coolify:system', containers: ['coolify-db'] });
  assert.deepEqual(extrasOf(inventory([sys], [{ id: 'coolify:system', name: 'Coolify itself', system: true, domains: [] }] as never), sys).paths, ['/data/coolify/source/.env', '/data/coolify/ssh', '/data/coolify/proxy']);
  assert.match(extrasScript(['/data/x'], ['vol']), /type=bind,src=\/data\/x,dst=\/b\/f0-x,readonly.*type=volume,src=vol,dst=\/b\/v-vol,readonly/, 'read-only, always');
});

test('Coolify itself is protected when anything it holds is important', async () => {
  const sys = part({ id: 'c:coolify-db', kind: 'service', name: 'coolify-db', project: 'coolify:system', containers: ['coolify-db'] });
  const { app, o } = await world([part({}), sys], [{ id: 'coolify:shop', name: 'Shop', domains: ['shop.example.com'] }, { id: 'coolify:system', name: 'Coolify itself', system: true, domains: [] }] as never);
  const c = protectionOf(app.db, o.orgId).find((g) => g.system)!;
  assert.equal(c.name, 'Coolify itself'); assert.equal(c.important, true);
});

const noDocker = !dockerAvailable() && 'Docker is not available';
test('real Docker: a real dump restores into a throwaway container, gets counted, and the container is gone after', { skip: noDocker, timeout: 180_000 }, async () => {
  const live = `unit7-safety-live-${id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a')}`, image = 'postgres:16-alpine';
  const dir = mkdtempSync(join(tmpdir(), 'unit7-proof-')), file = join(dir, 'dump.sql.gz');
  Object.assign(manageDirs, { backups: dir });
  spawnSync('docker', ['run', '-d', '--name', live, '-e', 'POSTGRES_PASSWORD=x', image], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60 && spawnSync('docker', ['exec', live, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    execFileSync('docker', ['exec', live, 'psql', '-U', 'postgres', '-c', 'create table shipments (id int); create table riders (id int); insert into shipments values (1);']);
    execFileSync('sh', ['-c', `docker exec ${live} pg_dumpall -U postgres | gzip > ${file}`]);
    const sum = createHash('sha256').update(execFileSync('cat', [file])).digest('hex');
    const { app, o } = await world([part({ id: 'coolify:live', name: 'live-db', image, containers: [live] })]);
    run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES (?, ?, NULL, ?, 'coolify:live', 'postgres', 'x', ?, 1, ?, 'done', ?)`, 'bak_realproof0001', o.orgId, SRV, file, sum, new Date().toISOString());
    ssh(app).exec = ((_s: unknown, command: string, opts: { stdin?: string } = {}) => new Promise((resolve) => {
      const c = spawn('sh', ['-c', command]); let stdout = '', stderr = '';
      c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
      c.stdin.end(opts.stdin ?? ''); c.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, truncated: false }));
    })) as never;
    const r = ok<{ ok: boolean; note: string }>(await o.as(WARDEN as never)('part.verify', { serverId: SRV, part: 'coolify:live' }));
    assert.equal(r.ok, true); assert.equal(r.note, 'all 2 tables and 1 row came back');
    const b = get<{ verify_ok: number }>(app.db, 'SELECT verify_ok FROM backups WHERE id = ?', 'bak_realproof0001');
    assert.equal(b?.verify_ok, 1);
    assert.equal(execFileSync('sh', ['-c', 'docker ps -a --filter label=unit7.copy-of=proof:coolify:live -q'], { encoding: 'utf8' }).trim(), '', 'the throwaway is gone');
    assert.equal(execFileSync('docker', ['exec', live, 'psql', '-Atq', '-U', 'postgres', '-c', 'select count(*) from shipments'], { encoding: 'utf8' }).trim(), '1', 'the live one is untouched');
  } finally { spawnSync('docker', ['rm', '-f', live], { stdio: 'ignore' }); writeFileSync(file, ''); }
});
