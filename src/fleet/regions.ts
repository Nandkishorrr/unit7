// Regions, light: where an app's visitors come from, and where its servers are with their share of visitors and how fast
// they answer. Countries come from the proxy's own log when Cloudflare sits in front (it adds the visitor's country to
// every request), else from Cloudflare's analytics when the domain is there, else Unit7 says it doesn't know. Read copies
// of the database (a copy near the visitors that only reads) are guidance with links for now: Unit7 doesn't set them up.
import { all, get, json, type DB } from '../db.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import type { ServiceRow } from '../deploy/deployer.ts';
import type { Summary, Hit } from '../sentinel/traffic.ts';
import { readSiteLog } from '../deploy/release.ts';
import type { Ctx } from '../tools/runtime.ts';
import { isTestHost } from '../care/readiness.ts';
import { shares, targetsOf } from './model.ts';

export interface CountryCount { code: string; name: string; requests: number }
const names = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return undefined; } })();
export const countryName = (code: string) => { try { return names?.of(code) ?? code; } catch { return code; } };

// the visitors' countries in a log, or null when no line says (no Cloudflare in front)
export function countriesFromHits(hits: Pick<Hit, 'country'>[]): CountryCount[] | null {
  const n = new Map<string, number>();
  for (const h of hits) if (h.country && h.country !== 'XX' && h.country !== 'T1') n.set(h.country, (n.get(h.country) ?? 0) + 1);
  if (!n.size) return null;
  return [...n].map(([code, requests]) => ({ code, name: countryName(code), requests })).sort((a, b) => b.requests - a.requests);
}

// a server's region: the label a person (or the provider) gave it
export const regionOf = (facts: string) => { const f = json<{ region?: string }>(facts, {}); return f.region?.trim() || null; };

export interface RegionServer { serverId: string; name: string; region: string | null; share: number; p95: number | null; requests: number | null; state: string; primary: boolean; role: string }
export const READ_COPIES = [
  { id: 'neon', name: 'Neon', words: 'Read replicas: another compute on the same data, for reads only. Point reads at its address.', url: 'https://neon.com/docs/introduction/read-replicas' },
  { id: 'supabase', name: 'Supabase', words: 'Read replicas in other regions on paid plans; each has its own connection string.', url: 'https://supabase.com/docs/guides/platform/read-replicas' },
  { id: 'aws', name: 'Amazon RDS', words: 'Read replicas in the same or another region; writes still go to the main one.', url: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html' },
];
export const READ_COPY_NOTE = 'Unit7 doesn’t set up read copies yet. Your app has to send writes to the main database and only reads to a copy: an app that writes everywhere keeps using the main one.';

// servers grouped by region, each region's share of visitors and its slowest typical answer; the top countries
export function regionView(servers: RegionServer[], countries: CountryCount[] | null, source: 'traffic' | 'cloudflare' | 'unknown') {
  const groups = new Map<string, RegionServer[]>();
  for (const s of servers) groups.set(s.region ?? 'Not set', [...(groups.get(s.region ?? 'Not set') ?? []), s]);
  const regions = [...groups].map(([region, list]) => {
    const p95s = list.map((s) => s.p95).filter((x): x is number => typeof x === 'number');
    return { region, servers: list, share: list.reduce((n, s) => n + s.share, 0), p95: p95s.length ? Math.max(...p95s) : null };
  }).sort((a, b) => b.share - a.share);
  const total = countries?.reduce((n, c) => n + c.requests, 0) ?? 0;
  const top = (countries ?? []).slice(0, 5).map((c) => ({ ...c, pct: total ? Math.round((c.requests / total) * 1000) / 10 : 0 }));
  const rest = total ? Math.round(((total - top.reduce((n, c) => n + c.requests, 0)) / total) * 1000) / 10 : 0;
  const words = !countries ? 'Unit7 doesn’t know where visitors come from yet: that needs Cloudflare in front of the domain (free).'
    : `Most visitors come from ${top[0]!.name} (${top[0]!.pct}%)${top[1] ? `, then ${top[1].name} (${top[1].pct}%)` : ''}.`;
  return { regions, countries: top, otherPct: rest, total, source, words, readCopies: READ_COPIES, readCopyNote: READ_COPY_NOTE };
}

// --- gathering ---------------------------------------------------------------------------------------------------------
const latestWindow = (db: DB, serverId: string) => json<Partial<Summary>>(get<{ summary: string }>(db, 'SELECT summary FROM traffic_windows WHERE server_id = ? ORDER BY at DESC LIMIT 1', serverId)?.summary, {});

// Cloudflare's own count of requests by country for the domain's zone over the last day (a token that may read analytics)
export const regionDeps = {
  async cloudflare(ctx: Ctx, hostname: string): Promise<CountryCount[] | null> {
    const acc = get<{ id: string }>(ctx.db, `SELECT id FROM accounts WHERE org_id = ? AND provider = 'cloudflare' AND status != 'failing' LIMIT 1`, ctx.orgId);
    if (!acc) return null;
    const { cloudflare } = await import('../connectors/cloudflare.ts');
    const zone = await cloudflare.findZone(ctx, acc.id, hostname).catch(() => undefined);
    if (!zone) return null;
    const since = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const { value } = ctx.credentialFor('cloudflare', acc.id);
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ query: 'query($z: String!, $d: Date!) { viewer { zones(filter: { zoneTag: $z }) { httpRequests1dGroups(limit: 2, filter: { date_geq: $d }) { sum { countryMap { clientCountryName requests } } } } } }', variables: { z: zone.id, d: since } }),
    }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { data?: { viewer?: { zones?: { httpRequests1dGroups?: { sum?: { countryMap?: { clientCountryName: string; requests: number }[] } }[] }[] } } } | null;
    const rows = data?.data?.viewer?.zones?.[0]?.httpRequests1dGroups?.flatMap((g) => g.sum?.countryMap ?? []) ?? [];
    if (!rows.length) return null;
    const n = new Map<string, number>();
    for (const r of rows) if (/^[A-Z]{2}$/.test(r.clientCountryName)) n.set(r.clientCountryName, (n.get(r.clientCountryName) ?? 0) + r.requests);
    return [...n].map(([code, requests]) => ({ code, name: countryName(code), requests })).sort((a, b) => b.requests - a.requests);
  },
  readLog: readSiteLog,
};

export async function regionsFor(ctx: Ctx, svc: ServiceRow) {
  const ts = targetsOf(ctx.db, svc);
  const share = shares(ts);
  const servers: RegionServer[] = ts.map((t) => {
    const s = get<{ facts: string }>(ctx.db, 'SELECT facts FROM servers WHERE id = ?', t.serverId);
    const w = latestWindow(ctx.db, t.serverId);
    return { serverId: t.serverId, name: t.name, region: regionOf(s?.facts ?? '{}'), share: share[t.serverId] ?? 0, p95: typeof w.p95 === 'number' ? Math.round(w.p95) : null, requests: typeof w.requests === 'number' ? w.requests : null, state: t.state, primary: t.primary, role: t.role };
  });
  const hosts = all<{ hostname: string }>(ctx.db, 'SELECT hostname FROM domains WHERE service_id = ? AND org_id = ?', svc.id, ctx.orgId).map((d) => d.hostname).filter((h) => !isTestHost(h));
  let countries: CountryCount[] | null = null, source: 'traffic' | 'cloudflare' | 'unknown' = 'unknown';
  const main = svc.server_id ? get<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE id = ?', svc.server_id) : undefined;
  if (main && hosts.length) {
    const log = await regionDeps.readLog(ctx.app, main, hosts, '6h').catch(() => null);
    countries = log ? countriesFromHits(log.hits) : null;
    if (countries) source = 'traffic';
  }
  if (!countries && hosts[0]) { countries = await regionDeps.cloudflare(ctx, hosts[0]).catch(() => null); if (countries) source = 'cloudflare'; }
  return { serviceId: svc.id, name: svc.name, ...regionView(servers, countries, source) };
}
