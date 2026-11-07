// A backup that says it worked has to have worked: it's what a risky change leans on, and what a person leans on the day they need it.
// These run the real shell against a stand-in dump. The last one restores into a real Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { testApp, testOrg, ok } from './helpers.ts';
import { dockerAvailable } from './fixture.ts';
import { all, get, id, run } from '../src/db.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { gzipInto } from '../src/connectors/shell.ts';
import { saveXray } from '../src/tools/xray.ts';
import { manageDirs } from '../src/tools/manage.ts';
import { BACKUPS } from '../src/tools/backups.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'unit7-backup-'));
const fake = (bin: string, name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
const inShell = (body: string, env: NodeJS.ProcessEnv = {}) => spawnSync('sh', ['-c', body, 'unit7', ''], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('gzipInto: the file stands only when the dump and gzip both finished', () => {
  for (const before of ['', 'set -e; ']) {
    const d = dir(), f = join(d, 'a.gz');
    const good = inShell(`${before}${gzipInto('printf hello', f)}`);
    assert.equal(good.status, 0); assert.equal(gunzipSync(readFileSync(f)).toString(), 'hello');
    const dumpDied = inShell(`${before}${gzipInto('printf half; exit 42', f)}`);
    assert.equal(dumpDied.status, 3, 'a dump that fails after some output is a failure');
    assert.ok(!existsSync(f) && !existsSync(`${f}.rc`), 'and nothing half-written stays to be taken for a backup');
    const bin = dir(); fake(bin, 'gzip', 'printf x; exit 1');
    assert.equal(inShell(`${before}${gzipInto('printf whole', f)}`, { PATH: `${bin}:${process.env.PATH}` }).status, 3, 'and so is a gzip that fails after the dump finished');
    assert.ok(!existsSync(f));
  }
});

// a server that's this computer, with a stand-in for docker
async function world() {
  const app = testApp(), o = await testOrg(app), bin = dir(), root = dir(), serverId = id('srv');
  manageDirs.backups = join(root, 'parts');
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready', '{}')`, serverId, o.orgId);
  run(app.db, `UPDATE orgs SET offsite = 'off' WHERE id = ?`, o.orgId);
  ssh(app).exec = ((_s: unknown, command: string, opts: { stdin?: string } = {}) => new Promise((resolve) => {
    const c = spawn('sh', ['-c', command.replaceAll(BACKUPS, join(root, 'managed'))], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.stdin.on('error', () => undefined); c.stdin.end(opts.stdin ?? '');
    c.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, truncated: false }));
  })) as never;
  const service = (container: string) => {
    const svc = id('svc'), env = environments.find((e: any) => e.kind === 'development').id;
    run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) SELECT ?, org_id, project_id, id, ?, ?, ?, 'postgres', ? FROM environments WHERE id = ?`, svc, serverId, container, container, JSON.stringify({ container, database: 'app' }), env);
    return svc;
  };
  return { app, o, bin, root, serverId, service };
}

test('part.backup: a dump that fails part way isn’t a backup', async () => {
  const { app, o, bin, serverId } = await world();
  fake(bin, 'docker', `printf 'half a dump\\n'; echo 'invalid page in block 0' >&2; exit 1`);
  saveXray(app.db, o.orgId, serverId, 'fast', { version: 1, at: new Date().toISOString(), server: {}, paas: [], projects: [{ id: 'p', name: 'shop', owner: 'compose', trust: 'seen', how: 'x', confidence: 1, parts: ['compose:db'], health: { status: 'ok' }, domains: [] }], loose: [], ports: [], repos: [], summary: '', notes: [], parts: [{ id: 'compose:db', kind: 'database', name: 'shop-db', owner: 'compose', trust: 'seen', project: 'p', engine: 'postgres', containers: ['shop-db'], state: 'running' }] } as never);
  const r = await o.h('part.backup', { serverId, part: 'compose:db' }) as { status: string; error?: { message: string } };
  assert.equal(r.status, 'error');
  assert.match(r.error!.message, /invalid page/, 'and the person sees why');
  assert.deepEqual(all(app.db, `SELECT status FROM backups WHERE status = 'done'`), []);
});

test('backup.create: a gzip that fails after the dump finished is a failed backup, so what leans on it stops', async () => {
  const { app, o, bin, service } = await world(), svc = service('shop-db');
  fake(bin, 'docker', `printf 'a whole dump\\n'`);
  fake(bin, 'gzip', 'head -c 5; exit 1');
  const r = await o.h('backup.create', { serviceId: svc });
  assert.equal(r.status, 'error');
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM backups WHERE service_id = ?', svc)!.status, 'failed');
});

const noDocker = !dockerAvailable() && 'Docker is not available';
test('real Docker: backup.verify says yes only when the rows came back', { skip: noDocker, timeout: 240_000 }, async () => {
  const { app, o, root, service } = await world(), live = `unit7-truth-${id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a')}`;
  const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const seal = (name: string, make: string) => { const f = join(root, name); execFileSync('sh', ['-c', `docker exec ${live} pg_dump -U postgres -d app --no-owner --clean --if-exists | ${make} > '${f}'`]); return f; };
  const prove = async (file: string) => {
    const b = id('bak'); run(app.db, `INSERT INTO backups (id, org_id, service_id, kind, reason, location, status, size, checksum, finished_at) VALUES (?, ?, ?, 'postgres', 'test', ?, 'done', 1, 'x', ?)`, b, o.orgId, svc, file, new Date().toISOString());
    ok(await o.h('backup.verify', { backupId: b }));
    return get<{ verify_ok: number; verify_note: string }>(app.db, 'SELECT verify_ok, verify_note FROM backups WHERE id = ?', b)!;
  };
  const svc = service(live);
  docker('run', '-d', '--name', live, '-e', 'POSTGRES_PASSWORD=x', '-e', 'POSTGRES_DB=app', 'postgres:16-alpine');
  try {
    for (let i = 0; i < 120 && spawnSync('docker', ['exec', live, 'psql', '-U', 'postgres', '-d', 'app', '-h', '127.0.0.1', '-c', 'select 1'], { stdio: 'ignore' }).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    assert.equal((await prove(seal('empty.gz', 'gzip'))).verify_ok, 1, 'an empty database’s backup is a fair one');
    docker('exec', live, 'psql', '-q', '-U', 'postgres', '-d', 'app', '-c', `create table orders (id int primary key, note text); insert into orders select g, md5(g::text) from generate_series(1, 20000) g; create table notes (id int primary key); insert into notes select generate_series(1, 5);`);
    const good = await prove(seal('good.gz', 'gzip'));
    assert.equal(good.verify_ok, 1); assert.equal(good.verify_note, 'all 2 tables and 20,005 rows came back');
    const bad = await prove(seal('bad-row.gz', `sed 's/^5\\t.*/not-a-number/' | gzip`));
    assert.equal(bad.verify_ok, 0, 'a bad row: the tables are there, their rows aren’t'); assert.match(bad.verify_note, /came back short/);
    const cut = await prove(seal('cut.gz', 'gzip | head -c 60000'));
    assert.equal(cut.verify_ok, 0, 'a file cut short'); assert.match(cut.verify_note, /damaged/);
  } finally { spawnSync('docker', ['rm', '-fv', live], { stdio: 'ignore' }); }
});
