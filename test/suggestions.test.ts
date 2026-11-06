// Warden's suggestions come from real state, most urgent first, each with a one-click fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { suggestions } from '../src/suggestions.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { id, run } from '../src/db.ts';

test('a fresh org is told to connect a server', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const s = suggestions(app, o.orgId);
  assert.equal(s[0]!.id, 'no-server');
  assert.equal(s[0]!.actions[0]!.kind, 'navigate');
});

test('no AI connected offers one button per installed agent', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const s = suggestions(app, o.orgId, { agents: [{ id: 'claude-code', name: 'Claude Code', installed: true, connected: false }, { id: 'cursor', name: 'Cursor', installed: false, connected: false }] });
  const noAgent = s.find((x) => x.id === 'no-agent')!;
  assert.deepEqual(noAgent.actions.map((a) => a.label), ['Claude Code']);
});

test('leaked public secrets, unprepared servers and unprotected databases are flagged, worst first', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { projectId, environments } = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] }));
  ok(await o.h('env.set', { projectId, key: 'NEXT_PUBLIC_STRIPE_SECRET', value: 'sk_live_51ABCDEFGHIJKLMNOPQRSTUV' }));
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'connected')`, srv, o.orgId);
  const db = id('svc');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) VALUES (?, ?, ?, ?, ?, 'pg', 'pg', 'postgres', '{}')`, db, o.orgId, projectId, environments[0].id, srv);
  const s = suggestions(app, o.orgId);
  assert.equal(s[0]!.severity, 'alert');
  assert.ok(s[0]!.id.startsWith('leak:'));
  const prep = s.find((x) => x.id === `prepare:${srv}`)!;
  assert.deepEqual(prep.actions[0], { label: 'Prepare it', kind: 'tool', tool: 'server.bootstrap', input: { serverId: srv }, success: 'box is ready' });
  assert.ok(s.some((x) => x.id === `backup:${db}`));
  // once backups are scheduled, that suggestion goes away
  ok(await o.h('backup.schedule', { serviceId: db, frequency: 'daily', keep: 7 }));
  assert.ok(!suggestions(app, o.orgId).some((x) => x.id === `backup:${db}`));
});

test('one-click agent connect is refused when Unit7 is not on this computer', async () => {
  resetRateLimits();
  const app = testApp();
  app.services.listen = { host: '0.0.0.0', port: 4800 }; // exposed, not local
  const http = createHttp(app);
  let cookie = '', bind = ''; // a browser session is the cookie plus the page's header
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await http.fetch(new Request(`http://localhost:4800${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', origin: 'http://localhost:4800', ...(cookie && { cookie, 'x-unit7-bind': bind }) } }));
    const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
    return { status: r.status, body: await r.json() as any };
  };
  await call('POST', '/api/auth/signup', { email: 'a@x.com', name: 'A', password: 'correct horse battery' });
  assert.equal((await call('GET', '/api/agents')).body.local, false);
  assert.equal((await call('POST', '/api/agents/cursor/connect', {})).status, 403);
  const sug = (await call('GET', '/api/suggestions')).body;
  assert.equal(sug.scope, 'Everything');
  assert.ok(Array.isArray(sug.items) && sug.items.length > 0);
  assert.equal((await call('GET', '/api/suggestions?projectId=prj_nothere12345')).status, 404);
});

// Project suggestions come from what Unit7 learned of the code, the server's load and the traffic,
// and one project's never show on another's page.
test('project suggestions: code, load and traffic, scoped to the project', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const db = app.db;
  const shop = ok(await o.h('project.create', { name: 'Shop' })).projectId as string;
  const blog = ok(await o.h('project.create', { name: 'Blog' })).projectId as string;
  const prodEnv = (p: string) => db.prepare(`SELECT id FROM environments WHERE project_id = ? AND kind = 'production'`).get(p) as { id: string };
  const srv = id('srv');
  run(db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts, provider_ref) VALUES (?, ?, 'box', '203.0.113.7', 'credential://ssh/box/private-key', 'ready', '{"cpus":4,"hardenedAt":"x"}', 'hostinger:vm:1')`, srv, o.orgId);
  const svc = (project: string, name: string, detection: object) => {
    const sid = id('svc'), dep = id('dep');
    run(db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status, current_deployment_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'app', ?, 'healthy', ?)`,
      sid, o.orgId, project, prodEnv(project).id, srv, name, name, JSON.stringify({ detection, port: 3000 }), dep);
    run(db, `INSERT INTO deployments (id, org_id, service_id, number, status, container, finished_at) VALUES (?, ?, ?, 2, 'live', ?, ?)`, dep, o.orgId, sid, `unit7-${name}-2`, new Date(Date.now() - 10 * 60_000).toISOString());
    run(db, `INSERT INTO deployments (id, org_id, service_id, number, status, container) VALUES (?, ?, ?, 1, 'stopped', ?)`, id('dep'), o.orgId, sid, `unit7-${name}-1`);
    run(db, `INSERT INTO domains (id, org_id, hostname, service_id, status, auto) VALUES (?, ?, ?, ?, 'active', 1)`, id('dom'), o.orgId, `${name}.203-0-113-7.sslip.io`, sid);
    return sid;
  };
  const web = svc(shop, 'web', { stack: 'vite', builder: 'railpack', port: 3000, needs: [], envKeys: ['STRIPE_SECRET_KEY'], healthPath: '/', healthRoute: false, scaleRisks: [], startCommand: 'vite --host', notes: [] });
  svc(blog, 'blog', { stack: 'node', builder: 'railpack', port: 3000, needs: [], envKeys: [], healthPath: '/', healthRoute: true, scaleRisks: ['the database is a SQLite file'], notes: [] });

  // 20 samples: web's only copy pinned at 95% while the 4-core host idles at 30%
  for (let k = 0; k < 20; k++) {
    run(db, 'INSERT INTO metrics (server_id, at, cpu, mem_used, mem_total, disk_used, disk_total, load1, containers) VALUES (?, ?, 30, 1, 10, 1, 10, 0.5, ?)', srv,
      new Date(Date.now() - k * 30_000).toISOString(), JSON.stringify([{ name: 'unit7-web-2', cpu: 95, memPct: 40, mem: '200MiB' }, { name: 'unit7-blog-2', cpu: 99, memPct: 20, mem: '90MiB' }]));
  }
  // a burst of 5xx on web since its deploy
  run(db, 'INSERT INTO traffic (server_id, hostname, at, requests, errors, p95_ms, static_hits, static_uncached) VALUES (?, ?, ?, 100, 40, 300, 0, 0)', srv, 'web.203-0-113-7.sslip.io', new Date().toISOString());

  const shopIds = suggestions(app, o.orgId, { projectId: shop }).map((s) => s.id.split(':')[0]);
  for (const want of ['5xx', 'devserver', 'envmissing', 'health', 'domain', 'scale']) assert.ok(shopIds.includes(want), `shop should get ${want}: ${shopIds}`);
  assert.ok(!suggestions(app, o.orgId, { projectId: shop }).some((s) => s.text.includes('blog')));
  const rollback = suggestions(app, o.orgId, { projectId: shop }).find((s) => s.id.startsWith('5xx'))!;
  assert.equal(rollback.actions[0]!.kind === 'tool' && rollback.actions[0]!.tool, 'deployment.rollback');

  // blog would break as two copies (SQLite), so it gets "prepare it", not a scale button
  const blogIds = suggestions(app, o.orgId, { projectId: blog }).map((s) => s.id.split(':')[0]);
  assert.ok(blogIds.includes('scale-blocked') && !blogIds.includes('scale'));
});

// "api in Staging needs 2 settings … Production has them": the suggestion names the environment, links to its
// Variables, and copies Production's values over (preview first, live-looking keys flagged, undo removes them).
test('missing settings name their environment and copy from Production', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const db = app.db;
  const shop = ok(await o.h('project.create', { name: 'Shop', environments: ['production', 'staging'] })).projectId as string;
  const env = (kind: string) => db.prepare(`SELECT id, name FROM environments WHERE project_id = ? AND kind = ?`).get(shop, kind) as { id: string; name: string };
  const prod = env('production'), staging = env('staging');
  const svc = (envId: string) => {
    const sid = id('svc'), dep = id('dep');
    run(db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, config, status, current_deployment_id) VALUES (?, ?, ?, ?, 'api', 'api', 'app', ?, 'healthy', ?)`,
      sid, o.orgId, shop, envId, JSON.stringify({ detection: { stack: 'node', builder: 'railpack', port: 3000, needs: [], envKeys: ['PAY_KEY_ID', 'PAY_KEY_SECRET', 'MAIL_KEY'], healthPath: '/', healthRoute: true, scaleRisks: [], notes: [] } }), dep);
    run(db, `INSERT INTO deployments (id, org_id, service_id, number, status) VALUES (?, ?, ?, 1, 'live')`, dep, o.orgId, sid);
    return sid;
  };
  const prodApi = svc(prod.id), stagingApi = svc(staging.id);
  ok(await o.h('env.set', { serviceId: prodApi, key: 'PAY_KEY_ID', value: 'rzp_live_AbCdEf123456' }));
  ok(await o.h('env.set', { serviceId: prodApi, key: 'PAY_KEY_SECRET', value: 'not-a-real-secret-value-123' }));

  const s = suggestions(app, o.orgId, { projectId: shop }).find((x) => x.id.startsWith(`envmissing:${stagingApi}`))!;
  assert.equal(s.text, `api in ${staging.name} needs 3 settings: PAY_KEY_ID, PAY_KEY_SECRET, MAIL_KEY. ${prod.name} has PAY_KEY_ID, PAY_KEY_SECRET.`);
  const [copy, open] = s.actions;
  assert.deepEqual(copy, { label: `Copy from ${prod.name}`, kind: 'tool', tool: 'env.copy', input: { fromServiceId: prodApi, environmentId: staging.id, keys: ['PAY_KEY_ID', 'PAY_KEY_SECRET'] }, success: `Copied to ${staging.name}`, preview: true });
  assert.deepEqual(open, { label: 'Set them', kind: 'navigate', href: `/projects/${shop}?env=${staging.id}&tab=variables` });
  // production's own suggestion has nothing to copy from
  const p = suggestions(app, o.orgId, { projectId: shop }).find((x) => x.id.startsWith(`envmissing:${prodApi}`))!;
  assert.equal(p.text, `api in ${prod.name} needs 1 setting: MAIL_KEY. Expect errors where it’s used.`);
  assert.deepEqual(p.actions.map((a) => a.label), ['Set it']);

  // the preview lists the keys, flags the live one, and shows no values
  const dry = await o.h('env.copy', (copy as any).input, { dryRun: true });
  assert.equal(dry.status, 'dry_run');
  const plan = (dry as any).plan;
  assert.deepEqual(plan.keys, [{ key: 'PAY_KEY_ID', secret: plan.keys[0].secret, live: true }, { key: 'PAY_KEY_SECRET', secret: true, live: false }]);
  assert.ok(!JSON.stringify(plan).includes('rzp_live_AbCdEf123456'));

  const done = ok(await o.h('env.copy', (copy as any).input));
  assert.deepEqual(done.copied, ['PAY_KEY_ID', 'PAY_KEY_SECRET']);
  assert.deepEqual(done.live, ['PAY_KEY_ID']);
  assert.ok(!JSON.stringify(done).includes('rzp_live_AbCdEf123456'));
  // the values arrived, sealed again for Staging
  const shown = ok(await o.h('env.reveal', { environmentId: staging.id, key: 'PAY_KEY_ID' }));
  assert.equal(shown.value, 'rzp_live_AbCdEf123456');
  assert.ok(!suggestions(app, o.orgId, { projectId: shop }).find((x) => x.id.startsWith(`envmissing:${stagingApi}`))!.text.includes('PAY_KEY'));
  // copying again finds nothing to do
  assert.equal((await o.h('env.copy', (copy as any).input)).status, 'error');
  // undo takes them away again
  ok(await o.h(done.undo.tool, done.undo.input));
  const left = ok(await o.h('env.list', { environmentId: staging.id })).variables.map((v: any) => v.key);
  assert.ok(!left.includes('PAY_KEY_ID') && !left.includes('PAY_KEY_SECRET'));
});

// a waiting approval that's hard to undo carries its tier and the name to type
test('hard-to-undo approvals ask for the name to be typed', async () => {
  resetRateLimits();
  const app = testApp();
  app.services.listen = { host: '127.0.0.1', port: 4800 };
  const http = createHttp(app);
  let cookie = '', bind = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await http.fetch(new Request(`http://localhost:4800${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', origin: 'http://localhost:4800', ...(cookie && { cookie, 'x-unit7-bind': bind }) } }));
    const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
    return { status: r.status, body: await r.json() as any };
  };
  await call('POST', '/api/auth/signup', { email: 'a@example.com', name: 'Sam', password: 'correct horse battery' });
  const orgId = (app.db.prepare('SELECT id FROM orgs').get() as { id: string }).id;
  const prj = id('prj'), env = id('env'), svc = id('svc');
  run(app.db, `INSERT INTO projects (id, org_id, name, slug) VALUES (?, ?, 'Shop', 'shop')`, prj, orgId);
  run(app.db, `INSERT INTO environments (id, org_id, project_id, name, slug, kind, autonomy) VALUES (?, ?, ?, 'Staging', 'staging', 'staging', 2)`, env, orgId, prj);
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, config) VALUES (?, ?, ?, ?, 'preview-web', 'preview-web', 'app', '{}')`, svc, orgId, prj, env);
  const later = new Date(Date.now() + 3600_000).toISOString();
  run(app.db, `INSERT INTO approvals (id, org_id, tool, input, why, actor, environment_id, expires_at) VALUES (?, ?, 'service.remove', ?, 'An AI asked.', '{}', ?, ?)`, id('apr'), orgId, JSON.stringify({ serviceId: svc }), env, later);
  run(app.db, `INSERT INTO approvals (id, org_id, tool, input, why, actor, environment_id, expires_at) VALUES (?, ?, 'service.restart', ?, 'An AI asked.', '{}', ?, ?)`, id('apr'), orgId, JSON.stringify({ serviceId: svc }), env, later);
  const list = (await call('GET', '/api/approvals')).body as any[];
  const remove = list.find((a) => a.tool === 'service.remove'), restart = list.find((a) => a.tool === 'service.restart');
  assert.equal(remove.tier, 3);
  assert.equal(remove.confirm, 'preview-web');
  assert.ok(restart.tier < 3 && !restart.confirm);
  // the server checks the typed name too, so approving any other way (the API, a phone button) can't skip it
  for (const body of [undefined, {}, { confirm: 'something-else' }]) {
    const r = await call('POST', `/api/approvals/${remove.id}/approve`, body);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /confirm_needed/);
  }
  assert.equal((app.db.prepare('SELECT status FROM approvals WHERE id = ?').get(remove.id) as { status: string }).status, 'pending', 'still waiting');
  const typed = await call('POST', `/api/approvals/${remove.id}/approve`, { confirm: ' Preview-Web ' });
  assert.doesNotMatch(JSON.stringify(typed.body), /confirm_needed/);
  assert.notEqual((app.db.prepare('SELECT status FROM approvals WHERE id = ?').get(remove.id) as { status: string }).status, 'pending');
});
