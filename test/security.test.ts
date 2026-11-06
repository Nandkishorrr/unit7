// Holes found in a security review, each pinned by the smallest check that fails if it reopens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { acceptInvite, actorOf, createInvite, type Principal } from '../src/auth.ts';
import { execute } from '../src/tools/runtime.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { get, id, run } from '../src/db.ts';

const principal = (o: { orgId: string; userId: string }, role: Principal['role']): Principal =>
  ({ user: { id: o.userId, email: 'x@example.com', name: 'X' }, org: { id: o.orgId, name: 'Org', slug: 'org' }, role, via: 'session' });

test('an invite link never signs anyone in as an existing account', async () => {
  const app = testApp();
  const admin = await testOrg(app, 'Mallory');
  const victim = await testOrg(app, 'Victim');
  const email = get<{ email: string }>(app.db, 'SELECT email FROM users WHERE id = ?', victim.userId)!.email;
  const token = createInvite(app.db, principal(admin, 'owner'), email, 'readonly');
  await assert.rejects(acceptInvite(app.db, token, {}), /Sign in first/);
  await assert.rejects(acceptInvite(app.db, token, { name: 'X', password: 'correct horse battery' }), /Sign in first/);
  // signed in as themselves, the invite works
  assert.equal((await acceptInvite(app.db, token, { userId: victim.userId })).userId, victim.userId);
  // and a new email still joins with a name and password
  const fresh = createInvite(app.db, principal(admin, 'owner'), 'new@example.com', 'developer');
  assert.ok((await acceptInvite(app.db, fresh, { name: 'New', password: 'correct horse battery' })).userId);
});

test('an AI can never change a credential (it could redirect phone approvals to itself)', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const ref = 'credential://ntfy/main/token';
  assert.equal((await o.a('vault.set', { ref, value: 'https://ntfy.sh/attacker-topic' })).status, 'denied');
  ok(await o.h('vault.set', { ref, value: 'https://ntfy.sh/the-real-topic' }));
  ok(await o.h('vault.set', { ref, value: 'https://ntfy.sh/the-real-topic-2' }));
  assert.equal((await o.a('vault.restore', { ref, version: 1 })).status, 'denied');
  assert.equal((await o.a('vault.retire', { ref })).status, 'denied');
  assert.equal(app.vault.resolve(o.orgId, ref), 'https://ntfy.sh/the-real-topic-2');
});

test('Unit7’s agent working for a readonly or auditor person can only look', async () => {
  const app = testApp();
  const o = await testOrg(app);
  for (const role of ['readonly', 'auditor'] as const) {
    const actor = actorOf(principal(o, role), 'Unit7 agent');
    assert.equal((await execute(app, o.orgId, actor, 'project.create', { name: `by-${role}` })).status, 'denied');
    assert.equal((await execute(app, o.orgId, actor, 'project.list', {})).status, 'ok');
  }
  assert.equal(actorOf(principal(o, 'developer'), 'Unit7 agent').role, 'agent');
});

test('the policy of every environment an action touches applies, not just the first id’s', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const dev = environments.find((e: any) => e.kind === 'development').id;
  const prod = environments.find((e: any) => e.kind === 'production').id;
  run(app.db, 'UPDATE environments SET rules = ? WHERE id = ?', JSON.stringify({ env_write: 'prohibited', database_create: 'prohibited' }), prod);
  const prodSvc = ok(await o.h('service.create', { environmentId: prod, name: 'web' })).serviceId;
  // dev's id next to prod's service: the write lands in prod, so prod's rule decides
  assert.equal((await o.a('env.set', { environmentId: dev, serviceId: prodSvc, key: 'API_URL', value: 'https://evil.example' })).status, 'denied');
  assert.equal(get(app.db, 'SELECT 1 FROM env_vars WHERE scope_id = ?', prodSvc), undefined);
  // a dev database wired into a prod app
  assert.equal((await o.a('database.create', { environmentId: dev, engine: 'postgres', injectInto: prodSvc })).status, 'denied');
  // dev on its own still works
  assert.equal((await o.a('env.set', { environmentId: dev, key: 'API_URL', value: 'https://dev.example' })).status, 'ok');
  // a mixed action needing approval is filed under production, so only an admin can approve it
  run(app.db, 'UPDATE environments SET rules = ? WHERE id = ?', JSON.stringify({ env_write: 'restricted' }), prod);
  const r = await o.a('env.set', { environmentId: dev, serviceId: prodSvc, key: 'API_URL', value: 'https://x.example' });
  assert.equal(r.status, 'approval_required');
  assert.equal(get<{ environment_id: string }>(app.db, 'SELECT environment_id FROM approvals WHERE id = ?', (r as any).approvalId)!.environment_id, prod);
});

test('an API token can’t add or remove passkeys or change the team', async () => {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  let cookie = '', bind = ''; // a browser session is the cookie plus the page's header
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await http.fetch(new Request(`http://localhost:4800${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin: 'http://localhost:4800', ...(cookie && { cookie, 'x-unit7-bind': bind }), ...headers },
    }));
    const set = res.headers.get('set-cookie'); bind = res.headers.get('x-unit7-bind') ?? bind;
    if (set) cookie = set.split(';')[0]!;
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  await call('POST', '/api/auth/signup', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  const me = (await call('GET', '/api/me')).body;
  const agent = (await call('POST', '/api/tokens', { name: 'claude', role: 'agent' })).body.token;
  assert.equal((await call('POST', '/api/auth/passkey/register/options', {})).status, 200, 'a person in the web app can');
  const bearer = { authorization: `Bearer ${agent}`, origin: '' };
  cookie = '';
  assert.equal((await call('POST', '/api/auth/passkey/register/options', {}, bearer)).status, 403);
  assert.equal((await call('POST', '/api/auth/passkey/register/verify', { response: {} }, bearer)).status, 403);
  assert.equal((await call('DELETE', '/api/auth/passkey/pk_1', undefined, bearer)).status, 403);
  assert.equal((await call('POST', '/api/invites', { email: 'eve@example.com', role: 'admin' }, bearer)).status, 403);
  assert.equal((await call('DELETE', `/api/members/${me.user.id}`, undefined, bearer)).status, 403);
  assert.ok(get(app.db, 'SELECT 1 FROM memberships WHERE user_id = ?', me.user.id), 'the person is still in their org');
});

test('a GitHub token goes to GitHub as a header on stdin, never into the clone URL or a command', async () => {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === 'development').id;
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready')`, srv, o.orgId);
  const acc = id('acc');
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta) VALUES (?, ?, 'github', 'GitHub', 'main', '{}')`, acc, o.orgId);
  const token = 'ghp_' + 'Q'.repeat(36);
  app.vault.put(o.orgId, 'credential://github/main/token', token, { kind: 'token', accountId: acc });
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', serverId: srv, source: { type: 'git', repo: 'acme/app', accountId: acc } })).serviceId;
  // stand in for the server: record everything, stop at the clone
  const seen: { command: string; stdin: string }[] = [];
  ssh(app).exec = async (_s, command, opt = {}) => {
    seen.push({ command, stdin: String(opt.stdin ?? '') });
    return command.includes('git clone') ? { code: 128, stdout: 'stop here', stderr: '', truncated: false } : { code: 0, stdout: '', stderr: '', truncated: false };
  };
  assert.notEqual((await o.h('deployment.create', { serviceId: svc, noHeal: true })).status, 'ok');
  const clone = seen.find((x) => x.command.includes('git clone'))!;
  assert.ok(clone, 'it got to the clone');
  assert.ok(seen.every((x) => !x.command.includes(token)), 'never in a command line (or the saved remote URL)');
  assert.ok(clone.stdin.includes(Buffer.from(`x-access-token:${token}`).toString('base64')), 'the header arrives on stdin');
  assert.match(clone.command, /http\.\$4\.extraheader/);
  assert.match(clone.command, /'https:\/\/github\.com\/'$/, 'scoped to GitHub only');
});
