// Conversations with the agent: stored messages, live streaming, start/stop. Messages are pushed as
// events (type agent.message / agent.done) so the web UI follows along in real time.
import { z } from 'zod';
import type { App } from '../app.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import type { Principal } from '../auth.ts';
import { actorOf } from '../auth.ts';
import { runAgent, isRunning as brainRunning, stopAgent, agentStatus, type AgentMessage } from './brain.ts';
import { enqueue, watcherActive, LIVE_TASK, liveTaskArgs, WARDEN } from './bridge.ts';
import { myBrain, runCli } from './subscription.ts';
import { answerByRule, ASKS, INBOX_WAITS, NOTHING_ANSWERS, ruleFor } from './quick.ts';

export function listConversations(app: App, orgId: string, userId: string) {
  // yours, plus the ones Warden opened for incidents (handled by Unit7's model or your own AI)
  return all(app.db, `SELECT id, title, project_id, created_at, updated_at, user_id = 'warden' AS warden FROM conversations WHERE org_id = ? AND (user_id = ? OR user_id = 'warden') ORDER BY updated_at DESC LIMIT 50`, orgId, userId);
}

// Unit7's own model is working on it, or a request is being handled by your AI or waiting for one that's listening (a stale one
// doesn't count). A request nothing can pick up yet isn't work under way: the box stays free, and a key connected now can answer the next ask.
export function isRunning(conversationId: string, app?: App) {
  if (brainRunning(conversationId)) return true;
  const t = app && get<{ status: string; org_id: string; user_id: string }>(app.db, `SELECT status, org_id, user_id FROM agent_tasks WHERE conversation_id = ? AND ${LIVE_TASK} ORDER BY status = 'claimed' DESC LIMIT 1`, conversationId, ...liveTaskArgs());
  return !!t && (t.status === 'claimed' || t.user_id === WARDEN || watcherActive(app!, t.org_id, t.user_id));
}

// A conversation is its person's (plus the ones Warden opened, which everyone in the org can follow).
const mine = (app: App, orgId: string, conversationId: string, userId: string) =>
  get<{ id: string }>(app.db, `SELECT id FROM conversations WHERE id = ? AND org_id = ? AND (user_id = ? OR user_id = 'warden')`, conversationId, orgId, userId);

export function getConversation(app: App, orgId: string, conversationId: string, userId: string) {
  const c = mine(app, orgId, conversationId, userId);
  if (!c) throw new Unit7Error('not_found', 'That conversation was not found.', 404);
  const messages = all<{ id: string; role: string; content: string; created_at: string }>(app.db, 'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', conversationId)
    .map((m) => ({ id: m.id, role: m.role, content: json(m.content, {}), created_at: m.created_at }));
  return { messages, running: isRunning(conversationId, app) };
}

function saveMessage(app: App, conversationId: string, m: AgentMessage) {
  // tool steps update in place (same id); others insert
  run(app.db, `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET content = excluded.content`, m.id, conversationId, m.role, JSON.stringify(m.content), m.created_at);
}

// --- what a chat is about: the servers, apps, domains… the person picked (the @ chips) -----------------------------
export const CONTEXT_KINDS = ['server', 'project', 'app', 'domain', 'database', 'account', 'environment'] as const;
export type ContextKind = typeof CONTEXT_KINDS[number];
export interface ContextItem { kind: ContextKind; id: string; name: string }
export const CONTEXT = z.array(z.object({ kind: z.enum(CONTEXT_KINDS), id: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/), name: z.string().max(300) })).max(12);

// Each id checked against this organisation's own records: one that isn't its is dropped, and the name is the one
// Unit7 has (it goes into the AI's prompt, so never the browser's word for it). Unit7's ids (srv_, prj_, svc_, dom_,
// acc_) and the map's (ast_).
const LOOKUP: Record<string, string> = {
  srv: `SELECT name, 'server' kind FROM servers WHERE id = ? AND org_id = ?`,
  prj: `SELECT name, 'project' kind FROM projects WHERE id = ? AND org_id = ?`,
  svc: `SELECT name, CASE WHEN kind IN ('postgres','mysql','mariadb','mongo','redis') THEN 'database' ELSE 'app' END kind FROM services WHERE id = ? AND org_id = ?`,
  dom: `SELECT hostname name, 'domain' kind FROM domains WHERE id = ? AND org_id = ?`,
  acc: `SELECT name, 'account' kind FROM accounts WHERE id = ? AND org_id = ?`,
  ast: `SELECT name, kind FROM assets WHERE id = ? AND org_id = ?`,
  // a project's environment (the switch on its page): "shop · Staging"
  env: `SELECT p.name || ' · ' || e.name name, 'environment' kind FROM environments e JOIN projects p ON p.id = e.project_id WHERE e.id = ? AND e.org_id = ?`,
};
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f"`\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
export function resolveContext(db: DB, orgId: string, items: { kind: ContextKind; id: string }[]): ContextItem[] {
  const out: ContextItem[] = [];
  for (const c of items) {
    const sql = LOOKUP[c.id.split('_')[0]!];
    const row = sql ? get<{ name: string; kind: string }>(db, sql, c.id, orgId) : undefined;
    if (!row || out.some((x) => x.id === c.id)) continue;
    const kind = (CONTEXT_KINDS as readonly string[]).includes(row.kind) ? row.kind as ContextKind : c.kind; // a map service or job: what the person called it
    out.push({ kind, id: c.id, name: clean(row.name) || c.id });
  }
  return out.slice(0, 12);
}

// everything the conversation's messages were about so far, oldest first (a follow-up keeps the focus)
export function conversationContext(db: DB, conversationId: string): ContextItem[] {
  const seen = new Map<string, ContextItem>();
  for (const m of all<{ content: string }>(db, `SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at, rowid`, conversationId)) {
    for (const c of json<{ context?: ContextItem[] }>(m.content, {}).context ?? []) if (c?.id && !seen.has(c.id)) seen.set(c.id, c);
  }
  return [...seen.values()].slice(-12);
}

// The short, firm line every brain gets first: what to look at, by the ids its tools take.
const PLURAL: Record<ContextKind, string> = { server: 'servers', project: 'projects', app: 'apps', domain: 'domains', database: 'databases', account: 'accounts', environment: 'environments' };
export function focusLine(items: ContextItem[]): string {
  if (!items.length) return '';
  const list = items.map((c) => `${c.kind} "${clean(c.name)}" (id ${c.id})`).join(', ');
  const others = [...new Set(items.map((c) => PLURAL[c.kind]))];
  const or = others.length > 1 ? `${others.slice(0, -1).join(', ')} or ${others.at(-1)}` : others[0];
  return `Focus on: ${list}. Use these ids. Look only at ${items.length === 1 ? 'this one' : 'these'}; don't scan or change other ${or} unless the person asks.`;
}

// Send a message. If this person turned on their own Claude subscription, that answers. Otherwise, with a model connected,
// Unit7's own agent answers. Without one, your own AI (Claude Code running `/unit7 watch`) answers from the inbox in this same
// thread. With nothing listening either, a fixed rule answers the commonest requests (quick.ts), and anything else says at once
// what it can answer and how to connect an AI. It doesn't wait in the inbox: an AI that turned up later would act on a request the
// person was told hadn't started. inbox: this one should wait, and the caller says so (a fix asked for from a phone alert). context:
// what the person picked for it to be about; every brain gets the focus line for the whole conversation's picks.
export async function sendToAgent(app: App, p: Principal, message: string, conversationId?: string, context: { kind: ContextKind; id: string }[] = [], o: { inbox?: boolean } = {}): Promise<{ conversationId: string; via: 'unit7' | 'your-ai' | 'subscription' | 'rules'; watching?: boolean }> {
  const cli = myBrain(app, p.org.id, p.user.id);
  const status = cli ? undefined : await agentStatus(app, p.org.id);
  let convId = conversationId;
  if (convId) {
    if (!mine(app, p.org.id, convId, p.user.id)) throw new Unit7Error('not_found', 'That conversation was not found.', 404);
    if (isRunning(convId, app)) throw new Unit7Error('busy', 'Still working on this conversation.', 409);
  } else {
    convId = id('cnv');
    run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', convId, p.org.id, p.user.id, message.slice(0, 80));
  }
  const picked = resolveContext(app.db, p.org.id, context);
  const userMsg: AgentMessage = { id: id('msg'), role: 'user', content: { text: message, ...(picked.length && { context: picked }) }, created_at: now() };
  saveMessage(app, convId, userMsg);
  const focus = focusLine(conversationContext(app.db, convId));
  const emit = (m: AgentMessage) => { saveMessage(app, convId!, m); app.events.emit(p.org.id, 'agent.message', '', { live: true, data: { conversationId: convId, message: m } }); };
  if (cli) {
    void runCli({ app, p, cli, conversationId: convId, message, emit, focus }).catch((e) => console.error('subscription run failed', e));
    return { conversationId: convId, via: 'subscription' };
  }
  if (!status!.ready) {
    const watching = watcherActive(app, p.org.id, p.user.id); // ask before enqueue wakes (and so un-registers) the watcher
    if (watching || o.inbox) {
      enqueue(app, p.org.id, convId, focus ? `${focus}\n\n${message}` : message, p.user.id); // your own AI reads the focus first too
      if (!watching) {
        emit({ id: id('msg'), role: 'status', content: { tone: 'info', text: INBOX_WAITS, brain: true }, created_at: now() });
        app.events.emit(p.org.id, 'agent.done', 'Nothing to answer it yet', { live: true, data: { conversationId: convId } });
      }
      return { conversationId: convId, via: 'your-ai', watching };
    }
    const rule = ruleFor(message);
    if (rule) {
      void answerByRule({ app, p, rule, conversationId: convId, context: conversationContext(app.db, convId), emit }).catch((e) => console.error('ask box rule failed', e));
      return { conversationId: convId, via: 'rules' };
    }
    emit({ id: id('msg'), role: 'status', content: { tone: 'info', text: NOTHING_ANSWERS, brain: true, asks: ASKS }, created_at: now() });
    app.events.emit(p.org.id, 'agent.done', 'Nothing to answer it yet', { live: true, data: { conversationId: convId } });
    return { conversationId: convId, via: 'rules', watching };
  }
  // run in the background; the caller returns immediately and the UI streams via SSE
  void runAgent({ app, orgId: p.org.id, actor: actorOf(p, 'Unit7 agent'), conversationId: convId, message, emit, principal: p, focus }).catch((e) => console.error('agent run failed', e));
  return { conversationId: convId, via: 'unit7' };
}

export { stopAgent, agentStatus };
