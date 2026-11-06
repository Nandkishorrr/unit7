// The map: one sync looks at every connected account (any number per provider: 34 Vercel accounts is
// fine), lists every app, site, database, server and domain, and works out what's wired to what —
// from DNS records, domains added on hosts, and the URLs in each app's settings. Each account's last
// good scan is kept, so an expired token never wipes its part of the map. Warden syncs each organisation
// on its own schedule (sync.schedule: every 6 hours unless changed).
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { defineTool, execute, noteAccountTrouble, type Ctx } from './runtime.ts';
import { all, get, id, json, now, run, tx, type DB } from '../db.ts';
import { isAgent, requireRole } from './helpers.ts';
import { pool, scanUnit7, SCANNERS, type Scan } from '../discovery/scanners.ts';
import { mergeFound, resolve, domainKey, UNCLAIMED, type Found, type Issue, type Ref } from '../discovery/model.ts';
import { assertReachable } from '../netguard.ts';
import { publicResolver } from '../connectors/dnsinfo.ts';
import { suggest, thingsFrom } from './links.ts';
import { watchIssues, watchRows, checkSites, checkDaily } from '../sentinel/watch.ts';
import { archivedAssets } from '../archive.ts';
import { keptMarks } from '../kept.ts';
import { withGroups } from '../organize/groups.ts';
import { snoozeKeyOf, snoozeState, visible } from '../snooze.ts';

const assetId = (orgId: string, key: string) => `ast_${createHash('sha256').update(`${orgId}\n${key}`).digest('base64url').slice(0, 12)}`;
// A name is gone only when public DNS says so for A, AAAA and CNAME alike. A timeout or SERVFAIL proves nothing
// (undefined), and an IPv6-only name exists.
type NameLookup = { resolve4(n: string): Promise<unknown[]>; resolve6(n: string): Promise<unknown[]>; resolveCname(n: string): Promise<unknown[]> };
export async function nameMissing(name: string, dns: NameLookup = publicNames()): Promise<boolean | undefined> {
  const ask = (p: Promise<unknown[]>) => p.then((x) => (x.length ? 'yes' : 'no'), (e: { code?: string }) => (e?.code === 'ENOTFOUND' || e?.code === 'ENODATA' ? 'no' : 'unknown'));
  const answers = await Promise.all([ask(dns.resolve4(name)), ask(dns.resolve6(name)), ask(dns.resolveCname(name))]);
  return answers.includes('yes') ? false : answers.every((a) => a === 'no') ? true : undefined;
}
function publicNames() { const r = new Resolver({ timeout: 4000, tries: 2 }); r.setServers(['1.1.1.1', '8.8.8.8']); return r; }

const withTimeout = <T>(p: Promise<T>, ms: number, why: string) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(why)), ms).unref())]);

// --- auto-sync: how often Warden syncs an organisation by itself (minutes; 0 = off) ---
export const AUTO_SYNC = { '15m': 15, '1h': 60, '6h': 360, '1d': 1440, off: 0 } as const;
export type AutoSyncEvery = keyof typeof AUTO_SYNC;
// a sync older than 20 minutes that never finished crashed; it doesn't hold the next one up
export const syncRunning = (db: DB, orgId: string) => !!get(db, `SELECT 1 FROM sync_runs WHERE org_id = ? AND status = 'running' AND started_at > ?`, orgId, new Date(Date.now() - 20 * 60_000).toISOString());
// The scheduling decision, pure: the next automatic sync is one interval after the last sync started (by
// hand or not, finished or not), so a failing one is never retried every minute. Never synced = now; off = never.
export function nextAutoSync(every: string, lastStartedAt: string | null, at = Date.now()): number | null {
  const min = AUTO_SYNC[every as AutoSyncEvery] ?? AUTO_SYNC['6h'];
  if (!min) return null;
  return lastStartedAt ? Date.parse(lastStartedAt) + min * 60_000 : at;
}
export function syncDue(s: { every: string; lastStartedAt: string | null; running: boolean }, at = Date.now()) {
  const next = nextAutoSync(s.every, s.lastStartedAt, at);
  return !s.running && next !== null && next <= at;
}
export function autoSync(db: DB, orgId: string) {
  const every = (get<{ sync_every: string }>(db, 'SELECT sync_every FROM orgs WHERE id = ?', orgId)?.sync_every ?? '6h') as AutoSyncEvery;
  const lastStartedAt = get<{ at: string | null }>(db, 'SELECT max(started_at) at FROM sync_runs WHERE org_id = ?', orgId)?.at ?? null;
  const lastSyncAt = get<{ at: string | null }>(db, `SELECT max(finished_at) at FROM sync_runs WHERE org_id = ? AND status = 'done'`, orgId)?.at ?? null;
  const next = nextAutoSync(every, lastStartedAt);
  return { every, lastSyncAt, lastStartedAt, nextSyncAt: next === null ? null : new Date(next).toISOString(), running: syncRunning(db, orgId) };
}

// A recheck (o.only): only those scopes are scanned again ('unit7' and account ids); every other one comes from its last
// scan, so a fix shows on the map in seconds instead of at the next sync. It rewrites the last sync's result in place
// (the next automatic sync isn't pushed back) and checks takeovers only for o.hosts and the ones already flagged.
export async function runSync(ctx: Ctx, o: { only?: string[]; hosts?: string[] } = {}) {
  // one sync per organisation at a time, whoever starts it (check and claim with no await between)
  if (syncRunning(ctx.db, ctx.orgId)) return { skipped: true, note: 'A sync is already running.' };
  const t0 = Date.now();
  const lastDone = get<{ id: string; summary: string }>(ctx.db, `SELECT id, summary FROM sync_runs WHERE org_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`, ctx.orgId);
  const prevIssues = json<{ issues?: Issue[] }>(lastDone?.summary ?? '{}', {}).issues ?? [];
  const partial = !!o.only && !!lastDone; // never synced: a recheck is a full sync
  const runId = partial ? lastDone!.id : id('syn');
  if (!partial) run(ctx.db, 'INSERT INTO sync_runs (id, org_id, started_at) VALUES (?, ?, ?)', runId, ctx.orgId, now());
  run(ctx.db, `DELETE FROM scan_cache WHERE org_id = ? AND scope != 'unit7' AND scope NOT IN (SELECT id FROM accounts WHERE org_id = ?)`, ctx.orgId, ctx.orgId);
  const accounts = all<{ id: string; name: string; provider: string }>(ctx.db, 'SELECT id, name, provider FROM accounts WHERE org_id = ? ORDER BY provider, name', ctx.orgId).filter((a) => SCANNERS[a.provider]);
  const scopes = [{ id: 'unit7', name: 'Unit7', provider: 'unit7' }, ...accounts];
  let done = 0;

  // every account in parallel (6 at a time); a failure falls back to that account's last good scan
  const cached = (s: { id: string; name: string; provider: string }) => {
    const c = get<{ found: string; refs: string; at: string; ok: number; note: string | null }>(ctx.db, 'SELECT found, refs, at, ok, note FROM scan_cache WHERE org_id = ? AND scope = ?', ctx.orgId, s.id);
    const found = json<Found[]>(c?.found ?? '[]', []);
    return { s, ok: !c || !!c.ok, note: c?.ok ? undefined : c?.note ?? undefined, staleSince: c && !c.ok && found.length ? c.at : undefined, found, refs: json<Ref[]>(c?.refs ?? '[]', []) };
  };
  const results = await pool(scopes, 6, async (s) => {
    if (partial && !o.only!.includes(s.id)) return cached(s);
    try {
      const r: Scan = s.id === 'unit7' ? await scanUnit7(ctx) : await withTimeout(SCANNERS[s.provider]!(ctx, s.id), 180_000, 'took longer than 3 minutes');
      run(ctx.db, `INSERT INTO scan_cache (org_id, scope, found, refs, ok, note, at) VALUES (?, ?, ?, ?, 1, NULL, ?)
        ON CONFLICT(org_id, scope) DO UPDATE SET found = excluded.found, refs = excluded.refs, ok = 1, note = NULL, at = excluded.at`, ctx.orgId, s.id, JSON.stringify(r.found), JSON.stringify(r.refs), now());
      ctx.progress(`${++done}/${scopes.length} · ${s.name}: ${r.found.length} found`);
      return { s, ok: true, note: undefined as string | undefined, staleSince: undefined as string | undefined, ...r };
    } catch (e) {
      // a recheck that may not use an account right now (paused, or not bound where the fix ran) keeps its last scan: not a new failure
      if (partial && ['account_paused', 'forbidden', 'no_account'].includes((e as { code?: string })?.code ?? '')) return cached(s);
      if (s.id !== 'unit7') noteAccountTrouble(ctx.app, s.id, e); // a refused or rate-limited account is left alone next time
      const note = (e as Error).message.slice(0, 200).replace(/\.+$/, '');
      const prev = get<{ found: string; refs: string; at: string; ok: number }>(ctx.db, 'SELECT found, refs, at, ok FROM scan_cache WHERE org_id = ? AND scope = ?', ctx.orgId, s.id);
      run(ctx.db, `INSERT INTO scan_cache (org_id, scope, found, refs, ok, note, at) VALUES (?, ?, '[]', '[]', 0, ?, ?) ON CONFLICT(org_id, scope) DO UPDATE SET ok = 0, note = excluded.note`, ctx.orgId, s.id, note, now());
      ctx.progress(`${++done}/${scopes.length} · ${s.name}: couldn't scan (${note})`);
      return { s, ok: false, note, staleSince: prev?.ok ? prev.at : undefined, found: json<Found[]>(prev?.found ?? '[]', []), refs: json<Ref[]>(prev?.refs ?? '[]', []) };
    }
  });

  const found = mergeFound(results.flatMap((r) => r.found));
  const refs = results.flatMap((r) => r.refs);
  // domains added on a host whose DNS no scanned account serves: ask public DNS what they point at
  const dns = publicResolver();
  const known = new Set(refs.filter((r) => r.kind === 'dns').map((r) => r.from));
  const ask = [...new Set(refs.filter((r) => r.kind === 'domain' && r.host).map((r) => r.host!))].filter((h) => !known.has(domainKey(h)));
  await pool(ask, 8, async (h) => {
    const cname = await dns.cname(h).catch(() => [] as string[]);
    const a = cname.length ? [] : await dns.a(h).catch(() => [] as string[]);
    for (const c of cname) refs.push({ from: domainKey(h), kind: 'dns', via: `CNAME ${c.toLowerCase()} (public DNS)`, host: c.toLowerCase().replace(/\.$/, '') });
    for (const ip of a) refs.push({ from: domainKey(h), kind: 'dns', via: `A ${ip} (public DNS)`, ip });
  });
  for (const h of new Set(refs.filter((r) => r.kind === 'domain' && r.host).map((r) => r.host!))) if (!found.has(domainKey(h))) found.set(domainKey(h), { provider: 'domain', kind: 'domain', extId: h, name: h });
  // every PlanetScale database in a region shares one address, so only Unit7's own connection says which one an app uses
  const byEnd = new Map([...found].filter(([, f]) => f.end).map(([k, f]) => [JSON.stringify(f.end), k]));
  for (const l of all<{ source: string; target: string }>(ctx.db, `SELECT source, target FROM links WHERE org_id = ? AND json_extract(source, '$.kind') = 'planetscale'`, ctx.orgId)) {
    const db = byEnd.get(l.source), app = byEnd.get(l.target);
    if (db && app) refs.push({ from: app, kind: 'env', via: 'connected by Unit7', to: db });
  }

  const { edges, issues, dangling } = resolve(found, refs);
  // a CNAME to a platform app that no longer exists: whoever creates that app gets the domain
  const flagged = new Set(prevIssues.filter((x) => x.key.startsWith('takeover:')).map((x) => x.key.slice(9)));
  await pool(partial ? dangling.filter((d) => flagged.has(d.domain) || o.hosts?.includes(d.domain)) : dangling, 8, async (d) => {
    // gone from DNS, or the platform answers with its "nobody has this name" page (they answer every name)
    const nx = (await nameMissing(d.target)) === true;
    const sig = UNCLAIMED[d.platform];
    const gone = nx || (!!sig && await assertReachable(d.domain).then(() => fetch(`http://${d.domain}/`, { signal: AbortSignal.timeout(8000) }).then((r) => r.text()).then((t) => sig.test(t.slice(0, 20_000)))).catch(() => false));
    if (!gone) return;
    issues.unshift({ severity: 'critical', key: `takeover:${d.domain}`, about: domainKey(d.domain), text: `${d.domain} points at ${d.target}, which no longer exists. Anyone can create a ${d.platform} app with that name and serve your domain. Remove or fix that DNS record.` });
    if (!partial || !flagged.has(d.domain)) ctx.emit('domain.takeover_risk', `${d.domain} points at ${d.target}, which no longer exists (anyone could claim it).`, { severity: 'critical', resource: d.domain });
  });
  for (const r of results.filter((x) => !x.ok)) issues.push({ severity: 'warning', key: `scan:${r.s.id}`, text: `${r.s.name} (${r.s.provider}) couldn't be read: ${r.note}${r.staleSince ? `. Showing what it had at ${r.staleSince.slice(0, 16).replace('T', ' ')}.` : ''}` });
  const suggestions = suggest(thingsFrom(found.values()), all(ctx.db, 'SELECT source, target FROM links WHERE org_id = ?', ctx.orgId));

  tx(ctx.db, () => {
    run(ctx.db, 'DELETE FROM edges WHERE org_id = ?', ctx.orgId);
    run(ctx.db, 'DELETE FROM assets WHERE org_id = ?', ctx.orgId);
    const at = now();
    for (const [k, f] of found) {
      const { provider, kind, extId, name, url, accountId, ...meta } = f;
      run(ctx.db, 'INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        assetId(ctx.orgId, k), ctx.orgId, accountId ?? null, provider, kind, extId, name, url ?? null, JSON.stringify(meta), at);
    }
    for (const e of edges) run(ctx.db, 'INSERT OR IGNORE INTO edges (id, org_id, source, target, kind, via, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id('edg'), ctx.orgId, assetId(ctx.orgId, e.from), assetId(ctx.orgId, e.to), e.kind, e.via, e.status, e.detail ?? null);
  });

  const count = (k: string) => [...found.values()].filter((f) => f.kind === k).length;
  const summary = {
    ms: Date.now() - t0,
    counts: { apps: count('app'), databases: count('database'), servers: count('server'), domains: count('domain'), connections: edges.length },
    accounts: results.map((r) => ({ id: r.s.id, name: r.s.name, provider: r.s.provider, ok: r.ok, note: r.note, found: r.found.length, staleSince: r.staleSince })),
    issues, suggestions,
  };
  // what the last look flagged and this one doesn't: it's fixed, and Activity says so
  const nowKeys = new Set(issues.map((x) => x.key));
  for (const x of prevIssues.filter((p) => !nowKeys.has(p.key))) ctx.emit('alert.cleared', `Cleared: ${x.text.replace(/ couldn't be read: [\s\S]*$/, ' can be read again').replace(/\.$/, '')}`, { severity: 'success', resource: x.about, data: { key: x.key, source: 'map' } });
  if (partial) {
    // a recheck rewrites the last result in place: the next automatic sync keeps its time
    run(ctx.db, `UPDATE sync_runs SET summary = ? WHERE id = ?`, JSON.stringify({ ...json<object>(lastDone!.summary, {}), ...summary, rechecked: now() }), runId);
    // live only (pages refetch; Activity shows what cleared, not every look)
    ctx.app.events.emit(ctx.orgId, 'map.rechecked', 'Checked again', { live: true, data: { issues: issues.length } });
    return { runId, partial: true, ...summary, suggestions: suggestions.length };
  }
  run(ctx.db, `UPDATE sync_runs SET finished_at = ?, status = 'done', summary = ? WHERE id = ?`, now(), JSON.stringify(summary), runId);
  run(ctx.db, `DELETE FROM sync_runs WHERE org_id = ? AND id NOT IN (SELECT id FROM sync_runs WHERE org_id = ? ORDER BY started_at DESC LIMIT 20)`, ctx.orgId, ctx.orgId);
  const c = summary.counts;
  ctx.emit('sync.done', `Map updated: ${c.apps} apps, ${c.databases} databases, ${c.servers} servers, ${c.domains} domains across ${accounts.length} accounts${issues.length ? `; ${issues.length} to look at` : ''}`, { severity: issues.some((i) => i.severity === 'critical') ? 'critical' : 'info' });
  return { runId, ...summary, suggestions: suggestions.length };
}

defineTool({
  name: 'sync.run', title: 'Sync everything', risk: 'read', action: 'read', timeoutMs: 20 * 60_000,
  description: 'Look at every connected account (all of them, any number per provider) and rebuild the map: every app, site, database, server and domain, and what is wired to what (DNS, domains added on hosts, URLs in settings). Finds problems: domains pointing elsewhere, CNAMEs to apps that no longer exist, apps using paused databases. Warden runs this on the organisation\u2019s auto-sync schedule (sync.schedule).',
  input: z.object({}),
  run: (ctx) => runSync(ctx),
});

defineTool({
  name: 'sync.start', title: 'Start a sync', risk: 'read', action: 'read',
  description: 'Start a sync in the background (progress shows live); map.get has the result.',
  input: z.object({}),
  run(ctx) {
    if (syncRunning(ctx.db, ctx.orgId)) return { started: false, note: 'A sync is already running.' };
    void execute(ctx.app, ctx.orgId, ctx.actor, 'sync.run', {}, { reason: 'sync started' });
    return { started: true };
  },
});

defineTool({
  name: 'sync.schedule', title: 'Change how often the map syncs', risk: (i) => (i.every ? 'write' : 'read'), action: (i) => (i.every ? 'settings_write' : 'read'),
  description: 'How often Unit7 syncs the map by itself: every 15 minutes (15m), every hour (1h), every 6 hours (6h, the default), once a day (1d), or off. Without `every` it only reads the setting. Returns it with when the map last synced and when it syncs next. A newly connected account is synced within a minute either way. Owners and admins change it; an AI within its Autopilot level.',
  input: z.object({ every: z.enum(Object.keys(AUTO_SYNC) as [AutoSyncEvery, ...AutoSyncEvery[]]).optional() }),
  run(ctx, i) {
    if (i.every) {
      if (!isAgent(ctx)) requireRole(ctx, ['owner', 'admin'], 'change how often the map syncs');
      run(ctx.db, 'UPDATE orgs SET sync_every = ? WHERE id = ?', i.every, ctx.orgId);
    }
    return autoSync(ctx.db, ctx.orgId);
  },
});

// A hidden issue stops flagging what it's about: a hidden "down" or "slow" drops that site's live check, a hidden
// HTTPS, registration or email alert drops that check, and a hidden "points elsewhere" stops drawing its line red (it
// reads as not checked). includeHidden shows both again.
const CHECK: Record<string, string> = { tls: 'tls', reg: 'registration', email: 'email' };
export function quiet(orgId: string, hidden: Issue[], o: { sites: Record<string, { host: string }>; checks: Record<string, Record<string, unknown>>; edges: { source: string; target: string; status: string }[] }) {
  for (const x of hidden) {
    const kind = x.key.split(':')[0]!, tail = x.key.slice(kind.length + 1);
    if (kind === 'down' || kind === 'slow') for (const [id, s] of Object.entries(o.sites)) if (s.host === tail) delete o.sites[id];
    if (CHECK[kind]) delete o.checks[tail]?.[CHECK[kind]];
    if (kind === 'dns') { // dns:domain:<host>:<app key>
      const host = tail.split(':')[1] ?? '';
      const from = assetId(orgId, `domain:${host}`), to = assetId(orgId, tail.slice(`domain:${host}:`.length));
      for (const e of o.edges) if (e.source === from && e.target === to && e.status === 'misconfigured') e.status = 'unknown';
    }
  }
}

defineTool({
  name: 'map.get', title: 'The map', risk: 'read', action: 'read',
  description: 'Everything across your connected accounts from the last sync: apps, sites, databases, servers, domains, how they connect, and what needs attention. Filter by provider or text. Archived things (asset.archive) are left out unless includeArchived, which marks them archived: true. Things the person marked in use (asset.keep) have kept: true, and important ones important: true: they are in use even without visitors, so never suggest archiving or deleting them, and take extra care before changing them.',
  input: z.object({ provider: z.string().max(40).optional(), q: z.string().max(100).optional(), includeArchived: z.boolean().optional(),
    includeHidden: z.boolean().optional().describe('Also the issues a person hid (“This is fine”, or for now), marked hidden: true. Left out by default, and so is what they flag (a red line, a site down).') }),
  run(ctx, i) {
    const last = get<{ started_at: string; finished_at: string | null; status: string; summary: string }>(ctx.db, `SELECT started_at, finished_at, status, summary FROM sync_runs WHERE org_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`, ctx.orgId);
    const auto = autoSync(ctx.db, ctx.orgId);
    const names = new Map(all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM accounts WHERE org_id = ?', ctx.orgId).map((a) => [a.id, a.name]));
    const q = i.q?.toLowerCase();
    const off = archivedAssets(ctx.db, ctx.orgId); // archived: Unit7 doesn't look at them, so the map leaves them out unless asked
    const marks = keptMarks(ctx.db, ctx.orgId); // what the person said is in use (asset.keep): kept: true, and important: true
    const assets = all<{ id: string; account_id: string | null; provider: string; kind: string; ext_id: string; name: string; url: string | null; meta: string }>(ctx.db,
      'SELECT id, account_id, provider, kind, ext_id, name, url, meta FROM assets WHERE org_id = ? ORDER BY kind, provider, name', ctx.orgId)
      .filter((a) => i.includeArchived || !off.has(a.id))
      .filter((a) => (!i.provider || a.provider === i.provider || json<{ dns?: string }>(a.meta, {}).dns === i.provider) && (!q || a.name.toLowerCase().includes(q)))
      .map((a) => { const m = json<Found>(a.meta, {} as Found); return { id: a.id, provider: a.provider, kind: a.kind, name: a.name, url: a.url, account: a.account_id ? names.get(a.account_id) : undefined, platform: m.platform, status: m.status, dns: m.dns, settings: m.envKeys?.length, end: m.end,
        zone: m.zone, registrar: m.registrar, expires: m.expires, ips: m.ips, also: m.also?.map((x) => ({ ...x, account: x.accountId ? names.get(x.accountId) : undefined })),
        // found inside a server by its X-ray: who runs it, how well Unit7 knows it, and the project frame it's in
        ...(m.owner && { owner: m.owner, trust: m.trust, server: m.server && assetId(ctx.orgId, m.server), project: m.project && assetId(ctx.orgId, m.project), parts: m.parts?.map((k) => assetId(ctx.orgId, k)),
          product: m.product, engine: m.engine, version: m.version, exposed: m.exposed, health: m.health, environment: m.environment, system: m.system, how: m.how }),
        ...(m.size !== undefined && { size: m.size }), ...(m.region && { region: m.region }), ...(m.engine && !m.owner && { engine: m.engine, version: m.version }) }; });
    // a server's projects, for drawing each as a frame with its parts inside; the rest is "Not part of a project"
    const frames = (serverId: string) => {
      const projects = assets.filter((x) => x.kind === 'project' && x.server === serverId).map((x) => ({ id: x.id, name: x.name, owner: x.owner, trust: x.trust, system: x.system, health: x.health, environment: x.environment, parts: x.parts ?? [] }));
      const loose = assets.filter((x) => x.server === serverId && x.kind !== 'project' && !x.project).map((x) => x.id);
      return projects.length || loose.length ? { projects, loose } : {};
    };
    const ids = new Set(assets.map((a) => a.id));
    const edges = all<{ source: string; target: string; kind: string; via: string; status: string; detail: string | null }>(ctx.db, 'SELECT source, target, kind, via, status, detail FROM edges WHERE org_id = ?', ctx.orgId)
      .filter((e) => ids.has(e.source) || ids.has(e.target))
      .filter((e) => i.includeArchived || (!off.has(e.source) && !off.has(e.target)));
    const summary = json<{ accounts?: unknown[]; issues?: Issue[]; suggestions?: unknown[]; counts?: object }>(last?.summary ?? '{}', {});
    // live outside checks first (a site down right now), then what the last sync found
    const live = watchIssues(ctx.app, ctx.orgId);
    const errs: Record<string, { asset: string; kinds: number; hits: number; top: string; hidden?: boolean }> = Object.fromEntries(all<{ asset: string; kinds: number; hits: number; top: string }>(ctx.db, `SELECT asset, count(*) kinds, sum(count) hits, max(kind || ': ' || substr(message, 1, 80)) top FROM remote_errors WHERE org_id = ? AND last_seen > ? GROUP BY asset`, ctx.orgId, new Date(Date.now() - 86400_000).toISOString()).map((e) => [e.asset, e]));
    // Unit7's own databases: their backups (how many, the last one and its size); the map's ring and hover card use them
    const backups = Object.fromEntries(all<{ service_id: string; n: number; last: string | null; size: number | null }>(ctx.db,
      `SELECT service_id, count(*) n, max(finished_at) last, (SELECT size FROM backups b2 WHERE b2.service_id = b.service_id AND b2.status = 'done' ORDER BY finished_at DESC LIMIT 1) size
       FROM backups b WHERE org_id = ? AND status = 'done' AND service_id IS NOT NULL GROUP BY service_id`, ctx.orgId).map((b) => [b.service_id, { count: b.n, last: b.last, size: b.size }]));
    const rows = watchRows(ctx.app, ctx.orgId);
    const sites = Object.fromEntries(rows.filter((w) => w.kind === 'site' && w.asset).map((w) => [w.asset!, { status: w.status, ms: w.ms, host: w.host }]));
    // a domain's HTTPS certificate, registration and email protection, from the outside checks
    const checks: Record<string, Record<string, { status: string; detail: string | null }>> = {};
    for (const w of rows) if (w.kind !== 'site') (checks[w.host] ??= {})[w.kind] = { status: w.status, detail: w.detail };
    // issues name what they're about by map key; the page knows assets by id
    const about = (k?: string) => (k && !k.startsWith('ast_') ? assetId(ctx.orgId, k) : k);
    const issues = [...live, ...(summary.issues ?? [])].map((x) => ({ ...x, about: about(x.about) })).filter((x) => i.includeArchived || !off.has(x.about ?? ''));
    // what a person hid stays out, and so does what it flags, so the canvas, the Overview, Home and the AI agree
    const shown = visible(ctx.db, ctx.orgId, issues, (x) => x.key);
    const keep = new Set(shown.map((x) => x.key));
    const hidden = issues.filter((x) => !keep.has(x.key));
    if (!i.includeHidden) quiet(ctx.orgId, hidden, { sites, checks, edges });
    // a hosted app's errors today, hidden by Home's task key for them ("remote:<asset>")
    const errKeys = Object.keys(errs).map((asset) => ({ key: `remote:${asset}`, asset }));
    const errsShown = new Set(visible(ctx.db, ctx.orgId, errKeys, (x) => x.key).map((x) => x.asset));
    for (const { asset } of errKeys) if (!errsShown.has(asset)) { if (i.includeHidden) errs[asset] = { ...errs[asset]!, hidden: true }; else delete errs[asset]; }
    const held = i.includeHidden ? snoozeState(ctx.db, ctx.orgId).hidden : undefined;
    const until = (k: string) => held?.get(snoozeKeyOf(k))?.until ?? null; // null: for good
    // products (src/organize): each asset's group, and the groups with their one health and name, for the Map's frames
    return withGroups(ctx.db, ctx.orgId, { syncedAt: last?.finished_at, running: auto.running, autoSync: auto, counts: summary.counts, accounts: summary.accounts ?? [],
      issues: i.includeHidden ? [...shown, ...hidden.map((x) => ({ ...x, hidden: true, until: until(x.key) }))] : shown, hidden: hidden.length + errKeys.length - errsShown.size, suggestions: summary.suggestions ?? [],
      assets: assets.map((a) => ({ ...a, ...(off.has(a.id) && { archived: true }), ...(marks.has(a.id) && { kept: true, ...(marks.get(a.id)!.important && { important: true }) }), site: sites[a.id], errors: errs[a.id], checks: a.kind === 'domain' ? checks[a.name] : undefined, ...(a.kind === 'server' && frames(a.id)),
        ...(a.kind === 'database' && a.end?.kind === 'unit7' && backups[a.end.serviceId!] && { backups: backups[a.end.serviceId!] }) })), edges });
  },
});


defineTool({
  name: 'watch.check', title: 'Check everything now', risk: 'read', action: 'read', timeoutMs: 10 * 60_000,
  description: 'Run the outside checks now (Warden does sites every 5 minutes and the rest daily): is every app and domain on the map answering, how fast, HTTPS certificates, domain registrations, email protection (SPF/DMARC).',
  input: z.object({ daily: z.boolean().default(true) }),
  async run(ctx, i) {
    const n = await checkSites(ctx.app, ctx.orgId);
    if (i.daily) await checkDaily(ctx.app, ctx.orgId);
    return { checked: n, issues: watchIssues(ctx.app, ctx.orgId), rows: watchRows(ctx.app, ctx.orgId) };
  },
});
