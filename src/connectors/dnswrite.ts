// Writing DNS records wherever a domain's DNS actually lives. Unit7 asks DNS who serves the zone
// (dnsinfo.ts), then looks for a connected account at that provider that owns the zone, and writes
// there. When no connected account can, it returns the exact records for a person to add — and
// Warden keeps checking until they're live, then finishes the job.
import type { Ctx } from '../tools/runtime.ts';
import { all } from '../db.ts';
import { cloudflare, cfApi } from './cloudflare.ts';
import { hostinger } from './hostinger.ts';
import { dnsHost } from './dnsinfo.ts';
import { vercel } from './clouds.ts';
import { bearerFor } from './mcp-oauth.ts';
import { assertReachable } from '../netguard.ts';
import { Unit7Error } from '../errors.ts';
import { google, googleDns, viaFirebaseCli, type GRRSet } from './google.ts';
import { aws, route53, type R53Set } from './aws.ts';
import { azure, azureDns, type AzRecordSet } from './azure.ts';
import { hetzner, hetznerDns } from './hetzner.ts';

export interface Rec { type: 'A' | 'AAAA' | 'CNAME' | 'ALIAS' | 'TXT'; name: string; content: string; ttl?: number }

interface Writer {
  owns(ctx: Ctx, accountId: string, zone: string): Promise<boolean>;
  upsert(ctx: Ctx, accountId: string, zone: string, rec: Rec): Promise<void>;
}

const relative = (name: string, zone: string) => (name === zone ? '@' : name.slice(0, -zone.length - 1));
const sub = (name: string, zone: string) => (name === zone ? '' : relative(name, zone));
const noAlias = (who: string, rec: Rec) => {
  if (rec.type === 'ALIAS') throw new Unit7Error('unsupported', `${who} can't point the bare domain at a hostname (no ALIAS records). Use www, or move this domain's DNS to Cloudflare (free; Unit7 can do it).`, 409);
};

// a provider's API address; tests point it at a fake with UNIT7_<NAME>_API
const apiBase = (name: string, url: string) => () => process.env[`UNIT7_${name}_API`] ?? url;

// SRV and CAA are kept the way a zone file writes them ("10 5 5060 sip.example.com", `0 issue "letsencrypt.org"`), so a
// record reads the same on every host; the hosts that split them into fields go through these.
export const srvOf = (v: string) => { const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/.exec(v.trim()); return m ? { priority: Number(m[1]), weight: Number(m[2]), port: Number(m[3]), target: m[4]!.replace(/\.$/, '') } : undefined; };
export const caaOf = (v: string) => { const m = /^(\d+)\s+(issuewild|issue|iodef)\s+"?([^"]*)"?$/i.exec(v.trim()); return m ? { flags: Number(m[1]), tag: m[2]!.toLowerCase(), value: m[3]! } : undefined; };
const srvLine = (s: { priority: number; weight: number; port: number; target: string }) => `${s.priority} ${s.weight} ${s.port} ${s.target.replace(/\.$/, '')}`;
const caaLine = (c: { flags: number; tag: string; value: string }) => `${c.flags} ${c.tag} "${c.value}"`;
// a host's SRV answer: all four parts, or weight, port and target with the priority on its own
const srvJoin = (v: string, prio?: number | string | null) => { const t = v.trim().replace(/\.$/, ''); return t.split(/\s+/).length === 3 ? `${prio ?? 0} ${t}` : t; };

// JSON over HTTPS with a readable error
export async function rest<T = any>(who: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  await assertReachable(new URL(url).hostname);
  const res = await fetch(url, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (who === 'GoDaddy' && res.status === 403) throw new Unit7Error('dns_error', 'GoDaddy refused this key. It limits its DNS API by account (how many domains, or a paid plan), so a good key can still be refused. Ask GoDaddy about API access, or move this domain’s DNS to Cloudflare (free; Unit7 can do it).', 403);
  if (!res.ok || data?.status === 'ERROR') throw new Unit7Error('dns_error', `${who}: ${data?.message ?? data?.error?.message ?? data?.id ?? (data?.errors ? JSON.stringify(data.errors) : res.statusText || res.status)}`.slice(0, 300), res.status === 403 || res.status === 401 ? 403 : 502);
  return data as T;
}

// one URL path segment: encoded, and never empty, "." or ".." (a URL parser would walk up the path with those)
export const seg = (v: string | number | undefined) => {
  const s = v === undefined ? '' : String(v);
  if (!s || s === '.' || s === '..') throw new Unit7Error('invalid_input', `“${s}” isn’t a name Unit7 can look up.`, 400);
  return encodeURIComponent(s);
};

export const WRITERS: Record<string, Writer> = {
  cloudflare: {
    owns: async (ctx, acc, zone) => !!(await cloudflare.findZone(ctx, acc, zone).catch(() => undefined))?.name,
    async upsert(ctx, acc, zone, rec) {
      const z = (await cloudflare.findZone(ctx, acc, zone))!;
      // Cloudflare flattens a CNAME at the apex itself, so ALIAS is written as CNAME
      await cloudflare.upsertRecord(ctx, acc, z.id, { type: rec.type === 'ALIAS' ? 'CNAME' : rec.type, name: rec.name, content: rec.content, ttl: rec.ttl, proxied: false });
    },
  },
  hostinger: {
    owns: (ctx, acc, zone) => hostinger(ctx.app).call(ctx, acc, 'execute', { operation: 'dns_records_list', params: { domain: zone } }, 60_000).then(() => true, () => false),
    async upsert(ctx, acc, zone, rec) {
      // overwrite replaces only records with this name AND type (Hostinger's documented behaviour), never the zone
      await hostinger(ctx.app).call(ctx, acc, 'execute', { operation: 'dns_records_update', params: { domain: zone, overwrite: true, zone: [{ name: relative(rec.name, zone), type: rec.type, ttl: rec.ttl ?? 300, records: [{ content: rec.content }] }] } }, 60_000);
    },
  },
};

// GoDaddy: a personal access token (Bearer), or a legacy KEY:SECRET pair
export const GODADDY = apiBase('GODADDY', 'https://api.godaddy.com');
export const gd = async (ctx: Ctx, acc: string) => { const v = ctx.credentialFor('godaddy', acc).value; return { authorization: /^[^:\s]+:[^:\s]+$/.test(v) ? `sso-key ${v}` : `Bearer ${v}` }; };
WRITERS.godaddy = {
  owns: async (ctx, acc, zone) => rest('GoDaddy', `${GODADDY()}/v1/domains/${seg(zone)}`, { headers: await gd(ctx, acc) }).then(() => true),
  async upsert(ctx, acc, zone, rec) {
    noAlias('GoDaddy', rec);
    // replaces only this name + type (never PUT /records: that replaces the whole zone)
    await rest('GoDaddy', `${GODADDY()}/v1/domains/${seg(zone)}/records/${rec.type}/${seg(relative(rec.name, zone))}`, { method: 'PUT', headers: await gd(ctx, acc), body: [{ data: rec.content, ttl: Math.max(600, rec.ttl ?? 600) }] });
  },
};

// Vercel's own DNS (the zone's nameservers are ns1/ns2.vercel-dns.com)
WRITERS.vercel = {
  owns: async (ctx, acc, zone) => (seg(zone), !!(await vercel.dnsTeam(ctx, acc, zone))),
  async upsert(ctx, acc, zone, rec) {
    seg(zone); // vercel.dnsTeam puts it in a path
    const { team } = (await vercel.dnsTeam(ctx, acc, zone))!;
    await vercel.upsertDns(ctx, acc, zone, team, { type: rec.type, name: sub(rec.name, zone), value: rec.content, ttl: Math.max(60, rec.ttl ?? 60) });
  },
};

// DigitalOcean DNS
export const DO = apiBase('DIGITALOCEAN', 'https://api.digitalocean.com/v2');
export const doAuth = async (ctx: Ctx, acc: string) => ({ authorization: `Bearer ${await bearerFor(ctx, 'digitalocean', acc)}` });
WRITERS.digitalocean = {
  owns: async (ctx, acc, zone) => rest('DigitalOcean', `${DO()}/domains/${seg(zone)}`, { headers: await doAuth(ctx, acc) }).then(() => true),
  async upsert(ctx, acc, zone, rec) {
    noAlias('DigitalOcean', rec);
    const headers = await doAuth(ctx, acc);
    const { domain_records } = await rest<{ domain_records: { id: number }[] }>('DigitalOcean', `${DO()}/domains/${seg(zone)}/records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`, { headers });
    const body = { type: rec.type, name: relative(rec.name, zone), data: rec.type === 'CNAME' ? `${rec.content}.` : rec.content, ttl: Math.max(30, rec.ttl ?? 300) };
    if (domain_records[0]) await rest('DigitalOcean', `${DO()}/domains/${seg(zone)}/records/${seg(domain_records[0].id)}`, { method: 'PUT', headers, body });
    else await rest('DigitalOcean', `${DO()}/domains/${seg(zone)}/records`, { headers, body });
  },
};

// Porkbun: KEY:SECRET, sent in the body. Each domain must have "API Access" switched on.
export const PORKBUN = apiBase('PORKBUN', 'https://api.porkbun.com/api/json/v3');
export const pb = (ctx: Ctx, acc: string) => { const [apikey, secretapikey] = ctx.credentialFor('porkbun', acc).value.split(':'); return { apikey, secretapikey }; };
WRITERS.porkbun = {
  owns: (ctx, acc, zone) => rest('Porkbun', `${PORKBUN()}/dns/retrieve/${seg(zone)}`, { body: pb(ctx, acc) }).then(() => true, (e: Unit7Error) => {
    if (/opt|api access/i.test(e.message)) throw new Unit7Error('dns_error', `Porkbun: switch on API Access for ${zone} (Domain Management → Details → API Access), then Unit7 can write its records.`, 409);
    return false;
  }),
  async upsert(ctx, acc, zone, rec) {
    const auth = pb(ctx, acc);
    const { records } = await rest<{ records: { id: string; name: string; type: string }[] }>('Porkbun', `${PORKBUN()}/dns/retrieve/${seg(zone)}`, { body: auth });
    const hit = records.find((r) => r.name === rec.name && r.type === rec.type);
    const body = { ...auth, name: sub(rec.name, zone), type: rec.type, content: rec.content, ttl: String(Math.max(600, rec.ttl ?? 600)) };
    await rest('Porkbun', hit ? `${PORKBUN()}/dns/edit/${seg(zone)}/${seg(hit.id)}` : `${PORKBUN()}/dns/create/${seg(zone)}`, { body });
  },
};

// Name.com (Core API): USERNAME:TOKEN as HTTP Basic. Accounts with 2FA must switch API access on.
export const NAMECOM = apiBase('NAMECOM', 'https://api.name.com/core/v1');
export const nc = (ctx: Ctx, acc: string) => ({ authorization: `Basic ${Buffer.from(ctx.credentialFor('namecom', acc).value).toString('base64')}` });
WRITERS.namecom = {
  owns: (ctx, acc, zone) => rest('Name.com', `${NAMECOM()}/domains/${seg(zone)}`, { headers: nc(ctx, acc) }).then(() => true),
  async upsert(ctx, acc, zone, rec) {
    const headers = nc(ctx, acc);
    const type = rec.type === 'ALIAS' ? 'ANAME' : rec.type;
    const { records = [] } = await rest<{ records?: { id: number; fqdn?: string; host?: string; type: string }[] }>('Name.com', `${NAMECOM()}/domains/${seg(zone)}/records`, { headers });
    const hit = records.find((r) => r.type === type && (r.fqdn?.replace(/\.$/, '') === rec.name || (r.host || '@') === relative(rec.name, zone)));
    const body = { host: sub(rec.name, zone), type, answer: rec.content, ttl: Math.max(300, rec.ttl ?? 300) };
    if (hit) await rest('Name.com', `${NAMECOM()}/domains/${seg(zone)}/records/${seg(hit.id)}`, { method: 'PUT', headers, body });
    else await rest('Name.com', `${NAMECOM()}/domains/${seg(zone)}/records`, { headers, body });
  },
};

// Every record in a zone, any type (to move a domain's DNS without losing email records)
export interface FullRec { type: string; name: string; content: string; ttl?: number; priority?: number; proxied?: boolean } // proxied: Cloudflare's orange cloud
// a name in its zone, fully written out (Name.com's fqdn ends in a dot: dropped first, so it isn't taken as relative)
const fq = (raw: string, zone: string) => { const name = raw.replace(/\.$/, ''); return (!name || name === '@' ? zone : name.endsWith(zone) ? name : `${name}.${zone}`).toLowerCase(); };
const mx = (content: string, prio?: number) => { const m = /^(\d+)\s+(.+)$/.exec(content); return m && prio === undefined ? { content: m[2]!, priority: Number(m[1]) } : { content, priority: prio }; };
type GdRow = { type?: string; name?: string; data: string; ttl: number; priority?: number; service?: string; protocol?: string; port?: number; weight?: number };
const gdRec = (r: GdRow, zone: string, type = r.type!, name = r.name ?? '@'): FullRec => (type === 'SRV'
  ? { type, name: fq(name.startsWith('_') ? name : [r.service, r.protocol, name === '@' ? '' : name].filter(Boolean).join('.'), zone), content: srvLine({ priority: r.priority ?? 0, weight: r.weight ?? 0, port: r.port ?? 0, target: r.data }), ttl: r.ttl }
  : { type, name: fq(name, zone), content: r.data, ttl: r.ttl, priority: r.priority });
type PbRow = { id?: string; type: string; name: string; content: string; ttl: string; prio?: string | null };
const pbRec = (r: PbRow, zone: string): Hit => ({ ...(r.id && { id: r.id }), type: r.type, name: fq(r.name, zone), content: r.type === 'SRV' ? srvJoin(r.content, r.prio) : r.content, ttl: Number(r.ttl), priority: r.prio && r.type === 'MX' ? Number(r.prio) : undefined });
type NcRow = { id?: number; type: string; fqdn?: string; host?: string; answer: string; ttl: number; priority?: number };
const ncRec = (r: NcRow, zone: string): Hit => ({ ...(r.id !== undefined && { id: r.id }), type: r.type, name: fq(r.fqdn ?? r.host ?? '', zone), content: r.type === 'SRV' ? srvJoin(r.answer, r.priority) : r.answer, ttl: r.ttl, priority: r.type === 'SRV' ? undefined : r.priority });
type DoRow = { id?: number; type: string; name: string; data: string; ttl: number; priority?: number | null; port?: number | null; weight?: number | null; flags?: number | null; tag?: string | null };
const doRec = (r: DoRow, zone: string): Hit => ({ ...(r.id !== undefined && { id: r.id }), type: r.type, name: fq(r.name, zone), ttl: r.ttl,
  ...(r.type === 'SRV' ? { content: srvLine({ priority: r.priority ?? 0, weight: r.weight ?? 0, port: r.port ?? 0, target: r.data }) }
    : r.type === 'CAA' ? { content: caaLine({ flags: r.flags ?? 0, tag: r.tag ?? 'issue', value: r.data.replace(/\.$/, '') }) }
    : { content: r.data === '@' ? zone : r.data, priority: r.priority ?? undefined }) });
type CfRow = { id: string; name: string; type: string; content: string; ttl: number; priority?: number; proxied?: boolean; data?: { priority: number; weight: number; port: number; target: string; flags: number; tag: string; value: string } };
const cfRec = (x: CfRow, zone: string): Hit => ({ id: x.id, type: x.type, name: fq(x.name, zone), ttl: x.ttl, ...(x.proxied !== undefined && { proxied: x.proxied }),
  ...(x.type === 'SRV' ? { content: x.data ? srvLine(x.data) : srvJoin(x.content, x.priority) } : x.type === 'CAA' && x.data ? { content: caaLine(x.data) } : { content: x.content, priority: x.priority }) });
type VcRow = { id?: string; name: string; type: string; value: string; ttl?: number; mxPriority?: number; priority?: number };
const vcRec = (r: VcRow, zone: string): Hit => ({ ...(r.id && { id: r.id }), type: r.type, name: fq(r.name, zone), content: r.type === 'SRV' ? srvJoin(r.value, r.priority) : r.value, ttl: r.ttl, priority: r.mxPriority });

export const LISTERS: Record<string, (ctx: Ctx, acc: string, zone: string) => Promise<FullRec[]>> = {
  hostinger: async (ctx, acc, zone) => {
    const text = await hostinger(ctx.app).call(ctx, acc, 'execute', { operation: 'dns_records_list', params: { domain: zone } }, 60_000);
    return (JSON.parse(text) as { name: string; type: string; ttl: number; records: { content: string }[] }[]).flatMap((r) => r.records.map((x) => ({ type: r.type, name: fq(r.name, zone), ttl: r.ttl, ...(r.type === 'MX' ? mx(x.content) : { content: r.type === 'SRV' ? x.content.replace(/\.$/, '') : x.content }) })));
  },
  godaddy: async (ctx, acc, zone) => (await rest<GdRow[]>('GoDaddy', `${GODADDY()}/v1/domains/${seg(zone)}/records`, { headers: await gd(ctx, acc) })).map((r) => gdRec(r, zone)),
  porkbun: async (ctx, acc, zone) => ((await rest<{ records?: PbRow[] }>('Porkbun', `${PORKBUN()}/dns/retrieve/${seg(zone)}`, { body: pb(ctx, acc) })).records ?? []).map((r) => pbRec(r, zone)),
  namecom: async (ctx, acc, zone) => ((await rest<{ records?: NcRow[] }>('Name.com', `${NAMECOM()}/domains/${seg(zone)}/records`, { headers: nc(ctx, acc) })).records ?? [])
    .map((r) => ({ ...ncRec(r, zone), type: r.type === 'ANAME' ? 'CNAME' : r.type })),
  digitalocean: async (ctx, acc, zone) => ((await rest<{ domain_records: DoRow[] }>('DigitalOcean', `${DO()}/domains/${seg(zone)}/records?per_page=200`, { headers: await doAuth(ctx, acc) })).domain_records).map((r) => doRec(r, zone)),
  vercel: async (ctx, acc, zone) => ((await vercel.dnsZones(ctx, acc)).find((z) => z.zone === zone)?.records ?? [])
    .map((r) => { const x = vcRec(r as VcRow, zone); return { ...x, type: r.type === 'ALIAS' ? 'CNAME' : r.type, ...(r.type === 'MX' ? mx(r.value, (r as VcRow).mxPriority) : {}) }; }),
  cloudflare: async (ctx, acc, zone) => {
    const z = await cloudflare.findZone(ctx, acc, zone);
    if (!z) throw new Unit7Error('not_found', `${zone} isn’t in this Cloudflare account.`, 404);
    return ((await cloudflare.listRecords(ctx, acc, z.id)) as CfRow[]).map((x) => cfRec(x, zone));
  },
};

// Registrars whose nameservers Unit7 can switch itself
export const NAMESERVERS: Record<string, (ctx: Ctx, acc: string, domain: string, ns: string[]) => Promise<void>> = {
  hostinger: async (ctx, acc, domain, ns) => { await hostinger(ctx.app).call(ctx, acc, 'execute', { operation: 'domains_portfolio_update-nameservers', params: { domain, ns1: ns[0], ns2: ns[1], ...(ns[2] && { ns3: ns[2] }), ...(ns[3] && { ns4: ns[3] }) } }, 60_000); },
  namecom: async (ctx, acc, domain, ns) => { await rest('Name.com', `${NAMECOM()}/domains/${seg(domain)}:setNameservers`, { headers: nc(ctx, acc), body: { nameservers: ns } }); },
};

// Where Unit7 can't write: what to do instead
const NO_API: Record<string, string> = {
  namecheap: 'Namecheap only opens its API to big accounts and fixed IP addresses, and its API replaces every record at once, so Unit7 won\u2019t risk your email records.',
  squarespace: 'Squarespace has no DNS API for domain owners.',
};

// a zone's DNS host (from its nameservers) → the connected account that edits it, when they're named differently;
// one Google sign-in can sit on the Google Cloud tile or the Firebase one
export const DNS_ACCOUNT: Record<string, string> = { route53: 'aws', google: 'gcp' };
export const SAME_SIGNIN: Record<string, string[]> = { gcp: ['gcp', 'firebase'], firebase: ['gcp', 'firebase'] };

export const dnsLook = { host: dnsHost }; // tests swap it
export interface WriteResult { zone?: string; host?: string; written: boolean; provider?: string; accountId?: string; records: Rec[]; why?: string; before?: FullRec[] }

// Put these records in place for a hostname. `prefer` pins a specific connected account; keep reads what's there first,
// so an undo can put it back.
export async function writeRecords(ctx: Ctx, hostname: string, records: Rec[], prefer?: { provider?: string; accountId?: string; keep?: boolean }): Promise<WriteResult> {
  const { zone, host } = await dnsLook.host(hostname.replace(/^\*\./, ''));
  if (!zone) return { written: false, records, why: `${hostname} doesn't exist in DNS yet. Is the domain registered?` };
  const provider = prefer?.provider ?? (host && (DNS_ACCOUNT[host] ?? host));
  const writer = provider && WRITERS[provider];
  if (!writer) return { zone, host, written: false, records, why: host ? NO_API[host] ?? `${zone}'s DNS is at ${host}, which Unit7 can't edit yet.` : `Unit7 couldn't tell who runs ${zone}'s DNS.` };
  const kinds = SAME_SIGNIN[provider] ?? [provider];
  const accounts = prefer?.accountId ? [prefer.accountId] : all<{ id: string }>(ctx.db, `SELECT id FROM accounts WHERE org_id = ? AND provider IN (${kinds.map(() => '?').join(', ')})`, ctx.orgId, ...kinds).map((a) => a.id);
  const problems: string[] = [];
  for (const acc of accounts) {
    try { if (!(await writer.owns(ctx, acc, zone))) continue; } catch (e) { problems.push((e as Error).message); continue; }
    const ed = prefer?.keep ? EDITORS[provider] : undefined;
    const before = ed ? (await Promise.all(records.map((r) => ed.find(ctx, acc, zone, { name: r.name, type: r.type }).catch(() => [])))).flat() : undefined;
    for (const r of records) await writer.upsert(ctx, acc, zone, r);
    return { zone, host, written: true, provider, accountId: acc, records, ...(before && { before }) };
  }
  return { zone, host, written: false, records, why: problems[0] ?? (accounts.length ? `None of your connected ${provider} accounts manages ${zone}.` : `${zone}'s DNS is at ${provider}. Connect your ${provider} account and Unit7 does this itself.`) };
}

// --- deleting a record, and putting one back (domain.remove_record and its undo) ---------------------------------
// Every DNS host Unit7 writes to can also: list the records at one name + type (find), delete them all or only the one
// with a given value (del, which returns exactly what it deleted, so the undo can put it back), and add one record next
// to whatever is already there (add, never a replace). Nothing here can touch more than one name + type at a time.
export interface RecQuery { name: string; type: string; value?: string }
export interface Editor {
  find(ctx: Ctx, acc: string, zone: string, q: RecQuery): Promise<FullRec[]>;
  del(ctx: Ctx, acc: string, zone: string, q: RecQuery): Promise<FullRec[]>;
  add(ctx: Ctx, acc: string, zone: string, r: FullRec): Promise<void>;
}
export const EDITORS: Record<string, Editor> = {};

// a record's value as people write it: no quotes around TXT, no trailing dot, any case; an MX may carry its priority
export const normValue = (v: string) => v.trim().replace(/^"|"$/g, '').replace(/"\s+"/g, '').replace(/\.$/, '').toLowerCase();
export const matches = (r: Pick<FullRec, 'content' | 'priority'>, value?: string) => value === undefined
  || normValue(r.content) === normValue(value) || (r.priority !== undefined && normValue(`${r.priority} ${r.content}`) === normValue(value.replace(/\s+/g, ' ')));
export const fqName = (name: string, zone: string) => fq(name, zone);
const relName = (name: string, zone: string) => relative(fq(name, zone), zone);
const subName = (name: string, zone: string) => sub(fq(name, zone), zone);
const quoted = (s: string) => (/^".*"$/s.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
const unquoted = (s: string) => s.replace(/^"((?:[^"\\]|\\.)*)"(\s+"((?:[^"\\]|\\.)*)")*$/s, (m) => [...m.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\"/g, '"')).join(''));
// One name + type moves to other records with nothing left unanswered: the new ones go in first, then the old ones go.
// A CNAME can't stand next to anything, and the same value can't stand next to itself (a new TTL, the orange cloud), so
// there the old one goes first and comes back if the new one fails.
const valueOf = (r: FullRec) => (r.priority !== undefined ? `${r.priority} ${r.content}` : r.content);
export async function swapRecords(ctx: Ctx, ed: Editor, acc: string, zone: string, q: { name: string; type: string }, old: FullRec[], next: FullRec[]) {
  const drop = async () => { for (const r of old) await ed.del(ctx, acc, zone, { name: q.name, type: q.type, value: valueOf(r) }); };
  const first = q.type === 'CNAME' || old.some((o) => next.some((n) => normValue(n.content) === normValue(o.content)));
  if (!first) { for (const r of next) await ed.add(ctx, acc, zone, r); return drop(); }
  await drop();
  try { for (const r of next) await ed.add(ctx, acc, zone, r); } catch (e) { for (const r of old) await ed.add(ctx, acc, zone, r).catch(() => undefined); throw e; }
}

// names back to what they said before a write (writeRecords' before): only what differs moves
export interface WriteUndo { provider: string; accountId: string; zone: string; added: FullRec[]; before: FullRec[] }
export async function putBack(ctx: Ctx, d: WriteUndo) {
  const ed = EDITORS[d.provider];
  if (!ed) return;
  const same = (a: FullRec, b: FullRec) => a.content.replace(/\.$/, '') === b.content.replace(/\.$/, '');
  for (const name of new Set(d.added.map((r) => r.name))) {
    const added = d.added.filter((r) => r.name === name), old = d.before.filter((r) => r.name === name);
    await swapRecords(ctx, ed, d.accountId, d.zone, { name, type: added[0]!.type }, added.filter((a) => !old.some((b) => same(a, b))), old.filter((b) => !added.some((a) => same(a, b))));
  }
}

// "Ids" each host gives its records, kept next to the record while deleting
type Hit = FullRec & { id?: string | number };
async function delHits(hits: Hit[], q: RecQuery, drop: (h: Hit) => Promise<unknown>): Promise<FullRec[]> {
  const gone = hits.filter((h) => matches(h, q.value));
  for (const h of gone) await drop(h);
  return gone.map(({ id: _id, ...r }) => r);
}

// Cloudflare: list by name + type, delete by id (DELETE /zones/{zone}/dns_records/{id})
// https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/
const cfAuth = (ctx: Ctx, acc: string) => ({ authorization: `Bearer ${ctx.credentialFor('cloudflare', acc).value}` });
async function cfHits(ctx: Ctx, acc: string, zone: string, q: RecQuery): Promise<{ zid: string; hits: Hit[] }> {
  const z = await cloudflare.findZone(ctx, acc, zone);
  if (!z) throw new Unit7Error('not_found', `${zone} isn’t in this Cloudflare account.`, 404);
  const r = await rest<{ result?: CfRow[] }>('Cloudflare', `${cfApi()}/zones/${seg(z.id)}/dns_records?type=${encodeURIComponent(q.type)}&name=${encodeURIComponent(fq(q.name, zone))}&per_page=100`, { headers: cfAuth(ctx, acc) });
  // filtered here too, so a value-less delete never reaches another record if Cloudflare ever ignored the filter;
  // proxied (and the TTL) kept so the undo brings it back exactly, behind the orange cloud when it was
  return { zid: z.id, hits: (r.result ?? []).map((x) => cfRec(x, zone)).filter((x) => x.type === q.type && x.name === fq(q.name, zone)) };
}
EDITORS.cloudflare = {
  find: async (ctx, acc, zone, q) => (await cfHits(ctx, acc, zone, q)).hits.map(({ id: _id, ...r }) => r),
  async del(ctx, acc, zone, q) { const { zid, hits } = await cfHits(ctx, acc, zone, q); return delHits(hits, q, (h) => rest('Cloudflare', `${cfApi()}/zones/${seg(zid)}/dns_records/${seg(h.id)}`, { method: 'DELETE', headers: cfAuth(ctx, acc) })); },
  async add(ctx, acc, zone, r) {
    const z = (await cloudflare.findZone(ctx, acc, zone))!;
    const data = r.type === 'SRV' ? srvOf(r.content) : r.type === 'CAA' ? caaOf(r.content) : undefined; // Cloudflare takes these two as fields
    await cloudflare.addRecord(ctx, acc, z.id, { type: r.type, name: r.name, ...(data ? { data } : { content: r.content }), ttl: r.ttl || 1, priority: r.priority, proxied: r.proxied });
  },
};

// Hostinger: delete is by name + type (DELETE /api/dns/v1/zones/{domain} with filters); one value of several is removed
// by writing the rest back for that name + type only (overwrite replaces just that name + type, never the zone)
// https://developers.hostinger.com/#tag/dns-zone/DELETE/api/dns/v1/zones/{domain}
const hx = (ctx: Ctx, acc: string, operation: string, params: Record<string, unknown>) => hostinger(ctx.app).call(ctx, acc, 'execute', { operation, params }, 60_000);
const hContent = (r: FullRec) => {
  const dot = `${r.content.replace(/\.$/, '')}.`; // its zone holds zone-file text, where a hostname ends in a dot
  return r.type === 'MX' && r.priority !== undefined ? `${r.priority} ${dot}` : r.type === 'SRV' || r.type === 'CNAME' ? dot : r.content;
};
EDITORS.hostinger = {
  find: async (ctx, acc, zone, q) => (await LISTERS.hostinger!(ctx, acc, zone)).filter((r) => r.name === fq(q.name, zone) && r.type === q.type),
  async del(ctx, acc, zone, q) {
    const all = await EDITORS.hostinger!.find(ctx, acc, zone, q);
    const gone = all.filter((r) => matches(r, q.value)), rest = all.filter((r) => !gone.includes(r));
    if (!gone.length) return [];
    if (rest.length) await hx(ctx, acc, 'dns_records_update', { domain: zone, overwrite: true, zone: [{ name: relName(q.name, zone), type: q.type, ttl: rest[0]!.ttl ?? 300, records: rest.map((r) => ({ content: hContent(r) })) }] });
    else await hx(ctx, acc, 'dns_records_delete', { domain: zone, filters: [{ name: relName(q.name, zone), type: q.type }] });
    return gone;
  },
  // overwrite false adds next to what's there
  async add(ctx, acc, zone, r) { await hx(ctx, acc, 'dns_records_update', { domain: zone, overwrite: false, zone: [{ name: relName(r.name, zone), type: r.type, ttl: r.ttl ?? 300, records: [{ content: hContent(r) }] }] }); },
};

// GoDaddy: one name + type is read, replaced or deleted on its own path (never PUT /records: that's the whole zone);
// PATCH /records adds without replacing. https://developer.godaddy.com/doc/endpoint/domains
// An SRV sits at its host part (@ or a prefix) with its service and protocol as fields, so one path can hold several.
const gdSrv = (name: string, zone: string) => { const m = /^(_[^.]+)\.(_[^.]+)(?:\.(.+))?$/.exec(sub(fq(name, zone), zone)); return m ? { service: m[1]!, protocol: m[2]!, host: m[3] ?? '@' } : undefined; };
async function gdRows(ctx: Ctx, acc: string, zone: string, q: RecQuery) {
  const srv = q.type === 'SRV' ? gdSrv(q.name, zone) : undefined;
  const path = `${GODADDY()}/v1/domains/${seg(zone)}/records/${q.type}/${seg(srv?.host ?? relName(q.name, zone))}`, headers = await gd(ctx, acc);
  const rows = await rest<GdRow[]>('GoDaddy', path, { headers });
  const mine = (r: GdRow) => !srv || (r.service === srv.service && r.protocol === srv.protocol);
  const rec = (r: GdRow) => gdRec({ ...r, service: r.service ?? srv?.service, protocol: r.protocol ?? srv?.protocol }, zone, q.type, srv ? srv.host : q.name);
  return { path, headers, rows, mine, rec };
}
const gdBody = (r: GdRow) => ({ data: r.data, ttl: Math.max(600, r.ttl ?? 600), ...(r.priority !== undefined && { priority: r.priority }), ...(r.service && { service: r.service, protocol: r.protocol, port: r.port, weight: r.weight }) });
EDITORS.godaddy = {
  async find(ctx, acc, zone, q) { const { rows, mine, rec } = await gdRows(ctx, acc, zone, q); return rows.filter(mine).map(rec); },
  async del(ctx, acc, zone, q) {
    const { path, headers, rows, mine, rec } = await gdRows(ctx, acc, zone, q);
    const gone = rows.filter((r) => mine(r) && matches(rec(r), q.value)), keep = rows.filter((r) => !gone.includes(r));
    if (!gone.length) return [];
    if (keep.length) await rest('GoDaddy', path, { method: 'PUT', headers, body: keep.map(gdBody) });
    else await rest('GoDaddy', path, { method: 'DELETE', headers });
    return gone.map(rec);
  },
  async add(ctx, acc, zone, r) {
    const srv = r.type === 'SRV' ? gdSrv(r.name, zone) : undefined, s = srv && srvOf(r.content);
    const row = s ? { data: s.target, ttl: r.ttl ?? 600, priority: s.priority, service: srv!.service, protocol: srv!.protocol, port: s.port, weight: s.weight } : { data: r.content, ttl: r.ttl ?? 600, priority: r.priority };
    await rest('GoDaddy', `${GODADDY()}/v1/domains/${seg(zone)}/records`, { method: 'PATCH', headers: await gd(ctx, acc), body: [{ type: r.type, name: srv?.host ?? relName(r.name, zone), ...gdBody(row) }] });
  },
};

// Vercel DNS: records by id (DELETE /v2/domains/{domain}/records/{recordId}, POST /v2/domains/{domain}/records)
// https://vercel.com/docs/rest-api/reference/endpoints/dns/delete-a-dns-record
const VC = () => process.env.UNIT7_VERCEL_API ?? 'https://api.vercel.com';
async function vcDns<T = any>(ctx: Ctx, acc: string, zone: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  seg(zone); // vercel.dnsTeam puts it in a path
  const team = (await vercel.dnsTeam(ctx, acc, zone))?.team;
  return rest<T>('Vercel', `${VC()}${path}${team ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(team)}` : ''}`, { ...init, headers: { authorization: `Bearer ${await bearerFor(ctx, 'vercel', acc)}` } });
}
async function vcHits(ctx: Ctx, acc: string, zone: string, q: RecQuery): Promise<Hit[]> {
  const { records = [] } = await vcDns<{ records?: VcRow[] }>(ctx, acc, zone, `/v5/domains/${seg(zone)}/records?limit=100`);
  return records.map((r) => vcRec(r, zone)).filter((r) => r.name === fq(q.name, zone) && r.type === q.type);
}
EDITORS.vercel = {
  find: async (ctx, acc, zone, q) => (await vcHits(ctx, acc, zone, q)).map(({ id: _id, ...r }) => r),
  del: async (ctx, acc, zone, q) => delHits(await vcHits(ctx, acc, zone, q), q, (h) => vcDns(ctx, acc, zone, `/v2/domains/${seg(zone)}/records/${seg(h.id)}`, { method: 'DELETE' })),
  async add(ctx, acc, zone, r) {
    const value = r.type === 'SRV' ? { srv: srvOf(r.content) } : { value: r.content, ...(r.type === 'MX' && { mxPriority: r.priority ?? 10 }) };
    await vcDns(ctx, acc, zone, `/v2/domains/${seg(zone)}/records`, { method: 'POST', body: { name: subName(r.name, zone), type: r.type, ttl: Math.max(60, r.ttl ?? 60), ...value } });
  },
};

// DigitalOcean: GET …/records?type=&name= (the full name), DELETE …/records/{id}, POST …/records
// https://docs.digitalocean.com/reference/api/digitalocean/#tag/Domain-Records
const doData = (r: FullRec) => (r.type === 'CNAME' || r.type === 'MX' ? `${r.content.replace(/\.$/, '')}.` : r.content);
const doFields = (r: FullRec) => {
  const s = r.type === 'SRV' ? srvOf(r.content) : undefined, c = r.type === 'CAA' ? caaOf(r.content) : undefined;
  if (s) return { data: `${s.target}.`, priority: s.priority, port: s.port, weight: s.weight };
  if (c) return { data: c.tag === 'iodef' ? c.value : `${c.value.replace(/\.$/, '')}.`, flags: c.flags, tag: c.tag };
  return { data: doData(r), ...(r.type === 'MX' && { priority: r.priority ?? 10 }) };
};
async function doHits(ctx: Ctx, acc: string, zone: string, q: RecQuery): Promise<Hit[]> {
  const { domain_records = [] } = await rest<{ domain_records?: DoRow[] }>('DigitalOcean', `${DO()}/domains/${seg(zone)}/records?type=${q.type}&name=${encodeURIComponent(fq(q.name, zone))}`, { headers: await doAuth(ctx, acc) });
  return domain_records.map((r) => doRec(r, zone)).filter((r) => r.type === q.type && r.name === fq(q.name, zone));
}
EDITORS.digitalocean = {
  find: async (ctx, acc, zone, q) => (await doHits(ctx, acc, zone, q)).map(({ id: _id, ...r }) => r),
  del: async (ctx, acc, zone, q) => { const headers = await doAuth(ctx, acc); return delHits(await doHits(ctx, acc, zone, q), q, (h) => rest('DigitalOcean', `${DO()}/domains/${seg(zone)}/records/${seg(h.id)}`, { method: 'DELETE', headers })); },
  async add(ctx, acc, zone, r) { await rest('DigitalOcean', `${DO()}/domains/${seg(zone)}/records`, { headers: await doAuth(ctx, acc), body: { type: r.type, name: relName(r.name, zone), ttl: Math.max(30, r.ttl ?? 300), ...doFields(r) } }); },
};

// Porkbun: POST /dns/delete/{domain}/{id}, POST /dns/create/{domain} (keys in the body). https://porkbun.com/api/json/v3/documentation
async function pbHits(ctx: Ctx, acc: string, zone: string, q: RecQuery): Promise<Hit[]> {
  const { records = [] } = await rest<{ records?: PbRow[] }>('Porkbun', `${PORKBUN()}/dns/retrieve/${seg(zone)}`, { body: pb(ctx, acc) });
  return records.map((r) => pbRec(r, zone)).filter((r) => r.name === fq(q.name, zone) && r.type === q.type);
}
EDITORS.porkbun = {
  find: async (ctx, acc, zone, q) => (await pbHits(ctx, acc, zone, q)).map(({ id: _id, ...r }) => r),
  del: async (ctx, acc, zone, q) => delHits(await pbHits(ctx, acc, zone, q), q, (h) => rest('Porkbun', `${PORKBUN()}/dns/delete/${seg(zone)}/${seg(h.id)}`, { body: pb(ctx, acc) })),
  async add(ctx, acc, zone, r) {
    const s = r.type === 'SRV' ? srvOf(r.content) : undefined; // its answer is "weight port target", the priority on its own
    await rest('Porkbun', `${PORKBUN()}/dns/create/${seg(zone)}`, { body: { ...pb(ctx, acc), name: subName(r.name, zone), type: r.type, content: s ? `${s.weight} ${s.port} ${s.target}` : r.content, ttl: String(Math.max(600, r.ttl ?? 600)), ...(s ? { prio: String(s.priority) } : r.priority !== undefined ? { prio: String(r.priority) } : {}) } });
  },
};

// Name.com: DELETE /core/v1/domains/{domain}/records/{id}, POST …/records. https://docs.name.com/docs/api-reference/dns
async function ncHits(ctx: Ctx, acc: string, zone: string, q: RecQuery): Promise<Hit[]> {
  const { records = [] } = await rest<{ records?: NcRow[] }>('Name.com', `${NAMECOM()}/domains/${seg(zone)}/records`, { headers: nc(ctx, acc) });
  const type = q.type === 'ALIAS' ? 'ANAME' : q.type;
  return records.map((r) => ncRec(r, zone)).filter((r) => r.name === fq(q.name, zone) && r.type === type);
}
EDITORS.namecom = {
  find: async (ctx, acc, zone, q) => (await ncHits(ctx, acc, zone, q)).map(({ id: _id, ...r }) => r),
  del: async (ctx, acc, zone, q) => delHits(await ncHits(ctx, acc, zone, q), q, (h) => rest('Name.com', `${NAMECOM()}/domains/${seg(zone)}/records/${seg(h.id)}`, { method: 'DELETE', headers: nc(ctx, acc) })),
  async add(ctx, acc, zone, r) {
    // its record types are A, AAAA, ANAME, CNAME, MX, NS, SRV and TXT
    if (r.type === 'CAA') throw new Unit7Error('unsupported', 'Name.com’s API doesn’t take CAA records. Add it in Name.com’s dashboard, or move this domain’s DNS to Cloudflare (free; Unit7 can do it).', 400);
    const s = r.type === 'SRV' ? srvOf(r.content) : undefined; // its answer is "weight port target", the priority on its own
    await rest('Name.com', `${NAMECOM()}/domains/${seg(zone)}/records`, { headers: nc(ctx, acc), body: { host: subName(r.name, zone), type: r.type, answer: s ? `${s.weight} ${s.port} ${s.target}` : r.content, ttl: Math.max(300, r.ttl ?? 300), ...(s ? { priority: s.priority } : r.priority !== undefined ? { priority: r.priority } : {}) } });
  },
};

// --- the big clouds' DNS: Google Cloud DNS, Route 53, Azure DNS, Hetzner (Cloud API) --------------------------------
// All four keep records as sets (one name + one type, several values) and replace a set as a whole. So a write here
// always reads the set first and writes it back with only that one change: an A/AAAA/CNAME gets its single new value,
// a TXT is added next to the ones already there (verifications and SPF share a name), and a delete writes back what's
// left (or removes the set when nothing is). Each set's write is checked against what was read (Google's exact
// deletions, Azure's If-Match, Route 53's exact DELETE), so a zone or set changed meanwhile is never overwritten blind.
export interface RRSet { ttl: number; values: string[]; raw?: unknown }
interface RRHost<H> {
  who: string; alias?: 'apex';
  locate(ctx: Ctx, acc: string, zone: string): Promise<H | undefined>;
  get(ctx: Ctx, acc: string, h: H, fqdn: string, type: string): Promise<RRSet | undefined>;
  put(ctx: Ctx, acc: string, h: H, fqdn: string, type: string, set: RRSet, prev?: RRSet): Promise<unknown>;
  drop(ctx: Ctx, acc: string, h: H, fqdn: string, type: string, prev: RRSet): Promise<unknown>;
  list(ctx: Ctx, acc: string, h: H, zone: string): Promise<{ name: string; type: string; ttl?: number; values: string[] }[]>;
}
// a record as a zone-file value (what Google, Route 53 and Hetzner take): hostnames end in a dot, TXT is quoted in
// pieces of at most 255 characters, MX is "priority host."
export function toValue(r: Pick<FullRec, 'type' | 'content' | 'priority'>) {
  const dot = (h: string) => `${h.replace(/\.$/, '')}.`;
  if (['CNAME', 'ALIAS', 'NS', 'PTR'].includes(r.type)) return dot(r.content);
  if (r.type === 'MX') { const m = /^(\d+)\s+(.+)$/.exec(r.content); return m ? `${m[1]} ${dot(m[2]!)}` : `${r.priority ?? 10} ${dot(r.content)}`; }
  if (r.type === 'SRV') return dot(r.content);
  if (r.type === 'TXT') { const t = /^".*"$/s.test(r.content) ? unquoted(r.content) : r.content; return (t.match(/[\s\S]{1,255}/g) ?? ['']).map(quoted).join(' '); }
  return r.content;
}
export function fromValue(type: string, name: string, v: string, ttl?: number): FullRec {
  if (type === 'TXT') return { type, name, content: unquoted(v), ttl };
  if (type === 'MX') { const m = /^(\d+)\s+(.+?)\.?$/.exec(v); return { type, name, content: m ? m[2]! : v.replace(/\.$/, ''), priority: m ? Number(m[1]) : undefined, ttl }; }
  return { type, name, content: v.replace(/\.$/, ''), ttl };
}
const caches = new Map<string, { at: number; v: unknown }>();
async function remembered<T>(key: string, f: () => Promise<T>): Promise<T> {
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v as T;
  const v = await f();
  caches.set(key, { at: Date.now(), v });
  return v;
}
function rrWriter<H>(host: RRHost<H>): { writer: Writer; editor: Editor; lister: (typeof LISTERS)[string] } {
  const where = async (ctx: Ctx, acc: string, zone: string) => {
    const h = await remembered(`${host.who}:${acc}:${zone}`, () => host.locate(ctx, acc, zone));
    if (!h) throw new Unit7Error('not_found', `${zone} isn’t in this ${host.who} account.`, 404);
    return h;
  };
  const read = async (ctx: Ctx, acc: string, zone: string, q: { name: string; type: string }) => {
    const h = await where(ctx, acc, zone), name = fq(q.name, zone);
    return { h, name, cur: await host.get(ctx, acc, h, name, q.type) };
  };
  const recs = (type: string, name: string, s?: RRSet) => (s?.values ?? []).map((v) => fromValue(type, name, v, s!.ttl));
  const editor: Editor = {
    find: async (ctx, acc, zone, q) => { const { name, cur } = await read(ctx, acc, zone, q); return recs(q.type, name, cur); },
    async del(ctx, acc, zone, q) {
      const { h, name, cur } = await read(ctx, acc, zone, q);
      const all = recs(q.type, name, cur), gone = all.filter((r) => matches(r, q.value));
      if (!cur || !gone.length) return [];
      const keep = cur.values.filter((_v, i) => !gone.includes(all[i]!));
      if (keep.length) await host.put(ctx, acc, h, name, q.type, { ttl: cur.ttl, values: keep }, cur);
      else await host.drop(ctx, acc, h, name, q.type, cur);
      return gone;
    },
    async add(ctx, acc, zone, r) {
      const { h, name, cur } = await read(ctx, acc, zone, r);
      const v = toValue(r);
      if (cur?.values.some((x) => normValue(x) === normValue(v))) return;
      await host.put(ctx, acc, h, name, r.type, { ttl: cur?.ttl ?? r.ttl ?? 300, values: [...(cur?.values ?? []), v] }, cur);
    },
  };
  const writer: Writer = {
    owns: async (ctx, acc, zone) => !!(await remembered(`${host.who}:${acc}:${zone}`, () => host.locate(ctx, acc, zone))),
    async upsert(ctx, acc, zone, rec) {
      if (rec.type === 'ALIAS' && (host.alias !== 'apex' || fq(rec.name, zone) !== zone)) noAlias(host.who, rec);
      const { h, name, cur } = await read(ctx, acc, zone, rec);
      const v = toValue(rec);
      // TXT: added next to what's there (verifications and SPF share a name); anything else: this one value
      const values = rec.type === 'TXT' ? [...(cur?.values.filter((x) => normValue(x) !== normValue(v)) ?? []), v] : [v];
      if (cur && cur.values.length === values.length && cur.values.every((x, i) => normValue(x) === normValue(values[i]!))) return;
      await host.put(ctx, acc, h, name, rec.type, { ttl: rec.ttl ?? cur?.ttl ?? 300, values }, cur);
    },
  };
  const lister: (typeof LISTERS)[string] = async (ctx, acc, zone) => (await host.list(ctx, acc, await where(ctx, acc, zone), zone))
    .flatMap((s) => s.values.map((v) => fromValue(s.type, fq(s.name, zone), v, s.ttl)));
  return { writer, editor, lister };
}

// Google Cloud DNS (public zones in any project the sign-in sees). ALIAS works at the apex only.
// https://docs.cloud.google.com/dns/docs/records-overview
const gcpDns = rrWriter<{ p: string; mz: string }>({
  who: 'Google Cloud', alias: 'apex',
  async locate(ctx, acc, zone) {
    if (viaFirebaseCli(ctx, acc)) return undefined; // the Firebase CLI can't edit DNS
    for (const { projectId: p } of await google.projects(ctx, acc)) {
      const z = (await google.dnsZones(ctx, acc, p).catch(() => [])).find((x) => x.dnsName.toLowerCase() === `${zone}.` && x.visibility !== 'private');
      if (z) return { p, mz: z.name };
    }
    return undefined;
  },
  get: async (ctx, acc, h, fqdn, type) => { const s = await googleDns.rrset(ctx, acc, h.p, h.mz, fqdn, type); return s && { ttl: s.ttl ?? 300, values: s.rrdatas ?? [], raw: s }; },
  // the old set must match exactly, or Google refuses the whole change
  put: (ctx, acc, h, fqdn, type, s, prev) => googleDns.change(ctx, acc, h.p, h.mz, { ...(prev && { deletions: [prev.raw as GRRSet] }), additions: [{ name: `${fqdn}.`, type, ttl: s.ttl, rrdatas: s.values }] }),
  drop: (ctx, acc, h, _fqdn, _type, prev) => googleDns.change(ctx, acc, h.p, h.mz, { deletions: [prev.raw as GRRSet] }),
  list: async (ctx, acc, h) => (await google.dnsRecords(ctx, acc, h.p, h.mz)).map((s) => ({ name: s.name, type: s.type, ttl: s.ttl, values: s.rrdatas ?? [] })),
});
WRITERS.gcp = WRITERS.firebase = gcpDns.writer;
EDITORS.gcp = EDITORS.firebase = gcpDns.editor;
LISTERS.gcp = LISTERS.firebase = gcpDns.lister;

// AWS Route 53 (public hosted zones). An alias (to CloudFront, a load balancer…) isn't a plain value: left to AWS.
const r53 = rrWriter<string>({
  who: 'AWS',
  locate: async (ctx, acc, zone) => (await aws.zones(ctx, acc)).find((z) => z.name === zone && !z.private)?.id,
  async get(ctx, acc, id, fqdn, type) {
    const s = await route53.get(ctx, acc, id, fqdn, type);
    if (s?.alias) throw new Unit7Error('unsupported', `${fqdn} is an AWS alias (to ${s.alias.replace(/\.$/, '')}). Change it in the AWS console; Unit7 only edits plain records there.`, 409);
    return s && { ttl: s.ttl, values: s.values, raw: s };
  },
  put: (ctx, acc, id, fqdn, type, s) => route53.change(ctx, acc, id, 'UPSERT', { name: fqdn, type, ttl: s.ttl, values: s.values }),
  drop: (ctx, acc, id, _fqdn, _type, prev) => route53.change(ctx, acc, id, 'DELETE', prev.raw as R53Set),
  list: (ctx, acc, id) => route53.list(ctx, acc, id),
});
WRITERS.aws = r53.writer;
EDITORS.aws = r53.editor;
LISTERS.aws = r53.lister;

// Azure DNS: typed records (no zone-file text), so values are turned into its shapes and back
const azValues = (type: string, p: NonNullable<AzRecordSet['properties']>): string[] =>
  type === 'A' ? (p.ARecords ?? []).map((r) => r.ipv4Address) : type === 'AAAA' ? (p.AAAARecords ?? []).map((r) => r.ipv6Address)
  : type === 'CNAME' ? (p.CNAMERecord ? [`${p.CNAMERecord.cname.replace(/\.$/, '')}.`] : []) : type === 'TXT' ? (p.TXTRecords ?? []).map((r) => r.value.map(quoted).join(' '))
  : type === 'MX' ? (p.MXRecords ?? []).map((r) => `${r.preference} ${r.exchange.replace(/\.$/, '')}.`)
  : type === 'SRV' ? (p.SRVRecords ?? []).map((r) => `${srvLine(r)}.`) : type === 'CAA' ? (p.caaRecords ?? []).map(caaLine) : type === 'NS' ? (p.NSRecords ?? []).map((r) => r.nsdname) : [];
function azProps(type: string, s: RRSet): NonNullable<AzRecordSet['properties']> {
  const base = { TTL: s.ttl };
  if (type === 'A') return { ...base, ARecords: s.values.map((v) => ({ ipv4Address: v })) };
  if (type === 'AAAA') return { ...base, AAAARecords: s.values.map((v) => ({ ipv6Address: v })) };
  if (type === 'CNAME') return { ...base, CNAMERecord: { cname: s.values[0]!.replace(/\.$/, '') } };
  if (type === 'TXT') return { ...base, TXTRecords: s.values.map((v) => ({ value: unquoted(v).match(/[\s\S]{1,255}/g) ?? [''] })) };
  if (type === 'MX') return { ...base, MXRecords: s.values.map((v) => { const r = fromValue('MX', '', v); return { preference: r.priority ?? 10, exchange: r.content }; }) };
  if (type === 'SRV') return { ...base, SRVRecords: s.values.map((v) => srvOf(v)!) };
  if (type === 'CAA') return { ...base, caaRecords: s.values.map((v) => caaOf(v)!) };
  throw new Unit7Error('unsupported', `Unit7 doesn’t edit ${type} records on Azure DNS.`, 400);
}
const azDns = rrWriter<string>({
  who: 'Azure',
  async locate(ctx, acc, zone) {
    for (const { subscriptionId: s } of await azure.subscriptions(ctx, acc)) {
      const z = (await azure.dnsZones(ctx, acc, s).catch(() => [])).find((x) => x.name.toLowerCase() === zone);
      if (z) return z.id;
    }
    return undefined;
  },
  async get(ctx, acc, zoneId, fqdn, type) {
    const s = await azureDns.get(ctx, acc, zoneId, type, relative(fqdn, zoneId.split('/').pop()!.toLowerCase()));
    if (s?.properties?.targetResource?.id) throw new Unit7Error('unsupported', `${fqdn} is an Azure alias to one of your Azure resources. Change it in the Azure portal.`, 409);
    return s?.properties && { ttl: s.properties.TTL ?? 3600, values: azValues(type, s.properties), raw: s };
  },
  put: (ctx, acc, zoneId, fqdn, type, s, prev) => azureDns.put(ctx, acc, zoneId, type, relative(fqdn, zoneId.split('/').pop()!.toLowerCase()), azProps(type, s), (prev?.raw as AzRecordSet | undefined)?.etag),
  drop: (ctx, acc, zoneId, fqdn, type, prev) => azureDns.del(ctx, acc, zoneId, type, relative(fqdn, zoneId.split('/').pop()!.toLowerCase()), (prev.raw as AzRecordSet).etag),
  list: async (ctx, acc, zoneId) => (await azure.records(ctx, acc, zoneId)).map((s) => { const type = s.type.split('/').pop()!; return { name: s.name, type, ttl: s.properties?.TTL, values: s.properties ? azValues(type, s.properties) : [] }; }).filter((s) => s.values.length),
});
WRITERS.azure = azDns.writer;
EDITORS.azure = azDns.editor;
LISTERS.azure = azDns.lister;

// Hetzner DNS (Cloud API): set_records replaces one set's records; a new set is created with its records
const hzDns = rrWriter<string>({
  who: 'Hetzner',
  locate: async (ctx, acc, zone) => (await hetznerDns.zone(ctx, acc, zone))?.name,
  get: async (ctx, acc, zone, fqdn, type) => { const s = await hetznerDns.get(ctx, acc, zone, relative(fqdn, zone), type); return s && { ttl: s.ttl ?? 3600, values: s.records.map((r) => r.value), raw: s }; },
  put: (ctx, acc, zone, fqdn, type, s, prev) => prev
    ? hetznerDns.setRecords(ctx, acc, zone, relative(fqdn, zone), type, s.values.map((value) => ({ value })))
    : hetznerDns.create(ctx, acc, zone, { name: relative(fqdn, zone), type, ttl: s.ttl, records: s.values.map((value) => ({ value })) }),
  drop: (ctx, acc, zone, fqdn, type) => hetznerDns.remove(ctx, acc, zone, relative(fqdn, zone), type),
  list: async (ctx, acc, zone) => (await hetzner.records(ctx, acc, zone)).map((s) => ({ name: s.name, type: s.type, ttl: s.ttl ?? undefined, values: s.records.map((r) => r.value) })),
});
WRITERS.hetzner = hzDns.writer;
EDITORS.hetzner = hzDns.editor;
LISTERS.hetzner = hzDns.lister;
