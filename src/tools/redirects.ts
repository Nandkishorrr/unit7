// Redirects and what a wildcard certificate takes. domain.redirect sends a whole name, or a path on it, to any address: on a
// Coolify server a file in the folder its Traefik watches (a Restart Proxy leaves that folder alone, and Coolify's saved
// settings are checked for it first), on Unit7's own servers Caddy's redir, on Vercel the project domain's redirect setting.
// What's set is kept with the name (domains.target), so a deploy writes it again, and Undo puts things back.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, json, run } from '../db.ts';
import { forbidden, Unit7Error } from '../errors.ts';
import { fid, isAgent } from './helpers.ts';
import { serverRow } from './servers.ts';
import { assertReachable } from '../netguard.ts';
import { REDIRECT_PATH, REDIRECT_TO, assertHostname, proxyFor, putSite, putTraefikRedirects, removeSite, type Redirect, type Site } from '../deploy/caddy.ts';
import { replicaNames, routeService, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';
import { DNS_ACCOUNT, putBack, writeRecords, type Rec, type WriteUndo } from '../connectors/dnswrite.ts';
import { proxyFacts } from '../connectors/coolify.ts';
import { vercel } from '../connectors/clouds.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import { readProxy } from './coolify.ts';
import { saveDomain, needsYou, serverPublicIp } from './domains.ts';
import { CHANGE_UNDO, keepChange } from './manage.ts';
import { CANON } from './launch.ts';
import { dnsDeps } from './clouds-dns.ts';

// --- a wildcard's certificate -------------------------------------------------------------------------------------------
// Let's Encrypt only proves a whole domain through the DNS-01 challenge, so the proxy needs a key that can edit its DNS.
// Unit7 never puts that key on a server by itself (Coolify's proxy settings hold it in plain text): a person does, once.
const DNS01: Record<string, { code: string; env: string[]; name: string }> = {
  cloudflare: { code: 'cloudflare', env: ['CF_DNS_API_TOKEN'], name: 'Cloudflare' }, hostinger: { code: 'hostinger', env: ['HOSTINGER_API_TOKEN'], name: 'Hostinger' },
  godaddy: { code: 'godaddy', env: ['GODADDY_API_KEY', 'GODADDY_API_SECRET'], name: 'GoDaddy' }, porkbun: { code: 'porkbun', env: ['PORKBUN_API_KEY', 'PORKBUN_SECRET_API_KEY'], name: 'Porkbun' },
  namecom: { code: 'namedotcom', env: ['NAMECOM_USERNAME', 'NAMECOM_API_TOKEN'], name: 'Name.com' }, digitalocean: { code: 'digitalocean', env: ['DO_AUTH_TOKEN'], name: 'DigitalOcean' },
  vercel: { code: 'vercel', env: ['VERCEL_API_TOKEN'], name: 'Vercel' }, hetzner: { code: 'hetzner', env: ['HETZNER_API_TOKEN'], name: 'Hetzner' },
  aws: { code: 'route53', env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'], name: 'Route 53' }, gcp: { code: 'gcloud', env: ['GCE_PROJECT', 'GCE_SERVICE_ACCOUNT_FILE'], name: 'Google Cloud DNS' },
  azure: { code: 'azuredns', env: ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_GROUP'], name: 'Azure DNS' },
};
const CHALLENGE = '--certificatesresolvers.letsencrypt.acme';
export async function wildcardCertificate(ctx: Ctx, s: ServerRow, host: string, dnsAt?: string) {
  const until = 'Until then the name answers, but browsers warn about its certificate.';
  const at = DNS01[DNS_ACCOUNT[dnsAt ?? ''] ?? dnsAt ?? ''];
  if (proxyFor(s).kind === 'other') return { state: 'needs_dns01', why: `A wildcard certificate takes Let’s Encrypt’s DNS-01 challenge. ${s.name}’s web ports belong to another program, so that’s where it has to be set up, with a key that can edit ${host.slice(2)}’s DNS.`, until };
  if (proxyFor(s).kind !== 'coolify') {
    return { state: 'needs_dns01', why: `A wildcard certificate takes Let’s Encrypt’s DNS-01 challenge, and the standard Caddy on ${s.name} has no plugin for it, so it signs ${host} itself for now.`, until,
      steps: [dnsAt === 'cloudflare' ? `In Cloudflare, turn on the orange cloud for ${host} (dns.set can, with proxied) and set SSL to Full: Cloudflare then gives visitors a real certificate.`
        : `The simplest way: move the domain’s DNS to Cloudflare (free; domain.move_dns does it), turn on the orange cloud for ${host} and set SSL to Full. Cloudflare then gives visitors a real certificate.`,
      `Or run a Caddy built with the caddy-dns plugin for ${at?.name ?? 'your DNS host'} and give it a DNS key. Unit7 doesn’t build that.`] };
  }
  const flags = await readProxy(ctx, s).then((p) => proxyFacts(p.text).command, () => [] as string[]);
  if (flags.some((f) => f.startsWith(`${CHALLENGE}.dnschallenge.provider=`))) return { state: 'on_the_way', note: `Coolify’s proxy has the DNS-01 challenge set up, so Traefik asks for ${host}’s certificate by itself. It can take a few minutes; domain.renew_https reads how it went from Traefik’s log.` };
  return { state: 'needs_dns01', why: `A wildcard certificate takes Let’s Encrypt’s DNS-01 challenge, and Coolify’s proxy on ${s.name} isn’t set up for it. Unit7 doesn’t put a DNS key on the server by itself: it would sit in plain text in Coolify’s proxy settings.`, until,
    steps: [`In Coolify: Servers → ${s.name} → Proxy → Configuration.`,
      `Under the traefik service’s environment, add ${(at?.env ?? ['the key your DNS host’s Lego provider asks for']).map((e) => `${e}=<a key from ${at?.name ?? 'your DNS host'}>`).join(' and ')}. It needs to be able to edit ${host.slice(2)}’s DNS.`,
      `In command, remove ${CHALLENGE}.httpchallenge=true and add ${CHALLENGE}.dnschallenge.provider=${at?.code ?? '<your DNS host’s Lego code>'} and ${CHALLENGE}.dnschallenge.delaybeforecheck=0.`,
      'Save, then press Restart Proxy. Sites pause for a few seconds.',
      `That certificate setting is for every site on this proxy: a domain whose DNS lives somewhere other than ${at?.name ?? 'that host'} can’t renew through it, so keep those on a second resolver.`],
    docs: 'https://coolify.io/docs/core/networking/proxy/traefik/dns-challenge' };
}

// --- where a redirect runs -------------------------------------------------------------------------------------------------
const clean = (s: string) => s.trim().replace(/^https?:\/\//i, '');
function fromOf(raw: string): { host: string; path?: string } {
  const c = clean(raw), cut = c.indexOf('/'), host = (cut < 0 ? c : c.slice(0, cut)).toLowerCase(), path = cut < 0 ? '' : c.slice(cut).replace(/\/+$/, '');
  assertHostname(host);
  if (path && !REDIRECT_PATH.test(path)) throw new Unit7Error('bad_redirect', `“${path}” isn’t a path Unit7 can redirect: use letters, digits and - _ . ~ /, like /old-page.`, 400);
  return { host, ...(path && { path }) };
}
const toOf = (raw: string) => (/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);

interface DomRow { id: string; hostname: string; service_id: string | null; target: string | null; records: string | null; tls_mode: string | null }
type Target = { kind?: string; serverId?: string; accountId?: string; project?: string; team?: string; redirects?: Redirect[]; redirectTo?: string };
const rowOf = (ctx: Ctx, host: string) => get<DomRow>(ctx.db, 'SELECT id, hostname, service_id, target, records, tls_mode FROM domains WHERE hostname = ? AND org_id = ?', host, ctx.orgId);
const targetIn = (r?: DomRow) => json<Target>(r?.target, {});
const saveList = (ctx: Ctx, r: DomRow, list: Redirect[]) => { const { redirects: _old, ...t } = targetIn(r); run(ctx.db, 'UPDATE domains SET target = ? WHERE id = ?', JSON.stringify({ ...t, ...(list.length && { redirects: list }) }), r.id); };

const NO_SETTING: Record<string, string> = { netlify: 'Netlify', render: 'Render', railway: 'Railway', heroku: 'Heroku', fly: 'Fly.io', supabase: 'Supabase', pages: 'Cloudflare Pages', hostinger: 'Hostinger', addon: 'This tool' };
function placeOf(ctx: Ctx, host: string, serverId?: string) {
  const row = rowOf(ctx, host), t = targetIn(row);
  if (t.kind === 'vercel') return { row, t, s: undefined };
  if (t.kind && NO_SETTING[t.kind]) throw new Unit7Error('unsupported', `${NO_SETTING[t.kind]} has no redirect setting Unit7 can use for ${host}. Your app can send visitors there itself, or point ${host} at one of your servers first.`, 400);
  const own = row?.service_id ? get<{ server_id: string | null }>(ctx.db, 'SELECT server_id FROM services WHERE id = ?', row.service_id)?.server_id : undefined;
  const servers = all<{ id: string }>(ctx.db, 'SELECT id FROM servers WHERE org_id = ?', ctx.orgId), known = t.serverId ?? own ?? undefined;
  if (serverId && known && known !== serverId) throw new Unit7Error('other_server', `${host} points at another server. Point it at that one first (domain.point), then add the redirect.`, 409);
  const id = serverId ?? known ?? (servers.length === 1 ? servers[0]!.id : undefined);
  if (!id) throw new Unit7Error('which_server', `Which server should answer ${host}? Give serverId.`, 400);
  const s = serverRow(ctx, id), proxy = proxyFor(s);
  if (proxy.kind === 'other') throw new Unit7Error('proxy_taken', `${s.name}’s web ports (80 and 443) belong to ${proxy.name}, so Unit7 can’t put a redirect there.`, 409);
  return { row, t, s };
}

// Coolify's saved settings, which its Restart Proxy goes by, have to read the folder the redirect lands in
async function needsFolder(ctx: Ctx, s: ServerRow) {
  const flags = proxyFacts((await readProxy(ctx, s)).text).command;
  if (!flags.some((f) => f.startsWith('--providers.file.directory='))) throw new Unit7Error('proxy_layout', `Coolify’s proxy on ${s.name} isn’t reading its folder of extra routes, so a redirect there wouldn’t work. Add --providers.file.directory=/traefik/dynamic/ and --providers.file.watch=true in Coolify (Servers → Proxy), then try again.`, 409);
}

// writes a name's whole list where it runs. The row already says the same, so a Caddy site can read it back.
async function apply(ctx: Ctx, s: ServerRow, host: string, list: Redirect[], row?: DomRow) {
  if (proxyFor(s).kind === 'coolify') return putTraefikRedirects(ctx.app, s, host, list);
  if (row?.service_id) {
    const svc = get<ServiceRow & { server_id: string | null; config: string; current_deployment_id: string | null }>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', row.service_id, ctx.orgId);
    const container = svc?.current_deployment_id ? get<{ container: string | null }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id)?.container : undefined;
    if (!svc || !container) throw new Unit7Error('not_deployed', `${svc?.name ?? 'That app'} isn’t running yet. Deploy it first.`, 409);
    await routeService(ctx, s, svc, container, replicaNames(container, json<ServiceConfig>(svc.config, {}).replicas), { hostname: host, tls: (row.tls_mode ?? 'auto') as Site['tls'] });
  } else if (list.length) await putSite(ctx.app, s, { hostname: host, upstream: '', port: 0, tls: 'auto', redirects: list });
  else await removeSite(ctx.app, s, host);
}

// asks the name for its page, and wants a redirect to where it should go (the host comes from the input: netguard first)
export const redirectChecks = { reachable: assertReachable }; // tests swap it
async function answersWith(host: string, path: string | undefined, to: string, keepPath: boolean): Promise<{ answered: boolean; ok: boolean; status?: number; location?: string }> {
  const probe = `${path ?? ''}/unit7-check`, want = keepPath ? `${to.replace(/\/$/, '')}${path ? '/unit7-check' : probe}` : to;
  try {
    await redirectChecks.reachable(host);
    const r = await CANON.fetch(`https://${host}${probe}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Unit7 redirect check' } });
    const location = r.headers.get('location') ?? undefined;
    return { answered: true, ok: r.status >= 300 && r.status < 400 && location === want, status: r.status, ...(location && { location }) };
  } catch { return { answered: false, ok: false }; }
}

interface RedirectUndo { host: string; path?: string; serverId?: string; before: Redirect[]; hadRow: boolean; target?: string | null; vercel?: { accountId: string; project: string; team?: string; to: string | null; code: number | null }; dns?: WriteUndo }

// a domain.canonical on a Coolify app: the other name sends visitors to the main one; the main one stops sending anywhere
export async function canonicalOnCoolify(ctx: Ctx, serverId: string, main: string, other: string) {
  const s = serverRow(ctx, serverId);
  await needsFolder(ctx, s);
  const set = async (host: string, list: Redirect[]) => { const row = rowOf(ctx, host); if (row) saveList(ctx, row, list); await putTraefikRedirects(ctx.app, s, host, list); };
  await set(main, targetIn(rowOf(ctx, main)).redirects?.filter((r) => r.path) ?? []);
  await set(other, [...(targetIn(rowOf(ctx, other)).redirects?.filter((r) => r.path) ?? []), { to: `https://${main}`, permanent: true, keepPath: true }]);
}

const redirectInput = z.object({
  from: z.string().min(3).max(300).describe('What to send away: a name (old.example.com) or a path on it (old.example.com/blog; everything under it too)'),
  to: z.string().min(3).max(1000).optional().describe('Any address, like https://new.example.net/news. Leave out with remove'),
  permanent: z.boolean().default(true).describe('A permanent redirect (browsers and search engines remember it); false for a temporary one'),
  keepPath: z.boolean().default(true).describe('Add the rest of the page and the query to the address, so /blog/a goes to /news/a; false sends everything to the address itself'),
  serverId: fid('srv').optional().describe('Which server answers the name, when Unit7 doesn’t know it yet'),
  remove: z.boolean().default(false).describe('Take this redirect away'),
}).superRefine((i, c) => {
  try { fromOf(i.from); } catch (e) { c.addIssue({ code: 'custom', path: ['from'], message: (e as Error).message }); }
  if (i.remove) return;
  if (!i.to) return c.addIssue({ code: 'custom', path: ['to'], message: 'Say where it should go.' });
  const to = toOf(i.to);
  if (!REDIRECT_TO.test(to)) c.addIssue({ code: 'custom', path: ['to'], message: 'must be an address like https://new.example.net/news, with no spaces, quotes or braces' });
  else if (i.keepPath && /[?]/.test(to)) c.addIssue({ code: 'custom', path: ['keepPath'], message: 'An address with a ? can’t keep the page: set keepPath to false.' });
});
type In = z.infer<typeof redirectInput>;

// never in a circle: to itself, or to a name that sends visitors straight back
function refuseLoop(ctx: Ctx, host: string, path: string | undefined, to: string) {
  const u = new URL(to), there = u.pathname.replace(/\/+$/, '');
  if (u.hostname === host && (!path || there === path || there.startsWith(`${path}/`))) throw new Unit7Error('redirect_loop', `That would send ${host}${path ?? ''} to itself.`, 400);
  const back = get<{ target: string | null }>(ctx.db, 'SELECT target FROM domains WHERE hostname = ? AND org_id = ?', u.hostname, ctx.orgId);
  if (!path && targetIn(back as DomRow).redirects?.some((r) => !r.path && new URL(r.to).hostname === host)) throw new Unit7Error('redirect_loop', `${u.hostname} already sends visitors to ${host}, so this would go round in a circle. Remove that one first.`, 409);
}

defineTool({
  name: 'domain.redirect', title: 'Send a domain or a page somewhere else', risk: 'write', action: 'proxy_config', timeoutMs: 3 * 60_000,
  description: 'Send a whole domain, or one path on it, to any address (from old.example.com/blog to https://new.example.net/news). On a Coolify server it lands in the folder of extra routes its Traefik watches, so Coolify’s Restart Proxy keeps it; other paths still reach the app. On Unit7’s own servers it goes in Caddy’s site for that name, so a deploy keeps it. On Vercel it’s the project domain’s redirect: whole domains only, to another domain on the same project. Netlify, Render, Railway, Heroku and Fly have no setting for it. A name Unit7 doesn’t know yet needs serverId; its DNS is pointed there. remove takes one away. keepPath (on by default) keeps the rest of the page and the query. A dry run says what happens. Activity’s Undo puts things back.',
  input: redirectInput,
  assess: (_c, i) => ({ tier: 2, impact: i.remove ? `${i.from} stops sending visitors elsewhere.` : `${i.from} sends visitors to ${i.to}${i.permanent ? ' (permanent)' : ''}. Activity’s Undo takes it back.` }),
  dryRun(ctx, i) {
    const { host, path } = fromOf(i.from), p = placeOf(ctx, host, i.serverId);
    return { from: `${host}${path ?? ''}`, ...(i.to && { to: toOf(i.to) }), runsOn: p.s ? `${proxyFor(p.s).kind === 'coolify' ? 'Coolify’s proxy' : 'Caddy'} on ${p.s.name}` : 'Vercel’s project domain', already: targetIn(p.row).redirects ?? [] };
  },
  run: (ctx, i) => setRedirect(ctx, i),
});

async function setRedirect(ctx: Ctx, i: In) {
  const { host, path } = fromOf(i.from), to = i.to ? toOf(i.to) : undefined;
  if (to) refuseLoop(ctx, host, path, to);
  const { row, t, s } = placeOf(ctx, host, i.serverId);
  const whole = `${host}${path ?? ''}`;
  // a name serving an app isn't taken over by an AI: the same rule as domain.point
  if (isAgent(ctx) && !path && !i.remove && row && t.kind !== 'redirect') throw forbidden(`${host} opens something right now. A person can make it send visitors to ${to}.`);

  if (!s) { // Vercel: one domain to another on the same project; it keeps the page by itself
    if (path || !i.keepPath) throw new Unit7Error('unsupported', `Vercel’s domain redirect moves a whole domain and keeps the page. For ${path ? 'one path' : 'anything else'}, add a redirect to vercel.json in the app.`, 400);
    const target = to ? new URL(to) : undefined;
    if (target && (target.pathname !== '/' || target.search)) throw new Unit7Error('unsupported', 'Vercel’s domain redirect goes to another domain, not to a page on it. Point it at the domain, or use vercel.json in the app.', 400);
    const v = { accountId: t.accountId!, project: t.project!, team: t.team };
    const was = await vercel.domainRedirect(ctx, v.accountId, v.project, v.team, host);
    await vercel.redirectDomain(ctx, v.accountId, v.project, v.team, host, target?.hostname ?? null, target && !i.permanent ? 302 : undefined).catch((e: Unit7Error) => {
      throw new Unit7Error('vercel_error', `${e.message} Vercel only redirects to another domain on the same project, so add ${target?.hostname ?? 'it'} there first.`, 502);
    });
    const summary = to ? `${host} now sends visitors to ${target!.hostname}` : `${host} stopped sending visitors elsewhere`;
    const changeId = keepChange(ctx, `dns:${host}`, 'domain.redirect', summary, { host, before: [], hadRow: true, vercel: { ...v, ...was } } satisfies RedirectUndo);
    return { from: host, ...(to && { to: target!.hostname }), how: 'vercel', changeId, undo: `change.undo with changeId ${changeId} puts it back.` };
  }

  if (proxyFor(s).kind === 'coolify') await needsFolder(ctx, s);
  const before = t.redirects ?? [];
  const others = before.filter((r) => (r.path ?? '') !== (path ?? ''));
  if (i.remove && others.length === before.length) throw new Unit7Error('not_found', `${whole} has no redirect.`, 404);
  const list: Redirect[] = i.remove ? others : [...others, { ...(path && { path }), to: to!, permanent: i.permanent, keepPath: i.keepPath }];
  const undo: RedirectUndo = { host, ...(path && { path }), serverId: s.id, before, hadRow: !!row, target: row?.target ?? null };

  // a name new to Unit7 needs its DNS here too
  let dns: Record<string, unknown> = {};
  if (!i.remove && !row) {
    const ip = await serverPublicIp(ctx, s.id);
    const now = await dnsDeps.answers(host, 'A');
    if (isAgent(ctx) && now.length && !now.includes(ip)) throw forbidden(`${host} points at ${now.join(', ')} right now. A person can move it here.`);
    const records: Rec[] = [{ type: 'A', name: host, content: ip }];
    ctx.progress(`Finding where ${host}'s DNS lives…`);
    const w = await writeRecords(ctx, host, records, { keep: true });
    saveDomain(ctx, host, w, { kind: 'redirect', serverId: s.id }, records, null);
    if (w.written) undo.dns = { provider: w.provider!, accountId: w.accountId!, zone: w.zone!, added: records, before: w.before ?? [] };
    dns = w.written ? { dns: `${w.provider}: A ${host} → ${ip}` } : needsYou(w, records);
  }
  const fresh = rowOf(ctx, host);
  if (fresh) saveList(ctx, fresh, list);
  ctx.progress(i.remove ? `Taking the redirect off ${whole}…` : `Sending ${whole} to ${to}…`);
  try { await apply(ctx, s, host, list, fresh); } catch (e) {
    if (row) run(ctx.db, 'UPDATE domains SET target = ? WHERE id = ?', row.target, row.id); else run(ctx.db, 'DELETE FROM domains WHERE hostname = ? AND org_id = ?', host, ctx.orgId);
    if (undo.dns) await putBack(ctx, undo.dns).catch(() => undefined);
    throw e;
  }
  const summary = i.remove ? `${whole} stopped sending visitors elsewhere` : `${whole} now sends visitors to ${to}`;
  const changeId = keepChange(ctx, `dns:${host}`, 'domain.redirect', summary, undo);
  const check = to ? await answersWith(host, path, to, i.keepPath) : undefined;
  return { from: whole, ...(to && { to }), permanent: i.permanent, how: proxyFor(s).kind === 'coolify' ? 'traefik' : 'caddy', ...dns, ...(check && { check, state: check.ok ? 'ok' : 'waiting' }),
    note: !check ? 'Nothing sends visitors elsewhere from there now.' : check.ok ? `${whole} sends visitors to ${to}.` : check.answered ? `Set, but it answered ${check.status}${check.location ? ` (to ${check.location})` : ''} instead. Its DNS may still point somewhere else, or the certificate may not be ready; Unit7 keeps checking.` : `Set. ${whole} starts sending visitors there once its DNS reaches this server.`,
    changeId, undo: `change.undo with changeId ${changeId} puts it back.` };
}

CHANGE_UNDO['domain.redirect'] = async (ctx, ch) => {
  const u = json<RedirectUndo>(ch.undo, {} as RedirectUndo);
  if (u.vercel) {
    await vercel.redirectDomain(ctx, u.vercel.accountId, u.vercel.project, u.vercel.team, u.host, u.vercel.to, u.vercel.to ? u.vercel.code ?? 301 : undefined);
    return { restored: u.host };
  }
  const s = serverRow(ctx, u.serverId!), row = rowOf(ctx, u.host);
  if (u.hadRow && row) run(ctx.db, 'UPDATE domains SET target = ? WHERE id = ?', u.target ?? null, row.id);
  await apply(ctx, s, u.host, u.before, u.hadRow ? rowOf(ctx, u.host) : undefined);
  if (!u.hadRow) run(ctx.db, 'DELETE FROM domains WHERE hostname = ? AND org_id = ?', u.host, ctx.orgId);
  if (u.dns) await putBack(ctx, u.dns);
  return { restored: u.host };
};
