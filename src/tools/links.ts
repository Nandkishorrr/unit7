// Links: one thing wired to another, across providers — a database to an app, an API (say a CRM on
// your server) to a website (say on Vercel). Unit7 puts the right settings on each side (URLs, keys,
// a shared secret it generates), applies them (a redeploy where needed), remembers what it set, and
// keeps it in sync: Warden re-checks links daily and pushes a changed value (a rotated key, a new
// domain) to the other side by itself.
//
// Each end is a provider adapter: a SOURCE says what a consumer needs from it; a SINK can set
// settings on a consumer. Secrets live in the vault; links keep only a fingerprint of each value.
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { accountAllowed, defineTool, execute, type Ctx } from './runtime.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { makeRef } from '../vault.ts';
import { merged, envContext, isPublicKey } from './env.ts';
import { internalHost, type ServiceConfig } from '../deploy/deployer.ts';
import { neon, supabase, vercel } from '../connectors/clouds.ts';
import { netlify, render, railway, heroku, fly } from '../connectors/hosts.ts';
import { planetscale, turso, upstash } from '../connectors/services.ts';
import { scanUnit7 } from '../discovery/scanners.ts';
import type { Found } from '../discovery/model.ts';
import { fid, isAgent } from './helpers.ts';
import { verifiers } from './core.ts';
import { endArchived } from '../archive.ts';

verifiers.vercel = (ctx, a) => vercel.whoami(ctx, a.id);

export type End =
  | { kind: 'unit7'; serviceId: string }
  | { kind: 'vercel'; accountId: string; project: string; team?: string }
  | { kind: 'supabase'; accountId: string; ref: string }
  | { kind: 'neon'; accountId: string; project: string }
  | { kind: 'planetscale' | 'turso'; accountId: string; org: string; database: string }
  | { kind: 'upstash'; accountId: string; database: string }
  | { kind: 'netlify'; accountId: string; site: string }
  | { kind: 'render'; accountId: string; service: string }
  | { kind: 'railway'; accountId: string; project: string; environment: string; service: string }
  | { kind: 'heroku'; accountId: string; app: string }
  | { kind: 'fly'; accountId: string; app: string }
  | { kind: 'digitalocean'; accountId: string; app: string }; // takes a domain; no link reaches it yet
export interface Var { key: string; value: string; secret: boolean }
export interface Reads { stack?: string | null; keys: string[] }
export interface Source { label(ctx: Ctx, e: End): Promise<string>; vars(ctx: Ctx, e: End, consumer: End, linkId: string): Promise<{ consumer: Var[]; provider?: Var[]; note?: string }> }
// reads: what the consumer's code is known to read (and its framework), so a source can use those exact names
export interface Sink { label(ctx: Ctx, e: End): Promise<string>; reads(ctx: Ctx, e: End): Promise<Reads>; set(ctx: Ctx, e: End, vars: Var[]): Promise<void>; current(ctx: Ctx, e: End, keys: string[]): Promise<Record<string, string | undefined>>; apply(ctx: Ctx, e: End): Promise<string | undefined> }

export const SOURCES: Partial<Record<End['kind'], Source>> = {};
export const SINKS: Partial<Record<End['kind'], Sink>> = {};

export const prefixOf = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1') || 'SERVICE';
export const fp = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);

// --- an app on Unit7, as either end ---------------------------------------------------------------

const svc = (ctx: Ctx, serviceId: string) => {
  const s = get<{ id: string; name: string; slug: string; environment_id: string; server_id: string | null; config: string }>(ctx.db, 'SELECT id, name, slug, environment_id, server_id, config FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  if (!s) throw new Unit7Error('not_found', 'That app was not found.', 404);
  return s;
};
// the address a consumer should use: the private one when both run on the same Unit7 server
function addressFor(ctx: Ctx, s: ReturnType<typeof svc>, consumer: End): string {
  const cfg = json<ServiceConfig>(s.config, {});
  if (consumer.kind === 'unit7' && s.server_id && svc(ctx, consumer.serviceId).server_id === s.server_id) return `http://${internalHost(s)}:${cfg.port ?? 3000}`;
  const d = get<{ hostname: string; tls_mode: string }>(ctx.db, `SELECT hostname, tls_mode FROM domains WHERE service_id = ? AND status != 'broken' AND hostname NOT LIKE '*%' ORDER BY auto, created_at LIMIT 1`, s.id);
  if (!d) throw new Unit7Error('no_address', `${s.name} has no public address yet. Deploy it (or point a domain at it) first.`, 409);
  return `${d.tls_mode === 'off' ? 'http' : 'https'}://${d.hostname}`;
}

// An app used as an API by another (a CRM, a backend): the consumer gets NAME_URL + NAME_API_KEY, the
// API gets the same key as CONSUMER_API_KEY. One shared secret per link, kept in the vault, so both
// sides agree and it survives re-syncs.
async function apiVars(ctx: Ctx, linkId: string, name: string, address: string, consumer: End) {
  const consumerName = await (SINKS[consumer.kind]?.label(ctx, consumer) ?? Promise.resolve('client'));
  const ref = makeRef('link', linkId, 'key');
  let key: string;
  try { key = ctx.secret(ref); } catch { key = randomBytes(24).toString('base64url'); ctx.app.vault.put(ctx.orgId, ref, key, { kind: 'link_key', by: 'link' }); ctx.redactor.add(key, 'link key'); }
  // after a key change the API also accepts the previous key for a day (then it becomes an unguessable value, never empty)
  let previous: string | undefined;
  try { previous = ctx.secret(makeRef('link', linkId, 'previous')); } catch { /* never rotated */ }
  const P = prefixOf(name), C = prefixOf(consumerName);
  return {
    consumer: [{ key: `${P}_URL`, value: address, secret: false }, { key: `${P}_API_KEY`, value: key, secret: true }],
    provider: [{ key: `${C}_API_KEY`, value: key, secret: true }, ...(previous ? [{ key: `${C}_API_KEY_PREVIOUS`, value: previous, secret: true }] : [])],
    note: `${name} should accept requests that carry ${C}_API_KEY (e.g. as a Bearer token), and also ${C}_API_KEY_PREVIOUS when it is set, so a key change never breaks anything. If its code doesn't check that yet, ask your AI to add it.`,
  };
}

SOURCES.unit7 = {
  label: async (ctx, e) => svc(ctx, (e as { serviceId: string }).serviceId).name,
  async vars(ctx, e, consumer, linkId) {
    const s = svc(ctx, (e as { serviceId: string }).serviceId);
    return apiVars(ctx, linkId, s.name, addressFor(ctx, s, consumer), consumer);
  },
};

SINKS.unit7 = {
  label: async (ctx, e) => svc(ctx, (e as { serviceId: string }).serviceId).name,
  async reads(ctx, e) {
    const d = json<ServiceConfig>(svc(ctx, (e as { serviceId: string }).serviceId).config, {}).detection;
    return { stack: d?.stack, keys: d?.envKeys ?? [] };
  },
  async set(ctx, e, vars) {
    const serviceId = (e as { serviceId: string }).serviceId;
    for (const v of vars) {
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'env.set', { serviceId, key: v.key, value: v.value, secret: v.secret }, { reason: 'link' });
      if (r.status !== 'ok') throw new Unit7Error('link_failed', r.status === 'error' ? r.error.message : `Setting ${v.key} needs ${r.status === 'approval_required' ? 'approval' : 'permission'}.`, 409);
    }
  },
  async current(ctx, e, keys) {
    const serviceId = (e as { serviceId: string }).serviceId;
    const rows = merged(ctx.db, ctx.orgId, { type: 'service', id: serviceId, label: '' }).filter((r) => keys.includes(r.key));
    const out: Record<string, string | undefined> = {};
    for (const r of rows) out[r.key] = r.ref ? undefined : ctx.app.vault.openValue(ctx.orgId, envContext(r), r.ciphertext!, r.wrapped_key!);
    return out;
  },
  // settings take effect on the next start: redeploy now if it's running
  async apply(ctx, e) {
    const s = get<{ current_deployment_id: string | null; name: string }>(ctx.db, 'SELECT current_deployment_id, name FROM services WHERE id = ?', (e as { serviceId: string }).serviceId)!;
    if (!s.current_deployment_id) return `${s.name} picks these up on its first deploy.`;
    const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { serviceId: (e as { serviceId: string }).serviceId }, { reason: 'apply linked settings' });
    return r.status === 'ok' ? `${s.name} redeployed with the new settings.` : `${s.name} needs a redeploy to pick them up (${r.status}).`;
  },
};

// --- Supabase and Neon, as a source ------------------------------------------------------------------

// Browser-exposed names by framework (what create-next-app, Vite, SvelteKit… templates read)
const PUBLIC: Record<string, string> = { next: 'NEXT_PUBLIC_', nextjs: 'NEXT_PUBLIC_', vite: 'VITE_', react: 'REACT_APP_', 'create-react-app': 'REACT_APP_', sveltekit: 'PUBLIC_', astro: 'PUBLIC_', nuxt: 'NUXT_PUBLIC_', nuxtjs: 'NUXT_PUBLIC_', expo: 'EXPO_PUBLIC_', gatsby: 'GATSBY_' };

// The names to set: the ones the code reads when Unit7 knows them, else the conventional pair for its framework
export function supabaseVars(r: Reads, url: string, anon: string, publishable: string): Var[] {
  const out = new Map<string, string>();
  for (const k of r.keys) {
    if (/SUPABASE_URL$/.test(k)) out.set(k, url);
    else if (/SUPABASE_(ANON(_PUBLIC)?_KEY|KEY)$/.test(k)) out.set(k, anon);
    else if (/SUPABASE_PUBLISHABLE(_DEFAULT)?_KEY$/.test(k)) out.set(k, publishable);
  }
  // the official Vercel integration's names, plus the older *_ANON_KEY that most tutorials' code reads
  if (!out.size) for (const pre of new Set(['', PUBLIC[r.stack ?? ''] ?? ''])) { out.set(`${pre}SUPABASE_URL`, url); out.set(`${pre}SUPABASE_PUBLISHABLE_KEY`, publishable); out.set(`${pre}SUPABASE_ANON_KEY`, anon); }
  return [...out].map(([key, value]) => ({ key, value, secret: false })); // these keys are public by design
}

const consumerReads = (ctx: Ctx, consumer: End) => SINKS[consumer.kind]?.reads(ctx, consumer) ?? Promise.resolve({ keys: [] } as Reads);

SOURCES.supabase = {
  async label(ctx, e) {
    const { accountId, ref } = e as { accountId: string; ref: string };
    return (await supabase.projects(ctx, accountId)).find((p) => p.id === ref)?.name ?? ref;
  },
  async vars(ctx, e, consumer, linkId) {
    const { accountId, ref } = e as { accountId: string; ref: string };
    const [reads, url, keys] = await Promise.all([consumerReads(ctx, consumer), supabase.url(ctx, accountId, ref), supabase.publicKey(ctx, accountId, ref)]);
    const vars = supabaseVars(reads, url, keys.anon, keys.publishable);
    // a server-side key only when the code actually reads one (it bypasses row-level security)
    // never into a NEXT_PUBLIC_/VITE_… name: those are compiled into the page every visitor downloads
    const wantsSecret = reads.keys.filter((k) => /SUPABASE_(SERVICE_ROLE|SECRET)_KEY$/.test(k) && !isPublicKey(k));
    let note: string | undefined;
    // a person gave this link its key, so a rotated one follows it. A new one waits for a person
    const had = json<{ key: string }[]>(get<{ vars: string }>(ctx.db, 'SELECT vars FROM links WHERE id = ?', linkId)?.vars ?? '[]', []).map((v) => v.key);
    const waits = isAgent(ctx) && !ctx.approvalId ? wantsSecret.filter((k) => !had.includes(k)) : [];
    const fetched = wantsSecret.filter((k) => !waits.includes(k));
    if (waits.length) note = `The code reads ${waits.join(', ')}, a key that skips row-level security, so a person adds it: connect these two on Unit7's Wiring page, or put it in the Vault page.`;
    if (fetched.length) {
      try {
        const sk = await supabase.secretKeys(ctx, accountId, ref);
        for (const k of fetched) vars.push({ key: k, value: /SERVICE_ROLE/.test(k) ? sk.serviceRole ?? sk.secret! : sk.secret ?? sk.serviceRole!, secret: true });
      } catch (e) { note = [note, `The code reads ${fetched.join(', ')}, which Unit7 couldn't fetch (${(e as Error).message.slice(0, 120)}). Put it in Unit7's Vault page (never in a chat) from supabase.com/dashboard/project/${ref}/settings/api-keys.`].filter(Boolean).join(' '); }
    }
    if (reads.keys.some((k) => /^(DATABASE_URL|POSTGRES_URL)$/.test(k))) note = [note, `The code also reads a database URL. Supabase never reveals the database password, so set it once from supabase.com/dashboard/project/${ref}/database/settings (in Unit7's Vault page, never in a chat).`].filter(Boolean).join(' ');
    return { consumer: vars, note };
  },
};

SOURCES.neon = {
  async label(ctx, e) {
    const { accountId, project } = e as { accountId: string; project: string };
    return (await neon.projects(ctx, accountId)).find((p) => p.id === project)?.name ?? project;
  },
  async vars(ctx, e, consumer) {
    const { accountId, project } = e as { accountId: string; project: string };
    const [reads, url] = await Promise.all([consumerReads(ctx, consumer), neon.connectionString(ctx, accountId, project)]);
    const names = reads.keys.filter((k) => /^(DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|NEON_DATABASE_URL)$/.test(k));
    return { consumer: (names.length ? names : ['DATABASE_URL']).map((key) => ({ key, value: url, secret: true })) };
  },
};

// --- PlanetScale, Turso and Upstash, as a source --------------------------------------------------------------------------

// these hand a login out once, or a new one each time they're asked: the link keeps its own, so a daily sync never makes another
async function loginOf(ctx: Ctx, linkId: string, accountId: string, label: string, make: () => Promise<string>) {
  const ref = makeRef('link', linkId, 'login');
  if (!ctx.app.vault.has(ctx.orgId, ref)) ctx.app.vault.put(ctx.orgId, ref, await make(), { kind: 'connection_string', accountId, by: ctx.actor.name, meta: { label } });
  return ctx.secret(ref);
}
// the names the code reads, else the usual one. Exact names only: a NEXT_PUBLIC_ or VITE_ one is compiled into the page
const namesFor = (r: Reads, known: RegExp, usual: string) => { const k = r.keys.filter((x) => known.test(x)); return k.length ? k : [usual]; };

type NamedEnd = { accountId: string; org: string; database: string };
SOURCES.planetscale = {
  label: async (_ctx, e) => (e as NamedEnd).database,
  async vars(ctx, e, consumer, linkId) {
    const p = e as NamedEnd, reads = await consumerReads(ctx, consumer);
    // a Postgres role's name: letters, digits and _ are safe in any client
    const url = await loginOf(ctx, linkId, p.accountId, `Login for the PlanetScale database ${p.database}`, () => planetscale.login(ctx, p.accountId, p, `unit7_${linkId.toLowerCase().replace(/[^a-z0-9]/g, '_')}`));
    return { consumer: namesFor(reads, /^(DATABASE_URL|MYSQL_URL|POSTGRES_URL|PLANETSCALE_DATABASE_URL)$/, 'DATABASE_URL').map((key) => ({ key, value: url, secret: true })) };
  },
};
SOURCES.turso = {
  label: async (_ctx, e) => (e as NamedEnd).database,
  async vars(ctx, e, consumer, linkId) {
    const t = e as NamedEnd, reads = await consumerReads(ctx, consumer), host = await turso.host(ctx, t.accountId, t);
    const token = await loginOf(ctx, linkId, t.accountId, `Token for the Turso database ${t.database}`, () => turso.token(ctx, t.accountId, t));
    return { consumer: [
      ...namesFor(reads, /^(TURSO_DATABASE_URL|TURSO_DB_URL|TURSO_CONNECTION_URL|TURSO_URL|LIBSQL_URL|LIBSQL_DATABASE_URL)$/, 'TURSO_DATABASE_URL').map((key) => ({ key, value: `libsql://${host}`, secret: false })),
      ...namesFor(reads, /^(TURSO_AUTH_TOKEN|TURSO_DB_AUTH_TOKEN|TURSO_DATABASE_TOKEN|TURSO_TOKEN|LIBSQL_AUTH_TOKEN)$/, 'TURSO_AUTH_TOKEN').map((key) => ({ key, value: token, secret: true })),
    ] };
  },
};
type UpstashEnd = { accountId: string; database: string };
SOURCES.upstash = {
  label: (ctx, e) => upstash.name(ctx, (e as UpstashEnd).accountId, (e as UpstashEnd).database),
  async vars(ctx, e, consumer) {
    const u = e as UpstashEnd, reads = await consumerReads(ctx, consumer), login = await upstash.login(ctx, u.accountId, u.database);
    const tcp = reads.keys.filter((k) => /^(REDIS_URL|KV_URL|UPSTASH_REDIS_URL)$/.test(k));
    const rest = !tcp.length || reads.keys.some((k) => /^(UPSTASH_REDIS_REST_|KV_REST_API_)/.test(k)); // the REST pair is what @upstash/redis reads
    return { consumer: [...tcp.map((key) => ({ key, value: login.redisUrl, secret: true })), ...(rest ? [
      ...namesFor(reads, /^(UPSTASH_REDIS_REST_URL|KV_REST_API_URL)$/, 'UPSTASH_REDIS_REST_URL').map((key) => ({ key, value: login.restUrl, secret: false })),
      ...namesFor(reads, /^(UPSTASH_REDIS_REST_TOKEN|KV_REST_API_TOKEN)$/, 'UPSTASH_REDIS_REST_TOKEN').map((key) => ({ key, value: login.restToken, secret: true })),
    ] : [])] };
  },
};

// --- a Vercel project, as a sink --------------------------------------------------------------------

type VercelEnd = { accountId: string; project: string; team?: string };
SINKS.vercel = {
  label: async (ctx, e) => { const v = e as VercelEnd; return (await vercel.project(ctx, v.accountId, v.project, v.team)).name; },
  async reads(ctx, e) {
    const v = e as VercelEnd;
    const [p, env] = await Promise.all([vercel.project(ctx, v.accountId, v.project, v.team), vercel.env(ctx, v.accountId, v.project, v.team)]);
    return { stack: p.framework, keys: env.map((x) => x.key) };
  },
  async set(ctx, e, vars) { const v = e as VercelEnd; await vercel.setEnv(ctx, v.accountId, v.project, v.team, vars); },
  async current(ctx, e, keys) {
    const v = e as VercelEnd;
    return Object.fromEntries((await vercel.env(ctx, v.accountId, v.project, v.team)).filter((x) => keys.includes(x.key)).map((x) => [x.key, x.type === 'plain' ? x.value : undefined]));
  },
  async apply(ctx, e) {
    const v = e as VercelEnd;
    const p = await vercel.project(ctx, v.accountId, v.project, v.team);
    if (!p.productionDeployment) return `${p.name} picks these up on its next deploy.`;
    await vercel.redeploy(ctx, v.accountId, p);
    return `${p.name} is rebuilding on Vercel with the new settings.`;
  },
};

// --- Netlify, Render, Railway: as a destination, and as the API end of a connection -------------------

type NetlifyEnd = { accountId: string; site: string };
type RenderEnd = { accountId: string; service: string };
type RailwayEnd = { accountId: string; project: string; environment: string; service: string };
const pick = (env: Record<string, string>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, env[k]]));

SINKS.netlify = {
  label: async (ctx, e) => (await netlify.site(ctx, (e as NetlifyEnd).accountId, (e as NetlifyEnd).site)).name,
  reads: async (ctx, e) => { const n = e as NetlifyEnd; return { keys: Object.keys(await netlify.env(ctx, n.accountId, await netlify.site(ctx, n.accountId, n.site))) }; },
  set: async (ctx, e, vars) => { const n = e as NetlifyEnd; await netlify.setEnv(ctx, n.accountId, await netlify.site(ctx, n.accountId, n.site), vars); },
  current: async (ctx, e, keys) => { const n = e as NetlifyEnd; return pick(await netlify.env(ctx, n.accountId, await netlify.site(ctx, n.accountId, n.site)), keys); },
  apply: async (ctx, e) => { const n = e as NetlifyEnd; await netlify.build(ctx, n.accountId, n.site); return `${(await netlify.site(ctx, n.accountId, n.site)).name} is rebuilding on Netlify.`; },
};
SINKS.render = {
  label: async (ctx, e) => (await render.service(ctx, (e as RenderEnd).accountId, (e as RenderEnd).service)).name,
  reads: async (ctx, e) => ({ keys: Object.keys(await render.env(ctx, (e as RenderEnd).accountId, (e as RenderEnd).service)) }),
  set: async (ctx, e, vars) => { await render.setEnv(ctx, (e as RenderEnd).accountId, (e as RenderEnd).service, vars); },
  current: async (ctx, e, keys) => pick(await render.env(ctx, (e as RenderEnd).accountId, (e as RenderEnd).service), keys),
  apply: async (ctx, e) => { await render.deploy(ctx, (e as RenderEnd).accountId, (e as RenderEnd).service); return 'Redeploying on Render.'; },
};
SINKS.railway = {
  label: async (ctx, e) => railway.serviceName(ctx, (e as RailwayEnd).accountId, (e as RailwayEnd).service),
  reads: async (ctx, e) => ({ keys: Object.keys(await railway.variables(ctx, (e as RailwayEnd).accountId, e as RailwayEnd)).filter((k) => !k.startsWith('RAILWAY_')) }),
  set: async (ctx, e, vars) => { await railway.setEnv(ctx, (e as RailwayEnd).accountId, e as RailwayEnd, vars); },
  current: async (ctx, e, keys) => pick(await railway.variables(ctx, (e as RailwayEnd).accountId, e as RailwayEnd), keys),
  apply: async (ctx, e) => { await railway.redeploy(ctx, (e as RailwayEnd).accountId, e as RailwayEnd); return 'Redeploying on Railway.'; },
};

type HerokuEnd = { accountId: string; app: string };
SINKS.heroku = {
  label: async (ctx, e) => (await heroku.app(ctx, (e as HerokuEnd).accountId, (e as HerokuEnd).app)).name,
  reads: async (ctx, e) => ({ keys: Object.keys(await heroku.env(ctx, (e as HerokuEnd).accountId, (e as HerokuEnd).app)) }),
  set: async (ctx, e, vars) => { await heroku.setEnv(ctx, (e as HerokuEnd).accountId, (e as HerokuEnd).app, vars); },
  current: async (ctx, e, keys) => pick(await heroku.env(ctx, (e as HerokuEnd).accountId, (e as HerokuEnd).app), keys),
  apply: async () => 'Heroku restarts the app with the new settings by itself.',
};

// Fly.io: secrets can't be read back, so the link remembers what it set (see syncLink), and new
// secrets reach the app by rolling each machine onto the new secrets version
type FlyEnd = { accountId: string; app: string };
const flySecretsVersion = new Map<string, number>(); // app -> the version the last set produced
SINKS.fly = {
  label: async (_ctx, e) => (e as FlyEnd).app,
  reads: async (ctx, e) => ({ keys: (await fly.app(ctx, (e as FlyEnd).accountId, (e as FlyEnd).app))?.secrets ?? [] }),
  set: async (ctx, e, vars) => { const f = e as FlyEnd; flySecretsVersion.set(f.app, await fly.setSecrets(ctx, f.accountId, f.app, vars)); },
  current: async () => ({}),
  apply: async (ctx, e) => { const f = e as FlyEnd; const n = await fly.roll(ctx, f.accountId, f.app, flySecretsVersion.get(f.app)); return `${f.app} is restarting on Fly.io with the new secrets (${n} machine${n === 1 ? '' : 's'}).`; },
};
SOURCES.fly = { label: (ctx, e) => SINKS.fly!.label(ctx, e), async vars(ctx, e, consumer, linkId) {
  const a = await fly.app(ctx, (e as FlyEnd).accountId, (e as FlyEnd).app);
  if (!a) throw new Unit7Error('not_found', `Fly.io app ${(e as FlyEnd).app} wasn\u2019t found.`, 404);
  return apiVars(ctx, linkId, a.name, `https://${a.certs[0] ?? a.hostname}`, consumer);
} };

// an app elsewhere as the API end: its public address
SOURCES.vercel = { label: (ctx, e) => SINKS.vercel!.label(ctx, e), async vars(ctx, e, consumer, linkId) {
  const v = e as VercelEnd;
  const p = await vercel.project(ctx, v.accountId, v.project, v.team);
  const custom = (await vercel.projectDomains(ctx, v.accountId, v.project, v.team)).map((d) => d.name).find((n) => !n.endsWith('.vercel.app'));
  const url = custom ? `https://${custom}` : p.productionUrl;
  if (!url) throw new Unit7Error('no_address', `${p.name} has no production address yet.`, 409);
  return apiVars(ctx, linkId, p.name, url, consumer);
} };
SOURCES.netlify = { label: (ctx, e) => SINKS.netlify!.label(ctx, e), async vars(ctx, e, consumer, linkId) {
  const s = await netlify.site(ctx, (e as NetlifyEnd).accountId, (e as NetlifyEnd).site);
  return apiVars(ctx, linkId, s.name, s.ssl_url ?? `https://${s.name}.netlify.app`, consumer);
} };
SOURCES.render = { label: (ctx, e) => SINKS.render!.label(ctx, e), async vars(ctx, e, consumer, linkId) {
  const s = await render.service(ctx, (e as RenderEnd).accountId, (e as RenderEnd).service);
  if (!s.serviceDetails?.url) throw new Unit7Error('no_address', `${s.name} has no web address on Render.`, 409);
  return apiVars(ctx, linkId, s.name, s.serviceDetails.url, consumer);
} };
SOURCES.heroku = { label: (ctx, e) => SINKS.heroku!.label(ctx, e), async vars(ctx, e, consumer, linkId) {
  const a = await heroku.app(ctx, (e as HerokuEnd).accountId, (e as HerokuEnd).app);
  const custom = (await heroku.domains(ctx, (e as HerokuEnd).accountId, a.id)).find((d) => d.kind === 'custom')?.hostname;
  const url = custom ? `https://${custom}` : a.web_url?.replace(/\/$/, '');
  if (!url) throw new Unit7Error('no_address', `${a.name} has no web address on Heroku.`, 409);
  return apiVars(ctx, linkId, a.name, url, consumer);
} };
// a Railway service: a database (its connection URL; Railway's own reference inside the same project)
// or an app used as an API (its public address)
SOURCES.railway = { label: (ctx, e) => SINKS.railway!.label(ctx, e), async vars(ctx, e, consumer, linkId) {
  const r = e as RailwayEnd;
  const [vars, name] = await Promise.all([railway.variables(ctx, r.accountId, r), railway.serviceName(ctx, r.accountId, r.service)]);
  const db = Object.keys(vars).find((k) => /^(DATABASE|REDIS|MYSQL|MONGO)_PUBLIC_URL$/.test(k));
  if (db) {
    const key = db === 'DATABASE_PUBLIC_URL' ? 'DATABASE_URL' : db.replace('_PUBLIC', '');
    const same = consumer.kind === 'railway' && consumer.project === r.project && consumer.environment === r.environment;
    for (const v of Object.values(vars)) if (v.length >= 6) ctx.redactor.add(v, 'railway variable');
    return { consumer: [{ key, value: same ? `\${{${name}.${key}}}` : vars[db]!, secret: !same }], note: same ? undefined : 'Uses the database\u2019s public address (apps outside Railway can\u2019t reach its private one).' };
  }
  if (!vars.RAILWAY_PUBLIC_DOMAIN) throw new Unit7Error('no_address', `${name} has no public domain on Railway. Generate one (Settings → Networking), then sync again.`, 409);
  return apiVars(ctx, linkId, name, `https://${vars.RAILWAY_PUBLIC_DOMAIN}`, consumer);
} };

// --- the engine -------------------------------------------------------------------------------------

const need = <T>(x: T | undefined, what: string): T => { if (!x) throw new Unit7Error('unsupported', `Unit7 can't link ${what} yet.`, 400); return x; };

export async function syncLink(ctx: Ctx, linkId: string, source: End, target: End, apply = true) {
  const src = need(SOURCES[source.kind], `from ${source.kind}`);
  const sink = need(SINKS[target.kind], `to ${target.kind}`);
  const { consumer, provider, note } = await src.vars(ctx, source, target, linkId);
  const applied: string[] = [];
  const before = json<{ key: string; fp: string; side?: 'provider' }[]>(get<{ vars: string }>(ctx.db, 'SELECT vars FROM links WHERE id = ?', linkId)?.vars ?? '[]', []);
  const changed = consumer.filter((v) => before.find((b) => b.key === v.key && b.side !== 'provider')?.fp !== fp(v.value));
  // the provider side first (the API learns the key its client will send), so a key change never locks the client out
  let providerChanged = false;
  if (provider?.length) {
    const psink = need(SINKS[source.kind], `back to ${source.kind}`);
    const have = await psink.current(ctx, source, provider.map((v) => v.key));
    // a value the provider won't show back (Fly secrets, Vercel's encrypted ones): compare with what this link set last time
    // ponytail: such a value deleted by hand isn't restored until it changes; read it back where a host allows
    const pc = provider.filter((v) => (have[v.key] !== undefined ? have[v.key] !== v.value : before.find((b) => b.side === 'provider' && b.key === v.key)?.fp !== fp(v.value)));
    if (pc.length) {
      await psink.set(ctx, source, pc); providerChanged = true;
      // remembered at once: if the client side fails below, the retry doesn't set (and redeploy) the API side again
      run(ctx.db, 'UPDATE links SET vars = ? WHERE id = ?', JSON.stringify([...before.filter((b) => b.side !== 'provider'), ...provider.map((v) => ({ key: v.key, fp: fp(v.value), secret: v.secret, side: 'provider' }))]), linkId);
    }
  }
  if (providerChanged && apply) { const m = await SINKS[source.kind]!.apply(ctx, source); if (m) applied.push(m); }
  if (changed.length) await sink.set(ctx, target, changed);
  run(ctx.db, `UPDATE links SET vars = ?, status = 'ok', detail = NULL, checked_at = ? WHERE id = ?`,
    JSON.stringify([...consumer.map((v) => ({ key: v.key, fp: fp(v.value), secret: v.secret })), ...(provider ?? []).map((v) => ({ key: v.key, fp: fp(v.value), secret: v.secret, side: 'provider' }))]), now(), linkId);
  if (apply && changed.length) { const m = await sink.apply(ctx, target); if (m) applied.push(m); }
  return { set: changed.map((v) => v.key), unchanged: consumer.filter((v) => !changed.includes(v)).map((v) => v.key), applied, note };
}

// a connection that can't sync yet (the API has no address yet, a key expired) is kept as broken with
// the reason; Warden retries it every 15 minutes and it finishes by itself
async function syncOrMark(ctx: Ctx, linkId: string, source: End, target: End, apply: boolean) {
  const was = get<{ status: string; vars: string }>(ctx.db, 'SELECT status, vars FROM links WHERE id = ?', linkId);
  try { return await syncLink(ctx, linkId, source, target, apply); }
  catch (e) {
    run(ctx.db, `UPDATE links SET status = 'broken', detail = ?, checked_at = ? WHERE id = ?`, (e as Error).message.slice(0, 300), now(), linkId);
    // an alert only when a working connection breaks, not for one still waiting to finish
    if (was?.status === 'ok' && was.vars !== '[]') ctx.emit('link.broken', `A connection stopped working: ${(e as Error).message.slice(0, 160)}`, { severity: 'warning', resource: linkId });
    throw e;
  }
}

// a name that goes into a provider's path: it starts with a letter or digit, so it can never be .. or a slash
export const SLUG = z.string().regex(/^[a-z0-9][\w.-]{0,63}$/i, 'a name: letters, digits and . _ -');
const endSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unit7'), serviceId: fid('svc') }),
  z.object({ kind: z.literal('vercel'), accountId: fid('acc'), project: z.string().min(1).max(100), team: z.string().max(100).optional() }),
  z.object({ kind: z.literal('supabase'), accountId: fid('acc'), ref: z.string().regex(/^[a-z0-9]{8,40}$/) }),
  z.object({ kind: z.literal('neon'), accountId: fid('acc'), project: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('planetscale'), accountId: fid('acc'), org: SLUG, database: SLUG }),
  z.object({ kind: z.literal('turso'), accountId: fid('acc'), org: SLUG, database: SLUG }),
  z.object({ kind: z.literal('upstash'), accountId: fid('acc'), database: SLUG }),
  z.object({ kind: z.literal('netlify'), accountId: fid('acc'), site: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('render'), accountId: fid('acc'), service: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('heroku'), accountId: fid('acc'), app: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('fly'), accountId: fid('acc'), app: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('railway'), accountId: fid('acc'), project: z.string().min(1).max(100), environment: z.string().min(1).max(100), service: z.string().min(1).max(100) }),
]);

// apply false only skips the redeploy: the login still lands in the app's settings, so these ask either way
const LOGIN_KINDS = new Set<End['kind']>(['planetscale', 'turso', 'upstash']);
defineTool({
  name: 'link.create', title: 'Connect two things', risk: 'write', action: 'env_write', timeoutMs: 30 * 60_000,
  description: 'Wire one thing to another, across providers: a Supabase, Neon, PlanetScale, Turso or Upstash database to an app (Vercel or here), or an app here (an API, a CRM) to another app (here or on Vercel). Unit7 sets the right settings on both sides (URLs, keys, a generated shared secret), redeploys to apply them, and keeps them in sync. A PlanetScale, Turso or Upstash login is secret, so an AI’s link waits for a person. It goes into the app’s settings and the vault, never into a result.',
  input: z.object({ from: endSchema, to: endSchema, apply: z.boolean().default(true) }),
  // a Neon link puts a full database login where the app's code can read it, so a person says yes first
  assess: (c, i) => (isAgent(c) && [i.from, i.to].some((e) => LOGIN_KINDS.has(e.kind) || e.kind === 'neon') ? { tier: 3, ask: 'This puts a database login into an app’s settings, where its code can read it.', impact: 'Wires a database to an app, with its login.' } : undefined),
  async run(ctx, i) {
    // A link copies an app's secrets to its other end. An AI may only wire an app here to an outside account that
    // environment may use (see accountAllowed), so a second account can't be made to receive production's keys.
    if (isAgent(ctx)) {
      const here = [i.from, i.to].flatMap((e) => (e.kind === 'unit7' ? [get<{ environment_id: string }>(ctx.db, 'SELECT environment_id FROM services WHERE id = ?', e.serviceId)!.environment_id] : []));
      for (const e of [i.from, i.to]) {
        if (e.kind === 'unit7') continue;
        const acc = get<{ id: string; provider: string }>(ctx.db, 'SELECT id, provider FROM accounts WHERE id = ?', e.accountId)!;
        if (!here.every((env) => accountAllowed(ctx.db, ctx.orgId, env, acc))) {
          throw new Unit7Error('forbidden', `That ${e.kind} account isn't bound to the environment of the app here. A person can bind it (or create the link).`, 403);
        }
      }
    }
    const key = (e: End) => JSON.stringify(e);
    const existing = all<{ id: string; source: string; target: string }>(ctx.db, 'SELECT id, source, target FROM links WHERE org_id = ?', ctx.orgId)
      .find((l) => l.source === key(i.from) && l.target === key(i.to));
    const linkId = existing?.id ?? id('lnk');
    if (!existing) run(ctx.db, 'INSERT INTO links (id, org_id, source, target) VALUES (?, ?, ?, ?)', linkId, ctx.orgId, key(i.from), key(i.to));
    const r = await syncOrMark(ctx, linkId, i.from, i.to, i.apply);
    const [a, b] = await Promise.all([need(SOURCES[i.from.kind], i.from.kind).label(ctx, i.from), need(SINKS[i.to.kind], i.to.kind).label(ctx, i.to)]);
    ctx.emit('link.created', `${a} → ${b} connected${r.set.length ? ` (${r.set.join(', ')})` : ''}`, { severity: 'success' });
    return { linkId, from: a, to: b, ...r };
  },
});

defineTool({
  name: 'link.sync', title: 'Re-sync a connection', risk: 'write', action: 'env_write', timeoutMs: 30 * 60_000,
  description: 'Re-read a connection’s source (a rotated key, a new domain) and push any change to the other side. Warden does this daily.',
  input: z.object({ linkId: fid('lnk'), apply: z.boolean().default(true) }),
  async run(ctx, i) {
    const l = get<{ source: string; target: string }>(ctx.db, 'SELECT source, target FROM links WHERE id = ? AND org_id = ?', i.linkId, ctx.orgId);
    if (!l) throw new Unit7Error('not_found', 'That connection was not found.', 404);
    return syncOrMark(ctx, i.linkId, JSON.parse(l.source), JSON.parse(l.target), i.apply);
  },
});

defineTool({
  name: 'link.list', title: 'Connections', risk: 'read', action: 'read',
  description: 'Everything wired to everything: each connection, the settings it manages (names only), and whether it’s healthy.',
  input: z.object({}),
  async run(ctx) {
    return Promise.all(all<{ id: string; source: string; target: string; vars: string; status: string; detail: string | null; checked_at: string | null }>(ctx.db, 'SELECT id, source, target, vars, status, detail, checked_at FROM links WHERE org_id = ? ORDER BY created_at', ctx.orgId).map(async (l) => {
      const [s, t] = [JSON.parse(l.source) as End, JSON.parse(l.target) as End];
      const name = async (e: End, side: 'from' | 'to') => { try { return await (side === 'from' ? SOURCES : SINKS)[e.kind]!.label(ctx, e); } catch { return e.kind; } };
      return { id: l.id, from: { ...s, name: await name(s, 'from') }, to: { ...t, name: await name(t, 'to') }, settings: json<{ key: string; side?: string }[]>(l.vars, []).filter((v) => v.side !== 'provider').map((v) => v.key), status: l.status, detail: l.detail, checkedAt: l.checked_at };
    }));
  },
});

defineTool({
  name: 'link.remove', title: 'Disconnect', risk: 'write', action: 'env_write',
  description: 'Forget a connection. The settings it put in place stay (so nothing breaks); remove them yourself if you want.',
  input: z.object({ linkId: fid('lnk') }),
  run(ctx, i) { run(ctx.db, 'DELETE FROM links WHERE id = ? AND org_id = ?', i.linkId, ctx.orgId); return { removed: true }; },
});

// --- what can connect to what, and what obviously should ---------------------------------------------

export interface Thing { end: End; name: string; provider: string; role: 'app' | 'database'; uses?: Uses }
export interface Uses { reads: string[]; has: string[]; supabase: boolean; postgres: boolean }
// "shop-web" and "shop-prod" are the same thing; the generic words don't count
const GENERIC = new Set(['web', 'app', 'site', 'www', 'api', 'frontend', 'backend', 'front', 'back', 'prod', 'production', 'staging', 'dev', 'db', 'database', 'main', 'next', 'supabase', 'neon', 'vercel', 'project']);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w)));
const sameName = (a: string, b: string) => { const y = words(b); return [...words(a)].some((w) => y.has(w)); };
const usesFrom = (reads: string[], has: string[], deps: string[]): Uses => ({
  reads, has,
  supabase: [...reads, ...has].some((k) => /SUPABASE/.test(k)) || deps.some((d) => d.startsWith('@supabase/')),
  postgres: reads.some((k) => /^(DATABASE_URL|POSTGRES_URL)$/.test(k)) || deps.some((d) => ['pg', 'postgres', '@neondatabase/serverless', '@prisma/client', 'drizzle-orm', '@vercel/postgres'].includes(d)),
});

export function thingsFrom(found: Iterable<Found>): Thing[] {
  const out: Thing[] = [];
  for (const f of found) {
    if (!f.end || (f.kind !== 'app' && f.kind !== 'database') || !(SOURCES[f.end.kind] ?? SINKS[f.end.kind])) continue;
    // an app whose settings couldn't be read (no envKeys) gets no suggestions: it may well have them already
    const uses = f.kind === 'app' && f.envKeys ? usesFrom(f.reads ?? [], f.envKeys, []) : undefined;
    if (uses) Object.assign(uses, { supabase: uses.supabase || !!f.uses?.supabase, postgres: uses.postgres || !!f.uses?.postgres });
    out.push({ end: f.end, name: f.name, provider: f.provider, role: f.kind, uses });
  }
  return out;
}

// What the last sync found across every account (sync.run), plus the apps here as they are right now
export async function inventory(ctx: Ctx) {
  const elsewhere = all<{ provider: string; kind: Found['kind']; ext_id: string; name: string; meta: string }>(ctx.db,
    `SELECT provider, kind, ext_id, name, meta FROM assets WHERE org_id = ? AND kind IN ('app', 'database') AND provider != 'unit7'`, ctx.orgId)
    .map((a): Found => ({ ...json<Partial<Found>>(a.meta, {}), provider: a.provider, kind: a.kind, extId: a.ext_id, name: a.name }));
  const here = (await scanUnit7(ctx)).found;
  const last = json<{ accounts?: { name: string; ok: boolean; note?: string }[] }>(get<{ summary: string }>(ctx.db, `SELECT summary FROM sync_runs WHERE org_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`, ctx.orgId)?.summary ?? '{}', {});
  return { things: thingsFrom([...here, ...elsewhere]), problems: (last.accounts ?? []).filter((a) => !a.ok).map((a) => `${a.name}: ${a.note}`) };
}

export interface Suggestion { from: End; to: End; fromName: string; toName: string; why: string; sure: boolean }
// sure = only one thing it could be (or the names match), so Unit7 connects it by itself
export function suggest(things: Thing[], linked: { source: string; target: string }[]): Suggestion[] {
  const out: Suggestion[] = [];
  const done = (a: End, b: End) => linked.some((l) => l.source === JSON.stringify(a) && l.target === JSON.stringify(b));
  const pick = (app: Thing, dbs: Thing[], why: string) => {
    const named = dbs.filter((d) => sameName(d.name, app.name));
    const choice = named.length === 1 ? named[0] : dbs.length === 1 ? dbs[0] : undefined;
    for (const d of choice ? [choice] : dbs) if (!done(d.end, app.end)) out.push({ from: d.end, to: app.end, fromName: d.name, toName: app.name, why, sure: !!choice });
  };
  for (const app of things.filter((t) => t.role === 'app' && t.uses)) {
    const u = app.uses!;
    if (u.supabase && !u.has.some((k) => /SUPABASE_URL$/.test(k))) pick(app, things.filter((t) => t.provider === 'supabase'), `${app.name} uses Supabase but has no project URL set`);
    // apps here get a database from Unit7 itself when they need one; this is for apps elsewhere
    if (app.provider !== 'unit7' && u.postgres && !u.has.some((k) => /^(DATABASE_URL|POSTGRES_URL)$/.test(k))) pick(app, things.filter((t) => t.provider === 'neon'), `${app.name} uses Postgres but has no DATABASE_URL`);
    // the code asks for another app by name: CRM_URL → the app called "crm"
    for (const other of things.filter((t) => t.provider === 'unit7' && t !== app)) {
      const want = `${prefixOf(other.name)}_URL`;
      if ((u.reads.includes(want) || u.has.includes(want)) && !done(other.end, app.end) && !u.has.includes(`${prefixOf(other.name)}_API_KEY`)) {
        out.push({ from: other.end, to: app.end, fromName: other.name, toName: app.name, why: `${app.name} reads ${want}`, sure: true });
      }
    }
  }
  return out;
}

const linkedRows = (ctx: Ctx) => all<{ source: string; target: string }>(ctx.db, 'SELECT source, target FROM links WHERE org_id = ?', ctx.orgId);

defineTool({
  name: 'link.options', title: 'What can connect', risk: 'read', action: 'read', timeoutMs: 2 * 60_000,
  description: 'Every app and database across your connected accounts (from the last sync.run, plus apps here), and the connections that look missing (e.g. a Vercel site using supabase-js with no Supabase URL set).',
  input: z.object({}),
  async run(ctx) {
    const { things, problems } = await inventory(ctx);
    return { things: things.map(({ end, name, provider, role }) => ({ end, name, provider, role })), suggestions: suggest(things, linkedRows(ctx)), problems };
  },
});

defineTool({
  name: 'link.autoconnect', title: 'Connect what belongs together', risk: 'write', action: 'env_write', timeoutMs: 30 * 60_000,
  idle: (o: { created?: unknown[] }) => !o.created?.length,
  description: 'Make every connection that is clearly missing and unambiguous (one Supabase project for a site that uses Supabase, an app whose code asks for CRM_URL…). Each goes through the normal gate. Warden runs this after each automatic sync (sync.schedule).',
  input: z.object({}),
  async run(ctx) {
    const { things } = await inventory(ctx);
    const created: string[] = [], skipped: string[] = [];
    for (const s of suggest(things, linkedRows(ctx))) {
      if (endArchived(ctx.db, ctx.orgId, s.from) || endArchived(ctx.db, ctx.orgId, s.to)) { skipped.push(`${s.fromName} → ${s.toName}: archived, so Unit7 leaves it alone`); continue; }
      if (!s.sure) { skipped.push(`${s.toName}: more than one possible source (${s.fromName}…), so it's your call`); continue; }
      // Warden runs this after every sync, so it never asks: a login stays a person's to connect
      if (isAgent(ctx) && [s.from, s.to].some((e) => e.kind === 'neon')) { skipped.push(`${s.fromName} → ${s.toName}: this gives the app a database login, so it's your call`); continue; }
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'link.create', { from: s.from, to: s.to }, { reason: s.why });
      (r.status === 'ok' ? created : skipped).push(r.status === 'ok' ? `${s.fromName} → ${s.toName}` : `${s.fromName} → ${s.toName}: ${r.status === 'error' ? r.error.message : r.status}`);
    }
    return { created, skipped };
  },
});

// A new shared key for a connection. The API side takes it first and keeps accepting the old one for a
// day (its _PREVIOUS variable), then the client switches; Warden retires the old key after 24 hours.
export async function rotateLink(ctx: Ctx, linkId: string) {
  const l = get<{ source: string; target: string }>(ctx.db, 'SELECT source, target FROM links WHERE id = ? AND org_id = ?', linkId, ctx.orgId);
  if (!l) throw new Unit7Error('not_found', 'That connection was not found.', 404);
  const ref = makeRef('link', linkId, 'key');
  let old: string | undefined;
  try { old = ctx.secret(ref); } catch { /* no key yet: this link carries none (a database link) */ }
  if (!old) throw new Unit7Error('nothing_to_rotate', 'This connection has no shared key to change.', 409);
  const next = randomBytes(24).toString('base64url');
  ctx.redactor.add(next, 'link key');
  ctx.app.vault.put(ctx.orgId, makeRef('link', linkId, 'previous'), old, { kind: 'link_key', by: 'rotation' });
  ctx.app.vault.put(ctx.orgId, ref, next, { kind: 'link_key', by: 'rotation' });
  run(ctx.db, 'UPDATE links SET rotated_at = ?, previous_until = ? WHERE id = ?', now(), new Date(Date.now() + 86400_000).toISOString(), linkId);
  return syncOrMark(ctx, linkId, JSON.parse(l.source), JSON.parse(l.target), true);
}

// After the grace day: the old key stops working everywhere (an unguessable value, never an empty one). Only
// once the client really uses the new key (the link is healthy and its side has it); until then the grace
// period is stretched an hour at a time. The grace mark is cleared last, so a failed run is simply tried again.
export async function retirePrevious(ctx: Ctx, linkId: string) {
  const l = get<{ source: string; target: string; status: string; vars: string }>(ctx.db, 'SELECT source, target, status, vars FROM links WHERE id = ? AND org_id = ?', linkId, ctx.orgId);
  if (!l) return undefined;
  let key: string | undefined;
  try { key = ctx.secret(makeRef('link', linkId, 'key')); } catch { /* no key: nothing the client could hold */ }
  const clientHas = !!key && json<{ fp: string; side?: string }[]>(l.vars, []).some((v) => v.side !== 'provider' && v.fp === fp(key!));
  if (l.status !== 'ok' || !clientHas) {
    run(ctx.db, 'UPDATE links SET previous_until = ? WHERE id = ?', new Date(Date.now() + 3600_000).toISOString(), linkId);
    return { retired: false, why: l.status !== 'ok' ? 'the connection isn\u2019t healthy yet' : 'the client doesn\u2019t have the new key yet' };
  }
  ctx.app.vault.put(ctx.orgId, makeRef('link', linkId, 'previous'), randomBytes(32).toString('base64url'), { kind: 'link_key', by: 'rotation' });
  const r = await syncOrMark(ctx, linkId, JSON.parse(l.source), JSON.parse(l.target), true);
  run(ctx.db, 'UPDATE links SET previous_until = NULL WHERE id = ?', linkId);
  return { retired: true, ...r };
}

defineTool({
  name: 'link.rotate', title: 'Change a connection\u2019s key', risk: 'write', action: 'env_write', timeoutMs: 30 * 60_000,
  description: 'Give a connection a new shared key without breaking it: the API side accepts the new key (and the old one for a day), then the client switches. Warden retires the old key after 24 hours, and rotates keys on the schedule you set.',
  input: z.object({ linkId: fid('lnk') }),
  run: (ctx, i) => rotateLink(ctx, i.linkId),
});

defineTool({
  name: 'link.retire_previous', title: 'Retire a connection\u2019s old key', risk: 'write', action: 'env_write', timeoutMs: 30 * 60_000,
  description: 'End the grace period after a key change: the old key stops being accepted. Warden does this 24 hours after a rotation.',
  input: z.object({ linkId: fid('lnk') }),
  run: (ctx, i) => retirePrevious(ctx, i.linkId),
});
