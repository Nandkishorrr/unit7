// Six services that could only be connected until now: Stripe, Resend, Sentry, PlanetScale, Turso and Upstash. Each says what an
// account holds, for the map. A pasted key goes to the provider's REST API. A one-click sign-in goes to the read tools of its hosted
// server, because its token is only good there, so making, connecting or removing a database takes a key.
import type { Ctx } from '../tools/runtime.ts';
import { Unit7Error } from '../errors.ts';
import { assertReachable } from '../netguard.ts';
import { bearerFor, isOAuthAccount, oauthMcp } from './mcp-oauth.ts';
import { mcpJson } from './clouds.ts';

// overridable for offline tests
const STRIPE = () => process.env.UNIT7_STRIPE_API ?? 'https://api.stripe.com/v1';
const RESEND = () => process.env.UNIT7_RESEND_API ?? 'https://api.resend.com';
const SENTRY = () => process.env.UNIT7_SENTRY_API ?? 'https://sentry.io/api/0';
const PLANETSCALE = () => process.env.UNIT7_PLANETSCALE_API ?? 'https://api.planetscale.com/v1';
const TURSO = () => process.env.UNIT7_TURSO_API ?? 'https://api.turso.tech/v1';
const UPSTASH = () => process.env.UNIT7_UPSTASH_API ?? 'https://api.upstash.com/v2';

const pasted = (ctx: Ctx, provider: string, acc: string) => !isOAuthAccount(ctx.credentialFor(provider, acc).account.meta);

async function api<T>(who: string, base: string, path: string, headers: Record<string, string>, o: { method?: string; body?: unknown } = {}): Promise<T> {
  if (Object.values(headers).some((v) => /[^\x20-\x7e]/.test(v))) throw new Unit7Error('bad_key', `The ${who} key has a stray character in it. Paste it again in Connections.`, 400); // fetch throws on one
  await assertReachable(new URL(base).hostname);
  const res = await fetch(`${base}${path}`, { method: o.method ?? (o.body === undefined ? 'GET' : 'POST'), headers: { accept: 'application/json', ...(o.body !== undefined && { 'content-type': 'application/json' }), ...headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(30_000) })
    .catch((e: Error) => { throw new Unit7Error('service_unreachable', `Unit7 couldn’t reach ${who} (${e.name === 'TimeoutError' ? 'it took too long' : 'no answer'}). Check the internet connection and try again.`, 502); });
  // some answer in plain words: those are kept, a web page isn't
  const text = await res.text().catch(() => '');
  let data: any = {};
  try { data = JSON.parse(text); } catch { if (text && text.length < 300 && !text.includes('<')) data = text.trim(); }
  const why: string = (typeof data === 'string' && data) || (typeof data?.error === 'object' ? data.error?.message : data?.error) || data?.detail || data?.message || res.statusText;
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
// One shape for all three, for the map and the tools. status is in the map's words: active when the service says it's fine, and left
// out when it didn't say. Each answer is copied field by field, so a password or token in one never travels further than here.
// Checked against each reference, 2026-11-07: planetscale.com/docs/api/reference, docs.turso.tech/api-reference,
// upstash.com/docs/devops/developer-api. Only fakes have answered so far.
export type DataService = 'planetscale' | 'turso' | 'upstash';
export interface HostedDb { id: string; name: string; engine: string; org?: string; region?: string; host?: string; plan?: string; group?: string; tables?: number; url?: string; status?: string; healthy?: boolean }
export interface Spot { org?: string; database: string } // which one: a name in an organisation, or Upstash's id
const SERVICE: Record<DataService, { who: string; base: () => string; auth: (key: string) => string }> = {
  planetscale: { who: 'PlanetScale', base: PLANETSCALE, auth: (k) => (k.includes(':') ? k : `Bearer ${k}`) }, // an older token only works as ID:TOKEN, with no scheme
  turso: { who: 'Turso', base: TURSO, auth: (k) => `Bearer ${k}` },
  upstash: { who: 'Upstash', base: UPSTASH, auth: (k) => `Basic ${Buffer.from(k).toString('base64')}` },
};
async function rest<T = any>(ctx: Ctx, p: DataService, acc: string, path: string, o: { method?: string; body?: unknown } = {}): Promise<T> {
  const { who, base, auth } = SERVICE[p];
  if (!pasted(ctx, p, acc)) throw new Unit7Error('needs_key', `Unit7’s one-click sign-in to ${who} can only read. This needs a key: Connections → ${who} → Use a key instead.`, 409);
  return api<T>(who, base(), path, { authorization: auth(await bearerFor(ctx, p, acc)) }, o).catch((e: Unit7Error) => {
    // a key that may read but not change is still a good key: these words keep the account in use
    if ((o.method || o.body !== undefined) && e.status === 403) throw new Unit7Error('not_allowed', `${who} says this key may not do that. Connections → ${who} says what a key needs.`, 403);
    throw e;
  });
}
const noLogin = (who: string, why = '') => new Unit7Error('no_login', `${who} didn’t hand over a login${why}.`, 502);

// PlanetScale: a database's branches hold its data, and its main one (default_branch) is what an app uses
interface PsRow { name: string; state?: string; ready?: boolean; kind?: string; html_url?: string; plan?: string; default_branch?: string; default_branch_table_count?: number; region?: { slug?: string } | string }
const isPostgres = (kind?: string) => /postgres|neki/.test(kind ?? ''); // Neki is its sharded Postgres
function psDb(d: PsRow, org: string): HostedDb {
  const fine = d.ready === true || d.state === 'ready', said = d.ready !== undefined || d.state !== undefined;
  return { id: `${org}/${d.name}`, name: d.name, org, engine: isPostgres(d.kind) ? 'postgres' : 'mysql', url: d.html_url ?? `https://app.planetscale.com/${org}/${d.name}`, region: typeof d.region === 'object' ? d.region?.slug : d.region, plan: d.plan, tables: d.default_branch_table_count,
    status: fine ? 'active' : /sleep/.test(d.state ?? '') ? 'paused (sleeping)' : d.state, healthy: said ? fine : undefined };
}
async function psPages<T>(ctx: Ctx, acc: string, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page: number | null | undefined = 1, n = 0; page && n < 20; n++) { // ponytail: 20 pages of 100; anything past that isn't listed
    const r: { data?: T[]; next_page?: number | null } = await rest(ctx, 'planetscale', acc, `${path}?per_page=100&page=${page}`);
    out.push(...(r.data ?? []));
    page = r.next_page;
  }
  return out;
}
const dbPath = (s: Spot) => `/organizations/${enc(s.org!)}/databases/${enc(s.database)}`;
export const planetscale = {
  organizations: (ctx: Ctx, acc: string) => psPages<{ name: string }>(ctx, acc, '/organizations'),
  async databases(ctx: Ctx, acc: string): Promise<HostedDb[]> {
    const out: HostedDb[] = [];
    if (pasted(ctx, 'planetscale', acc)) {
      for (const o of await psPages<{ name: string }>(ctx, acc, '/organizations')) out.push(...(await psPages<PsRow>(ctx, acc, `/organizations/${enc(o.name)}/databases`)).map((d) => psDb(d, o.name)));
      return out;
    }
    for (const o of rowsOf<{ name?: string; slug?: string }>(await read(ctx, acc, /(?:^|_)list_organizations$/), 'data', 'organizations')) {
      const org = o.name ?? o.slug;
      if (org) out.push(...rowsOf<PsRow>(await read(ctx, acc, /(?:^|_)list_databases$/, { organization: org, per_page: 100 }), 'data', 'databases').map((d) => psDb(d, org)));
    }
    return out;
  },
  // what its primary stores now, from PlanetScale's own storage metric (a sharded database has one series per shard)
  async size(ctx: Ctx, acc: string, s: Spot): Promise<number | undefined> {
    const { default_branch: branch } = await rest<PsRow>(ctx, 'planetscale', acc, dbPath(s));
    const { series = [] } = await rest<{ series?: { points?: [number, number | null][] }[] }>(ctx, 'planetscale', acc, `${dbPath(s)}/branches/${enc(branch ?? 'main')}/metrics?metrics=planetscale_primary_storage_usage_bytes&period=15m`);
    const last = series.flatMap((x) => { const v = x.points?.findLast((p) => typeof p[1] === 'number')?.[1]; return typeof v === 'number' ? [v] : []; });
    return last.length ? last.reduce((a, b) => a + b) : undefined;
  },
  // what a new one can be, with PlanetScale's own rates
  sizes: (ctx: Ctx, acc: string, org: string, engine: string) => rest<{ name: string; display_name?: string; cpu?: string; ram?: number; storage?: number | null; rate?: number | null; replica_rate?: number | null; enabled?: boolean; metal?: boolean }[]>(ctx, 'planetscale', acc, `/organizations/${enc(org)}/cluster-size-skus?engine=${enc(engine)}&rates=true`)
    .then((r) => r.filter((x) => x.enabled && !x.metal).map((x) => ({ name: x.name, displayName: x.display_name, cpu: x.cpu, ram: x.ram, storage: x.storage, rate: x.rate, replicaRate: x.replica_rate }))),
  create: (ctx: Ctx, acc: string, org: string, body: { name: string; cluster_size: string; kind: string; region?: string }) => rest<PsRow>(ctx, 'planetscale', acc, `/organizations/${enc(org)}/databases`, { body }).then((d) => psDb(d, org)),
  // a new login for one app: a role on Postgres, a password on MySQL. PlanetScale shows it once, so the caller keeps it.
  async login(ctx: Ctx, acc: string, s: Spot, name: string) {
    const d = await rest<PsRow>(ctx, 'planetscale', acc, dbPath(s)), branch = `${dbPath(s)}/branches/${enc(d.default_branch ?? 'main')}`, pg = isPostgres(d.kind);
    const r = await rest<{ username?: string; password?: string; plain_text?: string; access_host_url?: string; database_name?: string }>(ctx, 'planetscale', acc, `${branch}/${pg ? 'roles' : 'passwords'}`, { body: pg ? { name, inherited_roles: ['postgres'] } : { name, role: 'readwriter' } });
    const password = r.password ?? r.plain_text;
    if (!r.username || !password || !r.access_host_url) throw noLogin('PlanetScale');
    ctx.redactor.add(password, 'a PlanetScale password');
    const url = pg ? `postgresql://${enc(r.username)}:${enc(password)}@${r.access_host_url}:5432/${enc(r.database_name ?? s.database)}?sslmode=verify-full`
      : `mysql://${enc(r.username)}:${enc(password)}@${r.access_host_url}/${enc(s.database)}?ssl={"rejectUnauthorized":true}`;
    ctx.redactor.add(url, 'a PlanetScale connection string');
    return url;
  },
  remove: (ctx: Ctx, acc: string, s: Spot) => rest(ctx, 'planetscale', acc, dbPath(s), { method: 'DELETE' }),
};

// Turso: a database lives in a group, and the group says where it is. Its hostname is public, its token isn't.
interface TursoRow { Name?: string; name?: string; DbId?: string; id?: string; Hostname?: string; hostname?: string; block_reads?: boolean; block_writes?: boolean; primaryRegion?: string; group?: string }
export interface TursoOrg { slug: string; plan_id?: string; overages?: boolean }
const tursoDb = (d: TursoRow, org?: string): HostedDb[] => {
  const name = d.Name ?? d.name, said = d.block_reads !== undefined || d.block_writes !== undefined;
  return name ? [{ id: d.DbId ?? d.id ?? name, name, engine: 'sqlite', org, region: d.primaryRegion, group: d.group, host: (d.Hostname ?? d.hostname)?.toLowerCase(), ...(org && { url: `https://app.turso.tech/${org}/databases/${name}` }),
    status: d.block_reads ? 'paused' : d.block_writes ? 'paused: writes are blocked' : said ? 'active' : undefined, healthy: said ? !d.block_reads && !d.block_writes : undefined }] : [];
};
export const turso = {
  organizations: (ctx: Ctx, acc: string): Promise<TursoOrg[]> => rest(ctx, 'turso', acc, '/organizations').then((r) => rowsOf<TursoOrg>(r, 'organizations')),
  async databases(ctx: Ctx, acc: string): Promise<HostedDb[]> {
    if (!pasted(ctx, 'turso', acc)) return rowsOf<TursoRow>(await read(ctx, acc, /(?:^|[_-])list[_-]databases$/), 'databases', 'data').flatMap((d) => tursoDb(d));
    const out: HostedDb[] = [];
    for (const o of rowsOf<TursoOrg>(await rest(ctx, 'turso', acc, '/organizations'), 'organizations')) out.push(...rowsOf<TursoRow>(await rest(ctx, 'turso', acc, `/organizations/${enc(o.slug)}/databases`), 'databases').flatMap((d) => tursoDb(d, o.slug)));
    return out;
  },
  // free only by the plan's own price: a plan Unit7 can't price isn't free, and overages can bill on any plan
  async isFree(ctx: Ctx, acc: string, org: TursoOrg) {
    const { plans = [] } = await rest<{ plans?: { name: string; price?: string }[] }>(ctx, 'turso', acc, `/organizations/${enc(org.slug)}/plans`);
    return !org.overages && Number(plans.find((p) => p.name === org.plan_id)?.price ?? NaN) === 0;
  },
  groups: (ctx: Ctx, acc: string, org: string) => rest<{ groups?: { name: string; primary?: string }[] }>(ctx, 'turso', acc, `/organizations/${enc(org)}/groups`).then((r) => r.groups ?? []),
  addGroup: (ctx: Ctx, acc: string, org: string, name: string, location: string) => rest<{ group?: { name: string; primary?: string } }>(ctx, 'turso', acc, `/organizations/${enc(org)}/groups`, { body: { name, location } }).then((r) => r.group ?? { name, primary: location }),
  create: (ctx: Ctx, acc: string, org: string, name: string, group: string) => rest<{ database?: TursoRow }>(ctx, 'turso', acc, `/organizations/${enc(org)}/databases`, { body: { name, group } }).then((r) => tursoDb({ Name: name, ...r.database }, org)[0]!),
  host: (ctx: Ctx, acc: string, s: Spot) => rest<{ database?: TursoRow }>(ctx, 'turso', acc, dbPath(s)).then((r) => {
    const host = r.database?.Hostname ?? r.database?.hostname;
    if (!host) throw new Unit7Error('provider_error', 'Turso didn’t say where this database lives.', 502);
    return host.toLowerCase();
  }),
  size: (ctx: Ctx, acc: string, s: Spot): Promise<number | undefined> => rest<{ database?: { total?: { storage_bytes?: number } } }>(ctx, 'turso', acc, `${dbPath(s)}/usage`).then((r) => r.database?.total?.storage_bytes),
  // a token that can read and write this one database. Turso makes a new one each time and can't list them, so the caller keeps it.
  async token(ctx: Ctx, acc: string, s: Spot) {
    const { jwt } = await rest<{ jwt?: string }>(ctx, 'turso', acc, `${dbPath(s)}/auth/tokens?expiration=never&authorization=full-access`, { method: 'POST' });
    if (!jwt) throw noLogin('Turso');
    ctx.redactor.add(jwt, 'a Turso database token');
    return jwt;
  },
  remove: (ctx: Ctx, acc: string, s: Spot) => rest(ctx, 'turso', acc, dbPath(s), { method: 'DELETE' }),
};

// Upstash Redis: a create or a listing can carry the password and tokens, and upstashDb leaves them behind
interface UpstashRow { database_id?: string; database_name?: string; id?: string; name?: string; endpoint?: string; state?: string; primary_region?: string; region?: string; type?: string; database_type?: string; port?: number; tls?: boolean; password?: string; rest_token?: string }
const upstashHost = (d: UpstashRow) => d.endpoint && (d.endpoint.includes('.') ? d.endpoint : `${d.endpoint}.upstash.io`).toLowerCase();
const upstashDb = (d: UpstashRow): HostedDb[] => {
  const id = d.database_id ?? d.id, name = d.database_name ?? d.name;
  return id && name ? [{ id, name, engine: 'redis', region: d.primary_region ?? d.region, plan: d.type ?? d.database_type, host: upstashHost(d), url: `https://console.upstash.com/redis/${id}`,
    status: d.state === 'passive' ? 'inactive' : d.state, healthy: d.state === undefined ? undefined : d.state === 'active' }] : [];
};
export const upstash = {
  // credentials=hide: a listing that holds passwords isn't needed
  databases: async (ctx: Ctx, acc: string): Promise<HostedDb[]> => rowsOf<UpstashRow>(pasted(ctx, 'upstash', acc) ? await rest(ctx, 'upstash', acc, '/redis/databases?credentials=hide') : await read(ctx, acc, /(?:^|_)list_databases$/), 'databases', 'data').flatMap(upstashDb),
  name: (ctx: Ctx, acc: string, id: string) => rest<UpstashRow>(ctx, 'upstash', acc, `/redis/database/${enc(id)}?credentials=hide`).then((d) => d.database_name ?? d.name ?? id),
  size: (ctx: Ctx, acc: string, s: Spot): Promise<number | undefined> => rest<{ current_storage?: number }>(ctx, 'upstash', acc, `/redis/stats/${enc(s.database)}`).then((r) => r.current_storage),
  create: (ctx: Ctx, acc: string, body: { database_name: string; platform: string; primary_region: string; plan: string; tls: boolean }) => rest<UpstashRow>(ctx, 'upstash', acc, '/redis/database', { body }).then((d) => upstashDb({ database_name: body.database_name, ...d })[0]),
  // the one read that holds its keys. They reach the caller only.
  async login(ctx: Ctx, acc: string, id: string) {
    const d = await rest<UpstashRow>(ctx, 'upstash', acc, `/redis/database/${enc(id)}`), host = upstashHost(d);
    if (!host || !d.password || !d.rest_token) throw noLogin('Upstash', ': the key may be read-only, or credential protection is on. Use a read and write key in Connections → Upstash, or turn protection off in Upstash');
    const redisUrl = `${d.tls === false ? 'redis' : 'rediss'}://default:${enc(d.password)}@${host}:${d.port ?? 6379}`;
    for (const v of [d.password, d.rest_token, redisUrl]) ctx.redactor.add(v, 'an Upstash login');
    return { restUrl: `https://${host}`, restToken: d.rest_token, redisUrl };
  },
  remove: (ctx: Ctx, acc: string, s: Spot) => rest(ctx, 'upstash', acc, `/redis/database/${enc(s.database)}`, { method: 'DELETE' }),
};

// how a connection and a delete name one. A Turso sign-in's rows have no organisation, so those can only be looked at.
export const hostedEnd = (p: DataService, acc: string, d: HostedDb): (Spot & { kind: DataService; accountId: string }) | undefined =>
  (p === 'upstash' ? { kind: p, accountId: acc, database: d.id } : d.org ? { kind: p, accountId: acc, org: d.org, database: d.name } : undefined);
export const dataServices: Record<DataService, { databases(ctx: Ctx, acc: string): Promise<HostedDb[]>; size(ctx: Ctx, acc: string, s: Spot): Promise<number | undefined>; remove(ctx: Ctx, acc: string, s: Spot): Promise<unknown> }> = { planetscale, turso, upstash };
