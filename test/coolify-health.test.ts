// Z8: a Coolify app with no health check gets a finding, and "Add a health check" turns Coolify's own check on with a
// page the app answers on from inside its container, through the gate, with Undo putting the old settings back. A stand-in
// Coolify answers its API; the "server" runs real curl for it and answers the X-ray and the in-container probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { CURL, coolifyTiming, healthOf } from '../src/connectors/coolify.ts';
import { healthProbe } from '../src/tools/coolify.ts';
import { XRAY_PROBE } from '../src/discovery/xray.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';

const TOKEN = '3|unit7testtokenAbC123xyz';
coolifyTiming.pollMs = 5;

function fakeCoolify() {
  const seen: { method: string; path: string; body: any }[] = [];
  const app = { uuid: 'shopapp01', name: 'Shop web', fqdn: 'https://shop.example.com', build_pack: 'nixpacks', status: 'running:healthy', ports_exposes: '3000', health_check_enabled: false, health_check_path: '/' } as Record<string, unknown>;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, 'http://x'), path = url.pathname.replace(/^\/api\/v1/, ''), body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ method: req.method!, path, body });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': typeof b === 'string' ? 'text/plain' : 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Unauthenticated.' });
    const r = `${req.method} ${path}`;
    if (r === 'GET /version') return send(200, '4.4.0');
    if (r === 'GET /team') return send(200, { id: 0, name: 'Sam’s team' });
    if (r === 'GET /servers') return send(200, [{ uuid: 'srvuuid01', name: 'localhost' }]);
    if (r === 'GET /servers/srvuuid01/sentinel') return send(200, { is_metrics_enabled: false });
    if (r === 'POST /deploy') return send(200, { deployments: [{ message: 'Deployment queued.', deployment_uuid: 'dep2' }] });
    if (r === 'GET /deployments/dep2') return send(200, { deployment_uuid: 'dep2', status: 'finished' });
    if (r === 'GET /projects') return send(200, [{ uuid: 'proj01', name: 'Shop' }]);
    if (r === 'GET /projects/proj01') return send(200, { uuid: 'proj01', name: 'Shop', environments: [{ id: 1, name: 'production', uuid: 'env01' }] });
    if (r === 'GET /projects/proj01/env01') return send(200, { applications: [{ ...app }], postgresqls: [], services: [] });
    if (r === 'GET /deployments/applications/shopapp01') return send(200, []);
    if (r === 'GET /applications/shopapp01') return send(200, { ...app });
    if (r === 'PATCH /applications/shopapp01') { Object.assign(app, body); return send(200, { uuid: 'shopapp01' }); }
    send(404, { message: 'Not found.' });
  });
  return new Promise<{ port: number; seen: typeof seen; app: typeof app; close: () => void }>((r) => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as { port: number }).port, seen, app, close: () => server.close() })));
}

// the server: real curl for Coolify's API, the captured X-ray, and the probe inside the app's container
function fakeServer(app: App, port: number, probe: () => string) {
  const calls: string[] = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    const stdin = String(o.stdin ?? '');
    calls.push(command);
    if (stdin === XRAY_PROBE) return { code: 0, stdout: COOLIFY_HOST, stderr: '', truncated: false };
    if (command.includes('docker exec "$c" sh -c')) return { code: 0, stdout: probe(), stderr: '', truncated: false };
    if (command !== CURL) return { code: 0, stdout: '', stderr: '', truncated: false };
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
async function setup(probe = () => '@@path /health 404\n@@path /api/health 404\n@@path /healthz 200\n@@path / 302\n') {
  const app = testApp();
  const c = await fakeCoolify();
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ sudo: 'root' }));
  const calls = fakeServer(app, c.port, probe);
  ok(await o.h('coolify.connect', { serverId: srv, token: TOKEN }));
  ok(await o.h('server.xray', { serverId: srv }));
  return { app, c, o, srv, calls };
}
const healthFinding = (f: { risks: { id: string }[] }) => f.risks.find((x) => x.id.startsWith('xray:coolify-health:'));

test('the probe and Coolify’s fields, read the way Coolify means them', () => {
  assert.deepEqual(healthProbe('@@path /health 404\n@@path /healthz 200\n@@path / 200\n'), { tool: true, path: '/healthz' }, 'a real health page beats /');
  assert.deepEqual(healthProbe('@@path /health 000\n@@path / 301\n'), { tool: true, path: '/' });
  assert.deepEqual(healthProbe('@@path /health 500\n@@path / 500\n'), { tool: true, path: undefined });
  assert.deepEqual(healthProbe('@@none\n'), { tool: false });
  assert.deepEqual(healthOf({ health_check_enabled: false, health_check_path: '/', custom_healthcheck_found: true }), { enabled: false, path: '/', custom: true });
});

test('a Coolify app with no health check: the finding, the gated fix with the probe, then Undo', async () => {
  const { c, o, srv, calls, app } = await setup();
  try {
    const f = healthFinding(ok(await o.h('server.findings', { serverId: srv })))! as any;
    assert.ok(f, 'the finding is there');
    assert.equal(f.detail, 'Coolify can’t swap versions safely for this app: it has no health check, so visitors can see errors during a deploy.');
    assert.equal(f.title, 'Coolify can’t swap versions safely for Shop web');
    assert.deepEqual([f.fix.tool, f.fix.label, f.fix.input.uuid], ['coolify.health_check', 'Add a health check', 'shopapp01']);

    // an AI asks first (a live app's settings, tier 2)
    assert.equal((await o.a('coolify.health_check', f.fix.input)).status, 'approval_required');
    assert.ok(!c.seen.some((x) => x.method === 'PATCH'), 'nothing changed yet');

    const r = ok(await o.h('coolify.health_check', f.fix.input));
    assert.deepEqual(c.seen.find((x) => x.method === 'PATCH')!.body, { health_check_enabled: true, health_check_path: '/healthz' }, 'Coolify’s own fields, with the page that answered');
    assert.deepEqual(r.next, { tool: 'coolify.control', input: { serverId: srv, uuid: 'shopapp01', action: 'deploy' }, label: 'Deploy again to test it' });
    const probe = calls.find((x) => x.includes('docker exec "$c" sh -c'))!;
    assert.ok(probe.includes(`'3000'`) && probe.includes(`'/healthz'`), 'probed inside the container on the app’s own port');
    assert.equal(healthFinding(ok(await o.h('server.findings', { serverId: srv }))), undefined, 'the finding goes away at once');
    assert.equal((ok(await o.h('coolify.health_check', f.fix.input)) as { changed: boolean }).changed, false, 'twice changes nothing');

    // the deploy to test it, through Coolify
    assert.equal(ok(await o.h('coolify.control', r.next.input)).status, 'finished');

    // Undo: the settings Coolify had before
    const ch = get<{ status: string }>(app.db, 'SELECT status FROM changes WHERE id = ?', r.changeId)!;
    assert.equal(ch.status, 'done');
    ok(await o.h('change.undo', { changeId: r.changeId }));
    assert.deepEqual(c.seen.filter((x) => x.method === 'PATCH').at(-1)!.body, { health_check_enabled: false, health_check_path: '/' });
    assert.equal(c.app.health_check_enabled, false);
  } finally { c.close(); }
});

test('no curl or wget in the image, or no page that answers: said plainly, nothing changed', async () => {
  let out = '@@none\n';
  const { c, o, srv } = await setup(() => out);
  try {
    const input = { serverId: srv, uuid: 'shopapp01' };
    const none = await o.h('coolify.health_check', input);
    assert.equal((none as { error: { code: string } }).error.code, 'no_probe_tool');
    assert.match((none as { error: { message: string } }).error.message, /has neither, so turning it on would fail every deploy/);
    out = '@@path /health 404\n@@path /api/health 404\n@@path /healthz 404\n@@path / 500\n';
    assert.equal(((await o.h('coolify.health_check', input)) as { error: { code: string } }).error.code, 'no_health_page');
    assert.ok(!c.seen.some((x) => x.method === 'PATCH'), 'Coolify was never changed');
  } finally { c.close(); }
});

test('apps that already check their health get no finding: on in Coolify, or the Dockerfile’s own HEALTHCHECK', async () => {
  const { c, o, srv } = await setup();
  try {
    c.app.custom_healthcheck_found = true;
    ok(await o.h('server.xray', { serverId: srv }));
    assert.equal(healthFinding(ok(await o.h('server.findings', { serverId: srv }))), undefined);
    c.app.custom_healthcheck_found = false; c.app.health_check_enabled = true;
    ok(await o.h('server.xray', { serverId: srv }));
    assert.equal(healthFinding(ok(await o.h('server.findings', { serverId: srv }))), undefined);
  } finally { c.close(); }
});
