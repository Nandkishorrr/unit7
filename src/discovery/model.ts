// The map's logic, kept pure so it can be tested on its own. Scanners report what they FOUND (an app, a
// database, a server, a domain) and REFS (something that points somewhere: a DNS record, a domain
// added on a host, an env value holding a URL). resolve() turns refs into edges between found things,
// and spots what's wrong: a domain added on a host but pointing elsewhere, a CNAME to an app that no
// longer exists (anyone could claim it), an app using a database in an account you haven't connected.
import type { End } from '../tools/links.ts';

// project, service, volume and job come from server X-rays (discovery/xray.ts): what runs inside a server
export type Kind = 'app' | 'database' | 'server' | 'domain' | 'project' | 'service' | 'volume' | 'job';
export interface Found {
  provider: string; kind: Kind; extId: string; name: string; url?: string; accountId?: string;
  hosts?: string[];        // names that reach it: its domains, x.vercel.app, <ref>.supabase.co…
  ips?: string[];          // public addresses (servers)
  envKeys?: string[];      // settings it has (names only, never values)
  reads?: string[];        // settings its code reads, when known
  uses?: { supabase?: boolean; postgres?: boolean };
  end?: End;               // how a connection addresses it
  platform?: string;       // where it's served from (vercel, netlify, unit7…), to check its domains' DNS
  status?: string;         // the provider's own state ("paused"…)
  auth?: { smtp: boolean; site?: string }; // Supabase: its own sender set?, and where sign-in lands
  dns?: string;            // domains: who serves the zone
  zone?: string;           // domains: the zone they're in (a name equal to its zone is the bare domain)
  expires?: string;        // domains: when the registration runs out (from the registrar)
  autoRenew?: boolean;     // domains: whether the registrar renews it by itself
  registrar?: string;
  also?: { provider: string; extId: string; name: string; accountId?: string }[]; // servers: the same machine as seen by other scans
  // found inside a server by its X-ray
  owner?: string;          // who runs it: coolify, dokploy, compose, pm2, systemd, unit7, unmanaged…
  trust?: string;          // seen | understood | managed | owned
  server?: string;         // map key of the server it's on
  project?: string;        // map key of the project it's part of
  parts?: string[];        // projects: map keys of what's in them
  system?: boolean;        // projects: the PaaS itself or the server's own software, not something you built
  product?: { id: string; name: string }; // a known app (Supabase, n8n…): logo id and plain name
  engine?: string; version?: string; exposed?: boolean; // databases: engine, version, open to the internet
  health?: { status: string; reason?: string };
  environment?: string;    // Coolify's environment (production…)
  how?: string;            // projects: what grouped them (Coolify labels, Docker Compose labels, the same folder…)
  size?: number;           // databases: bytes stored, when the provider says (the map draws it as a ring)
  repo?: string;           // the git repo it deploys from (owner/name or a URL), when the provider says: one product's parts share it
  api?: string;            // where its provider's API lives for it, when that isn't the provider's main address (a Sentry region)
}
export type RefKind = 'dns' | 'domain' | 'env' | 'runs_on' | 'uses';
export interface Ref { from: string; kind: RefKind; via: string; host?: string; ip?: string; supabase?: string; to?: string }
export interface Edge { from: string; to: string; kind: RefKind; via: string; status: 'ok' | 'misconfigured' | 'unknown'; detail?: string }
export interface Issue { severity: 'critical' | 'warning' | 'info'; key: string; text: string; about?: string }

export const keyOf = (f: Pick<Found, 'provider' | 'extId'>) => `${f.provider}:${f.extId}`;
export const domainKey = (host: string) => `domain:${host}`;

// Hosting platforms recognised from DNS alone (a CNAME target or an address)
export const PLATFORMS: { id: string; cname: RegExp; ip?: RegExp }[] = [
  { id: 'vercel', cname: /\.vercel-dns(-\d+)?\.com$|\.vercel\.app$/, ip: /^(76\.76\.21|216\.198\.79)\./ },
  { id: 'netlify', cname: /\.netlify\.(app|com)$/, ip: /^(75\.2\.60\.5|99\.83\.231\.61)$/ },
  { id: 'render', cname: /\.onrender\.com$/, ip: /^216\.24\.57\./ },
  { id: 'railway', cname: /\.railway\.app$/ },
  { id: 'supabase', cname: /\.supabase\.co$/ },
  { id: 'digitalocean', cname: /\.ondigitalocean\.app$/ },
  { id: 'github-pages', cname: /\.github\.io$/ },
  { id: 'heroku', cname: /\.herokuapp\.com$|\.herokudns\.com$/ },
  { id: 'fly', cname: /\.fly\.dev$/ },
  { id: 'aws', cname: /\.amazonaws\.com$|\.cloudfront\.net$/ },
  { id: 'azure', cname: /\.azurewebsites\.net$|\.cloudapp\.azure\.com$|\.azureedge\.net$/ },
  // Google: Cloud Run and App Engine custom domains (ghs.googlehosted.com and its four addresses), Firebase Hosting
  { id: 'gcp', cname: /\.run\.app$|^ghs\.googlehosted\.com$|\.appspot\.com$|\.cloudfunctions\.net$/, ip: /^216\.239\.3[2468]\.21$/ },
  { id: 'firebase', cname: /\.web\.app$|\.firebaseapp\.com$/, ip: /^199\.36\.158\.100$|^151\.101\.(1|65)\.195$/ },
  { id: 'azure', cname: /\.azurestaticapps\.net$/ },
  { id: 'aws', cname: /\.amplifyapp\.com$/ },
];
// What a platform serves for a name nobody has claimed: the domain can be taken over by creating it
export const UNCLAIMED: Record<string, RegExp> = {
  netlify: /Not Found - Request ID/i, heroku: /no-such-app|There(?:'|&#39;)s nothing here, yet/i, 'github-pages': /There isn't a GitHub Pages site here/i,
  aws: /NoSuchBucket/, vercel: /DEPLOYMENT_NOT_FOUND/,
};

export const platformOf = (r: { host?: string; ip?: string }) =>
  PLATFORMS.find((p) => (r.host && p.cname.test(r.host)) || (r.ip && p.ip?.test(r.ip)))?.id;

const LOCAL = /^(localhost|127\.|0\.0\.0\.0|::1|host\.docker\.internal|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$|\.internal$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Where env values point: hosts in URLs and connection strings, *_HOST values, and Supabase's pooler
// user (postgres.<ref>), which names the project even though the host is shared. Values never leave here.
export function envRefs(from: string, env: Record<string, string>): Ref[] {
  const out = new Map<string, Ref>();
  const add = (r: Ref) => out.set(`${r.via}|${r.host ?? r.ip ?? r.supabase}`, r);
  for (const [k, raw] of Object.entries(env)) {
    const v = String(raw ?? '');
    for (const m of v.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s@/]+@)?\[?([a-z0-9.-]+)\]?/gi)) {
      const host = m[1]!.toLowerCase().replace(/\.$/, '');
      if (!host.includes('.') || LOCAL.test(host)) continue;
      add(IPV4.test(host) ? { from, kind: 'env', via: k, ip: host } : { from, kind: 'env', via: k, host });
    }
    const pooler = /\bpostgres\.([a-z]{20})[:@]/.exec(v);
    if (pooler) add({ from, kind: 'env', via: k, supabase: pooler[1] });
    if (/HOST(NAME)?$/.test(k) && /^[a-z0-9.-]+\.[a-z]{2,}$|^\d{1,3}(\.\d{1,3}){3}$/i.test(v.trim()) && !LOCAL.test(v.trim())) {
      const h = v.trim().toLowerCase();
      add(IPV4.test(h) ? { from, kind: 'env', via: k, ip: h } : { from, kind: 'env', via: k, host: h });
    }
  }
  return [...out.values()];
}

// Several scans can report the same thing (a domain from its DNS host and from the app it's added to)
export function mergeFound(list: Found[]): Map<string, Found> {
  const out = new Map<string, Found>();
  const uniq = (a?: string[], b?: string[]) => (a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined);
  for (const f of list) {
    const k = keyOf(f), prev = out.get(k);
    out.set(k, prev ? { ...prev, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)), accountId: prev.accountId ?? f.accountId, dns: prev.dns ?? f.dns,
      hosts: uniq(prev.hosts, f.hosts), ips: uniq(prev.ips, f.ips), envKeys: uniq(prev.envKeys, f.envKeys) } : f);
  }
  // one machine seen twice (Unit7 manages it, and it's a VPS in a Hostinger account): one server, Unit7's
  // first, the other names kept in `also`; resolve() sends refs to them here. Private addresses never match.
  const servers = [...out.keys()].filter((k) => out.get(k)!.kind === 'server').sort((a, b) => +(out.get(b)!.provider === 'unit7') - +(out.get(a)!.provider === 'unit7'));
  for (const k of servers) {
    for (const k2 of servers) {
      const f = out.get(k), g = out.get(k2);
      if (!f || !g || k === k2 || !g.ips?.some((ip) => !LOCAL.test(ip) && f.ips?.includes(ip))) continue;
      out.set(k, { ...f, ips: uniq(f.ips, g.ips), also: [...(f.also ?? []), { provider: g.provider, extId: g.extId, name: g.name, ...(g.accountId && { accountId: g.accountId }) }, ...(g.also ?? [])] });
      out.delete(k2);
    }
  }
  return out;
}

const supabaseRefOfHost = (h: string) => /^(?:db\.)?([a-z]{20})\.supabase\.co$/.exec(h)?.[1];

export function resolve(found: Map<string, Found>, refs: Ref[]): { edges: Edge[]; issues: Issue[]; dangling: { domain: string; target: string; platform: string }[] } {
  const alias = new Map<string, string>();
  for (const [k, f] of found) for (const a of f.also ?? []) alias.set(keyOf(a), k);
  if (alias.size) refs = refs.map((r) => ({ ...r, from: alias.get(r.from) ?? r.from, ...(r.to && { to: alias.get(r.to) ?? r.to }) }));
  const byHost = new Map<string, string>(), byIp = new Map<string, string>();
  for (const [k, f] of found) {
    if (f.kind === 'domain') continue;
    for (const h of f.hosts ?? []) if (!byHost.has(h)) byHost.set(h, k);
    for (const ip of f.ips ?? []) if (!byIp.has(ip)) byIp.set(ip, k);
  }
  const edges: Edge[] = [], issues: Issue[] = [], dangling: { domain: string; target: string; platform: string }[] = [];
  const seen = new Set<string>();
  const edge = (e: Edge) => { const id = `${e.from}|${e.to}|${e.kind}|${e.via}`; if (!seen.has(id) && e.from !== e.to && found.has(e.from) && found.has(e.to)) { seen.add(id); edges.push(e); } };

  // 1. domains added on a host (authoritative: the host says this domain is this app's)
  const attached = new Map<string, string[]>(); // domain key -> app keys
  for (const r of refs.filter((x) => x.kind === 'domain' && x.host)) {
    const d = domainKey(r.host!);
    attached.set(d, [...new Set([...(attached.get(d) ?? []), r.from])]); // one app seen by two accounts is still one app
  }

  // 2. DNS records: what each domain actually points at
  const dnsOf = new Map<string, Ref[]>();
  for (const r of refs.filter((x) => x.kind === 'dns')) dnsOf.set(r.from, [...(dnsOf.get(r.from) ?? []), r]);
  for (const [d, recs] of dnsOf) {
    const apps = attached.get(d) ?? [];
    for (const r of recs) {
      const owner = (r.ip && byIp.get(r.ip)) || (r.host && byHost.get(r.host));
      // a server address: the app on that server that has this domain is the real target
      const app = apps.find((a) => (!!found.get(a)?.platform && found.get(a)?.platform === platformOf(r)) || (!!owner && (owner === a || runsOn(refs, a) === owner)));
      if (app) continue; // confirmed by step 3
      if (owner) { edge({ from: d, to: owner, kind: 'dns', via: r.via, status: 'ok' }); continue; }
      const p = platformOf(r);
      if (r.host && p && !apps.length) dangling.push({ domain: d.slice(7), target: r.host, platform: p });
    }
  }

  // 3. each attachment: does DNS agree?
  for (const [d, apps] of attached) {
    const recs = dnsOf.get(d) ?? [];
    if (apps.length > 1) issues.push({ severity: 'warning', key: `dup:${d}`, about: d, text: `${d.slice(7)} is added to ${apps.length} apps (${apps.map((a) => found.get(a)?.name ?? a).join(', ')}); only one can get its traffic.` });
    for (const a of apps) {
      const f = found.get(a);
      const server = runsOn(refs, a);
      const ok = recs.some((r) => (!!f?.platform && platformOf(r) === f.platform) || (!!server && !!r.ip && byIp.get(r.ip) === server) || (!!r.host && byHost.get(r.host) === a) || (!!r.ip && !!f?.ips?.includes(r.ip)));
      // a host whose addresses Unit7 doesn't know (shared web hosting): can't judge, so don't cry wolf
      const checkable = !!server || !!f?.ips?.length || PLATFORMS.some((p) => p.id === f?.platform);
      const via = refs.find((x) => x.kind === 'domain' && x.from === a && domainKey(x.host!) === d)!.via;
      const got = recs.map((r) => `${r.via}`).join(', ');
      const status = !recs.length ? 'unknown' : ok ? 'ok' : checkable ? 'misconfigured' : 'unknown';
      edge({ from: d, to: a, kind: 'domain', via, status, detail: !recs.length ? 'doesn’t resolve' : status === 'misconfigured' ? `DNS says ${got}` : undefined });
      if (status === 'misconfigured') issues.push({ severity: 'warning', key: `dns:${d}:${a}`, about: d, text: `${d.slice(7)} is added to ${f?.name} but its DNS points elsewhere (${got}).` });
    }
  }

  // 4. what each app's settings point at; a domain stands for the app it reaches
  const reach = (host: string) => byHost.get(host) ?? edges.find((e) => e.from === domainKey(host) && e.status !== 'misconfigured')?.to;
  for (const r of refs.filter((x) => x.kind === 'env')) {
    const sref = r.supabase ?? (r.host ? supabaseRefOfHost(r.host) : undefined);
    if (sref) {
      if (found.has(`supabase:${sref}`)) edge({ from: r.from, to: `supabase:${sref}`, kind: 'env', via: r.via, status: 'ok' });
      else issues.push({ severity: 'info', key: `ext-supabase:${sref}`, about: r.from, text: `${found.get(r.from)?.name} uses Supabase project ${sref}, which isn't in any connected Supabase account.` });
      continue;
    }
    // a scan that knows exactly what a setting names (Unit7's own wiring) says so with `to`
    const to = (r.to && found.has(r.to) ? r.to : undefined) || (r.ip && byIp.get(r.ip)) || (r.host && reach(r.host));
    if (to) edge({ from: r.from, to, kind: 'env', via: r.via, status: 'ok' });
  }
  for (const r of refs.filter((x) => x.kind === 'runs_on' && x.to)) edge({ from: r.from, to: r.to!, kind: 'runs_on', via: r.via, status: 'ok' });
  // inside a server: an app talking to a database or service next to it (from the X-ray)
  for (const r of refs.filter((x) => x.kind === 'uses' && x.to)) edge({ from: r.from, to: r.to!, kind: 'uses', via: r.via, status: 'ok' });

  // 5. an app relying on a database that's paused
  for (const e of edges.filter((x) => x.kind === 'env')) {
    const t = found.get(e.to);
    if (t?.kind === 'database' && t.status && /paus|inactive|removed/i.test(t.status)) issues.push({ severity: 'warning', key: `paused:${e.to}`, about: e.from, text: `${found.get(e.from)?.name} uses ${t.name}, which is ${t.status.toLowerCase()}.` });
  }
  return { edges, issues, dangling };
}

const runsOn = (refs: Ref[], app: string) => refs.find((r) => r.kind === 'runs_on' && r.from === app)?.to;
