// Routing lives in Caddy: one file per hostname under /etc/unit7/caddy/sites, applied with a
// graceful `caddy reload` (no dropped connections). Unit7 points a hostname at a container by name
// on the private `unit7` network, so app ports are never published to the internet.
import type { App } from '../app.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import { ssh } from '../connectors/ssh.ts';
import { script, safeName } from '../connectors/shell.ts';
import { Unit7Error } from '../errors.ts';
import { get, json } from '../db.ts';

// Who answers on ports 80/443 of a server. Usually Unit7's own Caddy; on a server that already runs Coolify,
// Coolify's Traefik does, and Unit7 adds its apps there instead of taking the ports (see putTraefikSite).
export type Proxy = { kind: 'caddy' } | { kind: 'coolify'; dir: string; network: string } | { kind: 'other'; name: string };
export function proxyOf(f: { web?: string; ports?: number[] }): Proxy {
  const [name = '', image = ''] = (f.web ?? '').split('|');
  if (!name || name === 'unit7-caddy') return f.web || !f.ports?.some((p) => p === 80 || p === 443) ? { kind: 'caddy' } : { kind: 'other', name: 'a program on the server' };
  if (name === 'coolify-proxy' && image.startsWith('traefik')) return { kind: 'coolify', dir: '/data/coolify/proxy/dynamic', network: 'coolify' };
  return { kind: 'other', name };
}
export const proxyFor = (s: ServerRow): Proxy => proxyOf((() => { try { return JSON.parse(s.facts || '{}'); } catch { return {}; } })());

export interface Site {
  hostname: string;        // app.example.com, or an sslip.io name
  upstream: string;        // container name on the unit7 network
  replicas?: string[];     // more copies of the same app; Caddy load-balances across all of them
  remotes?: string[];      // the same app on the fleet's other servers, "10.77.0.2:7001" over the private network (src/fleet)
  weights?: number[];      // a canary (src/fleet/canary.ts): one weight per upstream, copies first then remotes (weighted round robin)
  healthPath?: string;
  cacheStatic?: string;    // a path of content-hashed files (/assets/*) to cache for a year
  port: number;
  tls: 'auto' | 'internal' | 'off'; // auto = Let's Encrypt/ZeroSSL; internal = self-signed (IP hosts); off = http only
  rateLimit?: { events: number; window: string }; // reserved for the edge phase
  blocked?: string[];      // CIDRs Shield has blocked
  redirectTo?: string;     // the main address (domain.canonical): this name only sends visitors there, 301, path and query kept
  redirects?: Redirect[];  // domain.redirect: a whole name, or paths on it, sent to any address
  service?: string;        // Traefik only: a service it already knows (name@docker), instead of an upstream of Unit7's
}

// One redirect. path is left out for the whole name; "/old" also covers everything under it. keepPath adds what came
// after the matched part (and the query) to the address. Both are checked again wherever they're written into a config.
export interface Redirect { path?: string; to: string; permanent: boolean; keepPath: boolean }
export const REDIRECT_TO = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[\w.~:/?@!&+,;=%-]*)?$/i, REDIRECT_PATH = /^(?!.*\.\.)\/[\w.~/-]*[\w~-]$/;
function checked(rs: Redirect[] = []) {
  for (const r of rs) if (!REDIRECT_TO.test(r.to) || (r.path && !REDIRECT_PATH.test(r.path))) throw new Unit7Error('bad_redirect', `“${r.path ?? ''} → ${r.to}” isn’t a redirect Unit7 can write.`, 400);
  return [...rs].sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0)); // the longest path answers first
}

// where each stack puts its content-hashed build files (Next.js already marks its own immutable)
export function hashedPath(stack?: string): string | undefined {
  if (!stack || /next/.test(stack)) return undefined;
  if (/svelte/.test(stack)) return '/_app/immutable/*';
  if (/nuxt/.test(stack)) return '/_nuxt/*';
  if (/laravel/.test(stack)) return '/build/assets/*';
  if (/vite|react|vue|remix|astro|static|solid/.test(stack)) return '/assets/*';
  return undefined;
}

export const siteFileName = (hostname: string) => `${hostname.replace(/[^a-zA-Z0-9.-]/g, '_')}.caddy`;

// Files that must never be served from a site: settings with keys (.env), code history (.git), cloud and SSH keys.
// Every site Unit7 routes answers 404 for them, whatever the app would do. SITES_GUARD is bumped when this changes,
// so Warden re-applies it to sites written before (server.protect_sites).
export const SITES_GUARD = 1;
export const SECRET_PATHS = ['/.env*', '/.git', '/.git/*', '/.svn/*', '/.hg/*', '/.DS_Store', '/.aws', '/.aws/*', '/.ssh', '/.ssh/*', '/*.pem', '/*.key'];
const CADDY_SECRETS = `\t@unit7_secrets path ${SECRET_PATHS.join(' ')}\n\trespond @unit7_secrets 404\n`;

// Caddy's redirects: {re.<name>.1} is what came after the path, {?query} the query when there is one
const caddyRedirects = (rs: Redirect[]) => rs.map((r, n) => {
  const code = r.permanent ? 'permanent' : 'temporary';
  if (!r.path) return `\tredir ${r.keepPath ? `${r.to.replace(/\/$/, '')}{uri}` : r.to} ${code}\n`;
  return `\t@unit7_redir${n} path_regexp unit7_redir${n} ^${r.path.replace(/\./g, '[.]')}(/.*)?$\n\tredir @unit7_redir${n} ${r.keepPath ? `${r.to.replace(/\/$/, '')}{re.unit7_redir${n}.1}{?query}` : r.to} ${code}\n`;
}).join('');

export function renderSite(s: Site): string {
  if (s.redirectTo) return renderRedirect(s, s.redirectTo);
  const redirects = checked(s.redirects);
  if (!s.upstream || redirects.some((r) => !r.path)) return renderRedirects(s, redirects);
  const upstreams = [s.upstream, ...(s.replicas ?? [])];
  upstreams.forEach((u) => safeName(u, 'container name'));
  // a fleet's other servers: private address and port only, nothing else gets into the file
  const remotes = (s.remotes ?? []).map((r) => { if (!/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(r)) throw new Error(`upstream "${r}" isn't an address and port`); return r; });
  // a canary: each upstream's weight (whole numbers only), and which copy answered goes into the log so the two versions
  // can be compared (src/fleet/canary.ts)
  const weights = s.weights?.length ? s.weights : undefined;
  if (weights && (weights.length !== upstreams.length + remotes.length || !weights.every((w) => Number.isInteger(w) && w >= 0 && w <= 10_000) || !weights.some((w) => w > 0))) throw new Error('canary weights don’t match the upstreams');
  const health = (s.healthPath ?? '/').replace(/[^\w/.-]/g, '') || '/';
  const addr = s.tls === 'off' ? `http://${s.hostname}` : s.hostname;
  const tls = s.tls === 'internal' ? '\n\ttls internal' : '';
  const blocks = (s.blocked?.length)
    ? `\n\t@blocked remote_ip ${s.blocked.join(' ')}\n\tabort @blocked`
    : '';
  // Active checks only against a real health route: Caddy wants a 2xx and doesn't follow redirects,
  // so probing '/' (which may redirect to a login page or 404) would mark a healthy app down -> 503s.
  // Without one, Caddy relies on passive checks (real requests that fail).
  const active = health !== '/';
  // several copies: spread load to the least busy one, hold requests briefly while a copy restarts,
  // and take a copy out after 3 failed checks. No `unhealthy_status 5xx`: one buggy route would
  // otherwise mark every copy down and turn the whole site into 503s.
  const lb = upstreams.length + remotes.length > 1 ? `
\t\tlb_policy ${weights ? `weighted_round_robin ${weights.join(' ')}` : 'least_conn'}
\t\tlb_try_duration 10s
\t\tlb_try_interval 250ms${active ? `
\t\thealth_interval 10s
\t\thealth_timeout 3s
\t\thealth_status 2xx
\t\thealth_fails 3
\t\thealth_passes 2` : ''}
\t\tfail_duration 30s
\t\tmax_fails 3` : '';
  // fingerprinted build files never change, so browsers may keep them a year (200s only, so a 404
  // during a deploy is never cached)
  const cache = s.cacheStatic && /^\/[\w/.-]+\/\*$/.test(s.cacheStatic)
    ? `\n\t@hashed path ${s.cacheStatic}\n\theader @hashed {\n\t\tCache-Control "public, max-age=31536000, immutable"\n\t\tmatch status 200\n\t\tdefer\n\t}` : '';
  return `${addr} {
\timport unit7_blocklist
${CADDY_SECRETS}${caddyRedirects(redirects)}\tlog {
\t\toutput stdout
\t\tformat json
\t}
\tencode zstd gzip${tls}${blocks}${cache}${weights ? '\n\tlog_append upstream {rp.upstream.hostport}' : ''}
\treverse_proxy ${[...upstreams.map((u) => `${u}:${s.port}`), ...remotes].join(' ')} {
\t\theader_up X-Forwarded-Host {host}
\t\theader_up X-Real-IP {remote_host}${active ? `\n\t\thealth_uri ${health}` : ''}${lb}
\t\tstream_close_delay 5m
\t}
}
`;
}

// www.example.com → example.com (or the other way): Caddy's own redirect, {uri} keeps the path and the query
export function renderRedirect(s: Site, to: string): string {
  assertHostname(s.hostname); assertHostname(to);
  const addr = s.tls === 'off' ? `http://${s.hostname}` : s.hostname;
  return `${addr} {
\timport unit7_blocklist
${CADDY_SECRETS}${s.tls === 'internal' ? '\ttls internal\n' : ''}\tredir ${s.tls === 'off' ? 'http' : 'https'}://${to}{uri} permanent
}
`;
}
// a name with no app behind it: only its redirects, and "not found" for the rest of it
function renderRedirects(s: Site, rs: Redirect[]): string {
  assertHostname(s.hostname);
  const addr = s.tls === 'off' ? `http://${s.hostname}` : s.hostname;
  return `${addr} {
\timport unit7_blocklist
${CADDY_SECRETS}${s.tls === 'internal' ? '\ttls internal\n' : ''}${caddyRedirects(rs)}${rs.some((r) => !r.path) ? '' : '\trespond 404\n'}}
`;
}
// the name's redirects, from Unit7's own records (domain.canonical and domain.redirect write them), so every caller of
// putSite (a deploy, a re-point, a scale) keeps writing them
const targetOf = (app: App, hostname: string) =>
  json<{ redirectTo?: string; redirects?: Redirect[] }>(get<{ target: string | null }>(app.db, 'SELECT target FROM domains WHERE hostname = ?', hostname)?.target, {});

async function reload(app: App, s: ServerRow) {
  // validate first: a broken file must never take the proxy down
  await ssh(app).check(s, script('docker exec unit7-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1'), { what: 'Validating the proxy config', timeoutMs: 30_000 });
  await ssh(app).check(s, script('docker exec unit7-caddy caddy reload --config /etc/caddy/Caddyfile 2>&1'), { what: 'Reloading the proxy', timeoutMs: 30_000 });
}

// validate, then reload gracefully: for a site file written by hand (a client's status page, src/organize/status.ts)
export const reloadCaddy = reload;

// A fleet with a front proxy (src/fleet): this server is the app's main one, so its site also sends visitors to the copies
// on the other servers in rotation. From Unit7's own records, so every caller of putSite (a deploy, a rollback, a scale,
// a new domain) keeps the fleet instead of quietly dropping it back to one server.
const remotesOf = (app: App, s: ServerRow, hostname: string) => (app.db.prepare(`SELECT n.address || ':' || f.edge_port AS a FROM domains d
  JOIN services sv ON sv.id = d.service_id AND sv.server_id = ?
  JOIN fleets f ON f.service_id = d.service_id AND f.mode = 'front' AND f.edge_port IS NOT NULL
  JOIN service_targets t ON t.service_id = d.service_id AND t.server_id != ? AND t.state = 'in' AND t.deployment_id IS NOT NULL
  JOIN fleet_net n ON n.server_id = t.server_id WHERE d.hostname = ? ORDER BY t.added_at`).all(s.id, s.id, hostname) as { a: string }[]).map((r) => r.a);

// A canary (src/fleet/canary.ts) on this server: the new version gets its share of visitors by weight, and the old copies
// (here, and with a front proxy the fleet's other servers) keep the rest. From Unit7's records as well, so a scale, a heal
// or a new domain during a canary keeps the split. Each new copy weighs share × (old copies), each old one (100 − share) ×
// (new copies), so the new ones together get exactly share%; reduced to the smallest whole numbers.
export function canaryWeights(nNew: number, nOld: number, share: number): { wNew: number; wOld: number } | undefined {
  const p = Math.round(share);
  if (nNew < 1 || nOld < 1 || !(p > 0 && p < 100)) return undefined;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const wNew = p * nOld, wOld = (100 - p) * nNew, d = gcd(wNew, wOld);
  return { wNew: wNew / d, wOld: wOld / d };
}
export function withCanary(site: Site, old: string[], share: number): Site {
  if (site.redirectTo) return site;
  const local = [site.upstream, ...(site.replicas ?? [])];
  const extra = old.filter((o) => !local.includes(o));
  const all = [...local, ...extra];
  const nNew = all.filter((u) => !old.includes(u)).length;
  const w = canaryWeights(nNew, all.length - nNew + (site.remotes?.length ?? 0), share);
  if (!w) return site; // nothing new among the copies (a route back to the old version), or the canary is at 0/100
  return { ...site, replicas: [...(site.replicas ?? []), ...extra], weights: [...all.map((u) => (old.includes(u) ? w.wOld : w.wNew)), ...(site.remotes ?? []).map(() => w.wOld)] };
}
const canaryOf = (app: App, s: ServerRow, hostname: string) => app.db.prepare(`SELECT c.share, c.old_containers FROM canaries c JOIN domains d ON d.service_id = c.service_id
  JOIN services sv ON sv.id = c.service_id AND sv.server_id = ? WHERE d.hostname = ? AND c.status IN ('starting', 'running', 'held') ORDER BY c.created_at DESC LIMIT 1`).get(s.id, hostname) as { share: number; old_containers: string } | undefined;

export async function putSite(app: App, s: ServerRow, site: Site) {
  const saved = targetOf(app, site.hostname);
  site = { ...site, redirectTo: site.redirectTo ?? saved.redirectTo, redirects: site.redirects ?? saved.redirects };
  site = { ...site, remotes: site.remotes ?? remotesOf(app, s, site.hostname) };
  const canary = site.weights ? undefined : canaryOf(app, s, site.hostname);
  if (canary) site = withCanary(site, json<string[]>(canary.old_containers, []), canary.share);
  const proxy = proxyFor(s);
  if (proxy.kind === 'coolify') return putTraefikSite(app, s, site, proxy);
  if (proxy.kind === 'other') throw new Unit7Error('proxy_taken', `${s.name}'s web ports (80 and 443) belong to ${proxy.name}, so Unit7 can't put ${site.hostname} there. Free them, or deploy to another server.`, 409);
  const file = `/etc/unit7/caddy/sites/${siteFileName(site.hostname)}`;
  const su = s.username === 'root' ? '' : 'sudo ';
  // the working file is kept aside (as .prev, which `import sites/*.caddy` skips) so a file that fails
  // validation never stays live and blocks every later reload
  await ssh(app).check(s, script(`if [ -f "$1" ]; then ${su}cp -p "$1" "$1.prev"; else ${su}rm -f "$1.prev"; fi; printf '%s' "$2" | ${su}tee "$1" >/dev/null`, file, renderSite(site)), { what: 'Writing the site config', timeoutMs: 20_000 });
  try {
    await reload(app, s);
  } catch (e) {
    await ssh(app).exec(s, script(`if [ -f "$1.prev" ]; then ${su}mv -f "$1.prev" "$1"; else ${su}rm -f "$1"; fi`, file)).catch(() => undefined);
    throw e;
  }
}

export async function removeSite(app: App, s: ServerRow, hostname: string) {
  const su = s.username === 'root' ? '' : 'sudo ';
  const proxy = proxyFor(s);
  if (proxy.kind === 'coolify') { await ssh(app).exec(s, script(`${su}rm -f "$1" "$2"`, `${proxy.dir}/${traefikFileName(hostname)}`, `${proxy.dir}/${redirectFileName(hostname)}`)); return; }
  await ssh(app).exec(s, script(`${su}rm -f "$1" "$1.prev"`, `/etc/unit7/caddy/sites/${siteFileName(hostname)}`));
  await reload(app, s).catch(() => undefined); // removing a site that was already broken shouldn't fail
}

// --- Coolify's Traefik: one file per hostname in the folder it watches (Coolify's documented way to add routes).
// Traefik picks a file up within a second; nothing of Coolify's is touched. Apps join Coolify's network so
// Traefik can reach them by container name, and Traefik's own Let's Encrypt resolver handles HTTPS.
export const traefikFileName = (hostname: string) => `unit7-${hostname.replace(/[^a-zA-Z0-9.-]/g, '_')}.yaml`;

// Traefik has no "answer 404" middleware in every version, so Unit7's own routers leave the secret paths out: no
// router matches them, and Traefik answers its own 404. Coolify's routers are never touched. PathRegexp (the *.pem
// and *.key files at the root) is Traefik 3 only; a Traefik 2 proxy gets the rest.
// a wildcard is a HostRegexp, one label deep like its certificate; Traefik 2 spells its pattern differently
const hostRule = (hostname: string, v2: boolean) => {
  if (!hostname.startsWith('*.')) return `Host(\`${hostname}\`)`;
  const base = hostname.slice(2);
  return v2 ? `HostRegexp(\`{sub:[a-z0-9-]+}.${base}\`)` : `HostRegexp(\`^[a-z0-9-]+[.]${base.replace(/\./g, '[.]')}$\`)`;
};
export function traefikRule(hostname: string, v2 = false) {
  const m = SECRET_PATHS.map((p) => p === '/*.pem' || p === '/*.key' ? '' : p.endsWith('*') ? `PathPrefix(\`${p.slice(0, -1)}\`)` : `Path(\`${p}\`)`).filter(Boolean);
  if (!v2) m.push('PathRegexp(`^/[^/]+[.](pem|key)$`)');
  return `${hostRule(hostname, v2)} && !(${m.join(' || ')})`;
}
export const traefikV2 = (s: Pick<ServerRow, 'facts'>) => /\|traefik:v?2(\.|$)/.test(json<{ web?: string }>(s.facts, {}).web ?? '');

export function renderTraefik(s: Site, v2 = false): string {
  if (s.service && !/^[\w.-]+@docker$/.test(s.service)) throw new Unit7Error('bad_route', `“${s.service}” isn’t a Traefik service name.`, 400);
  const upstreams = s.service ? [] : [s.upstream, ...(s.replicas ?? [])];
  upstreams.forEach((u) => safeName(u, 'container name'));
  assertHostname(s.hostname, true);
  const id = `unit7-${s.hostname.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const servers = upstreams.map((u) => `          - url: "http://${u}:${Math.trunc(s.port)}"`).join('\n');
  const secure = s.tls !== 'off';
  const wild = s.hostname.startsWith('*.');
  // a wildcard stands behind every exact name (priority 1, or its long rule would win) and asks for the wildcard certificate
  const low = wild ? ['      priority: 1'] : [];
  const certificate = !wild ? '      tls:\n        certResolver: letsencrypt'
    : `      tls:\n        certResolver: letsencrypt\n        domains:\n          - main: ${s.hostname.slice(2)}\n            sans:\n              - "${s.hostname}"`;
  const service = s.service ?? id;
  if (s.redirectTo) {
    // a redirectRegex middleware on Unit7's own routers for this name (Coolify's are never touched): http and https
    // both go straight to the main address, ${2} keeps the path and the query. The service is only there because a
    // router needs one; the redirect answers first.
    assertHostname(s.redirectTo);
    const to = `${id}-to-main`;
    return [
      'http:',
      '  routers:',
      `    ${id}-http:`,
      `      rule: "${traefikRule(s.hostname, v2)}"`,
      '      entryPoints: [http]',
      `      service: ${service}`,
      `      middlewares: [${to}]`,
      ...(secure ? [
        `    ${id}:`,
        `      rule: "${traefikRule(s.hostname, v2)}"`,
        '      entryPoints: [https]',
        `      service: ${id}`,
        `      middlewares: [${to}]`,
        s.tls === 'internal' ? '      tls: {}' : '      tls:\n        certResolver: letsencrypt',
      ] : []),
      '  middlewares:',
      `    ${to}:`,
      '      redirectRegex:',
      `        regex: '^https?://${s.hostname.replace(/\./g, '\\.')}(:[0-9]+)?/(.*)'`,
      `        replacement: '${secure ? 'https' : 'http'}://${s.redirectTo}/\${2}'`,
      '        permanent: true',
      '  services:',
      `    ${id}:`,
      '      loadBalancer:',
      '        servers:',
      servers,
      '',
    ].join('\n');
  }
  return [
    'http:',
    '  routers:',
    `    ${id}-http:`,
    `      rule: "${traefikRule(s.hostname, v2)}"`,
    '      entryPoints: [http]',
    `      service: ${service}`,
    ...low,
    ...(secure ? [`      middlewares: [${id}-https]`] : []),
    ...(secure ? [
      `    ${id}:`,
      `      rule: "${traefikRule(s.hostname, v2)}"`,
      '      entryPoints: [https]',
      `      service: ${service}`,
      ...low,
      s.tls === 'internal' ? '      tls: {}' : certificate,
      '  middlewares:',
      `    ${id}-https:`,
      '      redirectScheme:',
      '        scheme: https',
      '        permanent: true',
    ] : []),
    ...(s.service ? [] : [
      '  services:',
      `    ${id}:`,
      '      loadBalancer:',
      '        servers:',
      servers,
    ]),
    '',
  ].join('\n');
}

// --- redirects on Coolify's Traefik: one more file in the folder it watches. The folder lives in Coolify's proxy path, so
// its Restart Proxy (which only rewrites the compose file) leaves it alone. Unit7's routers outrank whatever else answers
// the name (Coolify's own routers among them, untouched), so the redirect wins; other paths go on to the app.
export const redirectFileName = (hostname: string) => `unit7-redirect-${hostname.replace(/[^a-zA-Z0-9.-]/g, '_')}.yaml`;
export function renderTraefikRedirects(hostname: string, list: Redirect[]): string {
  assertHostname(hostname);
  const host = hostname.replace(/\./g, '[.]');
  const routers: string[] = [], middlewares: string[] = [];
  checked(list).forEach((r, n) => {
    const id = `unit7-redirect-${hostname.replace(/[^a-zA-Z0-9]/g, '-')}-${n}`;
    const rule = `Host(\`${hostname}\`) && ${r.path ? `(Path(\`${r.path}\`) || PathPrefix(\`${r.path}/\`))` : 'PathPrefix(`/`)'}`;
    const to = r.to.replace(/\/$/, '');
    // the query comes with the regex's last group; Traefik's redirectRegex reads the whole address
    const [regex, replacement] = r.path
      ? [`^https?://${host}(:[0-9]+)?${r.path.replace(/\./g, '[.]')}([/?].*)?$`, r.keepPath ? `${to}\${2}` : r.to]
      : [`^https?://${host}(:[0-9]+)?/(.*)$`, r.keepPath ? `${to}/\${2}` : r.to];
    const router = (name: string, entry: string, tls: string[]) => [`    ${name}:`, `      rule: "${rule}"`, `      entryPoints: [${entry}]`, '      service: noop@internal', `      priority: ${100_000 + (r.path?.length ?? 0)}`, `      middlewares: [${id}-to]`, ...tls];
    routers.push(...router(`${id}-http`, 'http', []), ...router(id, 'https', ['      tls:', '        certResolver: letsencrypt']));
    middlewares.push(`    ${id}-to:`, '      redirectRegex:', `        regex: '${regex}'`, `        replacement: '${replacement}'`, `        permanent: ${r.permanent}`);
  });
  return ['http:', '  routers:', ...routers, '  middlewares:', ...middlewares, ''].join('\n');
}
export async function putTraefikRedirects(app: App, s: ServerRow, hostname: string, list: Redirect[]) {
  const proxy = proxyFor(s), su = s.username === 'root' ? '' : 'sudo ';
  if (proxy.kind !== 'coolify') throw new Unit7Error('not_traefik', `${s.name} doesn’t run Coolify’s proxy.`, 409);
  const file = `${proxy.dir}/${redirectFileName(hostname)}`;
  if (!list.length) { await ssh(app).check(s, script(`${su}rm -f "$1"`, file), { what: 'Taking the redirect off Coolify’s proxy', timeoutMs: 30_000 }); return; }
  await ssh(app).check(s, script(`printf '%s' "$2" | ${su}tee "$1" >/dev/null`, file, renderTraefikRedirects(hostname, list)), { what: 'Adding the redirect to Coolify’s proxy', timeoutMs: 30_000 });
}

async function putTraefikSite(app: App, s: ServerRow, site: Site, proxy: { dir: string; network: string }) {
  const su = s.username === 'root' ? '' : 'sudo ';
  for (const c of site.service ? [] : [site.upstream, ...(site.replicas ?? [])]) {
    // already on the network is fine; anything else is a real failure
    await ssh(app).check(s, script('docker network connect "$1" "$2" 2>&1 | grep -v "already exists" | grep . >&2 && exit 1 || exit 0', proxy.network, c), { what: `Joining ${c} to Coolify's network`, timeoutMs: 30_000 });
  }
  await ssh(app).check(s, script(`printf '%s' "$2" | ${su}tee "$1" >/dev/null`, `${proxy.dir}/${traefikFileName(site.hostname)}`, renderTraefik(site, traefikV2(s))), { what: "Adding the route to Coolify's proxy", timeoutMs: 30_000 });
}

// --- sites written before the secret-file rule: add it in place, nothing else changes ---------------------------
// Pure, so tests can check it: a file that already has the rule comes back unchanged.
export function guardCaddyFile(text: string) {
  return text.includes('@unit7_secrets') ? text : text.replace(/^\timport unit7_blocklist\n/m, (l) => l + CADDY_SECRETS);
}
export function guardTraefikFile(text: string, v2 = false) {
  return text.replace(/^(\s+rule: ")Host\(`([^`]+)`\)"$/gm, (_l, pre: string, host: string) => `${pre}${traefikRule(host, v2)}"`);
}
export async function guardSites(app: App, s: ServerRow): Promise<{ sites: number; updated: string[] }> {
  const proxy = proxyFor(s);
  if (proxy.kind === 'other') return { sites: 0, updated: [] };
  const su = s.username === 'root' ? '' : 'sudo ';
  const dir = proxy.kind === 'coolify' ? proxy.dir : '/etc/unit7/caddy/sites';
  const files = (await ssh(app).check(s, script(`for f in "$1"/${proxy.kind === 'coolify' ? 'unit7-*.yaml' : '*.caddy'}; do [ -f "$f" ] && echo "$f"; done; true`, dir), { what: 'Listing the sites', timeoutMs: 20_000 }))
    .split('\n').map((f) => f.trim()).filter(Boolean);
  const updated: string[] = [];
  for (const f of files) {
    const text = await ssh(app).check(s, script(`${su}cat "$1"`, f), { what: 'Reading a site', timeoutMs: 20_000 });
    const next = proxy.kind === 'coolify' ? guardTraefikFile(text, traefikV2(s)) : guardCaddyFile(text);
    if (next === text) continue;
    // Caddy's working file is kept aside (.prev, which the import skips) until the new one validates
    await ssh(app).check(s, script(`${proxy.kind === 'caddy' ? `${su}cp -p "$1" "$1.prev" && ` : ''}printf '%s' "$2" | ${su}tee "$1" >/dev/null`, f, next), { what: 'Writing a site', timeoutMs: 20_000 });
    updated.push(f);
  }
  if (proxy.kind === 'caddy' && updated.length) {
    try { await reload(app, s); } catch (e) {
      for (const f of updated) await ssh(app).exec(s, script(`${su}mv -f "$1.prev" "$1"`, f)).catch(() => undefined);
      throw e;
    }
  }
  return { sites: files.length, updated };
}

// Does the host's DNS point at this server? (so we can choose real TLS vs an instant sslip.io URL)
export async function pointsHere(hostname: string, serverHost: string): Promise<boolean> {
  const { lookup } = await import('node:dns/promises');
  try {
    const ips = (await lookup(hostname, { all: true })).map((a) => a.address);
    const server = await lookup(serverHost).then((r) => r.address).catch(() => serverHost);
    return ips.includes(server);
  } catch {
    return false;
  }
}

// wildcard: *.example.com is fine too. Only one label deep: that's all a certificate can cover.
export function assertHostname(h: string, wildcard = false) {
  if (!/^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(wildcard ? h.replace(/^\*\./, '') : h)) {
    throw new Unit7Error('bad_hostname', `"${h}" is not a valid domain name.`);
  }
}
