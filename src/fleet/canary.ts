// Canary releases. "Canary" means the new version first gets a small share of visitors (10% by default). Unit7 compares
// its errors and speed with the old version's over the same minutes, then raises the share in steps (10 → 50 → 100%)
// with a hold per step (5 minutes), or rolls back by itself when the new one is clearly worse.
//  · The split is the proxy's own: weighted round robin in the main server's Caddy, between the new copies and the old
//    ones (the old copies on the same server, and with a front proxy the fleet's other servers). caddy.ts withCanary
//    writes it from this table, so every caller of putSite keeps it. An app on one server with one copy works too: the
//    old and the new container sit side by side for the canary.
//  · The deploy itself is the normal one (deployment.create, through the gate, with its test gate and database checks);
//    with a canary starting it leaves the old version serving and skips its own watch (deployer.ts).
//  · The comparison is the deploy watch's rule (release.ts watchVerdict), with the old version's numbers from the same
//    minutes as "usual": which copy answered each request is in the proxy's log (log_append upstream).
//  · DNS can't split visitors precisely (resolvers cache, and each picks a server its own way), so a fleet spread by DNS
//    is told to use the front proxy for canaries.
// Each look runs in Warden's minute and acts through the gate as Warden (step up, promote, roll back); a person can
// promote, hold, resume, set the share or roll back at any time, also from the phone.
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { proxyFor } from '../deploy/caddy.ts';
import { containerName, replicaNames, routeService, MAX_REPLICAS, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';
import * as rel from '../deploy/release.ts';
import type { Hit } from '../sentinel/traffic.ts';
import { execute, type Actor, type Ctx, type ToolResult } from '../tools/runtime.ts';
import { fleetOf, planOf, targetsOf } from './model.ts';

export const DEFAULT_STEPS = [10, 50, 100];
export const DEFAULT_HOLD = 5;
const OPEN = ['starting', 'running', 'held'];
export interface CanaryRow {
  id: string; org_id: string; service_id: string; status: string; share: number; steps: string; step: number; hold_minutes: number;
  from_deployment_id: string | null; deployment_id: string | null; old_containers: string; new_containers: string; step_at: string | null;
  points: string; health_fails: number; reason: string | null; by: string | null; created_at: string; finished_at: string | null;
}
export interface Point { at: string; newRate: number | null; oldRate: number | null; newReq: number; oldReq: number; newP95?: number; oldP95?: number; share: number }

// --- the plan and the decisions (pure; test/fleet-canary.test.ts) ------------------------------------------------------
// the steps: rising, whole percents, starting at the first share and always ending at 100
export function planSteps(share = DEFAULT_STEPS[0]!, steps?: number[]): number[] {
  const first = Math.min(99, Math.max(1, Math.round(share)));
  const rest = (steps ?? DEFAULT_STEPS).map((x) => Math.round(x)).filter((x) => x > first && x <= 100);
  return [...new Set([first, ...rest.sort((a, b) => a - b), 100])];
}

// requests that went to the new copies, and the rest (the old ones, here and on the other servers), from the proxy's log
export function splitHits(hits: Hit[], newContainers: string[]) {
  const neu: Hit[] = [], old: Hit[] = [];
  for (const h of hits) {
    if (!h.upstream) continue; // answered by the proxy itself (a blocked path, a redirect): neither version
    (newContainers.some((c) => h.upstream!.startsWith(`${c}:`)) ? neu : old).push(h);
  }
  return { neu: rel.rates(neu), old: rel.rates(old) };
}

export type Next = { act: 'rollback'; reason: string } | { act: 'step'; share: number; step: number } | { act: 'finish' } | { act: 'wait'; msLeft: number | null };
// what to do after a look: clearly worse → back; held → stay; the hold over and fine → the next step (or done at 100%)
export function canaryNext(c: { status: string; step: number; steps: number[]; stepAt: string | null; holdMinutes: number }, v: rel.Verdict, nowMs: number): Next {
  if (v.act === 'rollback') return { act: 'rollback', reason: v.reason ?? 'the new version did worse' };
  if (c.status === 'held') return { act: 'wait', msLeft: null };
  const left = Date.parse(c.stepAt ?? '') + c.holdMinutes * 60_000 - nowMs;
  if (!(left <= 0) || v.act === 'wait') return { act: 'wait', msLeft: Number.isFinite(left) ? Math.max(0, left) : null };
  const next = c.steps[c.step + 1];
  return next === undefined || next >= 100 ? { act: 'finish' } : { act: 'step', share: next, step: c.step + 1 };
}

const pct = (r: Pick<rel.Rates, 'requests' | 'errors'>) => (r.requests ? Math.round((r.errors / r.requests) * 10_000) / 100 : null);
const pctWords = (x: number | null) => (x === null ? 'no visits yet' : `${x < 1 && x > 0 ? x.toFixed(1) : Math.round(x * 10) / 10}% errors`);
// "New version: 0.1% errors vs 0.2% usual · next step to 50% in 4 min"
export function canaryWords(p: Pick<Point, 'newRate' | 'oldRate'> | undefined, n: { status: string; next?: number; msLeft?: number | null }) {
  const now = p ? `New version: ${pctWords(p.newRate)}${p.oldRate !== null ? ` vs ${p.oldRate.toFixed(1).replace(/\.0$/, '')}% usual` : ''}` : 'New version: no visits yet';
  if (n.status === 'held') return `${now} · held here until you carry on`;
  if (n.next === undefined) return now;
  const mins = n.msLeft === null || n.msLeft === undefined ? undefined : Math.max(1, Math.ceil(n.msLeft / 60_000));
  return `${now} · next step to ${n.next}%${mins ? ` in ${mins} min` : ' soon'}`;
}
// the phone's one word: normal (no worse), worse, or not enough visits to say
export const verdictWord = (v: rel.Verdict, p?: Pick<Point, 'newReq'>) => (v.act === 'rollback' ? 'worse' : (p?.newReq ?? 0) < 30 ? 'few visits yet' : 'normal');

// --- records ---------------------------------------------------------------------------------------------------------
export const activeCanary = (db: DB, serviceId: string) => get<CanaryRow>(db, `SELECT * FROM canaries WHERE service_id = ? AND status IN ('starting', 'running', 'held') ORDER BY created_at DESC LIMIT 1`, serviceId);
export const lastCanary = (db: DB, serviceId: string) => get<CanaryRow>(db, 'SELECT * FROM canaries WHERE service_id = ? ORDER BY created_at DESC LIMIT 1', serviceId);
const numberOf = (db: DB, dep: string | null) => (dep ? get<{ number: number }>(db, 'SELECT number FROM deployments WHERE id = ?', dep)?.number ?? null : null);
const steps = (c: CanaryRow) => json<number[]>(c.steps, DEFAULT_STEPS);

export function canaryView(db: DB, c: CanaryRow | undefined, nowMs = Date.now()) {
  if (!c) return null;
  const st = steps(c), points = json<Point[]>(c.points, []), last = points.at(-1);
  const next = st[c.step + 1];
  const msLeft = c.status === 'running' && c.step_at ? Math.max(0, Date.parse(c.step_at) + c.hold_minutes * 60_000 - nowMs) : null;
  return {
    id: c.id, status: c.status, share: c.share, steps: st, step: c.step, holdMinutes: c.hold_minutes, version: numberOf(db, c.deployment_id), from: numberOf(db, c.from_deployment_id),
    next: OPEN.includes(c.status) ? next : undefined, nextAt: msLeft !== null ? new Date(nowMs + msLeft).toISOString() : null, points: points.slice(-40),
    words: c.status === 'starting' ? 'Building the new version: it gets its first visitors once its checks pass'
      : OPEN.includes(c.status) ? canaryWords(last, { status: c.status, next, msLeft })
      : c.status === 'done' ? `v${numberOf(db, c.deployment_id)} took over all visitors` : c.reason ?? (c.status === 'rolled_back' ? 'Rolled back' : 'Stopped'),
    reason: c.reason, by: c.by, startedAt: c.created_at, finishedAt: c.finished_at,
  };
}

// --- starting one ------------------------------------------------------------------------------------------------------
export const CANARY_WORD = 'Canary: the new version first gets a small share of visitors, and more only while it does as well as the old one.';
const DBS = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
const copiesOf = (primary: string, cfg: ServiceConfig) => [primary, ...replicaNames(primary, cfg.replicas)];
const serverOf = (db: DB, sid: string) => get<ServerRow>(db, 'SELECT * FROM servers WHERE id = ?', sid)!;

// why a canary can't run for this app (or undefined when it can)
export function canaryRefusal(db: DB, svc: ServiceRow): string | undefined {
  if (svc.kind === 'worker') return `${svc.name} works in the background and has no visitors to split.`;
  if (DBS.includes(svc.kind)) return `${svc.name} is a database: there’s no new version of it to try on visitors.`;
  if (!svc.server_id || !svc.current_deployment_id) return `${svc.name} isn’t running yet. Deploy it once first: a canary tries a new version next to a running one.`;
  const main = serverOf(db, svc.server_id);
  const p = proxyFor(main);
  if (p.kind !== 'caddy') return `${main.name}’s web traffic goes through ${p.kind === 'coolify' ? 'Coolify’s proxy' : 'another program'}, so Unit7 can’t split visitors there.`;
  if (targetsOf(db, svc).length > 1 && fleetOf(db, svc.id)?.mode === 'dns') return `${svc.name}’s visitors are spread with DNS, which can’t split them precisely: resolvers keep an answer for minutes and each picks a server its own way. Canaries need the front proxy (one server takes every visitor and splits them by weight). Spread visitors with the front proxy to use canaries.`;
  if (activeCanary(db, svc.id)) return `A new version of ${svc.name} is already being tried. Promote it or roll it back first.`;
  if (get(db, `SELECT 1 FROM fleet_runs WHERE service_id = ? AND status IN ('running', 'paused', 'cancelling') AND created_at > ?`, svc.id, new Date(Date.now() - 6 * 3600_000).toISOString())) return `A rollout of ${svc.name} is going. Wait for it, or cancel it.`;
  return undefined;
}

export async function startCanary(ctx: Ctx, svc0: ServiceRow, o: { share?: number; steps?: number[]; holdMinutes?: number } = {}) {
  const fresh = () => get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ?', svc0.id)!;
  const svc = fresh();
  const no = canaryRefusal(ctx.db, svc);
  if (no) throw new Unit7Error('canary_unavailable', no, 409);
  const cfg = json<ServiceConfig>(svc.config, {});
  const live = get<{ container: string | null }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id)?.container;
  if (!live) throw new Unit7Error('not_running', `Unit7 doesn’t know which copy of ${svc.name} is live, so it can’t keep it serving beside the new one. Deploy it once first.`, 409);
  const st = planSteps(o.share, o.steps);
  const hold = Math.min(120, Math.max(1, Math.round(o.holdMinutes ?? DEFAULT_HOLD)));
  const canaryId = id('can');
  run(ctx.db, `INSERT INTO canaries (id, org_id, service_id, status, share, steps, step, hold_minutes, from_deployment_id, old_containers, by) VALUES (?, ?, ?, 'starting', ?, ?, 0, ?, ?, ?, ?)`,
    canaryId, ctx.orgId, svc.id, st[0], JSON.stringify(st), hold, svc.current_deployment_id, JSON.stringify(copiesOf(live, cfg)), ctx.actor.name);
  ctx.emit('fleet.canary_started', `Trying a new version of ${svc.name} on ${st[0]}% of visitors first (then ${st.slice(1).join(' → ')}%, ${hold} min each).`, { resource: svc.id, data: { serviceId: svc.id, canaryId } });
  // the normal deploy, through the gate: it builds, tests, checks the database changes, starts the new copies and checks
  // them; at the switch the proxy gives them their share and the old version keeps the rest
  const x = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { serviceId: svc.id }, { reason: `a canary of ${svc.name}`, signal: ctx.signal, onProgress: ctx.progress, conversationId: ctx.conversationId, ...(ctx.approvalId && { underApproval: ctx.approvalId }) });
  if (x.status !== 'ok') {
    const why = x.status === 'error' ? x.error.message : x.status === 'approval_required' ? `the deploy waits for a person’s approval (${x.why})` : 'why' in x ? x.why : 'the deploy didn’t run';
    run(ctx.db, `UPDATE canaries SET status = 'failed', reason = ?, finished_at = ? WHERE id = ?`, `It didn’t start: ${why.split('\n')[0]}`, now(), canaryId);
    throw new Unit7Error('canary_failed', `The new version of ${svc.name} didn’t start, so nothing changed for visitors: ${why}`, x.status === 'approval_required' ? 409 : 502, x.status === 'approval_required' ? { approvalId: x.approvalId } : undefined);
  }
  const r = x.output as { deploymentId: string; number: number };
  const dep = get<{ container: string }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', r.deploymentId);
  const neu = copiesOf(dep?.container ?? containerName(fresh(), r.number), json<ServiceConfig>(fresh().config, {}));
  run(ctx.db, `UPDATE canaries SET status = 'running', deployment_id = ?, new_containers = ?, step_at = ? WHERE id = ?`, r.deploymentId, JSON.stringify(neu), now(), canaryId);
  const c = get<CanaryRow>(ctx.db, 'SELECT * FROM canaries WHERE id = ?', canaryId)!;
  ctx.emit('fleet.canary', `${svc.name} v${r.number} is at ${st[0]}% · few visits yet`, { resource: svc.id, data: { serviceId: svc.id, canaryId, share: st[0], projectId: svc.project_id } });
  return { canary: canaryView(ctx.db, c), words: CANARY_WORD };
}

// --- one look --------------------------------------------------------------------------------------------------------
export const canaryDeps = {
  readLog: rel.readSiteLog,
  probe: (app: App, s: ServerRow, base: string, path: string) => rel.requestPaths(app, s, base, [path]),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};
const hostsOf = (db: DB, svc: ServiceRow) => all<{ hostname: string; target: string | null }>(db, 'SELECT hostname, target FROM domains WHERE service_id = ? AND org_id = ?', svc.id, svc.org_id)
  .filter((d) => !json<{ redirectTo?: string }>(d.target, {}).redirectTo).map((d) => d.hostname);

export async function lookAt(app: App, svc: ServiceRow, c: CanaryRow) {
  const main = serverOf(app.db, svc.server_id!);
  const since = Date.parse(c.step_at ?? c.created_at);
  const log = await canaryDeps.readLog(app, main, hostsOf(app.db, svc), String(Math.floor(since / 1000))).catch(() => null);
  const { neu, old } = splitHits((log?.hits ?? []).filter((h) => h.at >= since), json<string[]>(c.new_containers, []));
  const plan = planOf(app.db, c.deployment_id);
  const cfg = json<ServiceConfig>(svc.config, {});
  const port = plan.port ?? cfg.port ?? 3000, path = (plan as { readyPath?: string }).readyPath ?? plan.healthPath ?? '/';
  const first = json<string[]>(c.new_containers, [])[0];
  const probe = first ? await canaryDeps.probe(app, main, `http://${first}:${port}`, path).catch(() => []) : [];
  const healthFails = probe[0] && rel.okCode(path, probe[0].code) ? 0 : c.health_fails + 1;
  const nowMs = canaryDeps.now();
  const done = !!c.step_at && Date.parse(c.step_at) + c.hold_minutes * 60_000 <= nowMs;
  const verdict = rel.watchVerdict(old, neu, { healthFails, done });
  const point: Point = { at: new Date(nowMs).toISOString(), newRate: pct(neu), oldRate: pct(old), newReq: neu.requests, oldReq: old.requests, ...(neu.p95 !== undefined && { newP95: neu.p95 }), ...(old.p95 !== undefined && { oldP95: old.p95 }), share: c.share };
  return { verdict, point, healthFails, logRead: !!log };
}

const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };
// Warden's minute: every canary that's going gets a look, and the next move goes through the gate as Warden
export async function canaryTick(app: App, act: (orgId: string, tool: string, input: unknown, reason: string) => Promise<ToolResult> = (o, t, i, r) => execute(app, o, WARDEN, t, i, { reason: r })) {
  // a start cut short (Unit7 stopped while it deployed): it never got visitors, so it simply ends
  run(app.db, `UPDATE canaries SET status = 'failed', reason = 'Unit7 stopped while the new version was starting.', finished_at = ? WHERE status = 'starting' AND created_at < ?`, now(), new Date(canaryDeps.now() - 90 * 60_000).toISOString());
  for (const c of all<CanaryRow>(app.db, `SELECT * FROM canaries WHERE status IN ('running', 'held')`)) {
    const svc = get<ServiceRow>(app.db, 'SELECT * FROM services WHERE id = ?', c.service_id);
    if (!svc) continue;
    // someone rolled back or deployed by hand meanwhile: the canary is over
    if (svc.current_deployment_id !== c.deployment_id) {
      run(app.db, `UPDATE canaries SET status = 'rolled_back', reason = ?, finished_at = ? WHERE id = ?`, 'Another version went live while it was being tried.', now(), c.id);
      continue;
    }
    const l = await lookAt(app, svc, c);
    const points = [...json<Point[]>(c.points, []), l.point].slice(-90);
    run(app.db, 'UPDATE canaries SET points = ?, health_fails = ? WHERE id = ?', JSON.stringify(points), l.healthFails, c.id);
    const n = canaryNext({ status: c.status, step: c.step, steps: steps(c), stepAt: c.step_at, holdMinutes: c.hold_minutes }, l.verdict, canaryDeps.now());
    if (n.act === 'wait') continue;
    const action = n.act === 'rollback' ? 'rollback' : n.act === 'finish' ? 'promote' : 'next';
    const why = n.act === 'rollback' ? `${n.reason} on ${c.share}% of visitors` : n.act === 'finish' ? 'it did as well as the old version at every step' : `it did as well as the old version at ${c.share}%`;
    await act(c.org_id, 'fleet.canary_control', { serviceId: c.service_id, action, ...(n.act === 'rollback' && { reason: why }) }, `the canary: ${why}`).catch(() => undefined);
  }
}

// --- moves -------------------------------------------------------------------------------------------------------------
async function reroute(ctx: Ctx, svc: ServiceRow, c: CanaryRow) {
  const [primary, ...replicas] = json<string[]>(c.new_containers, []);
  if (!primary) return;
  const plan = planOf(ctx.db, c.deployment_id);
  const cfg = json<ServiceConfig>(svc.config, {});
  await routeService(ctx, serverOf(ctx.db, svc.server_id!), svc, primary, replicas, undefined, plan.port ? { port: plan.port, healthPath: plan.healthPath ?? cfg.healthPath ?? '/' } : undefined);
}
const say = (ctx: Ctx, svc: ServiceRow, c: CanaryRow, share: number, word: string) =>
  ctx.emit('fleet.canary', `${svc.name} v${numberOf(ctx.db, c.deployment_id)} is at ${share}% · ${word}`, { resource: svc.id, data: { serviceId: svc.id, canaryId: c.id, share, projectId: svc.project_id } });

export type CanaryAction = 'promote' | 'hold' | 'resume' | 'rollback' | 'next' | 'share';
export async function canaryControl(ctx: Ctx, svc: ServiceRow, action: CanaryAction, o: { share?: number; reason?: string } = {}) {
  const c = activeCanary(ctx.db, svc.id);
  if (!c || c.status === 'starting') throw new Unit7Error('no_canary', c ? `The new version of ${svc.name} is still starting. Try again once it gets its first visitors.` : `No new version of ${svc.name} is being tried right now.`, 409);
  const st = steps(c);
  const lastWord = verdictWord({ act: 'ok' }, json<Point[]>(c.points, []).at(-1));
  if (action === 'hold') {
    run(ctx.db, `UPDATE canaries SET status = 'held' WHERE id = ?`, c.id);
    ctx.emit('fleet.canary_control', `${ctx.actor.name} held ${svc.name}’s new version at ${c.share}% of visitors.`, { resource: svc.id, data: { serviceId: svc.id } });
  } else if (action === 'resume') {
    run(ctx.db, `UPDATE canaries SET status = 'running', step_at = ? WHERE id = ?`, now(), c.id);
    ctx.emit('fleet.canary_control', `${ctx.actor.name} let ${svc.name}’s new version carry on from ${c.share}%.`, { resource: svc.id, data: { serviceId: svc.id } });
  } else if (action === 'next' || action === 'share') {
    const share = action === 'next' ? st[c.step + 1] ?? 100 : Math.round(o.share ?? NaN);
    if (!(share >= 1 && share <= 100)) throw new Unit7Error('invalid_input', 'A share is a whole percent from 1 to 100.', 400);
    if (share >= 100) return finish(ctx, svc, c);
    // the step the share sits on: the next one up continues from there
    const step = action === 'next' ? c.step + 1 : Math.max(0, st.filter((x) => x <= share).length - 1);
    run(ctx.db, 'UPDATE canaries SET share = ?, step = ?, step_at = ? WHERE id = ?', share, step, now(), c.id);
    try { await reroute(ctx, svc, { ...c, share }); }
    catch (e) { run(ctx.db, 'UPDATE canaries SET share = ?, step = ?, step_at = ? WHERE id = ?', c.share, c.step, c.step_at, c.id); throw e; }
    say(ctx, svc, c, share, lastWord);
  } else if (action === 'promote') return finish(ctx, svc, c);
  else return rollbackCanary(ctx, svc, c, o.reason);
  return { canary: canaryView(ctx.db, get<CanaryRow>(ctx.db, 'SELECT * FROM canaries WHERE id = ?', c.id)) };
}

// 100%: the old copies leave the proxy, finish what they're doing and stop (kept: going back is a start); on a fleet the
// other servers then follow, one at a time (the rolling release)
async function finish(ctx: Ctx, svc: ServiceRow, c: CanaryRow) {
  run(ctx.db, `UPDATE canaries SET status = 'done', share = 100, finished_at = ? WHERE id = ?`, now(), c.id);
  try { await reroute(ctx, svc, c); }
  catch (e) { run(ctx.db, `UPDATE canaries SET status = 'running', share = ?, finished_at = NULL WHERE id = ?`, c.share, c.id); throw e; }
  const main = serverOf(ctx.db, svc.server_id!);
  const old = json<string[]>(c.old_containers, []);
  const cfg = json<ServiceConfig>(svc.config, {});
  if (old.length) {
    const oldPort = planOf(ctx.db, c.from_deployment_id).port ?? cfg.port ?? 3000;
    await rel.drainWait(() => rel.countOpen(ctx.app, main, old, oldPort), { limitMs: rel.drainLimit(cfg.release, false) * 1000, sleep: canaryDeps.sleep });
    const all = [...new Set([...old, ...replicaNames(old[0]!, MAX_REPLICAS)])]; // every copy the old version may have
    await ssh(ctx.app).exec(main, script('g=$1; shift; docker stop -t "$g" "$@" >/dev/null 2>&1; true', rel.DEFAULTS.stopGraceSeconds, ...all), { timeoutMs: 120_000 }).catch(() => undefined);
  }
  const n = numberOf(ctx.db, c.deployment_id);
  let rolled: unknown;
  const others = targetsOf(ctx.db, svc).filter((t) => !t.primary);
  if (others.length) {
    const { fleetDeploy } = await import('./rolling.ts');
    ctx.progress(`v${n} has every visitor on ${main.name}; now the other servers, one at a time…`);
    rolled = await fleetDeploy(ctx, get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ?', svc.id)!, { servers: others.map((t) => t.serverId) }).catch((e: Error) => ({ status: 'failed', error: e.message }));
  }
  const stuck = (rolled as { status?: string; error?: string } | undefined)?.status === 'failed' ? (rolled as { error?: string }).error : undefined;
  if (stuck) ctx.emit('fleet.canary_done', `${svc.name} v${n} takes every visitor on ${main.name}, but the other servers stayed on the version before: ${stuck.split('\n')[0]} Bring them together from the app’s page once that’s fixed.`, { severity: 'warning', resource: svc.id, data: { serviceId: svc.id, canaryId: c.id } });
  else ctx.emit('fleet.canary_done', `${svc.name} v${n} did as well as the old version, so it now takes every visitor.`, { severity: 'success', resource: svc.id, data: { serviceId: svc.id, canaryId: c.id } });
  return { canary: canaryView(ctx.db, get<CanaryRow>(ctx.db, 'SELECT * FROM canaries WHERE id = ?', c.id)), ...(rolled !== undefined && { otherServers: rolled }) };
}

// back: the canary ends first (so the proxy drops the split), then the normal rollback starts the old version's copies
// (they were serving all along), points every name at them and stops the new ones
async function rollbackCanary(ctx: Ctx, svc: ServiceRow, c: CanaryRow, reason?: string) {
  const why = reason ?? `${ctx.actor.name} rolled it back`;
  run(ctx.db, `UPDATE canaries SET status = 'rolled_back', reason = ?, finished_at = ? WHERE id = ?`, why.charAt(0).toUpperCase() + why.slice(1), now(), c.id);
  const r = c.from_deployment_id ? await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.rollback', { serviceId: svc.id, deploymentId: c.from_deployment_id }, { reason: `the canary: ${why}`, signal: ctx.signal, ...(ctx.approvalId && { underApproval: ctx.approvalId }) }) : undefined;
  if (r && r.status !== 'ok') {
    run(ctx.db, `UPDATE canaries SET status = 'running', reason = NULL, finished_at = NULL WHERE id = ?`, c.id);
    throw new Unit7Error('rollback_failed', `Couldn’t roll ${svc.name} back: ${r.status === 'error' ? r.error.message : 'why' in r ? r.why : r.status}. The new version keeps its ${c.share}% for now.`, 502);
  }
  ctx.emit('fleet.canary_rolled_back', `Rolled back ${svc.name} v${numberOf(ctx.db, c.deployment_id)}: ${why}. Every visitor is on v${numberOf(ctx.db, c.from_deployment_id)} again.`, { severity: 'warning', resource: svc.id, data: { serviceId: svc.id, canaryId: c.id, reason: why, projectId: svc.project_id } });
  return { canary: canaryView(ctx.db, get<CanaryRow>(ctx.db, 'SELECT * FROM canaries WHERE id = ?', c.id)) };
}

// --- the phone: "shop v42 is at 10% · normal" with Promote / Roll back ---------------------------------------------------
export async function canaryButtons(app: App, orgId: string, canaryId: string, replies: string) {
  const { phoneCode } = await import('../sentinel/phone.ts');
  const b = (label: string, a: 'promote' | 'rollback') => `http, ${label}, ${replies}, method=POST, body=canary ${canaryId} ${a} ${phoneCode(app, orgId, `canary:${canaryId}:${a}`)}, clear=true`;
  return `${b('Promote', 'promote')}; ${b('Roll back', 'rollback')}`;
}
// one tap: "canary can_… promote <code>", as the person who set up phone approvals, through the gate like a click
export async function handleCanaryTap(app: App, acc: { orgId: string; approver: string }, text: string): Promise<string> {
  const m = /^canary (can_[\w-]{12}) (promote|rollback) ([\w-]{22})$/.exec(text.trim());
  const NOT_OURS = 'That button wasn’t from Unit7, so nothing was done.';
  if (!m) return NOT_OURS;
  const [, canaryId, action, code] = m as unknown as [string, string, 'promote' | 'rollback', string];
  const { phoneCode } = await import('../sentinel/phone.ts');
  const want = Buffer.from(phoneCode(app, acc.orgId, `canary:${canaryId}:${action}`)), got = Buffer.from(code);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return NOT_OURS;
  const c = get<CanaryRow>(app.db, 'SELECT * FROM canaries WHERE id = ? AND org_id = ?', canaryId, acc.orgId);
  if (!c || !['running', 'held'].includes(c.status)) return 'That try is already over. Open Unit7 to see how it ended.';
  const user = get<{ id: string; name: string; role: Actor['role'] }>(app.db, 'SELECT u.id, u.name, m.role FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.id = ? AND m.org_id = ?', acc.approver, acc.orgId);
  if (!user) return 'The person who set up phone approvals is no longer in this organisation.';
  const actor: Actor = { kind: 'user', id: user.id, userId: user.id, name: `${user.name} (from phone)`, role: user.role };
  const r = await execute(app, acc.orgId, actor, 'fleet.canary_control', { serviceId: c.service_id, action }, { reason: 'from the phone' });
  return r.status === 'ok' ? (action === 'promote' ? 'Promoted: the new version takes every visitor.' : 'Rolled back: every visitor is on the old version again.') : r.status === 'error' ? `Didn’t work: ${r.error.message.slice(0, 160)}` : `Waiting: ${'why' in r ? r.why : r.status}`;
}
