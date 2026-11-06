// Alerts: only what needs a person, scrubbed of secrets, once per 10 minutes, in each channel's format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { deliver, testAlerts } from '../src/sentinel/notify.ts';
import { setupNtfy } from '../src/connectors/oneclick.ts';

test('alerts reach ntfy, Slack and Discord; scrubbed; not repeated; quiet events stay quiet', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { subscribeUrl } = setupNtfy(app, o.orgId);
  assert.match(subscribeUrl, /^https:\/\/ntfy\.sh\/unit7-[a-z0-9]{20,}$/);
  // connecting a team chat sends it a test message (faked here: no real Slack or Discord)
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
  try {
    ok(await o.h('account.connect', { provider: 'webhook', token: 'https://hooks.slack.com/services/T000/B000/xyz' }));
    ok(await o.h('account.connect', { provider: 'webhook', token: 'https://discord.com/api/webhooks/123/abc' }));
  } finally { globalThis.fetch = realFetch; }

  const sent: { url: string; init: RequestInit }[] = [];
  const send = async (url: string, init: RequestInit) => { sent.push({ url, init }); };
  const ev = (type: string, message: string, resource = 'svc_x') => ({ id: 'e', org_id: o.orgId, type, severity: 'critical' as const, message, project_id: null, environment_id: null, resource, data: {}, created_at: new Date().toISOString() });

  // a token that slipped into an event message never leaves Unit7
  const leaked = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  assert.equal(await deliver(app, ev('service.down', `shop is down (auth ${leaked})`), send), 3);
  const ntfy = sent.find((x) => x.url === subscribeUrl)!;
  assert.equal((ntfy.init.headers as Record<string, string>).Title, 'Unit7: App down');
  assert.equal((ntfy.init.headers as Record<string, string>).Priority, '5');
  assert.match(String(ntfy.init.body), /shop is down \(auth \[redacted github token\]\)/);
  assert.ok(!sent.some((x) => String(x.init.body).includes(leaked)));
  assert.match(String(sent.find((x) => x.url.includes('slack'))!.init.body), /"text":"\*Unit7: App down\*/);
  assert.match(String(sent.find((x) => x.url.includes('discord'))!.init.body), /"content":"\*\*Unit7: App down\*\*/);

  // the same alert about the same thing within 10 minutes: not again
  sent.length = 0;
  assert.equal(await deliver(app, ev('service.down', 'shop is still down'), send), 0);
  // routine events never buzz
  assert.equal(await deliver(app, ev('deployment.succeeded', 'shop deploy #4 is live'), send), 0);
  // "send a test" always goes through
  assert.equal(await testAlerts(app, o.orgId, send), 3);
});
