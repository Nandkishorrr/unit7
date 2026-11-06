// The monthly budget: forecast arithmetic, one warning per month, people-only settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { all } from '../src/db.ts';
import { forecast } from '../src/tools/budget.ts';

test('usage is projected from the days so far; fixed prices count once', () => {
  const day11 = new Date(Date.UTC(2026, 10, 11)); // 10 of November's 30 days gone
  const f = forecast([{ amount: 50, kind: 'spent' }, { amount: 20, kind: 'monthly' }], day11);
  assert.equal(Math.round(f.forecast), 170, '50 used in a third of the month → 150, plus 20 fixed');
  assert.equal(Math.round(f.soFar), 57, '50 used + a third of the 20 fixed');
});

test('on course for 90% of the budget: one warning this month, not one per check', async () => {
  const app = testApp(); const o = await testOrg(app);
  assert.notEqual((await o.a('budget.set', { monthly: 1000 })).status, 'ok', 'only a person sets the budget');
  ok(await o.h('budget.set', { monthly: 1000, currency: 'USD', manual: [{ label: 'Supabase Team', monthly: 900 }], scaleDown: true }));
  const r = ok(await o.a('budget.check', {}));
  assert.equal(r.forecast, 900);
  assert.equal(r.level, 'warning');
  ok(await o.a('budget.check', {}));
  const warnings = all<{ message: string }>(app.db, `SELECT message FROM events WHERE type = 'budget.warning'`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message, /on course for 900\.00 USD this month, 90% of your 1000\.00 USD budget/);
  const view = (await import('../src/tools/autopilot.ts')).autopilotView(app.db, o.orgId).budget;
  assert.equal(view.costs[0].label, 'Supabase Team');
});
