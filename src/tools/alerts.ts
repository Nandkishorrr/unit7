// Alert channels that prove they work. Phone alerts (ntfy) count as connected only after a test reached the phone: a
// tap on "It worked" (sentinel/phone.ts) or the person saying "I got it" here. A Slack or Discord link counts once a
// test message was taken (a 2xx). The topics and links themselves stay in the vault and never appear in any output.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { verifiers } from './core.ts';
import { get, json } from '../db.ts';
import { requireHuman, requireRole } from './helpers.ts';
import { Unit7Error } from '../errors.ts';
import { confirmPhone, missed, sendPhoneTest, type PhoneMeta } from '../sentinel/phone.ts';

const phone = (ctx: Ctx) => {
  const a = get<{ id: string; meta: string }>(ctx.db, `SELECT id, meta FROM accounts WHERE org_id = ? AND provider = 'ntfy' ORDER BY created_at LIMIT 1`, ctx.orgId);
  if (!a) throw new Unit7Error('no_account', 'Set up phone alerts first (Connections → Phone alerts).', 409);
  return { id: a.id, m: json<PhoneMeta>(a.meta, {}) };
};

defineTool({
  name: 'alerts.phone_test', title: 'Send a test to your phone', risk: 'read', action: 'read',
  description: 'Send a test alert to the phone (ntfy) with an "It worked" button. Phone alerts count as working only after the phone taps it or a person confirms it arrived. Fails, and shows phone alerts as not reaching the phone, when ntfy refuses it.',
  input: z.object({}),
  run: async (ctx) => sendPhoneTest(ctx.app, ctx.orgId, phone(ctx).id),
});

defineTool({
  name: 'alerts.phone_confirm', title: 'Say the test reached your phone', risk: 'write', action: 'settings_write', peopleOnly: true,
  description: 'A person saw the test alert arrive (iPhones show no buttons on alerts). People only (owners and admins): an AI can’t say what reached someone’s phone.',
  input: z.object({}),
  run(ctx) {
    requireHuman(ctx, 'say an alert reached your phone');
    requireRole(ctx, ['owner', 'admin'], 'confirm phone alerts');
    const { id, m } = phone(ctx);
    if (!m.check) throw new Unit7Error('no_test', 'Send a test first, then say whether it arrived.', 409);
    if (Date.parse(m.check.until) < Date.now()) throw new Unit7Error('test_expired', 'That test is too old. Send a new one, then say whether it arrived.', 409);
    return { verified: true, at: confirmPhone(ctx.app, ctx.orgId, id, 'person') };
  },
});

// Slack, Discord or any webhook: connecting (and Check) sends a real test message; only a 2xx counts. The link is never
// in the error: just what the other side answered.
verifiers.webhook = async (ctx, a, url) => {
  const discord = /discord(?:app)?\.com\/api\/webhooks/.test(url), slack = /hooks\.slack\.com\//.test(url);
  const text = 'Unit7 test: alerts that need you will show up here.';
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(discord ? { content: `**${text}**` } : { text: `*${text}*` }), signal: AbortSignal.timeout(10_000) })
    .catch(() => { throw new Error('Unit7 couldn’t reach that link'); });
  if (!r.ok) throw new Error(`it answered HTTP ${r.status}`);
  missed(ctx.app, ctx.orgId, a.id, null);
  return { label: discord ? 'Discord' : slack ? 'Slack' : 'Webhook', testedAt: new Date().toISOString() };
};
