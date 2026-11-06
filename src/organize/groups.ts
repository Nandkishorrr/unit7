// Group what belongs together. A Vercel site, its Supabase database, its domain, its repo and a Coolify app with the same
// name are really one product: Unit7 groups them into one, with one name and one health (its worst member) everywhere.
// Evidence, strongest first: wiring (a setting that points at the database, a connection Unit7 made), DNS (a domain
// pointing at the app), the same git repo, and last a similar name. A person accepts, renames or trims a suggestion; at
// Full autopilot Unit7 groups the very sure ones (wiring and DNS both) by itself, with an undo. Members are map asset ids
// (stable across syncs) or Unit7 project ids, so a re-scan keeps every group.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import { defineTool, execute, type Actor, type Ctx } from '../tools/runtime.ts';
import { all, get, id, json, run, tx, type DB } from '../db.ts';
import { Unit7Error, notFound } from '../errors.ts';
import { archivedAssets, assetIdOf } from '../archive.ts';
import { fid } from '../tools/helpers.ts';
import type { Suggestion } from '../suggestions.ts';

export type Signal = 'env' | 'dns' | 'repo' | 'name';
export const STRENGTH: Record<Signal, number> = { env: 4, dns: 3, repo: 2, name: 1 };
export interface Thing { key: string; name: string; kind: string; provider: string; logo: string; repo?: string; zone?: string }
// one piece of evidence that a and b belong together, and how each end would say it
export interface Link { a: string; b: string; signal: Signal; why: { a: string; b: string } }
export interface Item { key: string; name: string; kind: string; provider: string; logo: string; signal: Signal; reason: string }
export interface GroupSuggestion { id: string; name: string; confidence: 'strong' | 'good' | 'maybe'; signals: Signal[]; items: Item[]; into?: { id: string; name: string } }

const KEY = /^(ast|prj)_[A-Za-z0-9_-]{12}$/;
const hash = (s: string) => createHash('sha256').update(s).digest('base64url').slice(0, 12);
// the id of a suggestion: what it would group (and into which product), so a "no" sticks to exactly that
export const suggestionId = (keys: string[], into = '') => `sug_${hash(`${[...keys].sort().join('\n')}\n${into}`)}`;

// --- names: "harbor-web", "Harbor DB" and harbor.example are all "harbor" ----------------------------------------
const GENERIC = new Set(['www', 'app', 'apps', 'web', 'site', 'api', 'db', 'database', 'data', 'prod', 'production', 'staging', 'stage', 'dev',
  'development', 'preview', 'test', 'main', 'frontend', 'front', 'backend', 'back', 'server', 'service', 'svc', 'worker', 'admin', 'dashboard',
  'my', 'the', 'new', 'old', 'supabase', 'postgres', 'postgresql', 'pg', 'redis', 'mysql', 'mongo', 'neon', 'vercel', 'netlify', 'coolify',
  'docker', 'next', 'nextjs', 'react', 'vite', 'project', 'default', 'live', 'cloud', 'hosting', 'static', 'mail', 'email']);
const word = (t: string) => t.length >= 4 && !GENERIC.has(t) && !/^\d+$|^v\d+$/.test(t);
export function stemOf(t: Pick<Thing, 'name' | 'kind' | 'zone'>): string | undefined {
  const n = t.name.toLowerCase().trim();
  if (t.kind === 'domain') {
    if (/\.(sslip|nip)\.io$/.test(n)) return undefined; // an instant address: a machine's name, not a product's
    // a subdomain is named by its own label (blog.example.com is "blog"), else by the domain's ("staging-api.harbor.example" is "harbor")
    const zone = t.zone && (n === t.zone || n.endsWith(`.${t.zone}`)) ? t.zone : undefined;
    const labels = zone ? [...(n === zone ? [] : n.slice(0, -zone.length - 1).split('.')), zone.split('.')[0]!] : n.split('.').slice(0, -1);
    return labels.map(tokens).find(word);
  }
  const stem = tokens(n);
  return stem.length >= 4 ? stem : undefined;
}
const tokens = (s: string) => s.split(/[^a-z0-9]+/).filter((x) => x && !GENERIC.has(x) && !/^\d+$|^v\d+$/.test(x)).join('');

// "git@github.com:Sam/Harbor.git", "https://github.com/sam/harbor" and "sam/harbor" are the same repo
export function normRepo(s?: string | null): string | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase().replace(/^git\+/, '').replace(/^(https?|ssh|git):\/\/(?:[^@/]+@)?/, '').replace(/^git@([^:/]+):/, '$1/').replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = t.split('/').filter(Boolean);
  if (parts.length === 2) return `github.com/${parts.join('/')}`; // owner/name: GitHub, as Vercel and Coolify say it
  return parts.length >= 3 && parts[0]!.includes('.') ? parts.slice(0, 3).join('/') : undefined;
}

// --- the detector, pure: things and evidence in, ranked suggestions out ----------------------------------------------------
// members: what's already grouped (key -> product); groupNames: product -> name; skips: what people said no to
// (`${product}|${key}` for a member taken out, and suggestion ids)
export function detect(things: Thing[], evidence: Link[], o: { members?: Map<string, string>; groupNames?: Map<string, string>; skips?: Set<string> } = {}): GroupSuggestion[] {
  const by = new Map(things.map((t) => [t.key, t]));
  const members = o.members ?? new Map<string, string>(), skips = o.skips ?? new Set<string>();
  const links = [...evidence];
  // the same repo, and the same name: each thing linked to the first one that has it
  const chain = (signal: Signal, keyOf: (t: Thing) => string | undefined, why: (other: Thing, v: string) => string) => {
    const seen = new Map<string, Thing>();
    for (const t of things) {
      const v = keyOf(t);
      if (!v) continue;
      const first = seen.get(v);
      if (!first) { seen.set(v, t); continue; }
      links.push({ a: t.key, b: first.key, signal, why: { a: why(first, v), b: why(t, v) } });
    }
  };
  chain('repo', (t) => t.repo, (_o, v) => `deploys from the same code (${v.replace(/^github\.com\//, '')})`);
  chain('name', stemOf, (other) => `has the same name as ${other.name}`);

  // a thing someone took out of a product never goes back in by itself
  const refused = (k: string, g?: string) => !!g && skips.has(`${g}|${k}`);
  const ok = links.filter((l) => l.a !== l.b && by.has(l.a) && by.has(l.b) && !refused(l.a, members.get(l.b)) && !refused(l.b, members.get(l.a)));
  ok.sort((x, y) => STRENGTH[y.signal] - STRENGTH[x.signal]); // strong evidence joins things first

  // union-find; one product per component at most (two products never merge), and never with a thing it refused
  const parent = new Map<string, string>(things.map((t) => [t.key, t.key]));
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
  const comp = new Map<string, { group?: string; keys: Set<string> }>(things.map((t) => [t.key, { group: members.get(t.key), keys: new Set([t.key]) }]));
  const join = (a: string, b: string) => { // false when they may not be one product
    const ra = find(a), rb = find(b);
    if (ra === rb) return true;
    const A = comp.get(ra)!, B = comp.get(rb)!;
    if (A.group && B.group && A.group !== B.group) return false;
    const g = A.group ?? B.group;
    if (g && [...(A.group ? B : A).keys].some((k) => refused(k, g))) return false;
    parent.set(ra, rb);
    for (const x of A.keys) B.keys.add(x);
    B.group = g;
    return true;
  };
  const firstOf = new Map<string, string>(); // each product's members start as one
  for (const [k, g] of members) { if (!by.has(k)) continue; const f = firstOf.get(g); if (f) join(k, f); else firstOf.set(g, k); }
  const used = ok.filter((l) => join(l.a, l.b));

  const out: GroupSuggestion[] = [];
  const roots = new Set(things.map((t) => find(t.key)));
  for (const r of roots) {
    const c = comp.get(r)!;
    const fresh = [...c.keys].filter((k) => !members.has(k));
    if (!fresh.length || c.keys.size < 2) continue;
    if (!c.group && fresh.every((k) => by.get(k)!.kind === 'domain')) continue; // domains alone are a zone, not a product
    const inside = used.filter((l) => c.keys.has(l.a));
    const items: Item[] = fresh.map((k) => {
      const best = inside.filter((l) => l.a === k || l.b === k).sort((x, y) => STRENGTH[y.signal] - STRENGTH[x.signal])[0]!;
      const t = by.get(k)!;
      return { key: k, name: t.name, kind: t.kind, provider: t.provider, logo: t.logo, signal: best.signal, reason: best.a === k ? best.why.a : best.why.b };
    }).sort((x, y) => STRENGTH[y.signal] - STRENGTH[x.signal] || x.name.localeCompare(y.name));
    const signals = [...new Set(inside.map((l) => l.signal))].sort((x, y) => STRENGTH[y] - STRENGTH[x]);
    const into = c.group ? { id: c.group, name: o.groupNames?.get(c.group) ?? 'a product' } : undefined;
    const sid = suggestionId(fresh, into?.id);
    if (skips.has(sid)) continue;
    const confidence = signals.includes('env') && signals.includes('dns') ? 'strong' : STRENGTH[signals[0]!] >= STRENGTH.repo ? 'good' : 'maybe';
    out.push({ id: sid, name: into?.name ?? nameFor(fresh.map((k) => by.get(k)!)), confidence, signals, items, ...(into && { into }) });
  }
  return out.sort((x, y) => STRENGTH[y.signals[0]!] - STRENGTH[x.signals[0]!] || y.signals.length - x.signals.length || y.items.length - x.items.length || x.name.localeCompare(y.name));
}

// a domain names a product best ("harbor.example" is harbor), then the name most of them share, then its app
function nameFor(ts: Thing[]): string {
  const dom = ts.filter((t) => t.kind === 'domain').map(stemOf).find(Boolean);
  const count = new Map<string, number>();
  for (const s of ts.map(stemOf).filter(Boolean) as string[]) count.set(s, (count.get(s) ?? 0) + 1);
  const stem = dom ?? [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!stem) return (ts.find((t) => t.kind === 'app') ?? ts[0]!).name;
  // said the way a person wrote it ("north-star-shop"), unless every way has an extra word in it ("orbit-web" is "orbit")
  return ts.filter((t) => t.kind !== 'domain' && stemOf(t) === stem && t.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).every((x) => !GENERIC.has(x)))
    .map((t) => t.name).sort((a, b) => a.length - b.length)[0] ?? stem;
}

// Sure enough to group without asking (Full autopilot): its wiring and its DNS agree, and nothing in it is there by name alone
export const autoReady = (s: GroupSuggestion) => s.confidence === 'strong' && !s.into && s.items.every((i) => i.signal === 'env' || i.signal === 'dns');

// --- what's on the map, as things and evidence ------------------------------------------------------------------------
interface AssetRow { id: string; provider: string; kind: string; ext_id: string; name: string; meta: string }
interface Meta { project?: string; system?: boolean; zone?: string; dns?: string; repo?: string; end?: Record<string, unknown>; product?: { id: string }; server?: string }
// the logo a thing shows: a known app's own (Supabase on a server), a domain's DNS host, else its provider's
export const logoOf = (a: { provider: string; kind: string }, m: { product?: { id: string }; dns?: string }) => m.product?.id ?? (a.kind === 'domain' ? m.dns ?? 'domain' : a.provider);
const endKey = (e?: Record<string, unknown>) => (e?.kind ? JSON.stringify(Object.keys(e).sort().map((k) => [k, e[k]])) : undefined);

// The org's products as they stand, and how a map thing counts for grouping ("up"): a Unit7 app is its project, a part
// inside a server project is that project, servers (shared) and leftover volumes and jobs count as nothing.
export function index(db: DB, orgId: string, o: { withArchived?: boolean } = {}) {
  const off = o.withArchived ? new Set<string>() : archivedAssets(db, orgId);
  const rows = all<AssetRow>(db, 'SELECT id, provider, kind, ext_id, name, meta FROM assets WHERE org_id = ?', orgId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const metas = new Map<string, Meta>();
  const meta = (a: AssetRow) => { let m = metas.get(a.id); if (!m) metas.set(a.id, (m = json<Meta>(a.meta, {}))); return m; };
  const services = all<{ id: string; project_id: string; repo: string | null }>(db, `SELECT id, project_id, json_extract(config, '$.source.repo') repo FROM services WHERE org_id = ?`, orgId);
  const svcProject = new Map(services.map((s) => [s.id, s.project_id]));
  const projects = new Map(all<{ id: string; name: string; repo: string | null }>(db, 'SELECT id, name, repo FROM projects WHERE org_id = ?', orgId).map((p) => [p.id, p]));
  const up = (aid: string): string | undefined => {
    const a = byId.get(aid);
    if (!a || off.has(aid) || a.kind === 'server') return undefined;
    if (a.provider === 'unit7' && svcProject.has(a.ext_id)) { const p = svcProject.get(a.ext_id)!; return off.has(p) ? undefined : p; }
    const m = meta(a);
    if (m.project) { const p = assetIdOf(orgId, m.project); return p !== aid && byId.has(p) ? up(p) : undefined; }
    if ((a.kind === 'project' && m.system) || a.kind === 'volume' || a.kind === 'job') return undefined;
    return aid;
  };
  const groups = new Map(all<{ id: string; name: string; auto: number; created_at: string }>(db, 'SELECT id, name, auto, created_at FROM product_groups WHERE org_id = ? ORDER BY name COLLATE NOCASE', orgId).map((g) => [g.id, g]));
  const members = new Map(all<{ key: string; group_id: string }>(db, 'SELECT key, group_id FROM group_members WHERE org_id = ?', orgId).map((m) => [m.key, m.group_id]));
  return { off, rows, byId, meta, up, services, svcProject, projects, groups, members };
}
export type Index = ReturnType<typeof index>;

export function gather(db: DB, orgId: string, ix: Index = index(db, orgId)): { things: Thing[]; links: Link[] } {
  const things = new Map<string, Thing>();
  for (const p of ix.projects.values()) if (!ix.off.has(p.id)) things.set(p.id, { key: p.id, name: p.name, kind: 'project', provider: 'unit7', logo: 'unit7', repo: normRepo(p.repo) });
  for (const a of ix.rows) {
    const k = ix.up(a.id);
    if (!k || things.has(k) || k !== a.id) continue;
    const m = ix.meta(a);
    things.set(k, { key: k, name: a.name, kind: a.kind, provider: a.provider, logo: logoOf(a, m), repo: normRepo(m.repo), ...(m.zone && { zone: m.zone }) });
  }
  // repos Unit7 knows: its own apps' git source, and what each server's X-ray read (Coolify's app settings, git folders)
  const withRepo = (k: string | undefined, r: string | null | undefined) => { const t = k && things.get(k); const n = normRepo(r); if (t && n && !t.repo) t.repo = n; };
  for (const s of ix.services) withRepo(s.project_id, s.repo);
  for (const p of all<{ server_id: string; id: string; owner: string; repo: string }>(db, `SELECT x.server_id, json_extract(p.value, '$.id') id, json_extract(p.value, '$.owner') owner,
      coalesce(json_extract(p.value, '$.coolify.repo'), json_extract(p.value, '$.git.remote')) repo FROM xrays x, json_each(x.data, '$.parts') p
      WHERE x.org_id = ? AND x.kind = 'fast' AND x.ok = 1 AND x.created_at = (SELECT max(created_at) FROM xrays y WHERE y.server_id = x.server_id AND y.kind = 'fast' AND y.ok = 1)
      AND coalesce(json_extract(p.value, '$.coolify.repo'), json_extract(p.value, '$.git.remote')) IS NOT NULL`, orgId)) {
    withRepo(ix.up(assetIdOf(orgId, `${p.owner}:${p.server_id}/${p.id}`)), p.repo);
  }

  const links: Link[] = [];
  const pair = (a: string | undefined, b: string | undefined, signal: Signal, why: (A: Thing, B: Thing) => { a: string; b: string }) => {
    const A = a && things.get(a), B = b && things.get(b);
    if (A && B && A.key !== B.key) links.push({ a: A.key, b: B.key, signal, why: why(A, B) });
  };
  for (const e of all<{ source: string; target: string; kind: string; via: string }>(db, `SELECT source, target, kind, via FROM edges WHERE org_id = ? AND kind IN ('env', 'uses', 'domain', 'dns')`, orgId)) {
    const a = ix.up(e.source), b = ix.up(e.target);
    if (e.kind === 'env') pair(a, b, 'env', (A, B) => ({ a: `its ${e.via} setting points at ${B.name}`, b: `${A.name}’s ${e.via} setting points here` }));
    else if (e.kind === 'uses') pair(a, b, 'env', (A, B) => ({ a: `talks to ${B.name} on its server`, b: `${A.name} talks to it` }));
    else pair(a, b, 'dns', (A, B) => ({ a: `points at ${B.name}`, b: `${A.name} points here` }));
  }
  // connections Unit7 made: source is what's provided (a database), target what uses it
  const byEnd = new Map<string, string>();
  for (const a of ix.rows) { const k = endKey(ix.meta(a).end); if (k) byEnd.set(k, a.id); }
  const endThing = (e: Record<string, unknown>) => (e.kind === 'unit7' && typeof e.serviceId === 'string' ? ix.svcProject.get(e.serviceId) : ix.up(byEnd.get(endKey(e) ?? '') ?? ''));
  for (const l of all<{ source: string; target: string; vars: string }>(db, 'SELECT source, target, vars FROM links WHERE org_id = ?', orgId)) {
    const key = json<{ key: string }[]>(l.vars, [])[0]?.key;
    pair(endThing(json(l.target, {})), endThing(json(l.source, {})), 'env', (A, B) => ({ a: `Unit7 connected it to ${B.name}${key ? ` (${key})` : ''}`, b: `Unit7 connected ${A.name} to it` }));
  }
  return { things: [...things.values()], links };
}

export function suggest(db: DB, orgId: string): GroupSuggestion[] {
  const ix = index(db, orgId);
  const { things, links } = gather(db, orgId, ix);
  const skips = new Set(all<{ ref: string; key: string }>(db, 'SELECT ref, key FROM group_skips WHERE org_id = ?', orgId).map((s) => (s.key ? `${s.ref}|${s.key}` : s.ref)));
  return detect(things, links, { members: ix.members, groupNames: new Map([...ix.groups].map(([k, g]) => [k, g.name])), skips });
}

// --- health: one status per product, its worst member ---------------------------------------------------------------------
export type Health = 'ok' | 'warn' | 'bad';
const RANK: Record<Health, number> = { ok: 0, warn: 1, bad: 2 };
export const worst = (a: Health, b: Health): Health => (RANK[b] > RANK[a] ? b : a);
export interface MapThing { id: string; kind: string; status?: string; site?: { status: string }; errors?: unknown; health?: { status: string } }
export function healthOf(a: MapThing, issues: string[] = []): Health {
  if (a.site?.status === 'down' || a.health?.status === 'bad' || issues.includes('critical')) return 'bad';
  if (a.site?.status === 'slow' || a.site?.status === 'flaky' || a.health?.status === 'warn' || !!a.errors || (!!a.status && /paus|error|fail|inactive|exited/i.test(a.status)) || issues.includes('warning')) return 'warn';
  return 'ok';
}
const svcHealth = (status: string): Health => (/failed|unhealthy|down|crash/.test(status) ? 'bad' : 'ok');

export interface MapGroup { id: string; name: string; auto: boolean; health: Health; members: string[]; projects: string[]; client?: { id: string; name: string; color: string | null } }
// For map.get: each asset's product (parts of a server project and Unit7's apps through what they count as), and the
// products with their one health. The Map draws each as a collapsible frame.
export function groupsForMap(db: DB, orgId: string, assets: MapThing[], issues: { severity: string; about?: string }[]): { groupOf: Map<string, string>; groups: MapGroup[] } {
  const groupOf = new Map<string, string>();
  if (!get(db, 'SELECT 1 FROM product_groups WHERE org_id = ? LIMIT 1', orgId)) return { groupOf, groups: [] }; // most maps: nothing to add
  const ix = index(db, orgId, { withArchived: true });
  const about = new Map<string, string[]>();
  for (const i of issues) if (i.about) about.set(i.about, [...(about.get(i.about) ?? []), i.severity]);
  const clients = clientOfGroups(db, orgId);
  const out = new Map<string, MapGroup>([...ix.groups.values()].map((g) => [g.id, { id: g.id, name: g.name, auto: !!g.auto, health: 'ok' as Health, members: [], projects: [], ...(clients.get(g.id) && { client: clients.get(g.id) }) }]));
  for (const a of assets) {
    const g = out.get(ix.members.get(ix.up(a.id) ?? '') ?? '');
    if (!g) continue;
    groupOf.set(a.id, g.id);
    g.members.push(a.id);
    g.health = worst(g.health, healthOf(a, about.get(a.id)));
  }
  for (const [k, gid] of ix.members) {
    const g = out.get(gid);
    if (!g || !k.startsWith('prj_') || !ix.projects.has(k)) continue;
    g.projects.push(k);
    for (const s of all<{ status: string }>(db, 'SELECT status FROM services WHERE project_id = ? AND org_id = ?', k, orgId)) g.health = worst(g.health, svcHealth(s.status));
  }
  return { groupOf, groups: [...out.values()] };
}
// map.get's answer with `group` on each asset in a product, and `groups` (left out while there are none)
export function withGroups<T extends { assets: (MapThing & Record<string, unknown>)[]; issues: { severity: string; about?: string }[] }>(db: DB, orgId: string, m: T) {
  const { groupOf, groups } = groupsForMap(db, orgId, m.assets, m.issues);
  if (!groups.length) return m; // no products: the map's shape is exactly what it was
  return { ...m, assets: m.assets.map((a) => (groupOf.has(a.id) ? { ...a, group: groupOf.get(a.id) } : a)), groups };
}
// Every product with its members (name, logo, why it's there), its one health and its client, for the Products page
export function productList(db: DB, orgId: string) {
  const ix = index(db, orgId, { withArchived: true });
  const clients = clientOfGroups(db, orgId);
  const sites = new Map(all<{ asset: string; status: string }>(db, `SELECT asset, status FROM watch WHERE org_id = ? AND kind = 'site' AND asset IS NOT NULL`, orgId).map((w) => [w.asset, w.status]));
  const rows = all<{ key: string; group_id: string; reason: string | null }>(db, 'SELECT key, group_id, reason FROM group_members WHERE org_id = ? ORDER BY created_at', orgId);
  return [...ix.groups.values()].map((g) => {
    let health: Health = 'ok';
    const members = rows.filter((r) => r.group_id === g.id).map(({ key: k, reason }) => {
      if (k.startsWith('prj_')) {
        for (const s of ix.services.filter((x) => x.project_id === k)) { const st = get<{ status: string }>(db, 'SELECT status FROM services WHERE id = ?', s.id)?.status ?? ''; health = worst(health, svcHealth(st)); }
        return { key: k, name: ix.projects.get(k)?.name ?? 'A project that’s gone', kind: 'project', provider: 'unit7', logo: 'unit7', reason };
      }
      const a = ix.byId.get(k);
      if (!a) return { key: k, name: 'Not on the map since the last sync', kind: 'gone', provider: '', logo: '', reason };
      for (const r of ix.rows) if (r.id === k || ix.up(r.id) === k) { const m = ix.meta(r) as Meta & { status?: string; health?: { status: string } }; health = worst(health, healthOf({ id: r.id, kind: r.kind, status: m.status, health: m.health, site: sites.has(r.id) ? { status: sites.get(r.id)! } : undefined })); }
      return { key: k, name: a.name, kind: a.kind, provider: a.provider, logo: logoOf(a, ix.meta(a)), reason };
    });
    return { id: g.id, name: g.name, auto: !!g.auto, createdAt: g.created_at, health, members, ...(clients.get(g.id) && { client: clients.get(g.id) }) };
  });
}
const clientOfGroups = (db: DB, orgId: string) => new Map(all<{ key: string; id: string; name: string; color: string | null }>(db,
  `SELECT m.key, c.id, c.name, c.color FROM client_members m JOIN clients c ON c.id = m.client_id WHERE m.org_id = ? AND m.key LIKE 'grp\\_%' ESCAPE '\\'`, orgId).map((r) => [r.key, { id: r.id, name: r.name, color: r.color }]));

// --- Warden and Home: suggestions in Warden's voice, and grouping the sure ones at Full autopilot ---------------------------
export function groupSuggestions(app: App, orgId: string, max = 2): Suggestion[] {
  return suggest(app.db, orgId).filter((s) => s.confidence !== 'maybe').slice(0, max).map((s) => ({
    id: `group:${s.id}`, severity: 'info',
    text: s.into ? `${s.items.map((i) => i.name).join(', ')} look${s.items.length > 1 ? '' : 's'} like part of ${s.into.name}. Add ${s.items.length > 1 ? 'them' : 'it'}?`
      : `These ${s.items.length} look like one product: ${s.name}. Group them?`,
    actions: [
      { label: s.into ? `Add to ${s.into.name}` : 'Group them', kind: 'tool', tool: 'group.accept', input: { keys: s.items.map((i) => i.key), reasons: Object.fromEntries(s.items.map((i) => [i.key, i.reason.slice(0, 200)])), ...(s.into ? { groupId: s.into.id } : { name: s.name }) }, success: s.into ? `Added to ${s.into.name}` : `Grouped as ${s.name}` },
      { label: 'Look first', kind: 'navigate', href: `/products?review=${s.id}` },
    ],
  }));
}

const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };
export async function autoGroup(app: App, orgId: string) {
  const org = get<{ autonomy: number; paused_at: string | null }>(app.db, 'SELECT autonomy, paused_at FROM orgs WHERE id = ?', orgId);
  if (!org || org.autonomy < 4 || org.paused_at) return [];
  const done: unknown[] = [];
  for (const s of suggest(app.db, orgId).filter(autoReady)) {
    const r = await execute(app, orgId, WARDEN, 'group.accept', { keys: s.items.map((i) => i.key), name: s.name, auto: true, reasons: Object.fromEntries(s.items.map((i) => [i.key, i.reason.slice(0, 200)])) },
      { reason: `Warden: ${s.name} is clearly one product (its wiring and DNS agree)` });
    if (r.status === 'ok') done.push(r.output);
  }
  return done;
}

// --- tools -------------------------------------------------------------------------------------------------------------------
const groupRow = (ctx: Ctx, groupId: string) => {
  const g = get<{ id: string; name: string; auto: number }>(ctx.db, 'SELECT id, name, auto FROM product_groups WHERE id = ? AND org_id = ?', groupId, ctx.orgId);
  if (!g) throw notFound('That product');
  return g;
};
const membersOf = (ctx: Ctx, groupId: string) => all<{ key: string; reason: string | null }>(ctx.db, 'SELECT key, reason FROM group_members WHERE group_id = ? AND org_id = ? ORDER BY created_at', groupId, ctx.orgId);
const nameOfKey = (ix: Index, k: string) => ix.projects.get(k)?.name ?? ix.byId.get(k)?.name ?? 'something';

// a key someone sent, as what it counts for (a part becomes its project); a server is refused
export function memberKey(ix: Index, k: string): string {
  if (!KEY.test(k)) throw new Unit7Error('invalid_input', 'That isn’t something on the map or a Unit7 project.');
  if (k.startsWith('prj_')) { if (!ix.projects.has(k)) throw notFound('That project'); return k; }
  const a = ix.byId.get(k);
  if (!a) throw new Unit7Error('not_found', 'That isn’t on the map any more. Sync the map and try again.', 404);
  if (a.kind === 'server') throw new Unit7Error('invalid_input', `${a.name} is a server: several products can share it, so it isn’t part of one.`);
  const u = ix.up(k);
  if (!u) throw new Unit7Error('invalid_input', `${a.name} can’t be part of a product (it’s archived, or part of the server’s own software).`);
  return u;
}
// what a client owns of it: its whole product when it's in one
export function ownerKey(ix: Index, k: string): string {
  if (k.startsWith('grp_')) { if (!ix.groups.has(k)) throw notFound('That product'); return k; }
  const m = memberKey(ix, k);
  return ix.members.get(m) ?? m;
}

const GROUP_NAME = z.string().trim().min(1).max(60);

defineTool({
  name: 'group.suggest', title: 'Find what belongs together', risk: 'read', action: 'read',
  description: 'Things across providers that look like one product (a Vercel project, its Supabase database, its domain, a Coolify app with the same name…), strongest evidence first: wiring (a setting that points at it, a connection Unit7 made), DNS, the same git repo, then a similar name. Each item says why it belongs. Also returns the existing products (members, why each is there, one health, client) and Unit7 projects (to add to one instead). Read-only; group.accept groups them.',
  input: z.object({}),
  run(ctx) {
    const ix = index(ctx.db, ctx.orgId);
    return {
      suggestions: suggest(ctx.db, ctx.orgId),
      groups: productList(ctx.db, ctx.orgId),
      projects: [...ix.projects.values()].filter((p) => !ix.off.has(p.id)).map((p) => ({ id: p.id, name: p.name, groupId: ix.members.get(p.id) })),
    };
  },
});

defineTool({
  name: 'group.accept', title: 'Group things into one product', risk: 'write', action: 'group_write',
  description: 'Make these things one product (or add them to one: groupId, or to the product a Unit7 project is in: projectId, which also joins). keys are map ids (ast_…) or Unit7 project ids (prj_…); a part inside a server project counts as that project; servers are shared, so they never join. A thing is in one product at most: one in another product moves. Returns how to undo it.',
  input: z.object({ keys: z.array(z.string().max(40)).min(1).max(100), name: GROUP_NAME.optional(), groupId: fid('grp').optional(), projectId: fid('prj').optional(),
    reasons: z.record(z.string(), z.string().max(200)).optional(), auto: z.boolean().optional().describe('Set by Warden when it groups by itself'),
    left: z.array(z.string().max(40)).max(100).optional().describe('What the person unticked: never suggested for this product again') }),
  run(ctx, i) {
    const ix = index(ctx.db, ctx.orgId);
    const keys = [...new Set([...i.keys.map((k) => memberKey(ix, k)), ...(i.projectId ? [i.projectId] : [])])];
    const target = i.groupId ?? (i.projectId ? ix.members.get(i.projectId) : undefined);
    const fresh = !target;
    const groupId = target ?? id('grp');
    const name = target ? groupRow(ctx, target).name : i.name ?? (i.projectId ? ix.projects.get(i.projectId)!.name : nameFor(keys.map((k) => ({ key: k, name: nameOfKey(ix, k), kind: ix.byId.get(k)?.kind ?? 'project', provider: '', logo: '', zone: ix.byId.get(k) && ix.meta(ix.byId.get(k)!).zone }))));
    const moved = keys.filter((k) => ix.members.has(k) && ix.members.get(k) !== groupId).map((k) => nameOfKey(ix, k));
    const added = keys.filter((k) => ix.members.get(k) !== groupId);
    tx(ctx.db, () => {
      if (fresh) run(ctx.db, 'INSERT INTO product_groups (id, org_id, name, auto, created_by) VALUES (?, ?, ?, ?, ?)', groupId, ctx.orgId, name, i.auto ? 1 : 0, ctx.actor.name);
      for (const k of keys) {
        run(ctx.db, `INSERT INTO group_members (org_id, key, group_id, reason) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET group_id = excluded.group_id, reason = excluded.reason`, ctx.orgId, k, groupId, i.reasons?.[k] ?? null);
        run(ctx.db, 'DELETE FROM group_skips WHERE org_id = ? AND ref = ? AND key = ?', ctx.orgId, groupId, k); // a person put it back
      }
      for (const k of i.left ?? []) if (KEY.test(k) && !keys.includes(k)) run(ctx.db, 'INSERT OR IGNORE INTO group_skips (org_id, ref, key) VALUES (?, ?, ?)', ctx.orgId, groupId, ix.up(k) ?? k);
      // one client per product: what a member belonged to on its own goes with the product (the product's own client wins)
      const own = get<{ client_id: string }>(ctx.db, 'SELECT client_id FROM client_members WHERE org_id = ? AND key = ?', ctx.orgId, groupId)?.client_id
        ?? keys.map((k) => get<{ client_id: string }>(ctx.db, 'SELECT client_id FROM client_members WHERE org_id = ? AND key = ?', ctx.orgId, k)?.client_id).find(Boolean);
      for (const k of keys) run(ctx.db, 'DELETE FROM client_members WHERE org_id = ? AND key = ?', ctx.orgId, k);
      if (own) run(ctx.db, 'INSERT INTO client_members (org_id, key, client_id) VALUES (?, ?, ?) ON CONFLICT(org_id, key) DO NOTHING', ctx.orgId, groupId, own);
    });
    const undo = fresh ? { tool: 'group.dissolve', input: { groupId }, label: 'Ungroup them' } : { tool: 'group.remove_member', input: { groupId, keys: added }, label: 'Take them out again' };
    const said = fresh ? `${i.auto ? 'Unit7' : ctx.actor.name} grouped ${keys.length} thing${keys.length > 1 ? 's' : ''} into ${name}${i.auto ? ': their wiring and DNS agree' : ''}` : `${ctx.actor.name} added ${added.length} to ${name}`;
    ctx.emit(i.auto ? 'group.auto' : 'group.changed', said, { severity: 'info', resource: groupId, data: { groupId, undo } });
    return { groupId, name, members: membersOf(ctx, groupId).length, added: added.map((k) => nameOfKey(ix, k)), ...(moved.length && { moved }), undo };
  },
});

defineTool({
  name: 'group.rename', title: 'Rename a product', risk: 'write', action: 'group_write',
  description: 'Give a product a new name. It shows everywhere: the Map’s frame, Home, Clients.',
  input: z.object({ groupId: fid('grp'), name: GROUP_NAME }),
  run(ctx, i) {
    const g = groupRow(ctx, i.groupId);
    run(ctx.db, 'UPDATE product_groups SET name = ? WHERE id = ?', i.name, g.id);
    return { groupId: g.id, name: i.name, undo: { tool: 'group.rename', input: { groupId: g.id, name: g.name }, label: `Call it ${g.name} again` } };
  },
});

defineTool({
  name: 'group.remove_member', title: 'Take something out of a product', risk: 'write', action: 'group_write',
  description: 'Take things out of a product. Unit7 remembers, so it never suggests putting them back. A product left empty goes.',
  input: z.object({ groupId: fid('grp'), keys: z.array(z.string().max(40)).min(1).max(100) }),
  run(ctx, i) {
    const g = groupRow(ctx, i.groupId);
    const ix = index(ctx.db, ctx.orgId, { withArchived: true });
    const keys = i.keys.map((k) => (KEY.test(k) && ix.members.get(k) === g.id ? k : ix.up(k) ?? k)).filter((k) => ix.members.get(k) === g.id);
    if (!keys.length) throw new Unit7Error('invalid_input', `None of those are in ${g.name}.`);
    const client = get<{ client_id: string }>(ctx.db, 'SELECT client_id FROM client_members WHERE org_id = ? AND key = ?', ctx.orgId, g.id)?.client_id;
    tx(ctx.db, () => {
      for (const k of keys) {
        run(ctx.db, 'DELETE FROM group_members WHERE org_id = ? AND key = ?', ctx.orgId, k);
        run(ctx.db, 'INSERT OR IGNORE INTO group_skips (org_id, ref, key) VALUES (?, ?, ?)', ctx.orgId, g.id, k);
        if (client) run(ctx.db, 'INSERT OR IGNORE INTO client_members (org_id, key, client_id) VALUES (?, ?, ?)', ctx.orgId, k, client); // still that client's
      }
    });
    const left = membersOf(ctx, g.id).length;
    if (!left) dissolve(ctx, g.id);
    return { groupId: g.id, removed: keys.map((k) => nameOfKey(ix, k)), left, undo: { tool: 'group.accept', input: left ? { groupId: g.id, keys } : { keys, name: g.name }, label: 'Put them back' } };
  },
});

function dissolve(ctx: Ctx, groupId: string) {
  const keys = membersOf(ctx, groupId).map((m) => m.key);
  const client = get<{ client_id: string }>(ctx.db, 'SELECT client_id FROM client_members WHERE org_id = ? AND key = ?', ctx.orgId, groupId)?.client_id;
  tx(ctx.db, () => {
    // its things stay with the product's client, one by one
    if (client) for (const k of keys) run(ctx.db, 'INSERT OR IGNORE INTO client_members (org_id, key, client_id) VALUES (?, ?, ?)', ctx.orgId, k, client);
    run(ctx.db, 'DELETE FROM client_members WHERE org_id = ? AND key = ?', ctx.orgId, groupId);
    run(ctx.db, 'DELETE FROM group_skips WHERE org_id = ? AND ref = ?', ctx.orgId, groupId);
    run(ctx.db, 'DELETE FROM product_groups WHERE id = ? AND org_id = ?', groupId, ctx.orgId);
    // the same set isn't suggested (or grouped by Warden) again
    if (keys.length > 1) run(ctx.db, 'INSERT OR IGNORE INTO group_skips (org_id, ref, key) VALUES (?, ?, \'\')', ctx.orgId, suggestionId(keys));
  });
  return keys;
}

defineTool({
  name: 'group.dissolve', title: 'Ungroup a product', risk: 'write', action: 'group_write',
  description: 'Ungroup a product: its things stay exactly where they run (nothing at any provider changes) and stop sharing a name and health. Unit7 won’t suggest the same group again. Undo with group.accept.',
  input: z.object({ groupId: fid('grp') }),
  run(ctx, i) {
    const g = groupRow(ctx, i.groupId);
    const keys = dissolve(ctx, g.id);
    ctx.emit('group.changed', `${ctx.actor.name} ungrouped ${g.name}`, { severity: 'info', resource: g.id });
    return { ungrouped: g.name, things: keys.length, undo: { tool: 'group.accept', input: { keys, name: g.name }, label: `Group ${g.name} again` } };
  },
});

defineTool({
  name: 'group.dismiss', title: 'Turn down a grouping suggestion', risk: 'write', action: 'group_write',
  description: 'Say no to one suggestion from group.suggest (its id, sug_…): Unit7 won’t suggest that same group again.',
  input: z.object({ id: z.string().regex(/^sug_[A-Za-z0-9_-]{12}$/) }),
  run(ctx, i) {
    run(ctx.db, 'INSERT OR IGNORE INTO group_skips (org_id, ref, key) VALUES (?, ?, \'\')', ctx.orgId, i.id);
    return { dismissed: i.id };
  },
});
