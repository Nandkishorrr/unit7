// The watch's settings per organisation, and its scheduling decisions as pure functions (no timers here:
// Warden's minute sweep asks them).
import { get, json, run, type DB } from '../db.ts';

export interface WatchSettings {
  every: 30 | 60;            // minutes between traffic and log checks
  sampleEvery: number;       // minutes between usage samples
  usage: boolean; traffic: boolean; logs: boolean; findings: boolean; digest: boolean; investigate: boolean;
  quiet?: { from: string; to: string; tz?: string } | null; // "22:00"–"07:00": only critical alerts reach the phone
  tz?: string;               // the person's own clock (IANA name), for quiet hours and the Monday digest
  lastDigest?: string;
  brief?: boolean;           // the morning brief (src/story/brief.ts): 09:00 on the person's clock
  lastBrief?: string;
}
export const DEFAULTS: WatchSettings = { every: 30, sampleEvery: 5, usage: true, traffic: true, logs: true, findings: true, digest: true, investigate: true, quiet: null, brief: true };
export const settingsOf = (db: DB, orgId: string): WatchSettings => ({ ...DEFAULTS, ...json<Partial<WatchSettings>>(get<{ watch: string }>(db, 'SELECT watch FROM orgs WHERE id = ?', orgId)?.watch, {}) });
export function saveSettings(db: DB, orgId: string, patch: Partial<WatchSettings>) {
  const next = { ...settingsOf(db, orgId), ...patch };
  run(db, 'UPDATE orgs SET watch = ? WHERE id = ?', JSON.stringify(next), orgId);
  return next;
}

// minutes since midnight at `tz` (the person's own clock), or UTC
export function clockAt(now: number, tz?: string): { minutes: number; day: number } {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    return { minutes: Number(p.hour) * 60 + Number(p.minute), day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!) };
  } catch { const d = new Date(now); return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.getUTCDay() }; }
}
const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };
// a window that crosses midnight ("22:00"–"07:00") works too
export function inQuiet(q: WatchSettings['quiet'], now = Date.now(), tz?: string): boolean {
  if (!q?.from || !q.to) return false;
  const t = clockAt(now, q.tz ?? tz).minutes, a = mins(q.from), b = mins(q.to);
  return a === b ? false : a < b ? t >= a && t < b : t >= a || t < b;
}

export const quietNow = (db: DB, orgId: string, now = Date.now()) => { const w = settingsOf(db, orgId); return inQuiet(w.quiet, now, w.tz); };

// due when it has never run, or `everyMin` minutes have gone by (a minute early counts: the sweep is coarse)
export const due = (last: string | number | null | undefined, everyMin: number, now = Date.now()) =>
  last == null || !(now - (typeof last === 'number' ? last : Date.parse(last)) < everyMin * 60_000 - 30_000);
// the weekly digest: Monday from 08:00 on the person's clock, once a week
export function digestDue(s: Pick<WatchSettings, 'digest' | 'lastDigest' | 'quiet' | 'tz'>, now = Date.now()): boolean {
  if (!s.digest) return false;
  const c = clockAt(now, s.tz ?? s.quiet?.tz);
  return c.day === 1 && c.minutes >= 8 * 60 && (!s.lastDigest || now - Date.parse(s.lastDigest) > 6 * 86400_000);
}
// one AI investigation per server at a time, at most every 6 hours
export const investigateDue = (last: string | undefined, now = Date.now()) => !last || now - Date.parse(last) > 6 * 3600_000;
