// An app in Coolify, day to day: deploy on push, pull request previews, persistent storage, and whether it can have more
// copies. Add-only next to tools/coolify.ts: the same token, the same `need` check, Coolify stays in charge of what it runs.
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { json } from '../db.ts';
import { Unit7Error, notFound } from '../errors.ts';
import { defineTool, type Ctx } from './runtime.ts';
import { fid, isAgent } from './helpers.ts';
import { serverRow } from './servers.ts';
import { KIND, UUID, apiChange, need } from './coolify.ts';
import { CHANGE_UNDO } from './manage.ts';
import { inventoryOf } from './xray.ts';
import { addHook, githubToken, parseRepo, repoHooks } from '../connectors/github.ts';
import { list as items, plural, type Coolify, type Kind } from '../connectors/coolify.ts';
import type { ServerRow } from '../connectors/ssh.ts';

const enc = encodeURIComponent;
// An older Coolify answers a route it hasn't got with 404, and a field it hasn't got with "not allowed"
const tooOld = (version: string | undefined, what: string, since: string) => new Unit7Error('coolify_too_old', `Coolify${version ? ` ${version}` : ''} can’t ${what} through its API (that came in ${since}). Update Coolify, or do it in Coolify’s dashboard.`, 409);
const notAllowed = (e: unknown) => (e as Unit7Error).code === 'coolify_rejected' && /not allowed/i.test((e as Error).message);

// --- deploy on push, and previews -------------------------------------------------------------------------------------
// Two switches on an app. Both hear about GitHub the same way: Coolify's GitHub App tells it by itself; an app built from a
// public repo or a deploy key hears only through a webhook on the repo, so turning a switch on alone would do nothing. Unit7
// adds that webhook when a GitHub account can, one per app: Coolify checks a push against each app's own secret, so two apps
// on one repo can't share one. A webhook that's already there is left alone, with its secret. Turning off leaves it too.
async function hearsGitHub(ctx: Ctx, s: ServerRow, api: Coolify, app: Record<string, any>) {
  if (Number(app.source_id) > 0) return { hears: 'Coolify’s GitHub App tells it about pushes and pull requests by itself.' };
  const repo = parseRepo(String(app.git_repository ?? ''));
  const base = (await inventoryOf(ctx, s)).coolify?.dashboard?.replace(/\/+$/, '');
  const token = repo && await githubToken(ctx).catch(() => undefined);
  const by = 'in Coolify, the app’s Webhooks page has the address and secret to add to the repo.';
  if (!repo) return { next: `This isn’t a GitHub repo, so Unit7 can’t add the webhook Coolify needs: ${by}` };
  if (!base) return { next: `Unit7 doesn’t know Coolify’s address, so it can’t add the webhook Coolify needs: ${by}` };
  if (!token) return { next: `GitHub isn’t connected, so Unit7 can’t add the webhook Coolify needs. Connect GitHub and run this again, or: ${by}` };
  const path = '/webhooks/source/github/events/manual', mine = `${path}?app=${enc(String(app.uuid))}`;
  const hooks = await repoHooks(repo, token).catch(() => undefined);
  if (!hooks) return { next: `The connected GitHub account can’t see ${repo.owner}/${repo.name}’s webhooks (that takes admin rights), so Unit7 didn’t add one: ${by}` };
  if (hooks.some((h) => h.config?.url?.endsWith(path) || h.config?.url?.endsWith(mine))) return { hears: 'The repo’s webhook is already there.' };
  const secret = randomBytes(24).toString('hex');
  ctx.redactor.add(secret, 'a webhook secret');
  await api.call('PATCH', `/applications/${enc(String(app.uuid))}`, { manual_webhook_secret_github: secret });
  const hook = await addHook(repo, { url: `${base}${mine}`, secret }, token).catch((e: Error) => { throw new Unit7Error('webhook', `Coolify is set, but GitHub didn’t take the webhook (${e.message}). The connected account may not be allowed to add one: ${by}`, 502); });
  return { webhook: hook.id, hears: `Unit7 added a webhook to the repo: GitHub must be able to reach ${base}.` };
}

const SWITCHES = [{
  tool: 'coolify.auto_deploy', title: 'Deploy on push in Coolify', field: 'is_auto_deploy_enabled', what: 'turn deploy on push on or off', since: '4.0', word: 'deploy on push',
  about: 'Turn deploy on push on or off for a Coolify application: Coolify deploys when its branch gets a new commit. With on, an app built from a public repo or a deploy key also gets the webhook it needs on the repo, when GitHub is connected; without one the result says how to add it. Coolify does this itself, so it works while this computer sleeps. Undo puts the old setting back.',
  note: 'Coolify deploys its branch on each push from now on.',
}, {
  tool: 'coolify.previews', title: 'Pull request previews in Coolify', field: 'is_preview_deployments_enabled', what: 'turn pull request previews on or off', since: '4.2', word: 'pull request previews',
  about: 'Turn pull request previews on or off for a Coolify application: Coolify deploys a copy of each open pull request and takes it down when it closes. With on, an app built from a public repo or a deploy key also gets the webhook it needs on the repo, when GitHub is connected; without one the result says how to add it. Each copy’s address comes from the app’s own domain (like 12.app.example.com), so it needs a wildcard DNS record pointing at this server. Undo puts the old setting back.',
  note: 'Each pull request gets an address like <number>.<the app’s domain>: that needs a wildcard DNS record pointing at this server. coolify.envs with preview sets a preview copy’s settings.',
}] as const;
for (const sw of SWITCHES) {
  defineTool({
    name: sw.tool, title: sw.title, risk: 'write', action: 'settings_write', timeoutMs: 60_000, description: sw.about,
    input: z.object({ serverId: fid('srv'), uuid: UUID, on: z.boolean() }),
    assess: (_c, i) => ({ tier: 2, impact: `Turns ${sw.word} ${i.on ? 'on' : 'off'} for this app. Nothing restarts. Undo puts the old setting back.`, shows: `Coolify’s API: PATCH the application with ${sw.field}${i.on ? ', and a webhook on its GitHub repo when it needs one' : ''}` }),
    async run(ctx, i) {
      const s = serverRow(ctx, i.serverId), c = need(ctx, s);
      const app = await c.api.call('GET', `/applications/${enc(i.uuid)}`), name = String(app?.name ?? 'this app');
      if (app?.build_pack === 'dockerimage' || !app?.git_repository || /coollabsio\/coolify/.test(app.git_repository)) throw new Unit7Error('no_repo', `${name} runs from an image or a Dockerfile, not a repo, so it has no pushes or pull requests to follow.`, 409);
      const before = app?.settings?.[sw.field] as boolean | undefined;
      let changeId: string | undefined;
      if (before !== i.on) {
        await c.api.call('PATCH', `/applications/${enc(i.uuid)}`, { [sw.field]: i.on }).catch((e) => { throw notAllowed(e) ? tooOld(c.version, sw.what, sw.since) : e; });
        changeId = apiChange(ctx, s, i.uuid, 'coolify.setting', `Turned ${sw.word} ${i.on ? 'on' : 'off'} for ${name} in Coolify`, { name, before: { [sw.field]: before ?? !i.on } });
      }
      return { app: name, on: i.on, changed: !!changeId, ...(i.on && { note: sw.note, ...(await hearsGitHub(ctx, s, c.api, { ...app, uuid: i.uuid })) }), ...(changeId && { changeId, undo: { tool: 'change.undo', input: { changeId }, label: 'Undo' } }) };
    },
  });
}
// Activity's Undo: a setting Coolify keeps on the application, put back through its API
CHANGE_UNDO['coolify.setting'] = async (ctx, ch) => {
  const u = json<{ serverId: string; uuid: string; name: string; before: Record<string, unknown> }>(ch.undo, { serverId: '', uuid: '', name: '', before: {} });
  await need(ctx, serverRow(ctx, u.serverId)).api.call('PATCH', `/applications/${enc(u.uuid)}`, u.before);
  return { restored: `${u.name}’s setting in Coolify` };
};

// --- persistent storage -----------------------------------------------------------------------------------------------
// Coolify's API has this from 4.0 (the last betas). A volume's real name is <owner uuid>-<name>. Removing one only takes it off the
// app: the data stays in its Docker volume, so adding the same name back brings it back. File mounts are different: removing
// one deletes it from the server, so they're only listed here. From 4.6 removing needs the key's delete permission.
const NAME = z.string().regex(/^[a-zA-Z0-9][\w.-]{0,100}$/, 'letters, digits and . _ -');
const MOUNT = z.string().regex(/^\/[\w./-]{0,200}$/, 'a path inside the app, like /app/uploads').refine((p) => p !== '/' && !/(^|\/)\.\.(\/|$)/.test(p), 'a folder inside the app, with no ..');
async function storagesOf(api: Coolify, version: string | undefined, kind: Kind, uuid: string) {
  const b = await api.call('GET', `/${plural(kind)}/${enc(uuid)}/storages`).catch(async (e) => {
    if ((e as Unit7Error).code !== 'not_found') throw e;
    await api.call('GET', `/${plural(kind)}/${enc(uuid)}`); // the app is there, so it's the route that isn't
    throw tooOld(version, 'list storage', '4.0');
  });
  return { persistent: items(b?.persistent_storages), files: items(b?.file_storages) };
}
const addStorage = (api: Coolify, kind: Kind, uuid: string, o: { name: string; mountPath: string; resource?: string }) =>
  api.call('POST', `/${plural(kind)}/${enc(uuid)}/storages`, { type: 'persistent', name: o.name, mount_path: o.mountPath, ...(o.resource && { resource_uuid: o.resource }) });

defineTool({
  name: 'coolify.storage', title: 'Persistent storage in Coolify',
  risk: (i) => (i.op === 'list' ? 'read' : i.op === 'remove' ? 'destructive' : 'write'), action: (i) => (i.op === 'list' ? 'read' : i.op === 'remove' ? 'service_delete' : 'settings_write'), timeoutMs: 60_000,
  description: 'Persistent storage of a Coolify application, database or service: folders that survive a deploy. op list: its volumes, and its file mounts (paths only, never what’s in them). op add: a new volume (name, mountPath like /app/uploads; for a service also resource, the part from op list). Coolify mounts it from the next deploy. op remove (storage, from op list): takes a volume off the app, from its next deploy. It always waits for a person (people type its name in confirm), and its data stays on the server. Undo adds it back.',
  input: z.object({
    serverId: fid('srv'), uuid: UUID, kind: KIND, op: z.enum(['list', 'add', 'remove']).default('list'),
    name: NAME.optional(), mountPath: MOUNT.optional(), resource: UUID.optional(), storage: UUID.optional(), confirm: z.string().max(200).optional(),
  }),
  assess: (_c, i) => (i.op === 'list' ? { tier: 0 } : i.op === 'remove' ? { tier: 3, impact: 'The app stops seeing that folder from its next deploy. Its data stays on the server, and undo adds it back.', shows: 'Coolify’s API: DELETE the storage' }
    : { tier: 2, impact: `Adds a volume at ${i.mountPath ?? 'that folder'}. Nothing restarts; Coolify mounts it from the next deploy.`, shows: 'Coolify’s API: POST a persistent storage' }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), c = need(ctx, s), { api } = c;
    const { persistent, files } = await storagesOf(api, c.version, i.kind, i.uuid);
    if (i.op === 'list') {
      return { volumes: persistent.map((v) => ({ uuid: v.uuid, name: v.name, mountPath: v.mount_path, ...(v.resource_uuid && { resource: v.resource_uuid }) })),
        files: files.map((f) => ({ uuid: f.uuid, path: f.mount_path, ...(f.resource_uuid && { resource: f.resource_uuid }) })) };
    }
    if (i.op === 'add') {
      if (!i.name || !i.mountPath) throw new Unit7Error('invalid_input', 'A volume needs a name and a mountPath.');
      if (i.kind === 'service' && !i.resource) throw new Unit7Error('invalid_input', 'A service’s volume belongs to one of its parts: give resource (a part’s uuid, from op list).');
      const same = persistent.find((v) => v.mount_path === i.mountPath && (!i.resource || v.resource_uuid === i.resource));
      if (same) return { storage: same.uuid, name: same.name, mountPath: i.mountPath, reused: true };
      const r = await addStorage(api, i.kind, i.uuid, { name: i.name, mountPath: i.mountPath, resource: i.resource });
      ctx.emit('coolify.setting', `Added the volume ${i.name} at ${i.mountPath} to a Coolify ${i.kind} on ${s.name}`, { resource: s.id, data: { uuid: i.uuid } });
      return { storage: r?.uuid, name: i.name, mountPath: i.mountPath, next: 'Coolify mounts it from the next deploy (coolify.control deploy).', undo: 'coolify.storage op remove takes it off again.' };
    }
    if (!i.storage) throw new Unit7Error('invalid_input', 'Say which volume (storage, its uuid from op list).');
    const v = persistent.find((x) => x.uuid === i.storage);
    if (!v) throw files.some((f) => f.uuid === i.storage) ? new Unit7Error('file_mount', 'That’s a file mount: removing it deletes it from the server, so Unit7 leaves it to you in Coolify.', 409) : notFound('That volume');
    if (!isAgent(ctx) && i.confirm?.trim() !== v.name) throw new Unit7Error('confirm_needed', `This is hard to undo. Type the name (${v.name}) to confirm.`, 400, { confirm: v.name });
    await api.call('DELETE', `/${plural(i.kind)}/${enc(i.uuid)}/storages/${enc(v.uuid)}`);
    // the name Coolify took (<owner uuid>-<name>) is what brings the same data back
    const owner = v.resource_uuid ?? i.uuid, short = String(v.name).startsWith(`${owner}-`) ? String(v.name).slice(owner.length + 1) : undefined;
    const summary = `Took the volume ${v.name} off a Coolify ${i.kind}`;
    const changeId = short ? apiChange(ctx, s, i.uuid, 'coolify.storage', summary, { kind: i.kind, name: short, mountPath: v.mount_path, resource: v.resource_uuid }) : undefined;
    if (!changeId) ctx.emit('coolify.setting', `${summary} on ${s.name}`, { severity: 'warning', resource: s.id, data: { uuid: i.uuid } });
    return { removed: v.name, mountPath: v.mount_path, dataKept: true, next: 'The app stops seeing it from the next deploy. The data stays in the volume on the server.', ...(changeId ? { changeId, undo: { tool: 'change.undo', input: { changeId }, label: 'Add it back' } } : { note: `To bring it back, add a volume in Coolify with the name ${v.name}.` }) };
  },
});
CHANGE_UNDO['coolify.storage'] = async (ctx, ch) => {
  const u = json<{ serverId: string; uuid: string; kind: Kind; name: string; mountPath: string; resource?: string }>(ch.undo, { serverId: '', uuid: '', kind: 'application', name: '', mountPath: '' });
  await addStorage(need(ctx, serverRow(ctx, u.serverId)).api, u.kind, u.uuid, u);
  return { restored: `The volume ${u.name} at ${u.mountPath}`, next: 'Coolify mounts it again from the next deploy, with the data it had.' };
};

// --- more copies ------------------------------------------------------------------------------------------------------
// Coolify has replicas on Docker Swarm servers only, and no version's API can set them (swarm_replicas isn't in PATCH
// /applications, 4.0 to 4.6). On a plain Docker server an app is one container, and a service is what its compose says.
defineTool({
  name: 'coolify.scale', title: 'More copies of an app in Coolify', risk: 'read', action: 'read', timeoutMs: 30_000,
  description: 'Whether Coolify can run more copies of an application or service on this server, and what to do instead. It changes nothing: Coolify has replicas only on Docker Swarm servers, and its API can’t set them. service.scale is for apps Unit7 deployed itself.',
  input: z.object({ serverId: fid('srv'), uuid: UUID, kind: KIND, replicas: z.number().int().min(1).max(100).optional() }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), { api } = need(ctx, s);
    const swarm = items(await api.call('GET', '/servers')).some((x) => x?.settings?.is_swarm_manager || x?.settings?.is_swarm_worker);
    return { scalable: false, kind: i.kind, ...(i.replicas && { asked: i.replicas }),
      why: swarm ? 'This Coolify has a Docker Swarm server, the only place it runs replicas, but its API can’t set them. In Coolify: the app → Swarm Configuration → Replicas.'
        : i.kind === 'application' ? 'Coolify runs one container for an app on a normal Docker server. Replicas are for Docker Swarm servers only.'
        : `Coolify has no replicas for a ${i.kind} on a normal Docker server.`,
      instead: ['Give it more room: a bigger memory cap (coolify.memory_cap), or a bigger server.', 'Run it on one more server too (coolify.add_server). Coolify doesn’t spread visitors between servers: that takes DNS or a load balancer.'] };
  },
});
