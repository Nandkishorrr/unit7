// The Check-up as a tool: for the web app's button, the CLI, an AI over MCP, a routine and Warden's own schedule.
import { z } from 'zod';
import { defineTool } from './runtime.ts';
import { all, get, json } from '../db.ts';
import { fid } from './helpers.ts';
import { notFound } from '../errors.ts';
import { compareCheckups, runCheckup, lastCheckup, worthSaying, type Checkup } from '../care/checkup.ts';

defineTool({
  name: 'checkup.run', title: 'Run a Check-up', risk: 'read', action: 'read', timeoutMs: 8 * 60_000,
  description: 'The whole picture in one read-only pass (it reads logs, settings by name and databases, and changes nothing), no AI needed: is there room on each server (RAM, CPU, disk, who uses what, what can be freed), is the data safe (each database’s protection level), is anything open (security), and is the app behaving (traffic, errors). Returns one verdict per area, what to do first and who does it (Unit7, your AI or only you), what can be reduced, what changed since last time, and what it could not check. Use this first for "is everything OK?" or "how is my server?". quick uses what Unit7 already has.',
  input: z.object({ quick: z.boolean().default(false), serverId: fid('srv').optional() }),
  async run(ctx, i) {
    const c = await runCheckup(ctx, i);
    const say = ctx.actor.kind === 'user' ? [] : worthSaying(c);
    if (say.length) ctx.emit('checkup.found', `Check-up: ${say.length} new serious thing${say.length === 1 ? '' : 's'}: ${say.slice(0, 2).map((x) => x.title).join('; ')}`, { severity: 'warning', data: { id: c.id } });
    return c;
  },
});

defineTool({
  name: 'checkup.compare', title: 'Compare two Check-ups', risk: 'read', action: 'read',
  description: 'Two Check-ups side by side: what was fixed, what’s new, and which areas got better or worse. With one id, compares it with the latest.',
  input: z.object({ a: fid('chk'), b: fid('chk').optional() }),
  run(ctx, i) {
    const read = (id: string) => { const r = json<Checkup | null>(get<{ data: string }>(ctx.db, 'SELECT data FROM checkups WHERE id = ? AND org_id = ?', id, ctx.orgId)?.data, null); if (!r) throw notFound('That Check-up'); return r; };
    return compareCheckups(read(i.a), i.b ? read(i.b) : lastCheckup(ctx.db, ctx.orgId)!);
  },
});

defineTool({
  name: 'checkup.get', title: 'A Check-up’s report', risk: 'read', action: 'read',
  description: 'The latest Check-up (or one by id), plus the history: when each ran and its verdict.',
  input: z.object({ id: fid('chk').optional() }),
  run(ctx, i) {
    const report = i.id ? json<Checkup | null>(get<{ data: string }>(ctx.db, 'SELECT data FROM checkups WHERE id = ? AND org_id = ?', i.id, ctx.orgId)?.data, null) : lastCheckup(ctx.db, ctx.orgId) ?? null;
    if (i.id && !report) throw notFound('That Check-up');
    return { report, history: all(ctx.db, 'SELECT id, created_at at, level, line, by, ms FROM checkups WHERE org_id = ? ORDER BY created_at DESC LIMIT 30', ctx.orgId) };
  },
});
