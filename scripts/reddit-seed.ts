// Wipes and rebuilds <repo>/.unit7 as a realistic demo instance, so the web UI can be designed against
// real-looking data. Run: npm run demo:seed  (then start the demo server; the command is in .unit7/DEMO_LOGIN.md)
//
// The owner signs up through the real HTTP endpoint, like the web Auth page. Everything else is written the
// way Unit7's own code writes it: env vars through setVar (encrypted with the vault), the Unit7 part of the
// map through scanUnit7, and the map itself through the same mergeFound/resolve steps a sync runs. Timestamps
// are spread over the last weeks. Nothing calls a provider: the provider accounts have no stored credentials
// and the server has no SSH key, so anything that would reach out fails locally instead.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(tmpdir(), 'unit7-reddit-demo', '.unit7');
const SANDBOX = join(HOME, 'sandbox-home'); // the server's HOME here: it never touches your real ~/.claude or synced folders
const PORT = 4872;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = { name: 'Sam', email: 'demo@unit7.test', orgName: 'Lumen' };
const SERVE = `UNIT7_HOME="${HOME}" UNIT7_WARDEN=off UNIT7_KEYCHAIN=off UNIT7_SKIP_NET_PROBE=1 node src/main.ts serve --port ${PORT}`;

// --- the server, as a child process with a clean environment (no inherited API keys, UNIT7_URL…) -----
const serverEnv = {
  PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8', TMPDIR: process.env.TMPDIR ?? '/tmp',
  HOME: SANDBOX, UNIT7_SYNC_HOME: SANDBOX, UNIT7_HOME: HOME, UNIT7_WARDEN: 'off', UNIT7_KEYCHAIN: 'off', UNIT7_SKIP_NET_PROBE: '1',
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const healthy = () => fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
let serverLog = '';

async function up(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['src/main.ts', 'serve', '--port', String(PORT)], { cwd: ROOT, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => (serverLog += d));
  child.stderr!.on('data', (d) => (serverLog += d));
  for (let i = 0; i < 150 && child.exitCode === null; i++) { if (await healthy()) return child; await sleep(200); }
  child.kill('SIGKILL');
  throw new Error(`The server didn't start:\n${serverLog}`);
}
async function down(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([gone, sleep(5000).then(() => child.kill('SIGKILL'))]);
}

let sessionBind = ''; // a session is the cookie plus this value, sent back at login (web/src/lib/api.ts)
async function http(path: string, o: { cookie?: string; body?: unknown } = {}) {
  const res = await fetch(BASE + path, {
    method: o.body === undefined ? 'GET' : 'POST',
    headers: { origin: BASE, 'x-unit7-bind': sessionBind, ...(o.cookie && { cookie: o.cookie }), ...(o.body !== undefined && { 'content-type': 'application/json' }) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  sessionBind = res.headers.get('x-unit7-bind') ?? sessionBind;
  return { status: res.status, data: await res.json().catch(() => null) as any, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

// --- 1. a fresh .unit7, and the owner signing up over HTTP ---------------------------------------------
if (await healthy()) { console.error(`Something is already running on :${PORT}. Stop the demo server first, then run this again.`); process.exit(1); }
if (!HOME.endsWith('/.unit7')) throw new Error(`Refusing to wipe ${HOME}`);
rmSync(HOME, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true, mode: 0o700 });
const password = randomBytes(18).toString('base64url');

let server = await up();
try {
  const setup = await http('/api/setup');
  if (!setup.data?.needsSetup) throw new Error('A fresh .unit7 should need setup.');
  const r = await http('/api/auth/signup', { body: { ...OWNER, password } });
  if (r.status !== 200) throw new Error(`Signup failed: ${r.status} ${JSON.stringify(r.data)}`);
} finally { await down(server); }

// --- 2. everything else, written in-process the way Unit7 writes it ------------------------------------
Object.assign(process.env, serverEnv);
for (const k of ['UNIT7_MASTER_KEY', 'UNIT7_MASTER_PASSPHRASE', 'UNIT7_URL']) delete process.env[k];
const { createApp } = await import('../src/app.ts');
await import('../src/tools/index.ts');
const { get, id, run, tx } = await import('../src/db.ts');
const { setVar } = await import('../src/tools/env.ts');
const { scanUnit7 } = await import('../src/discovery/scanners.ts');
const { mergeFound, resolve, domainKey, envRefs } = await import('../src/discovery/model.ts');
const { suggest, thingsFrom } = await import('../src/tools/links.ts');
const { targets } = await import('../src/sentinel/watch.ts');
const { decide, DEFAULT_AUTONOMY } = await import('../src/policy.ts');
const { createToken } = await import('../src/auth.ts');
const { Redactor } = await import('../src/redact.ts');
const { rollup, summarize } = await import('../src/discovery/xray.ts');
const { saveXray } = await import('../src/tools/xray.ts');
const { nextRun, parseSchedule } = await import('../src/tools/routines.ts');
type Inventory = import('../src/discovery/xray.ts').Inventory;
type Sizes = import('../src/discovery/xray.ts').Sizes;
type Found = import('../src/discovery/model.ts').Found;
type Ref = import('../src/discovery/model.ts').Ref;
type Actor = import('../src/tools/runtime.ts').Actor;
type Ctx = import('../src/tools/runtime.ts').Ctx;
type EnvKind = import('../src/policy.ts').EnvKind;

const app = createApp();
const { db } = app;
const user = get<{ id: string; email: string; name: string }>(db, 'SELECT id, email, name FROM users WHERE email = ?', OWNER.email)!;
const org = get<{ id: string; name: string; slug: string }>(db, 'SELECT o.id, o.name, o.slug FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ?', user.id)!;
const orgId = org.id;

const NOW = Date.now();
const M = 60_000, H = 3_600_000, D = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
let seed = 1872799;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const hex = (n: number) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
const IP = '203.0.113.10'; // TEST-NET-3 (documentation range): the demo can never reach a real server
const VM = 100042;
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

const ME: Actor = { kind: 'user', id: user.id, userId: user.id, name: user.name, role: 'owner' };
const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };
// how an MCP call from Claude Code shows up: the "Unit7 connect" token's agent role (auth.actorOf)
const token = createToken(db, { user, org, role: 'owner', via: 'session' }, 'Unit7 connect · Claude Code', 'agent');
const CLAUDE: Actor = { kind: 'agent', id: token.id, userId: user.id, name: `${user.name} (token Unit7 connect · Claude Code)`, role: 'agent', agent: 'Unit7 connect · Claude Code' };
const MCP = 'mcp (external agent)';

const ctx = {
  app, db, orgId, actor: ME, env: undefined, projectId: undefined, signal: new AbortController().signal, redactor: new Redactor(), resources: [],
  secret: (ref: string) => app.vault.resolve(orgId, ref),
  credentialFor: () => { throw new Error('no provider calls while seeding'); }, progress() {}, emit() {},
} as unknown as Ctx;

function ev(at: number, type: string, severity: string, message: string, o: { projectId?: string; environmentId?: string; resource?: string; data?: object } = {}) {
  run(db, `INSERT INTO events (id, org_id, type, severity, message, project_id, environment_id, resource, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id('evt'), orgId, type, severity, message, o.projectId ?? null, o.environmentId ?? null, o.resource ?? null, JSON.stringify(o.data ?? {}), ago(at));
}
function audit(at: number, actor: Actor, tool: string, action: string, risk: string, result: string, o: { input?: object; output?: object; error?: string; ms?: number; reason?: string; projectId?: string; environmentId?: string; approvalId?: string; resources?: string[] } = {}) {
  const auditId = id('aud');
  run(db, `INSERT INTO audit (id, org_id, actor_kind, actor_id, actor_name, agent, user_id, project_id, environment_id, tool, action, risk, reason, input, output, result, error, duration_ms, resources, approval_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, auditId, orgId, actor.kind, actor.id, actor.name, actor.agent ?? null, actor.userId,
    o.projectId ?? null, o.environmentId ?? null, tool, action, risk, o.reason ?? null, stable(o.input ?? {}), o.output ? JSON.stringify(o.output) : null, result, o.error ?? null, o.ms ?? null,
    JSON.stringify(o.resources ?? []), o.approvalId ?? null, ago(at));
  return auditId;
}

const summary: string[] = [];
tx(db, () => {
  // the signup happened three weeks ago
  for (const [t, where] of [['users', `id = '${user.id}'`], ['orgs', `id = '${orgId}'`], ['memberships', `user_id = '${user.id}'`], ['audit', `tool = 'auth.signup'`]]) run(db, `UPDATE ${t} SET created_at = ? WHERE ${where}`, ago(22 * D));
  run(db, `UPDATE api_tokens SET created_at = ?, last_used_at = ? WHERE id = ?`, ago(20 * D), ago(35 * M), token.id);
  // DNS changes need a person's OK org-wide (that's why shop.nestly.example waits on the Approvals page)
  run(db, `UPDATE orgs SET rules = ? WHERE id = ?`, JSON.stringify({ dns_write: 'restricted' }), orgId);
});

// --- provider accounts (no credentials stored: nothing here can reach a provider) ----------------------
const accounts: Record<string, string> = {};
tx(db, () => {
  const acct = (key: string, provider: string, name: string, at: number, meta: object, credential: string) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const accId = id('acc');
    run(db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
      accId, orgId, provider, name, slug, JSON.stringify({ ref: `credential://${provider}/${slug}/${credential}`, ...meta }), ago(at - 2 * H), ago(at));
    ev(at, 'account.connected', 'success', `${name} connected`, { resource: accId });
    accounts[key] = accId;
  };
  acct('hostinger', 'hostinger', 'Hostinger', 21 * D, { auth: 'oauth', mcpUrl: 'https://mcp.hostinger.com', facts: { connected: 'one-click sign-in' } }, 'oauth');
  acct('github', 'github', 'GitHub · acme', 20 * D, { login: 'acme', facts: { label: 'acme' } }, 'token');
  acct('vercel', 'vercel', 'Vercel · demo', 14 * D, { facts: { label: 'demo' } }, 'token');
  acct('cloudflare', 'cloudflare', 'Cloudflare · demo', 13 * D, { facts: { label: 'demo', zones: 2 } }, 'token');
  acct('supabase', 'supabase', 'Supabase · demo', 10 * D, { auth: 'oauth', mcpUrl: 'https://mcp.supabase.com/mcp', facts: { label: 'demo' } }, 'oauth');
});

// --- the server: a Hostinger VPS, prepared by Unit7 ---------------------------------------------------
const GB = 1024 ** 3;
const srvId = id('srv');
tx(db, () => {
  const facts = {
    os: 'Ubuntu 24.04.3 LTS', os_id: 'ubuntu', os_like: 'debian', kernel: '6.8.0-85-generic', arch: 'x86_64', cpus: 2, mem_total: 8 * GB - 254 * 1024 ** 2,
    mem_available: Math.round(3.05 * GB), swap_total: 2 * GB, disk_total: 96 * GB + 0.7 * GB, disk_used: Math.round(46.6 * GB), uptime: 19 * 86400 + 4 * 3600, load: '0.68 0.74 0.71',
    docker: '28.4.0', compose: '2.39.4', caddy: 'Up 19 days', ufw: 'active', user: 'root', sudo: 'root', ports: [22, 80, 443],
    has: ['git', 'curl', 'ufw', 'apt-get', 'systemctl', 'journalctl', 'ss', 'python3'], checkedAt: ago(2 * M), publicIp: IP,
    blocks: [{ ip: '198.51.100.23', reason: 'vulnerability scanner', until: NOW + 22 * M, strikes: 2 }],
  };
  run(db, `INSERT INTO servers (id, org_id, name, host, port, username, key_ref, account_id, provider_ref, status, facts, last_seen_at, created_at)
    VALUES (?, ?, 'vps-01', ?, 22, 'root', 'credential://ssh/vps-01/private-key', ?, ?, 'ready', ?, ?, ?)`, srvId, orgId, IP, accounts.hostinger, `hostinger:vm:${VM}`, JSON.stringify(facts), ago(1 * M), ago(21 * D));
  ev(21 * D - 5 * M, 'server.connected', 'success', 'Connected vps-01 (Ubuntu 24.04.3 LTS, 2 CPU, 7.8 GB RAM)', { resource: srvId });
  ev(21 * D - 9 * M, 'server.ready', 'success', 'vps-01 is ready: Docker 28.4.0, Caddy running, firewall on', { resource: srvId });
});

// --- projects, environments, services, deployments ---------------------------------------------------
interface Env { id: string; projectId: string; name: string; kind: EnvKind }
interface Svc { id: string; name: string; slug: string; kind: string; env: Env }
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const containerName = (s: Svc, n: number) => `unit7-${s.slug}-${s.env.id.slice(-6)}-${n}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
const internal = (s: Svc) => `unit7-${s.slug}-${s.env.id.slice(-6)}`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');

function project(name: string, repo: string | null, description: string, at: number, by: Actor) {
  const pid = id('prj');
  run(db, 'INSERT INTO projects (id, org_id, name, slug, description, repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', pid, orgId, name, slugOf(name), description, repo, ago(at));
  ev(at, 'project.created', 'success', `Created project ${name}`, { projectId: pid, resource: pid });
  audit(at, by, 'project.create', 'project_write', 'write', 'success', { input: { name, ...(repo && { repo }) }, output: { projectId: pid }, ms: 14, projectId: pid, reason: by === CLAUDE ? MCP : undefined });
  return pid;
}
function environment(projectId: string, kind: EnvKind, at: number, rules: object = {}): Env {
  const eid = id('env');
  const name = kind[0]!.toUpperCase() + kind.slice(1);
  run(db, 'INSERT INTO environments (id, org_id, project_id, name, slug, kind, autonomy, rules, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    eid, orgId, projectId, name, kind, kind, DEFAULT_AUTONOMY[kind], JSON.stringify(rules), ago(at));
  return { id: eid, projectId, name, kind };
}
const bind = (env: Env, ...keys: string[]) => { for (const k of keys) run(db, 'INSERT INTO environment_accounts (environment_id, provider, account_id) VALUES (?, ?, ?)', env.id, k, accounts[k]!); };
function service(env: Env, name: string, kind: string, config: object, at: number, status = 'healthy'): Svc {
  const s: Svc = { id: id('svc'), name, slug: slugOf(name), kind, env };
  run(db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id, orgId, env.projectId, env.id, srvId, name, s.slug, kind, JSON.stringify(config), status, ago(at));
  return s;
}
function domain(s: Svc, hostname: string, at: number, o: { status?: string; tls?: string; auto?: boolean; dns?: string; zone?: string; checked?: number } = {}) {
  const domId = id('dom');
  run(db, `INSERT INTO domains (id, org_id, hostname, service_id, account_id, zone, status, tls, checked_at, tls_mode, auto, target, records, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?)`,
    domId, orgId, hostname, s.id, o.dns ? accounts[o.dns]! : null, o.zone ?? null, o.status ?? 'active', o.tls ?? 'active', ago(o.checked ?? 3 * H), o.auto ? 1 : 0,
    o.auto ? null : JSON.stringify({ kind: 'unit7', serviceId: s.id }), o.auto ? null : JSON.stringify([{ type: 'A', name: hostname, content: IP }]), ago(at));
  return domId;
}
const vars = (scope: { type: 'project' | 'environment' | 'service'; id: string; label: string }, values: Record<string, string>, at: number, by: Actor = ME) => {
  for (const [k, v] of Object.entries(values)) setVar({ ...ctx, actor: by } as Ctx, scope, k, v);
  run(db, `UPDATE env_vars SET created_at = ? WHERE scope_type = ? AND scope_id = ?`, ago(at), scope.type, scope.id);
};
const profile = (projectId: string, line: string, at: number) =>
  run(db, 'INSERT INTO memories (id, org_id, project_id, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', id('mem'), orgId, projectId, `Profile · ${line}`, 'Unit7 (from the code)', ago(at));

interface Dep { n: number; at: number; status: 'live' | 'stopped' | 'failed'; by: Actor; error?: string; took?: number; migrated?: string[] }
type Source = { type: 'git'; repo: string; branch: string; accountId: string } | { type: 'image'; image: string };
function deploys(s: Svc, source: Source, detection: Record<string, unknown>, list: Dep[], url?: string) {
  const repo = source.type === 'git' ? source.repo : source.image;
  const ids: Record<number, string> = {};
  for (const d of list) {
    const depId = id('dep');
    ids[d.n] = depId;
    const sha = hex(40), took = d.took ?? Math.round((70 + rnd() * 110) * 1000), fin = d.at - took;
    const t = (ms: number) => new Date(NOW - d.at + ms).toISOString().slice(11, 19);
    const ok = d.status !== 'failed';
    const log = [...(source.type === 'git' ? [`${t(0)} Cloning ${repo} (main)…`, `${t(2400)} Commit ${sha.slice(0, 7)}.`, `${t(4100)} Detected ${detection.stack}. Port ${detection.port}.`] : [`${t(0)} Using image ${repo}.`]),
      ...(d.migrated ? [`${t(took - 30_000)} Running database migrations (${d.migrated.length} new): ${detection.migrate}`, `${t(took - 22_000)} Migrated: ${d.migrated.length} new migration${d.migrated.length > 1 ? 's' : ''}.`] : []),
      ...(ok ? [`${t(took - 14_000)} Starting ${containerName(s, d.n)}…`, `${t(took - 2000)} Healthy: ${detection.healthPath ?? '/'} answered 200.`, `${t(took)} Traffic now goes to deploy #${d.n}.`]
        : [`${t(took)} Build failed.`])].join('\n');
    const plan = { ...(source.type === 'git' && { commit: sha }), stack: detection.stack, builder: detection.builder, port: detection.port, needs: detection.needs, envKeys: detection.envKeys, nodeVersion: detection.nodeVersion, migrations: detection.migrations ?? [], ...(d.migrated && { migrated: d.migrated }) };
    run(db, `INSERT INTO deployments (id, org_id, service_id, number, status, source, plan, image, container, log, error, triggered_by, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      depId, orgId, s.id, d.n, d.status, JSON.stringify(source), JSON.stringify(plan), ok ? (source.type === 'image' ? source.image : `unit7/${s.slug}:${d.n}`) : null,
      ok ? containerName(s, d.n) : null, log, d.error ?? null, d.by.name, ago(d.at), ago(fin));
    const where = { projectId: s.env.projectId, environmentId: s.env.id };
    if (d.by === WARDEN) ev(d.at + 20_000, 'deployment.auto', 'info', `New commit ${sha.slice(0, 7)} on ${repo}: deploying ${s.name}`, { ...where, resource: s.id });
    ev(d.at, 'deployment.started', 'info', `Deploy #${d.n} of ${s.name} started`, { ...where, resource: s.id, data: { deploymentId: depId, number: d.n } });
    if (ok) ev(fin, 'deployment.succeeded', 'success', `${s.name} deploy #${d.n} is live${url ? ` at ${url}` : ''}`, { ...where, resource: s.id, data: { deploymentId: depId, number: d.n, url } });
    else ev(fin, 'deployment.failed', 'warning', `Deploy #${d.n} of ${s.name} failed: ${d.error!.split('\n')[0]}`, { ...where, resource: s.id, data: { deploymentId: depId, number: d.n } });
    ev(fin - 500, ok ? 'action.completed' : 'action.failed', ok ? 'success' : 'warning', ok ? `${d.by.name}: Deploy a service` : `Deploy a service failed: ${d.error!.split('\n')[0]}`, where);
    audit(fin, d.by, 'deployment.create', 'deploy', 'write', ok ? 'success' : 'error', {
      input: { serviceId: s.id }, ...where, ms: took, reason: d.by === WARDEN ? `new commit ${sha.slice(0, 7)}` : d.by === CLAUDE ? MCP : undefined,
      ...(ok ? { output: { deploymentId: depId, number: d.n, status: 'live', ...(url && { url }) } } : { error: `build_failed: ${d.error}` }), resources: [depId],
    });
  }
  const live = list.find((d) => d.status === 'live');
  if (live) run(db, 'UPDATE services SET current_deployment_id = ? WHERE id = ?', ids[live.n]!, s.id);
  return ids;
}

const nextApp = (envKeys: string[]) => ({ stack: 'next', builder: 'railpack', runtime: 'node', packageManager: 'pnpm', buildCommand: 'pnpm build', startCommand: 'pnpm start', port: 3000, needs: [], envKeys, healthPath: '/api/health', healthRoute: true, scaleRisks: [], nodeVersion: 22, notes: [] });
const gitSource = (repo: string): Source => ({ type: 'git', repo, branch: 'main', accountId: accounts.github! });
const live: Svc[] = []; // everything with a running container (for the server's container stats)
let web!: Svc, webStaging!: Svc, api!: Svc, worker!: Svc, pgProd!: Svc, apiStaging!: Svc, nestProd!: Env;
const nestDeps: Record<number, string> = {};

tx(db, () => {
  // nestly: a Next.js app (production + staging live, development empty)
  const repo = 'acme/nestly';
  const p = project('nestly', repo, 'Roommate and flat matching for students and young professionals.', 20 * D, ME);
  const dev = environment(p, 'development', 20 * D), stg = environment(p, 'staging', 20 * D);
  nestProd = environment(p, 'production', 20 * D, { rollback: 'restricted' });
  bind(nestProd, 'hostinger', 'cloudflare', 'github'); bind(stg, 'hostinger', 'cloudflare', 'github'); bind(dev, 'github');
  const keys = ['NEXT_PUBLIC_SITE_NAME', 'NEXT_PUBLIC_SITE_URL', 'NEXTAUTH_URL', 'NEXTAUTH_SECRET', 'RESEND_API_KEY'];
  const cfg = { source: gitSource(repo), port: 3000, detection: nextApp(keys), autoDeploy: true, previews: true };
  vars({ type: 'project', id: p, label: 'nestly' }, { NEXT_PUBLIC_SITE_NAME: 'Nestly' }, 20 * D);
  vars({ type: 'environment', id: nestProd.id, label: 'Production' }, { NEXT_PUBLIC_SITE_URL: 'https://nestly.example', NEXTAUTH_URL: 'https://nestly.example', NEXTAUTH_SECRET: randomBytes(32).toString('base64'), RESEND_API_KEY: `re_${randomBytes(18).toString('base64url')}` }, 19 * D);
  setVar(ctx, { type: 'environment', id: nestProd.id, label: 'Production' }, 'RESEND_API_KEY', `re_${randomBytes(18).toString('base64url')}`);
  run(db, `UPDATE env_vars SET created_at = ? WHERE scope_id = ? AND key = 'RESEND_API_KEY' AND version = 2`, ago(5 * D + 6 * H), nestProd.id);
  vars({ type: 'environment', id: stg.id, label: 'Staging' }, { NEXT_PUBLIC_SITE_URL: 'https://staging.nestly.example', NEXTAUTH_URL: 'https://staging.nestly.example', NEXTAUTH_SECRET: randomBytes(32).toString('base64') }, 19 * D);
  web = service(nestProd, 'web', 'app', cfg, 19 * D);
  domain(web, 'nestly.example', 19 * D, { dns: 'cloudflare', zone: 'nestly.example' });
  domain(web, 'www.nestly.example', 19 * D, { dns: 'cloudflare', zone: 'nestly.example' });
  Object.assign(nestDeps, deploys(web, cfg.source, cfg.detection, [
    { n: 38, at: 6 * D + 4 * H, status: 'stopped', by: WARDEN },
    { n: 39, at: 5 * D + 2 * H, status: 'stopped', by: CLAUDE },
    { n: 40, at: 3 * D + 3 * H, status: 'failed', by: WARDEN, error: "The build failed.\n./app/listings/[id]/page.tsx:42:18 Type error: Property 'city' does not exist on type 'Listing'." },
    { n: 41, at: 3 * D + 1 * H, status: 'stopped', by: CLAUDE },
    { n: 42, at: 20 * H, status: 'live', by: WARDEN },
  ], 'https://nestly.example'));
  webStaging = service(stg, 'web', 'app', { ...cfg, previews: false }, 19 * D);
  domain(webStaging, 'staging.nestly.example', 19 * D, { dns: 'cloudflare', zone: 'nestly.example' });
  deploys(webStaging, cfg.source, cfg.detection, [
    { n: 13, at: 6 * D + 7 * H, status: 'stopped', by: WARDEN }, { n: 14, at: 4 * D + 5 * H, status: 'stopped', by: WARDEN }, { n: 15, at: 2 * D + 6 * H, status: 'live', by: WARDEN },
  ], 'https://staging.nestly.example');
  live.push(web, webStaging);
  profile(p, 'web: next (pnpm), port 3000 · reads 5 settings (NEXT_PUBLIC_SITE_NAME, NEXT_PUBLIC_SITE_URL, NEXTAUTH_URL, NEXTAUTH_SECRET, RESEND_API_KEY) · has a health route · safe to run as several copies', 20 * H);
  run(db, 'INSERT INTO memories (id, org_id, project_id, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', id('mem'), orgId, p,
    'Listing photos are served from Cloudflare R2 (bucket nestly-media); the app only stores their keys.', CLAUDE.name, ago(9 * D));
  audit(19 * D, ME, 'environment.policy', 'policy_change', 'write', 'success', { input: { environmentId: nestProd.id, rules: { rollback: 'restricted' } }, projectId: p, environmentId: nestProd.id, ms: 9 });
  ev(19 * D, 'policy.changed', 'warning', 'Sam set Production to autonomy 3', { projectId: p, environmentId: nestProd.id, resource: nestProd.id });
  // the agent tried to raise its own autonomy: people only
  audit(3 * D + 50 * M, CLAUDE, 'environment.policy', 'policy_change', 'write', 'denied', { input: { environmentId: nestProd.id, autonomy: 4 }, projectId: p, environmentId: nestProd.id, reason: MCP, error: "Only a person can change autonomy and policy. An AI can't do this, even with approval." });

  // shipfast: a Node API with Postgres and a background worker (production + staging)
  const srepo = 'acme/shipfast-api';
  const sp = project('shipfast', srepo, 'Shipping labels and pickups API for small sellers.', 18 * D, ME);
  const sprod = environment(sp, 'production', 18 * D), sstg = environment(sp, 'staging', 18 * D);
  bind(sprod, 'hostinger', 'github'); bind(sstg, 'hostinger', 'github');
  const migrations = ['prisma/migrations/20260911_init/migration.sql', 'prisma/migrations/20260923_shipments_index/migration.sql', 'prisma/migrations/20261003_pickup_slots/migration.sql'];
  const det = { stack: 'node', builder: 'railpack', runtime: 'node', packageManager: 'npm', buildCommand: 'npm run build', startCommand: 'node dist/server.js', port: 8080, needs: ['postgres'],
    envKeys: ['DATABASE_URL', 'JWT_SECRET', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'CARRIER_API_URL', 'NODE_ENV'], healthPath: '/health', healthRoute: true, scaleRisks: [], nodeVersion: 22,
    migrate: 'npx prisma migrate deploy', migrations, processes: { web: 'node dist/server.js', worker: 'node dist/worker.js' }, notes: [] };
  const db_ = (env: Env, name: string, at: number) => {
    const container = `unit7-${slugOf(name)}-${env.id.slice(-6)}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
    const s = service(env, name, 'postgres', { engine: 'postgres', container, database: 'shipfast', port: 5432, passwordRef: `credential://postgres/${slugOf(name)}/password`, volume: `${container}-data` }, at);
    const pw = randomBytes(18).toString('base64url');
    app.vault.put(orgId, `credential://postgres/${slugOf(name)}/password`, pw, { kind: 'db_password', by: CLAUDE.name });
    app.vault.put(orgId, `credential://postgres/${slugOf(name)}/url`, `postgresql://postgres:${pw}@${container}:5432/shipfast`, { kind: 'connection_url', by: CLAUDE.name });
    run(db, `UPDATE secrets SET created_at = ? WHERE ref LIKE ?`, ago(at), `credential://postgres/${slugOf(name)}/%`);
    return s;
  };
  vars({ type: 'project', id: sp, label: 'shipfast' }, { CARRIER_API_URL: 'https://api.carrier.example/v1' }, 18 * D);
  vars({ type: 'environment', id: sprod.id, label: 'Production' }, { NODE_ENV: 'production', JWT_SECRET: randomBytes(32).toString('base64url'), RAZORPAY_KEY_ID: `rzp_live_${randomBytes(10).toString('base64url')}`, RAZORPAY_KEY_SECRET: randomBytes(18).toString('base64url') }, 18 * D);
  vars({ type: 'environment', id: sstg.id, label: 'Staging' }, { NODE_ENV: 'staging', JWT_SECRET: randomBytes(32).toString('base64url') }, 17 * D);
  const acfg = { source: gitSource(srepo), port: 8080, detection: det, autoDeploy: true, previews: false };
  api = service(sprod, 'api', 'app', acfg, 18 * D);
  pgProd = db_(sprod, 'db', 18 * D);
  vars({ type: 'service', id: api.id, label: 'api' }, { DATABASE_URL: 'credential://postgres/db/url' }, 18 * D, CLAUDE);
  ev(18 * D - 4 * M, 'database.created', 'success', 'Created postgres "db", wired into the app', { projectId: sp, environmentId: sprod.id, resource: pgProd.id });
  audit(18 * D - 4 * M, CLAUDE, 'database.create', 'database_create', 'write', 'success', { input: { environmentId: sprod.id, engine: 'postgres', name: 'db', database: 'shipfast', injectInto: api.id }, output: { serviceId: pgProd.id, engine: 'postgres', connectionUrl: 'credential://postgres/db/url', injected: 'DATABASE_URL → api' }, projectId: sp, environmentId: sprod.id, ms: 21_400, reason: MCP });
  domain(api, 'api.shipfast.example', 17 * D, { dns: 'hostinger', zone: 'shipfast.example' });
  deploys(api, acfg.source, det, [
    { n: 21, at: 6 * D + 1 * H, status: 'stopped', by: CLAUDE }, { n: 22, at: 5 * D + 18 * H, status: 'stopped', by: WARDEN },
    { n: 23, at: 4 * D + 2 * H, status: 'live', by: WARDEN, migrated: [migrations[2]!], took: 164_000 },
  ], 'https://api.shipfast.example');
  worker = service(sprod, 'api worker', 'worker', { source: gitSource(srepo), startCommand: 'node dist/worker.js', nodeVersion: 22, workerOf: api.id, workerName: 'worker', previews: false }, 16 * D);
  deploys(worker, acfg.source, { ...det, healthPath: undefined }, [{ n: 7, at: 5 * D + 18 * H - 3 * M, status: 'stopped', by: WARDEN }, { n: 8, at: 4 * D + 2 * H - 4 * M, status: 'live', by: WARDEN }]);
  apiStaging = service(sstg, 'api', 'app', acfg, 17 * D);
  const pgStg = db_(sstg, 'db-staging', 17 * D);
  vars({ type: 'service', id: apiStaging.id, label: 'api' }, { DATABASE_URL: 'credential://postgres/db-staging/url' }, 17 * D, CLAUDE);
  // moved off Render, but its DNS still points there
  domain(apiStaging, 'api-staging.shipfast.example', 17 * D, { dns: 'hostinger', zone: 'shipfast.example', status: 'broken', checked: 30 * H });
  ev(30 * H, 'domain.broken', 'critical', 'api-staging.shipfast.example stopped pointing where it should (api-staging.shipfast.example → shipfast-staging.onrender.com)', { projectId: sp, environmentId: sstg.id, resource: apiStaging.id });
  deploys(apiStaging, acfg.source, det, [{ n: 8, at: 7 * D + 3 * H, status: 'stopped', by: CLAUDE }, { n: 9, at: 5 * D + 20 * H, status: 'live', by: WARDEN, migrated: [migrations[2]!] }], 'https://api-staging.shipfast.example');
  live.push(api, worker, pgProd, apiStaging, pgStg);
  profile(sp, 'api: node (npm), port 8080 · uses postgres · reads 6 settings (DATABASE_URL, JWT_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, CARRIER_API_URL, NODE_ENV) · has a health route · safe to run as several copies', 4 * D);
  run(db, 'INSERT INTO memories (id, org_id, project_id, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', id('mem'), orgId, sp,
    'Razorpay webhooks call https://api.shipfast.example/webhooks/razorpay; keep that path stable.', CLAUDE.name, ago(12 * D));

  // backups of the production database: daily, kept 7, copied off the server, proven weekly
  run(db, `INSERT INTO backup_schedules (id, org_id, service_id, frequency, keep, last_run_at, created_at) VALUES (?, ?, ?, 'daily', 7, ?, ?)`, id('bsc'), orgId, pgProd.id, ago(9 * H), ago(18 * D));
  const backup = (at: number, reason: string, mb: number, by: Actor, verified?: string) => {
    const bid = id('bak'), stamp = new Date(NOW - at).toISOString().replace(/[:.]/g, '-'), size = Math.round(mb * 1048576), file = `/var/lib/unit7/backups/db-${stamp}.gz`;
    run(db, `INSERT INTO backups (id, org_id, service_id, kind, reason, location, size, checksum, status, verified_at, verify_ok, verify_note, offsite, created_at, finished_at) VALUES (?, ?, ?, 'postgres', ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?)`,
      bid, orgId, pgProd.id, reason, file, size, hex(64), verified ? ago(at - 2 * H) : null, verified ? 1 : null, verified ?? null,
      JSON.stringify({ local: join(HOME, 'backups', orgId, 'db', `db-${stamp}.gz.enc`), size: size + 4096, at: ago(at - 40_000) }), ago(at), ago(at - 26_000));
    const where = { projectId: sp, environmentId: sprod.id, resource: pgProd.id };
    ev(at - 26_000, 'backup.created', 'info', `Backed up db (${mb.toFixed(1)} MB) — ${reason}`, { ...where, data: { backupId: bid } });
    ev(at - 40_000, 'backup.offsite', 'success', "db's backup is safe off the server (this computer)", where);
    audit(at - 26_000, by, 'backup.create', 'backup', 'write', 'success', { input: { serviceId: pgProd.id, reason }, output: { backupId: bid, size, location: file }, ms: 26_000, projectId: sp, environmentId: sprod.id, reason: by === WARDEN ? 'Warden: scheduled backup' : undefined });
    if (verified) ev(at - 2 * H, 'backup.verified', 'success', `Backup of db (its off-server copy) restores cleanly (${verified})`, where);
  };
  for (let day = 6; day >= 0; day--) backup(day * D + 9 * H, 'scheduled (daily)', 14.1 + (6 - day) * 0.09, WARDEN, day === 3 ? '23 tables, 41,208 rows' : undefined);
  backup(4 * D + 2 * H + 40_000, 'migrating api (deploy #23)', 14.4, WARDEN);

  // errors grouped from the app's logs
  const errGroup = (s: Svc, kind: string, message: string, frame: string, sample: string, total: number, first: number, last: number, firstDeploy: number, hits: number[]) => {
    const gid = id('err');
    run(db, `INSERT INTO error_groups (id, org_id, service_id, fingerprint, kind, message, frame, sample, count, first_seen, last_seen, first_deploy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      gid, orgId, s.id, hex(16), kind, message, frame, sample, total, ago(first), ago(last), firstDeploy);
    hits.forEach((n, i) => run(db, 'INSERT INTO error_hits (group_id, at, n) VALUES (?, ?, ?)', gid, ago(last + i * 9 * M), n));
  };
  errGroup(web, 'TypeError', "Cannot read properties of null (reading 'city')", 'app/listings/[id]/page.tsx:42',
    "TypeError: Cannot read properties of null (reading 'city')\n    at ListingPage (app/listings/[id]/page.tsx:42:31)\n    at renderWithHooks (node_modules/react-dom/cjs/react-dom-server.node.production.js:4213:18)", 37, 19 * H, 6 * M, 42, [6, 4, 5, 3, 2, 4]);
  errGroup(api, 'PrismaClientKnownRequestError', 'Unique constraint failed on the fields: (`awb_number`)', 'src/shipments/create.ts:88',
    'PrismaClientKnownRequestError: Unique constraint failed on the fields: (`awb_number`)\n    at createShipment (src/shipments/create.ts:88:17)\n    at async POST /v1/shipments (src/routes/shipments.ts:31:5)', 9, 3 * D, 2 * H, 23, [1]);

  // playground: only development and staging; scratch: nothing yet
  const pg = project('playground', null, 'Experiments that never ship.', 9 * D, CLAUDE);
  const pgDev = environment(pg, 'development', 9 * D), pgStgEnv = environment(pg, 'staging', 9 * D);
  const sbSource: Source = { type: 'image', image: 'ghcr.io/acme/sandbox:latest' }, webSource: Source = { type: 'image', image: 'ghcr.io/acme/playground-web:0.3.1' };
  const sandbox = service(pgDev, 'sandbox', 'app', { source: sbSource, port: 80, detection: { stack: 'vite', builder: 'static', port: 80, staticDir: 'dist', needs: [], envKeys: [], healthPath: '/', notes: [] } }, 9 * D);
  const pgWeb = service(pgStgEnv, 'web', 'app', { source: webSource, port: 3000, detection: { stack: 'node', builder: 'dockerfile', port: 3000, needs: [], envKeys: ['PORT'], healthPath: '/', notes: [] } }, 8 * D);
  for (const [s, n, at] of [[sandbox, 3, 8 * D + 2 * H], [pgWeb, 2, 7 * D + 5 * H]] as const) {
    const host = `${s.slug}-${s.env.id.slice(-6)}.${IP.replace(/\./g, '-')}.sslip.io`.toLowerCase();
    domain(s, host, at, { auto: true });
    deploys(s, s === sandbox ? sbSource : webSource, { stack: s === sandbox ? 'vite' : 'node', port: s === sandbox ? 80 : 3000, healthPath: '/' }, [{ n, at, status: 'live', by: CLAUDE }], `https://${host}`);
  }
  live.push(sandbox, pgWeb);
  project('scratch', null, 'Empty for now.', 1 * D, ME);
  summary.push('projects: nestly (web prod #38–#42, #42 live; web staging), shipfast (api + db + api worker prod; api + db-staging staging), playground (dev/staging only), scratch (empty)');
});

// --- server metrics: 7 days every 10 minutes, the last hour every 30 seconds ---------------------------
tx(db, () => {
  const memTotal = 8 * GB - 254 * 1024 ** 2, diskTotal = 96.7 * GB;
  const names = ['unit7-caddy', ...live.map((s) => (s.kind === 'postgres' ? `unit7-${s.slug}-${s.env.id.slice(-6)}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')
    : get<{ container: string }>(db, 'SELECT d.container FROM deployments d JOIN services s ON s.current_deployment_id = d.id WHERE s.id = ?', s.id)!.container))];
  const point = (msAgo: number) => {
    const hour = new Date(NOW - msAgo).getUTCHours() + 5.5; // IST traffic curve
    const cpu = Math.max(6, Math.min(92, 34 + 11 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + (rnd() - 0.5) * 12 + (msAgo < 20 * H && msAgo > 19 * H ? 30 : 0)));
    const mem = 0.61 + 0.025 * Math.sin(msAgo / (5 * H)) + (rnd() - 0.5) * 0.02;
    const disk = msAgo > 6 * D ? 0.88 + (7 * D - msAgo) / D * 0.04 : 0.468 + (6 * D - msAgo) / (6 * D) * 0.014; // 92% six days ago, then Warden freed space
    const containers = names.map((n) => ({ name: n, cpu: Math.round(rnd() * (n.includes('-db-') || n.includes('worker') ? 4 : 9) * 10) / 10, memPct: Math.round((2 + rnd() * 9) * 10) / 10, mem: `${Math.round(60 + rnd() * 420)}MiB` }));
    run(db, 'INSERT INTO metrics (server_id, at, cpu, mem_used, mem_total, disk_used, disk_total, load1, containers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      srvId, ago(msAgo), Math.round(cpu * 10) / 10, Math.round(memTotal * mem), memTotal, Math.round(diskTotal * disk), Math.round(diskTotal), Math.round((cpu / 50) * 100) / 100, JSON.stringify(containers));
  };
  for (let t = 7 * D; t > H; t -= 10 * M) point(t);
  for (let t = H; t >= 0; t -= 30_000) point(t);
});

// --- Warden and the activity around it (last 7 days) -------------------------------------------------
tx(db, () => {
  // the disk filled with old build images six days ago; Warden opened an incident and freed space
  ev(6 * D + 5 * H, 'server.disk_high', 'warning', 'vps-01 disk at 92% — Warden is freeing space', { resource: srvId });
  audit(6 * D + 5 * H - 20_000, WARDEN, 'docker.prune', 'docker_prune', 'write', 'success', { input: { serverId: srvId }, output: { freed: '11.2 GB' }, ms: 18_300, reason: 'Warden: disk 92%' });
  ev(6 * D + 5 * H - 40_000, 'server.disk_freed', 'success', 'Freed 11.2 GB on vps-01', { resource: srvId });
  const inc = id('inc');
  run(db, `INSERT INTO incidents (id, org_id, title, status, severity, trigger_event, timeline, root_cause, remediation, created_at, resolved_at) VALUES (?, ?, ?, 'resolved', 'warning', 'server.disk_high', ?, ?, ?, ?, ?)`,
    inc, orgId, 'disk at 92%', JSON.stringify([{ at: ago(6 * D + 5 * H), text: 'Disk above 90% on vps-01' }, { at: ago(6 * D + 5 * H - 40_000), text: 'Pruned unused images and build cache: 11.2 GB freed' }, { at: ago(6 * D + 4 * H), text: 'Disk steady at 47% for an hour' }]),
    '42 old build images (one per deploy since the server was set up) and 3 GB of build cache.', 'Pruned images older than the last 3 deploys of each app; disk back to 47%. Unit7 now prunes weekly.', ago(6 * D + 5 * H), ago(6 * D + 4 * H));
  ev(6 * D + 5 * H - 5000, 'incident.opened', 'critical', 'Incident: disk at 92% on vps-01', { resource: inc, data: { incidentId: inc, type: 'server.disk_high' } });

  // a crashed worker that Warden brought back
  const where = { projectId: worker.env.projectId, environmentId: worker.env.id };
  ev(2 * D + 3 * H, 'service.down', 'critical', 'api worker is down — Warden is restarting it', { ...where, resource: worker.id });
  ev(2 * D + 3 * H - 21_000, 'service.restarted', 'info', 'Restarted api worker', { ...where, resource: worker.id });
  ev(2 * D + 3 * H - 21_500, 'action.completed', 'success', 'Warden: Restart a service', where);
  audit(2 * D + 3 * H - 21_000, WARDEN, 'service.restart', 'restart_service', 'write', 'success', { input: { serviceId: worker.id }, output: { restarted: 'api worker', healthy: true }, ms: 19_800, reason: 'Warden: container down', ...where });

  // Shield: scanners and floods blocked at the edge
  for (const [at, ip, mins, why] of [[6 * D + 11 * H, '198.51.100.41', 15, 'vulnerability scanner'], [4 * D + 23 * H, '198.51.100.77', 15, 'request flood'], [2 * D + 14 * H, '198.51.100.23', 15, 'vulnerability scanner'], [38 * M, '198.51.100.23', 60, 'vulnerability scanner']] as const)
    ev(at, 'shield.blocked', 'warning', `Blocked ${ip} on vps-01 for ${mins}m (${why})`, { resource: srvId, data: { ip, strikes: mins === 60 ? 2 : 1 } });

  // a secret the owner set, a stopped experiment, approvals decided earlier
  ev(5 * D + 6 * H, 'env.changed', 'info', 'RESEND_API_KEY set on environment:Production', { projectId: web.env.projectId, environmentId: web.env.id });
  audit(5 * D + 6 * H, ME, 'env.set', 'env_write', 'write', 'success', { input: { environmentId: web.env.id, key: 'RESEND_API_KEY', value: '[sensitive]' }, output: { key: 'RESEND_API_KEY', version: 2, secret: true }, ms: 11, projectId: web.env.projectId, environmentId: web.env.id });
  const decided = (at: number, command: string, status: 'rejected' | 'done') => {
    const apr = id('apr');
    const input = { command, serverId: srvId, timeoutSeconds: 120 };
    const why = decide({ actor: 'agent', role: 'agent', risk: 'destructive', action: 'server_exec', env: { kind: 'production', autonomy: 3, rules: { dns_write: 'restricted' }, name: 'org-wide resources', orgWide: true } }).why;
    run(db, `INSERT INTO approvals (id, org_id, tool, input, reason, why, actor, environment_id, status, decided_by, decided_at, result, expires_at, created_at) VALUES (?, ?, 'server.exec', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      apr, orgId, stable(input), MCP, why, JSON.stringify(CLAUDE), status, user.name, ago(at - 6 * M), status === 'done' ? 'success' : null, ago(at - 24 * H), ago(at));
    audit(at, CLAUDE, 'server.exec', 'server_exec', 'destructive', 'pending_approval', { input, reason: MCP, approvalId: apr });
    ev(at, 'approval.requested', 'warning', `${CLAUDE.name} wants to run run a command on a server: ${why}`, { resource: apr, data: { tool: 'server.exec', approvalId: apr, reason: MCP } });
    ev(at - 6 * M, status === 'done' ? 'approval.approved' : 'approval.rejected', 'info', `${user.name} ${status === 'done' ? 'approved' : 'rejected'} server.exec`, { resource: apr });
    if (status === 'done') audit(at - 6 * M - 9000, { ...CLAUDE, name: `${CLAUDE.name} (approved by ${user.name})` }, 'server.exec', 'server_exec', 'destructive', 'success', { input, output: { exitCode: 0, stdout: 'Total reclaimed space: 2.31GB' }, ms: 8_700, approvalId: apr });
  };
  decided(5 * D + 22 * H, 'docker image prune -af --filter until=168h', 'done');
  decided(4 * D + 1 * H, 'docker system prune -af --volumes', 'rejected');
});

// --- two actions waiting for a person ----------------------------------------------------------------
const VERCEL_SHOP = 'prj_demo_nestly_shop';
tx(db, () => {
  const pending = (at: number, tool: string, title: string, input: object, why: string, environmentId: string | null, projectId?: string) => {
    const apr = id('apr');
    run(db, `INSERT INTO approvals (id, org_id, tool, input, reason, why, actor, environment_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      apr, orgId, tool, stable(input), MCP, why, JSON.stringify(CLAUDE), environmentId, new Date(NOW - at + 24 * H).toISOString(), ago(at));
    audit(at, CLAUDE, tool, tool === 'deployment.rollback' ? 'rollback' : 'dns_write', 'write', 'pending_approval', { input, reason: MCP, approvalId: apr, projectId, environmentId: environmentId ?? undefined });
    ev(at, 'approval.requested', 'warning', `${CLAUDE.name} wants to run ${title.toLowerCase()}: ${why}`, { projectId, environmentId: environmentId ?? undefined, resource: apr, data: { tool, approvalId: apr, reason: MCP } });
    return apr;
  };
  const prodRules = { kind: 'production' as const, autonomy: 3, rules: { rollback: 'restricted' as const }, name: 'Production' };
  const shopApr = pending(2 * H, 'domain.point', 'Point a domain at an app', { hostname: 'shop.nestly.example', vercel: { accountId: accounts.vercel!, project: VERCEL_SHOP } },
    decide({ actor: 'agent', role: 'agent', risk: 'write', action: 'dns_write', env: { kind: 'production', autonomy: 3, rules: { dns_write: 'restricted' }, name: 'org-wide resources', orgWide: true } }).why, null);
  const rbApr = pending(35 * M, 'deployment.rollback', 'Roll back a service', { serviceId: web.id, deploymentId: nestDeps[41]! },
    decide({ actor: 'agent', role: 'agent', risk: 'write', action: 'rollback', env: prodRules }).why, nestProd.id, nestProd.projectId);

  // what the owner asked from the command box (answered by their Claude Code)
  const convo = (at: number, title: string, msgs: { role: string; content: object; after: number }[]) => {
    const cid = id('cnv');
    run(db, 'INSERT INTO conversations (id, org_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', cid, orgId, user.id, title, ago(at), ago(at - msgs.at(-1)!.after));
    for (const m of msgs) run(db, 'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', id('msg'), cid, m.role, JSON.stringify(m.content), ago(at - m.after));
  };
  convo(19 * H, 'Why do some listing pages crash since this morning?', [
    { role: 'user', content: { text: 'Why do some listing pages crash since this morning?' }, after: 0 },
    { role: 'tool', content: { tool: 'errors.list', title: 'Errors, in plain words', input: { serviceId: web.id }, status: 'ok', durationMs: 38 }, after: 40_000 },
    { role: 'assistant', content: { text: "Deploy #42 of web reads `listing.city`, but listings created before the September import have no address yet, so those pages throw `TypeError: Cannot read properties of null (reading 'city')` (37 times so far). The fix is a null check in app/listings/[id]/page.tsx:42. Want me to roll production back to #41 while I fix it?" }, after: 95_000 },
  ]);
  convo(36 * M, 'Roll nestly production back to #41', [
    { role: 'user', content: { text: 'Yes, roll production back to #41.' }, after: 0 },
    { role: 'tool', content: { tool: 'deployment.rollback', title: 'Roll back a service', input: { serviceId: web.id, deploymentId: nestDeps[41] }, status: 'approval_required', why: 'rollback in Production is restricted, so a human must approve it.', approvalId: rbApr, approvalState: 'pending' }, after: 30_000 },
    { role: 'assistant', content: { text: 'Rollbacks in Production need your OK, so it is waiting on the Approvals page. Approve it there and #41 is live within seconds.' }, after: 50_000 },
  ]);
  convo(2 * H + 2 * M, 'Put the new shop at shop.nestly.example', [
    { role: 'user', content: { text: 'Put the new shop (nestly-shop on Vercel) at shop.nestly.example' }, after: 0 },
    { role: 'tool', content: { tool: 'domain.point', title: 'Point a domain at an app', input: { hostname: 'shop.nestly.example', vercel: { accountId: accounts.vercel, project: VERCEL_SHOP } }, status: 'approval_required', why: 'dns write in org-wide resources is restricted, so a human must approve it.', approvalId: shopApr, approvalState: 'pending' }, after: 25_000 },
    { role: 'assistant', content: { text: 'DNS changes need your approval in this organization. Once you approve, Unit7 adds the domain on Vercel and writes the CNAME at Cloudflare.' }, after: 41_000 },
  ]);
});

// --- the map: what each account's scan found, merged and resolved the way sync.run does -------------
const SUPA = 'demodemodemodemodemo';
const usesOf = (deps: string[], keys: string[]) => ({
  supabase: deps.some((d) => d.startsWith('@supabase/')) || keys.some((k) => /SUPABASE/.test(k)),
  postgres: deps.some((d) => ['pg', 'postgres', '@neondatabase/serverless', '@prisma/client', 'drizzle-orm', '@vercel/postgres'].includes(d)) || keys.some((k) => /^(DATABASE_URL|POSTGRES_URL)$/.test(k)),
});
// a DNS zone as domain nodes + where each name points (scanners.ts zoneScan)
function zone(scan: { found: Found[]; refs: Ref[] }, dnsHost: string, accountId: string, z: string, records: [string, string, string][]) {
  for (const [n, type, v] of records) {
    const name = n === '@' ? z : `${n}.${z}`;
    scan.found.push({ provider: 'domain', kind: 'domain', extId: name, name, accountId, dns: dnsHost, zone: z });
    scan.refs.push(type === 'A' ? { from: domainKey(name), kind: 'dns', via: `A ${v}`, ip: v } : { from: domainKey(name), kind: 'dns', via: `${type} ${v}`, host: v === '@' ? z : v });
  }
}
function vercelApp(scan: { found: Found[]; refs: Ref[] }, p: { id: string; name: string; domains: string[]; env: Record<string, string>; deps?: string[] }) {
  const key = `vercel:${p.id}`, own = `${p.name}.vercel.app`;
  scan.found.push({ provider: 'vercel', kind: 'app', extId: p.id, name: p.name, accountId: accounts.vercel, url: `https://${p.domains[0] ?? own}`, hosts: [...p.domains, own, own],
    envKeys: Object.keys(p.env), uses: usesOf(p.deps ?? [], Object.keys(p.env)), end: { kind: 'vercel', accountId: accounts.vercel!, project: p.id }, platform: 'vercel' });
  for (const d of p.domains) scan.refs.push({ from: key, kind: 'domain', via: 'added on Vercel', host: d });
  scan.refs.push(...envRefs(key, p.env));
}

const hostinger = { found: [] as Found[], refs: [] as Ref[] };
for (const [d, exp] of [['lumen.example', '2027-03-14T00:00:00Z'], ['shipfast.example', '2027-01-22T00:00:00Z'], ['runclub.example', '2027-06-02T00:00:00Z']]) {
  hostinger.found.push({ provider: 'domain', kind: 'domain', extId: d!, name: d!, accountId: accounts.hostinger, zone: d, expires: exp, registrar: 'hostinger' });
}
hostinger.found.push({ provider: 'hostinger', kind: 'server', extId: `vm-${VM}`, name: 'vps-01.lumen.example', accountId: accounts.hostinger, ips: [IP], platform: 'vps' });
zone(hostinger, 'hostinger', accounts.hostinger!, 'lumen.example', [['@', 'A', '203.0.113.20'], ['www', 'CNAME', 'lumen.example'], ['admin', 'A', IP], ['api', 'A', IP], ['coolify', 'A', IP], ['status', 'A', IP], ['docs', 'A', IP]]);
zone(hostinger, 'hostinger', accounts.hostinger!, 'shipfast.example', [['@', 'A', '203.0.113.20'], ['www', 'CNAME', 'shipfast.example'], ['api', 'A', IP], ['api-staging', 'CNAME', 'shipfast-staging.onrender.com'], ['old', 'CNAME', 'shipfast-old.vercel.app']]);
zone(hostinger, 'hostinger', accounts.hostinger!, 'runclub.example', [['@', 'A', '203.0.113.20'], ['www', 'CNAME', 'runclub.example']]);

const cloudflare = { found: [] as Found[], refs: [] as Ref[] };
zone(cloudflare, 'cloudflare', accounts.cloudflare!, 'orbit.example', [['@', 'A', '76.76.21.21'], ['www', 'CNAME', 'cname.vercel-dns.com']]);
zone(cloudflare, 'cloudflare', accounts.cloudflare!, 'nestly.example', [['@', 'A', IP], ['www', 'A', IP], ['staging', 'A', IP]]);

const supabase = { found: [{ provider: 'supabase', kind: 'database', extId: SUPA, name: 'orbit-db', accountId: accounts.supabase, url: `https://supabase.com/dashboard/project/${SUPA}`,
  hosts: [`${SUPA}.supabase.co`, `db.${SUPA}.supabase.co`], status: 'ACTIVE_HEALTHY', end: { kind: 'supabase', accountId: accounts.supabase!, ref: SUPA }, platform: 'supabase' }] as Found[], refs: [] as Ref[] };

const vercel = { found: [] as Found[], refs: [] as Ref[] };
vercelApp(vercel, { id: 'prj_demo_harbor', name: 'harbor', domains: ['www.harbor.example', 'harbor.example'],
  env: { NEXT_PUBLIC_SITE_URL: 'https://www.harbor.example', RESEND_API_KEY: 're_x', CONTACT_EMAIL: 'hello@harbor.example' } });
vercelApp(vercel, { id: 'prj_demo_orbit_web', name: 'orbit-web', domains: ['orbit.example', 'www.orbit.example'], deps: ['@supabase/supabase-js', 'pg'],
  env: { DATABASE_URL: `postgresql://postgres.${SUPA}:x@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`, NEXT_PUBLIC_SUPABASE_URL: `https://${SUPA}.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', NEXTAUTH_URL: 'https://orbit.example' } });
vercelApp(vercel, { id: 'prj_demo_pocket_hub', name: 'pocket-hub', domains: [], deps: ['@supabase/supabase-js'], env: { NEXT_PUBLIC_SUPPORT_PHONE: '+12025550100', NEXT_PUBLIC_GA_ID: 'G-DEMO12345' } });
vercelApp(vercel, { id: VERCEL_SHOP, name: 'nestly-shop', domains: [], env: { NEXT_PUBLIC_API_URL: 'https://nestly.example/api', NEXT_PUBLIC_STORE_NAME: 'Nestly Shop' } });

const unit7 = await scanUnit7(ctx);
const results = [
  { s: { id: 'unit7', name: 'Unit7', provider: 'unit7' }, ...unit7 },
  { s: { id: accounts.cloudflare!, name: 'Cloudflare · demo', provider: 'cloudflare' }, ...cloudflare },
  { s: { id: accounts.hostinger!, name: 'Hostinger', provider: 'hostinger' }, ...hostinger },
  { s: { id: accounts.supabase!, name: 'Supabase · demo', provider: 'supabase' }, ...supabase },
  { s: { id: accounts.vercel!, name: 'Vercel · demo', provider: 'vercel' }, ...vercel },
];
const found = mergeFound(results.flatMap((r) => r.found));
const refs = results.flatMap((r) => r.refs);
// domains added on a host whose DNS no connected account serves: what public DNS answered
const PUBLIC_DNS: Record<string, { cname?: string; a?: string[] }> = { 'harbor.example': { a: ['76.76.21.21'] }, 'www.harbor.example': { cname: 'cname.vercel-dns.com' } };
const known = new Set(refs.filter((r) => r.kind === 'dns').map((r) => r.from));
for (const h of [...new Set(refs.filter((r) => r.kind === 'domain' && r.host).map((r) => r.host!))].filter((x) => !known.has(domainKey(x)))) {
  const sslip = /\.(\d+-\d+-\d+-\d+)\.sslip\.io$/.exec(h)?.[1]?.replace(/-/g, '.');
  const ans = PUBLIC_DNS[h] ?? (sslip ? { a: [sslip] } : {});
  if (ans.cname) refs.push({ from: domainKey(h), kind: 'dns', via: `CNAME ${ans.cname} (public DNS)`, host: ans.cname });
  for (const ip of ans.a ?? []) refs.push({ from: domainKey(h), kind: 'dns', via: `A ${ip} (public DNS)`, ip });
}
for (const h of new Set(refs.filter((r) => r.kind === 'domain' && r.host).map((r) => r.host!))) if (!found.has(domainKey(h))) found.set(domainKey(h), { provider: 'domain', kind: 'domain', extId: h, name: h });
const { edges, issues, dangling } = resolve(found, refs);
// every dangling CNAME here points at a deleted Vercel project: nothing answers for it any more
for (const d of dangling) issues.unshift({ severity: 'critical', key: `takeover:${d.domain}`, about: domainKey(d.domain), text: `${d.domain} points at ${d.target}, which no longer exists. Anyone can create a ${d.platform} app with that name and serve your domain. Remove or fix that DNS record.` });
const suggestions = suggest(thingsFrom(found.values()), []);
const assetId = (key: string) => `ast_${createHash('sha256').update(`${orgId}\n${key}`).digest('base64url').slice(0, 12)}`;
const count = (k: string) => [...found.values()].filter((f) => f.kind === k).length;
const mapSummary = {
  ms: 47_812, counts: { apps: count('app'), databases: count('database'), servers: count('server'), domains: count('domain'), connections: edges.length },
  accounts: results.map((r) => ({ id: r.s.id, name: r.s.name, provider: r.s.provider, ok: true, found: r.found.length })), issues, suggestions,
};
const SYNC_AT = 2 * H + 15 * M;
tx(db, () => {
  for (const r of results) run(db, `INSERT INTO scan_cache (org_id, scope, found, refs, ok, note, at) VALUES (?, ?, ?, ?, 1, NULL, ?)`, orgId, r.s.id, JSON.stringify(r.found), JSON.stringify(r.refs), ago(SYNC_AT));
  for (const [k, f] of found) {
    const { provider, kind, extId, name, url, accountId, ...meta } = f;
    run(db, 'INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', assetId(k), orgId, accountId ?? null, provider, kind, extId, name, url ?? null, JSON.stringify(meta), ago(SYNC_AT));
  }
  for (const e of edges) run(db, 'INSERT OR IGNORE INTO edges (id, org_id, source, target, kind, via, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id('edg'), orgId, assetId(e.from), assetId(e.to), e.kind, e.via, e.status, e.detail ?? null);
  // Warden syncs every 6 hours; the feed shows one a day. The old.shipfast.example risk appeared three days ago.
  const c = mapSummary.counts;
  for (let day = 6; day >= 0; day--) {
    const at = day * D + SYNC_AT, risky = day <= 2;
    run(db, `INSERT INTO sync_runs (id, org_id, started_at, finished_at, status, summary) VALUES (?, ?, ?, ?, 'done', ?)`, id('syn'), orgId, ago(at + 48_000), ago(at), JSON.stringify(risky ? mapSummary : { ...mapSummary, issues: issues.filter((i) => !i.key.startsWith('takeover:')) }));
    const n = risky ? issues.length : issues.length - dangling.length;
    if (risky) for (const d of dangling) ev(at + 2000, 'domain.takeover_risk', 'critical', `${d.domain} points at ${d.target}, which no longer exists (anyone could claim it).`, { resource: d.domain });
    ev(at, 'sync.done', risky ? 'critical' : 'info', `Map updated: ${c.apps} apps, ${c.databases} databases, ${c.servers} servers, ${c.domains} domains across 4 accounts${n ? `; ${n} to look at` : ''}`);
  }

  // outside checks: every site answering, certificates, registrations, email protection
  const watch = (host: string, kind: string, status: string, detail: string, o: { ms?: number; value?: string; asset?: string } = {}) =>
    run(db, `INSERT INTO watch (org_id, host, kind, status, detail, streak, ms, last_ok, checked_at, value, asset) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      orgId, host, kind, status, detail, o.ms ?? null, kind === 'site' ? ago(3 * M) : null, ago(kind === 'site' ? 3 * M : 7 * H), o.value ?? null, o.asset ?? null);
  const MS: Record<string, number> = { 'www.harbor.example': 1392, 'harbor.example': 1392, 'orbit.example': 139, 'www.orbit.example': 139, 'pocket-hub.vercel.app': 398, 'nestly.example': 212, 'www.nestly.example': 212, 'nestly-shop.vercel.app': 176, 'api.shipfast.example': 94 };
  for (const t of targets(app, orgId)) {
    watch(t.host, 'site', 'up', t.host === 'api-staging.shipfast.example' ? 'HTTP 404' : 'HTTP 200', { ms: MS[t.host] ?? Math.round(150 + rnd() * 350), asset: t.asset });
    const days = 35 + Math.round(rnd() * 50);
    watch(t.host, 'tls', 'ok', `${days} days left`, { value: new Date(NOW + days * D).toISOString(), asset: t.asset });
  }
  for (const [d, exp] of [['lumen.example', '2027-03-14T00:00:00Z'], ['shipfast.example', '2027-01-22T00:00:00Z'], ['runclub.example', '2027-06-02T00:00:00Z']]) watch(d!, 'registration', 'ok', `${Math.floor((Date.parse(exp!) - NOW) / D)} days left (hostinger)`, { value: exp });
  const EMAIL: Record<string, [string, string]> = {
    'lumen.example': ['unprotected', 'SPF and DMARC missing: your email may land in spam, and others can send as you'],
    'runclub.example': ['spoofable', 'SPF and DMARC missing: this domain sends no email, but anyone can pretend it does'],
  };
  for (const { name } of db.prepare(`SELECT name FROM assets WHERE org_id = ? AND kind = 'domain' AND json_extract(meta, '$.zone') = name`).all(orgId) as { name: string }[]) {
    const [status, detail] = EMAIL[name] ?? ['ok', 'SPF and DMARC set'];
    watch(name, 'email', status, detail);
  }
  // errors read from an app on another host
  const orbit = [...found].find(([, f]) => f.name === 'orbit-web')![0];
  run(db, `INSERT INTO remote_errors (org_id, asset, fingerprint, kind, message, frame, sample, count, first_seen, last_seen) VALUES (?, ?, ?, 'TypeError', ?, ?, ?, 23, ?, ?)`, orgId, assetId(orbit), hex(16),
    "Cannot read properties of undefined (reading 'plan')", 'app/dashboard/page.tsx:57', "TypeError: Cannot read properties of undefined (reading 'plan')\n    at Dashboard (app/dashboard/page.tsx:57:33)", ago(5 * H), ago(22 * M));
  ev(5 * H, 'app.errors', 'warning', "orbit-web: TypeError: Cannot read properties of undefined (reading 'plan') (8 times in the last few minutes)", { resource: assetId(orbit) });
});
summary.push(`map: ${mapSummary.counts.apps} apps, ${mapSummary.counts.databases} databases, ${mapSummary.counts.servers} servers, ${mapSummary.counts.domains} domains, ${edges.length} connections; ${issues.length} issues from the sync (+ email checks), ${suggestions.length} suggestion(s)`);

// --- routines: what runs on a schedule, each with a good last run ---------------------------------------
tx(db, () => {
  const routine = (name: string, schedule: string, last: number, summaryLine: string, o: { ask?: string; steps?: object[] }) =>
    run(db, `INSERT INTO routines (id, org_id, owner_id, name, kind, ask, ask_by, steps, schedule, tz, next_at, last_at, last_status, last_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UTC', ?, ?, 'ok', ?, ?)`,
      id('rtn'), orgId, user.id, name, o.ask ? 'ask' : 'steps', o.ask ?? null, o.ask ? 'person' : null, JSON.stringify(o.steps ?? []), schedule, nextRun(parseSchedule(schedule).spec, new Date(NOW), 'UTC').toISOString(), ago(last), summaryLine, ago(14 * D));
  routine("Test-restore last night's backups", 'every day at 03:00', 23 * H, 'The backup of db restores cleanly.', { steps: [{ tool: 'backup.verify', title: 'Prove a backup restores', input: { serviceId: pgProd.id } }] });
  routine('Keep the disk tidy', 'every 6 hours', 2 * H, 'Logs tidied on vps-01.', { steps: [{ tool: 'server.tidy_logs', title: 'Tidy up logs on a server', input: { serverId: srvId } }] });
  routine('Watch my domains', 'every day at 08:00', 18 * H, 'Every certificate has more than 30 days left.', { ask: 'Check my domains and certificates, and tell me about anything that runs out soon.' });
  routine('Friday security sweep', 'every Friday at 18:00', 5 * D, 'Nothing new since last week.', { ask: 'Run a security check on vps-01 and tell me what to fix first.' });
  routine('Monday health report', 'every Monday at 09:00', 3 * D, 'All servers and apps healthy.', { ask: 'Send me a health report for every server and app.' });
});

// --- the last look inside vps-01: four projects Coolify runs, found from its Docker labels ----------------
// Nothing can reach the server here, so the server page shows this as the last good X-ray.
{
  const health = { status: 'ok' } as const, at = new Date(NOW).toISOString();
  const memTotal = 8 * GB - 254 * 1024 ** 2, diskTotal = 96.7 * GB, memUsed = Math.round(memTotal * 0.61), diskUsed = Math.round(46.6 * GB);
  const by = { owner: 'coolify', trust: 'understood' } as const, running = { ...by, state: 'running', health } as const;
  const parts: Inventory['parts'] = [], projects: Inventory['projects'] = [], stats = new Map<string, { cpu: number; mem: number; rx: number; tx: number }>();
  const databases: Sizes['databases'] = [], sized: Sizes['projects'] = [];
  const coolifyProject = (name: string, supabase: boolean, hosts: string[], memMb: number, diskGb: number) => {
    const project = `coolify:${name}`, app = `app:${name}`, store = `db:${name}`, uuid = hex(24);
    const web = `${uuid}-web`, data = `${uuid}-${supabase ? 'supabase-db' : 'postgres'}`, dataName = `${name}-${supabase ? 'supabase' : 'db'}`;
    const coolify = (type: string) => ({ uuid, type, labels: 'uuid', environment: 'production' }) as const;
    parts.push({ ...running, id: app, kind: 'app', name: `${name}-web`, project, image: `ghcr.io/acme/${name}:latest`, containers: [web], match: [web], hosts, uses: [store], coolify: coolify('application') });
    parts.push({ ...running, id: store, kind: 'database', name: dataName, project, engine: 'postgres', version: supabase ? '15' : '16', containers: [data], match: [data], coolify: coolify(supabase ? 'service' : 'database'),
      product: supabase ? { id: 'supabase', name: 'Supabase' } : { id: 'postgresql', name: 'PostgreSQL' } });
    for (const host of hosts) parts.push({ ...by, id: `domain:${host}`, kind: 'domain', name: host, project, via: 'Coolify’s proxy', target: app });
    projects.push({ ...by, id: project, name, how: 'Coolify’s labels', confidence: 1, environments: ['production'], health, domains: hosts, coolify: { uuid }, parts: [app, store, ...hosts.map((h) => `domain:${h}`)] });
    stats.set(web, { cpu: 3 + rnd() * 6, mem: Math.round(memMb * 0.3e6), rx: 4e6, tx: 9e6 });
    stats.set(data, { cpu: 2 + rnd() * 4, mem: Math.round(memMb * 0.7e6), rx: 2e6, tx: 2e6 });
    databases.push({ part: store, container: data, name: 'postgres', bytes: Math.round(diskGb * 0.4e9) });
    sized.push({ id: project, name, bytes: Math.round(diskGb * 1e9) });
  };
  coolifyProject('recipes', true, ['recipes.example', 'www.recipes.example', 'api.recipes.example', 'studio.recipes.example'], 1300, 9.4);
  coolifyProject('bookclub', true, ['bookclub.example', 'api.bookclub.example', 'studio.bookclub.example'], 900, 5.1);
  coolifyProject('plantdiary', true, ['plantdiary.example', 'api.plantdiary.example', 'studio.plantdiary.example'], 700, 3.2);
  coolifyProject('notes-api', false, ['notes.example', 'api.notes.example'], 260, 0.6);
  parts.push({ ...running, id: 'app:coolify', kind: 'app', name: 'coolify', product: { id: 'coolify', name: 'Coolify' }, project: 'coolify:system', containers: ['coolify'], match: ['coolify'], hosts: ['coolify.lumen.example'] });
  projects.push({ ...by, id: 'coolify:system', name: 'Coolify itself', how: 'Coolify’s own containers', confidence: 1, system: true, health, domains: ['coolify.lumen.example'], parts: ['app:coolify'] });
  stats.set('coolify', { cpu: 2, mem: 480e6, rx: 1e6, tx: 1e6 });
  const jobs = [['0 3 * * *', 'node scripts/nightly-digest.js'], ['0 * * * *', 'node scripts/clear-expired-sessions.js'], ['*/30 * * * *', 'node scripts/sync-feeds.js'], ['15 4 * * 1', 'node scripts/weekly-report.js']] as const;
  jobs.forEach(([schedule, command], i) => parts.push({ ...by, id: `job:${i}`, kind: 'job', name: command, schedule, command, user: 'root' }));
  for (const name of ['coolify-letsencrypt', 'shared-uploads', 'old-uploads']) parts.push({ ...by, id: `v:${name}`, kind: 'volume', name, trust: 'seen' });
  const inv: Inventory = {
    version: 1, at, ms: 3_180, paas: [{ id: 'coolify', name: 'Coolify' }], coolify: { version: '4.0.0-beta.434', apiPort: 8000, sentinel: true, proxy: true },
    server: { os: 'Ubuntu 24.04.3 LTS', cpus: 2, memTotal, memAvailable: memTotal - memUsed, diskTotal, diskUsed, load: '0.68 0.74 0.71', docker: '28.4.0', user: 'root' },
    projects, parts, loose: parts.filter((p) => !p.project).map((p) => p.id), repos: [], notes: [], summary: '',
    ports: [{ proto: 'tcp', ip: '0.0.0.0', port: 22, public: true, process: 'sshd' }, { proto: 'tcp', ip: '0.0.0.0', port: 80, public: true, process: 'coolify-proxy' }, { proto: 'tcp', ip: '0.0.0.0', port: 443, public: true, process: 'coolify-proxy' }],
    disk: { method: 'docker-cli', images: 8.7e9, imagesUnused: 965e6, buildCache: 1.2e9, reclaimable: 2.2e9 },
  };
  inv.summary = summarize(inv);
  const sizes: Sizes = { at, method: 'docker system df and du', volumes: {}, binds: {}, logs: {}, databases, layers: {}, images: [], buildCache: 1.2e9, projects: sized, loose: 2.4e9, reclaimable: 2.2e9 };
  saveXray(db, orgId, srvId, 'fast', inv, undefined, inv.ms);
  saveXray(db, orgId, srvId, 'deep', sizes);
  saveXray(db, orgId, srvId, 'usage', { serverId: srvId, serverName: 'vps-01', ...rollup(inv, { cpus: 2, cpu: 34, memTotal, memUsed, diskTotal, diskUsed }, stats, 'sentinel', { sizes, at }) });
}
db.close();

// --- 3. the login file ---------------------------------------------------------------------------
writeFileSync(join(HOME, 'DEMO_LOGIN.md'), `# Unit7 demo login (unit7 UI)

- URL: http://localhost:${PORT}
- Email: ${OWNER.email}
- Password: ${password}

Start the demo server from the repo root:

    ${SERVE}

Made by \`npm run demo:seed\` on ${new Date(NOW).toISOString().slice(0, 16).replace('T', ' ')} UTC. Running it again wipes .unit7, makes a new password
and moves every timestamp to "now" (pending approvals expire 24 hours after a seed).
`, { mode: 0o600 });

// --- 4. check it: log in like the web app and read what each page reads ---------------------------
server = await up();
const failures: string[] = [];
try {
  const login = await http('/api/auth/login', { body: { email: OWNER.email, password } });
  if (login.status !== 200 || !login.cookie) throw new Error(`Login failed: ${login.status} ${JSON.stringify(login.data)}`);
  const cookie = login.cookie;
  const tool = (name: string, input: object = {}) => http(`/api/tools/${name}`, { cookie, body: { input } });
  const rows: [string, string, number, string][] = [];
  const check = async (page: string, what: string, p: Promise<{ status: number; data: any }>, test: (d: any) => string | true, expectFail = false) => {
    const r = await p;
    const ok = r.status < 400 && (!r.data?.status || r.data.status === 'ok');
    const out = r.data?.output ?? r.data;
    let note: string | true;
    try { note = ok ? test(out) : (r.data?.error?.message ?? r.data?.why ?? JSON.stringify(r.data)).slice(0, 110); } catch (e) { note = `bad shape: ${(e as Error).message}`; }
    const pass = expectFail ? !ok : ok && note === true;
    if (!pass) failures.push(`${page} ${what}: ${note === true ? 'ok' : note}`);
    rows.push([page, what, r.status, `${pass ? (expectFail ? 'expected error' : 'ok') : 'FAIL'}${note === true ? '' : ` · ${note}`}`]);
  };
  const g = (await http('/api/graph', { cookie })).data;
  const nest = g.projects.find((p: any) => p.name === 'nestly'), ship = g.projects.find((p: any) => p.name === 'shipfast');
  const prodWeb = nest.environments.find((e: any) => e.kind === 'production').services[0];
  const shipDb = ship.environments.find((e: any) => e.kind === 'production').services.find((s: any) => s.kind === 'postgres');
  const needs = (cond: boolean, why: string): true => { if (!cond) throw new Error(why); return true; };

  await check('Auth', 'GET /api/me', http('/api/me', { cookie }), (d) => needs(d.user.email === OWNER.email && d.role === 'owner', 'not the owner'));
  await check('Home', 'GET /api/graph', http('/api/graph', { cookie }), (d) => needs(d.projects.length === 4 && d.servers[0]?.status === 'ready' && prodWeb.deployment?.number === 42 && prodWeb.deployment.status === 'live' && prodWeb.domains.some((x: any) => x.hostname === 'nestly.example'), 'projects/server/deploy #42 missing'));
  await check('Home', 'GET /api/events?limit=6', http('/api/events?limit=6', { cookie }), (d) => needs(d.length === 6, 'fewer than 6 events'));
  await check('Home', 'GET /api/agents', http('/api/agents', { cookie }), (d) => needs(Array.isArray(d.agents), 'no agent list'));
  await check('Home', 'GET /api/connections', http('/api/connections', { cookie }), (d) => needs(d.filter((c: any) => c.accounts.length && c.id !== 'ollama').length === 5, 'not 5 connected providers'));
  await check('Home', 'GET /api/agent/status', http('/api/agent/status', { cookie }), (d) => needs('ready' in d, 'no status'));
  await check('Home', 'GET /api/suggestions', http('/api/suggestions', { cookie }), (d) => needs(d.items.some((i: any) => i.id === 'approvals'), 'no approvals nudge'));
  await check('Shell', 'GET /api/approvals', http('/api/approvals', { cookie }), (d) => needs(d.filter((a: any) => a.status === 'pending').length === 2, 'not 2 pending'));
  await check('Map', 'tool map.get', tool('map.get'), (d) => {
    const names = d.assets.map((a: any) => a.name);
    const hb = d.assets.find((a: any) => a.name === 'harbor');
    return needs(['harbor', 'orbit-web', 'pocket-hub', 'orbit-db', 'vps-01', 'coolify.lumen.example', 'orbit.example'].every((n) => names.includes(n))
      && hb?.site?.ms === 1392 && d.issues.some((i: any) => i.key === 'takeover:old.shipfast.example' && i.severity === 'critical')
      && d.issues.some((i: any) => i.key === 'email:lumen.example') && d.issues.some((i: any) => i.key === 'email:runclub.example')
      && d.edges.some((e: any) => e.status === 'misconfigured') && d.accounts.length === 5, 'map is missing seeded data');
  });
  await check('Projects', 'GET /api/graph?projectId', http(`/api/graph?projectId=${nest.id}`, { cookie }), (d) => needs(d.projects.length === 1 && d.projects[0].environments.length === 3, 'nestly envs'));
  await check('Projects', 'tool env.list', tool('env.list', { environmentId: nest.environments.find((e: any) => e.kind === 'production').id }), (d) => needs(d.variables.length >= 5, 'variables'));
  await check('Projects', 'tool account.list', tool('account.list'), (d) => needs(d.length === 5, 'accounts'));
  await check('Projects', 'tool environment.get', tool('environment.get', { environmentId: nest.environments.find((e: any) => e.kind === 'production').id }), (d) => needs(d.rules.rollback === 'restricted', 'policy'));
  await check('Projects', 'GET /api/projects/:id/memory', http(`/api/projects/${nest.id}/memory`, { cookie }), (d) => needs(d.length >= 1, 'memory'));
  await check('Service', 'tool service.get', tool('service.get', { serviceId: prodWeb.id }), (d) => needs(d.deployments.length === 5 && d.current.number === 42 && d.domains.length === 2, 'deployments'));
  await check('Service', 'tool errors.list', tool('errors.list', { serviceId: prodWeb.id }), (d) => needs(d.length === 1 && d[0].lastHour > 0, 'errors'));
  await check('Service', 'tool domain.list', tool('domain.list', { serviceId: prodWeb.id }), (d) => needs(d.length === 2, 'domains'));
  await check('Service', 'tool backup.list (db)', tool('backup.list', { serviceId: shipDb.id }), (d) => needs(d.length === 8 && d[0].offsite === 'this computer', 'backups'));
  await check('Service', 'tool deployment.logs (needs SSH)', tool('deployment.logs', { serviceId: prodWeb.id, lines: 50 }), () => true, true);
  await check('Servers', 'tool server.list', tool('server.list'), (d) => needs(d[0]?.name === 'vps-01' && d[0].status === 'ready' && d[0].services.length === 9, 'server'));
  await check('Servers', 'tool hostinger.vps_list (needs Hostinger)', tool('hostinger.vps_list'), () => true, true);
  await check('Servers', 'tool server.inspect (needs SSH)', tool('server.inspect', { serverId: g.servers[0].id }), () => true, true);
  await check('Servers', 'tool server.metrics (needs SSH)', tool('server.metrics', { serverId: g.servers[0].id }), () => true, true);
  await check('Activity', 'GET /api/events?limit=200', http('/api/events?limit=200', { cookie }), (d) => needs(d.length > 60 && d.some((e: any) => e.type === 'service.down') && d.some((e: any) => e.type === 'shield.blocked') && d.some((e: any) => e.type === 'backup.created') && d.some((e: any) => e.type === 'sync.done'), 'event mix'));
  await check('Activity', 'GET /api/audit?limit=300', http('/api/audit?limit=300', { cookie }), (d) => needs(d.length > 20 && d.some((a: any) => a.result === 'denied') && d.some((a: any) => a.result === 'pending_approval'), 'audit mix'));
  await check('Approvals', 'GET /api/approvals (decided)', http('/api/approvals', { cookie }), (d) => needs(d.length === 4, '4 approvals'));
  await check('Autopilot', 'GET /api/autopilot', http('/api/autopilot', { cookie }), (d) => needs(d.environments.length === 7 && d.actions.length > 0, 'autopilot'));
  await check('Warden', 'GET /api/incidents', http('/api/incidents', { cookie }), (d) => needs(d.length === 1, 'incident'));
  await check('Vault', 'tool vault.list', tool('vault.list'), (d) => needs(d.length === 4, '4 secrets'));
  await check('Wiring', 'tool link.list', tool('link.list'), () => true);
  await check('Wiring', 'tool link.options', tool('link.options'), (d) => needs(d.things.length > 5, 'things'));
  await check('Settings', 'GET /api/members', http('/api/members', { cookie }), (d) => needs(d.members.length === 1, 'members'));
  await check('Settings', 'GET /api/tokens', http('/api/tokens', { cookie }), (d) => needs(d.length === 1, 'token'));

  const w = Math.max(...rows.map((r) => r[1].length));
  console.log(rows.map(([p, what, s, note]) => `${p.padEnd(9)} ${what.padEnd(w)} ${String(s).padEnd(4)} ${note}`).join('\n'));
  const crashes = serverLog.split('\n').filter((l) => /crashed|Error:/.test(l) && !/^Unit7 is/.test(l));
  if (crashes.length) failures.push(`server log:\n${crashes.slice(0, 10).join('\n')}`);
} finally { await down(server); }

console.log(`\n${summary.join('\n')}\nLogin details: ${join(HOME, 'DEMO_LOGIN.md')}`);
if (failures.length) { console.error(`\n${failures.length} check(s) failed:\n${failures.join('\n')}`); process.exit(1); }
console.log('All checks passed.');
