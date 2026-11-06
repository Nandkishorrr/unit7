// Right or Wrong: one tap on any finding. "Right 14 of 17 here" is the only honest confidence number, because it comes from what
// actually happened on this server. A "Wrong" also teaches: that kind of finding stops acting by itself. And a fix that's been
// proven can be learned: "Do this by itself next time?"
import { z } from 'zod';
import { all, get, now, run, type DB } from '../db.ts';
import { defineTool } from '../tools/runtime.ts';
import { requireHuman } from '../tools/helpers.ts';
import { kindOf } from '../explain.ts';
import { tierOf } from '../policy.ts';
import { getTool } from '../tools/runtime.ts';
import { Unit7Error } from '../errors.ts';

export function statsOf(db: DB, orgId: string) {
  const rows = all<{ kind: string; was_right: number; n: number }>(db, 'SELECT kind, sum(was_right) was_right, count(*) n FROM judgements WHERE org_id = ? GROUP BY kind', orgId);
  const total = rows.reduce((a, r) => ({ right: a.right + r.was_right, n: a.n + r.n }), { right: 0, n: 0 });
  return { total, kinds: rows.map((r) => ({ kind: r.kind, right: r.was_right, of: r.n })), line: total.n ? `Right ${total.right} of ${total.n} here` : undefined };
}
export const toldWrong = (db: DB, orgId: string, key: string) => !!get(db, 'SELECT 1 FROM judgements WHERE org_id = ? AND key = ? AND was_right = 0', orgId, key);
// this kind has been called wrong more often than right: it may suggest, and it doesn't act by itself
export function distrusted(db: DB, orgId: string, id: string) {
  const r = get<{ was_right: number | null; n: number }>(db, 'SELECT sum(was_right) was_right, count(*) n FROM judgements WHERE org_id = ? AND kind = ?', orgId, kindOf(id));
  return !!r && r.n >= 2 && (r.was_right ?? 0) * 2 < r.n;
}
defineTool({
  name: 'finding.judge', title: 'Say whether a finding was right', risk: 'write', action: 'memory', peopleOnly: true,
  description: 'People only. Right or Wrong on a finding. Wrong hides it, and that kind stops acting by itself here if it keeps being wrong. This is the only confidence number Unit7 shows: what it got right on this server.',
  input: z.object({ key: z.string().min(3).max(300), right: z.boolean(), why: z.string().max(200).optional() }),
  run(ctx, i) {
    run(ctx.db, `INSERT INTO judgements (org_id, key, kind, was_right, why, by, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, key) DO UPDATE SET was_right = excluded.was_right, why = excluded.why, by = excluded.by, at = excluded.at`, ctx.orgId, i.key, kindOf(i.key), i.right ? 1 : 0, i.why ?? null, ctx.actor.name, now());
    return statsOf(ctx.db, ctx.orgId);
  },
});

export const playbookFor = (db: DB, orgId: string, findingId: string, tool: string) => !!get(db, 'SELECT 1 FROM playbooks WHERE org_id = ? AND kind = ? AND tool = ?', orgId, kindOf(findingId), tool);
// green and yellow only: anything that can lose data, or spend money, always waits for a person
export function learnable(tool: string) {
  const t = getTool(tool);
  if (!t) return false;
  const risk = typeof t.risk === 'string' ? t.risk : undefined, action = typeof t.action === 'string' ? t.action : undefined;
  return !!risk && !!action && risk !== 'destructive' && tierOf(action, risk) <= 2;
}
defineTool({
  name: 'playbook.learn', title: 'Do this by itself next time', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'People only. After a fix worked: let Unit7 use that same fix by itself next time this kind of problem appears. Only for fixes that can’t lose data or spend money, and still inside your autonomy level, limits and rules.',
  input: z.object({ finding: z.string().min(3).max(300), tool: z.string().max(80), on: z.boolean().default(true) }),
  run(ctx, i) {
    requireHuman(ctx, 'teach Unit7 a playbook');
    if (i.on && !learnable(i.tool)) throw new Unit7Error('too_risky', 'That fix can lose data or cost money, so it always waits for a person.', 409);
    if (i.on) run(ctx.db, 'INSERT OR REPLACE INTO playbooks (org_id, kind, tool, by, at) VALUES (?, ?, ?, ?, ?)', ctx.orgId, kindOf(i.finding), i.tool, ctx.actor.name, now());
    else run(ctx.db, 'DELETE FROM playbooks WHERE org_id = ? AND kind = ? AND tool = ?', ctx.orgId, kindOf(i.finding), i.tool);
    return { kind: kindOf(i.finding), tool: i.tool, on: i.on };
  },
});
defineTool({ name: 'playbook.list', title: 'What Unit7 learned to do', risk: 'read', action: 'read', description: 'Fixes a person told Unit7 to do by itself next time.', input: z.object({}), run: (ctx) => ({ playbooks: all(ctx.db, 'SELECT kind, tool, by, at FROM playbooks WHERE org_id = ? ORDER BY at DESC', ctx.orgId), ...statsOf(ctx.db, ctx.orgId) }) });
