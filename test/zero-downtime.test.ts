// Zero downtime, end to end, on the disposable SSH + Docker server (skips without Docker): visitors hammer the app,
// including slow requests that are still running when traffic moves, while a new version deploys. Not one request may
// fail, and Unit7's own proof (from Caddy's log) must say the same: 0 s down, 0 failed requests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { testApp, testOrg, ok } from './helpers.ts';
import { dockerAvailable, startServer } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { get, id, run } from '../src/db.ts';
import { stopWatch } from '../src/deploy/release.ts';

const skip = !dockerAvailable() && 'Docker is not available';
const app = testApp();
let fx: Awaited<ReturnType<typeof startServer>>;
let o: Awaited<ReturnType<typeof testOrg>>;
let envId: string, serverId: string;

// a tiny app: "/" answers at once, "/slow" takes 2 s (so some requests are in flight when traffic moves)
function appTar(version: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-zd-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zd', version: '1.0.0', scripts: { start: 'node server.js' } }));
  writeFileSync(join(dir, 'server.js'), `const http=require('http');http.createServer((q,r)=>{const end=()=>{r.writeHead(200);r.end('v${version}')};q.url==='/slow'?setTimeout(end,2000):end()}).listen(process.env.PORT||3000);`);
  const tgz = join(dir, 'src.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package.json', 'server.js'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return readFileSync(tgz);
}
async function upload(buf: Buffer) {
  const uploadId = id('upl');
  const dir = join(app.home, 'uploads');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uploadId}.tgz`), buf);
  run(app.db, 'INSERT INTO uploads (id, org_id, path, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?)', uploadId, o.orgId, join(dir, `${uploadId}.tgz`), buf.length, createHash('sha256').update(buf).digest('hex'), 'test');
  return uploadId;
}
const hget = (port: number, host: string, path: string) => new Promise<number>((resolve) => {
  const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host }, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
  req.on('error', () => resolve(0)); req.setTimeout(15_000, () => { req.destroy(); resolve(0); }); req.end();
});

before(async () => {
  if (skip) return;
  fx = await startServer();
  o = await testOrg(app);
  envId = ok(await o.h('project.create', { name: 'Zd', environments: ['production'] })).environments[0].id;
  serverId = ok(await o.h('server.connect', { name: 'Box', host: '127.0.0.1', port: fx.sshPort, privateKey: fx.privateKey })).serverId;
  ok(await o.h('server.bootstrap', { serverId }));
}, { timeout: 600_000 });
after(() => { ssh(app).closeAll(); fx?.stop(); });

test('a deploy under load: 0 failed requests, and Unit7’s proof says 0 s down', { skip, timeout: 900_000 }, async () => {
  const svc = ok(await o.h('service.create', { environmentId: envId, name: 'zd', serverId })).serviceId;
  const first = ok(await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(appTar(1)) } }));
  const host = new URL(first.url).host;
  for (let i = 0; i < 20 && (await hget(fx.httpPort, host, '/')) !== 200; i++) await new Promise((r) => setTimeout(r, 500));

  // visitors: a steady stream of quick requests, and slow ones that straddle the switch
  const codes: number[] = [];
  let going = true;
  const loop = async (path: string, every: number) => { while (going) { codes.push(await hget(fx.httpPort, host, path)); await new Promise((r) => setTimeout(r, every)); } };
  const load = [loop('/', 20), loop('/', 35), loop('/slow', 300), loop('/slow', 450)];
  const second = ok(await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(appTar(2)) } }));
  await new Promise((r) => setTimeout(r, 3000)); // the slow ones started right at the end finish too
  going = false;
  await Promise.all(load);
  stopWatch(app, svc, 'test over');

  const failed = codes.filter((c) => c === 0 || c >= 500);
  assert.ok(codes.length > 200, `enough load to mean something (${codes.length} requests)`);
  assert.equal(failed.length, 0, `failed requests during the deploy: ${failed.length} of ${codes.length}`);
  const dep = get<{ downtime_seconds: number | null; failed_requests: number | null; plan: string }>(app.db, 'SELECT downtime_seconds, failed_requests, plan FROM deployments WHERE id = ?', second.deploymentId)!;
  assert.equal(dep.failed_requests, 0, 'Unit7’s own count agrees');
  assert.equal(dep.downtime_seconds, 0);
  assert.ok((JSON.parse(dep.plan).proof?.requests ?? 0) > 0, 'measured from real requests in Caddy’s log');
  assert.equal(await hget(fx.httpPort, host, '/'), 200);
});
