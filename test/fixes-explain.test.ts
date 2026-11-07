// Real fixes instead of steps, "This is fine", and plain words everywhere: Unit7 backs up a database it found on a server
// itself (the right dump per engine, a schedule, the first copy off the server, Undo); a person can hide a finding for a
// while or for good and it comes back marked when the time is up; an AI can never hide one; and every finding, alert and
// suggestion kind has three plain lines (what happened, what it can cause, what Unit7 does) with no tool words in them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { buildInventory, type Inventory } from '../src/discovery/xray.ts';
import { saveXray } from '../src/tools/xray.ts';
import { manageDirs } from '../src/tools/manage.ts';
import { decideApproval } from '../src/tools/runtime.ts';
import { dueSchedules } from '../src/tools/partbackup.ts';
import { findingsFor } from '../src/discovery/findings.ts';
import { serverFindings as auditFindings } from '../src/tools/security.ts';
import { EVENT_WORDS, FINDING_WORDS, SUGGESTION_WORDS, explainAlert, explainEvent, explainFinding, jargonIn, kindOf, phoneText } from '../src/explain.ts';
import { snoozeState, untilFor, visible } from '../src/snooze.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';

const SRV = 'srv_fix000000001';
const dump = gzipSync(Buffer.from('-- a database dump\n'.repeat(50)));
const sum = createHash('sha256').update(dump).digest('hex');
// a stand-in server: every command is kept; the dump "works", the size and checksum come back, the file downloads
function fakeServer(app: App) {
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, _o: ExecOptions = {}) => {
    seen.push(command);
    return { code: 0, stdout: command.includes('sha256sum') ? `${dump.length}\n${sum}\n` : '', stderr: '', truncated: false };
  };
  ssh(app).getFile = async (_s, _remote, local) => { (await import('node:fs')).writeFileSync(local, dump); };
  return seen;
}
// a Coolify host (Supabase stacks, a Coolify Postgres) plus a Compose MySQL, MariaDB, MongoDB and Redis
async function setup() {
  Object.assign(manageDirs, { backups: '/tmp/unit7-test-backups' });
  const app = testApp();
  const o = await testOrg(app, 'Sam');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'web-1', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', '{}')`, SRV, o.orgId);
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
  const db = (engine: string, image: string) => ({ id: `c:${engine}-db`, kind: 'database' as const, name: `${engine}-db`, owner: 'compose' as const, trust: 'understood' as const, engine, image, containers: [`${engine}-db-1`], project: 'c:shop' });
  inv.parts.push(db('mysql', 'mysql:8'), db('mariadb', 'mariadb:11'), db('mongo', 'mongo:7'), db('redis', 'redis:7'));
  saveXray(app.db, o.orgId, SRV, 'fast', inv);
  return { app, o, inv, seen: fakeServer(app) };
}
// the command as the server's shell reads it (script() quotes the whole body once)
const lastDump = (seen: string[]) => seen.find((c) => /docker exec/.test(c))!.replace(/'\\''/g, "'");

test('“Back up daily with Unit7”: the right dump per engine, a schedule, the first copy off the server, and Undo', async () => {
  const { app, o, inv, seen } = await setup();
  const findings = findingsFor({ serverId: SRV, serverName: 'web-1', inv });
  // the owner's case: a Coolify Supabase with no backups gets Unit7's own daily backup, Coolify's steps by hand
  const supa = findings.find((f) => f.id === `xray:no-backup:${SRV}:coolify:shopsupa01`)!;
  assert.ok(supa.fix && 'tool' in supa.fix);
  assert.equal(supa.fix.tool, 'part.backup_schedule');
  assert.equal(supa.fix.label, 'Back up daily with Unit7');
  assert.match(supa.fix.change, /every day.*keeps the last 7.*encrypted off the server/);
  assert.deepEqual(supa.fix.byHand, ['In Coolify, open shop-supabase → Backups.', 'Add a daily schedule and, if you can, an S3 bucket so copies live off the server.']);

  const out = ok(await o.h('part.backup_schedule', { serverId: SRV, part: 'coolify:shopsupa01' }));
  // Supabase's Postgres: every database, as its own admin, inside its own container
  assert.match(lastDump(seen), /docker exec "\$2" sh -c 'PGPASSWORD="\$POSTGRES_PASSWORD" pg_dumpall -h 127\.0\.0\.1 -U supabase_admin'; echo \$\? > "\$3\.rc"; \} \| gzip > "\$3"/);
  assert.match(lastDump(seen), /'supabase-db-shopsupa01'/);
  assert.deepEqual([out.scheduled, out.keep, out.firstBackup.offServer], ['daily', 7, ['this computer']]);
  const sch = get<{ frequency: string; keep: number; last_run_at: string | null }>(app.db, 'SELECT frequency, keep, last_run_at FROM part_backup_schedules WHERE server_id = ? AND part = ?', SRV, 'coolify:shopsupa01')!;
  assert.deepEqual([sch.frequency, sch.keep, !!sch.last_run_at], ['daily', 7, true]);
  const bak = get<{ status: string; size: number; checksum: string; offsite: string; service_id: string | null }>(app.db, 'SELECT status, size, checksum, offsite, service_id FROM backups WHERE part = ?', 'coolify:shopsupa01')!;
  assert.deepEqual([bak.status, bak.size, bak.checksum, bak.service_id], ['done', dump.length, sum, null]);
  const local = JSON.parse(bak.offsite).local as string;
  assert.ok(existsSync(local) && local.endsWith('.enc'), 'copied off the server');
  assert.ok(!readFileSync(local).includes(Buffer.from('a database dump')), 'encrypted');
  // Activity has it, with Undo
  const ev = get<{ message: string; data: string }>(app.db, `SELECT message, data FROM events WHERE type = 'change.made' ORDER BY created_at DESC LIMIT 1`)!;
  assert.match(ev.message, /^Backs up shop-supabase on web-1 every day, keeping the last 7\. The first backup is done and safe off the server \(this computer\)\. It can be undone\.$/);
  assert.equal(JSON.parse(ev.data).changeId, out.changeId);
  // the finding is gone once Unit7 backs it up
  const { gather } = await import('../src/discovery/findings.ts');
  assert.ok(!findingsFor(gather(app.db, o.orgId, { id: SRV, name: 'web-1' })).some((f) => f.id === supa.id));

  // Warden runs it again when it's due, and keeps the newest 7 scheduled copies
  assert.deepEqual(dueSchedules(app.db).length, 0, 'just ran');
  run(app.db, 'UPDATE part_backup_schedules SET last_run_at = ?', new Date(Date.now() - 25 * 3600_000).toISOString());
  assert.equal(dueSchedules(app.db)[0]!.part, 'coolify:shopsupa01');
  // (only Warden's own run when the schedule is due prunes: the schedule row says so, never the input)
  const warden = o.as({ kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' });
  for (let k = 0; k < 8; k++) {
    run(app.db, 'UPDATE part_backup_schedules SET last_run_at = ?', new Date(Date.now() - 25 * 3600_000).toISOString());
    ok(await warden('part.backup', { serverId: SRV, part: 'coolify:shopsupa01', reason: 'scheduled (daily)' }));
  }
  assert.equal(all(app.db, `SELECT 1 FROM backups WHERE part = 'coolify:shopsupa01' AND reason LIKE 'scheduled%'`).length, 7, 'the newest 7 stay');

  // Undo: an AI can't stop backups; a person can, and the copies stay
  assert.equal((await o.a('change.undo', { changeId: out.changeId })).status !== 'ok', true);
  assert.equal((await o.a('part.backup_schedule', { serverId: SRV, part: 'coolify:shopsupa01', off: true })).status, 'denied');
  ok(await o.h('change.undo', { changeId: out.changeId }));
  assert.ok(!get(app.db, 'SELECT 1 FROM part_backup_schedules WHERE part = ?', 'coolify:shopsupa01'));
  assert.ok(all(app.db, `SELECT 1 FROM backups WHERE part = 'coolify:shopsupa01'`).length > 0, 'copies already made stay');

  // the other engines, each with its own dump, inside its own container
  const want: Record<string, RegExp> = {
    'coolify:relaydb01': /docker exec "\$2" sh -c 'pg_dumpall -U "\$\{POSTGRES_USER:-postgres\}"'; echo \$\? > "\$3\.rc"; \} \| gzip/,
    'c:mysql-db': /mysqldump -uroot --all-databases --single-transaction 2>\/dev\/null \|\| mariadb-dump -uroot --all-databases --single-transaction'; echo \$\? > "\$3\.rc"; \} \| gzip/,
    'c:mariadb-db': /export MYSQL_PWD="\$\{MYSQL_ROOT_PASSWORD:-\$MARIADB_ROOT_PASSWORD\}"; mysqldump/,
    // the password only in a 0600 file inside the container, never on a command line
    'c:mongo-db': /mongodump --quiet --archive --username="\$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin --config="\$f".*exec mongodump --quiet --archive'; echo \$\? > "\$3\.rc"; \} \| gzip/,
    'c:redis-db': /REDISCLI_AUTH=.*redis-cli BGSAVE.*while \[ "\$\(redis-cli LASTSAVE\)" = "\$t" \].*cat "\$\{d:-\/data\}\/\$\{f:-dump\.rdb\}"'; echo \$\? > "\$3\.rc"; \} \| gzip/,
  };
  for (const [part, re] of Object.entries(want)) {
    seen.length = 0;
    ok(await o.h('part.backup', { serverId: SRV, part }));
    assert.match(lastDump(seen), re, part);
    assert.ok(lastDump(seen).includes(`'${part === 'coolify:relaydb01' ? 'relaydb01' : `${part.slice(2)}-1`}'`), `${part}: in its own container`);
  }
  // an AI keeps at least 7; Unit7's own databases use their own Backups
  assert.equal((await o.a('part.backup_schedule', { serverId: SRV, part: 'c:mysql-db', keep: 3 })).status, 'error');
});

test('a Coolify database offers Coolify’s own backups second', () => {
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9', coolify: { accountId: 'acc_test0000000a' } } as never);
  const f = findingsFor({ serverId: SRV, serverName: 'web-1', inv: { ...inv, parts: inv.parts.filter((p) => p.kind !== 'job') } }).find((x) => x.id === `xray:no-backup:${SRV}:coolify:relaydb01`)!;
  assert.ok(f.fix && 'tool' in f.fix);
  assert.equal(f.fix.tool, 'part.backup_schedule');
  assert.deepEqual(f.fix.alt?.map((a) => [a.tool, a.label]), [['coolify.backup', 'Use Coolify’s backups']]);
});

test('snoozes: hidden until the time is up, then back and marked; for good stays; brought back by hand', async () => {
  const { app, o } = await setup();
  const list = async () => ok(await o.h('server.findings', { serverId: SRV }));
  const key = `xray:no-backup:${SRV}:coolify:crmsupa01`;
  const has = (r: any) => r.risks.find((f: any) => f.id === key);
  assert.ok(has(await list()), 'there to begin with');
  assert.ok(has(await list()).explain.what, 'with plain words');
  ok(await o.h('snooze.set', { key, for: '7d', title: 'crm-supabase has no backups Unit7 can see' }));
  assert.ok(!has(await list()), 'hidden for 7 days');
  assert.equal(ok(await o.h('snooze.list')).hidden[0].title, 'crm-supabase has no backups Unit7 can see');
  // a week later it's back, and says so
  run(app.db, 'UPDATE snoozes SET until = ? WHERE key = ?', new Date(Date.now() - 60_000).toISOString(), key);
  assert.equal(has(await list()).back, 'Back after 7 days: still here');
  assert.equal(ok(await o.h('snooze.list')).back[0].words, 'Back after 7 days: still here');
  // ... and the "back" mark goes after another week
  run(app.db, 'UPDATE snoozes SET until = ? WHERE key = ?', new Date(Date.now() - 8 * 86400_000).toISOString(), key);
  assert.equal(has(await list()).back, undefined);
  // "This is fine, don't show it again": for good, with the person's reason
  ok(await o.h('snooze.set', { key, for: 'forever', reason: 'it’s a test copy' }));
  run(app.db, `UPDATE snoozes SET created_at = '2020-01-01T00:00:00.000Z'`);
  assert.ok(!has(await list()), 'never comes back by itself');
  assert.deepEqual([snoozeState(app.db, o.orgId).hidden.get(key)!.reason, snoozeState(app.db, o.orgId).hidden.get(key)!.until], ['it’s a test copy', null]);
  ok(await o.h('snooze.clear', { key }));
  assert.ok(has(await list()), 'Bring back');
  // tomorrow: the next morning, never sooner than 12 hours
  const at = Date.parse('2026-10-08T22:00:00Z');
  assert.equal(untilFor('tomorrow', at), '2026-10-09T10:00:00.000Z');
  assert.equal(untilFor('tomorrow', Date.parse('2026-10-08T05:00:00Z')), '2026-10-09T07:00:00.000Z');
  assert.equal(untilFor('15d', at), new Date(at + 15 * 86400_000).toISOString());
  // one store: Home's tasks and Warden's suggestions leave out what's hidden too
  assert.deepEqual(visible(app.db, o.orgId, [{ id: 'a' }, { id: key }], (x) => x.id).map((x) => x.id), ['a', key]);
  ok(await o.h('snooze.set', { key, for: 'tomorrow' }));
  assert.ok(!ok<{ tasks: any[] }>(await o.h('home.suggest', { limit: 10 })).tasks.some((t) => t.snoozeKey === key), 'gone from Home too');
});

test('an AI can’t hide a risk, for good or for a while; it may only suggest it', async () => {
  const { o } = await setup();
  const key = `xray:no-backup:${SRV}:coolify:crmsupa01`;
  for (const f of ['forever', '7d', 'tomorrow']) assert.equal((await o.a('snooze.set', { key, for: f })).status, 'denied', f);
  // an AI acting through a person's own connection is refused inside the tool too
  const viaToken = await o.as({ ...o.human, role: 'agent' as never })('snooze.set', { key, for: 'forever' });
  assert.notEqual(viaToken.status, 'ok');
  assert.equal((await o.a('home.dismiss', { id: key })).status, 'denied');
  assert.ok(ok<{ risks: any[] }>(await o.a('server.findings', { serverId: SRV })).risks.some((f) => f.id === key), 'still shown');
});

test('a hidden alert stays off the phone; the phone gets the short plain version', async () => {
  const app = testApp(); const o = await testOrg(app, 'Sam');
  setupNtfy(app, o.orgId, o.userId);
  const sent: string[] = [];
  const send = async (_u: string, init: RequestInit) => { sent.push(String(init.body)); };
  const ev = (resource: string) => ({ id: id('evt'), org_id: o.orgId, type: 'site.down', severity: 'critical' as const, message: 'shop.example.com is down: connection refused.', project_id: null, environment_id: null, resource, data: {}, created_at: new Date().toISOString() });
  assert.equal(await deliver(app, ev('ast_a') as never, send), 1);
  assert.equal(sent[0], 'Real. shop.example.com is down: connection refused.\nVisitors can’t reach it right now. Unit7 is checking why and will tell you the fix.');
  ok(await o.h('snooze.set', { key: 'event:site.down:ast_b', for: '7d', kind: 'event' }));
  assert.equal(await deliver(app, ev('ast_b') as never, send), 0, 'hidden: no buzz');
  assert.equal(phoneText('no.such.kind', 'Plain message.'), 'Plain message.');
});

test('a shared server leaves the firewall to Coolify; a restart offers now or a night window', () => {
  const out = ['@@unit7 sshd', 'passwordauthentication no', '@@unit7 ufw', 'Status: inactive', '@@unit7 reboot', 'yes', '@@unit7 end'].join('\n');
  const { findings } = auditFindings({ id: SRV, name: 'web-1', port: 22, provider_ref: null }, { sharedHost: '2026-10-01T00:00:00Z' } as never, out);
  const fw = findings.find((f) => f.id.startsWith('server:firewall'))!;
  assert.deepEqual([fw.severity, fw.fix], ['info', undefined], 'nothing that loops: no "turn it on" that prepare would skip');
  assert.match(explainFinding(fw).next, /closes single doors instead/);
  const rb = findings.find((f) => f.id.startsWith('server:reboot'))!;
  assert.ok(rb.fix && 'tool' in rb.fix);
  assert.deepEqual([rb.fix.tool, rb.fix.alt?.[0]?.tool], ['server.reboot', 'reboot.window']);
});

// --- the words ------------------------------------------------------------------------------------------------------
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const plain = (what: string, lines: string[]) => {
  assert.equal(lines.length, 3, what);
  for (const l of lines) assert.ok(l && l.trim().length > 8, `${what}: a real sentence (“${l}”)`);
  assert.deepEqual(jargonIn(lines.join(' ')), [], `${what}: no tool words in the first three lines (${lines.join(' | ')})`);
};

test('every finding kind has three plain lines, whatever its fix, with no jargon', () => {
  // every kind the engines make (their ids, up to the second colon) has its own words
  const made = new Set<string>();
  for (const f of ['discovery/findings.ts', 'tools/security.ts', 'sentinel/traffic.ts']) for (const m of src(f).matchAll(/id: `((?:server|xray|app|domain|unit7|traffic|logs):[a-z0-9-]+)/g)) made.add(m[1]!);
  for (const m of src('tools/security.ts').matchAll(/id: '(unit7:[a-z-]+)'/g)) made.add(m[1]!);
  assert.ok(made.size >= 45, `found ${made.size} kinds`);
  for (const k of made) assert.ok(FINDING_WORDS[k], `${k} has plain words`);
  const fixes = [{ tool: 'x.y' }, { ask: 'look', manual: ['a'] }, { manual: ['a'] }, undefined];
  for (const k of Object.keys(FINDING_WORDS)) for (const fix of fixes) {
    const port = k === 'server:port' ? [5432, 2375, 8080, 3000] : [0];
    for (const p of port) {
      const e = explainFinding({ id: `${k}:${SRV}${p ? `:${p}` : ':thing'}`, title: k === 'domain:registration' ? 'example.com expires soon' : 'shop-db has something to look at', detail: 'Technical detail.', evidence: 'docker ps: 0.0.0.0:5432', fix: fix as never });
      plain(`${k}${p ? `:${p}` : ''} (${fix ? Object.keys(fix)[0] : 'no fix'})`, [e.what, e.why, e.next]);
      assert.match(e.advanced!, /Technical detail\..*Seen: docker ps/, `${k}: the technical detail stays under Advanced`);
    }
  }
  assert.equal(kindOf(`xray:no-backup:${SRV}:coolify:x`), 'xray:no-backup');
  // the owner's exact case
  const e = explainFinding({ id: `xray:no-backup:${SRV}:coolify:shopsupa01`, title: 'shop-supabase has no backups Unit7 can see', detail: 'If the server dies…', fix: { tool: 'part.backup_schedule' } });
  assert.deepEqual([e.what, e.why, e.next], ['shop-supabase holds your app’s data, and no copy of it is kept anywhere Unit7 can see.', 'If the server breaks or something is deleted by mistake, that data is gone for good.',
    'Unit7 can copy it every day, keep the last 7, and store them safely off the server, starting now.']);
});

test('every alert and suggestion kind has plain words, with no jargon', () => {
  // each kind of phone alert (src/sentinel/notify.ts)
  const alerts = [...src('sentinel/notify.ts').matchAll(/'([a-z_]+\.[a-z_]+)': \{ title:/g)].map((m) => m[1]!);
  assert.ok(alerts.length >= 40);
  for (const t of alerts) { assert.ok(EVENT_WORDS[t], `${t} has plain words`); const e = explainEvent(t, 'msg'); plain(t, [e.what, e.why, e.next]); }
  // each kind of Warden suggestion (src/suggestions.ts)
  const kinds = new Set([...src('suggestions.ts').matchAll(/id: `([a-z0-9-]+):/g)].map((m) => m[1]!));
  for (const k of kinds) { assert.ok(SUGGESTION_WORDS[k], `${k} has plain words`); plain(k, ['A sentence from Warden here.', ...SUGGESTION_WORDS[k]!]); }
  // usage jumps on the server watch
  for (const kind of ['high', 'spike', 'leak', 'restarts', 'disk']) { const e = explainAlert({ source: 'usage', key: `coolify:shop:${kind}:mem`, title: 'tech', data: { kind, name: 'shop', metric: 'mem' } }); plain(kind, [e.what, e.why, e.next]); }
  // the banned words are caught (and only whole words)
  assert.deepEqual(jargonIn('The OOM killer hit the container on port 5432'), ['oom', 'container', 'port']);
  assert.deepEqual(jargonIn('Your database is important'), []);
});

test('bringing a part backup back: a test copy by default (Undo removes it); over the live one only for a person, its name typed, a fresh backup first', async () => {
  const { app, o, seen } = await setup();
  const exec = ssh(app).exec; // the file check answers with the checksum alone
  ssh(app).exec = async (s, command, opt) => (command.includes('gunzip -t') ? { code: 0, stdout: `${sum}\n`, stderr: '', truncated: false } : exec(s, command, opt));
  ok(await o.h('part.backup', { serverId: SRV, part: 'c:mysql-db' }));
  const list = ok(await o.h('part.backups', { serverId: SRV }));
  const mysql = list.find((x: any) => x.part === 'c:mysql-db');
  assert.equal(mysql.name, 'mysql-db');
  assert.equal(mysql.backups.length, 1);
  assert.equal(mysql.canRestoreOverLive, true);

  // into a test copy: a new container from the same image, labelled, no port published; Activity's Undo removes it
  seen.length = 0;
  const copy = ok(await o.h('part.restore', { serverId: SRV, part: 'c:mysql-db' }));
  assert.equal(copy.into, 'copy');
  assert.match(copy.copy, /^mysql-db-copy-\d{8}-[a-z0-9]{4}$/);
  const made = seen.find((c) => c.includes('docker run -d'))!;
  assert.ok(made.includes(`'mysql:8'`) && made.includes(`'${copy.copy}'`) && made.includes('unit7.copy-of'));
  assert.ok(!/ -p /.test(made), 'no port open');
  const copyPw = app.vault.resolve(o.orgId, copy.passwordRef)!;
  assert.ok(copyPw && !made.includes(copyPw), 'the copy’s password isn’t on its command line (it goes on stdin)');
  assert.ok(!JSON.stringify(all(app.db, 'SELECT * FROM events')).includes(copyPw), 'the copy’s password stays out of events');
  seen.length = 0;
  ok(await o.h('change.undo', { changeId: copy.changeId }));
  assert.ok(seen.some((c) => c.includes('docker rm -f') && c.includes(copy.copy)));

  // over the live one: an AI can't; a person types the name; a fresh backup is taken before the restore
  assert.equal((await o.a('part.restore', { serverId: SRV, part: 'c:mysql-db', into: 'live', confirmName: 'mysql-db' })).status, 'denied');
  const yes = async (r: any, name = 'mysql-db') => (r.status === 'approval_required' ? decideApproval(app, o.orgId, o.human, r.approvalId, true, name) : r) as any;
  assert.equal((await yes(await o.h('part.restore', { serverId: SRV, part: 'c:mysql-db', into: 'live', confirmName: 'mysql' }))).status, 'error');
  seen.length = 0;
  const live = ok(await yes(await o.h('part.restore', { serverId: SRV, part: 'c:mysql-db', into: 'live', confirmName: 'mysql-db' })));
  const dumpAt = seen.findIndex((c) => c.includes('mysqldump')), restoreAt = seen.findIndex((c) => c.includes('exec mysql -uroot'));
  assert.ok(dumpAt >= 0 && restoreAt > dumpAt, 'backed up first, then restored');
  assert.ok(live.safetyBackup);

  // Postgres over the live one needs its test restore first: this stand-in's file holds no tables, so it stops there (test/gap-data.test.ts has the rest)
  ok(await o.h('part.backup', { serverId: SRV, part: 'coolify:relaydb01' }));
  assert.equal((await yes(await o.h('part.restore', { serverId: SRV, part: 'coolify:relaydb01', into: 'live', confirmName: 'relay-db' }), 'relaydb01')).status, 'error');
});
