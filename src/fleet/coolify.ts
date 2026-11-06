// Coolify fleets. Coolify can run one application on more servers itself ("additional servers", since 4.4: the app's
// destinations). The main server builds the image and pushes it to the app's registry image, the other servers pull the
// same one, and each deploy reaches every server. Where Coolify runs an app, Unit7 drives that feature through Coolify's
// API instead of building a second system next to it, and shows it in the same release lanes.
// What Coolify refuses, Unit7 says first in plain words (from Coolify's own rules, app/Models/Application.php 4.4):
// Docker Compose apps, apps with persistent storage (volumes aren't shared between servers), a server on another proxy,
// and, at deploy time, an app without a registry image. Coolify doesn't spread visitors across the servers: that needs
// DNS records for each server, or a load balancer in front.
import { Unit7Error } from '../errors.ts';
import { list, type Coolify } from '../connectors/coolify.ts';

const enc = encodeURIComponent;
export interface CoolifyDest { uuid: string; name: string; serverUuid: string; serverId: number | null; primary: boolean }
export interface CoolifyLane { serverUuid: string; name: string; primary: boolean; state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string; at?: string }

// what stops this app from running on more servers, or undefined (pure)
export function coolifyFleetRefusal(app: { build_pack?: string | null; docker_registry_image_name?: string | null }, persistentStorages: number): { reason: string; fix?: string } | undefined {
  if (app.build_pack === 'dockercompose') return { reason: 'Coolify can’t run a Docker Compose app on more than one server.' };
  if (persistentStorages > 0) return { reason: 'It keeps files in a volume on its server, and volumes aren’t shared between servers, so each server would have different files.', fix: 'Move those files to S3 or Cloudflare R2, then remove the volume in Coolify.' };
  if (!String(app.docker_registry_image_name ?? '').trim()) return { reason: 'Coolify needs a registry image for it, so every server runs exactly the same build.', fix: 'In Coolify, open the app’s General tab and set Image (for example ghcr.io/sam/shop), with the registry signed in on each server.' };
  return undefined;
}

export const destsOf = (b: unknown): CoolifyDest[] => list(b, 'destinations').filter((d) => d?.uuid).map((d) => ({
  uuid: String(d.uuid), name: String(d.name ?? 'a destination'), serverUuid: String(d.server_uuid ?? ''), serverId: typeof d.server_id === 'number' ? d.server_id : null, primary: d.is_primary === true,
}));

// one lane per server: its newest deployment (Coolify queues one per server, each with the server's id and name)
export function coolifyLanes(dests: CoolifyDest[], deployments: { status?: string; server_id?: number; server_name?: string; created_at?: string; commit?: string }[], serverName: (d: CoolifyDest) => string): CoolifyLane[] {
  return dests.map((d) => {
    const dep = deployments.filter((x) => d.serverId !== null && x.server_id === d.serverId).sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
    const st = String(dep?.status ?? '');
    const state: CoolifyLane['state'] = !dep ? 'waiting' : /^(queued|in_progress)/.test(st) ? 'running' : /^finished/.test(st) ? 'done' : /^failed/.test(st) ? 'failed' : 'skipped';
    return { serverUuid: d.serverUuid, name: dep?.server_name ?? serverName(d), primary: d.primary, state, ...(dep && { detail: state === 'done' ? `Done${dep.commit ? ` · ${String(dep.commit).slice(0, 7)}` : ''}` : state === 'failed' ? 'The deploy failed here' : state === 'running' ? (st.startsWith('queued') ? 'Waiting its turn' : 'Deploying') : 'Cancelled', at: dep.created_at }) };
  });
}

// everything the app's "servers" view needs, from Coolify
export async function readCoolifyFleet(api: Coolify, uuid: string) {
  const [app, dests, servers, deps, storages] = await Promise.all([
    api.call('GET', `/applications/${enc(uuid)}`),
    api.call('GET', `/applications/${enc(uuid)}/destinations`).then(destsOf).catch((e: Unit7Error) => { if (e.code === 'not_found') throw new Unit7Error('coolify_too_old', 'This Coolify can’t run an app on more servers yet (that came in Coolify 4.4). Update Coolify first.', 409); throw e; }),
    api.call('GET', '/servers').then((b) => list(b)),
    api.call('GET', `/deployments/applications/${enc(uuid)}?skip=0&take=30`).then((b) => (Array.isArray(b) ? b : b?.deployments ?? []) as any[]).catch(() => []),
    api.call('GET', `/applications/${enc(uuid)}/storages`).then((b) => (Array.isArray(b) ? b : list(b, 'persistent_storages'))).catch(() => [] as unknown[]),
  ]);
  const byUuid = new Map(servers.filter((s) => s?.uuid).map((s) => [String(s.uuid), s]));
  const nameOf = (d: CoolifyDest) => String(byUuid.get(d.serverUuid)?.name ?? d.name);
  const refusal = coolifyFleetRefusal(app ?? {}, storages.length);
  const used = new Set(dests.map((d) => d.serverUuid));
  return {
    app: { uuid, name: String(app?.name ?? 'the app'), buildPack: app?.build_pack ?? null, image: app?.docker_registry_image_name || null },
    servers: dests.map((d) => ({ ...d, server: nameOf(d), ip: byUuid.get(d.serverUuid)?.ip ?? null })),
    lanes: coolifyLanes(dests, deps, nameOf),
    candidates: servers.filter((s) => s?.uuid && !used.has(String(s.uuid)) && s.is_usable !== false && s.settings?.is_usable !== false).map((s) => ({ uuid: String(s.uuid), name: String(s.name ?? 'a server'), ip: s.ip ?? null })),
    ...(refusal && { refusal }),
  };
}

// the destination to attach on another Coolify server: its Docker network (Coolify makes one per server)
export async function destinationOn(api: Coolify, serverUuid: string) {
  const ds = destsOf(await api.call('GET', `/servers/${enc(serverUuid)}/destinations`));
  if (!ds[0]) throw new Unit7Error('no_destination', 'That server has no Docker network in Coolify yet. Validate the server in Coolify first.', 409);
  return ds[0];
}
