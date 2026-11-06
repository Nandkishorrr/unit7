// Facts about a domain from DNS itself, not guesses: which zone a hostname lives in, who serves that
// zone's DNS (from its nameservers), and whether a name resolves to what it should yet — asked of
// public resolvers, so a stale local cache never fools the "has it propagated?" check.
import { Resolver } from 'node:dns/promises';

export interface Lookup {
  soa(name: string): Promise<unknown>;
  ns(name: string): Promise<string[]>;
  a(name: string): Promise<string[]>;
  cname(name: string): Promise<string[]>;
}

export const publicResolver = (): Lookup => {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return { soa: (n) => r.resolveSoa(n), ns: (n) => r.resolveNs(n), a: (n) => r.resolve4(n), cname: (n) => r.resolveCname(n) };
};

// The zone a hostname belongs to: walk up the labels until one answers SOA (works for example.co.uk,
// where "the last two labels" would wrongly give co.uk).
export async function zoneOf(hostname: string, dns: Lookup = publicResolver()): Promise<string | undefined> {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    // a CNAME can't sit at a zone's apex, but asking it for SOA answers with its target's zone
    if (await dns.cname(name).then((c) => c.length > 0, () => false)) continue;
    try { await dns.soa(name); return name; } catch { /* not a zone apex; keep walking up */ }
  }
  return undefined;
}

// Who serves a zone's DNS, recognised from its nameservers.
const HOSTS: [RegExp, string][] = [
  [/\.ns\.cloudflare\.com$/, 'cloudflare'],
  [/(dns-parking\.com|hostinger\.)/, 'hostinger'],
  [/domaincontrol\.com$/, 'godaddy'],
  [/registrar-servers\.com$/, 'namecheap'],
  [/porkbun\.com$/, 'porkbun'],
  [/vercel-dns\.com$/, 'vercel'],
  [/nsone\.net$/, 'nsone'], // NS1: Netlify DNS uses it, and so do many others
  [/digitalocean\.com$/, 'digitalocean'],
  [/awsdns-/, 'route53'],
  [/squarespacedns\.com$|squarespace-dns\.com$/, 'squarespace'],
  [/googledomains\.com$/, 'google'], // Google Cloud DNS, or an old Google Domains zone now at Squarespace
  [/netlifydns\.com$/, 'netlify'],
  [/(^|\.)name\.com$/, 'namecom'],
  [/gandi\.net$/, 'gandi'],
  [/ui-dns\./, 'ionos'],
  [/ovh\.net$/, 'ovh'],
  [/\.azure-dns\.(com|net|org|info)$/, 'azure'], // ns1-37.azure-dns.com … (https://learn.microsoft.com/en-us/azure/dns/dns-delegate-domain-azure-dns)
  [/\.ns\.hetzner\.(com|de)$/, 'hetzner'],       // hydrogen/oxygen.ns.hetzner.com, helium.ns.hetzner.de
];
export function dnsHostFromNs(ns: string[]): string | undefined {
  for (const n of ns.map((x) => x.toLowerCase().replace(/\.$/, ''))) for (const [re, id] of HOSTS) if (re.test(n)) return id;
  return undefined;
}

export async function dnsHost(hostname: string, dns: Lookup = publicResolver()): Promise<{ zone?: string; host?: string; nameservers: string[] }> {
  const zone = await zoneOf(hostname, dns);
  if (!zone) return { nameservers: [] };
  const nameservers = await dns.ns(zone).catch(() => [] as string[]);
  return { zone, host: dnsHostFromNs(nameservers), nameservers };
}

// Does the name resolve to what it should? (an IP for an A record, or a CNAME target)
export async function resolvesTo(hostname: string, want: { a?: string[]; cname?: string }, dns: Lookup = publicResolver()): Promise<{ ok: boolean; got: string[] }> {
  const norm = (s: string) => s.toLowerCase().replace(/\.$/, '');
  if (want.cname) {
    const got = await dns.cname(hostname).catch(() => [] as string[]);
    if (got.map(norm).includes(norm(want.cname))) return { ok: true, got };
    // flattened/ALIAS apex: no CNAME visible, but it resolves to the same addresses as the target
    const [mine, theirs] = await Promise.all([dns.a(hostname).catch(() => [] as string[]), dns.a(want.cname).catch(() => [] as string[])]);
    return { ok: mine.length > 0 && mine.some((ip) => theirs.includes(ip)), got: got.length ? got : mine };
  }
  const got = await dns.a(hostname).catch(() => [] as string[]);
  return { ok: !!want.a?.length && want.a.some((ip) => got.includes(ip)), got };
}
