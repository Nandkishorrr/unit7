import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { testApp, testOrg, ok, setAutonomy } from './helpers.ts';
import { all, get, run, openDb } from '../src/db.ts';
import { unit7Home } from '../src/cli/client.ts';
import { Vault, loadMasterKey, keychain } from '../src/vault.ts';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Redactor, detectSecrets } from '../src/redact.ts';
import { decide } from '../src/policy.ts';
import { decideApproval, defineTool } from '../src/tools/runtime.ts';
import { parseDotenv } from '../src/tools/env.ts';
import { z } from 'zod';

test('vault: versions, integrity binding and rekey', async () => {
  const app = testApp();
  const { orgId } = await testOrg(app);
  const other = await testOrg(app, 'Bob');
  const ref = 'credential://cloudflare/client-a/token';
  app.vault.put(orgId, ref, 'first-secret-value');
  app.vault.put(orgId, ref, 'second-secret-value');
  assert.equal(app.vault.resolve(orgId, ref), 'second-secret-value');
  assert.deepEqual(app.vault.history(orgId, ref).map((h) => h.version), [2, 1]);
  assert.equal(app.vault.list(orgId)[0]!.hint, '…alue');

  // a row moved to another tenant must not decrypt
  run(app.db, `UPDATE secrets SET org_id = ? WHERE org_id = ? AND retired_at IS NULL`, other.orgId, orgId);
  assert.throws(() => app.vault.resolve(other.orgId, ref), /integrity check/);
  run(app.db, `UPDATE secrets SET org_id = ? WHERE org_id = ?`, orgId, other.orgId);

  // a flipped ciphertext byte must not decrypt
  const row = get<{ id: string; ciphertext: Uint8Array }>(app.db, 'SELECT id, ciphertext FROM secrets WHERE version = 2')!;
  const bad = Buffer.from(row.ciphertext); bad[bad.length - 1]! ^= 1;
  run(app.db, 'UPDATE secrets SET ciphertext = ? WHERE id = ?', bad, row.id);
  assert.throws(() => app.vault.resolve(orgId, ref), /integrity check/);
  run(app.db, 'UPDATE secrets SET ciphertext = ? WHERE id = ?', row.ciphertext, row.id);

  // restore an old version, then rekey and read back
  app.vault.restore(orgId, ref, 1);
  assert.equal(app.vault.resolve(orgId, ref), 'first-secret-value');
  const next = randomBytes(32);
  app.vault.rekey(next);
  assert.equal(new Vault(app.db, next).resolve(orgId, ref), 'first-secret-value');
  assert.throws(() => app.vault.put(orgId, 'not-a-ref', 'x'), /credential reference/);
});

test('a missing Unit7 home fails loudly instead of creating ./undefined/unit7.db', () => {
  assert.throws(() => openDb('undefined/unit7.db'), /must be absolute/);
  const prev = process.env.UNIT7_HOME;
  process.env.UNIT7_HOME = 'undefined'; // what `process.env.UNIT7_HOME = someUndefined` leaves behind
  try { assert.throws(() => unit7Home(), /must be an absolute path/); }
  finally { if (prev === undefined) delete process.env.UNIT7_HOME; else process.env.UNIT7_HOME = prev; }
  assert.equal(existsSync('undefined'), false);
});

test('redactor: known values and secret shapes', () => {
  const r = new Redactor();
  r.add('hunter2-is-my-password', 'credential://ssh/prod/key');
  const out = r.redact('pw=hunter2-is-my-password url=postgres://app:s3cretpw@db:5432/x key=sk-ant-abcdefghijklmnopqrstuvwxyz123 ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  assert.ok(!out.includes('hunter2'));
  assert.ok(out.includes('postgres://app:[redacted]@db'));
  assert.ok(!out.includes('sk-ant-'));
  assert.ok(!out.includes('ghp_'));
  assert.deepEqual(detectSecrets('AKIAABCDEFGHIJKLMNOP'), ['aws key']);
  assert.deepEqual(detectSecrets('hello world'), []);
});

test('policy: autonomy levels and rules', () => {
  const prod = { kind: 'production' as const, autonomy: 2, rules: {}, name: 'Production' };
  const dev = { kind: 'development' as const, autonomy: 3, rules: {}, name: 'Development' };
  const d = (x: Partial<Parameters<typeof decide>[0]>) => decide({ actor: 'agent', role: 'agent', risk: 'write', action: 'x', env: prod, ...x }).decision;
  assert.equal(d({ risk: 'read' }), 'allow');
  assert.equal(d({ action: 'deploy' }), 'allow');                       // production allows deploy explicitly
  assert.equal(d({ action: 'env_write' }), 'approve');                  // other prod writes need approval at level 2
  assert.equal(d({ action: 'drop_database', risk: 'destructive' }), 'deny');
  assert.equal(d({ action: 'drop_database', risk: 'destructive', actor: 'human', role: 'owner' }), 'deny'); // prohibited for everyone
  assert.equal(d({ env: dev, action: 'env_write' }), 'allow');
  assert.equal(d({ env: dev, risk: 'destructive' }), 'approve');
  assert.equal(d({ env: { ...dev, autonomy: 0 } }), 'deny');
  assert.equal(d({ env: { ...dev, autonomy: 1 } }), 'approve');
  assert.equal(d({ env: { ...dev, autonomy: 4 }, risk: 'destructive' }), 'allow');
  assert.equal(d({ env: { ...dev, autonomy: 4 }, action: 'drop_database', risk: 'destructive' }), 'approve'); // restricted in dev
  assert.equal(d({ actor: 'human', role: 'readonly' }), 'deny');
  assert.equal(d({ actor: 'human', role: 'developer', risk: 'destructive' }), 'approve');
  assert.equal(d({ actor: 'human', role: 'admin', risk: 'destructive' }), 'allow');
});

test('tenant isolation: another org cannot see or touch your resources', async () => {
  const app = testApp();
  const a = await testOrg(app, 'Ada');
  const b = await testOrg(app, 'Bob');
  const { projectId } = ok(await a.h('project.create', { name: 'Shop' }));
  const r = await b.h('project.update', { projectId, name: 'pwned' });
  assert.equal(r.status, 'error');
  assert.equal((r as any).error.code, 'not_found');
  assert.equal(ok<any[]>(await b.h('project.list')).length, 0);
  assert.equal(get<{ name: string }>(app.db, 'SELECT name FROM projects WHERE id = ?', projectId)!.name, 'Shop');
  // ids must be Unit7 ids
  assert.equal((await b.h('project.update', { projectId: 'x' })).status, 'error');
});

test('project.delete: never while production runs something, only once it is empty', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { projectId, environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const envOf = (kind: string) => environments.find((e: any) => e.kind === kind).id;
  const addSvc = (envId: string, name: string) => run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind) VALUES (?, ?, ?, ?, ?, ?, 'app')`, `svc_${name}`, o.orgId, projectId, envId, name, name);
  const code = async () => ((await o.h('project.delete', { projectId, confirm: 'shop' })) as any).error?.code;

  addSvc(envOf('production'), 'web');
  addSvc(envOf('staging'), 'preview');
  assert.equal(await code(), 'production_live');
  run(app.db, `DELETE FROM services WHERE id = 'svc_web'`);
  assert.equal(await code(), 'not_empty'); // staging still runs: remove it first
  run(app.db, `DELETE FROM services WHERE id = 'svc_preview'`);
  assert.equal(((await o.h('project.delete', { projectId, confirm: 'nope' })) as any).error?.code, 'confirm_mismatch');
  assert.deepEqual(ok(await o.h('project.delete', { projectId, confirm: 'shop' })), { deleted: 'shop' });
  assert.equal(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', projectId), undefined);
});

test('approvals: agent destructive action waits for a person, runs once', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { projectId, environments } = ok(await o.h('project.create', { name: 'Api' }));
  const prodEnv = environments.find((e: any) => e.kind === 'production').id;
  setAutonomy(app, prodEnv, 2);
  const r = await o.a('env.set', { environmentId: prodEnv, key: 'LOG_LEVEL', value: 'debug' });
  assert.equal(r.status, 'approval_required');
  const approvalId = (r as any).approvalId;
  assert.equal(all(app.db, 'SELECT 1 FROM env_vars').length, 0);
  // agents can't approve, developers can't approve production
  await assert.rejects(decideApproval(app, o.orgId, o.agent, approvalId, true), /Only a person/);
  await assert.rejects(decideApproval(app, o.orgId, o.role('developer'), approvalId, true), /owner or admin/);
  const done = await decideApproval(app, o.orgId, o.human, approvalId, true);
  assert.equal(done.status, 'ok');
  assert.equal(all(app.db, 'SELECT 1 FROM env_vars').length, 1);
  await assert.rejects(decideApproval(app, o.orgId, o.human, approvalId, true), /already/);
  const replay = await o.a('env.set', { environmentId: prodEnv, key: 'LOG_LEVEL', value: 'debug' }, { approvalId });
  assert.equal((replay as any).error?.code, 'approval_invalid');
  // agents can't raise their own autonomy
  const pol = await o.a('environment.policy', { environmentId: prodEnv, autonomy: 4 });
  assert.ok(pol.status !== 'ok');
  void projectId;
});

test('audit: every action recorded, secrets never stored', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { projectId } = ok(await o.h('project.create', { name: 'Web' }));
  ok(await o.h('env.set', { projectId, key: 'STRIPE_SECRET_KEY', value: 'sk_live_51ABCDEFGHIJKLMNOPQRSTUV' }));
  ok(await o.h('vault.set', { ref: 'credential://stripe/main/key', value: 'very-secret-value-123' }));
  const rows = all<{ input: string; output: string | null; tool: string }>(app.db, 'SELECT tool, input, output FROM audit');
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes('sk_live_51'));
  assert.ok(!blob.includes('very-secret-value-123'));
  assert.ok(rows.some((r) => r.tool === 'env.set'));
});

test('broker: an environment never uses another account\'s credential', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Client A site' }));
  const env = environments[0].id;
  const a = ok(await o.h('account.connect', { provider: 'cloudflare', name: 'Client A', token: 'token-for-client-a-0000' }));
  ok(await o.h('account.connect', { provider: 'cloudflare', name: 'Client B', token: 'token-for-client-b-0000' }));
  ok(await o.h('account.bind', { environmentId: env, accountId: a.accountId }));
  defineTool({
    name: 'test.use_secret', title: 'Use a secret', risk: 'read', action: 'read', description: 'test',
    input: z.object({ environmentId: z.string(), ref: z.string() }),
    run: (ctx, i) => ({ length: ctx.secret(i.ref).length, account: ctx.credentialFor('cloudflare').account.name }),
  });
  assert.deepEqual(ok(await o.h('test.use_secret', { environmentId: env, ref: 'credential://cloudflare/client-a/token' })), { length: 23, account: 'Client A' });
  const crossed = await o.h('test.use_secret', { environmentId: env, ref: 'credential://cloudflare/client-b/token' });
  assert.equal(crossed.status, 'error');
  assert.match((crossed as any).error.message, /will not use "client-b"/);
});

test('env engine: inheritance, detection, public-prefix warning, reveal', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { projectId, environments } = ok(await o.h('project.create', { name: 'Shop', environments: ['development'] }));
  const env = environments[0].id;
  ok(await o.h('env.set', { key: 'LOG_LEVEL', value: 'info' }));
  ok(await o.h('env.set', { projectId, key: 'LOG_LEVEL', value: 'warn' }));
  ok(await o.h('env.set', { environmentId: env, key: 'APP_NAME', value: 'shop-dev' }));
  const warn = ok(await o.h('env.set', { environmentId: env, key: 'NEXT_PUBLIC_STRIPE_KEY', value: 'sk_live_51ABCDEFGHIJKLMNOPQRSTUV' }));
  assert.equal(warn.secret, true);
  assert.match(warn.warnings[0], /browser bundle/);
  const vars = ok(await o.h('env.list', { environmentId: env })).variables;
  const lvl = vars.find((v: any) => v.key === 'LOG_LEVEL');
  assert.equal(lvl.value, 'warn');
  assert.deepEqual(lvl.overrides, ['org']);
  assert.ok(!JSON.stringify(vars).includes('sk_live_51ABC'));
  // reveal: people yes (owner), agents no
  assert.equal(ok(await o.h('env.reveal', { environmentId: env, key: 'NEXT_PUBLIC_STRIPE_KEY' })).value, 'sk_live_51ABCDEFGHIJKLMNOPQRSTUV');
  const agentTry = await o.a('env.reveal', { environmentId: env, key: 'NEXT_PUBLIC_STRIPE_KEY' });
  assert.notEqual(agentTry.status, 'ok');
  // .env import
  assert.deepEqual(parseDotenv('# c\nexport A=1\nB="two\\nlines" # note\nC=\'lit $x\'\nD=x # y\n'), { A: '1', B: 'two\nlines', C: 'lit $x', D: 'x' });
  const imp = ok(await o.h('env.import', { environmentId: env, dotenv: 'DATABASE_URL=postgres://u:p@h/db\nPORT=3000\n' }));
  assert.deepEqual(imp.secrets, ['DATABASE_URL']);
  // history + restore
  ok(await o.h('env.set', { environmentId: env, key: 'PORT', value: '4000' }));
  ok(await o.h('env.restore', { environmentId: env, key: 'PORT', version: 1 }));
  assert.equal(ok(await o.h('env.list', { environmentId: env })).variables.find((v: any) => v.key === 'PORT').value, '3000');
});

test('runtime: dry run changes nothing; timeouts stop slow tools', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const dry = await o.h('project.create', { name: 'Dry' }, { dryRun: true });
  assert.equal(dry.status, 'dry_run');
  assert.equal(ok<any[]>(await o.h('project.list')).length, 0);
  defineTool({
    name: 'test.slow', title: 'Slow thing', risk: 'read', action: 'read', description: 'test', timeoutMs: 50,
    input: z.object({}), run: () => new Promise((r) => setTimeout(r, 1000)),
  });
  const slow = await o.h('test.slow');
  assert.equal((slow as any).error.code, 'timeout');
  void setAutonomy;
});

// Touches the real login Keychain, so it only runs when asked: UNIT7_TEST_KEYCHAIN=1 npm test
test('master key moves from the key file into the macOS Keychain', { skip: process.platform !== 'darwin' || !process.env.UNIT7_TEST_KEYCHAIN }, () => {
  const home = mkdtempSync(join(tmpdir(), 'unit7-kc-'));
  const old = randomBytes(32);
  writeFileSync(join(home, 'master.key'), old, { mode: 0o600 });
  try {
    assert.ok(loadMasterKey(home).equals(old));
    assert.equal(existsSync(join(home, 'master.key')), false);
    assert.ok(keychain.get(home)?.equals(old));
    assert.ok(loadMasterKey(home).equals(old));
  } finally {
    execFileSync('security', ['delete-generic-password', '-s', keychain.service, '-a', home], { stdio: 'ignore' });
  }
});
