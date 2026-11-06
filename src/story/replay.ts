// "Replay a failure": when something fails (a site check goes red, a deploy fails, an unusual jump, an incident), the
// story of the ten minutes before and after: usage (CPU, memory against its cap, restarts, out-of-memory kills),
// traffic and errors, the deploys and changes from the timeline, and the first error lines (secrets removed, marked as
// untrusted). Then the likely cause in plain words, from fixed rules: "memory hit the cap at 03:12, then the app
// restarted 4 times", "the deploy at 14:02 started server errors". No AI decides the cause; "Explain with AI" can
// take the story further. Reads the database only.
import { all, get, json, type DB } from '../db.ts';
import { Redactor } from '../redact.ts';
import { untrusted } from '../agent/escalate.ts';
import { fmtBytes } from '../sentinel/anomaly.ts';
import { settingsOf } from '../sentinel/schedule.ts';
import type { Inventory } from '../discovery/xray.ts';
import type { AppErrors, Summary } from '../sentinel/traffic.ts';
import { Names, gather, resolveScope, type Item } from './timeline.ts';

const MIN = 60_000;
export const WINDOW = 10 * MIN;   // the story: ten minutes either side
const LOOKBACK = 30 * MIN;        // a change this long before still counts as a cause

export interface UsagePoint { at: number; cpu: number | null; cpuMax: number | null; mem: number | null; memMax: number | null; restarts: number; oom: number; disk?: number | null }
export interface TrafficPoint { at: number; requests: number; errors: number; p95?: number }
export interface Signal { at: number; ok: boolean; type: string; text: string }
export interface Facts {
  at: number; from: number; to: number; name: string; server: boolean;
  usage: UsagePoint[]; memCap?: number; diskTotal?: number;
  traffic: TrafficPoint[]; coarse?: boolean; usual?: number; // requests a minute before it, when known
  changes: Item[]; signals: Signal[]; errorLines: number;
}
export type Rule = 'oom_loop' | 'oom' | 'bad_deploy' | 'traffic_spike' | 'restart_loop' | 'change' | 'cpu' | 'disk' | 'errors' | 'unknown';
export interface Cause { rule: Rule; text: string; at?: string; itemId?: string; confidence: 'high' | 'medium' | 'low' | 'none' }

const hm = (t: number, tz?: string) => { try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz || 'UTC' }).format(new Date(t)); } catch { return new Date(t).toISOString().slice(11, 16); } };
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const mins = (ms: number) => { const m = Math.max(1, Math.round(ms / MIN)); return `${m} minute${m === 1 ? '' : 's'}`; };
const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0; };
const FAIL_WORDS: Record<string, string> = { 'site.down': 'stopped answering', 'service.down': 'went down', 'service.unhealthy': 'turned unhealthy', 'server.unreachable': 'stopped answering Unit7', 'domain.broken': 'stopped pointing where it should', 'app.errors': 'started writing errors' };
const DEPLOYISH = new Set(['deploy', 'rollback']);
const CHANGEISH = new Set(['setting', 'dns', 'change', 'security', 'server', 'found', 'link', 'other']);

// --- the rules, in the order they're trusted ----------------------------------------------------------------------
export function causeOf(f: Facts, tz?: string): Cause {
  const inWin = (t: number) => t >= f.from && t <= f.to;
  const use = f.usage.filter((p) => inWin(p.at));
  const restarts = use.reduce((a, p) => a + p.restarts, 0);
  const oomAt = use.find((p) => p.oom > 0)?.at;
  const deploys = f.changes.filter((c) => DEPLOYISH.has(c.kind) && c.status !== 'failed' && Date.parse(c.at) <= f.at && Date.parse(c.at) >= f.at - LOOKBACK).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const after = (d: Item, t: number) => ` It began ${mins(t - Date.parse(d.at))} after the deploy at ${hm(Date.parse(d.at), tz)}.`;

  // 1. out of memory: the kernel stopped it for using more than it may, and usually it came back and did it again
  if (oomAt !== undefined) {
    const peak = Math.max(0, ...use.map((p) => p.memMax ?? p.mem ?? 0));
    const capWords = f.memCap ? ` its ${fmtBytes(f.memCap)} cap` : ' its cap';
    const d = deploys.find((x) => Date.parse(x.at) <= oomAt);
    const tail = d ? after(d, oomAt) : '';
    const text = restarts >= 2
      ? `Memory hit${capWords} at ${hm(oomAt, tz)}, then ${f.name} restarted ${times(restarts)}.${tail}`
      : `Memory hit${capWords} at ${hm(oomAt, tz)} and ${f.name} was stopped for using too much${peak && f.memCap ? ` (${fmtBytes(peak)})` : ''}.${tail}`;
    return { rule: restarts >= 2 ? 'oom_loop' : 'oom', text, at: new Date(oomAt).toISOString(), ...(d && { itemId: d.id }), confidence: 'high' };
  }
  // 2. a deploy just before: errors that weren't there, or the failure itself a few minutes later
  const d = deploys[0];
  if (d) {
    const dt = Date.parse(d.at), m0 = Math.floor(dt / MIN) * MIN; // the minute it went live in counts as after it
    const before = f.traffic.filter((p) => p.at < m0 && p.at >= m0 - 15 * MIN), afterT = f.traffic.filter((p) => p.at >= m0 && p.at <= f.to);
    const eb = before.length ? before.reduce((a, p) => a + p.errors, 0) / before.length : 0;
    const ea = afterT.length ? afterT.reduce((a, p) => a + p.errors, 0) / afterT.length : 0;
    if (!f.coarse && afterT.length && ea >= 3 && ea >= 3 * Math.max(eb, 0.3)) {
      return { rule: 'bad_deploy', text: `The deploy at ${hm(dt, tz)} started server errors: about ${round(ea)} a minute, up from ${round(eb)}.`, at: d.at, itemId: d.id, confidence: 'high' };
    }
    const bad = f.signals.filter((s) => !s.ok && s.at >= dt && s.at <= f.to && s.type !== 'deployment.failed').sort((a, b) => a.at - b.at)[0];
    if (bad) {
      const what = FAIL_WORDS[bad.type] ?? 'had trouble';
      return { rule: 'bad_deploy', text: `${f.name} ${what} at ${hm(bad.at, tz)}, ${mins(bad.at - dt)} after the deploy at ${hm(dt, tz)}.`, at: d.at, itemId: d.id, confidence: 'high' };
    }
    if (f.at - dt <= 15 * MIN) return { rule: 'bad_deploy', text: `The trouble began ${mins(f.at - dt)} after the deploy at ${hm(dt, tz)}.`, at: d.at, itemId: d.id, confidence: 'medium' };
  }
  // 3. a rush of visitors: several times the usual, right around it
  const near = f.traffic.filter((p) => p.at >= f.at - WINDOW && p.at <= f.at + 5 * MIN);
  const usual = f.usual ?? median(f.traffic.filter((p) => p.at < f.at - WINDOW).map((p) => p.requests));
  const peak = near.reduce<TrafficPoint | undefined>((a, p) => (!a || p.requests > a.requests ? p : a), undefined);
  if (peak && usual >= 1 && peak.requests >= 30 && peak.requests >= 3 * usual) {
    const later = f.traffic.filter((p) => p.at >= peak.at && p.at <= f.to);
    const errs = later.length && later.reduce((a, p) => a + p.errors, 0) / later.length >= 3;
    const hot = f.server && use.some((p) => (p.cpuMax ?? p.cpu ?? 0) >= 90);
    return { rule: 'traffic_spike', text: `Traffic jumped ${round(peak.requests / usual)}× at ${hm(peak.at, tz)}: about ${Math.round(peak.requests)} requests a minute, against ${round(usual)} usually.${errs ? ' Errors followed.' : hot ? ' The CPU ran flat out.' : ''}`, at: new Date(peak.at).toISOString(), confidence: f.coarse ? 'medium' : 'high' };
  }
  // 4. a restart loop without running out of memory
  if (restarts >= 3) {
    const first = use.find((p) => p.restarts > 0)!.at;
    return { rule: 'restart_loop', text: `${f.name} restarted ${times(restarts)} from ${hm(first, tz)}.${f.errorLines ? ' Its first error lines are below.' : ''}`, at: new Date(first).toISOString(), confidence: 'medium' };
  }
  // 5. a change just before it
  const c = f.changes.filter((x) => CHANGEISH.has(x.kind) && x.status !== 'failed' && Date.parse(x.at) <= f.at && Date.parse(x.at) >= f.at - LOOKBACK).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (c) return { rule: 'change', text: `${c.text.replace(/\.$/, '')} at ${hm(Date.parse(c.at), tz)}, ${mins(f.at - Date.parse(c.at))} before the trouble.`, at: c.at, itemId: c.id, confidence: 'medium' };
  // 6. the whole server flat out, or out of disk
  const hotAt = f.server ? use.find((p) => (p.cpuMax ?? p.cpu ?? 0) >= 95)?.at : undefined;
  if (hotAt !== undefined) return { rule: 'cpu', text: `The server’s CPU was flat out from ${hm(hotAt, tz)}.`, at: new Date(hotAt).toISOString(), confidence: 'low' };
  const full = f.diskTotal ? use.find((p) => (p.disk ?? 0) / f.diskTotal! >= 0.97) : undefined;
  if (full) return { rule: 'disk', text: `The disk was full at ${hm(full.at, tz)}.`, at: new Date(full.at).toISOString(), confidence: 'medium' };
  // 7. at least the logs say something
  if (f.errorLines) return { rule: 'errors', text: `${f.name}’s logs filled with errors around ${hm(f.at, tz)}. The first lines are below.`, confidence: 'low' };
  return { rule: 'unknown', text: 'Nothing in the minutes around it explains it on its own. The chart and the changes below show what Unit7 saw.', confidence: 'none' };
}

// --- what was happening, from the database ------------------------------------------------------------------------
export interface ReplayInput { incidentId?: string; serviceId?: string; serverId?: string; host?: string; at?: string }
// an address: the Unit7 app its domain opens, else the server whose X-ray routes it
export function placeHost(db: DB, orgId: string, host: string): { serviceId?: string; serverId?: string } {
  const h = host.toLowerCase();
  const s = get<{ service_id: string }>(db, 'SELECT service_id FROM domains WHERE org_id = ? AND hostname = ? AND service_id IS NOT NULL', orgId, h)?.service_id;
  if (s) return { serviceId: s };
  for (const x of all<{ server_id: string; data: string }>(db, `SELECT server_id, data FROM xrays x WHERE org_id = ? AND kind = 'fast' AND ok = 1
      AND created_at = (SELECT max(created_at) FROM xrays WHERE server_id = x.server_id AND kind = 'fast' AND ok = 1)`, orgId)) {
    if (json<Inventory>(x.data, {} as Inventory).parts?.some((p) => p.hosts?.some((y) => y.toLowerCase() === h))) return { serverId: x.server_id };
  }
  return {};
}
export interface Bucket { at: string; requests: number | null; errors: number | null; cpu: number | null; mem: number | null; restarts: number; oom: number }
export interface Marker { at: string; kind: 'deploy' | 'change' | 'restart' | 'oom' | 'failure' | 'recovery'; label: string; itemId?: string }
export interface Story {
  at: string; from: string; to: string; title: string; scope: { label: string; serverId?: string; serviceId?: string; incidentId?: string };
  cause: Cause; buckets: Bucket[]; memCap: number | null; coarse: boolean; markers: Marker[]; changes: Item[];
  errors: { source: string; lines: string[] }[]; untrusted: true; aiContext: string;
}

// an incident: when, and on which server and app (Warden and the watch write these differently)
export function incidentScope(db: DB, orgId: string, incidentId: string): { at: string; title: string; serverId?: string; serviceId?: string } | undefined {
  const inc = get<{ title: string; created_at: string }>(db, 'SELECT title, created_at FROM incidents WHERE id = ? AND org_id = ?', incidentId, orgId);
  if (!inc) return undefined;
  let serverId = get<{ server_id: string }>(db, 'SELECT server_id FROM watch_alerts WHERE incident_id = ? AND org_id = ? LIMIT 1', incidentId, orgId)?.server_id;
  const ev = get<{ message: string; data: string }>(db, `SELECT message, data FROM events WHERE org_id = ? AND resource = ? AND type = 'incident.opened' LIMIT 1`, orgId, incidentId);
  serverId ??= json<{ serverId?: string }>(ev?.data, {}).serverId;
  if (!serverId) {
    const named = / on ([^:]+?)\.?$/.exec(ev?.message ?? inc.title)?.[1];
    if (named) serverId = get<{ id: string }>(db, 'SELECT id FROM servers WHERE org_id = ? AND name = ?', orgId, named.trim())?.id;
  }
  const before = new Date(Date.parse(inc.created_at) - 15 * MIN).toISOString();
  const svc = get<{ resource: string }>(db, `SELECT resource FROM events WHERE org_id = ? AND type IN ('service.down', 'service.unhealthy', 'deployment.failed') AND resource LIKE 'svc\\_%' ESCAPE '\\'
    AND created_at >= ? AND created_at <= ? ${serverId ? 'AND resource IN (SELECT id FROM services WHERE server_id = ?)' : ''} ORDER BY created_at DESC LIMIT 1`, orgId, before, inc.created_at, ...(serverId ? [serverId] : []))?.resource
    // a site that stopped answering: the app its domain opens
    ?? get<{ service_id: string }>(db, `SELECT d.service_id FROM events e JOIN domains d ON d.hostname = e.resource AND d.org_id = e.org_id WHERE e.org_id = ? AND e.type = 'site.down' AND e.created_at >= ? AND e.created_at <= ?
      AND d.service_id IS NOT NULL ${serverId ? 'AND d.service_id IN (SELECT id FROM services WHERE server_id = ?)' : ''} ORDER BY e.created_at DESC LIMIT 1`, orgId, before, new Date(Date.parse(inc.created_at) + 60_000).toISOString(), ...(serverId ? [serverId] : []))?.service_id;
  return { at: inc.created_at, title: inc.title, ...(serverId && { serverId }), ...(svc && { serviceId: svc }) };
}

const latestXray = (db: DB, orgId: string, serverId: string, at: string) =>
  json<Inventory | null>(get<{ data: string }>(db, `SELECT data FROM xrays WHERE org_id = ? AND server_id = ? AND kind = 'fast' AND ok = 1 AND created_at <= ? ORDER BY created_at DESC LIMIT 1`, orgId, serverId, at)?.data
    ?? get<{ data: string }>(db, `SELECT data FROM xrays WHERE org_id = ? AND server_id = ? AND kind = 'fast' AND ok = 1 ORDER BY created_at LIMIT 1`, orgId, serverId)?.data, null);

export function replay(db: DB, orgId: string, i: ReplayInput, nowMs = Date.now()): Story {
  const inc = i.incidentId ? incidentScope(db, orgId, i.incidentId) : undefined;
  const placed = i.host && !i.serviceId && !i.serverId ? placeHost(db, orgId, i.host) : {};
  const serviceId = i.serviceId ?? placed.serviceId ?? inc?.serviceId;
  const n = new Names(db, orgId);
  const svc = serviceId ? n.svcs.get(serviceId) : undefined;
  const serverId = i.serverId ?? svc?.server_id ?? placed.serverId ?? inc?.serverId ?? undefined;
  const atMs = Math.min(Date.parse(i.at ?? inc?.at ?? new Date(nowMs).toISOString()), nowMs);
  const from = atMs - WINDOW, to = Math.min(atMs + WINDOW, nowMs);
  const iso = (t: number) => new Date(t).toISOString();
  const tz = settingsOf(db, orgId).tz;
  const name = svc?.name ?? (serverId ? n.srv(serverId) : undefined) ?? 'it';
  const inv = serverId ? latestXray(db, orgId, serverId, iso(atMs)) : null;

  // usage: the app's own project on the server (from the X-ray), or the whole server
  const part = svc && inv?.parts.find((p) => p.id === `unit7:${svc.id}`);
  const scope = part?.project ?? 'server';
  const usage: UsagePoint[] = serverId ? all<{ at: string; cpu: number | null; cpu_max: number | null; mem: number | null; mem_max: number | null; restarts: number; oom: number; disk: number | null }>(db,
    `SELECT at, cpu, cpu_max, mem, mem_max, restarts, oom, disk FROM usage_points WHERE server_id = ? AND res = '5m' AND scope = ? AND at >= ? AND at <= ? ORDER BY at`, serverId, scope, iso(from - LOOKBACK), iso(to))
    .map((p) => ({ at: Date.parse(p.at), cpu: p.cpu, cpuMax: p.cpu_max, mem: p.mem, memMax: p.mem_max, restarts: p.restarts, oom: p.oom, disk: p.disk })) : [];
  const projectParts = scope === 'server' ? [] : inv?.parts.filter((p) => p.project === scope && (p.containers?.length ?? 0) > 0) ?? [];
  const memCap = projectParts.length && projectParts.every((p) => (p.memLimit ?? 0) > 0) ? projectParts.reduce((a, p) => a + p.memLimit!, 0) : inv?.server.memTotal;

  // traffic: Caddy's half-minute counts when Unit7's proxy serves it, else the half-hourly check (coarse)
  const hosts = svc ? new Set(all<{ hostname: string }>(db, 'SELECT hostname FROM domains WHERE service_id = ? AND org_id = ?', svc.id, orgId).map((d) => d.hostname.toLowerCase())) : undefined;
  const raw = serverId ? all<{ hostname: string; at: string; requests: number; errors: number; p95_ms: number }>(db, 'SELECT hostname, at, requests, errors, p95_ms FROM traffic WHERE server_id = ? AND at >= ? AND at <= ? ORDER BY at', serverId, iso(from - 60 * MIN), iso(to))
    .filter((t) => !hosts?.size || hosts.has(t.hostname.toLowerCase())) : [];
  const perMin = new Map<number, TrafficPoint>();
  for (const t of raw) {
    const m = Math.floor(Date.parse(t.at) / MIN) * MIN, p = perMin.get(m) ?? { at: m, requests: 0, errors: 0 };
    p.requests += t.requests; p.errors += t.errors; p.p95 = Math.max(p.p95 ?? 0, t.p95_ms); perMin.set(m, p);
  }
  let traffic = [...perMin.values()].sort((a, b) => a.at - b.at), coarse = false, usual: number | undefined;
  const windows = serverId ? all<{ at: string; minutes: number; summary: string }>(db, 'SELECT at, minutes, summary FROM traffic_windows WHERE server_id = ? AND at >= ? AND at <= ? ORDER BY at', serverId, iso(from - 86400_000), iso(to + 60 * MIN))
    .map((w) => ({ end: Date.parse(w.at), minutes: w.minutes, s: json<Summary>(w.summary, {} as Summary) })) : [];
  const overlapping = windows.filter((w) => w.end >= from && w.end - w.minutes * MIN <= to);
  if (!traffic.length && overlapping.length) {
    coarse = true;
    for (const w of overlapping) for (let m = Math.max(from, w.end - w.minutes * MIN); m < Math.min(to, w.end); m += MIN) {
      traffic.push({ at: Math.floor(m / MIN) * MIN, requests: (w.s.requests ?? 0) / w.minutes, errors: (w.s.status?.s5xx ?? 0) / w.minutes, ...(w.s.p95 && { p95: w.s.p95 }) });
    }
    traffic = traffic.sort((a, b) => a.at - b.at);
    const past = windows.filter((w) => w.end < from && w.minutes > 0).map((w) => (w.s.requests ?? 0) / w.minutes);
    if (past.length) usual = median(past);
  }

  // the first error lines: from the traffic and log check and the app's own error groups; untrusted, secrets removed
  const red = new Redactor();
  const clean = (l: string) => red.redact(l).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 300);
  const mine = new Set([...(part?.containers ?? []), ...(svc ? all<{ container: string | null }>(db, 'SELECT container FROM deployments WHERE service_id = ? AND container IS NOT NULL ORDER BY number DESC LIMIT 3', svc.id).map((d) => d.container!) : [])]);
  const errors: Story['errors'] = [];
  for (const w of overlapping) for (const e of (w.s.errors ?? []) as AppErrors[]) {
    if (svc && mine.size && ![...mine].some((c) => e.container === c || e.container.startsWith(`${c}-`))) continue;
    if (errors.length < 4 && !errors.some((x) => x.source === e.container)) errors.push({ source: e.container, lines: e.sample.slice(0, 3).map(clean) });
  }
  if (svc) for (const g of all<{ kind: string; message: string; sample: string }>(db, 'SELECT kind, message, sample FROM error_groups WHERE service_id = ? AND org_id = ? AND last_seen >= ? AND first_seen <= ? ORDER BY first_seen LIMIT 3', svc.id, orgId, iso(from), iso(to))) {
    errors.push({ source: svc.name, lines: [clean(`${g.kind}: ${g.message}`), ...g.sample.split('\n').slice(0, 2).map(clean)].filter(Boolean) });
  }

  // what happened: events for this thing, and the timeline's changes
  const siteHosts = hosts ?? (serverId ? resolveScope(db, orgId, { serverId }, n).hosts : new Set<string>());
  const keys = new Set([serverId, svc?.id, ...siteHosts].filter(Boolean).map((x) => x!.toLowerCase()));
  const evs = all<{ type: string; severity: string; message: string; resource: string | null; created_at: string }>(db,
    `SELECT type, severity, message, resource, created_at FROM events WHERE org_id = ? AND created_at >= ? AND created_at <= ? AND resource IS NOT NULL ORDER BY created_at LIMIT 500`, orgId, iso(from - LOOKBACK), iso(to))
    .filter((e) => keys.has(e.resource!.toLowerCase()) || e.resource === i.incidentId);
  const BAD = new Set(['site.down', 'service.down', 'service.unhealthy', 'deployment.failed', 'server.unreachable', 'domain.broken', 'app.errors', 'incident.opened']);
  const GOOD = new Set(['site.recovered', 'server.recovered', 'deployment.succeeded', 'deployment.healed', 'watch.cleared']);
  const signals: Signal[] = evs.filter((e) => BAD.has(e.type) || GOOD.has(e.type) || (e.type.startsWith('watch.') && e.severity === 'critical')).map((e) => ({ at: Date.parse(e.created_at), ok: GOOD.has(e.type), type: e.type, text: red.redact(e.message).slice(0, 240) }));
  const changes = gather(db, orgId, { ...(svc ? { serviceId: svc.id } : serverId ? { serverId } : {}) }, iso(from - LOOKBACK), iso(to), n).items;

  const facts: Facts = { at: atMs, from, to, name, server: !svc, usage, ...(memCap && { memCap }), ...(inv?.server.diskTotal && { diskTotal: inv.server.diskTotal }), traffic, coarse, ...(usual !== undefined && { usual }), changes, signals, errorLines: errors.reduce((a, e) => a + e.lines.length, 0) };
  const cause = causeOf(facts, tz);

  // the strip: one bucket a minute, usage held across its five minutes
  const buckets: Bucket[] = [];
  for (let m = Math.floor(from / MIN) * MIN; m <= to; m += MIN) {
    const t = traffic.filter((p) => p.at === m);
    const u = usage.filter((p) => p.at <= m).at(-1);
    const fresh = usage.find((p) => p.at === m); // restarts and kills land on their own five-minute mark only
    buckets.push({ at: iso(m), requests: t.length ? Math.round(t.reduce((a, p) => a + p.requests, 0) * 10) / 10 : null, errors: t.length ? Math.round(t.reduce((a, p) => a + p.errors, 0) * 10) / 10 : null,
      cpu: u && m - u.at < 5 * MIN ? u.cpu : null, mem: u && m - u.at < 5 * MIN ? u.memMax ?? u.mem : null, restarts: fresh?.restarts ?? 0, oom: fresh?.oom ?? 0 });
  }
  const inStory = (at: string) => Date.parse(at) >= from && Date.parse(at) <= to;
  const shown = changes.filter((c) => inStory(c.at) || c.id === cause.itemId);
  const markers: Marker[] = [
    ...shown.map((c): Marker => ({ at: Date.parse(c.at) < from ? iso(from) : c.at, kind: DEPLOYISH.has(c.kind) ? 'deploy' : c.kind === 'restart' ? 'restart' : 'change', label: c.text, itemId: c.id })),
    ...signals.filter((s) => s.at >= from).map((s): Marker => ({ at: iso(s.at), kind: s.ok ? 'recovery' : 'failure', label: s.text })),
    ...usage.filter((p) => p.at >= from && p.oom > 0).map((p): Marker => ({ at: iso(p.at), kind: 'oom', label: `Out of memory${p.oom > 1 ? ` (${p.oom} times)` : ''}` })),
    ...usage.filter((p) => p.at >= from && p.restarts > 0 && !p.oom).map((p): Marker => ({ at: iso(p.at), kind: 'restart', label: `Restarted ${times(p.restarts)}` })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));

  const title = inc?.title ?? `Around ${hm(atMs, tz)} on ${name}`;
  const lines = [
    `What Unit7 recorded around ${hm(atMs, tz)} (${tz || 'UTC'}) on ${name}, from ${hm(from, tz)} to ${hm(to, tz)}:`,
    `- Likely cause, by Unit7's rules: ${cause.text}`,
    ...(shown.length ? [`- Changes: ${shown.slice(0, 8).map((c) => `${hm(Date.parse(c.at), tz)} ${c.text} (${c.who.name})`).join('; ')}`] : ['- No changes recorded.']),
    usage.some((p) => p.at >= from) ? `- Usage: memory peaked at ${fmtBytes(Math.max(...usage.filter((p) => p.at >= from).map((p) => p.memMax ?? p.mem ?? 0)))}${memCap ? ` of ${fmtBytes(memCap)}` : ''}, ${usage.filter((p) => p.at >= from).reduce((a, p) => a + p.restarts, 0)} restarts, ${usage.filter((p) => p.at >= from).reduce((a, p) => a + p.oom, 0)} out-of-memory kills.` : '- No usage samples for that time.',
    traffic.some((p) => p.at >= from) ? `- Traffic: up to ${Math.round(Math.max(...traffic.filter((p) => p.at >= from).map((p) => p.requests)))} requests and ${Math.round(Math.max(...traffic.filter((p) => p.at >= from).map((p) => p.errors)))} server errors a minute${coarse ? ' (averaged over the half-hourly check)' : ''}.` : '- No traffic counts for that time.',
  ];
  const evidence = [...signals.filter((s) => s.at >= from).map((s) => `${hm(s.at, tz)} ${s.text}`), ...errors.flatMap((e) => [`[${e.source}]`, ...e.lines])].join('\n');
  const aiContext = `${lines.join('\n')}${evidence ? `\n\n${untrusted('alerts and app logs', evidence)}` : ''}`;
  return { at: iso(atMs), from: iso(from), to: iso(to), title, scope: { label: name, ...(serverId && { serverId }), ...(svc && { serviceId: svc.id }), ...(i.incidentId && { incidentId: i.incidentId }) },
    cause, buckets, memCap: memCap ?? null, coarse, markers, changes: shown, errors, untrusted: true, aiContext };
}

// --- for alerts: one short "likely cause" when a rule found one ----------------------------------------------------
// which thing an alert is about, from its event
export function replayOfEvent(db: DB, orgId: string, e: { type: string; resource?: string | null; created_at: string; data?: Record<string, unknown> }): Story | undefined {
  const r = e.resource ?? '';
  const inputs: ReplayInput | undefined = e.type === 'incident.opened' && r.startsWith('inc_') ? { incidentId: r }
    : r.startsWith('svc_') ? { serviceId: r, at: e.created_at }
    : r.startsWith('srv_') ? { serverId: r, at: e.created_at }
    : e.type.startsWith('site.') && r ? { host: r, at: e.created_at }
    : undefined;
  if (!inputs || (inputs.host && !Object.keys(placeHost(db, orgId, inputs.host)).length)) return undefined;
  try { return replay(db, orgId, inputs, Date.parse(e.created_at) + WINDOW); } catch { return undefined; }
}
const EXPLAINED = new Set(['incident.opened', 'site.down', 'service.down', 'service.unhealthy', 'deployment.failed', 'watch.anomaly', 'server.unreachable', 'domain.broken']);
// " Likely cause: …" for the phone, or nothing (a rule that found nothing says nothing)
export function causeLine(db: DB, e: { org_id: string; type: string; resource?: string | null; created_at: string; data?: Record<string, unknown> }): string {
  if (!EXPLAINED.has(e.type)) return '';
  try {
    const s = replayOfEvent(db, e.org_id, e);
    return s && s.cause.confidence !== 'none' && s.cause.confidence !== 'low' ? ` Likely cause: ${s.cause.text}` : '';
  } catch { return ''; } // an alert always goes out, with or without its story
}
// for an AI's investigation (src/agent/escalate.ts): the replay of the app or server its brief names, now
export function storyNote(db: DB, orgId: string, brief: string, nowMs = Date.now()): string {
  try {
    const id = (p: string) => [...brief.matchAll(new RegExp(`(?<![\\w-])${p}_[A-Za-z0-9_-]{12}(?![\\w-])`, 'g'))].map((m) => m[0]).find((x) => get(db, `SELECT 1 FROM ${p === 'svc' ? 'services' : 'servers'} WHERE id = ? AND org_id = ?`, x, orgId));
    const serviceId = id('svc'), serverId = serviceId ? undefined : id('srv');
    if (!serviceId && !serverId) return '';
    const s = replay(db, orgId, { serviceId, serverId, at: new Date(nowMs).toISOString() }, nowMs);
    return `\n\nUnit7's replay of the last ten minutes (its own records; the cause comes from fixed rules, check it):\n${s.aiContext}`;
  } catch { return ''; }
}
