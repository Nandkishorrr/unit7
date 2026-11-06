// Moving between environments and deleting a project, without dead ends:
// - Promote Staging to Production (tools/promote.ts): the dry run says exactly what happens; it ships the commit Staging
//   runs through the normal deploy (deployment.create with that commit and Production's own source); an AI asks first.
// - The guided delete (tools/lifecycle.ts): production running means "stop it first, then delete", step by step; an AI
//   never deletes; archive is recommended when it looks used; project.delete's refusal points at the guided path.
// - Tools keep a log apart from the plain message (error.logTail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { defineTool, getTool } from '../src/tools/runtime.ts';
import { Unit7Error } from '../src/errors.ts';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

async function project(name = 'Harbor') {
  const app = testApp();
  const o = await testOrg(app, 'Sam');
  const { projectId, environments } = ok(await o.h('project.create', { name }));
  const env = (kind: string) => environments.find((e: { kind: string }) => e.kind === kind).id as string;
  const svc = (envId: string, status = 'healthy') => {
    const s = id('svc');
    run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, status, config) VALUES (?, ?, ?, ?, 'web', 'web', 'app', ?, ?)`,
      s, o.orgId, projectId, envId, status, JSON.stringify({ source: { type: 'git', repo: 'https://github.com/example/web', branch: envId === env('production') ? 'main' : 'staging' } }));
    return s;
  };
  const live = (serviceId: string, number: number, plan: object = {}) => {
    const d = id('dep');
    run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, source, plan, container) VALUES (?, ?, ?, ?, 'live', ?, ?, ?)`,
      d, o.orgId, serviceId, number, JSON.stringify({ type: 'git', repo: 'https://github.com/example/web', branch: 'staging' }), JSON.stringify(plan), `unit7-web-${number}`);
    run(app.db, 'UPDATE services SET current_deployment_id = ? WHERE id = ?', d, serviceId);
  };
  return { app, o, projectId, env, svc, live };
}

test('promote: the dry run says what happens, an AI asks first, a person ships Staging’s exact commit through the normal deploy', async () => {
  const { app, o, env, svc, live } = await project();
  const prod = svc(env('production')), stg = svc(env('staging'));
  live(prod, 3, { commit: '0'.repeat(40) });

  // nothing live in Staging yet: nothing to promote, said plainly
  const none = await o.h('deployment.promote', { fromServiceId: stg });
  assert.equal(none.status === 'error' && none.error.code, 'nothing_live');

  live(stg, 7, { commit: SHA });
  const dry = await o.h('deployment.promote', { fromServiceId: stg }, { dryRun: true });
  assert.equal(dry.status, 'dry_run');
  const plan = (dry as { plan: any }).plan;
  assert.equal(plan.to.serviceId, prod, 'its Production copy, found by itself');
  assert.equal(plan.commit, SHA);
  assert.deepEqual([plan.from.version, plan.to.version], [7, 3]);
  assert.match(plan.says, /gets v7 from Staging \(commit a1b2c3d\).*no downtime.*v3 stays ready to roll back/);

  // new code in Production: an AI waits for a person (and can't slip a commit past the gate through deployment.create)
  assert.equal((await o.a('deployment.promote', { fromServiceId: stg })).status, 'approval_required');
  run(app.db, 'UPDATE environments SET autonomy = 4 WHERE id = ?', env('staging'));
  assert.equal((await o.a('deployment.promote', { fromServiceId: stg })).status, 'approval_required', 'even with Staging on full autopilot');
  assert.equal((await o.a('deployment.create', { serviceId: prod, commit: SHA })).status, 'approval_required');

  // a person: the deploy itself is deployment.create with Production's own source and Staging's commit
  const deploy = getTool('deployment.create')!;
  const real = deploy.run;
  const calls: any[] = [];
  deploy.run = (async (_ctx: unknown, i: unknown) => { calls.push(i); return { deploymentId: id('dep'), number: 4, status: 'live' }; }) as typeof real;
  try {
    const r = ok(await o.h('deployment.promote', { fromServiceId: stg }));
    assert.deepEqual(calls, [{ serviceId: prod, source: { type: 'git', repo: 'https://github.com/example/web', branch: 'main' }, commit: SHA }], 'Production keeps following its own branch');
    assert.deepEqual([r.status, r.promoted.from.environment, r.promoted.to.environment], ['live', 'Staging', 'Production']);
  } finally { deploy.run = real; }
});

test('the guided delete: production running is stopped first, then everything goes; an AI never deletes', async () => {
  const { app, o, projectId, env, svc } = await project();
  const prod = svc(env('production')), stg = svc(env('staging'));

  const before = ok(await o.h('asset.impact', { key: projectId }));
  assert.equal(before.can.delete, false);
  assert.match(before.can.why, /Production is live \(web\), so Unit7 stops it first, then deletes everything/);
  assert.deepEqual(before.can.stopFirst, [{ tool: 'service.stop', input: { serviceId: prod }, label: 'Stop web' }], 'only production’s, in order');
  assert.ok(before.deletes.some((d: any) => /an app in staging/.test(d.detail)), 'what goes is listed as if stopped');
  assert.equal(before.recommend.choice, 'delete', 'nothing says it’s in use');

  // an AI: never, even with approval; a person in one go: refused with the way through
  assert.equal((await o.a('asset.delete', { key: projectId, confirmName: 'Harbor' })).status, 'denied');
  const early = await o.h('asset.delete', { key: projectId, confirmName: 'Harbor' });
  assert.equal(early.status === 'error' && early.error.code, 'cant_delete');
  // project.delete on its own isn't a dead end either
  const direct = await o.h('project.delete', { projectId, confirm: 'harbor' });
  assert.match(direct.status === 'error' ? direct.error.message : '', /Unit7 stops production first, then deletes everything.*Or archive it instead/);

  // step 1, stop production; step 2, delete everything
  ok(await o.h(before.can.stopFirst[0].tool, before.can.stopFirst[0].input));
  const after = ok(await o.h('asset.impact', { key: projectId }));
  assert.equal(after.can.delete, true);
  assert.equal(after.can.stopFirst, undefined);
  ok(await o.h('asset.delete', { key: projectId, confirmName: 'Harbor' }));
  assert.equal(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', projectId), undefined);
  assert.equal(get(app.db, `SELECT 1 FROM services WHERE id IN (?, ?)`, prod, stg), undefined, 'both apps went with it');
});

test('archive is the recommended way out when it looks used; the chat card only works in the ask box', async () => {
  const { o, projectId, env, svc } = await project('Shop');
  svc(env('production'));
  ok(await o.h('asset.keep', { key: projectId }));
  const i = ok(await o.h('asset.impact', { key: projectId }));
  assert.equal(i.recommend.choice, 'archive');
  assert.match(i.recommend.why, /you marked it in use/);
  // ui.delete is the AI's way to offer it: outside Unit7's ask box it says to ask in words
  const r = await o.a('ui.delete', { key: projectId });
  assert.equal(r.status === 'error' && r.error.code, 'not_here');
});

test('a log behind an error rides apart from the plain message', async () => {
  defineTool({
    name: 'test.loggy', title: 'A tool that fails with a log', description: 'test only', risk: 'read', action: 'read', input: z.object({}),
    run() { throw new Unit7Error('build_failed', 'The build failed.', 400, { logTail: '#12 RUN pnpm install\nnpm ERR! code EACCES' }); },
  });
  const app = testApp();
  const o = await testOrg(app);
  const r = await o.h('test.loggy');
  assert.equal(r.status, 'error');
  if (r.status !== 'error') return;
  assert.equal(r.error.message, 'The build failed.');
  assert.equal(r.error.logTail, '#12 RUN pnpm install\nnpm ERR! code EACCES');
});
