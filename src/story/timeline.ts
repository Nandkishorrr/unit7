// "What changed since it last worked": one timeline per app, project or server (or everything), newest first,
// merged from what Unit7 already keeps: deploys, setting changes (names only, never values), DNS and domain points,
// changes on a server with their undo, Coolify deploys and actions, what the X-ray saw change between saved runs,
// connection syncs, Warden's reflexes, approvals decided and security fixes. Each line says who did it (a person, an
// AI, Warden, Unit7, or something outside like Coolify) and carries the undo Unit7 already has for it, never one made
// up. "Since it last worked" finds the last healthy moment from the site checks and health history and marks the
// change most likely to blame: the closest one before the failure, a deploy first. Reads the database only.
import { all, get, json, type DB } from '../db.ts';
import { redact } from '../redact.ts';
import { getTool, viewInput } from '../tools/runtime.ts';
import type { Inventory, Part } from '../discovery/xray.ts';

export type Kind = 'deploy' | 'rollback' | 'setting' | 'dns' | 'change' | 'found' | 'restart' | 'link' | 'security' | 'server' | 'approval' | 'other';
export type WhoKind = 'person' | 'ai' | 'warden' | 'unit7' | 'outside';
export interface Who { kind: WhoKind; name: string }
export interface Undo { tool: string; input: Record<string, unknown>; label: string }
export interface Item {
  id: string; at: string; kind: Kind; text: string; who: Who;
  logo?: string; status?: 'ok' | 'failed' | 'undone' | 'working';
  undo?: Undo; detail?: string[]; children?: Item[];
  serverId?: string; serviceId?: string; projectId?: string;
  culprit?: boolean;
}
export interface Scope { serverId?: string; projectId?: string; serviceId?: string }
export interface Health { state: 'ok' | 'failing'; healthyAt?: string; failingSince?: string; recoveredAt?: string; what?: string; guessed?: boolean }

const MIN = 60_000, HOUR = 3600_000;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const dedot = (s: string) => s.replace(/\.$/, '');

// --- who did it --------------------------------------------------------------------------------------------
export interface AuditActor { actor_kind: string; actor_id: string | null; actor_name: string; agent: string | null }
const approvedBy = (name: string) => /\(approved by ([^)]*)\)\s*$/.exec(name)?.[1];
// a token Unit7 made for an AI app says which one: "Sam (token Unit7 connect · Claude Code)"
const viaAi = (name: string) => /\(token [^)]*·\s*([^)]+?)\s*\)/.exec(name)?.[1];
export function whoOfAudit(r: AuditActor): Who {
  const base = r.actor_name.replace(/\s*\(approved by [^)]*\)\s*$/, '');
  if (r.actor_kind === 'user') return { kind: 'person', name: base };
  if (r.actor_kind === 'agent' && r.actor_id === 'warden') return { kind: 'warden', name: 'Warden' };
  if (r.actor_kind === 'agent') return { kind: 'ai', name: r.agent ?? base };
  if (r.actor_kind === 'token') return viaAi(base) ? { kind: 'ai', name: viaAi(base)! } : { kind: 'person', name: base.replace(/\s*\(token [^)]*\)\s*$/, '') };
  return { kind: 'unit7', name: 'Unit7' };
}
// a name Unit7 wrote down (who deployed, who changed a setting): the org's people by name, else by its shape
export function whoOfName(name: string | null | undefined, people: Set<string>): Who {
  const n = (name ?? '').replace(/\s*\(approved by [^)]*\)\s*$/, '').trim();
  if (!n) return { kind: 'unit7', name: 'Unit7' };
  if (/^warden$/i.test(n)) return { kind: 'warden', name: 'Warden' };
  if (/^unit7\b/i.test(n) && !/agent/i.test(n)) return { kind: 'unit7', name: 'Unit7' };
  if (viaAi(n)) return { kind: 'ai', name: viaAi(n)! };
  const person = n.replace(/\s*\(token [^)]*\)\s*$/, '');
  if (people.has(person.toLowerCase())) return { kind: 'person', name: person };
  if (/claude|gemini|codex|cursor|copilot|\bmcp\b|\bai\b|agent/i.test(n)) return { kind: 'ai', name: n };
  return { kind: 'person', name: person };
}

// --- the thing a timeline is about -----------------------------------------------------------------------------
interface SvcRow { id: string; name: string; server_id: string | null; project_id: string; environment_id: string; current_deployment_id: string | null }
export interface Resolved {
  label: string; all: boolean; kind: 'all' | 'server' | 'project' | 'service';
  servers: Set<string>; services: Set<string>; projects: Set<string>; envs: Set<string>; hosts: Set<string>; parts: Set<string>;
}
export class Names {
  private db: DB; private orgId: string;
  svcs = new Map<string, SvcRow>(); srvs = new Map<string, string>(); prjs = new Map<string, string>(); envs = new Map<string, string>();
  people = new Set<string>();
  constructor(db: DB, orgId: string) {
    this.db = db; this.orgId = orgId;
    for (const s of all<SvcRow>(db, 'SELECT id, name, server_id, project_id, environment_id, current_deployment_id FROM services WHERE org_id = ?', orgId)) this.svcs.set(s.id, s);
    for (const s of all<{ id: string; name: string }>(db, 'SELECT id, name FROM servers WHERE org_id = ?', orgId)) this.srvs.set(s.id, s.name);
    for (const p of all<{ id: string; name: string }>(db, 'SELECT id, name FROM projects WHERE org_id = ?', orgId)) this.prjs.set(p.id, p.name);
    for (const e of all<{ id: string; name: string }>(db, 'SELECT id, name FROM environments WHERE org_id = ?', orgId)) this.envs.set(e.id, e.name);
    for (const u of all<{ name: string }>(db, 'SELECT u.name FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ?', orgId)) this.people.add(u.name.toLowerCase());
  }
  svc = (id?: unknown) => (typeof id === 'string' ? this.svcs.get(id)?.name : undefined);
  srv = (id?: unknown) => (typeof id === 'string' ? this.srvs.get(id) : undefined);
  domain = (id?: unknown) => (typeof id === 'string' ? get<{ hostname: string }>(this.db, 'SELECT hostname FROM domains WHERE id = ? AND org_id = ?', id, this.orgId)?.hostname : undefined);
}

export function resolveScope(db: DB, orgId: string, sc: Scope, n = new Names(db, orgId)): Resolved {
  const kind = sc.serviceId ? 'service' : sc.projectId ? 'project' : sc.serverId ? 'server' : 'all';
  const r: Resolved = { label: 'everything', all: kind === 'all', kind, servers: new Set(), services: new Set(), projects: new Set(), envs: new Set(), hosts: new Set(), parts: new Set() };
  const addSvc = (s: SvcRow) => {
    r.services.add(s.id); r.projects.add(s.project_id); r.envs.add(s.environment_id); r.parts.add(`unit7:${s.id}`);
    if (s.server_id) r.servers.add(s.server_id);
  };
  if (sc.serviceId) { const s = n.svcs.get(sc.serviceId); if (s) { addSvc(s); r.label = s.name; } }
  else if (sc.projectId) { r.projects.add(sc.projectId); r.label = n.prjs.get(sc.projectId) ?? 'this project'; for (const s of n.svcs.values()) if (s.project_id === sc.projectId) addSvc(s); }
  else if (sc.serverId) { r.servers.add(sc.serverId); r.label = n.srv(sc.serverId) ?? 'this server'; for (const s of n.svcs.values()) if (s.server_id === sc.serverId) addSvc(s); }
  for (const id of r.services) for (const d of all<{ hostname: string }>(db, 'SELECT hostname FROM domains WHERE service_id = ? AND org_id = ?', id, orgId)) r.hosts.add(d.hostname.toLowerCase());
  // a server's own sites (Coolify apps and the like) are in its X-ray
  if (sc.serverId) {
    const inv = json<Inventory | null>(get<{ data: string }>(db, `SELECT data FROM xrays WHERE org_id = ? AND server_id = ? AND kind = 'fast' AND ok = 1 ORDER BY created_at DESC LIMIT 1`, orgId, sc.serverId)?.data, null);
    for (const p of inv?.parts ?? []) for (const h of p.hosts ?? []) r.hosts.add(h.toLowerCase());
  }
  return r;
}
// does a row with these ids belong to the scope? An app's own changes, and anything done to the server it runs on
const touches = (r: Resolved, ids: { serverId?: unknown; serviceId?: unknown; projectId?: unknown; host?: unknown; resources?: string[] }) => r.all
  || (typeof ids.serviceId === 'string' ? r.services.has(ids.serviceId)
    : (typeof ids.serverId === 'string' && r.servers.has(ids.serverId)) || (r.kind === 'project' && typeof ids.projectId === 'string' && r.projects.has(ids.projectId)))
  || (typeof ids.host === 'string' && r.hosts.has(ids.host.toLowerCase()))
  || !!ids.resources?.some((x) => r.services.has(x) || r.servers.has(x));

// --- deploys --------------------------------------------------------------------------------------------------
function deploys(db: DB, orgId: string, r: Resolved, n: Names, since: string, until: string): Item[] {
  const rows = all<{ id: string; service_id: string; number: number; status: string; triggered_by: string | null; started_at: string; finished_at: string | null; error: string | null; rollback_of: string | null }>(db,
    `SELECT id, service_id, number, status, triggered_by, started_at, finished_at, error, rollback_of FROM deployments WHERE org_id = ? AND coalesce(finished_at, started_at) >= ? AND coalesce(finished_at, started_at) <= ?
     ORDER BY started_at DESC LIMIT 300`, orgId, since, until);
  const out: Item[] = [];
  // who: the audit row that made it (it lists the deploy), else the name it was recorded under
  const byDeploy = new Map<string, AuditActor>();
  if (rows.length) for (const a of all<AuditActor & { resources: string }>(db, `SELECT actor_kind, actor_id, actor_name, agent, resources FROM audit WHERE org_id = ? AND created_at >= ? AND resources LIKE '%dep\\_%' ESCAPE '\\' ORDER BY created_at`,
    orgId, rows.at(-1)!.started_at)) for (const x of json<string[]>(a.resources, [])) if (x.startsWith('dep_') && !byDeploy.has(x)) byDeploy.set(x, a);
  for (const d of rows) {
    const s = n.svcs.get(d.service_id);
    if (!s || !touches(r, { serviceId: s.id })) continue;
    const a = byDeploy.get(d.id);
    const named = whoOfName(d.triggered_by, n.people);
    const who = named.kind === 'unit7' || named.kind === 'warden' || !a ? named : whoOfAudit(a); // a self-heal deploy is Unit7's, inside a person's
    const failed = d.status === 'failed', working = d.status === 'building' || d.status === 'deploying';
    let undo: Undo | undefined;
    if (d.id === s.current_deployment_id && d.status === 'live') {
      const prev = get<{ id: string; number: number }>(db, `SELECT id, number FROM deployments WHERE service_id = ? AND number < ? AND status IN ('stopped', 'live') AND container IS NOT NULL ORDER BY number DESC LIMIT 1`, s.id, d.number);
      if (prev) undo = { tool: 'deployment.rollback', input: { serviceId: s.id, deploymentId: prev.id }, label: `Roll back to v${prev.number}` };
    }
    out.push({
      id: `dep:${d.id}`, at: d.finished_at ?? d.started_at, kind: 'deploy', who, serviceId: s.id, projectId: s.project_id, ...(s.server_id && { serverId: s.server_id }),
      text: failed ? `Deploy v${d.number} of ${s.name} didn’t work` : working ? `Deploying v${d.number} of ${s.name}` : `Deployed v${d.number} of ${s.name}${d.rollback_of ? ' (an earlier version again)' : ''}`,
      status: failed ? 'failed' : working ? 'working' : 'ok', ...(undo && { undo }),
      ...(failed && d.error && { detail: [dedot(redact(d.error.split('\n').filter(Boolean).slice(-1)[0] ?? '').slice(0, 200))] }),
    });
  }
  return out;
}

// --- settings: names only ----------------------------------------------------------------------------------------
type ScopeType = 'org' | 'project' | 'environment' | 'service';
const scopeInput = (t: ScopeType, id: string): Record<string, unknown> => (t === 'service' ? { serviceId: id } : t === 'environment' ? { environmentId: id } : t === 'project' ? { projectId: id } : {});
function settings(db: DB, orgId: string, r: Resolved, n: Names, since: string, until: string): Item[] {
  const rows = all<{ id: string; scope_type: ScopeType; scope_id: string; key: string; version: number; created_by: string | null; created_at: string; deleted_at: string | null }>(db,
    `SELECT id, scope_type, scope_id, key, version, created_by, created_at, deleted_at FROM env_vars WHERE org_id = ? AND ((created_at >= ? AND created_at <= ?) OR (deleted_at >= ? AND deleted_at <= ?))
     ORDER BY created_at DESC LIMIT 500`, orgId, since, until, since, until);
  const inScope = (t: ScopeType, id: string) => r.all || (t === 'org' ? r.services.size > 0 : t === 'service' ? r.services.has(id) : t === 'environment' ? r.envs.has(id) : r.projects.has(id));
  const where = (t: ScopeType, id: string) => (t === 'service' ? ` for ${n.svc(id) ?? 'an app'}` : t === 'environment' ? ` for ${n.envs.get(id) ?? 'an environment'}` : t === 'project' ? ` for everything in ${n.prjs.get(id) ?? 'a project'}` : ' for every app');
  const newest = (t: ScopeType, id: string, key: string) => get<{ version: number; deleted_at: string | null }>(db, 'SELECT version, deleted_at FROM env_vars WHERE org_id = ? AND scope_type = ? AND scope_id = ? AND key = ? ORDER BY version DESC LIMIT 1', orgId, t, id, key);
  const out: Item[] = [];
  for (const v of rows) {
    if (!inScope(v.scope_type, v.scope_id)) continue;
    const ids = v.scope_type === 'service' ? { serviceId: v.scope_id, projectId: n.svcs.get(v.scope_id)?.project_id } : v.scope_type === 'project' ? { projectId: v.scope_id } : {};
    const top = newest(v.scope_type, v.scope_id, v.key);
    const base = scopeInput(v.scope_type, v.scope_id);
    if (v.created_at >= since && v.created_at <= until) {
      const current = top?.version === v.version && !top.deleted_at;
      const undo: Undo | undefined = !current ? undefined : v.version > 1
        ? { tool: 'env.restore', input: { ...base, key: v.key, version: v.version - 1 }, label: 'Put the old value back' }
        : { tool: 'env.unset', input: { ...base, key: v.key }, label: 'Remove it again' };
      out.push({ id: `env:${v.id}`, at: v.created_at, kind: 'setting', who: whoOfName(v.created_by, n.people), ...ids, text: `${v.version > 1 ? 'Changed' : 'Added'} the setting ${v.key}${where(v.scope_type, v.scope_id)}`, ...(undo && { undo }) });
    }
    if (v.deleted_at && v.deleted_at >= since && v.deleted_at <= until) {
      const a = get<AuditActor>(db, `SELECT actor_kind, actor_id, actor_name, agent FROM audit WHERE org_id = ? AND tool = 'env.unset' AND result = 'success' AND json_extract(input, '$.key') = ? AND created_at >= ? ORDER BY created_at LIMIT 1`,
        orgId, v.key, new Date(Date.parse(v.deleted_at) - 10_000).toISOString());
      const back = top?.version === v.version && !!top.deleted_at;
      out.push({ id: `env-del:${v.id}`, at: v.deleted_at, kind: 'setting', who: a ? whoOfAudit(a) : { kind: 'person', name: 'Someone' }, ...ids, text: `Removed the setting ${v.key}${where(v.scope_type, v.scope_id)}`,
        ...(back && { undo: { tool: 'env.restore', input: { ...base, key: v.key, version: v.version }, label: 'Bring it back' } }) });
    }
  }
  return out;
}
// an import or a copy changes many settings at once: one line, the single ones inside it
export function groupSettings(items: Item[], withinMs = 10_000): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    const last = out.at(-1);
    const lead = last?.children?.[0] ?? last;
    const where = (x: Item) => x.text.replace(/^.*? the setting \S+/, '');
    if (last && lead && it.kind === 'setting' && lead.kind === 'setting' && it.who.name === lead.who.name && where(it) === where(lead) && Math.abs(Date.parse(it.at) - Date.parse(lead.at)) <= withinMs) {
      const kids = last.children ?? [last];
      kids.push(it);
      const keys = kids.map((k) => /the setting (\S+)/.exec(k.text)?.[1] ?? '?');
      out[out.length - 1] = { ...lead, id: `grp:${lead.id}`, children: kids, undo: undefined,
        text: `Changed ${kids.length} settings${where(lead)}: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` and ${keys.length - 3} more` : ''}` };
    } else out.push(it);
  }
  return out;
}

// --- changes Unit7 made on servers (with their undo) ---------------------------------------------------------------
const partName = (p: string) => p.replace(/^(stack:.*:|[a-z0-9]+:)/, '').replace(/\.service$/, '');
function changes(db: DB, orgId: string, r: Resolved, n: Names, since: string, until: string): Item[] {
  const rows = all<{ id: string; server_id: string; part: string; verb: string; summary: string; status: string; actor: string | null; note: string | null; created_at: string; undone_at: string | null }>(db,
    `SELECT id, server_id, part, verb, summary, status, actor, note, created_at, undone_at FROM changes WHERE org_id = ? AND ((created_at >= ? AND created_at <= ?) OR (undone_at >= ? AND undone_at <= ?))
     ORDER BY created_at DESC LIMIT 300`, orgId, since, until, since, until);
  const out: Item[] = [];
  for (const c of rows) {
    if (!(r.all || (r.kind === 'server' ? r.servers.has(c.server_id) : r.parts.has(c.part)))) continue;
    const kind: Kind = c.verb === 'update' ? 'deploy' : c.verb === 'env' ? 'setting' : c.verb === 'restart' || c.verb === 'start' ? 'restart' : 'change';
    if (c.created_at >= since && c.created_at <= until) {
      const back = c.status === 'rolled_back';
      out.push({ id: `chg:${c.id}`, at: c.created_at, kind, who: whoOfName(c.actor, n.people), serverId: c.server_id,
        text: `${cap(dedot(c.summary))}${back ? '. It wasn’t healthy after, so Unit7 put it back' : ''}`, status: back || c.status === 'undone' ? 'undone' : 'ok',
        ...(c.status === 'done' && c.verb !== 'backup' && { undo: { tool: 'change.undo', input: { changeId: c.id }, label: 'Undo' } }),
        detail: [`On ${n.srv(c.server_id) ?? 'a server'}: ${partName(c.part)}`, ...(c.note ? [c.note] : [])] });
    }
    if (c.undone_at && c.undone_at >= since && c.undone_at <= until) {
      const a = get<AuditActor>(db, `SELECT actor_kind, actor_id, actor_name, agent FROM audit WHERE org_id = ? AND tool = 'change.undo' AND result = 'success' AND json_extract(input, '$.changeId') = ? LIMIT 1`, orgId, c.id);
      out.push({ id: `undo:${c.id}`, at: c.undone_at, kind: 'change', who: a ? whoOfAudit(a) : { kind: 'unit7', name: 'Unit7' }, serverId: c.server_id, text: `Took back: ${dedot(c.summary)}` });
    }
  }
  return out;
}

// --- everything else a person, an AI or Warden did, from the audit trail ------------------------------------------
// covered by their own source above, or not a change to anything people run
const SKIP = new Set(['deployment.create', 'service.sync_git', 'service.sync_previews', 'env.set', 'env.unset', 'env.import', 'env.restore', 'env.copy', 'change.undo',
  'memory.remember', 'memory.forget', 'errors.resolve', 'backup.create', 'backup.prune', 'backup.offsite_copy', 'backup.verify', 'backup.offsite_set', 'backup.folder_set',
  'sync.schedule', 'security.note', 'watch.settings', 'server.price', 'job.run', 'alerts.phone_approvals', 'asset.archive', 'security.fix_settings', 'security.weekly', 'alerts.phone_confirm']);
const isPart = (t: string) => (t.startsWith('part.') && t !== 'part.adopt') || /^file\.(write|upload|move|remove)$/.test(t); // their changes rows say it, with the undo
const KIND_OF: [RegExp, Kind][] = [
  [/^deployment\.rollback$/, 'rollback'], [/^(domain|coolify\.set_domain)/, 'dns'], [/^link\./, 'link'], [/^(security\.|server\.(harden|close_port|protect_sites)|shield\.)/, 'security'],
  [/^(service\.restart|docker\.restart)$/, 'restart'], [/^(server\.|docker\.prune|hostinger\.)/, 'server'], [/^coolify\.control$/, 'deploy'],
  [/^(service\.(settings|scale|autoscale|cache_static|add_worker)|database\.(pool|rotate_password))$/, 'change'],
];
const kindOf = (tool: string, input: Record<string, unknown>): Kind =>
  tool === 'coolify.control' && (input.action === 'start' || input.action === 'restart') ? 'restart' : tool === 'coolify.control' && input.action !== 'deploy' && input.action !== 'rollback' ? 'change' : KIND_OF.find(([re]) => re.test(tool))?.[1] ?? 'other';
const logoOf = (tool: string) => (tool.startsWith('coolify.') ? 'coolify' : tool.startsWith('hostinger.') ? 'hostinger' : tool === 'domain.move_dns' ? 'cloudflare' : tool.startsWith('security.') && tool.endsWith('_pr') ? 'github' : undefined);

type Said = (i: Record<string, any>, o: Record<string, any>, n: Names, part: (serverId: unknown, uuid: unknown) => string | undefined) => string;
const SAID: Record<string, Said> = {
  'deployment.rollback': (i, o, n) => `Rolled ${n.svc(i.serviceId) ?? 'an app'} back to v${o.number ?? '?'}`,
  'service.restart': (i, _o, n) => `Restarted ${n.svc(i.serviceId) ?? 'an app'}`,
  'service.stop': (i, _o, n) => `Stopped ${n.svc(i.serviceId) ?? 'an app'}`,
  'service.scale': (i, _o, n) => `Set ${n.svc(i.serviceId) ?? 'an app'} to run ${plural(Number(i.replicas) || 1, 'copy').replace('copys', 'copies')}`,
  'service.autoscale': (i, _o, n) => `Turned ${i.on ? 'on' : 'off'} autoscaling for ${n.svc(i.serviceId) ?? 'an app'}`,
  'service.settings': (i, _o, n) => `Changed how ${n.svc(i.serviceId) ?? 'an app'} builds and runs`,
  'service.cache_static': (i, _o, n) => `Turned on caching of build files for ${n.svc(i.serviceId) ?? 'an app'}`,
  'service.add_worker': (i, _o, n) => `Added a background worker to ${n.svc(i.serviceId) ?? 'an app'}`,
  'service.create': (i) => `Added the app ${i.name ?? ''}`.trim(),
  'service.remove': (i, _o, n) => `Removed ${n.svc(i.serviceId) ?? 'an app'}`,
  'docker.restart': (i, _o, n) => `Restarted ${i.container ?? 'a container'} on ${n.srv(i.serverId) ?? 'a server'}`,
  'docker.prune': (i, _o, n) => `Freed disk space on ${n.srv(i.serverId) ?? 'a server'}`,
  'domain.point': (i, _o, n) => `Pointed ${i.hostname ?? 'a domain'} at ${n.svc(i.serviceId) ?? 'an app'}`,
  'domain.remove': (i, _o, n) => `Removed the domain ${n.domain(i.domainId) ?? ''}`.trim(),
  'domain.move_dns': (i) => `Moved ${i.domain ?? 'a domain'}’s DNS to Cloudflare`,
  'domain.protect_email': (i) => `Protected ${i.domain ?? 'a domain'}’s email`,
  'domain.renew_https': (i, _o, n) => `Renewed the HTTPS certificate of ${n.domain(i.domainId) ?? 'a domain'}`,
  'coolify.control': (i, _o, n, part) => `${({ start: 'Started', stop: 'Stopped', restart: 'Restarted', deploy: 'Deployed', cancel: 'Cancelled a deploy of', rollback: 'Rolled back' } as Record<string, string>)[i.action] ?? 'Changed'} ${part(i.serverId, i.uuid) ?? 'an app'} through Coolify`,
  'coolify.set_domain': (i, _o, _n, part) => `Gave ${part(i.serverId, i.uuid) ?? 'an app'} the domain ${(i.domains ?? [])[0] ?? ''} in Coolify`.trim(),
  'shield.block': (i, _o, n) => `Blocked ${i.ip} on ${n.srv(i.serverId) ?? 'a server'}`,
  'shield.unblock': (i, _o, n) => `Unblocked ${i.ip} on ${n.srv(i.serverId) ?? 'a server'}`,
  'server.close_port': (i, _o, n) => `${i.open ? 'Opened' : 'Closed'} port ${i.port} on ${n.srv(i.serverId) ?? 'a server'}`,
  'server.harden': (i, _o, n) => `Locked down ${n.srv(i.serverId) ?? 'a server'}`,
  'server.protect_sites': (i, _o, n) => `Hid secret files on every site on ${n.srv(i.serverId) ?? 'a server'}`,
  'server.swap': (i, _o, n) => `${i.off ? 'Removed swap from' : 'Added swap to'} ${n.srv(i.serverId) ?? 'a server'}`,
  'server.tidy_logs': (i, _o, n) => `Tidied up logs on ${n.srv(i.serverId) ?? 'a server'}`,
  'server.time_sync': (i, _o, n) => `Turned on time sync on ${n.srv(i.serverId) ?? 'a server'}`,
  'server.repair': (i, _o, n) => `Fixed a problem on ${n.srv(i.serverId) ?? 'a server'}`,
  'link.sync': () => 'Re-synced a connection', 'link.create': () => 'Connected two things', 'link.remove': () => 'Removed a connection',
  'link.rotate': () => 'Changed a connection’s key', 'link.retire_previous': () => 'Retired a connection’s old key', 'link.autoconnect': () => 'Connected what belongs together',
  'security.fix_pr': (i, _o, n) => `Opened a pull request fixing vulnerable packages in ${n.svc(i.serviceId) ?? 'an app'}`,
  'security.merge_fix': (i, _o, n) => `Merged the vulnerability fix for ${n.svc(i.serviceId) ?? 'an app'}`,
  'deployment.pin_pr': (i, _o, n) => `Opened a pull request pinning the build tools of ${n.svc(i.serviceId) ?? 'an app'}`,
  'deployment.merge_pin': (i, _o, n) => `Merged the pull request pinning the build tools of ${n.svc(i.serviceId) ?? 'an app'}`,
  'backup.restore': (i, _o, n) => `Restored a backup${n.svc(i.serviceId) ? ` of ${n.svc(i.serviceId)}` : ''}`,
  'database.pool': (i, _o, n) => `Turned connection sharing ${i.on ? 'on' : 'off'} for ${n.svc(i.serviceId) ?? 'a database'}`,
  'database.rotate_password': (i, _o, n) => `Changed the password of ${n.svc(i.serviceId) ?? 'a database'}`,
  'autopilot.set': (i) => (i.paused ? 'Paused Autopilot' : 'Resumed Autopilot'),
};
function audited(db: DB, orgId: string, r: Resolved, n: Names, since: string, until: string): Item[] {
  const rows = all<AuditActor & { id: string; tool: string; input: string; output: string | null; project_id: string | null; created_at: string; resources: string }>(db,
    `SELECT id, actor_kind, actor_id, actor_name, agent, tool, input, output, project_id, created_at, resources FROM audit
     WHERE org_id = ? AND result = 'success' AND risk != 'read' AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 600`, orgId, since, until);
  const parts = new Map<string, Inventory | null>();
  const part = (serverId: unknown, uuid: unknown) => {
    if (typeof serverId !== 'string') return undefined;
    if (!parts.has(serverId)) parts.set(serverId, json<Inventory | null>(get<{ data: string }>(db, `SELECT data FROM xrays WHERE org_id = ? AND server_id = ? AND kind = 'fast' AND ok = 1 ORDER BY created_at DESC LIMIT 1`, orgId, serverId)?.data, null));
    return parts.get(serverId)?.parts.find((p) => p.coolify?.uuid === uuid)?.name;
  };
  const out: Item[] = [];
  for (const a of rows) {
    if (SKIP.has(a.tool) || isPart(a.tool) || a.tool.startsWith('ui.') || a.tool.startsWith('story.')) continue;
    const i = json<Record<string, any>>(a.input, {}), o = json<Record<string, any>>(a.output, {});
    const res = json<string[]>(a.resources, []);
    if (!touches(r, { serverId: i.serverId, serviceId: i.serviceId, projectId: a.project_id ?? i.projectId, host: i.hostname, resources: res })) continue;
    const say = SAID[a.tool];
    const t = getTool(a.tool);
    const svcOf = typeof i.serviceId === 'string' ? n.svcs.get(i.serviceId) : undefined;
    const text = say ? say(i, o && typeof o === 'object' ? o : {}, n, part) : `${t?.title ?? a.tool}${svcOf ? `: ${svcOf.name}` : typeof i.serverId === 'string' && n.srv(i.serverId) ? `: ${n.srv(i.serverId)}` : ''}`;
    const by = approvedBy(a.actor_name);
    const undo: Undo | undefined = a.tool === 'shield.block' && typeof i.serverId === 'string' && typeof i.ip === 'string' ? { tool: 'shield.unblock', input: { serverId: i.serverId, ip: i.ip }, label: 'Unblock' } : undefined;
    out.push({ id: `aud:${a.id}`, at: a.created_at, kind: kindOf(a.tool, i), who: whoOfAudit(a), text, ...(logoOf(a.tool) && { logo: logoOf(a.tool) }),
      ...(typeof i.serverId === 'string' && { serverId: i.serverId }), ...(svcOf && { serviceId: svcOf.id, projectId: svcOf.project_id }), ...(undo && { undo }),
      ...(by && { detail: [`Approved by ${by}`] }) });
  }
  return out;
}

// --- approvals a person decided -------------------------------------------------------------------------------
function approvals(db: DB, orgId: string, r: Resolved, n: Names, since: string, until: string): Item[] {
  const rows = all<{ id: string; tool: string; input: string; actor: string; status: string; decided_by: string | null; decided_at: string; environment_id: string | null }>(db,
    `SELECT id, tool, input, actor, status, decided_by, decided_at, environment_id FROM approvals WHERE org_id = ? AND decided_at >= ? AND decided_at <= ? AND decided_by IS NOT NULL ORDER BY decided_at DESC LIMIT 200`, orgId, since, until);
  const out: Item[] = [];
  for (const a of rows) {
    const i = viewInput(a.input) as Record<string, unknown>;
    if (!touches(r, { serverId: i.serverId, serviceId: i.serviceId, projectId: i.projectId, host: i.hostname })) continue;
    const title = (getTool(a.tool)?.title ?? a.tool).replace(/^\w/, (c) => c.toLowerCase());
    const actor = json<{ kind?: string; id?: string | null; name?: string; agent?: string }>(a.actor, {});
    const asked = actor.name && whoOfAudit({ actor_kind: actor.kind ?? 'user', actor_id: actor.id ?? null, actor_name: actor.name, agent: actor.agent ?? null }).name;
    const what = `${title}${n.svc(i.serviceId) ? ` (${n.svc(i.serviceId)})` : n.srv(i.serverId) ? ` (${n.srv(i.serverId)})` : ''}`;
    out.push({ id: `apr:${a.id}`, at: a.decided_at, kind: 'approval', who: { kind: 'person', name: a.decided_by! },
      text: a.status === 'rejected' ? `Said no to: ${what}` : `Approved: ${what}`, ...(asked && { detail: [`Asked by ${asked}`] }),
      ...(typeof i.serverId === 'string' && { serverId: i.serverId }), ...(typeof i.serviceId === 'string' && { serviceId: i.serviceId }) });
  }
  return out;
}

// --- what the X-ray saw change between two saved runs ---------------------------------------------------------------
const short = (image?: string) => (image ?? '?').replace(/^(docker\.io\/)?(library\/)?/, '').replace(/@sha256:[0-9a-f]{8,}$/, '');
const SEEN: Who = { kind: 'outside', name: 'Seen by the X-ray' };
export function xrayDiff(prev: Inventory, next: Inventory, serverId: string, serverName = 'the server'): Item[] {
  const system = (inv: Inventory) => new Set(inv.projects.filter((p) => p.system).map((p) => p.id));
  const sysA = system(prev), sysB = system(next);
  const keep = (sys: Set<string>) => (p: Part) => !(p.project && sys.has(p.project));
  const a = new Map(prev.parts.filter(keep(sysA)).map((p) => [p.id, p])), b = new Map(next.parts.filter(keep(sysB)).map((p) => [p.id, p]));
  const at = next.at, out: Item[] = [];
  const item = (key: string, kind: Kind, text: string, detail?: string[]): Item => ({ id: `xr:${serverId}:${at}:${key}`, at, kind, who: SEEN, text, serverId, ...(detail && { detail }) });
  for (const [id, p] of b) {
    const q = a.get(id);
    if (!q) { out.push(item(`new:${id}`, 'found', p.kind === 'domain' ? `New address on ${serverName}: ${p.name}` : `New on ${serverName}: ${p.name}`, p.image ? [`Runs ${short(p.image)}`] : undefined)); continue; }
    const coolifyDeployed = !!p.coolify?.lastDeploy?.uuid && p.coolify.lastDeploy.uuid !== q.coolify?.lastDeploy?.uuid;
    if (p.image && q.image && p.image !== q.image && !coolifyDeployed) out.push(item(`img:${id}`, 'deploy', `${p.name} now runs ${short(p.image)}`, [`It ran ${short(q.image)} before`]));
    const ca = new Set(q.containers ?? []), cb = new Set(p.containers ?? []);
    const added = [...cb].filter((c) => !ca.has(c)), gone = [...ca].filter((c) => !cb.has(c));
    // a container renamed by a redeploy (same count) isn't news; one more or one fewer is
    if (added.length !== gone.length) {
      if (added.length > gone.length) out.push(item(`ctr+:${id}`, 'found', `${p.name} has ${plural(added.length - gone.length, 'new container')}`, added.slice(0, 5)));
      else out.push(item(`ctr-:${id}`, 'found', `${p.name} has ${plural(gone.length - added.length, 'container')} fewer`, gone.slice(0, 5)));
    }
    const pa = new Set((q.ports ?? []).filter((x) => x.public).map((x) => x.port));
    for (const port of new Set((p.ports ?? []).filter((x) => x.public).map((x) => x.port))) if (!pa.has(port)) out.push(item(`port:${id}:${port}`, 'security', `${p.name} opened port ${port} to the internet`));
    const ra = q.restarts ?? 0, rb = p.restarts ?? 0;
    if (rb > ra) out.push(item(`rst:${id}`, 'restart', `${p.name} restarted ${times(rb - ra)}`));
    const up = (s?: string) => s === 'running';
    if (q.state && p.state && up(q.state) && !up(p.state)) out.push(item(`down:${id}`, 'restart', `${p.name} stopped running`, [`State: ${p.state}`]));
    if (q.state && p.state && !up(q.state) && up(p.state)) out.push(item(`up:${id}`, 'restart', `${p.name} is running again`));
  }
  for (const [id, q] of a) if (!b.has(id)) out.push(item(`gone:${id}`, 'found', `${q.name} is gone from ${serverName}`));
  // ports the server answers on from the internet, whatever owns them
  const la = new Set(prev.ports.filter((x) => x.public).map((x) => `${x.proto}:${x.port}`));
  for (const l of next.ports.filter((x) => x.public && !x.part)) if (!la.has(`${l.proto}:${l.port}`)) out.push(item(`lport:${l.proto}:${l.port}`, 'security', `Port ${l.port} opened to the internet${l.process ? ` (${l.process})` : ''}`));
  return out;
}
// Coolify's own deploys, as the X-ray read them from its API (one line per deploy, whichever run saw it)
export function coolifyDeploys(runs: Inventory[], serverId: string): Item[] {
  const seen = new Map<string, Item>();
  for (const inv of runs) for (const p of inv.parts) {
    const d = p.coolify?.lastDeploy;
    if (!d?.uuid || !d.at || seen.has(d.uuid)) continue;
    const failed = /fail|error/i.test(d.status ?? ''), working = /queued|progress/i.test(d.status ?? '');
    seen.set(d.uuid, { id: `cdep:${d.uuid}`, at: new Date(d.at).toISOString(), kind: 'deploy', logo: 'coolify', who: { kind: 'outside', name: 'Coolify' }, serverId,
      text: failed ? `Coolify’s deploy of ${p.name} didn’t work` : working ? `Coolify is deploying ${p.name}` : `Coolify deployed ${p.name}${d.commit ? ` (commit ${d.commit.slice(0, 7)})` : ''}`,
      status: failed ? 'failed' : working ? 'working' : 'ok' });
  }
  return [...seen.values()];
}
const XRAY_RUNS = 60; // ponytail: the newest 60 saved runs per server in range; a daily frame when timelines span months
// saved runs never change, so what one pair of them says is worked out once (parsing a run is the slow part)
const seenLines = new Map<string, Item[]>();
const remember = (key: string, make: () => Item[]) => { if (seenLines.size > 4000) seenLines.clear(); let v = seenLines.get(key); if (!v) seenLines.set(key, (v = make())); return v; };
function xrays(db: DB, orgId: string, r: Resolved, n: Names, since: string, until: string): Item[] {
  const servers = r.all ? [...n.srvs.keys()] : [...r.servers];
  const out: Item[] = [];
  for (const serverId of servers) {
    const runs = all<{ id: string }>(db, `SELECT id FROM (SELECT id, created_at FROM xrays WHERE org_id = ? AND server_id = ? AND kind = 'fast' AND ok = 1 AND created_at <= ?
      AND created_at >= coalesce((SELECT max(created_at) FROM xrays WHERE org_id = ? AND server_id = ? AND kind = 'fast' AND ok = 1 AND created_at < ?), ?) ORDER BY created_at DESC LIMIT ?) ORDER BY created_at`,
      orgId, serverId, until, orgId, serverId, since, since, XRAY_RUNS + 1).map((x) => x.id);
    const parsed = new Map<string, Inventory | null>();
    const load = (id: string) => {
      if (!parsed.has(id)) { const inv = json<Inventory>(get<{ data: string }>(db, 'SELECT data FROM xrays WHERE id = ?', id)?.data, {} as Inventory); parsed.set(id, Array.isArray(inv.parts) ? inv : null); }
      return parsed.get(id)!;
    };
    const name = n.srv(serverId);
    const deploys = new Map<string, Item>();
    for (const id of runs) for (const it of remember(`c:${id}`, () => { const inv = load(id); return inv ? coolifyDeploys([inv], serverId) : []; })) if (!deploys.has(it.id)) deploys.set(it.id, it);
    const diffs = runs.slice(1).flatMap((id, k) => remember(`d:${runs[k]}>${id}:${name}`, () => { const a = load(runs[k]!), b = load(id); return a && b ? xrayDiff(a, b, serverId, name) : []; }));
    const found = [...deploys.values(), ...diffs];
    // an app's own timeline gets only its own parts' lines; a project's, its apps'
    const mine = (it: Item) => r.kind === 'all' || r.kind === 'server' || [...r.parts].some((p) => it.id.endsWith(`:${p}`) || it.id.includes(`:${p}:`));
    out.push(...found.filter((it) => it.at >= since && it.at <= until && mine(it)));
  }
  return out;
}

// --- the timeline ---------------------------------------------------------------------------------------------------
export function newestFirst(items: Item[]): Item[] {
  return [...items].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
}
export function gather(db: DB, orgId: string, sc: Scope, since: string, until: string, n = new Names(db, orgId)): { items: Item[]; scope: Resolved } {
  const r = resolveScope(db, orgId, sc, n);
  const items = [deploys, settings, changes, audited, approvals, xrays].flatMap((f) => f(db, orgId, r, n, since, until));
  return { items: groupSettings(newestFirst(items)), scope: r };
}

// --- the last healthy moment --------------------------------------------------------------------------------------
export interface Signal { at: string; ok: boolean; key: string; text: string; type: string }
const BAD = new Set(['site.down', 'service.down', 'service.unhealthy', 'deployment.failed', 'server.unreachable', 'domain.broken', 'app.errors']);
const GOOD = new Set(['site.recovered', 'server.recovered', 'deployment.succeeded', 'deployment.healed', 'watch.cleared']);
export function signals(db: DB, orgId: string, r: Resolved, since: string): Signal[] {
  const rows = all<{ type: string; severity: string; message: string; resource: string | null; created_at: string }>(db,
    `SELECT type, severity, message, resource, created_at FROM events WHERE org_id = ? AND created_at >= ? AND (type IN (${[...BAD, ...GOOD].map(() => '?').join(',')}) OR (type LIKE 'watch.%' AND severity = 'critical'))
     ORDER BY created_at LIMIT 2000`, orgId, since, ...BAD, ...GOOD);
  return rows.filter((e) => e.resource && (r.all || r.services.has(e.resource) || r.servers.has(e.resource) || r.hosts.has(e.resource.toLowerCase())))
    .map((e) => ({ at: e.created_at, ok: GOOD.has(e.type), key: e.resource!.toLowerCase(), text: e.message, type: e.type }));
}
// The newest failure in the scope: since when it's been failing, the last moment it was known to work before that, and
// whether it has recovered. lastOk: the site checks' last good answer per address. With nothing earlier to go by, the
// six hours before the failure stand in (guessed).
export function lastHealthy(sig: Signal[], lastOk: Record<string, string> = {}, guessMs = 6 * HOUR): Health {
  const s = [...sig].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const bi = s.findLastIndex((x) => !x.ok);
  if (bi < 0) return { state: 'ok' };
  const b = s[bi]!, key = b.key;
  let first = b;
  for (let k = bi - 1; k >= 0; k--) { const x = s[k]!; if (x.key !== key) continue; if (x.ok) break; first = x; }
  const recovered = s.slice(bi + 1).find((x) => x.key === key && x.ok);
  const goodBefore = s.filter((x) => x.key === key && x.ok && x.at < first.at).at(-1)?.at;
  const ok = lastOk[key] && lastOk[key]! < first.at ? lastOk[key] : undefined;
  const healthyAt = [ok, goodBefore].filter(Boolean).sort().at(-1);
  return {
    state: recovered ? 'ok' : 'failing', failingSince: first.at, what: first.text, ...(recovered && { recoveredAt: recovered.at }),
    ...(healthyAt ? { healthyAt } : { healthyAt: new Date(Date.parse(first.at) - guessMs).toISOString(), guessed: true }),
  };
}
// the change most likely to blame: the newest one between the healthy moment and the failure, a deploy first.
// Symptoms (restarts, a container stopping) and decisions (an approval, which shows as its own change) never count.
const SYMPTOM = new Set<Kind>(['restart', 'approval']);
export function pickCulprit(items: Item[], healthyAt: string, failingSince: string): Item | undefined {
  const window = items.filter((it) => it.at >= healthyAt && it.at <= failingSince && !SYMPTOM.has(it.kind) && it.status !== 'failed' && it.status !== 'undone');
  const newest = (xs: Item[]) => xs.sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  return newest(window.filter((it) => it.kind === 'deploy' || it.kind === 'rollback')) ?? newest([...window]);
}

export interface Timeline { scope: { label: string } & Scope; since: string; until: string; items: Item[]; health?: Health; culpritId?: string; mode: 'all' | 'since-healthy'; leadMinutes?: number }
// a site check runs every few minutes and a change can take a moment to break things: the minutes just before the
// last good answer count too
export const LEAD_MS = 10 * MIN;
export function timeline(db: DB, orgId: string, sc: Scope, o: { since?: string; until?: string; untilHealthy?: boolean; limit?: number; now?: number } = {}): Timeline {
  const nowMs = o.now ?? Date.now();
  const until = o.until ?? new Date(nowMs).toISOString();
  const n = new Names(db, orgId);
  const r = resolveScope(db, orgId, sc, n);
  let since = o.since ?? new Date(nowMs - 7 * 86400_000).toISOString();
  let health: Health | undefined;
  if (o.untilHealthy) {
    const lastOk = Object.fromEntries(all<{ host: string; last_ok: string | null }>(db, `SELECT host, last_ok FROM watch WHERE org_id = ? AND kind = 'site' AND last_ok IS NOT NULL`, orgId)
      .filter((w) => r.all || r.hosts.has(w.host.toLowerCase())).map((w) => [w.host.toLowerCase(), w.last_ok!]));
    health = lastHealthy(signals(db, orgId, r, new Date(nowMs - 30 * 86400_000).toISOString()), lastOk);
    if (health.healthyAt && (health.state === 'failing' || !o.since)) since = health.guessed ? health.healthyAt : new Date(Date.parse(health.healthyAt) - LEAD_MS).toISOString();
  }
  const { items } = gather(db, orgId, sc, since, until, n);
  let culpritId: string | undefined;
  if (health?.healthyAt && health.failingSince) culpritId = pickCulprit(items, since < health.healthyAt ? since : health.healthyAt, health.failingSince)?.id;
  // marked on a copy: the X-ray's lines are shared between calls
  const shown = items.slice(0, o.limit ?? 200).map((it) => (it.id === culpritId ? { ...it, culprit: true } : it));
  return { scope: { label: r.label, ...sc }, since, until, items: shown, mode: o.untilHealthy ? 'since-healthy' : 'all', ...(health && { health }), ...(culpritId && { culpritId }),
    ...(health?.healthyAt && !health.guessed && o.untilHealthy && { leadMinutes: LEAD_MS / MIN }) };
}
