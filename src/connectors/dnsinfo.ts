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

// --- SPF: a name has one record, so a new sender joins what's there ---------------------------------------------------
// a TXT value as DNS means it: some hosts hand it back in quotes, a long one in several
export const bareTxt = (t: string) => t.trim().replace(/^"|"$/g, '').replace(/"\s+"/g, '');
export const isSpf = (t: string) => /^v=spf1(\s|$)/i.test(bareTxt(t));
const spfTerms = (t: string) => (isSpf(t) ? bareTxt(t).split(/\s+/).slice(1) : t.trim().split(/\s+/));
const closing = (t: string) => /^[-~?+]?all$/i.test(t) || /^redirect=/i.test(t);
// every sender in the old record(s) stays, new ones go before the closing term, and that term is never loosened
export function mergeSpf(existing: string[], add = '') {
  const had = existing.filter(isSpf).flatMap(spfTerms), want = add ? spfTerms(add) : [];
  const seen = new Set<string>(), terms = [...had, ...want].filter((t) => { const k = t.toLowerCase(); if (closing(t) || seen.has(k)) return false; seen.add(k); return true; });
  return ['v=spf1', ...terms, had.find(closing) ?? want.find(closing) ?? '~all'].join(' ');
}
// nothing the old record allowed is lost, and it ends the same way
export const spfKeeps = (old: string, next: string) => { const is = new Set(spfTerms(next).map((t) => t.toLowerCase())); return spfTerms(old).every((t) => is.has(t.toLowerCase())); };
// DNS lookups a receiver spends on this record alone (what it includes costs more): over 10 and SPF fails
export const spfLookups = (t: string) => spfTerms(t).filter((x) => /^[-~?+]?(include:|exists:|ptr(:|$)|a([:/]|$)|mx([:/]|$))|^redirect=/i.test(x)).length;

// who answers a domain's mail, from its MX, and the term that lets them send too
const MAIL_HOSTS: [RegExp, string, string][] = [
  [/\.google(mail)?\.com$/i, 'Google', 'include:_spf.google.com'],
  [/\.outlook\.com$/i, 'Microsoft 365', 'include:spf.protection.outlook.com'],
  [/\.mx\.cloudflare\.net$/i, 'Cloudflare Email Routing', 'include:_spf.mx.cloudflare.net'],
  [/\.hostinger\.com$/i, 'Hostinger Email', 'include:_spf.mail.hostinger.com'],
  [/\.zoho\.(com|eu|in)$/i, 'Zoho Mail', 'include:zoho.com'],
  [/\.protonmail\.ch$/i, 'Proton Mail', 'include:_spf.protonmail.ch'],
  [/\.messagingengine\.com$/i, 'Fastmail', 'include:spf.messagingengine.com'],
];
export const mailHost = (mx: string[]) => { for (const m of mx) for (const [re, name, spf] of MAIL_HOSTS) if (re.test(m.trim().split(/\s+/).pop()!.replace(/\.$/, ''))) return { name, spf }; return undefined; };

// What a name's SPF should say, as one whole line to write, or nothing when it's right. A sender adds to what's there;
// with no record, the mail host's term goes in, and a domain with no mail says it sends none.
export function spfAdvice(txt: string[], mx: string[], add?: string): { record?: string; why: string } | undefined {
  const spf = txt.filter(isSpf), host = mailHost(mx), need = [add, host?.spf].filter(Boolean).join(' ');
  if (spf.length) {
    const record = mergeSpf(spf, need);
    return spf.length === 1 && record === mergeSpf(spf) ? undefined : { record, why: spf.length > 1 ? 'A name can only have one SPF record: two break both. This joins them and keeps every sender.' : 'This keeps every sender already there and adds the new one.' };
  }
  if (need) return { record: mergeSpf([], need), why: `It lets ${[host?.name, add && 'your sender'].filter(Boolean).join(' and ')} send as this domain.` };
  return mx.length ? { why: 'Your email host gives you the term for its senders (like include:_spf.example.net). email.setup with spfInclude joins it to the record.' } : { record: 'v=spf1 -all', why: 'It says this domain sends no email.' };
}
