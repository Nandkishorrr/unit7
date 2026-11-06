// A weekly report card, and a badge that only shows when it's true. Both say what Unit7 measured, nothing more.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { all, get, json, run, type DB } from '../db.ts';
import { defineTool, type Ctx } from '../tools/runtime.ts';
import { briefStats } from '../story/brief.ts';
import { protectionOf } from '../care/safetynet.ts';
import { blindMs, gapsIn } from '../sentinel/gaps.ts';
import { lastCheckup } from '../care/checkup.ts';
import type { Summary } from '../sentinel/traffic.ts';

const DAY = 86400_000;
export interface Card { week: string; protected: { word: string; line: string }; up: { word: string; line: string }; fast: { word: string; line: string }; safe: { word: string; line: string }; streaks: string[]; watched: number; fixed: number }
export const grade = (ok: boolean, some: boolean) => (ok ? 'Good' : some ? 'Fair' : 'Needs work');
export function cardOf(o: { important: number; proven: number; guarded: number; uptime?: number; downDays: number; p95?: number; urgent: number; todo: number; watched: number; fixed: number; week: string; daysSinceDown?: number; daysProven?: number }): Card {
  const streaks = [...(o.daysSinceDown !== undefined && o.daysSinceDown >= 7 ? [`${o.daysSinceDown} days with no downtime`] : []), ...(o.daysProven !== undefined && o.daysProven >= 7 ? [`${o.daysProven} days with every database proven`] : [])];
  return { week: o.week, watched: o.watched, fixed: o.fixed, streaks,
    protected: { word: o.important ? grade(o.proven === o.important, o.guarded === o.important) : 'Not measured', line: o.important ? `${o.proven} of ${o.important} important databases proven this week` : 'No important database found' },
    up: { word: o.uptime === undefined ? 'Not measured' : grade(o.uptime >= 99.9, o.uptime >= 99), line: o.uptime === undefined ? 'No site checks this week' : `${o.uptime}% up over the hours Unit7 was watching` },
    fast: { word: o.p95 === undefined ? 'Not measured' : grade(o.p95 < 500, o.p95 < 1500), line: o.p95 === undefined ? 'No traffic log to read' : `95% of requests answered in under ${o.p95} ms` },
    safe: { word: grade(!o.urgent && !o.todo, !o.urgent), line: o.urgent ? `${o.urgent} urgent thing${o.urgent === 1 ? '' : 's'} open` : o.todo ? `${o.todo} thing${o.todo === 1 ? '' : 's'} worth doing, nothing urgent` : 'Nothing open' } };
}
export function cardNow(db: DB, orgId: string, nowMs = Date.now()) {
  const g = protectionOf(db, orgId, nowMs).filter((x) => x.important), b = briefStats(db, orgId, nowMs), c = lastCheckup(db, orgId), from = nowMs - 7 * DAY;
  const p95s = all<{ summary: string }>(db, `SELECT w.summary FROM traffic_windows w JOIN servers s ON s.id = w.server_id WHERE s.org_id = ? AND w.at > ?`, orgId, new Date(from).toISOString()).map((r) => json<Summary>(r.summary, {} as Summary).p95).filter((x): x is number => !!x).sort((a, c2) => a - c2);
  const lastDown = get<{ at: string | null }>(db, `SELECT max(created_at) at FROM events WHERE org_id = ? AND type = 'site.down'`, orgId)?.at;
  return cardOf({ week: new Date(nowMs).toISOString().slice(0, 10), important: g.length, proven: g.filter((x) => x.level === 'proven').length, guarded: g.filter((x) => x.level === 'proven' || x.level === 'protected').length, ...(b.uptime !== null && b.uptime !== undefined && { uptime: b.uptime }), downDays: 0, ...(p95s.length && { p95: p95s[p95s.length >> 1]! }), urgent: c?.items?.filter((i) => ['critical', 'high'].includes(i.severity)).length ?? 0, todo: c?.items?.filter((i) => ['medium', 'warning'].includes(i.severity)).length ?? 0,
    watched: Math.round(1000 - (blindMs(gapsIn(db, from, nowMs)) / (7 * DAY)) * 1000) / 10, fixed: get<{ n: number }>(db, `SELECT count(*) n FROM findings WHERE org_id = ? AND status = 'fixed' AND checked_at > ?`, orgId, new Date(from).toISOString())?.n ?? 0, ...(lastDown && { daysSinceDown: Math.floor((nowMs - Date.parse(lastDown)) / DAY) }) });
}
export const cardMarkdown = (c: Card) => [`# Weekly report, ${c.week}`, '', `| | | |`, `|---|---|---|`, `| Protected | ${c.protected.word} | ${c.protected.line} |`, `| Up | ${c.up.word} | ${c.up.line} |`, `| Fast | ${c.fast.word} | ${c.fast.line} |`, `| Safe | ${c.safe.word} | ${c.safe.line} |`, '', `Watched ${c.watched}% of the week.${c.fixed ? ` ${c.fixed} problem${c.fixed === 1 ? '' : 's'} fixed and proven.` : ''}`, ...c.streaks.map((s) => `- ${s}`)].join('\n');
defineTool({ name: 'report.card', title: 'Weekly report card', risk: 'read', action: 'read', description: 'One page: Protected, Up, Fast and Safe, with streaks, how much of the week Unit7 watched, and problems proven fixed. Includes Markdown to share with a client.', input: z.object({}), run(ctx) { const c = cardNow(ctx.db, ctx.orgId); return { ...c, markdown: cardMarkdown(c) }; } });

// F12: true right now, or nothing shows
export const allProven = (db: DB, orgId: string) => { const g = protectionOf(db, orgId).filter((x) => x.important); return g.length > 0 && g.every((x) => x.level === 'proven'); };
export const BADGE = '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="20" role="img" aria-label="Protected by Unit7"><rect width="140" height="20" rx="4" fill="#16a34a"/><text x="70" y="14" fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle">Protected by Unit7</text></svg>';
export const NO_BADGE = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
export const badgeOf = (db: DB, token: string) => { const o = get<{ id: string }>(db, 'SELECT id FROM orgs WHERE badge_token = ?', token); return o && allProven(db, o.id) ? BADGE : NO_BADGE; };
defineTool({
  name: 'badge.link', title: 'A “Protected by Unit7” badge', risk: 'write', action: 'memory',
  description: 'A README badge that shows only while every important database is proven, and disappears when that stops being true. It needs Unit7 reachable at a public address.',
  input: z.object({}),
  run(ctx: Ctx) {
    let t = get<{ badge_token: string | null }>(ctx.db, 'SELECT badge_token FROM orgs WHERE id = ?', ctx.orgId)?.badge_token;
    if (!t) { t = randomBytes(16).toString('hex'); run(ctx.db, 'UPDATE orgs SET badge_token = ? WHERE id = ?', t, ctx.orgId); }
    const base = (process.env.UNIT7_URL ?? 'https://your-unit7.example.com').replace(/\/$/, '');
    return { markdown: `![Protected by Unit7](${base}/badge/${t}.svg)`, showing: allProven(ctx.db, ctx.orgId), ...(!process.env.UNIT7_URL && { note: 'Unit7 needs a public address for this to show anywhere else.' }) };
  },
});
