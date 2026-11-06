// One address: www and the bare domain both answer, and one sends visitors to the other with a 301 that keeps the page
// and the query. Caddy's redir block, a redirectRegex middleware on Unit7's own Traefik routers (Coolify's untouched),
// Vercel's project-domain redirect, remembered so a later deploy keeps the redirect, and checked over HTTP afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions, type ServerRow } from '../src/connectors/ssh.ts';
import { get, id, json, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { guardCaddyFile, guardTraefikFile, putSite, renderSite, renderTraefik } from '../src/deploy/caddy.ts';
import { CANON } from '../src/tools/launch.ts';

test('Caddy: the other name is only a permanent redirect to the main one, with the page and query kept', () => {
  const c = renderSite({ hostname: 'www.example.com', upstream: 'shop-web-1', port: 3000, tls: 'auto', redirectTo: 'example.com' });
  assert.match(c, /^www\.example\.com \{\n\timport unit7_blocklist\n/);
  assert.match(c, /\tredir https:\/\/example\.com\{uri\} permanent\n\}\n$/);
  assert.doesNotMatch(c, /reverse_proxy/, 'the app never answers on it');
  assert.equal(guardCaddyFile(c), c, 'Warden’s secret-file guard has nothing to add, so it never rewrites it');
  const plain = renderSite({ hostname: 'www.example.com', upstream: 'a', port: 80, tls: 'off', redirectTo: 'example.com' });
  assert.match(plain, /^http:\/\/www\.example\.com \{/);
  assert.match(plain, /redir http:\/\/example\.com\{uri\} permanent/);
  assert.match(renderSite({ hostname: 'example.com', upstream: 'a', port: 80, tls: 'internal', redirectTo: 'www.example.com' }), /\ttls internal\n\tredir https:\/\/www\.example\.com\{uri\} permanent/);
  assert.throws(() => renderSite({ hostname: 'www.example.com', upstream: 'a', port: 80, tls: 'auto', redirectTo: 'example.com{uri}; respond 200' }));
});

test('Traefik: a redirectRegex middleware on Unit7’s own routers, http and https straight to the main address', () => {
  const y = renderTraefik({ hostname: 'www.example.com', upstream: 'shop-web-1', port: 3000, tls: 'auto', redirectTo: 'example.com' });
  assert.match(y, /    unit7-www-example-com-http:\n      rule: "Host\(`www\.example\.com`\) && !\(/);
  assert.match(y, /    unit7-www-example-com:\n[^]*entryPoints: \[https\]\n      service: unit7-www-example-com\n      middlewares: \[unit7-www-example-com-to-main\]\n      tls:\n        certResolver: letsencrypt/);
  assert.equal(y.match(/middlewares: \[unit7-www-example-com-to-main\]/g)?.length, 2, 'both routers redirect');
  assert.match(y, /redirectRegex:\n        regex: '\^https\?:\/\/www\\\.example\\\.com\(:\[0-9\]\+\)\?\/\(\.\*\)'\n        replacement: 'https:\/\/example\.com\/\$\{2\}'\n        permanent: true/);
  assert.doesNotMatch(y, /redirectScheme/, 'one hop, not http → https → main');
  assert.equal(guardTraefikFile(y), y);
  // what Traefik does with it (Go's ${2} is JavaScript's $2): the page and the query survive, a port is dropped
  const regex = new RegExp(/regex: '([^']+)'/.exec(y)![1]!), to = /replacement: '([^']+)'/.exec(y)![1]!.replace('${2}', '$2');
  assert.equal('https://www.example.com/pricing?plan=pro'.replace(regex, to), 'https://example.com/pricing?plan=pro');
  assert.equal('http://www.example.com/'.replace(regex, to), 'https://example.com/');
  assert.equal('http://www.example.com:80/a'.replace(regex, to), 'https://example.com/a');
  assert.doesNotMatch('https://wwwXexample.com/a', regex, 'dots are literal');
  assert.match(renderTraefik({ hostname: 'www.example.com', upstream: 'a', port: 80, tls: 'off', redirectTo: 'example.com' }), /replacement: 'http:\/\/example\.com\/\$\{2\}'/);
  assert.throws(() => renderTraefik({ hostname: 'www.example.com', upstream: 'a', port: 80, tls: 'auto', redirectTo: "example.com'\n  evil: x" }));
});

// --- a server, an app on it, and both names pointing at it ------------------------------------------------------------
function fakeServer(app: App) {
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => { seen.push(`${command}\n${String(o.stdin ?? '')}`); return { code: 0, stdout: '', stderr: '', truncated: false }; };
  return seen;
}
async function shop(facts: object = {}) {
  const app = testApp(), o = await testOrg(app);
  const p = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] }));
  const srv = id('srv'), web = id('svc'), dep = id('dep');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', ?)`, srv, o.orgId, JSON.stringify(facts));
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, status, current_deployment_id, config) VALUES (?, ?, ?, ?, ?, 'web', 'web', 'app', 'healthy', ?, '{"port":3000}')`, web, o.orgId, p.projectId, p.environments[0].id, srv, dep);
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, container) VALUES (?, ?, ?, 1, 'live', 'shop-web-1')`, dep, o.orgId, web);
  for (const h of ['example.com', 'www.example.com']) run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls, tls_mode, target) VALUES (?, ?, ?, ?, 'active', 'active', 'auto', ?)`, id('dom'), o.orgId, h, web, JSON.stringify({ kind: 'unit7', serviceId: web }));
  return { app, o, srv, web, seen: fakeServer(app) };
}
const target = (app: App, h: string) => json<{ redirectTo?: string }>(get<{ target: string }>(app.db, 'SELECT target FROM domains WHERE hostname = ?', h)!.target, {});
const fileFor = (seen: string[], h: string) => seen.filter((c) => c.includes(`/etc/unit7/caddy/sites/${h}.caddy`) && c.includes('tee')).at(-1) ?? '';
// stands in for the internet: www answers with what the proxy would
function answers(status = 301, to = 'https://example.com') {
  const asked: string[] = [];
  CANON.fetch = async (url: string) => { asked.push(url); const u = new URL(url); return new Response(null, { status, headers: { location: `${to}${u.pathname}${u.search}` } }); };
  return asked;
}

test('domain.canonical on Unit7’s own server: www redirects, the bare domain serves the app, checked, and running it again changes nothing', async () => {
  const { app, o, seen } = await shop();
  const asked = answers();
  const r = ok(await o.h('domain.canonical', { domain: 'example.com' }));
  assert.equal(r.how, 'caddy');
  assert.deepEqual([r.main, r.redirects, r.state], ['example.com', 'www.example.com', 'ok']);
  assert.deepEqual(r.check, { answered: true, status: 301, location: 'https://example.com/unit7-check?from=redirect', ok: true });
  assert.deepEqual(asked, ['https://www.example.com/unit7-check?from=redirect'], 'it asks for a page with a query and wants both back');
  assert.match(r.note, /www\.example\.com sends visitors to example\.com, keeping the page/);
  assert.match(fileFor(seen, 'www.example.com'), /redir https:\/\/example\.com\{uri\} permanent/);
  assert.match(fileFor(seen, 'example.com'), /reverse_proxy shop-web-1:3000/);
  assert.equal(target(app, 'www.example.com').redirectTo, 'example.com');
  assert.equal(target(app, 'example.com').redirectTo, undefined);

  // a later deploy (or a re-point) routes every name of the app again: www stays a redirect
  const row = get<ServerRow>(app.db, 'SELECT * FROM servers')!;
  await putSite(app, row, { hostname: 'www.example.com', upstream: 'shop-web-2', port: 3000, tls: 'auto' });
  assert.match(fileFor(seen, 'www.example.com'), /redir https:\/\/example\.com\{uri\} permanent/);
  assert.doesNotMatch(fileFor(seen, 'www.example.com'), /reverse_proxy/);

  const again = ok(await o.h('domain.canonical', { domain: 'www.example.com', prefer: 'apex' }));
  assert.deepEqual([again.main, again.redirects, again.state], ['example.com', 'www.example.com', 'ok'], 'idempotent');

  // the other way round: www is the main one, the bare domain sends visitors there
  answers(301, 'https://www.example.com');
  const flip = ok(await o.h('domain.canonical', { domain: 'example.com', prefer: 'www' }));
  assert.deepEqual([flip.main, flip.redirects, flip.state], ['www.example.com', 'example.com', 'ok']);
  assert.match(fileFor(seen, 'example.com'), /redir https:\/\/www\.example\.com\{uri\} permanent/);
  assert.match(fileFor(seen, 'www.example.com'), /reverse_proxy shop-web-1:3000/);
  assert.equal(target(app, 'www.example.com').redirectTo, undefined);
});

test('domain.canonical says when it isn’t confirmed yet, and an AI goes through the gate', async () => {
  const { o } = await shop();
  CANON.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const waiting = ok(await o.h('domain.canonical', { domain: 'example.com' }));
  assert.equal(waiting.state, 'waiting');
  assert.match(waiting.note, /^Set\. www\.example\.com will send visitors to example\.com once its DNS reaches it/);
  answers(200);
  const wrong = ok(await o.h('domain.canonical', { domain: 'example.com' }));
  assert.equal(wrong.state, 'waiting');
  assert.match(wrong.note, /answered 200/);
  // an AI's change waits for a person in production (tier 2, a change with undo)
  const ai = await o.a('domain.canonical', { domain: 'example.com' });
  assert.equal(ai.status, 'approval_required');
  assert.match((ai as { why: string }).why, /www\.example\.com sends visitors to example\.com/);
  const none = await o.h('domain.canonical', { domain: 'nothing.example' });
  assert.equal(none.status === 'error' && none.error.code, 'not_found');
});

test('on a Coolify server the redirect is a file of Unit7’s own in Traefik’s folder', async () => {
  const { o, seen } = await shop({ web: 'coolify-proxy|traefik:v3.6' });
  answers();
  const r = ok(await o.h('domain.canonical', { domain: 'example.com' }));
  assert.equal(r.how, 'traefik');
  const www = seen.filter((c) => c.includes('/data/coolify/proxy/dynamic/unit7-www.example.com.yaml')).at(-1)!;
  assert.match(www, /redirectRegex:/);
  assert.match(www, /replacement: '[\\']*https:\/\/example\.com\/\$\{2\}/, 'the file goes through the shell quoted, as data');
  const apex = seen.filter((c) => c.includes('/data/coolify/proxy/dynamic/unit7-example.com.yaml')).at(-1)!;
  assert.doesNotMatch(apex, /redirectRegex/);
  assert.ok(!seen.some((c) => /caddy (validate|reload)/.test(c)));
});

test('Vercel: its own project-domain redirect (301), the main one cleared first', async () => {
  const calls: { method: string; path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const path = new URL(req.url!, 'http://x').pathname;
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (req.method === 'PATCH') calls.push({ method: req.method, path, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(path === '/v2/user' ? { user: { username: 'sam' } } : path === '/v2/teams' ? { teams: [] } : path === '/v10/projects' ? { projects: [] } : { name: path.split('/').pop(), ...body }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.UNIT7_VERCEL_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = ok(await o.h('account.connect', { provider: 'vercel', token: 'vercel-test-token-123' })).accountId;
    for (const h of ['example.com', 'www.example.com']) run(app.db, `INSERT INTO domains (id, org_id, hostname, status, tls, target) VALUES (?, ?, ?, 'active', 'active', ?)`, id('dom'), o.orgId, h, JSON.stringify({ kind: 'vercel', accountId: acc, project: 'site' }));
    answers();
    const r = ok(await o.h('domain.canonical', { domain: 'example.com' }));
    assert.equal(r.how, 'vercel');
    assert.deepEqual(calls, [
      { method: 'PATCH', path: '/v9/projects/site/domains/example.com', body: { redirect: null, redirectStatusCode: null } },
      { method: 'PATCH', path: '/v9/projects/site/domains/www.example.com', body: { redirect: 'example.com', redirectStatusCode: 301 } },
    ]);
    assert.equal(r.state, 'ok');
    assert.equal(target(app, 'www.example.com').redirectTo, 'example.com');
    // a host without a redirect setting: nothing changes, and it says so
    run(app.db, `UPDATE domains SET target = ? WHERE org_id = ?`, JSON.stringify({ kind: 'heroku', accountId: acc, app: 'shop' }), o.orgId);
    answers(200);
    const h = ok(await o.h('domain.canonical', { domain: 'example.com' }));
    assert.equal(h.set, false);
    assert.match(h.note, /Heroku has no redirect setting, so www\.example\.com opens the same app/);
  } finally { server.close(); delete process.env.UNIT7_VERCEL_API; }
});
