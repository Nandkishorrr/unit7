// Archived things: kept where they run, but Unit7 stops looking at them. One table (archived), keyed by a map asset id
// (ast_…, a hash of the organisation and the thing's map key, so it survives every sync) or a Unit7 project id (prj_…).
// Everything that watches, alerts, suggests or changes things in the background asks here first. Only reads the
// database, so any module can import it without pulling in the tools.
import { createHash } from 'node:crypto';
import { all, get, json, type DB } from './db.ts';
import type { Inventory } from './discovery/xray.ts';

// the same id map.ts gives a map key ("vercel:prj_1", "unit7:svc_…", "coolify:srv_…/c:shop")
export const assetIdOf = (orgId: string, key: string) => `ast_${createHash('sha256').update(`${orgId}\n${key}`).digest('base64url').slice(0, 12)}`;

const anyArchived = (db: DB, orgId: string) => !!get(db, 'SELECT 1 FROM archived WHERE org_id = ? LIMIT 1', orgId);
export const archivedKeys = (db: DB, orgId: string) => new Set(all<{ key: string }>(db, 'SELECT key FROM archived WHERE org_id = ?', orgId).map((r) => r.key));

// Unit7's own services Unit7 leaves alone: in an archived project, or archived themselves on the map
export function archivedServices(db: DB, orgId: string, keys = archivedKeys(db, orgId)): Set<string> {
  if (!keys.size) return new Set();
  return new Set(all<{ id: string; project_id: string }>(db, 'SELECT id, project_id FROM services WHERE org_id = ?', orgId)
    .filter((s) => keys.has(s.project_id) || keys.has(assetIdOf(orgId, `unit7:${s.id}`))).map((s) => s.id));
}

// every map asset id that counts as archived: archived itself, inside an archived X-ray project, or a service of an
// archived Unit7 project
export function archivedAssets(db: DB, orgId: string): Set<string> {
  const keys = archivedKeys(db, orgId);
  if (!keys.size) return keys;
  const out = new Set(keys);
  for (const s of archivedServices(db, orgId, keys)) out.add(assetIdOf(orgId, `unit7:${s}`));
  for (const a of all<{ id: string; project: string }>(db, `SELECT id, json_extract(meta, '$.project') project FROM assets WHERE org_id = ? AND json_extract(meta, '$.project') IS NOT NULL`, orgId)) {
    if (keys.has(assetIdOf(orgId, a.project))) out.add(a.id);
  }
  return out;
}

// key order doesn't matter when comparing two connection ends
const same = (a: unknown, b: unknown) => JSON.stringify(a, Object.keys(a ?? {}).sort()) === JSON.stringify(b, Object.keys(b ?? {}).sort());

// a connection end ({ kind: 'vercel', accountId, project } or { kind: 'unit7', serviceId }) that is archived
export function endArchived(db: DB, orgId: string, end: Record<string, unknown>): boolean {
  if (!end?.kind || !anyArchived(db, orgId)) return false;
  if (end.kind === 'unit7') return archivedServices(db, orgId).has(String(end.serviceId));
  const ids = [...archivedAssets(db, orgId)].filter((k) => k.startsWith('ast_'));
  return !!ids.length && all<{ e: string | null }>(db, `SELECT json_extract(meta, '$.end') e FROM assets WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`, orgId, ...ids)
    .some((r) => same(json<Record<string, unknown>>(r.e, {}), end));
}
// a connection (link) with an archived thing on either side
export function linkArchived(db: DB, orgId: string, linkId: string): boolean {
  if (!anyArchived(db, orgId)) return false;
  const l = get<{ source: string; target: string }>(db, 'SELECT source, target FROM links WHERE id = ? AND org_id = ?', linkId, orgId);
  return !!l && [l.source, l.target].some((e) => endArchived(db, orgId, json<Record<string, unknown>>(e, {})));
}

// Does a background job's input point at something archived? (a service, its job, domain or error group, a connection)
export function touchesArchived(db: DB, orgId: string, input: unknown): boolean {
  if (!input || typeof input !== 'object' || !anyArchived(db, orgId)) return false;
  const i = input as Record<string, unknown>;
  const via = (sql: string, v: unknown) => (typeof v === 'string' ? get<{ s: string }>(db, sql, v)?.s : undefined);
  const svc = typeof i.serviceId === 'string' ? i.serviceId
    : via('SELECT service_id s FROM jobs WHERE id = ?', i.jobId) ?? via('SELECT service_id s FROM domains WHERE id = ?', i.domainId) ?? via('SELECT service_id s FROM error_groups WHERE id = ?', i.groupId);
  if (svc && archivedServices(db, orgId).has(svc)) return true;
  // something the X-ray found on a server (part.restart { serverId, part })
  const part = typeof i.serverId === 'string' && typeof i.part === 'string' ? get<{ id: string }>(db, 'SELECT id FROM assets WHERE org_id = ? AND ext_id = ?', orgId, `${i.serverId}/${i.part}`) : undefined;
  if (part && archivedAssets(db, orgId).has(part.id)) return true;
  return typeof i.linkId === 'string' && linkArchived(db, orgId, i.linkId);
}

// A server's X-ray without what's archived (parts, and projects with all their parts), for the findings
export function withoutArchived(db: DB, orgId: string, serverId: string, inv: Inventory | undefined): Inventory | undefined {
  if (!inv || !anyArchived(db, orgId)) return inv;
  const gone = archivedAssets(db, orgId);
  const projects = new Set(inv.projects.filter((p) => gone.has(assetIdOf(orgId, `${p.owner}:${serverId}/p/${p.id}`))).map((p) => p.id));
  const parts = new Set(inv.parts.filter((p) => (p.project && projects.has(p.project)) || gone.has(assetIdOf(orgId, `${p.owner}:${serverId}/${p.id}`))).map((p) => p.id));
  if (!projects.size && !parts.size) return inv;
  return { ...inv, projects: inv.projects.filter((p) => !projects.has(p.id)).map((p) => ({ ...p, parts: p.parts.filter((x) => !parts.has(x)) })), parts: inv.parts.filter((p) => !parts.has(p.id)) };
}

// every Unit7 id that belongs to something archived: its project, environments, services and what hangs off them
export function archivedIds(db: DB, orgId: string): string[] {
  const keys = archivedKeys(db, orgId);
  if (!keys.size) return [];
  const svcs = [...archivedServices(db, orgId, keys)], projects = [...keys].filter((k) => k.startsWith('prj_'));
  const of = (table: string, col: string, list: string[]) => (list.length ? all<{ id: string }>(db, `SELECT id FROM ${table} WHERE ${col} IN (${list.map(() => '?').join(',')})`, ...list).map((r) => r.id) : []);
  return [...projects, ...svcs, ...of('environments', 'project_id', projects), ...of('jobs', 'service_id', svcs), ...of('error_groups', 'service_id', svcs), ...of('backups', 'service_id', svcs)];
}
// leave out (in place) what's about something archived: a suggestion names it in its id or its buttons' input
export function dropArchived<T>(db: DB, orgId: string, list: T[]): T[] {
  const ids = archivedIds(db, orgId);
  if (!ids.length) return list;
  const keep = list.filter((x) => { const t = JSON.stringify(x); return !ids.some((id) => t.includes(id)); });
  list.splice(0, list.length, ...keep);
  return list;
}
