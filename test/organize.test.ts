// Group what belongs together, and client spaces. Grouping ranks its evidence (wiring > DNS > repo > name) and keeps
// products across re-scans; Warden groups by itself only at Full autopilot, with an undo. A thing belongs to one client
// at most; a client's cost includes its share of each server; its status page shows nothing internal, and its link can be
// changed and turned off. Servers are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { assetIdOf } from '../src/archive.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { saveXray } from '../src/tools/xray.ts';
import { detect, stemOf, normRepo, autoGroup, autoReady, groupSuggestions, type Thing, type Link } from '../src/organize/groups.ts';
import { statusData, renderStatusHtml, uptime, refreshStatusPages, tokenRef } from '../src/organize/status.ts';
import { suggestions } from '../src/suggestions.ts';

type Org = Awaited<ReturnType<typeof testOrg>>;
function asset(app: App, o: Org, f: { provider: string; kind: string; extId: string; name: string; meta?: object }) {
  const aid = assetIdOf(o.orgId, `${f.provider}:${f.extId}`);
  run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    aid, o.orgId, f.provider, f.kind, f.extId, f.name, JSON.stringify(f.meta ?? {}), new Date().toISOString());
  return aid;
}
const edge = (app: App, o: Org, source: string, target: string, kind: string, via: string) =>
  run(app.db, `INSERT INTO edges (id, org_id, source, target, kind, via, status) VALUES (?, ?, ?, ?, ?, ?, 'ok')`, id('edg'), o.orgId, source, target, kind, via);

// harbor: a Vercel site wired to its Supabase database, its domain pointing at the site, and a Coolify project with the
// same name on a server. Next to it, an agency's own domain with two unrelated sites on subdomains.
async function harbor() {
  const app = testApp();
  const o = await testOrg(app, 'Sam');
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box-prod-1', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', '{}')`, srv, o.orgId);
  const server = asset(app, o, { provider: 'unit7', kind: 'server', extId: srv, name: 'box-prod-1', meta: { ips: ['203.0.113.9'] } });
  const web = asset(app, o, { provider: 'vercel', kind: 'app', extId: 'prj_v1', name: 'harbor-web', meta: { hosts: ['harbor.example'], envKeys: ['DATABASE_URL'], repo: 'sam/harbor', end: { kind: 'vercel', project: 'prj_v1' } } });
  const db = asset(app, o, { provider: 'supabase', kind: 'database', extId: 'abcdefghijklmnopqrst', name: 'Harbor DB', meta: { hosts: ['abcdefghijklmnopqrst.supabase.co'] } });
  const dom = asset(app, o, { provider: 'domain', kind: 'domain', extId: 'harbor.example', name: 'harbor.example', meta: { zone: 'harbor.example', dns: 'cloudflare' } });
  const cool = asset(app, o, { provider: 'coolify', kind: 'project', extId: `${srv}/p/coolify:harbor`, name: 'harbor-api', meta: { server: `unit7:${srv}`, owner: 'coolify' } });
  const coolApp = asset(app, o, { provider: 'coolify', kind: 'app', extId: `${srv}/c:harbor-api`, name: 'harbor-api', meta: { server: `unit7:${srv}`, project: `coolify:${srv}/p/coolify:harbor`, envKeys: ['SECRET_KEY'] } });
  edge(app, o, web, db, 'env', 'DATABASE_URL');
  edge(app, o, dom, web, 'domain', 'added on Vercel');
  edge(app, o, coolApp, server, 'runs_on', 'run by Coolify');
  const blog = asset(app, o, { provider: 'vercel', kind: 'app', extId: 'prj_b', name: 'blog' });
  const shop = asset(app, o, { provider: 'vercel', kind: 'app', extId: 'prj_s', name: 'shop' });
  const blogDom = asset(app, o, { provider: 'domain', kind: 'domain', extId: 'blog.example.com', name: 'blog.example.com', meta: { zone: 'example.com' } });
  const shopDom = asset(app, o, { provider: 'domain', kind: 'domain', extId: 'shop.example.com', name: 'shop.example.com', meta: { zone: 'example.com' } });
  edge(app, o, blogDom, blog, 'dns', 'CNAME cname.vercel-dns.com');
  edge(app, o, shopDom, shop, 'dns', 'CNAME cname.vercel-dns.com');
  return { app, o, srv, server, web, db, dom, cool, coolApp, blog, shop, blogDom, shopDom };
}

test('names, domains and repos boil down to the same product', () => {
  assert.equal(stemOf({ name: 'harbor-web', kind: 'app' }), 'harbor');
  assert.equal(stemOf({ name: 'Harbor DB', kind: 'database' }), 'harbor');
  assert.equal(stemOf({ name: 'harbor.example', kind: 'domain', zone: 'harbor.example' }), 'harbor');
  assert.equal(stemOf({ name: 'api.harbor.example', kind: 'domain', zone: 'harbor.example' }), 'harbor', 'a generic label falls back to the domain');
  assert.equal(stemOf({ name: 'blog.example.com', kind: 'domain', zone: 'example.com' }), 'blog', 'a subdomain is its own name');
  assert.equal(stemOf({ name: 'web', kind: 'app' }), undefined, 'too generic to say anything');
  assert.equal(normRepo('git@github.com:Sam/Harbor.git'), 'github.com/sam/harbor');
  assert.equal(normRepo('https://github.com/sam/harbor/'), 'github.com/sam/harbor');
  assert.equal(normRepo('sam/harbor'), 'github.com/sam/harbor');
  assert.equal(normRepo('not a repo'), undefined);
});

test('evidence ranks: wiring, then DNS, then the same repo, then the same name', () => {
  const t = (key: string, name: string, kind = 'app', extra: Partial<Thing> = {}): Thing => ({ key, name, kind, provider: 'vercel', logo: 'vercel', ...extra });
  const things = [t('a1', 'alpha'), t('a2', 'zeta-store', 'database'), t('d1', 'bravo.io', 'domain', { zone: 'bravo.io' }), t('d2', 'quux'),
    t('r1', 'one', 'app', { repo: 'github.com/sam/r' }), t('r2', 'two', 'app', { repo: 'github.com/sam/r' }), t('n1', 'kilo-web'), t('n2', 'kilo-db', 'database')];
  const links: Link[] = [
    { a: 'a1', b: 'a2', signal: 'env', why: { a: 'its DATABASE_URL setting points at zeta-store', b: 'alpha’s DATABASE_URL setting points here' } },
    { a: 'd1', b: 'd2', signal: 'dns', why: { a: 'points at quux', b: 'bravo.io points here' } },
  ];
  const out = detect(things, links);
  assert.deepEqual(out.map((s) => s.signals[0]), ['env', 'dns', 'repo', 'name']);
  assert.deepEqual(out.map((s) => s.confidence), ['good', 'good', 'good', 'maybe']);
  assert.equal(out[0]!.items.find((i) => i.key === 'a2')!.reason, 'alpha’s DATABASE_URL setting points here', 'each item says why, from its side');
  assert.equal(out[2]!.items[0]!.reason, 'deploys from the same code (sam/r)');
  assert.equal(out[3]!.name, 'kilo');
});

test('the map: one product found with a reason each; an agency’s subdomains stay apart; the sure ones only are automatic', async () => {
  const { app, o, web, db, dom, cool, blog, shop } = await harbor();
  const r = ok(await o.h('group.suggest'));
  const s = r.suggestions.find((x: any) => x.name === 'harbor');
  assert.ok(s, 'harbor is found');
  assert.deepEqual(new Set(s.items.map((i: any) => i.key)), new Set([web, db, dom, cool]), 'the Coolify part counts as its project; the server isn’t part of it');
  assert.equal(s.confidence, 'strong');
  assert.deepEqual(s.signals, ['env', 'dns', 'repo', 'name'].filter((x) => s.signals.includes(x)));
  const why = Object.fromEntries(s.items.map((i: any) => [i.key, i.reason]));
  assert.equal(why[db], 'harbor-web’s DATABASE_URL setting points here');
  assert.equal(why[dom], 'points at harbor-web');
  assert.match(why[cool], /same name/);
  assert.equal(autoReady(s), false, 'a member there by name alone means a person decides');
  assert.ok(!r.suggestions.some((x: any) => x.items.some((i: any) => i.key === blog) && x.items.some((i: any) => i.key === shop)), 'blog and shop share a domain, not a product');
  // Warden's suggestion, on Home
  const sug = suggestions(app, o.orgId).find((x) => x.id === `group:${s.id}`);
  assert.match(sug!.text, /These 4 look like one product: harbor/);
  assert.equal(sug!.actions[0]!.kind === 'tool' && sug!.actions[0]!.tool, 'group.accept');
  assert.equal(groupSuggestions(app, o.orgId).length >= 1, true);
});

test('a product survives every re-scan, shows on the map with one health, and a removed member isn’t suggested back', async () => {
  const { app, o, web, db, dom, cool, coolApp } = await harbor();
  const g = ok(await o.h('group.accept', { keys: [web, db, dom, coolApp], name: 'Harbor' }));
  assert.equal(g.members, 4, 'the Coolify app joins as its project');
  assert.deepEqual(g.undo, { tool: 'group.dissolve', input: { groupId: g.groupId }, label: 'Ungroup them' });
  // a re-scan deletes and writes every asset again, with the same ids
  const rows = all<any>(app.db, 'SELECT * FROM assets WHERE org_id = ?', o.orgId);
  run(app.db, 'DELETE FROM assets WHERE org_id = ?', o.orgId);
  for (const a of rows) run(app.db, 'INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', a.id, a.org_id, a.account_id, a.provider, a.kind, a.ext_id, a.name, a.url, a.meta, new Date().toISOString());
  run(app.db, `INSERT INTO watch (org_id, host, kind, status, asset) VALUES (?, 'harbor.example', 'site', 'down', ?)`, o.orgId, web);
  const m = ok(await o.h('map.get'));
  for (const k of [web, db, dom, cool, coolApp]) assert.equal(m.assets.find((a: any) => a.id === k).group, g.groupId, 'every member, and the part inside the project');
  const frame = m.groups.find((x: any) => x.id === g.groupId);
  assert.equal(frame.name, 'Harbor');
  assert.equal(frame.health, 'bad', 'one health: its worst member (the site is down)');
  assert.ok(!ok(await o.h('group.suggest')).suggestions.some((x: any) => x.items.some((i: any) => i.key === db)), 'nothing grouped is suggested again');
  // a person takes the Coolify project out: it isn't suggested back into Harbor
  const rm = ok(await o.h('group.remove_member', { groupId: g.groupId, keys: [coolApp] }));
  assert.deepEqual(rm.removed, ['harbor-api']);
  assert.ok(!ok(await o.h('group.suggest')).suggestions.some((x: any) => x.items.some((i: any) => i.key === cool)));
  ok(await o.h('group.rename', { groupId: g.groupId, name: 'Harbor Shop' }));
  assert.equal(ok(await o.h('map.get')).groups[0].name, 'Harbor Shop');
  const bad = await o.h('group.accept', { keys: [assetIdOf(o.orgId, `unit7:${rows.find((r) => r.kind === 'server').ext_id}`)] });
  assert.equal(bad.status, 'error', 'a server is shared, so it never joins a product');
});

test('Warden groups the sure ones by itself only at Full autopilot, says so with an undo, and an undo sticks', async () => {
  const { app, o, web, db, dom, cool } = await harbor();
  ok(await o.h('group.dismiss', { id: ok(await o.h('group.suggest')).suggestions.find((x: any) => x.name === 'harbor').id }));
  run(app.db, 'DELETE FROM assets WHERE id = ?', cool); // without the name-only member, wiring + DNS is sure
  run(app.db, `DELETE FROM assets WHERE kind = 'app' AND provider = 'coolify'`);
  assert.deepEqual(await autoGroup(app, o.orgId), [], 'level 3: a suggestion, nothing more');
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM product_groups')!.n, 0);
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  run(app.db, 'UPDATE orgs SET paused_at = ? WHERE id = ?', new Date().toISOString(), o.orgId);
  assert.deepEqual(await autoGroup(app, o.orgId), [], 'paused: nothing');
  run(app.db, 'UPDATE orgs SET paused_at = NULL WHERE id = ?', o.orgId);
  const done = await autoGroup(app, o.orgId) as any[];
  assert.equal(done.length, 1);
  assert.equal(done[0].name, 'harbor');
  assert.equal(get<{ auto: number }>(app.db, 'SELECT auto FROM product_groups WHERE id = ?', done[0].groupId)!.auto, 1);
  assert.deepEqual(new Set(all<{ key: string }>(app.db, 'SELECT key FROM group_members').map((m) => m.key)), new Set([web, db, dom]));
  const ev = get<{ message: string; data: string }>(app.db, `SELECT message, data FROM events WHERE type = 'group.auto'`)!;
  assert.match(ev.message, /grouped 3 things into harbor/);
  assert.deepEqual(JSON.parse(ev.data).undo, { tool: 'group.dissolve', input: { groupId: done[0].groupId }, label: 'Ungroup them' }, 'Activity offers the undo');
  const audit = get<{ actor_name: string; output: string }>(app.db, `SELECT actor_name, output FROM audit WHERE tool = 'group.accept'`)!;
  assert.equal(audit.actor_name, 'Warden');
  assert.equal(JSON.parse(audit.output).undo.tool, 'group.dissolve', 'Autopilot lists it with its undo');
  // the person undoes it: Warden never groups that again
  ok(await o.h('group.dissolve', { groupId: done[0].groupId }));
  assert.deepEqual(await autoGroup(app, o.orgId), []);
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM product_groups')!.n, 0);
});

test('a thing belongs to one client at most; a product moves as a whole; removing a client gives things back', async () => {
  const { app, o, web, db, dom, blog } = await harbor();
  const a = ok(await o.h('client.create', { name: 'Acme Bakery', contact: 'Sam' })).clientId;
  const b = ok(await o.h('client.create', { name: 'Gym Co', color: '#0f766e' })).clientId;
  assert.equal((await o.h('client.create', { name: 'acme bakery' })).status, 'error', 'one name per client');
  assert.equal((await o.h('client.create', { name: 'X', logo: 'https://tracker.example.com/x.png' })).status, 'error', 'a logo is a picture kept here, not an outside address');
  const g = ok(await o.h('group.accept', { keys: [web, db, dom], name: 'harbor' }));
  ok(await o.h('client.assign', { clientId: a, key: g.groupId }));
  const moved = ok(await o.h('client.assign', { clientId: b, key: db }));
  assert.equal(moved.key, g.groupId, 'a member moves its whole product');
  assert.equal(moved.from, 'Acme Bakery');
  assert.deepEqual(moved.undo, { tool: 'client.assign', input: { clientId: a, key: g.groupId }, label: 'Give it back to Acme Bakery' });
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM client_members WHERE key = ?', g.groupId)!.n, 1);
  ok(await o.h('client.assign', { clientId: a, key: blog }));
  const list = ok(await o.h('client.list'));
  const A = list.clients.find((c: any) => c.id === a), B = list.clients.find((c: any) => c.id === b);
  assert.equal(A.products, 0); assert.equal(B.products, 1);
  assert.ok(B.ids.includes(web) && B.ids.includes(db) && !A.ids.includes(web), 'pages can filter by these ids');
  assert.ok(A.ids.includes(blog));
  assert.equal(B.color, '#0f766e');
  // grouping a thing that was the client's on its own: the product keeps one client
  ok(await o.h('group.dissolve', { groupId: g.groupId }));
  assert.equal(ok(await o.h('client.list')).clients.find((c: any) => c.id === b).ids.includes(db), true, 'ungrouped, its things stay with the client');
  const r = await o.a('client.remove', { clientId: b });
  assert.equal(r.status, 'denied', 'removing a client is a person’s');
  ok(await o.h('client.remove', { clientId: b }));
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM client_members WHERE client_id = ?', b)!.n, 0);
});

test('a client’s monthly cost: its share of each server, provider costs by name, and a CSV that can’t run formulas', async () => {
  const { app, o, srv, web, db, dom } = await harbor();
  const prj = id('prj'), env = id('env');
  run(app.db, `INSERT INTO projects (id, org_id, name, slug) VALUES (?, ?, 'gym-crm', 'gym-crm')`, prj, o.orgId);
  run(app.db, `INSERT INTO environments (id, org_id, project_id, name, slug, kind, autonomy) VALUES (?, ?, ?, 'Production', 'production', 'production', 3)`, env, o.orgId, prj);
  for (const n of ['crm-web', 'crm-db']) run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id('svc'), o.orgId, prj, env, srv, n, n, n === 'crm-db' ? 'postgres' : 'web');
  saveXray(app.db, o.orgId, srv, 'fast', { version: 1, projects: [{ id: 'coolify:harbor', name: 'harbor-api', owner: 'coolify', parts: [] }, { id: 'unit7:apps', name: 'Unit7', owner: 'unit7', parts: [] }], parts: [] });
  saveXray(app.db, o.orgId, srv, 'usage', { price: { monthly: 20, currency: 'USD', source: 'you' }, projects: [{ id: 'coolify:harbor', name: 'harbor-api', cost: 8, share: 0.4 }, { id: 'unit7:apps', name: 'Unit7', cost: 6, share: 0.3 }, { id: 'coolify:system', name: 'Coolify itself', system: true, cost: 4, share: 0.2 }] });
  run(app.db, `INSERT INTO costs (org_id, provider, account, label, amount, currency, kind, at) VALUES (?, 'vercel', 'sam', 'harbor-web', 20, 'USD', 'spent', ?)`, o.orgId, new Date().toISOString());
  run(app.db, `INSERT INTO costs (org_id, provider, account, label, amount, currency, kind, at) VALUES (?, 'vercel', 'sam', 'team (usage this month)', 5, 'USD', 'spent', ?)`, o.orgId, new Date().toISOString());
  const a = ok(await o.h('client.create', { name: '=HYPERLINK("https://example.com")' })).clientId;
  const b = ok(await o.h('client.create', { name: 'Gym Co' })).clientId;
  const g = ok(await o.h('group.accept', { keys: [web, db, dom, assetIdOf(o.orgId, `coolify:${srv}/p/coolify:harbor`)], name: 'harbor' }));
  ok(await o.h('client.assign', { clientId: a, key: g.groupId }));
  ok(await o.h('client.assign', { clientId: b, key: prj }));
  const c = ok(await o.h('client.costs'));
  const total = (cid: string) => c.perClient.find((x: any) => x.clientId === cid).total;
  assert.deepEqual(total(a), [{ currency: 'USD', amount: 28 }], 'its Vercel cost and its project’s share of the server');
  assert.deepEqual(total(b), [{ currency: 'USD', amount: 6 }], 'Unit7’s apps on the server split between them, all Gym Co’s');
  assert.deepEqual(c.unassigned, [{ currency: 'USD', amount: 5 }], 'the server itself and account-wide lines stay unassigned');
  assert.ok(c.lines.some((l: any) => l.clientId === a && l.source === 'Server share' && l.product === 'harbor' && l.amount === 8));
  assert.match(c.csv, /^Month,Client,Product,Item,Source,Amount,Currency\n/);
  assert.ok(c.csv.includes(`"'=HYPERLINK(""https://example.com"")"`), 'a name that looks like a formula is quoted and defused');
  assert.ok(!/(^|,)=/m.test(c.csv));
  const one = ok(await o.h('client.costs', { clientId: b }));
  assert.equal(one.lines.length, 2);
  assert.equal(ok(await o.h('client.list')).clients.find((x: any) => x.id === b).cost[0].amount, 6);
});

test('the status page shows a name, up or down, uptime and the last incident: nothing internal, nothing unescaped', async () => {
  const { app, o, web, db, dom } = await harbor();
  const cid = ok(await o.h('client.create', { name: 'Acme' })).clientId;
  const g = ok(await o.h('group.accept', { keys: [web, db, dom], name: '<script>alert(1)</script> shop' }));
  ok(await o.h('client.assign', { clientId: cid, key: g.groupId }));
  run(app.db, `INSERT INTO watch (org_id, host, kind, status, detail, asset) VALUES (?, 'harbor.example', 'site', 'up', 'HTTP 200 from 203.0.113.9', ?)`, o.orgId, web);
  const at = Date.parse('2026-10-07T12:00:00Z');
  const ev = (type: string, ms: number) => run(app.db, `INSERT INTO events (id, org_id, type, severity, message, resource, created_at) VALUES (?, ?, ?, 'critical', 'harbor.example (harbor-web) isn’t answering: box-prod-1 203.0.113.9', 'harbor.example', ?)`, id('evt'), o.orgId, type, new Date(at - ms).toISOString());
  ev('site.down', 2 * 86400_000); ev('site.recovered', 2 * 86400_000 - 3600_000);
  const page = statusData(app.db, o.orgId, cid, undefined, at);
  assert.deepEqual(Object.keys(page), ['title', 'updatedAt', 'apps']);
  assert.deepEqual(page.apps.map((x) => Object.keys(x)), [['name', 'status', 'uptime30', 'lastIncident']]);
  assert.deepEqual(page.apps[0], { name: '<script>alert(1)</script> shop', status: 'up', uptime30: 99.86, lastIncident: new Date(at - 2 * 86400_000).toISOString() });
  const html = renderStatusHtml(page), text = JSON.stringify(page);
  for (const out of [html, text]) for (const secret of ['203.0.113.9', 'box-prod-1', 'DATABASE_URL', 'SECRET_KEY', 'supabase.co', 'harbor.example', 'harbor-web', 'HTTP 200', 'srv_', 'ast_', 'cli_']) {
    assert.ok(!out.includes(secret), `the page never shows ${secret}`);
  }
  assert.ok(!html.includes('<script>'), 'names are escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/<script|<img|<link|https?:\/\//i.test(html.replace(/&lt;script&gt;/g, '')), 'no script, picture, stylesheet or outside address');
  assert.match(html, /noindex/);
  // uptime itself: a site still down counts until now
  assert.equal(uptime([{ type: 'site.down', at: new Date(at - 3 * 86400_000).toISOString() }], at).percent, 90);
  assert.equal(uptime([], at).percent, 100);
  assert.equal(uptime([{ type: 'site.down', at: new Date(at - 40 * 86400_000).toISOString() }, { type: 'site.recovered', at: new Date(at - 39 * 86400_000).toISOString() }], at).percent, 100, 'older than 30 days');
});

const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
function fakeServer(app: App) {
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => { seen.push(`${command} ${String(o.stdin ?? '')}`); return done(); };
  return seen;
}

test('the status link: a person turns it on; Warden refreshes; a new link kills the old; off takes it down; the token never leaks', async () => {
  const { app, o, srv, web, db, dom } = await harbor();
  run(app.db, `UPDATE servers SET facts = ? WHERE id = ?`, JSON.stringify({ web: 'coolify-proxy|traefik:v3.6' }), srv);
  const cid = ok(await o.h('client.create', { name: 'Acme' })).clientId;
  const g = ok(await o.h('group.accept', { keys: [web, db, dom], name: 'harbor' }));
  ok(await o.h('client.assign', { clientId: cid, key: g.groupId }));
  run(app.db, `INSERT INTO watch (org_id, host, kind, status, asset) VALUES (?, 'harbor.example', 'site', 'up', ?)`, o.orgId, web);
  const seen = fakeServer(app);

  assert.equal((await o.a('client.status_link', { clientId: cid, enabled: true, serverId: srv, domain: 'status.example.org' })).status, 'denied', 'an AI can’t turn it on');
  const sneaky = await o.a('client.status_link', { clientId: cid, enabled: true });
  assert.equal(sneaky.status, 'error');
  assert.equal((await o.h('client.status_link', { clientId: cid, enabled: true, serverId: srv, domain: 'harbor.example' })).status, 'error', 'not on a name an app uses');
  assert.equal(seen.length, 0);

  const on = ok(await o.h('client.status_link', { clientId: cid, enabled: true, serverId: srv, domain: 'status.example.org' }));
  const token = /^https:\/\/status\.example\.org\/([A-Za-z0-9_-]{32})\/$/.exec(on.url)![1]!;
  assert.deepEqual(on.shows, ['harbor']);
  assert.ok(app.vault.has(o.orgId, tokenRef(cid)), 'the token is in the vault');
  const files = seen.find((c) => c.includes('/etc/unit7/caddy/status/' + cid) && c.includes('index.html'))!;
  assert.ok(files && !files.includes(token) && !files.includes('203.0.113.9') && !files.includes('box-prod-1'), 'the files carry no token, address or server name');
  assert.ok(seen.some((c) => /docker run -d --name unit7-status/.test(c) && /--read-only/.test(c) && /--cap-drop ALL/.test(c) && c.includes(':/srv:ro') && /State\.Running/.test(c)), 'a read-only file server next to Coolify, started once');
  const route = seen.find((c) => c.includes('/data/coolify/proxy/dynamic/unit7-status.example.org.yaml'))!;
  assert.ok(route.includes(`PathPrefix(\`/${token}/\`)`) && route.includes('rateLimit:') && route.includes('average: 30'), 'only the long path, rate-limited');
  // never in the record, the events, or what an AI sees
  for (const t of ['audit', 'events', 'approvals']) assert.ok(!all<any>(app.db, `SELECT * FROM ${t}`).some((r) => JSON.stringify(r).includes(token)), `no token in ${t}`);
  const seenByAi = ok(await o.a('client.status_link', { clientId: cid }));
  assert.equal(seenByAi.on, true);
  assert.ok(!JSON.stringify(seenByAi).includes(token), 'an AI gets a placeholder, not the link');
  assert.equal(ok(await o.h('client.status_link', { clientId: cid })).url, on.url, 'a person sees it again');

  // Warden's refresh: new files, no route, no token
  seen.length = 0;
  await refreshStatusPages(app);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.includes('status.json') && !seen[0]!.includes(token));

  // a new link: the old path is gone from the route
  seen.length = 0;
  assert.equal((await o.a('client.status_link', { clientId: cid, rotate: true })).status, 'denied', 'changing the link is a person’s');
  const rotated = ok(await o.h('client.status_link', { clientId: cid, rotate: true }));
  const token2 = /\/([A-Za-z0-9_-]{32})\/$/.exec(rotated.url)![1]!;
  assert.notEqual(token2, token);
  const route2 = seen.find((c) => c.includes('unit7-status.example.org.yaml'))!;
  assert.ok(route2.includes(token2) && !route2.includes(token));

  // off: an AI may take it down; the route goes first, then the files; the link's token is retired
  seen.length = 0;
  const off = ok(await o.a('client.status_link', { clientId: cid, enabled: false }));
  assert.equal(off.on, false);
  assert.ok(/rm -f/.test(seen[0]!) && seen[0]!.includes('/data/coolify/proxy/dynamic/unit7-status.example.org.yaml'));
  assert.ok(seen.some((c) => c.includes('rm -rf --') && c.includes(`/etc/unit7/caddy/status/${cid}`)));
  assert.equal(app.vault.has(o.orgId, tokenRef(cid)), false);
  seen.length = 0;
  await refreshStatusPages(app);
  assert.equal(seen.length, 0, 'nothing refreshes once it’s off');
});

test('on a Caddy server the page is a route of its own: never over an existing site, validated before it goes live', async () => {
  const { app, o, srv } = await harbor();
  run(app.db, `UPDATE servers SET facts = ? WHERE id = ?`, JSON.stringify({ web: 'unit7-caddy|caddy:2' }), srv);
  const cid = ok(await o.h('client.create', { name: 'Acme' })).clientId;
  const seen = fakeServer(app);
  const on = ok(await o.h('client.status_link', { clientId: cid, enabled: true, serverId: srv, domain: 'status.example.org' }));
  const token = /\/([A-Za-z0-9_-]{32})\/$/.exec(on.url)![1]!;
  const site = seen.find((c) => c.includes('/etc/unit7/caddy/sites/status.example.org.caddy'))!;
  assert.ok(site.includes(`handle_path /${token}/*`) && site.includes(`root * /etc/caddy/status/${cid}`) && site.includes('respond 404'));
  assert.ok(site.includes('already has a site on this server'), 'it refuses to replace someone’s site');
  assert.ok(seen.some((c) => /caddy validate/.test(c)) && seen.some((c) => /caddy reload/.test(c)));
  assert.deepEqual(on.shows, [], 'a client with nothing checked yet shows an empty page');
});

test('what a person unticks while grouping isn’t suggested for that product again', async () => {
  const { o, web, db, dom, cool } = await harbor();
  const g = ok(await o.h('group.accept', { keys: [web, db, dom], name: 'harbor', left: [cool], reasons: { [db]: 'harbor-web’s DATABASE_URL setting points here' } }));
  assert.ok(!ok(await o.h('group.suggest')).suggestions.some((s: any) => s.items.some((i: any) => i.key === cool)), 'the Coolify project stays out');
  const p = ok(await o.h('group.suggest')).groups.find((x: any) => x.id === g.groupId);
  assert.equal(p.members.find((m: any) => m.key === db).reason, 'harbor-web’s DATABASE_URL setting points here', 'the product remembers why');
  assert.equal(p.health, 'ok');
});

test('a status page moved off a server that doesn’t answer is removed there as soon as it does', async () => {
  const { app, o, srv } = await harbor();
  const srv2 = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box-2', '203.0.113.20', 'root', 'credential://ssh/box2/private-key', 'ready', ?)`, srv2, o.orgId, JSON.stringify({ web: 'unit7-caddy|caddy:2' }));
  run(app.db, `UPDATE servers SET facts = ? WHERE id = ?`, JSON.stringify({ web: 'unit7-caddy|caddy:2' }), srv);
  const cid = ok(await o.h('client.create', { name: 'Acme' })).clientId;
  const seen: { server: string; cmd: string }[] = [];
  let firstDown = false;
  ssh(app).exec = async (s, command) => { seen.push({ server: s.id, cmd: command }); return firstDown && s.id === srv ? done('', 255) : done(); };
  ok(await o.h('client.status_link', { clientId: cid, enabled: true, serverId: srv, domain: 'status.example.org' }));
  firstDown = true;
  const moved = ok(await o.h('client.status_link', { clientId: cid, enabled: true, serverId: srv2, domain: 'status.example.net' }));
  assert.equal(moved.on, true);
  assert.equal(moved.leftover, true, 'the old place is remembered');
  firstDown = false; seen.length = 0;
  await refreshStatusPages(app);
  assert.ok(seen.some((c) => c.server === srv && c.cmd.includes('status.example.org.caddy') && /rm -f/.test(c.cmd)), 'the old route goes as soon as that server answers');
  assert.equal(ok(await o.h('client.status_link', { clientId: cid })).leftover, undefined);
});
