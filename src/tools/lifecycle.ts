// Keeping, archiving and deleting what you have. Archive: Unit7 stops looking at a thing (no watch, alerts,
// suggestions or background changes) and it keeps running where it is. Impact: everything deleting it affects, from
// Unit7's own records. Delete: the provider's own delete call, for a person who typed the exact name; an AI never
// deletes, and data (databases, volumes, storage) goes only when the person also ticked "delete its data".
// A thing is known by a key: a map asset id (ast_…, stable across syncs) or a Unit7 project id (prj_…).
import { z } from 'zod';
import { defineTool, execute, type Ctx, type ToolResult } from './runtime.ts';
import { all, get, json, run, tx } from '../db.ts';
import { Unit7Error, notFound } from '../errors.ts';
import { archivedAssets, archivedKeys, assetIdOf } from '../archive.ts';
import { keptMarks, keptRows } from '../kept.ts';
import { lastXray } from './xray.ts';
import { routeOf } from '../discovery/actions.ts';
import { OWNER_NAME, type Inventory, type Part } from '../discovery/xray.ts';
import { keyOf, type Found } from '../discovery/model.ts';
import { CATALOG } from '../connectors/oneclick.ts';
import { cloudRemoval } from '../connectors/clouds.ts';
import { hostRemoval, heroku } from '../connectors/hosts.ts';
import { dataServices, type DataService, type Spot } from '../connectors/services.ts';

const KEY = z.string().regex(/^(ast|prj)_[A-Za-z0-9_-]{12}$/, 'a map item or a Unit7 project');
const DAY = 86400_000;
const DB_KINDS = new Set(['postgres', 'mysql', 'mariadb', 'mongo', 'redis']);
const NAMES: Record<string, string> = { ...OWNER_NAME, fly: 'Fly.io', domain: 'your DNS' };
export const providerWord = (p: string) => NAMES[p] ?? CATALOG.find((c) => c.id === p)?.name ?? p.charAt(0).toUpperCase() + p.slice(1);
// "Vercel · sam" already says Vercel: the account's name alone, else "Vercel (sam)"
const placeWord = (provider: string, account?: string) => (!account ? providerWord(provider) : account.toLowerCase().startsWith(providerWord(provider).toLowerCase()) ? account : `${providerWord(provider)} (${account})`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const month = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

interface AssetRow { id: string; account_id: string | null; provider: string; kind: string; ext_id: string; name: string; url: string | null; meta: string }
type End = { kind: string } & Record<string, string>;
interface Target {
  key: string; name: string; kind: string; provider: string; accountId?: string; account?: string; url?: string;
  meta: Found; asset?: AssetRow; projectId?: string;
  services: { id: string; name: string; kind: string; env_kind: string; status: string }[]; // Unit7's own services it covers
  ids: string[];                                    // the map assets that are it: itself and what's inside it
  server?: string; part?: string; xproject?: string; // found inside a server by the X-ray
}
export interface Item { name: string; logo?: string; detail?: string }

const assetRow = (ctx: Ctx, id: string) => get<AssetRow>(ctx.db, 'SELECT id, account_id, provider, kind, ext_id, name, url, meta FROM assets WHERE id = ? AND org_id = ?', id, ctx.orgId);
const svcList = (ctx: Ctx, where: string, ...p: string[]) => all<Target['services'][number]>(ctx.db,
  `SELECT s.id, s.name, s.kind, e.kind env_kind, s.status FROM services s JOIN environments e ON e.id = s.environment_id WHERE s.org_id = ? AND ${where} ORDER BY s.name`, ctx.orgId, ...p);

function target(ctx: Ctx, key: string): Target {
  if (key.startsWith('prj_')) {
    const p = get<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM projects WHERE id = ? AND org_id = ?', key, ctx.orgId);
    if (!p) throw notFound('That project');
    const services = svcList(ctx, 's.project_id = ?', p.id);
    return { key, name: p.name, kind: 'project', provider: 'unit7', meta: {} as Found, projectId: p.id, services, ids: services.map((s) => assetIdOf(ctx.orgId, `unit7:${s.id}`)) };
  }
  const a = assetRow(ctx, key);
  if (!a) throw new Unit7Error('not_found', 'That isn’t on the map any more. Sync the map and try again.', 404);
  const meta = json<Found>(a.meta, {} as Found);
  const account = a.account_id ? get<{ name: string }>(ctx.db, 'SELECT name FROM accounts WHERE id = ?', a.account_id)?.name : undefined;
  const t: Target = { key, name: a.name, kind: a.kind, provider: a.provider, accountId: a.account_id ?? undefined, account, url: a.url ?? undefined, meta, asset: a, services: [], ids: [a.id] };
  if (a.provider === 'unit7' && a.ext_id.startsWith('svc_')) t.services = svcList(ctx, 's.id = ?', a.ext_id);
  if (meta.server) {
    t.server = meta.server.replace(/^unit7:/, '');
    const rest = a.ext_id.slice(t.server.length + 1);
    if (rest.startsWith('p/')) t.xproject = rest.slice(2); else t.part = rest;
    t.ids.push(...(meta.parts ?? []).map((k) => assetIdOf(ctx.orgId, k)));
  }
  return t;
}

// --- what's around it, from the map, the connections and Unit7's own tables ----------------------------------
const ofIds = (ids: string[]) => ids.map(() => '?').join(',');
function around(ctx: Ctx, t: Target) {
  const ids = t.ids.length ? t.ids : ['-'];
  const into = all<{ kind: string; via: string; status: string; id: string; name: string; skind: string; provider: string; meta: string }>(ctx.db,
    `SELECT e.kind, e.via, e.status, a.id, a.name, a.kind skind, a.provider, a.meta FROM edges e JOIN assets a ON a.id = e.source WHERE e.org_id = ? AND e.target IN (${ofIds(ids)}) AND e.source NOT IN (${ofIds(ids)})`, ctx.orgId, ...ids, ...ids);
  const out = all<{ kind: string; via: string; id: string; name: string; tkind: string; provider: string; meta: string }>(ctx.db,
    `SELECT e.kind, e.via, a.id, a.name, a.kind tkind, a.provider, a.meta FROM edges e JOIN assets a ON a.id = e.target WHERE e.org_id = ? AND e.source IN (${ofIds(ids)}) AND e.target NOT IN (${ofIds(ids)})`, ctx.orgId, ...ids, ...ids);
  const domains = new Map<string, { name: string; zone?: string; dns?: string }>();
  for (const e of into.filter((x) => x.skind === 'domain')) { const m = json<Found>(e.meta, {} as Found); domains.set(e.name, { name: e.name, zone: m.zone, dns: m.dns }); }
  // domains Unit7 routes to its own services, or pointed at this thing elsewhere (domain.point keeps the target)
  const end = t.meta.end as End | undefined;
  for (const d of all<{ hostname: string; zone: string | null; target: string | null; service_id: string | null; auto: number }>(ctx.db, 'SELECT hostname, zone, target, service_id, auto FROM domains WHERE org_id = ?', ctx.orgId)) {
    const tg = json<End>(d.target ?? '{}', {} as End);
    const mine = (d.service_id && t.services.some((s) => s.id === d.service_id) && !d.auto) || (end && tg.kind === end.kind && Object.entries(end).every(([k, v]) => tg[k] === undefined || tg[k] === v) && tg.kind !== 'unit7');
    if (mine && !domains.has(d.hostname)) domains.set(d.hostname, { name: d.hostname, zone: d.zone ?? undefined });
  }
  // apps whose settings point at it (the map), and the connections Unit7 made (links)
  const users = new Map<string, Item>();
  for (const e of into.filter((x) => x.skind !== 'domain' && (x.kind === 'env' || x.kind === 'uses'))) {
    const u = users.get(e.id);
    users.set(e.id, { name: e.name, logo: e.provider, detail: u ? `${u.detail}, ${e.via}` : e.kind === 'env' ? `its setting ${e.via} points here` : 'talks to it' });
  }
  const ends = [...(end ? [end] : []), ...t.services.map((s) => ({ kind: 'unit7', serviceId: s.id }))];
  const sameEnd = (a: End, b: End) => a.kind === b.kind && Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);
  for (const l of all<{ source: string; target: string; vars: string }>(ctx.db, 'SELECT source, target, vars FROM links WHERE org_id = ?', ctx.orgId)) {
    const src = json<End>(l.source, {} as End), dst = json<End>(l.target, {} as End);
    if (!ends.some((x) => sameEnd(x, src)) || ends.some((x) => sameEnd(x, dst))) continue;
    const who = dst.kind === 'unit7' ? get<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM services WHERE id = ?', dst.serviceId ?? '') : undefined;
    const asset = !who ? all<{ id: string; name: string; provider: string; e: string }>(ctx.db, `SELECT id, name, provider, json_extract(meta, '$.end') e FROM assets WHERE org_id = ? AND json_extract(meta, '$.end.kind') = ?`, ctx.orgId, dst.kind).find((a) => sameEnd(json<End>(a.e, {} as End), dst)) : undefined;
    const id = who?.id ?? asset?.id ?? JSON.stringify(dst), keys = json<{ key: string }[]>(l.vars, []).map((v) => v.key);
    if (!users.has(id)) users.set(id, { name: who?.name ?? asset?.name ?? providerWord(dst.kind), logo: who ? 'unit7' : dst.kind, detail: keys.length ? `Unit7 connected it (${keys.slice(0, 3).join(', ')})` : 'Unit7 connected it' });
  }
  const uses = out.filter((e) => (e.kind === 'env' || e.kind === 'uses') && e.tkind === 'database').map((e) => ({ id: e.id, name: e.name, provider: e.provider }));
  return { domains: [...domains.values()], users: [...users.values()], uses: [...new Map(uses.map((u) => [u.id, u])).values()] };
}

// the facts: last deploy, recent visitors, cost, whether people use it
function facts(ctx: Ctx, t: Target, hosts: string[], inv?: Inventory) {
  const ids = t.services.map((s) => s.id);
  let lastDeploy = ids.length ? get<{ at: string | null }>(ctx.db, `SELECT max(coalesce(finished_at, started_at)) at FROM deployments WHERE service_id IN (${ofIds(ids)}) AND status IN ('live', 'stopped')`, ...ids)?.at ?? undefined : undefined;
  const part = (pid?: string) => inv?.parts.find((p) => p.id === pid);
  const coolifyAt = [t.part, ...(inv?.projects.find((p) => p.id === t.xproject)?.parts ?? [])].map((pid) => part(pid)?.coolify?.lastDeploy?.at).filter(Boolean).sort().at(-1);
  lastDeploy ??= coolifyAt;
  // visitors: Unit7's own proxy (two days kept) and the server watch's windows (a week)
  const h = [...new Set(hosts.map((x) => x.toLowerCase()))];
  const own = h.length ? get<{ n: number | null; rows: number }>(ctx.db, `SELECT sum(requests) n, count(*) rows FROM traffic WHERE hostname IN (${ofIds(h)}) AND at > ?`, ...h, new Date(Date.now() - 2 * DAY).toISOString()) : undefined;
  let requests = own?.rows ? { n: own.n ?? 0, days: 2 } : undefined;
  if (!requests && t.server && h.length) {
    const wins = all<{ summary: string }>(ctx.db, 'SELECT summary FROM traffic_windows WHERE server_id = ? AND at > ?', t.server, new Date(Date.now() - 7 * DAY).toISOString());
    // answered requests by people and programs where the log says who (scanners and failures aren't visits), else every request
    const of = (w: Win) => (w.callers ? w.callers.filter((x) => h.includes(x.host.toLowerCase())).reduce((a, x) => a + x.people + x.programs + x.api, 0)
      : (w.hosts ?? []).filter((x) => h.includes(x.host.toLowerCase())).reduce((a, x) => a + x.n, 0));
    if (wins.length) requests = { n: wins.reduce((sum, w) => sum + of(json<Win>(w.summary, {} as Win)), 0), days: 7 };
  }
  const site = t.ids.length ? get<{ status: string; checked_at: string | null }>(ctx.db, `SELECT status, checked_at FROM watch WHERE org_id = ? AND kind = 'site' AND asset IN (${ofIds(t.ids)}) ORDER BY checked_at DESC LIMIT 1`, ctx.orgId, ...t.ids) : undefined;
  const cost = get<{ amount: number; currency: string }>(ctx.db, 'SELECT sum(amount) amount, max(currency) currency FROM costs WHERE org_id = ? AND lower(label) = lower(?) HAVING count(*) > 0', ctx.orgId, t.name);
  return { lastDeploy, requests, site: site ? { status: site.status, checkedAt: site.checked_at } : undefined, cost: cost ? { amount: Math.round(cost.amount * 100) / 100, currency: cost.currency } : undefined };
}

// --- is it in use? ------------------------------------------------------------------------------------------------
// Visitors aren't the only sign. An API other servers call, an app whose settings point at it, a domain that answers, a
// recent deploy or code change, logs showing activity, a scheduled job, data going in and out: each from what Unit7
// already stored (never asking a provider). A strong sign means in use: Clean up and the savings ideas never list it.
// Not signs yet: database writes (Unit7 doesn't read them) and uptime monitors (Unit7 watches every site the same way).
export interface Signal { kind: 'visitors' | 'api' | 'requests' | 'apps' | 'domain' | 'deploy' | 'code' | 'logs' | 'jobs' | 'network'; strong: boolean; text: string; at?: string; n?: number }
export interface Pulse { label: 'Used' | 'Last visit' | 'Deployed' | 'Changed' | 'Live'; at?: string; by?: number; detail: string[] }
const WEEK = 7 * DAY, FRESH = 30 * DAY;
const NET_BUSY = 1024; // bytes a second, averaged: more than health checks and DNS. ponytail: one fixed line; a per-app baseline when it misleads
type Memo = Map<string, unknown>;
const once = <T>(m: Memo, k: string, f: () => T): T => { if (!m.has(k)) m.set(k, f()); return m.get(k) as T; };
const latest = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1);
const names = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`);
export const agoWords = (iso: string, now = Date.now()) => {
  const m = Math.max(0, (now - Date.parse(iso)) / 60_000);
  return m < 2 ? 'just now' : m < 90 ? `${Math.round(m)} min ago` : m < 36 * 60 ? `${Math.round(m / 60)} hours ago` : m < 45 * 1440 ? `${Math.round(m / 1440)} days ago` : m < 365 * 1440 ? `${Math.round(m / 43200)} months ago` : 'over a year ago';
};
interface Win { at: string; hosts?: { host: string; n: number }[]; callers?: { host: string; people: number; programs: number; api: number }[]; errors?: { container: string; n: number }[] }

export function usageOf(ctx: Ctx, t: Target, o: { now?: number; memo?: Memo } = {}) {
  const now = o.now ?? Date.now(), m = o.memo ?? new Map(), db = ctx.db, since = new Date(now - WEEK).toISOString();
  const inv = t.server ? once(m, `x:${t.server}`, () => lastXray(db, ctx.orgId, t.server!)?.data) : undefined;
  const a = around(ctx, t);
  const mine = t.server && inv ? (t.part ? [t.part] : inv.projects.find((p) => p.id === t.xproject)?.parts ?? []) : [];
  const parts = mine.map((id) => inv!.parts.find((p) => p.id === id)).filter((p): p is Part => !!p);
  const hosts = [...new Set([...(t.meta.hosts ?? []), ...a.domains.map((d) => d.name), ...parts.flatMap((p) => p.hosts ?? [])].map((h) => h.toLowerCase()))];
  const f = facts(ctx, t, hosts, inv);
  const svcIds = t.services.map((s) => s.id);
  const out: Signal[] = [];
  const add = (s: Signal) => out.push(s);

  // who calls it, from the access logs Unit7 reads on its servers: people, programs and other servers, API paths
  const servers = [...new Set([t.server, ...(svcIds.length ? all<{ s: string }>(db, `SELECT DISTINCT server_id s FROM services WHERE id IN (${ofIds(svcIds)}) AND server_id IS NOT NULL`, ...svcIds).map((r) => r.s) : [])].filter((x): x is string => !!x))];
  const ctrs = new Set(parts.flatMap((p) => [...(p.containers ?? []), ...(p.match ?? [])]));
  let people = 0, calls = 0, seen = 0, logs: string | undefined;
  const at = { people: undefined as string | undefined, calls: undefined as string | undefined, seen: undefined as string | undefined };
  for (const sid of servers) {
    const wins = once(m, `w:${sid}`, () => all<{ at: string; summary: string }>(db, 'SELECT at, summary FROM traffic_windows WHERE server_id = ? AND at > ?', sid, since).map((w) => ({ ...json<Win>(w.summary, {} as Win), at: w.at })));
    for (const w of wins) {
      if (w.callers) for (const c of w.callers.filter((x) => hosts.includes(x.host.toLowerCase()))) {
        if (c.people) { people += c.people; at.people = latest([at.people, w.at]); }
        if (c.programs + c.api) { calls += c.programs + c.api; at.calls = latest([at.calls, w.at]); }
      } else {
        const n = (w.hosts ?? []).filter((x) => hosts.includes(x.host.toLowerCase())).reduce((s, x) => s + x.n, 0);
        if (n) { seen += n; at.seen = latest([at.seen, w.at]); }
      }
      if ((w.errors ?? []).some((e) => e.n > 0 && ctrs.has(e.container))) logs = latest([logs, w.at]);
    }
  }
  const own = hosts.length ? get<{ n: number | null; last: string | null }>(db, `SELECT sum(requests) n, max(at) last FROM traffic WHERE hostname IN (${ofIds(hosts)}) AND requests > 0 AND at > ?`, ...hosts, since) : undefined;
  if (own?.n) { seen += own.n; at.seen = latest([at.seen, own.last]); }
  if (people) add({ kind: 'visitors', strong: true, text: `${people.toLocaleString('en')} visit${people === 1 ? '' : 's'} in the last 7 days`, at: at.people, n: people });
  if (calls) add({ kind: 'api', strong: true, text: `${calls.toLocaleString('en')} call${calls === 1 ? '' : 's'} from other servers, apps or scripts in the last 7 days`, at: at.calls, n: calls });
  if (seen && !people && !calls) add({ kind: 'requests', strong: true, text: `${seen.toLocaleString('en')} request${seen === 1 ? '' : 's'} in the last 7 days`, at: at.seen, n: seen });

  // other apps whose settings point at it (the map, Unit7's own connections) or that reach it on the same server
  const users = new Set(a.users.map((u) => u.name));
  for (const q of inv?.parts ?? []) if (!mine.includes(q.id) && (q.uses ?? []).some((u) => mine.includes(u))) users.add(q.name);
  if (users.size) add({ kind: 'apps', strong: true, text: `Used by ${names([...users])}`, n: users.size });

  // one of the person's domains points at it and it answers
  const sites = a.domains.length ? all<{ host: string; status: string; checked_at: string | null }>(db, `SELECT host, status, checked_at FROM watch WHERE org_id = ? AND kind = 'site' AND host IN (${ofIds(a.domains.map((d) => d.name))})`, ctx.orgId, ...a.domains.map((d) => d.name)) : [];
  const up = sites.find((s) => s.status === 'up') ?? (a.domains.length && f.site?.status === 'up' ? { host: a.domains[0]!.name, checked_at: f.site.checkedAt } : undefined);
  if (up) add({ kind: 'domain', strong: true, text: `${up.host} points at it and answers`, at: up.checked_at ?? undefined });

  // work on it: a deploy, a change in its code
  if (f.lastDeploy) add({ kind: 'deploy', strong: now - Date.parse(f.lastDeploy) < FRESH, text: `Last deploy ${agoWords(f.lastDeploy, now)}`, at: f.lastDeploy });
  const commit = latest(parts.map((p) => p.git?.last?.split(' ')[1]).filter((x) => x && !Number.isNaN(Date.parse(x))));
  if (commit) add({ kind: 'code', strong: now - Date.parse(commit) < FRESH, text: `Its code changed ${agoWords(commit, now)}`, at: commit });

  // it runs: its logs, its scheduled jobs, data going in and out of its containers
  logs = latest([logs,
    t.ids.length ? get<{ at: string | null }>(db, `SELECT max(last_seen) at FROM remote_errors WHERE org_id = ? AND asset IN (${ofIds(t.ids)}) AND last_seen > ?`, ctx.orgId, ...t.ids, since)?.at : undefined,
    svcIds.length ? get<{ at: string | null }>(db, `SELECT max(last_seen) at FROM error_groups WHERE service_id IN (${ofIds(svcIds)}) AND last_seen > ?`, ...svcIds, since)?.at : undefined]);
  if (logs) add({ kind: 'logs', strong: true, text: `Its logs show activity (${agoWords(logs, now)})`, at: logs });
  const jobs = svcIds.length ? get<{ n: number; last: string | null }>(db, `SELECT count(*) n, max(last_run_at) last FROM jobs WHERE service_id IN (${ofIds(svcIds)})`, ...svcIds) : undefined;
  const xjobs = (inv?.parts ?? []).filter((p) => (p.kind === 'job' || p.schedule) && (mine.includes(p.id) || (!!t.xproject && p.project === t.xproject)));
  const nJobs = (jobs?.n ?? 0) + xjobs.length;
  if (nJobs) add({ kind: 'jobs', strong: true, text: nJobs === 1 ? 'Runs a scheduled job' : `Runs ${nJobs} scheduled jobs`, at: jobs?.last ?? undefined, n: nJobs });
  const scope = t.xproject ?? parts[0]?.project;
  const busy = t.server && scope ? get<{ at: string | null }>(db, `SELECT max(at) at FROM usage_points WHERE server_id = ? AND scope = ? AND res IN ('5m', '1h') AND at > ? AND coalesce(net_max, net) >= ?`, t.server, scope, since, NET_BUSY)?.at : undefined;
  if (busy) add({ kind: 'network', strong: true, text: 'Sends and receives data', at: busy });

  return { signals: out.sort((x, y) => +y.strong - +x.strong), facts: f, around: a };
}

// the one line a card shows ("Used 3 min ago · by 2 apps"), from the strongest sign; nothing when nothing is known
export function pulseOf(signals: Signal[]): Pulse | undefined {
  const detail = signals.filter((s) => s.strong).map((s) => s.text); // the signs of use, not old facts
  if (!detail.length) return undefined;
  const apps = signals.find((s) => s.kind === 'apps')?.n;
  const act = signals.filter((s) => s.strong && s.at && ['visitors', 'api', 'requests', 'logs', 'jobs', 'network'].includes(s.kind)).sort((x, y) => Date.parse(y.at!) - Date.parse(x.at!))[0];
  if (act) return { label: act.kind === 'visitors' ? 'Last visit' : 'Used', at: act.at, ...(apps && { by: apps }), detail };
  if (apps) return { label: 'Used', by: apps, detail };
  const work = signals.find((s) => s.strong && (s.kind === 'deploy' || s.kind === 'code'));
  if (work) return { label: work.kind === 'deploy' ? 'Deployed' : 'Changed', at: work.at, detail };
  const live = signals.find((s) => s.kind === 'domain');
  return live ? { label: 'Live', at: live.at, detail } : undefined;
}

// Listed by Clean up or not, and why, in words
function judge(ctx: Ctx, t: Target, m: Memo, now = Date.now()) {
  const u = usageOf(ctx, t, { now, memo: m });
  const mark = once(m, 'kept', () => keptMarks(ctx.db, ctx.orgId)).get(t.key);
  const archived = once(m, 'off', () => new Set([...archivedAssets(ctx.db, ctx.orgId), ...archivedKeys(ctx.db, ctx.orgId)])).has(t.key);
  const strong = u.signals.filter((s) => s.strong), f = u.facts, meta = t.meta;
  let reasons: string[], tail: string;
  if (t.projectId) {
    const last = t.services.length ? get<{ at: string | null }>(ctx.db, `SELECT max(started_at) at FROM deployments WHERE service_id IN (${ofIds(t.services.map((s) => s.id))})`, ...t.services.map((s) => s.id))?.at : undefined;
    reasons = [!t.services.length && 'Nothing runs in it', last ? now - Date.parse(last) > 90 * DAY && `No deploy since ${month(last)}` : 'Never deployed'].filter((x): x is string => !!x);
    if (reasons.length < 2 && !last) reasons = []; // a new, empty project isn't abandoned
    tail = last ? `last deploy ${agoWords(last, now)}` : 'never deployed';
  } else {
    reasons = [
      f.lastDeploy && now - Date.parse(f.lastDeploy) > 90 * DAY && `No deploy since ${month(f.lastDeploy)}`,
      // the access log was read, and nobody (no person, no program) got an answer: scanners and failures don't count
      f.requests && !u.signals.some((s) => s.kind === 'visitors' || s.kind === 'api' || s.kind === 'requests') && `No visitors in the last ${f.requests.days} days`,
      t.kind !== 'database' && !u.around.domains.length && 'No domain of yours points at it',
      (f.site?.status === 'down' || meta.health?.status === 'down') && 'Its address isn’t answering',
      /paus|suspend|stopped|exited|inactive|disabled|crash|fail/i.test(meta.status ?? '') && `It’s ${String(meta.status).toLowerCase()} already`,
      t.kind === 'database' && !u.signals.some((s) => s.kind === 'apps') && 'No app on the map uses it',
    ].filter((x): x is string => !!x);
    tail = f.lastDeploy ? `last deploy ${agoWords(f.lastDeploy, now)}` : 'no deploy Unit7 knows of';
  }
  const idle = reasons.length >= 2 - (t.projectId ? 1 : 0); // what the visitor-and-deploy rules alone would list
  const listed = !mark && !archived && !strong.length && idle;
  const low = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const why = mark ? (mark.important ? 'You marked it important, so it counts as in use and Unit7 never suggests archiving or deleting it.' : 'You said it’s in use, so Unit7 doesn’t suggest it.')
    : archived ? 'It’s archived, so Clean up leaves it out.'
    : strong.length ? `It’s in use: ${strong.map((s) => low(s.text)).join('; ')}.`
    : listed ? `${t.projectId && !t.services.length ? 'Nothing runs in it' : `${f.requests ? 'No visitors' : 'No visitors Unit7 can see'} and no ${t.kind === 'database' ? '' : 'other '}app uses it`}, ${tail}.`
    : reasons.length ? `Only one sign it’s unused (${low(reasons[0]!)}), so Unit7 doesn’t suggest it.` : 'Nothing says it’s unused.';
  return { listed, idle, reasons, why, signals: u.signals, pulse: pulseOf(u.signals), kept: !!mark, important: !!mark?.important, archived };
}

// Kept, or a strong sign of use: the cost radar's savings leave it out (a key that's gone counts as not in use)
export function inUse(ctx: Pick<Ctx, 'db' | 'orgId'>, key: string, now = Date.now(), memo: Memo = new Map()) {
  try { const j = judge(ctx as Ctx, target(ctx as Ctx, key), memo, now); return j.kept || j.signals.some((s) => s.strong); } catch { return false; }
}

// The Unit7 backup newest for each of its databases, and the X-ray's own (Unit7 takes one before a hard change)
function backupOf(ctx: Ctx, serviceId: string) {
  return get<{ at: string }>(ctx.db, `SELECT created_at at FROM backups WHERE service_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`, serviceId)?.at;
}
const partBackup = (ctx: Ctx, serverId: string, part: string) =>
  get<{ at: string }>(ctx.db, `SELECT created_at at FROM changes WHERE org_id = ? AND server_id = ? AND part = ? AND verb = 'backup' ORDER BY created_at DESC LIMIT 1`, ctx.orgId, serverId, part)?.at;

// how Unit7 deletes it, if it can: who carries it out, and whether data goes with it
type DataGoes = 'always' | 'optional' | 'never';
interface Plan { can: boolean; why?: string; how?: string; dataGoes: DataGoes; what: string[]; stopFirst?: boolean } // stopFirst: production runs; stopping it first unlocks the delete
const DASHBOARD = (t: Target) => `Unit7 can’t delete things on ${providerWord(t.provider)} yet. Delete it in ${providerWord(t.provider)}’s own dashboard${t.url ? ` (${t.url})` : ''}; the map updates on its next sync.`;
function plan(ctx: Ctx, t: Target, inv?: Inventory): Plan {
  const end = t.meta.end as End | undefined;
  if (t.provider === 'unit7' && t.kind === 'project') {
    const all: Plan = { can: true, how: 'Unit7 removes each app and database, then the project', dataGoes: t.services.some((s) => DB_KINDS.has(s.kind)) ? 'optional' : 'never',
      what: [...(t.services.length ? ['Their containers, routes and addresses'] : []), 'Its environments and settings in Unit7'] };
    // production still running: never deleted in one go, but never a dead end either. The guided path stops production
    // first (each stop its own gated call), then deletes; the preview shows what goes as if it were stopped.
    const prod = t.services.filter((s) => s.env_kind === 'production' && s.status !== 'stopped');
    if (prod.length) return { ...all, can: false, stopFirst: true, why: `Production is live (${prod.map((s) => s.name).join(', ')}), so Unit7 stops it first, then deletes everything. Or archive it instead to keep it.` };
    return all;
  }
  if (t.provider === 'unit7' && t.services.length) {
    const db = DB_KINDS.has(t.services[0]!.kind);
    return { can: true, how: 'Unit7 stops and removes it on its server', dataGoes: db ? 'optional' : 'never', what: [db ? 'The database’s container (Unit7 takes a final backup first)' : 'Its containers, routes and settings'] };
  }
  if (t.server && t.provider === 'coolify') {
    const p = inv?.parts.find((x) => x.id === t.part), pr = inv?.projects.find((x) => x.id === t.xproject);
    if (t.part && !p?.coolify) return { can: false, dataGoes: 'never', what: [], why: `${t.name} is part of Coolify itself, so Unit7 leaves it alone.` };
    if (t.xproject && !pr?.coolify?.uuid) return { can: false, dataGoes: 'never', what: [], why: 'Unit7 doesn’t know this project’s Coolify id yet. Connect Coolify on the server, or delete it in Coolify.' };
    if (!get(ctx.db, `SELECT 1 FROM accounts WHERE org_id = ? AND provider = 'coolify' AND json_extract(meta, '$.serverId') = ?`, ctx.orgId, t.server)) return { can: false, dataGoes: 'never', what: [], why: 'Connect Coolify on this server first (its page shows how), so Unit7 can ask Coolify to delete it.' };
    return { can: true, how: 'Unit7 asks Coolify to delete it', dataGoes: 'optional', what: t.xproject ? [`The Coolify project and ${plural(pr!.parts.length, 'thing')} in it`, 'Their containers and settings'] : ['Its containers and settings in Coolify'] };
  }
  if (t.server) return { can: false, dataGoes: 'never', what: [], why: `Unit7 found ${t.name} on the server but didn’t set it up, so it won’t delete it. You can stop it instead, or remove it on the server yourself.` };
  if (t.provider === 'cloudflare') return { can: false, dataGoes: 'never', what: [], why: `Ask Unit7 to remove ${t.name}: a Worker, a D1 database or an R2 bucket has its own remove step, and you say yes to it. Or delete it in Cloudflare’s dashboard${t.url ? ` (${t.url})` : ''}.` };
  if (!end && !['render'].includes(t.provider)) return { can: false, dataGoes: 'never', what: [], why: DASHBOARD(t) };
  switch (t.provider) {
    case 'vercel': return { can: true, how: 'Unit7 asks Vercel to delete the project', dataGoes: 'never', what: ['The project, all its deployments and settings', 'Its domains’ link to this project'] };
    case 'netlify': return { can: true, how: 'Unit7 asks Netlify to delete the site', dataGoes: 'never', what: ['The site, its deploys and settings', 'Form submissions and files kept on Netlify for it'] };
    case 'render': return t.kind === 'database'
      ? { can: true, how: 'Unit7 asks Render to delete the database', dataGoes: 'always', what: ['The database and every row in it'] }
      : { can: true, how: 'Unit7 asks Render to delete the service', dataGoes: 'never', what: ['The service, its deploys and settings'] };
    // only ever the service; the project too only when a fresh read at delete time shows nothing else in it (no other
    // service, no volume unless its data goes too)
    case 'railway': return { can: true, how: 'Unit7 asks Railway to delete the service', dataGoes: t.kind === 'database' ? 'always' : 'never',
      what: ['The service and its deployments in this environment', 'The Railway project too, only if nothing else is left in it'] };
    case 'fly': return { can: true, how: 'Unit7 asks Fly.io to delete the app', dataGoes: t.kind === 'database' ? 'always' : 'never', what: ['The app, its machines, addresses and secrets', 'Any volumes on it, with their snapshots'] };
    case 'heroku': return t.kind === 'database'
      ? { can: false, dataGoes: 'never', what: [], why: 'This is an add-on of a Heroku app. Delete the app (it takes its add-ons with it), or remove the add-on in Heroku.' }
      : { can: true, how: 'Unit7 asks Heroku to delete the app', dataGoes: 'never', what: ['The app, its releases and settings', 'Add-ons the app owns (like Heroku Postgres)'] };
    case 'neon': return { can: true, how: 'Unit7 asks Neon to delete the project', dataGoes: 'always', what: ['The project: every branch, database and role'] };
    case 'supabase': return { can: true, how: 'Unit7 asks Supabase to delete the project', dataGoes: 'always', what: ['The project: its database, stored files and users'] };
    case 'planetscale': case 'turso': case 'upstash': return { can: true, how: `Unit7 asks ${providerWord(t.provider)} to delete the database`, dataGoes: 'always', what: ['The database and everything in it'] };
    default: return { can: false, dataGoes: 'never', what: [], why: DASHBOARD(t) };
  }
}

// what's on a provider that isn't on the map yet (a Fly volume, a Heroku add-on, a Render disk, a Railway volume): looked
// up live, so the dialog can name it. A lookup that fails never reads as "no data": it throws, and delete refuses.
async function liveData(ctx: Ctx, t: Target): Promise<Item[]> {
  const end = t.meta.end as End | undefined, acc = t.accountId;
  if (!acc || !end) return [];
  try {
    if (t.provider === 'fly') return (await hostRemoval.flyVolumes(ctx, acc, end.app!)).filter((v) => v.state !== 'destroyed').map((v) => ({ name: v.name, logo: 'fly', detail: `a volume${v.size_gb ? ` of ${v.size_gb} GB` : ''}` }));
    // Heroku destroys every add-on the app owns with it, so each one counts (a database by any brand name)
    if (t.provider === 'heroku') return (await heroku.addons(ctx, acc, end.app!)).map((a) => ({ name: a.name, logo: 'heroku', detail: a.addon_service.name }));
    if (t.provider === 'render' && t.kind !== 'database') { const d = await hostRemoval.renderDisk(ctx, acc, end.service!); return d ? [{ name: d.name ?? 'its disk', logo: 'render', detail: `a disk${d.sizeGB ? ` of ${d.sizeGB} GB` : ''}` }] : []; }
    if (t.provider === 'railway') return (await hostRemoval.railwayContents(ctx, acc, end.project!)).volumes.filter((v) => v.services.includes(end.service!)).map((v) => ({ name: v.name, logo: 'railway', detail: 'a volume' }));
  } catch {
    throw new Unit7Error('data_unknown', `Unit7 couldn’t check what data ${t.name} has at ${providerWord(t.provider)}, so nothing was deleted. Try again in a minute, or delete it in ${providerWord(t.provider)} yourself.`, 409);
  }
  return [];
}

async function impact(ctx: Ctx, key: string) {
  const t = target(ctx, key);
  const inv = t.server ? lastXray(ctx.db, ctx.orgId, t.server)?.data : undefined;
  const p = plan(ctx, t, inv);
  const { domains, users, uses } = around(ctx, t);
  const hosts = [...(t.meta.hosts ?? []), ...domains.map((d) => d.name)];
  const f = facts(ctx, t, hosts, inv);
  const name = t.name, where = providerWord(t.provider);

  // the data that goes with it (or would, with "also delete its data"), and whether a backup exists
  const data: (Item & { backup?: string })[] = [];
  for (const s of t.services.filter((x) => DB_KINDS.has(x.kind))) data.push({ name: s.name, logo: s.kind, detail: 'a database', backup: backupOf(ctx, s.id) });
  if (t.server && inv) {
    const parts = t.part ? [t.part] : inv.projects.find((x) => x.id === t.xproject)?.parts ?? [];
    for (const pid of parts) { const x = inv.parts.find((y) => y.id === pid); if (x && (x.kind === 'database' || x.kind === 'volume' || x.volumes?.length)) data.push({ name: x.name, logo: x.engine ?? x.product?.id, detail: x.kind === 'database' ? 'a database' : 'stored data (volumes)', backup: partBackup(ctx, t.server, x.id) }); }
  }
  if (!t.server && t.provider !== 'unit7' && t.kind === 'database') data.push({ name, logo: t.provider, detail: 'the database itself' });
  const live = p.can ? await liveData(ctx, t).catch(() => undefined) : [];
  data.push(...(live ?? [{ name: 'What else it holds', logo: t.provider, detail: 'Unit7 couldn’t check just now, so it won’t delete it until it can' }]));
  const dataGoes: DataGoes = !live || live.length ? 'always' : p.dataGoes;

  const breaks: Item[] = [
    ...domains.map((d) => ({ name: d.name, logo: d.dns ?? 'domain', detail: 'points here, so it stops opening anything' })),
    ...users.map((u) => ({ ...u, detail: `uses it: ${u.detail}. It will fail where it calls it` })),
  ];
  const deletes: Item[] = [{ name, logo: t.provider === 'unit7' ? 'unit7' : t.provider, detail: `on ${placeWord(t.provider, t.account)}` },
    // a Unit7 project: each of its apps by name
    ...(t.projectId ? t.services.map((s) => ({ name: s.name, logo: DB_KINDS.has(s.kind) ? s.kind : 'unit7', detail: `${DB_KINDS.has(s.kind) ? 'a database' : 'an app'} in ${s.env_kind}` })) : []),
    ...p.what.map((w) => ({ name: w }))];
  const repo = (t.projectId ? get<{ repo: string | null }>(ctx.db, 'SELECT repo FROM projects WHERE id = ?', t.projectId)?.repo : undefined)
    ?? (t.services.length ? get<{ r: string | null }>(ctx.db, `SELECT json_extract(config, '$.source.repo') r FROM services WHERE id IN (${ofIds(t.services.map((x) => x.id))}) AND json_extract(config, '$.source.repo') IS NOT NULL LIMIT 1`, ...t.services.map((x) => x.id))?.r : undefined) ?? undefined;
  const servers = t.services.length ? all<{ name: string }>(ctx.db, `SELECT DISTINCT v.name FROM services s JOIN servers v ON v.id = s.server_id WHERE s.id IN (${ofIds(t.services.map((x) => x.id))})`, ...t.services.map((x) => x.id)) : [];
  if (dataGoes === 'always') deletes.push(...data.filter((d) => d.name !== name).map((d) => ({ name: d.name, logo: d.logo, detail: d.detail })));
  const zones = [...new Set(domains.map((d) => d.zone ?? d.name.split('.').slice(-2).join('.')))];
  const stays: Item[] = [
    ...zones.map((z) => ({ name: z, logo: 'domain', detail: 'stays registered; only the link to this is removed' })),
    ...uses.map((u) => ({ name: u.name, logo: u.provider, detail: 'a database it uses: stays, with its data' })),
    ...(dataGoes === 'optional' && data.length ? [{ name: data.length === 1 ? data[0]!.name : `${plural(data.length, 'database')} and stored data`, detail: 'its data stays unless you choose to delete it too' }] : []),
    ...(t.services.some((s) => backupOf(ctx, s.id)) ? [{ name: 'Backups Unit7 took', detail: 'stay, so you can restore later' }] : []),
    ...(t.provider === 'neon' ? [{ name: 'Neon keeps it 7 days', detail: 'you can still recover it in Neon during that time' }] : []),
    ...(t.accountId ? [{ name: `Your ${where} account`, logo: t.provider, detail: 'stays connected to Unit7' }] : []),
    ...servers.map((v) => ({ name: v.name, logo: 'ubuntu', detail: 'the server stays as it is; only these containers go' })),
    // code: where Unit7 knows it lives, or a reminder for an app hosted elsewhere
    ...(repo ? [{ name: 'Your code', logo: 'github', detail: `stays in ${repo}` }] : t.kind === 'app' || t.kind === 'project' && !t.projectId ? [{ name: 'Your code', logo: 'github', detail: 'stays wherever it lives (GitHub, your computer)' }] : []),
  ];

  const env = t.meta.environment ?? (t.services.some((s) => s.env_kind === 'production') ? 'production' : undefined);
  const production = /prod/i.test(env ?? '') ? { yes: true, why: 'It’s production.' }
    : domains.length && f.site?.status === 'up' ? { yes: true, why: `Your own domain${domains.length > 1 ? 's point' : ' points'} at it and it’s answering, so people may be using it.` }
    : { yes: false };
  return {
    key: t.key, name, kind: t.kind, provider: t.provider, providerName: where, account: t.account, url: t.url, archived: archivedKeys(ctx.db, ctx.orgId).has(t.key),
    production, breaks, deletes, stays, data, dataGoes, facts: f,
    // in use or marked important: the delete pop-up says so before anything else
    use: (() => { const j = judge(ctx, t, new Map()); return { kept: j.kept, important: j.important, signs: j.signals.filter((x) => x.strong).map((x) => x.text) }; })(),
    can: { delete: p.can, why: p.why, how: p.how, pause: t.provider === 'supabase' && !/paus|inactive/i.test(t.meta.status ?? ''), stop: stops(ctx, t, inv),
      // the guided delete: production's stops, in order, before the delete itself
      ...(p.stopFirst && { stopFirst: stops(ctx, t, inv).filter((s) => t.services.some((x) => x.env_kind === 'production' && x.id === s.input.serviceId)) }) },
    recommend: recommendOf(ctx, t),
  };
}

// Delete, or archive instead: archive is the recommended choice when it looks used (a sign of use, or the person said so)
function recommendOf(ctx: Ctx, t: Target): { choice: 'archive' | 'delete'; why: string } {
  const j = judge(ctx, t, new Map());
  const strong = j.signals.filter((x) => x.strong);
  if (j.kept || strong.length) return { choice: 'archive', why: j.kept ? 'you marked it in use' : `it looks used (${strong[0]!.text.charAt(0).toLowerCase()}${strong[0]!.text.slice(1)})` };
  return { choice: 'delete', why: 'nothing says it’s in use' };
}
// What the chat's Delete card shows (ui.delete): Unit7's own words for it, never the AI's
export function deleteCard(ctx: Ctx, key: string) {
  const t = target(ctx, key);
  const inv = t.server ? lastXray(ctx.db, ctx.orgId, t.server)?.data : undefined;
  const p = plan(ctx, t, inv);
  return { key: t.key, name: t.name, itemKind: t.kind, provider: t.provider, live: !!p.stopFirst, can: p.can || !!p.stopFirst, recommend: recommendOf(ctx, t).choice, stops: stops(ctx, t, inv).length };
}

// "Archive and stop it": the stop calls that exist for it (each its own gated call)
function stops(ctx: Ctx, t: Target, inv?: Inventory): { tool: string; input: Record<string, unknown>; label: string }[] {
  if (t.services.length) return t.services.filter((s) => s.status !== 'stopped').map((s) => ({ tool: 'service.stop', input: { serviceId: s.id }, label: `Stop ${s.name}` }));
  if (t.provider === 'supabase') return [{ tool: 'asset.pause', input: { key: t.key }, label: `Pause ${t.name}` }];
  if (!t.server || !inv) return [];
  const system = (p: Part) => !!inv.projects.find((x) => x.id === p.project)?.system;
  const parts = (t.part ? [t.part] : inv.projects.find((x) => x.id === t.xproject)?.parts ?? []).map((id) => inv.parts.find((p) => p.id === id)).filter((p): p is Part => !!p && ['app', 'database', 'service'].includes(p.kind) && p.state !== 'exited');
  return parts.filter((p) => routeOf(p, 'stop', system(p)).via !== 'refuse').map((p) => ({ tool: 'part.stop', input: { serverId: t.server, part: p.id }, label: `Stop ${p.name}` }));
}

// --- running the delete ------------------------------------------------------------------------------------------
const gone = (e: unknown) => (e as Unit7Error)?.status === 404 || /not.?found|no such|doesn.t exist|could not find/i.test((e as Error)?.message ?? '');
async function atProvider(t: Target, fn: () => Promise<unknown>) {
  try { await fn(); return 'deleted'; } catch (e) {
    if (gone(e)) return 'already gone';
    const status = (e as Unit7Error).status;
    if (status === 401 || status === 403) throw new Unit7Error('not_allowed', `${providerWord(t.provider)} didn’t let Unit7 delete ${t.name}: the connected token isn’t allowed to. Delete it in ${providerWord(t.provider)} yourself, or reconnect ${providerWord(t.provider)} with a token that may delete things.`, status);
    throw e;
  }
}
// a step that is its own tool (service.remove, project.delete, coolify.remove), gated and audited as itself
async function step(ctx: Ctx, tool: string, input: Record<string, unknown>) {
  const r: ToolResult = await execute(ctx.app, ctx.orgId, ctx.actor, tool, input, { reason: 'deleting from Unit7 (asset.delete)' });
  if (r.status === 'ok') return r.output as Record<string, unknown>;
  throw new Unit7Error(r.status === 'approval_required' ? 'approval_required' : 'step_failed', r.status === 'approval_required' ? `Part of this waits for approval on the Approvals page: ${r.why}` : r.status === 'denied' ? r.why : r.status === 'error' ? r.error.message : 'That didn’t work.', 409);
}

async function remove(ctx: Ctx, t: Target, alsoData: boolean, inv?: Inventory): Promise<string[]> {
  const end = t.meta.end as End, acc = t.accountId!;
  const done: string[] = [];
  if (t.provider === 'unit7') {
    for (const s of t.services) { await step(ctx, 'service.remove', { serviceId: s.id, deleteData: alsoData }); done.push(s.name); }
    if (t.projectId) { const slug = get<{ slug: string }>(ctx.db, 'SELECT slug FROM projects WHERE id = ?', t.projectId)!.slug; await step(ctx, 'project.delete', { projectId: t.projectId, confirm: slug }); done.push(`the project ${t.name}`); }
    return done;
  }
  if (t.provider === 'coolify' && t.server && inv) {
    const kindOf = (p: Part) => (p.coolify?.type === 'database' ? 'database' : p.coolify?.type === 'service' ? 'service' : 'application');
    const pr = inv.projects.find((x) => x.id === t.xproject);
    const parts = (t.part ? [t.part] : pr?.parts ?? []).map((id) => inv.parts.find((p) => p.id === id)).filter((p): p is Part => !!p?.coolify);
    for (const p of parts) { await step(ctx, 'coolify.remove', { serverId: t.server, uuid: p.coolify!.uuid, kind: kindOf(p), deleteVolumes: alsoData, ...(alsoData && { confirmName: p.name }) }); done.push(p.name); }
    if (pr?.coolify?.uuid) { await step(ctx, 'coolify.remove', { serverId: t.server, uuid: pr.coolify.uuid, kind: 'project' }); done.push(`the Coolify project ${pr.name}`); }
    return done;
  }
  const said = (r: string) => done.push(r === 'deleted' ? `${t.name} on ${providerWord(t.provider)}` : `${t.name} (it was already gone at ${providerWord(t.provider)})`);
  switch (t.provider) {
    case 'vercel': said(await atProvider(t, () => cloudRemoval.vercelProject(ctx, acc, end.project!, end.team))); break;
    case 'netlify': said(await atProvider(t, () => hostRemoval.netlifySite(ctx, acc, end.site!))); break;
    case 'render': said(await atProvider(t, () => (t.kind === 'database' ? hostRemoval.renderPostgres(ctx, acc, t.asset!.ext_id) : hostRemoval.renderService(ctx, acc, end.service!)))); break;
    case 'railway': {
      // the whole project only when Railway itself says nothing else is in it: no other service, and no volume unless its data goes too
      const now = await hostRemoval.railwayContents(ctx, acc, end.project!).catch(() => undefined);
      const whole = !!now && now.services.every((x) => x === end.service) && (!now.volumes.length || alsoData);
      said(await atProvider(t, async () => { const r = whole ? (await hostRemoval.railwayProject(ctx, acc, end.project!)).projectDelete : (await hostRemoval.railwayService(ctx, acc, end.service!, end.environment!)).serviceDelete; if (r === false) throw new Unit7Error('railway_error', 'Railway said no.', 502); }));
      if (whole) done.push(`the empty Railway project`);
      break;
    }
    case 'fly': said(await atProvider(t, () => hostRemoval.flyApp(ctx, acc, end.app!, alsoData).catch((e) => {
      if ((e as Unit7Error).status === 409 || (e as Unit7Error).status === 412) throw new Unit7Error('data_goes', `Fly.io won’t delete ${t.name} without also removing what it holds. Tick “Also delete its data” if you mean it.`, 409);
      throw e;
    }))); break;
    case 'heroku': said(await atProvider(t, () => hostRemoval.herokuApp(ctx, acc, end.app!))); break;
    case 'neon': said(await atProvider(t, () => cloudRemoval.neonProject(ctx, acc, end.project!))); break;
    case 'supabase': said(await atProvider(t, () => cloudRemoval.supabaseProject(ctx, acc, end.ref!))); break;
    case 'planetscale': case 'turso': case 'upstash': said(await atProvider(t, () => dataServices[t.provider as DataService].remove(ctx, acc, end as unknown as Spot))); break;
    default: throw new Unit7Error('unsupported', DASHBOARD(t), 501);
  }
  return done;
}

// the map without it straight away (its account's last scan too, so a later failed scan can't bring it back);
// Warden re-syncs the map soon after (asset.deleted)
function forget(ctx: Ctx, t: Target) {
  const ids = t.ids;
  tx(ctx.db, () => {
    if (ids.length) {
      run(ctx.db, `DELETE FROM edges WHERE org_id = ? AND (source IN (${ofIds(ids)}) OR target IN (${ofIds(ids)}))`, ctx.orgId, ...ids, ...ids);
      run(ctx.db, `DELETE FROM assets WHERE org_id = ? AND id IN (${ofIds(ids)})`, ctx.orgId, ...ids);
      run(ctx.db, `DELETE FROM watch WHERE org_id = ? AND asset IN (${ofIds(ids)})`, ctx.orgId, ...ids);
      const scope = t.provider === 'unit7' || t.server ? 'unit7' : t.accountId;
      const c = scope ? get<{ found: string; refs: string }>(ctx.db, 'SELECT found, refs FROM scan_cache WHERE org_id = ? AND scope = ?', ctx.orgId, scope) : undefined;
      if (c) {
        const drop = new Set(ids);
        const found = json<Found[]>(c.found, []).filter((f) => !drop.has(assetIdOf(ctx.orgId, keyOf(f))));
        const refs = json<{ from: string }[]>(c.refs, []).filter((r) => !drop.has(assetIdOf(ctx.orgId, r.from)));
        run(ctx.db, 'UPDATE scan_cache SET found = ?, refs = ? WHERE org_id = ? AND scope = ?', JSON.stringify(found), JSON.stringify(refs), ctx.orgId, scope!);
      }
    }
    run(ctx.db, 'DELETE FROM archived WHERE org_id = ? AND key = ?', ctx.orgId, t.key);
  });
}

// --- the tools ---------------------------------------------------------------------------------------------------

// Archiving silences watching and alerts, so it's a production change when an AI does it: production unless Unit7's
// own records say the thing lives somewhere else (a Unit7 project counts as production: its production is in it).
function archivesProduction(db: Ctx['db'], orgId: string, key: string) {
  if (key.startsWith('prj_')) return true;
  const a = get<{ provider: string; ext_id: string; meta: string }>(db, 'SELECT provider, ext_id, meta FROM assets WHERE id = ? AND org_id = ?', key, orgId);
  if (a?.provider === 'unit7' && a.ext_id.startsWith('svc_')) {
    const kind = get<{ kind: string }>(db, 'SELECT e.kind FROM services s JOIN environments e ON e.id = s.environment_id WHERE s.id = ?', a.ext_id)?.kind;
    return kind !== 'development' && kind !== 'staging';
  }
  const env = json<Found>(a?.meta, {} as Found).environment;
  return !env || /prod|live|main|master/i.test(env);
}

defineTool({
  name: 'asset.archive', title: 'Archive or bring back', risk: 'write', action: 'settings_write',
  // an AI archiving something in production asks a person first (the way coolify_admin does); bringing it back is easy
  assess: (c, i) => (i.archived && archivesProduction(c.db, c.orgId, i.key) ? { tier: 2, discovered: true, impact: 'Archiving stops Unit7 watching it: no alerts, findings or suggestions for it until it’s brought back.' } : { tier: 1 }),
  description: 'Archive something you keep but don’t work on: a Unit7 project (key: its prj_ id) or anything on the map (key: its map id from map.get), like a Vercel, Netlify, Render, Railway, Fly or Heroku project, a Supabase or Neon project, a Coolify project or app, or a project the X-ray found on a server. Archived: Unit7 won’t watch, alert on or change it, and the map and suggestions leave it out. It keeps running where it is; nothing is stopped or deleted. archived: false brings it back.',
  input: z.object({ key: KEY, archived: z.boolean().default(true) }),
  run(ctx, i) {
    if (!i.archived) {
      const was = get<{ name: string }>(ctx.db, 'SELECT name FROM archived WHERE org_id = ? AND key = ?', ctx.orgId, i.key);
      run(ctx.db, 'DELETE FROM archived WHERE org_id = ? AND key = ?', ctx.orgId, i.key);
      if (was) ctx.emit('asset.unarchived', `${ctx.actor.name} brought back ${was.name}: Unit7 watches it again`, { resource: i.key });
      return { key: i.key, archived: false, name: was?.name };
    }
    const t = target(ctx, i.key);
    run(ctx.db, `INSERT INTO archived (org_id, key, name, kind, provider, by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET name = excluded.name`, ctx.orgId, t.key, t.name, t.kind, t.provider, ctx.actor.name);
    const undo = { tool: 'asset.archive', input: { key: t.key, archived: false }, label: 'Undo' };
    // an AI's archive is never quiet: Activity and the phone both say so, with Undo
    if (ctx.actor.kind !== 'user') ctx.emit('asset.ai_archived', `Your AI (${ctx.actor.agent ?? ctx.actor.name}) archived ${t.name}: Unit7 stopped watching it · Undo`, { severity: 'warning', resource: t.key, data: { key: t.key, undo } });
    else ctx.emit('asset.archived', `${ctx.actor.name} archived ${t.name}: Unit7 won’t watch, alert on or change it. It keeps running where it is.`, { resource: t.key });
    return { key: t.key, archived: true, name: t.name, note: 'Archived: Unit7 won’t watch, alert on or change it. It keeps running where it is.', undo: { tool: undo.tool, input: undo.input } };
  },
});

defineTool({
  name: 'asset.archived', title: 'What’s archived', risk: 'read', action: 'read',
  description: 'Everything archived (asset.archive): its key, name, kind, provider, who archived it and when, and whether it’s still on the map.',
  input: z.object({}),
  run(ctx) {
    const on = archivedAssets(ctx.db, ctx.orgId);
    const onMap = new Set(all<{ id: string }>(ctx.db, 'SELECT id FROM assets WHERE org_id = ?', ctx.orgId).map((a) => a.id));
    return all<{ key: string; name: string; kind: string; provider: string | null; by: string | null; created_at: string }>(ctx.db, 'SELECT key, name, kind, provider, by, created_at FROM archived WHERE org_id = ? ORDER BY created_at DESC', ctx.orgId)
      .map((r) => ({ ...r, onMap: r.key.startsWith('prj_') ? !!get(ctx.db, 'SELECT 1 FROM projects WHERE id = ?', r.key) : onMap.has(r.key) && on.has(r.key) }));
  },
});

defineTool({
  name: 'asset.impact', title: 'What deleting it affects', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'Before deleting something (a Unit7 project or a map item, by key): what stops working (domains pointing at it, apps whose settings use it), what is deleted with it (and its data: databases, volumes, storage, with the newest backup), what stays (domain registrations, databases it only uses, backups, your code), its last deploy, recent visitors and cost when known, whether it’s production, and whether and how Unit7 can delete it (or stop or pause it instead).',
  input: z.object({ key: KEY }),
  run: (ctx, i) => impact(ctx, i.key),
});

defineTool({
  name: 'asset.delete', title: 'Delete a project or app', risk: 'destructive', action: 'asset_delete', peopleOnly: true, timeoutMs: 5 * 60_000,
  description: 'People only: an AI can’t delete, even with approval; asked to delete something, show the person the Delete card (ui_delete) instead, which runs this as them. Deletes a Unit7 project or a map item (by key) with its provider’s own delete call (Vercel, Netlify, Render, Railway, Fly.io, Heroku, Neon, Supabase, PlanetScale, Turso, Upstash), through Coolify for Coolify apps, or Unit7’s own removal for Unit7 apps. confirmName must be its exact name. Data (databases, volumes, storage) goes only with alsoData; where the provider can’t delete it without its data, alsoData is required. Read asset.impact first. The map updates at once and Activity records what was removed.',
  input: z.object({ key: KEY, confirmName: z.string().max(200), alsoData: z.boolean().default(false) }),
  async run(ctx, i) {
    const t = target(ctx, i.key);
    if (i.confirmName.trim() !== t.name) throw new Unit7Error('confirm_name', `Type the exact name (${t.name}) to delete it.`, 400, { confirm: t.name });
    const inv = t.server ? lastXray(ctx.db, ctx.orgId, t.server)?.data : undefined;
    const p = plan(ctx, t, inv);
    if (!p.can) throw new Unit7Error('cant_delete', p.why ?? DASHBOARD(t), 409);
    const live = await liveData(ctx, t);
    if ((p.dataGoes === 'always' || live.length) && !i.alsoData) {
      const what = live.length ? live.map((d) => d.name).join(', ') : t.kind === 'database' ? 'it is a database' : 'its data goes with it';
      throw new Unit7Error('data_goes', `Deleting ${t.name} at ${providerWord(t.provider)} also deletes its data (${what}). Tick “Also delete its data” if you mean it.`, 409);
    }
    ctx.progress(`${p.how}…`);
    const removed = await remove(ctx, t, i.alsoData, inv);
    forget(ctx, t);
    const kept = i.alsoData || p.dataGoes === 'never' ? [] : ['its data'];
    ctx.emit('asset.deleted', `${ctx.actor.name} deleted ${t.name} (${placeWord(t.provider, t.account)}): removed ${removed.join(', ')}${kept.length ? '; its data was kept' : i.alsoData ? ', with its data' : ''}`,
      { severity: 'info', resource: t.key, data: { key: t.key, name: t.name, provider: t.provider, accountId: t.accountId, removed, alsoData: i.alsoData } }); // a person's choice, not a problem to fix
    return { deleted: t.name, provider: t.provider, removed, dataKept: !i.alsoData && p.dataGoes === 'optional' };
  },
});

defineTool({
  name: 'asset.pause', title: 'Pause it', risk: 'write', action: 'stop_service', timeoutMs: 90_000,
  description: 'Pause a Supabase project (by its map key): it stops and costs nothing on the free plan, and everything in it is kept. Resume it in Supabase. A gentler step than deleting.',
  input: z.object({ key: KEY }),
  async run(ctx, i) {
    const t = target(ctx, i.key);
    const end = t.meta.end as End | undefined;
    if (t.provider !== 'supabase' || !end?.ref || !t.accountId) throw new Unit7Error('unsupported', 'Only a Supabase project can be paused here.', 400);
    await atProvider(t, () => cloudRemoval.supabasePause(ctx, t.accountId!, end.ref!));
    run(ctx.db, `UPDATE assets SET meta = json_set(meta, '$.status', 'paused') WHERE id = ?`, t.key);
    ctx.emit('asset.paused', `${ctx.actor.name} paused ${t.name} on Supabase. Everything in it is kept.`, { resource: t.key });
    return { paused: t.name };
  },
});

// Things that look abandoned, from what the scanners and the watch already know: no deploy in 90 days, no visitors,
// no domain of yours, not answering, already paused. Never anything with a sign of use (usageOf) or a person's "it's in
// use" (asset.keep). ponytail: a heuristic over stored facts, no provider calls; add per-provider "last deployed" to the
// scanners when it should be sharper.
defineTool({
  name: 'asset.cleanup', title: 'What looks abandoned', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'Projects and apps that look abandoned (no deploy in 90+ days, no visitors, no domain pointing at them, not answering, paused), each with why, to archive, delete or mark in use one at a time; left: what looks quiet by visitors and deploys alone but is in use, with why. Leaves out what’s archived, what the person marked in use (asset.keep), and anything with a sign of use: calls from other servers or apps, apps whose settings point at it, a domain that answers, a deploy or code change in 30 days, logs, scheduled jobs, data going in and out. asset.usage says why one is or isn’t listed.',
  input: z.object({}),
  run(ctx) {
    const off = archivedAssets(ctx.db, ctx.orgId), m: Memo = new Map();
    const out: { key: string; name: string; kind: string; provider: string; account?: string; reasons: string[]; why: string }[] = [];
    // what looks quiet by visitors and deploys alone but is in use (or marked so): left out, and why
    const left: { key: string; name: string; provider: string; why: string }[] = [];
    const accounts = new Map(all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM accounts WHERE org_id = ?', ctx.orgId).map((a) => [a.id, a.name]));
    const rows = all<AssetRow>(ctx.db, `SELECT id, account_id, provider, kind, ext_id, name, url, meta FROM assets WHERE org_id = ? AND kind IN ('app', 'database', 'project') AND provider != 'unit7' ORDER BY name`, ctx.orgId)
      .filter((a) => !off.has(a.id) && !json<Found>(a.meta, {} as Found).system && !json<Found>(a.meta, {} as Found).project);
    for (const a of rows) {
      const t = target(ctx, a.id), j = judge(ctx, t, m);
      if (!j.listed) { if (j.idle) left.push({ key: a.id, name: a.name, provider: a.provider, why: j.why }); continue; }
      // something found inside a server says which server (three "old-test" on three servers are three rows)
      const where = a.account_id ? accounts.get(a.account_id) : t.server ? get<{ name: string }>(ctx.db, 'SELECT name FROM servers WHERE id = ? AND org_id = ?', t.server, ctx.orgId)?.name : undefined;
      out.push({ key: a.id, name: a.name, kind: a.kind, provider: a.provider, account: where, reasons: j.reasons, why: j.why });
    }
    // Unit7's own projects with nothing deployed in 90 days
    const keys = archivedKeys(ctx.db, ctx.orgId);
    for (const p of all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM projects WHERE org_id = ?', ctx.orgId)) {
      if (keys.has(p.id)) continue;
      const j = judge(ctx, target(ctx, p.id), m);
      if (j.listed) out.push({ key: p.id, name: p.name, kind: 'project', provider: 'unit7', reasons: j.reasons, why: j.why });
      else if (j.idle) left.push({ key: p.id, name: p.name, provider: 'unit7', why: j.why });
    }
    return { items: out.sort((a, b) => b.reasons.length - a.reasons.length || a.name.localeCompare(b.name)).slice(0, 40), left: left.slice(0, 40) };
  },
});

defineTool({
  name: 'asset.usage', title: 'Is it in use?', risk: 'read', action: 'read',
  description: 'Whether something is in use and why (a Unit7 project or a map item, by key), so why Clean up lists it or not: each sign Unit7 has (visitors, calls from other servers, apps or scripts, apps whose settings point at it, a domain that answers, deploys and code changes, logs, scheduled jobs, data going in and out) and what the person marked (asset.keep). why is one plain sentence.',
  input: z.object({ key: KEY }),
  run(ctx, i) {
    const t = target(ctx, i.key);
    const { listed, why, signals, pulse, kept, important, archived } = judge(ctx, t, new Map());
    const note = get<{ note: string | null }>(ctx.db, 'SELECT note FROM kept WHERE org_id = ? AND key = ?', ctx.orgId, t.key)?.note ?? undefined;
    return { key: t.key, name: t.name, inUse: kept || signals.some((s) => s.strong), listed, why, signals, pulse, kept, important, ...(note && { note }), archived };
  },
});

defineTool({
  name: 'asset.pulse', title: 'What’s in use', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'For each project and app: when it was last used and how Unit7 knows (pulse: label, at, by = how many apps use it, detail), from the strongest sign of use; nothing for things Unit7 knows nothing about. Also everything the person marked in use or important (kept, from asset.keep).',
  input: z.object({}),
  run(ctx) {
    const m: Memo = new Map(), now = Date.now(), off = archivedAssets(ctx.db, ctx.orgId), gone = archivedKeys(ctx.db, ctx.orgId);
    const pulse: Record<string, Pulse> = {};
    const keys = [
      ...all<{ id: string; meta: string }>(ctx.db, `SELECT id, meta FROM assets WHERE org_id = ? AND kind IN ('app', 'database', 'project')`, ctx.orgId).filter((a) => !off.has(a.id) && !json<Found>(a.meta, {} as Found).system).map((a) => a.id),
      ...all<{ id: string }>(ctx.db, 'SELECT id FROM projects WHERE org_id = ?', ctx.orgId).map((p) => p.id).filter((k) => !gone.has(k)),
    ];
    for (const k of keys) { const p = pulseOf(usageOf(ctx, target(ctx, k), { now, memo: m }).signals); if (p) pulse[k] = p; }
    return { kept: keptRows(ctx.db, ctx.orgId).map((r) => ({ ...r, important: !!r.important })), pulse };
  },
});

defineTool({
  name: 'asset.keep', title: 'Mark as in use', risk: 'write', action: 'keep_write',
  // it changes what Unit7 suggests and how carefully it treats a thing: an AI asks a person first, whichever way
  assess: () => ({ tier: 1, ask: 'Saying something is in use or important changes what Unit7 suggests and how carefully it treats it, so a person confirms it first.' }),
  description: 'Say something is in use even with no visitors (an API other servers call, a worker, a database): a Unit7 project (key: its prj_ id) or anything on the map (key: its map id from map.get). Clean up and the savings ideas never suggest it again. important: true also marks it important: Unit7 takes extra care, and an AI asks a person before changing it in production. note: why, in a few words. kept: false takes the mark away. An AI asks a person first.',
  input: z.object({ key: KEY, important: z.boolean().optional(), note: z.string().trim().max(200).optional(), kept: z.boolean().default(true) }),
  run(ctx, i) {
    const prev = get<{ name: string; important: number; note: string | null }>(ctx.db, 'SELECT name, important, note FROM kept WHERE org_id = ? AND key = ?', ctx.orgId, i.key);
    const back = prev ? { key: i.key, important: !!prev.important, ...(prev.note && { note: prev.note }) } : { key: i.key, kept: false };
    if (!i.kept) {
      run(ctx.db, 'DELETE FROM kept WHERE org_id = ? AND key = ?', ctx.orgId, i.key);
      if (prev) ctx.emit('asset.unkept', `${ctx.actor.name} took the “in use” mark off ${prev.name}: Clean up may suggest it again`, { resource: i.key });
      return { key: i.key, kept: false, name: prev?.name, ...(prev && { undo: { tool: 'asset.keep', input: back } }) };
    }
    const t = target(ctx, i.key);
    const important = i.important ?? !!prev?.important;
    run(ctx.db, `INSERT INTO kept (org_id, key, name, kind, provider, important, note, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET
      name = excluded.name, important = excluded.important, note = coalesce(excluded.note, kept.note), by = excluded.by`, ctx.orgId, t.key, t.name, t.kind, t.provider, important ? 1 : 0, i.note || null, ctx.actor.name);
    const note = important ? `${t.name} is marked important: it counts as in use, Unit7 never suggests archiving or deleting it, and takes extra care before changing it.`
      : `${t.name} is marked in use: Unit7 won’t suggest archiving or deleting it again.`;
    ctx.emit('asset.kept', `${ctx.actor.name} marked ${t.name} ${important ? 'important' : 'in use'}`, { resource: t.key, data: { key: t.key, important } });
    return { key: t.key, kept: true, important, name: t.name, note, undo: { tool: 'asset.keep', input: back } };
  },
});
