// Keep it fresh · the pipeline. One batch moves Find → Apply → Test → Staging → Check → Accept → Release → Watch and
// stops at the first step that isn't right, with one plain line saying why ("Held back: a test failed").
//  - Apply: the updates on their own branch, made by the package manager in a throwaway container on the app's server,
//    pushed with the GitHub connection Unit7 already has, and a pull request listing what and why (the fix-PR pattern).
//  - Test + Staging: the pull request's preview (service.sync_previews): a test copy built from the branch beside the
//    live app, through the normal deploy, so the app's own tests (the test gate) and the readiness check run there.
//  - Check: the app's busiest pages and API paths (from its traffic) on the copy and on the live app: the same kind of
//    answer, and not clearly slower.
//  - Accept: fresh.release through the gate, which asks a person when the app's autonomy says so (policy.ts levels).
//  - Release: merge only after the pull request's checks are green, then the normal zero-downtime deploy of exactly that
//    commit (and the rolling release when the app runs on several servers).
//  - Watch: the release's own watch window; when it rolls back by itself, Unit7 opens a pull request taking the update
//    back out of the main branch, and the batch is held back with the reason.
// The outside world sits behind freshDeps, so the tests run the whole pipeline with fakes.
import type { App } from '../app.ts';
import { execute, type Ctx } from '../tools/runtime.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { containerToken, defaultBranch, githubAuthEnv, githubToken, headSha, mergePull, openPull, parseRepo, pullCheck, rememberSha, type Repo } from '../connectors/github.ts';
import { deploy, writeEnvFile, APPS, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';
import { requestPaths, warmPaths } from '../deploy/release.ts';
import type { Summary } from '../sentinel/traffic.ts';
import { serverRow } from '../tools/servers.ts';
import type { Item, Kind, Mode } from './plan.ts';
import { nice } from './plan.ts';

export const STEP_KEYS = ['find', 'apply', 'test', 'staging', 'check', 'accept', 'release', 'watch'] as const;
export type StepKey = typeof STEP_KEYS[number];
export interface Step { key: StepKey; state: 'active' | 'done' | 'failed' | 'skipped' | 'waiting'; at: string; ms?: number; note?: string }
export type Status = 'planned' | 'running' | 'waiting' | 'released' | 'held' | 'rolled_back' | 'failed' | 'up_to_date';
export interface Probe { path: string; code: number; ms: number }
export interface Smoke { ok: boolean; line: string; rows: { path: string; live: number; copy: number; liveMs: number; copyMs: number; ok: boolean }[] }
export interface BatchData {
  summary?: string[]; notes?: Record<string, string[]>; level?: number; mode?: Mode;
  pr?: { number: number; url: string; branch: string }; base?: string; baseSha?: string; diff?: string; files?: string;
  preview?: { serviceId?: string; deploymentId?: string; url?: string }; tests?: { status: string; label?: string; failure?: string; ms?: number };
  smoke?: Smoke; approvalId?: string; deploymentId?: string; mergeSha?: string; downSeconds?: number | null;
  revertPr?: { number: number; url: string; branch: string; merged?: boolean }; uuid?: string; part?: string; coolifyKind?: string; image?: string;
}
export interface Batch {
  id: string; org_id: string; service_id: string | null; server_id: string | null; kind: Kind; key: string; status: Status; title: string;
  items: Item[]; steps: Step[]; data: BatchData; why: string | null; by: string | null; created_at: string; finished_at: string | null;
}
type Row = Omit<Batch, 'items' | 'steps' | 'data'> & { items: string; steps: string; data: string };
const parse = (r: Row): Batch => ({ ...r, items: json<Item[]>(r.items, []), steps: json<Step[]>(r.steps, []), data: json<BatchData>(r.data, {}) });

// --- rows ----------------------------------------------------------------------------------------------------------------
export function newBatch(db: DB, orgId: string, b: { serviceId?: string | null; serverId?: string | null; kind: Kind; key: string; title: string; items: Item[]; data?: BatchData; status?: Status; by?: string; why?: string }) {
  const bid = id('frb');
  run(db, `INSERT INTO fresh_batches (id, org_id, service_id, server_id, kind, key, status, title, items, data, why, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bid, orgId, b.serviceId ?? null, b.serverId ?? null, b.kind, b.key, b.status ?? 'planned', b.title, JSON.stringify(b.items), JSON.stringify(b.data ?? {}), b.why ?? null, b.by ?? null);
  return bid;
}
export const loadBatch = (db: DB, orgId: string, bid: string) => { const r = get<Row>(db, 'SELECT * FROM fresh_batches WHERE id = ? AND org_id = ?', bid, orgId); return r && parse(r); };
export const batchesOf = (db: DB, orgId: string, serviceId: string, limit = 20) => all<Row>(db, 'SELECT * FROM fresh_batches WHERE org_id = ? AND service_id = ? ORDER BY created_at DESC LIMIT ?', orgId, serviceId, limit).map(parse);
export const openBatch = (db: DB, orgId: string, where: { serviceId?: string; serverId?: string }, key: string) => {
  const r = get<Row>(db, `SELECT * FROM fresh_batches WHERE org_id = ? AND ${where.serviceId ? 'service_id' : 'server_id'} = ? AND key = ? AND status IN ('planned', 'running', 'waiting') ORDER BY created_at DESC LIMIT 1`, orgId, where.serviceId ?? where.serverId!, key);
  return r && parse(r);
};
function save(app: App, b: Batch) {
  run(app.db, 'UPDATE fresh_batches SET status = ?, title = ?, items = ?, steps = ?, data = ?, why = ?, finished_at = ? WHERE id = ?',
    b.status, b.title, JSON.stringify(b.items), JSON.stringify(b.steps), JSON.stringify(b.data), b.why, b.finished_at, b.id);
  app.events.emit(b.org_id, 'fresh.step', b.why ?? b.steps.at(-1)?.note ?? b.status, { live: true, resource: b.service_id ?? b.server_id, data: { batch: b.id, serviceId: b.service_id, serverId: b.server_id, status: b.status, steps: b.steps } });
}
function step(app: App, b: Batch, key: StepKey, state: Step['state'], note?: string) {
  const cur = b.steps.find((s) => s.key === key);
  const t = now();
  if (cur) { if (state !== 'active' && cur.state === 'active') cur.ms = Date.now() - Date.parse(cur.at); cur.state = state; if (note !== undefined) cur.note = note; }
  else b.steps.push({ key, state, at: t, ...(state !== 'active' && { ms: 0 }), ...(note && { note }) });
  save(app, b);
}
const did = (b: Batch, key: StepKey) => b.steps.some((s) => s.key === key && (s.state === 'done' || s.state === 'skipped'));

// --- the outside world (tests replace these) ------------------------------------------------------------------------------
export interface AppRef { svc: ServiceRow; cfg: ServiceConfig; repo: Repo; token: string; base: string }
export const freshDeps = {
  apply: applyOnBranch,
  openPr: openPull,
  preview: previewOf,
  smoke: smokeOf,
  checks: pullCheck,
  merge: mergePull,
  head: headSha,
  release: async (ctx: Ctx, svc: ServiceRow, commit?: string) => {
    const r = await deploy(ctx, svc, { ...(commit && { commit }), triggeredBy: 'Keep it fresh' });
    const { followFleet } = await import('../fleet/rolling.ts');
    await followFleet(ctx, svc.id, r); // on several servers: the rest follow one at a time, the main one first
    return r;
  },
  // a major version on an app that runs on several servers is tried on a share of visitors first (src/fleet/canary.ts)
  useCanary: async (ctx: Ctx, svc: ServiceRow) => {
    const { targetsOf } = await import('../fleet/model.ts');
    if (targetsOf(ctx.db, svc).length < 2) return false;
    const { canaryRefusal } = await import('../fleet/canary.ts');
    return !canaryRefusal(ctx.db, svc);
  },
  canary: async (ctx: Ctx, svc: ServiceRow) => {
    const { startCanary } = await import('../fleet/canary.ts');
    await startCanary(ctx, svc);
    return get<{ id: string; deployment_id: string | null; share: number }>(ctx.db, 'SELECT id, deployment_id, share FROM canaries WHERE service_id = ? ORDER BY created_at DESC LIMIT 1', svc.id)!;
  },
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  pollMs: 20_000, checksMs: 15 * 60_000, watchMs: 20 * 60_000, canaryMs: 2 * 3600_000,
};

// --- apply: the updates on a branch, by the package manager, in a throwaway container ------------------------------------------
const NAME: Record<string, RegExp> = {
  npm: /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i, PyPI: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, Go: /^[\w.~-]+(\/[\w.~-]+)+$/, 'crates.io': /^[A-Za-z0-9_-]+$/,
};
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,40}$/;
export const IMAGE: Record<string, string> = { npm: 'node:22-alpine', pnpm: 'node:22-alpine', yarn: 'node:22-alpine', pip: 'python:3.13-alpine', poetry: 'python:3.13-alpine', uv: 'python:3.13-alpine', go: 'golang:1.25-alpine', cargo: 'rust:1-alpine' };
// what each package manager is asked to do; names and versions are checked before they get here and go in as words
export function tokens(items: Item[], manager: string): { prod: string; dev: string; audit: boolean } {
  const ok = items.filter((i) => i.manager === manager && NAME[i.eco]?.test(i.name) && VERSION.test(i.to));
  const tok = (i: Item) => (manager === 'pip' || manager === 'uv' ? `${i.name}==${i.to}` : manager === 'poetry' ? `${i.name}@^${i.to}` : manager === 'go' ? `${i.name}@v${i.to}` : `${i.name}@${i.to}`);
  return { prod: ok.filter((i) => i.direct && !i.dev).map(tok).join(' '), dev: ok.filter((i) => i.direct && i.dev).map(tok).join(' '),
    audit: items.some((i) => i.manager === manager && !i.direct && i.security?.length) };
}
// The toolchain guard: an update of libraries never moves the package manager or the runtime to another version (a
// package manager, Node, Go or Rust version line, or the lockfile's format, changed by the package manager while updating).
// The lines are checked before anything is committed; a hit stops that update with TOOLCHAIN and what changed.
export const TOOLCHAIN_LINES = '^[-+](.*"packageManager" *:|.*"node" *:|go [0-9]|toolchain go|lockfileVersion *:|.*channel *=)';
export const TOOLCHAIN_GUARD = `T=$({ git diff -U0 -- package.json go.mod pnpm-lock.yaml rust-toolchain.toml 2>/dev/null | grep -E '${TOOLCHAIN_LINES}' || true; git diff --name-only -- .nvmrc .node-version .python-version .ruby-version rust-toolchain 2>/dev/null || true; } | head -n 5)
if [ -n "$T" ]; then echo TOOLCHAIN; printf '%s\\n' "$T"; exit 0; fi`;
// what TOOLCHAIN's lines mean, in words
export function toolchainWhy(out: string): string {
  const t = out.slice(out.indexOf('TOOLCHAIN'));
  const what = /packageManager/.test(t) ? 'which package manager version builds the app' : /"node"/.test(t) ? 'which Node the app needs' : /^[-+]go |toolchain go/m.test(t) ? 'which Go the app needs'
    : /lockfileVersion/.test(t) ? 'the lockfile’s format (a new package manager version)' : /channel/.test(t) ? 'which Rust the app needs' : 'the app’s version file';
  return `Held back: the update would also change ${what}. Unit7 never changes that as part of an update; pin it yourself when you’re ready.`;
}
// the package manager at the version the app builds with (src/deploy/pins.ts), so an update can't move the lockfile on
const pmVersion = (a: AppRef, m: string) => { const p = a.cfg.detection?.pins?.pm; return p && p.tool === m && /^\d+(\.\d+){0,2}$/.test(p.version) ? p.version : ''; };
export const APPLY = `set -e
(apk add --no-cache git >/dev/null 2>&1 || (apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null)) || true
H="\${GIT_URL:-https://github.com/$REPO.git}" # GIT_URL: only the tests set it (a local bare repo)
if git clone -q --depth 50 -b "$BRANCH" "$H" /w 2>/dev/null; then cd /w; else git clone -q --depth 50 -b "$BASE" "$H" /w 2>/dev/null; cd /w; echo "@@base $(git rev-parse HEAD)"; git checkout -q -b "$BRANCH"; fi
set -f
if [ -f package.json ] && grep -q '"packageManager"' package.json && ! grep -Eq '"packageManager": *"[a-z]+@[0-9][0-9A-Za-z.+-]*"' package.json; then echo UNSUPPORTED; exit 0; fi
[ -z "$PM_VERSION" ] || case "$MANAGER" in pnpm|yarn) { corepack enable && corepack prepare "$MANAGER@$PM_VERSION" --activate; } >/dev/null 2>&1 || true ;; esac
if [ -n "$REVERT" ]; then git -c user.name=Unit7 -c user.email=unit7@users.noreply.github.com revert --no-edit "$REVERT" >/dev/null 2>&1 || { echo NOREVERT; exit 0; }
else case "$MANAGER" in
  npm) [ -z "$UP_PROD" ] || npm install --package-lock-only --ignore-scripts --no-audit --no-fund $UP_PROD >/dev/null 2>&1
       [ -z "$UP_DEV" ] || npm install -D --package-lock-only --ignore-scripts --no-audit --no-fund $UP_DEV >/dev/null 2>&1
       [ "$AUDIT" != 1 ] || npm audit fix --package-lock-only >/dev/null 2>&1 || true ;;
  pnpm) corepack enable >/dev/null 2>&1
       [ -z "$UP_PROD" ] || pnpm add --lockfile-only --ignore-scripts --ignore-pnpmfile $UP_PROD >/dev/null 2>&1
       [ -z "$UP_DEV" ] || pnpm add -D --lockfile-only --ignore-scripts --ignore-pnpmfile $UP_DEV >/dev/null 2>&1
       [ "$AUDIT" != 1 ] || { pnpm audit --fix --ignore-pnpmfile >/dev/null 2>&1; pnpm install --lockfile-only --ignore-pnpmfile --ignore-scripts >/dev/null 2>&1; } || true ;;
  yarn) corepack enable >/dev/null 2>&1
       if [ -f .yarnrc.yml ]; then yarn up --mode=update-lockfile $UP_PROD $UP_DEV >/dev/null 2>&1
       else [ -z "$UP_PROD" ] || yarn add --ignore-scripts $UP_PROD >/dev/null 2>&1; [ -z "$UP_DEV" ] || yarn add -D --ignore-scripts $UP_DEV >/dev/null 2>&1; fi ;;
  pip) python3 - $UP_PROD $UP_DEV <<'PY'
import re, sys
norm = lambda n: re.sub(r'[-_.]+', '-', n.lower())
want = {norm(a.split('==')[0]): a.split('==', 1)[1] for a in sys.argv[1:]}
lines = open('requirements.txt').read().split('\\n')
for i, l in enumerate(lines):
    m = re.match(r'^([A-Za-z0-9][A-Za-z0-9._-]*)(\\[[^\\]]*\\])?\\s*==\\s*([^\\s;#]+)', l)
    if m and norm(m.group(1)) in want: lines[i] = l[:m.start(3)] + want[norm(m.group(1))] + l[m.end(3):]
open('requirements.txt', 'w').write('\\n'.join(lines))
PY
       ;;
  poetry) pip install -q poetry >/dev/null 2>&1; [ -z "$UP_PROD" ] || poetry add --lock $UP_PROD >/dev/null 2>&1; [ -z "$UP_DEV" ] || poetry add --lock --group dev $UP_DEV >/dev/null 2>&1 ;;
  uv) pip install -q uv >/dev/null 2>&1; for p in $UP_PROD $UP_DEV; do uv lock --upgrade-package "$p" >/dev/null 2>&1; done ;;
  go) go get $UP_PROD >/dev/null 2>&1 && go mod tidy >/dev/null 2>&1 ;;
  cargo) for p in $UP_PROD $UP_DEV; do cargo update -p "\${p%@*}" --precise "\${p#*@}" >/dev/null 2>&1; done ;;
  *) echo UNSUPPORTED; exit 0 ;;
esac
${TOOLCHAIN_GUARD}
if [ -z "$(git status --porcelain)" ]; then echo NOCHANGE; exit 0; fi
git add -A && git -c user.name=Unit7 -c user.email=unit7@users.noreply.github.com commit -qm "$MSG"
fi
git push -q origin "$BRANCH" 2>&1 || exit 1
echo PUSHED; git diff --stat HEAD~1 | tail -n 15; echo @@diff; git diff HEAD~1 -- package.json requirements.txt pyproject.toml go.mod Cargo.toml composer.json Gemfile | head -n 150`;

export async function applyOnBranch(ctx: Ctx, a: AppRef, items: Item[], o: { branch: string; message: string; revert?: string }) {
  const s = serverRow(ctx, a.svc.server_id!);
  const managers = o.revert ? ['revert'] : [...new Set(items.map((i) => i.manager))];
  let baseSha: string | undefined, pushed = false, diff = '', files = '';
  // the container runs package tools on the repo's own files, so it gets a key to this repo only
  const box = await containerToken(ctx, a.repo, a.cfg.source?.type === 'git' ? a.cfg.source.accountId : undefined);
  ctx.redactor.add(box, 'GitHub token');
  const skipped: string[] = [];
  for (const m of managers) {
    const t = o.revert ? { prod: '', dev: '', audit: false } : tokens(items, m);
    if (!o.revert && !IMAGE[m]) { skipped.push(`Unit7 can’t update ${m} libraries by itself yet.`); continue; }
    if (!o.revert && !t.prod && !t.dev && !t.audit) continue;
    const envFile = `${APPS}/fresh-${a.svc.id.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}.env`;
    await writeEnvFile(ctx, s, envFile, { ...githubAuthEnv(box, 'https://github.com'), REPO: `${a.repo.owner}/${a.repo.name}`, BASE: a.base, BRANCH: o.branch, MANAGER: m, UP_PROD: t.prod, UP_DEV: t.dev, AUDIT: t.audit ? '1' : '0', MSG: o.message.replace(/\n/g, ' '), REVERT: o.revert ?? '', PM_VERSION: o.revert ? '' : pmVersion(a, m), COREPACK_ENABLE_AUTO_PIN: '0' });
    ctx.progress(o.revert ? `Taking the update back out of ${a.svc.name}’s main branch…` : `Updating ${a.svc.name}’s ${m} libraries on a branch…`);
    const r = await ssh(ctx.app).exec(s, script('docker run --rm --env-file "$1" "$3" sh -c "$2" 2>&1; rc=$?; rm -f "$1"; exit $rc', envFile, APPLY, o.revert ? IMAGE.npm! : IMAGE[m]!), { timeoutMs: 20 * 60_000, signal: ctx.signal });
    const out = ctx.redactor.redact(r.stdout);
    baseSha ??= /@@base ([0-9a-f]{40})/.exec(out)?.[1];
    if (/UNSUPPORTED/.test(out)) { skipped.push(`Unit7 can’t update ${m} libraries by itself yet.`); continue; }
    if (/NOREVERT/.test(out)) throw new Unit7Error('revert_failed', 'Git couldn’t take the update back out by itself (later commits touch the same lines).', 409);
    if (/^TOOLCHAIN$/m.test(out)) { skipped.push(toolchainWhy(out)); continue; } // the toolchain guard: nothing was committed
    if (/NOCHANGE/.test(out)) continue;
    if (r.code !== 0 || !/PUSHED/.test(out)) throw new Unit7Error('apply_failed', `The update couldn’t be pushed: ${out.trim().split('\n').slice(-3).join(' ').slice(-300)}`, 502);
    pushed = true;
    const [stat, d] = out.slice(out.indexOf('PUSHED') + 6).split('@@diff');
    files = `${files}${stat?.trim() ?? ''}\n`.trim(); diff = `${diff}${d?.trim() ?? ''}\n`.trim();
  }
  return { pushed, baseSha, diff: diff.slice(0, 12_000), files, skipped };
}

// --- staging: the pull request's preview -------------------------------------------------------------------------------------
export async function previewOf(ctx: Ctx, serviceId: string, pr: number) {
  const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'service.sync_previews', { serviceId }, { reason: 'a test copy of the updates', signal: ctx.signal, underApproval: ctx.approvalId });
  if (r.status !== 'ok') return { ok: false as const, why: r.status === 'error' ? r.error.message : 'why' in r ? r.why : r.status };
  const p = get<{ id: string; current_deployment_id: string | null }>(ctx.db, `SELECT id, current_deployment_id FROM services WHERE org_id = ? AND json_extract(config, '$.previewOf') = ? AND json_extract(config, '$.pr') = ?`, ctx.orgId, serviceId, pr);
  const d = p && get<{ id: string; status: string; plan: string; error: string | null }>(ctx.db, 'SELECT id, status, plan, error FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1', p.id);
  if (!p || !d) return { ok: false as const, why: 'The test copy wasn’t made.' };
  const plan = json<{ tests?: BatchData['tests'] }>(d.plan, {});
  const url = (r.output as { previews?: { pr: number; url?: string }[] }).previews?.find((x) => x.pr === pr)?.url;
  return { ok: d.status === 'live', serviceId: p.id, deploymentId: d.id, tests: plan.tests, error: d.error, ...(url && { url }) };
}

// --- check: the busiest pages on the copy and on the live app -------------------------------------------------------------------
const cls = (code: number) => (code ? Math.floor(code / 100) : 0);
const p95 = (ms: number[]) => { const s = [...ms].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! : 0; };
export function compareSmoke(live: Probe[], copy: Probe[]): Smoke {
  const rows = live.map((l) => {
    const c = copy.find((x) => x.path === l.path) ?? { code: 0, ms: 0 };
    // the same kind of answer; a page that errors live and works on the copy is fine
    return { path: l.path, live: l.code, copy: c.code, liveMs: l.ms, copyMs: c.ms, ok: cls(c.code) === cls(l.code) || (cls(l.code) === 5 && (cls(c.code) === 2 || cls(c.code) === 3)) };
  });
  const bad = rows.find((r) => !r.ok);
  if (bad) return { ok: false, rows, line: `${bad.path} answered ${bad.copy || 'nothing'} on the copy; the live app says ${bad.live || 'nothing'}.` };
  const a = p95(rows.map((r) => r.liveMs)), b = p95(rows.map((r) => r.copyMs));
  if (rows.length && b > Math.max(3 * a, a + 1000)) return { ok: false, rows, line: `Pages got slow on the copy: ${b} ms instead of the usual ${a} ms.` };
  return { ok: true, rows, line: rows.length ? `Your ${rows.length} busiest page${rows.length === 1 ? '' : 's'} answered the same on the copy as on the live app.` : 'Nothing to compare yet.' };
}
// the app's busiest pages and API paths from its traffic (when the server's traffic is this app's), then "/"
export function busiest(db: DB, serverId: string, hosts: string[]): string[] {
  const wins = all<{ summary: string }>(db, 'SELECT summary FROM traffic_windows WHERE server_id = ? AND at > ? ORDER BY at DESC LIMIT 200', serverId, new Date(Date.now() - 7 * 86400_000).toISOString()).map((w) => json<Partial<Summary>>(w.summary, {}));
  const count = new Map<string, number>();
  for (const w of wins) {
    if (!w.hosts?.length || !w.hosts.every((h) => hosts.includes(h.host))) continue;
    for (const p of w.topPaths ?? []) if (p.s4xx + p.s5xx < p.n / 2) count.set(p.path, (count.get(p.path) ?? 0) + p.n);
  }
  return warmPaths([], [...count].sort((a, b) => b[1] - a[1]).map(([p]) => p), 8);
}
async function smokeOf(ctx: Ctx, svc: ServiceRow, previewServiceId: string): Promise<Smoke> {
  const s = serverRow(ctx, svc.server_id!);
  const port = (c: ServiceConfig) => (c.detection?.builder === 'static' ? 80 : c.port ?? 3000);
  const box = (serviceId: string) => {
    const r = get<{ config: string; container: string | null }>(ctx.db, 'SELECT s.config, d.container FROM services s JOIN deployments d ON d.id = s.current_deployment_id WHERE s.id = ?', serviceId);
    return r?.container ? `http://${r.container}:${port(json<ServiceConfig>(r.config, {}))}` : undefined;
  };
  const live = box(svc.id), copy = box(previewServiceId);
  if (!live || !copy) return { ok: true, rows: [], line: 'Nothing to compare: one of the two isn’t running here.' };
  const hosts = all<{ hostname: string }>(ctx.db, 'SELECT hostname FROM domains WHERE service_id = ?', svc.id).map((d) => d.hostname);
  const paths = busiest(ctx.db, s.id, hosts);
  ctx.progress(`Opening ${paths.length} page${paths.length === 1 ? '' : 's'} on the copy and on the live app…`);
  return compareSmoke(await requestPaths(ctx.app, s, live, paths), await requestPaths(ctx.app, s, copy, paths));
}

// --- the run ---------------------------------------------------------------------------------------------------------------
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function appRef(ctx: Ctx, serviceId: string): Promise<AppRef> {
  return (async () => {
    const svc = get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
    if (!svc) throw new Unit7Error('not_found', 'That app was not found.', 404);
    const cfg = json<ServiceConfig>(svc.config, {});
    const repo = cfg.source?.type === 'git' ? parseRepo(cfg.source.repo) : undefined;
    if (!repo || cfg.source?.type !== 'git') throw new Unit7Error('unsupported', `${svc.name} isn’t deployed from GitHub, so there’s no repo to update.`, 400);
    if (!svc.server_id) throw new Unit7Error('no_server', `${svc.name} isn’t on a server.`, 409);
    const token = await githubToken(ctx, cfg.source.accountId);
    if (!token) throw new Unit7Error('no_account', 'Connect GitHub (with write access to this repo) so Unit7 can make the update branch.', 409);
    ctx.redactor.add(token, 'GitHub token');
    return { svc, cfg, repo, token, base: cfg.source.branch || await defaultBranch(repo, token) };
  })();
}
function prBody(b: Batch, app: string) {
  const rows = b.items.map((i) => `| ${i.name} | ${i.from} → ${i.to} | ${i.bump}${i.dev ? ' (dev)' : ''} | ${i.security?.map((s) => `[${s.id}](${s.url}) ${s.severity}`).join(', ') ?? ''} |`).join('\n');
  return `${(b.data.summary ?? []).map((l) => `- ${l}`).join('\n')}\n\n| Library | Version | Kind | Security |\n|---|---|---|---|\n${rows}\n\nUnit7 builds a test copy of ${app} from this branch, runs its tests and compares its busiest pages with the live app before anything is merged. — Unit7`;
}
const held = (app: App, b: Batch, key: StepKey, why: string) => {
  b.status = 'held'; b.why = `Held back: ${why}`; b.finished_at = now();
  step(app, b, key, 'failed', why);
  app.events.emit(b.org_id, 'fresh.held', `${b.why.replace(/\.$/, '')} · ${appName(app.db, b)}`, { severity: 'warning', projectId: projectOf(app.db, b.service_id), resource: b.service_id ?? b.server_id, data: { batch: b.id, serviceId: b.service_id, step: key } });
  return b;
};
export const projectOf = (db: DB, serviceId: string | null) => (serviceId ? get<{ p: string }>(db, 'SELECT project_id p FROM services WHERE id = ?', serviceId)?.p ?? null : null);
const appName = (db: DB, b: Pick<Batch, 'service_id' | 'server_id' | 'data'>) => (b.service_id ? get<{ name: string }>(db, 'SELECT name FROM services WHERE id = ?', b.service_id)?.name : b.data.part ?? get<{ name: string }>(db, 'SELECT name FROM servers WHERE id = ?', b.server_id ?? '')?.name) ?? 'your app';

// Prepare (Find → Check), then ask the gate about Accept. releasing: this is fresh.release itself, past Accept.
export async function runBatch(ctx: Ctx, bid: string, o: { releasing?: boolean; onlyIfAllowed?: boolean } = {}): Promise<Batch> {
  const b = loadBatch(ctx.db, ctx.orgId, bid);
  if (!b) throw new Unit7Error('not_found', 'That batch of updates was not found.', 404);
  if (['released', 'rolled_back', 'up_to_date'].includes(b.status)) return b;
  const app = ctx.app, name = appName(ctx.db, b);
  b.status = 'running'; b.why = null; b.finished_at = null;
  if (!did(b, 'find')) step(app, b, 'find', 'done', b.kind === 'image' ? 'The base image has a newer build.' : b.kind === 'server' ? 'System updates are waiting.' : b.kind === 'coolify' ? 'A newer image is out.' : `${plural(b.items.length, 'update')}${b.items.some((i) => i.security) ? `, ${plural(b.items.filter((i) => i.security).length, 'security fix', 'security fixes')}` : ''}.`);
  const code = b.kind === 'weekly' || b.kind === 'security' || b.kind === 'major';
  let ref: AppRef | undefined;
  try {
    // --- Apply ---
    if (!did(b, 'apply')) {
      if (!code) step(app, b, 'apply', 'skipped', b.kind === 'image' ? 'Nothing to change in your code: only the base image is new.' : 'Nothing to change in your code.');
      else {
        step(app, b, 'apply', 'active', 'Making the updates on a separate branch…');
        ref = await appRef(ctx, b.service_id!);
        const branch = `unit7/${b.kind === 'major' ? `${b.items[0]!.name.replace(/[^\w.-]+/g, '-')}-${b.items[0]!.to.split('.')[0]}` : b.kind === 'security' ? 'security-fixes' : 'updates'}-${now().slice(0, 10)}-${b.id.slice(-5).toLowerCase()}`;
        const r = await freshDeps.apply(ctx, ref, b.items, { branch, message: b.kind === 'major' ? `Update ${b.title}` : `Update ${plural(b.items.length, 'library', 'libraries')}${b.items.some((i) => i.security) ? ' (security fixes)' : ''}` });
        if (!r.pushed) return held(app, b, 'apply', r.skipped[0] ?? 'the package manager found nothing to change within what your app allows.');
        const pr = await freshDeps.openPr(ref.repo, { title: b.kind === 'major' ? `Update ${b.title}` : `Keep it fresh: ${b.title}`, head: branch, base: ref.base, body: prBody(b, name) }, ref.token);
        b.data = { ...b.data, pr: { number: pr.number, url: pr.html_url, branch }, base: ref.base, ...(r.baseSha && { baseSha: r.baseSha }), diff: r.diff, files: r.files };
        step(app, b, 'apply', 'done', `Pull request #${pr.number} with ${plural(b.items.length, 'update')}.${r.skipped.length ? ` ${r.skipped[0]}` : ''}`);
      }
    }
    // --- Test + Staging ---
    if (!did(b, 'staging')) {
      if (!code) {
        step(app, b, 'test', 'skipped', 'Your tests run in the release itself, before visitors move.');
        step(app, b, 'staging', 'skipped', b.kind === 'coolify' ? 'Coolify builds it beside the live one and checks its health first.' : 'The new version starts beside the live one; visitors move only once it answers.');
      } else {
        step(app, b, 'test', 'active', 'Building a test copy from the branch and running your tests…');
        const p = await freshDeps.preview(ctx, b.service_id!, b.data.pr!.number);
        b.data.preview = { ...('serviceId' in p && { serviceId: p.serviceId, deploymentId: p.deploymentId }), ...('url' in p && p.url && { url: p.url }) };
        if ('tests' in p && p.tests) b.data.tests = { status: p.tests.status, ...(p.tests.label && { label: p.tests.label }), ...(p.tests.failure && { failure: p.tests.failure }), ...(p.tests.ms && { ms: p.tests.ms }) };
        const t = b.data.tests;
        // the AI never skips a failing test: a failure here holds the batch, whoever asked
        if (t && (t.status === 'failed' || t.status === 'timeout')) return held(app, b, 'test', t.failure ?? 'a test failed on the updated code');
        step(app, b, 'test', t?.status === 'passed' ? 'done' : 'skipped', t?.status === 'passed' ? `Your tests passed${t.label ? ` (${t.label})` : ''}.` : t?.status === 'off' ? 'Tests are turned off for this app.' : 'This app has no tests Unit7 can find; the copy’s checks decide.');
        if (!p.ok) return held(app, b, 'staging', 'why' in p && p.why ? p.why : `the test copy didn’t start${'error' in p && p.error ? `: ${p.error.split('\n')[0]}` : ''}`);
        step(app, b, 'staging', 'done', 'The test copy is running beside the live app.');
      }
    }
    // --- Check ---
    if (!did(b, 'check')) {
      if (!code || !b.data.preview?.serviceId) step(app, b, 'check', 'skipped', 'Checked during the release: it must answer before visitors move.');
      else {
        step(app, b, 'check', 'active', 'Opening your busiest pages on the copy…');
        const svc = get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ?', b.service_id!)!;
        const sm = await freshDeps.smoke(ctx, svc, b.data.preview.serviceId);
        b.data.smoke = sm;
        if (!sm.ok) return held(app, b, 'check', sm.line);
        step(app, b, 'check', 'done', sm.line);
      }
    }
    // --- Accept ---
    if (!o.releasing) {
      step(app, b, 'accept', 'active', 'Asking whether this can go by itself…');
      const where = b.service_id ? { serviceId: b.service_id } : { serverId: b.server_id! };
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'fresh.release', { ...where, batch: b.id }, { reason: `${b.title} for ${name}`, signal: ctx.signal, onlyIfAllowed: o.onlyIfAllowed, conversationId: ctx.conversationId });
      if (r.status === 'ok') return loadBatch(ctx.db, ctx.orgId, b.id)!;
      const fresh = loadBatch(ctx.db, ctx.orgId, b.id)!;
      fresh.status = 'waiting';
      if (r.status === 'approval_required' && r.approvalId) fresh.data.approvalId = r.approvalId;
      const tested = fresh.data.tests?.status === 'passed' ? ', tests passed' : '';
      step(app, fresh, 'accept', 'waiting', r.status === 'approval_required' && r.approvalId ? 'Waiting for your OK (on Approvals and your phone).' : r.status === 'error' ? r.error.message : `Ready when you are${tested}: release it, or hold it.`);
      app.events.emit(b.org_id, 'fresh.ready', `${fresh.kind === 'major' ? fresh.title : plural(fresh.items.length || 1, 'update')} ready for ${name}${tested} · Release`, { projectId: projectOf(app.db, b.service_id), resource: b.service_id ?? b.server_id, data: { batch: b.id, serviceId: b.service_id } });
      return fresh;
    }
    step(app, b, 'accept', 'done', ctx.actor.kind === 'user' ? `${ctx.actor.name} released it.` : ctx.approvalId ? 'Released with your OK.' : 'Went by itself, as your settings allow.');
    // --- Release ---
    return await release(ctx, b, name);
  } catch (e) {
    const cur = b.steps.find((s) => s.state === 'active')?.key ?? 'find';
    const why = (e as Error).message.split('\n')[0]!.replace(/\.$/, '').slice(0, 240);
    b.status = 'failed'; b.why = `Held back: ${why}`; b.finished_at = now();
    step(app, b, cur, 'failed', why);
    app.events.emit(b.org_id, 'fresh.held', `${b.why} · ${name}`, { severity: 'warning', projectId: projectOf(app.db, b.service_id), resource: b.service_id ?? b.server_id, data: { batch: b.id, serviceId: b.service_id, step: cur } });
    return b;
  }
}

async function release(ctx: Ctx, b: Batch, name: string): Promise<Batch> {
  const app = ctx.app;
  step(app, b, 'release', 'active', 'Releasing with zero downtime…');
  let deploymentId: string | undefined;
  if (b.kind === 'coolify') {
    const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'coolify.control', { serverId: b.server_id!, uuid: b.data.uuid!, kind: b.data.coolifyKind ?? 'application', action: b.data.coolifyKind === 'service' ? 'restart' : 'deploy' }, { reason: `a newer image for ${name}`, signal: ctx.signal, underApproval: ctx.approvalId });
    const st = r.status === 'ok' ? String((r.output as { status?: string }).status ?? '') : '';
    if (r.status !== 'ok' || /fail|error|cancel/i.test(st)) return held(app, b, 'release', r.status === 'ok' ? `Coolify’s deploy ended as ${st}; the version before keeps running` : r.status === 'error' ? r.error.message : 'why' in r ? r.why : r.status);
    step(app, b, 'release', 'done', 'Coolify deployed it after its health check passed.');
    step(app, b, 'watch', 'done', 'Coolify kept the old version until the new one was healthy.');
    return done(app, b, name, null);
  }
  if (b.kind === 'server') {
    const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'fresh.server_patch', { serverId: b.server_id! }, { reason: 'system updates', signal: ctx.signal, underApproval: ctx.approvalId });
    if (r.status !== 'ok') return held(app, b, 'release', r.status === 'error' ? r.error.message : 'why' in r ? r.why : r.status);
    const out = r.output as { line: string; restart?: boolean };
    step(app, b, 'release', 'done', out.line);
    step(app, b, 'watch', out.restart ? 'waiting' : 'done', out.restart ? 'It restarts inside its restart window, after a 10-minute warning.' : 'Nothing needed a restart.');
    return done(app, b, name, null);
  }
  const svc = get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ?', b.service_id!)!;
  let commit: string | undefined;
  if (b.data.pr) {
    const ref = await appRef(ctx, svc.id);
    // merge only after the pull request's checks are green (Unit7's own preview reports there)
    const until = Date.now() + freshDeps.checksMs;
    let merged = false;
    for (;;) {
      const c = await freshDeps.checks(ref.repo, b.data.pr.number, ref.token);
      if (!c.open && !c.merged) return held(app, b, 'release', 'the pull request was closed');
      if (c.merged || c.status === 'success') { merged = c.merged; break; }
      if (c.status === 'failure' || c.status === 'error') return held(app, b, 'release', 'the pull request’s checks failed');
      if (Date.now() > until) return held(app, b, 'release', 'the pull request’s checks didn’t finish in time');
      await freshDeps.sleep(freshDeps.pollMs);
    }
    // what was tested is what ships: the main branch hasn't moved since the branch was made…
    const head = merged ? undefined : await freshDeps.head(ref.repo, ref.base, ref.token);
    if (b.data.baseSha && head && head !== b.data.baseSha) return held(app, b, 'release', `${ref.base} changed since the updates were tested; Unit7 tries again on the next run`);
    // …and an AI never ships commits on it that aren't live yet (the same rule as any redeploy by an AI)
    const live = json<{ commit?: string }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.plan, {}).commit;
    const ai = ctx.actor.kind !== 'user' && !(ctx.actor.id === 'warden' && ref.cfg.autoDeploy !== false);
    if (ai && live && b.data.baseSha && b.data.baseSha !== live) return held(app, b, 'release', `${ref.base} has changes that aren’t live yet, so Unit7 won’t release them for you`);
    if (!merged) await freshDeps.merge(ref.repo, b.data.pr.number, ref.token);
    commit = await freshDeps.head(ref.repo, ref.base, ref.token);
    if (commit) { rememberSha(ctx, svc.id, commit); b.data.mergeSha = commit; } // push-to-deploy doesn't ship it a second time
  } else if (json<ServiceConfig>(svc.config, {}).source?.type === 'git') {
    // only the base image moved: rebuild exactly what's live, on the fresh base
    commit = json<{ commit?: string }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.plan, {}).commit;
    if (!commit && ctx.actor.kind !== 'user') return held(app, b, 'release', 'Unit7 doesn’t know which commit is live, so it won’t rebuild it for you');
  }
  // a major version on several servers: a share of visitors first, then the rest, as long as it looks normal. Only when the
  // deploy inside isn't pinned to the live commit (a person, or push-to-deploy's Warden), so it ships what was tested.
  const unpinned = ctx.actor.kind === 'user' || (ctx.actor.id === 'warden' && json<ServiceConfig>(svc.config, {}).autoDeploy !== false);
  if (b.kind === 'major' && unpinned && await freshDeps.useCanary(ctx, svc).catch(() => false)) return canaryRelease(ctx, b, svc, name);
  const r = await freshDeps.release(ctx, svc, commit).catch((e: Error) => ({ error: e }));
  if ('error' in r) {
    if (b.data.mergeSha) await undo(ctx, b, name).catch(() => undefined);
    return held(app, b, 'release', `${r.error.message.split('\n')[0]!.replace(/\.$/, '')}. The version before keeps running`);
  }
  deploymentId = r.deploymentId;
  b.data.deploymentId = deploymentId;
  step(app, b, 'release', 'done', `Live as version ${r.number}.`);
  // --- Watch: the release's own watch window ---
  step(app, b, 'watch', 'active', 'Watching errors and speed after the switch…');
  const until = Date.now() + freshDeps.watchMs;
  let w: { status?: string; reason?: string } | undefined;
  for (;;) {
    w = json<{ watch?: { status?: string; reason?: string } }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', deploymentId)?.plan, {}).watch;
    if (!w || w.status !== 'watching' || Date.now() > until) break;
    await freshDeps.sleep(freshDeps.pollMs);
  }
  const down = get<{ d: number | null }>(ctx.db, 'SELECT downtime_seconds d FROM deployments WHERE id = ?', deploymentId)?.d ?? null;
  b.data.downSeconds = down;
  if (w?.status === 'rolled_back' || w?.status === 'bad') {
    if (b.data.mergeSha) await undo(ctx, b, name).catch(() => undefined);
    const why = w.status === 'rolled_back' ? `rolled back by itself: ${w.reason ?? 'it looked worse after the release'}` : `${w.reason ?? 'it looked worse after the release'}`;
    held(app, b, 'watch', why);
    b.status = w.status === 'rolled_back' ? 'rolled_back' : 'failed';
    save(app, b);
    return b;
  }
  step(app, b, 'watch', 'done', !w ? 'Not watched: watching after releases is off for this app.' : 'No change in errors or speed after the switch.');
  return done(app, b, name, down);
}

async function canaryRelease(ctx: Ctx, b: Batch, svc: ServiceRow, name: string): Promise<Batch> {
  const app = ctx.app;
  const c = await freshDeps.canary(ctx, svc).catch((e: Error) => ({ error: e }));
  if ('error' in c) {
    if (b.data.mergeSha) await undo(ctx, b, name).catch(() => undefined);
    return held(app, b, 'release', `${c.error.message.split('\n')[0]!.replace(/\.$/, '')}. The version before keeps running`);
  }
  b.data.deploymentId = c.deployment_id ?? undefined;
  step(app, b, 'release', 'done', `Live for ${c.share}% of visitors first; the rest follow while it looks normal.`);
  step(app, b, 'watch', 'active', 'Comparing it with the version before, on the same minutes…');
  const until = Date.now() + freshDeps.canaryMs;
  let row: { status: string; reason: string | null } | undefined;
  for (;;) {
    row = get<{ status: string; reason: string | null }>(ctx.db, 'SELECT status, reason FROM canaries WHERE id = ?', c.id);
    if (!row || !['starting', 'running', 'held'].includes(row.status) || Date.now() > until) break;
    await freshDeps.sleep(freshDeps.pollMs);
  }
  if (row?.status === 'done') {
    step(app, b, 'watch', 'done', 'Every visitor is on the new version; it looked normal at each step.');
    return done(app, b, name, get<{ d: number | null }>(ctx.db, 'SELECT downtime_seconds d FROM deployments WHERE id = ?', c.deployment_id ?? '')?.d ?? null);
  }
  if (row && ['starting', 'running', 'held'].includes(row.status)) {
    step(app, b, 'watch', 'waiting', 'Still being tried on some visitors. Promote it or roll it back on the app page.');
    b.status = 'waiting'; save(app, b);
    return b;
  }
  if (b.data.mergeSha) await undo(ctx, b, name).catch(() => undefined);
  held(app, b, 'watch', `rolled back by itself: ${(row?.reason ?? 'it looked worse on the visitors who tried it').replace(/\.$/, '').replace(/^\w/, (x) => x.toLowerCase())}`);
  b.status = 'rolled_back'; save(app, b);
  return b;
}

// a bad release: a pull request that takes the update back out of the main branch (merged by itself once green)
async function undo(ctx: Ctx, b: Batch, name: string) {
  const ref = await appRef(ctx, b.service_id!);
  const branch = `unit7/undo-${b.data.pr?.branch.replace(/^unit7\//, '') ?? b.id.slice(-5)}`.slice(0, 120);
  const r = await freshDeps.apply(ctx, ref, [], { branch, message: `Undo: ${b.title}`, revert: b.data.mergeSha! });
  if (!r.pushed) return;
  const pr = await freshDeps.openPr(ref.repo, { title: `Undo: ${b.title}`, head: branch, base: ref.base, body: `The release of these updates for ${name} looked worse after the switch, so Unit7 rolled it back and this takes the change back out of ${ref.base}. Unit7 merges it once its checks are green. — Unit7` }, ref.token);
  b.data.revertPr = { number: pr.number, url: pr.html_url, branch };
}

function done(app: App, b: Batch, name: string, down: number | null) {
  b.status = 'released'; b.why = null; b.finished_at = now();
  save(app, b);
  const sec = b.items.filter((i) => i.security?.length).length;
  const what = b.kind === 'server' ? `System updates on ${name} are in` : b.kind === 'image' ? `${name} is rebuilt on a fresh base image` : b.kind === 'coolify' ? `${name} runs its newer image` : sec && sec === b.items.length ? `Security fix${sec === 1 ? '' : 'es'} for ${name} ${sec === 1 ? 'is' : 'are'} live` : b.kind === 'major' ? `${b.title} is live on ${name}` : `${plural(b.items.length, 'update')} for ${name} ${b.items.length === 1 ? 'is' : 'are'} live`;
  app.events.emit(b.org_id, 'fresh.released', `${what}${down !== null ? ` · ${Math.round(down)} s down` : ''}`, { severity: 'success', projectId: projectOf(app.db, b.service_id), resource: b.service_id ?? b.server_id, data: { batch: b.id, serviceId: b.service_id, deploymentId: b.data.deploymentId, updates: b.items.length, security: sec } });
  return b;
}

export const itemWords = (i: Item) => `${nice(i.name)} ${i.from} → ${i.to}`;
