// Backups, off-server copies, password changes and non-root servers: each a check that fails if the bug comes back.
// The server is a stand-in (ssh exec replaced), so these run without Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok, fakeBucket } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { s3 } from '../src/connectors/s3.ts';
import { all, get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { plainWrite } from '../src/tools/databases.ts';

const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });

async function setup(username = 'root') {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === 'development').id;
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', ?, 'credential://ssh/box/private-key', 'ready')`, srv, o.orgId, username);
  run(app.db, `UPDATE orgs SET offsite = 'off' WHERE id = ?`, o.orgId); // no background copies unless a test asks
  const db = (kind: string, slug: string, config: object = {}) => {
    const svc = id('svc');
    run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) SELECT ?, org_id, project_id, id, ?, ?, ?, ?, ? FROM environments WHERE id = ?`,
      svc, srv, slug, slug, kind, JSON.stringify({ container: `${slug}-c`, ...config }), env);
    return svc;
  };
  return { app, o, env, srv, db };
}

// record every command; answer with `reply` (undefined = success, no output)
function fakeServer(app: App, reply: (command: string, o: ExecOptions) => ReturnType<typeof done> | undefined = () => undefined) {
  const seen: { command: string; stdin: string }[] = [];
  ssh(app).exec = async (_s, command, o = {}) => { seen.push({ command, stdin: String(o.stdin ?? '') }); return reply(command, o) ?? done(); };
  return seen;
}

test('a sudo user joins the docker group, owns /var/lib/unit7, and gets a fresh connection', async () => {
  for (const user of ['deploy', 'root']) {
    const { app, o, srv } = await setup(user);
    const closed: string[] = [];
    ssh(app).close = (sid: string) => { closed.push(sid); };
    const seen = fakeServer(app, (c) => {
      if (c.includes('os-release')) return done(`sudo=${user === 'root' ? 'root' : 'yes'}\ndocker=27.1.1\nhas=systemctl\ncaddy=Up 2 hours\nuser=${user}\n`);
      if (c.includes('usermod')) return done('added\n');
      if (c.includes('daemon.json')) return done('{"log-opts":{"max-size":"20m"}}');
    });
    ok(await o.h('server.bootstrap', { serverId: srv, firewall: false, swap: false, securityUpdates: false }));
    const all = seen.map((x) => x.command).join('\n');
    if (user === 'root') {
      assert.ok(!/usermod|chown -R/.test(all), 'root needs neither');
      assert.deepEqual(closed, []);
    } else {
      assert.match(all, /sudo -n usermod -aG docker/);
      assert.match(all, /sudo -n chown -R "\$\(id -un\)": \/var\/lib\/unit7/);
      assert.ok(all.indexOf('usermod') < all.indexOf('docker network'), 'in the group before the first docker command');
      assert.deepEqual(closed, [srv], 'the pooled login is dropped so the new group applies');
    }
  }
});

test('retention keeps N scheduled backups; safety backups age out after a week, newest 3 kept', async () => {
  const { app, o, db } = await setup();
  const pg = db('postgres', 'pg');
  const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
  const add = (reason: string, days: number) => { const b = id('bak'); run(app.db, `INSERT INTO backups (id, org_id, service_id, kind, reason, location, status, created_at) VALUES (?, ?, ?, 'postgres', ?, ?, 'done', ?)`, b, o.orgId, pg, reason, `/var/lib/unit7/backups/${b}.gz`, ago(days)); return b; };
  const sched = [1, 2, 3, 4, 5].map((d) => add('scheduled (daily)', d));
  const recent = [add('before deploy', 0.5), add('before restore', 1)];
  const old = [10, 11, 12, 13].map((d) => add(d === 12 ? 'manual' : 'before deploy', d));
  const rm = fakeServer(app);
  assert.equal(ok(await o.h('backup.prune', { serviceId: pg, keep: 2 })).removed, 6);
  const left = new Set(all<{ id: string }>(app.db, 'SELECT id FROM backups WHERE service_id = ?', pg).map((b) => b.id));
  assert.deepEqual([...left].sort(), [...sched.slice(0, 2), ...recent, old[0]!].sort(), 'two scheduled, the recent safety ones, and the newest 3 safety ones overall');
  assert.equal(rm.filter((x) => x.command.includes('rm -f')).length, 6, 'the files go too');
  // an AI still can't prune below what the schedule keeps
  ok(await o.h('backup.schedule', { serviceId: pg, keep: 7 }));
  assert.equal((await o.a('backup.prune', { serviceId: pg, keep: 2 })).status === 'ok', false);
});

test('a missing synced folder doesn’t stop the bucket copy; the endpoint path and a bare prefix are kept', async () => {
  const fb = await fakeBucket();
  try {
    const { app, o, db } = await setup();
    const pg = db('postgres', 'pg');
    const body = randomBytes(5000), sum = createHash('sha256').update(body).digest('hex');
    const bak = id('bak');
    run(app.db, `INSERT INTO backups (id, org_id, service_id, kind, reason, location, status, checksum) VALUES (?, ?, ?, 'postgres', 'manual', '/var/lib/unit7/backups/pg-1.gz', 'done', ?)`, bak, o.orgId, pg, sum);
    ssh(app).getFile = async (_s, _remote, local) => { writeFileSync(local, body); };
    run(app.db, 'UPDATE orgs SET backup_folder = ? WHERE id = ?', join(mkdtempSync(join(tmpdir(), 'unit7-gone-')), 'Drive that is not running'), o.orgId);
    const acc = id('acc');
    run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta) VALUES (?, ?, 'storage', 'Bucket', 'my-backups', ?)`, acc, o.orgId,
      JSON.stringify({ ref: 'credential://storage/my-backups/secret', endpoint: `${fb.endpoint}/s3`, bucket: 'my-backups', region: 'auto', accessKeyId: 'AKIDTEST1234', prefix: 'forgeorg' }));
    app.vault.put(o.orgId, 'credential://storage/my-backups/secret', 'test-secret-1234', { kind: 'api_token', accountId: acc });
    const r = ok(await o.h('backup.offsite_copy', { backupId: bak }));
    assert.equal(r.bucket, 'my-backups');
    assert.match(r.syncedFolderProblem, /isn.t there/);
    const slug = get<{ slug: string }>(app.db, 'SELECT slug FROM orgs WHERE id = ?', o.orgId)!.slug;
    assert.deepEqual([...fb.objects.keys()], [`/s3/my-backups/forgeorg/${slug}/pg/pg-1.gz.enc`]);
    const off = JSON.parse(get<{ offsite: string }>(app.db, 'SELECT offsite FROM backups WHERE id = ?', bak)!.offsite);
    assert.ok(off.bucket && off.local && !off.error && off.folderError);
    assert.ok(get(app.db, `SELECT 1 FROM events WHERE org_id = ? AND type = 'backup.folder_failed'`, o.orgId), 'the person is told');
    // and the copy comes back through the same path
    await s3.get({ endpoint: `${fb.endpoint}/s3/`, bucket: 'my-backups', region: 'auto', accessKeyId: 'AKIDTEST1234', secret: 'test-secret-1234' }, off.bucket.key, join(tmpdir(), `unit7-${bak}.enc`));
  } finally { fb.close(); }
});

test('a backup key that fails its integrity check is never silently replaced', async () => {
  const { app, o } = await setup();
  const first = ok(await o.h('backup.recovery_key')).recoveryKey;
  assert.ok(first, 'made once, on first use');
  run(app.db, `UPDATE secrets SET ciphertext = randomblob(64) WHERE org_id = ? AND ref = 'credential://forge/backups/key'`, o.orgId);
  const r = await o.h('backup.recovery_key');
  assert.equal(r.status, 'error');
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM secrets WHERE org_id = ? AND ref = 'credential://forge/backups/key'`, o.orgId)!.n, 1, 'no new key written over it');
});

test('a password change whose pooler step fails puts the old password back in the database', async () => {
  const { app, o, db } = await setup();
  const pg = db('postgres', 'pg', { database: 'app', pool: { container: 'pg-pool' } });
  const ref = 'credential://postgres/pg/password';
  run(app.db, 'UPDATE services SET config = json_set(config, \'$.passwordRef\', ?) WHERE id = ?', ref, pg);
  app.vault.put(o.orgId, ref, 'old-password-123', { kind: 'db_password' });
  let pooler = 0;
  const seen = fakeServer(app, (c) => (c.includes('userlist.txt') && pooler++ === 0 ? done('', 1) : undefined));
  const r = await o.h('database.rotate_password', { serviceId: pg });
  assert.equal(r.status, 'error');
  const alters = seen.filter((x) => x.stdin.includes('ALTER USER'));
  assert.equal(alters.length, 2, 'changed, then changed back');
  assert.match(alters[1]!.stdin, /'old-password-123'/);
  assert.match(alters[1]!.command, /PGPASSWORD/);
  assert.ok(alters[0]!.stdin.startsWith('old-password-123\n'), 'it signs in with the current password from stdin');
  assert.ok(!seen.some((x) => x.command.includes('old-password-123')), 'never from a command line');
  assert.equal(app.vault.resolve(o.orgId, ref), 'old-password-123');
});

test('a removed database’s backup restores into another database of the same engine, chosen by a person', async () => {
  const { app, o, db } = await setup();
  const target = db('postgres', 'pg2'), other = db('mysql', 'my');
  const bak = id('bak');
  run(app.db, `INSERT INTO backups (id, org_id, service_id, kind, reason, location, status, checksum) VALUES (?, ?, NULL, 'postgres', 'scheduled (daily)', '/var/lib/unit7/backups/pg-1.gz', 'done', 'abc')`, bak, o.orgId);
  const seen = fakeServer(app, (c) => (c.includes('gunzip -t') ? done('abc\n') : c.includes('wc -c') ? done('10\nffff\n') : undefined));
  const gone = await o.h('backup.verify', { backupId: bak }); // (a restore with no target is org-wide, so it waits on an approval first)
  assert.equal(gone.status === 'error' && gone.error.code, 'service_gone');
  const wrong = await o.h('backup.restore', { backupId: bak, serviceId: other, confirm: true });
  assert.equal(wrong.status === 'error' && wrong.error.code, 'wrong_engine');
  assert.notEqual((await o.a('backup.restore', { backupId: bak, serviceId: target, confirm: true })).status, 'ok', 'an AI can’t pick where it goes');
  assert.ok(!seen.some((x) => x.command.includes('ON_ERROR_STOP')), 'nothing was restored yet');
  ok(await o.h('backup.restore', { backupId: bak, serviceId: target, confirm: true }));
  const restore = seen.find((x) => x.command.includes('ON_ERROR_STOP'))!;
  assert.ok(restore.command.includes('pg2-c'), 'into the chosen database');
  assert.ok(get(app.db, `SELECT 1 FROM backups WHERE service_id = ? AND reason = 'before restore'`, target), 'with a safety backup of it first');
});

test('a write counts as plain only when it is one INSERT, one UPDATE with a WHERE, or a simple Redis SET', async () => {
  for (const sql of ["INSERT INTO items (name) VALUES ('a'),('b')", 'UPDATE users SET plan = 2 WHERE id = 7;', 'SET greeting hello', 'HSET user:1 name ada'])
    assert.ok(plainWrite(sql), sql);
  for (const sql of ["DO $$BEGIN EXECUTE 'DR' || 'OP TABLE users'; END$$", "PREPARE s FROM CONCAT('DR','OP TABLE users')", "SET PASSWORD FOR root = 'x'", 'SET PASSWORD FOR root TO RANDOM',
    'SWAPDB 0 1', 'MIGRATE h 6379 k 0 5', 'ACL SETUSER eve on >pw +@all', 'HDEL user:1 name', "db.users['dro'+'p']()", 'UPDATE users SET plan = 2', "INSERT INTO t VALUES (1); DROP TABLE t",
    'INSERT INTO t SELECT pg_terminate_backend(pid) FROM pg_stat_activity', "UPDATE t SET v = lo_unlink(1) WHERE id = 1", "INSERT INTO t VALUES ('a')\n\\! id", 'CALL wipe()', 'CREATE TABLE t (id int)'])
    assert.ok(!plainWrite(sql), sql);
  // so in production an AI's disguised drop waits for a person
  const { app, o, env } = await setup();
  const prod = get<{ id: string }>(app.db, `SELECT id FROM environments WHERE kind = 'production' AND project_id = (SELECT project_id FROM environments WHERE id = ?)`, env)!.id;
  const svc = ok(await o.h('service.create', { environmentId: prod, name: 'web' })).serviceId;
  assert.equal((await o.a('database.query', { serviceId: svc, sql: "DO $$BEGIN EXECUTE 'DR' || 'OP TABLE users'; END$$", write: true })).status, 'approval_required');
});

test('a read can’t run client commands, and its throwaway client has no privileges', async () => {
  const { app, o, db } = await setup();
  const pg = db('postgres', 'pg', { engine: 'postgres', database: 'app', passwordRef: 'credential://postgres/pg/password' });
  app.vault.put(o.orgId, 'credential://postgres/pg/password', 'admin-password-1', { kind: 'db_password' });
  const seen = fakeServer(app);
  for (const sql of ['SELECT 1;\n\\! id', 'SELECT 1 \\g', 'system id']) {
    const r = await o.h('database.query', { serviceId: pg, sql });
    assert.equal(r.status === 'error' && r.error.code, 'client_command', sql);
  }
  assert.equal(seen.length, 0, 'nothing ran');
  ok(await o.h('database.query', { serviceId: pg, sql: 'SELECT count(*) FROM items' }));
  assert.match(seen.find((x) => x.command.includes('docker run'))!.command, /--user 65534 --cap-drop ALL --read-only --security-opt no-new-privileges/);
});

test('an AI can’t lower the number of backups a person chose to keep', async () => {
  const { o, db } = await setup();
  const pg = db('postgres', 'pg');
  ok(await o.h('backup.schedule', { serviceId: pg, frequency: 'daily', keep: 30 }));
  const r = await o.a('backup.schedule', { serviceId: pg, frequency: 'daily', keep: 7 });
  assert.equal(r.status === 'error' && r.error.code, 'forbidden');
  assert.notEqual((await o.a('backup.prune', { serviceId: pg, keep: 7 })).status, 'ok', 'so it can’t prune to 7 either');
  ok(await o.a('backup.schedule', { serviceId: pg, frequency: 'daily', keep: 40 }));
});
