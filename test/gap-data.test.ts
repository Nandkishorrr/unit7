// Full tools for databases Unit7 found but didn't make. Two kinds of stand-in:
// 1. a fake SSH layer that records what's sent and answers like the real scripts, for the gate, the order of steps and failures;
// 2. the same fake running what's sent in a real shell against a scratch Postgres (data-real-pg.ts), for what a recording can't
//    judge: quoting, psql's output, what a dump really does. Those skip themselves where Postgres can't start.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, get, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { buildInventory, type Part } from '../src/discovery/xray.ts';
import { saveXray } from '../src/tools/xray.ts';
import { manageDirs } from '../src/tools/manage.ts';
import { decideApproval, type Ctx } from '../src/tools/runtime.ts';
import { closePg, openPgCommand, replayPg } from '../src/tools/partbackup.ts';
import { COMPOSE_IMAGE, csvToInserts, dumpProblem, nextImage, restorable } from '../src/tools/data.ts';
import { hideShapes, maskRows, parseCsv, parseTsv, personal, planMask, statement, textMask, toCsv, tokenize } from '../src/tools/datamask.ts';
import { ROLE, vaultAccount } from '../src/serverapps/adapters.ts';
import { makeRef } from '../src/vault.ts';
import { createHttp } from '../src/server/http.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { havePostgres, realShell, startPostgres, type Pg } from './data-real-pg.ts';

const SRV = 'srv_fix000000001', PG = 'c:pg-db', SUPA = 'coolify:shopsupa01', MY = 'c:my-db', MONGO = 'c:mg-db', REDIS = 'c:rd-db';
const dump = gzipSync(Buffer.from('COPY public.users (id) FROM stdin;\n1\n2\n\\.\n'));
const sum = createHash('sha256').update(dump).digest('hex');
const part = (x: Partial<Part>) => ({ kind: 'database', owner: 'compose', trust: 'understood', project: 'c:shop', ...x } as Part);

async function setup(o: { login?: boolean } = {}) {
  Object.assign(manageDirs, { backups: '/tmp/unit7-test-backups' });
  const app = testApp(), org = await testOrg(app, 'Sam');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'web-1', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', '{}')`, SRV, org.orgId);
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
  inv.parts.push(
    part({ id: PG, name: 'pg-db', engine: 'postgres', image: 'postgres:16-alpine', containers: ['pg-db-1'], networks: ['shop_default'], compose: { project: 'shop', service: 'db', workingDir: '/srv/shop', files: '/srv/shop/docker-compose.yml' } }),
    part({ id: MY, name: 'my-db', engine: 'mysql', image: 'mysql:8.4', containers: ['my-db-1'], networks: ['shop_default'] }),
    part({ id: MONGO, name: 'mg-db', engine: 'mongo', image: 'mongo:7', containers: ['mg-db-1'], networks: ['shop_default'] }),
    part({ id: REDIS, name: 'rd-db', engine: 'redis', image: 'redis:7-alpine', containers: ['rd-db-1'], networks: ['shop_default'] }),
    part({ id: 'c:web', name: 'web', kind: 'app', image: 'nginx:1', containers: ['web-1'] }),
  );
  saveXray(app.db, org.orgId, SRV, 'fast', inv);
  if (o.login !== false) for (const p of [PG, SUPA, MY, MONGO]) putLogin(app, org.orgId, p);
  return { app, o: org, inv };
}
function putLogin(app: App, orgId: string, p: string, name = 'db-read-password') {
  app.vault.put(orgId, makeRef('serverapp', vaultAccount(SRV, p), `x.${name}`), 'readonly-Passw0rd-value', { kind: 'serverapp', by: 'test', meta: { name, user: ROLE, label: 'Read-only', appName: 'x', part: p, serverId: SRV } });
}
// a stand-in server: every command and its stdin, answered by a function of them
type Reply = { code?: number; stdout?: string; stderr?: string } | undefined;
function fake(app: App, reply: (cmd: string, stdin: string) => Reply = () => undefined) {
  const seen: { command: string; stdin: string }[] = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    const stdin = String(o.stdin ?? '');
    seen.push({ command, stdin });
    const r = reply(command, stdin) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', truncated: false };
  };
  ssh(app).check = async (s, command, o = {}) => { const r = await ssh(app).exec(s, command, o); if (r.code !== 0) throw new Error(`${o.what ?? 'command'}: ${r.stderr}`); return r.stdout; };
  ssh(app).getFile = async (_s, _r, local) => { writeFileSync(local, 'a,b\n1,2\n'); };
  ssh(app).putFile = async () => undefined;
  return seen;
}
const code = (r: any) => (r.status === 'error' ? r.error.code : r.status);
const has = (seen: { command: string }[], text: string) => seen.findIndex((x) => x.command.includes(text));
// a backup answers with its size and checksum
const backups = (cmd: string): Reply => (cmd.includes('wc -c') ? { stdout: `${dump.length}\n${sum}\n` } : cmd.includes('gunzip -t') ? { stdout: `${sum}\n` } : undefined);

// --- the real thing -----------------------------------------------------------------------------------------------------------
const pgUp = havePostgres() ? startPostgres() : undefined;
const real = { skip: pgUp ? false : 'no Postgres can start here' };
after(() => pgUp?.stop());

async function withPg(login = true) {
  const s = await setup({ login: false }), pg = pgUp as Pg;
  if (login) putLogin(s.app, s.o.orgId, PG);
  pg.sql(`DROP DATABASE IF EXISTS shop WITH (FORCE); CREATE DATABASE shop;`);
  pg.sql(`DROP ROLE IF EXISTS ${ROLE}; CREATE ROLE ${ROLE} LOGIN BYPASSRLS PASSWORD 'pw';`);
  pg.sql(`CREATE TABLE users (id serial PRIMARY KEY, email text, full_name text, plan text);
    INSERT INTO users (email, full_name, plan) SELECT 'u' || g || '@shop.example', 'Person ' || g, CASE WHEN g % 2 = 0 THEN 'pro' ELSE 'free' END FROM generate_series(1, 5) g;
    CREATE TABLE "Order" (id int, note text); INSERT INTO "Order" VALUES (1, 'it''s, "quoted"' || chr(10) || 'two lines');
    GRANT USAGE ON SCHEMA public TO ${ROLE}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}; ALTER ROLE ${ROLE} SET default_transaction_read_only = on;`, 'shop');
  return { ...s, pg, seen: realShell(s.app, pg) };
}

test('real Postgres: tables, a person’s read, its limits', real, async () => {
  const { o, pg } = await withPg();
  const t = ok(await o.a('part.tables', { serverId: SRV, part: PG }));
  assert.equal(t.database, 'shop');
  assert.ok(t.databases.includes('shop'));
  assert.deepEqual(t.tables.map((x: any) => x.name).sort(), ['Order', 'users']);
  assert.ok(t.tables.every((x: any) => x.schema === 'public' && typeof x.bytes === 'number'));
  pg.sql('ANALYZE', 'shop');
  const exact = ok(await o.a('part.tables', { serverId: SRV, part: PG, exact: true }));
  assert.equal(exact.tables.find((x: any) => x.name === 'users').rows, 5);
  assert.equal(exact.tables.find((x: any) => x.name === 'Order').rows, 1, 'a name that needs quotes counts too');

  const r = ok(await o.h('part.query', { serverId: SRV, part: PG, sql: 'SELECT id, email FROM users ORDER BY id;', limit: 2 }));
  assert.deepEqual(r.columns, ['id', 'email']);
  assert.deepEqual(r.rows, [['1', 'u1@shop.example'], ['2', 'u2@shop.example']], 'a person sees real values');
  assert.equal(r.more, true, 'and is told there are more than the cap');
  const odd = ok(await o.h('part.query', { serverId: SRV, part: PG, sql: 'SELECT note FROM "Order"' }));
  assert.equal(odd.rows[0][0], `it's, "quoted"\ntwo lines`, 'commas, quotes and newlines survive');
  // a person's read is still a read: the database refuses, whatever the text
  assert.equal(code(await o.h('part.query', { serverId: SRV, part: PG, sql: 'DELETE FROM users' })), 'needs_write');
  const cte = await o.h('part.query', { serverId: SRV, part: PG, sql: 'WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d' });
  assert.equal(code(cte), 'query_failed');
  assert.equal(pg.sql('SELECT count(*) FROM users', 'shop').trim(), '5');
});

test('real Postgres: an AI reads through the read-only login, in the box, and can count but not see', real, async () => {
  const { o, pg, seen } = await withPg();
  const q = (sql: string) => o.a('part.query', { serverId: SRV, part: PG, sql });
  const star = ok(await q('SELECT * FROM users ORDER BY id LIMIT 1'));
  assert.deepEqual(star.columns, ['id', 'email', 'full_name', 'plan']);
  assert.deepEqual(star.rows, [['1', '[hidden]', '[hidden]', 'free']]);
  assert.deepEqual(star.masked.sort(), ['email', 'full_name']);
  assert.ok(seen.every((x) => !x.command.includes('readonly-Passw0rd-value')), 'the password is on no command line');
  assert.ok(seen.some((x) => /docker run --rm -i --user 65534 --cap-drop ALL --read-only/.test(x.command)), 'a box that holds nothing');
  for (const sql of ['SELECT email AS x FROM users', 'SELECT lower(email) FROM users', 'SELECT row_to_json(u) FROM users u', 'SELECT u FROM users u', `SELECT string_agg(email, ',') FROM users`, 'SELECT max(full_name) FROM users',
    'WITH e AS MATERIALIZED (SELECT email AS m FROM users) SELECT m FROM e', 'SELECT (SELECT email FROM users LIMIT 1)', 'SELECT plan FROM users UNION ALL SELECT email FROM users', `SELECT replace(email, '@', ' at ') FROM users`]) {
    const out = JSON.stringify(ok(await q(sql)).rows);
    assert.ok(!/shop\.example|Person|\bat shop\b/.test(out), `${sql} leaked: ${out}`);
    assert.ok(out.includes('[hidden]'), sql);
  }
  // may always count and aggregate
  assert.deepEqual(ok(await q('SELECT count(*), count(email), count(DISTINCT email) AS emails FROM users')).rows, [['5', '5', '5']]);
  assert.deepEqual(ok(await q('SELECT plan, count(*) FROM users GROUP BY plan ORDER BY plan')).rows, [['free', '3'], ['pro', '2']]);
  assert.deepEqual(ok(await q(`SELECT plan FROM users WHERE email = 'u2@shop.example'`)).rows, [['pro']], 'a filter on a personal column shows only what’s asked for');
  // the role refuses what no parser could
  assert.equal(code(await q('SELECT 1; DROP TABLE users')), 'bad_statement');
  assert.equal(code(await q('DROP TABLE users')), 'needs_write');
  const wrote = await q('WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d');
  assert.equal(code(wrote), 'query_failed');
  assert.equal(code(await q(`SELECT query_to_xml(concat('select em', 'ail from users'), true, true, '')`)), 'not_for_ai');
  assert.equal(pg.sql('SELECT count(*) FROM users', 'shop').trim(), '5');
  // a table with row-level security the login can't pass: an error, never a quiet zero
  pg.sql(`ALTER ROLE ${ROLE} NOBYPASSRLS; ALTER TABLE users ENABLE ROW LEVEL SECURITY;`, 'shop');
  const rls = await q('SELECT count(*) FROM users');
  assert.equal(code(rls), 'row_security');
  assert.equal(ok(await o.a('part.tables', { serverId: SRV, part: PG, exact: true })).tables.find((x: any) => x.name === 'users').rows, 5, 'Unit7’s own count still sees them all');
});

test('real Postgres: a write is one statement, as the admin, after a backup, and nothing else ran', real, async () => {
  const { app, o, pg, seen } = await withPg();
  noBackups(app);
  const r = await o.a('part.query', { serverId: SRV, part: PG, sql: `UPDATE users SET plan = 'it''s' WHERE id = 1`, write: true });
  assert.equal(r.status, 'approval_required', 'an AI’s write waits for a person');
  const done = ok(await decide(app, o, r));
  assert.equal(done.done, 'UPDATE 1');
  assert.ok(done.safetyBackup);
  assert.equal(pg.sql('SELECT plan FROM users WHERE id = 1', 'shop').trim(), `it's`);
  assert.ok(seen.every((x) => !x.command.includes('UPDATE users')), 'the statement travels on stdin');
  assert.equal(code(await o.h('part.query', { serverId: SRV, part: PG, sql: `UPDATE users SET plan = 'x'; DROP TABLE users`, write: true, confirm: 'pg-db' })), 'bad_statement');
  assert.equal(pg.sql('SELECT count(*) FROM users', 'shop').trim(), '5');
  // a person types its name
  assert.equal(code(await o.h('part.query', { serverId: SRV, part: PG, sql: 'DELETE FROM users', write: true })), 'confirm_needed');
  assert.equal(pg.sql('SELECT count(*) FROM users', 'shop').trim(), '5');
  ok(await o.h('part.query', { serverId: SRV, part: PG, sql: 'DELETE FROM users WHERE id = 5', write: true, confirm: 'pg-db' }));
  assert.equal(pg.sql('SELECT count(*) FROM users', 'shop').trim(), '4');
});

test('real Postgres: over the live one, closed to apps meanwhile, and proven against the file', real, async () => {
  const { app, o, pg, seen } = await withPg();
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', SRV);
  const ctx = { app, signal: new AbortController().signal } as unknown as Ctx;
  const file = join(pg.dir, 'b.sql.gz');
  pg.dumpTo(file);
  pg.sql(`DELETE FROM users WHERE id > 1; UPDATE users SET plan = 'changed'; CREATE TABLE later (id int);`, 'shop');
  pg.sql(`CREATE TABLE IF NOT EXISTS keepme (id int);`, 'template1');
  const hba = pg.sql('show hba_file').trim(), before = readFileSync(hba, 'utf8');
  await closePg(ctx, s, 'pg-db-1', 'postgres:16-alpine', 'pg-db');
  const shut = readFileSync(hba, 'utf8');
  assert.match(shut, /^host all all 127\.0\.0\.1\/32 trust\nhost all all ::1\/128 trust\nhost all all all reject\n/);
  assert.ok(shut.endsWith(before), 'the file’s own lines stay under the new ones');
  await closePg(ctx, s, 'pg-db-1', 'postgres:16-alpine', 'pg-db'); // twice is once: the copy kept is the real one
  const proof = await replayPg(ctx, s, 'pg-db-1', 'postgres:16-alpine', file);
  assert.equal(proof.ok, true, proof.note);
  assert.match(proof.note, /all \d+ tables? and \d+ rows? came back/);
  assert.equal(pg.sql('SELECT count(*) FROM users', 'shop').trim(), '5', 'the rows came back');
  assert.equal(pg.sql(`SELECT plan FROM users WHERE id = 1`, 'shop').trim(), 'free', 'the data is the file’s, not what was there');
  assert.equal(pg.sql(`SELECT count(*) FROM pg_tables WHERE tablename = 'later'`, 'shop').trim(), '0', 'what came after the backup is gone');
  assert.equal(pg.sql(`SELECT rolname FROM pg_roles WHERE rolname = '${ROLE}'`).trim(), ROLE, 'roles that exist carry on');
  await ssh(app).check(s, openPgCommand(s, 'pg-db-1', 'postgres:16-alpine'), { what: 'open' });
  assert.equal(readFileSync(hba, 'utf8'), before, 'pg_hba.conf is as it was');
  assert.ok(!existsSync(`${hba}.unit7`));
  assert.ok(seen.some((x) => x.command.includes('DROP DATABASE') || x.command.includes('pg_terminate_backend')));
  // a damaged file stops before anything is dropped: a database name that isn't plain
  const evil = join(pg.dir, 'evil.sql.gz');
  writeFileSync(evil, gzipSync(Buffer.from(`\\connect shop; drop\nSELECT 1;\n`)));
  const bad = await replayPg(ctx, s, 'pg-db-1', 'postgres:16-alpine', evil);
  assert.equal(bad.ok, false);
  assert.equal(pg.sql('SELECT count(*) FROM users', 'shop').trim(), '5', 'nothing was dropped');
});

// --- the rest of the real shell: files going in and out ---------------------------------------------------------------------------
function realFiles(app: App) {
  ssh(app).putFile = async (_s, local, remote) => { writeFileSync(remote, readFileSync(local)); };
  ssh(app).getFile = async (_s, remote, local) => { writeFileSync(local, readFileSync(remote)); };
}
// the "backup" of these runs: the test's own database isn't what's being backed up
function noBackups(app: App) {
  const exec = ssh(app).exec;
  ssh(app).exec = async (s, c, x) => (c.includes('pg_dumpall') || c.includes('wc -c') || c.includes('df -Pk') ? { code: 0, stdout: c.includes('wc -c') ? `${dump.length}\n${sum}\n` : '', stderr: '', truncated: false } : exec(s, c, x));
  run(app.db, `UPDATE orgs SET offsite = 'off'`);
}
const uploaded = (app: App, orgId: string, name: string, body: Buffer | string) => {
  const uploadId = `upl_${name.padEnd(12, 'x').slice(0, 12)}`, path = join(mkdtempSync(join(tmpdir(), 'u7up-')), `${uploadId}.tgz`);
  writeFileSync(path, body);
  run(app.db, 'INSERT INTO uploads (id, org_id, path, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?)', uploadId, orgId, path, Buffer.byteLength(body), 'x', 'test');
  return uploadId;
};
const decide = (app: App, o: { orgId: string; human: unknown }, r: any, name = 'pg-db') => (r.status === 'approval_required' ? decideApproval(app, o.orgId, o.human as never, r.approvalId, true, name) : r) as Promise<any>;

test('real Postgres: a CSV and a dump go in, a failure changes nothing, and a read has its limits set', real, async () => {
  const { app, o, pg } = await withPg();
  realFiles(app); noBackups(app);
  const load = async (uploadId: string, more = {}) => decide(app, o, await o.h('part.import', { serverId: SRV, part: PG, uploadId, database: 'shop', ...more }));
  const csv = uploaded(app, o.orgId, 'csv1', 'email,full_name,plan\n"a,b@shop.example","Ann ""A"" Lee",pro\nc@shop.example,Cy,free\n');
  const done = ok(await load(csv, { table: 'users' }));
  assert.equal(done.rows, 2);
  assert.ok(done.safetyBackup);
  assert.equal(pg.sql(`SELECT full_name FROM users WHERE email = 'a,b@shop.example'`, 'shop').trim(), 'Ann "A" Lee');
  const gz = uploaded(app, o.orgId, 'dump', gzipSync('CREATE TABLE imported (id int);\nINSERT INTO imported VALUES (1), (2);\n'));
  ok(await load(gz));
  assert.equal(pg.sql('SELECT count(*) FROM imported', 'shop').trim(), '2');
  // a dump that fails halfway leaves nothing behind
  const half = uploaded(app, o.orgId, 'half', 'CREATE TABLE half (id int);\nINSERT INTO half VALUES (1);\nSELECT * FROM nothing_here;\n');
  const failed = await load(half);
  assert.equal(code(failed), 'import_failed');
  assert.match(failed.error.message, /nothing_here/);
  assert.equal(pg.sql(`SELECT count(*) FROM pg_tables WHERE tablename = 'half'`, 'shop').trim(), '0');

  // the time limit and read-only mode really reach the session
  const show = async (who: typeof o.h, what: string) => ok(await who('part.query', { serverId: SRV, part: PG, sql: `SHOW ${what}` })).rows[0][0];
  assert.equal(await show(o.h, 'statement_timeout'), '30s');
  assert.equal(await show(o.h, 'default_transaction_read_only'), 'on');
  assert.equal(await show(o.a, 'statement_timeout'), '30s');
  assert.equal(await show(o.a, 'row_security'), 'off');
});

test('real Postgres: a table comes away as CSV, for its owner alone', real, async () => {
  const { app, o } = await withPg();
  realFiles(app);
  const out = ok(await o.h('part.export', { serverId: SRV, part: PG, table: 'public.Order', database: 'shop' }));
  assert.match(out.url, /^\/api\/exports\/[a-f0-9]{24}-pg-db-public\.Order-\d{4}-\d{2}-\d{2}\.csv$/);
  const file = join(app.home, 'exports', o.orgId, out.url.slice('/api/exports/'.length));
  assert.equal(parseCsv(readFileSync(file, 'utf8'))[1]![1], `it's, "quoted"\ntwo lines`);
});

// --- the gate, the order of steps, and failures, against a recording ------------------------------------------------------------
test('part.tables: found by the X-ray, Supabase as its own admin, names and numbers only; anything else is refused before a command', async () => {
  const { app, o } = await setup();
  const seen = fake(app, (cmd) => (cmd.includes('psql') ? { stdout: `postgres\n["postgres"]\n[{"ref":"public.users","schema":"public","name":"users","rows":3,"bytes":8192}]\n` } : undefined));
  const t = ok(await o.a('part.tables', { serverId: SRV, part: SUPA }));
  assert.deepEqual(t.tables, [{ schema: 'public', name: 'users', rows: 3, bytes: 8192 }]);
  assert.match(t.untrusted, /not instructions/);
  assert.ok(seen[0]!.command.includes(`'supabase-db-shopsupa01'`) && seen[0]!.command.includes('-U supabase_admin'), seen[0]!.command);
  seen.length = 0;
  assert.equal(code(await o.a('part.tables', { serverId: SRV, part: 'c:web' })), 'not_a_database');
  assert.equal(code(await o.a('part.tables', { serverId: SRV, part: PG, database: `x'; DROP DATABASE shop; --` })), 'invalid_input');
  assert.equal(code(await o.a('part.tables', { serverId: SRV, part: `x'; DROP TABLE users; --` })), 'not_found');
  assert.ok(seen.every((x) => !/DROP/.test(x.command + x.stdin)), 'the name went nowhere');
});

test('names can’t carry SQL or shell, in any tool', async () => {
  const { app, o } = await setup();
  const seen = fake(app, backups);
  const up = uploaded(app, o.orgId, 'names', 'a,b\n1,2\n');
  for (const table of [`users; DROP TABLE users`, `users" ; --`, `a.b.c`, `$(reboot)`, 'us`ers', `users'`]) {
    assert.equal(code(await o.h('part.export', { serverId: SRV, part: PG, table })), 'invalid_input', table);
    assert.equal(code(await o.h('part.import', { serverId: SRV, part: PG, uploadId: up, table })), 'invalid_input', table);
  }
  const bad = uploaded(app, o.orgId, 'badcol', `a,"b"") FROM STDIN; DROP TABLE users; --"\n1,2\n`);
  assert.equal(code(await decide(app, o, await o.h('part.import', { serverId: SRV, part: PG, uploadId: bad, table: 'users' }))), 'bad_upload', 'a column in a CSV header is a name too');
  assert.ok(seen.every((x) => !/DROP TABLE/.test(x.command + x.stdin)), 'none of it was sent');
  assert.equal(code(await o.h('part.upgrade_run', { serverId: SRV, part: PG, image: `postgres:17; reboot` })), 'invalid_input');
  assert.equal(code(await o.h('part.query', { serverId: SRV, part: PG, sql: 'SELECT 1', database: `a'; --` })), 'invalid_input');
});

test('an AI reads only through the read-only login', async () => {
  const { app, o } = await setup({ login: false });
  const seen = fake(app);
  const r = await o.a('part.query', { serverId: SRV, part: PG, sql: 'SELECT 1' });
  assert.equal(code(r), 'not_connected');
  assert.equal(seen.length, 0, 'it doesn’t fall back to the admin');
  assert.match((r as any).error.message, /serverapp\.connect/);
});

test('MySQL for an AI: names and shapes, and a personal word anywhere leaves only numbers', async () => {
  const { app, o } = await setup();
  let reply = '';
  const seen = fake(app, () => ({ stdout: reply }));
  const q = async (sql: string, out: string) => { reply = out; return ok(await o.a('part.query', { serverId: SRV, part: MY, sql })); };
  const every = await q('SELECT * FROM wp_users', 'ID\tuser_login\tuser_email\tuser_status\n1\tann\tann@shop.example\t0\n');
  assert.deepEqual(every.rows, [['1', '[hidden]', '[hidden]', '0']]);
  const alias = await q('SELECT user_email AS who, id FROM wp_users', 'who\tid\nann@shop.example\t1\n');
  assert.deepEqual(alias.rows, [['[hidden]', '1']]);
  const fn = await q(`SELECT concat(first_name, ' x') AS who FROM customers`, 'who\nAnn x\n');
  assert.deepEqual(fn.rows, [['[hidden]']]);
  assert.deepEqual((await q('SELECT count(user_email) AS n FROM wp_users', 'n\n12\n')).rows, [['12']]);
  assert.deepEqual((await q('SELECT status, count(*) FROM orders GROUP BY status', 'status\tcount(*)\npaid\t3\n')).rows, [['paid', '3']]);
  assert.deepEqual((await q('SELECT notes FROM orders', `notes\ncall +1 415 555 2671 or sam@shop.example\n`)).rows, [['call [hidden phone] or [hidden email]']], 'a shape is hidden wherever it turns up');
  assert.equal(code(await o.a('part.query', { serverId: SRV, part: MY, sql: 'SELECT 1 /*! , user_pass */ FROM wp_users' })), 'bad_statement');
  assert.equal(code(await o.a('part.query', { serverId: SRV, part: MY, sql: `SELECT * FROM t INTO OUTFILE '/tmp/x'` })), 'bad_statement');
  assert.ok(seen.every((x) => /--read-only/.test(x.command) && !x.command.includes('readonly-Passw0rd-value')), 'always the box, the password on stdin');
  assert.ok(seen[0]!.stdin.startsWith('readonly-Passw0rd-value\n'));
  assert.match(seen[0]!.stdin, /START TRANSACTION READ ONLY;\nSELECT \* FROM wp_users\n;\nROLLBACK;/);
});

test('MongoDB and Redis: one expression or one command, read-only unless written, personal fields hidden', async () => {
  const { app, o } = await setup();
  putLogin(app, o.orgId, REDIS, 'read-password');
  let reply = '';
  const seen = fake(app, () => ({ stdout: reply }));
  reply = JSON.stringify([{ _id: 1, email: 'a@shop.example', plan: 'pro', profile: { firstName: 'Ann', note: 'mail b@shop.example' } }]);
  const m = ok(await o.a('part.query', { serverId: SRV, part: MONGO, sql: 'db.users.find({ plan: "pro" })' }));
  assert.ok(!/shop\.example|Ann/.test(m.rows[0][0]), m.rows[0][0]);
  assert.match(m.rows[0][0], /"plan":"pro"/);
  reply = '[{"who":"Ann"}]';
  assert.ok(!ok(await o.a('part.query', { serverId: SRV, part: MONGO, sql: `db.users.aggregate([{ $project: { who: '$firstName' } }])` })).rows[0][0].includes('Ann'), 'a personal field under another name');
  reply = '[42]';
  assert.deepEqual(ok(await o.a('part.query', { serverId: SRV, part: MONGO, sql: 'db.users.countDocuments({ email: { $exists: true } })' })).rows, [['42']]);
  for (const sql of ['db.users.deleteMany({})', `require('child_process')`, 'db.users.find(); db.users.drop()', 'process.env']) assert.ok(['needs_write', 'bad_statement'].includes(code(await o.h('part.query', { serverId: SRV, part: MONGO, sql }))), sql);
  reply = 'hello sam@shop.example\n';
  assert.deepEqual(ok(await o.a('part.query', { serverId: SRV, part: REDIS, sql: 'GET greeting' })).rows, [['hello [hidden email]']]);
  assert.deepEqual(ok(await o.a('part.query', { serverId: SRV, part: REDIS, sql: 'GET user:9:email' })).rows, [['[hidden]']]);
  const before = seen.length;
  for (const sql of ['KEYS *', 'CONFIG SET requirepass x', 'FLUSHALL', 'SET a b', 'GET a\nFLUSHALL']) assert.ok(['needs_write', 'bad_statement'].includes(code(await o.a('part.query', { serverId: SRV, part: REDIS, sql }))), sql);
  assert.equal(seen.length, before, 'none of those ran');
  assert.equal(code(await o.h('part.query', { serverId: SRV, part: REDIS, sql: 'CONFIG SET requirepass x', write: true, confirm: 'rd-db' })), 'bad_statement');
});

test('a person sees real values, and they stay out of the logs; a key or a read-only seat gets the masked view', async () => {
  const { app, o } = await setup();
  let reply = 'id,email\n1,ann@shop.example\n';
  const PLAN = JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users', Alias: 'users', Output: ['id', 'email'] } }]);
  fake(app, (_c, stdin) => ({ stdout: stdin.includes('EXPLAIN') ? PLAN : reply }));
  const sql = 'SELECT id, email FROM users';
  assert.deepEqual(ok(await o.h('part.query', { serverId: SRV, part: PG, sql })).rows, [['1', 'ann@shop.example']]);
  assert.deepEqual(ok(await o.a('part.query', { serverId: SRV, part: PG, sql })).rows, [['1', '[hidden]']]);
  assert.deepEqual(ok(await o.as({ kind: 'token', id: 'tok_1', userId: o.userId, name: 'CLI', role: 'owner' } as never)('part.query', { serverId: SRV, part: PG, sql })).rows, [['1', '[hidden]']]);
  assert.deepEqual(ok(await o.as(o.role('readonly'))('part.query', { serverId: SRV, part: PG, sql })).rows, [['1', '[hidden]']]);
  const log = JSON.stringify(all(app.db, 'SELECT * FROM audit')) + JSON.stringify(all(app.db, 'SELECT * FROM events'));
  assert.ok(!log.includes('ann@shop.example'), 'no real value in any log');
  reply = 'id,note\n1,sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n';
  assert.ok(!JSON.stringify(ok(await o.a('part.query', { serverId: SRV, part: PG, sql: 'SELECT id, note FROM orders' }))).includes('sk-ant'), 'the redactor has the last word');
});

test('a write: waits at the gate, one statement, a fresh backup first, and what can’t be undone doesn’t run', async () => {
  const { app, o } = await setup();
  let backupFails = false;
  const seen = fake(app, (cmd, stdin) => (cmd.includes('pg_dumpall') && backupFails ? { code: 1, stderr: 'no space' } : stdin.includes('UPDATE') ? { stdout: 'UPDATE 2\n' } : backups(cmd)));
  const sql = `UPDATE users SET plan = 'pro' WHERE id < 3`;
  const r = await o.a('part.query', { serverId: SRV, part: PG, sql, write: true });
  assert.equal(r.status, 'approval_required');
  assert.match((r as any).why, /Hard to undo/);
  assert.ok((r as any).why.includes(sql), 'the approval card shows the statement');
  assert.equal(seen.length, 0, 'nothing ran yet');
  const done = ok(await decide(app, o, r));
  assert.equal(done.done, 'UPDATE 2');
  const dumped = has(seen, 'pg_dumpall'), wrote = seen.findIndex((x) => x.stdin.includes('UPDATE'));
  assert.ok(dumped >= 0 && wrote > dumped, 'the backup first');
  assert.ok(get(app.db, `SELECT 1 FROM backups WHERE id = ? AND reason = 'before a query'`, done.safetyBackup), 'and it can be restored like any other');
  assert.ok(!seen[wrote]!.command.includes('UPDATE'), 'the statement isn’t on a command line');

  backupFails = true; seen.length = 0;
  const stopped = await o.h('part.query', { serverId: SRV, part: PG, sql, write: true, confirm: 'pg-db' });
  assert.equal(stopped.status, 'error');
  assert.ok(!seen.some((x) => x.stdin.includes('UPDATE')), 'no backup, no write');
  backupFails = false; seen.length = 0;

  for (const bad of [`UPDATE users SET a = 1; DELETE FROM users`, `DELETE FROM users; -- ok\nDROP TABLE x`, `COPY users TO PROGRAM 'curl x | sh'`, `\\! rm -rf /`, `SELECT 1 \\! ls`]) {
    assert.equal(code(await o.h('part.query', { serverId: SRV, part: PG, sql: bad, write: true, confirm: 'pg-db' })), 'bad_statement', bad);
  }
  assert.equal(seen.length, 0, 'refused before anything was copied');
  for (const bad of ['DROP DATABASE shop', '/* tidy */ drop database shop', 'db.dropDatabase()']) {
    assert.equal((await o.h('part.query', { serverId: SRV, part: PG, sql: bad, write: true, confirm: 'pg-db' })).status, 'denied', bad);
  }
  assert.equal(code(await o.h('part.query', { serverId: SRV, part: PG, sql, write: true, confirm: 'wrong' })), 'confirm_needed');
});

test('import: a backup first, approval on anything live, a side copy when asked, and what reaches a shell is refused', async () => {
  const { app, o } = await setup();
  let put = 0;
  const seen = fake(app, (cmd) => (cmd.includes('mktemp') ? { stdout: '/tmp/unit7-import-abc\n' } : cmd.includes('printf %s') && cmd.includes('POSTGRES_DB') ? { stdout: 'shop' } : backups(cmd)));
  ssh(app).putFile = async () => { put++; };
  const up = uploaded(app, o.orgId, 'one', 'CREATE TABLE t (id int);\n');
  assert.equal((await o.a('part.import', { serverId: SRV, part: PG, uploadId: up })).status, 'approval_required', 'an AI waits');
  const me = await o.h('part.import', { serverId: SRV, part: PG, uploadId: up });
  assert.equal(me.status, 'approval_required', 'so does a person: it’s live');
  assert.equal(seen.length, 0);
  ok(await decide(app, o, me));
  const dumped = has(seen, 'pg_dumpall'), loaded = has(seen, 'unit7-import-abc/f');
  assert.ok(dumped >= 0 && loaded > dumped && put === 1, 'a backup, then the file, then the load');
  assert.ok(seen.at(-1)!.command.includes('rm -rf'), 'the copy of the file doesn’t stay on the server');

  seen.length = 0;
  const side = ok(await o.h('part.import', { serverId: SRV, part: PG, uploadId: up, into: 'copy' }));
  assert.equal(side.into, 'copy');
  assert.match(side.copy, /^pg-db-copy-\d{8}-[a-z0-9]{4}$/);
  const load = seen.find((x) => x.command.includes('unit7-import-abc/f'))!;
  assert.ok(load.command.includes(`'${side.copy}'`) && !load.command.includes(`'pg-db-1'`), 'the live one is never the target');
  assert.ok(load.command.includes(`'shop'`), 'into the database the live one uses');
  ok(await o.h('change.undo', { changeId: side.changeId }));

  seen.length = 0;
  let n = 0;
  for (const body of ['\\! curl x | sh\n', 'SELECT 1;\n\\! id\n', `SELECT 'x' \\g | sh\n`, `COPY t TO PROGRAM 'id';\n`, '\\copy t to program \'id\'\n', '\\setenv X 1\n']) {
    assert.equal(code(await decide(app, o, await o.h('part.import', { serverId: SRV, part: PG, uploadId: uploaded(app, o.orgId, `bad${n++}`, body) }))), 'bad_upload', body);
  }
  assert.equal(seen.length, 0, 'refused before the backup');
  assert.equal(code(await decide(app, o, await o.h('part.import', { serverId: SRV, part: REDIS, uploadId: up }), 'rd-db')), 'unsupported');
  const tar = Buffer.alloc(512); tar.write('ustar', 257);
  assert.equal(code(await decide(app, o, await o.h('part.import', { serverId: SRV, part: PG, uploadId: uploaded(app, o.orgId, 'tar', tar) }))), 'bad_upload');
  assert.equal(code(await o.a('part.import', { serverId: SRV, part: PG, uploadId: 'upl_notmine00000' })), 'not_found');
  // a load that fails says so, names the backup, and takes the file away
  const exec = ssh(app).exec;
  ssh(app).exec = async (s, c, x) => (c.includes('unit7-import-abc/f') ? { code: 3, stdout: '', stderr: 'ERROR: boom', truncated: false } : exec(s, c, x));
  seen.length = 0;
  const failed = await decide(app, o, await o.h('part.import', { serverId: SRV, part: PG, uploadId: up }));
  assert.equal(code(failed), 'import_failed');
  assert.match(failed.error.message, /boom.*backup taken just before is bak_/s);
  assert.ok(seen.at(-1)!.command.includes('rm -rf'));
});

test('a MySQL CSV goes in as INSERTs with nothing to escape from', () => {
  const sql = csvToInserts('shop.users', [['id', 'note'], ['1', `it's \\`], ['2', `'); DROP TABLE users; --`]]);
  assert.equal(sql, "INSERT INTO `shop`.`users` (`id`, `note`) VALUES\n('1', 'it''s \\\\'),\n('2', '''); DROP TABLE users; --');\n");
});

test('export: people only, owners and admins, and on the record', async () => {
  const { app, o } = await setup();
  const seen = fake(app, (cmd) => (cmd.includes('mktemp') ? { stdout: '/tmp/unit7-export-abc\n' } : backups(cmd)));
  ssh(app).getFile = async (_s, _r, local) => { writeFileSync(local, dump); };
  assert.equal((await o.a('part.export', { serverId: SRV, part: PG })).status, 'denied');
  assert.equal((await o.as({ kind: 'token', id: 'tok_1', userId: o.userId, name: 'CLI', role: 'owner' } as never)('part.export', { serverId: SRV, part: PG })).status, 'denied', 'a token could be any program');
  assert.equal((await o.as(o.role('developer'))('part.export', { serverId: SRV, part: PG })).status, 'error');
  assert.equal(seen.length, 0, 'nothing ran for them');
  const out = ok(await o.h('part.export', { serverId: SRV, part: PG }));
  assert.match(out.filename, /^pg-db-\d{4}-\d{2}-\d{2}\.sql\.gz$/);
  assert.ok(has(seen, 'pg_dumpall') >= 0 && seen.some((x) => x.command.includes('rm -f')), 'the dump made for this doesn’t stay on the server');
  assert.equal(all(app.db, `SELECT 1 FROM audit WHERE tool = 'part.export' AND result = 'success'`).length, 1, 'it’s on the record');
  assert.equal(code(await o.h('part.export', { serverId: SRV, part: REDIS, table: 'x' })), 'unsupported');
  assert.equal(code(await o.h('part.export', { serverId: SRV, part: MONGO, table: 'users' })), 'invalid_input');
});

test('the download route: a signed-in person, once; never a token, a stranger or a path', async () => {
  const app = testApp(), http = createHttp(app), BASE = 'http://localhost:4800';
  let cookie = '', bind = '';
  const call = async (path: string, o: { method?: string; body?: unknown; headers?: Record<string, string>; bound?: boolean } = {}) => {
    const res = await http.fetch(new Request(BASE + path, { method: o.method ?? 'GET', body: o.body === undefined ? undefined : JSON.stringify(o.body), headers: { 'content-type': 'application/json', origin: BASE, ...(cookie && { cookie, ...(o.bound !== false && { 'x-unit7-bind': bind }) }), ...o.headers } }));
    const set = res.headers.get('set-cookie'); bind = res.headers.get('x-unit7-bind') ?? bind;
    if (set) cookie = set.split(';')[0]!;
    return res;
  };
  await call('/api/auth/signup', { method: 'POST', body: { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' } });
  const orgId = (await (await call('/api/me')).json() as any).org.id;
  const dir = join(app.home, 'exports', orgId), name = `${'a'.repeat(24)}-pg-db-users-2026-11-06.csv`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), 'id,email\n1,a@shop.example\n');
  const token = (await (await call('/api/tokens', { method: 'POST', body: { name: 'key', role: 'owner' } })).json() as any).token;
  assert.equal((await http.fetch(new Request(`${BASE}/api/exports/${name}`, { headers: { authorization: `Bearer ${token}` } }))).status, 403, 'a token isn’t a person');
  assert.equal((await call('/api/exports/..%2F..%2Funit7.db')).status, 404);
  assert.equal((await call(`/api/exports/${'b'.repeat(24)}-nothing.csv`)).status, 404);
  // a click on a link: the cookie, without the page's header
  const res = await call(`/api/exports/${name}`, { bound: false });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="pg-db-users-2026-11-06\.csv"$/);
  assert.equal(await res.text(), 'id,email\n1,a@shop.example\n');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!existsSync(join(dir, name)), 'gone once it’s down');
  assert.equal((await call(`/api/exports/${name}`)).status, 404);
  // an address nobody can guess doesn't help a stranger: no session, nothing
  writeFileSync(join(dir, name), 'x');
  cookie = '';
  assert.equal((await call(`/api/exports/${name}`)).status, 401);
});

// --- restoring over a live Postgres ------------------------------------------------------------------------------------------
// what the scripts of a restore answer: its manifest, its row counts (`rows` of them), and the rest of a test restore
function restoring(o: { rows: () => number; verifyFails?: () => boolean; replayFails?: (file: string) => boolean } ) {
  return (cmd: string, stdin: string): Reply => {
    if (cmd.includes('print db')) return { stdout: 'shop\tpublic.users\t2\n' };
    if (stdin.includes(`select 'public.users'`)) return { stdout: `public.users|${o.rows()}\n` };
    if (cmd.includes('printf %s') && cmd.includes('POSTGRES_USER')) return { stdout: 'postgres' };
    if (cmd.includes('MemAvailable')) return { stdout: '8000000000\n' };
    if (cmd.includes('docker run -d') && o.verifyFails?.()) return { code: 1, stderr: 'it did not start' };
    if (cmd.includes('DROP DATABASE') && o.replayFails?.(cmd)) return { code: 1, stderr: 'it broke' };
    return backups(cmd);
  };
}
async function backedUp() {
  const s = await setup();
  run(s.app.db, `UPDATE orgs SET offsite = 'off'`);
  fake(s.app, backups);
  ok(await s.o.h('part.backup', { serverId: SRV, part: PG }));
  return s;
}
const live = { serverId: SRV, part: PG, into: 'live', confirmName: 'pg-db' };
const OPENS = 'then cat "$1.unit7"'; // only the step that lets apps back in (closing reads that file too)

test('Postgres over the live one: an AI can’t, a person types the name, the test restore and a fresh copy come first, apps are out meanwhile', async () => {
  const { app, o } = await backedUp();
  const seen = fake(app, restoring({ rows: () => 2 }));
  assert.equal((await o.a('part.restore', live)).status, 'denied');
  assert.equal(code(await decide(app, o, await o.h('part.restore', { ...live, confirmName: 'nope' }))), 'confirm_name');
  assert.ok(!seen.some((x) => x.command.includes('DROP DATABASE')), 'the wrong name changes nothing');
  seen.length = 0;
  const done = ok(await decide(app, o, await o.h('part.restore', live)));
  assert.equal(done.into, 'live');
  assert.ok(done.safetyBackup);
  const test_ = has(seen, 'docker run -d'), fresh = has(seen, 'pg_dumpall'), close = has(seen, 'host all all all reject'), drop = has(seen, 'DROP DATABASE'), open = seen.findLastIndex((x) => x.command.includes(OPENS));
  assert.ok(test_ >= 0 && fresh > test_ && close > fresh && drop > close && open > drop, `test ${test_}, fresh ${fresh}, closed ${close}, drop ${drop}, open ${open}`);
  assert.ok(has(seen, 'unit7-proof-') >= 0, 'the test restore was a throwaway');
  assert.equal(get<{ status: string }>(app.db, `SELECT status FROM changes WHERE verb = 'restore_open'`)!.status, 'kept', 'nothing left to open');
  assert.equal(get<{ verify_ok: number }>(app.db, 'SELECT verify_ok FROM backups ORDER BY created_at LIMIT 1')!.verify_ok, 1);
  assert.ok(ok(await o.h('part.backups', { serverId: SRV })).find((b: any) => b.part === PG).canRestoreOverLive);
});

test('a backup that fails its test restore never reaches the live one', async () => {
  const { app, o } = await backedUp();
  const seen = fake(app, restoring({ rows: () => 2, verifyFails: () => true }));
  const r = await decide(app, o, await o.h('part.restore', live));
  assert.equal(code(r), 'test_failed');
  assert.match(r.error.message, /wasn’t touched/);
  assert.ok(!seen.some((x) => /DROP DATABASE|all all reject/.test(x.command)));
  assert.ok(!get(app.db, `SELECT 1 FROM changes WHERE verb = 'restore_open'`));
});

test('a restore that doesn’t come back whole goes back to the fresh copy, and apps come back in', async () => {
  const { app, o } = await backedUp();
  let drops = 0;
  const count = () => (drops === 1 ? 1 : 2); // the first replay comes back short
  const seen = fake(app, (cmd, stdin) => { if (cmd.includes('DROP DATABASE')) drops++; return restoring({ rows: count })(cmd, stdin); });
  const r = await decide(app, o, await o.h('part.restore', live));
  assert.equal(code(r), 'restore_undone');
  assert.match(r.error.message, /Nothing was lost/);
  assert.equal(drops, 2, 'the fresh copy went back the same way');
  assert.ok(seen.some((x) => x.command.includes(OPENS)), 'it opened again');
  assert.equal(get<{ status: string }>(app.db, `SELECT status FROM changes WHERE verb = 'restore_open'`)!.status, 'kept');
});

test('if putting it back fails too, it stays closed, a person hears at once, and Undo opens it', async () => {
  const { app, o } = await backedUp();
  let counts = 0;
  const seen = fake(app, restoring({ rows: () => (counts++ === 0 ? 2 : 0) })); // the test restore is fine; both replays over the live one come back short
  const r = await decide(app, o, await o.h('part.restore', live));
  assert.equal(code(r), 'restore_failed');
  assert.match(r.error.message, /stays closed/);
  assert.ok(!seen.some((x) => x.command.includes(OPENS)), 'nothing opened it');
  assert.equal(get<{ severity: string }>(app.db, `SELECT severity FROM events WHERE type = 'backup.restore_failed'`)!.severity, 'critical');
  const ch = get<{ id: string; status: string }>(app.db, `SELECT id, status FROM changes WHERE verb = 'restore_open'`)!;
  assert.equal(ch.status, 'done');
  seen.length = 0;
  ok(await o.h('change.undo', { changeId: ch.id }));
  assert.ok(seen.some((x) => x.command.includes(OPENS)));
});

// --- files ---------------------------------------------------------------------------------------------------------------------
const FILES = '/var/backups/unit7/x/2026.files.tgz';
async function withFiles() {
  const s = await setup();
  run(s.app.db, `UPDATE orgs SET offsite = 'off'`);
  const inv = s.inv, p = inv.parts.find((x) => x.id === SUPA)!;
  p.binds = ['/srv/stack/functions', '/srv/stack/kong.yml']; p.volumes = ['shop_storage'];
  saveXray(s.app.db, s.o.orgId, SRV, 'fast', inv);
  run(s.app.db, `INSERT INTO backups (id, org_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES ('bak_files0000001', ?, ?, ?, 'files', 'extra', ?, 1, ?, 'done', ?)`, s.o.orgId, SRV, `extras:${SUPA}`, FILES, sum, new Date().toISOString());
  const seen = fake(s.app, (cmd) => (cmd.includes('tar tzf') ? { stdout: 'f0-functions/\nf1-kong.yml\nv-gone/\nv-shop_storage/\n' } : backups(cmd)));
  return { ...s, seen };
}

test('files: into a folder by default, a damaged copy stops it, and over the live ones is a person’s', async () => {
  const { app, o, seen, inv } = await withFiles();
  const name = inv.parts.find((x) => x.id === SUPA)!.name;
  const f = ok(await o.a('part.restore_files', { serverId: SRV, part: SUPA }));
  assert.match(f.folder, /\/restored-/);
  assert.ok(has(seen, 'tar xzf') >= 0);
  assert.equal((await o.a('part.restore_files', { serverId: SRV, part: SUPA, into: 'live', confirmName: name })).status, 'denied');
  assert.equal(code(await decide(app, o, await o.h('part.restore_files', { serverId: SRV, part: SUPA, into: 'live', confirmName: 'nope' }), 'shopsupa01')), 'confirm_name');
  fake(app, (cmd) => (cmd.includes('gunzip -t') ? { stdout: 'somethingelse\n' } : undefined));
  assert.equal(code(await o.a('part.restore_files', { serverId: SRV, part: SUPA })), 'bad_backup');
  assert.equal(code(await o.a('part.restore_files', { serverId: SRV, part: PG })), 'no_backup');
});

test('files over the live ones: a fresh copy first, what uses them stops and starts, what was there moves aside, and Undo swaps it back', async () => {
  const { app, o, seen, inv } = await withFiles();
  const name = inv.parts.find((x) => x.id === SUPA)!.name;
  const done = ok(await decide(app, o, await o.h('part.restore_files', { serverId: SRV, part: SUPA, into: 'live', confirmName: name }), 'shopsupa01'));
  assert.deepEqual(done.restored.sort(), ['/srv/stack/functions', 'shop_storage']);
  assert.deepEqual(done.skipped.sort(), ['f1-kong.yml', 'v-gone'], 'a single file, and a volume that isn’t this project’s any more');
  const copied = has(seen, 'tar czf'), swapped = has(seen, '.unit7-before-restore-');
  assert.ok(copied >= 0 && swapped > copied, 'a fresh copy first');
  const swap = seen[swapped]!.command;
  assert.ok(swap.includes('docker stop') && swap.includes('docker start') && swap.includes('type=volume,src=shop_storage,dst=/b/v-shop_storage') && swap.includes('type=bind,src=/srv/stack/functions,dst=/b/f0-functions'), swap);
  assert.ok(!/\brm -[rf]/.test(swap), 'nothing is deleted');
  seen.length = 0;
  ok(await o.h('change.undo', { changeId: done.changeId }));
  assert.ok(seen.some((x) => x.command.includes('.unit7-undone-')));
});

test('which folders of a copy can go back', () => {
  assert.deepEqual(restorable(['v-a/', 'v-b/', 'f0-up/', 'f1-up/', 'f2-x.yml', 'f3-data/'], ['/s/1/up', '/s/2/up', '/s/x.yml', '/s/data'], ['a']), { back: [{ top: 'v-a', kind: 'volume', src: 'a' }, { top: 'f3-data', kind: 'bind', src: '/s/data' }], skipped: ['v-b', 'f0-up', 'f1-up', 'f2-x.yml'] });
});

// --- a major version ------------------------------------------------------------------------------------------------------------
const facts = (version = 160004, extensions: string[] = ['vector']) => JSON.stringify({ version, bytes: 1048576, extensions });
function upgrading(o: { rows?: () => number; pgdata?: string; failAt?: string } = {}) {
  const inner = restoring({ rows: o.rows ?? (() => 2) });
  return (cmd: string, stdin: string): Reply => {
    if (o.failAt && (cmd.includes(o.failAt) || stdin.includes(o.failAt))) return { code: 1, stderr: 'it failed here' };
    if (stdin.includes('server_version_num') && !cmd.includes('show server')) return { stdout: `${facts()}\n` };
    if (cmd.includes('{{json .Mounts}}')) return { stdout: `[{"Source":"/var/lib/docker/volumes/shop_db/_data","Destination":"/var/lib/postgresql/data"}]\nPGDATA=/var/lib/postgresql/data\n@@\n${o.pgdata ?? 'PGDATA=/var/lib/postgresql/data'}\n` };
    if (stdin.includes('/api/v1/')) return { stdout: '{}\n200' };
    return inner(cmd, stdin);
  };
}
const upgrade = { serverId: SRV, part: PG };

test('the next major of the same image', () => {
  assert.equal(nextImage('postgres:16-alpine', 17), 'postgres:17-alpine');
  assert.equal(nextImage('postgres:16.4-bookworm', 17), 'postgres:17-bookworm');
  assert.equal(nextImage('pgvector/pgvector:pg16', 17), 'pgvector/pgvector:pg17');
  assert.equal(nextImage('timescale/timescaledb:2.15.0-pg16', 17), 'timescale/timescaledb:2.15.0-pg17');
  assert.equal(nextImage('postgres:latest', 17), undefined);
});

test('upgrade: the plan changes nothing, the run is side by side and proven, and a bad result takes its copy away', async () => {
  const { app, o } = await setup();
  run(app.db, `UPDATE orgs SET offsite = 'off'`);
  const seen = fake(app, upgrading());
  const plan = ok(await o.a('part.upgrade_plan', upgrade));
  assert.equal(plan.to, 'postgres:17-alpine');
  assert.equal(plan.canSwitch, true);
  assert.match(plan.watch, /vector/);
  assert.equal(seen.length, 1, 'one read');
  assert.equal(code(await o.h('part.upgrade_run', { ...upgrade, image: 'postgres:15-alpine' })), 'invalid_input');
  assert.equal(code(await o.h('part.upgrade_run', { ...upgrade, image: 'redis:8-alpine' })), 'invalid_input');
  assert.equal((await o.a('part.upgrade_run', upgrade)).status, 'approval_required');
  seen.length = 0;
  const out = ok(await o.h('part.upgrade_run', upgrade));
  assert.match(out.copy, /^pg-db-copy-/);
  assert.match(out.proof, /all 1 table and 2 rows came back/);
  const made = seen.find((x) => x.command.includes('docker run -d'))!;
  assert.ok(made.command.includes(`'postgres:17-alpine'`), 'the new version');
  assert.ok(!seen.some((x) => /docker (stop|restart)|compose/.test(x.command)), 'nothing live was stopped');
  assert.ok(!seen.some((x) => x.command.includes('reject')), 'or closed');
  // short: the copy goes, and nothing says it passed
  fake(app, upgrading({ rows: () => 1 }));
  run(app.db, `UPDATE changes SET status = 'undone' WHERE verb = 'upgrade_ready'`);
  const bad = await o.h('part.upgrade_run', upgrade);
  assert.equal(code(bad), 'upgrade_failed');
  assert.match(bad.error.message, /live one wasn’t touched/);
  assert.equal(code(await decide(app, o, await o.h('part.upgrade_switch', { ...upgrade, confirmName: 'pg-db' }))), 'not_tested');
});

test('switching: a person’s word, and only what Unit7 can carry through', async () => {
  const { app, o } = await setup();
  run(app.db, `UPDATE orgs SET offsite = 'off'`);
  const seen = fake(app, upgrading());
  assert.equal((await o.a('part.upgrade_switch', { ...upgrade, confirmName: 'pg-db' })).status, 'denied');
  assert.equal(code(await decide(app, o, await o.h('part.upgrade_switch', { ...upgrade, confirmName: 'nope' }))), 'confirm_name');
  assert.equal(code(await decide(app, o, await o.h('part.upgrade_switch', { serverId: SRV, part: SUPA, confirmName: 'x' }), 'shopsupa01')), 'confirm_name');
  const name = (await setup()).inv.parts.find((x) => x.id === SUPA)!.name;
  const supa = await decide(app, o, await o.h('part.upgrade_switch', { serverId: SRV, part: SUPA, confirmName: name }), 'shopsupa01');
  assert.equal(code(supa), 'not_here');
  assert.match(supa.error.message, /Supabase/);
  assert.equal(code(await decide(app, o, await o.h('part.upgrade_switch', { serverId: SRV, part: MY, confirmName: 'my-db' }), 'my-db')), 'not_here');
  assert.ok(!seen.some((x) => /reject|docker stop|compose/.test(x.command)), 'nothing moved');
  // the new image keeps its data elsewhere (Postgres 18): the volume would end up empty
  ok(await o.h('part.upgrade_run', { ...upgrade, image: 'postgres:18-alpine' }));
  fake(app, upgrading({ pgdata: 'PGDATA=/var/lib/postgresql/18/docker' }));
  assert.equal(code(await decide(app, o, await o.h('part.upgrade_switch', { ...upgrade, confirmName: 'pg-db' }))), 'data_moves');
  // an image Compose doesn't spell out can't be changed: found before anything stops
  const check = fake(app, upgrading({ failAt: 'old=$1; new=$2' }));
  assert.equal((await decide(app, o, await o.h('part.upgrade_switch', { ...upgrade, confirmName: 'pg-db' }))).status, 'error');
  assert.ok(!check.some((x) => /all all reject|'stop'/.test(x.command)), 'it all still runs');
});

test('switching a Compose database: apps out, a last backup, old files aside, the new version loads and proves it, and Undo goes back', async () => {
  const { app, o } = await setup();
  run(app.db, `UPDATE orgs SET offsite = 'off'`);
  fake(app, upgrading());
  ok(await o.h('part.upgrade_run', upgrade));
  const seen = fake(app, upgrading());
  const done = ok(await decide(app, o, await o.h('part.upgrade_switch', { ...upgrade, confirmName: 'pg-db' })));
  assert.equal(done.to, 'postgres:17-alpine');
  const at = (t: string) => has(seen, t);
  const close = at('host all all all reject'), dump_ = at('pg_dumpall'), stop = seen.findIndex((x) => /compose.*'stop'/.test(x.command)), aside = at('unit7-before-upgrade-$2"; mkdir "$k"'), image = at('old=$1; new=$2'), up = seen.findIndex((x) => /compose.*'up'/.test(x.command)), drop = at('DROP DATABASE');
  assert.ok(close >= 0 && dump_ > close && stop > dump_ && aside > stop && up > aside && drop > up, `close ${close}, dump ${dump_}, stop ${stop}, aside ${aside}, up ${up}, drop ${drop}`);
  assert.ok(image > -1 && seen.some((x) => x.command.includes(`'postgres:16-alpine' 'postgres:17-alpine'`)), 'the image, by its exact old value');
  assert.ok(seen.every((x) => !x.command.includes('rm -rf')), 'no data is deleted');
  assert.equal(get(app.db, `SELECT 1 FROM changes WHERE verb = 'upgrade_ready' AND status = 'done'`), undefined, 'that test is used up');
  seen.length = 0;
  assert.equal((await o.a('change.undo', { changeId: done.changeId })).status, 'approval_required', 'an AI may only ask');
  const back = ok(await o.h('change.undo', { changeId: done.changeId }));
  assert.equal(back.back, 'postgres:16-alpine');
  assert.ok(seen.some((x) => x.command.includes('unit7-after-upgrade-')));
  assert.ok(seen.some((x) => x.command.includes(`'postgres:17-alpine' 'postgres:16-alpine'`)));
});

test('a switch that fails goes back by itself, from wherever it got to', async () => {
  for (const failAt of ['pg_dumpall', 'unit7-before-upgrade-$2"; mkdir "$k"', `'up' '-d'`, 'DROP DATABASE']) {
    const { app, o } = await setup();
    run(app.db, `UPDATE orgs SET offsite = 'off'`);
    fake(app, upgrading());
    ok(await o.h('part.upgrade_run', upgrade));
    let tripped = false;
    const inner = upgrading();
    const seen = fake(app, (cmd, stdin) => { if (!tripped && cmd.includes(failAt)) { tripped = true; return { code: 1, stderr: 'it failed here' }; } return inner(cmd, stdin); });
    const r = await decide(app, o, await o.h('part.upgrade_switch', { ...upgrade, confirmName: 'pg-db' }));
    assert.equal(code(r), 'switch_undone', failAt);
    assert.ok(seen.some((x) => x.command.includes(OPENS)), `${failAt}: apps get back in`);
    if (failAt === 'pg_dumpall') assert.ok(!seen.some((x) => /compose.*'stop'/.test(x.command)), 'it never stopped');
    if (failAt === 'DROP DATABASE' || failAt === `'up' '-d'`) assert.ok(seen.some((x) => x.command.includes('unit7-after-upgrade-')), `${failAt}: the old files came back`);
  }
});

test('switching a Coolify database: Coolify is told the image, and starts it', async () => {
  const { app, o } = await setup();
  run(app.db, `UPDATE orgs SET offsite = 'off'`);
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status) VALUES ('acc_coolify00001', ?, 'coolify', 'c', 'c', ?, 'ok')`, o.orgId, JSON.stringify({ serverId: SRV, apiPort: '8000', facts: { abilities: ['deploy', 'read', 'write'] } }));
  app.vault.put(o.orgId, 'credential://coolify/c/token', '1|abcdefghijkl', { kind: 'token', by: 'test' });
  fake(app, upgrading());
  const db = 'coolify:relaydb01';
  ok(await o.h('part.upgrade_run', { serverId: SRV, part: db }));
  const seen = fake(app, upgrading());
  const name = (await setup()).inv.parts.find((x) => x.id === db)!.name;
  const done = ok(await decide(app, o, await o.h('part.upgrade_switch', { serverId: SRV, part: db, confirmName: name }), 'relaydb01'));
  assert.equal(done.to, 'postgres:17-alpine');
  const api = seen.filter((x) => x.stdin.includes('/api/v1/databases/')).map((x) => /\/databases\/\S+?(?=")/.exec(x.stdin)?.[0]);
  assert.deepEqual(api, ['/databases/relaydb01/stop', '/databases/relaydb01', '/databases/relaydb01/start']);
  assert.ok(seen.some((x) => x.stdin.includes('postgres:17-alpine') && x.stdin.includes('PATCH')));
});

test('the Compose image line: changed by its exact value, in a real shell, or not at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'u7compose-')), f = join(dir, 'c.yml');
  const go = (old: string, next: string) => spawnSync('sh', ['-c', COMPOSE_IMAGE, 'unit7', old, next, f], { encoding: 'utf8' });
  writeFileSync(f, 'services:\n  db:\n    image: postgres:16-alpine\n  other:\n    image: postgres:16-alpineX\n');
  assert.equal(go('postgres:16-alpine', '').status, 0, 'a check');
  assert.ok(readFileSync(f, 'utf8').includes('image: postgres:16-alpine\n'), 'that changes nothing');
  assert.equal(go('postgres:16-alpine', 'postgres:17-alpine').status, 0);
  assert.equal(readFileSync(f, 'utf8'), 'services:\n  db:\n    image: postgres:17-alpine\n  other:\n    image: postgres:16-alpineX\n');
  writeFileSync(f, `services:\n  db:\n    image: "postgres:16"\n`);
  assert.equal(go('postgres:16', 'postgres:17').status, 0);
  assert.equal(readFileSync(f, 'utf8'), 'services:\n  db:\n    image: postgres:17\n');
  writeFileSync(f, 'services:\n  db:\n    image: ${PG_IMAGE}\n');
  const r = go('postgres:16', 'postgres:17');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /isn't written in its Compose file/);
});

// --- reading a statement --------------------------------------------------------------------------------------------------------
test('one statement: strings, comments and dollar quotes read the way the database reads them', () => {
  const one = (s: string, d: 'pg' | 'my' = 'pg') => statement(s, d).text;
  assert.equal(one(`select ';' ; `), `select ';'`);
  assert.equal(one('select $$ ; $$'), 'select $$ ; $$');
  assert.equal(one('select $tag$ ; \\! ls $tag$'), 'select $tag$ ; \\! ls $tag$');
  assert.equal(one(`select E'\\'; drop table x; --'`), `select E'\\'; drop table x; --'`);
  assert.equal(one('select /* ; /* ; */ ; */ 1'), 'select /* ; /* ; */ ; */ 1');
  assert.equal(one('select "a;b" from t'), 'select "a;b" from t');
  assert.equal(one('select `a;b` from t', 'my'), 'select `a;b` from t');
  assert.equal(one(`select 'it\\'s; fine'`, 'my'), `select 'it\\'s; fine'`);
  for (const bad of [`select '\\'; drop table x; --'`, 'select 1; drop table x', 'select 1;;', '$$', `select 'x`, 'select (1', 'select 1)', '/* x', 'select 1 \\! ls', '\\! ls', '123']) {
    assert.throws(() => statement(bad, 'pg'), { code: 'bad_statement' }, bad);
  }
  assert.throws(() => statement('select 1; select 2 -- x', 'my'), { code: 'bad_statement' });
  assert.throws(() => statement('select 1 /*! ; drop table x */', 'my'), { code: 'bad_statement' });
  assert.throws(() => statement('select 1 /*M! ; drop table x */', 'my'), { code: 'bad_statement' });
  assert.deepEqual(tokenize(`a 'b' "c"`, 'pg').map((t) => t.k), ['word', 'str', 'name']);
});

test('what looks personal, and what doesn’t', () => {
  for (const c of ['email', 'user_email', 'userEmail', 'phone', 'phoneNumber', 'password_hash', 'encrypted_password', 'api_key', 'refresh_token', 'first_name', 'lastName', 'customer_name', 'ssn', 'ip_address', 'date_of_birth'.replace('date_of_', ''), 'birth_date']) assert.ok(personal(c, false), c);
  for (const c of ['id', 'plan', 'status', 'total', 'created_at', 'product_name', 'company_name', 'title', 'tokens_used'.replace('tokens_used', 'usage')]) assert.ok(!personal(c, false), c);
  assert.ok(personal('name', true) && !personal('name', false), 'a bare name counts only in a table about people');
  assert.equal(hideShapes('2026-11-06 10:00:01'), '2026-11-06 10:00:01');
  assert.equal(hideShapes('1234567890'), '1234567890');
  assert.equal(hideShapes('(415) 555-2671, a.b+c@shop.example'), '[hidden phone], [hidden email]');
});

test('masking a result: hidden, numbers only, or left alone', () => {
  const m = { hide: new Set([1]), text: new Set([2]), all: false };
  assert.deepEqual(maskRows(['id', 'email', 'x', 'y'], [['1', 'a', 'b', 'c'], ['2', 't', '3', 'sam@shop.example']], m), { rows: [['1', '[hidden]', '[hidden]', 'c'], ['2', 't', '3', '[hidden email]']], masked: ['email', 'x', 'y'] });
  assert.deepEqual(maskRows(['a'], [['x'], ['12'], ['']], { hide: new Set(), text: new Set(), all: true }).rows, [['[hidden]'], ['12'], ['']]);
  // without a plan's outputs, nothing is assumed
  assert.equal(planMask({ 'Node Type': 'Result' }, ['a'], []).all, true);
  const toks = tokenize('SELECT count(email) n, plan FROM users', 'my');
  assert.equal(textMask(toks, ['n', 'plan']).all, false, 'a count of anything is a number');
  assert.equal(textMask(tokenize('SELECT email AS n FROM users', 'my'), ['n']).all, true);
});

test('a dump is checked for what reaches the server’s shell, and data in a COPY block isn’t', () => {
  assert.deepEqual(dumpProblem('CREATE TABLE t (a text);\nCOPY t (a) FROM stdin;\n\\! this is a row\n\\.\nSELECT 1;\n'), { whole: false });
  assert.equal(dumpProblem('\\connect shop\nSELECT 1;\n').whole, true);
  assert.equal(dumpProblem('CREATE DATABASE x;\n').whole, true);
  assert.ok(dumpProblem('SELECT 1; \\! id\n').bad);
  assert.ok(dumpProblem(`\\i /etc/passwd\n`).bad);
  assert.deepEqual(parseCsv('a,"b,c"\n"d ""e""\nf",\n'), [['a', 'b,c'], ['d "e"\nf', '']]);
  assert.deepEqual(parseTsv('a\tb\nNULL\tx\\ty\\n\n'), [['a', 'b'], ['', 'x\ty\n']]);
  assert.equal(toCsv([['a', 'b,c'], ['d"e', '']]), 'a,"b,c"\n"d""e",\n');
});
