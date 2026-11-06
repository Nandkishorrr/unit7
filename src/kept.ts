// What a person said is in use (asset.keep): kept things are never suggested for archiving or deleting again, and
// important ones are also handled with extra care: an AI asks a person before changing one in production. One table
// (kept), keyed like archived: a map asset id (ast_…) or a Unit7 project id (prj_…). Only reads the database, so any
// module can import it.
import { all, get, json, type DB } from './db.ts';
import { assetIdOf } from './archive.ts';

export interface KeptRow { key: string; name: string; kind: string; provider: string | null; important: number; note: string | null; by: string | null; created_at: string }
export const keptRows = (db: DB, orgId: string) =>
  all<KeptRow>(db, 'SELECT key, name, kind, provider, important, note, by, created_at FROM kept WHERE org_id = ? ORDER BY created_at DESC', orgId);

// every key that counts as kept, and whether it's important: marked itself, a service of a marked Unit7 project (its map
// id), or a part inside a marked X-ray project
export function keptMarks(db: DB, orgId: string): Map<string, { important: boolean }> {
  const rows = keptRows(db, orgId);
  const out = new Map(rows.map((r) => [r.key, { important: !!r.important }]));
  if (!rows.length) return out;
  const add = (id: string, m: { important: boolean }) => out.set(id, { important: !!out.get(id)?.important || m.important });
  for (const s of all<{ id: string; project_id: string }>(db, 'SELECT id, project_id FROM services WHERE org_id = ?', orgId)) {
    const m = out.get(s.project_id); if (m) add(assetIdOf(orgId, `unit7:${s.id}`), m);
  }
  for (const a of all<{ id: string; project: string }>(db, `SELECT id, json_extract(meta, '$.project') project FROM assets WHERE org_id = ? AND json_extract(meta, '$.project') IS NOT NULL`, orgId)) {
    const m = out.get(assetIdOf(orgId, a.project)); if (m) add(a.id, m);
  }
  return out;
}

// production unless Unit7's own records say it lives somewhere else (the same reading as archiving)
const prodEnv = (env?: string | null) => !env || /prod|live|main|master/i.test(env);
const svcEnv = (db: DB, serviceId: string) => get<{ kind: string }>(db, 'SELECT e.kind FROM services s JOIN environments e ON e.id = s.environment_id WHERE s.id = ?', serviceId)?.kind;

// The important thing in production a change would touch, by name: one of its services (directly or through its job,
// domain or error group), the project or map item itself, a part of it on a server (by part or Coolify id), or a
// connection to it. The gate makes an AI ask a person first (tools/runtime.ts).
export function importantTouched(db: DB, orgId: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !get(db, 'SELECT 1 FROM kept WHERE org_id = ? AND important = 1 LIMIT 1', orgId)) return undefined;
  const marks = keptMarks(db, orgId), i = input as Record<string, unknown>;
  const imp = (k?: string) => !!k && !!marks.get(k)?.important;
  const via = (sql: string, v: unknown) => (typeof v === 'string' ? get<{ s: string }>(db, sql, v)?.s : undefined);
  const service = (id?: string) => {
    const s = id ? get<{ name: string; project_id: string }>(db, 'SELECT name, project_id FROM services WHERE id = ? AND org_id = ?', id, orgId) : undefined;
    return s && (imp(s.project_id) || imp(assetIdOf(orgId, `unit7:${id}`))) && svcEnv(db, id!) === 'production' ? s.name : undefined;
  };
  const asset = (where: string, v: string) => {
    const a = get<{ id: string; name: string; provider: string; ext_id: string; meta: string }>(db, `SELECT id, name, provider, ext_id, meta FROM assets WHERE org_id = ? AND ${where}`, orgId, v);
    if (!a || !imp(a.id)) return undefined;
    if (a.provider === 'unit7' && a.ext_id.startsWith('svc_')) return svcEnv(db, a.ext_id) === 'production' ? a.name : undefined;
    return prodEnv(json<{ environment?: string }>(a.meta, {}).environment) ? a.name : undefined;
  };
  const svc = typeof i.serviceId === 'string' ? i.serviceId
    : via('SELECT service_id s FROM jobs WHERE id = ?', i.jobId) ?? via('SELECT service_id s FROM domains WHERE id = ?', i.domainId) ?? via('SELECT service_id s FROM error_groups WHERE id = ?', i.groupId);
  const project = (id: string) => (imp(id) ? get<{ name: string }>(db, 'SELECT name FROM projects WHERE id = ?', id)?.name : undefined);
  const env = typeof i.environmentId === 'string' ? get<{ project_id: string; kind: string }>(db, 'SELECT project_id, kind FROM environments WHERE id = ? AND org_id = ?', i.environmentId, orgId) : undefined;
  // a domain (and its apex or www sibling): the Unit7 app it serves, the map's domain item, or an app found serving it
  const domain = (d: string) => {
    for (const h of [d, d.startsWith('www.') ? d.slice(4) : `www.${d}`].map((x) => x.trim().toLowerCase().replace(/\.$/, ''))) {
      const n = service(get<{ s: string }>(db, 'SELECT service_id s FROM domains WHERE org_id = ? AND hostname = ?', orgId, h)?.s) ?? asset(`provider = 'domain' AND ext_id = ?`, h)
        ?? asset(`kind = 'app' AND EXISTS (SELECT 1 FROM json_each(meta, '$.hosts') x WHERE lower(x.value) = ?)`, h);
      if (n) return n;
    }
  };
  const hit = service(svc)
    ?? service(via('SELECT service_id s FROM deployments WHERE id = ?', i.deploymentId))
    ?? (typeof i.asset === 'string' ? asset('id = ?', i.asset) : undefined)
    ?? (typeof i.domain === 'string' ? domain(i.domain) : undefined)
    ?? (typeof i.projectId === 'string' ? project(i.projectId) : undefined)
    ?? (env?.kind === 'production' ? project(env.project_id) : undefined)
    ?? (typeof i.key === 'string' ? (i.key.startsWith('prj_') ? project(i.key) : asset('id = ?', i.key)) : undefined);
  if (hit) return hit;
  if (typeof i.serverId === 'string') {
    if (typeof i.part === 'string') { const a = asset('ext_id = ?', `${i.serverId}/${i.part}`); if (a) return a; }
    // a Coolify app or project by its Coolify id, or the part that answers on a port: which part that is, from the
    // server's last X-ray
    if (typeof i.uuid === 'string' || typeof i.port === 'number') {
      const inv = json<{ parts?: { id: string; coolify?: { uuid: string }; ports?: { port: number }[] }[]; projects?: { id: string; coolify?: { uuid?: string } }[] }>(get<{ data: string }>(db,
        `SELECT data FROM xrays WHERE org_id = ? AND server_id = ? AND kind = 'fast' AND ok = 1 ORDER BY created_at DESC LIMIT 1`, orgId, i.serverId)?.data, {});
      const part = inv.parts?.find((p) => (typeof i.uuid === 'string' && p.coolify?.uuid === i.uuid) || (typeof i.port === 'number' && !!p.ports?.some((x) => x.port === i.port)))?.id;
      const project = typeof i.uuid === 'string' ? inv.projects?.find((p) => p.coolify?.uuid === i.uuid)?.id : undefined;
      const a = part ? asset('ext_id = ?', `${i.serverId}/${part}`) : project ? asset('ext_id = ?', `${i.serverId}/p/${project}`) : undefined;
      if (a) return a;
    }
  }
  // a connection with an important thing on either end
  const l = typeof i.linkId === 'string' ? get<{ source: string; target: string }>(db, 'SELECT source, target FROM links WHERE id = ? AND org_id = ?', i.linkId, orgId) : undefined;
  for (const e of l ? [l.source, l.target].map((x) => json<Record<string, unknown>>(x, {})) : []) {
    if (e.kind === 'unit7') { const n = service(String(e.serviceId)); if (n) return n; continue; }
    const same = (x: Record<string, unknown>) => Object.keys({ ...x, ...e }).every((k) => x[k] === e[k]);
    for (const a of all<{ id: string; e: string }>(db, `SELECT id, json_extract(meta, '$.end') e FROM assets WHERE org_id = ? AND json_extract(meta, '$.end.kind') = ?`, orgId, String(e.kind))) {
      if (same(json<Record<string, unknown>>(a.e, {}))) { const n = asset('id = ?', a.id); if (n) return n; }
    }
  }
  return undefined;
}
