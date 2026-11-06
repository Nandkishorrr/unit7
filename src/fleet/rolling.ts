// A rolling release: one server at a time (or a few at a time), so the others keep serving while each one updates. The
// app is built once, on its main server, through the normal single-server deploy (deployer.ts: build, test, database
// changes, start beside the old one, health check, switch, and everything else a deploy does there). The same image then
// goes to each other server straight from the main one, through Unit7 (docker save | docker load, no registry), and each
// server starts it beside its old version, checks it, switches and stops the old one. The first failure stops the
// rollout and puts every server already done back on the version before, so the app never ends up half on a broken
// version. A run record holds every lane, so a person can pause, continue or cancel (= roll back everything).
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { cmd, script } from '../connectors/shell.ts';
import { containerName, healthCheck, replicaNames, removeCopies, rollback, routeService, startContainer, stayUp, MAX_REPLICAS, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';
import { resolveValues } from '../tools/env.ts';
import { execute, type Ctx } from '../tools/runtime.ts';
import { fleetOf, planOf, setTarget, targetsOf } from './model.ts';
import { syncEdge, applyDns, routeFront, fleetDeps } from './traffic.ts';

// --- the plan and the engine (pure, with what it does injected: test/fleet.test.ts drives it with fakes) -----------------
export type StepKey = 'image' | 'start' | 'check' | 'switch' | 'done';
export const STEPS: StepKey[] = ['image', 'start', 'check', 'switch', 'done'];
export type LaneState = 'waiting' | 'running' | 'done' | 'failed' | 'undone' | 'skipped';
export interface Lane { serverId: string; name: string; primary: boolean; state: LaneState; step?: StepKey; detail?: string; from?: string | null }

// the main server first and alone (it builds and changes the database), then the rest in batches of `batch`
export function planBatches(ids: string[], main: string | undefined, batch = 1): string[][] {
  const size = Math.max(1, Math.trunc(batch));
  const rest = ids.filter((x) => x !== main);
  const out: string[][] = main && ids.includes(main) ? [[main]] : [];
  for (let i = 0; i < rest.length; i += size) out.push(rest.slice(i, i + size));
  return out;
}

export interface RollDeps {
  deployOn(serverId: string): Promise<{ from?: string | null }>;      // put the release on this server; says what it ran before
  undo(serverId: string, from: string | null | undefined): Promise<void>; // put this server back on what it ran before
  control(): 'running' | 'paused' | 'cancelled';
  wait(ms: number): Promise<void>;
  lane(serverId: string, patch: Partial<Lane>): void;
}
export type RollResult = { status: 'done' | 'failed' | 'cancelled'; failed?: string; error?: string; undone: string[] };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 300);

export async function roll(batches: string[][], d: RollDeps, already: { id: string; from?: string | null }[] = []): Promise<RollResult> {
  const done = [...already];
  const undoAll = async () => {
    const undone: string[] = [];
    for (const x of [...done].reverse()) {
      d.lane(x.id, { state: 'running', detail: 'Going back to the version before' });
      try { await d.undo(x.id, x.from); d.lane(x.id, { state: 'undone', detail: 'Back on the version before' }); undone.push(x.id); }
      catch (e) { d.lane(x.id, { state: 'failed', detail: `Couldn’t go back: ${msg(e)}` }); }
    }
    return undone;
  };
  const skipRest = (from: number) => { for (const b of batches.slice(from)) for (const x of b) d.lane(x, { state: 'skipped' }); };
  for (let k = 0; k < batches.length; k++) {
    for (;;) {
      const c = d.control();
      if (c === 'running') break;
      if (c === 'cancelled') { skipRest(k); return { status: 'cancelled', undone: await undoAll() }; }
      await d.wait(2000);
    }
    const b = batches[k]!;
    const results = await Promise.allSettled(b.map(async (sid) => { d.lane(sid, { state: 'running' }); return { id: sid, from: (await d.deployOn(sid)).from }; }));
    let failed: { id: string; error: string } | undefined;
    results.forEach((r, j) => {
      if (r.status === 'fulfilled') { done.push(r.value); d.lane(b[j]!, { state: 'done', step: 'done', from: r.value.from ?? null }); }
      else { failed ??= { id: b[j]!, error: msg(r.reason) }; d.lane(b[j]!, { state: 'failed', detail: msg(r.reason) }); }
    });
    if (failed) { skipRest(k + 1); return { status: 'failed', failed: failed.id, error: failed.error, undone: await undoAll() }; }
  }
  return { status: 'done', undone: [] };
}

// --- the image, from the main server to another --------------------------------------------------------------------------
export const IMAGE = {
  has: (image: string) => script('docker image inspect "$1" >/dev/null 2>&1 && echo yes || echo no', image),
  save: (image: string) => script('docker save "$1" | gzip -1', image),
  load: () => script('gunzip | docker load >/dev/null'),
  pull: (image: string) => cmd('docker', 'pull', image),
};
export async function sendImage(ctx: Ctx, from: ServerRow, to: ServerRow, image: string) {
  const pool = ssh(ctx.app);
  const there = async () => (await pool.exec(to, IMAGE.has(image), { timeoutMs: 20_000 })).stdout.trim() === 'yes';
  if (await there()) return 'already there';
  // an image from a registry (nginx:1.27) is pulled there; one Unit7 built only exists on the main server
  if (!image.startsWith('unit7/')) { await pool.check(to, IMAGE.pull(image), { what: 'Pulling the image', timeoutMs: 600_000 }); return 'pulled'; }
  // ponytail: streamed through Unit7 to each server in turn; a private registry on one server (its password in the vault)
  // is the upgrade once images are big or servers many
  await pool.relay(from, IMAGE.save(image), to, IMAGE.load(), { timeoutMs: 45 * 60_000 });
  // gzip hides a failed save behind exit 0: what counts is whether the image arrived
  if (!(await there())) throw new Unit7Error('image_missing', `The app’s image didn’t arrive on ${to.name}.`, 502);
  return 'copied';
}

// --- one other server: start the release beside the old one, check it, switch, stop the old ---------------------------
const serverOf = (db: DB, id: string) => get<ServerRow>(db, 'SELECT * FROM servers WHERE id = ?', id)!;
// what a copy runs with: the app's settings, its port, and UNIT7_RUN_JOBS=0 (scheduled jobs belong to the main server)
export function envFor(ctx: Ctx, svc: ServiceRow, port: number) {
  const env = resolveValues(ctx, svc.id);
  env.PORT ??= String(port);
  env.UNIT7_RUN_JOBS = '0';
  return env;
}
const portsOf = (db: DB, svc: ServiceRow, depId: string) => {
  const plan = planOf(db, depId), cfg = json<ServiceConfig>(svc.config, {});
  return { port: plan.port ?? (cfg.detection?.builder === 'static' ? 80 : cfg.port ?? 3000), healthPath: plan.healthPath ?? cfg.healthPath ?? cfg.detection?.healthPath ?? '/', cfg };
};
const allCopies = (primary: string) => [primary, ...replicaNames(primary, MAX_REPLICAS)];

// how the server takes visitors: through its edge (front proxy) or its own Caddy for the app's domains (DNS)
async function switchTo(ctx: Ctx, svc: ServiceRow, s: ServerRow, depId: string | null, live: string, replicas: string[]) {
  setTarget(ctx.db, ctx.orgId, svc.id, s.id, { deploymentId: depId });
  // a standby (src/fleet/dr.ts) answers the app's names on its own proxy, ready for the day DNS points at it
  const standby = get<{ role: string }>(ctx.db, 'SELECT role FROM service_targets WHERE service_id = ? AND server_id = ?', svc.id, s.id)?.role === 'standby';
  if (!standby && (fleetOf(ctx.db, svc.id)?.mode ?? 'front') === 'front') await syncEdge(ctx, s);
  else if (depId) {
    const { port, healthPath } = portsOf(ctx.db, svc, depId);
    // D4: with DNS (and for a standby) this server shows the main server's certificate for the app's names, so it never
    // has to win Let's Encrypt's check on a name that points at several servers
    if (svc.server_id && svc.server_id !== s.id) {
      const { copyCerts } = await import('./care.ts');
      await copyCerts(ctx, serverOf(ctx.db, svc.server_id), s, all<{ hostname: string }>(ctx.db, 'SELECT hostname FROM domains WHERE service_id = ?', svc.id).map((d) => d.hostname)).catch(() => undefined);
    }
    await routeService(ctx, s, svc, live, replicas, undefined, { port, healthPath });
  }
}

export async function copyTo(ctx: Ctx, svc: ServiceRow, s: ServerRow, depId: string, step: (k: StepKey, detail?: string) => void = () => undefined): Promise<{ from: string | null }> {
  const dep = get<{ id: string; number: number; image: string | null }>(ctx.db, 'SELECT id, number, image FROM deployments WHERE id = ? AND service_id = ?', depId, svc.id);
  if (!dep?.image) throw new Unit7Error('no_image', `Version ${dep?.number ?? ''} of ${svc.name} has no image to send.`, 409);
  const t = targetsOf(ctx.db, svc).find((x) => x.serverId === s.id);
  const from = t?.deploymentId ?? null;
  const fromNumber = t?.number ?? null;
  const name = containerName(svc, dep.number);
  if (from === depId) { step('done', `Already on v${dep.number}`); return { from }; }
  const { port, healthPath, cfg } = portsOf(ctx.db, svc, depId);
  const pool = ssh(ctx.app);
  step('image');
  const how = await sendImage(ctx, serverOf(ctx.db, svc.server_id!), s, dep.image);
  step('start', how === 'copied' ? 'Image copied from the main server' : undefined);
  const env = envFor(ctx, svc, port);
  const replicas = svc.kind === 'worker' ? [] : replicaNames(name, cfg.replicas);
  try {
    for (const c of [name, ...replicas]) {
      await startContainer(ctx, s, c, dep.image, { ...cfg, port }, env, svc);
      step('check');
      const h = svc.kind === 'worker' ? await stayUp(ctx, s, c, () => undefined) : await healthCheck(ctx, s, c, port, healthPath, () => undefined);
      if (!h.healthy) throw new Unit7Error('unhealthy', `v${dep.number} didn’t pass its health check on ${s.name}, so it kept the version before. ${h.detail.split('\n')[0]}`, 502);
    }
    step('switch');
    await switchTo(ctx, svc, s, depId, name, replicas);
  } catch (e) {
    // the new copies go, the old version keeps serving there
    await removeCopies(ctx, s, name).catch(() => undefined);
    if (from !== null) setTarget(ctx.db, ctx.orgId, svc.id, s.id, { deploymentId: from });
    throw e;
  }
  // the deploy's own drain, on this server too: the old version finishes its open requests (up to the app's drain limit),
  // then it stops (kept, not removed: going back is a start)
  if (fromNumber !== null && fromNumber !== dep.number) {
    const old = allCopies(containerName(svc, fromNumber));
    const rel = await import('../deploy/release.ts');
    await rel.drainWait(() => rel.countOpen(ctx.app, s, old, portsOf(ctx.db, svc, from!).port), { limitMs: rel.drainLimit(cfg.release, false) * 1000, sleep: fleetDeps.sleep });
    await pool.exec(s, script('docker stop "$@" >/dev/null 2>&1; true', ...old)).catch(() => undefined);
  }
  await pruneThere(ctx, svc, s, dep.number).catch(() => undefined);
  return { from };
}

// back to the version before on that server (a stopped container, started again), or off it when it had none
export async function undoCopy(ctx: Ctx, svc: ServiceRow, s: ServerRow, from: string | null | undefined) {
  const t = targetsOf(ctx.db, svc).find((x) => x.serverId === s.id);
  const nowName = t?.number !== null && t?.number !== undefined ? containerName(svc, t.number) : undefined;
  const pool = ssh(ctx.app);
  if (!from) {
    setTarget(ctx.db, ctx.orgId, svc.id, s.id, { deploymentId: null });
    if ((fleetOf(ctx.db, svc.id)?.mode ?? 'front') === 'front') await syncEdge(ctx, s).catch(() => undefined);
    if (nowName) await removeCopies(ctx, s, nowName);
    return;
  }
  const prev = get<{ number: number }>(ctx.db, 'SELECT number FROM deployments WHERE id = ?', from);
  if (!prev) throw new Unit7Error('not_found', 'The version before is gone.', 404);
  const name = containerName(svc, prev.number);
  const { port, healthPath, cfg } = portsOf(ctx.db, svc, from);
  const replicas = svc.kind === 'worker' ? [] : replicaNames(name, cfg.replicas);
  for (const c of [name, ...replicas]) {
    await pool.check(s, cmd('docker', 'start', c), { what: 'Starting the version before', timeoutMs: 60_000 });
    const h = svc.kind === 'worker' ? await stayUp(ctx, s, c, () => undefined) : await healthCheck(ctx, s, c, port, healthPath, () => undefined);
    if (!h.healthy) throw new Unit7Error('rollback_unhealthy', `v${prev.number} didn’t come back healthy on ${s.name}.`, 502);
  }
  await switchTo(ctx, svc, s, from, name, replicas);
  if (nowName && nowName !== name) await pool.exec(s, script('docker stop "$@" >/dev/null 2>&1; true', ...allCopies(nowName))).catch(() => undefined);
}

// keep the newest 3 versions on that server too (the main server prunes its own in the deploy)
async function pruneThere(ctx: Ctx, svc: ServiceRow, s: ServerRow, current: number) {
  const keep = new Set([current, ...all<{ number: number }>(ctx.db, `SELECT number FROM deployments WHERE service_id = ? AND number < ? AND status IN ('live', 'stopped') ORDER BY number DESC LIMIT 2`, svc.id, current).map((r) => r.number)]);
  const names = (await ssh(ctx.app).exec(s, script('docker ps -a --filter "label=unit7.service=$1" --format "{{.Names}}"', svc.id))).stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  const base = containerName(svc, 0).replace(/-0$/, '-');
  for (const n of names) {
    const m = n.startsWith(base) ? /^(\d+)(-r\d+)?$/.exec(n.slice(base.length)) : null;
    if (m && !keep.has(Number(m[1]))) {
      await removeCopies(ctx, s, `${base}${m[1]}`).catch(() => undefined);
      await ssh(ctx.app).exec(s, cmd('docker', 'rmi', `unit7/${svc.slug}:${m[1]}`.toLowerCase())).catch(() => undefined);
    }
  }
}

// --- the run record --------------------------------------------------------------------------------------------------------
export interface RunRow { id: string; service_id: string; status: string; batch: number; lanes: string; error: string | null; by: string | null; created_at: string; finished_at: string | null }
// the rollouts running in this process: a record still "running" without one here was cut short (Unit7 stopped)
const engines = new Set<string>();
const OPEN = ['running', 'paused', 'cancelling'];
export const activeRun = (db: DB, serviceId: string) => {
  const r = get<RunRow>(db, `SELECT * FROM fleet_runs WHERE service_id = ? AND status IN ('running', 'paused', 'cancelling') ORDER BY created_at DESC LIMIT 1`, serviceId);
  return r && engines.has(r.id) ? r : undefined;
};
export const lastRun = (db: DB, serviceId: string) => get<RunRow>(db, 'SELECT * FROM fleet_runs WHERE service_id = ? ORDER BY created_at DESC LIMIT 1', serviceId);
export const runView = (r: RunRow | undefined) => r && {
  ...(OPEN.includes(r.status) && !engines.has(r.id) ? { status: 'failed', error: r.error ?? 'Unit7 stopped while this rollout ran. Check the versions below, and bring them together if they differ.' } : { status: r.status, error: r.error }),
  batch: r.batch, lanes: json<Lane[]>(r.lanes, []), by: r.by, startedAt: r.created_at, finishedAt: r.finished_at,
};

export function control(db: DB, serviceId: string, action: 'pause' | 'continue' | 'cancel') {
  const r = activeRun(db, serviceId);
  if (!r) throw new Unit7Error('no_run', 'Nothing is rolling out right now.', 409);
  const next = action === 'pause' ? (r.status === 'running' ? 'paused' : r.status) : action === 'continue' ? (r.status === 'paused' ? 'running' : r.status) : 'cancelling';
  run(db, 'UPDATE fleet_runs SET status = ? WHERE id = ?', next, r.id);
  return runView({ ...r, status: next })!;
}

// --- the whole release --------------------------------------------------------------------------------------------------
// servers: only these (the main one among them = a new build; without it, they're brought to what the main one runs).
// primaryDone: the main server was just deployed by a plain deploy (deployment.create on a fleet app): roll the rest.
export async function fleetDeploy(ctx: Ctx, svc0: ServiceRow, o: { batch?: number; servers?: string[]; primaryDone?: { deploymentId: string; previousDeploymentId?: string } } = {}) {
  const fresh = () => get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ?', svc0.id)!;
  let svc = fresh();
  if (activeRun(ctx.db, svc.id)) throw new Unit7Error('busy', `A rollout of ${svc.name} is already going. Pause, continue or cancel it first.`, 409);
  const ts = targetsOf(ctx.db, svc);
  const pick = o.servers?.length ? ts.filter((t) => o.servers!.includes(t.serverId)) : ts;
  if (o.servers?.some((x) => !ts.some((t) => t.serverId === x))) throw new Unit7Error('not_in_fleet', `One of those servers doesn’t run ${svc.name}. Add it first.`, 404);
  if (!pick.length) throw new Unit7Error('no_server', `${svc.name} isn’t on a server yet.`, 409);
  const mainId = svc.server_id ?? undefined;
  const build = !o.primaryDone && pick.some((t) => t.primary);
  const lanes: Lane[] = pick.map((t) => ({ serverId: t.serverId, name: t.name, primary: t.primary, state: o.primaryDone && t.primary ? 'done' : 'waiting' }));
  let release = o.primaryDone?.deploymentId ?? (build ? undefined : svc.current_deployment_id ?? undefined);
  if (!build && !release) throw new Unit7Error('not_deployed', `${svc.name} hasn’t been deployed yet. Deploy it first.`, 409);
  const runId = id('flr');
  const batch = Math.max(1, o.batch ?? 1);
  run(ctx.db, 'INSERT INTO fleet_runs (id, org_id, service_id, status, batch, lanes, by) VALUES (?, ?, ?, ?, ?, ?, ?)', runId, ctx.orgId, svc.id, 'running', batch, JSON.stringify(lanes), ctx.actor.name);
  engines.add(runId);
  const save = () => run(ctx.db, 'UPDATE fleet_runs SET lanes = ? WHERE id = ?', JSON.stringify(lanes), runId);
  const lane = (sid: string, patch: Partial<Lane>) => {
    const l = lanes.find((x) => x.serverId === sid);
    if (!l) return;
    Object.assign(l, patch);
    save();
    if (patch.state === 'running' || patch.step) ctx.progress(`${l.name}: ${patch.detail ?? (patch.step ? STEP_WORDS[patch.step] : 'starting')}`);
  };
  ctx.emit('fleet.rollout', `Rolling ${svc.name} out to ${pick.length} server${pick.length === 1 ? '' : 's'}, ${batch === 1 ? 'one at a time' : `${batch} at a time`}.`, { resource: svc.id, data: { serviceId: svc.id } });
  const deps: RollDeps = {
    async deployOn(sid) {
      if (sid === mainId && build) {
        lane(sid, { step: 'image', detail: 'Building on the main server' });
        // the normal deploy, through the gate: what an AI may ship in production, self-heal, a linked folder, approvals
        const x = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { serviceId: svc.id }, { reason: 'a rolling release across servers', signal: ctx.signal, onProgress: ctx.progress, conversationId: ctx.conversationId, ...(ctx.approvalId && { underApproval: ctx.approvalId }) });
        if (x.status !== 'ok') throw new Unit7Error('deploy_failed', x.status === 'error' ? x.error.message : x.status === 'approval_required' ? `The build waits for a person’s approval (${x.why})` : 'why' in x ? x.why : 'The build didn’t run.', 409);
        const r = x.output as { deploymentId: string; previousDeploymentId?: string };
        release = r.deploymentId;
        svc = fresh();
        setTarget(ctx.db, ctx.orgId, svc.id, sid, { deploymentId: r.deploymentId, role: 'primary' });
        return { from: r.previousDeploymentId ?? null };
      }
      return copyTo(ctx, svc, serverOf(ctx.db, sid), release!, (k, detail) => lane(sid, { step: k, ...(detail && { detail }) }));
    },
    async undo(sid, from) {
      if (sid === mainId) { if (from) await rollback(ctx, fresh(), from); return; }
      await undoCopy(ctx, fresh(), serverOf(ctx.db, sid), from);
    },
    control: () => {
      if (ctx.signal.aborted) return 'cancelled';
      const st = get<{ status: string }>(ctx.db, 'SELECT status FROM fleet_runs WHERE id = ?', runId)?.status;
      return st === 'cancelling' ? 'cancelled' : st === 'paused' ? 'paused' : 'running';
    },
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    lane,
  };
  const already = o.primaryDone && mainId ? [{ id: mainId, from: o.primaryDone.previousDeploymentId ?? null }] : [];
  const batches = planBatches(pick.filter((t) => !(o.primaryDone && t.primary)).map((t) => t.serverId), build ? mainId : undefined, batch);
  let r: RollResult;
  try { r = await roll(batches, deps, already); }
  catch (e) { r = { status: 'failed', error: msg(e), undone: [] }; }
  svc = fresh();
  // the front proxy follows whatever the main server runs now
  if ((fleetOf(ctx.db, svc.id)?.mode ?? 'front') === 'front' && ts.length > 1) await routeFront(ctx, svc).catch(() => undefined);
  else if (ts.length > 1) await applyDns(ctx, svc).catch(() => undefined);
  const status = r.status === 'done' ? 'done' : r.status === 'cancelled' ? 'cancelled' : 'failed';
  run(ctx.db, 'UPDATE fleet_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?', status, r.error ?? null, now(), runId);
  engines.delete(runId);
  const failedName = r.failed ? lanes.find((l) => l.serverId === r.failed)?.name : undefined;
  if (r.status === 'done') ctx.emit('fleet.done', `${svc.name} runs ${release ? `v${get<{ number: number }>(ctx.db, 'SELECT number FROM deployments WHERE id = ?', release)?.number}` : 'the new version'} on ${pick.length} server${pick.length === 1 ? '' : 's'}.`, { severity: 'success', resource: svc.id, data: { serviceId: svc.id } });
  else ctx.emit('fleet.stopped', r.status === 'cancelled' ? `The rollout of ${svc.name} was cancelled${r.undone.length ? `; ${r.undone.length} server${r.undone.length === 1 ? ' is' : 's are'} back on the version before` : ''}.`
    : `The rollout of ${svc.name} stopped${failedName ? ` at ${failedName}` : ''}: ${r.error}${r.undone.length ? ` Unit7 put ${r.undone.length} server${r.undone.length === 1 ? '' : 's'} back on the version before.` : ''}`, { severity: 'warning', resource: svc.id, data: { serviceId: svc.id } });
  const out = { status, servers: pick.length, batch, lanes, ...(r.error && { error: r.error }), ...(failedName && { failedAt: failedName }), undone: r.undone.length };
  if (r.status === 'failed') throw new Unit7Error('rollout_failed', `The rollout stopped${failedName ? ` at ${failedName}` : ''}: ${r.error}${r.undone.length ? ` Unit7 put the ${r.undone.length} server${r.undone.length === 1 ? '' : 's'} already done back on the version before, so they all match again.` : ' Nothing else had changed.'}`, 502);
  return out;
}
const STEP_WORDS: Record<StepKey, string> = { image: 'getting the image', start: 'starting the new version', check: 'checking it', switch: 'switching visitors to it', done: 'done' };

// deployment.create on a fleet app: the main server is done; bring the rest along (stop and undo everything on a failure)
export async function followFleet(ctx: Ctx, serviceId: string, r: { deploymentId: string; previousDeploymentId?: string }) {
  const svc = get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ?', serviceId);
  // an app on one server, or the build step of a rollout already going (it handles the rest itself), or a canary's deploy
  // (the others follow once it's promoted: src/fleet/canary.ts)
  if (!svc || targetsOf(ctx.db, svc).length < 2 || activeRun(ctx.db, svc.id)) return undefined;
  if (get(ctx.db, `SELECT 1 FROM canaries WHERE service_id = ? AND status IN ('starting', 'running', 'held')`, svc.id)) return undefined;
  return fleetDeploy(ctx, svc, { primaryDone: r });
}
