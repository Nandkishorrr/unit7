// Autoscaling decisions: up when slow or busy, down after 30 calm minutes, within min/max, no flapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { run } from '../src/db.ts';
import { decide } from '../src/sentinel/autoscale.ts';

const a = { on: true, min: 1, max: 3 };
const calm = { requests: 600, p95: 120, cpu: 12 };
test('slow or busy adds a copy; calm for 30 minutes removes one; limits and cool-downs hold', () => {
  assert.deepEqual(decide(1, a, { requests: 900, p95: 1400, cpu: 40 }, calm), { replicas: 2, why: 'responses are slow (p95 1400 ms)' });
  assert.equal(decide(1, a, { requests: 3, p95: 5000, cpu: 20 }, calm).replicas, 1, 'a few slow requests are not a trend');
  assert.match(decide(2, a, { requests: 50, p95: 200, cpu: 91 }, calm).why, /busy \(CPU 91%\)/);
  assert.equal(decide(3, a, { requests: 900, p95: 2000, cpu: 95 }, calm).replicas, 3, 'never past the maximum, and never shrinks while busy');
  assert.equal(decide(2, { ...a, lastChange: new Date(Date.now() - 2 * 60_000).toISOString() }, { requests: 900, p95: 2000 }, calm).replicas, 2, '5 minutes between scale-ups');
  assert.deepEqual(decide(3, a, { requests: 100, p95: 150, cpu: 10 }, calm), { replicas: 2, why: 'calm for 30 minutes' });
  assert.equal(decide(3, { ...a, lastChange: new Date(Date.now() - 10 * 60_000).toISOString() }, calm, calm).replicas, 3, '15 minutes between scale-downs');
  assert.equal(decide(1, a, calm, calm).replicas, 1, 'never below the minimum');
  assert.equal(decide(2, a, calm, { requests: 600, p95: 450, cpu: 12 }).replicas, 2, 'not calm enough to shrink');
});

test('apps that can’t run as several copies can’t be autoscaled', async () => {
  const app = testApp(); const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'Shop', environments: ['staging'] })).environments[0].id;
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'ada/web' } })).serviceId;
  run(app.db, `UPDATE services SET config = json_set(config, '$.detection', json('{"scaleRisks":["sessions are kept in memory"]}')) WHERE id = ?`, svc);
  const r = await o.h('service.autoscale', { serviceId: svc, on: true, min: 1, max: 3 });
  assert.equal(r.status, 'error');
  assert.match((r as any).error.message, /sessions are kept in memory/);
  assert.equal(ok(await o.h('service.autoscale', { serviceId: svc, on: false })).autoscale, 'off');
});
