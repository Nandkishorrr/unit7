// Six services that could only be connected until now: Stripe, Resend, Sentry, PlanetScale, Turso and Upstash. Each says what an
// account holds, for the map. A pasted key goes to the provider's REST API. A one-click sign-in goes to the read tools of its hosted
// server, because its token is only good there. PlanetScale takes its service tokens there too, so it has just that one path.
import type { Ctx } from '../tools/runtime.ts';
import { Unit7Error } from '../errors.ts';
import { assertReachable } from '../netguard.ts';
import { bearerFor, isOAuthAccount, oauthMcp } from './mcp-oauth.ts';
import { mcpJson } from './clouds.ts';

// overridable for offline tests
const STRIPE = () => process.env.UNIT7_STRIPE_API ?? 'https://api.stripe.com/v1';
const RESEND = () => process.env.UNIT7_RESEND_API ?? 'https://api.resend.com';
const SENTRY = () => process.env.UNIT7_SENTRY_API ?? 'https://sentry.io/api/0';
const TURSO = () => process.env.UNIT7_TURSO_API ?? 'https://api.turso.tech/v1';
const UPSTASH = () => process.env.UNIT7_UPSTASH_API ?? 'https://api.upstash.com/v2';

const pasted = (ctx: Ctx, provider: string, acc: string) => !isOAuthAccount(ctx.credentialFor(provider, acc).account.meta);

async function api<T>(who: string, base: string, path: string, headers: Record<string, string>): Promise<T> {
  if (Object.values(headers).some((v) => /[^\x20-\x7e]/.test(v))) throw new Unit7Error('bad_key', `The ${who} key has a stray character in it. Paste it again in Connections.`, 400); // fetch throws on one
  await assertReachable(new URL(base).hostname);
  const res = await fetch(`${base}${path}`, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(30_000) })
    .catch((e: Error) => { throw new Unit7Error('service_unreachable', `Unit7 couldn’t reach ${who} (${e.name === 'TimeoutError' ? 'it took too long' : 'no answer'}). Check the internet connection and try again.`, 502); });
  const data = await res.json().catch(() => ({})) as { error?: { message?: string } | string; detail?: string; message?: string };
  const why = (typeof data.error === 'object' ? data.error.message : data.error) ?? data.detail ?? data.message ?? res.statusText;
  if (res.status === 401 || res.status === 403) throw new Unit7Error('service_auth', `${who} refused Unit7 (${why}). Check the key in Connections → ${who}.`, res.status);
  if (res.status === 429) throw new Unit7Error('rate_limited', `${who} asked Unit7 to slow down (429). Try again in a minute.`, 429);
  if (!res.ok) throw new Unit7Error(res.status === 404 ? 'not_found_there' : 'service_error', `${who}: ${why}`, res.status === 404 ? 404 : 502);
  return data as T;
}

// hosted tools often answer in prose: "Name: x" lines, one block per thing
export function blocks(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*#]+\s*)*\**([A-Za-z][\w /-]{0,30}?)\**\s*:\s*\**\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const k = m[1]!.toLowerCase().replace(/[ /-]+/g, '_');
    if (k in cur) { out.push(cur); cur = {}; }
    cur[k] = m[2]!.replace(/^[`*]+|[`*]+$/g, '');
  }
  if (Object.keys(cur).length) out.push(cur);
  return out;
}
// a tool's answer as rows, whatever it came as: a list, a list inside an object, or prose
const rowsOf = <T = Record<string, any>>(r: unknown, ...keys: string[]): T[] => {
  if (Array.isArray(r)) return r as T[];
  if (typeof r === 'string') return blocks(r) as T[];
  const o = (r ?? {}) as Record<string, unknown>;
  return (keys.map((k) => o[k]).find(Array.isArray) ?? []) as T[];
};
// a read tool of an account's hosted server, found by name (some prefix theirs), given only the arguments it takes
async function read<T = unknown>(ctx: Ctx, acc: string, match: RegExp, args: Record<string, unknown> = {}): Promise<T> {
  const tool = (await oauthMcp(ctx, acc).tools()).find((t) => match.test(t.name));
  if (!tool) throw new Unit7Error('unsupported', 'This account’s hosted server has no tool for that.', 501);
  const takes = tool.inputSchema?.properties;
  return mcpJson<T>(ctx, acc, tool.name, takes ? Object.fromEntries(Object.entries(args).filter(([k]) => k in takes)) : args);
}

// --- Stripe ----------------------------------------------------------------------------------------------------------------
export type StripeMode = 'test' | 'live';
// where an account can read: a pasted key is one mode of one account, a sign-in can hold several live accounts and sandboxes
export interface StripePlace { mode: StripeMode; id: string; name?: string; context?: string }
export interface StripeEndpoint { id: string; url: string; status: string; enabled_events?: string[] }
const OPERATION = { webhook_endpoints: 'GetWebhookEndpoints', products: 'GetProducts', events: 'GetEvents' };
async function stripeList<T>(ctx: Ctx, acc: string, p: StripePlace, what: keyof typeof OPERATION, params: Record<string, string | number | boolean> = {}, pages = 5): Promise<T[]> {
  if (p.context) return rowsOf<T>(await read(ctx, acc, /(?:^|_)stripe_api_read$/, { stripe_api_operation_id: OPERATION[what], parameters: { limit: 100, ...params }, livemode: p.mode === 'live', stripe_context: p.context }), 'data');
  const out: T[] = [], authorization = `Bearer ${await bearerFor(ctx, 'stripe', acc)}`;
  for (let page = 0, after: string | undefined; page < pages; page++) {
    const q = new URLSearchParams(Object.entries({ limit: 100, ...params, ...(after && { starting_after: after }) }).map(([k, v]) => [k, String(v)]));
    const r = await api<{ data: (T & { id: string })[]; has_more?: boolean }>('Stripe', STRIPE(), `/${what}?${q}`, { authorization });
    out.push(...r.data);
    after = r.data.at(-1)?.id;
    if (!r.has_more || !after) break;
  }
  return out;
}
export const stripe = {
  async places(ctx: Ctx, acc: string): Promise<StripePlace[]> {
    if (pasted(ctx, 'stripe', acc)) {
      const key = await bearerFor(ctx, 'stripe', acc);
      // a restricted key may not be allowed to read the account: its mode is in the key itself
      const who = await api<{ id?: string; settings?: { dashboard?: { display_name?: string } }; business_profile?: { name?: string } }>('Stripe', STRIPE(), '/account', { authorization: `Bearer ${key}` }).catch((e: Unit7Error) => { if (e.status === 403) return {} as { id?: string; settings?: undefined; business_profile?: undefined }; throw e; });
      return [{ mode: /_live_/.test(key) ? 'live' : 'test', id: who.id ?? acc, name: who.settings?.dashboard?.display_name ?? who.business_profile?.name }];
    }
    const seen: { stripe_context: string; livemode?: boolean; name?: string; display_name?: string }[] = [];
    JSON.stringify(await read(ctx, acc, /(?:^|_)list_available_accounts_or_orgs$/), (_k, v) => { if (typeof v?.stripe_context === 'string') seen.push(v); return v; });
    if (!seen.length) throw new Unit7Error('unsupported', 'Stripe’s sign-in didn’t list any accounts. Use a key instead: Connections → Stripe.', 501);
    return seen.map((s) => ({ mode: s.livemode ? 'live' : 'test', id: s.stripe_context, name: s.display_name ?? s.name, context: s.stripe_context }));
  },
  endpoints: (ctx: Ctx, acc: string, p: StripePlace) => stripeList<StripeEndpoint>(ctx, acc, p, 'webhook_endpoints'),
  products: (ctx: Ctx, acc: string, p: StripePlace) => stripeList<{ id: string }>(ctx, acc, p, 'products', { active: true }),
  // events of the last week that didn't reach a webhook, once Stripe has had an hour to try. Only counted: an event holds customer data.
  async undelivered(ctx: Ctx, acc: string, p: StripePlace, at = Date.now()) {
    const rows = await stripeList<{ created: number }>(ctx, acc, p, 'events', { delivery_success: false }, 1);
    return rows.filter((e) => e.created * 1000 < at - 3600_000 && e.created * 1000 > at - 7 * 86400_000).length;
  },
};

// --- Resend ----------------------------------------------------------------------------------------------------------------
export const resend = {
  domains: async (ctx: Ctx, acc: string) => rowsOf<{ id?: string; name?: string; status?: string; region?: string }>(pasted(ctx, 'resend', acc)
    ? await api('Resend', RESEND(), '/domains', { authorization: `Bearer ${await bearerFor(ctx, 'resend', acc)}` })
    : await read(ctx, acc, /(?:^|[_-])list[_-]domains$/), 'data', 'domains'),
};

// --- Sentry ----------------------------------------------------------------------------------------------------------------
export interface SentryOrg { slug: string; api?: string } // api: its own region's address, when it has one
export interface SentryIssue { title: string; type?: string; value?: string; culprit?: string; count?: number; lastSeen?: string; url?: string }
const sn = async (ctx: Ctx, acc: string, path: string, base = SENTRY()) => api<any>('Sentry', base, path, { authorization: `Bearer ${await bearerFor(ctx, 'sentry', acc)}` });
const enc = encodeURIComponent;
// Sentry's hosted server answers in markdown: "## Heading" per issue, "**Key**: value" lines under it
export function issuesFrom(text: string): SentryIssue[] {
  return text.split(/^#{2,3}\s+/m).slice(1).flatMap((b) => {
    const f = blocks(b)[0] ?? {}, bold = /^\*\*([^*\n]+)\*\*\s*$/m.exec(b)?.[1];
    const title = f.description ?? f.title ?? bold ?? b.split('\n')[0]!.replace(/^\d+\.\s*/, '').replace(/\[([^\]]+)\]\([^)]*\)/, '$1').trim();
    const count = Number(String(f.events ?? f.occurrences ?? '').replace(/\D/g, ''));
    return title ? [{ title, culprit: f.culprit, count: count || undefined, lastSeen: f.last_seen, url: f.url }] : [];
  });
}
export const sentry = {
  async orgs(ctx: Ctx, acc: string): Promise<SentryOrg[]> {
    if (pasted(ctx, 'sentry', acc)) {
      const rows = await sn(ctx, acc, '/organizations/') as { slug: string; links?: { regionUrl?: string } }[];
      // only a real Sentry region: this address came from an answer, and a token goes to it
      return rows.map((o) => ({ slug: o.slug, ...(!process.env.UNIT7_SENTRY_API && /^https:\/\/[a-z0-9-]+\.sentry\.io$/.test(o.links?.regionUrl ?? '') && { api: `${o.links!.regionUrl}/api/0` }) }));
    }
    const r = await read(ctx, acc, /(?:^|_)find_organizations$/);
    if (typeof r !== 'string') return rowsOf<{ slug: string }>(r, 'organizations', 'data').map((o) => ({ slug: o.slug }));
    return [...r.matchAll(/^##\s+\**([\w-]+)\**\s*$/gm)].map((m) => ({ slug: m[1]! }));
  },
  async projects(ctx: Ctx, acc: string, org: SentryOrg): Promise<{ slug: string; name?: string }[]> {
    if (pasted(ctx, 'sentry', acc)) return sn(ctx, acc, `/organizations/${enc(org.slug)}/projects/`, org.api);
    const r = await read(ctx, acc, /(?:^|_)find_projects$/, { organizationSlug: org.slug });
    if (typeof r !== 'string') return rowsOf<{ slug: string }>(r, 'projects', 'data');
    return [...r.matchAll(/^\s*[-*]\s+\*\*([\w.-]+)\*\*/gm)].map((m) => ({ slug: m[1]! }));
  },
  // what's unresolved and was seen in the last hour, newest first
  async issues(ctx: Ctx, acc: string, org: string, project: string, api_?: string): Promise<SentryIssue[]> {
    if (pasted(ctx, 'sentry', acc)) {
      const q = new URLSearchParams({ query: 'is:unresolved lastSeen:-1h', project, sort: 'date', limit: '25' });
      const rows = await sn(ctx, acc, `/organizations/${enc(org)}/issues/?${q}`, api_) as { title: string; culprit?: string; count?: string; lastSeen?: string; permalink?: string; metadata?: { type?: string; value?: string } }[];
      return rows.map((i) => ({ title: i.title, type: i.metadata?.type, value: i.metadata?.value, culprit: i.culprit, count: Number(i.count) || undefined, lastSeen: i.lastSeen, url: i.permalink }));
    }
    const r = await read(ctx, acc, /(?:^|_)search_issues$/, { organizationSlug: org, projectSlugOrId: project, query: 'is:unresolved lastSeen:-1h', sort: 'date', limit: 25 });
    return typeof r === 'string' ? issuesFrom(r) : rowsOf<SentryIssue>(r, 'issues', 'data');
  },
};

// --- PlanetScale, Turso, Upstash: databases --------------------------------------------------------------------------------
export interface PlanetscaleDb { org: string; id?: string; name: string; state?: string; kind?: string; html_url?: string }
export const planetscale = {
  async databases(ctx: Ctx, acc: string): Promise<PlanetscaleDb[]> {
    const out: PlanetscaleDb[] = [];
    for (const o of rowsOf<{ name?: string; slug?: string }>(await read(ctx, acc, /(?:^|_)list_organizations$/), 'data', 'organizations')) {
      const org = o.name ?? o.slug;
      if (org) out.push(...rowsOf<PlanetscaleDb>(await read(ctx, acc, /(?:^|_)list_databases$/, { organization: org, per_page: 100 }), 'data', 'databases').map((d) => ({ ...d, org })));
    }
    return out;
  },
};
export interface TursoDb { Name?: string; name?: string; DbId?: string; id?: string; Hostname?: string; hostname?: string; block_reads?: boolean; org?: string }
export const turso = {
  async databases(ctx: Ctx, acc: string): Promise<TursoDb[]> {
    if (!pasted(ctx, 'turso', acc)) return rowsOf<TursoDb>(await read(ctx, acc, /(?:^|[_-])list[_-]databases$/), 'databases', 'data');
    const authorization = `Bearer ${await bearerFor(ctx, 'turso', acc)}`, out: TursoDb[] = [];
    const orgs = rowsOf<{ slug: string }>(await api('Turso', TURSO(), '/organizations', { authorization }), 'organizations');
    for (const o of orgs) out.push(...rowsOf<TursoDb>(await api('Turso', TURSO(), `/organizations/${enc(o.slug)}/databases`, { authorization }), 'databases').map((d) => ({ ...d, org: o.slug })));
    return out;
  },
};
export interface UpstashDb { database_id?: string; database_name?: string; endpoint?: string; state?: string; id?: string; name?: string }
export const upstash = {
  // credentials=hide: a listing that holds passwords isn't needed, and only names and addresses are kept from it anyway
  databases: async (ctx: Ctx, acc: string): Promise<UpstashDb[]> => (pasted(ctx, 'upstash', acc)
    ? rowsOf<UpstashDb>(await api('Upstash', UPSTASH(), '/redis/databases?credentials=hide', { authorization: `Basic ${Buffer.from(await bearerFor(ctx, 'upstash', acc)).toString('base64')}` }))
    : rowsOf<UpstashDb>(await read(ctx, acc, /(?:^|_)list_databases$/), 'databases', 'data')),
};
