// Everything that runs out, on one page and in your calendar: domains, certificates, your server's plan, keys. Only what
// Unit7 has actually read; a date it doesn't know isn't guessed.
import { z } from 'zod';
import { all, type DB } from '../db.ts';
import { defineTool } from '../tools/runtime.ts';

export interface Expiry { id: string; kind: 'domain' | 'certificate' | 'server' | 'key'; name: string; at: string; days: number; renews?: boolean; note?: string }
const DAY = 86400_000;

export function expiries(db: DB, orgId: string, nowMs = Date.now()): Expiry[] {
  const out: Expiry[] = [];
  const days = (at: string) => Math.floor((Date.parse(at) - nowMs) / DAY);
  for (const w of all<{ host: string; kind: string; value: string | null; detail: string | null }>(db, `SELECT host, kind, value, detail FROM watch WHERE org_id = ? AND kind IN ('registration', 'tls') AND value IS NOT NULL`, orgId)) {
    if (Number.isNaN(Date.parse(w.value!))) continue;
    const domain = w.kind === 'registration', renews = domain ? /renews by itself/.test(w.detail ?? '') : true;
    out.push({ id: `${w.kind}:${w.host}`, kind: domain ? 'domain' : 'certificate', name: w.host, at: w.value!, days: days(w.value!), renews, note: domain ? (renews ? 'Renews by itself' : 'Renew it at your registrar') : 'Renews by itself' });
  }
  for (const s of all<{ id: string; name: string; expires: string | null }>(db, `SELECT id, name, json_extract(facts, '$.plan.expiresAt') expires FROM servers WHERE org_id = ?`, orgId)) {
    if (s.expires) out.push({ id: `server:${s.id}`, kind: 'server', name: s.name, at: s.expires, days: days(s.expires), note: 'Your server’s plan' });
  }
  for (const t of all<{ id: string; name: string; expires_at: string }>(db, `SELECT id, name, expires_at FROM api_tokens WHERE org_id = ? AND expires_at IS NOT NULL`, orgId)) {
    out.push({ id: `key:${t.id}`, kind: 'key', name: t.name.replace(/^.*·\s*/, ''), at: t.expires_at, days: days(t.expires_at), note: 'An app key for Unit7' });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// a calendar file with one all-day event per thing, reminding a week before
const stamp = (at: string) => new Date(at).toISOString().slice(0, 10).replace(/-/g, '');
const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
export function icsOf(list: Expiry[], nowMs = Date.now()) {
  const made = new Date(nowMs).toISOString().replace(/[-:]|\.\d+/g, '');
  const events = list.filter((e) => e.days >= 0).flatMap((e) => ['BEGIN:VEVENT', `UID:${e.id}@unit7`, `DTSTAMP:${made}`, `DTSTART;VALUE=DATE:${stamp(e.at)}`, `SUMMARY:${esc(`${e.name} runs out`)}`, `DESCRIPTION:${esc(e.note ?? '')}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Runs out in a week', 'TRIGGER:-P7D', 'END:VALARM', 'END:VEVENT']);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unit7//Expiry calendar//EN', ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

defineTool({
  name: 'expiry.list', title: 'What runs out, and when', risk: 'read', action: 'read',
  description: 'Everything that runs out with a date Unit7 has read: domains, HTTPS certificates, server plans and app keys, soonest first, with whether it renews by itself. Includes a calendar file (ics) to add it all to a calendar.',
  input: z.object({}),
  run(ctx) { const list = expiries(ctx.db, ctx.orgId); return { list, ics: icsOf(list) }; },
});
