// The map's data, worked out once per load: the same machine merged into one server, domains grouped
// under their root, every issue pinned to the thing it's about, and who owns what.
export type Kind = 'app' | 'database' | 'server' | 'domain' | 'project' | 'service' | 'volume' | 'job';
// the kinds the map lists on its own; projects, services, volumes and jobs (found inside a server by its X-ray) show in its frames
export const TOP = new Set<Kind>(['app', 'database', 'server', 'domain']);
// a server's project, ready to draw as a frame (map.get's server assets carry these)
export interface ServerFrame { id: string; name: string; owner: string; trust: string; system?: boolean; health?: { status: string; reason?: string }; environment?: string; parts: string[] }
export interface Asset {
  id: string; provider: string; kind: Kind; name: string; url: string | null; account?: string; platform?: string; status?: string; dns?: string; settings?: number;
  end?: { kind: string } & Record<string, string>;
  zone?: string; registrar?: string; expires?: string; ips?: string[];
  also?: { provider: string; name: string; accountId?: string; account?: string }[];
  site?: { status: string; ms: number | null; host: string };
  errors?: { kinds: number; hits: number; top: string; hidden?: boolean }; // hidden: a person hid them (shown with includeHidden)
  checks?: Partial<Record<'tls' | 'email' | 'registration', { status: string; detail: string | null }>>;
  // found inside a server by its X-ray: who runs it, how well Unit7 knows it, its server and project frame
  owner?: string; trust?: string; server?: string; project?: string; parts?: string[]; product?: { id: string; name: string }; engine?: string; version?: string;
  exposed?: boolean; health?: { status: string; reason?: string }; environment?: string; system?: boolean; how?: string;
  projects?: ServerFrame[]; loose?: string[];
  size?: number; region?: string; backups?: { count: number; last: string | null; size: number | null }; archived?: boolean; // the canvas: a database's size, where it lives and backups; hidden once archived
  group?: string; // the product it's part of (map.get's groups)
}
export interface Edge { source: string; target: string; kind: 'dns' | 'domain' | 'env' | 'runs_on' | 'uses'; via: string; status: 'ok' | 'misconfigured' | 'unknown'; detail: string | null }
export interface Issue { severity: 'critical' | 'warning' | 'info'; key: string; text: string; about?: string; hidden?: boolean; until?: string | null; back?: string } // hidden: a person hid it until then (null: for good), shown with includeHidden; back: it came back
export interface Suggestion { from: object; to: object; fromName: string; toName: string; why: string; sure: boolean }
export interface Acct { id: string; name: string; provider: string; ok: boolean; note?: string; found: number; staleSince?: string }
export interface MapData { syncedAt?: string; running: boolean; autoSync?: AutoSync; counts?: Record<string, number>; accounts: Acct[]; issues: Issue[]; suggestions: Suggestion[]; assets: Asset[]; edges: Edge[]; groups?: { id: string; name: string }[]; hidden?: number } // hidden: how many issues a person hid
export interface AutoSync { every: string; lastSyncAt: string | null; nextSyncAt: string | null; running: boolean }
// the auto-sync choices (sync.schedule), in the words the page shows
export const AUTO_SYNC = [
  { value: '15m', label: 'Every 15 minutes' }, { value: '1h', label: 'Every hour' }, { value: '6h', label: 'Every 6 hours' },
  { value: '1d', label: 'Once a day' }, { value: 'off', label: 'Off' },
];
// "Synced 12m ago · next in 5h 48m"; "auto-sync off" when it's off
export function nextSyncWords(a: AutoSync | undefined, at = Date.now()) {
  if (!a) return '';
  if (a.every === 'off') return 'auto-sync off';
  if (!a.nextSyncAt) return '';
  const m = Math.ceil((Date.parse(a.nextSyncAt) - at) / 60_000), h = Math.floor(m / 60);
  return m <= 1 ? 'next in a minute' : `next in ${h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`}`;
}
export interface Managed { id: string; hostname: string; status: string; tls: string; service: string | null }
export interface Group { root: string; asset?: Asset; subs: Asset[]; dns?: string; registrar?: string; expires?: string; hidden?: number } // hidden: subdomains a filter left out

export type Type = 'all' | 'domain' | 'app' | 'server' | 'database';
export const TYPES: { value: Type; label: string; one: string }[] = [
  { value: 'all', label: 'All', one: 'thing' }, { value: 'domain', label: 'Domains', one: 'domain' }, { value: 'app', label: 'Apps', one: 'app' },
  { value: 'server', label: 'Servers', one: 'server' }, { value: 'database', label: 'Databases', one: 'database' },
];

// DNS hosts Unit7 can move to Cloudflare (it can read every record there)
export const MOVABLE = new Set(['hostinger', 'godaddy', 'porkbun', 'namecom', 'digitalocean', 'vercel']);
// hosts domain.point can add a domain on, by the shape of the app's `end`
const POINTABLE = new Set(['unit7', 'vercel', 'netlify', 'render', 'railway', 'heroku', 'fly']);
export const pointable = (a: Asset) => a.kind === 'app' && !!a.end && POINTABLE.has(a.end.kind);
export function pointInput(hostname: string, a: Asset) {
  const { kind, ...rest } = a.end!;
  return kind === 'unit7' ? { hostname, serviceId: rest.serviceId } : { hostname, [kind]: rest };
}

const BAD_STATE = /paus|inactive|disabled|suspend|crash|fail|error|maintenance|removed/i;
export const logoOf = (a: Asset) => (a.kind === 'domain' ? a.dns ?? 'domain' : a.product ? (a.product.id === 'postgresql' ? 'postgres' : a.product.id) : a.engine && a.owner ? a.engine : a.provider === 'unmanaged' ? 'docker' : a.provider);
// "Vercel · sam-1234" → the part after the provider
export const acctLabel = (name: string) => (name.includes(' · ') ? name.slice(name.indexOf(' · ') + 3) : '');

// a name's registrable domain when no scan said its zone: the shortest other domain it sits under, else
// the last two labels (three for co.uk-style endings)
export function guessRoot(name: string, known: Set<string>) {
  const labels = name.split('.');
  for (let i = labels.length - 2; i >= 1; i--) { const up = labels.slice(i).join('.'); if (known.has(up)) return up; }
  const n = labels.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(labels.at(-2)!) && labels.at(-1)!.length === 2 ? 3 : 2;
  return labels.slice(-n).join('.');
}

const SHORT: Record<string, string> = {
  takeover: 'Can be taken over', dns: 'Points elsewhere', email: 'Email can be faked', tls: 'HTTPS problem', reg: 'Registration ending', down: 'Down',
  slow: 'Slow', paused: 'Database paused', dup: 'Added twice', 'ext-supabase': 'Unknown database', scan: 'Couldn’t read',
};
export const issueKind = (i: Issue) => i.key.split(':')[0]!;
export const issueLabel = (i: Issue) => SHORT[issueKind(i)] ?? 'Needs a look';

export function liveOf(a: Asset): { tone: 'ok' | 'warn' | 'bad'; text: string } | undefined {
  if (a.site) return a.site.status === 'up' ? { tone: 'ok', text: `Up${a.site.ms != null ? ` · ${a.site.ms} ms` : ''}` } : a.site.status === 'down' ? { tone: 'bad', text: 'Down' } : { tone: 'warn', text: a.site.status === 'slow' ? `Slow · ${a.site.ms} ms` : a.site.status };
  if (a.status && BAD_STATE.test(a.status)) return { tone: 'warn', text: a.status.toLowerCase().replace(/_/g, ' ') };
  if (a.status && /healthy|active|running/i.test(a.status)) return { tone: 'ok', text: 'Running' };
  // a thing inside a server: its X-ray health
  if (a.health && a.kind !== 'volume' && a.kind !== 'job') return a.health.status === 'ok' ? { tone: 'ok', text: 'Running' } : a.health.status === 'off' ? { tone: 'warn', text: 'Stopped' }
    : { tone: a.health.status === 'bad' ? 'bad' : 'warn', text: a.health.status === 'bad' ? 'Down' : 'Needs a look' };
}

// a domain's subdomains, split: the ones that reach something (or need a fix) stay in view; the rest fold away
export function splitSubs(v: Pick<Derived, 'out' | 'issuesOf'>, subs: Asset[]) {
  const idle = subs.filter((d) => !v.out(d.id).some((e) => e.kind === 'domain' || e.kind === 'dns') && !v.issuesOf(d.id).length && !(d.site && d.site.status !== 'up'));
  // folding one row saves nothing
  return idle.length >= 2 ? { linked: subs.filter((d) => !idle.includes(d)), idle } : { linked: subs, idle: [] as Asset[] };
}

export type Derived = ReturnType<typeof derive>;
export function derive(m: MapData) {
  // copies, so the merge below never touches what came from the server
  let assets = m.assets.map((a) => ({ ...a }));
  const alias = new Map<string, string>();
  // ponytail: synced before the model merged servers (src/discovery/model.ts), the same machine shows
  // twice; matched here on a shared address or Unit7's name being the first label of the other. Goes away after a sync.
  const servers = assets.filter((a) => a.kind === 'server');
  for (const f of servers.filter((s) => s.provider === 'unit7')) {
    for (const g of servers) {
      if (g === f || alias.has(g.id) || alias.has(f.id) || !(g.ips?.some((ip) => f.ips?.includes(ip)) || g.name.startsWith(`${f.name}.`))) continue;
      alias.set(g.id, f.id);
      f.also = [...(f.also ?? []), { provider: g.provider, name: g.name, account: g.account }];
      f.ips = [...new Set([...(f.ips ?? []), ...(g.ips ?? [])])];
    }
  }
  assets = assets.filter((a) => !alias.has(a.id));
  const to = (id: string) => alias.get(id) ?? id;
  const seen = new Set<string>();
  const edges = m.edges.map((e) => ({ ...e, source: to(e.source), target: to(e.target) }))
    .filter((e) => { const k = `${e.source}|${e.target}|${e.kind}|${e.via}`; if (seen.has(k) || e.source === e.target) return false; seen.add(k); return true; });

  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = (id: string, kind?: Edge['kind']) => edges.filter((e) => e.source === id && (!kind || e.kind === kind) && byId.has(e.target));
  const inc = (id: string, kind?: Edge['kind']) => edges.filter((e) => e.target === id && (!kind || e.kind === kind) && byId.has(e.source));

  // domains under their root
  const domains = assets.filter((a) => a.kind === 'domain');
  const domByName = new Map(domains.map((d) => [d.name, d]));
  const known = new Set(domains.filter((d) => !d.zone || d.zone === d.name).map((d) => d.name));
  const groupMap = new Map<string, Group>();
  for (const d of domains) {
    const root = d.zone ?? guessRoot(d.name, known);
    const g = groupMap.get(root) ?? { root, subs: [] };
    if (d.name === root) g.asset = d; else g.subs.push(d);
    g.dns ??= d.dns; g.registrar ??= d.registrar; g.expires ??= d.expires;
    groupMap.set(root, g);
  }
  for (const g of groupMap.values()) g.subs.sort((a, b) => a.name.localeCompare(b.name));
  const groups = [...groupMap.values()].sort((a, b) => a.root.localeCompare(b.root));
  const groupOf = new Map(groups.flatMap((g) => [g.asset, ...g.subs].filter(Boolean).map((d) => [d!.id, g] as const)));

  // every issue pinned to the thing it's about: by id, by domain name, or by the host in its key
  const issuesById = new Map<string, Issue[]>();
  const acctIssues = new Map<string, Issue[]>();
  const pins: { issue: Issue; id?: string; acct?: string }[] = [];
  const pin = (id: string, i: Issue) => issuesById.set(id, [...(issuesById.get(id) ?? []), i]);
  for (const i of m.issues) {
    const kind = issueKind(i), host = i.key.slice(kind.length + 1);
    if (kind === 'scan') { acctIssues.set(host, [...(acctIssues.get(host) ?? []), i]); pins.push({ issue: i, acct: host }); continue; }
    const about = i.about ? byId.get(to(i.about)) ?? (i.about.startsWith('domain:') ? domByName.get(i.about.slice(7)) : undefined) : undefined;
    const hit = about ?? domByName.get(host) ?? assets.find((a) => a.site?.host === host);
    if (hit) pin(hit.id, i);
    pins.push({ issue: i, id: hit?.id });
  }
  const issuesOf = (id: string) => issuesById.get(id) ?? [];

  const attention = (a: Asset) => issuesOf(a.id).length > 0 || (!!a.site && a.site.status !== 'up') || !!a.errors || (!!a.status && BAD_STATE.test(a.status)) || a.health?.status === 'bad' || a.health?.status === 'warn'
    || edges.some((e) => (e.source === a.id || e.target === a.id) && e.status === 'misconfigured');
  const groupAttention = (g: Group) => [g.asset, ...g.subs].some((d) => d && attention(d));

  // a sync from before the rename calls Unit7's own scope "forge": it's Unit7's account all the same
  const accounts = m.accounts.map((a) => (a.provider === 'forge' ? { ...a, provider: 'unit7' } : a));
  // who owns what: an account's own things, plus domains no account holds that point at them
  const owns = (acc: Acct, a: Asset) => acc.provider === 'unit7'
    ? a.provider === 'unit7' || !!a.also?.some((x) => x.provider === 'unit7')
    : a.account === acc.name || !!a.also?.some((x) => x.accountId === acc.id || (!!x.account && x.account === acc.name));
  const inAccount = (acc: Acct, a: Asset): boolean => owns(acc, a) || (a.kind === 'domain' && !a.account && out(a.id).some((e) => owns(acc, byId.get(e.target)!)));

  return { assets, edges, byId, out, inc, groups, groupOf, issuesOf, acctIssues, pins, attention, groupAttention, inAccount, issues: m.issues, suggestions: m.suggestions, accounts };
}

// what a domain points at, or what points at a thing, as one line
export function targetsOf(v: Derived, d: Asset) {
  return v.out(d.id).filter((e) => e.kind === 'domain' || e.kind === 'dns').map((e) => ({ edge: e, asset: v.byId.get(e.target)! }));
}


// --- the canvas -------------------------------------------------------------------------------------------------------
// a subdomain nothing here points at: no DNS record to anything Unit7 knows, not added to any app
export const isUnused = (v: Pick<Derived, 'out'>, d: Asset) => !v.out(d.id).some((e) => e.kind === 'domain' || e.kind === 'dns');
// unused and looks abandoned: its record points at something that's gone (anyone could claim it), or nothing answers
export function abandoned(v: Pick<Derived, 'issuesOf'>, d: Asset): 'takeover' | 'gone' | undefined {
  if (v.issuesOf(d.id).some((i) => issueKind(i) === 'takeover')) return 'takeover';
  if (d.site?.status === 'down') return 'gone';
}

// where an unused subdomain most likely belongs: an app named like its first label (api.* → "api", "shop-api"); an
// app in this domain's family counts more. Else www (and beta, preview…) go where the bare domain goes. No good guess → none.
const SAME: Record<string, string[]> = {
  app: ['app', 'web', 'dashboard', 'dash', 'portal'], dash: ['dash', 'dashboard', 'app'], dashboard: ['dashboard', 'dash', 'app'], admin: ['admin', 'dashboard', 'panel', 'cms'],
  api: ['api', 'backend', 'server'], shop: ['shop', 'store'], store: ['store', 'shop'], docs: ['docs', 'doc', 'documentation'], blog: ['blog', 'news'],
  hooks: ['hooks', 'webhooks', 'webhook'], cms: ['cms', 'admin'],
};
const MAIN = new Set(['www', 'web', 'site', 'home', 'beta', 'new', 'preview', 'demo']);
export function suggestApp(host: string, root: string, apps: { id: string; name: string }[], rootTargets: string[] = []): string | undefined {
  const label = host.endsWith(`.${root}`) ? host.slice(0, -root.length - 1) : host.split('.')[0]!;
  const family = root.split('.')[0]!.toLowerCase();
  const words = (SAME[label] ?? [label]).flatMap((w) => [w, ...w.split('-')]);
  let best: { id: string; score: number; len: number } | undefined;
  for (const a of apps) {
    const name = a.name.toLowerCase(), tokens = name.split(/[-_. ]+/);
    const related = rootTargets.includes(a.id) || name.includes(family);
    const score = (name === label ? 5 : words.some((w) => tokens.includes(w)) ? 3 : 0) + (related ? 2 : 0);
    if (score >= 4 && (!best || score > best.score || (score === best.score && name.length < best.len))) best = { id: a.id, score, len: name.length };
  }
  return best?.id ?? (MAIN.has(label) ? rootTargets[0] : undefined);
}

// a database engine's own colour, for its mark on the canvas
export const ENGINE_COLOR: Record<string, string> = {
  postgres: '#336791', supabase: '#3ecf8e', neon: '#00c99a', mysql: '#00758f', mariadb: '#c0765a', redis: '#dc382d', mongodb: '#47a248',
  sqlite: '#0f80cc', clickhouse: '#e8b100', turso: '#4ff8d2', planetscale: '#8a8a94',
};
export const engineOf = (a: Asset, stack?: string) =>
  (a.provider === 'supabase' || a.provider === 'neon' ? a.provider : a.engine ?? (a.product?.id === 'postgresql' ? 'postgres' : a.product?.id) ?? stack ?? 'postgres');
