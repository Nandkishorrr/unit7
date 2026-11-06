// One scanner per provider: list what this account has (apps, databases, servers, domains and their DNS
// records) and what each one points at. Each runs with its own account's token, through the broker.
// Env values are read only to find the hostnames in them; they're never stored or returned.
import { lookup } from 'node:dns/promises';
import { providerTrouble, type Ctx } from '../tools/runtime.ts';
import { all, json } from '../db.ts';
import { merged, resolveValues, parseDotenv } from '../tools/env.ts';
import { internalHost, type ServiceConfig } from '../deploy/deployer.ts';
import { cloudflare } from '../connectors/cloudflare.ts';
import { hostinger } from '../connectors/hostinger.ts';
import { vercel, supabase, neon, SUPABASE_API } from '../connectors/clouds.ts';
import { fileText, githubToken, parseRepo } from '../connectors/github.ts';
import { rest, gd, GODADDY, pb, PORKBUN, nc, NAMECOM } from '../connectors/dnswrite.ts';
import { netlify, render, railway, digitalocean, heroku, fly, hostOf } from '../connectors/hosts.ts';
import { envRefs, domainKey, type Found, type Ref } from './model.ts';
import { xrayFound } from './xray.ts';
import { lastXray, runXray } from '../tools/xray.ts';
import type { ServerRow } from '../connectors/ssh.ts';

// a missing piece is skipped, but a refusal or "slow down" stops the whole scan: the account is then left
// alone instead of being asked once per project, domain and record
const or = <T>(fallback: T) => (e: unknown): T => { if (providerTrouble(e)) throw e; return fallback; };
// settings that couldn't be read are unknown (envKeys left out), never "none": the map doesn't show them as
// empty and autoconnect doesn't write over what may already be there
type Env = Record<string, string> | undefined;
const keysOf = (env: Env) => env && Object.keys(env);

export interface Scan { found: Found[]; refs: Ref[] }
export type Scanner = (ctx: Ctx, accountId: string) => Promise<Scan>;

// run fn over items, n at a time
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}

const DB_KINDS = new Set(['postgres', 'mysql', 'mariadb', 'redis', 'mongo']);
const usesOf = (deps: string[], keys: string[]) => ({
  supabase: deps.some((d) => d.startsWith('@supabase/')) || keys.some((k) => /SUPABASE/.test(k)),
  postgres: deps.some((d) => ['pg', 'postgres', '@neondatabase/serverless', '@prisma/client', 'drizzle-orm', '@vercel/postgres'].includes(d)) || keys.some((k) => /^(DATABASE_URL|POSTGRES_URL)$/.test(k)),
});

// A DNS zone's records as domain nodes + where each points (address records and aliases only)
function zoneScan(found: Found[], refs: Ref[], dnsHost: string, accountId: string, zone: string, records: { name: string; type: string; value: string }[]) {
  for (const r of records) {
    const type = r.type.toUpperCase();
    if (!['A', 'AAAA', 'CNAME', 'ALIAS', 'ANAME'].includes(type)) continue;
    const name = (r.name === '@' || r.name === '' ? zone : r.name.endsWith(zone) ? r.name : `${r.name}.${zone}`).toLowerCase().replace(/\.$/, '');
    if (name.startsWith('_') || name.includes('._domainkey')) continue;
    const value = r.value.toLowerCase().replace(/\.$/, '');
    found.push({ provider: 'domain', kind: 'domain', extId: name, name, accountId, dns: dnsHost, zone });
    refs.push(type === 'A' || type === 'AAAA' ? { from: domainKey(name), kind: 'dns', via: `${type} ${value}`, ip: value } : { from: domainKey(name), kind: 'dns', via: `${type} ${value}`, host: value === '@' ? zone : value });
  }
}

// A domain you own at a registrar: when it runs out and whether it renews by itself
const registration = (found: Found[], registrar: string, accountId: string, domain: string, expires: string | number | undefined, autoRenew?: boolean) => {
  if (!expires) return;
  const at = new Date(typeof expires === 'number' ? expires : expires.replace(' ', 'T'));
  if (Number.isNaN(at.getTime())) return;
  const d = domain.toLowerCase();
  found.push({ provider: 'domain', kind: 'domain', extId: d, name: d, accountId, zone: d, expires: at.toISOString(), autoRenew, registrar });
};

// --- Unit7 itself: servers, apps and databases here ---------------------------------------------------
export async function scanUnit7(ctx: Ctx): Promise<Scan> {
  const found: Found[] = [], refs: Ref[] = [];
  for (const s of all<{ id: string; name: string; host: string; facts: string }>(ctx.db, 'SELECT id, name, host, facts FROM servers WHERE org_id = ?', ctx.orgId)) {
    const ip = json<{ publicIp?: string }>(s.facts, {}).publicIp ?? (/^\d+\.\d+\.\d+\.\d+$/.test(s.host) ? s.host : await lookup(s.host).then((r) => r.address, () => undefined));
    found.push({ provider: 'unit7', kind: 'server', extId: s.id, name: s.name, ips: ip ? [ip] : [], platform: 'unit7' });
  }
  // each of Unit7's databases by where its credentials live (credential://postgres/<db>/), so a setting that references one names it
  const dbOfRef = new Map(all<{ id: string; kind: string; config: string }>(ctx.db, 'SELECT id, kind, config FROM services WHERE org_id = ?', ctx.orgId)
    .filter((d) => DB_KINDS.has(d.kind)).flatMap((d) => { const r = json<{ passwordRef?: string }>(d.config, {}).passwordRef; return r ? [[r.replace(/[^/]+$/, ''), d.id] as const] : []; }));
  for (const s of all<{ id: string; name: string; slug: string; kind: string; environment_id: string; server_id: string | null; config: string }>(ctx.db,
    `SELECT id, name, slug, kind, environment_id, server_id, config FROM services WHERE org_id = ?`, ctx.orgId)) {
    const cfg = json<ServiceConfig>(s.config, {});
    const key = `unit7:${s.id}`;
    const domains = all<{ hostname: string }>(ctx.db, 'SELECT hostname FROM domains WHERE service_id = ?', s.id).map((d) => d.hostname.toLowerCase()).filter((h) => !h.startsWith('*.'));
    const vars = merged(ctx.db, ctx.orgId, { type: 'service', id: s.id, label: '' });
    const envKeys = vars.map((v) => v.key);
    // what Unit7 wired itself: a setting that is one of its databases' addresses names that database, whatever the value says
    for (const v of vars) { const t = v.ref ? dbOfRef.get(v.ref.replace(/[^/]+$/, '')) : undefined; if (t && t !== s.id) refs.push({ from: key, kind: 'env', via: v.key, to: `unit7:${t}` }); }
    const isDb = DB_KINDS.has(s.kind);
    found.push({ provider: 'unit7', kind: isDb ? 'database' : 'app', extId: s.id, name: s.name, url: domains[0] && `https://${domains[0]}`, hosts: [...domains, internalHost(s).toLowerCase()],
      envKeys, reads: cfg.detection?.envKeys, uses: usesOf([], [...(cfg.detection?.envKeys ?? []), ...envKeys]), end: { kind: 'unit7', serviceId: s.id }, platform: 'unit7' });
    if (s.server_id) refs.push({ from: key, kind: 'runs_on', via: 'runs here', to: `unit7:${s.server_id}` });
    for (const d of domains) refs.push({ from: key, kind: 'domain', via: 'routed by Unit7', host: d });
    if (!isDb) { try { refs.push(...envRefs(key, resolveValues(ctx, s.id))); } catch { /* a reference it can't resolve: skip */ } }
  }
  // what's inside each server, from its X-ray: refreshed when the last one is over an hour old (servers never
  // X-rayed wait for someone to open them), the last good one otherwise
  await Promise.all(all<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE org_id = ?', ctx.orgId).map(async (s) => {
    let x = lastXray(ctx.db, ctx.orgId, s.id);
    if (x && Date.now() - Date.parse(x.at) > 3600_000 && !s.ssh_block && !['awaiting_key', 'new'].includes(s.status)) {
      const fresh = await runXray(ctx, s).catch(() => undefined);
      if (fresh && !fresh.stale) x = { at: fresh.at, data: fresh };
    }
    if (!x) return;
    const r = xrayFound(s.id, x.data);
    found.push(...r.found);
    refs.push(...r.refs);
  }));
  return { found, refs };
}

export const SCANNERS: Record<string, Scanner> = {
  // --- Vercel: projects (domains, settings, framework, repo) and Vercel-hosted DNS --------------------
  async vercel(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    await vercel.whoami(ctx, acc); // an expired token fails the scan, instead of looking like an empty account
    const token = await githubToken(ctx).catch(() => undefined);
    await pool(await vercel.projects(ctx, acc), 4, async (p) => {
      const key = `vercel:${p.id}`;
      const [domains, env] = await Promise.all([vercel.projectDomains(ctx, acc, p.id, p.team).catch(or([])), vercel.envValues(ctx, acc, p.id, p.team).catch(or(undefined as Env))]);
      const repo = p.repo ? parseRepo(p.repo) : undefined;
      const pkg = repo ? json<{ dependencies?: object; devDependencies?: object }>(await fileText(repo, 'package.json', token) ?? '{}', {}) : {};
      const names = domains.map((d) => d.name.toLowerCase());
      found.push({ provider: 'vercel', kind: 'app', extId: p.id, name: p.name, accountId: acc, url: names.find((n) => !n.endsWith('.vercel.app')) ? `https://${names.find((n) => !n.endsWith('.vercel.app'))}` : p.productionUrl,
        hosts: [...names, ...(p.productionUrl ? [new URL(p.productionUrl).hostname] : [])], envKeys: keysOf(env), uses: usesOf(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }), keysOf(env) ?? []),
        end: { kind: 'vercel', accountId: acc, project: p.id, ...(p.team && { team: p.team }) }, platform: 'vercel', ...(p.repo && { repo: p.repo }) });
      for (const d of names.filter((n) => !n.endsWith('.vercel.app'))) refs.push({ from: key, kind: 'domain', via: 'added on Vercel', host: d });
      refs.push(...envRefs(key, env ?? {}));
    });
    const zones = await vercel.dnsZones(ctx, acc).catch(or(Object.assign([], { registered: [] })));
    for (const z of zones) zoneScan(found, refs, 'vercel', acc, z.zone, z.records.map((r) => ({ name: r.name, type: r.type, value: r.value })));
    for (const r of zones.registered) registration(found, 'vercel', acc, r.name, r.expiresAt, r.renew);
    return { found, refs };
  },

  // --- Supabase and Neon: databases -----------------------------------------------------------------
  async supabase(ctx, acc) {
    const found = (await supabase.projects(ctx, acc)).map((p): Found => ({ provider: 'supabase', kind: 'database', extId: p.id, name: p.name, accountId: acc, url: `https://supabase.com/dashboard/project/${p.id}`,
      hosts: [`${p.id}.supabase.co`, `db.${p.id}.supabase.co`], status: p.status, end: { kind: 'supabase', accountId: acc, ref: p.id }, platform: 'supabase' }));
    return { found, refs: [] };
  },
  async neon(ctx, acc) {
    const found = await pool(await neon.projects(ctx, acc), 4, async (p): Promise<Found> => ({ provider: 'neon', kind: 'database', extId: p.id, name: p.name, accountId: acc, url: `https://console.neon.tech/app/projects/${p.id}`,
      hosts: await neon.hosts(ctx, acc, p.id).catch(or([])), end: { kind: 'neon', accountId: acc, project: p.id }, platform: 'neon' }));
    return { found, refs: [] };
  },

  // --- Netlify, Render, Railway, DigitalOcean: apps (domains, settings) and databases --------------
  async netlify(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    await pool(await netlify.sites(ctx, acc), 4, async (s) => {
      const key = `netlify:${s.id}`;
      const custom = [s.custom_domain, ...(s.domain_aliases ?? [])].filter(Boolean).map((d) => d!.toLowerCase());
      const env = await netlify.env(ctx, acc, s).catch(or(undefined as Env));
      found.push({ provider: 'netlify', kind: 'app', extId: s.id, name: s.name, accountId: acc, url: s.ssl_url ?? s.url, hosts: [`${s.name}.netlify.app`, ...custom], envKeys: keysOf(env), uses: usesOf([], keysOf(env) ?? []),
        end: { kind: 'netlify', accountId: acc, site: s.id }, platform: 'netlify' });
      refs.push(...custom.map((h): Ref => ({ from: key, kind: 'domain', via: 'added on Netlify', host: h })), ...envRefs(key, env ?? {}));
    });
    return { found, refs };
  },
  async render(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    await pool(await render.services(ctx, acc), 4, async (s) => {
      const key = `render:${s.id}`;
      const [env, domains] = await Promise.all([render.env(ctx, acc, s.id).catch(or(undefined as Env)), render.domains(ctx, acc, s.id).catch(or([]))]);
      const host = hostOf(s.serviceDetails?.url);
      found.push({ provider: 'render', kind: 'app', extId: s.id, name: s.name, accountId: acc, url: s.serviceDetails?.url, hosts: [...(host ? [host] : []), ...domains.map((d) => d.name.toLowerCase())],
        envKeys: keysOf(env), uses: usesOf([], keysOf(env) ?? []), end: { kind: 'render', accountId: acc, service: s.id }, platform: 'render', status: s.suspended === 'suspended' ? 'suspended' : undefined });
      refs.push(...domains.map((d): Ref => ({ from: key, kind: 'domain', via: 'added on Render', host: d.name.toLowerCase() })), ...envRefs(key, env ?? {}));
    });
    for (const p of await render.postgres(ctx, acc).catch(or([]))) {
      found.push({ provider: 'render', kind: 'database', extId: p.id, name: p.name, accountId: acc, hosts: await render.postgresHosts(ctx, acc, p.id).catch(or([])), status: p.status, platform: 'render' });
    }
    return { found, refs };
  },
  async railway(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    await pool(await railway.instances(ctx, acc), 4, async (i) => {
      const key = `railway:${i.environment}/${i.service}`;
      const env = await railway.variables(ctx, acc, i).catch(or(undefined as Env));
      const isDb = /postgres|postgis|pgvector|timescale|redis|valkey|mysql|mariadb|mongo|clickhouse/i.test(i.image ?? '');
      // its own private and public names, from Railway's built-in variables
      const own = [env?.RAILWAY_PRIVATE_DOMAIN, env?.RAILWAY_PUBLIC_DOMAIN, env?.RAILWAY_TCP_PROXY_DOMAIN].filter(Boolean).map((h) => h!.toLowerCase());
      found.push({ provider: 'railway', kind: isDb ? 'database' : 'app', extId: `${i.environment}/${i.service}`, name: `${i.projectName} / ${i.name}${/^production$/i.test(i.environmentName) ? '' : ` (${i.environmentName})`}`, accountId: acc,
        url: i.custom[0] ? `https://${i.custom[0]}` : i.domains[0] ? `https://${i.domains[0]}` : undefined, hosts: [...new Set([...i.domains, ...i.custom, ...own])], envKeys: keysOf(env)?.filter((k) => !k.startsWith('RAILWAY_')),
        uses: usesOf([], keysOf(env) ?? []), end: { kind: 'railway', accountId: acc, project: i.project, environment: i.environment, service: i.service }, platform: 'railway', status: i.status === 'CRASHED' || i.status === 'FAILED' ? i.status.toLowerCase() : undefined });
      refs.push(...i.custom.map((h): Ref => ({ from: key, kind: 'domain', via: 'added on Railway', host: h })), ...envRefs(key, Object.fromEntries(Object.entries(env ?? {}).filter(([k]) => !k.startsWith('RAILWAY_')))));
    });
    return { found, refs };
  },
  async heroku(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    await pool(await heroku.apps(ctx, acc), 4, async (a) => {
      const key = `heroku:${a.id}`;
      const [domains, env, addons] = await Promise.all([heroku.domains(ctx, acc, a.id).catch(or([])), heroku.env(ctx, acc, a.id).catch(or(undefined as Env)), heroku.addons(ctx, acc, a.id).catch(or([]))]);
      const custom = domains.filter((d) => d.kind === 'custom').map((d) => d.hostname.toLowerCase());
      found.push({ provider: 'heroku', kind: 'app', extId: a.id, name: a.name, accountId: acc, url: a.web_url, hosts: [...(hostOf(a.web_url) ? [hostOf(a.web_url)!] : []), ...custom], envKeys: keysOf(env), uses: usesOf([], keysOf(env) ?? []),
        end: { kind: 'heroku', accountId: acc, app: a.id }, platform: 'heroku', status: a.maintenance ? 'maintenance' : undefined });
      refs.push(...custom.map((h): Ref => ({ from: key, kind: 'domain', via: 'added on Heroku', host: h })), ...envRefs(key, env ?? {}));
      // Heroku Postgres / Redis: a database whose address is in the app's settings (the add-on sets them)
      for (const ad of addons.filter((x) => /postgres|redis|mysql|mongo/i.test(x.addon_service.name))) {
        const hosts = ad.config_vars.map((v) => (env?.[v] ? /@([^:/?]+)/.exec(env[v]!)?.[1]?.toLowerCase() : undefined)).filter(Boolean) as string[];
        found.push({ provider: 'heroku', kind: 'database', extId: ad.id, name: ad.name, accountId: acc, hosts, platform: 'heroku', status: ad.state && ad.state !== 'provisioned' ? ad.state : undefined });
      }
    });
    return { found, refs };
  },
  // Fly.io: apps and Postgres clusters; secret values are never readable, so only their names
  async fly(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    for (const a of await fly.apps(ctx, acc)) {
      found.push({ provider: 'fly', kind: a.postgres ? 'database' : 'app', extId: a.id, name: a.name, accountId: acc, url: `https://${a.certs[0] ?? a.hostname}`,
        hosts: [a.hostname, ...a.certs, `${a.name}.internal`, `${a.name}.flycast`], ips: a.ips, envKeys: a.secrets, end: { kind: 'fly', accountId: acc, app: a.name }, platform: 'fly' });
      refs.push(...a.certs.map((h): Ref => ({ from: `fly:${a.id}`, kind: 'domain', via: 'added on Fly.io', host: h })));
    }
    return { found, refs };
  },
  async digitalocean(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    for (const d of await digitalocean.droplets(ctx, acc)) found.push({ provider: 'digitalocean', kind: 'server', extId: `droplet-${d.id}`, name: d.name, accountId: acc, ips: d.networks.v4.filter((n) => n.type === 'public').map((n) => n.ip_address), platform: 'vps', status: d.status === 'active' ? undefined : d.status });
    for (const a of await digitalocean.apps(ctx, acc).catch(or([]))) {
      const key = `digitalocean:app-${a.id}`;
      const custom = (a.domains ?? []).map((d) => d.spec.domain.toLowerCase());
      const env = Object.fromEntries([...(a.spec.envs ?? []), ...(a.spec.services ?? []).flatMap((x) => x.envs ?? []), ...(a.spec.static_sites ?? []).flatMap((x) => x.envs ?? [])].map((e) => [e.key, e.value ?? '']));
      found.push({ provider: 'digitalocean', kind: 'app', extId: `app-${a.id}`, name: a.spec.name, accountId: acc, url: a.default_ingress, hosts: [...(hostOf(a.default_ingress) ? [hostOf(a.default_ingress)!] : []), ...custom], envKeys: Object.keys(env), platform: 'digitalocean', status: a.active_deployment?.phase === 'ERROR' ? 'error' : undefined });
      refs.push(...custom.map((h): Ref => ({ from: key, kind: 'domain', via: 'added on DigitalOcean', host: h })), ...envRefs(key, env));
    }
    for (const db of await digitalocean.databases(ctx, acc).catch(or([]))) found.push({ provider: 'digitalocean', kind: 'database', extId: `db-${db.id}`, name: db.name, accountId: acc, hosts: [db.connection?.host, db.private_connection?.host].filter(Boolean).map((h) => h!.toLowerCase()), status: db.status === 'online' ? undefined : db.status });
    for (const z of await digitalocean.domains(ctx, acc).catch(or([]))) zoneScan(found, refs, 'digitalocean', acc, z.name, (await digitalocean.records(ctx, acc, z.name).catch(or([]))).map((r) => ({ name: r.name, type: r.type, value: r.data === '@' ? z.name : r.data })));
    return { found, refs };
  },

  // --- DNS hosts: every zone's address records ------------------------------------------------------
  async cloudflare(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    await pool(await cloudflare.zones(ctx, acc), 4, async (z) => {
      const recs = await cloudflare.listRecords(ctx, acc, z.id) as { name: string; type: string; content: string }[];
      zoneScan(found, refs, 'cloudflare', acc, z.name, recs.map((r) => ({ name: r.name, type: r.type, value: r.content })));
    });
    return { found, refs };
  },
  async godaddy(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    const headers = await gd(ctx, acc);
    const domains = await rest<{ domain: string; status: string; expires?: string; renewAuto?: boolean }[]>('GoDaddy', `${GODADDY}/v1/domains?statuses=ACTIVE&limit=1000`, { headers });
    for (const d of domains) registration(found, 'godaddy', acc, d.domain, d.expires, d.renewAuto);
    await pool(domains, 3, async (d) => {
      const recs = await rest<{ name: string; type: string; data: string }[]>('GoDaddy', `${GODADDY}/v1/domains/${d.domain}/records`, { headers }).catch(or([])); // DNS elsewhere: nothing to read
      zoneScan(found, refs, 'godaddy', acc, d.domain, recs.map((r) => ({ name: r.name, type: r.type, value: r.data })));
    });
    return { found, refs };
  },
  async porkbun(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    const auth = pb(ctx, acc);
    const { domains = [] } = await rest<{ domains?: { domain: string; expireDate?: string; autoRenew?: string | number }[] }>('Porkbun', `${PORKBUN}/domain/listAll`, { body: auth });
    for (const d of domains) registration(found, 'porkbun', acc, d.domain, d.expireDate, String(d.autoRenew) === '1');
    for (const d of domains) {
      const { records = [] } = await rest<{ records?: { name: string; type: string; content: string }[] }>('Porkbun', `${PORKBUN}/dns/retrieve/${d.domain}`, { body: auth }).catch(or({ records: [] }));
      zoneScan(found, refs, 'porkbun', acc, d.domain, records.map((r) => ({ name: r.name, type: r.type, value: r.content })));
    }
    return { found, refs };
  },
  async namecom(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    const headers = nc(ctx, acc);
    const { domains = [] } = await rest<{ domains?: { domainName: string; expireDate?: string; autorenewEnabled?: boolean }[] }>('Name.com', `${NAMECOM}/domains`, { headers });
    for (const d of domains) registration(found, 'namecom', acc, d.domainName, d.expireDate, d.autorenewEnabled);
    await pool(domains, 3, async (d) => {
      const { records = [] } = await rest<{ records?: { fqdn?: string; host?: string; type: string; answer: string }[] }>('Name.com', `${NAMECOM}/domains/${d.domainName}/records`, { headers }).catch(or({ records: [] }));
      zoneScan(found, refs, 'namecom', acc, d.domainName, records.map((r) => ({ name: r.fqdn?.replace(/\.$/, '') ?? r.host ?? '@', type: r.type, value: r.answer })));
    });
    return { found, refs };
  },

  // --- Hostinger: VPS (and the Docker apps on each, with their settings), domains + DNS, websites ----
  async hostinger(ctx, acc) {
    const found: Found[] = [], refs: Ref[] = [];
    const call = async <T>(operation: string, params: Record<string, unknown> = {}): Promise<T> => {
      const text = await hostinger(ctx.app).call(ctx, acc, 'execute', { operation, params }, 60_000);
      const j = JSON.parse(text);
      return (Array.isArray(j) ? j : j?.data ?? j) as T;
    };
    const portfolio = await call<{ domain: string; status?: string; expires_at?: string }[]>('domains_portfolio_list'); // fails the scan on a bad token
    for (const d of portfolio) registration(found, 'hostinger', acc, d.domain, d.expires_at);
    for (const vm of await call<{ id: number; hostname: string; ipv4?: { address: string }[] }[]>('vps_virtual-machines_list').catch(or([]))) {
      const server = `hostinger:vm-${vm.id}`;
      found.push({ provider: 'hostinger', kind: 'server', extId: `vm-${vm.id}`, name: vm.hostname, accountId: acc, ips: (vm.ipv4 ?? []).map((a) => a.address), platform: 'vps' });
      for (const proj of await call<{ name: string; status?: string }[]>('vps_docker_list', { virtualMachineId: vm.id }).catch(or([]))) {
        const key = `hostinger:vm-${vm.id}/${proj.name}`;
        const detail = await call<{ content?: string; environment?: string }>('vps_docker_get', { virtualMachineId: vm.id, projectName: proj.name }).catch(or(undefined));
        const env: Env = detail && parseDotenv(detail.environment ?? '');
        // the hostnames a reverse proxy routes to it (Traefik labels, VIRTUAL_HOST)
        const hosts = [...(detail?.content ?? '').matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1]!.toLowerCase()).concat((env?.VIRTUAL_HOST ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
        found.push({ provider: 'hostinger', kind: 'app', extId: `vm-${vm.id}/${proj.name}`, name: proj.name, accountId: acc, hosts, envKeys: keysOf(env), platform: 'vps', status: proj.status });
        refs.push({ from: key, kind: 'runs_on', via: 'Docker on this VPS', to: server }, ...envRefs(key, env ?? {}), ...hosts.map((h): Ref => ({ from: key, kind: 'domain', via: 'routed on the VPS', host: h })));
      }
    }
    for (const d of portfolio) {
      const recs = await call<{ name: string; type: string; records: { content: string }[] }[]>('dns_records_list', { domain: d.domain }).catch(or([]));
      zoneScan(found, refs, 'hostinger', acc, d.domain, recs.flatMap((r) => r.records.map((x) => ({ name: r.name, type: r.type, value: x.content }))));
    }
    for (const w of await call<{ domain: string; is_enabled?: boolean }[]>('hosting_websites_list', { per_page: 100 }).catch(or([]))) {
      const key = `hostinger:web-${w.domain}`;
      found.push({ provider: 'hostinger', kind: 'app', extId: `web-${w.domain}`, name: w.domain, accountId: acc, url: `https://${w.domain}`, hosts: [w.domain.toLowerCase()], platform: 'hostinger-web', status: w.is_enabled === false ? 'disabled' : undefined });
      refs.push({ from: key, kind: 'domain', via: 'website on Hostinger', host: w.domain.toLowerCase() });
    }
    return { found, refs };
  },
};


// --- The big clouds: Google Cloud + Firebase, AWS, Azure, Hetzner (connectors/{google,aws,azure,hetzner}.ts) ---
// Each product keeps its own logo on the map (Cloud Run, Cloud SQL, Firebase, Lightsail…), so `provider` here is
// the product; the account says whose it is. Like every scanner: the credential is proven first (a refused one
// fails the scan and the last good one stays), a product that isn't set up is just none, and nothing is changed.
import { google, firebaseCli, viaFirebaseCli, lastPart, sqlBytesUsed } from '../connectors/google.ts';

const hostsOf = (...urls: (string | undefined)[]) => urls.map((u) => hostOf(u)).filter(Boolean) as string[];
const firebaseSite = (acc: string, p: string, id: string, defaultUrl: string | undefined, custom: string[]): Found =>
  ({ provider: 'firebase', kind: 'app', extId: `${p}/hosting/${id}`, name: id, accountId: acc, url: custom[0] ? `https://${custom[0]}` : defaultUrl ?? `https://${id}.web.app`, hosts: [`${id}.web.app`, `${id}.firebaseapp.com`, ...custom], platform: 'firebase' });
const firestoreDb = (acc: string, p: string, id: string): Found =>
  ({ provider: 'firestore', kind: 'database', extId: `${p}/${id}`, name: id === '(default)' ? p : `${p} / ${id}`, accountId: acc, url: `https://console.firebase.google.com/project/${p}/firestore`, engine: 'firestore' });

// Google: one sign-in sees Google Cloud and Firebase alike. The Google Cloud tile shows the Cloud products and the
// Firebase tile the Firebase ones, so the same Google sign-in on both tiles never shows anything twice. Things Google
// made for another product (the Cloud Run service behind a Firebase function or App Hosting) show once, as that product.
const byFirebaseCli = (f: { labels?: Record<string, string> }) => f.labels?.['deployment-tool'] === 'cli-firebase';
async function scanGoogle(ctx: Ctx, acc: string): Promise<Scan> {
  const fbCli = viaFirebaseCli(ctx, acc);
  if (fbCli) return scanFirebaseCli(acc, fbCli.account);
  const found: Found[] = [], refs: Ref[] = [];
  const projects = await google.projects(ctx, acc); // a refused sign-in fails the scan here
  const firebaseTile = all<{ provider: string }>(ctx.db, 'SELECT provider FROM accounts WHERE id = ?', acc)[0]?.provider === 'firebase';
  const firebaseOn = firebaseTile && new Set((await google.firebaseProjects(ctx, acc).catch(or(undefined)))?.map((p) => p.projectId) ?? projects.map((p) => p.projectId));
  const functions = (p: string, mine: (f: { labels?: Record<string, string> }) => boolean) => google.functions(ctx, acc, p).catch(or([])).then((fns) => {
    for (const f of fns.filter(mine)) {
      const parts = f.name.split('/'), region = parts[3] ?? '', name = parts[5] ?? f.name, url = f.serviceConfig?.uri ?? f.url, env = f.serviceConfig?.environmentVariables ?? {};
      const provider = byFirebaseCli(f) ? 'firebase' : 'cloudfunctions', extId = `${p}/fn/${region}/${name}`;
      found.push({ provider, kind: 'app', extId, name, accountId: acc, url, hosts: hostsOf(url), envKeys: Object.keys(env), uses: usesOf([], Object.keys(env)), platform: 'gcp', status: f.state && f.state !== 'ACTIVE' ? f.state.toLowerCase() : undefined });
      refs.push(...envRefs(`${provider}:${extId}`, env));
    }
  });
  await pool(projects, 3, async ({ projectId: p }) => {
    if (firebaseOn) return firebaseOn.has(p) ? scanFirebaseProject(ctx, acc, p, found, refs, functions(p, byFirebaseCli)) : undefined;
    const [run, mapped, ae, , sql, zones, regs] = await Promise.all([
      google.runServices(ctx, acc, p).catch(or([])), google.runDomains(ctx, acc, p).catch(or([])), google.appEngine(ctx, acc, p).catch(or(undefined)),
      functions(p, (f) => !byFirebaseCli(f)), google.sql(ctx, acc, p).catch(or([])), google.dnsZones(ctx, acc, p).catch(or([])), google.registrations(ctx, acc, p).catch(or([])),
    ]);
    for (const s of run.filter((x) => !x.metadata.labels?.['goog-managed-by'])) {
      const region = s.metadata.labels?.['cloud.googleapis.com/location'] ?? '', extId = `${p}/${region}/${s.metadata.name}`, key = `cloudrun:${extId}`;
      const vars = (s.spec?.template?.spec?.containers ?? []).flatMap((c) => c.env ?? []);
      const custom = mapped.filter((m) => m.spec?.routeName === s.metadata.name).map((m) => m.metadata.name.toLowerCase());
      const ready = s.status?.conditions?.find((c) => c.type === 'Ready');
      const keys = [...new Set(vars.map((v) => v.name))];
      found.push({ provider: 'cloudrun', kind: 'app', extId, name: s.metadata.name, accountId: acc, url: custom[0] ? `https://${custom[0]}` : s.status?.url, hosts: [...hostsOf(s.status?.url), ...custom],
        envKeys: keys, uses: usesOf([], keys), platform: 'gcp', status: ready?.status === 'False' ? 'failing' : undefined });
      refs.push(...custom.map((h): Ref => ({ from: key, kind: 'domain', via: 'mapped on Cloud Run', host: h })), ...envRefs(key, Object.fromEntries(vars.filter((v) => v.value !== undefined).map((v) => [v.name, v.value!]))));
    }
    if (ae?.defaultHostname) {
      const [svcs, aeDomains] = await Promise.all([google.appEngineServices(ctx, acc, p).catch(or([])), google.appEngineDomains(ctx, acc, p).catch(or([]))]);
      for (const { id } of svcs.length ? svcs : [{ id: 'default' }]) {
        const h = id === 'default' ? ae.defaultHostname : `${id}-dot-${ae.defaultHostname}`, custom = id === 'default' ? aeDomains.map((d) => d.id.toLowerCase()) : [];
        found.push({ provider: 'appengine', kind: 'app', extId: `${p}/${id}`, name: id === 'default' ? p : `${p} / ${id}`, accountId: acc, url: `https://${custom[0] ?? h}`, hosts: [h, ...custom], platform: 'gcp',
          status: ae.servingStatus && ae.servingStatus !== 'SERVING' ? 'stopped' : undefined });
        refs.push(...custom.map((d): Ref => ({ from: `appengine:${p}/${id}`, kind: 'domain', via: 'mapped on App Engine', host: d })));
      }
    }
    const used = sql.length ? await dbSize(`cloudsql:${acc}:${p}`, () => sqlBytesUsed(ctx, acc, p).then((m) => JSON.stringify([...m]))).then((v) => new Map<string, number>(v ? JSON.parse(v) : [])) : new Map<string, number>();
    for (const d of sql) {
      found.push({ ...(used.has(d.name) && { size: used.get(d.name) }), provider: 'cloudsql', kind: 'database', extId: `${p}/${d.name}`, name: d.name, accountId: acc, url: `https://console.cloud.google.com/sql/instances/${d.name}/overview?project=${p}`,
        ips: (d.ipAddresses ?? []).filter((x) => x.type === 'PRIMARY').map((x) => x.ipAddress), hosts: d.dnsName ? [d.dnsName.toLowerCase().replace(/\.$/, '')] : [], engine: d.databaseVersion?.split('_')[0]?.toLowerCase(),
        status: d.settings?.activationPolicy === 'NEVER' ? 'stopped' : d.state && d.state !== 'RUNNABLE' ? d.state.toLowerCase() : undefined });
    }
    for (const z of zones.filter((x) => x.visibility !== 'private')) {
      const recs = await google.dnsRecords(ctx, acc, p, z.name).catch(or([]));
      zoneScan(found, refs, 'gcp', acc, z.dnsName.replace(/\.$/, '').toLowerCase(), recs.flatMap((r) => (r.rrdatas ?? []).map((v) => ({ name: r.name.replace(/\.$/, ''), type: r.type, value: v }))));
    }
    for (const r of regs.filter((x) => x.state !== 'EXPORTED')) registration(found, 'gcp', acc, r.domainName, r.expireTime, r.managementSettings?.renewalMethod === 'AUTOMATIC_RENEWAL');
  });
  return { found, refs };
}

// one Firebase project: Hosting sites (and their domains), App Hosting, Firestore, Realtime Database, its functions
async function scanFirebaseProject(ctx: Ctx, acc: string, p: string, found: Found[], refs: Ref[], fns: Promise<void>) {
  const [sites, backends, dbs, rtdbs] = await Promise.all([google.sites(ctx, acc, p).catch(or([])), google.appHosting(ctx, acc, p).catch(or([])), google.firestore(ctx, acc, p).catch(or([])), google.rtdb(ctx, acc, p).catch(or([])), fns]);
  await pool(sites, 3, async (s) => {
    const id = lastPart(s.name), custom = await google.siteDomains(ctx, acc, p, id).catch(or([]));
    found.push(firebaseSite(acc, p, id, s.defaultUrl, custom));
    refs.push(...custom.map((h): Ref => ({ from: `firebase:${p}/hosting/${id}`, kind: 'domain', via: 'added on Firebase Hosting', host: h })));
  });
  for (const b of backends) {
    const id = lastPart(b.name);
    found.push({ provider: 'firebase', kind: 'app', extId: `${p}/apphosting/${id}`, name: b.displayName || id, accountId: acc, url: b.uri && `https://${hostOf(b.uri)}`, hosts: hostsOf(b.uri) });
  }
  for (const d of dbs) found.push(firestoreDb(acc, p, lastPart(d.name)));
  for (const i of rtdbs) found.push({ provider: 'firebase', kind: 'database', extId: `${p}/rtdb/${lastPart(i.name)}`, name: lastPart(i.name), accountId: acc, url: i.databaseUrl, hosts: hostsOf(i.databaseUrl), status: i.state && i.state !== 'ACTIVE' ? i.state.toLowerCase() : undefined });
}

// Firebase through the Firebase CLI (no gcloud here): projects, Hosting sites and Firestore. The CLI doesn't list
// custom domains; connecting gcloud (or a key) adds them.
async function scanFirebaseCli(acc: string, account?: string): Promise<Scan> {
  const found: Found[] = [];
  const projects = await firebaseCli.projects(account); // a signed-out CLI fails the scan here
  await pool(projects, 2, async ({ projectId: p }) => {
    const [sites, dbs] = await Promise.all([firebaseCli.sites(account, p).catch(or([])), firebaseCli.firestore(account, p).catch(or([]))]);
    for (const s of sites) found.push(firebaseSite(acc, p, lastPart(s.name), s.defaultUrl, []));
    for (const d of dbs) found.push(firestoreDb(acc, p, lastPart(d.name)));
  });
  return { found, refs: [] };
}
SCANNERS.gcp = scanGoogle;
SCANNERS.firebase = scanGoogle;

// AWS: every region the account has switched on (EC2, RDS, Amplify, Lightsail), plus Route 53 zones and domains
import { aws, LIGHTSAIL, awsOps as aws_ } from '../connectors/aws.ts';
SCANNERS.aws = async (ctx, acc) => {
  const found: Found[] = [], refs: Ref[] = [];
  await aws.whoami(ctx, acc); // a refused key fails the scan here
  const regions = await aws.regions(ctx, acc).catch(or(['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-south-1', 'ap-southeast-1']));
  await pool(regions, 6, async (region) => {
    const [ec2, rds, apps, boxes] = await Promise.all([aws.instances(ctx, acc, region).catch(or([])), aws.databases(ctx, acc, region).catch(or([])),
      aws.amplifyApps(ctx, acc, region).catch(or([])), LIGHTSAIL.has(region) ? aws.lightsail(ctx, acc, region).catch(or([])) : []]);
    for (const i of ec2.filter((x) => x.state !== 'terminated')) found.push({ provider: 'ec2', kind: 'server', extId: `${region}/${i.id}`, name: i.name || i.id, accountId: acc, ips: i.ip ? [i.ip] : [], platform: 'vps', status: i.state === 'running' ? undefined : i.state });
    for (const b of boxes) found.push({ provider: 'lightsail', kind: 'server', extId: `${region}/${b.name}`, name: b.name, accountId: acc, ips: b.publicIpAddress ? [b.publicIpAddress] : [], platform: 'vps', status: b.state?.name === 'running' ? undefined : b.state?.name });
    const rdsSize = await pool(rds, 3, (d) => (d.allocatedGiB && !/^aurora/.test(d.engine ?? '') ? dbSize(`rds:${acc}:${region}/${d.id}`, () => aws_.rdsFreeBytes(ctx, acc, region, d.id).then((free) => (free === undefined ? '' : String(Math.max(0, d.allocatedGiB! * 2 ** 30 - free))))).then((v) => (v ? Number(v) : undefined)) : Promise.resolve(undefined)));
    for (const [n, d] of rds.entries()) found.push({ ...(rdsSize[n] !== undefined && { size: rdsSize[n] }), provider: 'rds', kind: 'database', extId: `${region}/${d.id}`, name: d.id, accountId: acc, url: `https://console.aws.amazon.com/rds/home?region=${region}#database:id=${d.id}`, hosts: d.host ? [d.host.toLowerCase()] : [], engine: d.engine, status: d.status === 'available' ? undefined : d.status });
    for (const a of apps) {
      const key = `amplify:${region}/${a.appId}`, branch = a.productionBranch?.branchName;
      const custom = (await aws.amplifyDomains(ctx, acc, region, a.appId).catch(or([]))).flatMap((d) => (d.subDomains?.length ? d.subDomains : [{ subDomainSetting: { prefix: '' } }]).map((s) => (s.subDomainSetting?.prefix ? `${s.subDomainSetting.prefix}.${d.domainName}` : d.domainName).toLowerCase()));
      const own = branch ? `${branch}.${a.defaultDomain}` : a.defaultDomain;
      found.push({ provider: 'amplify', kind: 'app', extId: `${region}/${a.appId}`, name: a.name, accountId: acc, url: `https://${custom[0] ?? own}`, hosts: [own, ...custom], platform: 'aws', status: a.productionBranch?.status === 'FAILED' ? 'failed' : undefined });
      refs.push(...[...new Set(custom)].map((h): Ref => ({ from: key, kind: 'domain', via: 'added on AWS Amplify', host: h })));
    }
  });
  for (const z of (await aws.zones(ctx, acc).catch(or([]))).filter((x) => !x.private)) zoneScan(found, refs, 'route53', acc, z.name, await aws.records(ctx, acc, z.id).catch(or([])));
  for (const d of await aws.registered(ctx, acc).catch(or([]))) registration(found, 'route53', acc, d.DomainName, d.Expiry ? d.Expiry * 1000 : undefined, d.AutoRenew);
  return { found, refs };
};

// Azure: every subscription: Static Web Apps, App Service, Postgres and SQL databases, Azure DNS
import { azure, metricMax, armList } from '../connectors/azure.ts';
SCANNERS.azure = async (ctx, acc) => {
  const found: Found[] = [], refs: Ref[] = [];
  const subs = await azure.subscriptions(ctx, acc); // a refused sign-in fails the scan here
  await pool(subs.filter((s) => s.state !== 'Disabled'), 3, async ({ subscriptionId: s }) => {
    const [swa, sites, pg, sql, zones] = await Promise.all([azure.staticSites(ctx, acc, s).catch(or([])), azure.webApps(ctx, acc, s).catch(or([])), azure.postgres(ctx, acc, s).catch(or([])), azure.sqlServers(ctx, acc, s).catch(or([])), azure.dnsZones(ctx, acc, s).catch(or([]))]);
    const app = (extId: string, name: string, own: string[], custom: string[], via: string, status?: string) => {
      found.push({ provider: 'azure', kind: 'app', extId, name, accountId: acc, url: `https://${custom[0] ?? own[0]}`, hosts: [...own, ...custom], platform: 'azure', status });
      refs.push(...custom.map((h): Ref => ({ from: `azure:${extId}`, kind: 'domain', via, host: h })));
    };
    for (const w of swa) app(`swa/${s}/${w.name}`, w.name, hostsOf(w.properties?.defaultHostname), (w.properties?.customDomains ?? []).map((d) => d.toLowerCase()), 'added on Azure Static Web Apps');
    for (const w of sites) {
      const names = (w.properties?.hostNames ?? []).map((h) => h.toLowerCase());
      app(`site/${s}/${w.name}`, w.name, hostsOf(w.properties?.defaultHostName), names.filter((h) => !h.endsWith('.azurewebsites.net')), 'added on Azure App Service', w.properties?.state && w.properties.state !== 'Running' ? w.properties.state.toLowerCase() : undefined);
    }
    for (const [kind, engine, list] of [['pg', 'postgres', pg], ['sql', 'sqlserver', sql]] as const) for (const d of list) {
      const size = await dbSize(`azure:${acc}:${d.id}`, async () => String(kind === 'pg' ? await metricMax(ctx, acc, d.id, 'storage_used') ?? ''
        : (await pool((await armList<{ id: string; name: string }>(ctx, acc, `${d.id}/databases?api-version=2021-11-01`)).filter((x) => x.name !== 'master'), 3, (x) => metricMax(ctx, acc, x.id, 'storage'))).reduce<number>((n, b) => n + (b ?? 0), 0) || '')).then((v) => (v ? Number(v) : undefined));
      found.push({ ...(size !== undefined && { size }), provider: 'azure', kind: 'database', extId: `${kind}/${s}/${d.name}`, name: d.name, accountId: acc, hosts: hostsOf(d.properties?.fullyQualifiedDomainName), engine, status: d.properties?.state && !/^(Ready)$/.test(d.properties.state) ? d.properties.state.toLowerCase() : undefined });
    }
    for (const z of zones) {
      const recs = await azure.records(ctx, acc, z.id).catch(or([]));
      zoneScan(found, refs, 'azure', acc, z.name.toLowerCase(), recs.flatMap((r) => { const type = r.type.split('/').pop()!, p = r.properties ?? {};
        return [...(p.ARecords ?? []).map((x) => ({ name: r.name, type, value: x.ipv4Address })), ...(p.AAAARecords ?? []).map((x) => ({ name: r.name, type, value: x.ipv6Address })), ...(p.CNAMERecord ? [{ name: r.name, type, value: p.CNAMERecord.cname }] : [])]; }));
    }
  });
  return { found, refs };
};

// Hetzner Cloud: servers and DNS zones
import { hetzner } from '../connectors/hetzner.ts';
SCANNERS.hetzner = async (ctx, acc) => {
  const found: Found[] = [], refs: Ref[] = [];
  for (const s of await hetzner.servers(ctx, acc)) { // a refused token fails the scan here
    found.push({ provider: 'hetzner', kind: 'server', extId: `server-${s.id}`, name: s.name, accountId: acc, ips: s.public_net?.ipv4?.ip ? [s.public_net.ipv4.ip] : [], platform: 'vps', status: s.status === 'running' ? undefined : s.status });
  }
  for (const z of await hetzner.zones(ctx, acc).catch(or([]))) zoneScan(found, refs, 'hetzner', acc, z.name, (await hetzner.records(ctx, acc, z.id).catch(or([]))).flatMap((r) => r.records.map((x) => ({ name: r.name, type: r.type, value: x.value }))));
  return { found, refs };
};


// --- database sizes (add-only): `size` (bytes stored) on database assets, where the provider says it cheaply ---------
// Each is asked at most once an hour per database (a sync every few minutes doesn't ask again) and a failure is just
// "not known" (cached too, so it isn't retried every sync). The map's database rings fill from these.
//   Supabase: GET /v1/projects/{ref}/config/disk/util (fs_used_bytes) https://api.supabase.com/api/v1-json
//   Neon: the default branch's logical_size (describe_project) https://api-docs.neon.tech/reference/listprojectbranches
//   Railway: volumeInstances.currentSizeMB https://docs.railway.com/integrations/api/manage-volumes
//   Render: GET /v1/metrics/disk-usage?resource= https://api-docs.render.com/reference/get-disk-usage
//   RDS, Cloud SQL, Azure: in their scanners above (CloudWatch FreeStorageSpace, Monitoring bytes_used, Azure Monitor).
//   DigitalOcean shows used disk for MySQL only as a percent of a size it doesn't give, so its databases stay unknown;
//   PlanetScale and Turso connect through their MCP only (no scanner yet).
import { cached } from '../connectors/cloudcli.ts';
import { bearerFor } from '../connectors/mcp-oauth.ts';
import { railwayQuery, RENDER_API, renderAuth } from '../connectors/hosts.ts';
export function dbSize(key: string, read: () => Promise<string>): Promise<string> {
  return cached(`dbsize:${key}`, async () => ({ value: await read().catch(() => ''), until: Date.now() + 3600_000 }), 3600_000);
}
const num = (v: string) => (v ? Number(v) : undefined);
const sizing: Record<string, (ctx: Ctx, acc: string, dbs: Found[]) => Promise<void>> = {
  async supabase(ctx, acc, dbs) {
    await pool(dbs.filter((d) => !/inactive|paused/i.test(d.status ?? '')), 3, async (d) => {
      const v = num(await dbSize(`supabase:${d.extId}`, async () => String((await rest<{ metrics?: { fs_used_bytes?: number } }>('Supabase', `${SUPABASE_API()}/projects/${d.extId}/config/disk/util`, { headers: { authorization: `Bearer ${await bearerFor(ctx, 'supabase', acc)}` } })).metrics?.fs_used_bytes ?? '')));
      if (v !== undefined) d.size = v;
    });
  },
  async neon(ctx, acc, dbs) {
    await pool(dbs, 3, async (d) => {
      const v = num(await dbSize(`neon:${d.extId}`, async () => {
        const text = JSON.stringify(await neon.branches(ctx, acc, d.extId));
        const sizes = [...text.matchAll(/"logical_size"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
        return sizes.length ? String(Math.max(...sizes)) : ''; // ponytail: the biggest branch, usually the default one
      }));
      if (v !== undefined) d.size = v;
    });
  },
  async railway(ctx, acc, dbs) {
    if (!dbs.length) return;
    const projects = [...new Set(dbs.map((d) => (d.end as { project?: string } | undefined)?.project).filter((x): x is string => !!x))];
    for (const p of projects) {
      const v = await dbSize(`railway:${p}`, async () => {
        const r = await railwayQuery<{ project: { volumes: { edges: { node: { volumeInstances: { edges: { node: { currentSizeMB: number; serviceId?: string; environmentId?: string } }[] } } }[] } } }>(ctx, acc,
          'query($id: String!) { project(id: $id) { volumes { edges { node { volumeInstances { edges { node { currentSizeMB serviceId environmentId } } } } } } } }', { id: p });
        return JSON.stringify(r.project.volumes.edges.flatMap((v) => v.node.volumeInstances.edges.map((x) => [`${x.node.environmentId}/${x.node.serviceId}`, Math.round(x.node.currentSizeMB * 1e6)])));
      });
      const by = new Map<string, number>(v ? JSON.parse(v) : []);
      for (const d of dbs) if (by.has(d.extId)) d.size = by.get(d.extId);
    }
  },
  async render(ctx, acc, dbs) {
    const UNIT: Record<string, number> = { b: 1, bytes: 1, kb: 1e3, mb: 1e6, gb: 1e9 };
    await pool(dbs, 3, async (d) => {
      const v = num(await dbSize(`render:${d.extId}`, async () => {
        const end = new Date(), start = new Date(end.getTime() - 3600_000);
        const r = await rest<{ unit?: string; values?: { value: number }[] }[]>('Render', `${RENDER_API()}/metrics/disk-usage?resource=${d.extId}&startTime=${start.toISOString()}&endTime=${end.toISOString()}&resolutionSeconds=600`, { headers: await renderAuth(ctx, acc) });
        const s = r[0], last = s?.values?.at(-1)?.value, unit = UNIT[(s?.unit ?? 'bytes').toLowerCase()];
        return last !== undefined && unit ? String(Math.round(last * unit)) : '';
      }));
      if (v !== undefined) d.size = v;
    });
  },
};
for (const [p, size] of Object.entries(sizing)) {
  const scan = SCANNERS[p]!;
  SCANNERS[p] = async (ctx, acc) => { const r = await scan(ctx, acc); await size(ctx, acc, r.found.filter((f) => f.kind === 'database')).catch(() => undefined); return r; };
}
