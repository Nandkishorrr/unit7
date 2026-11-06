// Before the phone buzzes: is this real? From this server's own record, no AI needed. If this kind of alert cleared by itself almost
// every time lately, it says so, and buzzes softly. "Not sure" is an honest answer.
import { all, type DB } from '../db.ts';
import type { Unit7Event } from '../events.ts';

export type Verdict = 'Real' | 'Probably noise' | 'Not sure';
const REAL = new Set(['site.down', 'deployment.failed', 'backup.failed', 'backup.verify_failed', 'service.down', 'safety.failed', 'finding.back', 'domain.expiring']);
const DAY = 86400_000;
// (pure) what a kind's history says
export function fromHistory(rows: { first_at: string; cleared_at: string | null }[]): { verdict: Verdict; line?: string } {
  if (rows.length < 5) return { verdict: 'Not sure' };
  const quick = rows.filter((r) => r.cleared_at && Date.parse(r.cleared_at) - Date.parse(r.first_at) < 3600_000).length;
  if (quick / rows.length >= 0.7) return { verdict: 'Probably noise', line: `This kind cleared by itself ${quick} of the last ${rows.length} times.` };
  if (quick / rows.length <= 0.2) return { verdict: 'Real', line: `This kind rarely clears by itself: ${quick} of the last ${rows.length} times.` };
  return { verdict: 'Not sure' };
}
const kindsOf = (e: Unit7Event) => ((e.data.alerts as { key?: string }[] | undefined) ?? []).map((a) => a.key?.split(':').slice(0, 2).join(':')).filter((k): k is string => !!k);
export function verdictFor(db: DB, e: Unit7Event, nowMs = Date.now()): { verdict: Verdict; line?: string } {
  if (REAL.has(e.type)) return { verdict: 'Real' };
  const key = kindsOf(e)[0];
  if (!key) return { verdict: 'Not sure' };
  return fromHistory(all<{ first_at: string; cleared_at: string | null }>(db, `SELECT first_at, cleared_at FROM watch_alerts WHERE org_id = ? AND key LIKE ? AND first_at > ? AND first_at < ? ORDER BY first_at DESC LIMIT 30`, e.org_id, `${key}%`, new Date(nowMs - 30 * DAY).toISOString(), new Date(nowMs - 3600_000).toISOString()));
}
