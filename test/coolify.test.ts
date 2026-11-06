// Coolify through its own API, called inside the server over SSH. A stand-in Coolify answers like v4.4; the
// "server" runs real curl with the config Unit7 sends on stdin, so the token is checked to never be on a
// command line. Connecting, projects, a deploy followed to its end, settings with Coolify's exact field names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { get, id, json, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { CURL, coolifyTiming, curlConfig } from '../src/connectors/coolify.ts';
import { XRAY_PROBE } from '../src/discovery/xray.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';

const TOKEN = '3|unit7testtokenAbC123xyz', LOOK_ONLY = '4|unit7lookonlytoken0000';
coolifyTiming.pollMs = 5;

function fakeCoolify() {
  const seen: { method: string; path: string; body: any }[] = [];
  let polls = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, 'http://x'), path = url.pathname.replace(/^\/api\/v1/, ''), body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ method: req.method!, path: path + url.search, body });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': typeof b === 'string' ? 'text/plain' : 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    const look = req.headers.authorization === `Bearer ${LOOK_ONLY}`;
    if (req.headers.authorization !== `Bearer ${TOKEN}` && !look) return send(401, { message: 'Unauthenticated.' });
    const r = `${req.method} ${path}`;
    if (look && (r === 'POST /deploy' || /\/(start|stop|restart|rollback)$/.test(path))) return send(403, { message: 'Missing required permissions: deploy' });
    if (look && r === 'GET /servers/srvuuid01/sentinel') return send(200, { is_metrics_enabled: false });
    if (r === 'GET /version') return send(200, '4.4.0');
    if (r === 'GET /team') return send(200, { id: 0, name: 'Sam’s team' });
    if (r === 'GET /servers') return send(200, [{ uuid: 'srvuuid01', name: 'localhost' }]);
    if (r === 'GET /servers/srvuuid01/sentinel') return send(200, { sentinel_token: 'sentinel-token-value-1', is_metrics_enabled: false });
    if (r === 'POST /deploy') return url.searchParams.get('uuid') ? send(200, { deployments: [{ message: 'Deployment queued.', resource_uuid: url.searchParams.get('uuid'), deployment_uuid: 'dep2' }] }) : send(400, { message: 'You must provide uuid or tag.' });
    if (r === 'GET /deployments/dep2') return send(200, { deployment_uuid: 'dep2', status: ++polls < 3 ? 'in_progress' : 'finished', commit: 'abc1234def9' });
    if (r === 'GET /projects') return send(200, [{ uuid: 'proj01', name: 'Shop', description: 'the store' }]);
    if (r === 'GET /projects/proj01') return send(200, { uuid: 'proj01', name: 'Shop', environments: [{ id: 1, name: 'production', uuid: 'env01' }] });
    if (r === 'GET /projects/proj01/env01') return send(200, {
      applications: [{ uuid: 'shopapp01', name: 'Shop web', fqdn: 'https://shop.example.com,https://www.shop.example.com', git_repository: 'example/shop', git_branch: 'main', build_pack: 'nixpacks', status: 'running:healthy' }],
      postgresqls: [], services: [{ uuid: 'shopsupa01', name: 'Shop Supabase', service_type: 'supabase', status: 'running:healthy' }],
    });
    if (r === 'GET /deployments/applications/shopapp01') return send(200, [{ deployment_uuid: 'dep1', status: 'finished', commit: 'abc1234def9', commit_message: 'Fix checkout', created_at: '2026-10-05T10:00:00Z' }, { deployment_uuid: 'dep0', status: 'finished', commit: '0ld0ld0ld0ld', created_at: '2026-10-01T10:00:00Z' }]);
    if (r === 'GET /applications/shopapp01/envs') return send(200, [{ uuid: 'env1', key: 'API_URL', value: 'https://api.example.com', is_preview: false, is_literal: false }, { uuid: 'env2', key: 'API_URL', value: 'https://preview.example.com', is_preview: true }]);
    if (/^(POST|PATCH) \/applications\/shopapp01\/envs$/.test(r)) return send(201, { uuid: 'env9' });
    if (r === 'DELETE /applications/shopapp01/envs/env1') return send(200, { message: 'Environment variable deleted.' });
    if (r === 'POST /applications/shopapp01/rollback') return send(200, { message: 'Rollback queued.', deployment_uuid: 'dep2' });
    send(404, { message: 'Not found.' });
  });
  return new Promise<{ port: number; seen: typeof seen; close: () => void }>((r) => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as { port: number }).port, seen, close: () => server.close() })));
}

// the server: real curl for Coolify's API, the captured X-ray for the probe
function fakeServer(app: App, port: number) {
  const calls: { command: string; stdin: string }[] = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    const stdin = String(o.stdin ?? '');
    calls.push({ command, stdin });
    if (stdin === XRAY_PROBE) return { code: 0, stdout: COOLIFY_HOST, stderr: '', truncated: false };
    if (command !== CURL) throw new Error(`unexpected command: ${command}`);
    return new Promise((resolve) => {
      const p = spawn('curl', ['-K', '-']);
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
      p.stdin.end(stdin.replace('http://127.0.0.1:8000/', `http://127.0.0.1:${port}/`));
    });
  };
  return calls;
}
async function setup() {
  const app = testApp();
  const c = await fakeCoolify();
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ sudo: 'root' }));
  return { app, c, o, srv, calls: fakeServer(app, c.port) };
}

test('the curl config escapes what it carries, so a value can’t add a line of its own', () => {
  const cfg = curlConfig({ url: 'http://127.0.0.1:8000/api/v1/x', method: 'POST', token: 'a"b\\c', body: { value: 'line1\nurl = "http://elsewhere.example.com"' } });
  assert.match(cfg, /^header = "Authorization: Bearer a\\"b\\\\c"$/m);
  assert.equal(cfg.split('\n').filter((l) => l.startsWith('url = ')).length, 1, 'one url, whatever the value says');
});

test('connect Coolify: three steps with links, then a pasted token is checked, its abilities found, and never put on a command line', async () => {
  const { c, o, srv, calls, app } = await setup();
  try {
    const steps = ok(await o.h('coolify.connect', { serverId: srv }));
    assert.equal(steps.found, true);
    assert.equal(steps.version, '4.4.0');
    assert.equal(steps.connected, null);
    assert.equal(steps.projects, 4, 'found by its labels before connecting');
    assert.deepEqual(steps.steps.map((s: { url?: string }) => s.url), ['https://coolify.example.com/settings/advanced', 'https://coolify.example.com/security/api-tokens', undefined]);

    const agent = await o.a('coolify.connect', { serverId: srv, token: TOKEN });
    assert.equal(agent.status, 'denied', 'an AI never handles the token');

    const r = ok(await o.h('coolify.connect', { serverId: srv, token: TOKEN }));
    assert.equal(r.status, 'verified');
    assert.equal(r.version, '4.4.0');
    assert.equal(r.team, 'Sam’s team');
    assert.deepEqual(r.abilities, ['read', 'read:sensitive', 'deploy']);
    assert.ok(c.seen.some((x) => x.method === 'POST' && x.path === '/deploy' && !x.body?.uuid), 'deploy permission probed without deploying anything');
    const acc = get<{ id: string; meta: string; name: string }>(app.db, `SELECT id, meta, name FROM accounts WHERE provider = 'coolify'`)!;
    assert.equal(json<{ serverId: string }>(acc.meta, { serverId: '' }).serverId, srv);
    assert.equal(acc.name, 'Coolify on box');
    assert.equal(app.vault.resolve(o.orgId, `credential://coolify/${acc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/token`), TOKEN, 'kept in the vault');

    // the token went to curl on stdin only: never in a command, never in audit or events
    assert.ok(calls.length > 3);
    assert.ok(calls.every((x) => !x.command.includes(TOKEN)), 'never on a command line');
    assert.ok(calls.some((x) => x.command === CURL && x.stdin.includes(`Bearer ${TOKEN}`)));
    assert.doesNotMatch(JSON.stringify([...app.db.prepare('SELECT * FROM audit').all(), ...app.db.prepare('SELECT * FROM events').all()]), /unit7testtoken/);

    // now the X-ray uses Coolify's own names and domains, and its things are managed through it
    const x = ok(await o.h('server.xray', { serverId: srv }));
    const shop = x.projects.find((p: { coolify?: { uuid: string } }) => p.coolify?.uuid === 'proj01');
    assert.equal(shop.name, 'Shop');
    assert.equal(shop.trust, 'managed');
    const web = x.parts.find((p: { id: string }) => p.id === 'coolify:shopapp01');
    assert.equal(web.name, 'Shop web');
    assert.deepEqual([web.coolify.repo, web.coolify.branch, web.coolify.lastDeploy.status], ['example/shop', 'main', 'finished']);
    assert.ok(x.parts.some((p: { id: string; via: string }) => p.id === 'd:www.shop.example.com' && p.via === 'added in Coolify'), 'a domain only Coolify knows');
    assert.equal(x.coolify.connected, acc.id);
  } finally { c.close(); }
});

test('projects, a deploy followed to the end, settings by Coolify’s field names, and stop asks first', async () => {
  const { c, o, srv } = await setup();
  try {
    ok(await o.h('coolify.connect', { serverId: srv, token: TOKEN }));
    const t = ok(await o.h('coolify.projects', { serverId: srv }));
    const app = t.projects[0].environments[0].resources.find((r: { kind: string }) => r.kind === 'application');
    assert.deepEqual([app.name, app.fqdn, app.buildPack, app.lastDeploy.commit], ['Shop web', ['shop.example.com', 'www.shop.example.com'], 'nixpacks', 'abc1234def9']);
    assert.equal(t.projects[0].environments[0].resources.find((r: { kind: string }) => r.kind === 'service').type, 'supabase');

    const d = ok(await o.a('coolify.control', { serverId: srv, uuid: 'shopapp01', action: 'deploy' }));
    assert.equal(d.deployment, 'dep2');
    assert.equal(d.status, 'finished', 'polled until Coolify said finished');
    assert.ok(c.seen.filter((x) => x.path === '/deployments/dep2').length >= 3);

    // roll back: by default to the deploy before the live one
    ok(await o.h('coolify.control', { serverId: srv, uuid: 'shopapp01', action: 'rollback' }));
    assert.deepEqual(c.seen.find((x) => x.path.endsWith('/rollback'))!.body, { commit: '0ld0ld0ld0ld' });

    const stop = await o.a('coolify.control', { serverId: srv, uuid: 'shopapp01', action: 'stop' });
    assert.equal(stop.status, 'approval_required', 'taking an app offline asks first');

    const list = ok(await o.a('coolify.envs', { serverId: srv, uuid: 'shopapp01' }));
    assert.deepEqual(list.map((e: { key: string; preview: boolean }) => `${e.key}:${e.preview}`), ['API_URL:false', 'API_URL:true']);
    assert.doesNotMatch(JSON.stringify(list), /api\.example\.com|preview\.example\.com/, 'names only, never values');

    ok(await o.h('coolify.envs', { serverId: srv, uuid: 'shopapp01', op: 'set', key: 'API_URL', value: 'https://api2.example.com', buildtime: false }));
    const patch = c.seen.find((x) => x.method === 'PATCH')!;
    assert.deepEqual(patch.body, { key: 'API_URL', value: 'https://api2.example.com', is_preview: false, is_buildtime: false }, 'an existing key is updated, with Coolify’s exact field names');
    const set = ok(await o.h('coolify.envs', { serverId: srv, uuid: 'shopapp01', op: 'set', key: 'NEW_FLAG', value: 'on' }));
    assert.equal(set.added, true);
    assert.match(set.next, /deploy/);
    ok(await o.h('coolify.envs', { serverId: srv, uuid: 'shopapp01', op: 'unset', key: 'API_URL' }));
    assert.ok(c.seen.some((x) => x.method === 'DELETE' && x.path === '/applications/shopapp01/envs/env1'), 'the production copy, not its preview twin');

    const reveal = await o.a('coolify.envs', { serverId: srv, uuid: 'shopapp01', op: 'reveal', key: 'API_URL' });
    assert.equal(reveal.status, 'denied', 'values are for people only');
    const shown = ok(await o.h('coolify.envs', { serverId: srv, uuid: 'shopapp01', op: 'reveal', key: 'API_URL' }));
    assert.equal(shown.value, 'https://api.example.com');
  } finally { c.close(); }
});

test('a refused token and a missing permission say what to do in plain words', async () => {
  const { c, o, srv } = await setup();
  try {
    const r = ok(await o.h('coolify.connect', { serverId: srv, token: '9|wrongtokenwrongtoken' }));
    assert.equal(r.status, 'failing');
    assert.match(r.problem, /refused Unit7's token/);
    const look = ok(await o.h('coolify.connect', { serverId: srv, token: LOOK_ONLY }));
    assert.deepEqual(look.abilities, ['read'], 'a new token replaces the old one');
    assert.match(look.note, /can only look/);
    const d = await o.h('coolify.control', { serverId: srv, uuid: 'shopapp01', action: 'deploy' });
    assert.equal(d.status, 'error');
    assert.match((d as { error: { message: string } }).error.message, /needs the "deploy" permission/);
  } finally { c.close(); }
});
