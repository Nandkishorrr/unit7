// Errors from apps on other hosts: grouped like local ones, alerted once, secrets scrubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, id, now, run } from '../src/db.ts';
import { eventsFrom } from '../src/tools/hosterrors.ts';

test('stack traces become one error; host-labelled error lines count even without one', () => {
  const at = now();
  const trace = ["TypeError: Cannot read properties of undefined (reading 'id')", '    at handler (/app/src/api.js:12:5)', '    at node:internal/process/task_queues:95:5'].map((text) => ({ at, text }));
  assert.deepEqual(eventsFrom(trace, trace, (s) => s).map((e) => [e.kind, e.frame]), [['TypeError', 'src/api.js:12']]);
  const plain = [{ at, text: 'payment webhook failed for order 1234' }];
  assert.deepEqual(eventsFrom(plain, plain, (s) => s).map((e) => [e.kind, e.message]), [['Logged error', 'payment webhook failed for order 1234']]);
});

test('a new error repeating on a Render app: one group, one alert; later hits just count', async (t) => {
  if (!(await lookup('api.render.com').then(() => true, () => false))) return t.skip('offline');
  const app = testApp(); const o = await testOrg(app);
  const acc = ok(await o.h('account.connect', { provider: 'render', token: 'rnd_testtoken123' })).accountId;
  const asset = id('ast');
  run(app.db, 'INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', asset, o.orgId, acc, 'render', 'app', 'srv-1', 'shop-api', null,
    JSON.stringify({ end: { kind: 'render', accountId: acc, service: 'srv-1' } }), now());
  const real = globalThis.fetch;
  const lines = (n: number) => Array.from({ length: n }, () => ["TypeError: Cannot read properties of undefined (reading 'id') token=sk_live_abcdef1234567890", '    at handler (/app/src/api.js:12:5)']).flat()
    .map((message, i) => ({ id: String(i), message, timestamp: now() }));
  let batch = lines(3);
  globalThis.fetch = (async (url: string) => {
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (url === 'https://api.render.com/v1/services/srv-1') return json({ id: 'srv-1', name: 'shop-api', ownerId: 'tea-1' });
    if (url.startsWith('https://api.render.com/v1/logs?')) { assert.match(url, /level=error/); return json({ hasMore: false, logs: batch }); }
    return json({});
  }) as typeof fetch;
  try {
    const r = ok(await o.a('errors.scan_hosts', {}));
    assert.equal(r.newErrors, 1);
    const alerts = all<{ message: string }>(app.db, `SELECT message FROM events WHERE type = 'app.errors'`);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.message, /shop-api: TypeError: Cannot read properties of undefined/);
    batch = lines(2);
    ok(await o.a('errors.scan_hosts', {}));
    assert.equal(all(app.db, `SELECT 1 FROM events WHERE type = 'app.errors'`).length, 1, 'no second alert');
    const g = ok(await o.a('errors.hosts', {}));
    assert.equal(g.length, 1);
    assert.equal(g[0].count, 5);
    assert.equal(JSON.stringify(g).includes('sk_live_abcdef1234567890'), false, 'secrets scrubbed from samples');
  } finally { globalThis.fetch = real; }
});
