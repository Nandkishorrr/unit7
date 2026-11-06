// The AI asks the person in the Home chat with a picker, a preview or a small form instead of a question in text,
// and waits for the answer (agent/asks.ts). They only ask: nothing changes, so they're reads. Outside Unit7's ask
// box (a terminal, CI, a person's own call) they refuse.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { ASK_MS, SOURCES, ask } from '../agent/asks.ts';
import { all, get, json } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { SNOOZE_FOR, alertKey, severityNow, snoozeKeyOf, type SnoozeFor } from '../snooze.ts';
import { mapIssues } from './recheck.ts';
import { candidates } from './home.ts';
import { serverFindings } from '../discovery/findings.ts';
import { suggestions } from '../suggestions.ts';

const title = z.string().trim().min(1).max(140).describe('The question, short: "Which domain?"');
const note = z.string().max(400).optional().describe('One optional line under the title.');
const wait = ASK_MS + 30_000; // the ask expires first

defineTool({
  name: 'ui.choose', title: 'Ask the person to pick', risk: 'read', action: 'read', timeoutMs: wait,
  description: 'Show the person a picker in the chat and wait for their pick (up to 10 minutes). With source (domains, apps, servers, projects, databases, accounts) the picker shows their live data and you get back ids plus `items` with what to pass to the next tool (hostname, serviceId, pointWith for domain_point, serverId…). Use options only for small fixed choices; when the person must decide, give 2–4 options with exactly one recommended (and its why). allowNew adds an "add new" card; picking it returns {new:true}. Returns {choice, labels, items?} | {new:true} | {cancelled:true} | {expired:true}.',
  input: z.object({
    title, note,
    source: z.enum(SOURCES).optional().describe('Live data to pick from. Prefer this over options.'),
    filter: z.record(z.string(), z.string()).optional().describe('Narrow a source, e.g. {"provider":"vercel"}.'),
    options: z.array(z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(120), detail: z.string().max(200).optional(), logo: z.string().max(40).optional().describe('A brand id like vercel, cloudflare, postgres.'),
      recommended: z.boolean().optional().describe('The one you recommend: mark exactly one. With 2–4 options it shows as a row of buttons, this one highlighted.'),
      why: z.string().max(140).optional().describe('Why you recommend it, a few words: "it fits most apps".') })).max(40).optional(),
    multiple: z.boolean().optional().describe('Let them pick more than one.'),
    allowNew: z.object({ label: z.string().min(1).max(60), hint: z.string().max(120).optional() }).optional().describe('An "add new" card, e.g. {"label":"Add a new domain"}.'),
    preselect: z.string().max(300).optional().describe('The id to select at first.'),
  }).refine((i) => !!i.source || !!i.options?.length, 'Give a source (domains, apps, servers, projects, databases, accounts) or options.'),
  run: (ctx, i) => ask(ctx, { kind: 'choose', ...i }),
});

defineTool({
  name: 'ui.confirm', title: 'Ask the person to confirm a change', risk: 'read', action: 'read', timeoutMs: wait,
  description: 'Before a change, show the person exactly what changes (each as before → after) and how to undo it, with Confirm / Not now, and wait (up to 10 minutes). Returns {ok:true|false} | {cancelled:true} | {expired:true}. Follow the autonomy rules for when to use it.',
  input: z.object({
    title, note,
    changes: z.array(z.object({ label: z.string().min(1).max(80).describe('What changes: "DNS for example.com"'), before: z.string().max(200).optional(), after: z.string().min(1).max(200) })).min(1).max(12),
    undo: z.string().max(240).optional().describe('How to undo it, in one line.'),
    danger: z.boolean().optional().describe('Deletes, restores or anything hard to undo.'),
    confirmLabel: z.string().max(40).optional().describe('The button, e.g. "Point it".'),
  }),
  run: (ctx, i) => ask(ctx, { kind: 'confirm', ...i }),
});

defineTool({
  name: 'ui.form', title: 'Ask the person for a few values', risk: 'read', action: 'read', timeoutMs: wait,
  description: 'Show a small form in the chat and wait (up to 10 minutes). A secret field is stored in Unit7\'s vault and comes back as a credential:// reference, never the value. Returns {values} | {cancelled:true} | {expired:true}.',
  input: z.object({
    title, note,
    fields: z.array(z.object({
      id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).describe('A short key, e.g. "repo".'),
      label: z.string().min(1).max(60), type: z.enum(['text', 'secret', 'select', 'number']),
      placeholder: z.string().max(80).optional(), options: z.array(z.string().min(1).max(80)).max(20).optional().describe('For select.'),
      required: z.boolean().optional(), initial: z.string().max(200).optional(),
    })).min(1).max(8),
    submitLabel: z.string().max(40).optional(),
  }).refine((i) => i.fields.every((f) => f.type !== 'select' || !!f.options?.length), 'A select field needs options.'),
  run: (ctx, i) => ask(ctx, { kind: 'form', ...i }),
});

defineTool({
  name: 'ui.folder', title: 'Ask the person for their site', risk: 'read', action: 'read', timeoutMs: wait,
  description: 'When something should go live and it isn’t in a repo: show a card in the chat where the person picks a folder or drops a ZIP, and wait (up to 10 minutes). You never see or choose a path: Unit7 packs it into an upload. Returns {uploadId, name, stack, runtime?} for live_options and live_put | {cancelled:true} | {expired:true}.',
  input: z.object({ title: title.default('Which site should go live?'), note }),
  run: (ctx, i) => ask(ctx, { kind: 'folder', ...i }),
});

// --- "Hide it?": hiding is the person's call --------------------------------------------------------------------------
// snooze.set is people-only, so an AI never hides a risk. Asked to hide or clear something, it shows this card instead:
// what it is (in Unit7's own words, from its records, never the AI's), how serious, the choices and Hide it. The
// person's press runs snooze.set as them (the same "This is fine" every list has); the AI only hears what happened.
// a title-length version of it, cut on a word (the card says the same)
const clip = (t: string) => { const s = t.replace(/\.$/, ''); if (s.length <= 66) return s; const cut = s.lastIndexOf(' ', 64); return `${s.slice(0, cut > 40 ? cut : 64).replace(/[,:;]$/, '')}…`; };
const SEV: Record<string, string> = { alert: 'high', warn: 'warning', info: 'info' }; // a suggestion's or task's severity, as the snooze store ranks them
export function whatIs(ctx: Ctx, key: string): { what: string; severity?: string; kind: 'finding' | 'alert' | 'suggestion' | 'task' | 'event' } | undefined {
  const k = snoozeKeyOf(key), same = (x?: string) => !!x && snoozeKeyOf(x) === k;
  const issue = mapIssues(ctx.app, ctx.orgId).find((x) => same(x.key)); // the Map's issues and the outside checks
  if (issue) return { what: issue.text, severity: issue.severity, kind: 'alert' };
  const task = candidates(ctx).find((c) => same(c.id) || same(c.snoozeKey)); // Home's tasks: Warden's, the server watch, risks
  if (task) return { what: task.text, severity: SEV[task.severity], kind: task.snoozeKey && !same(task.id) ? 'alert' : 'task' };
  const alert = all<{ source: string; key: string; server_id: string; severity: string; title: string }>(ctx.db, 'SELECT source, key, server_id, severity, title FROM watch_alerts WHERE org_id = ? AND cleared_at IS NULL', ctx.orgId).find((a) => same(alertKey(a)));
  if (alert) return { what: alert.title, severity: alert.severity, kind: 'alert' };
  const report = json<{ id: string; title: string; severity: string }[]>(get<{ findings: string }>(ctx.db, `SELECT findings FROM security_reports WHERE org_id = ? AND server_id IS NULL ORDER BY created_at DESC LIMIT 1`, ctx.orgId)?.findings, []);
  for (const s of all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM servers WHERE org_id = ?', ctx.orgId)) { try { report.push(...serverFindings(ctx.db, ctx.orgId, s)); } catch { /* an old X-ray */ } }
  const finding = report.find((f) => same(f.id));
  if (finding) return { what: finding.title, severity: finding.severity, kind: 'finding' };
  const sugg = suggestions(ctx.app, ctx.orgId).find((s) => same(s.id));
  if (sugg && sugg.id !== 'all-clear') return { what: sugg.text, severity: SEV[sugg.severity], kind: 'suggestion' };
  const ev = /^event:([^:]+):(.*)$/s.exec(k);
  const e = ev && get<{ message: string; severity: string }>(ctx.db, `SELECT message, severity FROM events WHERE org_id = ? AND type = ? AND coalesce(resource, '') = ? ORDER BY created_at DESC LIMIT 1`, ctx.orgId, ev[1], ev[2]);
  return e ? { what: e.message, severity: e.severity, kind: 'event' } : undefined;
}

defineTool({
  name: 'ui.hide', title: 'Ask the person to hide something', risk: 'read', action: 'read', timeoutMs: wait,
  description: 'When the person asks to hide, clear or dismiss an alert, finding or suggestion: show a Hide card in the chat (what it is in Unit7’s words, until tomorrow, 7 days, 15 days or for good, and a Hide it button) and wait. Their press hides it as them; you never hide anything yourself (snooze_set is people only). key: its stable key (map_get issue key, home_suggest snoozeKey or id, a finding’s id, a watch alert’s snoozeKey, a suggestion’s id). If it’s already fixed, don’t hide it: alert_recheck with its key clears it for real. Returns {hidden:true, until, forGood} | {hidden:false} | {expired:true} | {cancelled:true}.',
  input: z.object({
    key: z.string().trim().min(1).max(300).describe('The stable key of what to hide'),
    for: z.enum(Object.keys(SNOOZE_FOR) as [SnoozeFor, ...SnoozeFor[]]).default('7d').describe('The choice picked at first; the person can change it'),
    note: z.string().max(200).optional().describe('One optional line, e.g. why it looks fine'),
  }),
  run(ctx, i) {
    const w = whatIs(ctx, i.key);
    if (!w) throw new Unit7Error('not_found', 'Unit7 doesn’t know that one, or it’s already gone. Use the key from map_get, home_suggest or the finding; something already fixed clears with alert_recheck.', 404);
    const key = snoozeKeyOf(i.key);
    // how serious from Unit7's records first: a critical one is only ever hidden for a while
    const severity = severityNow(ctx.db, ctx.orgId, key) ?? w.severity;
    const what = w.what.replace(/\s+/g, ' ').trim();
    return ask(ctx, { kind: 'hide', title: `Hide “${clip(what)}”?`, note: i.note, key, what, ...(severity && { severity }), itemKind: w.kind,
      for: severity === 'critical' && i.for === 'forever' ? '7d' : i.for });
  },
});

// --- "Delete it?": deleting is the person's click ------------------------------------------------------------------
// asset.delete is people-only, so an AI asked to delete never stops at "I can't": it shows this card. What it is and
// whether production runs come from Unit7's records; the choices are delete (stopping production first), archive
// instead (recommended when it looks used), just stop it, or not now. The person's click runs it as them, in the same
// guided pop-up the project page has (the typed name and the hold); the AI only hears what they did.
defineTool({
  name: 'ui.delete', title: 'Ask the person about deleting something', risk: 'read', action: 'read', timeoutMs: wait,
  description: 'When the person asks to delete, remove or get rid of a project or app: show the guided Delete card in the chat and wait (up to 10 minutes). You never delete anything yourself (asset_delete is people only), so never answer that you can’t: show this. key: a Unit7 project id (prj_…) or a map id from map_get. The card lists what goes and what stays, and offers, in order: delete (when production runs, it stops production first, then deletes), archive instead (recommended when it looks used), just stop it, not now. Returns {outcome:"deleted"|"archived"|"stopped"} | {cancelled:true} | {expired:true}.',
  input: z.object({ key: z.string().regex(/^(ast|prj)_[A-Za-z0-9_-]{12}$/, 'a map item or a Unit7 project').describe('The prj_ id or the map id'), note: z.string().max(200).optional().describe('One optional line, e.g. why') }),
  async run(ctx, i) {
    const { deleteCard } = await import('./lifecycle.ts');
    const c = deleteCard(ctx, i.key);
    return ask(ctx, { kind: 'delete', title: `Delete ${c.name}?`, note: i.note, ...c });
  },
});
