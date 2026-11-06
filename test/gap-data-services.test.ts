// PlanetScale, Turso and Upstash as real tools, against fakes shaped like their API references: what an account holds, a new database
// and who may pay for one, a key that's refused, an AI's connection waiting for a person, a delete held 48 hours, and a login that
// never reaches a result, an audit row or an event.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok, setAutonomy } from './helpers.ts';
import { account, fakeApi, type Req } from './clouds-fakes.ts';
import { all, get, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { provider } from '../src/connectors/oneclick.ts';
import { HELD_TOOLS, runHeld } from '../src/ops/index.ts';
import { judged } from '../src/tools/connections.ts';
import { decideApproval, getTool } from '../src/tools/runtime.ts';

const PS_TOKEN = `pscale_tkn_${'a1'.repeat(16)}`, TURSO_TOKEN = 'turso-platform-token-123456', UP_KEY = 'ada@example.com:upstash-key-1234567';
const TURSO_JWT = 'eyJhbGciOiJFZERTQSJ9.eyJhIjoicnciLCJpZCI6InR1cnNvIn0.c2lnbmF0dXJlLW9mLWEtdHVyc28tdG9rZW4';
const MYSQL_PW = 'pscale_pw_mysql1234567890abcdefghij', PG_PW = 'pscale_pw_postgres1234567890abcdefgh', REDIS_PW = 'redis/PassW0rd+do-not-keep', REST_TOKEN = 'AXrestTokenDoNotKeep1234567890', READ_TOKEN = 'AXreadOnlyTokenDoNotKeep12345';
const SECRETS = [PS_TOKEN, TURSO_TOKEN, 'upstash-key-1234567', TURSO_JWT, MYSQL_PW, PG_PW, REDIS_PW, encodeURIComponent(REDIS_PW), REST_TOKEN, READ_TOKEN];
const clean = (what: unknown) => { const s = typeof what === 'string' ? what : JSON.stringify(what); for (const x of SECRETS) assert.ok(!s.includes(x), `a secret got out: ${x.slice(0, 14)}…`); };
// every row of every table, as text: a login may only live in ciphertext
function everywhere(app: App) {
  return all<{ name: string }>(app.db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((t) => JSON.stringify(all(app.db, `SELECT * FROM "${t.name}"`), (_k, v) => (v instanceof Uint8Array ? '[bytes]' : v))).join('\n');
}

let fakes = 0; // sizes are remembered for an hour by database, so each fake has its own
function state() {
  const n = ++fakes, org = `acme${n}`;
  return {
    org, refused: false, readOnly: false, minting: true, down: new Set<string>(),
    ps: {
      orgs: [{ name: org }] as { name: string }[], perPage: 2,
      dbs: [
        { name: 'shop', kind: 'postgresql', state: 'ready', ready: true, default_branch: 'main', plan: 'scaler_pro', default_branch_table_count: 12, html_url: `https://app.planetscale.com/${org}/shop`, region: { slug: 'us-east', display_name: 'US East' } },
        { name: 'legacy', kind: 'mysql', state: 'sleeping', ready: false, default_branch: 'prod', plan: 'scaler_pro', region: { slug: 'eu-west' } },
        { name: 'big', kind: 'postgresql', state: 'ready', ready: true, default_branch: 'main', region: { slug: 'us-east' } },
      ] as Record<string, unknown>[],
      logins: 0,
    },
    turso: {
      orgs: [{ slug: org, plan_id: 'starter', overages: false }] as { slug: string; plan_id?: string; overages: boolean }[],
      plans: [{ name: 'starter', price: '0' }, { name: 'scaler', price: '29' }] as { name: string; price: string }[] | undefined,
      groups: [{ name: 'default', primary: 'aws-eu-west-1' }] as { name: string; primary: string }[],
      dbs: [
        { Name: 'orders', DbId: `tdb-${n}`, Hostname: `orders-${org}.aws-eu-west-1.turso.io`, primaryRegion: 'aws-eu-west-1', group: 'default', block_reads: false, block_writes: false },
        { Name: 'frozen', DbId: `tdf-${n}`, Hostname: `frozen-${org}.aws-eu-west-1.turso.io`, primaryRegion: 'aws-eu-west-1', group: 'default', block_reads: false, block_writes: true },
      ] as Record<string, unknown>[],
      tokens: 0,
    },
    up: {
      dbs: [
        { database_id: `up-${n}`, database_name: 'cache', database_type: 'free', type: 'free', region: 'global', primary_region: 'eu-west-1', endpoint: `calm-fox-${n}`, port: 6379, tls: true, state: 'active', password: REDIS_PW, rest_token: REST_TOKEN, read_only_rest_token: READ_TOKEN },
        { database_id: `us-${n}`, database_name: 'stopped', type: 'payg', region: 'global', primary_region: 'us-east-1', endpoint: `cold-owl-${n}`, port: 6379, tls: true, state: 'suspended', password: REDIS_PW, rest_token: REST_TOKEN, read_only_rest_token: READ_TOKEN },
        { database_id: `up-q-${n}`, database_name: 'quiet', type: 'free', region: 'global', primary_region: 'us-east-1', endpoint: `slow-elk-${n}`, port: 6379, tls: true, state: 'passive', password: REDIS_PW, rest_token: REST_TOKEN, read_only_rest_token: READ_TOKEN },
      ] as Record<string, unknown>[],
      protection: false, makeAs: undefined as string | undefined,
    },
  };
}
type State = ReturnType<typeof state>;

function handle(st: State, { method, path, auth, body }: Req): unknown {
  const u = new URL(path, 'http://x'), [, service, ...rest] = u.pathname.split('/'), p = `/${rest.join('/')}`, get_ = method === 'GET';
  if (st.down.has(`${method} ${p}`)) return [500, { error: 'it fell over' }];
  const write = method !== 'GET';
  if (service === 'planetscale') {
    if (st.refused || ![`Bearer ${PS_TOKEN}`, `tokenid123:${PS_TOKEN}`].includes(auth)) return [401, { code: 'unauthorized', message: 'Invalid service token' }];
    if (st.readOnly && write) return [403, { code: 'forbidden', message: 'unauthorized for this action' }];
    const page = (rows: unknown[]) => { const at = Number(u.searchParams.get('page') ?? 1), size = st.ps.perPage; return { type: 'list', current_page: at, next_page: at * size < rows.length ? at + 1 : null, prev_page: null, data: rows.slice((at - 1) * size, at * size) }; };
    if (p === '/organizations') return page(st.ps.orgs);
    const m = /^\/organizations\/([^/]+)\/(databases|cluster-size-skus)(?:\/([^/]+)(?:\/branches\/([^/]+)\/(roles|passwords|metrics))?)?$/.exec(p);
    if (!m || m[1] !== st.org) return undefined;
    const [, , what, name, branch, sub] = m;
    if (what === 'cluster-size-skus') return [{ name: 'PS_5', display_name: 'PS-5', cpu: '1/16', ram: 536870912, storage: null, rate: 5, replica_rate: 0, enabled: true, metal: false }, { name: 'PS_OLD', enabled: false, metal: false, rate: 1 }, { name: 'M_100', enabled: true, metal: true, rate: 900 }];
    if (!name && get_) return page(st.ps.dbs);
    if (!name) { const b = JSON.parse(body) as { name: string; kind: string }; const d = { name: b.name, kind: b.kind, state: 'pending', ready: false, default_branch: 'main', region: { slug: 'us-east' } }; st.ps.dbs.push(d); return [201, d]; }
    const d = st.ps.dbs.find((x) => x.name === name);
    if (!d) return [404, { code: 'not_found', message: 'Not Found' }];
    if (!sub && get_) return d;
    if (!sub && method === 'DELETE') { st.ps.dbs = st.ps.dbs.filter((x) => x !== d); return [204, '']; }
    if (sub === 'metrics') {
      assert.equal(u.searchParams.get('metrics'), 'planetscale_primary_storage_usage_bytes');
      if (name === 'shop') return { type: 'MetricSeries', interval: 60, series: [{ type: 'TimeSeries', metric: 'planetscale_primary_storage_usage_bytes', label: 'Storage', labels: {}, points: [[1, 1000], [2, 2048], [3, null]] }] };
      return { type: 'MetricSeries', interval: 60, series: name === 'big' ? [{ points: [[1, 1000]] }, { points: [[1, 2000]] }] : [] };
    }
    assert.equal(branch, d.default_branch, 'the main branch');
    st.ps.logins++;
    const b = JSON.parse(body) as Record<string, unknown>;
    if (sub === 'roles') { assert.deepEqual(b.inherited_roles, ['postgres']); return { id: 'role1', name: b.name, username: 'postgres.abc123', password: PG_PW, access_host_url: 'db.psdb.example', database_name: name }; }
    assert.equal(b.role, 'readwriter');
    return [201, { id: 'pw1', name: b.name, username: 'mysqluser1', plain_text: MYSQL_PW, access_host_url: 'db.psdb.example', role: 'readwriter' }];
  }
  if (service === 'turso') {
    if (st.refused || auth !== `Bearer ${TURSO_TOKEN}`) return [401, { error: 'could not parse jwt' }];
    if (st.readOnly && write) return [403, { error: 'unauthorized' }];
    if (p === '/organizations') return st.turso.orgs;
    const m = /^\/organizations\/([^/]+)\/(databases|groups|plans)(?:\/([^/]+)(?:\/(usage|auth\/tokens))?)?$/.exec(p);
    if (!m || !st.turso.orgs.some((o) => o.slug === m[1])) return undefined;
    const [, , what, name, sub] = m;
    if (what === 'plans') return st.turso.plans ? { plans: st.turso.plans } : [403, { error: 'no' }];
    if (what === 'groups' && get_) return { groups: st.turso.groups };
    if (what === 'groups') { const b = JSON.parse(body) as { name: string; location: string }; const g = { name: b.name, primary: b.location }; st.turso.groups.push(g); return { group: g }; }
    if (!name && get_) return { databases: st.turso.dbs };
    if (!name) {
      const b = JSON.parse(body) as { name: string; group: string };
      if (!st.turso.groups.some((g) => g.name === b.group)) return [400, { error: 'group not found' }];
      const d = { Name: b.name, DbId: `tdb-new-${b.name}`, Hostname: `${b.name}-${m[1]}.turso.io`, group: b.group, block_reads: false, block_writes: false };
      st.turso.dbs.push(d);
      return { database: { DbId: d.DbId, Hostname: d.Hostname, Name: d.Name } };
    }
    const d = st.turso.dbs.find((x) => x.Name === name);
    if (!d) return [404, { error: `could not find database with name ${name}: record not found` }];
    if (sub === 'usage') return { database: { uuid: d.DbId, instances: [], total: { rows_read: 9, rows_written: 3, storage_bytes: 8192, bytes_synced: 0 } } };
    if (sub) {
      assert.deepEqual(Object.fromEntries(u.searchParams), { expiration: 'never', authorization: 'full-access' });
      if (!st.minting) return [403, { error: 'missing db:mint-token' }];
      st.turso.tokens++;
      return { jwt: TURSO_JWT };
    }
    if (method === 'DELETE') { st.turso.dbs = st.turso.dbs.filter((x) => x !== d); return { database: name }; }
    return { database: d };
  }
  if (service === 'upstash') {
    if (st.refused || auth !== `Basic ${Buffer.from(UP_KEY).toString('base64')}`) return [401, 'Unauthorized'];
    if (st.readOnly && write) return [403, 'this key is unauthorized to write'];
    if (p === '/redis/databases') return st.up.dbs;
    if (p === '/redis/database') {
      const b = JSON.parse(body) as Record<string, string>;
      if (b.plan === 'free' && st.up.dbs.some((x) => x.type === 'free')) return [400, 'You can only have one free database per account.'];
      const d = { database_id: `up-new-${b.database_name}`, database_name: b.database_name, type: st.up.makeAs ?? b.plan, region: 'global', primary_region: b.primary_region, endpoint: `new-${b.database_name}`, port: 6379, tls: true, state: 'active', password: REDIS_PW, rest_token: REST_TOKEN, read_only_rest_token: READ_TOKEN };
      st.up.dbs.push(d);
      return d;
    }
    const stats = /^\/redis\/stats\/(.+)$/.exec(p);
    if (stats) return { current_storage: 4096, total_monthly_storage: 1, keyspace: [] };
    const m = /^\/redis\/database\/(.+)$/.exec(p);
    const d = st.up.dbs.find((x) => x.database_id === m?.[1]);
    if (!m || !d) return [404, 'database not found'];
    if (method === 'DELETE') { st.up.dbs = st.up.dbs.filter((x) => x !== d); return 'OK'; }
    if (u.searchParams.get('credentials') === 'hide' || st.up.protection) { const { password: _p, rest_token: _r, read_only_rest_token: _o, ...safe } = d; return safe; }
    return d;
  }
  return undefined;
}

async function setup(t: TestContext) {
  const st = state(), api = await fakeApi((r: Req) => handle(st, r));
  for (const p of ['PLANETSCALE', 'TURSO', 'UPSTASH']) process.env[`UNIT7_${p}_API`] = `${api.base}/${p.toLowerCase()}`;
  t.after(() => { api.close(); for (const p of ['PLANETSCALE', 'TURSO', 'UPSTASH']) delete process.env[`UNIT7_${p}_API`]; });
  const app = testApp(), o = await testOrg(app);
  const acc = { planetscale: account(app, o.orgId, 'planetscale', PS_TOKEN), turso: account(app, o.orgId, 'turso', TURSO_TOKEN), upstash: account(app, o.orgId, 'upstash', UP_KEY) };
  const ends = { planetscale: { kind: 'planetscale', accountId: acc.planetscale, org: st.org, database: 'shop' }, turso: { kind: 'turso', accountId: acc.turso, org: st.org, database: 'orders' }, upstash: { kind: 'upstash', accountId: acc.upstash, database: st.up.dbs[0]!.database_id as string } };
  const sent = (method: string, path: RegExp) => api.calls.filter((c) => c.method === method && path.test(c.path));
  return { app, o, api, st, acc, ends, sent };
}
type Setup = Awaited<ReturnType<typeof setup>>;
// an app here, and what its code is known to read
async function appHere({ app, o }: Setup, reads?: string[]) {
  const environmentId = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id as string;
  const serviceId = ok(await o.h('service.create', { environmentId, name: 'web', source: { type: 'git', repo: 'ada/web' } })).serviceId as string;
  if (reads) run(app.db, `UPDATE services SET config = json_set(config, '$.detection', json(?)) WHERE id = ?`, JSON.stringify({ stack: 'express', envKeys: reads }), serviceId);
  return { serviceId, environmentId, to: { kind: 'unit7', serviceId } };
}
const reveal = async ({ o }: Setup, serviceId: string, key: string) => ok(await o.h('env.reveal', { serviceId, key })).value as string;
const errorOf = (r: unknown) => (r as { error: { code: string; message: string } }).error;
const yes = async ({ app, o }: Setup, asked: unknown, confirm?: string) => { const r = await decideApproval(app, o.orgId, o.human, (asked as { approvalId: string }).approvalId, true, confirm) as { status: string; output: any }; assert.equal(r.status, 'ok', JSON.stringify(r)); return r.output; };

test('with a key, each database shows on the map and in its tool: where it lives, what it holds, whether it’s healthy', async (t) => {
  const s = await setup(t), { app, o, st, api } = s;
  // pasted on the Connections page: each key is checked at once, in the form its service wants
  for (const [p, token] of [['planetscale', PS_TOKEN], ['turso', TURSO_TOKEN], ['upstash', UP_KEY]] as const) assert.equal(ok(await o.h('account.connect', { provider: p, token, name: `${p} 2` })).status, 'verified', p);
  ok(await o.h('account.connect', { provider: 'planetscale', token: `tokenid123:${PS_TOKEN}`, name: 'older token' }));
  assert.ok(api.calls.some((c) => c.path.startsWith('/planetscale/') && c.auth === `tokenid123:${PS_TOKEN}`), 'an older token goes with no scheme');
  run(app.db, `DELETE FROM accounts WHERE name IN ('planetscale 2', 'turso 2', 'upstash 2', 'older token')`);

  ok(await o.h('sync.run'));
  const on = async (provider: string) => (ok(await o.h('map.get', { provider })) as { assets: Record<string, unknown>[] }).assets;
  const ps = await on('planetscale'), tu = await on('turso'), up = await on('upstash');
  assert.deepEqual(ps.map((a) => [a.name, a.kind, a.engine, a.region, a.status, a.size]).sort(), [['big', 'database', 'postgres', 'us-east', 'active', 3000], ['legacy', 'database', 'mysql', 'eu-west', 'paused (sleeping)', undefined], ['shop', 'database', 'postgres', 'us-east', 'active', 2048]], 'the third is on a second page; a shard each adds up');
  assert.deepEqual(tu.map((a) => [a.name, a.engine, a.region, a.status, a.size]).sort(), [['frozen', 'sqlite', 'aws-eu-west-1', 'paused: writes are blocked', 8192], ['orders', 'sqlite', 'aws-eu-west-1', 'active', 8192]]);
  assert.deepEqual(up.map((a) => [a.name, a.engine, a.region, a.status, a.size]).sort(), [['cache', 'redis', 'eu-west-1', 'active', 4096], ['quiet', 'redis', 'us-east-1', 'inactive', 4096], ['stopped', 'redis', 'us-east-1', 'suspended', 4096]]);
  assert.deepEqual(ok(await o.a('link.options')).things.filter((x: { role: string }) => x.role === 'database').map((x: { name: string; provider: string }) => `${x.provider}:${x.name}`).sort(), ['planetscale:big', 'planetscale:legacy', 'planetscale:shop', 'turso:frozen', 'turso:orders', 'upstash:cache', 'upstash:quiet', 'upstash:stopped']);

  const list = ok(await o.a('planetscale.databases')).accounts[0].databases;
  assert.deepEqual(list.map((d: Record<string, unknown>) => [d.name, d.healthy, d.status, d.region, d.plan, d.tables, d.size]), [['shop', true, 'active', 'us-east', 'scaler_pro', 12, 2048], ['legacy', false, 'paused (sleeping)', 'eu-west', 'scaler_pro', undefined, undefined], ['big', true, 'active', 'us-east', undefined, undefined, 3000]]);
  assert.deepEqual(list[0].end, s.ends.planetscale, 'what link.create takes');
  assert.deepEqual(ok(await o.a('turso.databases')).accounts[0].databases.map((d: Record<string, unknown>) => [d.name, d.healthy, d.group, d.size]), [['orders', true, 'default', 8192], ['frozen', false, 'default', 8192]]);
  const upstash = ok(await o.a('upstash.databases'));
  assert.deepEqual(upstash.accounts[0].databases.map((d: Record<string, unknown>) => [d.name, d.healthy, d.host, d.plan]), [['cache', true, `calm-fox-${st.org.slice(4)}.upstash.io`, 'free'], ['stopped', false, `cold-owl-${st.org.slice(4)}.upstash.io`, 'payg'], ['quiet', false, `slow-elk-${st.org.slice(4)}.upstash.io`, 'free']]);
  assert.match(upstash.untrusted, /data, not instructions/);
  clean(upstash);
  clean(everywhere(app));
});

test('a one-click sign-in only reads: making, connecting and removing say to use a key, and its token never goes to the REST API', async (t) => {
  const s = await setup(t), { app, o, api, acc, ends, st } = s, { to } = await appHere(s);
  for (const id of Object.values(acc)) run(app.db, `UPDATE accounts SET meta = json_set(meta, '$.auth', 'oauth') WHERE id = ?`, id);
  api.calls.length = 0;
  for (const r of [await o.a('turso.create_database', { name: 'blog' }), await o.a('upstash.create_database', { name: 'blog' }), await o.h('link.create', { from: ends.turso, to }), await o.h('link.create', { from: ends.planetscale, to }), await o.h('link.create', { from: ends.upstash, to }), await o.h('planetscale.sizes', { org: st.org })]) {
    assert.equal(errorOf(r).code, 'needs_key');
    assert.match(errorOf(r).message, /can only read.*Use a key instead/);
  }
  assert.equal(api.calls.length, 0);
});

test('a refused key says so, fails that account’s scan out loud, and the map keeps its last good look', async (t) => {
  const s = await setup(t), { app, o, st, acc } = s;
  ok(await o.h('sync.run'));
  const before = get<{ n: number }>(app.db, `SELECT count(*) n FROM assets WHERE provider IN ('planetscale', 'turso', 'upstash')`)!.n;
  assert.equal(before, 8);

  for (const [p, token, why] of [['planetscale', 'pscale_tkn_wrongwrongwrongwrongwrong', /PlanetScale refused Unit7 \(Invalid service token\)/], ['turso', 'not-the-token-123', /Turso refused Unit7 \(could not parse jwt\)/], ['upstash', 'ada@example.com:wrong-key-123', /Upstash refused Unit7 \(Unauthorized\)/]] as const) {
    const r = ok(await o.h('account.connect', { provider: p, token, name: `${p} wrong` }));
    assert.equal(r.status, 'failing');
    assert.match(r.problem, why);
  }
  run(app.db, `DELETE FROM accounts WHERE name LIKE '% wrong'`);

  st.refused = true;
  const r = errorOf(await o.a('turso.databases', {}));
  assert.equal(r.code, 'service_auth');
  assert.match(r.message, /Check the key in Connections → Turso/);
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM accounts WHERE id = ?', acc.turso)!.status, 'failing', 'Warden leaves a dead key alone');

  const sync = ok(await o.h('sync.run'));
  for (const id of [acc.planetscale, acc.upstash]) assert.equal(sync.accounts.find((a: { id: string }) => a.id === id).ok, false);
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM assets WHERE provider IN ('planetscale', 'turso', 'upstash')`)!.n, before, 'the map doesn’t forget them');
});

test('a key that may read but not change says so, and stays in use', async (t) => {
  const s = await setup(t), { app, o, st, acc } = s;
  st.readOnly = true;
  const r = await o.a('turso.create_database', { name: 'blog' });
  assert.equal(errorOf(r).code, 'not_allowed');
  assert.match(errorOf(r).message, /may not do that\. Connections → Turso/);
  assert.equal(errorOf(await o.a('upstash.create_database', { name: 'blog', region: 'eu-west-1' })).code, 'not_allowed');
  for (const id of Object.values(acc)) assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM accounts WHERE id = ?', id)!.status, 'verified');
});

test('a size that can’t be read is just unknown, and a service that doesn’t answer says so in plain words', async (t) => {
  const { o, st } = await setup(t);
  st.down.add('GET /organizations/' + st.org + '/databases/shop/branches/main/metrics');
  ok(await o.h('sync.run'));
  const shop = (ok(await o.h('map.get', { provider: 'planetscale' })).assets as { name: string; size?: number; status: string }[]).find((a) => a.name === 'shop')!;
  assert.deepEqual([shop.size, shop.status], [undefined, 'active'], 'still on the map, and not called empty');

  process.env.UNIT7_TURSO_API = 'http://127.0.0.1:9/turso'; // nothing listens here
  const r = errorOf(await o.a('turso.databases', {}));
  assert.equal(r.code, 'service_unreachable');
  assert.match(r.message, /couldn’t reach Turso.*Check the internet connection/);
});

test('a stray character in a key is named, not a crash', async (t) => {
  const { o } = await setup(t);
  const r = ok(await o.h('account.connect', { provider: 'turso', token: 'turso-“curly”-token-123', name: 'curly' }));
  assert.equal(r.status, 'failing');
  assert.match(r.problem, /stray character/);
});

test('turso.create_database: free goes ahead on its own, in the group it belongs in, with no login in the result', async (t) => {
  const s = await setup(t), { app, o, st, sent, acc } = s;
  ok(await o.h('sync.run'));
  const r = ok(await o.a('turso.create_database', { name: 'blog' }));
  assert.deepEqual(JSON.parse(sent('POST', /\/databases$/)[0]!.body), { name: 'blog', group: 'default' });
  assert.deepEqual(r.end, { kind: 'turso', accountId: acc.turso, org: st.org, database: 'blog' });
  assert.equal(r.region, 'aws-eu-west-1');
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM approvals')!.n, 0, 'only creates, so nothing waits');
  assert.ok((ok(await o.h('map.get', { provider: 'turso' })).assets as { name: string }[]).some((a) => a.name === 'blog'), 'on the map at once');
  clean(r);

  // a choice is the person's to name
  st.turso.groups.push({ name: 'eu', primary: 'aws-eu-central-1' });
  assert.match(errorOf(await o.a('turso.create_database', { name: 'two' })).message, /Say which group: default, eu/);
  const two = ok(await o.a('turso.create_database', { name: 'two', group: 'eu', region: 'aws-us-east-1' }));
  assert.match(two.note, /lives in aws-eu-central-1, where its group is/);
  st.turso.orgs.push({ slug: 'second', overages: false });
  assert.match(errorOf(await o.a('turso.create_database', { name: 'three' })).message, new RegExp(`Say which organisation \\(org\\): ${st.org}, second`));
});

test('turso.create_database: an organisation with no group gets one, in the region named', async (t) => {
  const { o, st, sent } = await setup(t);
  st.turso.groups.length = 0;
  assert.match(errorOf(await o.a('turso.create_database', { name: 'blog' })).message, /no group yet.*region/);
  assert.equal(sent('POST', /./).length, 0);
  ok(await o.a('turso.create_database', { name: 'blog', region: 'aws-eu-west-1' }));
  assert.deepEqual(JSON.parse(sent('POST', /\/groups$/)[0]!.body), { name: 'default', location: 'aws-eu-west-1' });
  assert.deepEqual(JSON.parse(sent('POST', /\/databases$/)[0]!.body), { name: 'blog', group: 'default' });
});

test('turso.create_database: anything that isn’t plainly free is a person’s, and an AI is refused whatever it says', async (t) => {
  const s = await setup(t), { o, st, sent } = s, org = st.turso.orgs[0]!, made = () => sent('POST', /\/databases$/).length;
  org.plan_id = 'scaler';
  assert.equal(errorOf(await o.a('turso.create_database', { name: 'blog' })).code, 'paid_plan');
  assert.equal((await o.a('turso.create_database', { name: 'blog', paid: true, confirmName: 'blog' })).status, 'denied');
  org.plan_id = 'starter'; org.overages = true;
  assert.equal(errorOf(await o.a('turso.create_database', { name: 'blog' })).code, 'paid_plan', 'overages can bill on a plan at no cost');
  org.overages = false; org.plan_id = 'a-plan-it-does-not-list';
  assert.equal(errorOf(await o.a('turso.create_database', { name: 'blog' })).code, 'paid_plan', 'a plan with no price isn’t free');
  org.plan_id = 'starter'; st.turso.plans = undefined;
  const r = errorOf(await o.a('turso.create_database', { name: 'blog' }));
  assert.equal(r.code, 'plan_unknown');
  assert.match(r.message, /didn’t create anything that might cost money/);
  assert.equal(made(), 0);

  assert.equal(errorOf(await o.h('turso.create_database', { name: 'blog', paid: true })).code, 'confirm_needed');
  const asked = await o.h('turso.create_database', { name: 'blog', paid: true, confirmName: 'blog' });
  assert.equal(asked.status, 'approval_required', 'a person’s purchase still waits for a yes');
  assert.equal(made(), 0);
  await yes(s, asked, 'blog');
  assert.equal(made(), 1);
});

test('upstash.create_database: the free plan by name for an AI, a paid one only for a person, and the keys in its answer go no further', async (t) => {
  const s = await setup(t), { app, o, st, sent, acc } = s, made = () => sent('POST', /\/redis\/database$/);
  // Upstash allows one free database per free account, and says so in its own words
  const full = errorOf(await o.a('upstash.create_database', { name: 'blog' }));
  assert.equal(full.code, 'service_error');
  assert.match(full.message, /Upstash: You can only have one free database per account/);
  st.up.dbs = st.up.dbs.filter((d) => d.type !== 'free');

  const r = ok(await o.a('upstash.create_database', { name: 'blog', region: 'eu-west-1' }));
  assert.deepEqual(JSON.parse(made().at(-1)!.body), { database_name: 'blog', platform: 'aws', primary_region: 'eu-west-1', plan: 'free', tls: true });
  assert.equal(r.host, 'new-blog.upstash.io');
  assert.deepEqual(r.end, { kind: 'upstash', accountId: acc.upstash, database: 'up-new-blog' });
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM approvals')!.n, 0);
  clean(r);
  clean(everywhere(app));

  const before = made().length;
  assert.equal((await o.a('upstash.create_database', { name: 'paid', plan: 'payg', confirmName: 'paid' })).status, 'denied');
  assert.equal(made().length, before);
  const asked = await o.h('upstash.create_database', { name: 'paid', plan: 'payg', region: 'us-central1', confirmName: 'paid' });
  assert.equal(asked.status, 'approval_required');
  await yes(s, asked, 'paid');
  assert.deepEqual(JSON.parse(made().at(-1)!.body), { database_name: 'paid', platform: 'gcp', primary_region: 'us-central1', plan: 'payg', tls: true });
});

test('if Upstash ever bills what was asked for free, a person hears at once', async (t) => {
  const { app, o, st } = await setup(t);
  st.up.dbs = [];
  st.up.makeAs = 'payg';
  const r = ok(await o.a('upstash.create_database', { name: 'blog' }));
  assert.match(r.warning, /payg plan, not the free one/);
  assert.equal(get<{ severity: string }>(app.db, `SELECT severity FROM events WHERE type = 'upstash.not_free'`)!.severity, 'warning');
});

test('planetscale.create_database: no free plan, so an AI never can, and a person sees the sizes, types the name and says yes', async (t) => {
  const s = await setup(t), { o, st, sent } = s, made = () => sent('POST', /\/databases$/).length;
  const ai = await o.a('planetscale.create_database', { name: 'blog', size: 'PS_5', confirmName: 'blog' });
  assert.equal(ai.status, 'denied');
  assert.match((ai as { why: string }).why, /no free plan/);
  assert.equal(made(), 0);

  const sizes = ok(await o.a('planetscale.sizes', {}));
  assert.deepEqual(sizes.sizes, [{ name: 'PS_5', displayName: 'PS-5', cpu: '1/16', ram: 536870912, storage: null, rate: 5, replicaRate: 0 }], 'what’s switched on, without metal');
  assert.match(sent('GET', /cluster-size-skus/)[0]!.path, /engine=postgresql&rates=true/);

  assert.equal(errorOf(await o.h('planetscale.create_database', { name: 'blog', size: 'PS_5' })).code, 'confirm_needed');
  const asked = await o.h('planetscale.create_database', { name: 'blog', size: 'PS_5', confirmName: 'blog' });
  assert.equal(asked.status, 'approval_required');
  assert.equal(made(), 0);
  const r = await yes(s, asked, 'blog');
  assert.deepEqual(JSON.parse(sent('POST', /\/databases$/)[0]!.body), { name: 'blog', cluster_size: 'PS_5', kind: 'postgresql' });
  assert.equal(r.status, 'pending');
  assert.deepEqual(r.end, { kind: 'planetscale', accountId: s.acc.planetscale, org: st.org, database: 'blog' });
});

test('the raw pass-through can’t buy what the tools won’t: a new database or branch is a person’s there too', () => {
  for (const tool of ['planetscale_create_database', 'planetscale_create_branch', 'create_database', 'redis_create_database', 'redis_database_create_new', 'createDatabase']) {
    const j = judged({ accountId: 'acc_x', tool });
    assert.deepEqual([j.money, j.risk], [true, 'destructive'], tool);
  }
  for (const tool of ['planetscale_list_databases', 'redis_get_stats', 'list_databases']) assert.equal(judged({ accountId: 'acc_x', tool }).money, false, tool);
  const pass = getTool('connection.call')!, peopleOnly = pass.peopleOnly as (i: unknown) => boolean;
  assert.equal(peopleOnly({ accountId: 'acc_x', tool: 'planetscale_create_database', arguments: {} }), true);
});

test('an AI’s link to any of them waits for a person, redeploy or not, and nothing is made until they say yes', async (t) => {
  const s = await setup(t), { app, o, st, ends, sent } = s, { to, serviceId } = await appHere(s);
  const waiting: Record<string, unknown> = {};
  for (const [p, from] of Object.entries(ends)) {
    for (const apply of [false, true]) {
      const r = await o.a('link.create', { from, to, apply });
      assert.equal(r.status, 'approval_required', `${p} with apply ${apply}: a redeploy skipped still puts the login in the app’s settings`);
      assert.match((r as { why: string }).why, /database login into an app’s settings/);
      clean(r);
      if (apply) waiting[p] = r;
    }
  }
  assert.equal(sent('POST', /./).length, 0, 'no login made yet');
  assert.equal(sent('GET', /\/redis\/database\//).length, 0, 'no keys read yet');
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM links')!.n, 0);

  const ps = await yes(s, waiting.planetscale), tu = await yes(s, waiting.turso), up = await yes(s, waiting.upstash);
  assert.deepEqual([ps.set, tu.set.sort(), up.set.sort()], [['DATABASE_URL'], ['TURSO_AUTH_TOKEN', 'TURSO_DATABASE_URL'], ['UPSTASH_REDIS_REST_TOKEN', 'UPSTASH_REDIS_REST_URL']]);
  for (const r of [ps, tu, up]) clean(r);

  assert.equal(await reveal(s, serviceId, 'DATABASE_URL'), `postgresql://postgres.abc123:${PG_PW}@db.psdb.example:5432/shop?sslmode=verify-full`);
  assert.equal(await reveal(s, serviceId, 'TURSO_DATABASE_URL'), `libsql://orders-${st.org}.aws-eu-west-1.turso.io`);
  assert.equal(await reveal(s, serviceId, 'TURSO_AUTH_TOKEN'), TURSO_JWT);
  assert.equal(await reveal(s, serviceId, 'UPSTASH_REDIS_REST_URL'), `https://calm-fox-${st.org.slice(4)}.upstash.io`);
  assert.equal(await reveal(s, serviceId, 'UPSTASH_REDIS_REST_TOKEN'), REST_TOKEN);

  clean(ok(await o.a('link.list', {})));
  clean(ok(await o.a('env.list', { serviceId })));
  clean(everywhere(app));
});

test('a person connects them in one go, and a login made once is never made again', async (t) => {
  const s = await setup(t), { o, st, ends } = s, { to } = await appHere(s);
  const ps = ok(await o.h('link.create', { from: ends.planetscale, to })), tu = ok(await o.h('link.create', { from: ends.turso, to }));
  assert.equal(ps.from, 'shop');
  assert.equal(ok(await o.h('link.create', { from: ends.upstash, to })).from, 'cache', 'named, though it’s connected by id');
  assert.deepEqual([st.ps.logins, st.turso.tokens], [1, 1]);
  for (const linkId of [ps.linkId, tu.linkId]) {
    assert.deepEqual(ok(await o.a('link.sync', { linkId })).set, [], 'a daily sync changes nothing');
    assert.equal(errorOf(await o.h('link.rotate', { linkId })).code, 'nothing_to_rotate', 'a random key would break it');
  }
  assert.deepEqual([st.ps.logins, st.turso.tokens], [1, 1]);
  // the same two things again use the same link
  ok(await o.h('link.create', { from: ends.turso, to }));
  assert.equal(st.turso.tokens, 1);
});

test('a login made before a step failed is kept, so the retry doesn’t make another', async (t) => {
  const s = await setup(t), { app, o, st, ends } = s, { to, environmentId, serviceId } = await appHere(s);
  setAutonomy(app, environmentId, 2); // at Safe actions, the setting itself asks a person, so this link stops there
  const asked = await o.a('link.create', { from: ends.turso, to });
  const r = await decideApproval(app, o.orgId, o.human, (asked as { approvalId: string }).approvalId, true) as { status: string; error: { message: string } };
  assert.equal(r.status, 'error');
  assert.match(r.error.message, /needs approval/);
  assert.equal(st.turso.tokens, 1);
  const link = ok(await o.a('link.list', {}))[0];
  assert.equal(link.status, 'broken');
  clean(link);
  ok(await o.h('link.sync', { linkId: link.id }));
  assert.equal(st.turso.tokens, 1);
  assert.equal(await reveal(s, serviceId, 'TURSO_AUTH_TOKEN'), TURSO_JWT);
});

test('a provider that won’t give a login leaves a broken link with why, no secret, and it finishes once it can', async (t) => {
  const s = await setup(t), { app, o, st, ends } = s, { to, serviceId } = await appHere(s);
  st.minting = false;
  assert.equal(errorOf(await o.h('link.create', { from: ends.turso, to })).code, 'not_allowed');
  const link = ok(await o.a('link.list', {}))[0];
  assert.equal(link.status, 'broken');
  assert.match(link.detail, /Turso says this key may not do that/);
  assert.deepEqual(link.settings, []);
  st.minting = true;
  ok(await o.h('link.sync', { linkId: link.id }));
  assert.equal(await reveal(s, serviceId, 'TURSO_AUTH_TOKEN'), TURSO_JWT);

  // Upstash won't hand keys to a read-only key, or when credential protection is on
  st.up.protection = true;
  const r = errorOf(await o.h('link.create', { from: ends.upstash, to }));
  assert.equal(r.code, 'no_login');
  assert.match(r.message, /read-only, or credential protection/);
  clean(everywhere(app));
});

test('settings use the names the code reads, a MySQL database gets a password, and nothing goes into a name the browser sees', async (t) => {
  const s = await setup(t), { o, st, ends } = s, code = await appHere(s, ['LIBSQL_URL', 'LIBSQL_AUTH_TOKEN', 'NEXT_PUBLIC_TURSO_AUTH_TOKEN', 'REDIS_URL', 'MYSQL_URL', 'PORT']);
  const tu = ok(await o.h('link.create', { from: ends.turso, to: code.to }));
  assert.deepEqual(tu.set.sort(), ['LIBSQL_AUTH_TOKEN', 'LIBSQL_URL']);
  const up = ok(await o.h('link.create', { from: ends.upstash, to: code.to }));
  assert.deepEqual(up.set, ['REDIS_URL'], 'a Redis client needs no REST keys');
  assert.equal(await reveal(s, code.serviceId, 'REDIS_URL'), `rediss://default:${encodeURIComponent(REDIS_PW)}@calm-fox-${st.org.slice(4)}.upstash.io:6379`);
  const ps = ok(await o.h('link.create', { from: { ...ends.planetscale, database: 'legacy' }, to: code.to }));
  assert.deepEqual(ps.set, ['MYSQL_URL']);
  assert.equal(await reveal(s, code.serviceId, 'MYSQL_URL'), `mysql://mysqluser1:${MYSQL_PW}@db.psdb.example/legacy?ssl={"rejectUnauthorized":true}`);
  const r = await o.h('env.reveal', { serviceId: code.serviceId, key: 'NEXT_PUBLIC_TURSO_AUTH_TOKEN' });
  assert.equal(r.status, 'error', 'never set');
});

test('the map draws what’s wired: by its address for Turso and Upstash, by the connection for PlanetScale’s shared one', async (t) => {
  const s = await setup(t), { o, ends } = s, { to } = await appHere(s);
  for (const from of Object.values(ends)) ok(await o.h('link.create', { from, to }));
  ok(await o.h('sync.run'));
  const m = ok(await o.h('map.get', {})) as { assets: { id: string; name: string }[]; edges: { source: string; target: string; via: string }[] };
  const web = m.assets.find((a) => a.name === 'web')!.id, line = (name: string) => m.edges.find((e) => e.source === web && e.target === m.assets.find((a) => a.name === name)!.id)?.via;
  assert.equal(line('shop'), 'connected by Unit7');
  assert.equal(line('orders'), 'TURSO_DATABASE_URL');
  assert.equal(line('cache'), 'UPSTASH_REDIS_REST_URL');
});

test('an app on a database that’s stopped is flagged, whichever way that service says it', async (t) => {
  const s = await setup(t), { o, st, ends } = s;
  for (const [from, name, word] of [[{ ...ends.upstash, database: st.up.dbs[1]!.database_id as string }, 'web-a', 'stopped, which is suspended'], [{ ...ends.planetscale, database: 'legacy' }, 'web-b', 'legacy, which is paused \\(sleeping\\)'], [{ ...ends.turso, database: 'frozen' }, 'web-c', 'frozen, which is paused: writes are blocked']] as const) {
    const env = ok(await o.h('project.create', { name, environments: ['production'] })).environments[0].id;
    const serviceId = ok(await o.h('service.create', { environmentId: env, name, source: { type: 'git', repo: `ada/${name}` } })).serviceId;
    ok(await o.h('link.create', { from, to: { kind: 'unit7', serviceId } }));
    ok(await o.h('sync.run'));
    assert.match((ok(await o.h('map.get', {})).issues as { text: string }[]).map((i) => i.text).join('\n'), new RegExp(`${name} uses ${word}`));
  }
});

test('an AI’s delete: it names the database, a person types it, and it waits 48 hours', async (t) => {
  const s = await setup(t), { app, o, st, sent, ends } = s;
  for (const service of ['planetscale', 'turso', 'upstash']) assert.ok(HELD_TOOLS.has(`${service}.delete_database`));
  ok(await o.h('sync.run'));
  const cases = [['planetscale', { org: st.org, database: 'shop' }, 'shop', /\/databases\/shop$/], ['turso', { database: 'orders' }, 'orders', /\/databases\/orders$/], ['upstash', { database: ends.upstash.database }, 'cache', /\/redis\/database\/up-/]] as const;
  for (const [service, target, name, path] of cases) {
    assert.equal(errorOf(await o.a(`${service}.delete_database`, target)).code, 'invalid_input', 'it has to name it');
    const asked = await o.a(`${service}.delete_database`, { ...target, confirmName: name });
    assert.equal(asked.status, 'approval_required');
    assert.equal(sent('DELETE', path).length, 0);
    await assert.rejects(decideApproval(app, o.orgId, o.human, (asked as { approvalId: string }).approvalId, true, 'something-else'), /Type the name/);
    const r = await yes(s, asked, name);
    assert.equal(r.held, true);
    assert.equal(sent('DELETE', path).length, 0, 'an AI’s delete waits, even after a yes');
    await runHeld(app, Date.now() + 49 * 3600_000);
    assert.equal(sent('DELETE', path).length, 1);
  }
  assert.deepEqual([st.ps.dbs.some((d) => d.name === 'shop'), st.turso.dbs.some((d) => d.Name === 'orders'), st.up.dbs.some((d) => d.database_name === 'cache')], [false, false, false]);
  assert.ok(!(ok(await o.h('map.get', { provider: 'turso' })).assets as { name: string }[]).some((a) => a.name === 'orders'), 'off the map');
});

test('a delete checks the real name, even after a yes, and a person’s own waits for theirs', async (t) => {
  const s = await setup(t), { app, o, ends, sent } = s;
  const asked = await o.a('upstash.delete_database', { database: ends.upstash.database, confirmName: 'not-its-name' });
  await yes(s, asked, 'not-its-name');
  await runHeld(app, Date.now() + 49 * 3600_000);
  assert.equal(sent('DELETE', /./).length, 0, 'what an AI typed isn’t what’s there');
  assert.equal((await o.h('turso.delete_database', { database: 'orders', confirmName: 'orders' })).status, 'approval_required', 'a person’s own delete is restricted too');
  assert.equal(errorOf(await o.a('turso.delete_database', { database: '..', confirmName: '..' })).code, 'invalid_input', 'a name that climbs out of the path');
  assert.equal(errorOf(await o.h('link.create', { from: { ...ends.turso, database: '../x' }, to: { kind: 'unit7', serviceId: 'svc_aaaaaaaaaaaa' } })).code, 'invalid_input');
});

test('a person’s Delete card works on them too, and says what it takes with it', async (t) => {
  const s = await setup(t), { app, o, st, sent } = s;
  ok(await o.h('sync.run'));
  for (const [provider, name, path] of [['planetscale', 'shop', /\/databases\/shop$/], ['turso', 'orders', /\/databases\/orders$/], ['upstash', 'cache', /\/redis\/database\/up-/]] as const) {
    const key = get<{ id: string }>(app.db, 'SELECT id FROM assets WHERE provider = ? AND name = ?', provider, name)!.id;
    const impact = ok(await o.h('asset.impact', { key }));
    assert.equal(impact.can.delete, true);
    assert.equal(impact.dataGoes, 'always');
    assert.equal(errorOf(await o.h('asset.delete', { key, confirmName: name })).code, 'data_goes');
    assert.equal(ok(await o.h('asset.delete', { key, confirmName: name, alsoData: true })).deleted, name);
    assert.equal(sent('DELETE', path).length, 1);
  }
  assert.equal(st.up.dbs.length, 2);
  assert.equal((await o.a('asset.delete', { key: 'ast_aaaaaaaaaaaa', confirmName: 'x', alsoData: true })).status, 'denied', 'never an AI');
});

test('Connections says how to get a key that can do all of it', () => {
  for (const [id, words] of [['planetscale', /create_databases.*connect_production_branch/], ['turso', /db:create.*db:mint-token/], ['upstash', /Read\/Write/]] as const) {
    const p = provider(id)!;
    assert.ok(p.what && p.method.kind === 'mcp' && p.alt?.keyUrl);
    assert.match(p.alt!.hint, words);
  }
  assert.ok(new RegExp(provider('planetscale')!.alt!.pattern!).test(`tokenid123:${PS_TOKEN}`), 'an older token passes');
});
