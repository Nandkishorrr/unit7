// Many servers on real (throwaway) servers: two SSH + Docker boxes from test/fixture.ts. One app on both, visitors spread
// by the front proxy over the boxes' shared private network, a server taken out and put back, a rolling release, and a
// release that breaks on the second server rolled back on the first. Skips without Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { testApp, testOrg, ok } from './helpers.ts';
import { dockerAvailable, startServer } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { get, id, run } from '../src/db.ts';

const skip = !dockerAvailable() && 'Docker is not available';
const app = testApp();
let a: Awaited<ReturnType<typeof startServer>>, b: Awaited<ReturnType<typeof startServer>>;
let o: Awaited<ReturnType<typeof testOrg>>;
let svcId: string, srvA: string, srvB: string;

// v<n> answers with its version and the container it runs in; `crashOnCopies` dies on every server but the main one
function appTar(version: number, crashOnCopies = false): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-fleet-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fleetapp', version: '1.0.0', scripts: { start: 'node server.js' } }));
  writeFileSync(join(dir, 'server.js'), `${crashOnCopies ? "if (process.env.UNIT7_RUN_JOBS === '0') { console.error('boom'); process.exit(1); }\n" : ''}const http=require('http');http.createServer((_,r)=>{r.writeHead(200);r.end('v${version} '+require('os').hostname())}).listen(process.env.PORT||3000);`);
  execFileSync('tar', ['-czf', join(dir, 'src.tgz'), '-C', dir, 'package.json', 'server.js']);
  return readFileSync(join(dir, 'src.tgz'));
}
function upload(buf: Buffer) {
  const uploadId = id('upl'), dir = join(app.home, 'uploads');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uploadId}.tgz`), buf);
  run(app.db, 'INSERT INTO uploads (id, org_id, path, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?)', uploadId, o.orgId, join(dir, `${uploadId}.tgz`), buf.length, createHash('sha256').update(buf).digest('hex'), 'test');
  return uploadId;
}
const useSource = (buf: Buffer) => run(app.db, `UPDATE services SET config = json_set(config, '$.source', json(?)) WHERE id = ?`, JSON.stringify({ type: 'upload', uploadId: upload(buf) }), svcId);
// one visit with the app's Host header (Node's fetch() drops it, so raw http); anything but the app's 200 is 'down'
const visit = (host: string) => new Promise<string>((resolve) => {
  const req = httpRequest({ host: '127.0.0.1', port: a.httpPort, path: '/', headers: { host } }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (d) => (body += d)); res.on('end', () => resolve(res.statusCode === 200 ? body : 'down'));
  });
  req.on('error', () => resolve('down')); req.setTimeout(15_000, () => req.destroy(new Error('timeout'))); req.end();
});
// 24 visits through the main server's proxy: which versions and which containers answered
async function visits() {
  const host = get<{ hostname: string }>(app.db, 'SELECT hostname FROM domains WHERE service_id = ?', svcId)!.hostname;
  const seen: string[] = [];
  for (let k = 0; k < 24; k++) seen.push(await visit(host));
  return { versions: new Set(seen.map((s) => s.split(' ')[0])), hosts: new Set(seen.map((s) => s.split(' ')[1])), down: seen.filter((s) => s === 'down').length };
}

before(async () => {
  if (skip) return;
  [a, b] = await Promise.all([startServer(), startServer()]);
  o = await testOrg(app);
  const envId = ok(await o.h('project.create', { name: 'Fleet', environments: ['production'] })).environments[0].id;
  srvA = ok(await o.h('server.connect', { name: 'Box A', host: '127.0.0.1', port: a.sshPort, privateKey: a.privateKey })).serverId;
  srvB = ok(await o.h('server.connect', { name: 'Box B', host: '127.0.0.1', port: b.sshPort, privateKey: b.privateKey })).serverId;
  ok(await o.h('server.bootstrap', { serverId: srvA }));
  svcId = ok(await o.h('service.create', { environmentId: envId, name: 'fleetapp', serverId: srvA, source: { type: 'upload', uploadId: upload(appTar(1)) } })).serviceId;
  ok(await o.h('deployment.create', { serviceId: svcId }));
}, { timeout: 900_000 });
after(() => { ssh(app).closeAll(); a?.stop(); b?.stop(); });

test('a second server joins (prepared first), and visitors reach both through the front proxy', { skip, timeout: 900_000 }, async () => {
  // the tiny app has no health page, so a person adds it anyway
  const r = ok(await o.h('fleet.add_server', { serviceId: svcId, serverId: srvB, skipChecks: true }));
  assert.equal(r.mode, 'front');
  assert.equal(get<{ kind: string }>(app.db, 'SELECT kind FROM fleet_net WHERE server_id = ?', srvB)!.kind, 'provider', 'the boxes share a private network');
  const v = await visits();
  assert.equal(v.down, 0);
  assert.equal(v.hosts.size, 2, 'both servers answer');
});

test('taken out, the second server gets nothing; put back, it does again', { skip, timeout: 300_000 }, async () => {
  ok(await o.h('fleet.rotate', { serviceId: svcId, serverId: srvB, out: true }));
  const out = await visits();
  assert.equal(out.hosts.size, 1);
  assert.equal(out.down, 0);
  ok(await o.h('fleet.rotate', { serviceId: svcId, serverId: srvB, out: false }));
  assert.equal((await visits()).hosts.size, 2);
});

test('a rolling release puts v2 on both, with nothing down on the way', { skip, timeout: 900_000 }, async () => {
  useSource(appTar(2));
  const r = ok(await o.h('fleet.deploy', { serviceId: svcId }));
  assert.equal(r.status, 'done');
  const v = await visits();
  assert.deepEqual([...v.versions], ['v2']);
  assert.equal(ok(await o.h('fleet.get', { serviceId: svcId })).drift.same, true);
});

test('a release that breaks on the second server stops there, and the main one goes back to v2', { skip, timeout: 900_000 }, async () => {
  useSource(appTar(3, true));
  const r = await o.h('fleet.deploy', { serviceId: svcId });
  assert.equal(r.status, 'error');
  assert.match((r as { error: { message: string } }).error.message, /put the 1 server already done back/);
  const v = await visits();
  assert.deepEqual([...v.versions], ['v2'], 'never half on a broken version');
  assert.equal(v.down, 0);
});

// D3 on real servers: a canary at 50% across both boxes (the proxy's weights and its log), then promoted to every server
test('a canary: v4 gets its share beside v2 through the real proxy, then promoted it reaches both servers', { skip, timeout: 900_000 }, async () => {
  useSource(appTar(4));
  const c = ok(await o.h('fleet.canary', { serviceId: svcId, share: 50, steps: [50, 100] }));
  assert.equal(c.canary.share, 50);
  const v = await visits();
  assert.deepEqual([...v.versions].sort(), ['v2', 'v4'], 'both versions answer while it’s tried');
  assert.equal(v.down, 0);
  const { lookAt } = await import('../src/fleet/canary.ts');
  const svc = get<any>(app.db, 'SELECT * FROM services WHERE id = ?', svcId);
  const row = get<any>(app.db, `SELECT * FROM canaries WHERE service_id = ? ORDER BY created_at DESC LIMIT 1`, svcId);
  const look = await lookAt(app, svc, row);
  assert.ok(look.logRead && look.point.newReq > 0 && look.point.oldReq > 0, 'the proxy’s log says which version answered');
  ok(await o.h('fleet.canary_control', { serviceId: svcId, action: 'promote' }));
  const after = await visits();
  assert.deepEqual([...after.versions], ['v4']);
  assert.equal(after.hosts.size, 2, 'and both servers run it');
});
