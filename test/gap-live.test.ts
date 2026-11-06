// Put this live, offline against one fake Vercel and a real local git remote: a new project, hashes first, only the missing
// files sent, the build followed to its end, the address checked. Plus what must stop it: keys in a plain site, a folder
// from an AI, a name that exists, a build that fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { liveTiming } from '../src/live/vercel.ts';
import { pushFolder } from '../src/connectors/github.ts';
import { secretsIn, walk } from '../src/live/source.ts';
import { verdictsOf } from '../src/care/checkup.ts';
import { findTools } from '../src/ops/index.ts';
import { saveUpload, packFolder } from '../src/connectors/folder.ts';

liveTiming.pollMs = 1; liveTiming.answerMs = 20;
const site = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  for (const [k, v] of Object.entries(files)) { mkdirSync(join(dir, k, '..'), { recursive: true }); writeFileSync(join(dir, k), v); }
  return dir;
};
const sha = (s: string) => createHash('sha1').update(s).digest('hex');

function fakeVercel(o: { exists?: boolean; build?: 'READY' | 'ERROR' } = {}) {
  const st = { uploaded: [] as string[], projects: [] as any[], deploys: 0, bodies: [] as any[], env: [] as any[], logs: 0 };
  return fakeApi(({ method, path, body, headers }: Req) => {
    const u = new URL(path, 'http://x'), p = u.pathname;
    if (p === '/vercel/v2/user') return { user: { username: 'ada', defaultTeamId: null } };
    if (p === '/vercel/v9/projects/shop') return o.exists ? { id: 'prj_shop', name: 'shop' } : [404, { error: { code: 'not_found' } }];
    if (p === '/vercel/v11/projects' && method === 'POST') { st.projects.push(JSON.parse(body)); return { id: 'prj_new', name: JSON.parse(body).name }; }
    if (p === '/vercel/v10/projects/prj_new/env') { if (method === 'POST') st.env.push(JSON.parse(body)); return { envs: [] }; }
    if (p === '/vercel/v2/files' && method === 'POST') { st.uploaded.push(String(headers['x-vercel-digest'])); return {}; }
    if (p === '/vercel/v13/deployments' && method === 'POST') {
      const b = JSON.parse(body); st.bodies.push(b); st.deploys++;
      const missing = (b.files as { sha: string }[]).map((f) => f.sha).filter((s) => !st.uploaded.includes(s));
      if (missing.length) return [400, { error: { code: 'missing_files', message: 'Missing files', missing } }];
      return { id: 'dpl_1', url: 'shop-abc.vercel.app', readyState: 'QUEUED' };
    }
    if (p === '/vercel/v13/deployments/dpl_1') return o.build === 'ERROR' ? { id: 'dpl_1', readyState: 'ERROR', errorMessage: 'Command "npm run build" exited with 1' } : { id: 'dpl_1', readyState: 'READY', url: 'shop-abc.vercel.app', alias: ['shop.example.com'] };
    if (p === '/vercel/v3/deployments/dpl_1/events') { st.logs++; return [{ text: 'npm ERR! missing script' }]; }
    if (p === '/site') return 'fine';
    return undefined;
  }).then((api) => Object.assign(api, { st }));
}
const setup = async (o?: Parameters<typeof fakeVercel>[0]) => {
  const app = testApp(), org = await testOrg(app), api = await fakeVercel(o);
  process.env.UNIT7_VERCEL_API = `${api.base}/vercel`;
  const acc = account(app, org.orgId, 'vercel', 'tok-demo', 'Vercel demo');
  return { app, org, api, acc, close: () => { api.close(); delete process.env.UNIT7_VERCEL_API; } };
};
const upload = async (app: any, org: any, dir: string) => saveUpload(app, org.orgId, org.userId, await packFolder(dir, undefined, { keepBuild: true }));

test('a new site goes live on Vercel: a project, only what’s missing is sent, the build is followed, and it says the address', async () => {
  const s = await setup(), dir = site({ 'index.html': '<h1>hi</h1>', 'about.html': 'about', '.env': 'SECRET=1', 'server.pem': 'x' });
  try {
    const uploadId = await upload(s.app, s.org, dir);
    const out = ok<any>(await s.org.h('live.put', { uploadId, to: 'vercel', name: 'shop' }));
    assert.equal(s.api.st.projects.length, 1, 'made a project');
    assert.equal(s.api.st.projects[0].name, 'shop');
    assert.equal(s.api.st.deploys, 2, 'hashes first, then once the files are there');
    assert.deepEqual(s.api.st.uploaded.sort(), [sha('<h1>hi</h1>'), sha('about')].sort(), 'only the site’s files, never .env or a key');
    assert.equal(s.api.st.bodies[1].target, 'production');
    assert.equal(out.url, 'https://shop.example.com');
    assert.equal(out.host, 'vercel');
  } finally { s.close(); }
});

test('settings go to the project, an existing name stops it, and a failed build says why with its log', async () => {
  const s = await setup(), dir = site({ 'package.json': JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: { build: 'next build' } }), 'app/page.tsx': 'export default () => null' });
  try {
    const uploadId = await upload(s.app, s.org, dir);
    ok(await s.org.h('live.put', { uploadId, to: 'vercel', name: 'shop', env: { API_KEY: 'value-demo', MODE: 'x' } }));
    const sent = s.api.st.env[0] as { key: string; type: string }[];
    assert.equal(sent.find((e) => e.key === 'API_KEY')!.type, 'encrypted');
    assert.equal(sent.find((e) => e.key === 'MODE')!.type, 'plain');
  } finally { s.close(); }
  const t = await setup({ exists: true });
  try {
    const dir2 = site({ 'index.html': 'x' }), uploadId = await upload(t.app, t.org, dir2);
    const r = await t.org.h('live.put', { uploadId, to: 'vercel', name: 'shop' });
    assert.equal(r.status, 'error');
    assert.match((r as any).error.message, /already exists/);
  } finally { t.close(); }
  const f = await setup({ build: 'ERROR' });
  try {
    const dir3 = site({ 'index.html': 'x' }), uploadId = await upload(f.app, f.org, dir3);
    const r = await f.org.h('live.put', { uploadId, to: 'vercel', name: 'shop' }) as any;
    assert.equal(r.status, 'error');
    assert.match(r.error.message, /couldn’t build it: Command/);
    assert.match(r.error.logTail, /missing script/);
  } finally { f.close(); }
});

test('a plain website holding a real key never goes out, and a key that’s public by design doesn’t stop it', async () => {
  const s = await setup();
  try {
    const bad = site({ 'index.html': 'x', 'app.js': `const k = "sk_live_${'a1'.repeat(14)}"` });
    const r = await s.org.h('live.put', { uploadId: await upload(s.app, s.org, bad), to: 'vercel', name: 'shop' }) as any;
    assert.equal(r.status, 'error');
    assert.match(r.error.message, /secret keys on the internet.*app\.js/);
    assert.equal(s.api.st.projects.length, 0, 'nothing was created');
    assert.equal(s.api.st.uploaded.length, 0);
    const fine = site({ 'index.html': 'x', 'app.js': `const anon = "eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}"`, 'test/key.test.ts': `"sk_live_${'a1'.repeat(14)}"` });
    assert.deepEqual(secretsIn(walk(fine)), []);
  } finally { s.close(); }
});

test('an AI can’t publish a folder from this computer, but it can publish an upload', async () => {
  const s = await setup(), dir = site({ 'index.html': 'x' });
  try {
    const r = await s.org.a('live.put', { folder: dir, to: 'vercel', name: 'shop' });
    assert.equal(r.status, 'denied');
    const listed = await s.org.a('live.options', { folder: dir });
    assert.equal(listed.status, 'denied');
    const out = await s.org.a('live.put', { uploadId: await upload(s.app, s.org, dir), to: 'vercel', name: 'shop' });
    assert.equal(out.status, 'ok', 'a brand-new project only creates, so it runs');
    const again = await s.org.a('live.put', { uploadId: await upload(s.app, s.org, dir), to: 'vercel', name: 'shop', update: true });
    assert.notEqual((again as any).status, 'denied');
  } finally { s.close(); }
});

test('an AI can’t move a stored key onto a site, where code could read it', async () => {
  const s = await setup(), dir = site({ 'index.html': 'x' });
  try {
    const r = await s.org.a('live.put', { uploadId: await upload(s.app, s.org, dir), to: 'vercel', name: 'shop', env: { X: 'credential://vercel/any/token' } }) as any;
    assert.equal(r.status, 'error');
    assert.match(r.error.message, /A person has to put a stored key/);
    assert.equal(s.api.st.projects.length, 0, 'it stops before anything is made');
  } finally { s.close(); }
});

test('live.options ranks what’s connected and says when nothing can host it', async () => {
  const s = await setup();
  try {
    const dir = site({ 'index.html': 'x' });
    const o = ok<any>(await s.org.h('live.options', { folder: dir }));
    assert.equal(o.site.stack, 'static');
    assert.equal(o.places[0].to, 'vercel');
    assert.equal(o.places[0].ok, true);
    const docker = site({ Dockerfile: 'FROM node:24\nEXPOSE 3000\nCMD ["node","a.js"]\n', 'a.js': 'x' });
    const d = ok<any>(await s.org.h('live.options', { folder: docker }));
    assert.equal(d.places.filter((p: any) => p.ok).length, 0);
    assert.match(d.next, /Nothing connected can host/);
  } finally { s.close(); }
});

test('a push is one commit from a throwaway folder, and a second one lands on top with no force', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-')), remote = join(root, 'demo', 'site.git');
  mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  process.env.UNIT7_GITHUB_URL = `file://${root}`;
  const dir = site({ 'index.html': 'one', 'a/b.txt': 'two' });
  const repo = { owner: 'demo', name: 'site' };
  try {
    await pushFolder(walk(dir), repo, undefined, { branch: 'main', message: 'First', existing: false });
    const dir2 = site({ 'index.html': 'changed' });
    await pushFolder(walk(dir2), repo, undefined, { branch: 'main', message: 'Second', existing: true });
    const log = execFileSync('git', ['--git-dir', remote, 'log', '--format=%s', 'main']).toString().trim().split('\n');
    assert.deepEqual(log, ['Second', 'First']);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'show', 'main:index.html']).toString(), 'changed');
    assert.throws(() => execFileSync('git', ['--git-dir', remote, 'show', 'main:a/b.txt'], { stdio: 'ignore' }), 'a file taken out of the folder is gone from the new version');
    assert.ok(execFileSync('git', ['--git-dir', remote, 'show', 'main~1:a/b.txt']).toString().includes('two'), 'and stays in history');
  } finally { delete process.env.UNIT7_GITHUB_URL; }
});

test('a failed test restore is urgent, whatever else looks fine', () => {
  const g = (over: object) => ({ important: true, level: 'protected', ...over }) as any;
  const v = verdictsOf({ room: [], protection: [g({ failed: 'came back short' }), g({ level: 'proven' })], items: [], coverage: undefined as any });
  assert.equal(v.verdicts.protection.tone, 'act');
  assert.match(v.verdicts.protection.line, /1 of 2 failed a test restore/);
  assert.equal(v.level, 'act');
});

test('nothing found says so plainly, so an AI can’t quietly stop at a dead end', async () => {
  const app = testApp(), org = await testOrg(app);
  assert.equal(findTools('xyzzy plover').length, 0);
  const r = ok<any>(await org.h('tools.find', { query: 'xyzzy plover' }));
  assert.match(r.none, /Say so plainly/);
});
