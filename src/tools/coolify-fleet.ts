// Coolify fleets (src/fleet/coolify.ts): an app made in Coolify, on more servers, through Coolify's own feature. Add-only
// next to tools/coolify.ts: the same token, the same `need` check, Coolify stays in charge of what it runs.
import { z } from 'zod';
import { all } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { defineTool } from './runtime.ts';
import { fid } from './helpers.ts';
import { serverRow } from './servers.ts';
import { need } from './coolify.ts';
import { waitDeployment } from '../connectors/coolify.ts';
import { destinationOn, readCoolifyFleet } from '../fleet/coolify.ts';

const UUID = z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/, 'a Coolify uuid');
const enc = encodeURIComponent;
const TRAFFIC = 'Coolify runs the app on each server but doesn’t spread visitors between them: give the domain an address for each server (DNS), or put a load balancer in front.';
// Coolify's servers by address → Unit7's own names for them, where Unit7 knows the server too
const unit7Names = (ctx: Parameters<typeof need>[0]) => new Map(all<{ host: string; name: string }>(ctx.db, 'SELECT host, name FROM servers WHERE org_id = ?', ctx.orgId).map((s) => [s.host, s.name]));

defineTool({
  name: 'coolify.servers', title: 'Servers a Coolify app runs on', risk: 'read', action: 'read', timeoutMs: 90_000,
  description: 'Every server a Coolify application runs on (its main one and the extra ones Coolify deploys to), each server’s last deploy as a release lane, the servers it could also run on, and what stops it from running on more (Docker Compose, files in a volume, no registry image), in plain words.',
  input: z.object({ serverId: fid('srv'), uuid: UUID }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const f = await readCoolifyFleet(need(ctx, s).api, i.uuid);
    const names = unit7Names(ctx);
    return { ...f, servers: f.servers.map((x) => ({ ...x, unit7Name: (x.ip && names.get(String(x.ip))) || undefined })), traffic: TRAFFIC };
  },
});

defineTool({
  // like Unit7's own fleet.add_server: the app starts on another server with its settings, so an AI asks first
  name: 'coolify.add_server', title: 'Run a Coolify app on one more server', risk: 'destructive', action: 'deploy', timeoutMs: 25 * 60_000,
  description: 'Add one of Coolify’s other servers to a Coolify application (to: that server’s Coolify uuid, from coolify.servers), then deploy so it runs there too: the main server builds and pushes the registry image, the others pull it. Refused, in plain words, where Coolify can’t (Docker Compose, persistent storage, no registry image, another proxy). Undo: coolify.remove_server.',
  input: z.object({ serverId: fid('srv'), uuid: UUID, to: UUID, deploy: z.boolean().default(true) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const { api } = need(ctx, s);
    const f = await readCoolifyFleet(api, i.uuid);
    if (f.refusal) throw new Unit7Error('coolify_refuses', `${f.app.name} can’t run on more servers yet: ${f.refusal.reason}${f.refusal.fix ? ` ${f.refusal.fix}` : ''}`, 409);
    if (f.servers.some((x) => x.serverUuid === i.to)) throw new Unit7Error('already', `${f.app.name} already runs on that server.`, 409);
    const d = await destinationOn(api, i.to);
    ctx.progress(`Adding ${d.name} to ${f.app.name} in Coolify…`);
    await api.call('POST', `/applications/${enc(i.uuid)}/destinations`, { destination_uuid: d.uuid }); // Coolify says why when it refuses (another proxy, the same server)
    const target = f.candidates.find((c) => c.uuid === i.to)?.name ?? 'the server';
    ctx.emit('coolify.server_added', `${f.app.name} now runs on ${target} too (through Coolify).`, { severity: 'success', resource: s.id, data: { uuid: i.uuid } });
    let deployed: { status: string } | undefined;
    if (i.deploy) {
      ctx.progress('Deploying it everywhere through Coolify…');
      const r = await api.call('POST', `/deploy?uuid=${enc(i.uuid)}&force=false`);
      const dep: string | undefined = r?.deployment_uuid ?? r?.deployments?.[0]?.deployment_uuid;
      if (dep) deployed = await waitDeployment(api, dep, (m) => ctx.progress(m), ctx.signal);
    }
    const after = await readCoolifyFleet(api, i.uuid);
    return { added: target, lanes: after.lanes, ...(deployed && { deploy: deployed.status }), traffic: TRAFFIC,
      undo: { tool: 'coolify.remove_server', input: { serverId: i.serverId, uuid: i.uuid, destination: d.uuid }, label: `Stop running ${f.app.name} on ${target}` } };
  },
});

defineTool({
  name: 'coolify.remove_server', title: 'Stop running a Coolify app on a server', risk: 'write', action: 'deploy', timeoutMs: 120_000,
  description: 'Take one of a Coolify application’s extra servers off it (destination: from coolify.servers): Coolify stops deploying there. Its main server stays. Undo: coolify.add_server.',
  input: z.object({ serverId: fid('srv'), uuid: UUID, destination: UUID }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const { api } = need(ctx, s);
    const f = await readCoolifyFleet(api, i.uuid);
    const d = f.servers.find((x) => x.uuid === i.destination);
    if (!d) throw new Unit7Error('not_found', `${f.app.name} doesn’t run there.`, 404);
    if (d.primary) throw new Unit7Error('main_server', `That’s ${f.app.name}’s main server in Coolify: it builds the app, so it stays.`, 409);
    await api.call('DELETE', `/applications/${enc(i.uuid)}/destinations/${enc(i.destination)}`);
    ctx.emit('coolify.server_removed', `${f.app.name} no longer gets deploys on ${d.server} (through Coolify).`, { resource: s.id, data: { uuid: i.uuid } });
    return { removed: d.server, note: 'Coolify stops deploying there. Its copy there may keep running until you stop it in Coolify.', undo: { tool: 'coolify.add_server', input: { serverId: i.serverId, uuid: i.uuid, to: d.serverUuid }, label: `Run ${f.app.name} on ${d.server} again` } };
  },
});
