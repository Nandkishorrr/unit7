// End-to-end deploy against the disposable SSH+Docker server: upload a tiny app, build it, health
// gate, serve it through Caddy, break it and confirm the old version keeps serving, then roll back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { dockerAvailable, startServer } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { script } from '../src/connectors/shell.ts';
import { detect } from '../src/connectors/detect.ts';
import { dockerfileFor } from '../src/deploy/dockerfiles.ts';
import { renderSite, hashedPath } from '../src/deploy/caddy.ts';
import { replicaNames } from '../src/deploy/deployer.ts';
import { scaleRisks, runsDevServer } from '../src/connectors/detect.ts';
import { summarizeAccessLog } from '../src/sentinel/warden.ts';
import { all, get, run, id } from '../src/db.ts';
import { request as httpRequest } from 'node:http';
declare global { var __appHost: string | undefined; }

// Node's fetch() forbids setting the Host header, so route-by-host tests use raw http.
function hget(port: number, host: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (d) => (body += d)); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.setTimeout(8000, () => req.destroy(new Error('timeout'))); req.end();
  });
}
// The first request after `caddy reload` can race it; retry briefly past a catch-all 421.
async function hgetRetry(port: number, host: string, path = '/', tries = 6): Promise<{ status: number; body: string }> {
  let last = { status: 0, body: '' };
  for (let i = 0; i < tries; i++) { last = await hget(port, host, path).catch(() => ({ status: 0, body: '' })); if (last.status && last.status !== 421) return last; await new Promise((r) => setTimeout(r, 1000)); }
  return last;
}

const skip = !dockerAvailable() && 'Docker is not available';
const app = testApp();
let fx: Awaited<ReturnType<typeof startServer>>;
let o: Awaited<ReturnType<typeof testOrg>>;
let envId: string, serverId: string, appId: string;

// a one-file Node app that returns env + a version string; version 2 will crash to test the gate
function appTar(version: number, crash = false): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-app-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tinyapp', version: '1.0.0', scripts: { start: 'node server.js' } }));
  writeFileSync(join(dir, 'server.js'), crash
    ? `console.error('boom: missing config'); process.exit(1);`
    : `const http=require('http');const p=process.env.PORT||3000;http.createServer((_,r)=>{r.writeHead(200);r.end('v${version} db='+(process.env.DATABASE_URL?'set':'unset')+' host='+require('os').hostname())}).listen(p,()=>console.log('up on '+p));`);
  const tgz = join(dir, 'src.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package.json', 'server.js']);
  return readFileSync(tgz);
}

// a one-file app from raw server.js source (for self-heal cases)
function customTar(serverJs: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-app-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'healme', version: '1.0.0', scripts: { start: 'node server.js' } }));
  writeFileSync(join(dir, 'server.js'), serverJs);
  const tgz = join(dir, 'src.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package.json', 'server.js']);
  return readFileSync(tgz);
}

// an app from several files ({path: content}), packed like `unit7 deploy` does
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

before(async () => {
  if (skip) return;
  fx = await startServer();
  o = await testOrg(app);
  const proj = ok(await o.h('project.create', { name: 'Tiny', environments: ['production'] }));
  envId = proj.environments[0].id;
  serverId = ok(await o.h('server.connect', { name: 'Box', host: '127.0.0.1', port: fx.sshPort, privateKey: fx.privateKey })).serverId;
  ok(await o.h('server.bootstrap', { serverId }));
}, { timeout: 600_000 });
after(() => { ssh(app).closeAll(); fx?.stop(); });

test('detect + dockerfile generation (no server needed)', () => {
  const d = detect({ files: ['package.json', 'next.config.js'], manifests: { 'package.json': JSON.stringify({ dependencies: { next: '15' }, scripts: { build: 'next build', start: 'next start' } }) } });
  assert.equal(d.stack, 'next');
  assert.ok(dockerfileFor(d, [])!.includes('FROM node'));
  const vite = detect({ files: ['package.json', 'vite.config.ts', 'index.html'], manifests: { 'package.json': JSON.stringify({ devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }) } });
  assert.equal(vite.builder, 'static');
  assert.ok(dockerfileFor(vite, [])!.includes('caddy'));
  const fastapi = detect({ files: ['main.py', 'requirements.txt'], manifests: { 'requirements.txt': 'fastapi\nuvicorn' } });
  assert.equal(fastapi.stack, 'python-fastapi');
  // env scanning
  const scanned = detect({ files: ['index.js'], manifests: {}, sourceSample: 'process.env.STRIPE_SECRET_KEY; process.env.DATABASE_URL;' });
  assert.deepEqual(scanned.envKeys.sort(), ['DATABASE_URL', 'STRIPE_SECRET_KEY']);
  assert.ok(scanned.needs.includes('postgres'));
});

test('caddy site render blocks bad upstreams and lists blocked IPs', () => {
  const site = renderSite({ hostname: 'app.example.com', upstream: 'unit7-app-1', port: 3000, tls: 'auto', blocked: ['1.2.3.4', '5.6.7.0/24'] });
  assert.match(site, /reverse_proxy unit7-app-1:3000/);
  assert.match(site, /remote_ip 1\.2\.3\.4 5\.6\.7\.0\/24/);
  assert.throws(() => renderSite({ hostname: 'x', upstream: 'bad name; rm', port: 80, tls: 'off' }));
});

test('deploy an app end to end, with a database wired in', { skip, timeout: 600_000 }, async () => {
  appId = ok(await o.h('service.create', { environmentId: envId, name: 'web', serverId })).serviceId;
  // a postgres whose connection URL is wired into the app as a vault reference
  const dbRes = ok(await o.h('database.create', { environmentId: envId, engine: 'postgres', injectInto: appId }));
  assert.match(dbRes.connectionUrl, /^credential:\/\/postgres\//);
  const up = await upload(appTar(1));
  const dep = ok(await o.h('deployment.create', { serviceId: appId, source: { type: 'upload', uploadId: up } }));
  assert.equal(dep.status, 'live');
  assert.ok(dep.url, 'got an auto URL');
  // Caddy serves it on the fixture's mapped port 80, addressed by the sslip host
  const host = new URL(dep.url!).host;
  const res = await hgetRetry(fx.httpPort, host);
  assert.equal(res.status, 200);
  assert.match(res.body, /^v1/);
  assert.match(res.body, /db=set/); // DATABASE_URL reference resolved at deploy time
});

test('a broken new version never reaches users (health gate + auto-rollback)', { skip, timeout: 600_000 }, async () => {
  appId ??= get<{ id: string }>(app.db, "SELECT id FROM services WHERE slug = 'web' AND org_id = ?", o.orgId)!.id;
  const host = get<{ hostname: string }>(app.db, 'SELECT hostname FROM domains WHERE service_id = ?', appId)!.hostname;
  // deploy v2 that crashes on boot
  const up = await upload(appTar(2, true));
  const bad = await o.h('deployment.create', { serviceId: appId, source: { type: 'upload', uploadId: up } });
  assert.equal(bad.status, 'error');
  assert.match((bad as any).error.message, /health check|didn't pass|kept the previous/i);
  // users still get v1
  assert.match((await hgetRetry(fx.httpPort, host)).body, /^v1/);
  // deploy a good v3, then roll back to v1's deployment
  const up3 = await upload(appTar(3));
  ok(await o.h('deployment.create', { serviceId: appId, source: { type: 'upload', uploadId: up3 } }));
  assert.match((await hgetRetry(fx.httpPort, host)).body, /^v3/);
  ok(await o.h('deployment.rollback', { serviceId: appId }));
  assert.match((await hgetRetry(fx.httpPort, host)).body, /^v1/);
});

test('two copies behind the load balancer, then back to one', { skip, timeout: 600_000 }, async () => {
  appId ??= get<{ id: string }>(app.db, "SELECT id FROM services WHERE slug = 'web' AND org_id = ?", o.orgId)!.id;
  const host = get<{ hostname: string }>(app.db, 'SELECT hostname FROM domains WHERE service_id = ?', appId)!.hostname;
  assert.equal(ok(await o.h('service.scale', { serviceId: appId, replicas: 2 })).replicas, 2);
  const seen = new Set<string>();
  for (let k = 0; k < 30 && seen.size < 2; k++) seen.add(/host=(\S+)/.exec((await hgetRetry(fx.httpPort, host)).body)?.[1] ?? '');
  assert.equal(seen.size, 2, 'both copies answered');
  ok(await o.h('service.scale', { serviceId: appId, replicas: 1 }));
  const names = ok<any[]>(await o.h('docker.list', { serverId })).map((c) => c.Names ?? c.Name).join(' ');
  assert.doesNotMatch(names, /-r2\b/);
  assert.equal((await hgetRetry(fx.httpPort, host)).status, 200);
});

test('self-heal: a missing secret and a wrong port are fixed, and the deploy goes live', { skip, timeout: 900_000 }, async () => {
  // 1. crashes on boot without SESSION_SECRET → Unit7 generates one and redeploys
  const a = ok(await o.h('service.create', { environmentId: envId, name: 'needs-secret', serverId })).serviceId;
  const crashy = `if(!process.env.SESSION_SECRET){console.error('Error: Missing environment variable: SESSION_SECRET');process.exit(1)}
require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok len='+process.env.SESSION_SECRET.length)}).listen(process.env.PORT||3000)`;
  const d1 = ok(await o.h('deployment.create', { serviceId: a, source: { type: 'upload', uploadId: await upload(customTar(crashy)) } }));
  assert.equal(d1.status, 'live');
  assert.deepEqual(d1.healed, ['generated SESSION_SECRET']);
  assert.match((await hgetRetry(fx.httpPort, new URL(d1.url!).host)).body, /^ok len=4\d/);

  // 2. always listens on 8080, whatever PORT says → Unit7 points traffic at 8080
  const b = ok(await o.h('service.create', { environmentId: envId, name: 'odd-port', serverId })).serviceId;
  const odd = `require('http').createServer((_,r)=>{r.writeHead(200);r.end('odd ok')}).listen(8080,()=>console.log('Server listening on port 8080'))`;
  const d2 = ok(await o.h('deployment.create', { serviceId: b, source: { type: 'upload', uploadId: await upload(customTar(odd)) } }));
  assert.equal(d2.status, 'live');
  assert.deepEqual(d2.healed, ['pointed traffic at port 8080, where the app listens']);
  assert.equal((await hgetRetry(fx.httpPort, new URL(d2.url!).host)).body, 'odd ok');
});

test('migrations run once before traffic moves; a data-losing one waits for an OK; the backup restores', { skip, timeout: 900_000 }, async () => {
  const app1 = { 'package.json': JSON.stringify({ name: 'mig', version: '1.0.0', scripts: { start: 'node server.js', migrate: 'node migrate.js' } }),
    'server.js': `require('http').createServer((_,r)=>{r.writeHead(200);r.end('mig v1')}).listen(process.env.PORT||3000)`,
    'migrate.js': `console.log('MIGRATE ran with DATABASE_URL='+(process.env.DATABASE_URL?'set':'unset'))`,
    'migrations/0001_init.sql': 'CREATE TABLE items (id serial, name text);' };
  const svc = ok(await o.h('service.create', { environmentId: envId, name: 'mig', serverId })).serviceId;
  const pg = ok(await o.h('database.create', { environmentId: envId, engine: 'postgres', name: 'pgmig', injectInto: svc })).serviceId;

  const d1 = ok(await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(app1)) } }));
  assert.deepEqual(d1.migrated, ['migrations/0001_init.sql']);
  const log1 = get<{ log: string }>(app.db, 'SELECT log FROM deployments WHERE id = ?', d1.deploymentId)!.log;
  assert.match(log1, /MIGRATE ran with DATABASE_URL=set/);
  assert.ok(ok<any[]>(await o.h('backup.list', { serviceId: pg })).some((b) => /before migrating mig/.test(b.reason)), 'backed up before migrating');
  const host = new URL(d1.url!).host;

  // v2 drops a column: Unit7 stops before running it, and v1 keeps serving
  const app2 = { ...app1, 'server.js': app1['server.js'].replace('mig v1', 'mig v2'), 'migrations/0002_drop.sql': 'ALTER TABLE items DROP COLUMN name;' };
  const blocked = await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(app2)) } });
  assert.equal(blocked.status, 'error');
  assert.equal((blocked as any).error.code, 'migration_needs_ok');
  assert.match((blocked as any).error.message, /0002_drop\.sql: ALTER TABLE items DROP COLUMN name/);
  assert.equal((await hgetRetry(fx.httpPort, host)).body, 'mig v1');
  const { suggestions } = await import('../src/suggestions.ts');
  assert.ok(suggestions(app, o.orgId).some((x) => x.id === `migration:${svc}`), 'a one-click "back up & run it" is offered');

  // an AI asking to run it needs a person's approval; a person's click runs it
  assert.equal((await o.a('deployment.create', { serviceId: svc, allowDestructiveMigration: true, source: { type: 'upload', uploadId: await upload(filesTar(app2)) } })).status, 'approval_required');
  const d3 = ok(await o.h('deployment.create', { serviceId: svc, allowDestructiveMigration: true, source: { type: 'upload', uploadId: await upload(filesTar(app2)) } }));
  assert.deepEqual(d3.migrated, ['migrations/0002_drop.sql']);
  assert.equal((await hgetRetry(fx.httpPort, host)).body, 'mig v2');

  // and the backup taken before migrating really restores
  const v = ok(await o.h('backup.verify', { serviceId: pg }));
  assert.equal(v.ok, true, v.note);
});

test('Redis backups are real snapshots that restore (they used to save Docker\'s tar wrapper)', { skip, timeout: 300_000 }, async () => {
  const r = ok(await o.h('database.create', { environmentId: envId, engine: 'redis', name: 'cache' })).serviceId;
  ok(await o.h('backup.create', { serviceId: r, reason: 'test' }));
  const v = ok(await o.h('backup.verify', { serviceId: r }));
  assert.equal(v.ok, true, v.note);
});

test('a real credential in the code blocks the deploy; placeholders do not', { skip, timeout: 600_000 }, async () => {
  // built at runtime: a GitHub-token-shaped string that isn't a real token, and isn't in this repo
  const alnum = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const fake = 'gh' + 'p_' + Array.from({ length: 36 }, (_, k) => alnum[(k * 7 + 3) % alnum.length]).join('');
  const svc = ok(await o.h('service.create', { environmentId: envId, name: 'leaky', serverId })).serviceId;
  const leaky = { 'package.json': JSON.stringify({ name: 'leaky', version: '1.0.0', scripts: { start: 'node server.js' } }),
    'server.js': `const token = '${fake}';\nrequire('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(process.env.PORT||3000)` };
  const blocked = await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(leaky)) } });
  assert.equal(blocked.status, 'error');
  assert.equal((blocked as any).error.code, 'secrets_in_code');
  assert.match((blocked as any).error.message, /server\.js:1 \(github-pat\)/);
  assert.ok(!(blocked as any).error.message.includes(fake), 'the secret itself is never echoed');

  // the same token as a placeholder in an example file and a test fixture: deploys fine
  const clean = { 'package.json': leaky['package.json'], 'server.js': `require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(process.env.PORT||3000)`,
    '.env.example': `GITHUB_TOKEN=${fake}\n`, 'test/fixtures/token.json': JSON.stringify({ token: fake }) };
  assert.equal(ok(await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(clean)) } })).status, 'live');
});

test('trivy scans the running image (set UNIT7_TEST_TRIVY=1: downloads its database once)', { skip: skip || (!process.env.UNIT7_TEST_TRIVY && 'set UNIT7_TEST_TRIVY=1'), timeout: 1_200_000 }, async () => {
  const svc = get<{ id: string }>(app.db, "SELECT id FROM services WHERE slug = 'leaky' AND org_id = ?", o.orgId)!.id;
  const rep = ok(await o.h('security.scan', { serviceId: svc }));
  assert.equal(typeof rep.critical, 'number');
  assert.ok(rep.scannedAt);
});

test('errors in the logs become one plain-words group with a fix button', { skip, timeout: 600_000 }, async () => {
  const svc = ok(await o.h('service.create', { environmentId: envId, name: 'buggy', serverId })).serviceId;
  const buggy = { 'package.json': JSON.stringify({ name: 'buggy', version: '1.0.0', scripts: { start: 'node server.js' } }),
    'server.js': `require('http').createServer((req,r)=>{ if(req.url==='/boom'){ try { const cart=null; cart.map(x=>x) } catch(e){ console.error(e) } r.writeHead(500); return r.end('boom') }
r.writeHead(200); r.end('ok') }).listen(process.env.PORT||3000)` };
  const d = ok(await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(buggy)) } }));
  const host = new URL(d.url!).host;
  for (let k = 0; k < 4; k++) assert.equal((await hgetRetry(fx.httpPort, host, '/boom')).status, 500);
  const scan = ok(await o.h('errors.scan', { serviceId: svc }));
  assert.equal(scan.updated.length, 1, 'four occurrences, one group');
  assert.equal(scan.updated[0].added, 4);
  const [g] = ok<any[]>(await o.h('errors.list', { serviceId: svc }));
  assert.equal(g.kind, 'TypeError');
  assert.match(g.message, /Cannot read properties of null \(reading 'map'\)/);
  assert.match(g.frame, /server\.js:1$/);
  assert.equal(g.lastHour, 4);
  const { suggestions } = await import('../src/suggestions.ts');
  const sug = suggestions(app, o.orgId).find((x) => x.id === `error:${g.id}`)!;
  assert.match(sug.text, /buggy: TypeError in .*server\.js:1 — "Cannot read properties of null/);
  assert.equal(sug.actions[0]!.label, 'Fix it with my AI');
  // marked fixed, then it happens again: it comes back by itself
  ok(await o.h('errors.resolve', { groupId: g.id }));
  assert.equal(ok<any[]>(await o.h('errors.list', { serviceId: svc })).length, 0);
  await new Promise((r) => setTimeout(r, 1100));
  await hgetRetry(fx.httpPort, host, '/boom');
  assert.equal(ok(await o.h('errors.scan', { serviceId: svc })).updated[0].fresh, true);
});

test('workers run beside the app with its settings; jobs run once on schedule and report back', { skip, timeout: 900_000 }, async () => {
  const files = { 'package.json': JSON.stringify({ name: 'shopjobs', version: '1.0.0', scripts: { start: 'node server.js' } }),
    'server.js': `require('http').createServer((_,r)=>{r.writeHead(200);r.end('shop')}).listen(process.env.PORT||3000)`,
    'worker.js': `console.log('worker up, key='+(process.env.QUEUE_KEY||'none')); setInterval(()=>{}, 1000)`,
    'Procfile': 'web: node server.js\nworker: node worker.js\n' };
  const svc = ok(await o.h('service.create', { environmentId: envId, name: 'shopjobs', serverId })).serviceId;
  ok(await o.h('env.set', { serviceId: svc, key: 'QUEUE_KEY', value: 'k-123456', secret: true }));
  ok(await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(files)) } }));

  // the Procfile's worker isn't running yet → a one-click suggestion
  const { suggestions } = await import('../src/suggestions.ts');
  const sug = suggestions(app, o.orgId).find((x) => x.id === `worker:${svc}:worker`)!;
  assert.ok(sug, 'suggests running the worker');
  const act = sug.actions[0]! as { tool: string; input: Record<string, unknown> };
  const w = ok(await o.h(act.tool, act.input));
  assert.equal(w.status, 'live');
  const wlog = (await o.h('docker.logs', { serverId, container: get<{ container: string }>(app.db, 'SELECT container FROM deployments WHERE id = ?', w.deploymentId)!.container, lines: 20 })) as any;
  // the worker sees the app's secret, and the logs never show it
  assert.match(JSON.stringify(wlog), /worker up, key=\[redacted env QUEUE_KEY\]/, 'the worker sees the app\'s settings, masked in logs');
  assert.ok(!suggestions(app, o.orgId).some((x) => x.id === `worker:${svc}:worker`), 'and the suggestion goes away');

  // a job: runs once, in a one-off container from the app's image, with the app's settings
  const job = ok(await o.h('job.schedule', { serviceId: svc, name: 'report', schedule: 'daily 03:00', command: 'node -e "console.log(\'nightly report, key=\'+process.env.QUEUE_KEY)"' })).jobId;
  const r = ok(await o.h('job.run', { jobId: job }));
  assert.equal(r.ok, true);
  assert.match(r.output, /nightly report, key=\[redacted/, 'output captured, secrets scrubbed');
  const bad = ok(await o.h('job.schedule', { serviceId: svc, name: 'broken', schedule: 'every 1h', command: 'exit 3' })).jobId;
  assert.equal(ok(await o.h('job.run', { jobId: bad })).exitCode, 3);
  assert.ok(suggestions(app, o.orgId).some((x) => x.id === `job:${bad}`), 'a failed job is flagged');
});

test('Redis reads run as a read-only user, and a command is never shell', { skip, timeout: 120_000 }, async () => {
  const r = ok(await o.h('database.create', { environmentId: envId, engine: 'redis', name: 'rocache' })).serviceId;
  ok(await o.h('database.query', { serviceId: r, sql: 'SET greeting hello', write: true }));
  assert.match(ok(await o.h('database.query', { serviceId: r, sql: 'GET greeting' })).result, /hello/);
  // HSET isn't on the "looks like a write" list; Redis's ACL refuses it anyway
  await o.h('database.query', { serviceId: r, sql: 'HSET sneaky f v' });
  assert.match(ok(await o.h('database.query', { serviceId: r, sql: 'EXISTS sneaky' })).result, /0/);
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', serverId);
  const container = JSON.parse(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', r)!.config).container;
  await o.h('database.query', { serviceId: r, sql: 'PING; touch /tmp/escaped', write: true });
  assert.notEqual((await ssh(app).exec(s, script('docker exec "$1" test -e /tmp/escaped', container))).code, 0, 'the write path is no shell either');
});

test('a build command is Dockerfile text, never a shell command on the server', { skip, timeout: 300_000 }, async () => {
  const svc = ok(await o.h('service.create', { environmentId: envId, name: 'evilbuild', serverId, buildCommand: 'echo hi\nUNIT7_EOF\ntouch /tmp/unit7-escaped\ncat <<"UNIT7_EOF"' })).serviceId;
  await o.h('deployment.create', { serviceId: svc, noHeal: true, source: { type: 'upload', uploadId: await upload(appTar(1)) } });
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', serverId);
  assert.notEqual((await ssh(app).exec(s, 'test -e /tmp/unit7-escaped')).code, 0);
});

test('database inspect and read-only query guard', { skip, timeout: 120_000 }, async () => {
  const db = ok(await o.h('database.create', { environmentId: envId, engine: 'postgres', name: 'data' }));
  ok(await o.h('database.query', { serviceId: db.serviceId, sql: 'CREATE TABLE items (id serial primary key, name text)', write: true }));
  ok(await o.h('database.query', { serviceId: db.serviceId, sql: "INSERT INTO items (name) VALUES ('a'),('b')", write: true }));
  const read = ok(await o.h('database.query', { serviceId: db.serviceId, sql: 'SELECT count(*) FROM items' }));
  assert.match(read.result, /2/);
  // a write without write:true is refused by the database itself, however the SQL is dressed up
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', serverId);
  const container = JSON.parse(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', db.serviceId)!.config).container;
  for (const sql of ["INSERT INTO items (name) VALUES ('c')", "COMMIT; INSERT INTO items (name) VALUES ('c')", 'SET default_transaction_read_only = off; DROP TABLE items',
    "COPY (SELECT 1) TO PROGRAM 'touch /tmp/escaped'", '\\! touch /tmp/escaped']) {
    await o.h('database.query', { serviceId: db.serviceId, sql });
  }
  assert.match(ok(await o.h('database.query', { serviceId: db.serviceId, sql: 'SELECT count(*) FROM items' })).result, /\b2\b/, 'nothing was written');
  assert.notEqual((await ssh(app).exec(s, script('docker exec "$1" test -e /tmp/escaped', container))).code, 0, 'no command ran next to the data');
  const inspect = ok(await o.h('database.inspect', { serviceId: db.serviceId }));
  assert.match(JSON.stringify(inspect.result), /items/);
  // a destructive write takes a backup first
  ok(await o.h('database.query', { serviceId: db.serviceId, sql: 'DELETE FROM items WHERE id=1', write: true }));
  const backups = ok<any[]>(await o.h('backup.list', { serviceId: db.serviceId }));
  assert.ok(backups.some((b) => b.reason.includes('destructive')), 'auto-backup before destructive query');
});

test('several copies: Caddy load-balances with health checks; build files cached for 200s only', () => {
  const site = renderSite({ hostname: 'app.example.com', upstream: 'unit7-app-3', replicas: ['unit7-app-3-r2'], port: 3000, tls: 'auto', healthPath: '/healthz', cacheStatic: '/assets/*' });
  assert.match(site, /reverse_proxy unit7-app-3:3000 unit7-app-3-r2:3000/);
  assert.match(site, /lb_policy least_conn/);
  assert.match(site, /health_uri \/healthz/);
  assert.doesNotMatch(site, /unhealthy_status/);
  assert.match(site, /@hashed path \/assets\/\*[\s\S]*immutable[\s\S]*match status 200/);
  assert.doesNotMatch(renderSite({ hostname: 'a.b.co', upstream: 'one', port: 80, tls: 'off' }), /lb_policy/);
  assert.equal(hashedPath('next'), undefined);
  assert.equal(hashedPath('sveltekit'), '/_app/immutable/*');
  assert.deepEqual(replicaNames('unit7-x-4', 3), ['unit7-x-4-r2', 'unit7-x-4-r3']);
});

test('the code scan says what breaks with two copies, and spots dev servers', () => {
  const risks = scaleRisks({ files: [], manifests: { 'package.json': '{"dependencies":{"express-session":"1","connect-redis":"7","better-sqlite3":"9"}}' }, traits: 'express-session\nconnect-redis\nbetter-sqlite3' });
  assert.deepEqual(risks, ['the database is a SQLite file']); // sessions are in Redis, so they're fine
  assert.equal(runsDevServer('next dev -p 3000'), true);
  assert.equal(runsDevServer('vite build && vite preview'), false);
  assert.equal(runsDevServer('node server.js'), false);
});

test('Warden reads Caddy access logs into per-site traffic', () => {
  const line = (host: string, status: number, uri: string, cc?: string) => JSON.stringify({ msg: 'handled request', status, duration: 0.12, request: { client_ip: '198.51.100.4', host, uri }, resp_headers: cc ? { 'Cache-Control': [cc] } : {} });
  const log = [line('a.co', 200, '/'), line('a.co', 502, '/api'), line('a.co', 200, '/assets/app-1a2b3c4d.js'), line('a.co', 200, '/assets/x-9f8e7d6c.css', 'public, max-age=31536000, immutable'), 'not json'].join('\n');
  const t = summarizeAccessLog(log).perHost.get('a.co')!;
  assert.deepEqual({ ...t, p95: t.p95 > 0 }, { requests: 4, errors: 1, p95: true, staticHits: 2, staticUncached: 1 });
});

test('backups leave the server encrypted (here + a synced folder + a bucket); when the server loses its copy, it still proves and restores', { skip, timeout: 900_000 }, async () => {
  const { fakeBucket } = await import('./helpers.ts');
  const { decryptFile } = await import('../src/tools/offsite.ts');
  const { gunzipSync } = await import('node:zlib');
  const { serverRow } = await import('../src/tools/servers.ts');
  const pg = ok(await o.h('database.create', { environmentId: envId, engine: 'postgres', name: 'pgoff' })).serviceId;
  ok(await o.h('database.query', { serviceId: pg, sql: "CREATE TABLE notes (body text); INSERT INTO notes VALUES ('keep-me');", write: true }));
  const fb = await fakeBucket();
  try {
    const conn = { endpoint: fb.endpoint, bucket: 'unit7-test', accessKey: 'AKIDTEST1234', secretKey: 'test-secret-1234' };
    assert.notEqual((await o.a('backup.storage_connect', conn)).status, 'ok', 'an AI never handles the storage secret');
    ok(await o.h('backup.storage_connect', conn));
    const synced = mkdtempSync(join(tmpdir(), 'unit7-gdrive-')); // stands in for Google Drive's folder
    assert.notEqual((await o.a('backup.folder_set', { path: synced })).status, 'ok', 'a person picks where backups go');
    ok(await o.h('backup.folder_set', { path: synced }));
    const b = ok(await o.h('backup.create', { serviceId: pg, reason: 'test' }));
    const offOf = () => JSON.parse(get<{ offsite: string | null }>(app.db, 'SELECT offsite FROM backups WHERE id = ?', b.backupId)!.offsite ?? '{}');
    for (let n = 0; n < 90 && !offOf().at; n++) await new Promise((r) => setTimeout(r, 1000)); // copied in the background
    const off = offOf();
    assert.equal(off.error, undefined, off.error);
    assert.ok(existsSync(off.local), 'an encrypted copy on this computer');
    assert.equal(readFileSync(off.local).subarray(0, 8).toString(), 'FORGEBK1');
    assert.ok([...fb.objects.keys()].some((k) => k.endsWith(off.bucket.key)), 'and one in the bucket');
    assert.ok(off.folder.startsWith(join(synced, 'Unit7 Backups')) && existsSync(off.folder), 'and one in the synced folder');
    assert.equal(ok<any[]>(await o.h('backup.list', { serviceId: pg }))[0].offsite, 'this computer + synced folder + bucket');

    // the server loses its copy: the off-server one proves itself, then restores (from the bucket: this computer's copy is gone too)
    const s = serverRow({ db: app.db, orgId: o.orgId } as never, serverId);
    await ssh(app).exec(s, script('rm -f "$1"', b.location));
    const v = ok(await o.h('backup.verify', { backupId: b.backupId, offsite: true }));
    assert.equal(v.ok, true, v.note);
    assert.equal(v.fromOffsite, true);
    const enc = join(tmpdir(), `unit7-bucket-${Date.now()}.enc`);
    writeFileSync(enc, fb.objects.get([...fb.objects.keys()].find((k) => k.endsWith(off.bucket.key))!)!);
    rmSync(off.local); rmSync(off.folder); // this computer and the synced folder both lost it: the bucket brings it back
    ok(await o.h('database.query', { serviceId: pg, sql: 'DROP TABLE notes;', write: true }));
    // restoring production always waits for a person's explicit OK; the person gives it
    const asked = await o.h('backup.restore', { backupId: b.backupId, confirm: true });
    assert.equal(asked.status, 'approval_required');
    const { decideApproval } = await import('../src/tools/runtime.ts');
    ok(await decideApproval(app, o.orgId, o.human, (asked as any).approvalId, true, 'pgoff') as any);
    assert.match(JSON.stringify(ok(await o.h('database.query', { serviceId: pg, sql: 'SELECT body FROM notes' }))), /keep-me/);

    // and with only the recovery key, the bucket copy decrypts (this computer could be gone)
    const { recoveryKey } = ok(await o.h('backup.recovery_key', {}));
    assert.notEqual((await o.a('backup.recovery_key', {})).status, 'ok', 'never shown to an AI');
    await decryptFile(Buffer.from(recoveryKey, 'base64'), enc, `${enc}.gz`);
    assert.match(gunzipSync(readFileSync(`${enc}.gz`)).toString(), /keep-me/);
  } finally { fb.close(); }
});

test('PgBouncer in front of Postgres: apps move to it, DIRECT_URL keeps the direct line, and it really answers', { skip, timeout: 900_000 }, async () => {
  const { merged } = await import('../src/tools/env.ts');
  const appSvc = ok(await o.h('service.create', { environmentId: envId, name: 'poolapp', serverId })).serviceId;
  const pg = ok(await o.h('database.create', { environmentId: envId, engine: 'postgres', name: 'pgpool', injectInto: appSvc })).serviceId;
  const refs = () => Object.fromEntries(merged(app.db, o.orgId, { type: 'service', id: appSvc, label: '' }).map((v) => [v.key, v.ref]));
  const base = JSON.parse(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', pg)!.config).passwordRef.replace(/password$/, '');
  const r = ok(await o.h('database.pool', { serviceId: pg })); // the tool proves a query through the pooler before it returns
  assert.match(r.pooler, /-pool:6432 \(transaction mode/);
  assert.deepEqual(refs(), { DATABASE_URL: `${base}pool-url`, DIRECT_URL: `${base}url` });
  ok(await o.h('database.pool', { serviceId: pg, on: false }));
  assert.equal(refs().DATABASE_URL, `${base}url`, 'back to the direct line');
});

test('two databases with the same name in different environments each keep their own password', { skip, timeout: 600_000 }, async () => {
  const { merged } = await import('../src/tools/env.ts');
  const { serverRow } = await import('../src/tools/servers.ts');
  const envs: string[] = ok(await o.h('project.create', { name: 'Twins', environments: ['staging', 'production'] })).environments.map((e: { id: string }) => e.id);
  const made: { site: string; serviceId: string; passwordRef: string }[] = [];
  for (const env of envs) {
    const site = ok(await o.h('service.create', { environmentId: env, name: 'site', serverId })).serviceId;
    made.push({ ...ok(await o.h('database.create', { environmentId: env, engine: 'postgres', name: 'db', serverId, injectInto: site })), site });
  }
  assert.notEqual(made[0]!.passwordRef, made[1]!.passwordRef, 'one vault entry each');
  // the first app's DATABASE_URL still opens its database after the second one was created
  const s = serverRow({ db: app.db, orgId: o.orgId } as never, serverId);
  for (const m of made) {
    const { container } = JSON.parse(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', m.serviceId)!.config);
    const ref = merged(app.db, o.orgId, { type: 'service', id: m.site, label: '' }).find((v) => v.key === 'DATABASE_URL')!.ref!;
    const url = new URL(app.vault.resolve(o.orgId, ref));
    assert.equal(url.hostname, container, `${ref} points at its own database`);
    const r = await ssh(app).exec(s, script('docker exec -e PGPASSWORD="$2" "$1" psql -h "$1" -U postgres -d app -tAc "select 1"', container, url.password));
    assert.equal(r.code, 0, `${ref} connects: ${r.stderr}`);
  }
});

test('a database password changes for real (pooler included); the old one stops working', { skip, timeout: 900_000 }, async () => {
  const { serverRow } = await import('../src/tools/servers.ts');
  const pg = ok(await o.h('database.create', { environmentId: envId, engine: 'postgres', name: 'pgrot' })).serviceId;
  ok(await o.h('database.query', { serviceId: pg, sql: "CREATE TABLE t (v text); INSERT INTO t VALUES ('still-here');", write: true }));
  ok(await o.h('database.pool', { serviceId: pg }));
  const cfg = JSON.parse(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', pg)!.config);
  const old = app.vault.resolve(o.orgId, cfg.passwordRef);
  ok(await o.h('database.rotate_password', { serviceId: pg }));
  const fresh = app.vault.resolve(o.orgId, cfg.passwordRef);
  assert.notEqual(fresh, old);
  assert.match(JSON.stringify(ok(await o.h('database.query', { serviceId: pg, sql: 'SELECT v FROM t' }))), /still-here/, 'Unit7 connects with the new one');
  const s = serverRow({ db: app.db, orgId: o.orgId } as never, serverId);
  const via = (pw: string, host: string) => ssh(app).exec(s, script('docker exec -e PGPASSWORD="$3" "$1" psql -h "$2" -p "$4" -U postgres -d app -tAc "select 1"', cfg.container, host, pw, host.endsWith('-pool') ? '6432' : '5432'));
  assert.equal((await via(old, cfg.container)).code === 0, false, 'the old password no longer works');
  const pooled = await via(fresh, cfg.pool.container);
  assert.equal(pooled.code, 0, `the pooler took the new password: ${pooled.stderr}`);
});

test('a value Unit7 keeps for an app, written into its code, stops the deploy and is reported for changing', { skip, timeout: 600_000 }, async () => {
  const svc = ok(await o.h('service.create', { environmentId: envId, name: 'own-secret', serverId })).serviceId;
  ok(await o.h('env.set', { serviceId: svc, key: 'PARTNER_TOKEN', value: 'ptok-9f2c41d7a8b3e6f0', secret: true }));
  const code = { 'package.json': JSON.stringify({ name: 'own-secret', version: '1.0.0', scripts: { start: 'node server.js' } }),
    'server.js': `const token = 'ptok-9f2c41d7a8b3e6f0'; require('http').createServer((_,r)=>r.end('hi')).listen(process.env.PORT||3000)` };
  const r = await o.h('deployment.create', { serviceId: svc, source: { type: 'upload', uploadId: await upload(filesTar(code)) } });
  assert.equal(r.status, 'error');
  assert.equal((r as any).error.code, 'secrets_in_code');
  assert.match((r as any).error.message, /contains PARTNER_TOKEN/);
  const ev = all<{ message: string }>(app.db, `SELECT message FROM events WHERE type = 'secret.leaked'`);
  assert.ok(ev.some((e) => /own-secret's code contains PARTNER_TOKEN/.test(e.message)));
  assert.ok(!ev.some((e) => e.message.includes('ptok-9f2c41d7a8b3e6f0')), 'the value itself never appears in events');
});
