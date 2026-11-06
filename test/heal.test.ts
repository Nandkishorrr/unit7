// Self-healing deploys: the classifier reads real failure output and picks safe fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseFailure, describe } from '../src/deploy/heal.ts';
import { majorFromSpec, nodeMajor, migrationsOf, destructiveLine } from '../src/connectors/detect.ts';
import { dockerfileFor } from '../src/deploy/dockerfiles.ts';

const base = { cfg: { port: 3000 }, setKeys: new Set<string>(), has: { postgres: false, redis: false, mongo: false } };
const plan = (text: string, extra: Partial<Parameters<typeof diagnoseFailure>[0]> = {}) => diagnoseFailure({ ...base, text, ...extra });
const kinds = (p: ReturnType<typeof plan>) => p.fixes.map((f) => f.kind === 'generate-secret' ? `secret:${f.key}` : f.kind === 'provision' ? `db:${f.engine}` : f.kind === 'set-port' ? `port:${f.port}` : f.kind === 'node-version' ? `node:${f.major}` : f.kind === 'node-options' ? `opts:${f.value}` : f.kind);

test('missing secrets the app owns are generated; third-party keys are left to you', () => {
  const p = plan(`Error: Missing environment variable: SESSION_SECRET\n    at Object.<anonymous> (/app/config.js:4:9)\nError: STRIPE_SECRET_KEY is required`);
  assert.deepEqual(kinds(p), ['secret:SESSION_SECRET']);
  assert.deepEqual(p.needsYou, ['STRIPE_SECRET_KEY']);
});

test('t3-env / zod "Invalid environment variables" lists are read key by key', () => {
  const p = plan(`❌ Invalid environment variables: {\n  NEXTAUTH_SECRET: [ 'Required' ],\n  DATABASE_URL: [ 'Required' ],\n  GITHUB_CLIENT_SECRET: [ 'Required' ]\n}`);
  assert.deepEqual(kinds(p).sort(), ['db:postgres', 'secret:NEXTAUTH_SECRET']);
  assert.deepEqual(p.needsYou, ['GITHUB_CLIENT_SECRET']);
});

test('Python KeyError and Django ImproperlyConfigured', () => {
  assert.deepEqual(kinds(plan(`  File "/app/settings.py", line 9\n    SECRET_KEY = os.environ['DJANGO_SECRET_KEY']\nKeyError: 'DJANGO_SECRET_KEY'`)), ['secret:DJANGO_SECRET_KEY']);
  assert.deepEqual(kinds(plan(`django.core.exceptions.ImproperlyConfigured: Set the SECRET_KEY environment variable`)), ['secret:SECRET_KEY']);
});

test('a database the app reaches for but nobody provisioned', () => {
  assert.deepEqual(kinds(plan(`Error: P1001: Can't reach database server at \`localhost\`:\`5432\``)), ['db:postgres']);
  assert.deepEqual(kinds(plan(`Error: connect ECONNREFUSED 127.0.0.1:6379`)), ['db:redis']);
  // already wired: don't add another
  assert.deepEqual(kinds(plan(`Error: P1001: Can't reach database server`, { has: { postgres: true, redis: false, mongo: false } })), []);
});

test('an app listening on another port, or only on localhost', () => {
  assert.deepEqual(kinds(plan(`> api@1.0.0 start\n> node server.js\nServer listening on port 8080`)), ['port:8080']);
  assert.deepEqual(kinds(plan(`  VITE v6.0.1  ready in 320 ms\n  ➜  Local:   http://localhost:5173/`)).sort(), ['bind-all', 'port:5173']);
  assert.deepEqual(kinds(plan(`INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)`, { cfg: { port: 8000 } })), []);
});

test('wrong Node version, build out of memory, old webpack on new Node', () => {
  assert.deepEqual(kinds(plan(`error my-app@1.0.0: The engine "node" is incompatible with this module. Expected version "^18.17.0". Got "22.11.0"`)), ['node:18']);
  assert.deepEqual(kinds(plan(`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`, { hostMemMb: 4096 })), ['opts:--max-old-space-size=2458']);
  assert.deepEqual(kinds(plan(`Error: error:0308010C:digital envelope routines::unsupported`)), ['opts:--openssl-legacy-provider']);
});

test('nothing recognisable: no fixes, honest cause', () => {
  const p = plan(`TypeError: Cannot read properties of undefined (reading 'map')\n    at Cart (/app/cart.js:88)`);
  assert.equal(p.fixes.length, 0);
  assert.equal(p.cause, 'unrecognised failure');
  assert.match(describe({ kind: 'set-port', port: 8080 }), /8080/);
});

test('Node version from engines / .nvmrc, onto the images Unit7 builds with', () => {
  assert.equal(majorFromSpec('^18.17.0'), 18);
  assert.equal(majorFromSpec('20.x'), 20);
  assert.equal(majorFromSpec('>=18'), 22); // the default satisfies it
  assert.equal(majorFromSpec('>=24'), 24);
  assert.equal(majorFromSpec('v16.20.2'), 18); // oldest image Unit7 builds
  assert.equal(majorFromSpec('lts/*'), undefined);
  assert.equal(nodeMajor({ files: [], manifests: { '.nvmrc': '20\n' } }), 20);
  assert.equal(nodeMajor({ files: [], manifests: { 'package.json': '{"engines":{"node":"^18"}}' } }), 18);
  const df = dockerfileFor({ stack: 'express', builder: 'railpack', runtime: 'node', port: 3000, needs: [], envKeys: [], healthPath: '/', notes: [], nodeVersion: 18, nodeOptions: '--max-old-space-size=2048', buildCommand: 'npm run build' }, []);
  assert.match(df!, /FROM node:18-alpine/);
  assert.match(df!, /ENV NODE_OPTIONS="--max-old-space-size=2048"\nRUN npm run build/);
});

test('migrations: the deploy-safe command per tool, the author\'s own script first', () => {
  const d = { stack: 'node', builder: 'railpack', port: 3000, needs: [], envKeys: [], healthPath: '/', notes: [] } as any;
  const pkg = (o: object) => ({ 'package.json': JSON.stringify(o) });
  assert.equal(migrationsOf({ files: ['prisma/migrations/2024_init/migration.sql', 'prisma/schema.prisma'], manifests: pkg({ dependencies: { '@prisma/client': '6' } }) }, d).migrate, 'npx prisma migrate deploy');
  assert.equal(migrationsOf({ files: ['pnpm-lock.yaml', 'migrations/0001.sql'], manifests: pkg({ scripts: { 'db:migrate': 'node m.js' } }) }, d).migrate, 'pnpm run db:migrate');
  // a "migrate" script that is really `prisma migrate dev` / `drizzle-kit push` is not deploy-safe
  assert.equal(migrationsOf({ files: ['drizzle/0000_x.sql'], manifests: pkg({ scripts: { migrate: 'drizzle-kit push' }, devDependencies: { 'drizzle-kit': '1' } }) }, d).migrate, 'npx drizzle-kit migrate');
  assert.equal(migrationsOf({ files: ['manage.py', 'shop/migrations/0001_initial.py', 'shop/migrations/__init__.py'], manifests: {} }, { ...d, stack: 'python-django' }).migrations!.join(), 'shop/migrations/0001_initial.py');
  assert.equal(migrationsOf({ files: ['index.js'], manifests: pkg({}) }, d).migrate, undefined);
  // macOS AppleDouble junk (._file) is never a migration
  assert.deepEqual(migrationsOf({ files: ['migrations/._0001.sql', 'migrations/0001.sql'], manifests: pkg({ scripts: { migrate: 'node m.js' } }) }, d).migrations, ['migrations/0001.sql']);
});

test('destructive migrations are caught; index and constraint changes are not', () => {
  assert.match(destructiveLine('-- DropTable\nDROP TABLE "Order";')!, /DROP TABLE "Order"/);
  assert.match(destructiveLine('ALTER TABLE "User" DROP COLUMN "phone";')!, /DROP COLUMN "phone"/);
  assert.match(destructiveLine('ALTER TABLE users RENAME COLUMN name TO full_name;')!, /RENAME COLUMN/);
  assert.match(destructiveLine("migrations.RemoveField(model_name='order', name='note'),")!, /RemoveField/);
  assert.match(destructiveLine("$table->dropColumn('votes');")!, /dropColumn/);
  assert.equal(destructiveLine('-- DropIndex\nDROP INDEX "User_email_key";\nALTER TABLE "Post" DROP CONSTRAINT "Post_authorId_fkey";\nCREATE TABLE x (id int);'), undefined);
  assert.equal(destructiveLine('ALTER TABLE "User" ADD COLUMN "age" INTEGER;'), undefined);
});

test('secret scan: real credentials block; placeholders in tests, examples and docs only warn', async () => {
  const { classifyLeaks } = await import('../src/deploy/security.ts');
  const r = classifyLeaks([
    { rule: 'github-pat', file: 'src/server.js', line: 3 },
    { rule: 'stripe-access-token', file: 'config/payments.ts', line: 9 },
    { rule: 'stripe-access-token', file: 'test/fixtures/stripe.json', line: 1 },
    { rule: 'aws-access-token', file: '.env.example', line: 2 },
    { rule: 'generic-api-key', file: 'src/ids.ts', line: 12 },
    { rule: 'github-pat', file: 'docs/setup.md', line: 40 },
  ]);
  assert.deepEqual(r.block.map((l) => l.file), ['src/server.js', 'config/payments.ts']);
  assert.equal(r.warn.length, 4);
});

test('trivy report → fixable critical/high counts and one line per package', async () => {
  const { summarizeTrivy } = await import('../src/deploy/security.ts');
  const rep = summarizeTrivy(JSON.stringify({ Results: [
    { Vulnerabilities: [
      { VulnerabilityID: 'CVE-1', PkgName: 'openssl', InstalledVersion: '3.0.1', FixedVersion: '3.0.9', Severity: 'HIGH' },
      { VulnerabilityID: 'CVE-2', PkgName: 'openssl', InstalledVersion: '3.0.1', FixedVersion: '3.0.9', Severity: 'CRITICAL' },
      { VulnerabilityID: 'CVE-3', PkgName: 'zlib', InstalledVersion: '1.2', Severity: 'CRITICAL' }, // no fix: not actionable
    ] },
    { Vulnerabilities: [{ VulnerabilityID: 'GHSA-x', PkgName: 'express', InstalledVersion: '4.17.1', FixedVersion: '4.19.2', Severity: 'HIGH' }] },
  ] }));
  assert.equal(rep.critical, 1);
  assert.equal(rep.high, 2);
  assert.deepEqual(rep.top.map((v) => `${v.pkg}:${v.severity}`), ['openssl:CRITICAL', 'express:HIGH']);
});

test('errors from logs: Node and Python traces, JSON logs; first frame in your code', async () => {
  const { extractErrors, fingerprint } = await import('../src/tools/errors.ts');
  const node = `GET /cart 500
TypeError: Cannot read properties of undefined (reading 'map')
    at renderCart (/app/src/cart.ts:88:21)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (node:internal/process/task_queues:105:5)
listening`;
  const py = `INFO request
Traceback (most recent call last):
  File "/usr/lib/python3.13/site-packages/flask/app.py", line 1511, in wsgi_app
    response = self.full_dispatch_request()
  File "/app/shop/views.py", line 42, in checkout
    total = order.total / order.count
ZeroDivisionError: division by zero`;
  const pino = '{"level":50,"time":1,"msg":"payment failed","err":{"type":"StripeCardError","message":"Your card was declined.","stack":"StripeCardError: Your card was declined.\\n    at /app/pay.js:9"}}';
  const ev = extractErrors([node, py, pino, '{"level":30,"msg":"fine"}'].join('\n'));
  assert.deepEqual(ev.map((e) => [e.kind, e.frame]), [['TypeError', 'src/cart.ts:88'], ['ZeroDivisionError', 'shop/views.py:42'], ['StripeCardError', undefined]]);
  assert.equal(ev[1]!.message, 'division by zero');

  // the same bug groups together despite changing details; a different bug doesn't
  const a = { kind: 'Error', message: 'User 4821 not found (req 9f8e7d6c-1a2b-4c3d-8e9f-0a1b2c3d4e5f)', frame: 'src/users.ts:10', sample: '' };
  const b = { kind: 'Error', message: 'User 77 not found (req 1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e)', frame: 'src/users.ts:12', sample: '' };
  const c = { kind: 'Error', message: 'Order 77 not found', frame: 'src/users.ts:10', sample: '' };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
});

test('job schedules: intervals from the last run, times of day in UTC, nonsense refused', async () => {
  const { nextRun } = await import('../src/tools/jobs.ts');
  const now = new Date('2026-10-06T10:00:00Z');
  assert.equal(nextRun('every 15m', null, now).toISOString(), now.toISOString(), 'a new job runs on the next sweep');
  assert.equal(nextRun('every 15m', new Date('2026-10-06T09:50:00Z'), now).toISOString(), '2026-10-06T10:05:00.000Z');
  assert.equal(nextRun('daily 03:30', null, now).toISOString(), '2026-10-07T03:30:00.000Z');
  assert.equal(nextRun('daily 11:00', null, now).toISOString(), '2026-10-06T11:00:00.000Z');
  assert.equal(nextRun('daily 11:00', new Date('2026-10-06T11:00:00Z'), now).toISOString(), '2026-10-07T11:00:00.000Z');
  assert.equal(nextRun('Hourly', new Date('2026-10-06T09:00:00Z'), now).toISOString(), '2026-10-06T10:00:00.000Z');
  assert.throws(() => nextRun('every 0m', null, now), /at most once a minute/);
  assert.throws(() => nextRun('at midnight', null, now), /isn't a schedule/);
});

test('Procfile: processes read; release becomes the migrate step when nothing else is', async () => {
  const { detect } = await import('../src/connectors/detect.ts');
  const d = detect({ files: ['package.json', 'Procfile', 'server.js'], manifests: { 'package.json': '{"scripts":{"start":"node server.js"}}', Procfile: 'web: node server.js\nworker: node worker.js\nrelease: node migrate.js\n' } });
  assert.deepEqual(d.processes, { web: 'node server.js', worker: 'node worker.js', release: 'node migrate.js' });
  assert.equal(d.migrate, 'node migrate.js');
});
