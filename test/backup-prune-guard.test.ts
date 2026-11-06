// Backups of databases found on a server can't be thinned by an AI: only Warden's own scheduled run (decided from who
// asks and the schedule row, never from a "reason") prunes; an AI may take 2 extra backups an hour per database but
// never changes a schedule's frequency or keep. MongoDB's password never goes on a command line, dump or restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { all, get, id, run } from '../src/db.ts';
import { buildInventory } from '../src/discovery/xray.ts';
import { saveXray } from '../src/tools/xray.ts';
import { manageDirs, mongoAs } from '../src/tools/manage.ts';
import { decideApproval } from '../src/tools/runtime.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';

const SRV = 'srv_fix000000001', PART = 'coolify:shopsupa01';
const dump = gzipSync(Buffer.from('-- dump\n'.repeat(50)));
const sum = createHash('sha256').update(dump).digest('hex');
const WARDEN = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' } as const;

async function setup() {
  Object.assign(manageDirs, { backups: '/tmp/unit7-test-backups' });
  const app = testApp(), o = await testOrg(app, 'Sam');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'web-1', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', '{}')`, SRV, o.orgId);
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
  inv.parts.push({ id: 'c:mongo-db', kind: 'database', name: 'mongo-db', owner: 'compose', trust: 'understood', engine: 'mongo', image: 'mongo:7', containers: ['mongo-db-1'], project: 'c:shop' } as never);
  saveXray(app.db, o.orgId, SRV, 'fast', inv);
  const seen: string[] = [];
  ssh(app).exec = async (_s, command: string) => {
    seen.push(command);
    // the file check before a restore answers with the checksum alone; the size-and-checksum read after a dump with both
    const stdout = command.includes('gunzip -t') ? `${sum}\n` : command.includes('sha256sum') ? `${dump.length}\n${sum}\n` : '';
    return { code: 0, stdout, stderr: '', truncated: false };
  };
  ssh(app).getFile = async (_s, _r, local) => { writeFileSync(local, dump); };
  return { app, o, seen, warden: o.as(WARDEN as never) };
}

test('seven AI backups saying "scheduled" lose nothing; the schedule stays a person’s; only Warden’s due run prunes', async () => {
  const { app, o, warden } = await setup();
  ok(await o.h('part.backup_schedule', { serverId: SRV, part: PART })); // the person: daily, keep 7
  // a week of good history, each with an off-server copy on this computer
  const dir = mkdtempSync(join(tmpdir(), 'unit7-hist-')), files: string[] = [];
  for (let d = 1; d <= 6; d++) {
    const f = join(dir, `day${d}.enc`); writeFileSync(f, 'x'); files.push(f);
    const at = new Date(Date.now() - d * 86400_000).toISOString();
    run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at, offsite, created_at) VALUES (?, ?, NULL, ?, ?, 'postgres', 'scheduled (daily)', ?, 1, 'x', 'done', ?, ?, ?)`,
      id('bak'), o.orgId, SRV, PART, `/var/lib/x/day${d}.sql.gz`, at, JSON.stringify({ local: f }), at);
  }
  // Warden itself, when the schedule isn't due: a backup, never a prune
  ok(await warden('part.backup', { serverId: SRV, part: PART, reason: 'scheduled (daily)' }));
  assert.equal(files.filter(existsSync).length, 6, 'not due: nothing pruned');
  const before = all(app.db, 'SELECT id FROM backups WHERE part = ?', PART).length; // 6, the first one and Warden's early one

  // the reviewer's attack: 7 calls with reason "scheduled"
  const statuses: string[] = [];
  for (let k = 0; k < 7; k++) { const r = await o.a('part.backup', { serverId: SRV, part: PART, reason: 'scheduled' }); statuses.push(r.status === 'error' ? r.error.code : r.status); }
  assert.deepEqual(statuses, ['ok', 'ok', 'too_many', 'too_many', 'too_many', 'too_many', 'too_many'], 'two extra backups an hour, then a person');
  assert.equal(files.filter(existsSync).length, 6, 'every older copy is still on this computer');
  assert.equal(all(app.db, 'SELECT id FROM backups WHERE part = ?', PART).length, before + 2, 'nothing removed, two added');
  assert.deepEqual(all<{ reason: string }>(app.db, `SELECT reason FROM backups WHERE part = ? AND reason NOT LIKE 'scheduled%'`, PART).map((r) => r.reason), ['auto (scheduled (daily))', 'extra (scheduled)', 'extra (scheduled)'],
    'only Warden’s due run carries the label pruning counts');

  // the schedule: an AI can't make it hourly, keep fewer, or more (people only); the same values are just an extra backup
  for (const change of [{ frequency: 'hourly', keep: 7 }, { keep: 30 }, { keep: 5 }]) {
    const r = await o.a('part.backup_schedule', { serverId: SRV, part: PART, ...change });
    assert.equal(r.status === 'error' && r.error.code, 'forbidden', JSON.stringify(change));
  }
  assert.equal((await o.a('part.backup_schedule', { serverId: SRV, part: PART, off: true })).status, 'denied');
  const again = await o.a('part.backup_schedule', { serverId: SRV, part: PART });
  assert.equal(again.status === 'error' && again.error.code, 'too_many', 'the same schedule again is an extra backup, rate-limited too');
  assert.deepEqual({ ...get<object>(app.db, 'SELECT frequency, keep FROM part_backup_schedules WHERE part = ?', PART) }, { frequency: 'daily', keep: 7 });

  // Warden's due run: the newest 7 scheduled stay (the AI's extra ones don't push good ones out)
  run(app.db, 'UPDATE part_backup_schedules SET last_run_at = ?', new Date(Date.now() - 25 * 3600_000).toISOString());
  ok(await warden('part.backup', { serverId: SRV, part: PART, reason: 'scheduled (daily)' }));
  assert.equal(all(app.db, `SELECT 1 FROM backups WHERE part = ? AND reason LIKE 'scheduled%'`, PART).length, 7);
  assert.deepEqual(files.map(existsSync), [true, true, true, true, true, false], 'only the oldest went');

  // a person can still change it
  ok(await o.h('part.backup_schedule', { serverId: SRV, part: PART, frequency: 'weekly', keep: 3 }));
});

test('MongoDB: the password reaches mongodump and mongorestore through a 0600 file in the container, never a command line', async () => {
  // the snippet itself, run by a real shell against stand-in tools that write down what they got
  const bin = mkdtempSync(join(tmpdir(), 'unit7-mongo-')), out = join(bin, 'out');
  for (const tool of ['mongodump', 'mongorestore']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "args: $*" > "${out}"\nfor a in "$@"; do case "$a" in --config=*) f="\${a#--config=}"; echo "file: $f" >> "${out}"; ls -l "$f" | cut -c1-10 >> "${out}"; cat "$f" >> "${out}";; esac; done\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const pw = `pa'ss: #x "y" $HOME`;
  const sh = (snippet: string, env: Record<string, string>) => spawnSync('/bin/sh', ['-c', snippet], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: 'utf8' });
  for (const tool of ['mongodump --quiet --archive', 'mongorestore --quiet --archive --drop']) {
    const r = sh(mongoAs(tool), { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: pw });
    assert.equal(r.status, 0, r.stderr);
    const got = readFileSync(out, 'utf8').split('\n');
    assert.match(got[0]!, new RegExp(`^args: ${tool.split(' ').slice(1).join(' ')} --username=root --authenticationDatabase=admin --config=\\S+$`));
    assert.ok(!got[0]!.includes('pa\'ss'), 'not on the command line');
    assert.equal(got[2], '-rw-------', 'only its owner can read it');
    assert.equal(got.slice(3).join('\n').trim(), `password: 'pa''ss: #x "y" $HOME'`, 'YAML single quotes keep the password exactly');
    assert.ok(!existsSync(got[1]!.slice(6)), 'removed afterwards');
  }
  const none = sh(mongoAs('mongodump --quiet --archive'), {});
  assert.equal(none.status, 0);
  assert.equal(readFileSync(out, 'utf8').trim(), 'args: --quiet --archive', 'no root user: no file, no sign-in');

  // and both commands Unit7 sends: the dump and the restore over the live database
  const { app, o, seen } = await setup();
  ok(await o.h('part.backup', { serverId: SRV, part: 'c:mongo-db' }));
  const yes = async (r: any) => (r.status === 'approval_required' ? decideApproval(app, o.orgId, o.human, r.approvalId, true, 'mongo-db') : r) as any;
  ok(await yes(await o.h('part.restore', { serverId: SRV, part: 'c:mongo-db', into: 'live', confirmName: 'mongo-db' })));
  const mongo = seen.filter((c) => /mongodump|mongorestore/.test(c));
  assert.ok(mongo.some((c) => c.includes('mongodump')) && mongo.some((c) => c.includes('mongorestore')), 'both ran');
  for (const c of mongo) {
    assert.ok(!c.includes('--password'), 'no password flag anywhere');
    assert.ok(c.includes('--config="$f"'));
  }
});
