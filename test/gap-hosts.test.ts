// More places to put a site, offline. Netlify and Cloudflare are fake APIs, GitHub is a fake API with a real local git remote,
// Hostinger is its real MCP server talking to a fake REST API (so its error shapes and archive checks are the real ones),
// and a server is Unit7's own tools with only the deploy stood in for. Each host: it goes live, a refusal reads in plain
// words, and a site it can't take says what would. Plus what would be easy to get wrong: nothing that exists gets
// overwritten without update, and files Unit7 left out stay out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { all, get, id, json, run } from '../src/db.ts';
import { getTool } from '../src/tools/runtime.ts';
import { liveTiming } from '../src/live/vercel.ts';
import { blake3, pagesHash } from '../src/live/blake3.ts';
import { packFiles, packFolder, saveUpload } from '../src/connectors/folder.ts';
import { pushFolder } from '../src/connectors/github.ts';
import { hostinger } from '../src/connectors/hostinger.ts';
import { CATALOG } from '../src/connectors/oneclick.ts';
import { walk } from '../src/live/source.ts';

liveTiming.pollMs = 1; liveTiming.answerMs = 20;

const site = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  for (const [k, v] of Object.entries(files)) { mkdirSync(join(dir, k, '..'), { recursive: true }); writeFileSync(join(dir, k), v); }
  return dir;
};
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const inTar = (tgz: Buffer) => {
  const f = join(mkdtempSync(join(tmpdir(), 'tar-')), 'a.tgz');
  writeFileSync(f, tgz);
  return execFileSync('tar', ['-tzf', f]).toString().split('\n').filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^\.\//, '')).sort();
};
async function base() {
  const app = testApp(), org = await testOrg(app);
  return { app, org, upload: async (dir: string) => saveUpload(app, org.orgId, org.userId, await packFolder(dir, undefined, { keepBuild: true })) };
}
// a stand-in for public DNS, so domain.point really runs with no query leaving this computer
function fakeDns(zone: string, ns: string) {
  const p = Resolver.prototype as any, real = { soa: p.resolveSoa, ns: p.resolveNs, a: p.resolve4, cname: p.resolveCname };
  p.resolveSoa = async (n: string) => { if (n !== zone) throw new Error('no zone here'); return {}; };
  p.resolveNs = async () => [ns]; p.resolve4 = async () => []; p.resolveCname = async () => [];
  return () => { p.resolveSoa = real.soa; p.resolveNs = real.ns; p.resolve4 = real.a; p.resolveCname = real.cname; };
}

const VITE = { 'package.json': JSON.stringify({ dependencies: { vite: '7.0.0' }, scripts: { build: 'vite build' } }), 'src/main.js': 'the source', 'index.html': '<script src="/src/main.js"></script>' };
const NEXT = { 'package.json': JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: { build: 'next build' } }), 'app/page.tsx': 'export default () => null' };
const EXPRESS = { 'package.json': JSON.stringify({ dependencies: { express: '5.0.0' }, scripts: { start: 'node server.js' } }), 'server.js': 'listen()' };
const DOCKER = { Dockerfile: 'FROM node:24\nEXPOSE 3000\nCMD ["node","a.js"]\n', 'a.js': 'x' };
const PYTHON = { 'requirements.txt': 'flask\n', 'app.py': 'app = 1' };

test('BLAKE3 gives the official test vectors, and a Pages name is wrangler’s: the base64 of the file plus its extension', () => {
  const vectors: Record<number, string> = {
    0: 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262', 1: '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213',
    64: '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98', 65: 'de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee',
    1023: '10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11', 1024: '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7',
    1025: 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444', 2048: 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a',
    2049: '5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030', 3073: '7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3',
    8193: 'bab6c09cb8ce8cf459261398d2e7aef35700bf488116ceb94a36d0f5f1b7bc3b', 31744: '62b6960e1a44bcc1eb1a611a8d6235b6b4b78f32e7abc4fb4c6cdcce94895c47',
    102400: 'bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085',
  };
  for (const [len, want] of Object.entries(vectors)) assert.equal(blake3(Uint8Array.from({ length: Number(len) }, (_, i) => i % 251)), want, `${len} bytes`);
  const bytes = Buffer.from('<h1>hi</h1>');
  assert.equal(pagesHash(bytes, 'a/index.html'), blake3(Buffer.from(`${bytes.toString('base64')}html`)).slice(0, 32));
  assert.notEqual(pagesHash(bytes, 'a.html'), pagesHash(bytes, 'a.txt'), 'the extension is part of the name');
  assert.match(pagesHash(bytes, 'noextension'), /^[0-9a-f]{32}$/);
});

test('only the files Unit7 checked are packed: odd names work and nothing else gets in', async () => {
  const dir = site({ 'a b.txt': '1', '-x.txt': '2', 'ünï.txt': '3', 'sub/c.txt': '4', 'left-out.txt': '5' });
  assert.deepEqual(inTar(await packFiles(dir, ['a b.txt', '-x.txt', 'ünï.txt', 'sub/c.txt'])), ['-x.txt', 'a b.txt', 'sub/c.txt', 'ünï.txt'].sort());
});

// --- Netlify --------------------------------------------------------------------------------------------------------

function fakeNetlify(o: { sites?: any[]; known?: string[]; takenName?: boolean; refuseDeploy?: boolean; failDeploy?: boolean } = {}) {
  const st = { sites: [...o.sites ?? []], offered: {} as Record<string, string>, put: new Map<string, string>(), deploys: [] as any[], polls: 0, restored: [] as string[], env: [] as any[], removed: [] as string[], patched: [] as any[] };
  const missing = () => Object.entries(st.offered).filter(([, sha]) => !o.known?.includes(sha));
  return fakeApi(({ method, path, body }: Req) => {
    const p = new URL(path, 'http://x').pathname;
    if (p === '/netlify/sites' && method === 'GET') return st.sites;
    if (p === '/netlify/sites' && method === 'POST') {
      if (o.takenName) return [422, { errors: { subdomain: ['must be unique'] } }];
      const made = { id: 'site-1', name: JSON.parse(body).name, account_id: 'a1', ssl_url: 'https://shop.netlify.example' };
      st.sites.push(made);
      return [201, made];
    }
    if (p === '/netlify/sites/site-1/deploys' && method === 'POST') {
      if (o.refuseDeploy) return [429, { message: 'You have reached the deploy limit of 3 a minute.' }];
      const b = JSON.parse(body); st.deploys.push(b); st.offered = b.files;
      return { id: 'd2', state: 'preparing' };
    }
    if (p === '/netlify/sites/site-1/deploys/d2') {
      if (++st.polls === 1) return { id: 'd2', state: 'preparing' };
      if (o.failDeploy) return { id: 'd2', state: 'error', error_message: 'Deploy directory is too big' };
      const left = missing().filter(([path]) => !st.put.has(path));
      return left.length ? { id: 'd2', state: 'prepared', required: [...new Set(left.map(([, sha]) => sha))] } : { id: 'd2', state: 'ready' };
    }
    const f = /^\/netlify\/deploys\/d2\/files(\/.+)$/.exec(p);
    if (f && method === 'PUT') { st.put.set(decodeURIComponent(f[1]!), body); return {}; }
    if (p === '/netlify/sites/site-1') return st.sites[0];
    if (p === '/netlify/sites/site-1/deploys/d1/restore' && method === 'POST') { st.restored.push('d1'); return [201, { id: 'd1' }]; }
    if (p === '/netlify/accounts/a1/env') { if (method === 'POST') st.env.push(...JSON.parse(body)); return st.env.map((e) => ({ key: e.key, values: [{ context: 'all', value: e.values[0].value }] })); }
    const e = /^\/netlify\/accounts\/a1\/env\/(\w+)$/.exec(p);
    if (e && method === 'DELETE') { st.removed.push(e[1]!); st.env = st.env.filter((x) => x.key !== e[1]); return [204, '']; }
    return undefined;
  }).then((api) => Object.assign(api, { st }));
}
async function onNetlify(o?: Parameters<typeof fakeNetlify>[0]) {
  const b = await base(), api = await fakeNetlify(o);
  process.env.UNIT7_NETLIFY_API = `${api.base}/netlify`;
  return { ...b, api, st: api.st, acc: account(b.app, b.org.orgId, 'netlify', 'netlify-demo-token', 'Netlify demo'), close: () => { api.close(); delete process.env.UNIT7_NETLIFY_API; } };
}

test('Netlify: a built site goes up from dist, only what it asks for is sent, and it waits until it’s ready', async () => {
  const s = await onNetlify({ known: [sha1('already there')] });
  try {
    const dir = site({ ...VITE, 'dist/index.html': '<h1>built</h1>', 'dist/my page.html': 'with a space', 'dist/same-1.txt': 'twin', 'dist/same-2.txt': 'twin', 'dist/old.txt': 'already there', 'dist/deploy.pem': 'a key file', '.env': 'SECRET=1' });
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(dir), to: 'netlify', name: 'shop' }));
    assert.equal(out.url, 'https://shop.netlify.example');
    assert.equal(out.host, 'netlify');
    assert.equal(out.project, 'site-1');
    assert.equal(out.deployment, 'd2');
    assert.deepEqual(Object.keys(s.st.offered).sort(), ['/index.html', '/my page.html', '/old.txt', '/same-1.txt', '/same-2.txt'], 'the folder’s own paths, with no source and no key file');
    assert.equal(s.st.deploys[0].async, true);
    assert.equal(s.st.deploys[0].draft, false, 'it goes live, not to a draft address');
    assert.deepEqual([...s.st.put.keys()].sort(), ['/index.html', '/my page.html', '/same-1.txt', '/same-2.txt'], 'both twins, and nothing Netlify already had');
    assert.equal(s.st.put.get('/my page.html'), 'with a space');
  } finally { s.close(); }
});

test('Netlify: refusals say what happened and what to do', async () => {
  const dir = site({ 'index.html': 'hi' });
  const a = await onNetlify({ takenName: true });
  try {
    const r = await a.org.h('live.put', { uploadId: await a.upload(dir), to: 'netlify', name: 'shop' }) as any;
    assert.match(r.error.message, /Someone else’s Netlify site is already called shop\. Choose another name/);
  } finally { a.close(); }
  const b = await onNetlify({ refuseDeploy: true });
  try {
    const r = await b.org.h('live.put', { uploadId: await b.upload(dir), to: 'netlify', name: 'shop' }) as any;
    assert.match(r.error.message, /^Netlify refused to start the upload: You have reached the deploy limit/);
  } finally { b.close(); }
  const c = await onNetlify({ failDeploy: true });
  try {
    const r = await c.org.h('live.put', { uploadId: await c.upload(dir), to: 'netlify', name: 'shop' }) as any;
    assert.match(r.error.message, /^Netlify couldn’t publish it: Deploy directory is too big/);
  } finally { c.close(); }
});

test('Netlify: a site it can’t take says what would, and linking a repo is called one browser step', async () => {
  const s = await onNetlify();
  try {
    const put = async (files: Record<string, string>) => (await s.org.h('live.put', { uploadId: await s.upload(site(files)), to: 'netlify', name: 'shop' }) as any).error.message;
    assert.match(await put(NEXT), /Netlify takes finished files.*Run npm run build.*Vercel, Coolify or your own server.*one step in the browser/);
    assert.match(await put(DOCKER), /doesn’t run Docker\. Your own server or Coolify does/);
    assert.match(await put({ ...EXPRESS, 'dist/index.html': 'pages of a server app' }), /not an always-on express app\. Your own server or Coolify runs it/);
    assert.match(await put(PYTHON), /not an always-on python-flask app/);
    assert.equal(s.st.deploys.length, 0);
  } finally { s.close(); }
});

test('Netlify: a live site stays until update says so, and then the version before can be put back', async () => {
  const live = { id: 'site-1', name: 'shop', account_id: 'a1', ssl_url: 'https://shop.netlify.example', published_deploy: { id: 'd1' } };
  const s = await onNetlify({ sites: [live] });
  try {
    const uploadId = await s.upload(site({ 'index.html': 'v2' }));
    const r = await s.org.h('live.put', { uploadId, to: 'netlify', name: 'shop' }) as any;
    assert.match(r.error.message, /already exists on this Netlify account/);
    assert.equal(s.st.deploys.length, 0, 'nothing went up');
    const out = ok<any>(await s.org.h('live.put', { uploadId, to: 'netlify', name: 'shop', update: true }));
    assert.match(out.notes.join(' '), /change\.undo with changeId chg_/);
    const change = get<{ id: string }>(s.app.db, `SELECT id FROM changes WHERE verb = 'live.netlify'`)!;
    ok(await s.org.h('change.undo', { changeId: change.id }));
    assert.deepEqual(s.st.restored, ['d1']);
  } finally { s.close(); }
  const half = await onNetlify({ sites: [{ ...live, published_deploy: null }] });
  try {
    ok(await half.org.h('live.put', { uploadId: await half.upload(site({ 'index.html': 'x' })), to: 'netlify', name: 'shop' }));
    assert.equal(half.st.deploys.length, 1, 'a first try that stopped half way can simply run again');
  } finally { half.close(); }
});

test('Netlify: settings never come back, and a domain reaches the site by its id, not its name', async () => {
  const s = await onNetlify(), restore = fakeDns('shop.example', 'ns.unknown-dns.example');
  try {
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(site({ 'index.html': 'x' })), to: 'netlify', name: 'shop', domain: 'www.shop.example', env: { MODE: 'a' } }));
    assert.equal(s.st.env[0].key, 'MODE');
    assert.match(out.notes.join(' '), /finished files, so they can’t read settings/);
    assert.equal(out.domain.dns, 'needs you', 'told what to add, since no DNS account is connected');
    assert.equal(out.domain.addThese[0].value, 'shop.netlify.app');
    const set = ok<any>(await s.org.h('live.env', { to: 'netlify', project: 'site-1', op: 'set', key: 'OTHER', value: 'hidden-value' }));
    assert.deepEqual(set.settings.map((e: any) => e.key).sort(), ['MODE', 'OTHER']);
    assert.ok(!JSON.stringify(set).includes('hidden-value'));
    ok(await s.org.h('live.env', { to: 'netlify', project: 'site-1', op: 'unset', key: 'OTHER' }));
    assert.deepEqual(s.st.removed, ['OTHER']);
    const logs = await s.org.h('live.logs', { to: 'netlify', project: 'site-1' }) as any;
    assert.match(logs.error.message, /doesn’t give its logs to Unit7/);
  } finally { restore(); s.close(); }
});

test('a key in built files stops the upload, and one left in the source doesn’t', async () => {
  const s = await onNetlify(), key = `sk_live_${'a1'.repeat(14)}`;
  try {
    const bad = site({ ...VITE, 'dist/index.html': 'x', 'dist/app.js': `const k = "${key}"` });
    const r = await s.org.h('live.put', { uploadId: await s.upload(bad), to: 'netlify', name: 'shop' }) as any;
    assert.match(r.error.message, /secret keys on the internet: dist\/app\.js/);
    assert.equal(s.st.sites.length, 0, 'it stops before anything is made');
    const fine = site({ ...VITE, 'src/main.js': `const k = "${key}"`, 'dist/index.html': 'x' });
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(fine), to: 'netlify', name: 'shop' }));
    assert.match(out.notes.join(' '), /src\/main\.js/, 'still said');
    assert.deepEqual(Object.keys(s.st.offered), ['/index.html']);
  } finally { s.close(); }
});

// --- Cloudflare Pages -------------------------------------------------------------------------------------------------

const P = '/cf/accounts/acct1/pages/projects/shop';
function fakeCloudflare(o: { project?: any; oldToken?: boolean; known?: string[]; stage?: { name: string; status: string }; noCreate?: boolean } = {}) {
  const st = { project: o.project, created: [] as any[], buckets: [] as any[], upserted: [] as string[][], form: '', contentType: '', patched: [] as any[], domains: [] as string[], records: [] as any[], rollbacks: [] as string[], known: new Set(o.known) };
  const good = (result: unknown) => ({ success: true, errors: [], messages: [], result });
  const no = (status: number, message: string, code = 1000) => [status, { success: false, errors: [{ code, message }], messages: [], result: null }];
  return fakeApi(({ method, path, body, auth, headers }: Req) => {
    const p = new URL(path, 'http://x').pathname;
    if (p === '/cf/accounts') return good([{ id: 'acct1', name: 'Demo' }]);
    if (o.oldToken && p.includes('/pages')) return no(403, 'Authentication error', 10000);
    if (p === P && method === 'PATCH') { st.patched.push(JSON.parse(body)); st.project.deployment_configs = JSON.parse(body).deployment_configs; return good(st.project); }
    if (p === P) return st.project ? good(st.project) : no(404, 'Project not found', 8000007);
    if (p === '/cf/accounts/acct1/pages/projects' && method === 'POST') {
      if (o.noCreate) return no(400, 'You have reached the limit of 100 projects.');
      st.created.push(JSON.parse(body));
      st.project = { name: 'shop', subdomain: 'shop-x7.pages.example', production_branch: 'main' };
      return good(st.project);
    }
    if (p === `${P}/upload-token`) return good({ jwt: 'upload-jwt-demo' });
    if (p.startsWith('/cf/pages/assets/')) {
      if (auth !== 'Bearer upload-jwt-demo') return no(401, 'That upload token isn’t valid');
      const b = JSON.parse(body);
      if (p.endsWith('/check-missing')) return good(b.hashes.filter((h: string) => !st.known.has(h)));
      if (p.endsWith('/upload')) { st.buckets.push(b); for (const f of b) st.known.add(f.key); return good({}); }
      if (p.endsWith('/upsert-hashes')) { st.upserted.push(b.hashes); return no(500, 'not today'); }
    }
    if (p === `${P}/deployments` && method === 'POST') {
      st.form = body; st.contentType = String(headers['content-type']);
      return good({ id: 'dep2', url: 'https://abc.shop-x7.pages.example', latest_stage: { name: 'queued', status: 'active' } });
    }
    if (p === `${P}/deployments/dep2`) return good({ id: 'dep2', latest_stage: o.stage ?? { name: 'deploy', status: 'success' } });
    if (p === `${P}/deployments`) return good([{ id: 'dep2' }]);
    if (p === `${P}/deployments/dep2/history/logs`) return good({ total: 1, data: [{ ts: 'now', line: 'Success: Your site was deployed!' }] });
    if (p === `${P}/deployments/dep1/rollback`) { st.rollbacks.push('dep1'); return good({ id: 'dep1' }); }
    if (p === `${P}/domains` && method === 'POST') { st.domains.push(JSON.parse(body).name); return good({ name: JSON.parse(body).name }); }
    if (p === '/cf/zones') return good([{ id: 'z1', name: 'shop.example' }]);
    if (p === '/cf/zones/z1/dns_records') { if (method === 'POST') st.records.push(JSON.parse(body)); return good(method === 'POST' ? { id: 'r1' } : []); }
    return undefined;
  }).then((api) => Object.assign(api, { st }));
}
async function onCloudflare(o?: Parameters<typeof fakeCloudflare>[0]) {
  const b = await base(), api = await fakeCloudflare(o);
  process.env.UNIT7_CLOUDFLARE_API = `${api.base}/cf`;
  return { ...b, api, st: api.st, acc: account(b.app, b.org.orgId, 'cloudflare', 'cf-demo-token', 'Cloudflare demo'), close: () => { api.close(); delete process.env.UNIT7_CLOUDFLARE_API; } };
}

test('Cloudflare Pages: the project is made, hashes go first, only what’s missing is sent, with a token of its own, and it answers on its real address', async () => {
  const known = pagesHash(Buffer.from('already there'), 'old.txt');
  const s = await onCloudflare({ known: [known] });
  try {
    const dir = site({ ...VITE, 'dist/index.html': '<h1>built</h1>', 'dist/app.js': 'built', 'dist/old.txt': 'already there', 'dist/_redirects': '/* /index.html 200', 'dist/_headers': '/*\n  X-Demo: yes' });
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(dir), to: 'cloudflare-pages', name: 'shop' }));
    assert.deepEqual(s.st.created, [{ name: 'shop', production_branch: 'main' }]);
    assert.equal(out.url, 'https://shop-x7.pages.example', 'the address Cloudflare gave, which can differ from the name');
    assert.equal(out.deployment, 'dep2');
    const sent = s.st.buckets.flat();
    assert.deepEqual(sent.map((f: any) => f.key).sort(), [pagesHash(Buffer.from('<h1>built</h1>'), 'index.html'), pagesHash(Buffer.from('built'), 'app.js')].sort());
    const page = sent.find((f: any) => f.metadata.contentType === 'text/html');
    assert.equal(Buffer.from(page.value, 'base64').toString(), '<h1>built</h1>');
    assert.equal(page.base64, true);
    assert.equal(sent.find((f: any) => f !== page).metadata.contentType, 'text/javascript', 'or the browser would refuse the script');
    assert.match(s.st.contentType, /^multipart\/form-data; boundary=/);
    const manifest = JSON.parse(/name="manifest"\r\n\r\n(.*?)\r\n--/s.exec(s.st.form)![1]!);
    assert.deepEqual(Object.keys(manifest).sort(), ['/app.js', '/index.html', '/old.txt']);
    assert.equal(manifest['/old.txt'], known);
    assert.match(s.st.form, /name="branch"\r\n\r\nmain/, 'the production branch, so it goes live and not to a preview');
    assert.match(s.st.form, /name="_redirects"; filename="_redirects"[\s\S]*\/\* \/index\.html 200/);
    assert.match(s.st.form, /name="_headers"; filename="_headers"[\s\S]*X-Demo: yes/);
    assert.equal(s.st.upserted.length, 1, 'and a failed last step that only speeds up the next deploy stops nothing');
  } finally { s.close(); }
});

test('Cloudflare Pages: an older token, a refusal and a failed deployment each read in plain words', async () => {
  const dir = site({ 'index.html': 'hi' });
  const a = await onCloudflare({ oldToken: true });
  try {
    const r = await a.org.h('live.put', { uploadId: await a.upload(dir), to: 'cloudflare-pages', name: 'shop' }) as any;
    assert.match(r.error.message, /can’t publish sites yet\. In Connections, add a new Cloudflare key: the button pre-fills the right permissions/);
    assert.equal(get<{ status: string }>(a.app.db, 'SELECT status FROM accounts WHERE id = ?', a.acc)!.status, 'verified', 'its DNS still works, so the account isn’t marked as failing');
  } finally { a.close(); }
  const b = await onCloudflare({ noCreate: true });
  try {
    const r = await b.org.h('live.put', { uploadId: await b.upload(dir), to: 'cloudflare-pages', name: 'shop' }) as any;
    assert.equal(r.error.message, 'Cloudflare refused to create the project: You have reached the limit of 100 projects.');
  } finally { b.close(); }
  const c = await onCloudflare({ stage: { name: 'deploy', status: 'failure' } });
  try {
    const r = await c.org.h('live.put', { uploadId: await c.upload(dir), to: 'cloudflare-pages', name: 'shop' }) as any;
    assert.match(r.error.message, /Cloudflare couldn’t publish it \(the deploy step ended with failure\)/);
  } finally { c.close(); }
});

test('Cloudflare Pages: what it can’t take says what would, and code that must never be served isn’t uploaded as a page', async () => {
  const s = await onCloudflare();
  try {
    const put = async (files: Record<string, string>) => (await s.org.h('live.put', { uploadId: await s.upload(site(files)), to: 'cloudflare-pages', name: 'shop' }) as any).error.message;
    assert.match(await put(NEXT), /Cloudflare Pages takes finished files.*Vercel, Coolify or your own server/);
    assert.match(await put(DOCKER), /doesn’t run Docker/);
    assert.match(await put({ 'index.html': 'x', '_worker.js': 'export default {}' }), /own Cloudflare code.*wrangler pages deploy/);
    assert.match(await put({ 'index.html': 'x', 'functions/api.js': 'export const onRequest = 1' }), /own Cloudflare code/);
    const big = site({ 'index.html': 'x' });
    writeFileSync(join(big, 'film.bin'), Buffer.alloc(26 * 1024 * 1024));
    const opts = ok<any>(await s.org.h('live.options', { folder: big }));
    assert.match(opts.places.find((p: any) => p.to === 'cloudflare-pages').why, /up to 25 MB, and film\.bin is bigger/);
    assert.equal(s.st.created.length, 0);
  } finally { s.close(); }
});

test('Cloudflare Pages: a live project stays until update says so, the last version can be put back, and settings, logs and a domain work', async () => {
  const s = await onCloudflare({ project: { name: 'shop', subdomain: 'shop.pages.example', production_branch: 'main', latest_deployment: { id: 'dep1' }, canonical_deployment: { id: 'dep1' } } });
  const restore = fakeDns('shop.example', 'ada.ns.cloudflare.com');
  try {
    const uploadId = await s.upload(site({ 'index.html': 'v2' }));
    const r = await s.org.h('live.put', { uploadId, to: 'cloudflare-pages', name: 'shop' }) as any;
    assert.match(r.error.message, /already exists on this Cloudflare account/);
    assert.equal(s.st.form, '', 'nothing was deployed');
    const out = ok<any>(await s.org.h('live.put', { uploadId, to: 'cloudflare-pages', name: 'shop', update: true, domain: 'shop.example', env: { API_KEY: 'hidden-value', MODE: 'x' } }));
    assert.deepEqual(s.st.domains, ['shop.example']);
    assert.deepEqual(s.st.records.map((x) => [x.type, x.name, x.content]), [['CNAME', 'shop.example', 'shop.pages.example']], 'a bare domain, flattened by Cloudflare');
    assert.match(out.domain.dns[0], /cloudflare: ALIAS shop\.example/);
    assert.deepEqual(s.st.patched[0].deployment_configs.production.env_vars, { API_KEY: { type: 'secret_text', value: 'hidden-value' }, MODE: { type: 'plain_text', value: 'x' } });
    const change = get<{ id: string }>(s.app.db, `SELECT id FROM changes WHERE verb = 'live.pages'`)!;
    ok(await s.org.h('change.undo', { changeId: change.id }));
    assert.deepEqual(s.st.rollbacks, ['dep1']);
    const logs = ok<any>(await s.org.h('live.logs', { to: 'cloudflare-pages', project: 'shop' }));
    assert.deepEqual(logs.lines, ['Success: Your site was deployed!']);
    const env = ok<any>(await s.org.h('live.env', { to: 'cloudflare-pages', project: 'shop', op: 'unset', key: 'MODE' }));
    assert.equal(s.st.patched.at(-1).deployment_configs.production.env_vars.MODE, null, 'null is how Pages removes one');
    assert.ok(!JSON.stringify(env).includes('hidden-value'));
    const bad = await s.org.h('live.logs', { to: 'cloudflare-pages', project: '..' }) as any;
    assert.equal(bad.status, 'error', 'a name can’t walk up the path');
  } finally { restore(); s.close(); }
});

test('the Connections page asks Cloudflare for the right to publish, and still for DNS', () => {
  const url = new URL((CATALOG.find((p) => p.id === 'cloudflare')!.method as { keyUrl: string }).keyUrl);
  const keys = JSON.parse(url.searchParams.get('permissionGroupKeys')!) as { key: string; type: string }[];
  assert.deepEqual(keys.find((k) => k.key === 'page'), { key: 'page', type: 'edit' });
  assert.deepEqual(keys.find((k) => k.key === 'account_settings'), { key: 'account_settings', type: 'read' });
  assert.ok(keys.some((k) => k.key === 'dns'));
});

// --- GitHub Pages -----------------------------------------------------------------------------------------------------

const PAGES = '/gh/repos/demo/shop/pages';
function fakeGithub(root: string, o: { repo?: boolean; pages?: any; plan?: boolean; noRights?: boolean; errored?: boolean } = {}) {
  const st = { created: [] as any[], repo: !!o.repo, pages: o.pages, on: [] as any[], moved: [] as any[], polls: 0, cname: [] as string[] };
  const remote = join(root, 'demo', 'shop.git');
  const head = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/gh-pages']).toString().trim();
  return fakeApi(({ method, path, body }: Req) => {
    const p = new URL(path, 'http://x').pathname;
    if (o.noRights) return [403, { message: 'Resource not accessible by integration' }];
    if (p === '/gh/user') return { login: 'demo' };
    if (p === '/gh/user/repos' && method === 'POST') {
      st.created.push(JSON.parse(body)); st.repo = true;
      mkdirSync(remote, { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      return [201, { owner: { login: 'demo' }, name: 'shop' }];
    }
    if (p === '/gh/repos/demo/shop') return st.repo ? { owner: { login: 'demo' }, name: 'shop', private: false } : [404, { message: 'Not Found' }];
    if (p === PAGES && method === 'GET') return st.pages ?? [404, { message: 'Not Found' }];
    if (p === PAGES && method === 'POST') {
      if (o.plan) return [422, { message: 'Your current plan does not support GitHub Pages for this repository.' }];
      const b = JSON.parse(body); st.on.push(b);
      st.pages = { html_url: 'https://demo.github.example/shop/', source: b.source };
      return [201, st.pages];
    }
    if (p === PAGES && method === 'PUT') { const b = JSON.parse(body); if (b.cname) st.cname.push(b.cname); else st.moved.push(b); return [204, '']; }
    if (p === `${PAGES}/builds/latest`) {
      if (++st.polls === 1) return [404, { message: 'Not Found' }];
      if (st.polls === 2) return { status: 'built', commit: 'a'.repeat(40) }; // the build before this push
      return o.errored ? { status: 'errored', commit: head(), error: { message: 'A file is too big.' } } : { status: 'built', commit: head() };
    }
    if (p === `${PAGES}/builds`) return [{ status: 'built', commit: head(), created_at: '2026-11-06T10:00:00Z', error: { message: null } }];
    return undefined;
  }).then((api) => Object.assign(api, { st, remote }));
}
async function onGithub(o?: Parameters<typeof fakeGithub>[1]) {
  const b = await base(), root = mkdtempSync(join(tmpdir(), 'remotes-')), api = await fakeGithub(root, o);
  process.env.UNIT7_GITHUB_API = `${api.base}/gh`; process.env.UNIT7_GITHUB_URL = `file://${root}`;
  const show = (ref: string) => execFileSync('git', ['--git-dir', api.remote, 'show', ref], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return { ...b, api, st: api.st, show, acc: account(b.app, b.org.orgId, 'github', 'github-demo-token', 'GitHub demo'), close: () => { api.close(); delete process.env.UNIT7_GITHUB_API; delete process.env.UNIT7_GITHUB_URL; } };
}

test('GitHub Pages: an upload goes in a new public repo as finished files only, and it waits for this push’s build', async () => {
  const s = await onGithub();
  try {
    const dir = site({ ...VITE, 'dist/index.html': '<script src="/assets/app.js"></script>', 'dist/assets/app.js': 'built', 'dist/_next/x.js': 'in an underscore folder' });
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(dir), to: 'github-pages', name: 'shop' }));
    assert.equal(s.st.created[0].private, false, 'free Pages needs a public repo');
    assert.equal(out.url, 'https://demo.github.example/shop/');
    assert.equal(out.project, 'demo/shop');
    assert.deepEqual(s.st.on, [{ source: { branch: 'gh-pages', path: '/' }, build_type: 'legacy' }]);
    assert.equal(s.show('gh-pages:assets/app.js'), 'built');
    assert.equal(s.show('gh-pages:.nojekyll'), '', 'or GitHub would drop the _next folder');
    assert.equal(s.show('gh-pages:_next/x.js'), 'in an underscore folder');
    assert.throws(() => s.show('gh-pages:src/main.js'), 'the source stays out of a public repo');
    assert.ok(s.st.polls >= 3, 'past a build from before this push');
    assert.match(out.notes.join(' '), /serves it under \/shop\/.*base path/);

    const again = await s.org.h('live.put', { uploadId: await s.upload(dir), to: 'github-pages', name: 'shop' }) as any;
    assert.match(again.error.message, /already has a GitHub Pages site/);
    s.st.polls = 2;
    ok(await s.org.h('live.put', { uploadId: await s.upload(site({ ...VITE, 'dist/index.html': 'second' })), to: 'github-pages', name: 'shop', update: true }));
    assert.equal(s.show('gh-pages:index.html'), 'second');
    assert.equal(s.show('gh-pages~1:index.html'), '<script src="/assets/app.js"></script>', 'never a force push');
    const logs = ok<any>(await s.org.h('live.logs', { to: 'github-pages', project: 'demo/shop' }));
    assert.match(logs.lines[0], /built/);
  } finally { s.close(); }
});

test('GitHub Pages: from a repo, its code is never touched, and an update moves Pages to the new branch', async () => {
  const s = await onGithub({ repo: true });
  try {
    mkdirSync(s.api.remote, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', s.api.remote]);
    const code = site({ ...VITE, 'dist/index.html': 'built page' });
    await pushFolder(walk(code), { owner: 'demo', name: 'shop' }, undefined, { branch: 'main', message: 'The code', existing: false });
    const before = s.show('main').split('\n')[0];
    ok(await s.org.h('live.put', { repo: 'demo/shop', to: 'github-pages', name: 'shop' }));
    assert.equal(s.show('main').split('\n')[0], before, 'main is where it was');
    assert.equal(s.show('main:src/main.js'), 'the source');
    assert.equal(s.show('gh-pages:index.html'), 'built page');
    assert.equal(s.st.created.length, 0, 'no second repo');
  } finally { s.close(); }
  const t = await onGithub({ repo: true, pages: { html_url: 'https://demo.github.example/shop/', source: { branch: 'main' } } });
  try {
    mkdirSync(t.api.remote, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', t.api.remote]);
    const r = await t.org.h('live.put', { uploadId: await t.upload(site({ 'index.html': 'x' })), to: 'github-pages', name: 'shop' }) as any;
    assert.match(r.error.message, /already has a GitHub Pages site/);
    ok(await t.org.h('live.put', { uploadId: await t.upload(site({ 'index.html': 'x' })), to: 'github-pages', name: 'shop', update: true }));
    assert.deepEqual(t.st.moved[0].source, { branch: 'gh-pages', path: '/' }, 'or Pages would go on serving the old branch');
    assert.deepEqual(t.st.on, []);
  } finally { t.close(); }
});

test('GitHub Pages: refusals say what to do, and what it can’t take says what would', async () => {
  const dir = site({ 'index.html': 'x' });
  const plan = await onGithub({ plan: true });
  try {
    const r = await plan.org.h('live.put', { uploadId: await plan.upload(dir), to: 'github-pages', name: 'shop' }) as any;
    assert.match(r.error.message, /Your current plan does not support GitHub Pages for this repository\..*private repo needs a paid plan.*make the repo public/);
  } finally { plan.close(); }
  const app = await onGithub({ noRights: true });
  try {
    const r = await app.org.h('live.put', { uploadId: await app.upload(dir), to: 'github-pages', name: 'shop' }) as any;
    assert.match(r.error.message, /won’t let this connection create repos or turn on Pages.*connect GitHub with a token/);
    assert.equal(get<{ status: string }>(app.app.db, 'SELECT status FROM accounts WHERE id = ?', app.acc)!.status, 'verified');
  } finally { app.close(); }
  const bad = await onGithub({ errored: true });
  try {
    const r = await bad.org.h('live.put', { uploadId: await bad.upload(dir), to: 'github-pages', name: 'shop' }) as any;
    assert.equal(r.error.message, 'GitHub Pages couldn’t publish it: A file is too big.');
  } finally { bad.close(); }
  const s = await onGithub();
  try {
    const put = async (files: Record<string, string>) => (await s.org.h('live.put', { uploadId: await s.upload(site(files)), to: 'github-pages', name: 'shop' }) as any).error.message;
    assert.match(await put(EXPRESS), /GitHub Pages only serves finished web pages.*Your own server or Coolify runs it/);
    assert.match(await put(NEXT), /takes finished files.*Vercel, Coolify or your own server/);
    assert.equal(s.st.created.length, 0);
  } finally { s.close(); }
});

test('GitHub Pages: a domain is told to GitHub, and DNS gets the owner’s github.io', async () => {
  const s = await onGithub(), restore = fakeDns('shop.example', 'ns.unknown-dns.example');
  try {
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(site({ 'index.html': 'x' })), to: 'github-pages', name: 'shop', domain: 'www.shop.example' }));
    assert.deepEqual(s.st.cname, ['www.shop.example']);
    assert.deepEqual(out.domain.addThese, [{ type: 'CNAME', name: 'www', value: 'demo.github.io' }]);
  } finally { restore(); s.close(); }
});

// --- Hostinger web hosting: its real MCP server, with only the REST API faked ---------------------------------------------

const W = '/api/hosting/v1/accounts/u1/websites/shop.example';
const SITES = [{ domain: 'myshop.example', username: 'u1', website_type: 'other' }, { domain: 'shop.example', username: 'u1', website_type: 'other' }];
async function fakeHostinger(o: { sites?: any[]; files?: any[]; refuse?: boolean; build?: string; env?: string[]; git?: { is_success: boolean; log: string } } = {}) {
  const st = { calls: [] as string[], archives: new Map<string, Buffer>(), deployed: [] as string[], builds: [] as any[], env: o.env ?? [], saved: [] as any[], git: [] as any[], cleared: 0 };
  const sizes = new Map<string, string>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks), u = new URL(req.url!, 'http://x'), p = u.pathname, m = req.method!;
    st.calls.push(`${m} ${p}`);
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    if (p.startsWith('/tus/')) {
      const name = p.slice(5);
      if (m === 'POST') { st.archives.set(name, Buffer.alloc(0)); sizes.set(name, String(req.headers['upload-length'])); return send(201); }
      if (m === 'HEAD') return send(200, undefined, { 'upload-offset': String(st.archives.get(name)!.length), 'upload-length': sizes.get(name)!, 'tus-resumable': '1.0.0' });
      const whole = Buffer.concat([st.archives.get(name)!, raw]); st.archives.set(name, whole);
      return send(204, undefined, { 'upload-offset': String(whole.length), 'tus-resumable': '1.0.0' });
    }
    if (p === '/api/hosting/v1/websites') return send(200, { data: (o.sites ?? SITES).filter((s) => s.domain.includes(u.searchParams.get('domain') ?? '')), meta: {} });
    if (p === '/api/hosting/v1/files/upload-urls') return send(200, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/tus`, auth_key: 'demo-auth', rest_auth_key: 'demo-rest' });
    if (p === '/api/hosting/v1/accounts/u1/domains/shop.example/files') return send(200, { data: o.files ?? [{ name: 'default.php', type: 'file' }], total_items: 1 });
    if (p === `${W}/deploy`) {
      if (o.refuse) return send(422, { message: 'This plan can’t take that archive.' });
      st.deployed.push(JSON.parse(raw.toString()).archive_path);
      return send(200, { success: true });
    }
    if (p === `${W}/nodejs/builds/settings/from-archive`) return send(200, { app_type: 'next', node_version: 22, root_directory: '.', output_directory: '.next', build_script: 'npm run build', package_manager: 'npm' });
    if (p === `${W}/nodejs/builds/settings/env` && m === 'GET') return send(200, st.env.map((key) => ({ key, value: '********' })));
    if (p === `${W}/nodejs/builds/settings/env` && m === 'PUT') { const b = JSON.parse(raw.toString()); st.saved.push(b.env_vars); st.env = b.env_vars.map((e: { key: string }) => e.key); return send(200, {}); }
    if (p === `${W}/nodejs/builds` && m === 'POST') {
      if (o.refuse) return send(403, { message: 'This plan has no Node.js.' });
      st.builds.push(JSON.parse(raw.toString()));
      return send(200, { uuid: 'b1', state: 'pending' });
    }
    if (p === `${W}/nodejs/builds/b1`) return send(200, { uuid: 'b1', state: o.build ?? 'completed' });
    if (p === `${W}/nodejs/builds/b1/analysis`) return send(200, { analysis: 'The build script is missing.', solution: 'Add one to package.json.' });
    if (p === `${W}/nodejs/builds/b1/logs`) return send(200, { logs: '\u001b[31mnpm ERR!\u001b[0m missing script: build', lines: 1 });
    if (p === `${W}/nodejs/runtime-logs`) return send(200, { entries: [{ timestamp: 'now', level: 'LOG', message: 'listening' }], total_lines: 1 });
    if (p === `${W}/git/repositories/deploy`) { st.git.push(JSON.parse(raw.toString())); return send(200, o.git ?? { is_success: true, log: 'composer: done' }); }
    if (p === `${W}/cache/clear`) { st.cleared++; return send(200, {}); }
    send(404, { message: `no fake for ${m} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { st, port: (server.address() as { port: number }).port, close: () => server.close() };
}
const require = createRequire(import.meta.url);
const hostingerEntry = () => { const pkg = require.resolve('@hostinger/mcp/package.json'); return join(dirname(pkg), (require(pkg) as { bin: { mcp: string } }).bin.mcp); };
async function onHostinger(o?: Parameters<typeof fakeHostinger>[0]) {
  const b = await base(), api = await fakeHostinger(o);
  // Unit7 starts the server with a clean environment, so the address goes in through env
  process.env.UNIT7_HOSTINGER_CMD = '/usr/bin/env';
  process.env.UNIT7_HOSTINGER_ARGS = [`API_BASE_URL=http://127.0.0.1:${api.port}`, process.execPath, hostingerEntry()].join('\n');
  return { ...b, api, st: api.st, acc: account(b.app, b.org.orgId, 'hostinger', 'hostinger-demo-token', 'Hostinger demo'),
    close() { hostinger(b.app).closeAll(); api.close(); delete process.env.UNIT7_HOSTINGER_CMD; delete process.env.UNIT7_HOSTINGER_ARGS; } };
}
const onlyFromHere = (calls: string[]) => assert.ok(!calls.some((c) => /order|billing|purchase|payment|subscription/i.test(c)), `nothing near money: ${calls.join(', ')}`);

test('Hostinger: finished files reach the website picked by its exact domain, and only those', async () => {
  const s = await onHostinger();
  try {
    const dir = site({ ...VITE, 'dist/index.html': '<h1>built</h1>', 'dist/app.js': 'built', 'dist/deploy.pem': 'a key file', 'dist/.npmrc': '//registry/:_authToken=x' });
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(dir), to: 'hostinger', domain: 'shop.example', name: 'shop' }));
    assert.equal(out.url, 'https://shop.example');
    assert.equal(out.project, 'shop.example');
    assert.equal(out.domain, undefined, 'the website is the domain, so there’s nothing to point');
    const [name, tgz] = [...s.st.archives][0]!;
    assert.match(name, /^unit7-[0-9a-f]{16}\.tgz$/, 'a .tgz the operation accepts, under a name nobody can guess');
    assert.deepEqual(inTar(tgz), ['app.js', 'index.html'], 'the folder’s contents at the top, with no key file');
    assert.deepEqual(s.st.deployed, [name]);
    assert.equal(s.st.cleared, 1, 'or the default page can linger');
    onlyFromHere(s.st.calls);
  } finally { s.close(); }
});

test('Hostinger: a site that needs building goes as source, and the build is followed to its end', async () => {
  const s = await onHostinger();
  try {
    const dir = site({ ...NEXT, 'build/old.js': 'stale output', 'deploy.pem': 'a key file' });
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(dir), to: 'hostinger', domain: 'shop.example', name: 'shop', env: { API_KEY: 'hidden-value' } }));
    assert.equal(out.deployment, 'b1');
    assert.deepEqual(inTar([...s.st.archives.values()][0]!), ['app/page.tsx', 'package.json'], 'source only: no old build, no key file');
    assert.equal(s.st.builds[0].source_type, 'archive');
    assert.deepEqual(s.st.saved, [[{ key: 'API_KEY', value: 'hidden-value' }]]);
    assert.ok(s.st.calls.includes(`GET ${W}/nodejs/builds/b1`));
    const env = ok<any>(await s.org.h('live.env', { to: 'hostinger', project: 'shop.example' }));
    assert.deepEqual(env.settings, [{ key: 'API_KEY' }]);
    const logs = ok<any>(await s.org.h('live.logs', { to: 'hostinger', project: 'shop.example', deployment: 'b1' }));
    assert.deepEqual(logs.lines, ['npm ERR! missing script: build'], 'with its colour codes gone');
    const run = ok<any>(await s.org.h('live.logs', { to: 'hostinger', project: 'shop.example' }));
    assert.deepEqual(run.lines, ['listening']);
  } finally { s.close(); }
});

test('Hostinger: a refusal that comes back as an ordinary answer is still a refusal, and a failed build says so', async () => {
  const dir = site({ 'index.html': 'hi' });
  const a = await onHostinger({ refuse: true });
  try {
    const r = await a.org.h('live.put', { uploadId: await a.upload(dir), to: 'hostinger', domain: 'shop.example', name: 'shop' }) as any;
    assert.equal(r.status, 'error');
    assert.equal(r.error.message, 'Hostinger refused to deploy to shop.example: This plan can’t take that archive.');
    assert.equal(a.st.archives.size, 1, 'the upload itself went through, which is why it looks fine');
    const b = await a.org.h('live.put', { uploadId: await a.upload(site(NEXT)), to: 'hostinger', domain: 'shop.example', name: 'shop' }) as any;
    assert.equal(b.status, 'error');
    assert.equal(b.error.message, 'Hostinger refused to build shop.example: This plan has no Node.js.');
  } finally { a.close(); }
  const c = await onHostinger({ build: 'failed' });
  try {
    const r = await c.org.h('live.put', { uploadId: await c.upload(site(NEXT)), to: 'hostinger', domain: 'shop.example', name: 'shop' }) as any;
    assert.equal(r.error.message, 'Hostinger couldn’t build it. Its log says why.');
    assert.match(r.error.logTail, /The build script is missing\.[\s\S]*missing script: build/);
  } finally { c.close(); }
});

test('Hostinger: nothing on a website is overwritten by accident, and an AI can’t replace one without a person', async () => {
  const dir = site({ 'index.html': 'new' });
  const s = await onHostinger({ files: [{ name: 'default.php' }, { name: 'index.html' }] });
  try {
    const uploadId = await s.upload(dir);
    const r = await s.org.h('live.put', { uploadId, to: 'hostinger', domain: 'shop.example', name: 'shop' }) as any;
    assert.match(r.error.message, /already has a site on it.*no way back.*Say you want to replace it/);
    assert.equal(s.st.archives.size, 0, 'nothing was sent');
    const asked = await s.org.a('live.put', { uploadId, to: 'hostinger', domain: 'shop.example', name: 'shop', update: true });
    assert.equal(asked.status, 'approval_required');
    const sly = await s.org.a('live.put', { uploadId, domain: 'shop.example', name: 'shop', update: true }) as any;
    assert.equal(sly.error.code, 'needs_person', 'without naming the host it’s stopped all the same');
    assert.equal(s.st.archives.size, 0);
    const out = ok<any>(await s.org.h('live.put', { uploadId, to: 'hostinger', domain: 'shop.example', name: 'shop', update: true }));
    assert.match(out.notes.join(' '), /can’t be undone/);
  } finally { s.close(); }
  const wp = await onHostinger({ sites: [{ domain: 'shop.example', username: 'u1', website_type: 'wordpress' }] });
  try {
    const r = await wp.org.h('live.put', { uploadId: await wp.upload(dir), to: 'hostinger', domain: 'shop.example', name: 'shop', update: true }) as any;
    assert.match(r.error.message, /runs WordPress, and a deploy would wipe it/);
    assert.equal(wp.st.archives.size, 0);
  } finally { wp.close(); }
  const odd = await onHostinger({ files: {} as any });
  try {
    const r = await odd.org.h('live.put', { uploadId: await odd.upload(dir), to: 'hostinger', domain: 'shop.example', name: 'shop' }) as any;
    assert.match(r.error.message, /already has a site on it/, 'a listing Unit7 can’t read counts as full');
  } finally { odd.close(); }
});

test('Hostinger: a website is picked by its whole domain, and a missing one is never bought', async () => {
  const s = await onHostinger(), dir = site({ 'index.html': 'x' });
  try {
    const which = await s.org.h('live.put', { uploadId: await s.upload(dir), to: 'hostinger', name: 'shop' }) as any;
    assert.match(which.error.message, /Say which of yours this goes on: myshop\.example, shop\.example/);
    const part = await s.org.h('live.put', { uploadId: await s.upload(dir), to: 'hostinger', domain: 'hop.example', name: 'shop' }) as any;
    assert.match(part.error.message, /hop\.example isn’t a website on this Hostinger account.*hPanel.*doesn’t buy hosting/, 'part of another name isn’t a match');
    onlyFromHere(s.st.calls);
  } finally { s.close(); }
  const none = await onHostinger({ sites: [] });
  try {
    const r = await none.org.h('live.put', { uploadId: await none.upload(dir), to: 'hostinger', name: 'shop' }) as any;
    assert.match(r.error.message, /no websites yet/);
  } finally { none.close(); }
});

test('Hostinger: its settings go all together, so changing one never erases the rest', async () => {
  const s = await onHostinger({ env: ['A', 'B'] });
  try {
    const r = await s.org.h('live.env', { to: 'hostinger', project: 'shop.example', op: 'set', key: 'C', value: 'x' }) as any;
    assert.match(r.error.message, /would erase A, B/);
    const u = await s.org.h('live.env', { to: 'hostinger', project: 'shop.example', op: 'unset', key: 'A' }) as any;
    assert.match(u.error.message, /would erase B/);
    assert.deepEqual(s.st.saved, [], 'nothing was sent');
    const put = await s.org.h('live.put', { uploadId: await s.upload(site(NEXT)), to: 'hostinger', domain: 'shop.example', name: 'shop', env: { A: '1' } }) as any;
    assert.match(put.error.message, /would erase B/);
    assert.equal(s.st.archives.size, 0, 'and it stops before the site is touched');
  } finally { s.close(); }
  const one = await onHostinger({ env: ['A'] });
  try {
    ok(await one.org.h('live.env', { to: 'hostinger', project: 'shop.example', op: 'set', key: 'A', value: 'new' }));
    ok(await one.org.h('live.env', { to: 'hostinger', project: 'shop.example', op: 'unset', key: 'A' }));
    assert.deepEqual(one.st.saved, [[{ key: 'A', value: 'new' }], []]);
  } finally { one.close(); }
});

test('Hostinger: what it can’t take says what would, and a one-click sign-in says what it needs', async () => {
  const s = await onHostinger();
  try {
    const put = async (files: Record<string, string>) => (await s.org.h('live.put', { uploadId: await s.upload(site(files)), to: 'hostinger', domain: 'shop.example', name: 'shop' }) as any).error.message;
    assert.match(await put(DOCKER), /doesn’t run Docker\. Your own server or Coolify does/);
    assert.match(await put(PYTHON), /runs PHP and Node\.js, not python-flask\. Your own server or Coolify runs it/);
    assert.match(await put({ 'composer.json': '{}', artisan: 'x', 'public/index.php': 'x' }), /Laravel needs its public folder/);
    assert.equal(s.st.archives.size, 0);
    const php = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(site({ 'index.php': '<?php echo 1;' })), to: 'hostinger', domain: 'shop.example', name: 'shop' }));
    assert.equal(php.url, 'https://shop.example', 'plain PHP goes up as it is');
    assert.deepEqual(inTar([...s.st.archives.values()][0]!), ['index.php']);
  } finally { s.close(); }
  const b = await base();
  const acc = account(b.app, b.org.orgId, 'hostinger', '{}', 'Hostinger one-click');
  run(b.app.db, `UPDATE accounts SET meta = json_set(meta, '$.auth', 'oauth') WHERE id = ?`, acc);
  const reads: string[] = [];
  b.app.services.hostinger = { call: async (_c: unknown, _a: string, _t: string, args: { operation: string }) => { reads.push(args.operation); return args.operation === 'hosting_websites_list' ? JSON.stringify({ data: SITES }) : JSON.stringify({ data: [] }); }, closeAll() {} };
  const r = await b.org.h('live.put', { uploadId: await b.upload(site({ 'index.html': 'x' })), to: 'hostinger', domain: 'shop.example', name: 'shop' }) as any;
  assert.match(r.error.message, /one-click sign-in can’t read files on this computer.*add a Hostinger API token/);
  assert.ok(!reads.some((o) => /deploy/.test(o)));
});

test('Hostinger: a PHP repo needing composer goes by Git, and Git failing comes back as a failure', async () => {
  const code = { 'composer.json': '{"require":{}}', 'index.php': '<?php require "vendor/autoload.php";' };
  const gitSetup = async (o: Parameters<typeof fakeHostinger>[0] = {}) => {
    const s = await onHostinger(o), root = mkdtempSync(join(tmpdir(), 'remotes-')), remote = join(root, 'demo', 'shop.git');
    mkdirSync(remote, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    process.env.UNIT7_GITHUB_URL = `file://${root}`;
    await pushFolder(walk(site(code)), { owner: 'demo', name: 'shop' }, undefined, { branch: 'main', message: 'Code', existing: false });
    const gh = await fakeApi(({ path }: Req) => (new URL(path, 'http://x').pathname === '/repos/demo/shop' ? { private: false, default_branch: 'main' } : undefined));
    process.env.UNIT7_GITHUB_API = gh.base;
    return { ...s, end() { gh.close(); delete process.env.UNIT7_GITHUB_URL; delete process.env.UNIT7_GITHUB_API; s.close(); } };
  };
  const s = await gitSetup();
  try {
    const out = ok<any>(await s.org.h('live.put', { repo: 'demo/shop', to: 'hostinger', domain: 'shop.example', name: 'shop' }));
    assert.equal(out.url, 'https://shop.example');
    assert.equal(s.st.git[0].branch, 'main');
    assert.match(s.st.git[0].repository_url, /demo\/shop\.git$/);
    assert.equal(s.st.archives.size, 0, 'no archive: composer only runs on a Git deploy');
  } finally { s.end(); }
  const f = await gitSetup({ git: { is_success: false, log: 'composer: your requirements could not be resolved' } });
  try {
    const r = await f.org.h('live.put', { repo: 'demo/shop', to: 'hostinger', domain: 'shop.example', name: 'shop' }) as any;
    assert.equal(r.error.message, 'Hostinger couldn’t deploy demo/shop. Its log says why.');
    assert.match(r.error.logTail, /could not be resolved/);
  } finally { f.end(); }
  const up = await onHostinger();
  try {
    const r = await up.org.h('live.put', { uploadId: await up.upload(site(code)), to: 'hostinger', domain: 'shop.example', name: 'shop' }) as any;
    assert.match(r.error.message, /needs composer install.*upload it with its vendor folder/, 'an upload can’t run composer, and a site without its vendor folder wouldn’t start');
  } finally { up.close(); }
});

// --- your own server: Unit7's real tools, with only the build and SSH stood in for ----------------------------------------

async function onServer() {
  const b = await base(), srv = id('srv');
  run(b.app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready', '{}')`, srv, b.org.orgId);
  const deployed: any[] = [], tool = getTool('deployment.create')!, real = tool.run;
  tool.run = (_ctx: unknown, i: any) => {
    deployed.push(i);
    const before = get<{ c: string | null }>(b.app.db, 'SELECT current_deployment_id c FROM services WHERE id = ?', i.serviceId)!.c, dep = id('dep');
    run(b.app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, source, triggered_by) VALUES (?, ?, ?, ?, 'live', '{}', 'test')`, dep, b.org.orgId, i.serviceId, deployed.length);
    run(b.app.db, 'UPDATE services SET current_deployment_id = ? WHERE id = ?', dep, i.serviceId);
    return { deploymentId: dep, number: deployed.length, status: 'live', url: 'https://shop.203-0-113-9.sslip.example', ...(before && { previousDeploymentId: before }) };
  };
  return { ...b, srv, deployed, close: () => { tool.run = real; } };
}
const pathOf = (s: { app: any }, uploadId: string) => get<{ path: string }>(s.app.db, 'SELECT path FROM uploads WHERE id = ?', uploadId)!.path;
const tarOf = (path: string) => execFileSync('tar', ['-tzf', path]).toString().split('\n').filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^\.\//, '')).sort();

test('your own server: a project, a service and a deploy, packed from the checked files, not the upload as it came', async () => {
  const s = await onServer();
  try {
    const dir = site({ ...EXPRESS, 'deploy.pem': 'a key file', '.npmrc': '//registry/:_authToken=x' });
    const uploadId = await s.upload(dir);
    assert.ok(tarOf(pathOf(s, uploadId)).includes('deploy.pem'), 'the raw upload holds it');
    const out = ok<any>(await s.org.h('live.put', { uploadId, to: 'server', name: 'shop', env: { MODE: 'x', API_KEY: 'hidden-value' } }));
    assert.equal(out.host, 'server');
    assert.equal(out.url, 'https://shop.203-0-113-9.sslip.example');
    const svc = get<{ id: string; config: string; server_id: string; project_id: string }>(s.app.db, 'SELECT id, config, server_id, project_id FROM services')!;
    assert.equal(out.project, svc.id);
    assert.equal(svc.server_id, s.srv);
    const source = json<{ source: { type: string; uploadId: string } }>(svc.config, {} as any).source;
    assert.equal(source.type, 'upload');
    assert.notEqual(source.uploadId, uploadId);
    assert.deepEqual(tarOf(pathOf(s, source.uploadId)), ['package.json', 'server.js'], 'only what walk() let through');
    assert.deepEqual(s.deployed, [{ serviceId: svc.id }]);
    assert.deepEqual(all<{ kind: string }>(s.app.db, 'SELECT kind FROM environments WHERE project_id = ?', svc.project_id).map((e) => e.kind), ['production']);
    const listed = ok<any>(await s.org.h('live.env', { to: 'server', project: svc.id }));
    assert.deepEqual(listed.settings.map((e: any) => e.key).sort(), ['API_KEY', 'MODE']);
    assert.ok(!JSON.stringify(listed).includes('hidden-value'));
    const secret = ok<any>(await s.org.h('env.list', { serviceId: svc.id }));
    assert.equal(secret.variables.find((v: any) => v.key === 'API_KEY').secret, true);
  } finally { s.close(); }
});

test('your own server: a step that waited for a person isn’t done twice, a live app needs update, and an update stays the new version', async () => {
  const s = await onServer(), dir = site(EXPRESS);
  try {
    const uploadId = await s.upload(dir);
    const first = await s.org.a('live.put', { uploadId, to: 'server', name: 'shop' }) as any;
    assert.equal(first.error.code, 'approval_required');
    assert.match(first.error.message, /service\.create is waiting on the Approvals page\. Run this again once it’s approved/);
    const asked = json<Record<string, unknown>>(get<{ input: string }>(s.app.db, `SELECT input FROM approvals WHERE tool = 'service.create'`)!.input, {});
    ok(await s.org.h('service.create', asked));
    ok(await s.org.a('live.put', { uploadId, to: 'server', name: 'shop' }));
    assert.equal(get<{ n: number }>(s.app.db, 'SELECT count(*) n FROM projects')!.n, 1, 'no second project');
    assert.equal(get<{ n: number }>(s.app.db, 'SELECT count(*) n FROM services')!.n, 1, 'no second service');
    const svc = get<{ id: string }>(s.app.db, 'SELECT id FROM services')!.id;
    assert.deepEqual(s.deployed, [{ serviceId: svc }], 'the source it was approved with');

    const again = await s.org.h('live.put', { uploadId, to: 'server', name: 'shop' }) as any;
    assert.match(again.error.message, /already runs on your server/);
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.upload(site({ ...EXPRESS, 'server.js': 'version two' })), to: 'server', name: 'shop', update: true }));
    const source = s.deployed[1].source as { uploadId: string };
    assert.equal(json<{ source: { uploadId: string } }>(get<{ config: string }>(s.app.db, 'SELECT config FROM services WHERE id = ?', svc)!.config, {} as any).source.uploadId, source.uploadId, 'or a plain redeploy later would bring the old code back');
    assert.match(out.notes.join(' '), /deployment\.rollback with serviceId/);
  } finally { s.close(); }
});

test('your own server: a repo stays a repo, a domain is routed to the app, and a server with Coolify is left to Coolify', async () => {
  const s = await onServer(), root = mkdtempSync(join(tmpdir(), 'remotes-')), remote = join(root, 'demo', 'shop.git');
  const point = getTool('domain.point')!, realPoint = point.run, pointed: any[] = [];
  point.run = (_c: unknown, i: any) => { pointed.push(i); return { hostname: i.hostname, url: `https://${i.hostname}` }; };
  try {
    mkdirSync(remote, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    process.env.UNIT7_GITHUB_URL = `file://${root}`;
    await pushFolder(walk(site(EXPRESS)), { owner: 'demo', name: 'shop' }, undefined, { branch: 'main', message: 'Code', existing: false });
    const out = ok<any>(await s.org.h('live.put', { repo: 'demo/shop', to: 'server', name: 'shop', domain: 'www.shop.example' }));
    const svc = get<{ id: string; config: string }>(s.app.db, 'SELECT id, config FROM services')!;
    assert.deepEqual(json<{ source: unknown }>(svc.config, {} as any).source, { type: 'git', repo: 'demo/shop' });
    assert.equal(out.autoDeploy, true);
    assert.deepEqual(pointed, [{ hostname: 'www.shop.example', serviceId: svc.id }], 'routed to the app, not just an address for the server');

    const wrong = await s.org.h('live.put', { uploadId: await s.upload(site({ 'docker-compose.yml': 'services: {}' })), to: 'server', name: 'other' }) as any;
    assert.match(wrong.error.message, /compose file.*Coolify on your server does/);

    const coolify = account(s.app, s.org.orgId, 'coolify', 'coolify-demo-token', 'Coolify');
    run(s.app.db, `UPDATE accounts SET meta = json_set(meta, '$.serverId', ?) WHERE id = ?`, s.srv, coolify);
    const opts = ok<any>(await s.org.h('live.options', { folder: site(EXPRESS) }));
    assert.deepEqual(opts.places.filter((p: any) => p.serverId === s.srv).map((p: any) => p.to), ['coolify']);
  } finally { point.run = realPoint; delete process.env.UNIT7_GITHUB_URL; s.close(); }
});

// --- all of them together ---------------------------------------------------------------------------------------------

test('live.options lists every connected place with why, and each one that can’t says what would', async () => {
  const s = await onServer();
  try {
    for (const [provider, value] of [['netlify', 'a'], ['cloudflare', 'b'], ['github', 'c'], ['hostinger', 'd']] as const) account(s.app, s.org.orgId, provider, `${value}-demo-token`, provider);
    const plain = ok<any>(await s.org.h('live.options', { folder: site({ 'index.html': 'x' }) }));
    assert.deepEqual(plain.places.map((p: any) => p.to).sort(), ['cloudflare-pages', 'github-pages', 'hostinger', 'netlify', 'server']);
    assert.ok(plain.places.every((p: any) => p.ok && p.why));
    assert.match(plain.places.find((p: any) => p.to === 'hostinger').why, /Say which of your websites/);
    const docker = ok<any>(await s.org.h('live.options', { folder: site(DOCKER) }));
    assert.equal(docker.places[0].to, 'server', 'what can run it comes first');
    assert.equal(docker.places[0].recommended, true);
    for (const p of docker.places.filter((x: any) => !x.ok)) assert.match(p.why, /Your own server or Coolify/, p.to);
  } finally { s.close(); }
});
