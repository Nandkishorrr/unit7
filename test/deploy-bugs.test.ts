// Deploy, rollback and cleanup bugs, each pinned by a check that runs without a server: the SSH pool's
// exec is replaced by a stand-in that records every command and answers like a healthy Docker host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createReadStream } from 'node:fs';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { ssh, type ExecResult } from '../src/connectors/ssh.ts';
import { renderSite, putSite } from '../src/deploy/caddy.ts';
import { detect } from '../src/connectors/detect.ts';
import { dockerfileFor } from '../src/deploy/dockerfiles.ts';
import { writeEnvFile, readRepo, containerName, buildImage } from '../src/deploy/deployer.ts';
import { Redactor } from '../src/redact.ts';
import type { Ctx } from '../src/tools/runtime.ts';
import type { App } from '../src/app.ts';

type Call = { server: string; command: string };
const res = (stdout = '', code = 0): ExecResult => ({ code, stdout, stderr: '', truncated: false });

// a Docker host that does what it's told: containers run, probes answer 200, caddy validates
function fakeHost(app: App, answer: (command: string, server: string) => ExecResult | Promise<ExecResult> | undefined = () => undefined) {
  const calls: Call[] = [];
  ssh(app).exec = async (s, command) => {
    calls.push({ server: s.id, command });
    const r = await answer(command, s.id);
    if (r) return r;
    if (command.includes(`'inspect'`) && command.includes('State.Status')) return res('running 0 false 0');
    if (command.includes('curlimages/curl')) return res('200');
    return res();
  };
  return calls;
}

async function setup(envKind: 'development' | 'production' = 'development') {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === envKind).id;
  const server = (name: string, ip: string) => {
    const srv = id('srv');
    run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, ?, ?, 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, name, ip, JSON.stringify({ publicIp: ip }));
    return srv;
  };
  const srv = server('box', '203.0.113.9');
  return { app, o, env, srv, server };
}

const deployments = (app: App, svc: string) => app.db.prepare('SELECT id, number, status, container, image, plan FROM deployments WHERE service_id = ? ORDER BY number').all(svc) as any[];

// --- Caddy ---------------------------------------------------------------------------------------

test('Caddy only health-checks a real health route; on "/" it relies on passive checks', () => {
  const plain = renderSite({ hostname: 'a.example.com', upstream: 'one', replicas: ['one-r2'], port: 3000, tls: 'auto' });
  assert.doesNotMatch(plain, /health_uri|health_status|health_interval|health_fails/, 'a redirecting or 404ing "/" would mark the app down');
  assert.match(plain, /fail_duration 30s/);
  assert.match(plain, /max_fails 3/);
  assert.doesNotMatch(renderSite({ hostname: 'a.example.com', upstream: 'one', port: 3000, tls: 'auto', healthPath: '/' }), /health_uri/);
  const real = renderSite({ hostname: 'a.example.com', upstream: 'one', replicas: ['one-r2'], port: 3000, tls: 'auto', healthPath: '/healthz' });
  assert.match(real, /health_uri \/healthz/);
  assert.match(real, /health_status 2xx/);
});

test('a site file that fails validation is put back, so it never blocks later reloads', async () => {
  const { app, srv } = await setup();
  const calls = fakeHost(app, (c) => (c.includes('caddy validate') ? res('bad config', 1) : undefined));
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', srv);
  await assert.rejects(putSite(app, s, { hostname: 'a.example.com', upstream: 'one', port: 3000, tls: 'auto' }));
  const write = calls.find((c) => c.command.includes('tee'))!;
  assert.match(write.command, /cp -p "\$1" "\$1\.prev"/, 'the working file is kept aside first');
  assert.ok(calls.some((c) => c.command.includes('mv -f "$1.prev" "$1"')), 'and put back when validation fails');
  assert.ok(!calls.some((c) => c.command.includes('caddy reload')), 'nothing broken is ever loaded');
});

// --- reading the repo ------------------------------------------------------------------------------

test('detect prefers root manifests, ignores .devcontainer, and reads EXPOSE', () => {
  const dev = detect({ files: ['.devcontainer/Dockerfile', 'package.json', 'server.js'], manifests: { '.devcontainer/Dockerfile': 'FROM mcr.microsoft.com/devcontainers/node', 'package.json': '{"dependencies":{"express":"4"},"scripts":{"start":"node server.js"}}' } });
  assert.equal(dev.builder, 'railpack', 'the dev container is not how the app is built');
  assert.equal(dev.stack, 'express');
  const nested = detect({ files: ['docker/Dockerfile', 'Dockerfile'], manifests: { Dockerfile: 'FROM node:22\nENV PORT=3000\nEXPOSE 5000\nCMD ["node","x"]', 'docker/Dockerfile': 'EXPOSE 9999' } });
  assert.equal(nested.dockerfile, 'Dockerfile');
  assert.equal(nested.port, 5000, 'EXPOSE is the port the author declared');
  const mono = detect({ files: ['tools/x/package.json', 'package.json'], manifests: { 'tools/x/package.json': '{"dependencies":{"next":"15"}}', 'package.json': '{"dependencies":{"express":"4"},"scripts":{"start":"node index.js"}}' } });
  assert.equal(mono.stack, 'express');
});

test('migrations deeper than the shallow listing are seen (the destructive-migration guard needs them)', async () => {
  const { app, srv } = await setup();
  fakeHost(app, (c) => {
    if (c.includes('-maxdepth 3')) return res('package.json\nprisma/schema.prisma\nprisma/migrations/migration_lock.toml\n');
    if (c.includes('alembic/versions')) return res('prisma/migrations/20240101000000_init/migration.sql\nprisma/migrations/20240202000000_drop/migration.sql\n');
    if (c.includes('head -c 32768')) return res('{"dependencies":{"@prisma/client":"5","express":"4"},"scripts":{"start":"node index.js"}}');
    return undefined;
  });
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', srv);
  const d = detect(await readRepo({ app, db: app.db } as any, s, '/tmp/x'));
  assert.equal(d.migrate, 'npx prisma migrate deploy');
  assert.deepEqual(d.migrations, ['prisma/migrations/20240101000000_init/migration.sql', 'prisma/migrations/20240202000000_drop/migration.sql']);
});

test('a static site served from the repo root never ships .git or .env', () => {
  const df = dockerfileFor({ stack: 'static', builder: 'static', staticDir: '.', port: 80, needs: [], envKeys: [], healthPath: '/', notes: [] }, [])!;
  assert.match(df, /AS files/);
  assert.match(df, /find \/srv -mindepth 1 -name '\.\*' ! -name \.well-known -prune -exec rm -rf/);
  assert.match(df, /COPY --from=files \/srv \/srv/, 'only the pruned files reach the served image');
});

// --- env files ------------------------------------------------------------------------------------

test('a value with a line break is refused by name instead of writing a broken env file', async () => {
  const { app, srv } = await setup();
  const calls = fakeHost(app);
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', srv);
  await assert.rejects(writeEnvFile({ app, db: app.db } as any, s, '/var/lib/unit7/apps/x.env', { OK: 'fine', PRIVATE_KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----' }),
    (e: any) => e.code === 'multiline_env' && /PRIVATE_KEY/.test(e.message) && /base64/.test(e.message));
  assert.equal(calls.length, 0, 'nothing was written');
});

// --- deploys ----------------------------------------------------------------------------------------

async function imageApp(envKind: 'development' | 'production' = 'development') {
  const t = await setup(envKind);
  const svc = ok(await t.o.h('service.create', { environmentId: t.env, name: 'web', serverId: t.srv, source: { type: 'image', image: 'nginx:alpine' }, port: 80 })).serviceId;
  const row = () => get<any>(t.app.db, 'SELECT * FROM services WHERE id = ?', svc);
  return { ...t, svc, row, name: (n: number) => containerName(row(), n) };
}

test('image deploys stop the version before, mark it stopped, and old versions are cleaned up', async () => {
  const t = await imageApp();
  const calls = fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  assert.ok(calls.some((c) => c.command.includes('docker stop') && c.command.includes(`'${t.name(1)}'`)), 'the previous container is stopped, though an image has no detection');
  assert.deepEqual(deployments(t.app, t.svc).map((d) => d.status), ['stopped', 'live']);
  assert.equal(JSON.parse(deployments(t.app, t.svc)[1].plan).port, 80, 'the port is saved with the version');

  run(t.app.db, `UPDATE deployments SET image = 'unit7/web:1' WHERE number = 1 AND service_id = ?`, t.svc);
  for (let n = 0; n < 2; n++) ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const all = deployments(t.app, t.svc);
  assert.deepEqual(all.map((d) => d.container === null), [true, false, false, false], 'only the newest 3 keep a container');
  const rm = calls.find((c) => c.command.includes('docker rm -f') && c.command.includes(`'${t.name(1)}-r4'`));
  assert.ok(rm, 'every copy of the old version is removed');
  assert.match(rm!.command, /rm -f "\/var\/lib\/unit7\/apps\/\$n\.env"/, 'with its env files');
  assert.ok(calls.some((c) => c.command === `docker 'rmi' 'unit7/web:1'`), 'and the image Unit7 built for it');
  assert.ok(!calls.some((c) => c.command.includes(`'rmi' 'nginx`)), 'a pulled image is never removed');
});

test('a failure after the new container started removes it and points switched domains back', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  run(t.app.db, 'DELETE FROM domains');
  for (const h of ['a.example.com', 'b.example.com']) run(t.app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls_mode) VALUES (?, ?, ?, ?, 'active', 'auto')`, id('dom'), t.o.orgId, h, t.svc);
  let validations = 0;
  const calls = fakeHost(t.app, (c) => (c.includes('caddy validate') && ++validations === 2 ? res('b.example.com: bad', 1) : undefined));
  const r = await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true });
  assert.equal(r.status, 'error');
  const at = calls.findIndex((c) => c.command.includes('docker rm -f') && c.command.includes(`'${t.name(2)}-r2'`));
  assert.ok(at > 0, 'the new container and its copies are removed (they share the app’s private address)');
  const back = calls.slice(at).find((c) => c.command.includes('tee') && c.command.includes('a.example.com'));
  assert.ok(back && back.command.includes(`${t.name(1)}:80`) && !back.command.includes(t.name(2)), 'the domain already switched goes back to the previous version');
  assert.equal(t.row().current_deployment_id, deployments(t.app, t.svc)[0].id);
  assert.equal(deployments(t.app, t.svc)[0].status, 'live');
});

test('rollback steps back from the live version, with that version’s port, and stops a target that fails', async () => {
  const t = await imageApp();
  const calls = fakeHost(t.app);
  for (let n = 0; n < 3; n++) ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  run(t.app.db, `UPDATE deployments SET plan = json_set(plan, '$.port', 8080) WHERE number = 1 AND service_id = ?`, t.svc);
  assert.equal(ok(await t.o.h('deployment.rollback', { serviceId: t.svc })).number, 2);
  // the next rollback goes further back, never forward to #3
  calls.length = 0;
  assert.equal(ok(await t.o.h('deployment.rollback', { serviceId: t.svc })).number, 1);
  assert.ok(calls.some((c) => c.command.includes('curlimages/curl') && c.command.includes(`${t.name(1)}:8080/`)), 'checked on the port #1 was deployed with');
  assert.ok(calls.some((c) => c.command.includes('tee') && c.command.includes(`${t.name(1)}:8080`)), 'and routed there');
  assert.equal(json(t.row().config).port, 8080);

  // a target that doesn't come back is stopped again, not left running beside the live one
  ok(await t.o.h('deployment.rollback', { serviceId: t.svc, deploymentId: deployments(t.app, t.svc)[2].id }));
  const c2 = fakeHost(t.app, (c) => (c.includes(`'inspect'`) && c.includes(t.name(1)) ? res('exited 1 false 0') : undefined));
  const r = await t.o.h('deployment.rollback', { serviceId: t.svc, deploymentId: deployments(t.app, t.svc)[0].id });
  assert.equal(r.status, 'error');
  assert.ok(c2.some((c) => c.command.includes('docker stop') && c.command.includes(`'${t.name(1)}'`)));
});
const json = (s: string) => JSON.parse(s);

test('moving an app to another server stops it and takes its sites down on the old one', async () => {
  const t = await imageApp();
  const calls = fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const other = t.server('box2', '203.0.113.10');
  calls.length = 0;
  ok(await t.o.h('deployment.create', { serviceId: t.svc, serverId: other, noHeal: true }));
  const old = calls.filter((c) => c.server === t.srv);
  assert.ok(old.some((c) => c.command.includes('docker ps -q --filter') && c.command.includes(t.svc)), 'the old copy is stopped');
  assert.ok(old.some((c) => c.command.includes('rm -f') && c.command.includes('.caddy')), 'its site is removed there');
  assert.equal(t.row().server_id, other);
});

test('service.remove removes every copy, a database’s own containers, and env files', async () => {
  const t = await imageApp();
  const calls = fakeHost(t.app);
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const first = t.name(1);
  ok(await t.o.h('service.remove', { serviceId: t.svc }));
  const rm = calls.find((c) => c.command.includes('docker rm -f') && c.command.includes(`'${first}-r3'`));
  assert.ok(rm && rm.command.includes('.env'), 'all copies and their env files');

  const db = id('svc');
  run(t.app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) VALUES (?, ?, (SELECT project_id FROM environments WHERE id = ?), ?, ?, 'db', 'db', 'postgres', ?)`,
    db, t.o.orgId, t.env, t.env, t.srv, JSON.stringify({ container: 'unit7-db-pg', pool: { container: 'unit7-db-pg-pool', mode: 'transaction' } }));
  calls.length = 0;
  ok(await t.o.h('service.remove', { serviceId: db, deleteData: true }));
  const i = calls.findIndex((c) => c.command === `docker 'rm' '-f' 'unit7-db-pg' 'unit7-db-pg-pool'`);
  const v = calls.findIndex((c) => c.command.includes(`'volume' 'rm' 'unit7-db-pg-data'`));
  assert.ok(i >= 0 && v > i, 'the database and its pooler go before the volume');
});

// --- agents and production ---------------------------------------------------------------------------

test('an agent’s production redeploy ships the live commit, never a newer branch head', async () => {
  const t = await setup('production');
  const svc = ok(await t.o.h('service.create', { environmentId: t.env, name: 'web', serverId: t.srv, source: { type: 'git', repo: 'acme/app' } })).serviceId;
  const live = 'a'.repeat(40);
  const dep = id('dep');
  run(t.app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, plan, container) VALUES (?, ?, ?, 1, 'live', ?, 'unit7-web-x-1')`, dep, t.o.orgId, svc, JSON.stringify({ commit: live }));
  run(t.app.db, 'UPDATE services SET current_deployment_id = ? WHERE id = ?', dep, svc);
  const calls = fakeHost(t.app, (c) => (c.includes('git clone') ? res('stop here', 128) : undefined));
  const clone = () => calls.filter((c) => c.command.includes('git clone')).pop()!.command;

  await t.o.a('deployment.create', { serviceId: svc, noHeal: true });
  assert.ok(clone().endsWith(`'${live}'`), 'pinned to the commit that is live');
  await t.o.h('deployment.create', { serviceId: svc, noHeal: true });
  assert.ok(!clone().includes(live), 'a person deploys the branch head');
  const warden = { kind: 'agent' as const, id: 'warden', userId: null, name: 'Warden', role: 'agent' as const, agent: 'Warden' };
  await t.o.as(warden)('deployment.create', { serviceId: svc, noHeal: true });
  assert.ok(!clone().includes(live), 'push-to-deploy (on by default) still ships new commits');
  run(t.app.db, `UPDATE services SET config = json_set(config, '$.autoDeploy', json('false')) WHERE id = ?`, svc);
  await t.o.as(warden)('deployment.create', { serviceId: svc, noHeal: true });
  assert.ok(clone().endsWith(`'${live}'`), 'with push-to-deploy off, Warden redeploys what is live');
});

// --- jobs and SSH ------------------------------------------------------------------------------------------

test('a job that times out is stopped on the server, and every run is recorded', async () => {
  const t = await imageApp();
  fakeHost(t.app);
  const job = ok(await t.o.h('job.schedule', { serviceId: t.svc, name: 'report', schedule: 'hourly', command: 'node report.js' })).jobId;
  assert.notEqual((await t.o.h('job.run', { jobId: job })).status, 'ok');
  assert.equal(get<any>(t.app.db, 'SELECT last_status FROM jobs WHERE id = ?', job).last_status, 'failed (not deployed)');
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const { Unit7Error } = await import('../src/errors.ts');
  const calls = fakeHost(t.app, (c) => { if (c.includes('docker run --rm --name')) throw new Unit7Error('timeout', 'took too long', 504); return undefined; });
  assert.notEqual((await t.o.h('job.run', { jobId: job })).status, 'ok');
  const name = `unit7-job-${job.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  assert.ok(calls.some((c) => c.command.includes('docker run --rm --name') && c.command.includes(`'${name}'`)), 'the run is named');
  assert.ok(calls.some((c) => c.command.includes('docker rm -f "$1"') && c.command.includes(`'${name}'`)), 'and removed when it times out');
  const row = get<any>(t.app.db, 'SELECT last_run_at, last_status FROM jobs WHERE id = ?', job);
  assert.ok(row.last_run_at);
  assert.equal(row.last_status, 'failed (timeout)');
});

test('an upload that disappears mid-send fails the command instead of crashing Unit7', async () => {
  const { app, srv } = await setup();
  const pool = ssh(app);
  const channel = Object.assign(new PassThrough(), { stderr: new PassThrough(), close() { channel.emit('close', null); } });
  (pool as any).acquire = async () => ({ client: { exec: (_c: string, cb: (e: Error | undefined, ch: unknown) => void) => cb(undefined, channel) }, release() {} });
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', srv);
  await assert.rejects(pool.exec(s, 'tar -xz', { stdin: createReadStream('/nonexistent/unit7-upload.tgz') }), (e: any) => e.code === 'stdin_failed');
});

test('builds start from a fresh base image, and every app container keeps at most 3 × 10 MB of logs (Docker never restarts)', async () => {
  const t = await imageApp();
  const calls = fakeHost(t.app);
  const s = get<any>(t.app.db, 'SELECT * FROM servers WHERE id = ?', t.srv);
  const ctx = { app: t.app, redactor: new Redactor(), signal: AbortSignal.timeout(10_000) } as unknown as Ctx;
  await buildImage(ctx, s, t.row(), { builder: 'dockerfile', dockerfile: 'Dockerfile', stack: 'node' } as never, '/var/lib/unit7/apps/x', 'unit7/web:7', [], {}, () => undefined);
  const build = calls.find((c) => c.command.includes('docker build'))!;
  assert.match(build.command, /DOCKER_BUILDKIT=1 docker build --pull -f "\$2"/, 'the build pulls the base image again, so its OS fixes come in');
  ok(await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true }));
  const started = calls.find((c) => c.command.includes('docker run -d'))!;
  assert.match(started.command, /--log-driver json-file --log-opt max-size=10m --log-opt max-file=3/);
  assert.ok(!calls.some((c) => /daemon\.json|systemctl restart docker/.test(c.command)), 'set per container, not in Docker’s own settings');
});

test('a base image that only exists on the server: the pull fails, so the build runs once more from the local copy and says so', async () => {
  const t = await imageApp();
  const s = get<any>(t.app.db, 'SELECT * FROM servers WHERE id = ?', t.srv);
  const said: string[] = [];
  const ctx = { app: t.app, redactor: new Redactor(), signal: AbortSignal.timeout(10_000) } as unknown as Ctx;
  const build = (calls: { command: string }[]) => calls.filter((c) => c.command.includes('docker build'));
  let calls = fakeHost(t.app, (c) => (c.includes('docker build --pull') ? { code: 1, stdout: 'ERROR: failed to solve: pull access denied for mybase, repository does not exist or may require \'docker login\'', stderr: '', truncated: false } : undefined));
  await buildImage(ctx, s, t.row(), { builder: 'dockerfile', dockerfile: 'Dockerfile', stack: 'node' } as never, '/var/lib/unit7/apps/x', 'unit7/web:8', [], {}, (m) => said.push(m));
  assert.deepEqual(build(calls).map((c) => /docker build --pull/.test(c.command)), [true, false], 'once with --pull, then once without');
  assert.ok(said.some((m) => /only on this server/.test(m)), 'the deploy log says why');
  // any other failure is just a failure: no second build
  calls = fakeHost(t.app, (c) => (c.includes('docker build') ? { code: 1, stdout: 'npm ERR! missing script: build', stderr: '', truncated: false } : undefined));
  await assert.rejects(buildImage(ctx, s, t.row(), { builder: 'dockerfile', dockerfile: 'Dockerfile', stack: 'node' } as never, '/var/lib/unit7/apps/x', 'unit7/web:9', [], {}, () => undefined), (e: any) => e.code === 'build_failed');
  assert.equal(build(calls).length, 1);
});
