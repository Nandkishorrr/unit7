// Auto-sync: the map syncs itself on a schedule each organisation picks (15 minutes … once a day, or off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { syncDue, nextAutoSync } from '../src/tools/map.ts';
import { Warden } from '../src/sentinel/warden.ts';
import { nextSyncWords } from '../web/src/pages/map/data.ts';

const T = Date.parse('2026-01-01T12:00:00.000Z');
const ago = (min: number) => new Date(T - min * 60_000).toISOString();

test('Warden’s decision: due one interval after the last sync started; never synced = now; off = never; never while one runs', () => {
  for (const [every, min] of [['15m', 15], ['1h', 60], ['6h', 360], ['1d', 1440]] as const) {
    assert.equal(syncDue({ every, lastStartedAt: ago(min - 1), running: false }, T), false, `${every}: not yet`);
    assert.equal(syncDue({ every, lastStartedAt: ago(min), running: false }, T), true, `${every}: due`);
    assert.equal(syncDue({ every, lastStartedAt: ago(min + 600), running: true }, T), false, `${every}: one is running`);
    assert.equal(nextAutoSync(every, ago(0), T), T + min * 60_000);
  }
  assert.equal(syncDue({ every: '6h', lastStartedAt: null, running: false }, T), true, 'never synced: now (also right after Unit7 starts)');
  assert.equal(syncDue({ every: 'off', lastStartedAt: null, running: false }, T), false);
  assert.equal(syncDue({ every: 'off', lastStartedAt: ago(100_000), running: false }, T), false);
  assert.equal(nextAutoSync('off', ago(5), T), null);
  assert.equal(nextAutoSync('weekly', ago(0), T), T + 360 * 60_000, 'anything unknown reads as the default');
});

test('the setting: 6 hours by default, saved, validated, owners/admins or an AI within Autopilot; map.get has last and next', async () => {
  const app = testApp(); const o = await testOrg(app);
  assert.equal(ok(await o.h('sync.schedule')).every, '6h');
  assert.equal(ok(await o.h('sync.schedule', { every: '1h' })).every, '1h');
  const bad = await o.h('sync.schedule', { every: 'weekly' });
  assert.equal(bad.status, 'error');
  const dev = await o.as(o.role('developer'))('sync.schedule', { every: 'off' });
  assert.equal(dev.status, 'error', 'a developer can look, not change it');
  assert.equal(ok(await o.as(o.role('developer'))('sync.schedule')).every, '1h');
  assert.equal(ok(await o.a('sync.schedule', { every: '15m' })).every, '15m', 'an AI can, within its Autopilot level');
  run(app.db, 'UPDATE orgs SET paused_at = ? WHERE id = ?', new Date().toISOString(), o.orgId);
  assert.equal((await o.a('sync.schedule', { every: '1d' })).status, 'denied', 'not while Autopilot is paused');
  run(app.db, 'UPDATE orgs SET paused_at = NULL WHERE id = ?', o.orgId);
  ok(await o.h('sync.schedule', { every: '1h' }));

  const started = new Date(Date.now() - 12 * 60_000).toISOString(), finished = new Date(Date.now() - 11 * 60_000).toISOString();
  run(app.db, `INSERT INTO sync_runs (id, org_id, started_at, finished_at, status) VALUES (?, ?, ?, ?, 'done')`, id('syn'), o.orgId, started, finished);
  const m = ok(await o.h('map.get'));
  assert.equal(m.autoSync.every, '1h');
  assert.equal(m.autoSync.lastSyncAt, finished);
  assert.equal(m.autoSync.nextSyncAt, new Date(Date.parse(started) + 3600_000).toISOString());
  assert.equal(nextSyncWords(m.autoSync, Date.parse(started) + 12 * 60_000), 'next in 48m');
  assert.equal(nextSyncWords({ ...m.autoSync, every: '6h', nextSyncAt: new Date(T + (5 * 60 + 48) * 60_000).toISOString() }, T), 'next in 5h 48m');
  assert.equal(nextSyncWords({ ...m.autoSync, every: 'off', nextSyncAt: null }, T), 'auto-sync off');
});

test('Warden syncs an organisation when it’s due, and not when auto-sync is off', async () => {
  const app = testApp(); const o = await testOrg(app);
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug) VALUES (?, ?, 'ntfy', 'Phone', 'phone')`, id('acc'), o.orgId);
  const runs = (status = '%') => get<{ n: number }>(app.db, 'SELECT count(*) n FROM sync_runs WHERE org_id = ? AND status LIKE ?', o.orgId, status)!.n;
  const pause = () => new Promise((r) => setTimeout(r, 300));
  const w = new Warden(app);
  ok(await o.h('sync.schedule', { every: 'off' }));
  await w.sweepNow(); await pause();
  assert.equal(runs(), 0, 'off: nothing');
  ok(await o.h('sync.schedule', { every: '1h' }));
  await w.sweepNow();
  for (let i = 0; i < 50 && runs('done') < 1; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(runs('done'), 1, 'never synced: synced');
  await w.sweepNow(); await pause();
  assert.equal(runs(), 1, 'just synced: not again');
});
