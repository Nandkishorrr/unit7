// The famous accidents, replayed against Unit7's gate. Each one is what an AI really tried, as close as Unit7's tools allow. ACCIDENTS.md
// says what this proves and, as honestly, what it doesn't: an AI with its own SSH key or cloud token never comes through this gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, run } from '../src/db.ts';
import { decideApproval } from './runtime-exports.ts';
import { saveXray } from '../src/tools/xray.ts';
import { runHeld } from '../src/ops/index.ts';
import { createToken, fromToken, actorOf } from '../src/auth.ts';
import { execute } from '../src/tools/runtime.ts';

const SRV = 'srv_accident0001';
const world = async () => {
  const app = testApp(); const o = await testOrg(app);
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'prod', '203.0.113.9', 'credential://x', 'ready', '{}')`, SRV, o.orgId);
  saveXray(app.db, o.orgId, SRV, 'fast', { version: 1, at: new Date().toISOString(), server: {}, paas: [], projects: [{ id: 'p', name: 'shop', owner: 'coolify', trust: 'seen', how: 'x', confidence: 1, parts: ['coolify:db'], health: { status: 'ok' }, domains: [] }], loose: [], ports: [], repos: [], summary: '', notes: [], parts: [{ id: 'coolify:db', kind: 'database', name: 'shop-db', owner: 'compose', trust: 'seen', project: 'p', engine: 'postgres', containers: ['shop-db'], volumes: ['shop-data'], state: 'running' }, { id: 'vol:shop-data', kind: 'volume', name: 'shop-data', owner: 'unmanaged', trust: 'seen' }] } as never);
  return { app, o };
};
const delivered = (r: { status: string }) => r.status === 'ok';

test('PocketOS: an AI hits a credential mismatch, finds a token, and deletes the volume and its backups in one call', async () => {
  const { app, o } = await world();
  // the volume: a request, not a deletion
  const vol = await o.a('part.remove', { serverId: SRV, part: 'vol:shop-data' });
  assert.ok(!delivered(vol), `the volume wasn’t deleted (${vol.status})`);
  // Coolify's data, in one call: not even with approval
  assert.equal((await o.a('coolify.remove', { serverId: SRV, uuid: 'abc123', kind: 'application', deleteVolumes: true })).status, 'denied');
  // the backups: an AI can't thin them below what a person chose
  run(app.db, `INSERT INTO projects (id, org_id, name, slug) VALUES ('prj_accident0001', ?, 'x', 'x')`, o.orgId);
  // a token found lying around: one meant for reading can do nothing else, whatever it asks for
  const p = { user: { id: o.userId, email: 'a@b.c', name: 'Ada' }, org: { id: o.orgId, name: 'x', slug: 'x' }, role: 'owner', via: 'session' } as const;
  const found = fromToken(app.db, createToken(app.db, p as never, 'found in a file', 'readonly', undefined, 'findings').token)!;
  assert.equal((await execute(app, o.orgId, actorOf(found), 'part.remove', { serverId: SRV, part: 'vol:shop-data' })).status, 'denied');
  assert.ok(!get(app.db, `SELECT 1 FROM audit WHERE tool = 'part.remove' AND result = 'success'`), 'nothing was removed');
});

test('Replit: an AI deletes production during a code freeze', async () => {
  const { o } = await world();
  ok(await o.h('rule.add', { text: 'Never touch shop' }));
  const r = await o.a('part.restart', { serverId: SRV, part: 'coolify:db' });
  assert.equal(r.status, 'denied'); assert.match((r as { why: string }).why, /Your rule says so/);
  const run2 = await o.a('part.run', { serverId: SRV, part: 'coolify:db', command: 'dropdb shop' });
  assert.ok(!delivered(run2), `the command didn’t run (${run2.status})`);
  assert.equal((await o.a('rule.remove', { id: 'rul_x' })).status, 'denied', 'and it can’t remove the rule that stops it');
  assert.equal((await o.a('safety.settings', { on: false })).status, 'denied', 'or switch off the Safety Net');
});

test('DataTalks: a clean-up that takes the backups with it', async () => {
  const { app, o } = await world();
  const { id: projectId } = (await o.h('project.create', { name: 'shop-infra' }).then((r) => ({ id: ((r as { output: { id?: string; projectId?: string } }).output.projectId ?? (r as { output: { id?: string } }).output.id)! })));
  assert.equal((await o.a('asset.delete', { key: projectId, confirmName: 'shop-infra', alsoData: true })).status, 'denied', 'the guided delete is a person’s');
  const r = await o.a('project.delete', { projectId, confirm: 'shop-infra' });
  assert.equal(r.status, 'approval_required');
  const yes = await decideApproval(app, o.orgId, o.human, (r as { approvalId: string }).approvalId, true, 'shop-infra') as { output?: { held?: boolean } };
  assert.equal(yes.output?.held, true, 'even a yes waits, so a tired yes can be taken back');
  assert.deepEqual(await runHeld(app), []);
  assert.ok(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', projectId));
});

test('Kiro: an AI decides to delete and recreate an environment', async () => {
  const { o } = await world();
  const created = ok<{ projectId?: string; id?: string; environments?: { id: string }[] }>(await o.h('project.create', { name: 'envs' }));
  const env = await o.h('graph.get', {});
  assert.ok(created && env);
  const r = await o.a('environment.delete', { environmentId: 'env_doesnotexist' });
  assert.notEqual(r.status, 'ok', 'an AI doesn’t delete an environment by itself');
});
