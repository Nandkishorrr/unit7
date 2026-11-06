// The Safety Net's controls (src/care/safetynet.ts): what's protected and how well, what counts as important, whether it
// runs, and a copy on demand before something risky. Turning it off or changing what counts is a person's.
import { z } from 'zod';
import { defineTool } from './runtime.ts';
import { all, get, now, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { requireHuman } from './helpers.ts';
import { LEVELS, LEVEL_WORDS, ladderFor, protectionOf, quietHourOf, runLadder, settingsOf, type Guarded } from '../care/safetynet.ts';
import { syncFolders } from './offsite.ts';
import { execute } from './runtime.ts';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

defineTool({
  name: 'safety.status', title: 'What’s protected', risk: 'read', action: 'read',
  description: 'Every database Unit7 can see, how safe each is (unprotected: no copy; weak: copies only on this server; protected: a copy off the server; proven: that copy restored in a test this week), whether it counts as important and why, where its copies are, and what the Safety Net does next. Also whether the Safety Net is on, and where copies go.',
  input: z.object({}),
  run(ctx) {
    const org = get<{ safety_net: number; paused_at: string | null; autonomy: number; offsite: string; backup_folder: string | null }>(ctx.db, 'SELECT safety_net, paused_at, autonomy, offsite, backup_folder FROM orgs WHERE id = ?', ctx.orgId)!;
    const guarded = protectionOf(ctx.db, ctx.orgId);
    const important = guarded.filter((g) => g.important);
    const counts = Object.fromEntries(LEVELS.map((l) => [l, important.filter((g) => g.level === l).length]));
    const servers = [...new Set(guarded.map((g) => g.serverId).filter(Boolean))];
    return {
      on: !!org.safety_net, paused: !!org.paused_at, observe: org.autonomy < 1, settings: settingsOf(ctx.db, ctx.orgId), counts, words: LEVEL_WORDS, guarded,
      quiet: Object.fromEntries(servers.map((s) => [s, quietHourOf(ctx.db, s)])),
      copiesGo: { offServer: org.offsite !== 'off', folder: org.backup_folder, blocked: syncFolders().filter((f) => f.blocked).map((f) => f.name) },
      lastRuns: all<{ name: string; status: string; steps: string; why: string | null; created_at: string }>(ctx.db, 'SELECT name, status, steps, why, created_at FROM safety_runs WHERE org_id = ? ORDER BY created_at DESC LIMIT 8', ctx.orgId),
    };
  },
});

defineTool({
  name: 'safety.settings', title: 'Safety Net settings', risk: 'write', action: 'settings_write', peopleOnly: true,
  description: 'People only. Turn the Safety Net on or off, set busy hours when nothing heavy runs, and turn the daily and weekly Check-ups on or off.',
  input: z.object({ on: z.boolean().optional(), busy: z.object({ from: HHMM, to: HHMM, tz: z.string().max(64).optional() }).nullable().optional(), checkup: z.enum(['on', 'off']).optional() }),
  run(ctx, i) {
    requireHuman(ctx, 'change the Safety Net');
    if (i.on !== undefined) run(ctx.db, 'UPDATE orgs SET safety_net = ? WHERE id = ?', i.on ? 1 : 0, ctx.orgId);
    if (i.busy !== undefined || i.checkup) run(ctx.db, 'UPDATE orgs SET safety = ? WHERE id = ?', JSON.stringify({ ...settingsOf(ctx.db, ctx.orgId), ...(i.busy !== undefined && { busy: i.busy }), ...(i.checkup && { checkup: i.checkup }) }), ctx.orgId);
    return { on: !!get<{ safety_net: number }>(ctx.db, 'SELECT safety_net FROM orgs WHERE id = ?', ctx.orgId)!.safety_net, settings: settingsOf(ctx.db, ctx.orgId) };
  },
});

defineTool({
  name: 'safety.mark', title: 'Say what’s important', risk: 'write', action: 'keep_write', peopleOnly: true,
  description: 'People only. Say that a database counts as important, or doesn’t (key from safety.status), whatever Unit7 worked out. important: null goes back to Unit7’s own judgement.',
  input: z.object({ key: z.string().min(3).max(300), important: z.boolean().nullable() }),
  run(ctx, i) {
    requireHuman(ctx, 'say what’s important');
    if (i.important === null) run(ctx.db, 'DELETE FROM safety_marks WHERE org_id = ? AND key = ?', ctx.orgId, i.key);
    else run(ctx.db, `INSERT INTO safety_marks (org_id, key, important, by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, key) DO UPDATE SET important = excluded.important, by = excluded.by, at = excluded.at`, ctx.orgId, i.key, i.important ? 1 : 0, ctx.actor.name, now());
    return { key: i.key, important: i.important };
  },
});

const find = (ctx: Parameters<NonNullable<ReturnType<typeof defineTool>['run']>>[0], key: string): Guarded => {
  const g = protectionOf(ctx.db, ctx.orgId).find((x) => x.key === key);
  if (!g) throw new Unit7Error('not_found', 'Unit7 doesn’t see that database any more.', 404);
  return g;
};

defineTool({
  name: 'safety.protect', title: 'Protect it now', risk: 'write', action: 'backup', green: true, timeoutMs: 3 * 3600_000,
  description: 'Run the Safety Net’s ladder now for one database (key from safety.status): a copy, the copy off the server, its files and settings, and a test restore. Only creates or copies; the live database isn’t touched.',
  input: z.object({ key: z.string().min(3).max(300) }),
  async run(ctx, i) {
    const g = find(ctx, i.key);
    const steps = ladderFor(g);
    if (!steps.length) return { name: g.name, level: g.level, done: [], note: 'It’s already proven.' };
    return { name: g.name, ...(await runLadder(ctx.app, ctx.orgId, g, (org, tool, input, reason) => execute(ctx.app, org, ctx.actor, tool, input, { reason }))) };
  },
});

defineTool({
  name: 'safety.copy', title: 'Take a fresh copy', risk: 'write', action: 'backup', green: true, timeoutMs: 2 * 3600_000,
  description: 'A fresh copy before something risky: everything important, or one project or server. For an AI about to run a migration, a schema push or a bulk change: call this first. Only creates copies. Returns what was copied, and any database it couldn’t copy.',
  input: z.object({ serverId: z.string().max(40).optional(), project: z.string().max(200).optional(), reason: z.string().max(120).default('before a risky change') }),
  async run(ctx, i) {
    const list = protectionOf(ctx.db, ctx.orgId).filter((g) => g.important && (!i.serverId || g.serverId === i.serverId) && (!i.project || g.project === i.project || g.projectName === i.project));
    const copied: string[] = [], failed: { name: string; why: string }[] = [];
    for (const g of list) {
      const r = g.service ? await execute(ctx.app, ctx.orgId, ctx.actor, 'backup.create', { serviceId: g.service, reason: i.reason }, { reason: i.reason })
        : await execute(ctx.app, ctx.orgId, ctx.actor, 'part.backup', { serverId: g.serverId, part: g.part, reason: i.reason }, { reason: i.reason });
      if (r.status === 'ok') copied.push(g.name); else failed.push({ name: g.name, why: r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : String(r.status) });
    }
    return { copied, failed, ...(!list.length && { note: 'Nothing important matched, so nothing was copied.' }) };
  },
});
