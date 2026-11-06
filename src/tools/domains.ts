// Domains, end to end. "Point app.example.com at production" works as one step: find the DNS
// account, add the A record, point Caddy at the service's container, and let Caddy issue the
// certificate. Provider adapters (Cloudflare now, Hostinger DNS via its MCP) sit behind one tool.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { serverRow } from './servers.ts';
import { removeSite, assertHostname, proxyFor } from '../deploy/caddy.ts';
import { cloudflare } from '../connectors/cloudflare.ts';
import { writeRecords, LISTERS, NAMESERVERS, putBack, rest, NAMECOM, nc, type Rec, type WriteResult, type WriteUndo, type FullRec } from '../connectors/dnswrite.ts';
import { hostinger } from '../connectors/hostinger.ts';
import { vercel, supabase } from '../connectors/clouds.ts';
import { netlify, render, railway, heroku, fly } from '../connectors/hosts.ts';
import { resolvesTo, dnsHost, publicResolver, spfAdvice } from '../connectors/dnsinfo.ts';
import { loginHint } from '../care/mail.ts';
import { hostsOf } from '../connectors/coolify.ts';
import { act, need, setDomains } from './coolify.ts';
import { CHANGE_UNDO, keepChange } from './manage.ts';
import { wildcardCertificate } from './redirects.ts';
import { githubToken, pagesDomain, parseRepo } from '../connectors/github.ts';
import { verifiers } from './core.ts';
import { fid, isAgent } from './helpers.ts';
import { routeService, replicaNames, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';

verifiers.cloudflare = (ctx, account) => cloudflare.verify(ctx, account.id);

export async function serverPublicIp(ctx: Ctx, serverId: string): Promise<string> {
  const s = serverRow(ctx, serverId);
  const facts = json<{ publicIp?: string }>(s.facts, {});
  return facts.publicIp ?? s.host;
}

defineTool({
  name: 'domain.list', title: 'List domains', risk: 'read', action: 'read',
  description: 'Domains Unit7 manages, their service, TLS status and whether DNS currently points at the right server.',
  input: z.object({ serviceId: fid('svc').optional() }),
  run: (ctx, i) => all<{ redirects: string | null }>(ctx.db, `SELECT d.id, d.hostname, d.status, d.tls, d.tls_mode, d.auto, s.name service, json_extract(d.target, '$.redirects') redirects FROM domains d LEFT JOIN services s ON s.id = d.service_id
    WHERE d.org_id = ? AND (? IS NULL OR d.service_id = ?) ORDER BY d.created_at DESC`, ctx.orgId, i.serviceId ?? null, i.serviceId ?? null)
    .map(({ redirects, ...d }) => ({ ...d, ...(redirects && { redirects: json(redirects, []) }) })),
});

const vercelTarget = z.object({ accountId: fid('acc'), project: z.string().min(1).max(100), team: z.string().max(100).optional() });
const netlifyTarget = z.object({ accountId: fid('acc'), site: z.string().min(1).max(100) });
const renderTarget = z.object({ accountId: fid('acc'), service: z.string().min(1).max(100) });
const flyTarget = z.object({ accountId: fid('acc'), app: z.string().min(1).max(100) });
const herokuTarget = z.object({ accountId: fid('acc'), app: z.string().min(1).max(100) });
const supabaseTarget = z.object({ accountId: fid('acc'), ref: z.string().regex(/^[a-z]{20}$/) });
const railwayTarget = z.object({ accountId: fid('acc'), project: z.string().min(1).max(100), environment: z.string().min(1).max(100), service: z.string().min(1).max(100) });
const pagesTarget = z.object({ accountId: fid('acc'), project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'a Pages project name') });
const hostingerTarget = z.object({ accountId: fid('acc'), website: z.string().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'the website’s domain') });
const coolifyTarget = z.object({ serverId: fid('srv'), uuid: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/, 'a Coolify uuid'), kind: z.enum(['application', 'service']).default('application'), part: z.string().regex(/^[\w.-]{1,60}$/).optional() })
  .refine((t) => t.kind === 'application' || !!t.part, 'A Coolify service needs part: which of its parts gets the domain.');
const githubTarget = z.object({ accountId: fid('acc'), repo: z.string().regex(/^[\w-]+\/(?!\.+$)[\w.-]+$/, 'owner/name') });
// adding a domain on a host: it says what DNS should be; Unit7 writes it wherever the domain's DNS lives
const HOSTS = {
  netlify: { name: 'Netlify', attach: (ctx: Ctx, t: z.infer<typeof netlifyTarget>, d: string) => netlify.addDomain(ctx, t.accountId, t.site, d), confirm: (ctx: Ctx, t: z.infer<typeof netlifyTarget>) => netlify.ssl(ctx, t.accountId, t.site) },
  render: { name: 'Render', attach: (ctx: Ctx, t: z.infer<typeof renderTarget>, d: string) => render.addDomain(ctx, t.accountId, t.service, d), confirm: (ctx: Ctx, t: z.infer<typeof renderTarget>, d: string) => render.verify(ctx, t.accountId, t.service, d) },
  railway: { name: 'Railway', attach: (ctx: Ctx, t: z.infer<typeof railwayTarget>, d: string) => railway.addDomain(ctx, t.accountId, t, d), confirm: async () => undefined },
  fly: { name: 'Fly.io', attach: (ctx: Ctx, t: z.infer<typeof flyTarget>, d: string) => fly.addDomain(ctx, t.accountId, t.app, d), confirm: (ctx: Ctx, t: z.infer<typeof flyTarget>, d: string) => fly.check(ctx, t.accountId, t.app, d) },
  heroku: { name: 'Heroku', attach: (ctx: Ctx, t: z.infer<typeof herokuTarget>, d: string) => heroku.addDomain(ctx, t.accountId, t.app, d), confirm: async () => undefined }, // Heroku issues HTTPS by itself (ACM)
  pages: { name: 'Cloudflare Pages', attach: (ctx: Ctx, t: z.infer<typeof pagesTarget>, d: string) => cloudflare.addPagesDomain(ctx, t.accountId, t.project, d), confirm: (ctx: Ctx, t: z.infer<typeof pagesTarget>, d: string) => cloudflare.confirmPagesDomain(ctx, t.accountId, t.project, d) },
  github: { name: 'GitHub Pages', attach: async (ctx: Ctx, t: z.infer<typeof githubTarget>, d: string) => pagesDomain(parseRepo(t.repo)!, d, await githubToken(ctx, t.accountId)), confirm: async () => undefined },
  // Supabase: a custom domain for the project's API and auth (paid add-on, subdomains only)
  supabase: { name: 'Supabase', attach: async (ctx: Ctx, t: z.infer<typeof supabaseTarget>, d: string) => {
    if ((await dnsHost(d)).zone === d) throw new Unit7Error('unsupported', 'Supabase custom domains must be a subdomain (like api.example.com), not the bare domain.', 400);
    return supabase.addDomain(ctx, t.accountId, t.ref, d);
  }, confirm: (ctx: Ctx, t: z.infer<typeof supabaseTarget>) => supabase.confirmDomain(ctx, t.accountId, t.ref) },
  // Hostinger web hosting: parked on the website, so it serves the same pages, at the address the website answers on
  hostinger: { name: 'Hostinger', attach: async (ctx: Ctx, t: z.infer<typeof hostingerTarget>, d: string): Promise<Rec[]> => {
    const call = async (operation: string, params: Record<string, unknown>) => JSON.parse(await hostinger(ctx.app).call(ctx, t.accountId, 'execute', { operation, params }, 60_000)) as any;
    const found = await call('hosting_websites_list', { domain: t.website, per_page: 100 });
    const site = (Array.isArray(found) ? found : found?.data ?? []).find((w: { domain?: string }) => w.domain?.toLowerCase() === t.website) as { username?: string } | undefined;
    if (!site?.username) throw new Unit7Error('not_found', `This Hostinger account has no website called ${t.website}.`, 404);
    const [ip] = await domainDns.look().a(t.website).catch(() => [] as string[]);
    if (!ip) throw new Unit7Error('no_address', `${t.website} doesn’t answer in DNS yet, so Unit7 can’t tell which address ${d} should use.`, 409);
    await call('hosting_domains_create-website-parked', { username: site.username, domain: t.website, parked_domain: d });
    return [{ type: 'A', name: d, content: ip }];
  }, confirm: async () => undefined },
} as const;

// the wildcard's stand-in for asking DNS and HTTPS, since nobody can visit "*" itself
const reachable = (h: string) => h.replace(/^\*\./, 'unit7-check.');
// what checks ask the outside world (tests swap these)
export const domainDns = { host: dnsHost, look: publicResolver, https: async (host: string) => { try { return (await fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(10_000), redirect: 'manual' })).status > 0; } catch { return false; /* certificate not issued yet */ } } };

// Record a domain and what its DNS should say; Warden takes it from there (domain.check).
export function saveDomain(ctx: Ctx, hostname: string, w: WriteResult, target: object, records: Rec[], serviceId: string | null, tls: 'auto' | 'internal' = 'auto') {
  // hostnames are unique across organisations: never take over another one's record
  if (get(ctx.db, 'SELECT 1 FROM domains WHERE hostname = ? AND org_id <> ?', hostname, ctx.orgId)) throw new Unit7Error('domain_taken', `${hostname} belongs to another organisation in this Unit7.`, 409);
  // redirects belong to the name, so a re-point keeps them
  const { redirects } = json<{ redirects?: unknown[] }>(get<{ target: string | null }>(ctx.db, 'SELECT target FROM domains WHERE hostname = ?', hostname)?.target, {});
  run(ctx.db, `INSERT INTO domains (id, org_id, hostname, service_id, account_id, zone, status, tls, tls_mode, auto, target, records) VALUES (?, ?, ?, ?, ?, ?, ?, 'issuing', ?, 0, ?, ?)
    ON CONFLICT(hostname) DO UPDATE SET service_id = excluded.service_id, account_id = excluded.account_id, zone = excluded.zone, status = excluded.status, tls_mode = excluded.tls_mode, auto = 0, target = excluded.target, records = excluded.records`,
    id('dom'), ctx.orgId, hostname, serviceId, w.accountId ?? null, w.zone ?? null, w.written ? 'pending' : 'waiting_dns', tls, JSON.stringify({ ...target, ...(redirects?.length && { redirects }) }), JSON.stringify(records));
}
export const needsYou = (w: WriteResult, records: Rec[]) => ({
  dns: 'needs you', addThese: records.map((r) => ({ type: r.type === 'ALIAS' ? 'ALIAS (or CNAME flattening)' : r.type, name: w.zone && r.name === w.zone ? '@' : w.zone ? r.name.replace(`.${w.zone}`, '') : r.name, value: r.content })),
  at: w.host ?? 'your DNS provider', why: w.why, note: 'Add the records above where your domain\u2019s DNS is managed. Unit7 keeps checking and finishes by itself when they\u2019re live.',
});

// --- a Coolify app, in one step: the name on the app, its DNS, a restart so Coolify's proxy picks the name up, then a wait
// for HTTPS. The restart is part of what was asked for: nothing does it later by itself.
export const pointing = { pollMs: 15_000, waitMs: 3 * 60_000 }; // tests shorten these
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r, j) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); j(signal.reason); }, { once: true }); });
type CoolifyPoint = z.infer<typeof coolifyTarget>;
interface PointUndo { coolify: CoolifyPoint; hostname: string; before: string[]; changed: boolean; wild: string[]; dns?: WriteUndo; row?: { service_id: string | null; target: string | null; records: string | null; status: string; tls_mode: string | null } }
async function undoPoint(ctx: Ctx, u: PointUndo, restart: boolean) {
  const s = serverRow(ctx, u.coolify.serverId), { api } = need(ctx, s);
  for (const h of u.wild) await removeSite(ctx.app, s, h);
  if (u.changed) await setDomains(ctx, api, s, { ...u.coolify, domains: u.before, replace: true, exact: true });
  if (u.dns) await putBack(ctx, u.dns);
  if (restart && u.changed) await act(ctx, api, { uuid: u.coolify.uuid, kind: u.coolify.kind, action: 'restart' });
  if (u.row) run(ctx.db, 'UPDATE domains SET service_id = ?, target = ?, records = ?, status = ?, tls_mode = ? WHERE hostname = ? AND org_id = ?', u.row.service_id, u.row.target, u.row.records, u.row.status, u.row.tls_mode, u.hostname, ctx.orgId);
  else run(ctx.db, 'DELETE FROM domains WHERE hostname = ? AND org_id = ?', u.hostname, ctx.orgId);
}
CHANGE_UNDO['domain.point'] = async (ctx, ch) => {
  const u = json<PointUndo>(ch.undo, {} as PointUndo);
  await undoPoint(ctx, u, true);
  return { taken: u.hostname, ...(u.before.length && { keeps: u.before }) };
};

async function pointCoolify(ctx: Ctx, hostname: string, t: CoolifyPoint, prefer: { provider?: string; accountId?: string }, also: string[], wait: boolean) {
  const s = serverRow(ctx, t.serverId), { api } = need(ctx, s);
  const ip = await serverPublicIp(ctx, s.id);
  const names = [hostname, ...also.filter((n) => n !== hostname)];
  const records: Rec[] = names.map((name) => ({ type: 'A', name, content: ip }));
  ctx.progress(`Adding ${hostname} to the app in Coolify…`);
  const set = await setDomains(ctx, api, s, { uuid: t.uuid, kind: t.kind, part: t.part, domains: names });
  const row = get<NonNullable<PointUndo['row']>>(ctx.db, 'SELECT service_id, target, records, status, tls_mode FROM domains WHERE hostname = ? AND org_id = ?', hostname, ctx.orgId);
  const undo: PointUndo = { coolify: t, hostname, before: set.before, changed: set.changed, wild: set.wild, ...(row && { row }) };
  ctx.progress(`Finding where ${hostname}'s DNS lives…`);
  let w: WriteResult;
  try { w = await writeRecords(ctx, hostname, records, { ...prefer, keep: true }); } catch (e) { await undoPoint(ctx, undo, false).catch(() => undefined); throw e; }
  if (w.written) undo.dns = { provider: w.provider!, accountId: w.accountId!, zone: w.zone!, added: records, before: w.before ?? [] };
  saveDomain(ctx, hostname, w, { kind: 'coolify', serverId: s.id, uuid: t.uuid, resource: t.kind, ...(t.part && { part: t.part }) }, records, null);
  if (set.changed) {
    ctx.progress(`Restarting the app so Coolify’s proxy picks up ${hostname}…`);
    const r = await act(ctx, api, { uuid: t.uuid, kind: t.kind, action: 'restart' }).catch((e: Error) => ({ status: 'failed', logTail: [] as string[], message: e.message }));
    if (/fail|error/i.test(r.status)) {
      await undoPoint(ctx, undo, false).catch(() => undefined);
      throw new Unit7Error('restart_failed', `Coolify couldn’t restart the app (${r.status}), so ${hostname} isn’t live. Unit7 took the name off again. Fix the app, then run this again.`, 502, { logTail: ('logTail' in r ? r.logTail ?? [] : []).join('\n') });
    }
  }
  const changeId = keepChange(ctx, `dns:${hostname}`, 'domain.point', `Pointed ${hostname} at an app in Coolify on ${s.name}`, undo);
  ctx.emit('domain.pointed', w.written ? `${hostname} → Coolify on ${s.name}: DNS set at ${w.provider}` : `${hostname} → Coolify on ${s.name}: waiting for a DNS record at ${w.host ?? 'your DNS provider'}`, { severity: w.written ? 'success' : 'info', resource: s.id });
  const undoLine = { changeId, undo: `change.undo with changeId ${changeId} takes ${hostname} off the app again and puts the old DNS back.` };
  const wild = set.wild.length > 0;
  const certificate = wild ? { certificate: await wildcardCertificate(ctx, s, hostname, w.provider ?? w.host) } : {};
  if (!w.written) return { hostname, ...needsYou(w, records), ...certificate, ...undoLine };
  const dom = get<{ id: string }>(ctx.db, 'SELECT id FROM domains WHERE hostname = ? AND org_id = ?', hostname, ctx.orgId)!;
  let seen = await checkDomain(ctx, dom.id);
  // a wildcard's certificate doesn't turn up by waiting unless its challenge is set up, and that takes minutes when it is
  for (const until = Date.now() + pointing.waitMs; wait && !wild && !seen.httpsWorking && Date.now() < until;) {
    ctx.progress(`Waiting for ${hostname}’s HTTPS certificate…`);
    await sleep(pointing.pollMs, ctx.signal);
    seen = await checkDomain(ctx, dom.id);
  }
  return { hostname, dns: records.map((r) => `${w.provider}: A ${r.name} → ${r.content}`), ...(!wild && { url: `https://${hostname}` }), https: seen.httpsWorking,
    note: seen.httpsWorking ? `${hostname} works with HTTPS.` : wild ? `DNS is set and Coolify’s proxy answers for ${hostname}.` : `${seen.note} Unit7 keeps checking and tells you when HTTPS is on; if it doesn’t come, domain.renew_https says why.`,
    ...certificate, ...undoLine };
}

// a line in the result, nothing more: changing where login goes is the person's next step
const withLoginHint = <I extends { hostname: string }, O extends object>(go: (ctx: Ctx, i: I) => Promise<O>) => async (ctx: Ctx, i: I) => {
  const out = await go(ctx, i), suggest = loginHint(ctx.db, ctx.orgId, i.hostname.toLowerCase());
  return { ...out, ...(suggest && { suggest }) };
};

defineTool({
  // pointing at an app here is routine; at an outside host the name leaves Unit7's hands
  name: 'domain.point', title: 'Point a domain at an app', risk: (i) => (i.serviceId || i.server || i.coolify ? 'write' : 'destructive'), action: 'dns_write', timeoutMs: 20 * 60_000,
  description: 'Point a hostname (e.g. app.example.com) at an app: one deployed here (serviceId); GitHub Pages (github); a Coolify app (coolify: its serverId and uuid; a service needs kind service and part), in one step: the name goes on the app, DNS is written, the app restarts so Coolify’s proxy picks the name up, Unit7 waits for HTTPS and reports (Undo takes it back); or on Vercel, Netlify, Render, Railway, Heroku, Fly.io, Cloudflare Pages (pages) or Hostinger web hosting (hostinger: the website it should show); or at a Supabase project\u2019s API (supabase, a paid add-on there); or at one of your servers itself (server: an A record to its address, for something that answers behind its own proxy there, like Coolify\u2019s dashboard). Unit7 finds where the domain\u2019s DNS lives (Hostinger, Cloudflare…), writes the records with your connected account there (or tells you exactly what to add, and finishes by itself once it\u2019s live), and gets HTTPS working. A wildcard (*.example.com) works on your own server and on a Coolify app: the result says exactly what its certificate needs (a wildcard certificate takes the DNS-01 challenge).',
  input: z.object({ hostname: z.string().min(3).max(253), serviceId: fid('svc').optional(), vercel: vercelTarget.optional(), netlify: netlifyTarget.optional(), render: renderTarget.optional(), railway: railwayTarget.optional(), supabase: supabaseTarget.optional(), heroku: herokuTarget.optional(), fly: flyTarget.optional(),
    server: z.object({ serverId: fid('srv') }).optional(), coolify: coolifyTarget.optional(), pages: pagesTarget.optional(), github: githubTarget.optional(), hostinger: hostingerTarget.optional(),
    also: z.array(z.string().min(3).max(253)).max(3).optional().describe('Coolify only: more names to add in the same step, so the app restarts once'),
    wait: z.boolean().optional().describe('Coolify only: false to skip the wait for HTTPS'),
    provider: z.string().max(40).optional(), accountId: fid('acc').optional() })
    .refine((i) => [i.serviceId, i.vercel, i.netlify, i.render, i.railway, i.supabase, i.heroku, i.fly, i.server, i.coolify, i.pages, i.github, i.hostinger].filter(Boolean).length === 1, 'Give exactly one target: serviceId (an app here), coolify, vercel, netlify, render, railway, heroku, fly, pages, hostinger, supabase or server.'),
  run: withLoginHint(async (ctx, i) => {
    const hostname = i.hostname.toLowerCase();
    // a name already serving one app is moved to another only by a person (it may be production's address)
    const serving = get<{ service_id: string | null; target: string | null }>(ctx.db, 'SELECT service_id, target FROM domains WHERE hostname = ? AND org_id = ?', hostname, ctx.orgId);
    const was = json<{ kind?: string; uuid?: string }>(serving?.target, {});
    if (isAgent(ctx) && serving && (i.coolify ? was.kind !== 'coolify' || was.uuid !== i.coolify.uuid : (serving.service_id ?? null) !== (i.serviceId ?? null))) {
      throw new Unit7Error('forbidden', `${hostname} already points somewhere else. A person can move it.`, 403);
    }
    const wild = hostname.startsWith('*.');
    assertHostname(hostname, wild);
    if (wild && !(i.serviceId || i.server || i.coolify)) throw new Unit7Error('unsupported', `A wildcard like ${hostname} works here on your own server or a Coolify app. Hosted platforms want it set up in their own dashboard, usually with their nameservers.`, 400);
    const prefer = { provider: i.provider, accountId: i.accountId };
    if (i.coolify) {
      (i.also ?? []).forEach((h) => assertHostname(h.toLowerCase()));
      return pointCoolify(ctx, hostname, i.coolify, prefer, (i.also ?? []).map((h) => h.toLowerCase()), i.wait !== false);
    }

    for (const kind of ['netlify', 'render', 'railway', 'supabase', 'heroku', 'fly', 'pages', 'github', 'hostinger'] as const) {
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
      const certificate = wild ? { certificate: await wildcardCertificate(ctx, s, hostname, w.provider ?? w.host) } : {};
      return w.written ? { hostname, dns: `${w.provider}: A ${hostname} → ${ip}`, note: 'DNS usually updates within minutes.', ...certificate } : { hostname, ...needsYou(w, records), ...certificate };
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
    const server = serverRow(ctx, svc.server_id);
    // the standard Caddy build can't get a wildcard certificate (no DNS plugin), so it signs its own; Traefik asks for a real one
    const tls = wild && proxyFor(server).kind === 'caddy' ? 'internal' : 'auto';
    await routeService(ctx, server, svc as ServiceRow, container, replicaNames(container, cfg.replicas), { hostname, tls });
    saveDomain(ctx, hostname, w, { kind: 'unit7', serviceId: svc.id }, records, svc.id, tls);
    ctx.emit('domain.pointed', w.written ? `${hostname} → ${svc.name}: DNS set at ${w.provider}` : `${hostname} → ${svc.name}: waiting for a DNS record at ${w.host ?? 'your DNS provider'}`, { severity: w.written ? 'success' : 'info', resource: svc.id });
    const certificate = wild ? { certificate: await wildcardCertificate(ctx, server, hostname, w.provider ?? w.host) } : {};
    return w.written
      ? { hostname, dns: `${w.provider}: A ${hostname} → ${ip}`, ...(!wild && { url: `https://${hostname}` }), note: wild ? 'DNS usually updates within minutes.' : 'DNS usually updates within minutes; Unit7 checks and HTTPS turns on by itself.', ...certificate }
      : { hostname, ...needsYou(w, records), ...certificate };
  }),
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
  const dns = domainDns.look();
  const checks = await Promise.all(recs.filter((r) => r.type !== 'TXT').map(async (r) => ({ r, ...(await resolvesTo(reachable(r.name), r.type === 'A' || r.type === 'AAAA' ? { a: [r.content] } : { cname: r.content }, dns)) })));
  const resolves = checks.length > 0 && checks.every((c) => c.ok);
  // a Vercel domain also has to be confirmed on Vercel's side (it re-checks the ownership record)
  const t = json<{ kind?: string; accountId?: string; project?: string; team?: string }>(d.target ?? '{}', {});
  if (resolves && d.status !== 'active' && t.kind === 'vercel') await vercel.verify(ctx, t.accountId!, t.project!, t.team, d.hostname);
  if (resolves && d.status !== 'active' && (t.kind === 'netlify' || t.kind === 'render' || t.kind === 'railway' || t.kind === 'supabase' || t.kind === 'fly' || t.kind === 'pages')) await (HOSTS[t.kind].confirm as (c: Ctx, t: unknown, d: string) => Promise<unknown>)(ctx, t, d.hostname);
  const wild = d.hostname.startsWith('*.');
  const https = resolves && await domainDns.https(reachable(d.hostname));
  const status = resolves ? 'active' : d.status === 'active' || d.status === 'broken' ? 'broken' : d.status;
  run(ctx.db, `UPDATE domains SET status = ?, tls = ?, checked_at = ? WHERE id = ?`, status, https ? 'active' : 'issuing', new Date().toISOString(), domainId);
  if (status === 'active' && d.status !== 'active') ctx.emit('domain.live', `${d.hostname} is live${https ? ' with HTTPS' : wild ? '; its wildcard certificate still needs the DNS-01 challenge' : '; HTTPS follows in a minute or two'}`, { severity: 'success', resource: d.service_id ?? undefined });
  if (status === 'broken' && d.status === 'active') ctx.emit('domain.broken', `${d.hostname} stopped pointing where it should (${checks.map((c) => `${c.r.name} → ${c.got.join(', ') || 'nothing'}`).join('; ')})`, { severity: 'critical', resource: d.service_id ?? undefined });
  return {
    hostname: d.hostname, status, httpsWorking: https,
    records: checks.map((c) => ({ type: c.r.type, name: c.r.name, want: c.r.content, got: c.got, ok: c.ok })),
    note: resolves ? (https ? 'All good.' : wild ? 'DNS is right. A wildcard certificate needs the DNS-01 challenge: until that’s set up, browsers warn. domain.renew_https says why it failed on Coolify.' : 'DNS is right; the certificate should finish within a minute or two.') : `DNS doesn't say this yet: ${checks.filter((c) => !c.ok).map((c) => `${c.r.type} ${c.r.name} → ${c.r.content}`).join('; ')}.`,
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
      : await rest('Name.com', `${NAMECOM()}/domains/${zone}`, { headers: nc(ctx, a.id) }).then(() => true, () => false);
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

const spfWords = (root: string[], mx: string[]) => { const a = spfAdvice(root, mx); return a && (a.record ? `Also set the SPF record at the bare domain to "${a.record}". ${a.why} dns.set writes it and keeps an undo.` : `Also add an SPF record at the bare domain. ${a.why}`); };

// Stop others sending email as your domain. DMARC lives at its own name (_dmarc), so writing it can't
// touch any other record; SPF is one line at the bare domain, so Unit7 says the whole line, what's there kept in it.
defineTool({
  name: 'domain.protect_email', title: 'Protect a domain\u2019s email', risk: 'write', action: 'dns_write', timeoutMs: 2 * 60_000,
  description: 'Add a DMARC record so nobody can send email pretending to be this domain (p=reject if the domain sends no email, else p=none to start by watching). Written where the domain\u2019s DNS lives; never touches other records.',
  input: z.object({ domain: z.string().min(3).max(253) }),
  async run(ctx, i) {
    const domain = i.domain.toLowerCase();
    const { Resolver } = await import('node:dns/promises');
    const r = new Resolver({ timeout: 4000, tries: 2 }); r.setServers(['1.1.1.1', '8.8.8.8']);
    const [mx, existing, root] = await Promise.all([r.resolveMx(domain).then((v) => v.map((m) => `${m.priority} ${m.exchange}`), () => [] as string[]), r.resolveTxt(`_dmarc.${domain}`).then((v) => v.map((p) => p.join('')), () => [] as string[]), r.resolveTxt(domain).then((v) => v.map((p) => p.join('')), () => [] as string[])]);
    if (existing.some((t) => /^v=DMARC1/i.test(t))) return { domain, dmarc: 'already set', record: existing.find((t) => /^v=DMARC1/i.test(t)) };
    const value = mx.length ? 'v=DMARC1; p=none' : 'v=DMARC1; p=reject';
    const w = await writeRecords(ctx, `_dmarc.${domain}`, [{ type: 'TXT', name: `_dmarc.${domain}`, content: value }]);
    const spf = spfWords(root, mx);
    return w.written ? { domain, dmarc: value, at: w.provider, spf } : { domain, ...needsYou(w, [{ type: 'TXT', name: `_dmarc.${domain}`, content: value }]), spf };
  },
});

defineTool({
  name: 'domain.remove', title: 'Remove a domain', risk: 'destructive', action: 'dns_write', timeoutMs: 60_000,
  description: 'Stop serving a hostname from Unit7 (removes its route and any redirect on it; on a Coolify app, takes the name off the app, from its next deploy). Does not delete the DNS record.',
  input: z.object({ domainId: fid('dom') }),
  async run(ctx, i) {
    const d = get<{ hostname: string; service_id: string | null; target: string | null }>(ctx.db, 'SELECT hostname, service_id, target FROM domains WHERE id = ? AND org_id = ?', i.domainId, ctx.orgId);
    if (!d) throw new Unit7Error('not_found', 'That domain was not found.', 404);
    const t = json<{ kind?: string; serverId?: string; uuid?: string; resource?: 'application' | 'service'; part?: string }>(d.target, {});
    const svc = d.service_id && get<{ server_id: string | null }>(ctx.db, 'SELECT server_id FROM services WHERE id = ?', d.service_id);
    const serverId = (svc && svc.server_id) || t.serverId;
    if (serverId) await removeSite(ctx.app, serverRow(ctx, serverId), d.hostname).catch(() => undefined);
    let next: string | undefined;
    if (t.kind === 'coolify' && t.uuid && !d.hostname.startsWith('*.') && (t.resource ?? 'application') === 'application') {
      const s = serverRow(ctx, t.serverId!), { api } = need(ctx, s);
      const r = await api.call('GET', `/applications/${encodeURIComponent(t.uuid)}`);
      const urls = String(r?.fqdn ?? '').split(',').map((u) => u.trim()).filter(Boolean), keep = urls.filter((u) => hostsOf(u)[0] !== d.hostname);
      if (keep.length !== urls.length) await api.call('PATCH', `/applications/${encodeURIComponent(t.uuid)}`, { domains: keep.join(',') });
      next = 'Coolify stops answering it from the next deploy (coolify.control deploy).';
    }
    run(ctx.db, 'DELETE FROM domains WHERE id = ?', i.domainId);
    return { removed: d.hostname, ...(next && { next }) };
  },
});
