// Uptime Kuma watches every site Unit7 knows. The real program Unit7 sends runs here under Node, the way it would inside
// the container (`docker exec -i <container> node -`), against a stand-in socket.io-client that answers like Uptime
// Kuma's server.js and writes down every event. One monitor per site, tagged "unit7", 60 seconds; no duplicates, the
// person's own left alone, the login only ever on stdin, and running it again adds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { madeSet } from '../src/tools/staging.ts';
import { saveXray } from '../src/tools/xray.ts';
import { kumaRef, knownSites, startUptimeWatch } from '../src/tools/uptime.ts';
import { assetIdOf } from '../src/archive.ts';
import { kumaProgram, parseKuma } from '../src/serverapps/uptimekuma.ts';
import { fakeKuma, isKumaTrip, runInKuma } from './kuma-fixture.ts';

const PW = 'U7akumaAdminPw0123456789abcdef0123456';

// the server: `docker exec -i <container> node -` runs the program in the stand-in's folder; everything else is quiet
function fakeServer(app: App, dir: string) {
  const seen: { command: string; stdin: string }[] = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    const stdin = String(o.stdin ?? '');
    seen.push({ command, stdin });
    if (isKumaTrip(command)) return runInKuma(dir, stdin);
    return { code: 0, stdout: '', stderr: '', truncated: false };
  };
  return seen;
}

// a person's things: an app with its own domain, a site elsewhere, www that only redirects, a test address, and Uptime
// Kuma's own address; the X-ray found one more site on the server
async function org(kuma: ReturnType<typeof fakeKuma>, o: { installed?: boolean; login?: boolean } = {}) {
  const app = testApp(), t = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', '{}')`, srv, t.orgId);
  const p = ok(await t.h('project.create', { name: 'Shop', environments: ['production'] }));
  const web = id('svc');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind) VALUES (?, ?, ?, ?, ?, 'Shop', 'shop', 'app')`, web, t.orgId, p.projectId, p.environments[0].id, srv);
  const dom = (h: string, target: object = {}, svc: string | null = null) => run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls, target) VALUES (?, ?, ?, ?, 'active', 'active', ?)`, id('dom'), t.orgId, h, svc, JSON.stringify(target));
  dom('shop.example.com', { kind: 'unit7' }, web);
  dom('www.shop.example.com', { kind: 'unit7', redirectTo: 'shop.example.com' }, web);
  dom('api.example.com', { kind: 'vercel' });
  dom('shop-x1.203.0.113.9.sslip.io', {}, web);
  dom('uptime.example.com', { kind: 'addon' });
  saveXray(app.db, t.orgId, srv, 'fast', { parts: [
    { id: 'c:blog', kind: 'app', name: 'blog', hosts: ['blog.example.com', 'bad host`)'] },
    { id: 'c:kuma', kind: 'app', name: 'uptime-kuma', product: { id: 'uptimekuma', name: 'Uptime Kuma' }, containers: ['kuma-1'], hosts: ['status.example.com'] },
    { id: 'c:db', kind: 'database', name: 'db', hosts: ['db.example.com'] },
  ] });
  if (o.installed !== false) madeSet({ db: app.db, orgId: t.orgId }, 'addon', `${srv}:uptime-kuma`, { via: 'coolify', uuid: 'kuma01', url: 'https://uptime.example.com', domain: 'uptime.example.com', creds: [] });
  if (o.login !== false) app.vault.put(t.orgId, kumaRef(srv), PW, { kind: 'addon_credential', meta: { addon: 'uptime-kuma', label: 'Admin password (user admin)', people: true, user: 'admin' } });
  const seen = fakeServer(app, kuma.dir);
  return { app, ...t, srv, seen };
}
const secretsIn = (app: App) => JSON.stringify([all(app.db, 'SELECT * FROM audit'), all(app.db, 'SELECT * FROM events'), all(app.db, 'SELECT * FROM approvals'), all(app.db, 'SELECT * FROM made')]);

test('the program: the login travels inside stdin only, and what comes back is checked field by field', () => {
  const p = kumaProgram({ username: 'admin', password: PW, sites: [{ url: 'https://shop.example.com', name: 'shop.example.com (Shop)' }] });
  assert.match(p, /^'use strict';\nconst INPUT = \{"username":"admin","password":"U7a/);
  assert.match(p, /"interval":60/);
  assert.match(p, /require\.resolve\('socket\.io-client', \{ paths: \[process\.cwd\(\), '\/app'\] \}\)/, 'Uptime Kuma’s own socket.io-client, nothing installed');
  assert.match(p, /'http' : 'https'\) \+ ':\/\/127\.0\.0\.1:' \+ port|\+ ':\/\/127\.0\.0\.1:' \+ port/, 'from inside, on its own address');
  assert.deepEqual(parseKuma('noise\n@@unit7:reply\n{"ok":true,"added":[{"url":"https://a.example.com","id":"7","tagged":true}],"already":[],"failed":[],"stale":[],"why":"pwned","extra":"x"}\n'),
    { ok: true, added: [{ url: 'https://a.example.com', id: 7, tagged: true }], already: [], failed: [], stale: [] });
  assert.equal(parseKuma('').why, 'error');
});

test('uptime.sync: one monitor per new site, named and tagged, the person’s own left alone; again adds nothing', async () => {
  const kuma = fakeKuma({ users: [{ username: 'admin', password: PW }], monitors: [{ id: 1, name: 'API', url: 'https://api.example.com/health', type: 'http', tags: [] }] });
  const { app, srv, seen, ...o } = await org(kuma);
  const r = ok(await o.h('uptime.sync', { serverId: srv }));
  assert.equal(r.synced, true);
  assert.deepEqual(r.added, ['https://shop.example.com', 'https://blog.example.com'], 'its own domains first, then what the X-ray found');
  assert.equal(r.watching, 3);
  assert.equal(r.note, 'Uptime Kuma now watches 3 sites (2 new).');
  const k = kuma.state();
  // what it added: the web app's own form, named after the site and its app, every 60 seconds, tagged "unit7"
  const shop = k.monitors.find((m) => m.url === 'https://shop.example.com');
  assert.equal(shop.name, 'shop.example.com (Shop)');
  assert.deepEqual([shop.type, shop.method, shop.interval, shop.retryInterval, shop.maxretries], ['http', 'GET', 60, 60, 1]);
  assert.deepEqual(shop.accepted_statuscodes, ['200-299']);
  assert.deepEqual(shop.conditions, [], 'a 2.x server gets the 2.x form');
  assert.deepEqual(shop.tags.map((t: any) => t.name), ['unit7']);
  assert.equal(k.monitors.find((m) => m.url === 'https://blog.example.com').name, 'blog.example.com (blog)');
  // not watched: www that only redirects, a test address, Uptime Kuma itself, a database, a name that isn't one
  assert.deepEqual(k.monitors.map((m) => m.url).sort(), ['https://api.example.com/health', 'https://blog.example.com', 'https://shop.example.com']);
  assert.deepEqual(k.monitors[0], { id: 1, name: 'API', url: 'https://api.example.com/health', type: 'http', tags: [] }, 'the person’s own monitor is untouched');
  assert.deepEqual(k.tags, [{ id: 1, name: 'unit7', color: '#2563EB' }]);
  assert.deepEqual(k.events[0], ['connect', 'http://127.0.0.1:3001', ['websocket']]);

  // the login: only on stdin, never on the command line, in the audit, events, approvals or results
  const trip = seen.find((x) => x.command.includes('node -'))!;
  assert.equal(trip.command, `sh -c 'exec docker exec -i "$1" node -' unit7 'uptime-kuma-kuma01'`);
  assert.ok(trip.stdin.includes(PW));
  assert.ok(!seen.some((x) => x.command.includes(PW)));
  assert.ok(!secretsIn(app).includes(PW));
  assert.ok(!JSON.stringify(r).includes(PW));

  // again: nothing new, no second tag, no duplicates
  const again = ok(await o.h('uptime.sync', { serverId: srv }));
  assert.deepEqual(again.added, []);
  assert.equal(again.note, 'Uptime Kuma now watches 3 sites.');
  assert.equal(kuma.state().monitors.length, 3);
  assert.equal(kuma.state().tags.length, 1);
  assert.equal(kuma.state().events.filter((e) => e[0] === 'add').length, 2);

  // a site Unit7 no longer knows: its monitor stays, and it's said
  run(app.db, `DELETE FROM xrays WHERE server_id = ?`, srv);
  const stale = ok(await o.h('uptime.sync', { serverId: srv }));
  assert.deepEqual(stale.stale, ['https://blog.example.com']);
  assert.equal(kuma.state().monitors.length, 3, 'nothing deleted');
});

test('uptime.sync through the gate: on the Uptime Kuma Unit7 added, an AI may keep it in step; one Unit7 only found waits for a person', async () => {
  const kuma = fakeKuma({ users: [{ username: 'admin', password: PW }] }, '1.23.16');
  const mine = await org(kuma);
  const r = ok(await mine.a('uptime.sync', { serverId: mine.srv }));
  assert.equal(r.added.length, 3);
  const shop = kuma.state().monitors.find((m) => m.url === 'https://shop.example.com');
  assert.equal(shop.timeout, 48, 'a 1.x server gets the 1.x form');
  assert.equal(shop.conditions, undefined);

  // found on the server, no login: the AI's call waits for a person; the person gives the login once (people only)
  const found = fakeKuma({ users: [{ username: 'sam', password: 'samsOwnPassw0rd!' }] });
  const f = await org(found, { installed: false, login: false });
  assert.equal((await f.a('uptime.sync', { serverId: f.srv })).status, 'approval_required');
  const noLogin = ok(await f.h('uptime.sync', { serverId: f.srv }));
  assert.equal(noLogin.needsLogin, true);
  assert.ok(noLogin.sites.includes('https://shop.example.com'));
  assert.equal((await f.a('uptime.sync', { serverId: f.srv, username: 'sam', password: 'samsOwnPassw0rd!' })).status, 'denied', 'an AI never handles a password');
  const wrong = await f.h('uptime.sync', { serverId: f.srv, username: 'sam', password: 'wrong-password' });
  assert.equal(wrong.status === 'error' && wrong.error.code, 'login_refused');
  assert.ok(!f.app.vault.has(f.orgId, kumaRef(f.srv)), 'a login that doesn’t work isn’t kept');
  const given = ok(await f.h('uptime.sync', { serverId: f.srv, username: 'sam', password: 'samsOwnPassw0rd!' }));
  assert.equal(given.watching, 4);
  assert.equal(f.seen.find((x) => x.command.includes('node -'))!.command, `sh -c 'exec docker exec -i "$1" node -' unit7 'kuma-1'`, 'the container the X-ray found');
  assert.ok(f.app.vault.has(f.orgId, kumaRef(f.srv)));
  assert.ok(!secretsIn(f.app).includes('samsOwnPassw0rd!'));
  // adopted by a person: from now on it's kept in step without asking
  assert.equal((await f.a('uptime.sync', { serverId: f.srv })).status, 'ok');
});

test('when it can’t: two-factor, not answering, or a changed password are said plainly, with the sites to add by hand', async () => {
  const kuma = fakeKuma({ users: [{ username: 'admin', password: PW }], twofa: true });
  const o = await org(kuma);
  const r = ok(await o.h('uptime.sync', { serverId: o.srv }));
  assert.equal(r.synced, false);
  assert.match(r.note, /two-factor code, which Unit7 can’t type\. Add each site as an HTTP\(s\) monitor/);
  assert.ok(r.sites.includes('https://shop.example.com'));
  const down = fakeKuma({ down: true });
  const d = await org(down);
  assert.match(ok(await d.h('uptime.sync', { serverId: d.srv })).note, /isn’t answering inside its container/);
});

test('a site going live is added by itself, on the Uptime Kuma Unit7 has a login for', async () => {
  const kuma = fakeKuma({ users: [{ username: 'admin', password: PW }] });
  const o = await org(kuma);
  const off = startUptimeWatch(o.app, 5);
  try {
    o.app.events.emit(o.orgId, 'domain.live', 'shop.example.com is live', { severity: 'success' });
    for (let i = 0; i < 100 && kuma.state().monitors.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(kuma.state().monitors.length, 3);
    for (let i = 0; i < 40 && !all(o.app.db, `SELECT 1 FROM audit WHERE tool = 'uptime.sync'`).length; i++) await new Promise((r) => setTimeout(r, 50));
    const rows = all<{ actor_name: string; result: string }>(o.app.db, `SELECT actor_name, result FROM audit WHERE tool = 'uptime.sync'`);
    assert.deepEqual(rows.map((x) => [x.actor_name, x.result]), [['Warden', 'success']], 'through the gate, as Warden');
  } finally { off(); }
});

test('knownSites: what the X-ray found in an archived project isn’t watched', async () => {
  const kuma = fakeKuma({ users: [{ username: 'admin', password: PW }] });
  const { app, srv, orgId } = await org(kuma);
  const parts = [{ id: 'c:blog', kind: 'app', owner: 'coolify', name: 'blog', project: 'p1', hosts: ['blog.example.com'] }, { id: 'c:docs', kind: 'app', owner: 'coolify', name: 'docs', project: 'p2', hosts: ['docs.example.com'] }];
  saveXray(app.db, orgId, srv, 'fast', { parts, projects: [{ id: 'p1', owner: 'coolify', name: 'Blog', parts: ['c:blog'] }, { id: 'p2', owner: 'coolify', name: 'Docs', parts: ['c:docs'] }] });
  const urls = () => knownSites({ db: app.db, orgId }, srv).map((s) => s.url);
  assert.ok(urls().includes('https://blog.example.com'));
  run(app.db, `INSERT INTO archived (org_id, key, name, kind) VALUES (?, ?, 'Blog', 'project')`, orgId, assetIdOf(orgId, `coolify:${srv}/p/p1`));
  assert.ok(!urls().includes('https://blog.example.com'), 'archived project left out');
  assert.ok(urls().includes('https://docs.example.com'));
});
