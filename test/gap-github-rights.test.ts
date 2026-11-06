// GitHub rights: what the default one-click GitHub App can do, on a stand-in GitHub that refuses what the real one refuses. An install
// token gets a 403 on /user and /user/repos whatever the docs list, each route needs its own right, a token keeps the rights it was
// made with, OAuth failures come back as a 200, and a refresh token works once. git is real, against local bare repos, and the
// Coolify steps run through real curl.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, testApp } from './helpers.ts';
import { account, fakeApi, type Req } from './clouds-fakes.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { get, id, json, run } from '../src/db.ts';
import { decideApproval, execute, type Actor } from '../src/tools/runtime.ts';
import { packFolder, saveUpload } from '../src/connectors/folder.ts';
import { CURL } from '../src/connectors/coolify.ts';
import { pushFolder } from '../src/connectors/github.ts';
import { CATALOG } from '../src/connectors/oneclick.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { XRAY_PROBE } from '../src/discovery/xray.ts';
import { walk } from '../src/live/source.ts';
import { liveTiming } from '../src/live/vercel.ts';
import { plainError } from '../web/src/lib/words.ts';

liveTiming.pollMs = 1; liveTiming.answerMs = 20; liveTiming.buildMs = 5_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const OLD = { contents: 'write', metadata: 'read', pull_requests: 'write', statuses: 'write', deployments: 'write', actions: 'write', secrets: 'write' };
const NOW = { ...OLD, workflows: 'write', administration: 'write', pages: 'write', repository_hooks: 'write' };
const NO = [403, { message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.example/rest' }];
const INSTALL_PAGE = 'https://github.com/settings/installations/42';

const closers: (() => void)[] = [];
after(() => { for (const c of closers) c(); for (const k of ['UNIT7_GITHUB_API', 'UNIT7_GITHUB_LOGIN', 'UNIT7_GITHUB_URL']) delete process.env[k]; });

async function fakeGithub() {
  const root = mkdtempSync(join(tmpdir(), 'github-rights-'));
  const st = {
    root, granted: { ...NOW } as Record<string, string>, account: { login: 'demo', type: 'User' }, tokens: new Map<string, Record<string, string>>(),
    users: new Set<string>(), refreshTokens: new Set<string>(), challenge: '', codes: new Set(['GOODCODE']), refreshes: 0, expiresIn: 28800 as number | undefined,
    repos: new Map<string, { private: boolean; hooks: any[]; pages?: any }>(), sayNo: false, jwts: 0, // sayNo: a route that refuses for its own reasons
  };
  const make = (name: string, isPrivate: boolean) => {
    if (st.repos.has(name)) return [422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }];
    mkdirSync(join(root, st.account.login), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, st.account.login, `${name}.git`)]);
    st.repos.set(name, { private: isPrivate, hooks: [] });
    return [201, { owner: { login: st.account.login }, name, private: isPrivate }];
  };
  const head = (name: string) => execFileSync('git', ['--git-dir', join(root, st.account.login, `${name}.git`), 'rev-parse', 'refs/heads/gh-pages']).toString().trim();
  const signedByApp = (r: Req) => {
    const [h, p, sig] = r.auth.slice(7).split('.');
    return !!sig && createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')) && JSON.parse(Buffer.from(p!, 'base64url').toString()).iss === '7';
  };
  const api = await fakeApi((r) => {
    const p = new URL(r.path, 'http://x').pathname, route = `${r.method} ${p}`;
    if (route === 'POST /app-manifests/CODE1/conversions') return [201, { id: 7, slug: 'unit7-demo', pem, client_id: 'Iv1.demo', client_secret: 'demo-secret', owner: { login: 'demo' } }];
    if (route === 'POST /app/installations/42/access_tokens') {
      if (!signedByApp(r)) return [401, { message: 'A JSON web token could not be decoded' }];
      const token = `ghs_${randomBytes(8).toString('hex')}`;
      st.tokens.set(token, { ...st.granted });
      return [201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: st.granted, repository_selection: 'all' }];
    }
    if (route === 'GET /app/installations/42') {
      st.jwts++;
      return signedByApp(r) ? { id: 42, account: st.account, permissions: st.granted, repository_selection: 'all', html_url: INSTALL_PAGE } : [401, { message: 'A JSON web token could not be decoded' }];
    }
    if (route === 'POST /login/oauth/access_token') { // always a 200, even for a refusal
      const f = new URLSearchParams(r.body);
      if (f.get('client_secret') !== 'demo-secret') return { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' };
      const give = () => {
        const access = `ghu_${randomBytes(8).toString('hex')}`, refresh = `ghr_${randomBytes(8).toString('hex')}`;
        st.users.add(access); st.refreshTokens.add(refresh);
        return { access_token: access, ...(st.expiresIn && { expires_in: st.expiresIn, refresh_token: refresh, refresh_token_expires_in: 15897600 }), scope: '', token_type: 'bearer' };
      };
      if (f.get('grant_type') === 'refresh_token') {
        st.refreshes++;
        if (f.has('resource')) throw new Error('GitHub lists no such parameter');
        if (!st.refreshTokens.delete(f.get('refresh_token') ?? '')) return { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' };
        st.users.clear(); // the old access token stops working too
        return give();
      }
      const proved = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === st.challenge;
      if (!proved || !st.codes.delete(f.get('code') ?? '')) return { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' };
      return give();
    }
    const bearer = r.auth.slice(7), rights = st.tokens.get(bearer), person = st.users.has(bearer);
    if (!rights && !person) return [401, { message: 'Bad credentials' }];
    const may = (k: string) => (rights ?? st.granted)[k] === 'write'; // a person's token follows the App as it is now
    if (route === 'GET /user') return rights ? NO : { login: st.account.login };
    if (route === 'POST /user/repos') { if (rights || !may('administration') || st.sayNo) return NO; const b = JSON.parse(r.body); return make(b.name, b.private); }
    let m = /^\/orgs\/([\w-]+)\/repos$/.exec(p);
    if (m && r.method === 'POST') { if (!may('administration') || st.account.type !== 'Organization' || m[1] !== st.account.login) return NO; const b = JSON.parse(r.body); return make(b.name, b.private); }
    m = /^\/repos\/[\w-]+\/([\w.-]+)(\/.*)?$/.exec(p);
    const repo = m && st.repos.get(m[1]!);
    if (!m || !repo) return [404, { message: 'Not Found' }];
    const rest = m[2] ?? '', full = { owner: { login: st.account.login }, name: m[1], private: repo.private, default_branch: 'main', permissions: { admin: may('administration') } };
    if (route.startsWith('GET') && !rest) return full;
    if (rest === '/keys' && r.method === 'POST') return may('administration') ? [201, { id: 77 }] : NO;
    if (rest === '/keys/77' && r.method === 'DELETE') return may('administration') ? [204, ''] : NO;
    if (rest === '/hooks' && r.method === 'GET') return may('repository_hooks') ? repo.hooks : NO;
    if (rest === '/hooks' && r.method === 'POST') { if (!may('repository_hooks')) return NO; repo.hooks.push(JSON.parse(r.body)); return [201, { id: 9 }]; }
    if (rest === '/pages' && r.method === 'GET') return !may('pages') ? NO : repo.pages ?? [404, { message: 'Not Found' }];
    if (rest === '/pages' && r.method === 'POST') { if (!may('pages') || !may('administration')) return NO; repo.pages = { html_url: `https://demo.github.example/${m[1]}/`, source: JSON.parse(r.body).source }; return [201, repo.pages]; }
    if (rest === '/pages/builds/latest') return { status: 'built', commit: head(m[1]!) };
    return undefined;
  });
  closers.push(api.close);
  process.env.UNIT7_GITHUB_API = api.base; process.env.UNIT7_GITHUB_LOGIN = `${api.base}/login/oauth`; process.env.UNIT7_GITHUB_URL = `file://${root}`;
  return { ...api, st, git: (name: string, ...args: string[]) => execFileSync('git', ['--git-dir', join(root, st.account.login, `${name}.git`), ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString() };
}
type Github = Awaited<ReturnType<typeof fakeGithub>>;

const site = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  for (const [k, v] of Object.entries(files)) { mkdirSync(join(dir, k, '..'), { recursive: true }); writeFileSync(join(dir, k), v); }
  return dir;
};

// a person and a browser session, through Unit7's real routes
async function person() {
  const app = testApp();
  app.services.listen = { host: '127.0.0.1', port: 4800 };
  const http = createHttp(app);
  let cookie = '', bind = '';
  const call = async (method: string, path: string, body?: unknown, o: { noSession?: boolean } = {}) => {
    const r = await http.fetch(new Request(`http://localhost:4800${path}`, { method, redirect: 'manual', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', origin: 'http://localhost:4800', ...(cookie && !o.noSession && { cookie, 'x-unit7-bind': bind }) } }));
    const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location') ?? '', text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  resetRateLimits();
  await call('POST', '/api/auth/signup', { email: 'demo@example.com', name: 'Demo', password: 'correct horse battery' });
  const { id: orgId } = get<{ id: string }>(app.db, 'SELECT id FROM orgs LIMIT 1')!, { id: userId } = get<{ id: string }>(app.db, 'SELECT id FROM users LIMIT 1')!;
  const human: Actor = { kind: 'user', id: userId, userId, name: 'Demo', role: 'owner' };
  const agent: Actor = { kind: 'agent', id: userId, userId, name: 'Unit7 agent', role: 'agent', agent: 'Unit7 agent' };
  return { app, orgId, userId, human, agent, call, h: (tool: string, input: unknown = {}) => execute(app, orgId, human, tool, input), upload: async (dir: string) => saveUpload(app, orgId, userId, await packFolder(dir, undefined, { keepBuild: true })) };
}

// the whole one-click connection, as GitHub sends a browser through it
async function connected(g: Github, o: { authorize?: boolean } = {}) {
  const p = await person();
  const start = (await p.call('GET', '/api/connect/github/start')).body.url as string, state = start.split('/').pop()!;
  const page = await p.call('GET', new URL(start).pathname);
  const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(page.text)![1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
  await p.call('GET', `/api/connect/github/created?code=CODE1&state=${state}`);
  const installed = await p.call('GET', `/api/connect/github/installed?installation_id=42&setup_action=install&state=${state}`);
  const authorize = new URL(installed.location), acc = get<{ id: string; meta: string }>(p.app.db, `SELECT id, meta FROM accounts WHERE provider = 'github'`)!;
  const yes = async (url = authorize) => {
    g.st.challenge = url.searchParams.get('code_challenge')!;
    g.st.codes.add('GOODCODE');
    return p.call('GET', `/api/connect/github/authorized?code=GOODCODE&state=${url.searchParams.get('state')}`);
  };
  const back = o.authorize === false ? undefined : await yes();
  return { ...p, manifest, authorize, yes, back, accountId: acc.id, meta: json<any>(acc.meta, {}) };
}
// a connection made before this release: its App has the old rights and no callback address, and no person's token
function oldConnection(p: Awaited<ReturnType<typeof person>>, g: Github) {
  g.st.granted = { ...OLD };
  const accountId = id('acc'), ref = 'credential://github/github-demo/token';
  run(p.app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status) VALUES (?, ?, 'github', 'GitHub (demo)', 'github-demo', ?, 'verified')`, accountId, p.orgId, JSON.stringify({ ref, auth: 'github-app', appId: 7, slug: 'unit7-demo', owner: 'demo', installationId: 42 }));
  p.app.vault.put(p.orgId, ref, JSON.stringify({ app_id: 7, pem, client_id: 'Iv1.demo', client_secret: 'demo-secret' }), { kind: 'github_app', accountId });
  return accountId;
}
// a repo that already has a commit on it, as a real one does
async function seeded(g: Github, name: string) {
  g.st.repos.set(name, { private: false, hooks: [] });
  mkdirSync(join(g.st.root, 'demo'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(g.st.root, 'demo', `${name}.git`)]);
  await pushFolder(walk(site({ 'index.html': 'a site' })), { owner: 'demo', name }, undefined, { branch: 'main', message: 'Code', existing: false });
}
const failed = (r: unknown) => (r as { error: { code: string; message: string } }).error;
const vaulted = (p: { app: any; orgId: string }, name: string) => JSON.parse(p.app.vault.resolve(p.orgId, `credential://github/github-demo/${name}`));
const everythingOnFile = (app: any) => JSON.stringify([...app.db.prepare('SELECT * FROM audit').all(), ...app.db.prepare('SELECT * FROM events').all(), ...app.db.prepare('SELECT * FROM accounts').all()]);

test('the manifest asks for each right a route needs, and connecting ends with the person’s yes', async () => {
  const g = await fakeGithub(), c = await connected(g);
  assert.deepEqual(c.manifest.default_permissions, NOW);
  assert.deepEqual(c.manifest.callback_urls, ['http://localhost:4800/api/connect/github/authorized']);
  assert.equal(c.manifest.setup_url, 'http://localhost:4800/api/connect/github/installed', 'still where the install comes back to');
  assert.equal(c.manifest.request_oauth_on_install, undefined);

  assert.equal(c.authorize.origin + c.authorize.pathname, `${process.env.UNIT7_GITHUB_LOGIN}/authorize`);
  assert.equal(c.authorize.searchParams.get('client_id'), 'Iv1.demo');
  assert.equal(c.authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(c.authorize.searchParams.get('code_challenge')!.length, 43);
  assert.equal(c.back!.location, '/connections?connected=GitHub+%28demo%29');
  assert.equal(c.meta.installationId, 42);

  // the token lives in the vault under the account, encrypted, and nowhere an AI or a log can read it
  const secret = vaulted(c, 'user');
  assert.match(secret.access_token, /^ghu_/);
  assert.match(secret.refresh_token, /^ghr_/);
  assert.ok(Math.abs(secret.expires_at - (Date.now() + 28800_000)) < 60_000);
  assert.ok(!everythingOnFile(c.app).includes(secret.access_token) && !everythingOnFile(c.app).includes(secret.refresh_token));
  const list = await execute(c.app, c.orgId, c.agent, 'vault.list', {});
  assert.ok(!JSON.stringify(list).includes(secret.access_token) && !JSON.stringify(list).includes(secret.refresh_token));
  assert.ok(!c.app.db.prepare('SELECT ciphertext FROM secrets').all().some((r: any) => Buffer.from(r.ciphertext).includes(secret.access_token)), 'not stored in the clear');
});

test('a sign-in that can’t be trusted or doesn’t finish says so, and the App still works', async () => {
  const g = await fakeGithub(), c = await connected(g, { authorize: false });
  // GitHub refuses a wrong code with a 200: only the body says so
  g.st.challenge = c.authorize.searchParams.get('code_challenge')!;
  const bad = await c.call('GET', `/api/connect/github/authorized?code=WRONG&state=${c.authorize.searchParams.get('state')}`);
  assert.match(decodeURIComponent(bad.location), /oauth_error=.*bad_verification_code/);
  assert.equal(c.app.vault.has(c.orgId, 'credential://github/github-demo/user'), false);
  // a state works once, for the person who started it
  assert.match(decodeURIComponent((await c.yes()).location.replace(/\+/g, ' ')), /sign-in link expired/);
  const again = await c.call('GET', `/api/connect/github/authorize/${c.accountId}`);
  assert.match(again.location, /\/authorize\?client_id=Iv1\.demo/);
  const signedOut = await c.call('GET', `/api/connect/github/authorize/${c.accountId}`, undefined, { noSession: true });
  assert.match(decodeURIComponent(signedOut.location.replace(/\+/g, ' ')), /Sign in to Unit7 first/);
  const stranger = await c.call('GET', '/api/connect/github/authorize/acc_notmine0000');
  assert.match(decodeURIComponent(stranger.location.replace(/\+/g, ' ')), /isn’t here any more/);
  // clicking Cancel on GitHub comes back as a plain error, and everything an install token can do goes on working
  const cancelled = await c.call('GET', '/api/connect/github/authorized?error=access_denied&error_description=The+user+has+denied+your+application+access.');
  assert.match(decodeURIComponent(cancelled.location.replace(/\+/g, ' ')), /denied your application access/);
  assert.ok(ok(await c.h('github.repos')).repos, 'listing repos needs no person’s token');
});

test('github.create_repo: a personal account goes through the person’s token, never the install token', async () => {
  const g = await fakeGithub(), c = await connected(g);
  const r = ok(await c.h('github.create_repo', { name: 'shop' }));
  assert.deepEqual(r, { repo: 'demo/shop', url: 'https://github.com/demo/shop', private: true });
  assert.ok(g.st.repos.get('shop')!.private);
  const made = g.calls.find((x) => x.method === 'POST' && x.path === '/user/repos')!;
  assert.match(made.auth, /^Bearer ghu_/);
  assert.ok(!g.calls.some((x) => x.path === '/user' && x.auth.startsWith('Bearer ghs_')));
  const taken = await c.h('github.create_repo', { name: 'shop' });
  assert.equal(failed(taken).code, 'already_exists');
  assert.match(failed(taken).message, /You already have a repo called shop/);
  // a name that isn't the App's own account can't be reached, and the answer says what can
  const other = failed(await c.h('github.create_repo', { name: 'shop2', org: 'acme' }));
  assert.equal(other.code, 'github_rights');
  assert.match(other.message, /on demo, so it can’t reach acme.*connect GitHub with a token/);
  assert.equal(ok(await c.h('github.create_repo', { name: 'shop3', org: 'demo' })).repo, 'demo/shop3', 'naming your own account is the same thing');
  // only the right this step needs stops it
  delete g.st.granted.pages;
  assert.equal(ok(await c.h('github.create_repo', { name: 'shop4' })).repo, 'demo/shop4');
  // an AI gets the repo, never the token behind it
  const byAi = await execute(c.app, c.orgId, c.agent, 'github.create_repo', { name: 'shop5' });
  assert.equal(ok<any>(byAi).repo, 'demo/shop5');
  assert.doesNotMatch(JSON.stringify(byAi), /gh[usr]_/);
});

test('github.push with create: a new repo, then a normal commit on top, and a bare name finds it', async () => {
  const g = await fakeGithub(), c = await connected(g);
  const first = ok(await c.h('github.push', { uploadId: await c.upload(site({ 'index.html': 'one' })), repo: 'shop', create: true }));
  assert.equal(first.repo, 'demo/shop');
  assert.equal(g.git('shop', 'show', 'main:index.html'), 'one');
  const second = ok(await c.h('github.push', { uploadId: await c.upload(site({ 'index.html': 'two' })), repo: 'shop', message: 'Second' }));
  assert.equal(second.repo, 'demo/shop', 'a name alone: an install token can’t ask who it is, so Unit7 uses the account it’s installed on');
  assert.deepEqual(g.git('shop', 'log', '--format=%s', 'main').trim().split('\n'), ['Second', 'Update from Unit7']);
});

test('a GitHub Pages put, from an upload to a live address, on the default App', async () => {
  const g = await fakeGithub(), c = await connected(g);
  const out = ok<any>(await c.h('live.put', { uploadId: await c.upload(site({ 'index.html': '<h1>Hello</h1>' })), to: 'github-pages', name: 'shop' }));
  assert.equal(out.url, 'https://demo.github.example/shop/');
  assert.equal(g.st.repos.get('shop')!.private, false);
  assert.equal(g.git('shop', 'show', 'gh-pages:index.html'), '<h1>Hello</h1>');
  assert.deepEqual(g.st.repos.get('shop')!.pages.source, { branch: 'gh-pages', path: '/' });
  const turnedOn = g.calls.find((x) => x.method === 'POST' && x.path.endsWith('/pages'))!;
  assert.match(turnedOn.auth, /^Bearer ghs_/, 'only the new repo itself takes the person’s token');
});

test('an organisation’s install uses its own token, and needs no person', async () => {
  const g = await fakeGithub(), c = await connected(g, { authorize: false });
  g.st.account = { login: 'acme', type: 'Organization' };
  assert.equal(ok(await c.h('github.create_repo', { name: 'site' })).repo, 'acme/site');
  const made = g.calls.find((x) => x.method === 'POST' && x.path === '/orgs/acme/repos')!;
  assert.match(made.auth, /^Bearer ghs_/);
  assert.equal(failed(await c.h('github.create_repo', { name: 'site2', org: 'other' })).code, 'github_rights');
});

test('the person’s token: eight hours, then one refresh at a time; a dead refresh or a taken-back OK says what to do', async () => {
  const g = await fakeGithub(), c = await connected(g);
  const ref = 'credential://github/github-demo/user', expire = () => c.app.vault.put(c.orgId, ref, JSON.stringify({ ...vaulted(c, 'user'), expires_at: Date.now() - 1000 }), { kind: 'oauth' });
  ok(await c.h('github.create_repo', { name: 'first' }));
  assert.equal(g.st.refreshes, 0, 'still good: no refresh');

  expire();
  const had = vaulted(c, 'user').refresh_token;
  const both = await Promise.all([c.h('github.create_repo', { name: 'one' }), c.h('github.create_repo', { name: 'two' })]);
  both.forEach((r) => ok(r));
  assert.equal(g.st.refreshes, 1, 'its refresh token works once, so two callers share one refresh');
  assert.notEqual(vaulted(c, 'user').refresh_token, had, 'the new one is kept');

  expire();
  g.st.refreshTokens.clear();
  const dead = failed(await c.h('github.create_repo', { name: 'three' }));
  assert.equal(dead.code, 'github_rights');
  assert.match(dead.message, new RegExp(`Unit7 needs your OK once:\\nOpen http://localhost:4800/api/connect/github/authorize/${c.accountId} and click Authorize\\.\\nThen run this again\\.`));
  assert.ok(!/Save changes|Review request/.test(dead.message), 'an App with the rights has nothing else to do');
  assert.equal(get<{ status: string }>(c.app.db, 'SELECT status FROM accounts WHERE id = ?', c.accountId)!.status, 'verified', 'and the App goes on working');

  // that link really works, and so does the repo after it
  const link = await c.call('GET', `/api/connect/github/authorize/${c.accountId}`);
  await c.yes(new URL(link.location));
  ok(await c.h('github.create_repo', { name: 'three' }));

  // the person took their OK back on GitHub, with hours left on the token
  g.st.users.clear();
  const revoked = failed(await c.h('github.create_repo', { name: 'four' }));
  assert.equal(revoked.code, 'github_rights');
  assert.match(revoked.message, /click Authorize/);
  assert.equal(get<{ status: string }>(c.app.db, 'SELECT status FROM accounts WHERE id = ?', c.accountId)!.status, 'verified', 'a person’s no isn’t the App failing');
  await c.yes(new URL((await c.call('GET', `/api/connect/github/authorize/${c.accountId}`)).location));
  ok(await c.h('github.create_repo', { name: 'four' }));
});

test('Disconnect takes the person’s token with it: nothing is left to steal', async () => {
  const g = await fakeGithub(), c = await connected(g);
  assert.equal(get<{ n: number }>(c.app.db, `SELECT count(*) n FROM secrets WHERE ref LIKE 'credential://github/%'`)!.n, 2);
  const asked = await c.h('account.disconnect', { accountId: c.accountId }); // a person confirms this one
  assert.equal(asked.status, 'approval_required');
  assert.equal((await decideApproval(c.app, c.orgId, c.human, (asked as { approvalId: string }).approvalId, true)).status, 'ok');
  assert.equal(get<{ n: number }>(c.app.db, `SELECT count(*) n FROM secrets WHERE ref LIKE 'credential://github/%'`)!.n, 0);
});

test('an App with expiring tokens turned off gets a token that doesn’t expire, with no refresh', async () => {
  const g = await fakeGithub();
  g.st.expiresIn = undefined;
  const c = await connected(g);
  assert.equal(vaulted(c, 'user').refresh_token, undefined);
  ok(await c.h('github.create_repo', { name: 'shop' }));
  assert.equal(g.st.refreshes, 0);
});

// --- an App made before these rights ---------------------------------------------------------------------------------------
const PERMISSIONS = 'https://github.com/settings/apps/unit7-demo/permissions';
test('an old install: a repo on a personal account lists all it takes, with the exact links, in order', async () => {
  const g = await fakeGithub(), p = await person(), accountId = oldConnection(p, g);
  const e = failed(await p.h('github.create_repo', { name: 'shop' }));
  assert.equal(e.code, 'github_rights');
  const lines = e.message.split('\n');
  assert.equal(lines[0], 'Unit7’s GitHub App was made before it could do this, and only you can change that on GitHub:');
  assert.match(lines[1]!, new RegExp(`^1\\. Open ${PERMISSIONS}, set Workflows, Administration, Pages, and Webhooks to Read and write, then click Save changes\\.$`));
  assert.equal(lines[2], '2. Open https://github.com/settings/apps/unit7-demo, put http://localhost:4800/api/connect/github/authorized under Callback URL, then click Save changes.');
  assert.equal(lines[3], `3. Open ${INSTALL_PAGE}, click Review request, then Accept new permissions.`);
  assert.equal(lines[4], `4. Open http://localhost:4800/api/connect/github/authorize/${accountId} and click Authorize.`);
  assert.equal(lines[5], 'Then run this again.');
  assert.doesNotMatch(e.message, /Resource not accessible|403/, 'never the raw refusal');
  const shown = plainError(e.message); // a toast is one line, with the rest under Show details
  assert.equal(shown.line, 'Unit7’s GitHub App was made before it could do this, and only you can change that on GitHub.');
  assert.ok(shown.more!.includes(PERMISSIONS) && shown.more!.includes(INSTALL_PAGE), 'and the links are there');
  assert.equal(g.st.repos.size, 0);
  assert.equal(get<{ status: string }>(p.app.db, 'SELECT status FROM accounts WHERE id = ?', accountId)!.status, 'verified', 'one missing right doesn’t stop what the App can do');
});

test('an old install: the owner does the steps and it works, with a token made after they said yes', async () => {
  const g = await fakeGithub(), p = await person(), accountId = oldConnection(p, g);
  ok(await p.h('github.repos'));
  const had = [...g.st.tokens.keys()];
  assert.equal(had.length, 1);
  assert.equal(failed(await p.h('github.create_repo', { name: 'shop' })).code, 'github_rights');
  g.st.granted = { ...NOW }; // steps 1 to 3 on GitHub
  const link = await p.call('GET', `/api/connect/github/authorize/${accountId}`), url = new URL(link.location); // step 4
  g.st.challenge = url.searchParams.get('code_challenge')!;
  g.st.codes.add('GOODCODE');
  assert.match((await p.call('GET', `/api/connect/github/authorized?code=GOODCODE&state=${url.searchParams.get('state')}`)).location, /connected=/);
  const r = ok(await p.h('github.push', { uploadId: await p.upload(site({ 'index.html': 'x' })), repo: 'shop', create: true }));
  assert.equal(r.repo, 'demo/shop');
  assert.ok(g.st.tokens.size > 1, 'the refused run dropped the old token');
});

test('an old install: Pages and a push with a workflow file each get the same plain next step', async () => {
  const g = await fakeGithub(), p = await person();
  oldConnection(p, g);
  await seeded(g, 'shop');

  // a site from a repo that exists: no person's token needed, so no sign-in steps
  const pages = failed(await p.h('live.put', { repo: 'demo/shop', to: 'github-pages', name: 'shop' }));
  assert.equal(pages.code, 'github_rights');
  assert.match(pages.message, new RegExp(`1\\. Open ${PERMISSIONS}, set .*Pages.*\\n2\\. Open ${INSTALL_PAGE}, click Review request, then Accept new permissions\\.\\nThen run this again\\.`));
  assert.doesNotMatch(pages.message, /Callback URL|Authorize|token/);

  // what git says when GitHub turns a push down
  const hook = join(g.st.root, 'demo', 'shop.git', 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "refusing to allow a GitHub App to create or update workflow \\`.github/workflows/ci.yml\\` without \\`workflows\\` permission" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const push = failed(await p.h('github.push', { uploadId: await p.upload(site({ '.github/workflows/ci.yml': 'on: push', 'index.html': 'x' })), repo: 'demo/shop', branch: 'main' }));
  assert.equal(push.code, 'github_rights');
  assert.match(push.message, /set .*Workflows/);
  assert.match(push.message, /Accept new permissions/);
});

test('the rights are there but GitHub still says no: where to look, and the next try gets a new token', async () => {
  const g = await fakeGithub(), c = await connected(g);
  g.st.sayNo = true; // an install on chosen repos, for one
  const e = failed(await c.h('github.create_repo', { name: 'shop' }));
  assert.equal(e.code, 'github_rights');
  assert.match(e.message, new RegExp(`though Unit7’s GitHub App has the rights\\. Open ${INSTALL_PAGE} and, under Repository access, choose All repositories`));
  assert.doesNotMatch(e.message, /Save changes/);

  // an install token from before the owner accepted keeps its old rights: one refusal drops it, then it works
  g.st.sayNo = false;
  await seeded(g, 'shop');
  ok(await c.h('github.repos'));
  for (const t of g.st.tokens.keys()) g.st.tokens.set(t, { ...OLD });
  const first = failed(await c.h('live.put', { repo: 'demo/shop', to: 'github-pages', name: 'shop' }));
  assert.match(first.message, /If you only just accepted new rights, run this again/);
  assert.equal(ok<any>(await c.h('live.put', { repo: 'demo/shop', to: 'github-pages', name: 'shop' })).url, 'https://demo.github.example/shop/');
});

// --- the GitHub CLI and a pasted token -------------------------------------------------------------------------------------
test('the GitHub CLI and pasted tokens work as they did, and a refusal is in plain words', async () => {
  const g = await fakeGithub(), p = await person();
  const token = 'ghp_demotoken0000000000000000000';
  g.st.users.add(token); // a token that's a person's, as a pasted or CLI one is
  account(p.app, p.orgId, 'github', token, 'GitHub (demo)');
  assert.equal(ok(await p.h('github.push', { uploadId: await p.upload(site({ 'index.html': 'one' })), repo: 'shop', create: true })).repo, 'demo/shop');
  assert.equal(g.calls.find((x) => x.path === '/user/repos')!.auth, `Bearer ${token}`);
  assert.equal(ok(await p.h('github.push', { uploadId: await p.upload(site({ 'index.html': 'two' })), repo: 'shop' })).repo, 'demo/shop', 'a bare name asks GET /user');
  assert.ok(g.calls.some((x) => x.path === '/user'));
  assert.ok(g.st.jwts === 0, 'nothing of the App’s path');
  g.st.sayNo = true;
  const e = failed(await p.h('github.create_repo', { name: 'other' }));
  assert.equal(e.code, 'github_rights');
  assert.match(e.message, /won’t let this connection create repos.*connect GitHub with a new token/);
  assert.doesNotMatch(e.message, /github\.com\/settings/);
  assert.match(CATALOG.find((x) => x.id === 'github')!.alt!.hint, /Administration, Contents, Pages, Webhooks, Workflows, Actions and Secrets/);
});

test('a repo left empty by a push that failed takes the next one, never by force', async () => {
  const g = await fakeGithub(), c = await connected(g);
  ok(await c.h('github.create_repo', { name: 'shop' }));
  const dir = site({ 'index.html': 'one' });
  await pushFolder(walk(dir), { owner: 'demo', name: 'shop' }, undefined, { branch: 'main', message: 'First', existing: true });
  assert.equal(g.git('shop', 'show', 'main:index.html'), 'one');
  await pushFolder(walk(site({ 'index.html': 'two' })), { owner: 'demo', name: 'shop' }, undefined, { branch: 'main', message: 'Second', existing: true });
  assert.deepEqual(g.git('shop', 'log', '--format=%s', 'main').trim().split('\n'), ['Second', 'First']);
});

// --- Coolify: a private repo's deploy key, and deploy on push -------------------------------------------------------------------
function fakeCoolify() {
  const st = { keys: [] as any[], made: [] as any[], app: { uuid: 'shopapp01', name: 'Shop web', build_pack: 'nixpacks', git_repository: 'git@github.com:demo/shop.git', git_branch: 'main', source_id: 0, settings: { is_auto_deploy_enabled: false } } as any };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, 'http://x'), path = url.pathname.replace(/^\/api\/v1/, ''), body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined, r = `${req.method} ${path}`;
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': typeof b === 'string' ? 'text/plain' : 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    if (r === 'GET /version') return send(200, '4.4.0');
    if (r === 'GET /team') return send(200, { id: 0, name: 'Demo team' });
    if (r === 'GET /servers') return send(200, [{ uuid: 'srvuuid01', name: 'localhost', settings: {} }]);
    if (r === 'GET /servers/srvuuid01/sentinel') return send(200, { is_metrics_enabled: false });
    if (r === 'GET /projects') return send(200, [{ uuid: 'proj01', name: 'Shop' }]);
    if (r === 'GET /projects/proj01') return send(200, { uuid: 'proj01', name: 'Shop', environments: [{ id: 1, name: 'production', uuid: 'env01' }] });
    if (r === 'GET /projects/proj01/env01' || r === 'GET /projects/proj01/production') return send(200, { applications: [] });
    if (r === 'GET /github-apps') return send(200, []);
    if (r === 'POST /security/keys') { const uuid = `key${st.keys.length + 1}`; st.keys.push({ uuid, ...body }); return send(201, { uuid }); }
    const m = /^DELETE \/security\/keys\/(\w+)$/.exec(r);
    if (m) { st.keys = st.keys.filter((k) => k.uuid !== m[1]); return send(200, { message: 'Private Key deleted.' }); }
    if (r === 'POST /applications/private-deploy-key') { st.made.push(body); return send(201, { uuid: 'newapp01', domains: '' }); }
    if (r === 'GET /applications/shopapp01') return send(200, st.app);
    if (r === 'PATCH /applications/shopapp01') { for (const [k, v] of Object.entries(body)) if (k.startsWith('is_')) st.app.settings[k] = v; else st.app[k] = v; return send(200, { uuid: 'shopapp01' }); }
    send(404, { message: 'Not found.' });
  });
  return new Promise<typeof st & { port: number }>((r) => server.listen(0, '127.0.0.1', () => { closers.push(() => server.close()); r(Object.assign(st, { port: (server.address() as { port: number }).port })); }));
}
async function onCoolify(p: Awaited<ReturnType<typeof person>>) {
  const c = await fakeCoolify(), srv = id('srv');
  run(p.app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, p.orgId, JSON.stringify({ sudo: 'root', docker: '27.3.1', web: 'coolify-proxy|traefik:v3.6' }));
  ssh(p.app).exec = async (_s, command, o: ExecOptions = {}) => {
    const stdin = String(o.stdin ?? ''), done = (stdout: string, code = 0) => ({ code, stdout, stderr: '', truncated: false });
    if (stdin === XRAY_PROBE) return done(COOLIFY_HOST);
    if (command !== CURL) return done('');
    return new Promise((resolve) => {
      const x = spawn('curl', ['-K', '-']);
      let stdout = '', stderr = '';
      x.stdout.on('data', (d) => { stdout += d; });
      x.stderr.on('data', (d) => { stderr += d; });
      x.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
      x.stdin.end(stdin.replace('http://127.0.0.1:8000/', `http://127.0.0.1:${c.port}/`));
    });
  };
  ok(await p.h('coolify.connect', { serverId: srv, token: '7|rootkeyAbC123xyz00000' }));
  return { c, srv };
}
const CREATE = (srv: string) => ({ serverId: srv, project: 'proj01', name: 'Shop two', repo: 'demo/shop' });
const privateRepo = (g: Github) => { g.st.repos.set('shop', { private: true, hooks: [] }); };

test('Coolify on the default App: a private repo gets its deploy key, and deploy on push gets its webhook', async () => {
  const g = await fakeGithub(), c = await connected(g), { c: cool, srv } = await onCoolify(c);
  privateRepo(g);
  const r = ok(await c.h('coolify.create_app', CREATE(srv)));
  assert.deepEqual([r.deployKey.coolify, r.deployKey.github], ['key1', 77]);
  assert.equal(cool.made[0].git_repository, 'git@github.com:demo/shop.git');
  const key = g.calls.find((x) => x.method === 'POST' && x.path === '/repos/demo/shop/keys')!;
  assert.match(key.auth, /^Bearer ghs_/);
  assert.equal(JSON.parse(key.body).read_only, true);

  const on = ok(await c.h('coolify.auto_deploy', { serverId: srv, uuid: 'shopapp01', on: true }));
  assert.equal(on.webhook, 9);
  const hook = g.st.repos.get('shop')!.hooks[0];
  assert.equal(hook.config.url, 'https://coolify.example.com/webhooks/source/github/events/manual?app=shopapp01');
  assert.equal(hook.config.secret, cool.app.manual_webhook_secret_github);
});

test('Coolify on an old install: the deploy key and the webhook say what to do, and nothing is left behind', async () => {
  const g = await fakeGithub(), p = await person();
  oldConnection(p, g);
  const { c: cool, srv } = await onCoolify(p);
  privateRepo(g);
  const e = failed(await p.h('coolify.create_app', CREATE(srv)));
  assert.equal(e.code, 'github_rights');
  assert.match(e.message, new RegExp(`Open ${PERMISSIONS}, set .*Administration.*Accept new permissions`, 's'));
  assert.deepEqual(cool.keys, [], 'the half made in Coolify is taken back');
  assert.deepEqual(cool.made, []);

  const on = ok(await p.h('coolify.auto_deploy', { serverId: srv, uuid: 'shopapp01', on: true }));
  assert.equal(on.on, true);
  assert.equal(on.webhook, undefined);
  assert.match(on.next, new RegExp(`Open ${PERMISSIONS}, set .*Webhooks`));
  assert.equal(cool.app.manual_webhook_secret_github, undefined, 'no secret set for a webhook that isn’t there');
});
