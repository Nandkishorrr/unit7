// The clouds your apps also live on. Vercel over its REST API (its MCP server can read, not write
// settings); Supabase and Neon over their own MCP servers, signed in with one click. Every call goes
// through the broker: tokens come from the vault and the AI never sees them.
import type { Ctx } from '../tools/runtime.ts';
import { Unit7Error } from '../errors.ts';
import { assertReachable } from '../netguard.ts';
import { bearerFor, isOAuthAccount, oauthMcp } from './mcp-oauth.ts';

// --- MCP: call a provider's tool and get its JSON back ------------------------------------------------

export async function mcpJson<T = any>(ctx: Ctx, accountId: string, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const { client, tools } = oauthMcp(ctx, accountId);
  const name = (await tools()).find((t) => t.name === tool || t.name.endsWith(`_${tool}`) || t.name.endsWith(`.${tool}`))?.name;
  if (!name) throw new Unit7Error('unsupported', `This account's connector has no "${tool}" tool.`, 501);
  const r = await client.callTool(name, args, 60_000);
  if (r.isError) throw new Unit7Error('provider_error', r.text.slice(0, 300) || `${tool} failed.`, 502);
  const structured = (r.raw as { structuredContent?: T } | undefined)?.structuredContent;
  if (structured) return structured;
  try { return JSON.parse(r.text) as T; } catch { return r.text as T; }
}

// --- Supabase --------------------------------------------------------------------------------------

// Supabase: its MCP server for one-click sign-ins; its Management API for a personal access token (which
// also covers what the sign-in can't: custom domains, server keys)
const SUPABASE_API = 'https://api.supabase.com/v1';
const viaToken = (ctx: Ctx, acc: string) => !isOAuthAccount(ctx.credentialFor('supabase', acc).account.meta);
async function sb<T = any>(ctx: Ctx, acc: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await bearerFor(ctx, 'supabase', acc);
  await assertReachable('api.supabase.com');
  const res = await fetch(`${SUPABASE_API}${path}`, { method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({})) as { message?: string };
  if (res.status === 401 || res.status === 403) throw new Unit7Error('supabase_auth', `Supabase refused (${data.message ?? res.status}). Custom domains and server keys need a Supabase access token: Connections → Supabase → Use a key instead.`, 403);
  if (!res.ok) throw new Unit7Error('supabase_error', `Supabase: ${data.message ?? res.statusText}`, 502);
  return data as T;
}

export const supabase = {
  projects: async (ctx: Ctx, acc: string) => viaToken(ctx, acc)
    ? (await sb<{ ref: string; name: string; region?: string; status?: string }[]>(ctx, acc, '/projects')).map((p) => ({ id: p.ref, name: p.name, region: p.region, status: p.status }))
    : mcpJson<{ projects: { id: string; name: string; region?: string; status?: string }[] }>(ctx, acc, 'list_projects').then((r) => r.projects ?? []),
  url: async (ctx: Ctx, acc: string, ref: string) => viaToken(ctx, acc) ? `https://${ref}.supabase.co` : mcpJson<{ url: string }>(ctx, acc, 'get_project_url', { project_id: ref }).then((r) => r.url),
  // the browser-safe key: the legacy anon key where it's still on (every supabase-js reads it), else the newer publishable one
  async publicKey(ctx: Ctx, acc: string, ref: string) {
    const keys = (viaToken(ctx, acc)
      ? (await sb<{ name: string; api_key: string | null; type: 'legacy' | 'publishable' | 'secret' }[]>(ctx, acc, `/projects/${ref}/api-keys`)).filter((k) => k.api_key && (k.type === 'publishable' || k.name === 'anon')).map((k) => ({ api_key: k.api_key!, type: k.type as 'legacy' | 'publishable', disabled: false }))
      : (await mcpJson<{ keys: { api_key: string; type: 'legacy' | 'publishable'; disabled?: boolean }[] }>(ctx, acc, 'get_publishable_keys', { project_id: ref })).keys).filter((k) => !k.disabled);
    const k = keys.find((x) => x.type === 'legacy') ?? keys.find((x) => x.type === 'publishable');
    if (!k) throw new Unit7Error('no_key', 'That Supabase project has no enabled public key.', 409);
    return { anon: k.api_key, publishable: keys.find((x) => x.type === 'publishable')?.api_key ?? k.api_key };
  },
  // a custom domain for the project's API and auth (a paid add-on; subdomains only): the CNAME plus the
  // TXT records Supabase checks ownership and issues the certificate with
  async addDomain(ctx: Ctx, acc: string, ref: string, hostname: string) {
    const r = await sb<{ data?: { result?: { ssl?: { validation_records?: { txt_name: string; txt_value: string }[] }; ownership_verification?: { type: string; name: string; value: string } } } }>(ctx, acc, `/projects/${ref}/custom-hostname/initialize`, { body: { custom_hostname: hostname } });
    const res = r.data?.result;
    return [
      { type: 'CNAME' as const, name: hostname, content: `${ref}.supabase.co` },
      ...(res?.ssl?.validation_records ?? []).map((v) => ({ type: 'TXT' as const, name: v.txt_name.replace(/\.$/, ''), content: v.txt_value })),
      ...(res?.ownership_verification?.type?.toLowerCase() === 'txt' ? [{ type: 'TXT' as const, name: res.ownership_verification.name.replace(/\.$/, ''), content: res.ownership_verification.value }] : []),
    ];
  },
  // once DNS is live: Supabase re-checks, then switches the domain on
  async confirmDomain(ctx: Ctx, acc: string, ref: string) {
    const r = await sb<{ status: string }>(ctx, acc, `/projects/${ref}/custom-hostname/reverify`, { method: 'POST' }).catch(() => undefined);
    if (r && /^[34]_/.test(r.status)) await sb(ctx, acc, `/projects/${ref}/custom-hostname/activate`, { method: 'POST' }).catch(() => undefined);
  },
  // server-side keys aren't in Supabase's MCP; its sign-in token is issued for the Management API too
  async secretKeys(ctx: Ctx, acc: string, ref: string) {
    const token = await bearerFor(ctx, 'supabase', acc);
    await assertReachable('api.supabase.com');
    const res = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Unit7Error('supabase_error', `Supabase said ${res.status}`, 502);
    const keys = await res.json() as { name: string; type: string; api_key: string }[];
    const serviceRole = keys.find((k) => k.type === 'legacy' && k.name === 'service_role')?.api_key;
    const secret = keys.find((k) => k.type === 'secret')?.api_key;
    if (!serviceRole && !secret) throw new Unit7Error('no_key', 'That project has no server key.', 409);
    for (const k of [serviceRole, secret]) if (k) ctx.redactor.add(k, 'supabase server key');
    return { serviceRole, secret };
  },
};

// --- Neon --------------------------------------------------------------------------------------------

export const neon = {
  projects: (ctx: Ctx, acc: string) => mcpJson<{ projects?: { id: string; name: string }[] } | { id: string; name: string }[]>(ctx, acc, 'list_projects')
    .then((r) => (Array.isArray(r) ? r : r.projects ?? [])),
  // its compute endpoints' hosts (and their pooled twins), to recognise its connection strings
  async hosts(ctx: Ctx, acc: string, projectId: string) {
    const r = await mcpJson<unknown>(ctx, acc, 'list_postgres_endpoints', { project_id: projectId });
    const hs = [...new Set([...(typeof r === 'string' ? r : JSON.stringify(r)).matchAll(/ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech/g)].map((m) => m[0].toLowerCase()))];
    return hs.flatMap((h) => [h, h.replace(/^(ep-[^.]+?)(-pooler)?\./, '$1-pooler.')]);
  },
  async connectionString(ctx: Ctx, acc: string, projectId: string) {
    const r = await mcpJson<unknown>(ctx, acc, 'get_connection_string', { projectId });
    const s = typeof r === 'string' ? r : JSON.stringify(r);
    const url = /postgres(?:ql)?:\/\/[^\s"'`]+/.exec(s)?.[0];
    if (!url) throw new Unit7Error('provider_error', 'Neon did not return a connection string.', 502);
    return url;
  },
};

// --- Vercel ------------------------------------------------------------------------------------------

const VERCEL = () => process.env.UNIT7_VERCEL_API ?? 'https://api.vercel.com'; // overridable for offline tests
async function vc<T = any>(ctx: Ctx, acc: string, path: string, o: { method?: string; body?: unknown; team?: string; query?: Record<string, string> } = {}): Promise<T> {
  const token = await bearerFor(ctx, 'vercel', acc);
  await assertReachable(new URL(VERCEL()).hostname);
  const q = new URLSearchParams({ ...(o.team && { teamId: o.team }), ...o.query });
  const res = await fetch(`${VERCEL()}${path}${q.size ? `?${q}` : ''}`, {
    method: o.method ?? (o.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({})) as { error?: { message?: string; code?: string } };
  if (res.status === 401 || res.status === 403) {
    throw new Unit7Error('vercel_auth', `Vercel refused Unit7 (${data.error?.message ?? res.status}). In Connections, add a Vercel token (Vercel → Account settings → Tokens) and Unit7 uses that instead.`, 403);
  }
  if (!res.ok) throw new Unit7Error('vercel_error', `Vercel: ${data.error?.message ?? res.statusText}`, 502);
  return data as T;
}

export interface VercelProject { id: string; name: string; framework?: string | null; team?: string; owner?: string; repo?: string; productionDeployment?: string; productionUrl?: string }
const toProject = (p: any, team?: string): VercelProject => {
  const prod = p.targets?.production;
  return { id: p.id, name: p.name, framework: p.framework, team, owner: p.accountId, repo: p.link?.type === 'github' && p.link.org ? `${p.link.org}/${p.link.repo}` : undefined,
    productionDeployment: prod?.id, productionUrl: prod?.alias?.[0] ? `https://${prod.alias[0]}` : undefined };
};

export const vercel = {
  whoami: (ctx: Ctx, acc: string) => vc<{ user?: { username?: string } }>(ctx, acc, '/v2/user').then((r) => ({ user: r.user?.username, label: r.user?.username })),
  // every project you can reach: your own and each team's
  async projects(ctx: Ctx, acc: string): Promise<VercelProject[]> {
    const teams = await vc<{ teams?: { id: string }[] }>(ctx, acc, '/v2/teams').then((r) => r.teams ?? [], () => []);
    const out: VercelProject[] = [];
    for (const team of [undefined, ...teams.map((t) => t.id)]) {
      const r = await vc<{ projects: any[] }>(ctx, acc, '/v10/projects', { team, query: { limit: '100' } }).catch(() => ({ projects: [] }));
      for (const p of r.projects) if (!out.some((x) => x.id === p.id)) out.push(toProject(p, team));
    }
    return out;
  },
  async project(ctx: Ctx, acc: string, idOrName: string, team?: string): Promise<VercelProject> {
    return toProject(await vc<any>(ctx, acc, `/v9/projects/${encodeURIComponent(idOrName)}`, { team }), team);
  },
  projectDomains: (ctx: Ctx, acc: string, project: string, team?: string) =>
    vc<{ domains?: { name: string; verified: boolean }[] }>(ctx, acc, `/v9/projects/${encodeURIComponent(project)}/domains`, { team, query: { limit: '100' } }).then((r) => r.domains ?? []),
  // values too (not "sensitive" ones: Vercel never returns those). The map reads hostnames out of them in memory; nothing is kept.
  envValues: (ctx: Ctx, acc: string, project: string, team?: string) =>
    vc<{ envs: { key: string; value?: string }[] }>(ctx, acc, `/v10/projects/${encodeURIComponent(project)}/env`, { team, query: { decrypt: 'true' } })
      .then((r) => { const out: Record<string, string> = {}; for (const e of r.envs ?? []) { out[e.key] = e.value ?? ''; if (e.value && e.value.length >= 6) ctx.redactor.add(e.value, `vercel env ${e.key}`); } return out; }),
  // domains whose DNS Vercel serves, with their records, across your own account and each team
  async dnsZones(ctx: Ctx, acc: string) {
    const teams = await vc<{ teams?: { id: string }[] }>(ctx, acc, '/v2/teams').then((r) => r.teams ?? [], () => []);
    const out: { zone: string; team?: string; records: { name: string; type: string; value: string }[] }[] = [];
    const registered: { name: string; expiresAt: number; renew?: boolean }[] = []; // domains bought through Vercel
    for (const team of [undefined, ...teams.map((t) => t.id)]) {
      const { domains = [] } = await vc<{ domains?: { name: string; serviceType: string; expiresAt?: number | null; renew?: boolean }[] }>(ctx, acc, '/v5/domains', { team, query: { limit: '100' } }).catch(() => ({ domains: [] }));
      for (const d of domains) if (d.expiresAt && !registered.some((r) => r.name === d.name)) registered.push({ name: d.name, expiresAt: d.expiresAt, renew: d.renew });
      for (const d of domains.filter((x) => x.serviceType === 'zeit.world' && !out.some((o) => o.zone === x.name))) {
        const r = await vc<{ records?: { name: string; type: string; value: string }[] }>(ctx, acc, `/v5/domains/${encodeURIComponent(d.name)}/records`, { team, query: { limit: '100' } }).catch(() => ({ records: [] }));
        out.push({ zone: d.name, team, records: r.records ?? [] });
      }
    }
    return Object.assign(out, { registered });
  },
  // names only (and plain values): Vercel never returns sensitive values, and Unit7 doesn't need them
  env: (ctx: Ctx, acc: string, project: string, team?: string) =>
    vc<{ envs: { key: string; value?: string; type: string; target?: string[] }[] }>(ctx, acc, `/v10/projects/${encodeURIComponent(project)}/env`, { team }).then((r) => r.envs ?? []),
  setEnv: (ctx: Ctx, acc: string, project: string, team: string | undefined, vars: { key: string; value: string; secret: boolean }[]) =>
    vc(ctx, acc, `/v10/projects/${encodeURIComponent(project)}/env`, { team, query: { upsert: 'true' },
      body: vars.map((v) => ({ key: v.key, value: v.value, type: v.secret ? 'encrypted' : 'plain', target: ['production', 'preview', 'development'], comment: 'Set by Unit7 (a connection)' })) }),
  // a new build of what's live now, so it picks up new settings
  redeploy: (ctx: Ctx, acc: string, p: VercelProject) =>
    vc<{ id: string; url: string }>(ctx, acc, '/v13/deployments', { team: p.team, query: { forceNew: '1' }, body: { name: p.name, project: p.id, deploymentId: p.productionDeployment, target: 'production' } }),
  async addDomain(ctx: Ctx, acc: string, project: string, team: string | undefined, domain: string) {
    await vc(ctx, acc, `/v10/projects/${encodeURIComponent(project)}/domains`, { team, body: { name: domain } }).catch((e: Unit7Error) => {
      if (!/already|exists/i.test(e.message)) throw e; // already on this project is fine
    });
    return vercel.domainStatus(ctx, acc, project, team, domain);
  },
  // what DNS should say for this domain (Vercel's recommendation), and any ownership TXT it wants first
  async domainStatus(ctx: Ctx, acc: string, project: string, team: string | undefined, domain: string) {
    const [pd, cfg] = await Promise.all([
      vc<{ verified: boolean; verification?: { type: string; domain: string; value: string }[]; apexName: string }>(ctx, acc, `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`, { team }),
      vc<{ misconfigured: boolean; recommendedIPv4?: { rank: number; value: string[] }[]; recommendedCNAME?: { rank: number; value: string }[] }>(ctx, acc, `/v6/domains/${encodeURIComponent(domain)}/config`, { team, query: { projectIdOrName: project } }),
    ]);
    const best = <T extends { rank: number }>(xs?: T[]) => xs?.slice().sort((a, b) => a.rank - b.rank)[0];
    const apex = pd.apexName === domain;
    // Vercel's values differ per project now (a pool IP, <hash>.vercel-dns-0NN.com); never guess them
    const ip = best(cfg.recommendedIPv4)?.value[0], cname = best(cfg.recommendedCNAME)?.value;
    if (apex ? !ip : !cname) throw new Unit7Error('vercel_pending', `Vercel hasn't said which DNS records ${domain} needs yet. Try again in a minute.`, 409);
    const records = apex ? [{ type: 'A' as const, name: domain, content: ip! }] : [{ type: 'CNAME' as const, name: domain, content: cname!.replace(/\.$/, '') }];
    const proof = (pd.verification ?? []).filter((v) => v.type === 'TXT').map((v) => ({ type: 'TXT' as const, name: v.domain, content: v.value }));
    return { verified: pd.verified, misconfigured: cfg.misconfigured, records, proof };
  },
  // one project domain sends visitors to another (PATCH /v9/projects/{idOrName}/domains/{domain}: redirect,
  // redirectStatusCode 301/302/307/308); null makes it serve the project again
  redirectDomain: (ctx: Ctx, acc: string, project: string, team: string | undefined, domain: string, to: string | null) =>
    vc(ctx, acc, `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`, { team, method: 'PATCH', body: { redirect: to, redirectStatusCode: to ? 301 : null } }),
  // Vercel as a DNS host (nameservers ns1/ns2.vercel-dns.com): which of your teams holds the zone
  async dnsTeam(ctx: Ctx, acc: string, zone: string): Promise<{ team?: string } | undefined> {
    const teams = await vc<{ teams?: { id: string }[] }>(ctx, acc, '/v2/teams').then((r) => r.teams ?? [], () => []);
    for (const team of [undefined, ...teams.map((t) => t.id)]) if (await vc(ctx, acc, `/v5/domains/${encodeURIComponent(zone)}`, { team }).then(() => true, () => false)) return { team };
    return undefined;
  },
  // ponytail: reads the first 100 records; page through if a zone ever holds more
  async upsertDns(ctx: Ctx, acc: string, zone: string, team: string | undefined, r: { type: string; name: string; value: string; ttl: number }) {
    const { records } = await vc<{ records: { id: string; name: string; type: string }[] }>(ctx, acc, `/v5/domains/${encodeURIComponent(zone)}/records`, { team, query: { limit: '100' } });
    const hit = records.find((x) => x.name === r.name && x.type === r.type);
    if (hit) await vc(ctx, acc, `/v1/domains/records/${hit.id}`, { team, method: 'PATCH', body: { value: r.value, ttl: r.ttl } });
    else await vc(ctx, acc, `/v2/domains/${encodeURIComponent(zone)}/records`, { team, body: r });
  },
  // this month's charges (Vercel's billing export, one JSON row per line), summed, for each team the token reaches
  async spentThisMonth(ctx: Ctx, acc: string) {
    const token = await bearerFor(ctx, 'vercel', acc);
    const teams = await vc<{ teams?: { id: string; name?: string }[] }>(ctx, acc, '/v2/teams').then((r) => r.teams ?? [], () => []);
    const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString(), to = new Date(Date.now() + 86400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    await assertReachable(new URL(VERCEL()).hostname);
    const out: { team: string; usd: number }[] = [];
    for (const t of [undefined, ...teams]) {
      const q = new URLSearchParams({ from, to, ...(t && { teamId: t.id }) });
      const res = await fetch(`${VERCEL()}/v1/billing/charges?${q}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue; // no billing access for this team
      const usd = (await res.text()).split('\n').filter(Boolean).reduce((sum, line) => { try { return sum + Number(JSON.parse(line).BilledCost ?? 0); } catch { return sum; } }, 0);
      if (usd) out.push({ team: t?.name ?? 'personal', usd });
    }
    return out;
  },
  // Production error logs over a window. Vercel's documented API only streams live logs, so this uses the
  // request-logs endpoint its own CLI uses (not in the public API); a refusal means "not available here".
  async errorLines(ctx: Ctx, acc: string, project: string, team: string | undefined, since: Date) {
    const p = await vercel.project(ctx, acc, project, team);
    const q = new URLSearchParams({ projectId: p.id, ownerId: p.owner ?? team ?? '', startDate: String(since.getTime()), endDate: String(Date.now()), environment: 'production', level: 'error,fatal', page: '0' });
    const token = await bearerFor(ctx, 'vercel', acc);
    await assertReachable('vercel.com');
    const res = await fetch(`https://vercel.com/api/logs/request-logs?${q}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Unit7Error('unsupported', `Vercel didn\u2019t share logs with this token (${res.status}).`, 501);
    const r = await res.json() as { rows?: { timestamp: string; requestPath?: string; statusCode?: number; logs?: { level: string; message: string }[] }[] };
    return (r.rows ?? []).flatMap((row) => (row.logs?.length ? row.logs.filter((l) => /error|fatal/i.test(l.level)).map((l) => ({ at: row.timestamp, text: l.message })) : [{ at: row.timestamp, text: `HTTP ${row.statusCode} on ${row.requestPath}` }]));
  },
  verify: (ctx: Ctx, acc: string, project: string, team: string | undefined, domain: string) =>
    vc<{ verified: boolean }>(ctx, acc, `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}/verify`, { team, method: 'POST' }).then((r) => r.verified, () => false),
};

// --- removing (asset.delete, people only after typing the name; asset.pause) -----------------------------
// Each is the provider's own call, checked against its API reference (2026-10). Nothing else here changes.
const NEON_API = () => process.env.UNIT7_NEON_API ?? 'https://console.neon.tech/api/v2';
export const cloudRemoval = {
  // DELETE /v9/projects/{id} (204): its deployments, domains on it, settings. Storage stores are separate and stay.
  vercelProject: (ctx: Ctx, acc: string, project: string, team?: string) => vc(ctx, acc, `/v9/projects/${encodeURIComponent(project)}`, { method: 'DELETE', team }),
  // POST /v1/projects/{ref}/pause (200): stops it, keeps everything; DELETE /v1/projects/{ref} (200): gone, data too
  supabasePause: (ctx: Ctx, acc: string, ref: string) => sb(ctx, acc, `/projects/${encodeURIComponent(ref)}/pause`, { method: 'POST' }),
  supabaseProject: (ctx: Ctx, acc: string, ref: string) => sb(ctx, acc, `/projects/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
  // DELETE /api/v2/projects/{id} (200): every branch, database and role; Neon can recover it for 7 days
  async neonProject(ctx: Ctx, acc: string, project: string) {
    const token = await bearerFor(ctx, 'neon', acc);
    await assertReachable(new URL(NEON_API()).hostname);
    const res = await fetch(`${NEON_API()}/projects/${encodeURIComponent(project)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    const data = await res.json().catch(() => ({})) as { message?: string };
    if (!res.ok) throw new Unit7Error(res.status === 404 ? 'not_found_there' : 'neon_error', `Neon: ${data.message ?? res.statusText}`, res.status === 401 || res.status === 403 ? 403 : res.status === 404 ? 404 : 502);
    return data;
  },
};

// --- Vercel deploy history, rollback and promote (cloud.redeploy). Checked against Vercel's REST reference, 2026-10-08:
//   GET  /v7/deployments?projectId&target=production       vercel.com/docs/rest-api/deployments/list-deployments
//   GET  /v13/deployments/{id}                              vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url
//   POST /v1/projects/{id}/rollback/{deploymentId} (201)    vercel.com/docs/rest-api/projects/point-production-traffic-to-a-previous-production-deployment-by-id
//   POST /v10/projects/{id}/promote/{deploymentId}          vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment
// A rollback turns off auto-assigning production domains (new pushes stay off the live site); promoting a deployment
// undoes that (vercel.com/docs/instant-rollback#undo-a-rollback), so Undo promotes. Each passes the team id (teamId).
export interface VercelDeployment { uid: string; readyState?: string; state?: string; created?: number; url?: string; isRollbackCandidate?: boolean | null }
export const vercelDeploys = {
  list: (ctx: Ctx, acc: string, project: string, team?: string) =>
    vc<{ deployments?: VercelDeployment[] }>(ctx, acc, '/v7/deployments', { team, query: { projectId: project, target: 'production', limit: '20' } }).then((r) => r.deployments ?? []),
  get: (ctx: Ctx, acc: string, id: string, team?: string) => vc<{ id: string; readyState?: string; url?: string }>(ctx, acc, `/v13/deployments/${encodeURIComponent(id)}`, { team }),
  rollback: (ctx: Ctx, acc: string, project: string, id: string, team?: string) =>
    vc(ctx, acc, `/v1/projects/${encodeURIComponent(project)}/rollback/${encodeURIComponent(id)}`, { method: 'POST', team, query: { description: 'Rolled back by Unit7' } }),
  promote: (ctx: Ctx, acc: string, project: string, id: string, team?: string) =>
    vc(ctx, acc, `/v10/projects/${encodeURIComponent(project)}/promote/${encodeURIComponent(id)}`, { method: 'POST', team }),
};
