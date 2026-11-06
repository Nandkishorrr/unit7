// Watching everything from the outside: down only after two failed checks, back-up notices, and
// registration / certificate alerts once per threshold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { testApp, testOrg } from './helpers.ts';
import { all, id, now, run } from '../src/db.ts';
import { checkSites, checkDaily, watchIssues } from '../src/sentinel/watch.ts';

const online = { neutral: async () => true, inside: async () => new Set<string>() }; // this computer's connection is fine
const events = (app: ReturnType<typeof testApp>, type: string) => all<{ message: string }>(app.db, 'SELECT message FROM events WHERE type = ?', type).map((e) => e.message);
const asset = (app: ReturnType<typeof testApp>, orgId: string, kind: string, name: string, url: string | null, meta: object) =>
  run(app.db, 'INSERT INTO assets (id, org_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id('ast'), orgId, kind === 'domain' ? 'domain' : 'vercel', kind, name, name, url, JSON.stringify(meta), now());

test('a site is "down" only after two failed checks, and says when it is back', async (t) => {
  if (!(await lookup('github.com').then(() => true, () => false))) return t.skip('offline');
  const app = testApp(); const o = await testOrg(app);
  asset(app, o.orgId, 'app', 'shop', 'https://github.com', {});
  const real = globalThis.fetch;
  let answer = 200;
  globalThis.fetch = (async () => (answer ? new Response('ok', { status: answer }) : Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })))) as typeof fetch;
  try {
    await checkSites(app, o.orgId, online);
    answer = 0; await checkSites(app, o.orgId, online);
    assert.deepEqual(events(app, 'site.down'), [], 'one failure is a blip');
    await checkSites(app, o.orgId, online);
    assert.match(events(app, 'site.down')[0]!, /github\.com \(shop\) isn’t answering: ECONNREFUSED/);
    assert.match(watchIssues(app, o.orgId)[0]!.text, /github\.com is down/);
    await checkSites(app, o.orgId, online);
    assert.equal(events(app, 'site.down').length, 1, 'one alert, not one per check');
    answer = 404; await checkSites(app, o.orgId, online); // a 404 at the root is still a working site
    assert.match(events(app, 'site.recovered')[0]!, /answering again/);
  } finally { globalThis.fetch = real; }
});

test('a domain about to lapse alerts once per threshold; auto-renew changes how early', async () => {
  const app = testApp(); const o = await testOrg(app);
  const inDays = (d: number) => new Date(Date.now() + d * 86400_000 + 3600_000).toISOString();
  asset(app, o.orgId, 'domain', 'shop.com', null, { expires: inDays(5), autoRenew: false, registrar: 'godaddy' });
  asset(app, o.orgId, 'domain', 'blog.com', null, { expires: inDays(20), autoRenew: true, registrar: 'hostinger' });
  asset(app, o.orgId, 'domain', 'old.com', null, { expires: inDays(20), autoRenew: false, registrar: 'porkbun' });
  await checkDaily(app, o.orgId);
  await checkDaily(app, o.orgId);
  const alerts = events(app, 'domain.expiring');
  assert.equal(alerts.length, 2, 'shop.com (5 days) and old.com (20 days, no auto-renew); each once');
  assert.ok(alerts.some((a) => /shop\.com expires in 5 days at godaddy and auto-renew is off/.test(a)));
  assert.ok(!alerts.some((a) => /blog\.com/.test(a)), 'auto-renew on: no alert until 7 days');
  const issues = watchIssues(app, o.orgId);
  assert.equal(issues[0]!.severity, 'critical');
  assert.match(issues[0]!.text, /shop\.com/);
});
