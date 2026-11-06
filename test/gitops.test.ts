// Push to deploy and PR previews, end to end but offline: a real local git repo stands in for GitHub
// (git ls-remote works on file:// URLs) and a fake API records statuses and comments. There's no
// server, so the deploys themselves fail — what's tested is the detection, the bookkeeping, the
// GitHub feedback, fork safety, and cleanup.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { parseRepo } from '../src/connectors/github.ts';

// a bare repo at <root>/ada/shop.git with commits pushed from a work tree
const root = mkdtempSync(join(tmpdir(), 'unit7-gh-'));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
execFileSync('mkdir', ['-p', join(root, 'ada')]);
git(root, 'init', '--bare', '-b', 'main', join(root, 'ada', 'shop.git'));
const work = mkdtempSync(join(tmpdir(), 'unit7-work-'));
git(work, 'init', '-b', 'main'); git(work, 'remote', 'add', 'origin', join(root, 'ada', 'shop.git'));
const commit = (msg: string) => { writeFileSync(join(work, 'f.txt'), msg); git(work, 'add', '.'); git(work, 'commit', '-m', msg); git(work, 'push', '-q', 'origin', 'main'); return git(work, 'rev-parse', 'HEAD'); };

// the fake GitHub API
let pulls: unknown[] = [];
const calls: { method: string; path: string; body: any }[] = [];
const api = createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
    calls.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/repos/ada/shop/pulls')) return res.end(JSON.stringify(pulls));
    if (req.url!.includes('/comments') && req.method === 'GET') return res.end('[]');
    res.end('{}');
  });
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
process.env.UNIT7_GITHUB_URL = `file://${root}`;
process.env.UNIT7_GITHUB_API = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
after(() => api.close());

const app = testApp();

test('repo urls in every shape', () => {
  for (const u of ['ada/shop', 'https://github.com/ada/shop', 'https://github.com/ada/shop.git', 'git@github.com:ada/shop.git', 'https://x-access-token:abc@github.com/ada/shop.git'])
    assert.deepEqual(parseRepo(u), { owner: 'ada', name: 'shop' }, u);
});

test('a new commit is deployed once (not every minute), and GitHub hears about it', async () => {
  const o = await testOrg(app);
  ok(await o.h('account.connect', { provider: 'github', token: 'ghp_testtokentesttoken0123456789' }));
  const env = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id;
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'https://github.com/ada/shop.git', branch: 'main' } })).serviceId;
  // never deployed by hand: auto-deploy leaves it alone
  assert.equal(ok(await o.h('service.sync_git', { serviceId: svc })).note, 'deploy it once by hand first');
  run(app.db, 'UPDATE services SET current_deployment_id = ? WHERE id = ?', id('dep'), svc);

  const sha1 = commit('one');
  const r1 = ok(await o.h('service.sync_git', { serviceId: svc }));
  assert.equal(r1.sha, sha1);
  assert.notEqual(r1.status, 'ok'); // no server here, so the deploy itself fails
  const statuses = calls.filter((c) => c.path === `/repos/ada/shop/statuses/${sha1}`).map((c) => c.body.state);
  assert.deepEqual(statuses, ['pending', 'failure']);

  // the same commit again: nothing happens, even though it failed
  calls.length = 0;
  const r2 = ok(await o.h('service.sync_git', { serviceId: svc }));
  assert.equal(r2.deployed, false);
  assert.equal(calls.length, 0);

  // a new commit: deployed again
  const sha2 = commit('two');
  assert.equal(ok(await o.h('service.sync_git', { serviceId: svc })).sha, sha2);
});

test('previews: one per same-repo PR, never a fork, removed when the PR closes', async () => {
  const o = await testOrg(app, 'Bo');
  ok(await o.h('account.connect', { provider: 'github', token: 'ghp_testtokentesttoken0123456789' }));
  const env = ok(await o.h('project.create', { name: 'Shop2', environments: ['production'] })).environments[0].id;
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'ada/shop', branch: 'main' } })).serviceId;
  run(app.db, 'UPDATE services SET current_deployment_id = ? WHERE id = ?', id('dep'), svc);
  pulls = [
    { number: 7, title: 'feature', html_url: 'https://github.com/ada/shop/pull/7', head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'ada/shop' } } },
    { number: 8, title: 'from a fork', html_url: 'https://github.com/ada/shop/pull/8', head: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'evil/shop' } } },
  ];
  calls.length = 0;
  const r = ok(await o.h('service.sync_previews', { serviceId: svc }));
  assert.deepEqual(r.previews.map((p: any) => p.pr), [7], 'the fork PR is never built');
  const prev = get<{ id: string; environment_id: string; config: string }>(app.db, `SELECT id, environment_id, config FROM services WHERE json_extract(config, '$.previewOf') = ?`, svc)!;
  assert.equal(JSON.parse(prev.config).source.branch, 'feature');
  assert.equal(get<{ slug: string; autonomy: number }>(app.db, 'SELECT slug, autonomy FROM environments WHERE id = ?', prev.environment_id)!.slug, 'previews');
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/repos/ada/shop/issues/7/comments' && /Unit7/.test(c.body.body)), 'a comment on the PR');
  assert.ok(calls.some((c) => c.path === `/repos/ada/shop/statuses/${'a'.repeat(40)}` && c.body.context === 'Unit7 preview'));
  assert.ok(!calls.some((c) => c.path.includes('/issues/8/')), 'nothing posted on the fork PR');

  // PR closed → preview removed
  pulls = [];
  const r2 = ok(await o.h('service.sync_previews', { serviceId: svc }));
  assert.deepEqual(r2.previews, [{ pr: 7, status: 'removed' }]);
  assert.equal(get(app.db, 'SELECT 1 FROM services WHERE id = ?', prev.id), undefined);
});
