// What an independent review of the automatic actions found, each with the check that keeps it fixed. Worst first: a read tool that
// reached a root shell, automatic steps that deleted things, and a test restore that said Proven when real users hadn't come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, testApp, testOrg } from './helpers.ts';
import { dockerAvailable } from './fixture.ts';
import { get, id, run } from '../src/db.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { getTool } from './runtime-exports.ts';
import { actorOf, createToken, fromToken } from '../src/auth.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { colourOf } from '../src/policy.ts';
import { saveXray } from '../src/tools/xray.ts';
import { manageDirs, roomVerdict } from '../src/tools/manage.ts';
import { PG_MANIFEST, countsSql, parseCounts, parseManifest, proofOf, remindCopies } from '../src/tools/partbackup.ts';
import { mayCopy } from '../src/care/safetynet.ts';
import { knownNames, namesOf, ruleStops } from '../src/care/rules.ts';
import { hackCheck } from '../src/secure/hacked.ts';
import { sameSite } from '../src/secure/stranger.ts';
import { BACKUPS, DIR, OUTPOST } from '../src/outpost/script.ts';
import { syncOutpost } from '../src/outpost/index.ts';
import { script } from '../src/connectors/shell.ts';
import type { Inventory, Part } from '../src/discovery/xray.ts';

const SRV = 'srv_review000001', WARDEN = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' } as const;
const COPY = 'shop-db-copy-20261101-abcd';
const part = (over: Partial<Part>): Part => ({ id: 'coolify:live', kind: 'database', name: 'live-db', owner: 'coolify', trust: 'understood', engine: 'postgres', image: 'postgres:16-alpine', project: 'coolify:shop', containers: ['live'], ...over } as Part);
const inventory = (parts: Part[]) => ({ server: {}, parts, projects: [{ id: 'coolify:shop', name: 'Shop', owner: 'coolify', trust: 'understood', how: '', confidence: 1, parts: parts.map((p) => p.id), health: { status: 'healthy' }, domains: ['shop.example.com'] }], ports: [], coolify: { connected: true } }) as unknown as Inventory;
async function world(parts: Part[] = [part({})]) {
  const app = testApp(), o = await testOrg(app, 'Sam');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'web-1', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', '{}')`, SRV, o.orgId);
  saveXray(app.db, o.orgId, SRV, 'fast', inventory(parts));
  run(app.db, 'INSERT INTO metrics (server_id, at, cpu, mem_used, mem_total, disk_used, disk_total) VALUES (?, ?, 10, ?, ?, 1, 2)', SRV, new Date().toISOString(), 4e9, 16e9);
  return { app, o };
}
// a server that answers from a list of commands, and remembers each one
const fakeSsh = (app: ReturnType<typeof testApp>, answer: (c: string) => string = () => '') => {
  const seen: { command: string; stdin?: string }[] = [];
  ssh(app).exec = (async (_s: unknown, command: string, o: { stdin?: string } = {}) => { seen.push({ command, stdin: o.stdin }); return { code: 0, stdout: answer(command), stderr: '', truncated: false }; }) as never;
  return seen;
};
const localSsh = (app: ReturnType<typeof testApp>) => { ssh(app).exec = ((_s: unknown, command: string, opts: { stdin?: string } = {}) => new Promise((resolve) => {
  const c = spawn('sh', ['-c', command]); let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  c.stdin.end(opts.stdin ?? ''); c.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, truncated: false }));
})) as never; };

test('1: what a read tool is given never reaches a shell on the server', async () => {
  const { app, o } = await world();
  const seen = fakeSsh(app, (c) => (c.includes('docker ps -a') ? `${COPY}|coolify:live|2026-11-05 10:00:00 +0000 UTC\n` : ''));
  const evil = 'select 1\nU7SQL\ntouch /tmp/owned';
  ok(await o.a('part.copy_read', { serverId: SRV, copy: COPY, sql: evil }));
  const q = seen.find((x) => x.stdin?.includes('touch'))!;
  assert.ok(q, 'the text went to psql on stdin'); assert.ok(!q.command.includes('touch') && !q.command.includes('U7SQL'), 'and not into the command');
  assert.equal((await o.a('part.copy_read', { serverId: SRV, copy: COPY, sql: 'select 1; drop table a' })).status, 'error', 'a single query only');
  ok(await o.a('part.copy_read', { serverId: SRV, copy: COPY, sql: 'select 1;' }));
});

test('2: nothing removes a past copy by itself: an app may run on it by now', async () => {
  const { app, o } = await world();
  const seen = fakeSsh(app, (c) => (c.includes('docker ps -a') ? `${COPY}|coolify:live|2026-10-01 10:00:00 +0000 UTC\n` : ''));
  const ctx = { app, db: app.db, orgId: o.orgId, emit: (t: string, m: string, x: object) => app.events.emit(o.orgId, t, m, x as never) } as never;
  assert.deepEqual((await remindCopies(ctx)).reminded, [COPY]);
  assert.deepEqual((await remindCopies(ctx)).reminded, [], 'once');
  assert.ok(!seen.some((x) => /docker rm/.test(x.command)), 'nothing was removed');
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM events WHERE type = 'copy.old'`)!.n, 1);
  assert.equal((await o.a('part.copy_remove', { serverId: SRV, copy: COPY })).status, 'approval_required', 'an AI asks first');
  assert.equal(getTool('part.copy_remove')!.green, undefined);
  ok(await o.h('part.copy_remove', { serverId: SRV, copy: COPY }));
  assert.match(seen.at(-1)!.command, /docker rm -fv/, 'its data volume goes with it');
});

test('3: deleting images or old logs always waits for a person, at any autonomy', async () => {
  const { app, o } = await world();
  fakeSsh(app);
  run(app.db, 'UPDATE orgs SET autonomy = 4');
  assert.equal(colourOf('cleanup', 'write'), 'red');
  for (const tool of ['docker.prune', 'server.tidy_logs']) assert.equal((await o.as(WARDEN as never)(tool, { serverId: SRV })).status, 'approval_required', tool);
});

test('5, 6: a proof compares what came back with what the file holds', () => {
  const text = 'postgres\tauth.users\t12\npostgres\tpublic.shipments\t250\napp\tpublic."Order"\t3\nbroken line\n';
  const want = parseManifest(text);
  assert.equal(want.length, 3);
  assert.equal(countsSql(want.slice(2)), `select 'public."Order"', count(*) from public."Order";\n`);
  assert.deepEqual([...parseCounts('public."Order"|3\nauth.users|12\nnonsense\n')], [['public."Order"', 3], ['auth.users', 12]]);
  const got = new Map([['postgres\tauth.users', 12], ['postgres\tpublic.shipments', 250], ['app\tpublic."Order"', 3]]);
  assert.deepEqual(proofOf(want, got), { ok: true, note: 'all 3 tables and 265 rows came back' });
  // Supabase's image has auth.users already, so "some tables exist" passed with no users in it
  got.set('postgres\tauth.users', 0);
  const short = proofOf(want, got);
  assert.equal(short.ok, false); assert.match(short.note, /1 of 3 tables came back short: auth\.users/);
  got.delete('app\tpublic."Order"');
  assert.match(proofOf(want, got).note, /2 of 3/, 'a table that’s gone counts too');
  assert.equal(proofOf([], new Map()).ok, false, 'a file with no tables proves nothing');
});

test('5: a failed proof is an error, so the ladder rests instead of restoring every 15 minutes', async () => {
  const { app, o } = await world();
  const file = '/tmp/unit7-none.sql.gz';
  run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES ('bak_failedproof01', ?, NULL, ?, 'coolify:live', 'postgres', 'x', ?, 1, 'sum', 'done', ?)`, o.orgId, SRV, file, new Date().toISOString());
  fakeSsh(app, (c) => (c.includes('sha256sum') ? 'sum\n' : c.includes('MemAvailable') ? '9000000000\n' : c.includes('df -Pk') ? '900000000000 800000000000\n' : c.includes('gunzip -c') && c.includes('awk') ? 'postgres\tpublic.a\t5\n' : ''));
  const r = await o.as(WARDEN as never)('part.verify', { serverId: SRV, part: 'coolify:live' });
  assert.equal(r.status, 'error');
  assert.equal(get<{ verify_ok: number }>(app.db, 'SELECT verify_ok FROM backups WHERE id = ?', 'bak_failedproof01')!.verify_ok, 0);
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM events WHERE type = 'backup.verify_failed'`)!.n, 1, 'one alert');
});

test('5: a dropped connection says nothing about the backup', async () => {
  const { app, o } = await world();
  run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES ('bak_droppedconn01', ?, NULL, ?, 'coolify:live', 'postgres', 'x', '/tmp/x.sql.gz', 1, 'sum', 'done', ?)`, o.orgId, SRV, new Date().toISOString());
  ssh(app).exec = (async (_s: unknown, c: string) => (c.includes('docker run') ? { code: -1, stdout: '', stderr: '', truncated: false } : { code: 0, stdout: c.includes('sha256sum') ? 'sum\n' : c.includes('MemAvailable') ? '9000000000\n' : c.includes('df -Pk') ? '900000000000 800000000000\n' : '', stderr: '', truncated: false })) as never;
  assert.equal((await o.as(WARDEN as never)('part.verify', { serverId: SRV, part: 'coolify:live' })).status, 'error');
  assert.equal(get<{ verified_at: string | null }>(app.db, 'SELECT verified_at FROM backups WHERE id = ?', 'bak_droppedconn01')!.verified_at, null);
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM events WHERE type = 'backup.verify_failed'`)!.n, 0, 'no alarm');
});

test('4: a test restore that could fill the disk doesn’t start, and the size in words is right', async () => {
  assert.match(roomVerdict('200000000000 1000000000', false, 2e8)!, /only 1\.0 GB free, and Unit7 keeps 30\.0 GB free/);
  const { app, o } = await world();
  run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES ('bak_noroom000001', ?, NULL, ?, 'coolify:live', 'postgres', 'x', '/tmp/x.sql.gz', 9000000000, 'sum', 'done', ?)`, o.orgId, SRV, new Date().toISOString());
  const seen = fakeSsh(app, (c) => (c.includes('MemAvailable') ? '9000000000\n' : c.includes('df -Pk') ? '200000000000 50000000000\n' : ''));
  const r = await o.as(WARDEN as never)('part.verify', { serverId: SRV, part: 'coolify:live' });
  assert.equal(r.status, 'error'); assert.match((r as { error: { message: string } }).error.message, /didn’t test-restore/);
  assert.ok(!seen.some((x) => x.command.includes('docker run')));
});

test('7: a limited key reaches its tools and nothing else', async () => {
  resetRateLimits();
  const app = testApp(), o = await testOrg(app, 'Sam'), http = createHttp(app);
  const p = { user: { id: o.userId, email: 'a@b.c', name: 'Sam' }, org: { id: o.orgId, name: 'x', slug: 'x' }, role: 'owner', via: 'session' } as const;
  const { token } = createToken(app.db, p as never, 'cursor', 'agent', undefined, 'findings');
  const call = async (method: string, path: string, body?: unknown) => { const r = await http.fetch(new Request(`http://localhost:4800${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  for (const [m, path] of [['GET', '/api/graph'], ['GET', '/api/audit'], ['GET', '/api/agent/conversations'], ['POST', '/api/agent/conversations'], ['GET', '/api/stream']] as const) assert.equal((await call(m, path, m === 'POST' ? { message: 'hi' } : undefined)).status, 403, path);
  assert.equal((await call('POST', '/api/tools/project.create', { input: { name: 'x' } })).status, 403);
  assert.equal((await call('POST', '/api/tools/findings.list', { input: {} })).status, 200);
  const list = (await call('GET', '/api/tools')).body as { name: string }[];
  assert.ok(list.length > 0 && list.every((t) => t.name.startsWith('finding') || ['checkup.get', 'safety.status', 'expiry.list'].includes(t.name)), 'it sees its own tools');
  assert.deepEqual(actorOf(fromToken(app.db, token)!, 'An agent').only, actorOf(fromToken(app.db, token)!).only, 'an agent working for that key has the same limit');
});

test('8: the same brakes for every automatic copy', async () => {
  const { app, o } = await world(), may = () => mayCopy(app.db, o.orgId, SRV);
  assert.equal(may(), true);
  run(app.db, 'UPDATE orgs SET safety_net = 0'); assert.equal(may(), false, 'switched off');
  run(app.db, 'UPDATE orgs SET safety_net = 1, autonomy = 0'); assert.equal(may(), false, 'Observe');
  run(app.db, 'UPDATE orgs SET autonomy = 3, paused_at = ?', new Date().toISOString()); assert.equal(may(), false, 'Pause');
  run(app.db, `UPDATE orgs SET paused_at = NULL, safety = ?`, JSON.stringify({ busy: { from: '00:00', to: '23:59', tz: 'UTC' } })); assert.equal(may(), false, 'busy hours');
  run(app.db, `UPDATE orgs SET safety = '{}'`);
  run(app.db, 'DELETE FROM metrics'); assert.equal(may(), false, 'no fresh reading: it waits');
  run(app.db, 'INSERT INTO metrics (server_id, at, cpu, mem_used, mem_total, disk_used, disk_total) VALUES (?, ?, 95, 1, 16000000000, 1, 2)', SRV, new Date().toISOString()); assert.equal(may(), false, 'the server is busy');
});

test('8, 10: the Outpost hears the brakes, and its copies only leave through the gate', async () => {
  const { app, o } = await world();
  run(app.db, `INSERT INTO outposts (server_id, org_id, version, installed_at) VALUES (?, ?, '1', ?)`, SRV, o.orgId, new Date().toISOString());
  run(app.db, 'UPDATE orgs SET paused_at = ?', new Date().toISOString());
  const seen = fakeSsh(app, () => `@@copies\n${BACKUPS}/coolify-live/a.sql.gz 10 abc\n`);
  const ctx = { app, db: app.db, orgId: o.orgId } as never, s = get(app.db, 'SELECT * FROM servers WHERE id = ?', SRV) as never;
  await syncOutpost(ctx, s);
  assert.match(seen[0]!.command, /COPIES=%s/); assert.match(seen[0]!.command, /'off' '\d\d'$/, 'it’s told to stop');
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM backups WHERE offsite IS NULL')!.n, 1, 'the copy is on record, and stays on the server');
  assert.equal((await o.as(WARDEN as never)('outpost.send_copies', {})).status, 'denied', 'Pause stops it going anywhere');
  assert.equal(getTool('outpost.send_copies')!.green, true);
  run(app.db, 'UPDATE orgs SET paused_at = NULL');
  await syncOutpost(ctx, s);
  assert.match(seen.at(-1)!.command, /'on' '\d\d'$/);
});

test('11: only a person can say a change was theirs, or that a finding was right', async () => {
  const { app, o } = await world();
  fakeSsh(app, () => '@@keys\n@@exes\n');
  assert.equal((await o.a('security.accept_baseline', { serverId: SRV })).status, 'denied');
  assert.equal((await o.a('finding.judge', { key: 'traffic:surge:a', right: false })).status, 'denied');
  run(app.db, 'UPDATE orgs SET autonomy = 0');
  ok(await o.h('finding.judge', { key: 'traffic:surge:a', right: false }));
  ok(await o.h('security.accept_baseline', { serverId: SRV }));
});

test('12: a rule stops what it names, however a tool refers to it, and a rule that names nothing is refused', async () => {
  const { app, o } = await world([part({ id: 'coolify:api', kind: 'app', name: 'api', engine: undefined, containers: ['api-xyz'], internals: [{ name: 'api-worker', image: 'x' }], coolify: { uuid: 'abc', type: 'application', environment: 'production' } } as never)]);
  run(app.db, `INSERT INTO changes (id, org_id, server_id, part, verb, summary, undo, status, actor) VALUES ('chg_rule00000001', ?, ?, 'coolify:api', 'restart', 's', '{}', 'done', 'x')`, o.orgId, SRV);
  const names = (i: Record<string, unknown>) => namesOf(app.db, o.orgId, i);
  assert.ok(names({ serverId: SRV, container: 'api-xyz' }).includes('shop'), 'a container');
  assert.ok(names({ serverId: SRV, container: 'api-worker' }).includes('api'), 'a container inside a stack');
  assert.ok(names({ changeId: 'chg_rule00000001' }).includes('shop'), 'an undo');
  ok(await o.h('rule.add', { text: 'Never touch shop', tz: 'UTC' }));
  assert.match(ruleStops(app.db, o.orgId, { serverId: SRV, container: 'api-xyz' })!, /Never touch shop/);
  assert.match(ruleStops(app.db, o.orgId, { changeId: 'chg_rule00000001' })!, /Never touch shop/);
  ok(await o.h('rule.add', { text: 'Leave production alone', tz: 'UTC' }));
  assert.match(ruleStops(app.db, o.orgId, { serverId: SRV, part: 'coolify:api' })!, /Your rule says so/);
  assert.ok(knownNames(app.db, o.orgId).includes('production'));
  const r = await o.h('rule.add', { text: 'Never touch payroll' });
  assert.equal(r.status, 'error'); assert.match((r as { error: { message: string } }).error.message, /doesn’t know anything called “payroll”/);
});

test('13: an AI can’t push good copies out by asking for more', async () => {
  const { app, o } = await world();
  run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES ('bak_extras000001', ?, NULL, ?, 'extras:coolify:live', 'files', 'scheduled (safety net)', '/x', 1, 's', 'done', ?)`, o.orgId, SRV, new Date().toISOString());
  fakeSsh(app);
  const r = await o.a('part.copy_extras', { serverId: SRV, part: 'coolify:live' });
  assert.equal(r.status, 'error'); assert.match((r as { error: { message: string } }).error.message, /in the last hour/);
});

test('a look that didn’t finish is never “no signs”, and never becomes the baseline', async () => {
  const { app, o } = await world();
  ssh(app).exec = (async () => ({ code: 1, stdout: '', stderr: 'sudo: a password is required', truncated: false })) as never;
  const s = get(app.db, 'SELECT * FROM servers WHERE id = ?', SRV) as never;
  await assert.rejects(() => hackCheck({ app, db: app.db, orgId: o.orgId } as never, s), /can’t say either way/);
  assert.equal(get(app.db, 'SELECT 1 FROM server_baseline WHERE server_id = ?', SRV), undefined);
});

test('a redirect on / is followed only inside the site', () => {
  assert.equal(sameSite('https://www.shop.example.com/', 'https://shop.example.com', 'shop.example.com')?.origin, 'https://www.shop.example.com');
  assert.equal(sameSite('/login', 'https://shop.example.com', 'shop.example.com')?.pathname, '/login');
  assert.equal(sameSite('https://shop.example.com/', 'https://www.shop.example.com', 'www.shop.example.com')?.hostname, 'shop.example.com');
  for (const bad of ['http://shop.example.com/', 'https://evil.example/', 'https://shop.example.com.evil.example/', 'https://notshop.example.com/', 'https://[bad']) assert.equal(sameSite(bad, 'https://shop.example.com', 'shop.example.com'), undefined, bad);
});

test('smaller ones: a learned fix records itself, quiet git checks stay out of the audit chain, and cost reads stay twice a day', async () => {
  const warden = await import('node:fs').then((f) => f.readFileSync(new URL('../src/sentinel/warden.ts', import.meta.url), 'utf8'));
  assert.match(warden, /sweeps % 720 === 41\) for .*cloud\.spend_watch/);
  assert.ok(!/upkeepNow|upkeepFor/.test(warden), 'no automatic cleanups');
  assert.equal(getTool('service.sync_git')!.idle!({ deployed: false } as never), true);
  assert.equal(getTool('service.sync_git')!.idle!({ deployed: false, status: 'error' } as never), false, 'a failed deploy stays on the record');
  const autofix = await import('node:fs').then((f) => f.readFileSync(new URL('../src/tools/autofix.ts', import.meta.url), 'utf8'));
  assert.match(autofix, /JSON\.stringify\(c\.fix\.undo \?\? \{\}\)/);
});

test('9: the Outpost script keeps the alert channel off the command line and only trusts a whole copy', () => {
  assert.ok(!/curl[^\n]*"\$ALERT_URL"/.test(OUTPOST) && !/curl[^\n]*"\$HEARTBEAT_URL"/.test(OUTPOST));
  assert.match(OUTPOST, /curl -fsS -m 10 -K -/);
  assert.match(OUTPOST, /^umask 077$/m);
  assert.match(OUTPOST, /\[ "\\?\$\{?COPIES:-on\}?" = on \]|COPIES:-on/);
  assert.ok(OUTPOST.indexOf('mv "$f.tmp" "$f"') < OUTPOST.indexOf('tail -n +4'), 'the old one goes only after the new one is whole');
});

const noDocker = !dockerAvailable() && 'Docker is not available';
const hasImage = (image: string) => spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
const wait = async (name: string, user: string) => { for (let i = 0; i < 120 && spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', user]).status !== 0; i++) await new Promise((r) => setTimeout(r, 500)); };
const tag = () => id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a');
const dangling = () => Number(execFileSync('sh', ['-c', 'docker volume ls -q -f dangling=true | wc -l'], { encoding: 'utf8' }).trim());

// a live database, a real dump of it, and a real test restore through the real tool
async function prove(image: string, o: { setup: string[]; dump: (live: string) => string; db?: string; env?: string[] }) {
  const live = `unit7-review-${tag()}`, dir = mkdtempSync(join(tmpdir(), 'unit7-review-')), file = join(dir, 'dump.sql.gz'), supabase = image.includes('supabase');
  Object.assign(manageDirs, { backups: dir });
  spawnSync('docker', ['run', '-d', '--name', live, '-e', 'POSTGRES_PASSWORD=x', ...(o.env ?? []), image], { stdio: 'ignore' });
  try {
    await wait(live, 'postgres');
    for (const sql of o.setup) execFileSync('docker', ['exec', live, 'psql', '-h', '127.0.0.1', '-U', supabase ? 'supabase_admin' : 'postgres', '-d', o.db ?? 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    execFileSync('sh', ['-c', `${o.dump(live)} | gzip > ${file}`]);
    const sum = createHash('sha256').update(execFileSync('cat', [file])).digest('hex');
    const { app, o: org } = await world([part({ image, containers: [live] })]);
    run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES ('bak_reviewproof01', ?, NULL, ?, 'coolify:live', 'postgres', 'x', ?, 1, ?, 'done', ?)`, org.orgId, SRV, file, sum, new Date().toISOString());
    localSsh(app);
    const before = dangling(), r = await org.as(WARDEN as never)('part.verify', { serverId: SRV, part: 'coolify:live' });
    assert.equal(execFileSync('sh', ['-c', 'docker ps -a --filter name=^unit7-proof- -q'], { encoding: 'utf8' }).trim(), '', 'the throwaway is gone');
    assert.equal(dangling(), before, 'and its data with it');
    return { r, manifest: parseManifest(execFileSync('sh', ['-c', script(PG_MANIFEST, file)], { encoding: 'utf8' })) };
  } finally { spawnSync('docker', ['rm', '-fv', live], { stdio: 'ignore' }); writeFileSync(file, ''); }
}

test('real Docker: a database that isn’t called postgres comes back whole, and the test copy leaves no data behind', { skip: noDocker, timeout: 180_000 }, async () => {
  const { r, manifest } = await prove('postgres:16-alpine', { env: ['-e', 'POSTGRES_DB=app'], db: 'app', setup: ['create table shipments (id int)', 'insert into shipments select generate_series(1, 40)'], dump: (l) => `docker exec ${l} pg_dumpall -U postgres` });
  assert.deepEqual(manifest, [{ db: 'app', table: 'public.shipments', rows: 40 }]);
  assert.equal(ok<{ note: string }>(r).note, 'all 1 table and 40 rows came back');
});

const SUPA = 'supabase/postgres:15.8.1.060';
const supaSetup = ['create table public.shipments (id int primary key, note text)', `insert into public.shipments select g, 'row ' || g from generate_series(1, 250) g`, `insert into auth.users (id, email) values (gen_random_uuid(), 'a@example.com')`];
const supaDump = (l: string) => `docker exec ${l} sh -c 'PGPASSWORD=x pg_dumpall -h 127.0.0.1 -U supabase_admin'`;
test('real Docker: Supabase comes back whole, sign-in users included', { skip: noDocker || (!hasImage(SUPA) && `${SUPA} isn’t here`), timeout: 180_000 }, async () => {
  const { r, manifest } = await prove(SUPA, { setup: supaSetup, dump: supaDump });
  assert.equal(manifest.find((t) => t.table === 'auth.users')?.rows, 1);
  assert.match(ok<{ note: string }>(r).note, /^all \d+ tables and \d+ rows came back$/);
});
test('real Docker: a backup with a bad row in it doesn’t pass, even though plenty of tables exist', { skip: noDocker || (!hasImage(SUPA) && `${SUPA} isn’t here`), timeout: 180_000 }, async () => {
  const { r } = await prove(SUPA, { setup: supaSetup, dump: (l) => `${supaDump(l)} | sed 's/^5[[:space:]]row 5$/not-a-number/'` });
  assert.equal(r.status, 'error');
  const said = (r as { error: { message: string } }).error.message;
  assert.match(said, /came back short: public\.shipments \(0 of 250 rows\)\. Postgres said: shipments: invalid input syntax for type integer/, 'which table, how short, and why');
  assert.doesNotMatch(said, /not-a-number/, 'never the row itself');
});

test('real Docker: a failed night keeps the last good copy, nothing half-written gets a real name, and copies are private', { skip: noDocker, timeout: 120_000 }, async () => {
  const box = `unit7-review-box-${tag()}`, db = `unit7-review-db-${tag()}`;
  spawnSync('docker', ['run', '-d', '--name', db, '-e', 'POSTGRES_PASSWORD=x', 'postgres:16-alpine'], { stdio: 'ignore' });
  spawnSync('docker', ['run', '-d', '--name', box, '-v', '/var/run/docker.sock:/var/run/docker.sock', 'docker:27-cli', 'sh', '-c', 'apk add --no-cache curl coreutils >/dev/null 2>&1; sleep 200'], { stdio: 'ignore' });
  const sh = (cmd: string) => execFileSync('docker', ['exec', '-i', box, 'sh', '-c', cmd], { encoding: 'utf8' });
  const copy = OUTPOST.slice(OUTPOST.indexOf('  mkdir -p ' + BACKUPS), OUTPOST.lastIndexOf('fi\n')).replace(/\\\$/g, '$');
  const night = () => spawnSync('docker', ['exec', '-i', box, 'sh', '-c', `umask 077; D=${DIR}; alert() { echo ALERT "$@"; }; ${copy}`], { encoding: 'utf8' });
  try {
    await wait(db, 'postgres');
    for (let i = 0; i < 60 && spawnSync('docker', ['exec', box, 'sh', '-c', 'command -v curl']).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    sh(`mkdir -p ${DIR}; printf 'db|postgres|${db}\\n' > ${DIR}/jobs`);
    assert.equal(night().status, 0);
    assert.match(sh(`stat -c '%a' ${BACKUPS} ${BACKUPS}/db/*.sql.gz`), /^700\n600\n$/, 'nobody else on the server can read them');
    const good = sh(`ls ${BACKUPS}/db/`).trim();
    // a dump that dies part way: this one writes a little, then exits 1
    sh(`printf 'db|postgres|no-such-container\\n' > ${DIR}/jobs`);
    const bad = night();
    assert.match(bad.stdout, /ALERT Outpost couldn't copy db/);
    assert.equal(sh(`ls ${BACKUPS}/db/`).trim(), good, 'the good copy stays, and nothing half-written is left');
  } finally { spawnSync('docker', ['rm', '-fv', box, db], { stdio: 'ignore' }); }
});

test('Warden’s extra copies keep to a few, and after a break-in nothing is pruned', async () => {
  const { app, o } = await world();
  const seen = fakeSsh(app, (c) => (c.includes('wc -c') ? '10\nabc\n' : c.includes('df -Pk') ? '900000000000 800000000000\n' : ''));
  run(app.db, `UPDATE orgs SET offsite = 'off'`);
  for (let i = 0; i < 4; i++) run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at, created_at) VALUES (?, ?, NULL, ?, 'coolify:live', 'postgres', 'auto (before a deploy)', ?, 1, 's', 'done', ?, ?)`, `bak_autocopy0000${i}`, o.orgId, SRV, `/x/${i}`, new Date().toISOString(), new Date(Date.now() - (i + 1) * 3600_000).toISOString());
  run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at, created_at) VALUES ('bak_personscopy1', ?, NULL, ?, 'coolify:live', 'postgres', 'manual', '/x/me', 1, 's', 'done', ?, ?)`, o.orgId, SRV, new Date().toISOString(), new Date(Date.now() - 9 * 3600_000).toISOString());
  const count = () => get<{ n: number }>(app.db, `SELECT count(*) n FROM backups WHERE reason LIKE 'auto%'`)!.n;
  app.events.emit(o.orgId, 'breakin.found', 'x', { severity: 'critical', resource: SRV });
  ok(await o.as(WARDEN as never)('part.backup', { serverId: SRV, part: 'coolify:live', reason: 'before a deploy' }));
  assert.equal(count(), 5, 'after a break-in the old copies are the clean ones');
  assert.ok(!seen.some((x) => /sh -c 'rm -f "\$1"'/.test(x.command)));
  run(app.db, `DELETE FROM events WHERE type = 'breakin.found'`);
  ok(await o.as(WARDEN as never)('part.backup', { serverId: SRV, part: 'coolify:live', reason: 'before a deploy' }));
  assert.equal(count(), 3, 'only the newest few stay');
  assert.ok(get(app.db, `SELECT 1 FROM backups WHERE id = 'bak_personscopy1'`), 'a person’s copy is never counted');
});
