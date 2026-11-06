// Alerts in Telegram, and "why?" as a reply. It needs a bot of your own: a person pastes its token in the web app, sends the bot any
// message, and Unit7 finds the chat from that. The token stays in the vault. Unit7 only ever connects out.
import { z } from 'zod';
import type { App } from '../app.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { defineTool } from '../tools/runtime.ts';
import { requireHuman } from '../tools/helpers.ts';
import { Unit7Error } from '../errors.ts';
import { makeRef } from '../vault.ts';
import { explainEvent } from '../explain.ts';

const API = () => process.env.UNIT7_TELEGRAM_API ?? 'https://api.telegram.org';
const call = async (token: string, method: string, body?: unknown) => {
  const r = await fetch(`${API()}/bot${token}/${method}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({})) as { ok?: boolean; result?: any; description?: string };
  if (!j.ok) throw new Error(j.description ?? `Telegram said ${r.status}`);
  return j.result;
};
export const sendTelegram = (token: string, chatId: number | string, text: string) => call(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 3900) });
// (pure) the chat that wrote to the bot, the newest update, and what it asked
export function lastChat(updates: { update_id: number; message?: { chat?: { id: number }; text?: string } }[]) { const u = [...updates].reverse().find((x) => x.message?.chat?.id); return u && { chatId: u.message!.chat!.id, text: u.message!.text ?? '', updateId: u.update_id }; }
const WHY = /^\s*(why|why\?|what happened|\?)\s*$/i;
export const asksWhy = (t: string) => WHY.test(t);

defineTool({
  name: 'alerts.telegram', title: 'Connect Telegram', risk: 'write', action: 'settings_write', peopleOnly: true, sensitive: ['token'], timeoutMs: 20_000,
  description: 'People only. Send alerts to Telegram through your own bot: make one with BotFather, send it any message, then give its token here. Reply "why?" to the bot for the reason behind the last alert.',
  input: z.object({ token: z.string().regex(/^\d+:[\w-]{20,}$/, 'a bot token from BotFather') }),
  async run(ctx, i) {
    requireHuman(ctx, 'connect Telegram');
    const me = await call(i.token, 'getMe').catch((e: Error) => { throw new Unit7Error('telegram', `Telegram refused that token: ${e.message}`, 400); }) as { username?: string };
    const chat = lastChat(await call(i.token, 'getUpdates') as never);
    if (!chat) throw new Unit7Error('no_chat', `Send your bot${me.username ? ` @${me.username}` : ''} any message first, then try again.`, 409);
    const slug = (me.username ?? 'bot').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) || 'bot', ref = makeRef('telegram', slug, 'token'), accountId = id('acc');
    ctx.app.vault.put(ctx.orgId, ref, i.token, { kind: 'api_token', by: ctx.actor.name, meta: { label: 'Telegram bot' } });
    run(ctx.db, `INSERT INTO accounts (id, org_id, provider, slug, name, status, meta) VALUES (?, ?, 'telegram', ?, ?, 'connected', ?)`, accountId, ctx.orgId, slug, `Telegram (${me.username ?? 'bot'})`, JSON.stringify({ ref, chatId: chat.chatId, offset: chat.updateId + 1 }));
    await sendTelegram(i.token, chat.chatId, 'Unit7 is connected. I’ll tell you here when something needs you. Reply “why?” to any alert.');
    return { connected: me.username ?? 'bot' };
  },
});

// replies: only "why?", from the chat that was connected, answered from what Unit7 already recorded. No AI, no action.
export async function telegramReplies(app: App) {
  for (const a of all<{ id: string; org_id: string; meta: string }>(app.db, `SELECT id, org_id, meta FROM accounts WHERE provider = 'telegram'`)) {
    const m = json<{ ref: string; chatId: number; offset?: number }>(a.meta, { ref: '', chatId: 0 });
    let token: string; try { token = app.vault.resolve(a.org_id, m.ref); } catch { continue; }
    const updates = await call(token, `getUpdates?offset=${m.offset ?? 0}&timeout=0`).catch(() => []) as { update_id: number; message?: { chat?: { id: number }; text?: string } }[];
    if (!updates.length) continue;
    for (const u of updates) if (u.message?.chat?.id === m.chatId && asksWhy(u.message.text ?? '')) await sendTelegram(token, m.chatId, whyText(app, a.org_id)).catch(() => undefined);
    run(app.db, 'UPDATE accounts SET meta = ? WHERE id = ?', JSON.stringify({ ...m, offset: updates.at(-1)!.update_id + 1 }), a.id);
  }
}
// the reason behind the latest alert, in plain words, from the record
export function whyText(app: App, orgId: string, eventId?: string) {
  const e = get<{ type: string; message: string; created_at: string }>(app.db, eventId ? 'SELECT type, message, created_at FROM events WHERE org_id = ? AND id = ?' : `SELECT type, message, created_at FROM events WHERE org_id = ? AND severity IN ('warning', 'critical') ORDER BY created_at DESC LIMIT 1`, ...(eventId ? [orgId, eventId] : [orgId]));
  if (!e) return 'Nothing has gone wrong lately.';
  const w = explainEvent(e.type, e.message), at = (now(), e.created_at.slice(11, 16));
  return [`${at} UTC: ${w.what}`, w.why, w.next].filter(Boolean).join('\n');
}
