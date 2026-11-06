// Fly.io: an app and a machine from a ready image, over the Machines API (docs.fly.io/api/machines/openapi.json, 2026-11). Only
// flyctl builds code, not a token, so with no image Unit7 says so: a person brings an image, or copies an app that's already there.
// A copy takes the running app's image and shape, never its settings or volumes (test keys go in with live.env).
import { fly, flyAuth, FLY_API } from '../connectors/hosts.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { accountsOf, addHost, type Host, type Put } from './hosts.ts';
import { parts, send, taken, until, type Sent } from './kit.ts';

const call = async (ctx: Ctx, acc: string, path: string, o: { method?: string; body?: unknown } = {}) => send(`${FLY_API()}${path}`, { ...o, headers: await flyAuth(ctx, acc) });
function refused(what: string, r: Sent) {
  const why = String(r.data?.error ?? r.status);
  if (r.status === 401) return new Unit7Error('provider_refused', 'Fly.io refused this token (unauthorized). Check it in Connections.', 401);
  return new Unit7Error('fly_error', `Fly.io refused to ${what}: ${why}`, r.status === 403 ? 403 : 502);
}

// the shape `fly launch` starts with: small, HTTPS at the edge, asleep until someone visits
const shape = (image: string, port: number, memory = 256) => ({
  image, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: memory },
  services: [{ protocol: 'tcp', internal_port: port, autostart: true, autostop: 'stop', min_machines_running: 0, ports: [{ port: 80, handlers: ['http'], force_https: true }, { port: 443, handlers: ['tls', 'http'] }] }],
});
async function copied(ctx: Ctx, acc: string, from: string) {
  const r = await call(ctx, acc, `/apps/${from}/machines`);
  if (r.status >= 400) throw refused(`read ${from}`, r);
  const c = (r.data as { config?: Record<string, unknown> }[]).find((m) => m.config?.image)?.config;
  if (!c) throw new Unit7Error('nothing_live', `${from} has no machine to copy on this Fly.io account.`, 404);
  const { image, guest, services, init, processes, checks, restart } = c;
  return { image, guest, services, init, processes, checks, restart };
}

async function started(ctx: Ctx, acc: string, app: string, id: string) {
  await until(ctx, 'Fly.io', async () => {
    const m = await call(ctx, acc, `/apps/${app}/machines/${id}`);
    if (m.status >= 400) throw refused('say how the machine is going', m);
    const state = String(m.data.state ?? 'created');
    if (state === 'failed' || state === 'destroyed') throw new Unit7Error('build_failed', `Fly.io couldn’t start the machine: it ${state === 'failed' ? 'failed' : 'was destroyed'}.`, 502, { logTail: (await fly.recentLines(ctx, acc, app, new Date(Date.now() - 600_000)).catch(() => [])).map((l) => l.text).slice(-40).join('\n') });
    return { state, done: state === 'started' ? true : undefined };
  }, 5 * 60_000); // a machine starts in seconds, and one that stopped by itself won't change
}

async function firstApp(ctx: Ctx, acc: string, p: Put) {
  const made = await call(ctx, acc, '/apps', { body: { name: p.name, org_slug: p.team ?? 'personal' } });
  if (made.status === 422 && made.data?.status === 'name_taken') throw new Unit7Error('name_taken', `The name ${p.name} is taken on Fly.io, and names there are shared by everyone. Choose another.`, 409);
  if (made.status >= 400) throw refused('create the app', made);
  // a new app has no address of its own until it's given one; both of these are free
  for (const type of ['shared_v4', 'v6']) { const ip = await call(ctx, acc, `/apps/${p.name}/ip_assignments`, { body: { type } }); if (ip.status >= 400) throw refused('give the app an address', ip); }
}

export const flyHost: Host = addHost({
  id: 'fly', name: 'Fly.io', builds: false, noCode: true, envNow: true,
  sizes: [
    { id: '256mb', label: '256 MB', price: 'About $2.19 a month running all the time. It sleeps with no visitors, so often less.', memoryMb: 256 },
    { id: '512mb', label: '512 MB', price: 'About $3.69 a month running all the time. It sleeps with no visitors, so often less.', memoryMb: 512 },
    { id: '1gb', label: '1 GB', price: 'About $6.70 a month running all the time. It sleeps with no visitors, so often less.', memoryMb: 1024 },
  ],
  costs: 'Fly.io bills each running machine by the second: the smallest is about $2 a month.',
  places: (ctx) => accountsOf(ctx, 'fly', 'fly'),
  fit: (site) => (site.image || site.copyOf
    ? { ok: true, why: 'Fly.io starts a small machine from a ready image.' }
    : { ok: false, why: 'Fly.io can’t build code from an API token: only its own fly command can. Give Unit7 a ready image (image), or copy an app already on Fly.io (copyOf).' }),
  async put(ctx, p) {
    const acc = p.place.accountId!, app = p.name, site = p.site;
    const had = await call(ctx, acc, `/apps/${app}`);
    if (had.status === 401) throw refused('read the app', had);
    if (had.status < 400 && !p.update) throw taken('Fly.io', app);
    const config = site.copyOf ? await copied(ctx, acc, site.copyOf) : shape(site.image!, p.tuned?.port ?? p.port ?? 8080, p.size?.memoryMb);
    ctx.progress('Getting the app ready on Fly.io…');
    if (had.status >= 400) await firstApp(ctx, acc, p);
    if (p.env.length) await fly.setSecrets(ctx, acc, app, p.env);
    const running = had.status < 400 ? await call(ctx, acc, `/apps/${app}/machines`) : { status: 200, data: [] };
    if (running.status >= 400) throw refused('list the machines', running);
    const ids: string[] = [];
    for (const m of running.data as { id: string; config: object }[]) {
      const up = await call(ctx, acc, `/apps/${app}/machines/${m.id}`, { body: { config: { ...m.config, image: config.image } } });
      if (up.status >= 400) throw refused('update the machine', up);
      ids.push(m.id);
    }
    if (!ids.length) {
      const made = await call(ctx, acc, `/apps/${app}/machines`, { body: { config } });
      if (made.status >= 400) throw refused(`start a machine from ${String(config.image)} (a private image has to be in registry.fly.io, in the same organisation)`, made);
      ids.push(String(made.data.id));
    }
    for (const id of ids) await started(ctx, acc, app, id);
    return { url: `https://${app}.fly.dev`, project: app, deployment: ids[0], point: { fly: { accountId: acc, app } }, notes: site.copyOf ? [`It runs what ${site.copyOf} runs, without its settings. Give it test keys with live.env.`] : [] };
  },
  logs: async (ctx, r) => (await fly.recentLines(ctx, r.place.accountId!, parts(r.project)[0]!, new Date(Date.now() - 3600_000))).map((l) => l.text),
  async env(ctx, r, op) {
    const acc = r.place.accountId!, app = parts(r.project)[0]!;
    let version: number | undefined;
    if (op.set?.length) version = await fly.setSecrets(ctx, acc, app, op.set);
    for (const key of op.unset ?? []) {
      const gone = await call(ctx, acc, `/apps/${app}/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (gone.status >= 400) throw refused('remove a setting', gone);
      version = gone.data.version ?? version;
    }
    if (op.set?.length || op.unset?.length) await fly.roll(ctx, acc, app, version);
    const list = await call(ctx, acc, `/apps/${app}/secrets`);
    if (list.status >= 400) throw refused('list the settings', list);
    return (list.data.secrets as { name: string }[]).map((s) => ({ key: s.name }));
  },
});
