// The morning brief: at 09:00 on the person's own clock (after quiet hours, if those run later), three lines to the
// phone and to Activity, and on Home: yesterday (visits, uptime, deploys), what Unit7 fixed overnight, and the one
// decision it needs from you (the oldest waiting approval, else the worst open risk), with a link to it. A quiet day
// is a short brief: "Everything is fine." Uses the watch's settings (a switch, the time zone, quiet hours) and
// scheduling (Warden's minute sweep asks briefDue). Reads the database only; never a secret.
import { blindMs, gapsIn, overlapMs, type Gap } from '../sentinel/gaps.ts';
import type { App } from '../app.ts';
import { all, get, json, type DB } from '../db.ts';
import { getTool, viewInput } from '../tools/runtime.ts';
import { clockAt, inQuiet, saveSettings, settingsOf, type WatchSettings } from '../sentinel/schedule.ts';
import type { Summary } from '../sentinel/traffic.ts';
import { gather, whoOfAudit, Names } from './timeline.ts';

const HOUR = 3600_000, DAY = 86400_000;
export const BRIEF_AT = 9 * 60;      // 09:00 on the person's clock
export const BRIEF_UNTIL = 14 * 60;  // a Unit7 that was off all morning sends no "morning" brief after 14:00

export interface BriefSettings { brief?: boolean; lastBrief?: string }
type S = Pick<WatchSettings, 'quiet' | 'tz'> & BriefSettings;

// --- the person's day, in their time zone ----------------------------------------------------------------------
export function localDate(ms: number, tz?: string): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}
// how far the clock at tz is ahead of UTC at that moment
function offset(ms: number, tz?: string): number {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(ms / 1000) * 1000;
  } catch { return 0; }
}
// the moment a local day starts (YYYY-MM-DD at 00:00 on that clock), daylight saving included
export function dayStart(date: string, tz?: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  const first = guess - offset(guess, tz);
  return guess - offset(first, tz);
}
export function yesterday(now: number, tz?: string): { start: number; end: number; date: string } {
  const end = dayStart(localDate(now, tz), tz);
  const date = localDate(end - HOUR, tz);
  return { start: dayStart(date, tz), end, date };
}

// due once a day, from 09:00 on the person's clock, not during quiet hours, not after 14:00
export function briefDue(s: S, now = Date.now()): boolean {
  if (s.brief === false) return false;
  const tz = s.tz ?? s.quiet?.tz;
  const m = clockAt(now, tz).minutes;
  if (m < BRIEF_AT || m >= BRIEF_UNTIL || inQuiet(s.quiet, now, tz)) return false;
  return !s.lastBrief || localDate(Date.parse(s.lastBrief), tz) !== localDate(now, tz);
}

// --- what goes in it -------------------------------------------------------------------------------------------
export interface BriefStats {
  visitors: number | null; requests: number | null; uptime: number | null; sites: number; sitesDown: string[]; blindHours: number; deploys: number; failed: number;
  fixed: { text: string; n: number }[];
  decision?: { text: string; href: string; kind: 'approval' | 'risk'; more?: number };
  seven?: string; // what Seven last concluded, when it thought about it
}
export interface BriefLine { key: 'yesterday' | 'fixed' | 'decision' | 'fine' | 'blind' | 'seven'; text: string; href?: string }
export interface Brief { day: string; lines: BriefLine[]; fine: boolean; text: string }

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(n)));
const pct = (u: number) => (u >= 0.99995 ? '100%' : u >= 0.999 ? `${(Math.floor(u * 10000) / 100).toFixed(2).replace(/0$/, '')}%` : `${(Math.floor(u * 1000) / 10).toFixed(1)}%`);
const times = (n: number) => (n === 1 ? '' : n === 2 ? ' twice' : ` ${n} times`);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function composeBrief(s: BriefStats, day = ''): Brief {
  const bits = [
    s.visitors != null ? `${k(s.visitors)} visitor${s.visitors === 1 ? '' : 's'}` : s.requests != null && `${k(s.requests)} request${s.requests === 1 ? '' : 's'}`,
    s.uptime != null && (s.sitesDown.length ? `${s.sitesDown.length} of ${s.sites} sites had trouble (${s.sitesDown[0]}${s.sitesDown.length > 1 ? ' and others' : ''})` : `${s.sites === 1 ? 'your site' : `all ${s.sites} sites`} up`),
    s.deploys ? `${s.deploys} deploy${s.deploys === 1 ? '' : 's'}` : 'no deploys',
    s.failed > 0 && `${s.failed} that didn’t work`,
  ].filter(Boolean) as string[];
  const lines: BriefLine[] = [{ key: 'yesterday', text: `Yesterday: ${list(bits)}.` }];
  if (s.blindHours >= 1) lines.push({ key: 'blind', text: `Unit7 wasn’t watching for ${Math.round(s.blindHours)} hour${Math.round(s.blindHours) === 1 ? '' : 's'}, so those hours aren’t counted.` });
  const fine = !s.decision && !s.fixed.length && !s.failed && !s.sitesDown.length;
  if (s.seven) lines.push({ key: 'seven', text: `Seven: ${s.seven}`, href: '/seven' });
  if (fine) lines.push({ key: 'fine', text: 'Everything is fine. Nothing needs you.' });
  else {
    const top = s.fixed.slice(0, 3).map((f) => `${lower(f.text)}${times(f.n)}`);
    const rest = s.fixed.length - top.length;
    lines.push({ key: 'fixed', text: s.fixed.length ? `Overnight Unit7 ${list([...top, ...(rest > 0 ? [`${rest} more thing${rest === 1 ? '' : 's'}`] : [])])}.` : 'Nothing needed fixing overnight.' });
    lines.push(s.decision
      ? { key: 'decision', text: `Needs you: ${s.decision.text.replace(/\.$/, '')}${s.decision.more ? ` (and ${s.decision.more} more)` : ''}.`, href: s.decision.href }
      : { key: 'decision', text: 'No decision needed from you today.' });
  }
  return { day, lines, fine, text: lines.map((l) => l.text).join(' ') };
}

// time each site was down inside [start, end): from each "down" until its "back up" (or the end), never counting the
// hours nobody was watching
export function downtimeBySite(events: { at: number; host: string; down: boolean }[], start: number, end: number, blind: Gap[] = []): Map<string, number> {
  const byHost = new Map<string, { at: number; down: boolean }[]>();
  for (const e of [...events].sort((a, b) => a.at - b.at)) byHost.set(e.host, [...(byHost.get(e.host) ?? []), e]);
  const out = new Map<string, number>();
  const span = (host: string, from: number, to: number) => { const a = Math.max(from, start), b = Math.min(to, end); if (b > a) out.set(host, (out.get(host) ?? 0) + (b - a) - overlapMs(blind, a, b)); };
  for (const [host, evs] of byHost) {
    let downSince: number | undefined;
    for (const e of evs) {
      if (e.down && downSince === undefined) downSince = e.at;
      else if (!e.down && downSince !== undefined) { span(host, downSince, e.at); downSince = undefined; }
    }
    if (downSince !== undefined) span(host, downSince, end);
  }
  return out;
}
export const downtime = (events: { at: number; host: string; down: boolean }[], start: number, end: number, blind: Gap[] = []) => [...downtimeBySite(events, start, end, blind).values()].reduce((a, b) => a + b, 0);

export function briefStats(db: DB, orgId: string, now = Date.now(), tz?: string): BriefStats & { day: string } {
  const y = yesterday(now, tz);
  const iso = (t: number) => new Date(t).toISOString();
  // who came: every traffic check that ended yesterday. Visitors are real browsers, never requests, Unit7's own checks or
  // your apps calling each other; checks from before Unit7 told them apart only give a request count.
  const windows = all<{ summary: string }>(db, 'SELECT summary FROM traffic_windows WHERE org_id = ? AND at >= ? AND at < ?', orgId, iso(y.start), iso(y.end)).map((w) => json<Summary>(w.summary, {} as Summary));
  const requests = windows.length ? windows.reduce((a, w) => a + (w.requests ?? 0), 0) : null;
  const told = windows.filter((w) => w.who);
  const visitors = windows.length && told.length === windows.length ? told.reduce((a, w) => a + (w.who?.visitors ?? 0), 0) : null;
  const blind = gapsIn(db, y.start, y.end), blindTime = blindMs(blind);
  // uptime: the outside checks of every site
  const sites = get<{ n: number }>(db, `SELECT count(*) n FROM watch WHERE org_id = ? AND kind = 'site'`, orgId)!.n;
  const evs = all<{ type: string; resource: string; created_at: string }>(db, `SELECT type, resource, created_at FROM events WHERE org_id = ? AND type IN ('site.down', 'site.recovered') AND created_at < ? AND created_at >= ? ORDER BY created_at`,
    orgId, iso(y.end), iso(y.start - 30 * DAY)).map((e) => ({ at: Date.parse(e.created_at), host: e.resource, down: e.type === 'site.down' }));
  const bySite = downtimeBySite(evs, y.start, y.end, blind);
  const watched = Math.max(1, y.end - y.start - blindTime);
  const uptime = sites ? Math.max(0, 1 - [...bySite.values()].reduce((a, b) => a + b, 0) / (sites * watched)) : null;
  const sitesDown = [...bySite].filter(([, ms]) => ms >= 5 * 60_000).sort((a, b) => b[1] - a[1]).map(([host]) => host);
  const n = new Names(db, orgId);
  const day = gather(db, orgId, {}, iso(y.start), iso(y.end - 1), n).items;
  const deployLike = day.filter((it) => it.kind === 'deploy' && !it.id.startsWith('xr:'));
  // what Unit7 and Warden fixed since yesterday evening
  const night = gather(db, orgId, {}, iso(y.end - 6 * HOUR), iso(now), n).items.filter((it) => (it.who.kind === 'warden' || it.who.kind === 'unit7' || it.who.name === 'Seven') && it.status !== 'failed' && it.kind !== 'approval' && it.kind !== 'found');
  const fixed = new Map<string, number>();
  for (const it of [...night].reverse()) fixed.set(it.text, (fixed.get(it.text) ?? 0) + 1);
  return { day: y.date, visitors, requests, uptime, sites, sitesDown, blindHours: blindTime / HOUR, deploys: deployLike.filter((d) => d.status !== 'failed').length, failed: deployLike.filter((d) => d.status === 'failed').length,
    fixed: [...fixed].map(([text, c]) => ({ text, n: c })), ...decision(db, orgId, now, n), ...seven(db, orgId, iso(y.end - 6 * HOUR)) };
}

// the last time Seven really thought about things, only if it found something to say
const seven = (db: DB, orgId: string, since: string) => { const r = get<{ line: string }>(db, `SELECT line FROM seven_shifts WHERE org_id = ? AND status = 'done' AND brain != 'rules' AND level != 'calm' AND started_at > ? ORDER BY started_at DESC LIMIT 1`, orgId, since); return r ? { seven: r.line.replace(/\.$/, '') + '.' } : {}; };
const SEV = ['critical', 'high', 'warning', 'medium'];
function decision(db: DB, orgId: string, now: number, n: Names): { decision?: BriefStats['decision'] } {
  const waiting = all<{ tool: string; input: string; actor: string }>(db, `SELECT tool, input, actor FROM approvals WHERE org_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at`, orgId, new Date(now).toISOString());
  if (waiting.length) {
    const a = waiting[0]!, i = viewInput(a.input) as Record<string, unknown>;
    const actor = json<{ kind?: string; id?: string | null; name?: string; agent?: string }>(a.actor, {});
    const who = whoOfAudit({ actor_kind: actor.kind ?? 'user', actor_id: actor.id ?? null, actor_name: actor.name ?? 'Someone', agent: actor.agent ?? null }).name;
    const what = (getTool(a.tool)?.title ?? a.tool).replace(/^\w/, (c) => c.toLowerCase());
    const target = n.svc(i.serviceId) ?? n.srv(i.serverId);
    return { decision: { kind: 'approval', text: `${who} wants to ${what}${target ? ` (${target})` : ''}`, href: '/approvals', ...(waiting.length > 1 && { more: waiting.length - 1 }) } };
  }
  const risk = all<{ server_id: string; severity: string; title: string }>(db, `SELECT server_id, severity, title FROM watch_alerts WHERE org_id = ? AND cleared_at IS NULL AND severity IN ('critical', 'high')`, orgId)
    .sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity))[0];
  if (risk) return { decision: { kind: 'risk', text: `${n.srv(risk.server_id) ?? 'A server'}: ${risk.title}`, href: `/servers/${risk.server_id}` } };
  const down = get<{ host: string; detail: string | null }>(db, `SELECT host, detail FROM watch WHERE org_id = ? AND kind = 'site' AND status = 'down' ORDER BY checked_at LIMIT 1`, orgId);
  if (down) return { decision: { kind: 'risk', text: `${down.host} is down${down.detail ? ` (${down.detail})` : ''}`, href: '/map' } };
  return {};
}

export function brief(db: DB, orgId: string, now = Date.now()): Brief & { on: boolean; sentAt: string | null; empty: boolean } {
  const w = settingsOf(db, orgId);
  const tz = w.tz ?? w.quiet?.tz;
  const s = briefStats(db, orgId, now, tz);
  return { ...composeBrief(s, s.day), on: w.brief !== false, sentAt: w.lastBrief ?? null, empty: !hasAnything(db, orgId) };
}

// --- sending it --------------------------------------------------------------------------------------------------
// something to report on: a server, an app, or a site Unit7 watches
const hasAnything = (db: DB, orgId: string) => !!get(db, `SELECT 1 WHERE EXISTS (SELECT 1 FROM servers WHERE org_id = ?) OR EXISTS (SELECT 1 FROM services WHERE org_id = ?) OR EXISTS (SELECT 1 FROM watch WHERE org_id = ? AND kind = 'site')`, orgId, orgId, orgId);
export function sendBrief(app: App, orgId: string, now = Date.now()) {
  const b = brief(app.db, orgId, now);
  saveSettings(app.db, orgId, { lastBrief: new Date(now).toISOString() });
  // one line each on the phone (Activity shows them as one paragraph)
  app.events.emit(orgId, 'story.brief', b.lines.map((l) => l.text).join('\n'), { severity: 'info', data: { day: b.day, lines: b.lines, fine: b.fine } });
  return b;
}
export function briefTick(app: App, busy: Set<string> = new Set(), now = Date.now()) {
  for (const o of all<{ id: string }>(app.db, 'SELECT id FROM orgs')) {
    const key = `brief:${o.id}`;
    if (busy.has(key) || !briefDue(settingsOf(app.db, o.id), now) || !hasAnything(app.db, o.id)) continue;
    busy.add(key);
    try { sendBrief(app, o.id, now); } catch (e) { console.error('morning brief:', (e as Error).message); } finally { busy.delete(key); }
  }
}
