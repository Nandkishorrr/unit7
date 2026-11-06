// Domains, end to end. "Point app.example.com at production" works as one step: find the DNS
// account, add the A record, point Caddy at the service's container, and let Caddy issue the
// certificate. Provider adapters (Cloudflare now, Hostinger DNS via its MCP) sit behind one tool.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { serverRow } from './servers.ts';
import { removeSite, assertHostname, pointsHere } from '../deploy/caddy.ts';
import { cloudflare } from '../connectors/cloudflare.ts';
import { writeRecords, LISTERS, NAMESERVERS, rest, NAMECOM, nc, type Rec, type WriteResult, type FullRec } from '../connectors/dnswrite.ts';
import { hostinger } from '../connectors/hostinger.ts';
import { vercel, supabase } from '../connectors/clouds.ts';
import { netlify, render, railway, heroku, fly } from '../connectors/hosts.ts';
import { resolvesTo, dnsHost } from '../connectors/dnsinfo.ts';
import { verifiers } from './core.ts';
import { fid, isAgent } from './helpers.ts';
import { routeService, replicaNames, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';

verifiers.cloudflare = (ctx, account) => cloudflare.verify(ctx, account.id);

async function serverPublicIp(ctx: Ctx, serverId: string): Promise<string> {
  const s = serverRow(ctx, serverId);
  const facts = json<{ publicIp?: string }>(s.facts, {});
  return facts.publicIp ?? s.host;
}

defineTool({
  name: 'domain.list', title: 'List domains', risk: 'read', action: 'read',
  description: 'Domains Unit7 manages, their service, TLS status and whether DNS currently points at the right server.',
  input: z.object({ serviceId: fid('svc').optional() }),
  run: (ctx, i) => all(ctx.db, `SELECT d.id, d.hostname, d.status, d.tls, d.tls_mode, d.auto, s.name service FROM domains d LEFT JOIN services s ON s.id = d.service_id
    WHERE d.org_id = ? AND (? IS NULL OR d.service_id = ?) ORDER BY d.created_at DESC`, ctx.orgId, i.serviceId ?? null, i.serviceId ?? null),
});

const vercelTarget = z.object({ accountId: fid('acc'), project: z.string().min(1).max(100), team: z.string().max(100).optional() });
const netlifyTarget = z.object({ accountId: fid('acc'), site: z.string().min(1).max(100) });
const renderTarget = z.object({ accountId: fid('acc'), service: z.string().min(1).max(100) });
const flyTarget = z.object({ accountId: fid('acc'), app: z.string().min(1).max(100) });
const herokuTarget = z.object({ accountId: fid('acc'), app: z.string().min(1).max(100) });
const supabaseTarget = z.object({ accountId: fid('acc'), ref: z.string().regex(/^[a-z]{20}$/) });
const railwayTarget = z.object({ accountId: fid('acc'), project: z.string().min(1).max(100), environment: z.string().min(1).max(100), service: z.string().min(1).max(100) });
// adding a domain on a host: it says what DNS should be; Unit7 writes it wherever the domain's DNS lives
const HOSTS = {
  netlify: { name: 'Netlify', attach: (ctx: Ctx, t: z.infer<typeof netlifyTarget>, d: string) => netlify.addDomain(ctx, t.accountId, t.site, d), confirm: (ctx: Ctx, t: z.infer<typeof netlifyTarget>) => netlify.ssl(ctx, t.accountId, t.site) },
  render: { name: 'Render', attach: (ctx: Ctx, t: z.infer<typeof renderTarget>, d: string) => render.addDomain(ctx, t.accountId, t.service, d), confirm: (ctx: Ctx, t: z.infer<typeof renderTarget>, d: string) => render.verify(ctx, t.accountId, t.service, d) },
  railway: { name: 'Railway', attach: (ctx: Ctx, t: z.infer<typeof railwayTarget>, d: string) => railway.addDomain(ctx, t.accountId, t, d), confirm: async () => undefined },
  fly: { name: 'Fly.io', attach: (ctx: Ctx, t: z.infer<typeof flyTarget>, d: string) => fly.addDomain(ctx, t.accountId, t.app, d), confirm: (ctx: Ctx, t: z.infer<typeof flyTarget>, d: string) => fly.check(ctx, t.accountId, t.app, d) },
  heroku: { name: 'Heroku', attach: (ctx: Ctx, t: z.infer<typeof herokuTarget>, d: string) => heroku.addDomain(ctx, t.accountId, t.app, d), confirm: async () => undefined }, // Heroku issues HTTPS by itself (ACM)
  // Supabase: a custom domain for the project's API and auth (paid add-on, subdomains only)
  supabase: { name: 'Supabase', attach: async (ctx: Ctx, t: z.infer<typeof supabaseTarget>, d: string) => {
    if ((await dnsHost(d)).zone === d) throw new Unit7Error('unsupported', 'Supabase custom domains must be a subdomain (like api.example.com), not the bare domain.', 400);
    return supabase.addDomain(ctx, t.accountId, t.ref, d);
  }, confirm: (ctx: Ctx, t: z.infer<typeof supabaseTarget>) => supabase.confirmDomain(ctx, t.accountId, t.ref) },
} as const;

// Record a domain and what its DNS should say; Warden takes it from there (domain.check).
function saveDomain(ctx: Ctx, hostname: string, w: WriteResult, target: object, records: Rec[], serviceId: string | null) {
  // hostnames are unique across organisations: never take over another one's record
  if (get(ctx.db, 'SELECT 1 FROM domains WHERE hostname = ? AND org_id <> ?', hostname, ctx.orgId)) throw new Unit7Error('domain_taken', `${hostname} belongs to another organisation in this Unit7.`, 409);
  run(ctx.db, `INSERT INTO domains (id, org_id, hostname, service_id, account_id, zone, status, tls, tls_mode, auto, target, records) VALUES (?, ?, ?, ?, ?, ?, ?, 'issuing', 'auto', 0, ?, ?)
    ON CONFLICT(hostname) DO UPDATE SET service_id = excluded.service_id, account_id = excluded.account_id, zone = excluded.zone, status = excluded.status, tls_mode = 'auto', auto = 0, target = excluded.target, records = excluded.records`,
    id('dom'), ctx.orgId, hostname, serviceId, w.accountId ?? null, w.zone ?? null, w.written ? 'pending' : 'waiting_dns', JSON.stringify(target), JSON.stringify(records));
}
const needsYou = (w: WriteResult, records: Rec[]) => ({
  dns: 'needs you', addThese: records.map((r) => ({ type: r.type === 'ALIAS' ? 'ALIAS (or CNAME flattening)' : r.type, name: w.zone && r.name === w.zone ? '@' : w.zone ? r.name.replace(`.${w.zone}`, '') : r.name, value: r.content })),
  at: w.host ?? 'your DNS provider', why: w.why, note: 'Add the records above where your domain\u2019s DNS is managed. Unit7 keeps checking and finishes by itself when they\u2019re live.',
});

defineTool({
  // pointing at an app here is routine; at an outside host the name leaves Unit7's hands
  name: 'domain.point', title: 'Point a domain at an app', risk: (i) => (i.serviceId || i.server ? 'write' : 'destructive'), action: 'dns_write', timeoutMs: 5 * 60_000,
  description: 'Point a hostname (e.g. app.example.com) at an app: one deployed here (serviceId), or on Vercel, Netlify, Render, Railway, Heroku or Fly.io; or at a Supabase project\u2019s API (supabase, a paid add-on there); or at one of your servers itself (server: an A record to its address, for something that answers behind its own proxy there, like Coolify\u2019s dashboard). Unit7 finds where the domain\u2019s DNS lives (Hostinger, Cloudflare…), writes the records with your connected account there (or tells you exactly what to add, and finishes by itself once it\u2019s live), and gets HTTPS working.',
  input: z.object({ hostname: z.string().min(3).max(253), serviceId: fid('svc').optional(), vercel: vercelTarget.optional(), netlify: netlifyTarget.optional(), render: renderTarget.optional(), railway: railwayTarget.optional(), supabase: supabaseTarget.optional(), heroku: herokuTarget.optional(), fly: flyTarget.optional(),
    server: z.object({ serverId: fid('srv') }).optional(),
    provider: z.string().max(40).optional(), accountId: fid('acc').optional() })
    .refine((i) => [i.serviceId, i.vercel, i.netlify, i.render, i.railway, i.supabase, i.heroku, i.fly, i.server].filter(Boolean).length === 1, 'Give exactly one target: serviceId (an app here), vercel, netlify, render, railway, heroku, fly, supabase or server.'),
  async run(ctx, i) {
    const hostname = i.hostname.toLowerCase();
    // a name already serving one app is moved to another only by a person (it may be production's address)
    const serving = get<{ service_id: string | null; target: string | null }>(ctx.db, 'SELECT service_id, target FROM domains WHERE hostname = ? AND org_id = ?', hostname, ctx.orgId);
    if (isAgent(ctx) && serving && (serving.service_id ?? null) !== (i.serviceId ?? null)) {
      throw new Unit7Error('forbidden', `${hostname} already points somewhere else. A person can move it.`, 403);
    }
    assertHostname(hostname);
    const prefer = { provider: i.provider, accountId: i.accountId };

    for (const kind of ['netlify', 'render', 'railway', 'supabase', 'heroku', 'fly'] as const) {
      const t = i[kind];
      if (!t) continue;
      const host = HOSTS[kind];
      ctx.progress(`Adding ${hostname} on ${host.name}…`);
      const records = await (host.attach as (c: Ctx, t: unknown, d: string) => Promise<Rec[]>)(ctx, t, hostname);
      const w = await writeRecords(ctx, hostname, records, prefer);
      saveDomain(ctx, hostname, w, { kind, ...t }, records, null);
      ctx.emit('domain.pointed', w.written ? `${hostname} → ${host.name}: DNS set at ${w.provider}` : `${hostname} → ${host.name}: waiting for DNS records at ${w.host ?? 'your DNS provider'}`, { severity: w.written ? 'success' : 'info' });
      return w.written
        ? { hostname, dns: records.map((r) => `${w.provider}: ${r.type} ${r.name} → ${r.content}`), url: `https://${hostname}`, note: `${host.name} issues HTTPS once DNS points there; Unit7 checks and confirms it.` }
        : { hostname, ...needsYou(w, records) };
    }

    if (i.vercel) {
      const v = i.vercel;
      ctx.progress(`Adding ${hostname} to the Vercel project…`);
      const st = await vercel.addDomain(ctx, v.accountId, v.project, v.team, hostname);
      const records = [...st.records, ...st.proof];
      ctx.progress(`Finding where ${hostname}'s DNS lives…`);
      const w = await writeRecords(ctx, hostname, records, prefer);
      if (w.written && st.proof.length) await vercel.verify(ctx, v.accountId, v.project, v.team, hostname);
      saveDomain(ctx, hostname, w, { kind: 'vercel', ...v }, records, null);
      ctx.emit('domain.pointed', w.written ? `${hostname} → Vercel: DNS set at ${w.provider}` : `${hostname} → Vercel: waiting for DNS records at ${w.host ?? 'your DNS provider'}`, { severity: w.written ? 'success' : 'info' });
      return w.written
        ? { hostname, dns: records.map((r) => `${w.provider}: ${r.type} ${r.name} → ${r.content}`), url: `https://${hostname}`, note: 'Vercel issues HTTPS once DNS points there; Unit7 checks and confirms it.' }
        : { hostname, ...needsYou(w, records) };
    }

    // at a server itself: one A record to its address; whatever answers its web ports there (Coolify's proxy) serves it
    if (i.server) {
      const s = serverRow(ctx, i.server.serverId);
      const ip = await serverPublicIp(ctx, s.id);
      const records: Rec[] = [{ type: 'A', name: hostname, content: ip }];
      ctx.progress(`Finding where ${hostname}'s DNS lives…`);
      const w = await writeRecords(ctx, hostname, records, prefer);
      saveDomain(ctx, hostname, w, { kind: 'server', serverId: s.id }, records, null);
      ctx.emit('domain.pointed', w.written ? `${hostname} → ${s.name}: DNS set at ${w.provider}` : `${hostname} → ${s.name}: waiting for a DNS record at ${w.host ?? 'your DNS provider'}`, { severity: w.written ? 'success' : 'info', resource: s.id });
      return w.written ? { hostname, dns: `${w.provider}: A ${hostname} → ${ip}`, note: 'DNS usually updates within minutes.' } : { hostname, ...needsYou(w, records) };
    }
    const svc = get<{ id: string; name: string; server_id: string | null; config: string; current_deployment_id: string | null }>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', i.serviceId!, ctx.orgId);
    if (!svc) throw new Unit7Error('not_found', 'That service was not found.', 404);
    if (!svc.server_id || !svc.current_deployment_id) throw new Unit7Error('not_deployed', `${svc.name} isn't deployed yet. Deploy it first, then point a domain at it.`);
    const cfg = json<ServiceConfig>(svc.config, {});
    const container = get<{ container: string }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id)?.container;
    if (!container) throw new Unit7Error('not_running', `${svc.name} has no running container.`);
    const ip = await serverPublicIp(ctx, svc.server_id);
    const records: Rec[] = [{ type: 'A', name: hostname, content: ip }];

    ctx.progress(`Finding where ${hostname}'s DNS lives…`);
    const w = await writeRecords(ctx, hostname, records, prefer);
    ctx.progress(`Routing ${hostname} to ${svc.name}; HTTPS follows once DNS points here…`);
    await routeService(ctx, serverRow(ctx, svc.server_id), svc as ServiceRow, container, replicaNames(container, cfg.replicas), { hostname, tls: 'auto' });
    saveDomain(ctx, hostname, w, { kind: 'unit7', serviceId: svc.id }, records, svc.id);
    ctx.emit('domain.pointed', w.written ? `${hostname} → ${svc.name}: DNS set at ${w.provider}` : `${hostname} → ${svc.name}: waiting for a DNS record at ${w.host ?? 'your DNS provider'}`, { severity: w.written ? 'success' : 'info', resource: svc.id });
    return w.written
      ? { hostname, dns: `${w.provider}: A ${hostname} → ${ip}`, url: `https://${hostname}`, note: 'DNS usually updates within minutes; Unit7 checks and HTTPS turns on by itself.' }
      : { hostname, ...needsYou(w, records) };
  },
});

// Is a domain doing what it should? Each expected record is checked through public DNS; HTTPS is
// probed. Waiting → live is announced; live → not pointing anymore is an alert (someone changed DNS).
export async function checkDomain(ctx: Ctx, domainId: string) {
  const d = get<{ hostname: string; service_id: string | null; records: string | null; status: string; target: string | null }>(ctx.db, 'SELECT hostname, service_id, records, status, target FROM domains WHERE id = ? AND org_id = ?', domainId, ctx.orgId);
  if (!d) throw new Unit7Error('not_found', 'That domain was not found.', 404);
  let recs = json<Rec[]>(d.records ?? '[]', []);
  if (!recs.length && d.service_id) { // domains from before records were kept: the server's address
    const svc = get<{ server_id: string | null }>(ctx.db, 'SELECT server_id FROM services WHERE id = ?', d.service_id);
    if (svc?.server_id) recs = [{ type: 'A', name: d.hostname, content: await serverPublicIp(ctx, svc.server_id) }];
  }
  const checks = await Promise.all(recs.filter((r) => r.type !== 'TXT').map(async (r) => ({ r, ...(await resolvesTo(r.name, r.type === 'A' || r.type === 'AAAA' ? { a: [r.content] } : { cname: r.content })) })));
  const resolves = checks.length > 0 && checks.every((c) => c.ok);
  // a Vercel domain also has to be confirmed on Vercel's side (it re-checks the ownership record)
  const t = json<{ kind?: string; accountId?: string; project?: string; team?: string }>(d.target ?? '{}', {});
  if (resolves && d.status !== 'active' && t.kind === 'vercel') await vercel.verify(ctx, t.accountId!, t.project!, t.team, d.hostname);
  if (resolves && d.status !== 'active' && (t.kind === 'netlify' || t.kind === 'render' || t.kind === 'railway' || t.kind === 'supabase' || t.kind === 'fly')) await (HOSTS[t.kind].confirm as (c: Ctx, t: unknown, d: string) => Promise<unknown>)(ctx, t, d.hostname);
  let https = false;
  if (resolves) { try { const res = await fetch(`https://${d.hostname}/`, { method: 'HEAD', signal: AbortSignal.timeout(10_000), redirect: 'manual' }); https = res.status > 0; } catch { /* certificate not issued yet */ } }
  const status = resolves ? 'active' : d.status === 'active' || d.status === 'broken' ? 'broken' : d.status;
  run(ctx.db, `UPDATE domains SET status = ?, tls = ?, checked_at = ? WHERE id = ?`, status, https ? 'active' : 'issuing', new Date().toISOString(), domainId);
  if (status === 'active' && d.status !== 'active') ctx.emit('domain.live', `${d.hostname} is live${https ? ' with HTTPS' : '; HTTPS follows in a minute or two'}`, { severity: 'success', resource: d.service_id ?? undefined });
  if (status === 'broken' && d.status === 'active') ctx.emit('domain.broken', `${d.hostname} stopped pointing where it should (${checks.map((c) => `${c.r.name} → ${c.got.join(', ') || 'nothing'}`).join('; ')})`, { severity: 'critical', resource: d.service_id ?? undefined });
  return {
    hostname: d.hostname, status, httpsWorking: https,
    records: checks.map((c) => ({ type: c.r.type, name: c.r.name, want: c.r.content, got: c.got, ok: c.ok })),
    note: resolves ? (https ? 'All good.' : 'DNS is right; the certificate should finish within a minute or two.') : `DNS doesn't say this yet: ${checks.filter((c) => !c.ok).map((c) => `${c.r.type} ${c.r.name} → ${c.r.content}`).join('; ')}.`,
  };
}

defineTool({
  name: 'domain.check', title: 'Check a domain', risk: 'read', action: 'read', timeoutMs: 30_000,
  description: 'Check that a domain\u2019s DNS says what it should (through public resolvers) and whether HTTPS works. Warden runs this every few minutes for domains still waiting, and daily for live ones. With host instead of domainId, any name at all: what public DNS says, whether it answers, which app or server Unit7 knows it reaches, and the alerts about it. Read-only.',
  input: z.object({ domainId: fid('dom').optional(), host: z.string().max(253).optional() }).refine((i) => !!i.domainId || !!i.host, 'Give domainId (a domain Unit7 manages) or host (any name).'),
  run: async (ctx, i) => (i.domainId ? checkDomain(ctx, i.domainId) : (await import('./recheck.ts')).inspectHost(ctx, i.host!)),
});

// --- moving a domain's DNS to Cloudflare -----------------------------------------------------------
// For a DNS host with no API, or one that can't point the bare domain at a hostname. Every record is
// copied first (email included), then the nameservers switch: by Unit7 at Hostinger or Name.com, by you
// elsewhere. The old records stay where they were, so switching back undoes it.
const COPYABLE = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT']);
async function movePlan(ctx: Ctx, domain: string, cfAccount?: string) {
  const { zone, host } = await dnsHost(domain.toLowerCase());
  if (!zone) throw new Unit7Error('not_found', `${domain} isn't in public DNS.`, 404);
  if (host === 'cloudflare') throw new Unit7Error('already', `${zone}'s DNS is already on Cloudflare.`, 409);
  const list = host ? LISTERS[host] : undefined;
  if (!list) throw new Unit7Error('unsupported', `Unit7 can't read every record at ${host ?? 'this DNS host'}, so it won't move ${zone} (missing an email record would break your email). Add the records to Cloudflare by hand, then switch the nameservers.`, 400);
  let records: FullRec[] | undefined, from: string | undefined;
  for (const a of all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM accounts WHERE org_id = ? AND provider = ?', ctx.orgId, host!)) {
    try { records = await list(ctx, a.id, zone); from = a.name; break; } catch { /* not this account's zone */ }
  }
  if (!records) throw new Unit7Error('no_account', `Connect the ${host} account that holds ${zone} first, so Unit7 can read its records.`, 409);
  const cf = cfAccount ?? all<{ id: string }>(ctx.db, `SELECT id FROM accounts WHERE org_id = ? AND provider = 'cloudflare'`, ctx.orgId)[0]?.id;
  if (!cf) throw new Unit7Error('no_account', 'Connect Cloudflare first (free): Connections → Cloudflare.', 409);
  // who holds the registration, if Unit7 can switch nameservers there
  let registrar: { provider: string; accountId: string; name: string } | undefined;
  for (const a of all<{ id: string; name: string; provider: string }>(ctx.db, `SELECT id, name, provider FROM accounts WHERE org_id = ? AND provider IN ('hostinger', 'namecom')`, ctx.orgId)) {
    const owns = a.provider === 'hostinger'
      ? await hostinger(ctx.app).call(ctx, a.id, 'execute', { operation: 'domains_portfolio_list', params: {} }, 60_000).then((t) => (JSON.parse(t) as { domain: string }[]).some((d) => d.domain === zone), () => false)
      : await rest('Name.com', `${NAMECOM}/domains/${zone}`, { headers: nc(ctx, a.id) }).then(() => true, () => false);
    if (owns) { registrar = { provider: a.provider, accountId: a.id, name: a.name }; break; }
  }
  const copy = records.filter((r) => COPYABLE.has(r.type.toUpperCase()));
  const manual = records.filter((r) => !COPYABLE.has(r.type.toUpperCase()) && !['NS', 'SOA'].includes(r.type.toUpperCase()));
  const byType: Record<string, number> = {};
  for (const r of copy) byType[r.type] = (byType[r.type] ?? 0) + 1;
  return { zone, from: `${host} (${from})`, copy, manual, byType, cf, registrar,
    email: copy.filter((r) => r.type === 'MX' || (r.type === 'TXT' && /spf|dkim|dmarc/i.test(`${r.name} ${r.content}`))).length };
}

defineTool({
  name: 'domain.move_dns', title: 'Move a domain\u2019s DNS to Cloudflare', risk: 'destructive', action: 'dns_write', timeoutMs: 10 * 60_000,
  description: 'Move a domain\u2019s DNS to Cloudflare (free, full API, can point the bare domain anywhere). Copies every record first, email included, then switches the nameservers (Unit7 does it at Hostinger or Name.com; elsewhere you get the two nameservers to set). Run with dryRun first to see what moves.',
  input: z.object({ domain: z.string().min(3).max(253), cloudflareAccountId: fid('acc').optional() }),
  async dryRun(ctx, i) {
    const p = await movePlan(ctx, i.domain, i.cloudflareAccountId);
    return { zone: p.zone, from: p.from, willCopy: p.byType, emailRecords: p.email, copyByHand: p.manual.map((r) => `${r.type} ${r.name} ${r.content}`), nameservers: p.registrar ? `Unit7 switches them at ${p.registrar.name}` : 'You switch them at your registrar (Unit7 shows the two Cloudflare nameservers)' };
  },
  async run(ctx, i) {
    const p = await movePlan(ctx, i.domain, i.cloudflareAccountId);
    ctx.progress(`Creating ${p.zone} on Cloudflare…`);
    const z = await cloudflare.createZone(ctx, p.cf, p.zone);
    ctx.progress(`Copying ${p.copy.length} records…`);
    for (const r of p.copy) await cloudflare.addRecord(ctx, p.cf, z.id, { type: r.type.toUpperCase(), name: r.name, content: r.content, ttl: r.ttl && r.ttl >= 60 ? r.ttl : 1, priority: r.type.toUpperCase() === 'MX' ? r.priority ?? 10 : undefined });
    let switched = false;
    if (p.registrar) { await NAMESERVERS[p.registrar.provider]!(ctx, p.registrar.accountId, p.zone, z.name_servers); switched = true; }
    ctx.emit('domain.dns_moving', `${p.zone}: ${p.copy.length} records copied to Cloudflare${switched ? `, nameservers switched at ${p.registrar!.name}` : '; switch the nameservers to finish'}`, { severity: 'success', resource: p.zone });
    return {
      zone: p.zone, copied: p.byType, emailRecords: p.email, nameservers: z.name_servers,
      next: switched ? 'Nameservers switched. Cloudflare takes over once that spreads (usually under an hour, up to a day). Your old records stay at the old host, so nothing breaks meanwhile.'
        : `At your registrar, set the nameservers for ${p.zone} to ${z.name_servers.join(' and ')}. Cloudflare takes over once that spreads.`,
      copyByHand: p.manual.length ? p.manual.map((r) => `${r.type} ${r.name} ${r.content}`) : undefined,
    };
  },
});

// Stop others sending email as your domain. DMARC lives at its own name (_dmarc), so writing it can't
// touch any other record; SPF shares the bare domain's TXT records with verifications, so Unit7 only says
// what to add there.
defineTool({
  name: 'domain.protect_email', title: 'Protect a domain\u2019s email', risk: 'write', action: 'dns_write', timeoutMs: 2 * 60_000,
  description: 'Add a DMARC record so nobody can send email pretending to be this domain (p=reject if the domain sends no email, else p=none to start by watching). Written where the domain\u2019s DNS lives; never touches other records.',
  input: z.object({ domain: z.string().min(3).max(253) }),
  async run(ctx, i) {
    const domain = i.domain.toLowerCase();
    const { Resolver } = await import('node:dns/promises');
    const r = new Resolver({ timeout: 4000, tries: 2 }); r.setServers(['1.1.1.1', '8.8.8.8']);
    const [mx, existing, root] = await Promise.all([r.resolveMx(domain).then((v) => v.length > 0, () => false), r.resolveTxt(`_dmarc.${domain}`).then((v) => v.map((p) => p.join('')), () => [] as string[]), r.resolveTxt(domain).then((v) => v.map((p) => p.join('')), () => [] as string[])]);
    if (existing.some((t) => /^v=DMARC1/i.test(t))) return { domain, dmarc: 'already set', record: existing.find((t) => /^v=DMARC1/i.test(t)) };
    const value = mx ? 'v=DMARC1; p=none' : 'v=DMARC1; p=reject';
    const w = await writeRecords(ctx, `_dmarc.${domain}`, [{ type: 'TXT', name: `_dmarc.${domain}`, content: value }]);
    const spf = root.some((t) => /^v=spf1/i.test(t)) ? undefined : mx ? 'Also add an SPF record at the bare domain listing who sends your email (your email provider gives you the line, e.g. "v=spf1 include:_spf.google.com ~all").' : 'Also add "v=spf1 -all" at the bare domain (it says the domain sends no email).';
    return w.written ? { domain, dmarc: value, at: w.provider, spf } : { domain, ...needsYou(w, [{ type: 'TXT', name: `_dmarc.${domain}`, content: value }]), spf };
  },
});

defineTool({
  name: 'domain.remove', title: 'Remove a domain', risk: 'destructive', action: 'dns_write', timeoutMs: 60_000,
  description: 'Stop serving a hostname from Unit7 (removes its route). Does not delete the DNS record.',
  input: z.object({ domainId: fid('dom') }),
  async run(ctx, i) {
    const d = get<{ hostname: string; service_id: string | null }>(ctx.db, 'SELECT hostname, service_id FROM domains WHERE id = ? AND org_id = ?', i.domainId, ctx.orgId);
    if (!d) throw new Unit7Error('not_found', 'That domain was not found.', 404);
    const svc = d.service_id && get<{ server_id: string | null }>(ctx.db, 'SELECT server_id FROM services WHERE id = ?', d.service_id);
    if (svc && svc.server_id) await removeSite(ctx.app, serverRow(ctx, svc.server_id), d.hostname).catch(() => undefined);
    run(ctx.db, 'DELETE FROM domains WHERE id = ?', i.domainId);
    return { removed: d.hostname };
  },
});
