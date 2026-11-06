// Netlify, Render and Railway as places apps live: settings set the safe way, one redeploy, domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';

const reveal = async (o: Awaited<ReturnType<typeof testOrg>>, serviceId: string, key: string) => ok(await o.h('env.reveal', { serviceId, key })).value as string;

function fakeApis() {
  const calls: { method: string; url: string; body?: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init.method ?? 'GET', url, body });
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (url.startsWith('https://api.render.com/v1/services/srv-web/env-vars') && (init.method ?? 'GET') === 'GET') return json([]);
    if (url === 'https://api.render.com/v1/services/srv-web') return json({ id: 'srv-web', name: 'shop-api-client', type: 'web_service', serviceDetails: { url: 'https://shop-web.onrender.com' } });
    if (url.startsWith('https://backboard.railway.com')) {
      const q: string = body.query;
      if (q.includes('service(id')) return json({ data: { service: { name: body.variables.s === 'svc-db' ? 'Postgres' : 'api' } } });
      if (q.includes('variables(')) return json({ data: { variables: body.variables.s === 'svc-db' ? { DATABASE_URL: 'postgresql://postgres:secretpw@postgres.railway.internal:5432/railway', DATABASE_PUBLIC_URL: 'postgresql://postgres:secretpw@shortline.proxy.rlwy.net:41234/railway' } : {} } });
      return json({ data: { ok: true } });
    }
    if (url === 'https://api.netlify.com/api/v1/sites/site-1') return json({ id: 'site-1', name: 'shop-blog', account_id: 'acct-1', custom_domain: null, domain_aliases: [] });
    return json({});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('your CRM → a Render service; a Railway database → a Railway app; a domain on Netlify', async (t) => {
  if (!(await lookup('api.render.com').then(() => true, () => false))) return t.skip('offline');
  const f = fakeApis();
  try {
    const app = testApp();
    const o = await testOrg(app);
    const renderAcc = ok(await o.h('account.connect', { provider: 'render', token: 'rnd_testtoken123' })).accountId;
    const railwayAcc = ok(await o.h('account.connect', { provider: 'railway', token: 'railway-test-token-123' })).accountId;
    const netlifyAcc = ok(await o.h('account.connect', { provider: 'netlify', token: 'nfp_testtoken12345' })).accountId;
    const env = ok(await o.h('project.create', { name: 'Biz', environments: ['production'] })).environments[0].id;
    const crm = ok(await o.h('service.create', { environmentId: env, name: 'crm', source: { type: 'git', repo: 'ada/crm' } })).serviceId;
    run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status) VALUES (?, ?, 'crm.shop.test', ?, 'active')`, id('dom'), o.orgId, crm);

    // Render: one key at a time (never the replace-everything call), then one deploy
    ok(await o.a('link.create', { from: { kind: 'unit7', serviceId: crm }, to: { kind: 'render', accountId: renderAcc, service: 'srv-web' } }));
    const puts = f.calls.filter((c) => c.method === 'PUT' && c.url.includes('render.com'));
    assert.deepEqual(puts.map((c) => c.url.split('/').pop()).sort(), ['CRM_API_KEY', 'CRM_URL']);
    assert.equal(puts.find((c) => c.url.endsWith('CRM_URL'))!.body.value, 'https://crm.shop.test');
    assert.ok(!f.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/env-vars')), 'never replaces all of them');
    assert.ok(f.calls.some((c) => c.method === 'POST' && c.url === 'https://api.render.com/v1/services/srv-web/deploys'));

    // Railway: inside the same project, Railway's own reference (no password copied), one redeploy
    f.calls.length = 0;
    const r = ok(await o.h('link.create', { from: { kind: 'railway', accountId: railwayAcc, project: 'p1', environment: 'e1', service: 'svc-db' }, to: { kind: 'railway', accountId: railwayAcc, project: 'p1', environment: 'e1', service: 'svc-api' } }));
    assert.deepEqual(r.set, ['DATABASE_URL']);
    const upsert = f.calls.find((c) => c.body?.query?.includes('variableCollectionUpsert'))!;
    assert.deepEqual(upsert.body.variables.i, { projectId: 'p1', environmentId: 'e1', serviceId: 'svc-api', variables: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' }, skipDeploys: true });
    assert.equal(f.calls.filter((c) => c.body?.query?.includes('serviceInstanceRedeploy')).length, 1);

    // Netlify: the domain becomes the site's custom domain; a subdomain gets a CNAME to <site>.netlify.app
    f.calls.length = 0;
    const d = ok(await o.h('domain.point', { hostname: 'blog.example.com', netlify: { accountId: netlifyAcc, site: 'site-1' } }));
    assert.deepEqual(f.calls.find((c) => c.method === 'PATCH')!.body, { custom_domain: 'blog.example.com' });
    assert.deepEqual(d.addThese, [{ type: 'CNAME', name: 'blog', value: 'shop-blog.netlify.app' }]);
  } finally { f.restore(); }
});

test('a Railway project token sees only its environment; Supabase with a personal token; Heroku settings and domains', async (t) => {
  if (!(await lookup('api.heroku.com').then(() => true, () => false))) return t.skip('offline');
  const calls: { method: string; url: string; headers: Record<string, string>; body?: any }[] = [];
  const real = globalThis.fetch;
  const SB = 'abcdefghijklmnopqrst';
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>, body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init.method ?? 'GET', url, headers, body });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (url.startsWith('https://backboard.railway.com')) {
      const q: string = body.query, proj = headers['project-access-token'] === 'railway-project-token-1';
      if (/me \{|projects\(first: 1\)/.test(q) && !headers.authorization?.includes('railway-account')) return json({ errors: [{ message: 'Not Authorized' }] });
      if (q.includes('projectToken') && proj) return json({ data: { projectToken: { projectId: 'p1', environmentId: 'e-prod' } } });
      if (q.includes('project(id') && proj) return json({ data: { project: { id: 'p1', name: 'crm', environments: { edges: ['e-prod', 'e-staging'].map((id) => ({ node: { id, name: id.slice(2), serviceInstances: { edges: [{ node: { serviceId: `s-${id}`, serviceName: 'api', source: { image: null }, latestDeployment: { status: 'SUCCESS' }, domains: { serviceDomains: [{ domain: `api-${id}.up.railway.app` }], customDomains: [] } } }] } } })) } } } });
      return json({ errors: [{ message: 'Not Authorized' }] });
    }
    if (url === 'https://api.supabase.com/v1/projects') return json([{ ref: SB, name: 'shop', status: 'ACTIVE_HEALTHY' }]);
    if (url === `https://api.supabase.com/v1/projects/${SB}/api-keys`) return json([{ name: 'anon', type: 'legacy', api_key: 'eyJanon' }, { name: 'service_role', type: 'legacy', api_key: 'eyJsecret' }, { name: 'default', type: 'publishable', api_key: 'sb_publishable_x' }]);
    if (url.endsWith('/custom-hostname/initialize')) return json({ status: '2_initiated', data: { result: { ssl: { validation_records: [{ txt_name: '_acme-challenge.api.example.com', txt_value: 'acme-123' }] }, ownership_verification: { type: 'txt', name: '_cf-custom-hostname.api.example.com', value: 'own-456' } } } });
    if (url === 'https://api.heroku.com/apps/hk-1') return json({ id: 'hk-1', name: 'old-api', web_url: 'https://old-api-1234.herokuapp.com/' });
    if (url === 'https://api.heroku.com/apps/hk-1/config-vars') return json(init.method === 'PATCH' ? body : {});
    if (url === 'https://api.heroku.com/apps/hk-1/domains' && (init.method ?? 'GET') === 'GET') return json([]);
    if (url === 'https://api.heroku.com/apps/hk-1/domains') return json({ hostname: body.hostname, cname: 'shiny-1234.herokudns.com' }, 201);
    return json({});
  }) as typeof fetch;
  try {
    const app = testApp();
    const o = await testOrg(app);
    const { railway } = await import('../src/connectors/hosts.ts');
    const { supabase } = await import('../src/connectors/clouds.ts');
    const rw = ok(await o.h('account.connect', { provider: 'railway', token: 'railway-project-token-1' })).accountId;
    const sb = ok(await o.h('account.connect', { provider: 'supabase', token: 'sbp_personal_token_1' })).accountId;
    const hk = ok(await o.h('account.connect', { provider: 'heroku', token: 'heroku-token-12345' })).accountId;

    // run the connector calls inside a tool so they get a real context (credentials through the broker)
    const { defineTool } = await import('../src/tools/runtime.ts');
    const { z } = await import('zod');
    defineTool({ name: 'test.hosts2', title: 't', risk: 'read', action: 'read', description: 't', input: z.object({}), run: async (ctx) => ({
      railway: await railway.instances(ctx, rw), sbProjects: await supabase.projects(ctx, sb), sbKey: await supabase.publicKey(ctx, sb, SB), sbDomain: await supabase.addDomain(ctx, sb, SB, 'api.example.com'),
    }) });
    const r = ok(await o.h('test.hosts2', {}));
    assert.deepEqual(r.railway.map((i: any) => i.environment), ['e-prod'], 'a project token sees only its environment');
    assert.ok(calls.some((c) => c.headers['project-access-token'] === 'railway-project-token-1'), 'sent in Railway’s project-token header');
    assert.equal(JSON.parse(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', rw)!.meta).railway, 'project', 'remembered');
    assert.deepEqual(r.sbProjects, [{ id: SB, name: 'shop', region: undefined, status: 'ACTIVE_HEALTHY' }]);
    assert.equal(r.sbKey.anon, 'eyJanon');
    assert.deepEqual(r.sbDomain, [{ type: 'CNAME', name: 'api.example.com', content: `${SB}.supabase.co` }, { type: 'TXT', name: '_acme-challenge.api.example.com', content: 'acme-123' }, { type: 'TXT', name: '_cf-custom-hostname.api.example.com', content: 'own-456' }]);

    // Heroku: a connection sets settings (Heroku restarts the app itself); a domain gets Heroku's CNAME
    const env = ok(await o.h('project.create', { name: 'Biz', environments: ['production'] })).environments[0].id;
    const crm = ok(await o.h('service.create', { environmentId: env, name: 'crm', source: { type: 'git', repo: 'ada/crm' } })).serviceId;
    run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status) VALUES (?, ?, 'crm.shop.test', ?, 'active')`, id('dom'), o.orgId, crm);
    const l = ok(await o.a('link.create', { from: { kind: 'unit7', serviceId: crm }, to: { kind: 'heroku', accountId: hk, app: 'hk-1' } }));
    assert.ok(l.applied.includes('Heroku restarts the app with the new settings by itself.'));
    assert.deepEqual(Object.keys(calls.find((c) => c.method === 'PATCH')!.body).sort(), ['CRM_API_KEY', 'CRM_URL']);
    const d = ok(await o.h('domain.point', { hostname: 'shop.example.com', heroku: { accountId: hk, app: 'hk-1' } }));
    assert.deepEqual(d.addThese, [{ type: 'CNAME', name: 'shop', value: 'shiny-1234.herokudns.com' }]);
  } finally { globalThis.fetch = real; }
});

test('Fly.io: secrets then a roll onto the new version; a quiet re-sync restarts nothing; domains; Postgres on the map', async (t) => {
  if (!(await lookup('api.fly.io').then(() => true, () => false))) return t.skip('offline');
  const calls: { method: string; url: string; auth?: string; body?: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init.method ?? 'GET', url, auth: (init.headers as Record<string, string>)?.authorization, body });
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (url === 'https://api.fly.io/graphql') return json({ data: { apps: { pageInfo: { hasNextPage: false }, nodes: [
      { id: 'a1', name: 'shop-api', hostname: 'shop-api.fly.dev', organization: { slug: 'personal' }, role: null, sharedIpAddress: '66.241.124.10', ipAddresses: { nodes: [{ address: '2a09:8280:1::1', type: 'v6' }] }, certificates: { nodes: [{ hostname: 'api.shop.test' }] }, secrets: [{ name: 'DATABASE_URL' }] },
      { id: 'a2', name: 'shop-db', hostname: 'shop-db.fly.dev', organization: { slug: 'personal' }, role: { name: 'postgres_cluster' }, sharedIpAddress: null, ipAddresses: { nodes: [] }, certificates: { nodes: [] }, secrets: [] }] } } });
    if (url.endsWith('/apps/shop-api/secrets')) return json({ secrets: [], version: 7 });
    if (url.endsWith('/apps/shop-api/machines') && (init.method ?? 'GET') === 'GET') return json([{ id: 'm1', config: { image: 'registry.fly.io/shop-api:1' } }]);
    if (url.endsWith('/apps/shop-api/certificates/acme')) return json({ dns_requirements: { a: ['66.241.124.10'], cname: 'xyz.shop-api.fly.dev', ownership: { name: '_fly-ownership.www.example.com', app_value: 'app-123' } } });
    return json({});
  }) as typeof fetch;
  try {
    const app = testApp();
    const o = await testOrg(app);
    const acc = ok(await o.h('account.connect', { provider: 'fly', token: 'FlyV1 fm2_abc,fm2_def' })).accountId;
    const env = ok(await o.h('project.create', { name: 'Biz', environments: ['production'] })).environments[0].id;
    const site = ok(await o.h('service.create', { environmentId: env, name: 'site', source: { type: 'git', repo: 'ada/site' } })).serviceId;

    // shop-api on Fly is the API; the site here is its client. The API side learns SITE_API_KEY as a Fly secret.
    const l = ok(await o.a('link.create', { from: { kind: 'fly', accountId: acc, app: 'shop-api' }, to: { kind: 'unit7', serviceId: site } }));
    assert.equal(await reveal(o, site, 'SHOP_API_URL'), 'https://api.shop.test');
    const set = calls.find((c) => c.url.endsWith('/apps/shop-api/secrets'))!;
    assert.deepEqual(Object.keys(set.body.values), ['SITE_API_KEY']);
    assert.equal(set.auth, 'FlyV1 fm2_abc,fm2_def', 'macaroon tokens go as FlyV1');
    assert.deepEqual(calls.find((c) => c.url.endsWith('/machines/m1'))!.body, { config: { image: 'registry.fly.io/shop-api:1' }, min_secrets_version: 7 }, 'each machine rolls onto the new secrets');

    // Fly never shows a secret back: a re-sync with nothing changed must not set it (or restart) again
    calls.length = 0;
    const again = ok(await o.a('link.sync', { linkId: l.linkId }));
    assert.deepEqual(again.set, []);
    assert.ok(!calls.some((c) => c.url.endsWith('/secrets') || c.url.includes('/machines/')), 'nothing set, nothing restarted');

    // domains: a subdomain gets Fly's CNAME, plus the ownership TXT
    const d = ok(await o.h('domain.point', { hostname: 'www.example.com', fly: { accountId: acc, app: 'shop-api' } }));
    assert.deepEqual(d.addThese, [{ type: 'CNAME', name: 'www', value: 'xyz.shop-api.fly.dev' }, { type: 'TXT', name: '_fly-ownership.www', value: 'app-123' }]);

    // the map: an app with its domain, and the Postgres cluster as a database
    const m = ok(await o.a('sync.run', {}));
    assert.equal(m.accounts.find((a: any) => a.provider === 'fly').ok, true);
    const map = ok(await o.a('map.get', { provider: 'fly' }));
    assert.deepEqual(map.assets.map((a: any) => `${a.kind}:${a.name}`).sort(), ['app:shop-api', 'database:shop-db']);
  } finally { globalThis.fetch = real; }
});
