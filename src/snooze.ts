// "This is fine": a person hides a finding, alert or suggestion until tomorrow, for 7 or 15 days, or for good (with an
// optional reason). One table (snoozes), keyed by the item's stable id and the organisation. Past its time an item shows
// again, marked "Back after 7 days: still here". An AI never hides anything (it may suggest it; a person decides).
// Only reads and writes the database, so anything that lists, alerts or suggests can ask here first.
import { all, get, now, run, type DB } from './db.ts';

export const SNOOZE_FOR = { tomorrow: 1, '7d': 7, '15d': 15, forever: 0 } as const;
export type SnoozeFor = keyof typeof SNOOZE_FOR;
export interface SnoozeRow { key: string; until: string | null; reason: string | null; title: string; kind: string; days: number | null; by: string | null; created_at: string; cleared_at: string | null; severity?: string | null }
const DAY = 86400_000;
// a returned item keeps its "back" mark for a week
const BACK_FOR = 7 * DAY;

// tomorrow: the next morning (07:00 UTC) at least 12 hours away; otherwise N days from now
export function untilFor(f: SnoozeFor, nowMs = Date.now()): string | null {
  if (f === 'forever') return null;
  if (f === 'tomorrow') { const d = new Date(nowMs + DAY); d.setUTCHours(7, 0, 0, 0); return new Date(Math.max(d.getTime(), nowMs + 12 * 3600_000)).toISOString(); }
  return new Date(nowMs + SNOOZE_FOR[f] * DAY).toISOString();
}

// severities, worst first (watch alerts, findings, Activity events)
const SEVERITY = ['critical', 'high', 'warning', 'medium', 'low', 'info', 'success'];
const rank = (s?: string | null) => { const n = SEVERITY.indexOf(s ?? ''); return n < 0 ? undefined : n; };
// how serious it is right now, from Unit7's own records: an open watch alert, the latest security check's finding, or the
// latest Activity event of that kind about that thing (never from what a caller says)
export function severityNow(db: DB, orgId: string, key: string): string | undefined {
  const a = all<{ severity: string }>(db, `SELECT severity FROM watch_alerts WHERE org_id = ? AND cleared_at IS NULL AND (CASE WHEN source = 'usage' THEN 'usage:' || server_id || ':' || key ELSE key END) = ?`, orgId, key)
    .map((r) => r.severity).sort((x, y) => (rank(x) ?? 99) - (rank(y) ?? 99))[0];
  if (a) return a;
  const f = get<{ s: string | null }>(db, `SELECT json_extract(j.value, '$.severity') s FROM security_reports r, json_each(r.findings) j WHERE r.org_id = ? AND json_extract(j.value, '$.id') = ? ORDER BY r.created_at DESC LIMIT 1`, orgId, key);
  if (f?.s) return f.s;
  const e = /^event:([^:]+):(.*)$/s.exec(key);
  return e ? get<{ severity: string }>(db, `SELECT severity FROM events WHERE org_id = ? AND type = ? AND coalesce(resource, '') = ? ORDER BY created_at DESC LIMIT 1`, orgId, e[1], e[2])?.severity : undefined;
}

// The key a thing is hidden by: its stable id. Two kinds of id carry a count that moves on its own ("blocked:srv_1:3"
// attackers, "subdomains:example.com:8" unused names); hiding one holds when the count changes.
const COUNTED = /^((?:blocked|subdomains):[^:]+)(?::\d+)+$/;
export const snoozeKeyOf = (key: string) => COUNTED.exec(key)?.[1] ?? key;

export function snooze(db: DB, orgId: string, i: { key: string; for: SnoozeFor; reason?: string; title?: string; kind?: string; by: string; severity?: string }, nowMs = Date.now()) {
  i = { ...i, key: snoozeKeyOf(i.key) };
  const until = untilFor(i.for, nowMs);
  // how serious it was when hidden (Unit7's records first): coming back worse shows it again
  const severity = severityNow(db, orgId, i.key) ?? (rank(i.severity) !== undefined ? i.severity! : null);
  run(db, `INSERT INTO snoozes (org_id, key, until, reason, title, kind, days, by, created_at, cleared_at, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT (org_id, key) DO UPDATE SET until = excluded.until, reason = excluded.reason, title = CASE WHEN excluded.title = '' THEN snoozes.title ELSE excluded.title END,
      kind = CASE WHEN excluded.kind = '' THEN snoozes.kind ELSE excluded.kind END, days = excluded.days, by = excluded.by, created_at = excluded.created_at, cleared_at = NULL, severity = excluded.severity`,
  orgId, i.key, until, i.reason?.trim() || null, i.title ?? '', i.kind ?? '', SNOOZE_FOR[i.for] || null, i.by, new Date(nowMs).toISOString(), severity);
  return { key: i.key, until, forGood: until === null };
}
// still hidden, given how serious it is now: not once it's worse than when it was hidden, and a permanent "This is fine"
// never hides a critical one
export function stillHidden(r: SnoozeRow | undefined, severity?: string | null) {
  if (!r) return false;
  const now = rank(severity), then = rank(r.severity);
  if (now === 0 && r.until === null) return false;
  return !(now !== undefined && then !== undefined && now < then);
}
// the keys hidden right now, each checked against how serious it is now (Unit7's records)
export function hiddenNow(db: DB, orgId: string, nowMs = Date.now()) {
  const { hidden } = snoozeState(db, orgId, nowMs);
  for (const [k, r] of hidden) if (!stillHidden(r, severityNow(db, orgId, k))) hidden.delete(k);
  return hidden;
}
export const WORSE = 'Got worse since you hid it';
export const unsnooze = (db: DB, orgId: string, key: string) => run(db, 'UPDATE snoozes SET cleared_at = ? WHERE org_id = ? AND key IN (?, ?) AND cleared_at IS NULL', now(), orgId, key, snoozeKeyOf(key)).changes > 0;

// what's hidden now, and what came back in the last week (with how long it was away)
export function snoozeState(db: DB, orgId: string, nowMs = Date.now()) {
  const hidden = new Map<string, SnoozeRow>(), back = new Map<string, SnoozeRow>();
  if (!get(db, 'SELECT 1 FROM snoozes WHERE org_id = ? AND cleared_at IS NULL LIMIT 1', orgId)) return { hidden, back };
  for (const r of all<SnoozeRow>(db, 'SELECT * FROM snoozes WHERE org_id = ? AND cleared_at IS NULL', orgId)) {
    const u = r.until ? Date.parse(r.until) : Infinity;
    if (u > nowMs) hidden.set(snoozeKeyOf(r.key), r);
    else if (nowMs - u < BACK_FOR) back.set(snoozeKeyOf(r.key), r);
  }
  return { hidden, back };
}
export const backWords = (r: Pick<SnoozeRow, 'days'>) => `Back after ${r.days === 1 ? 'a day' : `${r.days ?? 7} days`}: still here`;

// a list without what's hidden, each returning one marked "back" (or "got worse", shown again though its time isn't up)
export function visible<T>(db: DB, orgId: string, list: T[], keyOf: (x: T) => string, nowMs = Date.now()): (T & { back?: string })[] {
  const { hidden, back } = snoozeState(db, orgId, nowMs);
  const out = list as (T & { back?: string })[];
  if (!hidden.size && !back.size) return out;
  const sev = (x: T) => { const s = (x as { severity?: unknown }).severity; return typeof s === 'string' && rank(s) !== undefined ? s : severityNow(db, orgId, keyOf(x)); };
  return out.flatMap((x) => {
    const h = hidden.get(snoozeKeyOf(keyOf(x)));
    if (h) { const s = sev(x); return stillHidden(h, s) ? [] : [{ ...x, back: (rank(s) ?? 99) < (rank(h.severity) ?? -1) ? WORSE : 'Serious, so it shows even though it was marked fine' }]; }
    const b = back.get(snoozeKeyOf(keyOf(x))); return [b ? { ...x, back: backWords(b) } : x];
  });
}
// the stable key of a server watch alert: traffic and risks are findings (their own id); usage jumps are per server
export const alertKey = (a: { source: string; key: string; server_id?: string; serverId?: string }) => (a.source === 'usage' ? `usage:${a.server_id ?? a.serverId}:${a.key}` : a.key);
// an Activity row or phone alert: the same kind of event about the same thing
export const eventKey = (e: { type: string; resource?: string | null }) => `event:${e.type}:${e.resource ?? ''}`;
