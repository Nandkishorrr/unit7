// The Overview's data: the map's things as plain sections (accounts, domains, apps, databases, services, servers),
// what needs a look first in each, and long ones folded. Built from the same derive() as the canvas; pure, so
// test/map-overview.test.ts runs it under Node.
import type { Acct, Asset, Derived, Group } from './data.ts';

// data.ts's targetsOf and isUnused, here so Node can run this file on its own (a .ts import of values doesn't build in web/)
const reach = (v: Derived, d: Asset) => v.out(d.id).filter((e) => e.kind === 'domain' || e.kind === 'dns').map((e) => ({ edge: e, asset: v.byId.get(e.target)! }));

export type Tone = 'ok' | 'warn' | 'bad' | 'idle';
export interface Hooks {
  label?: (a: Asset) => string;
  product?: (id: string) => string | undefined; // a product's name (map.get's groups)
  projectOf?: (a: Asset) => { id: string; name: string } | undefined; // the Unit7 project it was deployed from
}

// needs a look: anything the map flags, and a database open to the internet
export const needs = (v: Pick<Derived, 'attention'>, a: Asset) => v.attention(a) || !!a.exposed;
const has = (q: string, ...texts: (string | null | undefined)[]) => !q || texts.some((t) => !!t && t.toLowerCase().includes(q));
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

// what needs a look first, then by name: a fold never hides a problem
export function needFirst<T>(items: T[], need: (x: T) => boolean, name: (x: T) => string) {
  return [...items].sort((a, b) => +need(b) - +need(a) || name(a).localeCompare(name(b)));
}

// the first `limit`, unless it's open; folding a single one saves nothing
export function fold<T>(items: T[], limit: number, open: boolean): { shown: T[]; hidden: number } {
  return open || items.length <= limit + 1 ? { shown: items, hidden: 0 } : { shown: items.slice(0, limit), hidden: items.length - limit };
}
// groups of rows: the first few groups, the first few rows of each; hidden counts every row left out
export function foldGroups<G extends { items: unknown[] }>(groups: G[], o: { groups: number; rows: number }, open: boolean): { groups: (G & { shown: G['items']; more: number })[]; hidden: number } {
  if (open) return { groups: groups.map((g) => ({ ...g, shown: g.items, more: 0 })), hidden: 0 };
  const top = fold(groups, o.groups, false);
  const out = top.shown.map((g) => { const f = fold(g.items, o.rows, false); return { ...g, shown: f.shown, more: f.hidden }; });
  const hidden = out.reduce((n, g) => n + g.more, 0) + groups.slice(top.shown.length).reduce((n, g) => n + g.items.length, 0);
  return { groups: out, hidden };
}

// --- accounts: one circle per provider ------------------------------------------------------------------------------
export interface ProviderAccounts { provider: string; accounts: Acct[]; bad: number }
export function providersOf(accounts: Acct[], q = '', name: (p: string) => string = (p) => p): ProviderAccounts[] {
  const by = new Map<string, Acct[]>();
  for (const a of accounts) if (a.provider !== 'unit7' && has(q, a.name, a.provider, name(a.provider))) by.set(a.provider, [...(by.get(a.provider) ?? []), a]);
  return [...by.entries()].map(([provider, list]) => ({ provider, accounts: list.sort(byName), bad: list.filter((a) => !a.ok).length }))
    .sort((a, b) => +(b.bad > 0) - +(a.bad > 0) || b.accounts.length - a.accounts.length || a.provider.localeCompare(b.provider));
}

// --- domains: a card per root, its subdomains as a count ------------------------------------------------------------
export interface DomainCard { id: string; root: string; g: Group; open?: Asset; tone: Tone; targets: Asset[]; subs: Asset[]; unused: Asset[]; risky: number; need: boolean }
export function domainCards(v: Derived, show: Set<string>, q = '', h: Hooks = {}): DomainCard[] {
  const label = h.label ?? ((a: Asset) => a.name);
  const out: DomainCard[] = [];
  for (const g of v.groups) {
    const members = [g.asset, ...g.subs].filter((d): d is Asset => !!d && show.has(d.id));
    if (!members.length) continue;
    const links = members.flatMap((d) => reach(v, d));
    const targets = [...new Map(links.map((t) => [t.asset.id, t.asset])).values()];
    if (!has(q, g.root, ...members.map((d) => d.name), ...targets.map(label))) continue;
    const issues = members.flatMap((d) => v.issuesOf(d.id));
    const bad = issues.some((i) => i.severity === 'critical') || links.some((t) => t.edge.status === 'misconfigured');
    const tone: Tone = bad ? 'bad' : issues.length || members.some(v.attention) ? 'warn' : links.length ? 'ok' : 'idle';
    const subs = g.subs.filter((d) => show.has(d.id)), unused = subs.filter((d) => !reach(v, d).length);
    const risky = unused.filter((d) => v.issuesOf(d.id).some((i) => i.key.startsWith('takeover:'))).length;
    out.push({ id: `d:${g.root}`, root: g.root, g, open: g.asset && show.has(g.asset.id) ? g.asset : members[0], tone, targets, subs, unused, risky, need: tone === 'bad' || tone === 'warn' });
  }
  // problems first, then the ones that work, then the ones that lead nowhere yet (parked, say)
  const rank = (c: DomainCard) => (c.need ? 0 : c.tone === 'ok' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.root.localeCompare(b.root));
}

// --- apps: grouped by product, else the project they were deployed from, else where they're hosted ------------------
export interface Bucket { id: string; name: string; kind: 'product' | 'project' | 'host' | 'tools' | 'data' | 'jobs'; logo: string; sub?: string; items: Asset[]; need: number }
export function appGroups(v: Derived, show: Set<string>, q = '', h: Hooks = {}): Bucket[] {
  const label = h.label ?? ((a: Asset) => a.name);
  const groups = new Map<string, Bucket>();
  for (const a of v.assets) {
    if (a.kind !== 'app' || !show.has(a.id)) continue;
    const product = a.group ? h.product?.(a.group) : undefined;
    const up = !product ? h.projectOf?.(a) : undefined;
    const xp = !product && !up && a.project ? v.byId.get(a.project) : undefined;
    const server = a.server ? v.byId.get(a.server) : undefined;
    const g: Omit<Bucket, 'items' | 'need'> = product ? { id: `grp:${a.group}`, name: product, kind: 'product', logo: 'product' }
      : up ? { id: `prj:${up.id}`, name: up.name, kind: 'project', logo: 'unit7' }
        : xp ? { id: xp.id, name: xp.name, kind: 'project', logo: xp.owner ?? 'unmanaged', sub: server ? `on ${server.name}` : undefined }
          : { id: `host:${a.account ?? a.provider}`, name: a.provider, kind: 'host', logo: a.provider, sub: a.account?.includes(' · ') ? a.account.slice(a.account.indexOf(' · ') + 3) : undefined };
    const b = groups.get(g.id) ?? { ...g, items: [], need: 0 };
    b.items.push(a);
    groups.set(g.id, b);
  }
  return sortBuckets([...groups.values()], v, q, label, { product: 0, project: 1, host: 2 });
}

// a bucket stays whole when its own name matches; otherwise only its things that do
function sortBuckets(list: Bucket[], v: Derived, q: string, label: (a: Asset) => string, rank: Partial<Record<Bucket['kind'], number>>) {
  const out: Bucket[] = [];
  for (const b of list) {
    const items = has(q, b.name, b.sub) ? b.items : b.items.filter((a) => has(q, label(a), a.name, a.url, a.product?.name));
    if (!items.length) continue;
    const need = (a: Asset) => needs(v, a);
    const sorted = needFirst(items, need, label);
    out.push({ ...b, items: sorted, need: sorted.filter(need).length });
  }
  return out.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || +(b.need > 0) - +(a.need > 0) || a.name.localeCompare(b.name));
}

// --- databases, servers: plain lists ---------------------------------------------------------------------------------
export function listOf(v: Derived, show: Set<string>, kind: 'database' | 'server', q = '', h: Hooks = {}): Asset[] {
  const label = h.label ?? ((a: Asset) => a.name);
  return needFirst(v.assets.filter((a) => a.kind === kind && show.has(a.id) && has(q, label(a), a.name, a.url, a.engine, a.provider, ...(a.ips ?? []))), (a) => needs(v, a), label);
}

// --- services: tools that run on a server, the data they keep, and scheduled jobs ------------------------------------
export function serviceGroups(v: Derived, show: Set<string>, q = '', h: Hooks = {}): Bucket[] {
  const label = h.label ?? ((a: Asset) => a.name);
  const kinds = [['service', 'tools', 'Tools and services'], ['volume', 'data', 'Stored data'], ['job', 'jobs', 'Scheduled jobs']] as const;
  const list: Bucket[] = kinds.map(([k, kind, name]) => ({ id: kind, name, kind, logo: kind, items: v.assets.filter((a) => a.kind === k && show.has(a.id)), need: 0 }));
  const out = sortBuckets(list, v, q, label, { tools: 0, data: 1, jobs: 2 });
  // a server's own machinery (Coolify itself) after what people run
  for (const b of out) b.items = [...b.items.filter((a) => !a.system), ...b.items.filter((a) => a.system)];
  return out;
}

// the numbers a section header shows
export const countOf = (items: { need: boolean | number }[]) => ({ total: items.length, need: items.filter((x) => !!x.need).length });
