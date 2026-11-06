// A warm standby for an app on a second server (src/fleet/dr.ts): set it up, see the promise, refresh its data, switch
// visitors to it (and back), and drill it. Switching is a person's one tap; Warden does it by itself only at "Production
// autonomy" or higher when the main server has been down 5 minutes or more (and says so on the phone); any other AI asks.
import { z } from 'zod';
import { get } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { fid, requireHuman } from './helpers.ts';
import { serverRow } from './servers.ts';
import { proxyFor } from '../deploy/caddy.ts';
import type { ServiceRow } from '../deploy/deployer.ts';
import { targetsOf } from '../fleet/model.ts';
import { activeRun } from '../fleet/rolling.ts';
import { autoFailoverOk, drOf, drill, drView, failover, refreshStandby, removeStandby, setupStandby, standbyDbs, switchBack, DR_HOURS } from '../fleet/dr.ts';

const svcRow = (ctx: Ctx, serviceId: string) => {
  const svc = get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  if (!svc) throw new Unit7Error('not_found', 'That app was not found.', 404);
  return svc;
};
const rowOf = (ctx: Ctx, svc: ServiceRow) => {
  const r = drOf(ctx.db, svc.id);
  if (!r) throw new Unit7Error('no_standby', `${svc.name} has no standby. Set one up first (dr.setup).`, 404);
  return r;
};
const DBS = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
const wardenActor = (a: Ctx['actor']) => a.kind === 'agent' && a.id === 'warden' && a.userId === null;

defineTool({
  // like running the app on another server: it starts there with its secrets and a copy of its data, so an AI asks first
  name: 'dr.setup', title: 'Keep a warm standby of an app', risk: 'destructive', action: 'deploy', timeoutMs: 3 * 3600_000,
  description: 'A warm copy of an app on a second server, ready to take over if its server dies: out of rotation (no visitors), on the same version (every release reaches it), its databases copied there under the same names and refreshed from a fresh backup every `hours` (6), and the main server’s HTTPS certificate copied. Undo: dr.remove.',
  input: z.object({ serviceId: fid('svc'), serverId: fid('srv'), hours: z.number().int().min(1).max(48).default(DR_HOURS) }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    if (DBS.includes(svc.kind)) throw new Unit7Error('not_an_app', `${svc.name} is a database: its app’s standby carries a copy of it.`, 400);
    if (svc.kind === 'worker') throw new Unit7Error('not_an_app', `${svc.name} works in the background with no visitors; set up the standby on its app.`, 400);
    if (!svc.server_id || !svc.current_deployment_id) throw new Unit7Error('not_deployed', `${svc.name} isn’t running yet. Deploy it first.`, 409);
    if (i.serverId === svc.server_id) throw new Unit7Error('same_server', 'The standby has to be on another server: on the same one it goes down with it.', 400);
    const main = serverRow(ctx, svc.server_id);
    if (proxyFor(main).kind !== 'caddy') throw new Unit7Error('unsupported', `${main.name}’s web traffic goes through ${proxyFor(main).kind === 'coolify' ? 'Coolify’s proxy' : 'another program'}, so Unit7 can’t keep a standby of ${svc.name} from there yet.`, 409);
    const had = drOf(ctx.db, svc.id);
    if (had && had.status !== 'failed') throw new Unit7Error('already', `${svc.name} already keeps a standby on ${serverRow(ctx, had.server_id).name}.`, 409);
    if (targetsOf(ctx.db, svc).some((t) => t.serverId === i.serverId && t.role !== 'standby')) throw new Unit7Error('already', `${svc.name} already runs on that server and takes visitors there.`, 409);
    if (activeRun(ctx.db, svc.id)) throw new Unit7Error('busy', `A rollout of ${svc.name} is going. Wait for it, or cancel it.`, 409);
    const { refusal } = standbyDbs(ctx.db, svc);
    if (refusal) throw new Unit7Error('unsupported', refusal, 409);
    let s = serverRow(ctx, i.serverId);
    if (s.status !== 'ready') {
      ctx.progress(`Preparing ${s.name} first…`);
      const b = await execute(ctx.app, ctx.orgId, ctx.actor, 'server.bootstrap', { serverId: s.id }, { reason: `preparing it for ${svc.name}’s standby`, signal: ctx.signal, onProgress: ctx.progress, ...(ctx.approvalId && { underApproval: ctx.approvalId }) });
      if (b.status !== 'ok') throw new Unit7Error('server_not_ready', `${s.name} couldn’t be prepared: ${b.status === 'error' ? b.error.message : 'why' in b ? b.why : b.status}`, 409);
      s = serverRow(ctx, i.serverId);
    }
    const v = await setupStandby(ctx, svc, s, i.hours);
    return { ...v, undo: { tool: 'dr.remove', input: { serviceId: svc.id }, label: `Stop keeping a standby of ${svc.name}` } };
  },
});

defineTool({
  name: 'dr.status', title: 'An app’s standby and its promise', risk: 'read', action: 'read',
  description: 'The standby of an app: where it is, its version and health, when its data was last copied, the last drill, and the plain promise ("If this server dies, you’re back in about N minutes, losing at most H hours of data") worked out from those.',
  input: z.object({ serviceId: fid('svc') }),
  run: (ctx, i) => drView(ctx, svcRow(ctx, i.serviceId)),
});

defineTool({
  name: 'dr.refresh', title: 'Copy fresh data to the standby', risk: 'write', action: 'backup', timeoutMs: 3 * 3600_000,
  description: 'A fresh backup of each of the app’s databases, copied to its standby and loaded there (Warden does it every few hours by itself). The live databases aren’t changed.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId), r = rowOf(ctx, svc);
    if (r.status !== 'ready') throw new Unit7Error('standby_not_ready', r.status === 'active' ? 'Visitors are on the standby: its data is the live data now.' : 'The standby isn’t ready yet.', 409);
    const x = await refreshStandby(ctx, svc, r);
    return { ...x, ...drView(ctx, svc) };
  },
});

defineTool({
  name: 'dr.failover', title: 'Switch visitors to the standby', risk: 'write', action: 'dr_failover', timeoutMs: 30 * 60_000,
  // a person: one tap. Warden: by itself only at autonomy 3+ with the main server down 5+ minutes. Any other AI: asks.
  assess: (c, i) => (wardenActor(c.actor) && i.auto && autoFailoverOk(c.db, i.serviceId)
    ? { tier: 1, impact: 'Every visitor goes to the warm standby; the main server didn’t answer for 5 minutes.' }
    : { tier: 2, ask: 'Moving every visitor to the standby is a big change, so a person decides (one tap).', impact: 'Every visitor goes to the standby until you switch back. Its data is from the last copy.' }),
  description: 'Move every visitor of an app to its warm standby: the standby takes over the scheduled jobs and the app’s DNS records point at it. back: true switches back (a person only): what the standby collected is copied into the main databases first (after a fresh backup of each), then visitors return; the app is offline for the minutes that copy takes.',
  input: z.object({ serviceId: fid('svc'), back: z.boolean().default(false), auto: z.boolean().default(false).describe('Warden’s own switch when the main server is down') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId), r = rowOf(ctx, svc);
    if (i.back) { requireHuman(ctx, 'switch visitors back from the standby'); return switchBack(ctx, svc, r); }
    return failover(ctx, svc, r, { auto: i.auto && wardenActor(ctx.actor) });
  },
});

defineTool({
  name: 'dr.drill', title: 'Test the standby', risk: 'write', action: 'backup', timeoutMs: 3 * 3600_000,
  description: 'A drill, only when the standby is healthy: fresh data copied to it now, then the app’s real name asked at the standby’s address over HTTPS, the way visitors would reach it after a switch. Real visitors stay where they are (their writes would be lost on the copy). The result and the promise are kept and shown.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) { const svc = svcRow(ctx, i.serviceId); return drill(ctx, svc, rowOf(ctx, svc)); },
});

defineTool({
  name: 'dr.remove', title: 'Stop keeping a standby', risk: 'write', action: 'deploy', timeoutMs: 10 * 60_000,
  description: 'Take an app’s standby down: its copy and its database copies on the standby server go (the live app and data aren’t touched). Undo: dr.setup.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId), r = rowOf(ctx, svc);
    const server = serverRow(ctx, r.server_id).name;
    await removeStandby(ctx, svc, r);
    return { removed: server, undo: { tool: 'dr.setup', input: { serviceId: svc.id, serverId: r.server_id, hours: r.hours }, label: `Keep a standby of ${svc.name} on ${server} again` } };
  },
});
