// A client's status page. Unit7 runs on the person's computer, so a page a client can open lives on one of the person's
// servers: a tiny static page (HTML and JSON), behind the proxy that's already there (Unit7's Caddy, or Coolify's Traefik
// with a small file server next to it), at a long random path. It shows each chosen app's name, up or down, 30-day uptime
// and when its last incident was: nothing else (no addresses, server names, settings or logs). A person turns it on;
// Warden pushes fresh files every 5 minutes; the link can be changed (the old one stops working) or turned off.
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { App } from '../app.ts';
import { defineTool, execute, type Actor, type Ctx } from '../tools/runtime.ts';
import { all, get, json, now, run, type DB } from '../db.ts';
import { Unit7Error, forbidden } from '../errors.ts';
import { fid } from '../tools/helpers.ts';
import { serverRow } from '../tools/servers.ts';
import { CADDY_IMAGE } from '../tools/servers.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { assertHostname, proxyFor, reloadCaddy, removeSite, siteFileName, traefikFileName } from '../deploy/caddy.ts';
import { archivedAssets } from '../archive.ts';
import { clientRow, ownership } from './clients.ts';

const DAY = 86400_000;
export const STATUS_DIR = '/etc/unit7/caddy/status'; // unit7-caddy sees it as /etc/caddy/status; the Coolify file server as /srv
const FILE_SERVER = 'unit7-status';

export interface StatusConfig { on?: boolean; serverId?: string; domain?: string; apps?: string[]; publishedAt?: string; routeAt?: string; error?: string; leftover?: { serverId: string; domain: string } }
export interface StatusApp { name: string; status: 'up' | 'down' | 'unknown'; uptime30: number | null; lastIncident: string | null }
export interface StatusPage { title: string; updatedAt: string; apps: StatusApp[] }

// the link's token is a credential: in the vault, never in a table, a log or an AI's view
export const tokenRef = (clientId: string) => `credential://unit7/status-link/${createHash('sha256').update(clientId).digest('hex').slice(0, 24)}`;
export const newToken = () => randomBytes(24).toString('base64url'); // 32 characters

// --- what the page says, pure -----------------------------------------------------------------------------------------------
// Uptime over the last `days` from the outside checks' down and recovered moments (a site still down counts until now)
export function uptime(events: { type: string; at: string }[], at = Date.now(), days = 30): { percent: number; lastIncident?: string } {
  const from = at - days * DAY;
  let down: number | undefined, lost = 0, last: string | undefined;
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const t = Date.parse(e.at);
    if (e.type === 'site.down') { down ??= t; last = e.at; } else if (e.type === 'site.recovered' && down !== undefined) { lost += Math.max(0, Math.min(t, at) - Math.max(down, from)); down = undefined; }
  }
  if (down !== undefined) lost += Math.max(0, at - Math.max(down, from));
  return { percent: Math.floor(Math.max(0, 100 - (lost / (days * DAY)) * 100) * 100) / 100, ...(last && { lastIncident: last }) };
}

// The page's data, built only from a short list of fields: a name, up or down, uptime and the last incident time
export function statusData(db: DB, orgId: string, clientId: string, chosen?: string[], at = Date.now()): StatusPage {
  const c = clientRow(db, orgId, clientId);
  const own = ownership(db, orgId), ix = own.ix, off = archivedAssets(db, orgId);
  const mine = own.ids.get(clientId) ?? new Set<string>();
  const sites = all<{ host: string; asset: string; status: string }>(db, `SELECT host, asset, status FROM watch WHERE org_id = ? AND kind = 'site' AND asset IS NOT NULL`, orgId);
  const events = all<{ type: string; resource: string; at: string }>(db, `SELECT type, resource, created_at at FROM events WHERE org_id = ? AND type IN ('site.down', 'site.recovered') AND created_at > ?`, orgId, new Date(at - 90 * DAY).toISOString());
  const assetsOf = (key: string) => new Set(ix.rows.filter((a) => { const u = ix.up(a.id); return !off.has(a.id) && !!u && (u === key || ix.members.get(u) === key); }).map((a) => a.id));
  const nameOf = (k: string) => (k.startsWith('grp_') ? ix.groups.get(k)?.name : ix.projects.get(k)?.name ?? ix.byId.get(k)?.name);
  // what to show: the chosen ones (still the client's), else each of its products and loose apps that Unit7 checks
  const units = (chosen?.length ? chosen.filter((k) => mine.has(k)) : [...mine].filter((k) => k.startsWith('grp_') || ((k.startsWith('prj_') || ix.up(k) === k) && !ix.members.has(k))))
    .map((k) => { const ids = assetsOf(k); return { name: nameOf(k) ?? 'App', hosts: sites.filter((s) => ids.has(s.asset)) }; })
    .filter((u) => chosen?.length || u.hosts.length);
  return {
    title: c.name, updatedAt: new Date(at).toISOString(),
    apps: units.map((u) => {
      const per = u.hosts.map((h) => uptime(events.filter((e) => e.resource === h.host), at));
      return {
        name: u.name,
        status: !u.hosts.length ? 'unknown' : u.hosts.some((h) => h.status === 'down') ? 'down' : 'up',
        uptime30: per.length ? Math.min(...per.map((p) => p.percent)) : null,
        lastIncident: per.map((p) => p.lastIncident).filter(Boolean).sort().at(-1) ?? null,
      } satisfies StatusApp;
    }).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC';
// No script, no outside font or picture, no form: a page that only shows
export function renderStatusHtml(p: StatusPage): string {
  const down = p.apps.filter((a) => a.status === 'down').length;
  const headline = !p.apps.length ? 'Nothing to show yet' : down ? `${down === p.apps.length ? 'Everything is' : `${down} of ${p.apps.length} ${down === 1 ? 'is' : 'are'}`} down right now` : 'Everything is working';
  const rows = [...p.apps].sort((a, b) => +(b.status === 'down') - +(a.status === 'down')).map((a) => `<li><span class="dot ${a.status}" aria-hidden="true"></span><span class="name">${esc(a.name)}</span><span class="word ${a.status}">${a.status === 'up' ? 'Working' : a.status === 'down' ? 'Down' : 'Not checked yet'}</span>
<span class="meta">${a.uptime30 === null ? '' : `${a.uptime30.toFixed(2)}% up over 30 days · `}${a.lastIncident ? `last problem ${esc(when(a.lastIncident))}` : 'no problems recorded'}</span></li>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="300">
<title>${esc(p.title)} · status</title>
<style>
:root{--bg:#f4f4f6;--card:#fff;--ink:#16161a;--muted:#5d5d68;--line:#e4e4ea;--ok:#147a3d;--bad:#b42318;--idle:#6b6b76}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e11;--card:#18181d;--ink:#f2f2f5;--muted:#a3a3ae;--line:#2a2a31;--ok:#4ade80;--bad:#f87171;--idle:#9b9ba6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 16px}h1{font-size:24px;letter-spacing:-.02em;margin:0 0 4px}
.head{font-size:16px;font-weight:600;margin:0 0 24px;color:${down ? 'var(--bad)' : 'var(--ok)'}}
ul{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden}
li{display:grid;grid-template-columns:12px 1fr auto;gap:4px 12px;align-items:center;padding:16px 18px;border-top:1px solid var(--line)}li:first-child{border-top:0}
.dot{width:10px;height:10px;border-radius:50%;background:var(--idle)}.dot.up{background:var(--ok)}.dot.down{background:var(--bad)}
.name{font-weight:600;overflow-wrap:anywhere}.word{font-size:13px;font-weight:600;color:var(--idle)}.word.up{color:var(--ok)}.word.down{color:var(--bad)}
.meta{grid-column:2/4;font-size:13px;color:var(--muted)}footer{margin-top:16px;font-size:12.5px;color:var(--muted)}
</style></head>
<body><main><h1>${esc(p.title)}</h1><p class="head">${headline}</p>
<ul>
${rows}
</ul>
<footer>Updated ${esc(when(p.updatedAt))}. This page refreshes every 5 minutes.</footer></main></body></html>
`;
}

// --- where it lives: the proxy's own route, nothing of anyone else's touched ----------------------------------------------------
const HEADERS = `"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"`;
export function caddyRoute(domain: string, token: string, clientId: string): string {
  assertHostname(domain);
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token) || !/^cli_[A-Za-z0-9_-]{12}$/.test(clientId)) throw new Error('bad status link');
  return `${domain} {
\timport unit7_blocklist
\theader {
\t\t-Server
\t\tX-Robots-Tag "noindex, nofollow"
\t\tReferrer-Policy "no-referrer"
\t\tX-Content-Type-Options "nosniff"
\t\tContent-Security-Policy ${HEADERS}
\t\tCache-Control "no-store"
\t}
\tredir /${token} /${token}/ 308
\thandle_path /${token}/* {
\t\troot * /etc/caddy/status/${clientId}
\t\tfile_server
\t}
\thandle {
\t\trespond 404
\t}
}
`;
}
// Traefik can rate-limit (stock Caddy can't): 30 a minute per visitor
export function traefikRoute(domain: string, token: string, clientId: string): string {
  assertHostname(domain);
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token) || !/^cli_[A-Za-z0-9_-]{12}$/.test(clientId)) throw new Error('bad status link');
  const n = `unit7-status-${domain.replace(/[^a-zA-Z0-9]/g, '-')}`;
  return [
    'http:',
    '  routers:',
    `    ${n}-http:`,
    `      rule: "Host(\`${domain}\`)"`,
    '      entryPoints: [http]',
    `      middlewares: [${n}-https]`,
    `      service: ${n}`,
    `    ${n}:`,
    `      rule: "Host(\`${domain}\`) && PathPrefix(\`/${token}/\`)"`,
    '      entryPoints: [https]',
    `      middlewares: [${n}-limit, ${n}-path, ${n}-headers]`,
    `      service: ${n}`,
    '      tls:',
    '        certResolver: letsencrypt',
    '  middlewares:',
    `    ${n}-https:`,
    '      redirectScheme:',
    '        scheme: https',
    '        permanent: true',
    `    ${n}-limit:`,
    '      rateLimit:',
    '        average: 30',
    '        period: 1m',
    '        burst: 30',
    `    ${n}-path:`,
    '      replacePathRegex:',
    `        regex: "^/${token}/(.*)"`,
    `        replacement: "/${clientId}/$1"`,
    `    ${n}-headers:`,
    '      headers:',
    '        frameDeny: true',
    '        contentTypeNosniff: true',
    '        referrerPolicy: no-referrer',
    `        contentSecurityPolicy: ${HEADERS}`,
    '        customResponseHeaders:',
    '          X-Robots-Tag: "noindex, nofollow"',
    '          Cache-Control: "no-store"',
    '          Server: ""',
    '  services:',
    `    ${n}:`,
    '      loadBalancer:',
    '        servers:',
    `          - url: "http://${FILE_SERVER}:8080"`,
    '',
  ].join('\n');
}

const su = (s: ServerRow) => (s.username === 'root' ? '' : 'sudo ');
function proxyOrRefuse(s: ServerRow) {
  const p = proxyFor(s);
  if (p.kind === 'other') throw new Unit7Error('proxy_taken', `${s.name}'s web ports belong to ${p.name}, so Unit7 can't put a status page there. Pick another server.`, 409);
  return p;
}

// the two files, each written aside and moved into place, so a visitor never gets half a page
export async function pushFiles(app: App, s: ServerRow, clientId: string, page: StatusPage) {
  const dir = `${STATUS_DIR}/${clientId}`, x = su(s);
  await ssh(app).check(s, script(`${x}mkdir -p "$1" && printf '%s' "$2" | ${x}tee "$1/.index.html" >/dev/null && ${x}mv -f "$1/.index.html" "$1/index.html" && printf '%s' "$3" | ${x}tee "$1/.status.json" >/dev/null && ${x}mv -f "$1/.status.json" "$1/status.json"`,
    dir, renderStatusHtml(page), JSON.stringify(page)), { what: 'Writing the status page', timeoutMs: 30_000 });
}

export async function putRoute(app: App, s: ServerRow, domain: string, token: string, clientId: string) {
  const p = proxyOrRefuse(s), x = su(s);
  if (p.kind === 'coolify') {
    // a small read-only file server next to Coolify's proxy (Traefik can't serve files itself)
    await ssh(app).check(s, script(`[ "$(docker inspect -f '{{.State.Running}}' ${FILE_SERVER} 2>/dev/null)" = true ] && exit 0; docker rm -f ${FILE_SERVER} >/dev/null 2>&1;
docker run -d --name ${FILE_SERVER} --restart unless-stopped --network "$1" --read-only --tmpfs /config --tmpfs /data --cap-drop ALL --security-opt no-new-privileges --memory 64m --cpus 0.25 \
  -v "$2":/srv:ro "$3" caddy file-server --root /srv --listen :8080 >/dev/null`, p.network, STATUS_DIR, CADDY_IMAGE), { what: 'Starting the status page’s file server', timeoutMs: 300_000 });
    // the route carries the link's token, so it goes on stdin: a command-line argument shows in the server's process list
    await ssh(app).check(s, script(`${x}tee "$1" >/dev/null`, `${p.dir}/${traefikFileName(domain)}`), { what: "Adding the status page to Coolify's proxy", timeoutMs: 30_000, stdin: traefikRoute(domain, token, clientId) });
    return;
  }
  const file = `/etc/unit7/caddy/sites/${siteFileName(domain)}`;
  // never over someone's site: only a file that's empty or already a status page is replaced
  await ssh(app).check(s, script(`if [ -f "$1" ] && ! grep -q '/etc/caddy/status/' "$1"; then echo "$2 already has a site on this server" >&2; exit 3; fi
if [ -f "$1" ]; then ${x}cp -p "$1" "$1.prev"; else ${x}rm -f "$1.prev"; fi; ${x}tee "$1" >/dev/null`, file, domain), { what: 'Writing the status page’s route', timeoutMs: 20_000, stdin: caddyRoute(domain, token, clientId) });
  try { await reloadCaddy(app, s); } catch (e) {
    await ssh(app).exec(s, script(`if [ -f "$1.prev" ]; then ${x}mv -f "$1.prev" "$1"; else ${x}rm -f "$1"; fi`, file)).catch(() => undefined);
    throw e;
  }
}

export async function takeDown(app: App, s: ServerRow, domain: string, clientId: string) {
  if (!/^cli_[A-Za-z0-9_-]{12}$/.test(clientId)) throw new Error('bad client id');
  await removeSite(app, s, domain); // the route first: the link stops working at once
  await ssh(app).check(s, script(`${su(s)}rm -rf -- "$1"`, `${STATUS_DIR}/${clientId}`), { what: 'Removing the status page', timeoutMs: 20_000 });
}

// --- the tool ------------------------------------------------------------------------------------------------------------------
const save = (db: DB, clientId: string, cfg: StatusConfig) => run(db, 'UPDATE clients SET status = ? WHERE id = ?', JSON.stringify(cfg), clientId);
const view = (ctx: Ctx, cfg: StatusConfig, token?: string) => {
  const server = cfg.serverId ? get<{ name: string }>(ctx.db, 'SELECT name FROM servers WHERE id = ?', cfg.serverId)?.name : undefined;
  return { on: !!cfg.on, ...(cfg.on && { domain: cfg.domain, server, apps: cfg.apps ?? null, updatedAt: cfg.publishedAt }),
    ...(cfg.on && token && cfg.domain && { url: { __reveal: `https://${cfg.domain}/${token}/` } }), ...(cfg.error && { problem: cfg.error }), ...(cfg.leftover && { leftover: true }) };
};
const changes = (i: { serverId?: string; domain?: string; apps?: string[]; rotate?: boolean }) => !!(i.serverId || i.domain || i.apps || i.rotate);

defineTool({
  name: 'client.status_link', title: 'A client’s status page',
  risk: (i) => (i.enabled === undefined && !i.rotate ? 'read' : 'write'), action: (i) => (i.enabled === undefined && !i.rotate ? 'read' : 'status_publish'),
  // turning it on, moving it, changing what it shows and changing the link are a person's; refreshing and turning it off aren't
  peopleOnly: (i) => i.enabled !== false && changes(i),
  description: 'A small public page for a client, on one of your servers: each chosen app’s name, up or down, 30-day uptime and its last incident, nothing else (no addresses, server names, settings or logs). Without enabled it reads the state (a person sees the link). enabled true with serverId and domain (a name of its own, like status.example.com, pointed at that server) turns it on: a person does that. rotate makes a new link (the old one stops working). enabled false takes it down. Once on, Warden refreshes it every 5 minutes.',
  input: z.object({ clientId: z.string().regex(/^cli_[A-Za-z0-9_-]{12}$/), enabled: z.boolean().optional(), serverId: fid('srv').optional(), domain: z.string().trim().toLowerCase().max(253).optional(),
    apps: z.array(z.string().regex(/^(ast|prj|grp)_[A-Za-z0-9_-]{12}$/)).max(50).optional(), rotate: z.boolean().optional() }),
  async run(ctx, i) {
    const c = clientRow(ctx.db, ctx.orgId, i.clientId);
    const cfg = json<StatusConfig>(c.status, {});
    const ref = tokenRef(c.id);
    const token = () => ctx.secret(ref);
    if (i.enabled === undefined && !i.rotate) return view(ctx, cfg, cfg.on ? token() : undefined);

    if (i.enabled === false) {
      const where = cfg.on && cfg.serverId && cfg.domain ? { serverId: cfg.serverId, domain: cfg.domain } : cfg.leftover;
      if (ctx.app.vault.has(ctx.orgId, ref)) ctx.app.vault.retire(ctx.orgId, ref); // the link is dead from here on
      if (!where) { save(ctx.db, c.id, {}); return view(ctx, {}); }
      try {
        await takeDown(ctx.app, serverRow(ctx, where.serverId), where.domain, c.id);
        if (cfg.on && cfg.leftover && get(ctx.db, 'SELECT 1 FROM servers WHERE id = ? AND org_id = ?', cfg.leftover.serverId, ctx.orgId)) await takeDown(ctx.app, serverRow(ctx, cfg.leftover.serverId), cfg.leftover.domain, c.id).catch(() => undefined);
        save(ctx.db, c.id, { apps: cfg.apps });
        if (cfg.on) ctx.emit('status.off', `${ctx.actor.name} turned off ${c.name}’s status page`, { severity: 'info', resource: c.id });
        return view(ctx, {});
      } catch (e) {
        // off here at once; the files go as soon as the server answers (Warden tries again every 5 minutes)
        save(ctx.db, c.id, { apps: cfg.apps, leftover: where, error: `Turned off, but the page couldn’t be removed from the server yet: ${(e as Error).message.slice(0, 160)}` });
        return { ...view(ctx, json(get<{ status: string }>(ctx.db, 'SELECT status FROM clients WHERE id = ?', c.id)!.status, {})), note: 'Unit7 removes the files as soon as the server answers.' };
      }
    }

    // on: the first time (or after it was off), moving it and a new link are a person's; anyone may refresh it
    if (!cfg.on && ctx.actor.kind !== 'user') throw forbidden('Only a person can turn on a client’s status page.');
    if (i.rotate && !cfg.on && i.enabled === undefined) throw new Unit7Error('invalid_input', 'The status page is off, so there’s no link to change.');
    const serverId = i.serverId ?? cfg.serverId, domain = i.domain ?? cfg.domain;
    if (!serverId || !domain) throw new Unit7Error('invalid_input', 'Pick a server for the page and a name for it, like status.example.com.');
    assertHostname(domain);
    const used = get<{ name: string }>(ctx.db, `SELECT s.name FROM domains d LEFT JOIN services s ON s.id = d.service_id WHERE d.org_id = ? AND d.hostname = ?`, ctx.orgId, domain)
      ?? get<{ name: string }>(ctx.db, `SELECT a.name FROM edges e JOIN assets d ON d.id = e.source JOIN assets a ON a.id = e.target WHERE e.org_id = ? AND d.kind = 'domain' AND d.name = ? AND e.kind IN ('domain', 'dns') AND a.kind != 'server'`, ctx.orgId, domain);
    if (used) throw new Unit7Error('invalid_input', `${domain} already points at ${used.name ?? 'an app'}. Give the page a name of its own, like status.${domain.replace(/^[^.]+\.(?=.+\..+)/, '')}.`);
    const s = serverRow(ctx, serverId);
    proxyOrRefuse(s);
    const route = !cfg.on || !!i.rotate || serverId !== cfg.serverId || domain !== cfg.domain;
    const apps = i.apps ?? cfg.apps;
    const page = statusData(ctx.db, ctx.orgId, c.id, apps);
    try {
      // moved: the old place goes first; one that can't be reached yet is kept as leftover and removed on a later refresh
      let leftover = cfg.leftover;
      const old = cfg.on && cfg.serverId && cfg.domain && (cfg.serverId !== serverId || cfg.domain !== domain) ? { serverId: cfg.serverId, domain: cfg.domain } : undefined;
      if (old) leftover = old;
      if (leftover && get(ctx.db, 'SELECT 1 FROM servers WHERE id = ? AND org_id = ?', leftover.serverId, ctx.orgId)) {
        const gone = leftover;
        if (await takeDown(ctx.app, serverRow(ctx, gone.serverId), gone.domain, c.id).then(() => true, () => false)) leftover = undefined;
      } else leftover = undefined; // that server isn't Unit7's any more
      // a new link only when it's turned on or changed; it's kept once the server has it
      const fresh = !cfg.on || !!i.rotate || !ctx.app.vault.has(ctx.orgId, ref);
      const t = route ? (fresh ? newToken() : token()) : undefined;
      if (t) ctx.redactor.add(t, ref);
      ctx.progress(`Putting ${c.name}’s status page on ${s.name}…`);
      await pushFiles(ctx.app, s, c.id, page);
      if (t) { await putRoute(ctx.app, s, domain, t, c.id); if (fresh) ctx.app.vault.put(ctx.orgId, ref, t, { kind: 'status_link', by: ctx.actor.name }); }
      const at = now();
      const next: StatusConfig = { on: true, serverId, domain, ...(apps && { apps }), publishedAt: at, routeAt: route ? at : cfg.routeAt, ...(leftover && { leftover }) };
      save(ctx.db, c.id, next);
      if (!cfg.on) ctx.emit('status.on', `${ctx.actor.name} turned on ${c.name}’s status page`, { severity: 'info', resource: c.id });
      if (i.rotate && cfg.on) ctx.emit('status.rotated', `${ctx.actor.name} changed ${c.name}’s status page link; the old one no longer works`, { severity: 'info', resource: c.id });
      return { ...view(ctx, next, ctx.actor.kind === 'user' ? t ?? token() : undefined), shows: page.apps.map((a) => a.name),
        ...(!cfg.on && { next: `Point ${domain} at ${s.name} (an A record to its address) if it doesn’t already; HTTPS comes on by itself once it does.` }) };
    } catch (e) {
      save(ctx.db, c.id, { ...cfg, error: (e as Error).message.slice(0, 200) });
      throw e;
    }
  },
});

// --- Warden, every 5 minutes: each page that's on gets fresh files; one turned off that the server didn't answer goes now ------
const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };
export async function refreshStatusPages(app: App) {
  const list = all<{ id: string; org_id: string; status: string; autonomy: number }>(app.db, `SELECT c.id, c.org_id, c.status, o.autonomy FROM clients c JOIN orgs o ON o.id = c.org_id
    WHERE json_extract(c.status, '$.on') = 1 OR json_extract(c.status, '$.leftover') IS NOT NULL`);
  for (const c of list) {
    if (c.autonomy < 2) continue; // "Watch only" and "Suggest": Unit7 doesn't change anything by itself, so the page waits
    const on = !!json<StatusConfig>(c.status, {}).on;
    await execute(app, c.org_id, WARDEN, 'client.status_link', { clientId: c.id, enabled: on }, { reason: on ? 'Warden: keeping a client’s status page fresh' : 'Warden: removing a status page that was turned off' })
      .catch(() => undefined);
  }
}
