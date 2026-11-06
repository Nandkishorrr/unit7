// Earned autonomy: approved requests raise the level (never past the ceiling), rejections lower it at once,
// and with the switch off nothing moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok, setAutonomy } from './helpers.ts';
import { get, run } from '../src/db.ts';
import { decideApproval } from '../src/tools/runtime.ts';
import { earnedCheck } from '../src/tools/autopilot.ts';

async function setup() {
  const app = testApp(); const o = await testOrg(app);
  const env = ok(await o.h('project.create', { name: 'Shop', environments: ['staging'] })).environments[0].id;
  setAutonomy(app, env, 1); // Recommend: every AI change asks
  const ask = async (n: number, approve: boolean) => {
    for (let i = 0; i < n; i++) {
      const r = await o.a('env.set', { environmentId: env, key: `K${Math.random().toString(36).slice(2, 8)}`, value: 'v' });
      assert.equal(r.status, 'approval_required');
      await decideApproval(app, o.orgId, o.human, (r as any).approvalId, approve);
    }
  };
  const level = () => get<{ autonomy: number }>(app.db, 'SELECT autonomy FROM environments WHERE id = ?', env)!.autonomy;
  const weekAgo = () => run(app.db, 'UPDATE environments SET earn_changed_at = ? WHERE id = ?', new Date(Date.now() - 8 * 86400_000).toISOString(), env);
  return { app, o, env, ask, level, weekAgo };
}

test('approved requests raise it one step after a quiet week; never past the ceiling; rejections lower it at once', async () => {
  const { app, o, env, ask, level, weekAgo } = await setup();
  ok(await o.h('environment.earn', { environmentId: env, on: true, cap: 2 }));
  await ask(8, true);
  assert.equal(earnedCheck(app, env)!.to, 1, 'not before a week has passed');
  weekAgo();
  const up = earnedCheck(app, env)!;
  assert.equal(level(), 2);
  assert.match(up.why, /8 of its requests approved, none rejected/);
  weekAgo();
  assert.equal(earnedCheck(app, env)!.to, 2, 'the ceiling is 2');
  // at level 2 staging changes run on their own; make it ask again with a restricted action to collect rejections
  run(app.db, `UPDATE environments SET rules = '{"env_write":"restricted"}' WHERE id = ?`, env);
  await ask(2, false);
  const down = earnedCheck(app, env)!;
  assert.equal(level(), 1);
  assert.match(down.why, /2 of its requests were rejected this week/);
});

test('switched off, the level stays where a person put it; only a person can switch it', async () => {
  const { app, o, env, ask, level, weekAgo } = await setup();
  await ask(8, true); weekAgo();
  assert.equal(earnedCheck(app, env), undefined);
  assert.equal(level(), 1);
  assert.notEqual((await o.a('environment.earn', { environmentId: env, on: true })).status, 'ok');
});
