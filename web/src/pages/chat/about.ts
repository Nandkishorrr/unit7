// What a chat is about: the servers, projects, apps, domains, databases and accounts you can pick with @ (or + Add
// context), and what a conversation was about so far. Pure and import-free (types only), so tests load it under plain
// Node; the page hands in the Map's logo and the provider names (map/data.ts logoOf, lib/words.ts providerName).
import type { Asset, MapData } from '../map/data.ts'; // .ts: the root typecheck resolves it the way Node does

export type AboutKind = 'server' | 'project' | 'app' | 'domain' | 'database' | 'account' | 'environment'; // environment: a project's Staging/Production, from the switch on its page
export interface ContextItem { kind: AboutKind; id: string; name: string }
export interface PickItem extends ContextItem { logo: string; sub?: string }

export const GROUPS: { kind: AboutKind; label: string; one: string }[] = [
  { kind: 'server', label: 'Servers', one: 'server' }, { kind: 'project', label: 'Projects', one: 'project' }, { kind: 'app', label: 'Apps', one: 'app' },
  { kind: 'domain', label: 'Domains', one: 'domain' }, { kind: 'database', label: 'Databases', one: 'database' }, { kind: 'account', label: 'Accounts', one: 'account' },
];
const DB = new Set(['postgres', 'mysql', 'mariadb', 'mongo', 'redis']);
const MAP_KIND: Partial<Record<Asset['kind'], AboutKind>> = { app: 'app', service: 'app', database: 'database', server: 'server', domain: 'domain', project: 'project' };

// Unit7's own things first, by the ids its tools take (srv_, prj_, svc_, dom_, acc_); then what the map found in your
// connected accounts and inside your servers (ast_), leaving out what Unit7 already listed, Coolify's own parts,
// volumes and jobs. Each group sorted by name.
const acctLabel = (name: string) => (name.includes(' · ') ? name.slice(name.indexOf(' · ') + 3) : '');
export function pickItems(graph: any, map: MapData | null | undefined, o: { logoOf?: (a: Asset) => string; providerName?: (id: string) => string } = {}): PickItem[] {
  const logoOf = o.logoOf ?? ((a: Asset) => a.provider), providerName = o.providerName ?? ((id: string) => id);
  const out: PickItem[] = [];
  const ids = new Set<string>(), names = new Set<string>();
  const add = (x: PickItem, unit7 = false) => {
    const k = `${x.kind}:${x.name.toLowerCase()}`;
    if (ids.has(x.id) || (!unit7 && names.has(k))) return;
    ids.add(x.id); names.add(k); out.push(x);
  };
  const hosts = new Set<string>();
  for (const s of graph?.servers ?? []) {
    hosts.add(s.host); if (s.facts?.publicIp) hosts.add(s.facts.publicIp);
    add({ kind: 'server', id: s.id, name: s.name, logo: typeof s.provider_ref === 'string' && s.provider_ref.includes(':') ? s.provider_ref.split(':')[0] : 'server', sub: s.host }, true);
  }
  const unit7Servers = (graph?.servers ?? []).map((s: any) => String(s.name).toLowerCase());
  for (const p of graph?.projects ?? []) {
    const svcs = (p.environments ?? []).flatMap((e: any) => (e.services ?? []).map((s: any) => ({ s, env: e })));
    add({ kind: 'project', id: p.id, name: p.name, logo: 'unit7', sub: `${svcs.length} app${svcs.length === 1 ? '' : 's'}` }, true);
    for (const { s, env } of svcs) {
      const db = DB.has(s.kind);
      const where = (p.environments?.length ?? 0) > 1 ? `${p.name} · ${env.name}` : p.name;
      add({ kind: db ? 'database' : 'app', id: s.id, name: s.name, logo: db ? (s.kind === 'mongo' ? 'mongodb' : s.kind) : 'unit7', sub: where }, true);
      for (const d of s.domains ?? []) add({ kind: 'domain', id: d.id, name: d.hostname, logo: 'domain', sub: s.name }, true);
    }
  }
  for (const a of graph?.accounts ?? []) add({ kind: 'account', id: a.id, name: a.name, logo: a.provider, sub: providerName(a.provider) }, true);
  for (const a of map?.assets ?? []) {
    const kind = MAP_KIND[a.kind];
    if (!kind || a.provider === 'unit7' || a.end?.kind === 'unit7' || a.system || (a as { archived?: boolean }).archived) continue;
    // a server Unit7 already has, seen again in its provider's account
    if (kind === 'server' && (a.ips?.some((ip) => hosts.has(ip)) || unit7Servers.some((n: string) => a.name.toLowerCase().startsWith(`${n}.`)))) continue;
    const acct = a.account ? acctLabel(a.account) : '';
    add({ kind, id: a.id, name: a.name, logo: logoOf(a), sub: [providerName(a.provider === 'domain' ? a.dns ?? 'domain' : a.provider), acct].filter((x) => x && x !== 'Domain').join(' · ') || undefined });
  }
  const order = (k: AboutKind) => GROUPS.findIndex((g) => g.kind === k);
  return out.sort((a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name));
}

// everything a conversation's messages were about, in the order first picked
export function aboutOf(messages: { role: string; content: any }[]): ContextItem[] {
  const seen = new Map<string, ContextItem>();
  for (const m of messages) if (m.role === 'user') for (const c of (m.content?.context ?? []) as ContextItem[]) if (c?.id && !seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}
