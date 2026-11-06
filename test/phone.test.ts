// Approving from the phone: buttons on the alert, decided through a private reply channel, with codes
// only Unit7 can make. Nothing on this computer is opened to the internet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok, setAutonomy } from './helpers.ts';
import { all, get } from '../src/db.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';
import { deliver } from '../src/sentinel/notify.ts';
import { codeFor, confirmPhone, handleReply, startPhoneApprovals } from '../src/sentinel/phone.ts';

async function waitingApproval() {
  const app = testApp();
  const o = await testOrg(app);
  const prod = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id;
  setAutonomy(app, prod, 2);
  const { accountId } = setupNtfy(app, o.orgId, o.userId);
  confirmPhone(app, o.orgId, accountId, 'person'); // the phone showed it gets alerts: approvals turn on for Ada
  const r = await o.a('env.set', { environmentId: prod, key: 'LOG_LEVEL', value: 'debug' });
  assert.equal(r.status, 'approval_required');
  return { app, o, accountId, approvalId: (r as any).approvalId as string };
}

test('the "waiting for your OK" alert carries Approve and Reject buttons', async () => {
  const { app, o, approvalId } = await waitingApproval();
  const sent: { url: string; init: RequestInit }[] = [];
  const e = all<any>(app.db, `SELECT * FROM events WHERE type = 'approval.requested'`)[0];
  await deliver(app, { ...e, data: JSON.parse(e.data ?? '{}') }, async (url, init) => { sent.push({ url, init }); });
  const actions = (sent[0]!.init.headers as Record<string, string>).Actions!;
  assert.match(actions, new RegExp(`^http, Approve, https://ntfy\\.sh/unit7-r-[a-z0-9]+, method=POST, body=approve ${approvalId} ${codeFor(app, o.orgId, approvalId, 'approve')}, clear=true; http, Reject, `));
});

test('the right code decides as the person who set it up; a forged or reused one does nothing', async () => {
  const { app, o, accountId, approvalId } = await waitingApproval();
  assert.match((await handleReply(app, accountId, `approve ${approvalId} ${'x'.repeat(22)}`))!, /wasn’t from Unit7/);
  assert.match((await handleReply(app, accountId, `approve ${approvalId} ${codeFor(app, o.orgId, approvalId, 'reject')}`))!, /wasn’t from Unit7/, 'a Reject code can’t approve');
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM approvals WHERE id = ?', approvalId)!.status, 'pending');
  assert.match((await handleReply(app, accountId, `approve ${approvalId} ${codeFor(app, o.orgId, approvalId, 'approve')}`))!, /^Approved and done: env\.set/);
  assert.equal(get<{ decided_by: string }>(app.db, 'SELECT decided_by FROM approvals WHERE id = ?', approvalId)!.decided_by, 'Ada (from phone)');
  assert.equal(all(app.db, `SELECT 1 FROM env_vars WHERE key = 'LOG_LEVEL'`).length, 1, 'the action ran');
  assert.match((await handleReply(app, accountId, `approve ${approvalId} ${codeFor(app, o.orgId, approvalId, 'approve')}`))!, /already (approved|done)/, 'a code works once');
  assert.equal(await handleReply(app, accountId, 'hello'), undefined, 'other messages are ignored');
});

test('Unit7 listens on the reply channel (outgoing only), resumes where it left off, and confirms on the phone', async () => {
  const { app, o, accountId, approvalId } = await waitingApproval();
  const posted: string[] = [];
  let asked = '';
  const enc = new TextEncoder();
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(init.body)); return new Response('{}'); }
    asked = url;
    const lines = [{ event: 'open' }, { id: 'msg1', event: 'message', message: `reject ${approvalId} ${codeFor(app, o.orgId, approvalId, 'reject')}` }].map((m) => `${JSON.stringify(m)}\n`);
    return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); } }));
  }) as typeof fetch;
  const p = startPhoneApprovals(app, { fetch: fakeFetch });
  for (let i = 0; i < 50 && !posted.length; i++) await new Promise((r) => setTimeout(r, 20));
  p.stop();
  assert.match(asked, /^https:\/\/ntfy\.sh\/unit7-r-[a-z0-9]+\/json\?since=10m$/);
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM approvals WHERE id = ?', approvalId)!.status, 'rejected');
  assert.match(posted[0]!, /^Rejected: env\.set/);
  assert.equal(JSON.parse(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', accountId)!.meta).lastReply, 'msg1', 'a restart resumes after this reply');
});

test('only a person (owner or admin) can turn phone approvals on', async () => {
  const { o } = await waitingApproval();
  assert.notEqual((await o.a('alerts.phone_approvals', { on: true })).status, 'ok');
  assert.equal(ok(await o.h('alerts.phone_approvals', { on: false })).phoneApprovals, false);
});
