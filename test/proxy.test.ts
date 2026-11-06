// A server that already runs Coolify keeps its proxy: Unit7 never takes ports 80/443, never turns on a firewall
// that would cut Coolify's own ports off, and routes its apps through Coolify's Traefik instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions, type ServerRow } from '../src/connectors/ssh.ts';
import { get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { proxyOf, putSite, removeSite, renderTraefik } from '../src/deploy/caddy.ts';

const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
function fakeServer(app: App, reply: (command: string, o: ExecOptions) => ReturnType<typeof done> | undefined = () => undefined) {
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, o = {}) => { seen.push(`${command} ${String(o.stdin ?? '')}`); return reply(command, o) ?? done(); };
  return seen;
}
const COOLIFY = 'coolify-proxy|traefik:v3.6';

test('who holds the web ports decides the proxy', () => {
  assert.deepEqual(proxyOf({}), { kind: 'caddy' }, 'a fresh server: Unit7 starts Caddy');
  assert.deepEqual(proxyOf({ web: 'unit7-caddy|caddy:2' }), { kind: 'caddy' });
  assert.equal(proxyOf({ web: COOLIFY }).kind, 'coolify');
  assert.deepEqual(proxyOf({ web: 'nginx-proxy|nginx:1' }), { kind: 'other', name: 'nginx-proxy' });
  assert.equal(proxyOf({ ports: [22, 80, 443] }).kind, 'other', 'something outside Docker listens on 80');
});

test('a Coolify route: Host rule, HTTPS through its resolver, the app by container name', () => {
  const y = renderTraefik({ hostname: 'app.example.com', upstream: 'shop-web-3', replicas: ['shop-web-4'], port: 3000, tls: 'auto' });
  assert.match(y, /rule: "Host\(`app\.example\.com`\) && !\(PathPrefix\(`\/\.env`\)/, 'Unit7’s own routers leave secret files out');
  assert.match(y, /entryPoints: \[https\]/);
  assert.match(y, /certResolver: letsencrypt/);
  assert.match(y, /redirectScheme:/);
  assert.match(y, /url: "http:\/\/shop-web-3:3000"/);
  assert.match(y, /url: "http:\/\/shop-web-4:3000"/);
  assert.doesNotMatch(renderTraefik({ hostname: 'app.example.com', upstream: 'a', port: 80, tls: 'off' }), /https|certResolver/);
  assert.throws(() => renderTraefik({ hostname: 'app.example.com`) || Host(`evil.com', upstream: 'a', port: 80, tls: 'auto' }));
  assert.throws(() => renderTraefik({ hostname: 'app.example.com', upstream: 'a; rm -rf /', port: 80, tls: 'auto' }));
});

async function server(app: App, facts: object) {
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify(facts));
  return { o, srv, row: get<ServerRow>(app.db, 'SELECT * FROM servers WHERE id = ?', srv)! };
}

test('on a Coolify server a site joins Coolify’s network and lands in Traefik’s folder; no Caddy reload', async () => {
  const app = testApp();
  const { row } = await server(app, { web: COOLIFY });
  const seen = fakeServer(app);
  await putSite(app, row, { hostname: 'app.example.com', upstream: 'shop-web-3', port: 3000, tls: 'auto' });
  assert.ok(seen.some((c) => /docker network connect/.test(c) && /coolify/.test(c) && /shop-web-3/.test(c)));
  assert.ok(seen.some((c) => c.includes('/data/coolify/proxy/dynamic/unit7-app.example.com.yaml') && c.includes('Host(`app.example.com`)')));
  assert.ok(!seen.some((c) => /caddy (validate|reload)/.test(c)));
  await removeSite(app, row, 'app.example.com');
  assert.ok(seen.some((c) => /rm -f/.test(c) && c.includes('/data/coolify/proxy/dynamic/unit7-app.example.com.yaml')));
});

test('when something else owns 80/443, adding a domain says so instead of fighting for the ports', async () => {
  const app = testApp();
  const { row } = await server(app, { web: 'nginx-proxy|nginx:1' });
  fakeServer(app);
  await assert.rejects(putSite(app, row, { hostname: 'app.example.com', upstream: 'a', port: 80, tls: 'auto' }), /belong to nginx-proxy/);
});

test('preparing a Coolify server: no Caddy, no firewall switched on, and it ends ready', async () => {
  const app = testApp();
  const { o, srv } = await server(app, {});
  const seen = fakeServer(app, (command) => {
    if (command.includes('os_id=')) return done(['os=Ubuntu 24.04 LTS', 'os_id=ubuntu', 'docker=27.3.1', 'has=apt-get', 'has=ufw', 'has=systemctl', 'user=root', 'sudo=root',
      `web=${COOLIFY}`, 'ports=22,80,443,6001,6002,8000,8080', 'mem_total=17000000000', 'disk_total=200000000000', 'disk_used=50000000000', 'swap_total=1'].join('\n'));
    if (command.includes('daemon.json')) return done('{"log-driver":"json-file","log-opts":{"max-size":"20m"}}');
    return undefined;
  });
  const r = ok(await o.h('server.bootstrap', { serverId: srv }));
  assert.equal(r.status, 'ready');
  assert.equal(r.proxy, 'coolify');
  assert.ok(!seen.some((c) => /docker run[^\n]*unit7-caddy/.test(c)), 'Unit7’s Caddy never starts');
  assert.ok(!seen.some((c) => /ufw --force enable/.test(c)), 'the firewall is left as it is');
  assert.ok(r.steps.some((s: string) => /Coolify/.test(s)));
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM servers WHERE id = ?', srv)!.status, 'ready');
});
