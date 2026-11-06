// The test gate and the database checker end to end, against the disposable SSH + Docker server (skipped where there is
// no Docker). A failing test stops the deploy and the old version keeps serving; a person's "Deploy anyway" ships it. A
// new required column pauses the deploy; a person's "Go ahead anyway" runs it with Postgres's 5-second lock limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { testApp, testOrg, ok } from './helpers.ts';
import { dockerAvailable, startServer } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { get, id, json, run } from '../src/db.ts';

const skip = !dockerAvailable() && 'Docker is not available';
const app = testApp();
let fx: Awaited<ReturnType<typeof startServer>>;
let o: Awaited<ReturnType<typeof testOrg>>;
let envId: string, serverId: string;

function filesTar(files: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-app-'));
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), body); }
  const tgz = join(tmpdir(), `unit7-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', dir, ...Object.keys(files)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return readFileSync(tgz);
}
async function upload(buf: Buffer): Promise<string> {
  const uploadId = id('upl');
  const dir = join(app.home, 'uploads');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${uploadId}.tgz`);
  writeFileSync(path, buf);
  const { createHash } = await import('node:crypto');
  run(app.db, 'INSERT INTO uploads (id, org_id, path, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?)', uploadId, o.orgId, path, buf.length, createHash('sha256').update(buf).digest('hex'), 'test');
  return uploadId;
}
function hget(port: number, host: string): Promise<string> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (d) => (b += d)); res.on('end', () => resolve(b)); });
    req.on('error', () => resolve('')); req.setTimeout(8000, () => req.destroy()); req.end();
  });
}

before(async () => {
  if (skip) return;
  fx = await startServer();
  o = await testOrg(app);
  envId = ok(await o.h('project.create', { name: 'Safe', environments: ['production'] })).environments[0].id;
  serverId = ok(await o.h('server.connect', { name: 'Box', host: '127.0.0.1', port: fx.sshPort, privateKey: fx.privateKey })).serverId;
  ok(await o.h('server.bootstrap', { serverId }));
}, { timeout: 600_000 });
after(() => { ssh(app).closeAll(); fx?.stop(); });

const tested = (v: number, pass: boolean) => ({
  'package.json': JSON.stringify({ name: 'tested', version: '1.0.0', scripts: { start: 'node server.js', test: 'node --test' } }),
  'server.js': `require('http').createServer((_,r)=>{r.writeHead(200);r.end('tested v${v}')}).listen(process.env.PORT||3000)`,
  'math.test.js': `const t=require('node:test'),a=require('node:assert');t('adds two numbers',()=>a.equal(1+1,${pass ? 2 : 3}));t('sees no secrets',()=>a.equal(process.env.SECRET_TOKEN,undefined));`,
});

test('failing tests stop the deploy and the old version keeps serving; "Deploy anyway" is a person’s', { skip, timeout: 900_000 }, async () => {
  const svc = ok(await o.h('service.create', { environmentId: envId, name: 'tested', serverId })).serviceId;
  ok(await o.h('env.set', { serviceId: svc, key: 'SECRET_TOKEN', value: 'sk_live_not_for_tests_123', secret: true }));
  const d1 = ok(await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(tested(1, true))) } }));
  assert.equal(json<{ tests: { status: string } }>(get<{ plan: string }>(app.db, 'SELECT plan FROM deployments WHERE id = ?', d1.deploymentId)!.plan, {} as never).tests.status, 'passed', 'the tests ran without the app’s secrets');
  const host = new URL(d1.url!).host;

  const bad = await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(tested(2, false))) } });
  assert.equal((bad as { error: { code: string } }).error.code, 'tests_failed');
  assert.match((bad as { error: { message: string } }).error.message, /The test “adds two numbers” failed\.$/);
  assert.equal(await hget(fx.httpPort, host), 'tested v1', 'nothing changed');

  assert.equal((await o.a('deployment.create', { serviceId: svc, skipTests: true })).status, 'denied');
  const anyway = ok(await o.h('deployment.create', { serviceId: svc, skipTests: true, source: { type: 'upload', uploadId: await upload(filesTar(tested(2, false))) } }));
  assert.equal(anyway.status, 'live');
});

test('a new required column pauses the deploy; going ahead runs it with the lock limit', { skip, timeout: 900_000 }, async () => {
  const v = (n: number, migrations: Record<string, string>) => ({
    'package.json': JSON.stringify({ name: 'shop', version: '1.0.0', scripts: { start: 'node server.js', migrate: 'node migrate.js' } }),
    'server.js': `require('http').createServer((_,r)=>{r.writeHead(200);r.end('shop v${n}')}).listen(process.env.PORT||3000)`,
    'migrate.js': `console.log('PGOPTIONS='+process.env.PGOPTIONS)`, ...migrations,
  });
  const svc = ok(await o.h('service.create', { environmentId: envId, name: 'shop', serverId })).serviceId;
  ok(await o.h('database.create', { environmentId: envId, engine: 'postgres', name: 'pgshop', injectInto: svc }));
  const init = { 'migrations/0001_init.sql': 'CREATE TABLE orders (id serial, total int);' };
  const d1 = ok(await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(v(1, init))) } }));
  assert.match(get<{ log: string }>(app.db, 'SELECT log FROM deployments WHERE id = ?', d1.deploymentId)!.log, /PGOPTIONS=-c lock_timeout=5s -c statement_timeout=15min/);

  const risky = { ...init, 'migrations/0002_region.sql': 'ALTER TABLE orders ADD COLUMN region text NOT NULL;' };
  const paused = await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(v(2, risky))) } });
  assert.equal((paused as { error: { code: string } }).error.code, 'migration_risky');
  assert.equal(await hget(fx.httpPort, new URL(d1.url!).host), 'shop v1');
  const go = ok(await o.h('deployment.create', { serviceId: svc, allowRiskyMigration: true, source: { type: 'upload', uploadId: await upload(filesTar(v(2, risky))) } }));
  assert.deepEqual(go.migrated, ['migrations/0002_region.sql']);
});
