// What a security review proved against real runs, kept as tests. The attacker is prompt injection: anything an AI can call without
// a person is reachable. Where a real Postgres and psql proved it, one is used here too (data-real-pg.ts): a fake can't judge a lexer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, json, run } from '../src/db.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { decideApproval, type Actor } from '../src/tools/runtime.ts';
import { coolifyTiming } from '../src/connectors/coolify.ts';
import { liveTiming } from '../src/live/vercel.ts';
import { moveTiming } from '../src/tools/moves.ts';
import { addHost } from '../src/live/hosts.ts';
import { dumpProblem } from '../src/tools/data.ts';
import { LOAD } from '../src/tools/wordpress.ts';
import { readsOnly, touchesSecrets } from '../src/tools/supabase.ts';
import { Redactor } from '../src/redact.ts';
import { ROLES_BACK } from '../src/tools/move.ts';
import { classify } from '../src/discovery/actions.ts';
import { HELD_OPS, HELD_TOOLS, runHeld } from '../src/ops/index.ts';
import { ROUTINE_AGENT, routineActor } from '../src/tools/routines.ts';
import { fakeApi, account } from './clouds-fakes.ts';
import { dropsDatabase, mongoCall, mongoQuery, statement, textMask, tokenize } from '../src/tools/datamask.ts';
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
    if (/^(GET|POST) \/applications\/\w+\/envs$/.test(r)) { if (method === 'POST') st.envs.push(body); return [200, st.envs]; }
    if (/^PATCH \/applications\/\w+\/envs\/bulk$/.test(r)) { st.envs.push(...body.data); return [201, []]; }
    if (/^POST \/databases\/\w+$/.test(r)) { st.databases.push({ uuid: 'db2', name: body.name }); return [201, { uuid: 'db2' }]; }
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
    `select 1E--E ${shell}`,
    `select 1e$$ ' $$ ${shell} --'`,
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

// a host that only remembers what it was given
function fakeHost() {
  const got: { key: string; value: string }[][] = [];
  addHost({ id: 'fakehost', name: 'Fake', builds: true, places: () => [{ host: 'fakehost', label: 'Fake' }], fit: () => ({ ok: true, why: '' }),
    put: async (_c, p) => { got.push(p.env); return { url: '', project: 'p1', notes: [] }; }, env: async () => [] });
  return got;
}
const KEYS = { ssh: 'credential://ssh/box/private-key', coolify: 'credential://coolify/box/token', manual: 'credential://manual/mine/stripe' };
const storeKeys = (app: App, orgId: string) => { app.vault.put(orgId, KEYS.ssh, 'SERVER-PRIVATE-KEY', { kind: 'ssh_key', by: 't' }); app.vault.put(orgId, KEYS.coolify, 'COOLIFY-ROOT-TOKEN', { kind: 'api_token', by: 't' }); app.vault.put(orgId, KEYS.manual, 'sk_live_stored', { kind: 'manual', by: 't' }); };

test('3. a repo’s .env can’t open the vault: a reference from a file is dropped and said, for an AI, after a yes and for a person', async () => {
  const { app, o } = await world(), got = fakeHost();
  storeKeys(app, o.orgId);
  repoWith({ 'index.html': '<h1>hi</h1>', '.env': `NEXT_PUBLIC_A=${KEYS.ssh}\nVITE_B=${KEYS.manual}\nNEXT_PUBLIC_C=plain\n` });
  const move = { repo: 'evil/site', to: 'fakehost', skipMissing: true };
  const plan = ok<any>(await o.a('move.plan', { repo: 'evil/site' }));
  assert.ok(plan.warnings.some((w: string) => /NEXT_PUBLIC_A, VITE_B/.test(w) && /never opens/.test(w)), JSON.stringify(plan.warnings));
  assert.deepEqual(plan.comes.settings.comeByThemselves, ['NEXT_PUBLIC_C']);
  const ai = ok<any>(await o.a('move.run', { ...move, name: 'site-a' }));
  assert.deepEqual(ai.settings.notOpened, ['NEXT_PUBLIC_A', 'VITE_B']);
  assert.match(ai.settings.why, /never opens/);
  const asked = await o.a('move.run', { ...move, name: 'site-b', copySettings: true }) as any;
  assert.equal(asked.status, 'approval_required');
  assert.equal(code(await approve(app, o, asked)), 'ok');
  ok(await o.h('move.run', { ...move, name: 'site-c' }));
  assert.equal(got.length, 3);
  for (const env of got) assert.deepEqual(env.map((e) => [e.key, e.value]), [['NEXT_PUBLIC_C', 'plain']]);
  assert.ok(!JSON.stringify(got).includes('SERVER-PRIVATE-KEY'));
});

test('3. a value read from the old host isn’t opened either', async () => {
  const { app, o } = await world(), got = fakeHost();
  storeKeys(app, o.orgId);
  repoWith({ 'index.html': '<h1>hi</h1>' });
  const api = await fakeApi(({ path }) => (path.startsWith('/v10/projects/prj_old/env') ? { envs: [{ key: 'PLANTED', type: 'plain', value: KEYS.manual, target: ['production'] }, { key: 'FINE', type: 'plain', value: 'ok', target: ['production'] }] } : undefined));
  process.env.UNIT7_VERCEL_API = api.base;
  try {
    const acc = account(app, o.orgId, 'vercel', 'tok-demo');
    const assetId = id('ast');
    run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, account_id, meta, seen_at) VALUES (?, ?, 'vercel', 'app', 'prj_old', 'old', ?, ?, '2026-11-01')`, assetId, o.orgId, acc, JSON.stringify({ repo: 'evil/site', end: { kind: 'vercel', accountId: acc, project: 'prj_old' } }));
    ok(await o.h('move.run', { assetId, to: 'fakehost', copySettings: true, skipMissing: true }));
    assert.deepEqual(got[0]!.map((e) => [e.key, e.value]), [['FINE', 'ok']]);
  } finally { api.close(); delete process.env.UNIT7_VERCEL_API; }
});

test('3. a yes can’t carry a reference past what it may reach, and the card names the keys', async () => {
  const { app, o } = await world(), got = fakeHost();
  storeKeys(app, o.orgId);
  repoWith({ 'index.html': '<h1>hi</h1>' });
  const move = (env: Record<string, string>) => ({ repo: 'evil/site', to: 'fakehost', skipMissing: true, env });
  assert.equal((await o.a('move.run', move({ X: KEYS.coolify }))).status, 'denied', 'a key for people, even with approval');
  // Unit7's own keys never go into an app, whoever asks
  assert.match((await o.h('move.run', move({ X: KEYS.ssh })) as any).error.message, /one of Unit7's own keys/);
  assert.match((await o.h('live.put', { repo: 'evil/site', to: 'fakehost', env: { X: KEYS.ssh } }) as any).error.message, /one of Unit7's own keys/);
  const acc = account(app, o.orgId, 'vercel', 'tok-demo'), token = json<{ ref: string }>(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', acc)!.meta, { ref: '' }).ref;
  const bound = await o.a('move.run', move({ X: token })) as any;
  assert.equal(bound.status, 'approval_required');
  const out = await approve(app, o, bound) as any;
  assert.match(out.error.message, /isn't bound to this environment/, 'the yes doesn’t reach a connected account’s token');
  const ask = await o.a('move.run', move({ STRIPE: KEYS.manual, PLAIN: 'x' })) as any;
  assert.equal(ask.status, 'approval_required');
  assert.ok(ask.why.includes(KEYS.manual), ask.why);
  const card = ok<any[]>(await o.a('approval.list')).find((x) => x.id === ask.approvalId);
  assert.equal(card.input.env, `STRIPE = ${KEYS.manual}, PLAIN`);
  assert.equal(code(await approve(app, o, ask)), 'ok');
  assert.deepEqual(got.at(-1)!.map((e) => [e.key, e.value]).sort(), [['PLAIN', 'x'], ['STRIPE', 'sk_live_stored']]);
});

test('4. an existing database’s password goes into an AI’s app only on a person’s yes; a new one, or one already wired, doesn’t ask', async () => {
  const { app, o } = await world(), c = coolifyOn(app, o.orgId);
  c.databases.push({ uuid: 'db1', name: 'prod-db' });
  c.apps.push({ uuid: 'mine1x', name: 'ai-app', build_pack: 'dockerfile' });
  const wire = { ...WHERE, engine: 'postgresql', name: 'prod-db', injectInto: 'mine1x', wait: false };
  const r = await o.a('coolify.create_database', wire) as any;
  assert.equal(r.status, 'approval_required', JSON.stringify(r));
  assert.match(r.why, /prod-db already exists/);
  assert.equal(c.envs.length, 0, 'nothing went into the app');
  assert.ok(!c.calls.some((x) => x.startsWith('GET /databases/')), 'and the address wasn’t even read');
  const done = ok<any>(await approve(app, o, r) as never);
  assert.deepEqual(done.wired, ['DATABASE_URL']);
  assert.equal(c.envs[0].key, 'DATABASE_URL');
  assert.ok(!JSON.stringify(done).includes('stored-db-password'));
  assert.equal(code(await o.a('coolify.create_database', wire)), 'ok', 'already wired: a build run again doesn’t ask');
  assert.equal(c.envs.length, 1, 'and nothing moved');
  assert.equal(code(await o.a('coolify.create_database', { ...wire, name: 'fresh-db' })), 'ok', 'a new one’s password was never anyone else’s');
  // a person's own call doesn't wait, as before
  c.envs.length = 0;
  ok(await o.h('coolify.create_database', wire));
  assert.equal(c.envs.length, 1);
});

test('4. a stored key an AI names in a setting asks a person, in Coolify and in Unit7’s own apps; the same value, approved, goes in', async () => {
  const { app, o } = await world(), c = coolifyOn(app, o.orgId);
  storeKeys(app, o.orgId);
  c.apps.push({ uuid: 'mine1x', name: 'ai-app', build_pack: 'dockerfile' });
  const set = { serverId: SRV, uuid: 'mine1x', kind: 'application', op: 'set', key: 'K', value: KEYS.manual };
  for (const autonomy of [3, 4]) {
    run(app.db, 'UPDATE orgs SET autonomy = ? WHERE id = ?', autonomy, o.orgId);
    const r = await o.a('coolify.envs', set) as any;
    assert.equal(r.status, 'approval_required', `autonomy ${autonomy}: ${JSON.stringify(r)}`);
    assert.ok(r.why.includes(KEYS.manual));
  }
  assert.equal(c.envs.length, 0);
  const asked = await o.a('coolify.envs', set) as any;
  assert.equal(code(await approve(app, o, asked)), 'ok');
  assert.equal(c.envs[0].value, 'sk_live_stored');
  // the same drain through an app Unit7 deploys itself
  const pr = ok<any>(await o.h('project.create', { name: 'shop' })), env = pr.environments[0].id;
  run(app.db, 'UPDATE environments SET autonomy = 4 WHERE id = ?', env);
  assert.equal((await o.a('env.set', { environmentId: env, key: 'K', value: KEYS.manual })).status, 'approval_required');
  assert.equal(code(await o.a('env.set', { environmentId: env, key: 'PLAN', value: 'pro' })), 'ok', 'a plain setting doesn’t ask');
  assert.equal(code(await o.h('env.set', { environmentId: env, key: 'K', value: KEYS.manual })), 'ok', 'a person’s own doesn’t');
});

test('5. a template with a first-visitor admin: an AI asks, whatever the autonomy; Supabase and a person’s own click don’t', async () => {
  const { app, o } = await world(), c = coolifyOn(app, o.orgId);
  const add = (type: string) => ({ ...WHERE, type, urls: [{ part: type, domain: `${type}.203.0.113.9.sslip.io` }], wait: false });
  for (const autonomy of [3, 4]) {
    run(app.db, 'UPDATE orgs SET autonomy = ? WHERE id = ?', autonomy, o.orgId);
    const r = await o.a('coolify.create_service', add('n8n')) as any;
    assert.equal(r.status, 'approval_required', JSON.stringify(r));
    assert.match(r.why, /whoever opens it first/);
  }
  assert.equal(c.services.length, 0, 'nobody can be first at something that isn’t there');
  assert.equal(code(await o.a('coolify.create_service', { ...WHERE, type: 'supabase', wait: false })), 'ok');
  assert.equal(code(await o.h('coolify.create_service', { ...add('n8n'), name: 'mine' })), 'ok', 'a person knows what they asked for');
  const raw = await o.a('coolify.create_service', { ...WHERE, compose: ROOT_COMPOSE, name: 'x', wait: false }) as any;
  assert.equal(raw.status, 'approval_required');
  assert.match(raw.why, /compose file/);
});

test('5. coolify.build stops at such a step and says so; what it builds around it still works', async () => {
  const { app, o } = await world(), c = coolifyOn(app, o.orgId);
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const built = ok<any>(await o.a('coolify.build', { serverId: SRV, goal: 'a stack', service: 'gitea', project: 'site', confirmed: true }));
  assert.equal(built.built, false);
  assert.ok(built.failed.approvalId, JSON.stringify(built));
  assert.match(built.next, /approval/);
  assert.equal(c.services.length, 0);
  assert.equal(code(await approve(app, o, { approvalId: built.failed.approvalId })), 'ok');
  assert.equal(c.services.length, 1);
});

const days = (n: number) => Date.now() + n * 86400_000;
test('6. at Full autopilot an AI’s delete still goes through a person, then waits the 48 hours', async () => {
  const { app, o } = await world();
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const p = ok<any>(await o.h('project.create', { name: 'old', environments: ['staging'] }));
  const r = await o.a('project.delete', { projectId: p.projectId, confirm: 'old' }) as any;
  assert.equal(r.status, 'approval_required', JSON.stringify(r));
  assert.match(r.why, /48 hours/);
  assert.ok(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', p.projectId), 'nothing went');
  assert.equal(((await approve(app, o, r, 'old')) as any).output.held, true);
  assert.ok(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', p.projectId), 'still there after the yes');
  assert.deepEqual(await runHeld(app, days(1)), [], 'not after a day');
  assert.equal((await runHeld(app, days(3))).length, 1);
  assert.equal(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', p.projectId), undefined, 'gone after the wait');
  // a staging environment defaults to autopilot too, and a key of any kind counts: it could be any program
  const q = ok<any>(await o.h('project.create', { name: 'next', environments: ['staging'] })), env = q.environments.find((e: any) => e.kind === 'staging').id;
  assert.equal((await o.a('environment.delete', { environmentId: env })).status, 'approval_required');
  const key: Actor = { kind: 'token', id: 'tok_1', userId: o.userId, name: 'CLI', role: 'owner' };
  assert.equal((await o.as(key)('environment.delete', { environmentId: env })).status, 'approval_required');
  ok(await o.h('environment.delete', { environmentId: env }));
});

test('6. the delete of a tool that does many things waits too, and only its delete', async () => {
  const { app, o } = await world(), c = coolifyOn(app, o.orgId);
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const task = { serverId: SRV, uuid: 'app1x', kind: 'application', op: 'delete', task: 'task1x' };
  const r = await o.a('coolify.task', task) as any;
  assert.equal(r.status, 'approval_required', JSON.stringify(r));
  assert.equal(((await approve(app, o, r)) as any).output.held, true);
  assert.ok(!c.calls.some((x) => x.startsWith('DELETE')));
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM held_deletes')!.n, 1);
  assert.notEqual((await o.a('coolify.task', { ...task, op: 'list' })).status, 'approval_required');
  // and one a provider's own passthrough runs by name
  account(app, o.orgId, 'hostinger', 'tok-demo');
  assert.equal((await o.a('hostinger.do', { operation: 'dns_records_delete' })).status, 'approval_required');
  assert.equal((await o.a('hostinger.batch', { operations: [{ operation: 'vps_virtual-machines_list' }, { operation: 'dns_records_delete' }] })).status, 'approval_required');
});

test('6. what waits: every delete with nothing to come back from; a trash doesn’t, and a routine is a person’s own step', async () => {
  for (const t of ['dns.remove', 'domain.remove_record', 'domain.remove', 'part.copy_remove', 'dr.remove', 'job.remove']) assert.ok(HELD_TOOLS.has(t), t);
  assert.equal(HELD_OPS['coolify.task'], 'delete');
  for (const t of ['file.remove', 'part.remove', 'wordpress.plugin', 'coolify.storage']) assert.ok(!HELD_TOOLS.has(t) && !HELD_OPS[t], `${t} has a trash or an undo`);
  const { app, o } = await world();
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const p = ok<any>(await o.h('project.create', { name: 'old', environments: ['staging'] }));
  const routine = routineActor({ name: 'tidy', owner_id: o.userId }, 'owner');
  assert.equal(routine.agent, ROUTINE_AGENT);
  ok(await o.as(routine)('project.delete', { projectId: p.projectId, confirm: 'old' }));
  assert.equal(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', p.projectId), undefined);
  assert.equal(get(app.db, 'SELECT 1 FROM held_deletes'), undefined);
  // a step of something a person already approved isn't asked for again
  const q = ok<any>(await o.h('project.create', { name: 'step', environments: ['staging'] }));
  ok(await o.a('project.delete', { projectId: q.projectId, confirm: 'step' }, { underApproval: 'apr_whole' }));
});

test('7. where every container’s settings are kept in the clear is secret, a named volume’s data apart, and /proc is nobody’s', async () => {
  const { app, o } = await world();
  for (const path of ['/run/containerd/io.containerd.runtime.v2.task/moby/0123abcd/config.json', '/var/run/containerd/x/config.json', '/run/docker/containerd/x/init.pid', '/var/lib/containerd/io.containerd.grpc.v1.cri/containers/x', '/var/lib/docker/containers/0123/config.v2.json',
    '/var/lib/docker/overlay2/abc/merged/app/config.yml', '/var/snap/docker/common/var-lib-docker/containers/0123/config.v2.json', '/data/coolify/ssh/keys/id.root', '/var/lib/kubelet/pods/x/volumes/y', '/var/backups/unit7/shop/2026.sql.gz', '/var/lib/unit7/undo/1/compose.yml',
    '/etc/ssh/ssh_host_ed25519_key', '/root/.bash_history', '/etc/mysql/debian.cnf', '/var/www/html/wp-config.php.bak']) {
    const r = await o.a('file.read', { serverId: SRV, path }) as any;
    assert.equal(r.status, 'denied', path);
    assert.match(r.why, /holds secrets|sign in/, path);
    assert.equal(classify(`cat ${path}`).tier, 4, `the same through a command: ${path}`);
  }
  // a volume's own files are what they say they are; a listing of the folder isn't a file
  const said: string[] = [];
  ssh(app).exec = async (_s, command) => { said.push(command); return { code: 3, stdout: '', stderr: '', truncated: false }; };
  assert.equal(code(await o.a('file.read', { serverId: SRV, path: '/var/lib/docker/volumes/shop_uploads/_data/notes.txt' })), 'not_found');
  assert.equal(classify('du -sh /var/lib/docker').tier, 0);
  assert.equal(classify('ls /var/lib/docker/volumes').tier, 0);

  // /proc: for everyone, on the server and inside a container, however it's asked for
  for (const actor of [o.a, o.h]) for (const path of ['/proc/1/environ', '/proc/self/environ', '//proc/1/environ', '/./proc/1/environ']) {
    assert.equal(code(await actor('file.read', { serverId: SRV, path })), 'invalid_input', path);
    assert.equal(code(await actor('file.read', { serverId: SRV, path, part: 'c:web', container: 'web-1' })), 'invalid_input', path);
  }
  for (const c of ['cat /proc/1/environ', 'cat /proc/1/task/1/environ', 'cat /proc/self/root/etc/hostname']) assert.equal(classify(c).tier, 4, c);
  // and through a link, which the path alone can't show
  let leads = '/proc/7/environ';
  ssh(app).exec = async () => ({ code: 0, stdout: `${leads}\nfile\n`, stderr: '', truncated: false });
  assert.equal(code(await o.h('file.read', { serverId: SRV, path: '/srv/app/link' })), 'not_a_file');
  leads = '/run/containerd/x/config.json';
  assert.equal(code(await o.a('file.read', { serverId: SRV, path: '/srv/app/link' })), 'secret_file');
});

test('8. only what’s proved shows: on a real Postgres, whatever a query calls it and however it’s built', real, async () => {
  const { o, pg } = await withPg();
  pg.sql(`CREATE TABLE orders (id int, user_id int, total numeric); INSERT INTO orders VALUES (1, 1, 10), (2, 2, 20);
    CREATE TABLE notes (a text, b text); INSERT INTO notes VALUES ('$2b$12$hiddeninnotes', 'x');
    CREATE VIEW safe_looking AS SELECT id, password_hash AS plan FROM users;
    CREATE VIEW barrier WITH (security_barrier) AS SELECT id, password_hash AS plan FROM users;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE};`, 'shop');
  const rows = async (sql: string) => ok<any>(await o.a('part.query', { serverId: SRV, part: PG, sql })).rows;
  for (const sql of [
    'select v from users, lateral (values (password_hash),(password_hash)) t(v)',
    'select "Foo", "Bar" from (select email "Foo", password_hash "Bar" from users offset 0) "A B"',
    'select b from users u(a, b)',
    'select b from users as u(a, b)',
    'select plan from users u(id, plan, x, email)',
    'select "b" from only (users) u(a, b)',
    'select plan from barrier',
    'select plan from safe_looking',
    'select substr(password_hash, 1, 4) from users',
    'select ascii(substr(v, 1, 1)) from users, lateral (values (password_hash)) t(v)',
    'select sum(ascii(substr(password_hash, 1, 1))) from users',
    'select length(password_hash) from users',
    'select id::text || password_hash from users',
    'select plan from users union all select password_hash from users',
    'select plan from users union select password_hash from users',
    'select x from (select plan x from users union all select password_hash from users) s',
    'select u from users u',
    'select max(password_hash) from users',
    'with recursive r(x) as (select password_hash from users union all select x from r where false) select x from r',
    'select * from unnest(array(select password_hash from users)) v',
    'select most_common_vals::text from pg_stats where tablename = \'users\'',
    'select prosrc from pg_proc limit 1',
  ]) {
    const out = JSON.stringify(await rows(sql));
    assert.ok(!/shash|\$2b|shop\.example|\b\d{2,}\b/.test(out), `${sql}: ${out}`);
    assert.ok(out.includes('[hidden]') || out === '[]', `${sql}: ${out}`);
  }
  // what's proved still shows
  assert.deepEqual(await rows('select id, plan from users order by id'), [['1', 'pro'], ['2', 'free']]);
  assert.deepEqual(await rows('select u.plan, o.total from users u join orders o on o.user_id = u.id order by o.id'), [['pro', '10'], ['free', '20']]);
  assert.deepEqual(await rows('select plan, count(*) from users group by plan order by plan'), [['free', '1'], ['pro', '1']]);
  assert.deepEqual(await rows('select count(*), count(email), count(*) filter (where email like \'%x\') from users'), [['2', '2', '0']]);
  assert.deepEqual(await rows('select sum(total), max(total) from orders'), [['30', '20']]);
  assert.deepEqual(await rows('select plan from users union all select plan from users order by 1'), [['free'], ['free'], ['pro'], ['pro']]);
  assert.deepEqual(await rows('select 1'), [['1']]);
  assert.deepEqual(await rows('show max_connections'), [['30']]);
  // an app's own setting can hold a key: Supabase keeps its JWT secret in one
  pg.sql(`ALTER DATABASE shop SET app.settings.jwt_secret = 'jwt-secret-value'`);
  assert.deepEqual(await rows(`show "app.settings.jwt_secret"`), [['[hidden]']]);
  assert.deepEqual(await rows('show app.settings.jwt_secret'), [['[hidden]']]);
});

test('8. the database’s own error words stay with the database', real, async () => {
  const { o, seen } = await withPg();
  const said = async (sql: string) => JSON.stringify(await o.a('part.query', { serverId: SRV, part: PG, sql }));
  for (const sql of ['select cast(password_hash as int) from users', `select string_agg(password_hash || ' ' || email, ', ')::int from users`, `select 1/(select 0 from users where email = 'ann@shop.example')::int, password_hash::int from users`]) {
    const out = await said(sql);
    assert.ok(!/shash|\$2b|shop\.example/.test(out), `${sql}: ${out}`);
    assert.match(out, /query_failed/);
  }
  assert.match(await said('select nope from users'), /isn’t there/);
  assert.match(await said('selct 1 from users'), /needs_write/);
  assert.match(await said('select from from users'), /Check its syntax/);
  // a person still hears it all
  assert.match(JSON.stringify(await o.h('part.query', { serverId: SRV, part: PG, sql: 'select cast(password_hash as int) from users' })), /shash/);
  assert.ok(seen.length);
});

test('8. a past copy holds the same rows, so an AI sees of it what it sees of the live one, and hears no more', real, async () => {
  const { app, o, pg } = await withPg();
  const COPY = 'pg-db-copy-20261106-ab12', mine = ssh(app).exec;
  ssh(app).exec = (s, command, x) => (command.includes('docker ps -a') ? Promise.resolve({ code: 0, stdout: `${COPY}|c:pg-db|2026-11-06 10:00:00 +0000 UTC\n`, stderr: '', truncated: false }) : mine(s, command.replace(/psql -U postgres/, 'psql -U postgres -d shop'), x));
  const read = (sql: string, who = o.a) => who('part.copy_read', { serverId: SRV, copy: COPY, sql });
  assert.deepEqual(ok<any>(await read('select id, plan from users order by id')).rows, ['1|pro', '2|free']);
  const all = JSON.stringify(ok<any>(await read('select * from users order by id')));
  assert.ok(!/shash|shop\.example/.test(all), all);
  assert.ok(!/shash/.test(JSON.stringify(ok<any>(await read('select rolname, rolpassword from pg_authid')))));
  const failed = JSON.stringify(await read('select cast(password_hash as int) from users'));
  assert.ok(!/shash/.test(failed), failed);
  assert.equal(code(await read(`select pg_read_file('/etc/hosts')`)), 'not_for_ai');
  assert.equal(code(await read('select 1 --x\r\\! id\n')), 'bad_statement');
  assert.deepEqual(ok<any>(await read('select email from users order by id', o.h)).rows, ['ann@shop.example', 'bob@shop.example'], 'a person sees it as it was');
  assert.ok(pg);
});

test('8. MySQL: only a plain SELECT is proved, item by item', async () => {
  const mask = (sql: string, columns: string[]) => textMask(tokenize(sql, 'my'), columns);
  assert.equal(mask('select b, c, d from (select 1 a, 2 b, 3 c, 4 d, 5 e union all select * from users) x', ['b', 'c', 'd']).all, true, 'a subquery can put anything under any name');
  assert.equal(mask('select plan from users union select password from users', ['plan']).all, true);
  assert.equal(mask('with u as (select password p from users) select p from u', ['p']).all, true);
  assert.ok(mask('select binary password from users', ['binary password']).hide.has(0), 'a word in front is an operator, not a column');
  assert.ok(mask('select lower(plan) from users', ['lower(plan)']).hide.has(0));
  assert.ok(mask('select @a := plan from users', ['@a := plan']).hide.has(0));
  assert.ok(mask("select 'x' from users", ['x']).hide.has(0));
  assert.ok(mask('select sum(ascii(password)) from users', ['sum']).hide.has(0));
  const fine = mask('select distinct u.plan, status as state, count(*) n, sum(total) from users u', ['plan', 'state', 'n', 'sum(total)']);
  assert.deepEqual([fine.all, [...fine.hide]], [false, []]);
  assert.deepEqual([...mask('select * from users', ['id', 'email', 'plan']).hide], [1]);
  assert.equal(mask('show variables', ['Variable_name', 'Value']).all, true);
  assert.equal(mask('describe users', ['Field', 'Type']).all, false);
});

test('8. MongoDB for an AI is plain data: none of its text can run', async () => {
  const { app, o } = await world();
  foundDb(app, o.orgId, [part({ id: 'c:mg-db', name: 'mg-db', engine: 'mongo', image: 'mongo:7', containers: ['mg-db-1'], networks: ['shop_default'] })]);
  const sent: string[] = [];
  ssh(app).exec = async (_s, _c, x: ExecOptions = {}) => { sent.push(String(x.stdin ?? '')); return { code: 0, stdout: '[{"_id":1,"plan":"pro","n":3}]\n', stderr: '', truncated: false }; };
  const q = (sql: string, who = o.a) => who('part.query', { serverId: SRV, part: 'c:mg-db', sql });
  for (const sql of ['db.users.find().toArray().map(d=>d["pass"+"word"]+" "+this["pro"+"cess"].env.P.split("").reverse().join(""))', 'db.users.find({ $where: "sleep(1000) || true" })', 'this.process', 'db.users.find({}, { x: { $function: { body: "1" } } })',
    'db.users.aggregate([{ $project: { x: { $getField: { $concat: ["pas", "sword"] } } } }])', 'db.users.aggregate([{ $project: { x: { $objectToArray: "$$ROOT" } } }])', 'db.users.aggregate([{ $lookup: { from: "secrets", as: "s" } }])',
    'db.users.find().forEach(printjson)', 'db.users.find({ a: function () { return 1 } })', 'db.users.mapReduce(1, 2)', 'db.users.find(); process.exit()', 'db["users"].find()', 'db.users.find({ a: 1 }).map(x => x)']) {
    assert.equal(code(await q(sql)), 'bad_statement', sql);
  }
  assert.equal(sent.length, 0, 'none of it was sent');
  assert.equal(code(await q('db.users.deleteMany({})')), 'needs_write');
  // what's plain data goes out as data
  const asked = mongoQuery(`db.users.find({ plan: 'pro', _id: ObjectId("507f1f77bcf86cd799439011") }, { plan: 1 }).sort({ plan: -1 }).limit(5)`);
  assert.equal(mongoCall(asked), `db.getCollection("users").find(...EJSON.parse(${JSON.stringify('[{"plan":"pro","_id":{"$oid":"507f1f77bcf86cd799439011"}},{"plan":1}]')})).sort(...EJSON.parse("[{\\"plan\\":-1}]")).limit(...EJSON.parse("[5]"))`);
  assert.equal(mongoCall(mongoQuery(`db.users.find({ a: "\\");process.exit();//" })`)).includes('process.exit();//'), true, 'a string stays a string');
  const fine = ok<any>(await q('db.users.find({ plan: "pro" })'));
  assert.match(fine.rows[0][0], /"plan":"pro"/);
  assert.match(sent.at(-1)!, /db\.getCollection\("users"\)\.find\(\.\.\.EJSON\.parse/);
  assert.ok(!sent.at(-1)!.includes('db.users.find('), 'the text it was asked in never runs');
  assert.deepEqual(JSON.parse(ok<any>(await q('db.users.aggregate([{ $match: { email: { $exists: true } } }, { $count: "n" }])')).rows[0][0]), { _id: 1, plan: 'pro', n: 3 }, 'a count shows, whatever it counted');
  const named = ok<any>(await q(`db.users.aggregate([{ $project: { who: '$firstName' } }])`));
  assert.ok(!named.rows[0][0].includes('pro') && !named.rows[0][0].includes(':3'), `numbers hide too: ${named.rows[0][0]}`);
  // a person keeps the whole of mongosh, and a write an AI asks for stays data too
  assert.equal(code(await q('db.users.find().limit(1).map(x => x)', o.h)), 'ok');
  assert.equal(code(await o.a('part.query', { serverId: SRV, part: 'c:mg-db', sql: 'db.users.updateOne({ a: 1 }, { $set: { b: this.process } })', write: true, confirm: 'mg-db' })), 'bad_statement');
});

test('9. after a move, a visitor’s text doesn’t run as the superuser: only the roles at the top of the dump go back, and only their passwords', real, () => {
  const pg = pgUp as Pg, file = join(pg.dir, 'all.sql.gz');
  const role = (name: string) => pg.sql(`SELECT rolsuper, rolcreaterole, rolpassword FROM pg_authid WHERE rolname = '${name}'`).trim();
  pg.sql(`DROP DATABASE IF EXISTS shop WITH (FORCE); DROP ROLE IF EXISTS app; CREATE ROLE app LOGIN PASSWORD 'the-app-knows-this' VALID UNTIL 'infinity'; CREATE ROLE "odd name" LOGIN PASSWORD 'another-one'; CREATE DATABASE shop;`);
  // a role may set its own settings, and a value may span lines
  pg.sql(`ALTER ROLE app SET my.note = E'x\\nALTER ROLE app WITH SUPERUSER;\\nALTER ROLE app WITH CREATEROLE PASSWORD ''planted'';\\n--';`);
  pg.sql(`CREATE TABLE comments (body text); INSERT INTO comments VALUES ('ALTER ROLE app SUPERUSER;'), ('ALTER ROLE app WITH SUPERUSER PASSWORD ''planted'';');`, 'shop');
  const before = role('app'), oddBefore = role('odd name');
  pg.dumpTo(file);
  assert.ok(execFileSync('sh', ['-c', 'gunzip -c "$1"', 'unit7', file], { encoding: 'utf8' }).includes('\nALTER ROLE app SUPERUSER;\n'), 'the row really starts a line in the dump');
  pg.sql(`ALTER ROLE app PASSWORD 'the-test-copy-set-this'; ALTER ROLE "odd name" PASSWORD 'this-one-too';`);
  assert.notEqual(role('app'), before);
  execFileSync('sh', ['-c', ROLES_BACK, 'unit7', 'copy', file, 'postgres:16'], { env: pg.env });
  assert.equal(role('app'), before, 'its own password, and nothing more');
  assert.match(before, /^f\|f\|/);
  assert.equal(role('odd name'), oddBefore, 'a name that needs quotes too');
});

test('10. supabase.sql: a row made into one value, or a place that holds settings, is a person’s to read', async () => {
  for (const sql of [
    'select to_jsonb(t)::text as x from public.profiles t',
    'select row_to_json(t) from public.profiles t',
    'select json_agg(t) from public.profiles t',
    `select jsonb_build_object('a', note) from public.profiles`,
    'select note::jsonb from public.profiles',
    'select t::text from public.profiles t',
    'select cast(t as text) from public.profiles as t',
    'select concat(t) from public.profiles t',
    `select format('%s', p) from public.profiles p`,
    'select array_agg(p)::text from public.profiles p',
    'select string_agg(p::text, $$,$$) from public.profiles p',
    'select array[p]::text from public.profiles p',
    'select (t.*)::text from public.profiles t',
    'select concat(t.*) from public.profiles t',
    'select row(id, note)::text from public.profiles',
    'select row (id) from public.profiles',
    'select s::text from (select * from public.profiles) s',
    'with s as (select * from public.profiles) select s::text from s',
    'select a::text from public.orders o, public.profiles as a',
    'select "T"::text from public.profiles "T"',
    'select profiles::text from public.profiles',
    'select xmlforest(note) from public.profiles',
    'select name, setting from pg_show_all_settings()',
    'select setconfig from pg_db_role_setting',
    'select rolname, rolconfig from pg_roles',
    'select * from pg_user',
    'select query from pg_stat_activity',
    'select jobname, command from cron.job',
    'select * from net.http_request_queue',
    'select * from net . _http_response',
    'select * from supabase_functions.hooks',
    'select prosrc from pg_proc',
    'select pg_get_functiondef(oid) from pg_proc',
    'select token as x from public.sessions',
    'select * from auth . "users"',
    'select * from auth--\r.users',
    'select count(*) from auth.users --\r union all select ascii(substr(email, 1, 1))::bigint from auth.users',
    'select 1\r',
  ]) assert.equal(touchesSecrets(sql, false), true, JSON.stringify(sql));
  for (const sql of [
    'select * from public.profiles',
    'select id, name from public.profiles p where p.id = 1',
    'select p.* from public.profiles p',
    'select p.id, o.total from public.profiles p join public.orders o on o.user_id = p.id order by 1 limit 5',
    'select a.id, b.id from public.a a, public.b b where a.id = b.id',
    'select lower(name), count(*) from public.profiles group by 1',
    'with c as (select id from public.x) select c.id from c',
    'select x.id from (select id from public.x) x',
    'select count(*) from auth.users',
    'select now()',
  ]) assert.equal(touchesSecrets(sql, false), false, sql);
  assert.equal(touchesSecrets(`update public.x set data = to_jsonb('{}'::text)`, true), false, 'a write doesn’t hand rows to an AI');
  assert.equal(touchesSecrets('update public.x set password = 1', true), true);
  // the same words the database reads
  assert.equal(readsOnly('select 1 --\r; drop table x'), false);
  assert.equal(readsOnly(`select ';' -- ;\n`), true);
  assert.equal(readsOnly('with a as (delete from x returning 1) select * from a'), false);
  assert.equal(readsOnly(`select 'delete'`), true);
});

test('10. a secret’s key inside a string that is JSON is masked, and the tool does it for an AI’s rows', async () => {
  const r = new Redactor();
  assert.deepEqual(r.redactDeep({ x: '{"id": 1, "api_key": "aaaaaaaaaaaa", "note": "{\\"password\\": \\"hunter2hunter2\\"}", "list": [{"token": "aaaaaaaaaaaa"}]}' }),
    { x: '{"id":1,"api_key":"[redacted]","note":"{\\"password\\":\\"[redacted]\\"}","list":[{"token":"[redacted]"}]}' });
  assert.equal(r.redactDeep('[not json'), '[not json');
  assert.equal(r.redactDeep('{"a": 1'), '{"a": 1');
  const { app, o } = await world();
  const api = await fakeApi(({ path }) => (path.includes('/database/query/read-only') ? [{ note: '{"id":1,"secret_answer":"my first pet was rex"}' }] : undefined));
  process.env.UNIT7_SUPABASE_API = api.base;
  try {
    account(app, o.orgId, 'supabase', 'sbp_demo');
    const out = ok<any>(await o.a('supabase.sql', { ref: 'abcdefghijklmnopqrst', sql: 'select note from public.profiles' }));
    assert.ok(!JSON.stringify(out).includes('rex'), JSON.stringify(out));
    assert.equal((await o.a('supabase.sql', { ref: 'abcdefghijklmnopqrst', sql: 'select to_jsonb(t)::text from public.profiles t' })).status, 'denied');
    assert.ok(JSON.stringify(ok<any>(await o.h('supabase.sql', { ref: 'abcdefghijklmnopqrst', sql: 'select to_jsonb(t)::text from public.profiles t' }))).includes('rex'), 'a person reads it');
  } finally { api.close(); delete process.env.UNIT7_SUPABASE_API; }
});

test('11. a dump can’t reach a shell, however it’s written, and a real pg_dumpall file still loads', real, async () => {
  const pg = pgUp as Pg, mark = join(pg.dir, 'dump-shell-ran'), touch = `touch ${mark}`;
  const bad = [
    `select 1\n\\w |${touch}\n;\n`,
    `\\set x \`${touch}\`\n`,
    `select 1 \\g (format=csv) |${touch}\n`,
    `select 1 \\gexec\n`,
    `\\! ${touch}\n`,
    `\\copy t from program '${touch}'\n`,
    `create temp table t(x text);\nCOPY t\nFROM PROGRAM '${touch}';\n`,
    `create temp table t(x text);\nCOPY t FROM/**/PROGRAM '${touch}';\n`,
    `create temp table t(x text);\ncopy t from -- a note\n program $$${touch}$$;\n`,
    `create temp table t(x text);\nCOPY (select 1) TO PROGRAM '${touch}';\n`,
    `do $$ begin execute 'copy (select 1) to program ''${touch}'''; end $$;\n`,
    `create temp table t(x text);\nCOPY t FROM stdin; \\! ${touch}\n\\.\n`,
    `-- a note\r\\! ${touch}\n`,
    `select 1 /* */ \\! ${touch}\n`,
    `select 1E--E \\! ${touch}\n`,
    `select 1.5e-- \\! ${touch}\n`,
    `select 1e$$ ' $$ \\! ${touch} --'\n`,
    `SET standard_conforming_strings = off;\nselect 'x\\'' \\! ${touch} --'\n;\n`,
    `create function f() returns int language sql begin atomic select 1; COPY t FROM stdin;\n\\! ${touch}\n\\.\nend;\n`,
    `U&create function f() returns int language sql begin atomic select 1;copy t from stdin ;\n\\! ${touch}\n`,
    `SET client_encoding = 'SJIS';\nselect 1;\n`,
    `SET NAMES 'Shift-JIS';\n`,
    `ALTER ROLE app SET client_encoding TO big5;\n`,
    `select set_config('client_encoding', 'x', false);\n`,
    `\\connect "host=attacker.example dbname=x"\n`,
    `\\connect shop \\! ${touch}\n`,
    `select 1\n\\connect shop\n`,
    `select '`,
  ];
  for (const text of bad) assert.ok(dumpProblem(text).bad, JSON.stringify(text));
  // through the tool, on a real psql: refused before anything runs
  const { app, o, seen } = await withPg();
  const upload = (text: string) => { const id_ = `upl_${'a'.repeat(12)}`, path = join(pg.dir, 'upload.sql'); writeFileSync(path, text); run(app.db, 'INSERT OR REPLACE INTO uploads (id, org_id, path, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?)', id_, o.orgId, path, text.length, 'x', o.userId); return id_; };
  const load = (text: string) => o.h('part.import', { serverId: SRV, part: PG, uploadId: upload(text), into: 'live', confirm: 'pg-db' }, {});
  for (const text of bad.slice(0, 7)) {
    const r = await load(text) as any;
    assert.ok(['bad_upload', 'approval_required'].includes(code(r)), JSON.stringify(r));
    if (r.status === 'approval_required') assert.equal(code(await approve(app, o, r, 'pg-db')), 'bad_upload', text);
  }
  assert.ok(!existsSync(mark), 'no shell ran');
  assert.ok(!seen.some((x) => x.command.includes('LOAD') || x.stdin.includes(touch)));

  // what pg_dump really writes passes: backslash lines of its own, COPY rows that look like anything, and strings and functions
  pg.sql(`DROP TABLE IF EXISTS notes; CREATE TABLE notes (body text); INSERT INTO notes VALUES (E'\\\\! ${touch}'), ('ALTER ROLE x SUPERUSER;'), (E'\\\\.'), ('COPY t FROM PROGRAM ''${touch}'';');
    CREATE FUNCTION odd() RETURNS text LANGUAGE sql BEGIN ATOMIC SELECT 'a;b'::text; END;
    CREATE FUNCTION old() RETURNS text LANGUAGE plpgsql AS $x$ BEGIN RETURN 'c:\\temp;'; END $x$;
    COMMENT ON TABLE notes IS 'it''s: a \\ note';`, 'shop');
  const file = join(pg.dir, 'real.sql.gz');
  pg.dumpTo(file);
  const dump = gunzipSync(readFileSync(file)).toString('utf8');
  assert.match(dump, /^\\connect /m);
  assert.deepEqual(dumpProblem(dump), { whole: true });
  assert.deepEqual(dumpProblem(dump.replace(/\n/g, '\r\n')), { whole: true }, 'and a dump that went through Windows');
  assert.deepEqual(dumpProblem(`COPY public.t (a) FROM stdin;\n\\! a row\n\\.`), { whole: false }, 'the file can end right after its last \\.');
  assert.ok(dumpProblem(`COPY public.t (a) FROM stdin;\nrow\n\\.\n\\! ${touch}\n`).bad, 'after its rows it’s a script again');
});

test('11. what else feeds a client: MySQL’s dumps run with its client commands off, and a pg_dump file can’t carry PROGRAM', async () => {
  assert.match(LOAD, /--binary-mode/, 'wordpress.import');
  const { app, o } = await world();
  foundDb(app, o.orgId, [part({ id: 'c:my-db', name: 'my-db', engine: 'mysql', image: 'mysql:8.4', containers: ['my-db-1'], networks: ['shop_default'] })]);
  const dir = mkdtempSync(join(tmpdir(), 'unit7-dump-')), path = join(dir, 'x');
  const id_ = `upl_${'b'.repeat(12)}`;
  run(app.db, 'INSERT INTO uploads (id, org_id, path, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?)', id_, o.orgId, path, 1, 'x', o.userId);
  const sent: string[] = [];
  ssh(app).exec = async (_s, command) => { sent.push(command); return { code: 0, stdout: '12\nabc\n', stderr: '', truncated: false }; };
  ssh(app).check = async () => '/tmp/unit7-import-x\n';
  ssh(app).putFile = async () => undefined;
  // pg_dump's own format, with a statement it would run
  writeFileSync(path, Buffer.concat([Buffer.from('PGDMP'), Buffer.from('\x00\x01COPY t FROM PROGRAM \'id\';\x00', 'latin1')]));
  const pgDump = await o.h('part.import', { serverId: SRV, part: PG, uploadId: id_, into: 'live', confirm: 'pg-db' }) as any;
  const out = pgDump.status === 'approval_required' ? await approve(app, o, pgDump, 'pg-db') as any : pgDump;
  assert.equal(code(out), 'bad_upload');
  // the same words in a MySQL dump are text for a client that has its commands off
  writeFileSync(path, `\\! id\nselect 1;\n`);
  const my = await o.h('part.import', { serverId: SRV, part: 'c:my-db', uploadId: id_, into: 'live', confirm: 'my-db' }) as any;
  await (my.status === 'approval_required' ? approve(app, o, my, 'my-db') : my);
  assert.ok(sent.some((x) => x.includes('--binary-mode')), 'the load uses it');
});
