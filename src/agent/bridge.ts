// The bridge: use your own Claude Code as Unit7's brain, over MCP, with no API key and no Claude login.
//
// You type a request in Unit7's web UI. With no model connected, Unit7 doesn't try to think — it puts
// the request in an inbox. A Claude Code session running `/unit7 watch` pulls it (unit7.inbox_next),
// does the work with Unit7's tools, and streams its narration back (unit7.say) into the same web-UI
// thread. Claude Code is just acting normally over MCP; Unit7 holds the credentials and runs the real
// actions, so the AI never sees a secret and your Claude account is never driven directly.
//
// One person, one subscription: a watcher only answers requests from the person whose Claude Code it is
// (and Warden's incidents on that org's own infrastructure). A teammate's request waits for their own
// watcher. That keeps every Claude subscription doing its owner's own work, as Anthropic's terms require.
import type { App } from '../app.ts';
import { all, get, id, json, now, run, tx } from '../db.ts';
import { cleanNext, splitNext } from './next.ts';

export interface Task { id: string; conversationId: string; message: string }
export const WARDEN = 'warden'; // requests Warden raises for incidents

// in-process: wake long-polling `inbox_next` calls the moment a task they may take is queued
interface Waiter { userId: string; wake: () => void }
const waiters = new Map<string, Waiter[]>(); // orgId -> waiting watchers
function wake(orgId: string, forUser: string) {
  const list = waiters.get(orgId) ?? [];
  const hit = list.filter((w) => forUser === WARDEN || w.userId === forUser);
  waiters.set(orgId, list.filter((w) => !hit.includes(w)));
  hit.forEach((w) => w.wake());
}
function sleep(orgId: string, userId: string, ms: number) {
  return new Promise<void>((resolve) => {
    const w: Waiter = { userId, wake: () => { clearTimeout(t); resolve(); } };
    const t = setTimeout(() => { waiters.set(orgId, (waiters.get(orgId) ?? []).filter((x) => x !== w)); resolve(); }, ms);
    waiters.set(orgId, [...(waiters.get(orgId) ?? []), w]);
  });
}

// Put a request in the inbox. The conversation already holds the user's message.
export function enqueue(app: App, orgId: string, conversationId: string, message: string, userId: string): string {
  const taskId = id('task');
  run(app.db, 'INSERT INTO agent_tasks (id, org_id, conversation_id, message, user_id) VALUES (?, ?, ?, ?, ?)', taskId, orgId, conversationId, message, userId);
  wake(orgId, userId);
  app.events.emit(orgId, 'agent.queued', 'Waiting for your AI', { live: true, data: { conversationId } });
  return taskId;
}

export function pendingCount(app: App, orgId: string, userId: string) {
  tidyTasks(app, orgId);
  return get<{ n: number }>(app.db, `SELECT count(*) n FROM agent_tasks WHERE org_id = ? AND status = 'pending' AND user_id IN (?, ?)`, orgId, userId, WARDEN)!.n;
}

// A watcher that died mid-request never says it's done: a claim older than this goes back to the inbox for the
// next watcher, and a request nobody took in a day is dropped (both would keep the conversation "busy" forever).
export const CLAIM_STALE_MS = 30 * 60_000, PENDING_STALE_MS = 86400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
export function tidyTasks(app: App, orgId: string) {
  run(app.db, `UPDATE agent_tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE org_id = ? AND status = 'claimed' AND claimed_at < ?`, orgId, ago(CLAIM_STALE_MS));
  run(app.db, `UPDATE agent_tasks SET status = 'expired', done_at = ? WHERE org_id = ? AND status = 'pending' AND created_at < ?`, now(), orgId, ago(PENDING_STALE_MS));
}
// the tasks that still count: waiting less than a day, or claimed less than 30 minutes ago
export const LIVE_TASK = `((status = 'pending' AND created_at > ?) OR (status = 'claimed' AND claimed_at > ?))`;
export const liveTaskArgs = () => [ago(PENDING_STALE_MS), ago(CLAIM_STALE_MS)];

// Claim the oldest pending task this person may take (atomic). Returns it, or undefined.
function claim(app: App, orgId: string, userId: string): Task | undefined {
  tidyTasks(app, orgId);
  return tx(app.db, () => {
    const t = get<{ id: string; conversation_id: string; message: string }>(app.db,
      `SELECT id, conversation_id, message FROM agent_tasks WHERE org_id = ? AND status = 'pending' AND user_id IN (?, ?) ORDER BY created_at LIMIT 1`, orgId, userId, WARDEN);
    if (!t) return undefined;
    run(app.db, `UPDATE agent_tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ?`, userId, now(), t.id);
    return { id: t.id, conversationId: t.conversation_id, message: t.message };
  });
}

// Pull the next request. Long-polls up to `waitMs` (under Claude Code's ~5 min HTTP idle timeout and
// Node's 5 min request timeout) so a watch loop makes few empty calls.
const lastPoll = new Map<string, number>(); // between two polls a watcher isn't waiting, but it's still there
export async function nextTask(app: App, orgId: string, userId: string, waitMs = 240_000): Promise<Task | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const t = claim(app, orgId, userId);
    if (t) { app.events.emit(orgId, 'agent.claimed', 'Your AI picked it up', { live: true, data: { conversationId: t.conversationId } }); return t; }
    const left = deadline - Date.now();
    if (left <= 0) { lastPoll.set(`${orgId}:${userId}`, Date.now()); return undefined; }
    await sleep(orgId, userId, left);
  }
}

// Post a message from the brain into a conversation (narration or the final answer). Shows live in the
// web UI. `final` closes the request. Only into conversations this watcher may answer.
// `next`: up to 3 replies the person would likely type next (or a hidden `<<next: …>>` line in the text, which never
// shows): untrusted, cleaned, kept on the message for the ask box.
export function say(app: App, orgId: string, userId: string, conversationId: string, text: string, final: boolean, next?: unknown): boolean {
  const conv = get<{ user_id: string }>(app.db, 'SELECT user_id FROM conversations WHERE id = ? AND org_id = ?', conversationId, orgId);
  if (!conv || (conv.user_id !== userId && conv.user_id !== WARDEN)) return false;
  const s = splitNext(text);
  const options = cleanNext(next) ?? s.next;
  if (s.text.trim()) {
    const msg = { id: id('msg'), role: 'assistant', content: { text: s.text, ...(options && { next: options }) }, created_at: now() };
    run(app.db, `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`, msg.id, conversationId, msg.role, JSON.stringify(msg.content), msg.created_at);
    app.events.emit(orgId, 'agent.message', '', { live: true, data: { conversationId, message: msg } });
  } else if (options) { // only the options: they go on what it said last
    const prev = get<{ id: string; content: string; created_at: string }>(app.db, `SELECT id, content, created_at FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1`, conversationId);
    if (prev) {
      const msg = { id: prev.id, role: 'assistant', content: { ...json<object>(prev.content, {}), next: options }, created_at: prev.created_at };
      run(app.db, 'UPDATE messages SET content = ? WHERE id = ?', JSON.stringify(msg.content), prev.id);
      app.events.emit(orgId, 'agent.message', '', { live: true, data: { conversationId, message: msg } });
    }
  }
  run(app.db, 'UPDATE conversations SET updated_at = ? WHERE id = ?', now(), conversationId);
  if (final) {
    run(app.db, `UPDATE agent_tasks SET status = 'done', done_at = ? WHERE conversation_id = ? AND status != 'done'`, now(), conversationId);
    app.events.emit(orgId, 'agent.done', 'Your AI finished', { live: true, data: { conversationId } });
  }
  return true;
}

// Is this person's watcher connected? (waiting right now, between two polls, or took a request in the last 5 minutes)
export function watcherActive(app: App, orgId: string, userId: string): boolean {
  if ((waiters.get(orgId) ?? []).some((w) => w.userId === userId)) return true;
  if (Date.now() - (lastPoll.get(`${orgId}:${userId}`) ?? 0) < 60_000) return true;
  const r = get<{ claimed_at: string }>(app.db, `SELECT claimed_at FROM agent_tasks WHERE org_id = ? AND claimed_by = ? ORDER BY claimed_at DESC LIMIT 1`, orgId, userId);
  return !!r && Date.now() - Date.parse(r.claimed_at) < 300_000;
}

export const inbox = (app: App, orgId: string, userId: string) =>
  all<Task & { status: string }>(app.db, `SELECT id, conversation_id as conversationId, message, status FROM agent_tasks WHERE org_id = ? AND user_id IN (?, ?) ORDER BY created_at DESC LIMIT 20`, orgId, userId, WARDEN);

// While a watcher holds one of Seven's shifts it may only look, whatever key its session has: that brief came from logs and apps.
export const SHIFT_TITLE = 'Seven’s shift';
export const onShift = (app: App, orgId: string, userId: string) => !!get(app.db, `SELECT 1 FROM agent_tasks t JOIN conversations c ON c.id = t.conversation_id WHERE t.org_id = ? AND t.claimed_by = ? AND t.status = 'claimed' AND t.claimed_at > ? AND c.title = ?`, orgId, userId, ago(CLAIM_STALE_MS), SHIFT_TITLE);

// Is anyone's AI listening in this org (waiting now, or took a request in the last 5 minutes)?
export function anyWatcher(app: App, orgId: string): boolean {
  if ((waiters.get(orgId) ?? []).length) return true;
  const r = get<{ claimed_at: string }>(app.db, `SELECT claimed_at FROM agent_tasks WHERE org_id = ? AND claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 1`, orgId);
  return !!r && Date.now() - Date.parse(r.claimed_at) < 300_000;
}
