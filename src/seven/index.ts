// Seven as tools: what the page, the CLI and an AI can read, and the few switches a person holds. Starting a look and answering are
// a person's. Everything Seven does by itself runs from Warden's clock (sevenTick).
import { z } from 'zod';
import type { App } from '../app.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { defineTool, hardToUndo } from '../tools/runtime.ts';
import { fid, requireHuman, requireRole } from '../tools/helpers.ts';
import { notFound } from '../errors.ts';
import { quietHourOf } from '../care/safetynet.ts';
import { HANDS, LIMITS } from './hands.ts';
import { SYSTEM } from './prompt.ts';
import { mindFor } from './brain.ts';
import { Finish, ROUND_EVERY, dueTrigger, expireAsks, questionOf, runShift, settingsOf, spentToday, type Briefing, type Finished, type Thought } from './shift.ts';
import { SHIFT_TITLE, WARDEN, anyWatcher, enqueue } from '../agent/bridge.ts';
import { untrusted } from '../agent/escalate.ts';
import './knowledge.ts';
import type { Principal } from '../auth.ts';

export async function sevenTick(app: App, nowMs = Date.now()) {
  for (const o of all<{ id: string }>(app.db, 'SELECT id FROM orgs WHERE paused_at IS NULL')) {
    expireAsks(app.db, o.id);
    const server = get<{ id: string }>(app.db, `SELECT id FROM servers WHERE org_id = ? AND status = 'ready' ORDER BY created_at LIMIT 1`, o.id);
    const t = dueTrigger(app.db, o.id, nowMs, server ? quietHourOf(app.db, server.id, nowMs).calmNow : true);
    if (t) await runShift(app, o.id, t, t.kind === 'event' && anyWatcher(app, o.id) ? { cli: viaWatcher(app, o.id) } : {}).catch((e) => console.error('seven', (e as Error).message));
  }
}

// how a person is told what happens if they say yes
const CHANGE: Record<string, string> = { 'docker.prune': 'Removes old images nothing uses. They rebuild on the next deploy, but a quick rollback to an old version won’t be there.', 'server.tidy_logs': 'Removes old system logs for good. Apps keep running.', 'part.limits': 'Nothing restarts. You can undo it.', 'coolify.memory_cap': 'Nothing restarts. It applies from the next deploy, and you can undo it.', 'part.restart': 'A few seconds of downtime for this app.', 'service.restart': 'A few seconds of downtime for this app.', 'coolify.control': 'A few seconds of downtime for this app.', 'server.close_port': 'The port stops answering the internet. You can open it again.', 'deployment.rollback': 'The app goes back to the version before.', 'domain.protect_email': 'Adds a DNS record. Nothing else changes.', 'coolify.health_check': 'It applies from the next deploy, and you can undo it.', 'shield.block': 'Blocks one address for a while. It lifts by itself.', 'server.swap': 'Adds a swap file. Nothing restarts.' };
export function statusOf(app: App, orgId: string, nowMs = Date.now()) {
  const { db } = app, s = settingsOf(db, orgId);
  const last = get<{ id: string; started_at: string; finished_at: string | null; line: string | null; level: string | null; brain: string; status: string; notes: string }>(db, `SELECT id, started_at, finished_at, line, level, brain, status, notes FROM seven_shifts WHERE org_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1`, orgId);
  const working = !!get(db, `SELECT 1 FROM seven_shifts WHERE org_id = ? AND status = 'running' AND started_at > ?`, orgId, new Date(nowMs - 15 * 60_000).toISOString());
  const asks = all<{ tool: string; input: string; why: string; approval_id: string; created_at: string; asked: string; gate: string | null }>(db, `SELECT a.tool, a.input, a.why, a.approval_id, a.created_at, p.input asked, p.why gate FROM seven_actions a JOIN approvals p ON p.id = a.approval_id WHERE a.org_id = ? AND a.status = 'asked' AND p.status = 'pending' AND p.expires_at > ? ORDER BY a.created_at`, orgId, new Date(nowMs).toISOString())
    .map((a) => ({ approvalId: a.approval_id, question: questionOf(db, orgId, a.tool, json(a.input, {})), why: a.why, change: CHANGE[a.tool], at: a.created_at, confirm: hardToUndo(db, orgId, { tool: a.tool, input: a.asked, why: a.gate }).confirm }));
  const since = new Date(nowMs - 3 * 86400_000).toISOString();
  // what it did, and the copies the Safety Net took: to the person it's all one thing done for them
  const done = [...all<{ tool: string; why: string; status: string; created_at: string; by_who: string }>(db, `SELECT tool, why, status, created_at, by_who FROM seven_actions WHERE org_id = ? AND status IN ('done', 'approved', 'fixed', 'still') AND created_at > ? ORDER BY created_at DESC LIMIT 12`, orgId, since)
    .map((a) => ({ word: HANDS[a.tool]?.word ?? a.tool, why: a.why, status: a.status, at: a.created_at, by: a.by_who })),
    ...all<{ name: string; created_at: string }>(db, `SELECT name, created_at FROM safety_runs WHERE org_id = ? AND status = 'done' AND steps != '[]' AND created_at > ?`, orgId, since).map((r) => ({ word: 'protect', why: `Copied ${r.name} off the server and proved it restores.`, status: 'fixed', at: r.created_at, by: 'rule' }))]
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
  const handed = all<{ because: string; why: string; created_at: string }>(db, `SELECT because, why, created_at FROM seven_actions a WHERE org_id = ? AND kind = 'hand' AND status = 'handed' AND EXISTS (SELECT 1 FROM findings f WHERE f.org_id = a.org_id AND f.key = a.because AND f.status IN ('open', 'still', 'back')) ORDER BY created_at DESC LIMIT 6`, orgId).map((h) => ({ key: h.because, why: h.why, at: h.created_at }));
  return { on: s.on, settings: s, working, line: last?.line ?? undefined, level: last?.level ?? undefined, lastAt: last?.finished_at ?? last?.started_at, nextAt: last ? new Date(Date.parse(last.started_at) + ROUND_EVERY).toISOString() : undefined, notes: json<string[]>(last?.notes, []), brain: last?.brain, spent: spentToday(db, orgId, nowMs), asks, done, handed,
    shifts: all<{ id: string; trigger: string; line: string | null; level: string | null; brain: string; cost: number; started_at: string }>(db, `SELECT id, trigger, line, level, brain, cost, started_at FROM seven_shifts WHERE org_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 14`, orgId),
    notesFromYou: all<{ key: string; value: string }>(db, `SELECT key, value FROM seven_memory WHERE org_id = ? AND kind = 'note' ORDER BY at DESC`, orgId) };
}

defineTool({
  name: 'seven.status', title: 'What Seven is doing', risk: 'read', action: 'read',
  description: 'Seven, the agent on shift: its last verdict, the questions waiting for a yes or no, what it did by itself, what it spent today, and its recent shifts.',
  input: z.object({}),
  async run(ctx) { const mind = await mindFor(ctx.app, ctx.orgId).catch(() => undefined); return { ...statusOf(ctx.app, ctx.orgId), mind: mind ? { label: mind.label } : null, rules: { actsPerShift: LIMITS.actsPerShift, questionsPerDay: settingsOf(ctx.db, ctx.orgId).asks } }; },
});

defineTool({
  name: 'seven.shift', title: 'One of Seven’s shifts', risk: 'read', action: 'read',
  description: 'One shift in full: why it ran, what Seven looked at and thought, what it did, what it asked, and what it dropped.',
  input: z.object({ id: fid('shf') }),
  run(ctx, i) {
    const s = get<Record<string, unknown> & { notes: string; thoughts: string }>(ctx.db, 'SELECT * FROM seven_shifts WHERE id = ? AND org_id = ?', i.id, ctx.orgId);
    if (!s) throw notFound('That shift');
    return { ...s, notes: json(s.notes, []), thoughts: json(s.thoughts, []), actions: all(ctx.db, 'SELECT tool, kind, because, why, expect, status, result, by_who, created_at FROM seven_actions WHERE shift_id = ? ORDER BY created_at', i.id) };
  },
});

defineTool({
  name: 'seven.settings', title: 'Seven’s settings', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'People only. Turn Seven on or off, set its daily AI budget in dollars, how many questions it may ask a day, and whether it may use the web and read code through GitHub. An AI never sets its own limits.',
  input: z.object({ on: z.boolean().optional(), budget: z.number().min(0).max(100).optional(), asks: z.number().int().min(0).max(20).optional(), web: z.boolean().optional(), code: z.boolean().optional() }),
  run(ctx, i) {
    requireHuman(ctx, 'change Seven');
    const next = { ...settingsOf(ctx.db, ctx.orgId), ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) };
    run(ctx.db, 'UPDATE orgs SET seven = ? WHERE id = ?', JSON.stringify(next), ctx.orgId);
    ctx.emit('policy.changed', `${ctx.actor.name} changed Seven’s settings`, { severity: 'info' });
    return next;
  },
});

defineTool({
  name: 'seven.note', title: 'Tell Seven something', risk: 'write', action: 'memory',
  description: 'A note Seven reads every shift, such as what’s normal here or what to leave alone. People add and remove these; remove takes the key.',
  input: z.object({ text: z.string().min(3).max(400).optional(), remove: z.string().max(40).optional() }),
  run(ctx, i) {
    requireHuman(ctx, 'tell Seven something');
    if (i.remove) { run(ctx.db, `DELETE FROM seven_memory WHERE org_id = ? AND key = ? AND kind = 'note'`, ctx.orgId, i.remove); return { removed: i.remove }; }
    const key = `n${Date.now().toString(36)}`;
    run(ctx.db, `INSERT INTO seven_memory (org_id, key, kind, value, at) VALUES (?, ?, 'note', ?, ?)`, ctx.orgId, key, i.text ?? '', now());
    return { key };
  },
});

// a run on the person's own Claude ends by calling this, because that's the only tool besides looking it has
const finishes = new Map<string, Finished>();
const thoughtFrom = (shiftId: string, thoughts: string[] = []): Thought => { const finished = finishes.get(shiftId); finishes.delete(shiftId); return { thoughts, usage: { input: 0, output: 0, cached: 0, written: 0, cost: 0 }, turns: 0, ended: finished ? 'finished' : 'stuck', ...(finished && { finished }) }; };
const WATCH_WAIT = 8 * 60_000;
// With no key, a Claude Code the person left running /unit7 watch can take a shift when something goes wrong, the way it already takes
// Warden's incidents. Never a routine one: a personal subscription doesn't run on a timer (TRUST.md). Its
// session holds the person's full key, so while it has a shift the MCP server limits it to Seven's eyes (onShift), and what strangers
// can write stays out of its brief.
// ponytail: that covers Unit7's tools. The session's own shell stays under the person's Claude Code permissions.
const viaWatcher = (app: App, orgId: string) => async (b: Briefing, task: string, shiftId: string, signal: AbortSignal): Promise<Thought> => {
  const conversationId = id('cnv'), brief = `${SYSTEM}\n\n${untrusted('Unit7’s briefing', b.guarded)}\n\n${task}\n\nYour shift id is ${shiftId}. "finish" is the seven_finish tool: call it once at the end with shift: "${shiftId}". Use read-only tools only, then stop.`;
  run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conversationId, orgId, WARDEN, SHIFT_TITLE);
  run(app.db, `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`, id('msg'), conversationId, JSON.stringify({ text: b.guarded }), now());
  enqueue(app, orgId, conversationId, brief, WARDEN);
  for (const until = Date.now() + (app.services.sevenWatchWait as number | undefined ?? WATCH_WAIT); Date.now() < until && !signal.aborted && !finishes.has(shiftId);) await new Promise((r) => setTimeout(r, 200));
  run(app.db, `UPDATE agent_tasks SET status = 'done', done_at = ? WHERE conversation_id = ? AND status != 'done'`, now(), conversationId); // its key is its own again, and nobody picks up a stale brief
  return thoughtFrom(shiftId);
};
defineTool({
  name: 'seven.finish', title: 'End a shift', risk: 'write', action: 'memory',
  description: 'End the shift with your verdict and proposals. Only for a shift that’s waiting for this.',
  input: Finish.extend({ shift: fid('shf') }),
  run(ctx, i) {
    const { shift, ...f } = i;
    if (!get(ctx.db, `SELECT 1 FROM seven_shifts WHERE id = ? AND org_id = ? AND status = 'running'`, shift, ctx.orgId)) throw notFound('That shift');
    if (finishes.size < 20) finishes.set(shift, f);
    return { ok: true };
  },
});

defineTool({
  name: 'seven.look', title: 'Look now', risk: 'read', action: 'read', timeoutMs: 12 * 60_000,
  description: 'A person asks Seven to look now. It runs a whole shift, with the connected AI, or the person’s own Claude if that’s what’s on.',
  input: z.object({ about: z.string().max(300).optional() }),
  async run(ctx, i) {
    requireHuman(ctx, 'start a shift');
    requireRole(ctx, ['owner', 'admin', 'developer'], 'start a shift'); // it can act, so looking alone isn't enough
    const person: Principal = { user: { id: ctx.actor.userId!, email: '', name: ctx.actor.name }, org: { id: ctx.orgId, name: '', slug: '' }, role: ctx.actor.role, via: 'session' };
    const { myBrain, thinkWithCli } = await import('../agent/subscription.ts');
    const cli = !(await mindFor(ctx.app, ctx.orgId)) && myBrain(ctx.app, ctx.orgId, ctx.actor.userId!);
    return await runShift(ctx.app, ctx.orgId, { kind: 'look', ...(i.about && { why: i.about }) }, { ...(cli && { cli: async (b, task, shiftId, signal): Promise<Thought> => {
      const thoughts: string[] = [];
      await thinkWithCli(ctx.app, person, { system: SYSTEM, prompt: `${b.text}\n\n${task}\n\nYour shift id is ${shiftId}. Your tools are the unit7 ones. "finish" is the seven_finish tool: call it once at the end with shift: "${shiftId}".`, signal, onText: (t) => thoughts.push(t.slice(0, 400)) });
      return thoughtFrom(shiftId, thoughts);
    } }) }) ?? { line: 'A shift is already running.' };
  },
});
