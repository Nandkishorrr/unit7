// Links: a CRM on your server wired to a website — both sides get matching settings, the private
// address is used when they share a server, and a re-sync only touches what changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';

const reveal = async (o: Awaited<ReturnType<typeof testOrg>>, serviceId: string, key: string) => ok(await o.h('env.reveal', { serviceId, key })).value as string;

test('an API on Unit7 linked to a website: both sides agree, private address on a shared server', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'Biz', environments: ['production'] })).environments[0].id;
  const crm = ok(await o.h('service.create', { environmentId: env, name: 'crm', source: { type: 'git', repo: 'ada/crm' }, port: 4000 })).serviceId;
  const web = ok(await o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'ada/web' } })).serviceId;
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/key')`, srv, o.orgId);
  run(app.db, 'UPDATE services SET server_id = ? WHERE id IN (?, ?)', srv, crm, web);

  const r = ok(await o.a('link.create', { from: { kind: 'unit7', serviceId: crm }, to: { kind: 'unit7', serviceId: web } }));
  assert.deepEqual(r.set.sort(), ['CRM_API_KEY', 'CRM_URL']);
  const w = { CRM_URL: await reveal(o, web, 'CRM_URL'), CRM_API_KEY: await reveal(o, web, 'CRM_API_KEY') };
  assert.match(w.CRM_URL!, /^http:\/\/unit7-crm-[a-z0-9-]{6}:4000$/);
  assert.ok(w.CRM_API_KEY!.length >= 24);
  assert.equal(await reveal(o, crm, 'WEB_API_KEY'), w.CRM_API_KEY, 'the CRM learns the key the website sends');

  // nothing changed → nothing written
  const again = ok(await o.a('link.sync', { linkId: r.linkId }));
  assert.deepEqual(again.set, []);

  // the website moves to another server → it now uses the CRM's public address
  run(app.db, 'UPDATE services SET server_id = NULL WHERE id = ?', web);
  assert.equal((await o.a('link.sync', { linkId: r.linkId })).status, 'error', 'no public address yet');
  assert.equal(ok(await o.a('link.list', {}))[0].status, 'broken');
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status) VALUES (?, ?, 'crm.example.com', ?, 'active')`, id('dom'), o.orgId, crm);
  const moved = ok(await o.a('link.sync', { linkId: r.linkId }));
  assert.deepEqual(moved.set, ['CRM_URL']);
  assert.equal(await reveal(o, web, 'CRM_URL'), 'https://crm.example.com');
  const list = ok(await o.a('link.list', {}));
  assert.equal(list[0].status, 'ok');
  assert.deepEqual(list[0].settings.sort(), ['CRM_API_KEY', 'CRM_URL']);
  assert.equal(JSON.stringify(list).includes(w.CRM_API_KEY!), false, 'the list never shows a value');
});

// --- across providers --------------------------------------------------------------------------------

import { createServer } from 'node:http';
import { supabaseVars, suggest, type Thing } from '../src/tools/links.ts';
import { neon, supabase } from '../src/connectors/clouds.ts';

test('Supabase settings use the names the code reads, else its framework’s convention', () => {
  const names = (r: Parameters<typeof supabaseVars>[0]) => supabaseVars(r, 'https://abc.supabase.co', 'anon-jwt', 'sb_publishable_x').map((v) => `${v.key}=${v.value}`).sort();
  assert.deepEqual(names({ stack: 'nextjs', keys: [] }), ['NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-jwt', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_x', 'NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co', 'SUPABASE_ANON_KEY=anon-jwt', 'SUPABASE_PUBLISHABLE_KEY=sb_publishable_x', 'SUPABASE_URL=https://abc.supabase.co']);
  assert.deepEqual(names({ stack: 'vite', keys: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'PORT'] }), ['VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_x', 'VITE_SUPABASE_URL=https://abc.supabase.co']);
  assert.deepEqual(names({ stack: 'express', keys: [] }), ['SUPABASE_ANON_KEY=anon-jwt', 'SUPABASE_PUBLISHABLE_KEY=sb_publishable_x', 'SUPABASE_URL=https://abc.supabase.co']);
  assert.ok(supabaseVars({ keys: [] }, 'u', 'a', 'p').every((v) => !v.secret), 'public keys are not treated as secrets');
});

test('what belongs together: one obvious match is connected by itself; a real choice is left to you', () => {
  const app = (name: string, provider: string, uses: Partial<Thing['uses']> = {}): Thing => ({ end: provider === 'unit7' ? { kind: 'unit7', serviceId: `svc_${name}` } : { kind: 'vercel', accountId: 'acc_v', project: name }, name, provider, role: 'app', uses: { reads: [], has: [], supabase: false, postgres: false, ...uses } });
  const db = (name: string, provider = 'supabase'): Thing => ({ end: provider === 'supabase' ? { kind: 'supabase', accountId: 'acc_s', ref: name } : { kind: 'neon', accountId: 'acc_n', project: name }, name, provider, role: 'database' });

  const web = app('shop-web', 'vercel', { supabase: true });
  let s = suggest([web, db('shop')], []);
  assert.equal(s.length, 1); assert.equal(s[0]!.sure, true);
  s = suggest([web, db('blog'), db('shop-prod')], []);
  assert.deepEqual(s.map((x) => [x.fromName, x.sure]), [['shop-prod', true]], 'the name decides');
  s = suggest([web, db('alpha'), db('beta')], []);
  assert.deepEqual(s.map((x) => x.sure), [false, false], 'two unrelated projects: your call');
  assert.equal(suggest([app('x', 'vercel', { supabase: true, has: ['NEXT_PUBLIC_SUPABASE_URL'] }), db('x')], []).length, 0, 'already set up');
  assert.equal(suggest([web, db('shop')], [{ source: JSON.stringify(db('shop').end), target: JSON.stringify(web.end) }]).length, 0, 'already linked');
  // a Vercel site that uses Postgres and Neon has one project
  assert.equal(suggest([app('site', 'vercel', { postgres: true }), db('site-db', 'neon')], [])[0]!.sure, true);
  // code that asks for CRM_URL gets the CRM
  const crm = app('crm', 'unit7');
  s = suggest([crm, app('site', 'vercel', { has: ['CRM_URL'] })], []);
  assert.deepEqual(s.map((x) => `${x.fromName}→${x.toName}`), ['crm→site']);
});

// a small stand-in for api.vercel.com, shaped like its OpenAPI spec
function fakeVercel() {
  const envs: { key: string; value: string; type: string; target: string[] }[] = [];
  const deploys: any[] = [];
  const project = { id: 'prj_web', name: 'shop-web', framework: 'nextjs', link: { type: 'github', org: 'ada', repo: 'shop-web' }, targets: { production: { id: 'dpl_1', alias: ['shop-web.vercel.app'] } } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    let body = ''; for await (const c of req) body += c;
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (!url.pathname.startsWith('/repos/') && req.headers.authorization !== 'Bearer vercel-test-token-123') return send(403, { error: { message: 'Not authorized' } });
    const p = url.pathname;
    if (p === '/repos/ada/shop-web/contents/package.json') return send(200, { content: Buffer.from(JSON.stringify({ dependencies: { next: '15', '@supabase/supabase-js': '^2', pg: '8' } })).toString('base64') });
    if (p === '/v2/user') return send(200, { user: { username: 'ada' } });
    if (p === '/v2/teams') return send(200, { teams: [] });
    if (p === '/v10/projects' && req.method === 'GET') return send(200, { projects: [project] });
    if (p === '/v9/projects/prj_web') return send(200, project);
    if (p === '/v9/projects/prj_web/domains') return send(200, { domains: [{ name: 'shop-web.vercel.app', verified: true }] });
    if (p === '/v5/domains') return send(200, { domains: [] });
    if (p === '/v10/projects/prj_web/env' && req.method === 'GET') return send(200, { envs: envs.map((e) => ({ ...e, value: e.type === 'plain' ? e.value : undefined })) });
    if (p === '/v10/projects/prj_web/env' && req.method === 'POST') {
      assert.equal(url.searchParams.get('upsert'), 'true');
      for (const v of JSON.parse(body)) { const i = envs.findIndex((e) => e.key === v.key); if (i >= 0) envs.splice(i, 1); envs.push(v); }
      return send(201, { created: [] });
    }
    if (p === '/v13/deployments') { deploys.push(JSON.parse(body)); return send(200, { id: 'dpl_2', url: 'shop-web-2.vercel.app' }); }
    if (p === '/v10/projects/prj_web/domains') return send(200, { name: JSON.parse(body).name });
    if (p === '/v9/projects/prj_web/domains/www.shop.test') return send(200, { name: 'www.shop.test', apexName: 'shop.test', verified: false, verification: [{ type: 'TXT', domain: '_vercel.shop.test', value: 'vc-domain-verify=www.shop.test,abc', reason: 'pending' }] });
    if (p === '/v6/domains/www.shop.test/config') return send(200, { misconfigured: true, recommendedCNAME: [{ rank: 2, value: 'cname.vercel-dns.com.' }, { rank: 1, value: 'abc123.vercel-dns-017.com.' }], recommendedIPv4: [{ rank: 1, value: ['76.76.21.21'] }] });
    send(404, { error: { message: `no ${req.method} ${p}` } });
  });
  return new Promise<{ envs: typeof envs; deploys: typeof deploys; close: () => void }>((resolve) => server.listen(0, '127.0.0.1', () => {
    process.env.UNIT7_VERCEL_API = process.env.UNIT7_GITHUB_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    resolve({ envs, deploys, close: () => { server.close(); delete process.env.UNIT7_VERCEL_API; delete process.env.UNIT7_GITHUB_API; } });
  }));
}

test('your CRM here → your site on Vercel, and Supabase → that site: settings set on Vercel, then a rebuild', async () => {
  const v = await fakeVercel();
  try {
    const app = testApp();
    const o = await testOrg(app);
    const acc = ok(await o.h('account.connect', { provider: 'vercel', token: 'vercel-test-token-123' }));
    assert.equal(acc.status, 'verified');
    const env = ok(await o.h('project.create', { name: 'Biz', environments: ['production'] })).environments[0].id;
    const crm = ok(await o.h('service.create', { environmentId: env, name: 'crm', source: { type: 'git', repo: 'ada/crm' } })).serviceId;
    run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status) VALUES (?, ?, 'crm.shop.test', ?, 'active')`, id('dom'), o.orgId, crm);
    const site = { kind: 'vercel', accountId: acc.accountId, project: 'prj_web' };

    const r = ok(await o.a('link.create', { from: { kind: 'unit7', serviceId: crm }, to: site }));
    assert.equal(r.to, 'shop-web');
    const byKey = Object.fromEntries(v.envs.map((e) => [e.key, e]));
    assert.equal(byKey.CRM_URL!.value, 'https://crm.shop.test');
    assert.equal(byKey.CRM_URL!.type, 'plain');
    assert.equal(byKey.CRM_API_KEY!.type, 'encrypted');
    assert.deepEqual(byKey.CRM_API_KEY!.target, ['production', 'preview', 'development']);
    assert.equal(await reveal(o, crm, 'SHOP_WEB_API_KEY'), byKey.CRM_API_KEY!.value, 'the CRM accepts the site’s key');
    assert.deepEqual(v.deploys, [{ name: 'shop-web', project: 'prj_web', deploymentId: 'dpl_1', target: 'production' }], 'rebuilt what was live');

    // Supabase (its MCP calls stubbed): a Next.js site gets the NEXT_PUBLIC_ pair too
    Object.assign(supabase, { url: async () => 'https://abc.supabase.co', publicKey: async () => ({ anon: 'eyJanon', publishable: 'sb_publishable_x' }), projects: async () => [{ id: 'abcdefghijklmnop', name: 'shop' }] });
    const s = ok(await o.a('link.create', { from: { kind: 'supabase', accountId: acc.accountId, ref: 'abcdefghijklmnop' }, to: site }));
    assert.deepEqual(s.set.sort(), ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL']);
    assert.equal(v.deploys.length, 2);
  } finally { v.close(); }
});

test('an AI can wire public keys, but a database login or service key waits for a person', async () => {
  const { getTool } = await import('../src/tools/runtime.ts');
  const link = getTool('link.create')!, ai = { actor: { kind: 'agent', id: 'mcp', role: 'agent' } }, person = { actor: { kind: 'user', id: 'usr', role: 'owner' } };
  const neonLink = { from: { kind: 'neon', accountId: 'acc', project: 'p' }, to: { kind: 'unit7', serviceId: 'svc' }, apply: true };
  assert.ok(link.assess!(ai as never, neonLink as never)!.ask, 'a Neon login asks a person');
  assert.equal(link.assess!(ai as never, { ...neonLink, apply: false } as never), undefined, 'a look costs nothing');
  assert.equal(link.assess!(person as never, neonLink as never), undefined);
  assert.equal(link.assess!(ai as never, { ...neonLink, from: { kind: 'supabase', accountId: 'acc', ref: 'r' } } as never), undefined, 'public keys go through');

  const v = await fakeVercel();
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = ok(await o.h('account.connect', { provider: 'supabase', token: 'sbp_test_token_0000' }));
    const env = ok(await o.h('project.create', { name: 'Biz', environments: ['production'] })).environments[0].id;
    const api = ok(await o.h('service.create', { environmentId: env, name: 'api', source: { type: 'git', repo: 'ada/api' }, port: 4000 })).serviceId;
    run(app.db, `UPDATE services SET config = json_set(config, '$.detection', json('{"stack":"express","envKeys":["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY"]}')) WHERE id = ?`, api);
    ok(await o.h('account.bind', { accountId: acc.accountId, environmentId: env }));
    let asked = 0;
    Object.assign(supabase, { url: async () => 'https://abc.supabase.co', publicKey: async () => ({ anon: 'eyJanon', publishable: 'sb_publishable_x' }), projects: async () => [{ id: 'abcdefghijklmnop', name: 'shop' }], secretKeys: async () => { asked++; return { serviceRole: 'eyJservice', secret: 'sb_secret_x' }; } });
    const end = { from: { kind: 'supabase', accountId: acc.accountId, ref: 'abcdefghijklmnop' }, to: { kind: 'unit7', serviceId: api } };
    const r = await o.a('link.create', end);
    const out = ok(r) as { set: string[]; note?: string };
    assert.equal(asked, 0, 'an AI never makes Unit7 fetch the service key');
    assert.ok(!out.set.includes('SUPABASE_SERVICE_ROLE_KEY'));
    assert.match(out.note ?? '', /SUPABASE_SERVICE_ROLE_KEY.*person/);
    const p = ok(await o.h('link.create', end));
    assert.equal(asked, 1, 'a person connecting them does');
    assert.ok(p.set.includes('SUPABASE_SERVICE_ROLE_KEY'));
  } finally { v.close(); }
});

test('nobody asks, but a Neon login stays a person’s to connect', async () => {
  const v = await fakeVercel();
  const api = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url!.startsWith('/projects?') ? { projects: [{ id: 'proud-sun-123', name: 'shop' }] } : {})); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  const before = process.env.UNIT7_NEON_API;
  process.env.UNIT7_NEON_API = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  try {
    const app = testApp(), o = await testOrg(app);
    ok(await o.h('account.connect', { provider: 'vercel', token: 'vercel-test-token-123' }));
    Object.assign(neon, { connectionString: async () => 'postgres://u:p@ep.example/db' });
    ok(await o.h('account.connect', { provider: 'neon', token: 'neon_test_token_0000' }));
    ok(await o.a('sync.run', {}));
    const auto = ok(await o.a('link.autoconnect', {}));
    assert.deepEqual(auto.created, []);
    assert.match(auto.skipped.join(), /database login/);
    assert.equal(get<{ n: number }>(app.db, 'SELECT COUNT(*) n FROM approvals WHERE org_id = ?', o.orgId)!.n, 0, 'an automatic run leaves nothing to answer');
    assert.equal(v.envs.length, 0);
    assert.deepEqual(ok(await o.h('link.autoconnect', {})).created, ['shop → shop-web'], 'a person pressing it does connect them');
    assert.ok(v.envs.some((e) => e.key === 'DATABASE_URL'));
  } finally { v.close(); api.close(); if (before === undefined) delete process.env.UNIT7_NEON_API; else process.env.UNIT7_NEON_API = before; }
});

test('a domain pointed at a Vercel project: Vercel’s own records, plus its ownership check', async () => {
  const v = await fakeVercel();
  try {
    const app = testApp();
    const o = await testOrg(app);
    const acc = ok(await o.h('account.connect', { provider: 'vercel', token: 'vercel-test-token-123' }));
    const r = ok(await o.h('domain.point', { hostname: 'www.shop.test', vercel: { accountId: acc.accountId, project: 'prj_web' } }));
    // .test isn't in public DNS, so Unit7 says exactly what to add and keeps watching
    assert.equal(r.dns, 'needs you');
    assert.deepEqual(r.addThese.map((x: any) => `${x.type} ${x.value}`), ['CNAME abc123.vercel-dns-017.com', 'TXT vc-domain-verify=www.shop.test,abc']);
    const row = get<{ status: string; target: string }>(app.db, 'SELECT status, target FROM domains WHERE hostname = ?', 'www.shop.test')!;
    assert.equal(row.status, 'waiting_dns');
    assert.equal(JSON.parse(row.target).kind, 'vercel');
  } finally { v.close(); }
});

test('nobody asks: a Vercel site using supabase-js gets your one Supabase project wired in', async () => {
  const v = await fakeVercel();
  try {
    const app = testApp();
    const o = await testOrg(app);
    ok(await o.h('account.connect', { provider: 'vercel', token: 'vercel-test-token-123' }));
    ok(await o.h('account.connect', { provider: 'supabase', token: 'sbp_test_token_0000' })); // its MCP calls are stubbed below
    Object.assign(supabase, { url: async () => 'https://abcdefghijklmnopqrst.supabase.co', publicKey: async () => ({ anon: 'eyJanon', publishable: 'sb_publishable_x' }), projects: async () => [{ id: 'abcdefghijklmnopqrst', name: 'shop' }] });

    const map = ok(await o.a('sync.run', {}));
    assert.deepEqual(map.counts, { apps: 1, databases: 1, servers: 0, domains: 0, connections: 0 });
    assert.equal(map.accounts.every((a: any) => a.ok), true);
    const opts = ok(await o.a('link.options', {}));
    assert.deepEqual(opts.things.map((t: any) => `${t.provider}:${t.name}`).sort(), ['supabase:shop', 'vercel:shop-web']);
    assert.equal(opts.suggestions[0].why, 'shop-web uses Supabase but has no project URL set');

    const r = ok(await o.a('link.autoconnect', {}));
    assert.deepEqual(r.created, ['shop → shop-web']);
    assert.ok(v.envs.some((e) => e.key === 'NEXT_PUBLIC_SUPABASE_URL' && e.value === 'https://abcdefghijklmnopqrst.supabase.co'));
    assert.deepEqual(ok(await o.a('link.autoconnect', {})).created, [], 'nothing twice');
    // the next sync sees the site now points at the Supabase project
    ok(await o.a('sync.run', {}));
    const m = ok(await o.a('map.get', {}));
    const site = m.assets.find((a: any) => a.name === 'shop-web'), db = m.assets.find((a: any) => a.name === 'shop');
    assert.ok(m.edges.some((e: any) => e.source === site.id && e.target === db.id && e.kind === 'env'), 'site → Supabase, found from its settings');
    assert.equal(site.account, 'Vercel · ada', 'accounts are named after whose they are');
    assert.equal(JSON.stringify(m).includes('eyJanon'), false, 'no setting values on the map');
  } finally { v.close(); }
});

test('the map knows an app uses a Unit7 database when a setting references its address, even if the value can’t be read', async () => {
  const { scanUnit7 } = await import('../src/discovery/scanners.ts');
  const { mergeFound, resolve } = await import('../src/discovery/model.ts');
  const app = testApp();
  const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id;
  const api = ok(await o.h('service.create', { environmentId: env, name: 'api', source: { type: 'git', repo: 'sam/api' } })).serviceId;
  const db = id('svc');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, config) SELECT ?, org_id, project_id, id, 'db', 'db', 'postgres', ? FROM environments WHERE id = ?`,
    db, JSON.stringify({ passwordRef: 'credential://postgres/db/password' }), env);
  // a reference whose secret isn't in the vault: its value can't be resolved, so only the wiring says where it goes
  run(app.db, `INSERT INTO env_vars (id, org_id, scope_type, scope_id, key, version, secret, ref, hint) VALUES (?, ?, 'service', ?, 'DATABASE_URL', 1, 1, 'credential://postgres/db/url', 'credential://postgres/db/url')`, id('var'), o.orgId, api);
  const ctx = { app, db: app.db, orgId: o.orgId, secret: (r: string) => app.vault.resolve(o.orgId, r) } as never;
  const scan = await scanUnit7(ctx);
  const { edges } = resolve(mergeFound(scan.found), scan.refs);
  assert.deepEqual(edges.filter((e) => e.kind === 'env').map((e) => [e.from, e.to, e.via]), [[`unit7:${api}`, `unit7:${db}`, 'DATABASE_URL']]);
});
