// What a security review proved against real runs, kept as tests. The attacker is prompt injection: anything an AI can call without
// a person is reachable. Where a real Postgres and psql proved it, one is used here too (data-real-pg.ts): a fake can't judge a lexer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, json, run } from '../src/db.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { decideApproval, type Actor } from '../src/tools/runtime.ts';
import { coolifyTiming } from '../src/connectors/coolify.ts';
import { liveTiming } from '../src/live/vercel.ts';
import { moveTiming } from '../src/tools/moves.ts';
import { dropsDatabase, statement, tokenize } from '../src/tools/datamask.ts';
import { buildInventory, type Part } from '../src/discovery/xray.ts';
import { saveXray } from '../src/tools/xray.ts';
import { ROLE, vaultAccount } from '../src/serverapps/adapters.ts';
import { makeRef } from '../src/vault.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { havePostgres, realShell, startPostgres, type Pg } from './data-real-pg.ts';
import type { App } from '../src/app.ts';

const SRV = 'srv_sec000000001';
const code = (r: any) => (r.status === 'error' ? r.error.code : r.status);
coolifyTiming.pollMs = 1; liveTiming.pollMs = 1; liveTiming.answerMs = 10; Object.assign(moveTiming, { tries: 1, waitMs: 1, pageMs: 50 });

async function world() {
  const app = testApp(), o = await testOrg(app);
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', '{}')`, SRV, o.orgId);
  return { app, o };
}
// a Coolify in memory, behind the fake SSH layer: what its API is asked, and what it holds
function coolifyOn(app: App, orgId: string) {
  const ref = 'credential://coolify/box/token', st = { calls: [] as string[], apps: [] as any[], databases: [] as any[], services: [] as any[], envs: [] as any[] };
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status) VALUES (?, ?, 'coolify', 'Coolify', 'box', ?, 'verified')`, id('acc'), orgId, JSON.stringify({ serverId: SRV, ref, facts: { version: '4.4.0' } }));
  app.vault.put(orgId, ref, 'unit7-test-coolify-token', { kind: 'token' });
  const answer = (method: string, path: string, body: any): [number, unknown] => {
    const r = `${method} ${path.split('?')[0]}`;
    if (r === 'GET /projects') return [200, [{ uuid: 'proj0001', name: 'site' }]];
    if (r === 'POST /projects') return [201, { uuid: 'proj0001' }];
    if (r === 'GET /projects/proj0001') return [200, { uuid: 'proj0001', environments: [{ name: 'production', uuid: 'env1' }] }];
    if (r === 'GET /projects/proj0001/production') return [200, { applications: st.apps, postgresqls: st.databases, services: st.services }];
    if (r === 'GET /servers') return [200, [{ uuid: 'srvuuid01', name: 'localhost', ip: '203.0.113.9' }]];
    if (r === 'GET /github-apps') return [200, []];
    if (/^POST \/applications\/(public|dockerfile)$/.test(r)) { const a = { uuid: `app${st.apps.length + 1}x`, name: body.name, build_pack: body.build_pack }; st.apps.push(a); return [201, { uuid: a.uuid }]; }
    if (/^GET \/applications\/\w+$/.test(r)) { const a = st.apps.find((x) => path.endsWith(x.uuid)); return a ? [200, a] : [404, { message: 'Not found.' }]; }
    if (/^(GET|POST) \/applications\/\w+\/envs$/.test(r)) { if (method === 'POST') st.envs.push(body); return [200, []]; }
    if (/^PATCH \/applications\/\w+\/envs\/bulk$/.test(r)) { st.envs.push(...body.data); return [201, []]; }
    if (/^GET \/databases\/\w+$/.test(r)) return [200, { uuid: 'db1', internal_db_url: 'postgres://app:stored-db-password@db1:5432/app' }];
    if (r === 'POST /deploy') return [200, { deployments: [{ message: 'Queued', deployment_uuid: 'dep1' }] }];
    if (r === 'GET /deployments/dep1') return [200, { deployment_uuid: 'dep1', status: 'finished' }];
    if (r === 'POST /services') { st.services.push({ uuid: 'svc1x', name: body.name, ...body }); return [201, { uuid: 'svc1x', domains: [] }]; }
    if (/^GET \/services\/\w+$/.test(r)) return [200, { uuid: 'svc1x', status: 'running:healthy' }];
    return [404, { message: 'Not found.' }];
  };
  ssh(app).exec = async (_s, _c, x: ExecOptions = {}) => {
    const cfg = String(x.stdin ?? ''), path = /^url = "[^"]*\/api\/v1([^"]*)"/m.exec(cfg)?.[1] ?? '', method = /^request = "(\w+)"/m.exec(cfg)?.[1] ?? 'GET', data = /^data-binary = (".*")$/m.exec(cfg)?.[1];
    st.calls.push(`${method} ${path}`);
    const [status, out] = answer(method, path, data ? JSON.parse(JSON.parse(data)) : undefined);
    return { code: 0, stdout: `${JSON.stringify(out)}\n${status}`, stderr: '', truncated: false };
  };
  return st;
}
// a public repo, on a local remote
function repoWith(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'unit7-remote-')), bare = join(root, 'evil', 'site.git'), work = mkdtempSync(join(tmpdir(), 'unit7-work-'));
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  for (const [k, v] of Object.entries(files)) writeFileSync(join(work, k), v);
  const git = (...a: string[]) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  git('init', '-q', '-b', 'main'); git('add', '-A', '-f'); git('commit', '-q', '-m', 'first'); git('push', '-q', `file://${bare}`, 'main');
  process.env.UNIT7_GITHUB_URL = `file://${root}`;
}
after(() => { delete process.env.UNIT7_GITHUB_URL; });

const ROOT_COMPOSE = 'services:\n  a:\n    image: alpine\n    volumes:\n      - /:/host\n';
const WHERE = { serverId: SRV, project: 'proj0001', environment: 'production' };
const approve = (app: App, o: { orgId: string; human: Actor }, r: any, confirm?: string) => decideApproval(app, o.orgId, o.human, r.approvalId, true, confirm);
const toolOf = (app: App, approvalId: string) => get<{ tool: string }>(app.db, 'SELECT tool FROM approvals WHERE id = ?', approvalId)?.tool;

test('1. compose from a repo is a command on the server: an AI asks, a person approves, and nothing is made before that', async () => {
  const { app, o } = await world(), c = coolifyOn(app, o.orgId);
  const asked = await o.a('coolify.create_app', { ...WHERE, name: 'x', repo: 'https://github.com/evil/x', source: 'public', buildPack: 'dockercompose', deploy: true }) as any;
  assert.equal(asked.status, 'approval_required', JSON.stringify(asked));
  assert.match(asked.why, /can run anything on the server/);
  assert.equal(get<{ action: string }>(app.db, `SELECT action FROM audit WHERE tool = 'coolify.create_app' ORDER BY rowid DESC LIMIT 1`)?.action, 'server_exec');
  assert.equal(c.calls.length, 0, 'Coolify wasn’t even asked');
  assert.equal(code(await o.a('coolify.create_app', { ...WHERE, name: 'y', dockerfile: 'FROM alpine\nCMD env\n', buildPack: 'dockerfile' })), 'ok', 'a Dockerfile stays in its container');
  // where a person prohibits commands on servers, compose from a repo is prohibited too
  run(app.db, `UPDATE orgs SET rules = ? WHERE id = ?`, JSON.stringify({ server_exec: 'prohibited' }), o.orgId);
  assert.equal((await o.a('coolify.create_app', { ...WHERE, name: 'z', repo: 'evil/z', buildPack: 'dockercompose' })).status, 'denied');
});

test('1. a green live.put reaches it, and the waiting step comes back plainly: an approval, not an error', async () => {
  const { app, o } = await world(), c = coolifyOn(app, o.orgId);
  repoWith({ 'docker-compose.yml': ROOT_COMPOSE });
  const put = { repo: 'evil/site', to: 'coolify', serverId: SRV, name: 'site' };
  const r = await o.a('live.put', put) as any;
  assert.equal(r.status, 'approval_required', JSON.stringify(r));
  assert.equal(toolOf(app, r.approvalId), 'coolify.create_app');
  assert.match(r.why, /coolify\.create_app is waiting on the Approvals page/);
  assert.match(r.why, /update: true/);
  assert.ok(!c.calls.some((x) => x.startsWith('POST /applications')), 'nothing is made before the yes');
  assert.equal(code(await approve(app, o, r, 'box')), 'ok');
  assert.equal(c.apps[0].build_pack, 'dockercompose');
  // an update brings a new compose file: one yes for the whole of it, and asking again doesn't go round in circles
  const again = await o.a('live.put', { ...put, update: true }) as any;
  assert.equal(again.status, 'approval_required', JSON.stringify(again));
  assert.equal(toolOf(app, again.approvalId), 'live.put');
  const deploys = c.calls.filter((x) => x.startsWith('POST /deploy')).length;
  assert.equal(code(await approve(app, o, again)), 'ok');
  assert.equal(c.calls.filter((x) => x.startsWith('POST /deploy')).length, deploys + 1);
  assert.equal(c.apps.length, 1);
});

test('1. move.run says the build waits, and the next run goes on from there', async () => {
  const { app, o } = await world(), c = coolifyOn(app, o.orgId);
  repoWith({ 'docker-compose.yml': ROOT_COMPOSE });
  const first = ok<any>(await o.a('move.run', { repo: 'evil/site', to: 'coolify', serverId: SRV, name: 'site', skipMissing: true }));
  assert.equal(first.waiting, true);
  assert.match(first.why, /Approvals page/);
  const row = get<{ undo: string }>(app.db, 'SELECT undo FROM changes WHERE id = ?', first.moveId)!, m = json<any>(row.undo, {});
  assert.equal(m.stage, 'waiting');
  assert.equal(toolOf(app, m.waiting), 'coolify.create_app');
  assert.equal(ok<any>(await o.a('move.run', { moveId: first.moveId })).next, 'The build still waits for a person on the Approvals page.');
  assert.equal(code(await decideApproval(app, o.orgId, o.human, m.waiting, true, 'box')), 'ok');
  const second = ok<any>(await o.a('move.run', { moveId: first.moveId, rebuild: true }));
  assert.equal(second.waiting, true, 'the update asks for the whole of it');
  const m2 = json<any>(get<{ undo: string }>(app.db, 'SELECT undo FROM changes WHERE id = ?', first.moveId)!.undo, {});
  assert.equal(toolOf(app, m2.waiting), 'live.put');
  assert.equal(code(await decideApproval(app, o.orgId, o.human, m2.waiting, true)), 'ok');
  const third = ok<any>(await o.a('move.run', { moveId: first.moveId }));
  assert.equal(third.moveId, first.moveId);
  assert.ok(!third.waiting, JSON.stringify(third));
  assert.equal(c.apps.length, 1);
});

test('1. deploying a compose app an AI could have pushed to, or turning on deploy on push: a person says yes', async () => {
  const { app, o } = await world(), c = coolifyOn(app, o.orgId);
  c.apps.push({ uuid: 'comp1x', name: 'compose-app', build_pack: 'dockercompose', git_repository: 'https://github.com/evil/x', settings: {} }, { uuid: 'nix1x', name: 'plain', build_pack: 'nixpacks', settings: {} });
  const go = (uuid: string) => ({ serverId: SRV, uuid, kind: 'application', action: 'deploy' });
  const r = await o.a('coolify.control', go('comp1x')) as any;
  assert.equal(r.status, 'approval_required', JSON.stringify(r));
  assert.ok(!c.calls.some((x) => x.startsWith('POST /deploy')));
  assert.equal(code(await approve(app, o, r)), 'ok');
  assert.equal(c.calls.filter((x) => x.startsWith('POST /deploy')).length, 1);
  assert.equal(code(await o.a('coolify.control', go('nix1x'))), 'ok');
  assert.equal(code(await o.h('coolify.control', go('comp1x'))), 'ok', 'a person’s own click just runs');
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const on = await o.a('coolify.auto_deploy', { serverId: SRV, uuid: 'comp1x', on: true }) as any;
  assert.equal(on.status, 'approval_required');
  assert.match(on.why, /compose file/);
});

// --- a real Postgres and a real psql, behind a real shell --------------------------------------------------------------------
const PG = 'c:pg-db', pgUp = havePostgres() ? startPostgres() : undefined, real = { skip: pgUp ? false : 'no Postgres can start here' };
after(() => pgUp?.stop());
const part = (x: Partial<Part>) => ({ kind: 'database', owner: 'compose', trust: 'understood', project: 'c:shop', ...x } as Part);
function foundDb(app: App, orgId: string, extra: Part[] = []) {
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
  inv.parts.push(part({ id: PG, name: 'pg-db', engine: 'postgres', image: 'postgres:16-alpine', containers: ['pg-db-1'], networks: ['shop_default'] }), ...extra);
  saveXray(app.db, orgId, SRV, 'fast', inv);
  for (const p of [PG, ...extra.map((x) => x.id)]) app.vault.put(orgId, makeRef('serverapp', vaultAccount(SRV, p), 'x.db-read-password'), 'readonly-Passw0rd-value', { kind: 'serverapp', by: 'test', meta: { name: 'db-read-password', user: ROLE, label: 'Read-only', appName: 'x', part: p, serverId: SRV } });
}
async function withPg() {
  const w = await world(), pg = pgUp as Pg;
  foundDb(w.app, w.o.orgId);
  pg.sql(`DROP DATABASE IF EXISTS shop WITH (FORCE); CREATE DATABASE shop;`);
  pg.sql(`DROP ROLE IF EXISTS ${ROLE}; CREATE ROLE ${ROLE} LOGIN BYPASSRLS PASSWORD 'pw';`);
  pg.sql(`CREATE TABLE users (id serial PRIMARY KEY, email text, password_hash text, plan text);
    INSERT INTO users (email, password_hash, plan) VALUES ('ann@shop.example', '$2b$12$annshashannshash', 'pro'), ('bob@shop.example', '$2b$12$bobshashbobshash', 'free');
    GRANT USAGE ON SCHEMA public TO ${ROLE}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}; ALTER ROLE ${ROLE} SET default_transaction_read_only = on;`, 'shop');
  return { ...w, pg, seen: realShell(w.app, pg) };
}

test('2. a query can’t step out of itself into psql: not at a carriage return, not through a string read two ways, not past a long word', real, async () => {
  const { o, pg, seen } = await withPg(), mark = join(pg.dir, 'shell-ran'), shell = `\\! touch ${mark}`, B = 'b'.repeat(100);
  for (const sql of [
    `select 1 --x\r${shell}\n`,
    `select 1 --x\r; commit; set default_transaction_read_only = off; select 2 --\n`,
    `select 1e'\\' ${shell} #'`,
    `select 1.e'\\' ${shell} #'`,
    `select E'a'\n'\\'' ${shell} --'`,
    `select ${'a'.repeat(200)}$$ ${shell} $$`,
    `select $${B}$ ' $${B}$ ${shell} --'`,
    `select 1 -- ${shell}`,
    `select 1 /* ${shell} */`,
    `select 1\f${shell}`,
    `select 1 ${shell}`,
  ]) {
    assert.equal(code(await o.a('part.query', { serverId: SRV, part: PG, sql })), 'bad_statement', JSON.stringify(sql));
    assert.equal(code(await o.h('part.query', { serverId: SRV, part: PG, sql })), 'bad_statement', `a person’s too: ${JSON.stringify(sql)}`);
  }
  assert.equal(seen.length, 0, 'none of it reached the server');
  assert.ok(!existsSync(mark));
  // strings that really are strings still go through
  assert.deepEqual(ok<any>(await o.h('part.query', { serverId: SRV, part: PG, sql: String.raw`select E'a\'b', 'c\d', '\\', $$\!$$` })).rows, [[`a'b`, 'c\\d', '\\\\', '\\!']]);
});

test('2. the gate reads a write the way it runs: a hidden drop is refused before anyone is asked, and a plain one is a drop', real, async () => {
  const { app, o } = await withPg();
  const hidden = await o.a('part.query', { serverId: SRV, part: PG, sql: 'select 1 --x\r; drop schema public cascade', write: true, confirm: 'pg-db' });
  assert.equal(code(hidden), 'bad_statement');
  assert.equal(get(app.db, 'SELECT 1 FROM approvals'), undefined, 'nobody was asked');
  assert.equal(dropsDatabase('select 1 --x\r; drop schema public cascade'), false, 'it never runs, so it’s no drop');
  for (const sql of ['drop schema public cascade', 'DROP DATABASE shop', '/* x */ drop database shop', "DROP DATABASE shop # it's gone"]) assert.ok(dropsDatabase(sql), sql);
  assert.equal(dropsDatabase('select 1'), false);
  assert.equal((await o.h('part.query', { serverId: SRV, part: PG, sql: 'drop schema public cascade', write: true, confirm: 'pg-db' })).status, 'denied', 'production forbids it, whoever asks');
  assert.throws(() => statement('select 1\u0000', 'pg'), { code: 'bad_statement' });
  assert.throws(() => statement('select 1\u007f', 'my'), { code: 'bad_statement' });
  assert.deepEqual(tokenize('a --b\nc', 'pg').map((t) => t.v), ['a', 'c']);
  assert.deepEqual(tokenize('a --b\rc', 'pg').map((t) => t.v), ['a', 'c'], 'psql’s line ends');
});

test('2. what comes back as a column’s name is masked like a row', real, async () => {
  const { o } = await withPg();
  const r = ok<any>(await o.a('part.query', { serverId: SRV, part: PG, sql: `select 1 as "sam@shop.example", 2 as "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"` }));
  assert.ok(!JSON.stringify(r).includes('sam@shop.example'), JSON.stringify(r));
  assert.ok(!JSON.stringify(r).includes('sk-ant'), JSON.stringify(r));
});
