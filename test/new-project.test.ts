// New project from GitHub or from a folder on this computer: the folder routes are for a person signed in on
// this computer only, listing repos never hands a token to anyone, and a person's Deploy packs the linked folder
// (an AI's redeploy doesn't).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { packFolder } from '../src/connectors/folder.ts';
import { all, get, id, run } from '../src/db.ts';

// a small Next.js project, with the things a pack must leave out
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-shop-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15.0.0' } }));
  mkdirSync(join(dir, 'app')); writeFileSync(join(dir, 'app', 'page.tsx'), 'export default () => null');
  for (const d of ['node_modules/next', '.git', 'dist', '.next']) { mkdirSync(join(dir, d), { recursive: true }); writeFileSync(join(dir, d, 'x.js'), 'x'); }
  writeFileSync(join(dir, '.env'), 'STRIPE_SECRET_KEY=sk_live_example');
  writeFileSync(join(dir, '.env.local'), 'TOKEN=example');
  return dir;
}
const entries = (tgz: Buffer) => execFileSync('tar', ['-tzf', '-'], { input: tgz, encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));

test('a pack holds the code and leaves out dependencies, builds, git and .env files', async () => {
  const files = entries(await packFolder(project()));
  assert.ok(files.includes('package.json') && files.includes('app/page.tsx'), files.join(' '));
  for (const f of files) assert.doesNotMatch(f, /^(node_modules|\.git|dist|\.next)(\/|$)|^\.env/, f);
  await assert.rejects(packFolder(project(), 10), /larger than/, 'a folder past the cap is refused, not half-sent');
});

test('the folder routes answer only a person signed in on this computer', async () => {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  const BASE = 'http://localhost:4800';
  let cookie = '', bind = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, from?: string) => {
    const res = await http.fetch(new Request(BASE + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie && { cookie, 'x-unit7-bind': bind }), ...headers },
    }), from ? { incoming: { socket: { remoteAddress: from } } } : undefined);
    const set = res.headers.get('set-cookie'); bind = res.headers.get('x-unit7-bind') ?? bind;
    if (set) cookie = set.split(';')[0]!;
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  assert.equal((await call('POST', '/api/auth/signup', { email: 'sam@example.com', name: 'Sam', password: 'correct horse battery' })).status, 200);
  const dir = project();

  // every call here carries a path, so a test never opens the real folder window
  const seen = await call('POST', '/api/local/choose-folder', { path: dir });
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.path, dir);
  assert.equal(seen.body.stack, 'next');
  assert.match(seen.body.name, /^unit7-shop-/);
  for (const bad of ['/', homedir(), '~', join(dir, 'nope'), 'relative/path', dirname(app.home)]) {
    const r = await call('POST', '/api/local/choose-folder', { path: bad });
    assert.equal(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
  }

  // an app to link it to
  const tool = async (name: string, input: unknown) => (await call('POST', `/api/tools/${name}`, { input })).body.output;
  const env = (await tool('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id;
  const serviceId = (await tool('service.create', { environmentId: env, name: 'shop' })).serviceId;
  assert.equal((await call('POST', '/api/local/link-folder', { serviceId, path: dir })).status, 200);
  assert.equal((await tool('service.get', { serviceId })).folder, dir);
  assert.equal((await call('POST', '/api/local/link-folder', { serviceId: 'svc_aaaaaaaaaaaa', path: dir })).status, 404);

  // not from another computer
  assert.equal((await call('POST', '/api/local/choose-folder', { path: dir }, {}, '10.0.0.5')).status, 403);
  assert.equal((await call('POST', '/api/local/link-folder', { serviceId, path: dir }, {}, '10.0.0.5')).status, 403);
  // never with an API token, an AI's or an admin's
  const tokens = await Promise.all(['admin', 'agent'].map(async (role) => (await call('POST', '/api/tokens', { name: role, role })).body.token as string));
  cookie = '';
  for (const t of tokens) {
    assert.equal((await call('POST', '/api/local/choose-folder', { path: dir }, { authorization: `Bearer ${t}` })).status, 403);
    assert.equal((await call('POST', '/api/local/link-folder', { serviceId, path: '/tmp' }, { authorization: `Bearer ${t}` })).status, 403);
  }
  assert.equal((await call('POST', '/api/local/choose-folder', { path: dir })).status, 401, 'signed out');
});

test('a person’s Deploy packs the linked folder; an AI’s redeploy doesn’t read it', async () => {
  const app = testApp();
  const o = await testOrg(app, 'Sam');
  const env = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id;
  const serviceId = ok(await o.h('service.create', { environmentId: env, name: 'shop' })).serviceId;
  const dir = project();
  run(app.db, `UPDATE services SET config = json_set(config, '$.folder', ?) WHERE id = ?`, dir, serviceId);
  // a server that's "ready" but can't be reached: the deploy fails after the folder is packed
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready')`, id('srv'), o.orgId);
  const uploads = () => all<{ path: string; created_by: string }>(app.db, 'SELECT path, created_by FROM uploads WHERE org_id = ?', o.orgId);

  const byAgent = await o.a('deployment.create', { serviceId });
  assert.equal(byAgent.status === 'error' && byAgent.error.code, 'needs_person', 'nothing packed yet: the first deploy is a person’s');
  assert.equal(uploads().length, 0, 'an AI never packs the folder');

  const byPerson = await o.h('deployment.create', { serviceId, noHeal: true });
  assert.ok(byPerson.status === 'error' && !['no_source', 'needs_person'].includes(byPerson.error.code), 'it got past the source: only the server was missing');
  const [up] = uploads();
  assert.ok(up, 'the folder was packed and kept as an upload');
  assert.equal(up.created_by, o.userId);
  const files = entries(execFileSync('cat', [up.path]));
  assert.ok(files.includes('package.json') && files.includes('app/page.tsx'));
  assert.ok(!files.some((f) => f.startsWith('.env') || f.startsWith('node_modules')));
  assert.equal(JSON.parse(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', serviceId)!.config).source, undefined, 'a failed deploy doesn’t become what an AI redeploys');
});

test('listing GitHub repos uses the token server-side and never returns it', async () => {
  const TOKEN = 'ghp_listtokenlisttoken0123456789abcd';
  const auth: string[] = [];
  const api = createServer((req, res) => {
    auth.push(String(req.headers.authorization));
    res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/user/repos')) return res.end(JSON.stringify([
      { full_name: 'sam/shop', private: true, pushed_at: '2026-10-01T10:00:00Z', default_branch: 'main', description: 'The shop', owner: { login: 'sam' }, permissions: { admin: true }, clone_url: `https://x-access-token:${TOKEN}@github.com/sam/shop.git` },
      { full_name: 'sam/blog', private: false, pushed_at: '2026-10-05T10:00:00Z', default_branch: 'trunk', description: null },
    ]));
    res.end('{}');
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  after(() => api.close());
  process.env.UNIT7_GITHUB_API = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const app = testApp();
  const o = await testOrg(app, 'Sam');
  assert.deepEqual(ok(await o.h('github.repos')), { connected: false, repos: [], problems: [] });
  ok(await o.h('account.connect', { provider: 'github', token: TOKEN }));
  for (const as of [o.h, o.a]) {
    const out = ok(await as('github.repos'));
    assert.equal(out.connected, true);
    assert.deepEqual(out.repos.map((r: any) => [r.fullName, r.private, r.defaultBranch]), [['sam/blog', false, 'trunk'], ['sam/shop', true, 'main']], 'newest push first');
    assert.deepEqual(Object.keys(out.repos[0]).sort(), ['account', 'accountId', 'defaultBranch', 'description', 'fullName', 'private', 'updatedAt']);
    assert.ok(!JSON.stringify(out).includes(TOKEN), 'the token never leaves the server');
  }
  assert.ok(auth.includes(`Bearer ${TOKEN}`), 'GitHub was asked with the stored token');
});
