// More places apps live: Netlify, Render and Railway (REST/GraphQL with a token or a one-click sign-in),
// and DigitalOcean's listings. Each can list what's there (for the map), set settings and redeploy (for
// connections), and add a domain (Unit7 then writes the records the host asks for).
import type { Ctx } from '../tools/runtime.ts';
import { Unit7Error } from '../errors.ts';
import { bearerFor, isOAuthAccount } from './mcp-oauth.ts';
import { json, run } from '../db.ts';
import { rest, DO, doAuth } from './dnswrite.ts';
import { dnsHost } from './dnsinfo.ts';

type DnsRec = { type: 'A' | 'CNAME' | 'TXT' | 'ALIAS'; name: string; content: string };
const hostOf = (url?: string | null) => { try { return url ? new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase() : undefined; } catch { return undefined; } };
const isApex = async (domain: string) => (await dnsHost(domain)).zone === domain;

// --- Netlify -----------------------------------------------------------------------------------------
const NETLIFY = 'https://api.netlify.com/api/v1';
const nl = async (ctx: Ctx, acc: string) => ({ authorization: `Bearer ${await bearerFor(ctx, 'netlify', acc)}` });
export interface NetlifySite { id: string; name: string; account_id: string; custom_domain?: string | null; domain_aliases?: string[]; ssl_url?: string; url?: string; published_deploy?: { id: string } | null }
export const netlify = {
  async sites(ctx: Ctx, acc: string) {
    const out: NetlifySite[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await rest<NetlifySite[]>('Netlify', `${NETLIFY}/sites?filter=all&per_page=100&page=${page}`, { headers: await nl(ctx, acc) });
      out.push(...r);
      if (r.length < 100) break;
    }
    return out;
  },
  site: async (ctx: Ctx, acc: string, id: string) => rest<NetlifySite>('Netlify', `${NETLIFY}/sites/${id}`, { headers: await nl(ctx, acc) }),
  // one value per key: the "all" or production context
  async env(ctx: Ctx, acc: string, s: NetlifySite) {
    const r = await rest<{ key: string; values: { value?: string; context: string }[] }[]>('Netlify', `${NETLIFY}/accounts/${s.account_id}/env?site_id=${s.id}`, { headers: await nl(ctx, acc) });
    const out: Record<string, string> = {};
    for (const v of r) out[v.key] = (v.values.find((x) => x.context === 'all') ?? v.values.find((x) => x.context === 'production') ?? v.values[0])?.value ?? '';
    return out;
  },
  async setEnv(ctx: Ctx, acc: string, s: NetlifySite, vars: { key: string; value: string; secret: boolean }[]) {
    const headers = await nl(ctx, acc), have = await netlify.env(ctx, acc, s);
    const fresh = vars.filter((v) => !(v.key in have));
    if (fresh.length) await rest('Netlify', `${NETLIFY}/accounts/${s.account_id}/env?site_id=${s.id}`, { headers, body: fresh.map((v) => ({ key: v.key, values: [{ context: 'all', value: v.value }] })) });
    for (const v of vars.filter((x) => x.key in have)) await rest('Netlify', `${NETLIFY}/accounts/${s.account_id}/env/${encodeURIComponent(v.key)}?site_id=${s.id}`, { method: 'PATCH', headers, body: { context: 'all', value: v.value } });
  },
  build: async (ctx: Ctx, acc: string, siteId: string) => rest('Netlify', `${NETLIFY}/sites/${siteId}/builds`, { method: 'POST', headers: await nl(ctx, acc), body: {} }),
  async addDomain(ctx: Ctx, acc: string, siteId: string, domain: string): Promise<DnsRec[]> {
    const s = await netlify.site(ctx, acc, siteId);
    const body = !s.custom_domain ? { custom_domain: domain } : s.custom_domain === domain || s.domain_aliases?.includes(domain) ? undefined : { domain_aliases: [...(s.domain_aliases ?? []), domain] };
    if (body) await rest('Netlify', `${NETLIFY}/sites/${siteId}`, { method: 'PATCH', headers: await nl(ctx, acc), body });
    // apex: Netlify's load balancer address (no CNAME at a bare domain); subdomain: the site's own name
    return [await isApex(domain) ? { type: 'A', name: domain, content: '75.2.60.5' } : { type: 'CNAME', name: domain, content: `${s.name}.netlify.app` }];
  },
  // the main address: Netlify sends the other of www / the bare domain to the primary one by itself, as long as it
  // isn't an alias of its own (docs.netlify.com/manage/domains/manage-domains/manage-multiple-domains)
  async setPrimary(ctx: Ctx, acc: string, siteId: string, main: string, other: string) {
    const s = await netlify.site(ctx, acc, siteId);
    await rest('Netlify', `${NETLIFY}/sites/${siteId}`, { method: 'PATCH', headers: await nl(ctx, acc), body: { custom_domain: main, domain_aliases: (s.domain_aliases ?? []).filter((d) => d !== main && d !== other) } });
  },
  ssl: async (ctx: Ctx, acc: string, siteId: string) => { await rest('Netlify', `${NETLIFY}/sites/${siteId}/ssl`, { method: 'POST', headers: await nl(ctx, acc), body: {} }).catch(() => undefined); },
};

// --- Render ------------------------------------------------------------------------------------------
const RENDER = 'https://api.render.com/v1';
const rn = async (ctx: Ctx, acc: string) => ({ authorization: `Bearer ${await bearerFor(ctx, 'render', acc)}` });
async function renderList<T>(ctx: Ctx, acc: string, path: string, field: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await rest<({ cursor: string } & Record<string, T>)[]>('Render', `${RENDER}${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: await rn(ctx, acc) });
    out.push(...page.map((x) => x[field]!));
    if (page.length < 100) break;
    cursor = page.at(-1)!.cursor;
  }
  return out;
}
export interface RenderService { id: string; name: string; type: string; ownerId?: string; suspended?: string; serviceDetails?: { url?: string } }
export const render = {
  services: (ctx: Ctx, acc: string) => renderList<RenderService>(ctx, acc, '/services?includePreviews=false', 'service'),
  service: async (ctx: Ctx, acc: string, id: string) => rest<RenderService>('Render', `${RENDER}/services/${id}`, { headers: await rn(ctx, acc) }),
  env: async (ctx: Ctx, acc: string, id: string) => Object.fromEntries((await renderList<{ key: string; value: string }>(ctx, acc, `/services/${id}/env-vars`, 'envVar')).map((v) => [v.key, v.value])),
  domains: (ctx: Ctx, acc: string, id: string) => renderList<{ name: string; verificationStatus: string }>(ctx, acc, `/services/${id}/custom-domains`, 'customDomain'),
  postgres: (ctx: Ctx, acc: string) => renderList<{ id: string; name: string; status?: string }>(ctx, acc, '/postgres', 'postgres'),
  // the database's hosts, read out of its connection strings (the strings themselves aren't kept)
  postgresHosts: async (ctx: Ctx, acc: string, id: string) => {
    const c = await rest<{ internalConnectionString?: string; externalConnectionString?: string }>('Render', `${RENDER}/postgres/${id}/connection-info`, { headers: await rn(ctx, acc) });
    return [c.internalConnectionString, c.externalConnectionString].map((s) => (s ? /@([^:/?]+)/.exec(s)?.[1]?.toLowerCase() : undefined)).filter(Boolean) as string[];
  },
  async setEnv(ctx: Ctx, acc: string, id: string, vars: { key: string; value: string }[]) {
    for (const v of vars) await rest('Render', `${RENDER}/services/${id}/env-vars/${encodeURIComponent(v.key)}`, { method: 'PUT', headers: await rn(ctx, acc), body: { value: v.value } }); // one key at a time: never the replace-all call
  },
  deploy: async (ctx: Ctx, acc: string, id: string) => rest('Render', `${RENDER}/services/${id}/deploys`, { method: 'POST', headers: await rn(ctx, acc), body: {} }),
  // error-level log lines since a moment (Render filters by level itself)
  async errorLines(ctx: Ctx, acc: string, id: string, since: Date) {
    const owner = (await render.service(ctx, acc, id)).ownerId;
    if (!owner) return [];
    const out: { at: string; text: string }[] = [];
    let start = since.toISOString(), end = new Date().toISOString();
    for (let page = 0; page < 3; page++) {
      const q = new URLSearchParams({ ownerId: owner, resource: id, startTime: start, endTime: end, level: 'error', direction: 'forward', limit: '100' });
      const r = await rest<{ hasMore: boolean; nextStartTime?: string; nextEndTime?: string; logs: { message: string; timestamp: string }[] }>('Render', `${RENDER}/logs?${q}`, { headers: await rn(ctx, acc) });
      out.push(...r.logs.map((l) => ({ at: l.timestamp, text: l.message })));
      if (!r.hasMore || !r.nextStartTime) break;
      start = r.nextStartTime; end = r.nextEndTime ?? end;
    }
    return out;
  },
  async addDomain(ctx: Ctx, acc: string, id: string, domain: string): Promise<DnsRec[]> {
    await rest('Render', `${RENDER}/services/${id}/custom-domains`, { method: 'POST', headers: await rn(ctx, acc), body: { name: domain } }).catch((e: Unit7Error) => { if (!/exist|already/i.test(e.message)) throw e; });
    const host = hostOf((await render.service(ctx, acc, id)).serviceDetails?.url);
    if (!host) throw new Unit7Error('unsupported', 'That Render service has no web address (a worker or cron job can’t take a domain).', 400);
    return [await isApex(domain) ? { type: 'A', name: domain, content: '216.24.57.1' } : { type: 'CNAME', name: domain, content: host }];
  },
  verify: async (ctx: Ctx, acc: string, id: string, domain: string) => { await rest('Render', `${RENDER}/services/${id}/custom-domains/${encodeURIComponent(domain)}/verify`, { method: 'POST', headers: await rn(ctx, acc), body: {} }).catch(() => undefined); },
};

// --- Railway (GraphQL) -------------------------------------------------------------------------------
const RAILWAY = 'https://backboard.railway.com/graphql/v2';
// Railway has three kinds of token: an account token (or a one-click sign-in) sees everything; a
// workspace token sees one workspace and can't ask "who am I"; a project token sees one environment of
// one project and goes in its own header. Unit7 works out which it was given, once, and remembers.
type RailwayKind = 'account' | 'workspace' | 'project';
async function railwayKind(ctx: Ctx, acc: string): Promise<{ kind: RailwayKind; headers: Record<string, string> }> {
  const { account } = ctx.credentialFor('railway', acc);
  const token = await bearerFor(ctx, 'railway', acc);
  const headersFor = (k: RailwayKind): Record<string, string> => (k === 'project' ? { 'project-access-token': token } : { authorization: `Bearer ${token}` });
  const known = json<{ railway?: RailwayKind }>(account.meta, {}).railway ?? (isOAuthAccount(account.meta) ? 'account' : undefined);
  if (known) return { kind: known, headers: headersFor(known) };
  const works = (k: RailwayKind, query: string) => rest<{ errors?: unknown[] }>('Railway', RAILWAY, { headers: headersFor(k), body: { query } }).then((r) => !r.errors?.length, () => false);
  const kind: RailwayKind | undefined = await works('account', '{ me { id } }') ? 'account'
    : await works('workspace', '{ projects(first: 1) { edges { node { id } } } }') ? 'workspace'
    : await works('project', '{ projectToken { projectId } }') ? 'project' : undefined;
  if (!kind) throw new Unit7Error('railway_auth', 'Railway didn\u2019t accept this token (as an account, workspace or project token).', 403);
  run(ctx.db, `UPDATE accounts SET meta = json_set(meta, '$.railway', ?) WHERE id = ?`, kind, acc);
  return { kind, headers: headersFor(kind) };
}

async function rw<T = any>(ctx: Ctx, acc: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await rest<{ data?: T; errors?: { message: string }[] }>('Railway', RAILWAY, { headers: (await railwayKind(ctx, acc)).headers, body: { query, variables } });
  if (r.errors?.length) throw new Unit7Error('railway_error', `Railway: ${r.errors[0]!.message}`, /authori/i.test(r.errors[0]!.message) ? 403 : 502);
  return r.data!;
}
const PROJECT_FIELDS = `id name environments(first: 50) { edges { node { id name serviceInstances(first: 100) { edges { node {
  serviceId serviceName source { image repo } latestDeployment { status }
  domains { serviceDomains { domain } customDomains { domain } } } } } } } }`;
export interface RailwayInstance { project: string; projectName: string; environment: string; environmentName: string; service: string; name: string; image?: string; status?: string; domains: string[]; custom: string[] }
export const railway = {
  // every project: each workspace's, shared ones, and personal ones
  async instances(ctx: Ctx, acc: string): Promise<RailwayInstance[]> {
    const { kind } = await railwayKind(ctx, acc);
    const projects = new Map<string, any>();
    let onlyEnv: string | undefined;
    // a project token: just its project, just its environment
    if (kind === 'project') {
      const t = await rw<{ projectToken: { projectId: string; environmentId: string } }>(ctx, acc, '{ projectToken { projectId environmentId } }');
      projects.set(t.projectToken.projectId, (await rw(ctx, acc, `query($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`, { id: t.projectToken.projectId })).project);
      onlyEnv = t.projectToken.environmentId;
    }
    const ws = kind === 'account' ? await rw<{ me: { workspaces: { id: string }[] }; externalWorkspaces: { projects: { id: string }[] }[] }>(ctx, acc, 'query { me { workspaces { id } } externalWorkspaces { projects { id } } }') : undefined;
    for (const workspaceId of kind === 'project' ? [] : [undefined, ...(ws?.me.workspaces.map((w) => w.id) ?? [])]) {
      let after: string | undefined;
      for (let i = 0; i < 20; i++) {
        const r = await rw(ctx, acc, `query($w: String, $a: String) { projects(workspaceId: $w, first: 50, after: $a) { pageInfo { hasNextPage endCursor } edges { node { ${PROJECT_FIELDS} } } } }`, { w: workspaceId, a: after });
        for (const e of r.projects.edges) projects.set(e.node.id, e.node);
        if (!r.projects.pageInfo.hasNextPage) break;
        after = r.projects.pageInfo.endCursor;
      }
    }
    for (const p of ws?.externalWorkspaces.flatMap((w) => w.projects) ?? []) if (!projects.has(p.id)) projects.set(p.id, (await rw(ctx, acc, `query($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`, { id: p.id })).project);
    return [...projects.values()].flatMap((p) => p.environments.edges.filter((e: any) => !onlyEnv || e.node.id === onlyEnv).flatMap((e: any) => e.node.serviceInstances.edges.map((s: any): RailwayInstance => ({
      project: p.id, projectName: p.name, environment: e.node.id, environmentName: e.node.name, service: s.node.serviceId, name: s.node.serviceName, image: s.node.source?.image ?? undefined,
      status: s.node.latestDeployment?.status, domains: s.node.domains.serviceDomains.map((d: any) => d.domain.toLowerCase()), custom: s.node.domains.customDomains.map((d: any) => d.domain.toLowerCase()),
    }))));
  },
  serviceName: (ctx: Ctx, acc: string, service: string) => rw<{ service: { name: string } }>(ctx, acc, 'query($s: String!) { service(id: $s) { name } }', { s: service }).then((r) => r.service.name),
  variables: (ctx: Ctx, acc: string, t: { project: string; environment: string; service: string }) =>
    rw<{ variables: Record<string, string> }>(ctx, acc, 'query($p: String!, $e: String!, $s: String) { variables(projectId: $p, environmentId: $e, serviceId: $s) }', { p: t.project, e: t.environment, s: t.service }).then((r) => r.variables ?? {}),
  // set them all without a deploy each, then one redeploy
  setEnv: (ctx: Ctx, acc: string, t: { project: string; environment: string; service: string }, vars: { key: string; value: string }[]) =>
    rw(ctx, acc, 'mutation($i: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $i) }', { i: { projectId: t.project, environmentId: t.environment, serviceId: t.service, variables: Object.fromEntries(vars.map((v) => [v.key, v.value])), skipDeploys: true } }),
  // each workspace's usage so far this billing period (dollars, as Railway reports it)
  async spentThisPeriod(ctx: Ctx, acc: string) {
    if ((await railwayKind(ctx, acc)).kind !== 'account') return [];
    const ws = await rw<{ me: { workspaces: { id: string; name: string }[] } }>(ctx, acc, '{ me { workspaces { id name } } }');
    const out: { workspace: string; usd: number }[] = [];
    for (const w of ws.me.workspaces) {
      const r = await rw<{ workspace: { customer?: { currentUsage?: number } } }>(ctx, acc, 'query($w: String!) { workspace(workspaceId: $w) { customer { currentUsage } } }', { w: w.id }).catch(() => undefined);
      const usd = r?.workspace.customer?.currentUsage ?? 0;
      if (usd) out.push({ workspace: w.name, usd });
    }
    return out;
  },
  // the latest deployment's error-level log lines since a moment
  async errorLines(ctx: Ctx, acc: string, t: { environment: string; service: string }, since: Date) {
    const d = await rw<{ serviceInstance: { latestDeployment: { id: string } | null } }>(ctx, acc, 'query($s: String!, $e: String!) { serviceInstance(serviceId: $s, environmentId: $e) { latestDeployment { id } } }', { s: t.service, e: t.environment });
    const id = d.serviceInstance?.latestDeployment?.id;
    if (!id) return [];
    const r = await rw<{ deploymentLogs: { timestamp: string; message: string }[] }>(ctx, acc, 'query($id: String!, $start: DateTime) { deploymentLogs(deploymentId: $id, startDate: $start, filter: "@level:error", limit: 500) { timestamp message } }', { id, start: since.toISOString() });
    return r.deploymentLogs.map((l) => ({ at: l.timestamp, text: l.message }));
  },
  redeploy: (ctx: Ctx, acc: string, t: { environment: string; service: string }) =>
    rw(ctx, acc, 'mutation($s: String!, $e: String!) { serviceInstanceRedeploy(serviceId: $s, environmentId: $e) }', { s: t.service, e: t.environment }),
  async addDomain(ctx: Ctx, acc: string, t: { project: string; environment: string; service: string }, domain: string): Promise<DnsRec[]> {
    const r = await rw(ctx, acc, `mutation($i: CustomDomainCreateInput!) { customDomainCreate(input: $i) { status { verificationDnsHost verificationToken dnsRecords { fqdn recordType requiredValue purpose } } } }`,
      { i: { projectId: t.project, environmentId: t.environment, serviceId: t.service, domain } });
    const st = r.customDomainCreate.status;
    const zone = (await dnsHost(domain)).zone ?? domain;
    const recs: DnsRec[] = st.dnsRecords.filter((d: any) => d.purpose !== 'DNS_RECORD_PURPOSE_ACME_DNS01_CHALLENGE' && /_(A|CNAME|TXT)$/.test(d.recordType))
      .map((d: any) => ({ type: d.recordType.replace('DNS_RECORD_TYPE_', ''), name: d.fqdn.replace(/\.$/, ''), content: d.requiredValue.replace(/\.$/, '') }));
    if (st.verificationDnsHost && st.verificationToken && !recs.some((x) => x.type === 'TXT')) {
      const h = st.verificationDnsHost.replace(/\.$/, '');
      recs.push({ type: 'TXT', name: h.endsWith(zone) ? h : `${h}.${zone}`, content: st.verificationToken });
    }
    return recs;
  },
};

// --- Heroku (Platform API) ------------------------------------------------------------------------------
const HEROKU = 'https://api.heroku.com';
const hk = async (ctx: Ctx, acc: string) => ({ authorization: `Bearer ${await bearerFor(ctx, 'heroku', acc)}`, accept: 'application/vnd.heroku+json; version=3' });
export interface HerokuApp { id: string; name: string; web_url?: string; maintenance?: boolean }
export const heroku = {
  // ponytail: Heroku pages long lists with a Range header; 1000 apps per call covers nearly everyone
  apps: async (ctx: Ctx, acc: string) => rest<HerokuApp[]>('Heroku', `${HEROKU}/apps`, { headers: { ...(await hk(ctx, acc)), range: 'id ..; max=1000' } }),
  app: async (ctx: Ctx, acc: string, app: string) => rest<HerokuApp>('Heroku', `${HEROKU}/apps/${encodeURIComponent(app)}`, { headers: await hk(ctx, acc) }),
  domains: async (ctx: Ctx, acc: string, app: string) => rest<{ hostname: string; kind: 'heroku' | 'custom'; cname: string | null }[]>('Heroku', `${HEROKU}/apps/${encodeURIComponent(app)}/domains`, { headers: await hk(ctx, acc) }),
  env: async (ctx: Ctx, acc: string, app: string) => rest<Record<string, string>>('Heroku', `${HEROKU}/apps/${encodeURIComponent(app)}/config-vars`, { headers: await hk(ctx, acc) }),
  addons: async (ctx: Ctx, acc: string, app: string) => rest<{ id: string; name: string; addon_service: { name: string }; config_vars: string[]; state?: string }[]>('Heroku', `${HEROKU}/apps/${encodeURIComponent(app)}/addons`, { headers: await hk(ctx, acc) }),
  // Heroku makes a new release and restarts the app by itself when settings change
  setEnv: async (ctx: Ctx, acc: string, app: string, vars: { key: string; value: string }[]) =>
    rest('Heroku', `${HEROKU}/apps/${encodeURIComponent(app)}/config-vars`, { method: 'PATCH', headers: await hk(ctx, acc), body: Object.fromEntries(vars.map((v) => [v.key, v.value])) }),
  // Heroku has no month-to-date figure: the latest invoice stands in for a month
  lastInvoice: async (ctx: Ctx, acc: string) => (await rest<{ total: number; period_end: string }[]>('Heroku', `${HEROKU}/account/invoices`, { headers: await hk(ctx, acc) }).catch(() => [])).at(-1),
  async recentLines(ctx: Ctx, acc: string, app: string, since: Date) {
    const s = await rest<{ logplex_url: string }>('Heroku', `${HEROKU}/apps/${encodeURIComponent(app)}/log-sessions`, { headers: await hk(ctx, acc), body: { lines: 1500, source: 'app', tail: false } });
    const res = await fetch(s.logplex_url, { signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    // plain lines or Server-Sent Events ("data: …"); each line starts with its timestamp
    return text.split('\n').map((l) => l.replace(/^data: ?/, '')).filter((l) => /^\d{4}-\d\d-\d\dT/.test(l))
      .map((l) => ({ at: l.slice(0, l.indexOf(' ')), text: l.replace(/^\S+ \S+: /, '') })).filter((l) => Date.parse(l.at) > since.getTime());
  },
  async addDomain(ctx: Ctx, acc: string, app: string, domain: string): Promise<DnsRec[]> {
    const headers = await hk(ctx, acc);
    const existing = (await heroku.domains(ctx, acc, app)).find((d) => d.hostname === domain);
    const d = existing ?? await rest<{ cname: string | null }>('Heroku', `${HEROKU}/apps/${encodeURIComponent(app)}/domains`, { headers, body: { hostname: domain, sni_endpoint: null } });
    await rest('Heroku', `${HEROKU}/apps/${encodeURIComponent(app)}/acm`, { method: 'POST', headers, body: {} }).catch(() => undefined); // free automatic HTTPS
    if (!d.cname) throw new Unit7Error('heroku_error', 'Heroku didn\u2019t say where the domain should point yet. Try again in a minute.', 409);
    // a bare domain needs a flattened CNAME (Cloudflare does it) or ALIAS; a subdomain is a plain CNAME
    return [{ type: await isApex(domain) ? 'ALIAS' : 'CNAME', name: domain, content: d.cname.replace(/\.$/, '') }];
  },
};

// --- Fly.io: GraphQL to list apps, the Machines API to set secrets, roll machines and add domains --------
const FLY_GQL = 'https://api.fly.io/graphql', FLY_API = 'https://api.machines.dev/v1';
// flyctl's rule: tokens made of fm1r_/fm2_ parts go as "FlyV1 …", anything else as a Bearer token
const flyAuth = async (ctx: Ctx, acc: string) => {
  const t = (await bearerFor(ctx, 'fly', acc)).trim().replace(/^FlyV1\s+/, '');
  return { authorization: t.split(',').some((part) => /^fm(1r|2)_/.test(part.trim())) ? `FlyV1 ${t}` : `Bearer ${t}` };
};
async function flyGql<T = any>(ctx: Ctx, acc: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await rest<{ data?: T; errors?: { message: string }[] }>('Fly.io', FLY_GQL, { headers: await flyAuth(ctx, acc), body: { query, variables } });
  if (r.errors?.length) throw new Unit7Error('fly_error', `Fly.io: ${r.errors[0]!.message}`, 502);
  return r.data!;
}
export interface FlyApp { id: string; name: string; hostname: string; org: string; postgres: boolean; ips: string[]; certs: string[]; secrets: string[] }
export const fly = {
  // every app across your organisations (a personal token sees them all; an org token, one org)
  async apps(ctx: Ctx, acc: string): Promise<FlyApp[]> {
    const out: FlyApp[] = [];
    let after: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await flyGql(ctx, acc, `query($after: String) { apps(first: 200, after: $after) { pageInfo { hasNextPage endCursor } nodes {
        id name hostname organization { slug } role { name } sharedIpAddress ipAddresses(first: 50) { nodes { address type } } certificates(first: 100) { nodes { hostname } } secrets { name } } } }`, { after });
      for (const a of r.apps.nodes) out.push({ id: a.id, name: a.name, hostname: a.hostname, org: a.organization?.slug, postgres: a.role?.name === 'postgres_cluster',
        ips: [...a.ipAddresses.nodes.filter((x: any) => x.type === 'v4' || x.type === 'v6').map((x: any) => x.address), ...(a.sharedIpAddress ? [a.sharedIpAddress] : [])],
        certs: a.certificates.nodes.map((c: any) => c.hostname.toLowerCase()), secrets: (a.secrets ?? []).map((x: any) => x.name) });
      if (!r.apps.pageInfo.hasNextPage) break;
      after = r.apps.pageInfo.endCursor;
    }
    return out;
  },
  app: async (ctx: Ctx, acc: string, name: string) => (await fly.apps(ctx, acc)).find((a) => a.name === name),
  // secrets don't restart anything on Fly: each machine is then updated to require the new secrets version
  async setSecrets(ctx: Ctx, acc: string, app: string, vars: { key: string; value: string }[]) {
    const r = await rest<{ version: number }>('Fly.io', `${FLY_API}/apps/${encodeURIComponent(app)}/secrets`, { headers: await flyAuth(ctx, acc), body: { values: Object.fromEntries(vars.map((v) => [v.key, v.value])) } });
    return r.version;
  },
  async roll(ctx: Ctx, acc: string, app: string, secretsVersion?: number) {
    const headers = await flyAuth(ctx, acc);
    const machines = await rest<{ id: string; config: object }[]>('Fly.io', `${FLY_API}/apps/${encodeURIComponent(app)}/machines`, { headers });
    for (const m of machines) {
      await rest('Fly.io', `${FLY_API}/apps/${encodeURIComponent(app)}/machines/${m.id}`, { headers, body: { config: m.config, ...(secretsVersion !== undefined && { min_secrets_version: secretsVersion }) } });
      await new Promise((r) => setTimeout(r, 1100)); // Fly allows about one update a second
    }
    return machines.length;
  },
  async addDomain(ctx: Ctx, acc: string, app: string, domain: string): Promise<DnsRec[]> {
    const r = await rest<{ dns_requirements?: { a?: string[]; cname?: string; ownership?: { name: string; app_value: string } } }>('Fly.io', `${FLY_API}/apps/${encodeURIComponent(app)}/certificates/acme`, { headers: await flyAuth(ctx, acc), body: { hostname: domain } });
    const req = r.dns_requirements ?? {};
    const apex = await isApex(domain);
    // ponytail: the IPv4 record only; an AAAA to the app's v6 address would also work, add it when Unit7's checks speak IPv6
    if (apex && !req.a?.length) throw new Unit7Error('fly_error', `${app} has no public IPv4 address for a bare domain. Run: fly ips allocate-v4 --shared -a ${app}`, 409);
    if (!apex && !req.cname) throw new Unit7Error('fly_error', 'Fly.io didn\u2019t say where the domain should point yet. Try again in a minute.', 409);
    return [
      apex ? { type: 'A', name: domain, content: req.a![0]! } : { type: 'CNAME', name: domain, content: req.cname!.replace(/\.$/, '') },
      ...(req.ownership ? [{ type: 'TXT' as const, name: req.ownership.name.replace(/\.$/, ''), content: req.ownership.app_value }] : []),
    ];
  },
  async recentLines(ctx: Ctx, acc: string, app: string, since: Date) {
    const out: { at: string; text: string; level?: string }[] = [];
    let token = String(BigInt(since.getTime()) * 1_000_000n);
    for (let page = 0; page < 5; page++) {
      const r = await rest<{ data: { attributes: { timestamp: string; message: string; level?: string } }[]; meta?: { next_token?: string } }>('Fly.io', `https://api.fly.io/api/v1/apps/${encodeURIComponent(app)}/logs?next_token=${token}`, { headers: await flyAuth(ctx, acc) });
      out.push(...r.data.map((d) => ({ at: d.attributes.timestamp, text: d.attributes.message, level: d.attributes.level })));
      if (!r.data.length || !r.meta?.next_token || r.meta.next_token === token) break;
      token = r.meta.next_token;
    }
    return out;
  },
  check: async (ctx: Ctx, acc: string, app: string, domain: string) => { await rest('Fly.io', `${FLY_API}/apps/${encodeURIComponent(app)}/certificates/${encodeURIComponent(domain)}/check`, { method: 'POST', headers: await flyAuth(ctx, acc), body: {} }).catch(() => undefined); },
};

// --- DigitalOcean listings ---------------------------------------------------------------------------
async function doList<T>(ctx: Ctx, acc: string, path: string, field: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await rest<Record<string, any>>('DigitalOcean', `${DO()}${path}${path.includes('?') ? '&' : '?'}per_page=200&page=${page}`, { headers: await doAuth(ctx, acc) });
    out.push(...(r[field] ?? []));
    if (!r.links?.pages?.next) break;
  }
  return out;
}
export const digitalocean = {
  droplets: (ctx: Ctx, acc: string) => doList<{ id: number; name: string; status: string; networks: { v4: { ip_address: string; type: string }[] } }>(ctx, acc, '/droplets', 'droplets'),
  apps: (ctx: Ctx, acc: string) => doList<{ id: string; spec: { name: string; services?: { envs?: { key: string; value?: string }[] }[]; static_sites?: { envs?: { key: string; value?: string }[] }[]; envs?: { key: string; value?: string }[] }; default_ingress?: string; domains?: { spec: { domain: string } }[]; active_deployment?: { phase: string } }>(ctx, acc, '/apps', 'apps'),
  databases: async (ctx: Ctx, acc: string) => (await rest<{ databases?: { id: string; name: string; engine: string; status: string; connection?: { host?: string }; private_connection?: { host?: string } }[] }>('DigitalOcean', `${DO()}/databases`, { headers: await doAuth(ctx, acc) })).databases ?? [],
  domains: (ctx: Ctx, acc: string) => doList<{ name: string }>(ctx, acc, '/domains', 'domains'),
  records: (ctx: Ctx, acc: string, zone: string) => doList<{ type: string; name: string; data: string }>(ctx, acc, `/domains/${zone}/records`, 'domain_records'),
  monthToDate: async (ctx: Ctx, acc: string) => Number((await rest<{ month_to_date_usage?: string }>('DigitalOcean', `${DO()}/customers/my/balance`, { headers: await doAuth(ctx, acc) })).month_to_date_usage ?? 0),
  async recentLines(ctx: Ctx, acc: string, appId: string, since: Date) {
    const r = await rest<{ historic_urls?: string[] }>('DigitalOcean', `${DO()}/apps/${appId}/logs?type=RUN&follow=false`, { headers: await doAuth(ctx, acc) });
    if (!r.historic_urls?.[0]) return [];
    const text = await (await fetch(r.historic_urls[0], { signal: AbortSignal.timeout(20_000) })).text();
    // "<component> <timestamp> <message>"
    return text.split('\n').map((l) => { const [, at = '', ...rest] = l.split(' '); return { at, text: rest.join(' ') }; })
      .filter((l) => !Number.isNaN(Date.parse(l.at)) && Date.parse(l.at) > since.getTime());
  },
};

export { hostOf };

// --- removing (asset.delete, people only after typing the name) ---------------------------------------
// Each is the provider's own delete call, checked against its API reference (2026-10). Reads first where the
// delete would take data with it (Fly volumes, Heroku add-ons, a Render disk), so Unit7 can say so before.
export const hostRemoval = {
  netlifySite: async (ctx: Ctx, acc: string, site: string) => rest('Netlify', `${NETLIFY}/sites/${encodeURIComponent(site)}`, { method: 'DELETE', headers: await nl(ctx, acc) }),
  renderService: async (ctx: Ctx, acc: string, id: string) => rest('Render', `${RENDER}/services/${encodeURIComponent(id)}`, { method: 'DELETE', headers: await rn(ctx, acc) }),
  renderPostgres: async (ctx: Ctx, acc: string, id: string) => rest('Render', `${RENDER}/postgres/${encodeURIComponent(id)}`, { method: 'DELETE', headers: await rn(ctx, acc) }),
  renderDisk: async (ctx: Ctx, acc: string, id: string) => (await rest<{ serviceDetails?: { disk?: { name?: string; sizeGB?: number } } }>('Render', `${RENDER}/services/${encodeURIComponent(id)}`, { headers: await rn(ctx, acc) })).serviceDetails?.disk,
  // serviceDelete(id, environmentId) removes it from one environment; projectDelete takes the whole project with its volumes
  railwayService: (ctx: Ctx, acc: string, service: string, environment: string) => rw<{ serviceDelete: boolean }>(ctx, acc, 'mutation($id: String!, $e: String) { serviceDelete(id: $id, environmentId: $e) }', { id: service, e: environment }),
  railwayProject: (ctx: Ctx, acc: string, project: string) => rw<{ projectDelete: boolean }>(ctx, acc, 'mutation($id: String!) { projectDelete(id: $id) }', { id: project }),
  // what's in a Railway project right now: its services, and its volumes with the services each is mounted on (the
  // fresh read that decides whether the whole project may go)
  railwayContents: async (ctx: Ctx, acc: string, project: string) => {
    const r = await rw<{ project?: { services?: { edges: { node: { id: string } }[] }; volumes?: { edges: { node: { name: string; volumeInstances?: { edges: { node: { serviceId?: string | null } }[] } } }[] } } }>(ctx, acc,
      'query($id: String!) { project(id: $id) { services { edges { node { id } } } volumes { edges { node { name volumeInstances { edges { node { serviceId } } } } } } } }', { id: project });
    if (!r?.project?.services || !r.project.volumes) throw new Unit7Error('railway_error', 'Railway didn’t say what’s in the project.', 502);
    return {
      services: r.project.services.edges.map((e) => e.node.id),
      volumes: r.project.volumes.edges.map((e) => ({ name: e.node.name, services: (e.node.volumeInstances?.edges ?? []).map((x) => x.node.serviceId).filter((x): x is string => !!x) })),
    };
  },
  // DELETE /apps/{app} (200) destroys the add-ons the app owns, Heroku Postgres included
  herokuApp: async (ctx: Ctx, acc: string, app: string) => rest('Heroku', `${HEROKU}/apps/${encodeURIComponent(app)}`, { method: 'DELETE', headers: await hk(ctx, acc) }),
  // DELETE /v1/apps/{app}?force=true (202): its machines, volumes and their snapshots, addresses and secrets. Forced only
  // when the person also chose to delete its data; otherwise Fly.io's own checks stay in the way
  flyApp: async (ctx: Ctx, acc: string, app: string, force = false) => rest('Fly.io', `${FLY_API}/apps/${encodeURIComponent(app)}${force ? '?force=true' : ''}`, { method: 'DELETE', headers: await flyAuth(ctx, acc) }),
  flyVolumes: async (ctx: Ctx, acc: string, app: string) => rest<{ id: string; name: string; size_gb?: number; state?: string }[]>('Fly.io', `${FLY_API}/apps/${encodeURIComponent(app)}/volumes`, { headers: await flyAuth(ctx, acc) }),
};

// for the scanners' database sizes (discovery/scanners.ts): Railway's GraphQL with this account's own headers, Render's REST
export { rw as railwayQuery, RENDER as RENDER_API, rn as renderAuth };

// --- deploy history, restore / rollback and a new build (cloud.redeploy) ------------------------------------------
// Netlify, checked against its OpenAPI spec (open-api.netlify.com/swagger.json), 2026-10-08:
//   GET  /sites/{site_id}                      published_deploy is the live one (getSite)
//   GET  /sites/{site_id}/deploys?production=true&state=ready   (listSiteDeploys)
//   GET  /sites/{site_id}/deploys/{deploy_id}  (getSiteDeploy)
//   POST /sites/{site_id}/deploys/{deploy_id}/restore (201)     puts that deploy live again, no rebuild (restoreSiteDeploy)
//   POST /sites/{site_id}/builds               a new build of the production branch; answers its deploy_id (createSiteBuild)
// Render, checked against api-docs.render.com, 2026-10-08:
//   GET  /services/{id}/deploys?limit=        [{ deploy, cursor }], newest first (list-deploys)
//   GET  /services/{id}/deploys/{deployId}    status: live, deactivated (was live), build_failed, … (retrieve-deploy)
//   POST /services/{id}/rollback { deployId } (201) the deploy's build again; auto-deploys stay on (rollback-deploy)
//   POST /services/{id}/deploys               (201 the deploy, or 202 queued) a new build of the latest commit (create-deploy)
const NETLIFY_API = () => process.env.UNIT7_NETLIFY_API ?? NETLIFY; // overridable for offline tests
const RENDER_DEPLOY_API = () => process.env.UNIT7_RENDER_API ?? RENDER;
export interface NetlifyDeploy { id: string; state?: string; context?: string; published_at?: string | null; error_message?: string | null }
export const netlifyDeploys = {
  live: async (ctx: Ctx, acc: string, site: string) => (await rest<NetlifySite>('Netlify', `${NETLIFY_API()}/sites/${encodeURIComponent(site)}`, { headers: await nl(ctx, acc) })).published_deploy?.id,
  list: async (ctx: Ctx, acc: string, site: string) => rest<NetlifyDeploy[]>('Netlify', `${NETLIFY_API()}/sites/${encodeURIComponent(site)}/deploys?production=true&state=ready&per_page=20`, { headers: await nl(ctx, acc) }),
  get: async (ctx: Ctx, acc: string, site: string, id: string) => rest<NetlifyDeploy>('Netlify', `${NETLIFY_API()}/sites/${encodeURIComponent(site)}/deploys/${encodeURIComponent(id)}`, { headers: await nl(ctx, acc) }),
  restore: async (ctx: Ctx, acc: string, site: string, id: string) => rest<NetlifyDeploy>('Netlify', `${NETLIFY_API()}/sites/${encodeURIComponent(site)}/deploys/${encodeURIComponent(id)}/restore`, { method: 'POST', headers: await nl(ctx, acc), body: {} }),
  build: async (ctx: Ctx, acc: string, site: string) => rest<{ id: string; deploy_id?: string }>('Netlify', `${NETLIFY_API()}/sites/${encodeURIComponent(site)}/builds`, { method: 'POST', headers: await nl(ctx, acc), body: {} }),
};
export interface RenderDeploy { id: string; status?: string; createdAt?: string; finishedAt?: string | null }
export const renderDeploys = {
  list: async (ctx: Ctx, acc: string, id: string) => (await rest<{ deploy: RenderDeploy }[]>('Render', `${RENDER_DEPLOY_API()}/services/${encodeURIComponent(id)}/deploys?limit=20`, { headers: await rn(ctx, acc) })).map((d) => d.deploy),
  get: async (ctx: Ctx, acc: string, id: string, deploy: string) => rest<RenderDeploy>('Render', `${RENDER_DEPLOY_API()}/services/${encodeURIComponent(id)}/deploys/${encodeURIComponent(deploy)}`, { headers: await rn(ctx, acc) }),
  rollback: async (ctx: Ctx, acc: string, id: string, deploy: string) => rest<RenderDeploy>('Render', `${RENDER_DEPLOY_API()}/services/${encodeURIComponent(id)}/rollback`, { method: 'POST', headers: await rn(ctx, acc), body: { deployId: deploy } }),
  deploy: async (ctx: Ctx, acc: string, id: string) => rest<Partial<RenderDeploy>>('Render', `${RENDER_DEPLOY_API()}/services/${encodeURIComponent(id)}/deploys`, { method: 'POST', headers: await rn(ctx, acc), body: {} }),
};
