// "This is fine", as tools: hide a finding, alert or suggestion for a while or for good, list what's hidden, bring it
// back. Hiding is a person's call: an AI may suggest it in words, never do it (people only).
import { z } from 'zod';
import { defineTool } from './runtime.ts';
import { requireHuman } from './helpers.ts';
import { SNOOZE_FOR, snooze, snoozeState, unsnooze, backWords, type SnoozeFor, type SnoozeRow } from '../snooze.ts';

const KEY = z.string().trim().min(1).max(300).describe('The item’s stable id: a finding’s id, an alert’s key, a suggestion’s or task’s id');

defineTool({
  // a write (readonly and auditor members can't hide anything; it hides it for everyone), and a person's call
  name: 'snooze.set', title: 'Hide something for now', risk: 'write', action: 'preference', peopleOnly: true,
  description: 'People only. Hide a finding, alert or suggestion (its stable id as key) until tomorrow, for 7 or 15 days, or for good (“This is fine”, with an optional reason). It comes back by itself when the time is up, marked as back. An AI never does it: in Unit7’s ask box it asks with ui.hide (a Hide card the person presses).',
  input: z.object({ key: KEY, for: z.enum(Object.keys(SNOOZE_FOR) as [SnoozeFor, ...SnoozeFor[]]).default('7d'), reason: z.string().max(300).optional(),
    title: z.string().max(200).optional().describe('What it is, in words, for the Hidden list'), kind: z.enum(['finding', 'alert', 'suggestion', 'task', 'event']).optional(),
    severity: z.enum(['critical', 'high', 'warning', 'medium', 'low', 'info']).optional().describe('How serious it is as shown, when Unit7 has no record of it: one that comes back worse shows again') }),
  run(ctx, i) {
    // belt and braces: the gate already refuses an AI, this refuses one acting through a person's token too
    requireHuman(ctx, i.for === 'forever' ? 'say a risk is fine for good' : 'hide something');
    return snooze(ctx.db, ctx.orgId, { ...i, by: ctx.actor.name });
  },
});

defineTool({
  name: 'snooze.list', title: 'What’s hidden', risk: 'read', action: 'read',
  description: 'What a person hid (“This is fine”, or for now) and until when, and what came back in the last week because its time was up.',
  input: z.object({}),
  run(ctx) {
    const { hidden, back } = snoozeState(ctx.db, ctx.orgId);
    const row = (r: SnoozeRow) => ({ key: r.key, title: r.title || r.key, kind: r.kind, until: r.until, forGood: r.until === null, reason: r.reason, by: r.by, at: r.created_at });
    return { hidden: [...hidden.values()].map(row).sort((a, b) => b.at.localeCompare(a.at)), back: [...back.values()].map((r) => ({ ...row(r), words: backWords(r) })) };
  },
});

defineTool({
  name: 'snooze.clear', title: 'Bring a hidden thing back', risk: 'write', action: 'preference', peopleOnly: true,
  description: 'People only. Show something a person hid again (its key from snooze.list), right away.',
  input: z.object({ key: KEY }),
  run: (ctx, i) => ({ key: i.key, back: unsnooze(ctx.db, ctx.orgId, i.key) }),
});
