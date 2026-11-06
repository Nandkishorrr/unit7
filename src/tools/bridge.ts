// The three tools your Claude Code uses to be Unit7's brain (see agent/bridge.ts). They let a watch
// loop pull a request from the web UI's inbox, answer it, and close it. Reads only — they move text,
// never infrastructure — so they run at any autonomy level.
import { z } from 'zod';
import { defineTool } from './runtime.ts';
import { nextTask, say } from '../agent/bridge.ts';
import { id, now, run } from '../db.ts';
import { fid } from './helpers.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from './runtime.ts';

// the person behind the calling token: a watcher answers only its own person's requests
const me = (ctx: Ctx): string => {
  // answering requests (and Warden's incidents) is acting for people: not for a role that may only look
  if (ctx.actor.role === 'readonly' || ctx.actor.role === 'auditor') throw new Unit7Error('forbidden', `The ${ctx.actor.role} role can't answer requests.`, 403);
  // a subscription brain answers only its own thread: it never takes Warden's (or anyone's) requests from the inbox
  if (ctx.actor.agent?.startsWith('Unit7 brain')) throw new Unit7Error('forbidden', 'The ask box’s AI answers its own thread only.', 403);
  return ctx.actor.userId ?? ctx.actor.id ?? '';
};

defineTool({
  name: 'unit7.inbox_next', title: 'Get the next request from the web UI', risk: 'read', action: 'read', timeoutMs: 35_000,
  description: 'Pull the next thing the user typed in Unit7’s web app and wants done. Waits up to ~25s for one, then returns {empty:true} so you can call it again. In a `/unit7 watch` loop: call this, and when you get {conversationId, message}, do the work with the unit7 tools, keep the user posted with unit7_say, then call unit7_say with final=true and loop back here.',
  input: z.object({ wait: z.boolean().default(true) }),
  async run(ctx, i) {
    // must end before timeoutMs: a wait cut off by the timeout keeps waiting and can claim a request nobody gets
    const t = await nextTask(ctx.app, ctx.orgId, me(ctx), i.wait ? 25_000 : 0);
    // which AI session took it: its calls then belong to that conversation (a phone fix's "propose only" follows them)
    if (t && ctx.actor.kind !== 'user' && ctx.actor.id) run(ctx.db, 'UPDATE agent_tasks SET claimed_token = ? WHERE id = ?', ctx.actor.id, t.id);
    return t ? { taskId: t.id, conversationId: t.conversationId, message: t.message } : { empty: true };
  },
});

defineTool({
  name: 'unit7.say', title: 'Reply in the web UI', risk: 'read', action: 'read',
  description: 'Post a message into a web-UI conversation so the user sees it live. Use it to narrate what you’re doing in plain words, and once more with final=true for the final answer (which closes the request). conversationId comes from unit7_inbox_next.',
  input: z.object({ conversationId: fid('cnv'), text: z.string().min(1).max(8000), final: z.boolean().default(false),
    next: z.array(z.string().max(4000)).max(10).optional().describe('With final=true: up to 3 short replies the person would likely type next, in their voice ("Yes, implement phase 1 now", "Change the plan: skip the database"). Shown as suggestions in their ask box.') }),
  run(ctx, i) { return say(ctx.app, ctx.orgId, me(ctx), i.conversationId, i.text, i.final, i.next) ? { posted: true } : { posted: false, note: 'That conversation isn\u2019t one you can answer.' }; },
});

defineTool({
  name: 'unit7.thread', title: 'Show this conversation in the web UI', risk: 'read', action: 'read',
  description: 'Start a conversation in Unit7’s web app for a request the user typed in the terminal, so they can follow it there too. Returns conversationId; post updates and the final answer to it with unit7_say.',
  input: z.object({ message: z.string().min(1).max(4000) }),
  run(ctx, i) {
    const conversationId = id('cnv');
    run(ctx.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conversationId, ctx.orgId, me(ctx), i.message.slice(0, 80));
    const msg = { id: id('msg'), role: 'user', content: { text: `[relayed by ${ctx.actor.name} from the terminal] ${i.message}` }, created_at: now() };
    run(ctx.db, 'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', msg.id, conversationId, msg.role, JSON.stringify(msg.content), msg.created_at);
    ctx.app.events.emit(ctx.orgId, 'agent.message', '', { live: true, data: { conversationId, message: msg } });
    return { conversationId };
  },
});

defineTool({
  name: 'unit7.inbox_done', title: 'Mark a request handled', risk: 'read', action: 'read',
  description: 'Mark a request done without posting a final message (unit7_say with final=true already does this). Use only if you need to drop a request. taskId comes from unit7_inbox_next.',
  input: z.object({ taskId: fid('task') }),
  run(ctx, i) { run(ctx.db, `UPDATE agent_tasks SET status = 'done', done_at = ? WHERE id = ? AND org_id = ? AND user_id IN (?, 'warden')`, now(), i.taskId, ctx.orgId, me(ctx)); return { done: true }; },
});

