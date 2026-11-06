// When Unit7 wasn't watching. It runs on a computer that can sleep or lose its connection, and every number it shows
// has to say so: Warden stamps "alive" each sweep, and a stamp older than BLIND_AFTER means nobody watched in between.
// Those hours are kept, left out of uptime, and said out loud in the brief. One row per gap; nothing tenant-owned.
import { all, get, run, type DB } from '../db.ts';

export const BLIND_AFTER = 10 * 60_000;
export interface Gap { from: number; to: number }

export function noteAlive(db: DB, nowMs = Date.now()): Gap | undefined {
  const last = get<{ value: string }>(db, `SELECT value FROM instance WHERE key = 'alive_at'`)?.value;
  const at = last ? Date.parse(last) : NaN, gap = Number.isFinite(at) && nowMs - at > BLIND_AFTER ? { from: at, to: nowMs } : undefined;
  if (gap) run(db, 'INSERT INTO watch_gaps (from_at, to_at) VALUES (?, ?)', new Date(at).toISOString(), new Date(nowMs).toISOString());
  run(db, `INSERT INTO instance (key, value) VALUES ('alive_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, new Date(nowMs).toISOString());
  run(db, 'DELETE FROM watch_gaps WHERE to_at < ?', new Date(nowMs - 40 * 86400_000).toISOString());
  return gap;
}

// the gaps inside [from, to), cut to that range
export function gapsIn(db: DB, from: number, to: number): Gap[] {
  return all<{ from_at: string; to_at: string }>(db, 'SELECT from_at, to_at FROM watch_gaps WHERE to_at > ? AND from_at < ? ORDER BY from_at', new Date(from).toISOString(), new Date(to).toISOString())
    .map((g) => ({ from: Math.max(from, Date.parse(g.from_at)), to: Math.min(to, Date.parse(g.to_at)) }));
}
export const blindMs = (gaps: Gap[]) => gaps.reduce((n, g) => n + Math.max(0, g.to - g.from), 0);
// how much of [from, to) falls inside a gap
export const overlapMs = (gaps: Gap[], from: number, to: number) => gaps.reduce((n, g) => n + Math.max(0, Math.min(g.to, to) - Math.max(g.from, from)), 0);
