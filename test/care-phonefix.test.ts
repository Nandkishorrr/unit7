// "Let Unit7 fix it" from a phone alert: a code only Unit7 can make, used once, at most one look per problem every 30
// minutes, the investigation as the person who tapped it, ONE proposed fix that waits for their OK on the phone, and a
// follow-up saying whether it worked. ntfy, the model and the site are all fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, run } from '../src/db.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { codeFor, confirmPhone, handleReply } from '../src/sentinel/phone.ts';
import { fixAction, startCare } from '../src/care/phonefix.ts';
import type { Unit7Event } from '../src/events.ts';

for (const k of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'UNIT7_AGENT_MODEL']) delete process.env[k];
process.env.OLLAMA_URL = 'http://127.0.0.1:9/v1'; // no model unless a test starts the fake one

const until = async (f: () => unknown, ms = 3000) => { for (const t = Date.now(); !f() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 15)); assert.ok(f(), 'timed out waiting'); };
const event = (orgId: string, o: Partial<Unit7Event> = {}): Unit7Event => ({ id: 'evt_x', org_id: orgId, type: 'site.down', severity: 'critical', message: 'shop.example.com (shop) isn’t answering: HTTP 502',
  project_id: null, environment_id: null, resource: 'shop.example.com', data: {}, created_at: new Date().toISOString(), ...o });

async function setup() {
  const app = testApp();
  const o = await testOrg(app);
  const dev = ok(await o.h('project.create', { name: 'Shop', environments: ['development'] })).environments[0].id as string;
  const { accountId } = setupNtfy(app, o.orgId, o.userId);
  confirmPhone(app, o.orgId, accountId, 'person'); // buttons only go to a phone that showed it gets alerts
  const sent: { url: string; init: RequestInit }[] = [];
  const send = async (url: string, init: RequestInit) => { sent.push({ url, init }); };
  return { app, o, dev, accountId, sent, send };
}
const tapOf = (sent: { init: RequestInit }[]) => /body=(fix fix_[\w-]{12} [\w-]{22}), clear=true/.exec((sent.at(-1)!.init.headers as Record<string, string>).Actions ?? '')?.[1];

test('a problem alert carries "Let Unit7 fix it"; routine and approval alerts don’t', async () => {
  const { app, o, sent, send } = await setup();
  assert.equal(await deliver(app, event(o.orgId), send), 1);
  const actions = (sent[0]!.init.headers as Record<string, string>).Actions!;
  assert.match(actions, /^http, Let Unit7 fix it, https:\/\/ntfy\.sh\/unit7-r-[a-z0-9]+, method=POST, body=fix fix_[\w-]{12} [\w-]{22}, clear=true; http, Why\?, .+, method=POST, body=why \S+ [\w-]{22}, clear=false$/);
  assert.equal(get<{ status: string; user_id: string }>(app.db, 'SELECT status, user_id FROM care_fixes')!.user_id, o.userId, 'offered to the person who set up phone approvals');
  // a site coming back is news, not a problem
  await deliver(app, event(o.orgId, { type: 'site.recovered', severity: 'success', resource: 'other.example.com' }), send);
  assert.equal((sent.at(-1)!.init.headers as Record<string, string>).Actions, undefined);
});

test('a forged, mismatched, reused, expired or too-soon tap does nothing', async () => {
  const { app, o, accountId, sent, send } = await setup();
  await deliver(app, event(o.orgId), send);
  const tap = tapOf(sent)!;
  const [, fixId] = tap.split(' ');
  const conversations = () => all(app.db, 'SELECT 1 FROM conversations').length;
  assert.match((await handleReply(app, accountId, `fix ${fixId} ${'x'.repeat(22)}`))!, /wasn’t from Unit7/);
  assert.match((await handleReply(app, accountId, `fix ${fixId} ${codeFor(app, o.orgId, fixId!, 'approve')}`))!, /wasn’t from Unit7/, 'an approval code can’t start a fix');
  assert.match((await handleReply(app, accountId, `fix fix_${'a'.repeat(12)} ${tap.split(' ')[2]}`))!, /wasn’t from Unit7/, 'a code is for one alert only');
  assert.equal(conversations(), 0, 'nothing started');

  // expired
  run(app.db, 'UPDATE care_fixes SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), fixId!);
  assert.match((await handleReply(app, accountId, tap))!, /too old/);
  run(app.db, 'UPDATE care_fixes SET expires_at = ? WHERE id = ?', new Date(Date.now() + 3600_000).toISOString(), fixId!);

  // the right code starts one investigation, once
  assert.match((await handleReply(app, accountId, tap))!, /waiting in your AI’s inbox|Looking into it/);
  assert.equal(conversations(), 1);
  assert.match((await handleReply(app, accountId, tap))!, /already used/);

  // the same problem alerted again (a new button) within 30 minutes: no second look
  const again = fixAction(app, event(o.orgId), { title: 'Site down', text: 'still down', replies: 'https://ntfy.sh/unit7-r-x', accountId, approver: o.userId })!;
  assert.match((await handleReply(app, accountId, /body=(.+), clear/.exec(again)![1]!))!, /already started looking at this \d+ min ago/);
  assert.equal(conversations(), 1);
  // a different problem is its own look
  const other = fixAction(app, event(o.orgId, { resource: 'api.example.com' }), { title: 'Site down', text: 'api down', replies: 'https://ntfy.sh/unit7-r-x', accountId, approver: o.userId })!;
  assert.match((await handleReply(app, accountId, /body=(.+), clear/.exec(other)![1]!))!, /inbox|Looking/);
  assert.equal(conversations(), 2);
});

// before the fake model starts: Unit7 remembers a model it found for 10 minutes
test('through the person’s own AI (the inbox): its change waits too; "Not now" changes nothing; a fix that didn’t help says so', async () => {
  const { app, o, dev, accountId, sent, send } = await setup();
  let up = false;
  const stop = startCare(app, { probe: async () => ({ ok: up, ms: 10, why: 'HTTP 502' }), send: send as never, pollMs: 10, settleMs: 0 });
  try {
    await deliver(app, event(o.orgId), send);
    assert.match((await handleReply(app, accountId, tapOf(sent)!))!, /waiting in your AI’s inbox/);
    assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM agent_tasks WHERE user_id = ?`, o.userId)!.n, 1, 'queued for this person’s AI only');
    // the window is kept on the fix itself, as long as its inbox request can wait (not 30 minutes in memory)
    const look = () => get<{ look_until: string }>(app.db, `SELECT look_until FROM care_fixes WHERE status = 'looking'`)!.look_until;
    assert.ok(Date.parse(look()) - Date.now() > 23 * 3600_000);
    // an AI session that didn't take this request is never "the fix", even the person's own: the gate is as usual for it
    assert.equal((await o.as({ ...o.agent, id: 'tok_other_session' })('env.set', { environmentId: dev, key: 'ELSEWHERE', value: '1' })).status, 'ok');
    // their AI (an agent token for them) takes the request from the inbox, looks, then proposes: it waits
    const task = ok(await o.a('unit7.inbox_next', { wait: false }));
    assert.equal(task.conversationId, get<{ conversation_id: string }>(app.db, 'SELECT conversation_id FROM care_fixes')!.conversation_id);
    ok(await o.a('graph.get', {}));
    const r = await o.a('env.set', { environmentId: dev, key: 'LOG_LEVEL', value: 'info' });
    assert.equal(r.status, 'approval_required');
    assert.equal((await o.a('env.set', { environmentId: dev, key: 'OTHER', value: '1' })).status, 'denied', 'one fix only');
    const approvalId = (r as { approvalId: string }).approvalId;
    assert.match((await handleReply(app, accountId, `reject ${approvalId} ${codeFor(app, o.orgId, approvalId, 'reject')}`))!, /^Rejected/);
    assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM care_fixes')!.status, 'declined');
    assert.equal(all(app.db, `SELECT 1 FROM env_vars WHERE key IN ('LOG_LEVEL', 'OTHER')`).length, 0);
    assert.equal((await o.a('env.set', { environmentId: dev, key: 'AFTER', value: '1' })).status, 'denied', '“Not now” doesn’t free the thread for another change');

    // a later problem: the fix runs but the site still doesn't answer
    await deliver(app, event(o.orgId, { resource: 'api.example.com', message: 'api.example.com isn’t answering' }), send);
    await handleReply(app, accountId, tapOf(sent)!);
    ok(await o.a('unit7.inbox_next', { wait: false }));
    const r2 = await o.a('env.set', { environmentId: dev, key: 'LOG_LEVEL', value: 'info' });
    const a2 = (r2 as { approvalId: string }).approvalId;
    await handleReply(app, accountId, `approve ${a2} ${codeFor(app, o.orgId, a2, 'approve')}`);
    await until(() => get<{ status: string }>(app.db, `SELECT status FROM care_fixes WHERE resource = 'api.example.com'`)!.status === 'failed');
    await until(() => sent.some((s) => /^Didn’t work: api\.example\.com still isn’t answering \(HTTP 502\)/.test(String(s.init.body))));
    assert.ok(get(app.db, `SELECT 1 FROM events WHERE type = 'care.fix_failed'`));
    // once its time is up the thread is ordinary again (the gate reads the fix's row, nothing kept in memory)
    run(app.db, 'UPDATE care_fixes SET look_until = ?', new Date(Date.now() - 1000).toISOString());
    assert.equal((await o.a('env.set', { environmentId: dev, key: 'LATER', value: '1' })).status, 'ok');
  } finally { stop(); }
});

test('the tap is the person’s own request: their brain looks, proposes ONE fix, it comes back to the phone, and the follow-up says it worked', async () => {
  const { app, o, dev, accountId, sent, send } = await setup();
  // a fake model: look (read), propose a fix, try a second one, then answer
  const calls: string[] = [];
  const model = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
      const n = JSON.parse(raw).messages.filter((m: any) => m.role === 'tool').length;
      const call = (name: string, args: object) => ({ role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      const msg: any = n === 0 ? call('graph_get', {}) : n === 1 ? call('env_set', { environmentId: dev, key: 'LOG_LEVEL', value: 'info' })
        : n === 2 ? call('env_set', { environmentId: dev, key: 'LOG_LEVEL', value: 'warn' }) : n === 3 ? call('domain_buy', { domain: 'example.com', confirmName: 'example.com', confirmPrice: '$9.99' }) : { role: 'assistant', content: 'Found it. The fix sets LOG_LEVEL and waits for your OK.' };
      if (msg.tool_calls) calls.push(msg.tool_calls[0]!.function.name);
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  const stop = startCare(app, { probe: async () => ({ ok: true, ms: 42 }), send: send as never, pollMs: 10, settleMs: 0 });
  try {
    await deliver(app, event(o.orgId), send);
    assert.equal(await handleReply(app, accountId, tapOf(sent)!), 'Looking into it now. You’ll get one fix to approve here.');
    const f = () => get<{ status: string; conversation_id: string; approval_id: string | null; via: string; look_until: string }>(app.db, 'SELECT status, conversation_id, approval_id, via, look_until FROM care_fixes')!;
    await until(() => f().status === 'proposed' && Date.parse(f().look_until) <= Date.now());
    assert.equal(f().via, 'unit7');
    assert.deepEqual(calls, ['graph_get', 'env_set', 'env_set', 'domain_buy']);

    // as that person, in their own thread (visible in the web app), with the alert fenced off as data
    const conv = get<{ user_id: string }>(app.db, 'SELECT user_id FROM conversations WHERE id = ?', f().conversation_id)!;
    assert.equal(conv.user_id, o.userId);
    const asked = JSON.parse(get<{ content: string }>(app.db, `SELECT content FROM messages WHERE conversation_id = ? AND role = 'user'`, f().conversation_id)!.content).text;
    assert.match(asked, /Look first, read-only/);
    assert.match(asked, /<untrusted source="the alert">/);
    // the look ran; the one fix waits (it would have run on its own at this autonomy); a second fix and a purchase never happened
    const steps = all<{ content: string }>(app.db, `SELECT content FROM messages WHERE conversation_id = ? AND role = 'tool' ORDER BY created_at`, f().conversation_id).map((m) => JSON.parse(m.content));
    assert.deepEqual(steps.map((s) => [s.tool, s.status]), [['graph.get', 'ok'], ['env.set', 'approval_required'], ['env.set', 'denied'], ['domain.buy', 'denied']]);
    assert.equal(all(app.db, `SELECT 1 FROM approvals`).length, 1);
    assert.equal(all(app.db, `SELECT 1 FROM env_vars WHERE key = 'LOG_LEVEL'`).length, 0, 'nothing changed yet');
    const approval = get<{ id: string; actor: string }>(app.db, 'SELECT id, actor FROM approvals')!;
    assert.equal(JSON.parse(approval.actor).userId, o.userId);
    assert.equal(f().approval_id, approval.id);
    assert.ok(all(app.db, `SELECT 1 FROM events WHERE type = 'care.fix_started'`).length, 'Activity shows it');

    // the fix comes back to the phone as an approval: Approve / Not now
    const e = get<any>(app.db, `SELECT * FROM events WHERE type = 'approval.requested'`);
    await deliver(app, { ...e, data: JSON.parse(e.data) }, send);
    assert.match((sent.at(-1)!.init.headers as Record<string, string>).Actions!, /^http, Approve, .+; http, Not now, .+body=reject /);

    // approved from the phone: it runs, Unit7 checks the site again, and says so everywhere
    assert.match((await handleReply(app, accountId, `approve ${approval.id} ${codeFor(app, o.orgId, approval.id, 'approve')}`))!, /^Approved and done: env\.set/);
    await until(() => f().status === 'fixed');
    assert.equal(all(app.db, `SELECT 1 FROM env_vars WHERE key = 'LOG_LEVEL'`).length, 1);
    await until(() => sent.some((s) => String(s.init.body).startsWith('Fixed:')));
    assert.equal(String(sent.find((s) => String(s.init.body).startsWith('Fixed:'))!.init.body), 'Fixed: shop.example.com answers again (42 ms).');
    assert.ok(all<{ content: string }>(app.db, `SELECT content FROM messages WHERE conversation_id = ? AND role = 'status'`, f().conversation_id).some((m) => /Fixed: shop\.example\.com/.test(m.content)), 'the thread says so');
    assert.ok(get(app.db, `SELECT 1 FROM events WHERE type = 'care.fixed'`), 'and Activity');
  } finally { stop(); model.close(); process.env.OLLAMA_URL = 'http://127.0.0.1:9/v1'; }
});

test('outside a phone fix the gate is unchanged: the same AI change runs on its own at this autonomy', async () => {
  const { o, dev } = await setup();
  assert.equal((await o.a('env.set', { environmentId: dev, key: 'LOG_LEVEL', value: 'info' })).status, 'ok');
});
