// Z6: the test gate. Finding the tests per stack, the exact command (CI=true, never the app's secrets or private
// network), pass / fail / timeout, the first failing test in plain words, and the one-time tip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTests, firstFailure, runTests, testGate } from '../src/deploy/testgate.ts';
import { detect, type RepoFacts } from '../src/connectors/detect.ts';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { get, id, json, run } from '../src/db.ts';
import { Redactor } from '../src/redact.ts';
import type { Ctx } from '../src/tools/runtime.ts';

const repo = (files: string[], manifests: Record<string, string> = {}): RepoFacts => ({ files, manifests });
const plan = (r: RepoFacts) => findTests(r, detect(r), 'unit7/web:7');
const pkg = (scripts: Record<string, string>, more = {}) => JSON.stringify({ scripts: { start: 'node server.js', ...scripts }, dependencies: { express: '4' }, ...more });

test('finding the tests per stack, and the command each one runs', () => {
  // Node built by Unit7: the image already has the code and every dependency, so the test runs right in it
  const node = plan(repo(['package.json', 'package-lock.json', 'server.js'], { 'package.json': pkg({ test: 'vitest run' }) }))!;
  assert.deepEqual([node.stack, node.mode, node.image, node.command], ['node', 'built', 'unit7/web:7', 'npm test']);
  assert.equal(plan(repo(['package.json', 'pnpm-lock.yaml'], { 'package.json': pkg({ test: 'jest' }) }))!.command, 'pnpm test');
  assert.equal(plan(repo(['package.json', 'bun.lockb'], { 'package.json': pkg({ test: 'vitest' }) }))!.label, 'bun run test', 'bun test would be bun’s own runner, not the script');
  assert.equal(plan(repo(['package.json'], { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) })), undefined, 'npm’s placeholder is not a test');
  assert.equal(plan(repo(['package.json'], { 'package.json': pkg({}) })), undefined);
  // a repo with its own Dockerfile: its first FROM is the matching base image, the code is copied in and installed
  const own = plan(repo(['Dockerfile', 'package.json', 'yarn.lock'], { Dockerfile: 'FROM node:20-alpine AS deps\nRUN yarn\nFROM gcr.io/distroless/nodejs20\n', 'package.json': pkg({ test: 'jest' }) }))!;
  assert.deepEqual([own.mode, own.image], ['base', 'node:20-alpine']);
  assert.match(own.command, /yarn install --frozen-lockfile.*&& yarn test$/);
  // a built SPA ships only static files: tests run in Node
  const spa = plan(repo(['package.json', 'index.html', 'vite.config.ts'], { 'package.json': JSON.stringify({ scripts: { build: 'vite build', test: 'vitest run' }, devDependencies: { vite: '7' } }) }))!;
  assert.deepEqual([spa.mode, spa.image.startsWith('node:')], ['base', true]);

  const py = plan(repo(['requirements.txt', 'main.py', 'tests/test_api.py'], { 'requirements.txt': 'fastapi\nuvicorn\n' }))!;
  assert.deepEqual([py.stack, py.label, py.image], ['python', 'pytest', 'python:3.13-slim']);
  assert.match(py.command, /pip install -q -r "\$f".*python -m pytest -q$/);
  assert.equal(plan(repo(['go.mod', 'main.go', 'internal/calc/calc_test.go'], {}))!.command, 'CGO_ENABLED=0 go test ./...');
  assert.equal(plan(repo(['Cargo.toml', 'src/main.rs', 'tests/api.rs'], {}))!.command, 'cargo test');
  assert.equal(plan(repo(['Cargo.toml', 'src/main.rs'], {})), undefined, 'no tests folder, no cargo test');
  assert.match(plan(repo(['Gemfile', 'Dockerfile', 'spec/models/user_spec.rb'], { Dockerfile: 'FROM ruby:3.2-slim\n' }))!.command, /bundle exec rspec$/);
  assert.equal(plan(repo(['Gemfile', 'Dockerfile', 'spec/models/user_spec.rb'], { Dockerfile: 'FROM ruby:3.2-slim\n' }))!.image, 'ruby:3.2-slim');
  assert.match(plan(repo(['Gemfile', 'bin/rails', 'test/models/user_test.rb'], {}))!.command, /bin\/rails test$/);
  assert.equal(plan(repo(['index.html', 'style.css'], {})), undefined, 'a plain site has no tests');
});

test('the first failing test in plain words, from the usual runners', () => {
  assert.equal(firstFailure('FAIL src/math.test.js\n  Math\n    ✕ adds two numbers (3 ms)\n\n  ● Math › adds two numbers\n\n    expect(received).toBe(expected)'), 'The test “Math › adds two numbers” failed (src/math.test.js).');
  assert.equal(firstFailure(' FAIL  src/math.test.ts > Math > adds two numbers\nAssertionError: expected 3 to be 4'), 'The test “Math › adds two numbers” failed (src/math.test.ts).');
  assert.equal(firstFailure('tests/test_api.py F.\nFAILED tests/test_api.py::test_health - assert 500 == 200'), 'The test “test_health” failed (tests/test_api.py).');
  assert.equal(firstFailure('--- FAIL: TestAdd (0.00s)\n    calc_test.go:9: got 3, want 4\nFAIL'), 'The test “TestAdd” failed (calc_test.go).');
  assert.equal(firstFailure('test calc::adds ... FAILED\n'), 'The test “calc::adds” failed.');
  assert.equal(firstFailure('rspec ./spec/models/user_spec.rb:12 # User is valid with an email'), 'The test “User is valid with an email” failed (spec/models/user_spec.rb).');
  assert.equal(firstFailure('TAP version 13\nok 1 - boots\nnot ok 2 - adds two numbers\n'), 'The test “adds two numbers” failed.');
  assert.equal(firstFailure('✔ boots (1ms)\n✖ adds two numbers (2.1ms)\n✖ failing tests:\n'), 'The test “adds two numbers” failed.');
  assert.equal(firstFailure('  2 passing\n  1 failing\n\n  1) Math\n       adds two numbers:\n     AssertionError'), 'The test “Math adds two numbers” failed.');
  assert.equal(firstFailure('npm ERR! something'), undefined);
});

// a server that runs the tests: records the command, answers with the given output and exit code
function fakeRunner(app: ReturnType<typeof testApp>, answer: { code: number; out: string }) {
  const calls: string[] = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    calls.push(command);
    if (command.includes('timeout')) { o.onData?.(answer.out, 'out'); return { code: answer.code, stdout: answer.out, stderr: '', truncated: false }; }
    return { code: 0, stdout: '', stderr: '', truncated: false };
  };
  return calls;
}
const ctxOf = (app: ReturnType<typeof testApp>) => ({ app, db: app.db, redactor: new Redactor(), actor: { name: 'Sam' }, progress: () => undefined } as unknown as Ctx);
const box = { id: 'srv_x', name: 'box', facts: JSON.stringify({ mem_total: 4 * 1024 ** 3 }) } as never;

test('the command: CI=true only, the default network, a memory cap, the time limit, and the code read-only', async () => {
  const app = testApp();
  const calls = fakeRunner(app, { code: 0, out: 'Tests: 3 passed' });
  const log: string[] = [];
  const base = findTests(repo(['requirements.txt', 'tests/test_x.py'], {}), detect(repo(['requirements.txt', 'tests/test_x.py'], {})), 'unit7/api:3')!;
  const r = await runTests(ctxOf(app), box, base, { dir: '/var/lib/unit7/apps/api-build-abc', name: 'unit7-test-abc', limitMin: 10, log: (m) => log.push(m) });
  assert.equal(r.status, 'passed');
  const c = calls.find((x) => x.includes('docker run'))!;
  assert.match(c, /--network bridge/, 'never Unit7’s private network, where the databases are');
  assert.match(c, /-e CI=true/);
  assert.doesNotMatch(c, /--env-file|DATABASE_URL|unit7-[a-z]+-.*\.env/, 'never the app’s settings or secrets');
  assert.match(c, /-v "\$6":\/src:ro -w \/work/, 'the code goes in read-only and is copied');
  assert.ok(c.includes(`'600'`), 'a 10-minute limit');
  assert.ok(c.includes(`'2048m'`), 'half of a 4 GB server, at most 2 GB');
  assert.match(log[0]!, /Running the tests \(pytest, up to 10 min\)/);
});

test('fail, timeout and out of memory: what the person reads, and the last 30 lines for Advanced', async () => {
  const app = testApp();
  const node = findTests(repo(['package.json'], { 'package.json': pkg({ test: 'jest' }) }), detect(repo(['package.json'], { 'package.json': pkg({ test: 'jest' }) })), 'unit7/web:7')!;
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  fakeRunner(app, { code: 1, out: `${lines}\nFAIL src/cart.test.js\n  ● Cart › adds tax\nError: connect ECONNREFUSED 127.0.0.1:5432` });
  const failed = await runTests(ctxOf(app), box, node, { dir: '/d', name: 'unit7-test-a', limitMin: 10, log: () => undefined });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure, 'The test “Cart › adds tax” failed (src/cart.test.js).');
  assert.equal(failed.tail!.length, 30);
  assert.match(failed.hint!, /tried to reach a database/);

  fakeRunner(app, { code: 124, out: 'still going\n@@unit7:timeout' });
  const slow = await runTests(ctxOf(app), box, node, { dir: '/d', name: 'unit7-test-a', limitMin: 3, log: () => undefined });
  assert.deepEqual([slow.status, slow.failure], ['timeout', 'The tests took longer than 3 minutes, so Unit7 stopped them.']);
  assert.ok(!slow.tail!.some((l) => l.startsWith('@@unit7')), 'markers never show');

  fakeRunner(app, { code: 137, out: 'Killed' });
  assert.match((await runTests(ctxOf(app), box, node, { dir: '/d', name: 'unit7-test-a', limitMin: 3, log: () => undefined })).failure!, /ran out of memory \(2048 MB\)/);

  // a runner that never answers: the SSH limit fires, and the container is removed on the server
  const calls: string[] = [];
  ssh(app).exec = async (_s, command) => { calls.push(command); if (command.includes('timeout "$2"')) throw new Error('A command on box took longer than 720s and was stopped.'); return { code: 0, stdout: '', stderr: '', truncated: false }; };
  await assert.rejects(runTests(ctxOf(app), box, node, { dir: '/d', name: 'unit7-test-a', limitMin: 10, log: () => undefined }));
  assert.ok(calls.at(-1)!.startsWith(`sh -c 'docker rm -f "$1"`) && calls.at(-1)!.endsWith(`'unit7-test-a'`), 'the stuck run is removed');
});

test('the gate: off, skipped by a person, none with a one-time tip, and the stop message', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const svc = ok(await o.h('service.create', { environmentId: environments[0].id, name: 'web' })).serviceId;
  const dep = () => { const d = id('dep'); run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status) VALUES (?, ?, ?, (SELECT coalesce(max(number), 0) + 1 FROM deployments WHERE service_id = ?), 'building')`, d, o.orgId, svc, svc); return d; };
  const testsOf = (d: string) => json<{ tests?: Record<string, unknown> }>(get<{ plan: string }>(app.db, 'SELECT plan FROM deployments WHERE id = ?', d)!.plan, {}).tests!;
  const withTests = repo(['package.json'], { 'package.json': pkg({ test: 'jest' }) });
  const ctx = { ...ctxOf(app), orgId: o.orgId };
  const gate = (d: string, r: RepoFacts, more: object = {}) => testGate(ctx, box, { serviceId: svc, cfg: {}, repo: r, detection: detect(r), dir: '/d', image: 'unit7/web:1', deploymentId: d, log: () => undefined, ...more });

  fakeRunner(app, { code: 1, out: 'FAIL a.test.js\n  ● adds' });
  const d1 = dep();
  const stopped = await gate(d1, withTests);
  assert.match(stopped.stop!, /^Unit7 stopped this deploy before changing anything: a test failed\. The old version is still serving\./);
  assert.equal(stopped.stop!.split('\n').at(-1), 'The test “adds” failed (a.test.js).', 'the last line is what the app page shows');
  assert.equal(testsOf(d1).status, 'failed');

  const d2 = dep();
  assert.equal((await gate(d2, withTests, { skip: true })).stop, undefined);
  assert.deepEqual([testsOf(d2).status, testsOf(d2).by], ['skipped', 'Sam']);
  const d3 = dep();
  assert.equal((await gate(d3, withTests, { cfg: { runTests: false } })).result.status, 'off');

  const plain = repo(['index.html'], {});
  const d4 = dep(), d5 = dep();
  assert.match(String((await gate(d4, plain)).result.tip), /^Tip: this app has no tests/);
  assert.equal((await gate(d5, plain)).result.tip, undefined, 'the tip is said once per app');
  assert.equal(testsOf(d5).status, 'none');
});
