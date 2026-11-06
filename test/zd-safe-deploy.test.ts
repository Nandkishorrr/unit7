// The test gate and the database checker inside a real deploy, against a stand-in server (no Docker on this Mac): the
// SSH pool's exec answers like a Docker host and records every command and what went in on stdin.
// Tests that fail stop before anything changes; "Deploy anyway" is people-only. A risky database change pauses; an AI's
// deploy then asks a person by itself; a person's "Go ahead anyway" runs it, with Postgres's lock limit in PGOPTIONS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, json, run } from '../src/db.ts';
import { ssh, type ExecOptions, type ExecResult } from '../src/connectors/ssh.ts';
import type { App } from '../src/app.ts';

const res = (stdout = '', code = 0): ExecResult => ({ code, stdout, stderr: '', truncated: false });
const SHA = 'b'.repeat(40);
const PKG = JSON.stringify({ scripts: { start: 'node server.js', test: 'node --test' }, dependencies: { express: '4', '@prisma/client': '5' }, devDependencies: { prisma: '5' } });
const MIGRATIONS = ['prisma/migrations/1_init/migration.sql', 'prisma/migrations/2_region/migration.sql'];

// a Docker host for a Node app with Prisma migrations and tests; `tests` and `migration` decide how those go
function host(app: App, o: { tests: { code: number; out: string }; sql: string; migrateCode?: number }) {
  const calls: { command: string; stdin: string }[] = [];
  ssh(app).exec = async (_s, command, x: ExecOptions = {}) => {
    calls.push({ command, stdin: typeof x.stdin === 'string' ? x.stdin : '' });
    if (command.includes('git clone')) return res(`UNIT7_SHA=${SHA}\n`);
    if (command.includes('gitleaks')) return res('[]');
    if (command.includes('-maxdepth 3')) return res('package.json\npackage-lock.json\nserver.js\nprisma/schema.prisma\n');
    if (command.includes('alembic/versions')) return res(MIGRATIONS.join('\n'));
    if (command.includes('head -c 32768')) return res(PKG);
    if (command.includes('head -c 200000')) return res(command.includes('2_region') ? o.sql : 'CREATE TABLE "User" ("id" SERIAL NOT NULL);');
    if (command.includes('timeout "$2"')) { x.onData?.(o.tests.out, 'out'); return res(o.tests.out, o.tests.code); }
    if (command.includes('-migrate"') || command.includes('--env-file "$1" "$2" sh -c')) return res('migrate output', o.migrateCode ?? 1);
    if (command.includes(`'inspect'`) && command.includes('State.Status')) return res('running 0 false 0');
    if (command.includes('curlimages/curl')) return res('200');
    return res();
  };
  return calls;
}

async function setup(kind: 'production' | 'development' = 'production') {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: { kind: string }) => e.kind === kind).id;
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ publicIp: '203.0.113.9', mem_total: 4 * 1024 ** 3 }));
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', serverId: srv, source: { type: 'git', repo: 'acme/web' } })).serviceId;
  ok(await o.h('env.set', { serviceId: svc, key: 'DATABASE_URL', value: 'postgresql://app:s3cretpw@db:5432/app', secret: true }));
  // a version is live, with the first migration already applied
  const live = id('dep');
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, plan, container) VALUES (?, ?, ?, 1, 'live', ?, 'unit7-web-x-1')`, live, o.orgId, svc, JSON.stringify({ commit: SHA, migrations: [MIGRATIONS[0]] }));
  run(app.db, `UPDATE services SET current_deployment_id = ?, status = 'healthy' WHERE id = ?`, live, svc);
  return { app, o, svc, env };
}
const newest = (app: App, svc: string) => get<{ status: string; error: string; plan: string }>(app.db, 'SELECT status, error, plan FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1', svc)!;

test('failing tests stop the deploy before anything changes; "Deploy anyway" is a person’s choice', async () => {
  const t = await setup();
  const calls = host(t.app, { tests: { code: 1, out: 'not ok 1 - checkout adds tax\n' }, sql: 'ALTER TABLE "User" ADD COLUMN "bio" TEXT;' });
  const r = await t.o.h('deployment.create', { serviceId: t.svc });
  assert.equal(r.status, 'error');
  assert.equal((r as { error: { code: string } }).error.code, 'tests_failed');
  const d = newest(t.app, t.svc);
  assert.equal(d.status, 'failed');
  assert.equal(d.error.split('\n').at(-1), 'The test “checkout adds tax” failed.');
  assert.equal(json<{ tests: { status: string } }>(d.plan, { tests: { status: '' } }).tests.status, 'failed');
  assert.ok(!calls.some((c) => c.command.includes('-migrate') || /docker run -d/.test(c.command)), 'no migration ran, no container started');
  const runTests = calls.find((c) => c.command.includes('timeout "$2"'))!.command;
  assert.match(runTests, /--network bridge.*-e CI=true/);
  assert.doesNotMatch(runTests, /--env-file|s3cretpw/, 'the tests never get the app’s secrets');
  assert.equal(get<{ status: string }>(t.app.db, 'SELECT status FROM services WHERE id = ?', t.svc)!.status, 'healthy', 'the old version is still serving');

  // an AI can't skip the tests, not even with an approval
  const ai = await t.o.a('deployment.create', { serviceId: t.svc, skipTests: true });
  assert.equal(ai.status, 'denied');
  // a person can: the deploy goes on past the tests (here it then stops at the database step's migration run)
  const person = await t.o.h('deployment.create', { serviceId: t.svc, skipTests: true, noHeal: true });
  assert.equal((person as { error: { code: string } }).error.code, 'migration_failed');
  assert.deepEqual(json<{ tests: { status: string; by: string } }>(newest(t.app, t.svc).plan, { tests: { status: '', by: '' } }).tests, { status: 'skipped', label: 'npm test', by: 'Ada' });

  // turning the gate off for the app is people-only too
  assert.equal((await t.o.a('service.settings', { serviceId: t.svc, runTests: false })).status, 'denied');
  ok(await t.o.h('service.settings', { serviceId: t.svc, runTests: false }));
  const got = ok(await t.o.h('service.get', { serviceId: t.svc }));
  assert.deepEqual([got.safety.runTests, got.safety.hasTests], [false, true]);
});

test('a risky database change pauses; an AI’s deploy asks a person by itself; a person goes ahead with the lock limit', async () => {
  const t = await setup();
  const calls = host(t.app, { tests: { code: 0, out: 'ok 1 - all good\n' }, sql: 'ALTER TABLE "User" ADD COLUMN "region" TEXT NOT NULL;' });
  const r = await t.o.h('deployment.create', { serviceId: t.svc });
  assert.equal((r as { error: { code: string } }).error.code, 'migration_risky');
  const d = newest(t.app, t.svc);
  const check = json<{ dbCheck: { status: string; held: boolean; changes: { kind: string; why: string; steps: string[] }[] } }>(d.plan, {} as never).dbCheck;
  assert.deepEqual([check.status, check.held, check.changes[0]!.kind], ['risky', true, 'required_column']);
  assert.match(d.error.split('\n').at(-1)!, /^This adds a required column \(User\.region\) with no default/);
  assert.ok(!calls.some((c) => c.command.includes('--env-file "$1" "$2" sh -c')), 'the migration never ran');
  const got = ok(await t.o.h('service.get', { serviceId: t.svc }));
  assert.equal(got.safety.stoppedAt, 'database');
  assert.equal(got.safety.dbCheck.changes[0].steps.length, 4);

  // an AI's deploy: paused the same way, and an approval to go ahead is waiting for a person
  const ai = await t.o.a('deployment.create', { serviceId: t.svc });
  assert.equal(ai.status, 'error');
  assert.match((ai as { error: { message: string } }).error.message, /waiting on the Approvals page/);
  const apr = get<{ tool: string; input: string; why: string }>(t.app.db, `SELECT tool, input, why FROM approvals WHERE status = 'pending'`)!;
  assert.equal(apr.tool, 'deployment.create');
  assert.equal(JSON.parse(apr.input).allowRiskyMigration, true);
  assert.match(apr.why, /can break the version still serving, so a person decides/);
  assert.equal((await t.o.a('deployment.create', { serviceId: t.svc, allowRiskyMigration: true })).status, 'approval_required', 'an AI asking to go ahead always waits');

  // a person's "Go ahead anyway": the check says who, and the migration runs with Postgres's lock limit
  const go = await t.o.h('deployment.create', { serviceId: t.svc, allowRiskyMigration: true, noHeal: true });
  assert.equal((go as { error: { code: string } }).error.code, 'migration_failed', 'the stand-in migration fails, after the env was written');
  const gone = json<{ dbCheck: { goAhead: string; held?: boolean } }>(newest(t.app, t.svc).plan, {} as never).dbCheck;
  assert.deepEqual([gone.goAhead, gone.held], ['Ada', undefined]);
  const envWrite = calls.filter((c) => c.command.includes('-migrate.env')).find((c) => c.stdin.includes('DATABASE_URL'))!;
  assert.match(envWrite.stdin, /^PGOPTIONS=-c lock_timeout=5s -c statement_timeout=15min$/m);
});

test('a change that breaks nothing, and a first deploy, never pause', async () => {
  const t = await setup('development');
  host(t.app, { tests: { code: 0, out: 'ok' }, sql: 'ALTER TABLE "User" ADD COLUMN "bio" TEXT;' });
  const r = await t.o.h('deployment.create', { serviceId: t.svc, noHeal: true });
  assert.equal((r as { error: { code: string } }).error.code, 'migration_failed', 'straight through the check to the migration run');
  const check = json<{ dbCheck: { status: string; summary: string } }>(newest(t.app, t.svc).plan, {} as never).dbCheck;
  assert.equal(check.status, 'safe');
  assert.match(check.summary, /safe for the version still serving/);
});
