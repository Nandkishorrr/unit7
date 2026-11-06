// Two tools only a person may run, now with a button: a database's major upgrade on the server's Data tab, and a new PlanetScale database
// on Connections. What's tested is what the pages lean on: what the plan offers, the test that passed outliving a reload, the organisation
// a person picks, and the price they see. A stand-in server and a fake PlanetScale answer; nothing real is touched.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { testApp, testOrg, ok } from './helpers.ts';
import { account, fakeApi } from './clouds-fakes.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { buildInventory, type Part } from '../src/discovery/xray.ts';
import { manageDirs } from '../src/tools/manage.ts';
import { decideApproval } from '../src/tools/runtime.ts';
import { saveXray } from '../src/tools/xray.ts';
import { tidy } from '../web/src/lib/words.ts';
import { sizeChoices, upgradeOffer } from '../web/src/pages/servers/shape.ts';

// --- a database's major upgrade ------------------------------------------------------------------------------------------------
const SRV = 'srv_btn000000001', PG = 'c:pg-db', SUPA = 'coolify:shopsupa01', MY = 'c:my-db', PLAIN = 'c:plain-db', LATEST = 'c:latest-db';
const dump = gzipSync(Buffer.from('COPY public.users (id) FROM stdin;\n1\n2\n\\.\n')), sum = createHash('sha256').update(dump).digest('hex');
const part = (x: Partial<Part>) => ({ kind: 'database', owner: 'compose', trust: 'understood', project: 'c:shop', ...x } as Part);
const PLAN = { serverId: SRV, part: PG };

async function setup() {
  Object.assign(manageDirs, { backups: '/tmp/unit7-test-backups' });
  const app = testApp(), o = await testOrg(app, 'Sam');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'web-1', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', '{}')`, SRV, o.orgId);
  run(app.db, `UPDATE orgs SET offsite = 'off'`);
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
  inv.parts.push(
    part({ id: PG, name: 'pg-db', engine: 'postgres', image: 'postgres:16-alpine', containers: ['pg-db-1'], networks: ['shop_default'], compose: { project: 'shop', service: 'db', workingDir: '/srv/shop', files: '/srv/shop/docker-compose.yml' } }),
    part({ id: MY, name: 'my-db', engine: 'mysql', image: 'mysql:8.4', containers: ['my-db-1'], networks: ['shop_default'] }),
    part({ id: PLAIN, name: 'plain-db', engine: 'postgres', image: 'postgres:16-alpine', containers: ['plain-db-1'], networks: ['shop_default'] }),
    part({ id: LATEST, name: 'latest-db', engine: 'postgres', image: 'postgres:latest', containers: ['latest-db-1'], networks: ['shop_default'], compose: { project: 'shop', service: 'db2', workingDir: '/srv/shop', files: '/srv/shop/docker-compose.yml' } }),
  );
  saveXray(app.db, o.orgId, SRV, 'fast', inv);
  return { app, o };
}
// a stand-in server: what the scripts of a backup, a test restore and a switch answer. rows is how many come back.
function server(app: App, rows = 2) {
  ssh(app).exec = async (_s, cmd, x: ExecOptions = {}) => {
    const stdin = String(x.stdin ?? ''), say = (stdout: string) => ({ code: 0, stdout, stderr: '', truncated: false });
    if (stdin.includes('server_version_num')) return say(`${JSON.stringify({ version: 160004, bytes: 1048576, extensions: ['vector'] })}\n`);
    if (cmd.includes('{{json .Mounts}}')) return say('[{"Source":"/var/lib/docker/volumes/shop_db/_data","Destination":"/var/lib/postgresql/data"}]\nPGDATA=/var/lib/postgresql/data\n@@\nPGDATA=/var/lib/postgresql/data\n');
    if (cmd.includes('print db')) return say('shop\tpublic.users\t2\n');
    if (stdin.includes(`select 'public.users'`)) return say(`public.users|${rows}\n`);
    if (cmd.includes('printf %s') && cmd.includes('POSTGRES_USER')) return say('postgres');
    if (cmd.includes('MemAvailable')) return say('8000000000\n');
    if (cmd.includes('wc -c')) return say(`${dump.length}\n${sum}\n`);
    if (cmd.includes('gunzip -t')) return say(`${sum}\n`);
    return say('');
  };
  ssh(app).check = async (s, cmd, x = {}) => { const r = await ssh(app).exec(s, cmd, x); if (r.code !== 0) throw new Error(`${x.what ?? 'command'}: ${r.stderr}`); return r.stdout; };
  ssh(app).getFile = async (_s, _r, local) => { writeFileSync(local, 'a,b\n1,2\n'); };
  ssh(app).putFile = async () => undefined;
}
const code = (r: any) => (r.status === 'error' ? r.error.code : r.status);
const yes = (app: App, o: { orgId: string; human: never }, r: unknown, name: string) => decideApproval(app, o.orgId, o.human, (r as { approvalId: string }).approvalId, true, name) as Promise<any>;

test('the plan offers a test first, and the switch only once a test has passed', async () => {
  const { app, o } = await setup();
  server(app);
  const first = ok(await o.h('part.upgrade_plan', PLAN));
  assert.equal(first.tested, undefined);
  assert.deepEqual(upgradeOffer(first), { test: true, move: false });
  assert.ok(first.steps.every((s: string) => !/part\.|upgrade_/.test(s)), 'a person reads these, so no tool names');

  const out = ok(await o.h('part.upgrade_run', PLAN));
  const plan = ok(await o.h('part.upgrade_plan', PLAN));
  assert.equal(plan.tested.image, 'postgres:17-alpine');
  assert.match(plan.tested.found, /all 1 table and 2 rows came back/, 'what it found outlives a reload');
  assert.ok(plan.tested.found.includes(out.copy), 'and which copy to try');
  assert.ok(Date.now() - Date.parse(plan.tested.at) < 60_000, `a time the page can read: ${plan.tested.at}`);
  assert.deepEqual(upgradeOffer(plan), { test: true, move: true });

  // used up: the switch made the test history, so the page goes back to offering a test
  ok(await yes(app, o as never, await o.h('part.upgrade_switch', { ...PLAN, confirmName: 'pg-db' }), 'pg-db'));
  assert.equal(ok(await o.h('part.upgrade_plan', PLAN)).tested, undefined);
});

test('a test that came back short, or was undone, offers no switch', async () => {
  const { app, o } = await setup();
  server(app, 1);
  assert.equal(code(await o.h('part.upgrade_run', PLAN)), 'upgrade_failed');
  assert.equal(ok(await o.h('part.upgrade_plan', PLAN)).tested, undefined);

  server(app);
  const { changeId } = ok(await o.h('part.upgrade_run', PLAN));
  assert.equal(upgradeOffer(ok(await o.h('part.upgrade_plan', PLAN))).move, true);
  ok(await o.h('change.undo', { changeId }));
  const plan = ok(await o.h('part.upgrade_plan', PLAN));
  assert.equal(plan.tested, undefined, 'the side copy is gone, so there’s nothing to move to');
  assert.equal(upgradeOffer(plan).move, false);
});

test('where Unit7 can’t switch, the plan says why, and a passed test changes nothing', async () => {
  const { app, o } = await setup();
  server(app);
  const supa = ok(await o.h('part.upgrade_plan', { serverId: SRV, part: SUPA }));
  assert.equal(supa.canSwitch, false);
  assert.match(supa.switchNote, /Supabase builds its own Postgres/);
  assert.deepEqual(upgradeOffer(supa), { test: true, move: false }, 'it can still be tested side by side');
  assert.equal(upgradeOffer({ ...supa, tested: { image: 'x:1', at: '', found: '' } }).move, false);

  const plain = ok(await o.h('part.upgrade_plan', { serverId: SRV, part: PLAIN }));
  assert.match(plain.switchNote, /nothing records it but the running container/);
  assert.equal(plain.steps.length, 3, 'no switch step');

  const my = await o.h('part.upgrade_plan', { serverId: SRV, part: MY });
  assert.equal(code(my), 'unsupported');
  assert.match((my as any).error.message, /work on Postgres so far/, 'the words the card shows');
});

test('with no next version, or an older one, nothing is offered until a person names an image', async () => {
  const { app, o } = await setup();
  server(app);
  const unknown = ok(await o.h('part.upgrade_plan', { serverId: SRV, part: LATEST }));
  assert.equal(unknown.to, null);
  assert.match(unknown.problem, /Say which image/);
  assert.equal(upgradeOffer(unknown).test, false);
  const named = ok(await o.h('part.upgrade_plan', { serverId: SRV, part: LATEST, image: 'postgres:17-alpine' }));
  assert.equal(named.to, 'postgres:17-alpine');
  assert.equal(upgradeOffer(named).test, true);
  const older = ok(await o.h('part.upgrade_plan', { ...PLAN, image: 'postgres:15-alpine' }));
  assert.match(older.problem, /isn’t a newer major version/);
  assert.equal(upgradeOffer(older).test, false);
  assert.equal(code(await o.h('part.upgrade_plan', { ...PLAN, image: 'postgres:17; reboot' })), 'invalid_input');
});

test('an image keeps its name in what a person reads', () => {
  assert.equal(tidy('postgres:17-alpine didn’t take db’s data'), 'postgres:17-alpine didn’t take db’s data');
  assert.equal(tidy('postgres: it refused'), 'PostgreSQL: it refused');
});

test('an AI that tries the people-only tools hears where the person’s button is', async () => {
  const { app, o } = await setup();
  server(app);
  const up = await o.a('part.upgrade_switch', { ...PLAN, confirmName: 'pg-db' });
  assert.equal(up.status, 'denied');
  assert.match((up as { why: string }).why, /Data tab/);
  const ps = await o.a('planetscale.create_database', { name: 'blog', size: 'PS_5', confirmName: 'blog' });
  assert.equal(ps.status, 'denied');
  assert.match((ps as { why: string }).why, /Connections, then PlanetScale, then New database/);
});

// --- a new PlanetScale database ------------------------------------------------------------------------------------------------
const TOKEN = `pscale_tkn_${'b2'.repeat(16)}`;
async function planetscale(t: TestContext, orgs: string[]) {
  const made: { org: string; body: Record<string, unknown> }[] = [];
  const api = await fakeApi(({ method, path, auth, body }) => {
    if (auth !== `Bearer ${TOKEN}`) return [401, { code: 'unauthorized', message: 'Invalid service token' }];
    const u = new URL(path, 'http://x'), m = /^\/organizations\/([^/]+)\/(databases|cluster-size-skus)$/.exec(u.pathname);
    if (u.pathname === '/organizations') return { current_page: 1, next_page: null, data: orgs.map((name) => ({ name })) };
    if (!m || !orgs.includes(m[1]!)) return undefined;
    if (m[2] === 'cluster-size-skus') return [{ name: 'PS_10', display_name: 'PS-10', cpu: '1/8', ram: 1073741824, storage: null, rate: 10, replica_rate: 5, enabled: true, metal: false }, { name: 'PS_5', display_name: 'PS-5', cpu: '1/16', ram: 536870912, storage: null, rate: 5, replica_rate: 0, enabled: true, metal: false }];
    if (method === 'POST') { made.push({ org: m[1]!, body: JSON.parse(body) }); return [201, { name: 'blog', kind: 'postgresql', state: 'pending', ready: false, default_branch: 'main', region: { slug: 'us-east' } }]; }
    return { current_page: 1, next_page: null, data: [] };
  });
  process.env.UNIT7_PLANETSCALE_API = api.base;
  t.after(() => { api.close(); delete process.env.UNIT7_PLANETSCALE_API; });
  const app = testApp(), o = await testOrg(app), accountId = account(app, o.orgId, 'planetscale', TOKEN);
  return { app, o, accountId, api, made };
}

test('several organisations: the sizes wait until a person picks the one that pays', async (t) => {
  const { app, o, accountId, api, made } = await planetscale(t, ['acme', 'side-project']);
  const asked = ok(await o.h('planetscale.sizes', { accountId }));
  assert.deepEqual(asked.orgs, ['acme', 'side-project']);
  assert.deepEqual(asked.sizes, []);
  assert.equal(api.calls.filter((c) => c.path.includes('cluster-size-skus')).length, 0, 'no rates read for a guess');

  const sized = ok(await o.h('planetscale.sizes', { accountId, org: 'side-project', engine: 'mysql' }));
  assert.equal(sized.org, 'side-project');
  assert.deepEqual(sized.orgs, ['acme', 'side-project'], 'the picker stays');
  assert.deepEqual(sizeChoices(sized.sizes).map((s) => s.id), ['PS_5', 'PS_10'], 'cheapest first');
  assert.match(api.calls.at(-1)!.path, /organizations\/side-project\/cluster-size-skus\?engine=mysql/);

  // exactly what the dialog sends: it waits for a yes, in the organisation picked, and a person types the name there
  const r = await o.h('planetscale.create_database', { accountId, org: 'side-project', name: 'blog', size: 'PS_5', engine: 'mysql', confirmName: 'blog' });
  assert.equal(r.status, 'approval_required');
  assert.equal(made.length, 0, 'nothing is billed before the yes');
  await assert.rejects(yes(app, o as never, r, 'nope'), /Type the name \(blog\)/);
  assert.equal(made.length, 0, 'the wrong name runs nothing');
  ok(await yes(app, o as never, r, 'blog'));
  assert.deepEqual(made, [{ org: 'side-project', body: { name: 'blog', cluster_size: 'PS_5', kind: 'mysql' } }]);
});

test('one organisation goes straight to its sizes, and none says so', async (t) => {
  const one = await planetscale(t, ['acme']);
  const r = ok(await one.o.h('planetscale.sizes', { accountId: one.accountId }));
  assert.equal(r.org, 'acme');
  assert.equal(r.sizes.length, 2);
  const none = await planetscale(t, []);
  assert.match((await none.o.h('planetscale.sizes', { accountId: none.accountId }) as any).error.message, /this key sees none/);
});

test('a one-click sign-in can only read, and the dialog says what to do', async (t) => {
  const { app, o, accountId } = await planetscale(t, ['acme']);
  run(app.db, `UPDATE accounts SET meta = json_set(meta, '$.auth', 'oauth') WHERE id = ?`, accountId);
  const r = await o.h('planetscale.sizes', { accountId });
  assert.equal(code(r), 'needs_key');
  assert.match((r as any).error.message, /Use a key instead/);
});

test('a price before the press: a size with no rate isn’t offered, and memory reads the way PlanetScale sells it', () => {
  const sizes = [
    { name: 'PS_1G', displayName: 'PS-1G', cpu: '2', ram: 2 ** 31, storage: 3 * 2 ** 30, rate: 39 },
    { name: 'PS_FREE', displayName: 'PS-Free', rate: 0 },
    { name: 'PS_5', cpu: '1/16', ram: 536870912, storage: null, rate: 5 },
    { name: 'NO_RATE', cpu: '4', ram: 2 ** 32, rate: null },
    { name: 'NO_WORD', cpu: '4', ram: 2 ** 32 },
  ];
  assert.deepEqual(sizeChoices(sizes), [
    { id: 'PS_FREE', label: 'PS-Free', price: 'Rate 0', detail: '' },
    { id: 'PS_5', label: 'PS_5', price: 'Rate 5', detail: '1/16 CPU, 512 MB of memory' },
    { id: 'PS_1G', label: 'PS-1G', price: 'Rate 39', detail: '2 CPU, 2 GB of memory, 3 GB of storage' },
  ]);
  assert.deepEqual(sizeChoices([]), []);
});
