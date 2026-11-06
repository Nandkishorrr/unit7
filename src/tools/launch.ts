// A domain from idea to live. domain.ideas asks the connected Hostinger account which names are free and what they
// cost (a read). domain.buy is money: only a person, with the domain and the price typed back, through the gate
// (provider_purchase, hard to undo). domain.launch does everything after, for a new domain or one you already own:
// wait until it's ready, DNS (kept, or moved to Cloudflare), point it at the app, HTTPS, email protection, www, and a
// check that it's live. Each step is its own gated tool call, shown live; it stops at the first one that fails.
import { z } from 'zod';
import { defineTool, execute, getTool, type Ctx, type ToolResult } from './runtime.ts';
import { all, get, json, run } from '../db.ts';
import { forbidden, Unit7Error } from '../errors.ts';
import { hostingerExec, hostingerAccount } from './hostinger.ts';
import { fid, isAgent } from './helpers.ts';
import { serverRow } from './servers.ts';
import { proxyFor, type Site } from '../deploy/caddy.ts';
import { replicaNames, routeService, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';
import { vercel } from '../connectors/clouds.ts';
import { netlify } from '../connectors/hosts.ts';
import { canonicalOnCoolify } from './redirects.ts';

const TLDS = ['com', 'io', 'co', 'app', 'dev', 'net', 'org', 'xyz'];
export const LAUNCH = { pollMs: 15_000, waitMs: 3 * 60_000 }; // how long it waits for the domain and HTTPS (tests shorten it)
export const checkoutUrl = (domain: string) => `https://www.hostinger.com/domain-name-search?domain=${encodeURIComponent(domain)}`;

// "My Shop", "myshop.io", "https://www.myshop.com/x" → the name and the ending asked for
export function splitName(raw: string): { label: string; tld?: string } {
  const host = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#\s]/)[0] ?? '';
  const dot = host.indexOf('.');
  const label = (dot > 0 ? host.slice(0, dot) : raw.trim().toLowerCase()).normalize('NFKD').replace(/[^a-z0-9-]+/g, '').replace(/^-+|-+$/g, '').slice(0, 63);
  const tld = dot > 0 ? host.slice(dot + 1).replace(/[^a-z0-9.-]/g, '') : undefined;
  if (!label) throw new Unit7Error('invalid_input', 'Type a name with letters or numbers, like “my shop” or myshop.com.');
  return { label, ...(tld && /^[a-z0-9-]{2,24}(\.[a-z]{2,10})?$/.test(tld) && { tld }) };
}
const domainOf = (raw: string) => { const { label, tld } = splitName(raw); if (!tld) throw new Unit7Error('invalid_input', `Say the whole domain, like ${label}.com.`); return `${label}.${tld}`; };

const unwrap = (r: any): any => (r && typeof r === 'object' && !Array.isArray(r) && 'data' in r ? r.data : r);
const list = (r: any): any[] => { const v = unwrap(r); return Array.isArray(v) ? v : []; };

function hostingerFor(ctx: Ctx, accountId?: string) {
  if (!accountId && !get(ctx.db, `SELECT 1 FROM accounts WHERE org_id = ? AND provider = 'hostinger'`, ctx.orgId)) {
    throw new Unit7Error('no_account', 'Connect your Hostinger account first (Connections → Hostinger), so Unit7 can check names and prices there.', 409);
  }
  return hostingerAccount(ctx, accountId);
}

// --- prices ------------------------------------------------------------------------------------------------------
export interface Price { itemId: string; amount: number; renews?: number; currency: string } // cents
const priceCache = new Map<string, { at: number; prices: Map<string, Price> }>();
async function prices(ctx: Ctx, acc: string): Promise<Map<string, Price>> {
  const hit = priceCache.get(acc);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.prices;
  const out = new Map<string, Price>();
  // catalog items like { id, name: ".COM Domain", prices: [{ id, currency, price, first_period_price, period, period_unit }] }, prices in cents
  for (const item of list(await hostingerExec(ctx, acc, 'billing_catalog_list', { category: 'DOMAIN' }))) {
    const tld = (/\.([a-z0-9-]+(?:\.[a-z]{2,})?)\b/i.exec(String(item?.name ?? ''))?.[1] ?? /domain-([a-z0-9-]+)$/i.exec(String(item?.id ?? ''))?.[1])?.toLowerCase();
    const ps: any[] = Array.isArray(item?.prices) ? item.prices : [];
    const p = ps.find((x) => Number(x.period) === 1 && /year/i.test(String(x.period_unit ?? ''))) ?? ps[0];
    if (!tld || !p?.id || out.has(tld)) continue;
    const amount = Number(p.first_period_price ?? p.price);
    if (!Number.isFinite(amount)) continue;
    out.set(tld, { itemId: String(p.id), amount, ...(Number.isFinite(Number(p.price)) && Number(p.price) !== amount && { renews: Number(p.price) }), currency: String(p.currency ?? 'USD').toUpperCase() });
  }
  priceCache.set(acc, { at: Date.now(), prices: out });
  return out;
}
export const money = (cents: number, currency: string) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${currency}`; } };
// "9.99", "$9.99", "9,99 €" → cents
export const typedCents = (s: string) => { const v = s.replace(/[^\d.,]/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, ''); return v && Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : NaN; };

// is there a card on file? (only the answer leaves here, never card details); undefined when Hostinger won't say
async function canPay(ctx: Ctx, acc: string): Promise<boolean | undefined> {
  try { return list(await hostingerExec(ctx, acc, 'billing_payment-methods_list')).some((m) => !m?.is_expired && !m?.is_suspended); } catch { return undefined; }
}
async function availability(ctx: Ctx, acc: string, label: string, tlds: string[]) {
  return list(await hostingerExec(ctx, acc, 'domains_availability_check', { domain: label, tlds }))
    .map((r) => ({ domain: String(r?.domain ?? '').toLowerCase(), available: r?.is_available === true, alternative: r?.is_alternative === true }))
    .filter((r) => r.domain.includes('.'));
}

defineTool({
  name: 'domain.ideas', title: 'Find a domain', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'Check a name at the connected Hostinger account: up to 6 free domains across endings (.com, .io, .co, .app…) with their first-year price and renewal, whether the exact one is taken, and whether the account can pay (a card on file). Only a person can buy one (in Unit7’s domain window); an AI may suggest and prepare, never buy.',
  input: z.object({ name: z.string().trim().min(1).max(100), accountId: fid('acc').optional() }),
  async run(ctx, i) {
    const acc = hostingerFor(ctx, i.accountId);
    const { label, tld } = splitName(i.name);
    const tlds = tld ? [tld, ...TLDS.filter((t) => t !== tld)] : TLDS;
    const [found, price, pay] = await Promise.all([availability(ctx, acc, label, tlds), prices(ctx, acc), canPay(ctx, acc)]);
    const exact = found.find((f) => f.domain === `${label}.${tlds[0]}`);
    let free = found.filter((f) => f.available);
    // not enough free endings: Hostinger's own close alternatives (it only suggests free names)
    if (free.length < 6) {
      const alt = await hostingerExec(ctx, acc, 'domains_availability_suggest-names-from', { domain: `${label}.${tlds[0]}`, limit: 6 }).catch(() => []);
      for (const a of list(alt)) {
        const d = String(typeof a === 'string' ? a : a?.domain ?? '').toLowerCase();
        if (d.includes('.') && !free.some((f) => f.domain === d) && !found.some((f) => f.domain === d && !f.available)) free.push({ domain: d, available: true, alternative: true });
      }
    }
    const ending = (d: string) => d.slice(d.indexOf('.') + 1);
    const rank = (d: string) => { const ix = d.startsWith(`${label}.`) ? tlds.indexOf(ending(d)) : -1; return ix >= 0 ? ix : 50; }; // the endings asked for, in order, then Hostinger's ideas
    free = free.sort((a, b) => rank(a.domain) - rank(b.domain)).slice(0, 6);
    const suggestions = free.map((f) => {
      const p = price.get(ending(f.domain));
      return { domain: f.domain, available: true, alternative: f.alternative || !f.domain.startsWith(`${label}.`),
        price: p ? { amount: p.amount, currency: p.currency, text: money(p.amount, p.currency), ...(p.renews && { renews: money(p.renews, p.currency) }) } : null };
    });
    return {
      name: label, exact: exact ? { domain: exact.domain, available: exact.available } : undefined, suggestions,
      canBuy: pay !== false, ...(pay === false && { why: 'Your Hostinger account has no card on file, so Unit7 can’t pay. Buy it on Hostinger instead, then let Unit7 set it up.' }),
      checkout: checkoutUrl(suggestions[0]?.domain ?? `${label}.${tlds[0]}`),
    };
  },
});

defineTool({
  // money: a person only, never an AI (even with approval), and the gate's restricted-purchase rule still applies
  name: 'domain.buy', title: 'Buy a domain', risk: 'destructive', action: 'provider_purchase', peopleOnly: true, timeoutMs: 2 * 60_000,
  description: 'People only: buy one domain at the connected Hostinger account with its card on file. confirmName must be the domain and confirmPrice its first-year price as shown, both typed by the person. Unit7 checks again that it is free and the price hasn’t changed. Then domain.launch sets it up.',
  input: z.object({ domain: z.string().trim().min(3).max(253), confirmName: z.string().max(253), confirmPrice: z.string().max(24), accountId: fid('acc').optional() }),
  // the typed name is checked before anything waits for an approval; the price (asked live) when it runs
  assess(_ctx, i) {
    const domain = domainOf(i.domain);
    if (i.confirmName.trim().toLowerCase() !== domain) throw new Unit7Error('confirm_name', `Type the domain (${domain}) to buy it.`, 400);
    if (Number.isNaN(typedCents(i.confirmPrice))) throw new Unit7Error('confirm_price', 'Type the price as shown, like 11.99.', 400);
    return { tier: 3, impact: `Buys ${domain} at Hostinger for ${i.confirmPrice.trim()} (first year), paid with the card on file there.` };
  },
  async run(ctx, i) {
    const domain = domainOf(i.domain);
    if (i.confirmName.trim().toLowerCase() !== domain) throw new Unit7Error('confirm_name', `Type the domain (${domain}) to buy it.`, 400);
    const acc = hostingerFor(ctx, i.accountId);
    const tld = domain.slice(domain.indexOf('.') + 1);
    const [found, price] = await Promise.all([availability(ctx, acc, domain.slice(0, domain.indexOf('.')), [tld]), prices(ctx, acc)]);
    if (!found.find((f) => f.domain === domain)?.available) throw new Unit7Error('taken', `${domain} isn’t free any more. Pick another one.`, 409);
    const p = price.get(tld);
    if (!p) throw new Unit7Error('cant_buy', `Unit7 can’t buy .${tld} through Hostinger’s API. Buy it on Hostinger (${checkoutUrl(domain)}), then let Unit7 set it up.`, 409);
    if (typedCents(i.confirmPrice) !== p.amount) throw new Unit7Error('confirm_price', `It costs ${money(p.amount, p.currency)} now. Type that price to buy it.`, 400);
    if ((await canPay(ctx, acc)) === false) throw new Unit7Error('no_payment', `Your Hostinger account has no card on file, so Unit7 can’t pay. Buy it on Hostinger (${checkoutUrl(domain)}), then let Unit7 set it up.`, 402);
    ctx.progress(`Buying ${domain}…`);
    const order = unwrap(await hostingerExec(ctx, acc, 'domains_portfolio_purchase', { domain, item_id: p.itemId }));
    ctx.emit('domain.bought', `${ctx.actor.name} bought ${domain} at Hostinger for ${money(p.amount, p.currency)}`, { severity: 'success', resource: domain });
    return { domain, bought: true, price: money(p.amount, p.currency), ...(order?.id && { order: String(order.id) }), next: 'Unit7 sets it up next: DNS, your app, HTTPS and email protection.' };
  },
});

// --- launch ------------------------------------------------------------------------------------------------------
export type StepKey = 'ready' | 'dns' | 'point' | 'https' | 'email' | 'www' | 'live';
export interface LaunchStep { key: StepKey; label: string; state: 'todo' | 'running' | 'ok' | 'waiting' | 'failed' | 'skipped'; note?: string }
type Call = (tool: string, input: Record<string, unknown>) => Promise<ToolResult>;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r, j) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); j(signal.reason); }, { once: true }); });

// a step's tool result in words: it worked, it waits on a person (stop), or it failed (stop)
function said(r: ToolResult): { ok: true; output: any } | { ok: false; state: 'waiting' | 'failed'; note: string; code?: string } {
  if (r.status === 'ok' || r.status === 'dry_run') return { ok: true, output: r.status === 'ok' ? r.output : r.plan };
  if (r.status === 'approval_required') return { ok: false, state: 'waiting', note: 'Waiting for your OK on Approvals. Once it’s approved, run this again: it picks up here.' };
  if (r.status === 'denied') return { ok: false, state: 'failed', note: r.why };
  return { ok: false, state: 'failed', note: r.error.message, code: r.error.code };
}
// DNS that Unit7 couldn't write (the host has no API): the records to add, said once
const needsYou = (o: any) => o?.dns === 'needs you' ? `Add ${(o.addThese ?? []).map((r: any) => `${r.type} ${r.name} → ${r.value}`).join(', ')} at ${o.at}. Unit7 finishes by itself once it’s there.` : undefined;

// Is this name already doing what domain.point would do? A run after a person's OK lands here, and asking again would
// only file the same approval. Unit7's record says which app it went to and that the records went in (public DNS can lag
// behind them by minutes); Vercel says what they should be today, and its word that they're right is enough. Any doubt
// is a no, and domain.point asks as usual. The HTTPS step right after checks real DNS either way.
async function pointedAlready(ctx: Ctx, hostname: string, t: Record<string, any>) {
  const d = get<{ status: string; target: string | null; records: string | null }>(ctx.db, 'SELECT status, target, records FROM domains WHERE hostname = ? AND org_id = ?', hostname, ctx.orgId);
  if (!d) return false;
  const { kind, redirectTo: _, ...saved } = json<Record<string, any>>(d.target, {});
  if (JSON.stringify(saved) !== JSON.stringify(kind === 'unit7' ? { serviceId: t.serviceId } : t[kind])) return false;
  const wentIn = d.status === 'pending' || d.status === 'active';
  // ponytail: other hosts are taken on Unit7's record; ask them too once one of them reports what DNS should say
  if (kind !== 'vercel') return wentIn;
  const st = await vercel.domainStatus(ctx, saved.accountId, saved.project, saved.team, hostname).catch(() => undefined);
  if (!st) return false;
  const wrote = json<{ type: string; content: string }[]>(d.records, []);
  return (st.verified && !st.misconfigured) || (wentIn && st.records.every((r) => wrote.some((w) => w.type === r.type && w.content === r.content)));
}

export async function launch(ctx: Ctx, i: { domain: string; target: Record<string, unknown>; dns: 'keep' | 'cloudflare'; prefer?: 'apex' | 'www' },
  call: Call = (tool, input) => execute(ctx.app, ctx.orgId, ctx.actor, tool, input, { reason: `launch ${i.domain}`, signal: ctx.signal })) {
  const domain = domainOf(i.domain);
  const point = getTool('domain.point')!.input.safeParse({ hostname: domain, ...i.target });
  if (!point.success) throw new Unit7Error('invalid_input', 'Pick the app this domain should open.');
  const hostingerAccs = all<{ id: string }>(ctx.db, `SELECT id FROM accounts WHERE org_id = ? AND provider = 'hostinger' ORDER BY created_at`, ctx.orgId);
  const steps: LaunchStep[] = [
    { key: 'ready', label: 'Domain ready', state: 'todo' },
    { key: 'dns', label: i.dns === 'cloudflare' ? 'DNS moves to Cloudflare' : 'DNS stays where it is', state: 'todo' },
    { key: 'point', label: 'Opens your app', state: 'todo' },
    { key: 'https', label: 'HTTPS', state: 'todo' },
    { key: 'email', label: 'Email protection', state: 'todo' },
    { key: 'www', label: wwwLabel(domain, i.prefer), state: 'todo' },
    { key: 'live', label: 'Live check', state: 'todo' },
  ];
  const show = () => ctx.app.events.emit(ctx.orgId, 'domain.launch', '', { live: true, data: { domain, steps } });
  const set = (k: StepKey, state: LaunchStep['state'], note?: string) => { const s = steps.find((x) => x.key === k)!; s.state = state; s.note = note; show(); return state; };
  const end = (live: boolean, next?: string) => {
    ctx.emit(live ? 'domain.launched' : 'domain.launch_stopped', live ? `${domain} is live` : `Setting up ${domain} stopped: ${next}`, { severity: live ? 'success' : 'warning', resource: domain });
    return { domain, url: `https://${domain}`, live, steps, ...(next && { next }) };
  };
  const stop = (k: StepKey, s: { state: 'waiting' | 'failed'; note: string }) => { set(k, s.state, s.note); return end(false, s.state === 'failed' ? `${s.note} Fix that, then run it again: it picks up where it stopped.` : s.note); };
  const domainId = () => get<{ id: string }>(ctx.db, 'SELECT id FROM domains WHERE hostname = ? AND org_id = ?', domain, ctx.orgId)?.id;
  const deadline = () => Date.now() + LAUNCH.waitMs;
  const pointOnce = async (hostname: string, extra: Record<string, unknown> = {}) => (await pointedAlready(ctx, hostname, point.data))
    ? { ok: true as const, output: { note: 'It already points at this app.' } } : said(await call('domain.point', { hostname, ...i.target, ...extra }));

  // 1. ready: bought at Hostinger, wait until it's registered; registered elsewhere, nothing to wait for
  set('ready', 'running');
  let ready: string | undefined;
  for (const until = deadline(); ;) {
    let status: string | undefined;
    for (const a of hostingerAccs) {
      const r = said(await call('hostinger.do', { operation: 'domains_portfolio_list', params: {}, accountId: a.id }));
      if (!r.ok) return stop('ready', r);
      const d = list(r.output?.result).find((x) => String(x?.domain ?? '').toLowerCase() === domain);
      if (d) { status = String(d.status ?? 'active').toLowerCase(); break; }
    }
    if (status === undefined) { ready = 'Registered elsewhere: nothing to wait for.'; break; }
    if (status === 'active') { ready = 'Registered at Hostinger.'; break; }
    if (/fail|expired|suspend|cancel/.test(status)) return stop('ready', { state: 'failed', note: `Hostinger says ${domain} is ${status.replace(/_/g, ' ')}. Open Hostinger to finish it.` });
    if (Date.now() >= until) return stop('ready', { state: 'waiting', note: `Hostinger is still registering ${domain} (it can take up to an hour). Run this again then.` });
    set('ready', 'running', 'Hostinger is still registering it…');
    await sleep(LAUNCH.pollMs, ctx.signal);
  }
  set('ready', 'ok', ready);

  // 2. DNS
  if (i.dns === 'cloudflare') {
    set('dns', 'running');
    const r = said(await call('domain.move_dns', { domain }));
    if (!r.ok && r.code !== 'already') return stop('dns', r);
    set('dns', 'ok', r.ok ? r.output?.next : 'Already on Cloudflare.');
  } else set('dns', 'ok', hostingerAccs.length ? 'Kept at Hostinger.' : 'Kept where it is.');

  // 3. point the bare domain at the app
  set('point', 'running');
  // a Coolify app takes both names in one restart; www's own step below only finds it done
  const p = await pointOnce(domain, i.target.coolify ? { also: [`www.${domain}`], wait: false } : {});
  if (!p.ok) return stop('point', p);
  const waitDns = needsYou(p.output);
  set('point', waitDns ? 'waiting' : 'ok', waitDns ?? p.output?.note);

  // 4. HTTPS: the certificate follows once DNS points there; check until it does (or let Warden finish it)
  set('https', 'running');
  let https = false, httpsNote = 'DNS is still spreading. Unit7 keeps checking and tells you when HTTPS is on.';
  for (const until = deadline(); domainId();) {
    const r = said(await call('domain.check', { domainId: domainId()! }));
    if (!r.ok) return stop('https', r);
    if (r.output?.httpsWorking) { https = true; httpsNote = 'The certificate is in place.'; break; }
    if (Date.now() >= until) break;
    await sleep(LAUNCH.pollMs, ctx.signal);
  }
  set('https', https ? 'ok' : 'waiting', httpsNote);

  // 5. nobody can send email pretending to be this domain
  set('email', 'running');
  const e = said(await call('domain.protect_email', { domain }));
  if (!e.ok) return stop('email', e);
  const emailWait = needsYou(e.output);
  set('email', emailWait ? 'waiting' : 'ok', emailWait ?? (e.output?.dmarc === 'already set' ? 'Already protected.' : 'Nobody can send email pretending to be you.'));

  // 6. www answers too, then one of the two sends visitors to the other (301, the page they asked for kept): the bare
  // domain is the main address unless the person chose www (a Supabase API has no www)
  if (i.target.supabase) set('www', 'skipped', 'An API address has no www.');
  else {
    set('www', 'running');
    const w = await pointOnce(`www.${domain}`, i.target.coolify ? { wait: false } : {});
    if (!w.ok) return stop('www', w);
    const wwwWait = needsYou(w.output);
    // domain.canonical writes this down once it's set, so a run after a person's OK doesn't file it again
    const [main, other] = i.prefer === 'www' ? [`www.${domain}`, domain] : [domain, `www.${domain}`];
    const redirect = json<{ redirectTo?: string }>(get<{ target: string | null }>(ctx.db, 'SELECT target FROM domains WHERE hostname = ? AND org_id = ?', other, ctx.orgId)?.target, {}).redirectTo;
    const c = redirect === main ? { ok: true as const, output: { note: 'Already set.' } } : said(await call('domain.canonical', { domain, prefer: i.prefer ?? 'apex' }));
    if (!c.ok) return stop('www', c);
    set('www', wwwWait || c.output?.state === 'waiting' ? 'waiting' : 'ok', wwwWait ?? c.output?.note);
  }

  // 7. is it live?
  set('live', 'running');
  const id = domainId();
  if (!id) return stop('live', { state: 'waiting', note: `${domain} isn’t answering yet. Unit7 keeps checking and tells you when it’s live.` });
  const l = said(await call('domain.check', { domainId: id }));
  if (!l.ok) return stop('live', l);
  const live = l.output?.status === 'active' && !!l.output?.httpsWorking;
  set('live', live ? 'ok' : 'waiting', live ? `${domain} is live.` : `Not live yet: ${l.output?.note ?? 'DNS is still spreading.'} Unit7 keeps checking by itself.`);
  return end(live, live ? undefined : steps.find((s) => s.state === 'waiting')?.note);
}

defineTool({
  name: 'domain.launch', title: 'Set up a domain', risk: 'write', action: 'dns_write', timeoutMs: 20 * 60_000,
  description: 'After buying a domain, or for one you already own (“connect my existing domain”): waits until it’s ready, keeps its DNS where it is or moves it to Cloudflare (dns: "cloudflare"), points it at an app, gets HTTPS, protects its email, makes www send visitors to the bare domain (or the other way, prefer: "www") and checks it’s live. Each step is its own checked action, and it stops at the first that fails with what to do; run it again and it picks up there. target is what domain.point takes (serviceId, or coolify/vercel/netlify/render/railway/heroku/fly/pages/hostinger/supabase); a dry run lists the apps with theirs.',
  input: z.object({ domain: z.string().trim().min(3).max(253), target: z.record(z.string(), z.unknown()).optional(), dns: z.enum(['keep', 'cloudflare']).default('keep'),
    prefer: z.enum(['apex', 'www']).default('apex').describe('The main address: the bare domain (default) or www. The other one redirects to it.') }),
  async dryRun(ctx, i) {
    const domain = domainOf(i.domain);
    const { sourceOptions } = await import('../agent/asks.ts');
    const apps = sourceOptions(ctx.app, ctx.orgId, 'apps').filter((o) => o.use.pointWith).map((o) => ({ id: o.id, label: o.label, sub: o.sub, provider: o.provider, logo: o.logo, url: o.url, state: o.state, target: o.use.pointWith }));
    const has = (p: string) => !!get(ctx.db, 'SELECT 1 FROM accounts WHERE org_id = ? AND provider = ?', ctx.orgId, p);
    return { domain, apps, cloudflare: has('cloudflare'), hostinger: has('hostinger'), steps: ['Domain ready', i.dns === 'cloudflare' ? 'DNS moves to Cloudflare' : 'DNS stays where it is', 'Opens your app', 'HTTPS', 'Email protection', wwwLabel(domain, i.prefer), 'Live check'] };
  },
  run(ctx, i) {
    if (!i.target) throw new Unit7Error('which_app', 'Which app should it open? Give target (a dry run lists them).', 400);
    return launch(ctx, { domain: i.domain, target: i.target, dns: i.dns, prefer: i.prefer });
  },
});

// --- the main address: www and the bare domain both answer, and one sends visitors to the other with a 301 that keeps
// the page and the query. On Unit7's own servers it's the proxy (Caddy's redir, or a redirectRegex middleware on Unit7's
// own Traefik routers); on Vercel the project domain's redirect setting; on Netlify the primary domain (it redirects the
// other by itself). Render does it by itself (to whichever was added first); Railway, Heroku and Fly have no setting.
const wwwLabel = (domain: string, prefer?: 'apex' | 'www') => (prefer === 'www' ? `${domain} goes to www.${domain}` : `www goes to ${domain}`);
const HOST_NAME: Record<string, string> = { render: 'Render', railway: 'Railway', heroku: 'Heroku', fly: 'Fly.io', supabase: 'Supabase', addon: 'This tool' };
export const CANON = { fetch: (url: string, init: RequestInit) => fetch(url, init) }; // tests swap it
type DomRow = { id: string; hostname: string; service_id: string | null; target: string | null; tls_mode: string | null };

// asks the other name for a page with a query, and wants a permanent redirect to the same page on the main one
export async function redirectCheck(from: string, to: string, scheme = 'https'): Promise<{ answered: boolean; ok: boolean; status?: number; location?: string }> {
  const probe = '/unit7-check?from=redirect';
  try {
    const r = await CANON.fetch(`${scheme}://${from}${probe}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Unit7 redirect check' } });
    const location = r.headers.get('location') ?? undefined;
    return { answered: true, status: r.status, ...(location && { location }), ok: (r.status === 301 || r.status === 308) && location === `${scheme}://${to}${probe}` };
  } catch { return { answered: false, ok: false }; }
}

export async function setCanonical(ctx: Ctx, raw: string, prefer: 'apex' | 'www') {
  const apex = domainOf(raw);
  const main = prefer === 'www' ? `www.${apex}` : apex, other = prefer === 'www' ? apex : `www.${apex}`;
  const row = (h: string) => get<DomRow>(ctx.db, 'SELECT id, hostname, service_id, target, tls_mode FROM domains WHERE hostname = ? AND org_id = ?', h, ctx.orgId);
  const m = row(main), o = row(other);
  if (!m && !o) throw new Unit7Error('not_found', `Unit7 doesn’t know ${apex} yet. Point it at an app first.`, 404);
  const t = json<Record<string, string>>((m ?? o)!.target, {});
  const kind = t.kind ?? ((m ?? o)!.service_id ? 'unit7' : undefined);
  // what Unit7 remembers, so a deploy or a re-point writes the redirect again instead of the app (caddy.ts putSite)
  const mark = (r: DomRow | undefined, to?: string) => { if (r) run(ctx.db, 'UPDATE domains SET target = ? WHERE id = ?', JSON.stringify({ ...json<object>(r.target, {}), redirectTo: to }), r.id); };
  const restore = () => { for (const r of [m, o]) if (r) run(ctx.db, 'UPDATE domains SET target = ? WHERE id = ?', r.target, r.id); };
  const needBoth = () => { if (!m || !o) throw new Unit7Error('not_pointed', `Point ${m ? other : main} at the same app first, then choose the main address.`, 409); };
  let how: string, scheme = 'https';
  if (kind === 'unit7') {
    needBoth();
    // a name serving another app is moved only by a person (domain.point's rule)
    if (isAgent(ctx) && m!.service_id !== o!.service_id) throw forbidden(`${other} opens a different app. A person can make it send visitors to ${main}.`);
    const svc = get<ServiceRow & { server_id: string | null; config: string; current_deployment_id: string | null }>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', m!.service_id ?? o!.service_id ?? '', ctx.orgId);
    const container = svc?.current_deployment_id ? get<{ container: string | null }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id)?.container : undefined;
    if (!svc?.server_id || !container) throw new Unit7Error('not_deployed', `${svc?.name ?? 'That app'} isn’t running yet. Deploy it first.`, 409);
    const s = serverRow(ctx, svc.server_id), reps = replicaNames(container, json<ServiceConfig>(svc.config, {}).replicas);
    how = proxyFor(s).kind === 'coolify' ? 'traefik' : 'caddy';
    scheme = o!.tls_mode === 'off' ? 'http' : 'https';
    mark(m); mark(o, main);
    ctx.progress(`Sending ${other} to ${main}…`);
    try {
      await routeService(ctx, s, svc, container, reps, { hostname: main, tls: (m!.tls_mode ?? 'auto') as Site['tls'] });
      await routeService(ctx, s, svc, container, reps, { hostname: other, tls: (o!.tls_mode ?? 'auto') as Site['tls'] });
    } catch (e) { restore(); throw e; }
  } else if (kind === 'coolify') {
    needBoth();
    how = 'traefik';
    mark(m); mark(o, main);
    try { await canonicalOnCoolify(ctx, t.serverId!, main, other); } catch (e) { restore(); throw e; }
  } else if (kind === 'vercel') {
    needBoth();
    how = 'vercel';
    // the main one serves the project first, so the two never send visitors to each other
    await vercel.redirectDomain(ctx, t.accountId!, t.project!, t.team, main, null);
    await vercel.redirectDomain(ctx, t.accountId!, t.project!, t.team, other, main);
    mark(m); mark(o, main);
  } else if (kind === 'netlify') {
    how = 'netlify';
    await netlify.setPrimary(ctx, t.accountId!, t.site!, main, other);
    mark(m); mark(o, main);
  } else {
    // nothing Unit7 can set: Render does it by itself; the others have no setting (the app itself can redirect)
    const check = await redirectCheck(other, main);
    const host = HOST_NAME[kind ?? ''] ?? 'Its host';
    if (check.ok) { mark(m); mark(o, main); }
    return { main, redirects: other, how: kind ?? 'unknown', set: check.ok, check, state: 'ok',
      note: check.ok ? `${other} sends visitors to ${main}.` : kind === 'render'
        ? `Render sends www and the bare domain to whichever was added first. To make ${main} the main one, remove both in Render and add ${main} first.`
        : `${host} has no redirect setting, so ${other} opens the same app. Your app can send visitors to ${main} itself.` };
  }
  const check = await redirectCheck(other, main, scheme);
  ctx.emit('domain.canonical', `${other} now sends visitors to ${main}`, { severity: 'info', resource: main });
  return {
    main, redirects: other, how, set: true, check, state: check.ok ? 'ok' : 'waiting',
    note: check.ok ? `${other} sends visitors to ${main}, keeping the page they asked for.`
      : check.answered ? `Set, but ${other} answered ${check.status}${check.location ? ` (to ${check.location})` : ''} instead. Its DNS may still point at its old host; Unit7 checks again later.`
      : `Set. ${other} will send visitors to ${main} once its DNS reaches it.`,
  };
}

defineTool({
  name: 'domain.canonical', title: 'Choose the main address', risk: 'write', action: 'proxy_config', timeoutMs: 3 * 60_000, idempotent: true,
  description: 'Make www and the bare domain one address: the other one sends visitors to the main one with a permanent (301) redirect that keeps the page and the query. prefer "apex" (default: example.com is the main one) or "www". Works where Unit7 runs the app (its proxy), on a Coolify app (its Traefik) and on Vercel and Netlify (their own redirect setting); on Render, Railway, Heroku and Fly it says what to do. Both names must point at the same app first (domain.point). Checks afterwards that the redirect answers. Running it again changes nothing.',
  input: z.object({ domain: z.string().trim().min(3).max(253), prefer: z.enum(['apex', 'www']).default('apex') }),
  assess(_ctx, i) {
    const apex = domainOf(i.domain), main = i.prefer === 'www' ? `www.${apex}` : apex;
    return { tier: 2, impact: `${i.prefer === 'www' ? apex : `www.${apex}`} sends visitors to ${main} (a permanent redirect that keeps the page). Running it with the other choice undoes it.` };
  },
  run: (ctx, i) => setCanonical(ctx, i.domain, i.prefer),
});
