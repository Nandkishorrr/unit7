// Z6 · The test gate. When the code has tests, they run in the build step, in a container from the image just built
// (Unit7's own Node images keep the code and every dependency) or from a matching base image with the code copied in,
// with a time limit (10 minutes unless the app says otherwise). The container gets CI=true and nothing else: never the
// app's secrets, never Unit7's private network (where the databases are). A failure stops the deploy before anything
// changes, with the first failing test in plain words and the last 30 lines under Advanced. Skipping them is a person's
// choice ("Deploy anyway", held to confirm); an app with no tests gets one gentle tip, never a block.
import type { Ctx } from '../tools/runtime.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import type { Detection, RepoFacts } from '../connectors/detect.ts';
import { pick } from '../connectors/detect.ts';
import { ssh } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { get, json, run } from '../db.ts';
import { install } from './dockerfiles.ts';

export interface TestPlan { stack: 'node' | 'python' | 'go' | 'rust' | 'ruby'; label: string; image: string; mode: 'built' | 'base'; command: string }
// What the Test step shows. Kept on the deployment as plan.tests.
export interface TestResult {
  status: 'passed' | 'failed' | 'timeout' | 'skipped' | 'off' | 'none';
  label?: string;        // "npm test"
  ms?: number;
  failure?: string;      // the first failing test, in plain words
  hint?: string;         // why it may have failed that isn't the code (a database the tests expected)
  tail?: string[];       // the last 30 lines, for Advanced (secrets already hidden)
  tip?: string;          // no tests: said once per app
  by?: string;           // who chose "Deploy anyway"
}

export const TEST_LIMIT_MIN = 10;
const PLACEHOLDER = /no test specified/i;
const BASE = { python: 'python:3.13-slim', go: 'golang:1.25-alpine', rust: 'rust:1-slim', ruby: 'ruby:3.3' } as const;

// The test command for this code, or none. Never the person's text: the app's own `test` script is run by its package
// manager, the rest are fixed commands. files may include deeper test files found by testFiles().
export function findTests(facts: RepoFacts, d: Detection, image: string): TestPlan | undefined {
  const { files, manifests } = facts;
  // a matching base image: the first FROM of the repo's own Dockerfile when it's one of the language images
  const from = d.dockerfile ? /^\s*FROM\s+(?:docker\.io\/(?:library\/)?)?((node|python|golang|rust|ruby)(?::[\w.-]+)?)(?:\s|$)/im.exec(manifests[d.dockerfile] ?? '') : null;
  const baseFor = (lang: string, fallback: string) => (from?.[2] === lang ? from[1]! : fallback);
  const pkgPath = pick(Object.keys(manifests), /(^|\/)package\.json$/);
  const pkg = pkgPath && pkgPath.split('/').length === 1 ? safeJson(manifests[pkgPath]!) : undefined;
  const testScript: string | undefined = pkg?.scripts?.test;
  if (testScript && !PLACEHOLDER.test(testScript)) {
    const pm = d.packageManager && ['pnpm', 'yarn', 'bun'].includes(d.packageManager) ? d.packageManager : files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : files.includes('bun.lockb') ? 'bun' : 'npm';
    const label = pm === 'bun' ? 'bun run test' : `${pm} test`;
    // Unit7's own Node image has the code and every dependency (dev ones too) installed: test exactly what ships
    if (d.builder === 'railpack' && d.runtime === 'node') return { stack: 'node', label, image, mode: 'built', command: label };
    return { stack: 'node', label, image: baseFor('node', `node:${d.nodeVersion ?? 22}-alpine`), mode: 'base', command: `${install(pm, d.pins?.pm)} && ${label}` };
  }
  const py = files.some((f) => /(^|\/)(pytest\.ini|conftest\.py|test_[^/]*\.py|[^/]*_test\.py)$/.test(f) || /(^|\/)tests?\/[^/]+\.py$/.test(f))
    || /\[tool\.pytest/.test(manifests['pyproject.toml'] ?? '');
  if (py && (files.some((f) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.py|Pipfile)$/.test(f)) || d.runtime === 'python')) {
    const deps = d.packageManager === 'poetry'
      ? 'pip install -q poetry && poetry config virtualenvs.create false && poetry install --no-root --no-interaction'
      : 'for f in requirements.txt requirements-dev.txt requirements-test.txt; do if [ -f "$f" ]; then pip install -q -r "$f"; fi; done; if [ ! -f requirements.txt ] && [ -f pyproject.toml ]; then pip install -q ".[test]" 2>/dev/null || pip install -q .; fi';
    return { stack: 'python', label: 'pytest', image: baseFor('python', BASE.python), mode: 'base', command: `${deps}; python -c "import pytest" 2>/dev/null || pip install -q pytest; python -m pytest -q` };
  }
  if (files.some((f) => /_test\.go$/.test(f))) return { stack: 'go', label: 'go test', image: baseFor('golang', BASE.go), mode: 'base', command: 'CGO_ENABLED=0 go test ./...' };
  // ponytail: Rust only with a tests/ folder (unit tests inside src/ aren't visible from file names; cargo test compiles everything)
  if (files.includes('Cargo.toml') && files.some((f) => /^tests\/[^/]+\.rs$/.test(f))) return { stack: 'rust', label: 'cargo test', image: baseFor('rust', BASE.rust), mode: 'base', command: 'cargo test' };
  if (files.includes('Gemfile')) {
    if (files.some((f) => /(^|\/)spec\/.+_spec\.rb$/.test(f))) return { stack: 'ruby', label: 'rspec', image: baseFor('ruby', BASE.ruby), mode: 'base', command: 'bundle install --quiet && bundle exec rspec' };
    if (files.some((f) => /(^|\/)test\/.+_test\.rb$/.test(f)) && files.includes('bin/rails')) return { stack: 'ruby', label: 'rails test', image: baseFor('ruby', BASE.ruby), mode: 'base', command: 'bundle install --quiet && RAILS_ENV=test bin/rails test' };
  }
  return undefined;
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };

// Test files deeper than the shallow listing (Go packages, Python and Ruby test folders)
export async function testFiles(ctx: Ctx, s: ServerRow, dir: string): Promise<string[]> {
  const r = await ssh(ctx.app).exec(s, script(`cd "$1" && find . -maxdepth 6 \\( -name node_modules -o -name .git -o -name vendor -o -name target \\) -prune -o -type f \\( -name '*_test.go' -o -name 'test_*.py' -o -name '*_test.py' -o -name conftest.py -o -name '*_spec.rb' -o -name '*_test.rb' \\) -print 2>/dev/null | head -60 | sed "s|^\\./||"`, dir)).catch(() => undefined);
  return (r?.stdout ?? '').split('\n').filter(Boolean);
}

// The first failing test, as a person would say it, from the usual runners' output
export function firstFailure(out: string): string | undefined {
  const say = (name: string, file?: string) => `The test “${name.trim().replace(/\s+/g, ' ').slice(0, 160)}” failed${file ? ` (${file})` : ''}.`;
  let m: RegExpExecArray | null;
  if ((m = /^\s*FAIL\s+(\S+)\s+>\s+(.+?)\s*$/m.exec(out))) return say(m[2]!.replace(/\s+>\s+/g, ' › '), m[1]);                 // Vitest
  if ((m = /^\s*●\s+(?!Test suite failed to run)(.+?)\s*$/m.exec(out))) return say(m[1]!, /^\s*FAIL\s+(\S+)/m.exec(out)?.[1]);   // Jest
  if (/●\s+Test suite failed to run/.test(out)) return `A test file couldn’t run${(m = /^\s*FAIL\s+(\S+)/m.exec(out)) ? ` (${m[1]})` : ''}.`;
  if ((m = /^FAILED\s+(\S+?)::(\S+)/m.exec(out))) return say(m[2]!, m[1]);                                                       // pytest
  if ((m = /^\s*--- FAIL:\s+(\S+)/m.exec(out))) return say(m[1]!, /^\s+(\S+_test\.go):\d+:/m.exec(out)?.[1]);                    // go test
  if ((m = /^test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/m.exec(out))) return say(m[1]!);                                                 // cargo
  if ((m = /^rspec\s+\.\/(\S+?)(?::\d+)?\s+#\s+(.+)$/m.exec(out))) return say(m[2]!, m[1]);                                      // rspec
  if ((m = /^(?:Failure|Error):\s*\n(\w+)#(\w+)/m.exec(out))) return say(m[2]!, m[1]);                                          // minitest
  if ((m = /^\s*not ok \d+ - (.+)$/m.exec(out))) return say(m[1]!.replace(/\s+#.*$/, ''));                                      // node:test (TAP)
  if ((m = /^\s*[✖×✗✕]\s+(?!failing tests)(.+?)(?:\s+\(?\d+(?:\.\d+)?m?s\)?)?\s*$/m.exec(out)) && !m[1]!.endsWith(':')) return say(m[1]!); // node:test spec, Vitest
  if ((m = /\d+ failing[\s\S]*?^\s*1\) (.+)\n\s+(.+?):\s*$/m.exec(out))) return say(`${m[1]} ${m[2]}`);                          // Mocha
  return undefined;
}
const NEEDS_SERVICE = /ECONNREFUSED|ENOTFOUND|getaddrinfo|could not connect to server|Connection refused|connect ETIMEDOUT|DATABASE_URL|REDIS_URL/i;

// Run the tests on the server, within the limit. The output streams into the deploy log.
export async function runTests(ctx: Ctx, s: ServerRow, plan: TestPlan, o: { dir: string; name: string; limitMin: number; log: (m: string) => void }): Promise<TestResult> {
  const pool = ssh(ctx.app);
  const sec = Math.round(o.limitMin * 60);
  const memTotal = json<{ mem_total?: number }>(s.facts, {}).mem_total;
  // half the server's memory, between 512 MB and 2 GB, so tests can't starve what's serving next to them
  const mem = `${Math.min(2048, Math.max(512, memTotal ? Math.round(memTotal / 2 / 1024 / 1024) : 1024))}m`;
  const env = plan.stack === 'node' ? '-e NODE_ENV=test ' : '';
  // only CI=true (and NODE_ENV=test): no --env-file, no secrets, and the default network, not Unit7's private one
  const body = plan.mode === 'built'
    ? `docker run --rm --name "$1" --network bridge --memory "$3" --memory-swap "$3" -e CI=true ${env}--entrypoint sh "$4" -c "$5" 2>&1`
    : `docker run --rm --name "$1" --network bridge --memory "$3" --memory-swap "$3" -e CI=true ${env}-v "$6":/src:ro -w /work "$4" sh -c "cp -a /src/. /work/ && $5" 2>&1`;
  const SCRIPT = `docker rm -f "$1" >/dev/null 2>&1; timeout "$2" ${body}; rc=$?; if [ $rc -eq 124 ]; then docker rm -f "$1" >/dev/null 2>&1; echo "@@unit7:timeout"; fi; exit $rc`;
  o.log(`Running the tests (${plan.label}, up to ${o.limitMin} min)…`);
  const t0 = Date.now();
  let out = '';
  let r: Awaited<ReturnType<typeof pool.exec>> | undefined;
  try {
    r = await pool.exec(s, script(SCRIPT, o.name, sec, mem, plan.image, plan.command, ...(plan.mode === 'base' ? [o.dir] : [])), {
      timeoutMs: (sec + 120) * 1000, signal: ctx.signal,
      onData: (chunk) => { out = (out + chunk).slice(-2_000_000); for (const line of chunk.split('\n')) if (line.trim()) o.log(ctx.redactor.redact(line.trim().slice(0, 200))); },
    });
  } finally {
    if (!r) await pool.exec(s, script('docker rm -f "$1" >/dev/null 2>&1', o.name)).catch(() => undefined);
  }
  const text = ctx.redactor.redact(out || r.stdout || r.stderr);
  const tail = text.split('\n').filter((l) => l.trim() && !l.startsWith('@@unit7:')).slice(-30).map((l) => l.slice(0, 300));
  const ms = Date.now() - t0;
  if (r.code === 0) { o.log(`Tests passed (${Math.round(ms / 1000)} s).`); return { status: 'passed', label: plan.label, ms }; }
  if (/@@unit7:timeout/.test(text) || r.code === 124) return { status: 'timeout', label: plan.label, ms, tail, failure: `The tests took longer than ${o.limitMin} minutes, so Unit7 stopped them.` };
  const failure = r.code === 137 ? `The tests ran out of memory (${mem.replace('m', ' MB')}) and were stopped.`
    : r.code === 125 || r.code === 126 || r.code === 127 ? `The tests couldn’t start: ${tail.at(-1) ?? `exit ${r.code}`}`
    : firstFailure(text) ?? `The tests failed (exit code ${r.code}). The last lines are under Advanced.`;
  return { status: 'failed', label: plan.label, ms, tail, failure,
    ...(NEEDS_SERVICE.test(text) && { hint: 'They tried to reach a database or another service. Tests never get your app’s secrets or its private network, so tests that need one fail here. Give them their own test setup, or turn off “Run tests before deploying” for this app.' }) };
}

// The Test step of a deploy: decide, run, keep the result on the deployment (plan.tests), and say what has to stop.
export async function testGate(ctx: Ctx, s: ServerRow, a: {
  serviceId: string; cfg: { runTests?: boolean; testTimeoutMin?: number }; repo: RepoFacts; detection: Detection;
  dir: string; image: string; deploymentId: string; skip?: boolean; log: (m: string) => void;
}): Promise<{ result: TestResult; stop?: string }> {
  const save = (result: TestResult) => { run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ tests: result }), a.deploymentId); return result; };
  const found = findTests({ ...a.repo, files: [...new Set([...a.repo.files, ...(await testFiles(ctx, s, a.dir))])] }, a.detection, a.image);
  if (!found) {
    // one gentle tip per app, never a block
    const told = get<{ n: number }>(ctx.db, `SELECT count(*) n FROM deployments WHERE service_id = ? AND json_extract(plan, '$.tests.tip') IS NOT NULL`, a.serviceId)?.n;
    const tip = told ? undefined : 'Tip: this app has no tests Unit7 can find. Add a "test" script (or pytest, go test…) and Unit7 runs them before every deploy, so a broken change never goes live.';
    if (tip) a.log(tip);
    return { result: save({ status: 'none', ...(tip && { tip }) }) };
  }
  if (a.cfg.runTests === false) { a.log(`Tests are turned off for this app (${found.label}).`); return { result: save({ status: 'off', label: found.label }) }; }
  if (a.skip) { a.log(`${ctx.actor.name} chose to deploy without running the tests.`); return { result: save({ status: 'skipped', label: found.label, by: ctx.actor.name }) }; }
  const limitMin = Math.min(60, Math.max(1, a.cfg.testTimeoutMin ?? TEST_LIMIT_MIN));
  const result = save(await runTests(ctx, s, found, { dir: a.dir, name: `unit7-test-${a.deploymentId.slice(-10).toLowerCase().replace(/[^a-z0-9]/g, '')}`, limitMin, log: a.log }));
  if (result.status === 'passed') return { result };
  return { result, stop: `Unit7 stopped this deploy before changing anything: ${result.status === 'timeout' ? 'the tests ran too long' : 'a test failed'}. The old version is still serving.${result.hint ? `\n${result.hint}` : ''}\nFix it and deploy again, or a person can choose “Deploy anyway”.\n${result.failure}` };
}
