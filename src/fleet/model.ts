// Many servers, the records: which servers an app runs on (its placement), what each one runs, and whether all of them
// run the same version. services.server_id stays the main server, so an app on one server has no rows here and reads
// exactly as before: targetsOf() then returns just its main server.
import { all, get, json, run, type DB } from '../db.ts';
import type { ServiceRow } from '../deploy/deployer.ts';

export type TargetState = 'in' | 'out' | 'sick';
export interface Target {
  serverId: string; name: string; host: string; status: string; primary: boolean; weight: number; state: TargetState;
  role: string; // primary, replica, or standby (a warm copy out of rotation: src/fleet/dr.ts)
  deploymentId: string | null; number: number | null; health: string | null; checkedAt: string | null; address: string | null;
}
export interface Fleet { service_id: string; org_id: string; mode: 'front' | 'dns'; why: string | null; edge_port: number | null }

interface Row { server_id: string; role: string; weight: number; state: string; deployment_id: string | null; health: string | null; checked_at: string | null }
type Srv = { id: string; name: string; host: string; status: string };

const numberOf = (db: DB, depId: string | null) => (depId ? get<{ number: number }>(db, 'SELECT number FROM deployments WHERE id = ?', depId)?.number ?? null : null);
const addressOf = (db: DB, serverId: string) => get<{ address: string }>(db, 'SELECT address FROM fleet_net WHERE server_id = ?', serverId)?.address ?? null;

export const fleetOf = (db: DB, serviceId: string) => get<Fleet>(db, 'SELECT * FROM fleets WHERE service_id = ?', serviceId);

// every server the app runs on, the main one first. The main server's version is always the app's live deployment.
export function targetsOf(db: DB, svc: Pick<ServiceRow, 'id' | 'server_id' | 'current_deployment_id'>): Target[] {
  const rows = all<Row>(db, 'SELECT server_id, role, weight, state, deployment_id, health, checked_at FROM service_targets WHERE service_id = ? ORDER BY added_at, rowid', svc.id);
  const ids = [...new Set([svc.server_id, ...rows.map((r) => r.server_id)].filter((x): x is string => !!x))];
  return ids.map((sid) => {
    const s = get<Srv>(db, 'SELECT id, name, host, status FROM servers WHERE id = ?', sid);
    const r = rows.find((x) => x.server_id === sid);
    const primary = sid === svc.server_id;
    const deploymentId = primary ? svc.current_deployment_id : r?.deployment_id ?? null;
    return {
      serverId: sid, name: s?.name ?? 'a server', host: s?.host ?? '', status: s?.status ?? 'unknown', primary, weight: r?.weight ?? 1, role: primary ? 'primary' : r?.role ?? 'replica',
      state: (r?.state as TargetState) ?? 'in', deploymentId, number: numberOf(db, deploymentId), health: r?.health ?? null, checkedAt: r?.checked_at ?? null, address: addressOf(db, sid),
    };
  });
}
export const isFleet = (db: DB, svc: Pick<ServiceRow, 'id' | 'server_id' | 'current_deployment_id'>) => targetsOf(db, svc).length > 1;

export function setTarget(db: DB, orgId: string, serviceId: string, serverId: string, patch: { role?: string; state?: TargetState; deploymentId?: string | null; health?: string | null }) {
  run(db, `INSERT INTO service_targets (service_id, server_id, org_id, role) VALUES (?, ?, ?, ?) ON CONFLICT (service_id, server_id) DO NOTHING`, serviceId, serverId, orgId, patch.role ?? 'replica');
  if (patch.role) run(db, 'UPDATE service_targets SET role = ? WHERE service_id = ? AND server_id = ?', patch.role, serviceId, serverId);
  if (patch.state) run(db, 'UPDATE service_targets SET state = ? WHERE service_id = ? AND server_id = ?', patch.state, serviceId, serverId);
  if (patch.deploymentId !== undefined) run(db, 'UPDATE service_targets SET deployment_id = ? WHERE service_id = ? AND server_id = ?', patch.deploymentId, serviceId, serverId);
  if (patch.health !== undefined) run(db, 'UPDATE service_targets SET health = ?, checked_at = ? WHERE service_id = ? AND server_id = ?', patch.health, new Date().toISOString(), serviceId, serverId);
}

// --- one version everywhere? ---------------------------------------------------------------------------------------------
// The main server's version is the one the others should run. "Behind" is every other server that runs something else
// (or nothing yet); out-of-rotation servers count too, so a server put back never serves an old version.
export function drift(targets: Pick<Target, 'serverId' | 'name' | 'primary' | 'number'>[]) {
  const main = targets.find((t) => t.primary)?.number ?? null;
  const byVersion = new Map<number | null, string[]>();
  for (const t of targets) byVersion.set(t.number, [...(byVersion.get(t.number) ?? []), t.name]);
  const behind = targets.filter((t) => !t.primary && t.number !== main).map((t) => t.serverId);
  const versions = [...byVersion.entries()].map(([number, servers]) => ({ number, servers })).sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
  const words = versions.length > 1 ? versions.map((v) => `${v.servers.length} server${v.servers.length === 1 ? '' : 's'} on ${v.number === null ? 'nothing yet' : `v${v.number}`}`).join(', ') : undefined;
  return { same: behind.length === 0, main, behind, versions, words };
}

// --- who gets visitors, and how much ---------------------------------------------------------------------------------
// The share each server gets: in rotation, not known to be sick, running something; by weight. A server that's out
// (or sick) gets nothing. ponytail: the expected share from the weights (the proxy picks the least busy copy); read
// real counts from the proxy's log when shares need to be measured.
export function shares(targets: Pick<Target, 'serverId' | 'state' | 'health' | 'weight' | 'deploymentId'>[]): Record<string, number> {
  const live = targets.filter((t) => t.state === 'in' && t.health !== 'bad' && t.deploymentId);
  const total = live.reduce((n, t) => n + Math.max(1, t.weight), 0);
  const out: Record<string, number> = {};
  for (const t of targets) out[t.serverId] = 0;
  // rounded down, the rest to the first one (the main server when it's in rotation), so they always add up to 100
  live.forEach((t) => { out[t.serverId] = Math.floor((Math.max(1, t.weight) / total) * 100); });
  if (live[0]) out[live[0].serverId]! += 100 - live.reduce((n, t) => n + out[t.serverId]!, 0);
  return out;
}

// the fleets in an organisation (apps on more than one server)
export const fleetServices = (db: DB, orgId: string) =>
  all<ServiceRow>(db, `SELECT s.* FROM services s WHERE s.org_id = ? AND (SELECT count(*) FROM service_targets t WHERE t.service_id = s.id AND t.server_id != coalesce(s.server_id, '')) > 0`, orgId);

export const planOf = (db: DB, depId: string | null) => json<{ port?: number; healthPath?: string }>(get<{ plan: string }>(db, 'SELECT plan FROM deployments WHERE id = ?', depId ?? '')?.plan, {});
