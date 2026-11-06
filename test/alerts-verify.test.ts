// "Connected" means alerts really arrive. Phone alerts: set up, then a test with an "It worked" button whose one-time
// code (an HMAC, like the approval buttons) comes back on a separate reply topic; only then connected, and only then
// phone approvals. A later refused alert shows as not reaching the phone. Team chats: a test must be taken (a 2xx).
// ntfy, Slack and Discord are all fakes here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok, setAutonomy } from './helpers.ts';
import { all, get, run } from '../src/db.ts';
import { connections, setupNtfy } from '../src/connectors/oneclick.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { handleReply, sendPhoneTest, startPhoneApprovals } from '../src/sentinel/phone.ts';
import type { Unit7Event } from '../src/events.ts';

type Sent = { url: string; init: RequestInit };
const fakeNtfy = (status = 200) => {
  const sent: Sent[] = [];
  const f = (async (url: string, init?: RequestInit) => { sent.push({ url, init: init ?? {} }); return new Response('{}', { status }); }) as typeof fetch;
  return { sent, f };
};
const header = (s: Sent, h: string) => (s.init.headers as Record<string, string>)[h];
const tapOf = (s: Sent) => /body=(verify [\w-]{12} [\w-]{22}), clear=true$/.exec(header(s, 'Actions') ?? '')?.[1];
const phoneRow = (app: ReturnType<typeof testApp>, orgId: string) => connections(app, orgId).find((c) => c.id === 'ntfy')!.accounts[0] as any;
const ev = (orgId: string, o: Partial<Unit7Event> = {}): Unit7Event => ({ id: 'evt', org_id: orgId, type: 'site.down', severity: 'critical', message: 'shop.example.com isn’t answering',
  project_id: null, environment_id: null, resource: `shop-${Math.random()}`, data: {}, created_at: new Date().toISOString(), ...o });

async function setup() {
  const app = testApp();
  const o = await testOrg(app);
  const { accountId, subscribeUrl } = setupNtfy(app, o.orgId, o.userId);
  return { app, o, accountId, topic: subscribeUrl };
}

test('set up is not connected: waiting for the phone, no approvals, no buttons on alerts', async () => {
  const { app, o, accountId, topic } = await setup();
  const row = phoneRow(app, o.orgId);
  assert.equal(row.alert.state, 'waiting');
  assert.equal(row.phoneApprovals, false);
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM accounts WHERE id = ?', accountId)!.status, 'unverified');
  assert.deepEqual(setupNtfy(app, o.orgId, o.userId), { accountId, subscribeUrl: topic }, 'asking again shows the same topic, no second account');
  // alerts still go out (they may well arrive), just without buttons that would act for someone
  const { sent, f } = fakeNtfy();
  assert.equal(await deliver(app, ev(o.orgId), (u, i) => f(u, i)), 1);
  assert.equal(sent[0]!.url, topic);
  assert.equal(header(sent[0]!, 'Actions'), undefined);
});

test('the test carries "It worked" on the reply topic; its code works once, and not after 30 minutes', async () => {
  const { app, o, accountId, topic } = await setup();
  const { sent, f } = fakeNtfy();
  await sendPhoneTest(app, o.orgId, accountId, f);
  assert.equal(sent[0]!.url, topic);
  assert.equal(header(sent[0]!, 'Title'), 'Unit7 test');
  assert.match(String(sent[0]!.init.body), /^Unit7 test: tap “It worked”/);
  const actions = header(sent[0]!, 'Actions')!;
  const replies = /^http, It worked, (https:\/\/ntfy\.sh\/unit7-r-[a-z0-9]{20,}), method=POST, body=verify [\w-]{12} [\w-]{22}, clear=true$/.exec(actions)?.[1];
  assert.ok(replies, actions);
  assert.notEqual(replies, topic, 'answers come back on their own topic');
  const tap = tapOf(sent[0]!)!;
  const [, nonce, code] = tap.split(' ');

  assert.match((await handleReply(app, accountId, `verify ${nonce} ${'x'.repeat(22)}`))!, /wasn’t from Unit7/);
  assert.equal(phoneRow(app, o.orgId).alert.state, 'waiting', 'a forged code proves nothing');
  // an old test's code is refused
  run(app.db, `UPDATE accounts SET meta = json_set(meta, '$.check.until', ?) WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), accountId);
  assert.match((await handleReply(app, accountId, tap))!, /too old/);
  run(app.db, `UPDATE accounts SET meta = json_set(meta, '$.check.until', ?) WHERE id = ?`, new Date(Date.now() + 60_000).toISOString(), accountId);

  assert.match((await handleReply(app, accountId, tap))!, /All set/);
  const row = phoneRow(app, o.orgId);
  assert.equal(row.alert.state, 'verified');
  assert.ok(Date.now() - Date.parse(row.alert.at) < 5000, 'verified just now');
  assert.equal(row.phoneApprovals, true, 'approvals turn on for the person who set it up');
  assert.match((await handleReply(app, accountId, tap))!, /already answered/, 'a code works once');
  assert.match((await handleReply(app, accountId, `verify ${nonce} ${code}`))!, /already answered/);
});

test('the tap arrives through the reply listener, and the phone hears it worked', async () => {
  const { app, o, accountId } = await setup();
  const ntfy = fakeNtfy();
  await sendPhoneTest(app, o.orgId, accountId, ntfy.f);
  const tap = tapOf(ntfy.sent[0]!)!;
  const posted: string[] = [];
  let asked = '';
  const enc = new TextEncoder();
  const f = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(init.body)); return new Response('{}'); }
    asked = url;
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`${JSON.stringify({ id: 'm1', event: 'message', message: tap })}\n`)); c.close(); } }));
  }) as typeof fetch;
  const p = startPhoneApprovals(app, { fetch: f });
  for (let i = 0; i < 50 && !posted.length; i++) await new Promise((r) => setTimeout(r, 20));
  p.stop();
  assert.match(asked, /^https:\/\/ntfy\.sh\/unit7-r-[a-z0-9]+\/json\?since=10m$/, 'it listens on the reply topic, outgoing only');
  assert.match(posted[0]!, /All set/);
  assert.equal(phoneRow(app, o.orgId).alert.state, 'verified');
  assert.equal(all(app.db, `SELECT 1 FROM events WHERE type = 'account.phone_verified'`).length, 1);
});

test('phone approvals stay blocked until the phone is verified', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const prod = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id;
  setAutonomy(app, prod, 2);
  const { accountId } = setupNtfy(app, o.orgId, o.userId);
  const on = await o.h('alerts.phone_approvals', { on: true });
  assert.equal(on.status, 'error');
  assert.match((on as any).error.message, /hasn’t shown it gets alerts/);
  const r = await o.a('env.set', { environmentId: prod, key: 'LOG_LEVEL', value: 'debug' });
  assert.equal(r.status, 'approval_required');
  const approvalId = (r as any).approvalId as string;
  // the "waiting for your OK" alert goes out with no Approve button, and a reply can't approve anything
  const e = all<any>(app.db, `SELECT * FROM events WHERE type = 'approval.requested'`)[0];
  const { sent, f } = fakeNtfy();
  await deliver(app, { ...e, data: JSON.parse(e.data ?? '{}') }, (u, i) => f(u, i));
  assert.equal(header(sent[0]!, 'Actions'), undefined);
  assert.equal(await handleReply(app, accountId, `approve ${approvalId} ${'x'.repeat(22)}`), undefined);
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM approvals WHERE id = ?', approvalId)!.status, 'pending');

  // a person says the test arrived (an iPhone shows no buttons): people only, and only with a test waiting
  assert.equal((await o.h('alerts.phone_confirm', {})).status, 'error', 'nothing was sent yet');
  await sendPhoneTest(app, o.orgId, accountId, f);
  assert.notEqual((await o.a('alerts.phone_confirm', {})).status, 'ok', 'an AI can’t say what reached a phone');
  ok(await o.h('alerts.phone_confirm', {}));
  assert.equal((await o.h('alerts.phone_confirm', {})).status, 'error', 'used once');
  assert.equal(phoneRow(app, o.orgId).alert.state, 'verified');
  assert.equal(ok(await o.h('alerts.phone_approvals', { on: true })).phoneApprovals, true);
});

test('a refused alert shows as not reaching the phone (once in Activity); one that goes through clears it', async () => {
  const { app, o, accountId } = await setup();
  const down = fakeNtfy();
  await sendPhoneTest(app, o.orgId, accountId, down.f);
  await handleReply(app, accountId, tapOf(down.sent[0]!)!);
  const refuse = async () => { throw new Error('HTTP 429'); };
  assert.equal(await deliver(app, ev(o.orgId), refuse), 0);
  assert.equal(await deliver(app, ev(o.orgId), refuse), 0);
  const row = phoneRow(app, o.orgId);
  assert.equal(row.alert.state, 'failing');
  assert.equal(row.alert.why, 'ntfy answered HTTP 429');
  assert.equal(all(app.db, `SELECT 1 FROM events WHERE type = 'account.alerts_missed'`).length, 1, 'said once, not per alert');
  // the test itself failing says so too
  await assert.rejects(sendPhoneTest(app, o.orgId, accountId, fakeNtfy(500).f), /ntfy answered HTTP 500/);
  assert.equal(await deliver(app, ev(o.orgId), async () => undefined), 1);
  assert.equal(phoneRow(app, o.orgId).alert.state, 'verified', 'it works again');
});

test('no topic, reply topic or team chat link ever lands in audit or events', async () => {
  const { app, o, topic } = await setup();
  const realFetch = globalThis.fetch;
  const hook = 'https://hooks.slack.com/services/T000/B000/secretpart';
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
  try {
    const bad = ok(await o.h('account.connect', { provider: 'webhook', token: hook }));
    assert.equal(bad.status, 'failing', 'a link that refuses the test is not connected');
    assert.equal(bad.problem, 'it answered HTTP 404');
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
    const good = ok(await o.h('account.connect', { provider: 'webhook', token: `${hook}2` }));
    assert.equal(good.status, 'verified');
    const chat = connections(app, o.orgId).find((c) => c.id === 'webhook')!.accounts.find((a: any) => a.id === good.accountId) as any;
    assert.equal(chat.alert.state, 'verified');
    assert.equal(chat.name, 'Slack or Discord · Slack');
  } finally { globalThis.fetch = realFetch; }
  // the test through the gate, as the page sends it (ntfy faked)
  const { sent, f } = fakeNtfy();
  globalThis.fetch = f;
  try { assert.equal(ok(await o.h('alerts.phone_test', {})).sent, true); } finally { globalThis.fetch = realFetch; }
  assert.equal(sent.length, 1);
  ok(await o.h('alerts.phone_confirm', {}));
  await deliver(app, ev(o.orgId), async () => { throw new Error('HTTP 500'); });
  const replies = /It worked, (\S+),/.exec(header(sent[0]!, 'Actions')!)![1]!;
  const everything = JSON.stringify([all(app.db, 'SELECT * FROM audit'), all(app.db, 'SELECT * FROM events'), all(app.db, 'SELECT id, name, meta FROM accounts')]);
  for (const s of [topic, replies, hook, topic.split('/').pop()!, replies.split('/').pop()!, 'secretpart']) assert.ok(!everything.includes(s), `leaked: ${s.slice(0, 12)}…`);
});
