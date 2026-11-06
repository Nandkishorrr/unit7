// Many servers (src/fleet): is the app ready for a second server, put it there, roll releases across them, and spread
// visitors with a sick server taken out. Everything goes through the gate; skipping the readiness checks is people-only.
import { z } from 'zod';
import { all, get, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { fid } from './helpers.ts';
import { serverRow } from './servers.ts';
import { proxyFor } from '../deploy/caddy.ts';
import { removeCopies, containerName, type ServiceRow } from '../deploy/deployer.ts';
import { isTestHost } from '../care/readiness.ts';
import { fleetReadiness } from '../fleet/readiness.ts';
import { drift, fleetOf, fleetServices, setTarget, shares, targetsOf } from '../fleet/model.ts';
import { activeRun, control, fleetDeploy, lastRun, runView } from '../fleet/rolling.ts';
import { activeCanary, canaryControl, canaryRefusal, canaryView, lastCanary, startCanary, CANARY_WORD } from '../fleet/canary.ts';
import { connectServers } from '../fleet/network.ts';
import { EDGE_PORTS, applyDns, dnsFor, rotate, routeFront, syncEdge, trafficView } from '../fleet/traffic.ts';

const DBS = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
function svcRow(ctx: Ctx, serviceId: string): ServiceRow {
  const svc = get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  if (!svc) throw new Unit7Error('not_found', 'That app was not found.', 404);
  return svc;
}

// the words, the first time each one shows up
export const FLEET_WORDS = {
  rolling: 'Rolling: servers update one at a time, so the others keep serving while each one changes.',
  rotation: 'In rotation: the servers that get visitors right now.',
  front: 'Front proxy: one server takes every visitor and passes each one to a healthy server.',
};

// --- which way to spread visitors -------------------------------------------------------------------------------------------
async function chooseMode(ctx: Ctx, svc: ServiceRow, want: 'front' | 'dns' | undefined, mainName: string) {
  const own = all<{ hostname: string }>(ctx.db, 'SELECT hostname FROM domains WHERE service_id = ? AND org_id = ?', svc.id, ctx.orgId).map((d) => d.hostname).filter((h) => !isTestHost(h) && !h.startsWith('*.'));
  const cloudflare = !!get(ctx.db, `SELECT 1 FROM accounts WHERE org_id = ? AND provider = 'cloudflare'`, ctx.orgId);
  const paid = cloudflare ? ' Cloudflare’s Load Balancing can also do this, as a paid add-on: Unit7 never buys it for you.' : '';
  if (want === 'dns') {
    if (!own.length) throw new Unit7Error('no_domain', `Spreading visitors with DNS needs a domain of ${svc.name}’s own. Connect one first, or keep the front proxy.`, 409);
    if (!(await dnsFor(ctx, own[0]!))) throw new Unit7Error('dns_unavailable', `Unit7 can’t edit ${own[0]}’s DNS. Connect the account that runs it (Cloudflare is free), or keep the front proxy.`, 409);
    return { mode: 'dns' as const, why: `Each server gets its own address in ${own[0]}’s DNS, and Unit7 takes out a server that stops answering (within about a minute) and puts it back when it recovers. There’s no single front server.${paid}` };
  }
  return { mode: 'front' as const, why: `${mainName} takes every visitor and passes each one to a healthy server over a private network that only your servers can use. Your domain and HTTPS stay as they are, and a server that stops answering is skipped within seconds.${paid}` };
}

function nextEdgePort(ctx: Ctx) {
  const max = get<{ p: number | null }>(ctx.db, 'SELECT max(edge_port) p FROM fleets WHERE org_id = ?', ctx.orgId)?.p ?? EDGE_PORTS[0] - 1;
  if (max + 1 > EDGE_PORTS[1]) throw new Unit7Error('too_many', `Unit7 runs up to ${EDGE_PORTS[1] - EDGE_PORTS[0] + 1} apps on several servers per organisation for now.`, 409);
  return max + 1;
}

// --- reads ------------------------------------------------------------------------------------------------------------------
defineTool({
  name: 'fleet.readiness', title: 'Is an app ready for several servers', risk: 'read', action: 'read',
  description: 'What would break if this app ran on more than one server, from what Unit7 saw (the code at the last deploy, the server’s X-ray, its settings and databases): files saved on the server, a SQLite file, logins kept in memory, scheduled jobs, a database only its own server can reach, a health page. Each open item has its fix.',
  input: z.object({ serviceId: fid('svc') }),
  run: (ctx, i) => fleetReadiness(ctx.db, ctx.orgId, svcRow(ctx, i.serviceId)),
});

defineTool({
  name: 'fleet.get', title: 'An app’s servers', risk: 'read', action: 'read',
  description: 'Every server an app runs on (its main one first): the version each runs, health, whether it takes visitors and its share, whether they all run the same version, how visitors are spread and why, the rollout going on (or the last one), and the prepared servers it could also run on.',
  input: z.object({ serviceId: fid('svc') }),
  run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const ts = targetsOf(ctx.db, svc);
    const share = shares(ts);
    const f = fleetOf(ctx.db, svc.id);
    const r = fleetReadiness(ctx.db, ctx.orgId, svc);
    return {
      serviceId: svc.id, name: svc.name, kind: svc.kind, deployed: !!svc.current_deployment_id, many: ts.length > 1,
      mode: ts.length > 1 ? f?.mode ?? 'front' : 'single', why: ts.length > 1 ? f?.why ?? null : null,
      servers: ts.map((t) => ({ serverId: t.serverId, name: t.name, host: t.host, status: t.status, primary: t.primary, role: t.role, state: t.state, health: t.health, checkedAt: t.checkedAt, version: t.number, share: share[t.serverId] ?? 0, private: !!t.address })),
      drift: drift(ts),
      // D3: the new version being tried on some visitors (or the last try), and whether this app can have one
      canary: canaryView(ctx.db, activeCanary(ctx.db, svc.id) ?? lastCanary(ctx.db, svc.id)), canaryWhyNot: canaryRefusal(ctx.db, svc) ?? null,
      run: runView(activeRun(ctx.db, svc.id) ?? lastRun(ctx.db, svc.id)) ?? null,
      readiness: { done: r.done, total: r.total, ready: r.ready },
      candidates: all<{ id: string; name: string; status: string; host: string }>(ctx.db, `SELECT id, name, status, host FROM servers WHERE org_id = ? AND status IN ('ready', 'connected', 'new') ORDER BY name`, ctx.orgId)
        .filter((s) => !ts.some((t) => t.serverId === s.id)).map((s) => ({ serverId: s.id, name: s.name, ready: s.status === 'ready' })),
      words: FLEET_WORDS,
    };
  },
});

defineTool({
  name: 'fleet.traffic', title: 'Visitors across servers', risk: 'read', action: 'read',
  description: 'How visitors are spread across an app’s servers: each server’s share, health and whether it’s in rotation, and the way they’re spread (front proxy or DNS) with why. Without serviceId: every app that runs on more than one server (the Map draws these).',
  input: z.object({ serviceId: fid('svc').optional() }),
  async run(ctx, i) {
    if (i.serviceId) return trafficView(ctx.db, svcRow(ctx, i.serviceId));
    const { assetIdOf } = await import('../archive.ts');
    // the Map's ids for the app and its servers (what the last sync stored), so it can draw the fan without guessing
    const mapId = (extId: string) => get<{ id: string }>(ctx.db, `SELECT id FROM assets WHERE org_id = ? AND provider = 'unit7' AND ext_id = ?`, ctx.orgId, extId)?.id ?? assetIdOf(ctx.orgId, `unit7:${extId}`);
    return {
      fleets: fleetServices(ctx.db, ctx.orgId).map((svc) => {
        const v = trafficView(ctx.db, svc);
        return { ...v, assetId: mapId(svc.id), servers: v.servers.map((s) => ({ ...s, assetId: mapId(s.serverId) })) };
      }).filter((v) => v.servers.some((s) => !s.primary && s.role !== 'standby')), // a warm standby alone isn't a spread of visitors
    };
  },
});

// --- the rollout ------------------------------------------------------------------------------------------------------------
defineTool({
  name: 'fleet.deploy', title: 'Roll a release across servers', risk: 'write', action: 'deploy', timeoutMs: 3 * 3600_000,
  description: 'Deploy an app to all its servers, one at a time (batch: how many at once). The main server builds it through the normal deploy (with all its checks); the same image then goes to each other server, which starts it beside its old version, checks it and switches. The first failure stops the rollout and puts the servers already done back on the version before. servers: only these (without the main server, they are brought to the version the main one runs: "bring them together"). Pause, continue or cancel with fleet.control.',
  input: z.object({ serviceId: fid('svc'), batch: z.number().int().min(1).max(5).default(1), servers: z.array(fid('srv')).max(20).optional() }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    for (const s of i.servers ?? []) serverRow(ctx, s); // each one this organisation's
    return fleetDeploy(ctx, svc, { batch: i.batch, servers: i.servers });
  },
});

defineTool({
  name: 'fleet.control', title: 'Pause, continue or cancel a rollout', risk: 'write', action: 'deploy',
  description: 'The rollout going on for this app: pause (the server updating now finishes, the next waits), continue, or cancel (stops and puts every server already done back on the version before).',
  input: z.object({ serviceId: fid('svc'), action: z.enum(['pause', 'continue', 'cancel']) }),
  run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const r = control(ctx.db, svc.id, i.action);
    ctx.emit('fleet.control', `${ctx.actor.name} ${i.action === 'pause' ? 'paused' : i.action === 'continue' ? 'continued' : 'cancelled'} the rollout of ${svc.name}.`, { resource: svc.id, data: { serviceId: svc.id } });
    return r;
  },
});

// --- servers in and out of the app --------------------------------------------------------------------------------------------
defineTool({
  // a second server runs the app with its secrets: like deploying to another server, an AI asks first in production
  name: 'fleet.add_server', title: 'Run an app on one more server', risk: 'destructive', action: 'deploy', timeoutMs: 2 * 3600_000,
  peopleOnly: (i) => !!i.skipChecks,
  description: 'Run an app on another server too. Checks it’s ready for several servers first (fleet.readiness; skipping that is people-only), prepares the server if it isn’t yet, joins it to a private network with the others, deploys the version the app runs now, and starts sending it visitors (front proxy by default; mode dns spreads them with DNS when Unit7 can edit the domain’s DNS). Undo: fleet.remove_server. Buying a new server is a person’s job.',
  input: z.object({ serviceId: fid('svc'), serverId: fid('srv'), mode: z.enum(['front', 'dns']).optional(), skipChecks: z.boolean().optional().describe('People only: add it although the readiness checks found something') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    if (DBS.includes(svc.kind)) throw new Unit7Error('not_an_app', `${svc.name} is a database. Databases don’t run on several servers this way; give the app one database every server can reach.`, 400);
    if (!svc.server_id || !svc.current_deployment_id) throw new Unit7Error('not_deployed', `${svc.name} isn’t running yet. Deploy it first.`, 409);
    if (i.serverId === svc.server_id) throw new Unit7Error('already', `${svc.name} already runs on that server (it’s the main one).`, 409);
    const ts = targetsOf(ctx.db, svc);
    if (ts.some((t) => t.serverId === i.serverId)) throw new Unit7Error('already', `${svc.name} already runs on that server.`, 409);
    if (activeRun(ctx.db, svc.id)) throw new Unit7Error('busy', `A rollout of ${svc.name} is going. Wait for it, or cancel it.`, 409);
    const main = serverRow(ctx, svc.server_id);
    // D6: on a Coolify server, Coolify's own proxy holds the web ports, so Unit7's front proxy can't sit there. An app made in
    // Coolify runs on more servers through Coolify itself (coolify.add_server); a Unit7 app on that server can't yet.
    if (proxyFor(main).kind !== 'caddy') throw new Unit7Error('unsupported', proxyFor(main).kind === 'coolify'
      ? `${main.name}’s web traffic goes through Coolify’s proxy, so Unit7 can’t put its own front proxy there and spread ${svc.name} across servers. Apps made in Coolify can run on more servers through Coolify itself; for ${svc.name}, move it to a server without Coolify first.`
      : `${main.name}’s web traffic goes through another program, so Unit7 can’t spread ${svc.name} across servers from there.`, 409);
    const ready = fleetReadiness(ctx.db, ctx.orgId, svc);
    if (!ready.ready && !i.skipChecks) {
      const left = ready.checks.filter((c) => !c.ok);
      throw new Unit7Error('not_ready', `${svc.name} isn’t ready for a second server yet (${ready.done} of ${ready.total}): ${left.map((c) => c.detail).join(' ')} Fix ${left.length === 1 ? 'it' : 'them'} first (each has a fix on the app’s page), or a person can add the server anyway.`, 409);
    }
    let s = serverRow(ctx, i.serverId);
    if (s.status !== 'ready') {
      ctx.progress(`Preparing ${s.name} first…`);
      const b = await execute(ctx.app, ctx.orgId, ctx.actor, 'server.bootstrap', { serverId: s.id }, { reason: `preparing it to run ${svc.name}`, signal: ctx.signal, onProgress: ctx.progress, ...(ctx.approvalId && { underApproval: ctx.approvalId }) });
      if (b.status !== 'ok') throw new Unit7Error('server_not_ready', `${s.name} couldn’t be prepared: ${b.status === 'error' ? b.error.message : 'why' in b ? b.why : b.status}`, 409);
      s = serverRow(ctx, i.serverId);
    }
    const had = fleetOf(ctx.db, svc.id);
    const { mode, why } = had && !i.mode ? { mode: had.mode, why: had.why ?? '' } : await chooseMode(ctx, svc, i.mode, main.name);
    run(ctx.db, `INSERT INTO fleets (service_id, org_id, mode, why, edge_port) VALUES (?, ?, ?, ?, ?) ON CONFLICT (service_id) DO UPDATE SET mode = excluded.mode, why = excluded.why, edge_port = coalesce(fleets.edge_port, excluded.edge_port)`,
      svc.id, ctx.orgId, mode, why, had?.edge_port ?? nextEdgePort(ctx));
    setTarget(ctx.db, ctx.orgId, svc.id, main.id, { role: 'primary', deploymentId: svc.current_deployment_id });
    setTarget(ctx.db, ctx.orgId, svc.id, s.id, { role: 'replica', state: 'in', deploymentId: null });
    try {
      if (mode === 'front') await connectServers(ctx, [main, ...ts.filter((t) => !t.primary).map((t) => serverRow(ctx, t.serverId)), s], ctx.progress);
      await fleetDeploy(ctx, svc, { servers: [s.id] });
    } catch (e) {
      // it never joined: off the list again, and nothing of the app left running there
      run(ctx.db, 'DELETE FROM service_targets WHERE service_id = ? AND server_id = ?', svc.id, s.id);
      if (ts.length < 2) run(ctx.db, 'DELETE FROM service_targets WHERE service_id = ?', svc.id);
      throw e;
    }
    const n = targetsOf(ctx.db, svc).length;
    ctx.emit('fleet.added', `${svc.name} now runs on ${n} servers: ${s.name} joined.`, { severity: 'success', resource: svc.id, data: { serviceId: svc.id, serverId: s.id } });
    return { added: s.name, servers: n, mode, why, words: FLEET_WORDS, undo: { tool: 'fleet.remove_server', input: { serviceId: svc.id, serverId: s.id }, label: `Take ${svc.name} off ${s.name}` } };
  },
});

defineTool({
  name: 'fleet.remove_server', title: 'Stop running an app on a server', risk: 'write', action: 'deploy', timeoutMs: 10 * 60_000,
  description: 'Take an app off one of its servers (not the main one): it leaves rotation first and the requests in flight finish, then its copies there are removed. Undo: fleet.add_server.',
  input: z.object({ serviceId: fid('svc'), serverId: fid('srv') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const s = serverRow(ctx, i.serverId);
    if (i.serverId === svc.server_id) throw new Unit7Error('main_server', `${s.name} is ${svc.name}’s main server: it builds the app and holds its front door, so it stays.`, 409);
    if (activeRun(ctx.db, svc.id)) throw new Unit7Error('busy', `A rollout of ${svc.name} is going. Wait for it, or cancel it.`, 409);
    const ts = targetsOf(ctx.db, svc);
    const t = ts.find((x) => x.serverId === s.id);
    if (!t) throw new Unit7Error('not_in_fleet', `${svc.name} doesn’t run on ${s.name}.`, 404);
    if (t.state === 'in' && t.deploymentId) await rotate(ctx, svc, s.id, true);
    run(ctx.db, 'DELETE FROM service_targets WHERE service_id = ? AND server_id = ?', svc.id, s.id);
    const mode = fleetOf(ctx.db, svc.id)?.mode ?? 'front';
    if (mode === 'front') { await syncEdge(ctx, s).catch(() => undefined); await routeFront(ctx, svc); }
    else await applyDns(ctx, svc).catch(() => undefined);
    if (t.number !== null) await removeCopies(ctx, s, containerName(svc, t.number)).catch(() => undefined);
    // back to one server: the app reads exactly as before
    if (ts.length <= 2) run(ctx.db, 'DELETE FROM service_targets WHERE service_id = ?', svc.id);
    ctx.emit('fleet.removed', `${svc.name} no longer runs on ${s.name}.`, { resource: svc.id, data: { serviceId: svc.id, serverId: s.id } });
    return { removed: s.name, servers: ts.length - 1, undo: { tool: 'fleet.add_server', input: { serviceId: svc.id, serverId: s.id }, label: `Run ${svc.name} on ${s.name} again` } };
  },
});

// --- rotation -----------------------------------------------------------------------------------------------------------------
const wardenActor = (a: Ctx['actor']) => a.kind === 'agent' && a.id === 'warden' && a.userId === null;
defineTool({
  // easy to undo (put it back): Warden does it by itself when a server fails its health checks (DNS mode)
  name: 'fleet.rotate', title: 'Take a server out of rotation, or put it back', risk: 'write', action: 'fleet_rotate', timeoutMs: 3 * 60_000,
  assess: () => ({ tier: 1, impact: 'The server stops (or starts) getting visitors for this app; the others carry on. Requests in flight finish first.' }),
  description: 'out: true takes a server out of rotation for this app (for maintenance: no new visitors, the ones in flight finish, then it’s free for updates or a restart). out: false puts it back. The front server can’t be taken out, nor the last one taking visitors.',
  input: z.object({ serviceId: fid('svc'), serverId: fid('srv'), out: z.boolean() }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    serverRow(ctx, i.serverId);
    const r = await rotate(ctx, svc, i.serverId, i.out, wardenActor(ctx.actor) ? 'health' : 'person');
    return { ...r, ...(r.changed && { undo: { tool: 'fleet.rotate', input: { serviceId: svc.id, serverId: i.serverId, out: !i.out }, label: i.out ? `Put ${r.server} back` : `Take ${r.server} out` } }) };
  },
});

// --- D3: canary releases ----------------------------------------------------------------------------------------------
Object.assign(FLEET_WORDS, { canary: CANARY_WORD });
defineTool({
  name: 'fleet.canary', title: 'Try a new version on some visitors first', risk: 'write', action: 'deploy', timeoutMs: 30 * 60_000,
  description: 'Deploy a new version as a canary: it builds and checks like any deploy (deployment.create, through the gate), then gets only share% of visitors (10 by default) by weight in the main server’s proxy while the old version keeps the rest, on one server (side by side) or with a front proxy across servers. Every look compares its errors and speed with the old version’s over the same minutes; after holdMinutes (5) at a step it moves to the next (steps, by default 10 → 50 → 100), and it rolls back by itself when the new one is clearly worse. Controls: fleet.canary_control. Not with DNS spreading (DNS can’t split visitors precisely).',
  input: z.object({ serviceId: fid('svc'), share: z.number().int().min(1).max(50).default(10), steps: z.array(z.number().int().min(1).max(100)).max(6).optional(), holdMinutes: z.number().int().min(1).max(120).default(5) }),
  run: (ctx, i) => startCanary(ctx, svcRow(ctx, i.serviceId), { share: i.share, steps: i.steps, holdMinutes: i.holdMinutes }),
});

defineTool({
  name: 'fleet.canary_control', title: 'Promote, hold or roll back a canary', risk: 'write', action: (i) => (i.action === 'rollback' ? 'rollback' : 'deploy'), timeoutMs: 3 * 3600_000,
  description: 'The new version being tried on some visitors: promote (all visitors now; on several servers the others follow one at a time), hold (stay at this share; it still rolls back by itself if it gets clearly worse), resume, next (the next step), share (set it, 1–100), rollback (every visitor back on the old version).',
  input: z.object({ serviceId: fid('svc'), action: z.enum(['promote', 'hold', 'resume', 'rollback', 'next', 'share']), share: z.number().int().min(1).max(100).optional(), reason: z.string().max(300).optional() }),
  run: (ctx, i) => canaryControl(ctx, svcRow(ctx, i.serviceId), i.action, { share: i.share, ...(i.reason && { reason: i.reason }) }),
});

// --- D4: fleet care -----------------------------------------------------------------------------------------------------
defineTool({
  name: 'fleet.care', title: 'Keeping an app’s servers alike', risk: 'read', action: 'read', timeoutMs: 120_000,
  description: 'Whether every server of an app runs the same version and the same settings (a fingerprint of each server’s settings file, worked out on the server: no value leaves it), how HTTPS certificates are shared, and each server’s restart window (restarts go one server at a time, out of rotation first).',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const ts = targetsOf(ctx.db, svc);
    const { readEnvDrift, certPlan, hasDnsPlugin, restartWouldDown } = await import('../fleet/care.ts');
    const { rebootView } = await import('./reboot.ts');
    const f = fleetOf(ctx.db, svc.id);
    const mode = ts.length > 1 ? f?.mode ?? 'front' : 'single';
    const cloudflare = !!get(ctx.db, `SELECT 1 FROM accounts WHERE org_id = ? AND provider = 'cloudflare'`, ctx.orgId);
    const standby = ts.some((t) => t.role === 'standby');
    const plugin = mode === 'dns' && cloudflare ? (await Promise.all(ts.map((t) => hasDnsPlugin(ctx, serverRow(ctx, t.serverId))))).every(Boolean) : false;
    return {
      serviceId: svc.id, name: svc.name, mode, versions: drift(ts), settings: await readEnvDrift(ctx, svc),
      certs: certPlan({ mode, cloudflare, dnsPlugin: plugin, standby }),
      restarts: ts.map((t) => { const v = rebootView(ctx.db, serverRow(ctx, t.serverId)); const waits = restartWouldDown(ctx.db, t.serverId); return { serverId: t.serverId, name: t.name, window: v.words, needsRestart: v.needsRestart, lastRestart: v.lastRestart, lastResult: v.lastResult, ...(waits.length && { waits: `Waits while it’s the only server serving ${waits.join(', ')}` }) }; }),
      oneAtATime: 'Servers restart one at a time, each out of rotation first, so the others keep serving.',
    };
  },
});

defineTool({
  name: 'fleet.sync_settings', title: 'Give every server the current settings', risk: 'write', action: 'deploy', timeoutMs: 3 * 3600_000,
  description: 'Bring an app’s servers onto its current settings without visitors noticing: a server behind is taken out of rotation, its copies restart with the settings written fresh, are checked, and go back in, one at a time. When the main server is behind, a normal rolling release (fleet.deploy) does it everywhere.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    if (activeRun(ctx.db, svc.id)) throw new Unit7Error('busy', `A rollout of ${svc.name} is going. Wait for it, or cancel it.`, 409);
    const { readEnvDrift, refreshServer } = await import('../fleet/care.ts');
    const d = await readEnvDrift(ctx, svc);
    if (d.same) return { same: true, words: 'Every server already runs with the current settings.' };
    const main = targetsOf(ctx.db, svc).find((t) => t.primary)!;
    if (d.differs.includes(main.serverId)) return { via: 'release', release: await fleetDeploy(ctx, svc, {}) };
    const done: string[] = [];
    for (const sid of d.differs) { ctx.progress(`New settings for ${targetsOf(ctx.db, svc).find((t) => t.serverId === sid)?.name ?? 'a server'}…`); done.push((await refreshServer(ctx, svc, sid)).server); }
    ctx.emit('fleet.synced', `${svc.name}: ${done.join(', ')} now ${done.length === 1 ? 'runs' : 'run'} with the current settings.`, { severity: 'success', resource: svc.id, data: { serviceId: svc.id } });
    return { via: 'restart', servers: done, ...(d.unknown.length && { unread: d.unknown.length }) };
  },
});

defineTool({
  name: 'fleet.server_offers', title: 'Servers you could add', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'Plans you could buy to run an app on one more server, from the Hetzner and Hostinger accounts connected: the cheapest ones at least as big as its main server, on the same kind of processor, with their monthly price. Read-only: buying is fleet.buy_server, a person’s own decision.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const { hetznerOffers, mainFacts, usableAccount } = await import('../fleet/care.ts');
    const facts = mainFacts(ctx.db, svc);
    const offers = [];
    const problems: string[] = [];
    for (const a of usableAccount(ctx.db, ctx.orgId, 'hetzner')) offers.push(...await hetznerOffers(ctx, a.id, facts).catch((e: Error) => { problems.push(`Hetzner (${a.name}): ${e.message.slice(0, 120)}`); return []; }));
    const hostinger = usableAccount(ctx.db, ctx.orgId, 'hostinger').map((a) => ({ accountId: a.id, name: a.name }));
    return { offers, hostinger, ...(problems.length && { problems }), note: 'Unit7 never buys anything by itself: a person chooses, approves the price, and Unit7 does the rest.',
      ...(!offers.length && !hostinger.length && { next: 'Connect Hetzner or Hostinger (Connections) to buy a server in one click, or connect one you already have on Servers.' }) };
  },
});

defineTool({
  name: 'fleet.buy_server', title: 'Buy a server for an app', risk: 'destructive', action: 'provider_purchase', peopleOnly: true, timeoutMs: 2 * 3600_000,
  description: 'People only: buy one more server for an app (Hetzner: plan + location from fleet.server_offers; Hostinger: item, templateId and dataCenterId), with Unit7’s own key put in at creation, then connect it, prepare it and add it to the app (fleet.add_server). It costs money every month until it’s deleted at the provider.',
  input: z.object({
    serviceId: fid('svc'), provider: z.enum(['hetzner', 'hostinger']), accountId: fid('acc'),
    plan: z.string().regex(/^[a-z0-9-]{2,30}$/).optional(), location: z.string().regex(/^[a-z0-9-]{2,30}$/).optional(),
    // not itemId: anything named *Id must be one of Unit7's own ids, so Hostinger's would be refused at the gate
    item: z.string().regex(/^[\w.-]{3,120}$/).optional(), templateId: z.number().int().positive().optional(), dataCenterId: z.number().int().positive().optional(),
  }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    if (!get(ctx.db, 'SELECT 1 FROM accounts WHERE id = ? AND org_id = ? AND provider = ?', i.accountId, ctx.orgId, i.provider)) throw new Unit7Error('not_found', `That ${i.provider === 'hetzner' ? 'Hetzner' : 'Hostinger'} account isn’t connected.`, 404);
    const care = await import('../fleet/care.ts');
    const name = care.newServerName(svc, targetsOf(ctx.db, svc).length);
    const b = await care.buyAndConnect(ctx, i, { name, forWhat: svc.name, resource: svc.id, data: { serviceId: svc.id } });
    if (!b.serverId) return { bought: name, host: b.host, added: false, why: b.why };
    const { serverId } = b;
    const add = await execute(ctx.app, ctx.orgId, ctx.actor, 'fleet.add_server', { serviceId: svc.id, serverId }, { reason: 'the server bought for it', signal: ctx.signal, onProgress: ctx.progress });
    if (add.status !== 'ok') return { bought: name, serverId, added: false, why: add.status === 'error' ? add.error.message : 'why' in add ? add.why : add.status };
    return { bought: name, serverId, added: true, ...(add.output as object) };
  },
});

// --- D5: regions (light) -----------------------------------------------------------------------------------------------
defineTool({
  name: 'fleet.regions', title: 'Where visitors come from', risk: 'read', action: 'read', timeoutMs: 90_000,
  description: 'Where an app’s visitors come from (country counts from the proxy’s log when Cloudflare is in front, else Cloudflare’s analytics, else unknown) and its servers by region with their share of visitors and how fast they answer. Plus guidance for database read copies (Neon, Supabase, RDS); Unit7 doesn’t set those up yet.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) { const { regionsFor } = await import('../fleet/regions.ts'); return regionsFor(ctx, svcRow(ctx, i.serviceId)); },
});

defineTool({
  name: 'fleet.label_region', title: 'Say where a server is', risk: 'write', action: 'server_label',
  description: 'Label a server with its region (for example "Frankfurt" or "US East"), shown with the app’s visitors by region. Only a label: nothing on the server changes.',
  input: z.object({ serverId: fid('srv'), region: z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N} ,.()'-]+$/u) }),
  run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    run(ctx.db, `UPDATE servers SET facts = json_set(facts, '$.region', ?) WHERE id = ?`, i.region, s.id);
    return { server: s.name, region: i.region };
  },
});
