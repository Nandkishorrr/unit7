// "Help, something's wrong": the one button for a bad moment. It stops automatic changes, takes a safety copy, checks everything, and
// says what's broken and the first step, with a message for your customers ready to send. Then the person is in charge.
import { z } from 'zod';
import { all, get, json, now, run, type DB } from '../db.ts';
import { defineTool, execute } from '../tools/runtime.ts';
import { requireHuman } from '../tools/helpers.ts';
import type { Checkup, Item } from './checkup.ts';

// (pure) a calm message for customers. It says nothing about cause until there's one to say.
export function customerMessage(name: string, down: string[]) {
  return `We’re looking into a problem with ${down.length ? down.slice(0, 2).join(' and ') : name}. Some things may not work as they should. Your data is safe, and we’ll update you as soon as we know more.`;
}
// (pure) the one first step: what's worst, and who can act on it
export function firstStep(items: Item[]): { title: string; why: string; who: string } | undefined {
  const rank = ['critical', 'high', 'medium', 'warning', 'low'], i = [...items].sort((a, b) => rank.indexOf(a.severity) - rank.indexOf(b.severity))[0];
  return i && { title: i.title, why: i.why, who: i.who };
}
const after = (db: DB, orgId: string, hours: number) => all<{ summary: string; actor: string | null; created_at: string }>(db, `SELECT summary, actor, created_at FROM changes WHERE org_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 6`, orgId, new Date(Date.now() - hours * 3600_000).toISOString());

defineTool({
  name: 'help.now', title: 'Help, something’s wrong', risk: 'write', action: 'policy_change', peopleOnly: true, timeoutMs: 15 * 60_000,
  description: 'People only. The panic button: pause everything automatic, take a safety copy, check everything, and show what’s broken, the first step, what changed recently, and a message for customers. Nothing is changed except pausing automatic steps.',
  input: z.object({}),
  async run(ctx) {
    requireHuman(ctx, 'press this');
    const done: string[] = [], was = get<{ paused_at: string | null }>(ctx.db, 'SELECT paused_at FROM orgs WHERE id = ?', ctx.orgId)?.paused_at;
    if (!was) { run(ctx.db, 'UPDATE orgs SET paused_at = ? WHERE id = ?', now(), ctx.orgId); ctx.emit('autopilot.paused', `${ctx.actor.name} pressed Help: automatic changes are paused`, { severity: 'warning' }); done.push('Paused everything automatic.'); }
    ctx.progress('Taking a safety copy…');
    const copy = await execute(ctx.app, ctx.orgId, ctx.actor, 'safety.copy', { reason: 'pressed Help' }, { reason: 'pressed Help', signal: ctx.signal });
    const copied = copy.status === 'ok' ? (copy.output as { copied: string[]; failed: { name: string }[] }) : undefined;
    done.push(copied?.copied.length ? `Made a safety copy of ${copied.copied.join(', ')}.` : 'No safety copy was needed, or none could be made.');
    ctx.progress('Checking everything…');
    const check = await execute(ctx.app, ctx.orgId, ctx.actor, 'checkup.run', { quick: false }, { reason: 'pressed Help', signal: ctx.signal });
    const c = check.status === 'ok' ? check.output as Checkup : undefined, down = all<{ host: string }>(ctx.db, `SELECT host FROM watch WHERE org_id = ? AND kind = 'site' AND status NOT IN ('ok', 'up')`, ctx.orgId).map((r) => r.host);
    return { done, line: c?.line ?? 'The check didn’t finish.', first: c ? firstStep(c.items) : undefined, down, changed: after(ctx.db, ctx.orgId, 24), message: customerMessage(get<{ name: string }>(ctx.db, 'SELECT name FROM orgs WHERE id = ?', ctx.orgId)?.name ?? 'our service', down), ...(c && { checkupId: c.id }), paused: true, next: 'When you’re ready, turn automatic steps back on from Autopilot.' };
  },
});

// --- what did my AI do? --------------------------------------------------------------------------------------------------------
export interface Flight { agent: string; session?: string; from: string; to: string; actions: { id: string; at: string; tool: string; result: string; reason: string | null }[]; undoable: { id: string; summary: string; at: string }[] }
export function flightOf(db: DB, orgId: string, sinceIso: string): Flight[] {
  const rows = all<{ id: string; agent: string | null; actor_name: string; tool: string; result: string; reason: string | null; created_at: string; input: string }>(db, `SELECT id, agent, actor_name, tool, result, reason, created_at, input FROM audit WHERE org_id = ? AND created_at > ? AND risk != 'read' AND actor_kind IN ('agent', 'token') AND actor_id != 'warden' ORDER BY created_at`, orgId, sinceIso);
  const by = new Map<string, Flight>();
  for (const r of rows) {
    const agent = r.agent ?? r.actor_name, conv = json<{ conversationId?: string }>(r.input, {}).conversationId, key = `${agent}|${conv ?? ''}`;
    const f = by.get(key) ?? { agent, ...(conv && { session: conv }), from: r.created_at, to: r.created_at, actions: [], undoable: [] };
    f.to = r.created_at; f.actions.push({ id: r.id, at: r.created_at, tool: r.tool, result: r.result, reason: r.reason }); by.set(key, f);
  }
  const undo = all<{ id: string; summary: string; created_at: string; actor: string | null }>(db, `SELECT id, summary, created_at, actor FROM changes WHERE org_id = ? AND created_at > ? AND status = 'done' AND undone_at IS NULL ORDER BY created_at DESC`, orgId, sinceIso);
  for (const f of by.values()) f.undoable = undo.filter((u) => u.actor === f.agent || (u.actor ?? '').includes(f.agent)).map((u) => ({ id: u.id, summary: u.summary, at: u.created_at }));
  return [...by.values()].sort((a, b) => b.to.localeCompare(a.to));
}
const SINCE = z.string().max(40).optional().describe('From when; last night by default');
const lastNight = () => { const d = new Date(Date.now() - 24 * 3600_000); return d.toISOString(); };
defineTool({
  name: 'ai.flight', title: 'What did my AI do?', risk: 'read', action: 'read',
  description: 'A flight recorder: every change each AI made, by session, in order, with what can be undone. Warden’s own steps are in Activity.',
  input: z.object({ since: SINCE }),
  run: (ctx, i) => ({ since: i.since ?? lastNight(), flights: flightOf(ctx.db, ctx.orgId, i.since ?? lastNight()) }),
});
defineTool({
  name: 'ai.undo_all', title: 'Undo everything an AI did', risk: 'write', action: 'change_undo', peopleOnly: true, timeoutMs: 30 * 60_000,
  description: 'People only. Undo every change an AI made since a time, newest first, each through its own undo. Anything without an undo stays, and is listed. It stops at the first undo that fails.',
  input: z.object({ since: SINCE, agent: z.string().max(100).optional() }),
  async run(ctx, i) {
    requireHuman(ctx, 'undo what an AI did');
    const flights = flightOf(ctx.db, ctx.orgId, i.since ?? lastNight()).filter((f) => !i.agent || f.agent === i.agent), todo = flights.flatMap((f) => f.undoable).sort((a, b) => b.at.localeCompare(a.at));
    const undone: string[] = [];
    for (const u of todo) { const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'change.undo', { changeId: u.id }, { reason: 'undo all', signal: ctx.signal }); if (r.status !== 'ok') return { undone, stoppedAt: u.summary, why: r.status === 'error' ? r.error.message : r.status }; undone.push(u.summary); }
    return { undone, notUndoable: flights.reduce((n, f) => n + f.actions.filter((a) => a.result === 'success').length, 0) - undone.length };
  },
});

// --- automatic incident notes --------------------------------------------------------------------------------------------------
export function notesFor(db: DB, orgId: string, i: { id: string; title: string; severity: string; created_at: string; resolved_at: string | null; root_cause: string | null }) {
  const to = i.resolved_at ?? now(), from = new Date(Date.parse(i.created_at) - 30 * 60_000).toISOString();
  const events = all<{ type: string; message: string; created_at: string }>(db, `SELECT type, message, created_at FROM events WHERE org_id = ? AND created_at BETWEEN ? AND ? AND severity IN ('warning', 'critical', 'success') ORDER BY created_at LIMIT 30`, orgId, from, to);
  const changes = all<{ summary: string; actor: string | null; created_at: string }>(db, 'SELECT summary, actor, created_at FROM changes WHERE org_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at', orgId, from, to);
  const mins = i.resolved_at ? Math.round((Date.parse(i.resolved_at) - Date.parse(i.created_at)) / 60_000) : undefined;
  return [`# ${i.title}`, '', `Started ${i.created_at.slice(0, 16).replace('T', ' ')} UTC${mins !== undefined ? `, over in ${mins} minutes` : ', still open'}. Severity: ${i.severity}.`, '', '## Why', i.root_cause ?? 'Unit7 didn’t find a cause for certain.', '',
    '## What happened', ...(events.length ? events.map((e) => `- ${e.created_at.slice(11, 16)} ${e.message.replace(/\n/g, ' ').slice(0, 160)}`) : ['- Nothing else was recorded.']), '', '## What changed', ...(changes.length ? changes.map((c) => `- ${c.created_at.slice(11, 16)} ${c.summary}${c.actor ? ` (${c.actor})` : ''}`) : ['- No change was made. It may have passed by itself.'])].join('\n');
}
export function writeNotes(db: DB, orgId: string) {
  let n = 0;
  for (const i of all<{ id: string; title: string; severity: string; created_at: string; resolved_at: string | null; root_cause: string | null }>(db, `SELECT id, title, severity, created_at, resolved_at, root_cause FROM incidents WHERE org_id = ? AND status = 'resolved' AND notes IS NULL ORDER BY created_at DESC LIMIT 20`, orgId)) { run(db, 'UPDATE incidents SET notes = ? WHERE id = ?', notesFor(db, orgId, i), i.id); n++; }
  return n;
}
defineTool({ name: 'incident.notes', title: 'Notes on past incidents', risk: 'read', action: 'read', description: 'What happened, why, and what fixed it, written by itself when an incident closes.', input: z.object({ limit: z.number().int().min(1).max(50).default(10) }), run(ctx, i) { writeNotes(ctx.db, ctx.orgId); return { incidents: all(ctx.db, `SELECT id, title, severity, created_at at, resolved_at resolvedAt, notes FROM incidents WHERE org_id = ? AND notes IS NOT NULL ORDER BY created_at DESC LIMIT ?`, ctx.orgId, i.limit) }; } });
