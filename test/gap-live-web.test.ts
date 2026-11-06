// Put this live with no terminal: a ZIP or a folder of files dropped in the browser, or a folder picked on this computer,
// becomes a normal upload. What's inside a ZIP is never trusted: bad names, bombs, too many files, links. Plus who may do it,
// and the folder card in the ask box, where the AI hears what the site is and never where it was.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { serve } from '@hono/node-server';
import { testApp } from './helpers.ts';
import { acceptInvite, createInvite, createToken } from '../src/auth.ts';
import { askSummary, ASK_RULES } from '../src/agent/asks.ts';
import { all, get } from '../src/db.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { allHosts } from '../src/live/hosts.ts';
import { dropLimits } from '../src/live/upload.ts';
import { execute } from '../src/tools/runtime.ts';
import { PLANS } from '../web/src/pages/guide/plans.ts';

// a real server and a real fetch: what a browser's form really does on the way in is part of what's tested
const tmp = mkdtempSync(join(tmpdir(), 'unit7-liveweb-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let call: { name: string; arguments: object } = { name: 'ui_folder', arguments: {} };
const bodies: any[] = [];
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
    const b = JSON.parse(raw); bodies.push(b);
    const tool = b.messages.findLast((m: any) => m.role === 'tool');
    res.end(JSON.stringify({ choices: [{ message: tool ? { role: 'assistant', content: `Done: ${tool.content}` }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] }));
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
process.env.OLLAMA_URL = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
after(() => { model.close(); });

async function setup() {
  resetRateLimits();
  const app = testApp(), http = createHttp(app);
  const server = await new Promise<ReturnType<typeof serve>>((r) => {
    const s = serve({ fetch: http.fetch, port: 0, hostname: '127.0.0.1' }, (info) => { app.services.listen = { host: '127.0.0.1', port: info.port }; r(s); });
  });
  const base = `http://localhost:${(app.services.listen as any).port}`;
  const browser = () => {
    let cookie = '', bind = '';
    return async (method: string, path: string, body?: unknown, bearer?: string) => {
      const form = body instanceof FormData;
      const r = await fetch(`${base}${path}`, { method, body: form ? body : body ? JSON.stringify(body) : undefined,
        headers: { ...(form ? {} : { 'content-type': 'application/json' }), ...(bearer ? { authorization: `Bearer ${bearer}` } : { origin: base, ...(cookie && { cookie, 'x-unit7-bind': bind }) }) } });
      const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
  };
  const sam = browser();
  await sam('POST', '/api/auth/signup', { email: 'sam@example.com', name: 'Sam', password: 'correct horse battery' });
  const me = (await sam('GET', '/api/me')).body;
  const owner = { user: me.user, org: me.org, role: 'owner', via: 'session' } as any;
  const member = async (name: string, role: string) => {
    const email = `${name}@example.com`, web = browser();
    await acceptInvite(app.db, createInvite(app.db, owner, email, role as any), { name, password: 'correct horse battery' });
    await web('POST', '/api/auth/login', { email, password: 'correct horse battery' });
    return web;
  };
  return { app, sam, me, owner, browser, member, close: () => server.close() };
}

// a ZIP written by hand, so it can lie: claim is the size it says, flags and mode are whatever a test wants
interface Entry { name: string; data?: string | Buffer; method?: number; claim?: number; flags?: number; mode?: number; crc?: number; share?: boolean }
function zipOf(files: Entry[]) {
  const out: Buffer[] = [], central: Buffer[] = [];
  let at = 0, shared: { at: number; body: Buffer; size: number; crc: number } | undefined;
  for (const f of files) {
    const raw = Buffer.from(f.data ?? ''), method = f.method ?? 8, name = Buffer.from(f.name);
    const body = shared && f.share ? shared.body : method === 8 ? deflateRawSync(raw) : raw, size = shared && f.share ? shared.size : raw.length, crc = f.crc ?? (shared && f.share ? shared.crc : crc32(raw));
    const local = shared && f.share ? shared.at : at;
    if (!(shared && f.share)) {
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(f.flags ?? 0, 6); h.writeUInt16LE(method, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(size, 22); h.writeUInt16LE(name.length, 26);
      out.push(h, name, body);
      if (f.share) shared = { at, body, size, crc };
      at += 30 + name.length + body.length;
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(f.flags ?? 0, 8); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(f.claim ?? size, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE((f.mode ?? 0) << 16 >>> 0, 38); c.writeUInt32LE(local, 42);
    central.push(c, name);
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(files.length, 0xffff), 8); end.writeUInt16LE(Math.min(files.length, 0xffff), 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...out, dir, end]);
}
const zipForm = (zip: Buffer, name = 'site.zip') => { const f = new FormData(); f.append('zip', new File([new Uint8Array(zip)], name)); return f; };
const folderForm = (files: Record<string, string>, name?: string) => {
  const f = new FormData();
  if (name) f.append('name', name);
  for (const [path, body] of Object.entries(files)) { f.append('path', path); f.append('file', new File([body], 'x')); }
  return f;
};
const uploaded = (app: any) => all<{ id: string; path: string }>(app.db, 'SELECT id, path FROM uploads');
const listing = (app: any, id: string) => execFileSync('tar', ['-tzf', get<{ path: string }>(app.db, 'SELECT path FROM uploads WHERE id = ?', id)!.path]).toString().split('\n').map((l) => l.replace(/^\.\//, '')).filter(Boolean);
const site = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmp, 'site-'));
  for (const [k, v] of Object.entries(files)) { mkdirSync(join(dir, k, '..'), { recursive: true }); writeFileSync(join(dir, k), v); }
  return dir;
};
const NEXT = JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: { build: 'next build' } });

test('a ZIP becomes a normal upload: the site starts inside its folder, and what must stay home stays out', async () => {
  const s = await setup();
  try {
    const zip = zipOf([{ name: 'shop/' }, { name: 'shop/package.json', data: NEXT }, { name: 'shop/app/page.tsx', data: 'const k = process.env.STRIPE_SECRET; export default () => k', method: 0 },
      { name: 'shop/dist/app.js', data: 'built' }, { name: 'shop/.env', data: 'SECRET=1' }, { name: 'shop/.env.production', data: 'SECRET=2' }, { name: 'shop/server.pem', data: 'x' },
      { name: 'shop/node_modules/a/index.js', data: 'x' }, { name: 'shop/.git/config', data: 'x' }, { name: '__MACOSX/shop/._page.tsx', data: 'x' }, { name: 'shop/.DS_Store', data: 'x' }]);
    const r = await s.sam('POST', '/api/live/upload', zipForm(zip, 'My Shop.zip'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, 'my-shop');
    assert.equal(r.body.stack, 'next');
    assert.match(r.body.uploadId, /^upl_/);
    assert.equal(r.body.files, 3, 'only what belongs in a site');
    assert.deepEqual(listing(s.app, r.body.uploadId).filter((p: string) => !p.endsWith('/') && p !== '.').sort(), ['app/page.tsx', 'dist/app.js', 'package.json'], 'a real .tgz, starting inside the folder');
    assert.equal(readdirSync(join(s.app.home, 'uploads')).length, 1);
    const o = (await s.sam('POST', '/api/tools/live.options', { input: { uploadId: r.body.uploadId } })).body;
    assert.equal(o.status, 'ok');
    assert.equal(o.output.site.stack, 'next');
    assert.deepEqual(o.output.site.settings, ['STRIPE_SECRET'], 'the settings its code reads');
  } finally { s.close(); }
});

const hasZip = spawnSync('zip', ['-v']).status === 0;
test('a ZIP from a real zip tool, with a link in it, comes through and the link stays out', { skip: !hasZip && 'no zip here' }, async () => {
  const s = await setup();
  try {
    const dir = site({ 'index.html': '<h1>hi</h1>', 'css/a.css': 'a{}' });
    symlinkSync('/etc/hosts', join(dir, 'hosts-link'));
    symlinkSync('/etc', join(dir, 'etc-link'));
    const out = join(tmp, `real-${Date.now()}.zip`);
    execFileSync('zip', ['-q', '-r', '-y', out, '.'], { cwd: dir });
    const r = await s.sam('POST', '/api/live/upload', zipForm(execFileSync('cat', [out], { maxBuffer: 1e7 })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stack, 'static');
    const files = listing(s.app, r.body.uploadId);
    assert.ok(files.includes('index.html') && files.includes('css/a.css'));
    assert.ok(!files.some((f: string) => /link/.test(f)), 'a link never gets in');
  } finally { s.close(); }
});

test('a ZIP from Finder, with sizes only in its list and a folder around it, comes through', { skip: process.platform !== 'darwin' && 'Mac only' }, async () => {
  const s = await setup();
  try {
    const dir = site({ 'hello/index.html': '<h1>hi</h1>', 'hello/a.bin': 'x'.repeat(5000) });
    const out = join(tmp, `finder-${Date.now()}.zip`);
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(dir, 'hello'), out]);
    const r = await s.sam('POST', '/api/live/upload', zipForm(execFileSync('cat', [out], { maxBuffer: 1e7 }), 'hello.zip'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(listing(s.app, r.body.uploadId).filter((f: string) => !f.endsWith('/') && f !== '.').sort(), ['a.bin', 'index.html']);
  } finally { s.close(); }
});

test('a path that leaves the site stops the whole upload, from a ZIP or a folder, even in a part that would be left out', async () => {
  const s = await setup();
  try {
    for (const name of ['../evil.txt', 'a/../../evil.txt', '/tmp/unit7-evil.txt', '..\\evil.txt', 'a\\..\\..\\evil.txt', 'C:\\evil.txt', 'c:/evil.txt', 'node_modules/../../evil.txt', 'a/\0/b']) {
      const r = await s.sam('POST', '/api/live/upload', zipForm(zipOf([{ name: 'index.html', data: 'ok' }, { name, data: 'evil' }])));
      assert.equal(r.status, 400, name);
      assert.equal(r.body.error.code, 'unsafe_path', name);
      assert.match(r.body.error.message, /outside the site/);
      const f = await s.sam('POST', '/api/live/upload', folderForm({ 'index.html': 'ok', [name]: 'evil' }));
      assert.equal(f.status, 400, name);
    }
    assert.equal(uploaded(s.app).length, 0, 'nothing was kept');
    assert.ok(!existsSync('/tmp/unit7-evil.txt'));
    assert.ok(!existsSync(join(tmpdir(), 'evil.txt')));
  } finally { s.close(); }
});

test('a bomb stops at the limit: an honest one at once, and one that lies about its size as it unpacks', async () => {
  const s = await setup(), { bytes } = dropLimits;
  assert.equal(bytes, 1024 ** 3, 'the real limit is the same 1 GB a site has');
  assert.equal(dropLimits.files, 20_000);
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith('unit7-drop-')).length;
  dropLimits.bytes = 2 * 1024 ** 2;
  const refused = async (zip: Buffer) => {
    const r = await s.sam('POST', '/api/live/upload', zipForm(zip));
    assert.equal(r.status, 413, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'too_large');
    assert.match(r.body.error.message, /Take out what the site doesn’t need/);
  };
  try {
    const zeros = Buffer.alloc(5 * 1024 ** 2);
    await refused(zipOf([{ name: 'index.html', data: 'x' }, { name: 'big.bin', data: zeros }]));
    await refused(zipOf([{ name: 'big.bin', data: zeros, claim: 10 }]));                             // says 10 bytes, is 5 MB
    await refused(zipOf([{ name: 'big.bin', data: zeros, method: 0, claim: 10 }]));                  // the same, not even compressed
    await refused(zipOf(Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.bin`, data: Buffer.alloc(100 * 1024), claim: 1 }))));   // each small, the sum isn't
    await refused(zipOf(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.bin`, data: Buffer.alloc(100 * 1024), claim: 1, share: true })))); // many names, one set of bytes
    assert.equal(uploaded(s.app).length, 0);
    assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith('unit7-drop-')).length, before, 'nothing left behind');
  } finally { dropLimits.bytes = bytes; s.close(); }
});

test('too many files is refused before anything unpacks, and what’s left out doesn’t count', async () => {
  const s = await setup();
  try {
    const many = zipOf(Array.from({ length: 20_001 }, (_, i) => ({ name: `f${i}.txt`, data: 'x', method: 0 })));
    const r = await s.sam('POST', '/api/live/upload', zipForm(many));
    assert.equal(r.status, 413);
    assert.match(r.body.error.message, /more than 20000 files/);
    const folder = new FormData();
    for (let i = 0; i < 20_001; i++) { folder.append('path', `f${i}.txt`); folder.append('file', new File(['x'], 'x')); }
    assert.equal((await s.sam('POST', '/api/live/upload', folder)).status, 413);
    const fine = zipOf([{ name: 'index.html', data: 'x', method: 0 }, ...Array.from({ length: 20_001 }, (_, i) => ({ name: `node_modules/f${i}.js`, data: 'x', method: 0 }))]);
    const ok = await s.sam('POST', '/api/live/upload', zipForm(fine));
    assert.equal(ok.status, 200, 'a ZIP with node_modules in it still works');
    assert.equal(ok.body.files, 1);
  } finally { s.close(); }
});

test('only people and tokens that can upload code can, under the same limit as every upload', async () => {
  const s = await setup();
  try {
    const zip = () => zipForm(zipOf([{ name: 'index.html', data: 'x' }]));
    assert.equal((await s.browser()('POST', '/api/live/upload', zip())).status, 401, 'signed out');
    for (const role of ['readonly', 'auditor']) {
      const web = await s.member(role, role);
      const r = await web('POST', '/api/live/upload', zip());
      assert.equal(r.status, 403, role);
      assert.match(r.body.error.message, /Your role cannot upload code/);
    }
    const dev = await s.member('dev', 'developer');
    assert.equal((await dev('POST', '/api/live/upload', zip())).status, 200, 'a developer can');
    const agent = createToken(s.app.db, s.owner, 'an agent', 'agent').token;
    assert.equal((await s.browser()('POST', '/api/live/upload', zip(), agent)).status, 200, 'and so can an agent’s token, like /api/uploads');
    const scoped = createToken(s.app.db, { ...s.owner }, 'read only', 'readonly').token;
    assert.equal((await s.browser()('POST', '/api/live/upload', zip(), scoped)).status, 403);
    resetRateLimits();
    // 60 a minute refills as it goes, so a slow machine gets a few more before the limit bites
    let last = 0, tries = 0;
    while (last !== 429 && tries++ < 300) last = (await s.sam('POST', '/api/live/upload', new FormData())).status;
    assert.equal(last, 429, 'the upload limit');
    assert.ok(tries >= 60, `it took ${tries} tries`);
    assert.equal((await s.sam('POST', '/api/uploads', new FormData())).status, 429, 'and it’s the same limit as /api/uploads');
  } finally { s.close(); }
});

test('a bad file says what to do: not a ZIP, a password, odd compression, damage, a clash, nothing inside', async () => {
  const s = await setup();
  try {
    const says = async (zip: Buffer, re: RegExp) => { const r = await s.sam('POST', '/api/live/upload', zipForm(zip)); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error.message, re); };
    await says(Buffer.from('this is not a zip'), /isn’t a ZIP Unit7 can read/);
    await says(zipOf([{ name: 'a.txt', data: 'x', flags: 1 }]), /has a password/);
    await says(zipOf([{ name: 'a.txt', data: 'x', method: 12 }]), /kind of compression/);
    await says(zipOf([{ name: 'a.txt', data: 'hello', crc: 1234 }]), /damaged/);
    await says(zipOf([{ name: 'a.txt', data: 'hello', method: 0, crc: 1234 }]), /damaged/);
    const good = zipOf([{ name: 'a.txt', data: 'hello hello hello hello' }]);
    await says(good.subarray(10), /isn’t a ZIP Unit7 can read/);
    const rot = Buffer.from(good); rot[34] ^= 0xff; rot[35] ^= 0xff;
    await says(rot, /damaged/);
    await says(zipOf([{ name: 'a', data: 'file' }, { name: 'a/b', data: 'clash' }]), /clash/);
    await says(zipOf([]), /no files to put live/);
    await says(zipOf([{ name: '.env', data: 'x' }, { name: 'node_modules/a.js', data: 'x' }]), /no files to put live/);
    assert.equal((await s.sam('POST', '/api/live/upload', { not: 'a form' })).status, 400);
    const uneven = new FormData(); uneven.append('path', 'a'); uneven.append('path', 'b'); uneven.append('file', new File(['x'], 'x'));
    assert.equal((await s.sam('POST', '/api/live/upload', uneven)).status, 400);
  } finally { s.close(); }
});

test('a folder of files from the browser is the same upload, and past the old 2 MB cap', async () => {
  const s = await setup();
  try {
    const r = await s.sam('POST', '/api/live/upload', folderForm({ 'blog/index.html': '<h1>hi</h1>', 'blog/photo.bin': 'x'.repeat(3 * 1024 ** 2), 'blog/.env': 'SECRET=1', 'blog/node_modules/a.js': 'x' }, 'blog'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, 'blog');
    assert.equal(r.body.stack, 'static');
    assert.deepEqual(listing(s.app, r.body.uploadId).filter((f: string) => !f.endsWith('/') && f !== '.').sort(), ['index.html', 'photo.bin']);
    const huge = await fetch(`http://localhost:${(s.app.services.listen as any).port}/api/live/upload`, { method: 'POST', body: new Uint8Array(101 * 1024 ** 2), headers: { origin: `http://localhost:${(s.app.services.listen as any).port}`, 'content-type': 'multipart/form-data; boundary=x' } });
    assert.equal(huge.status, 413, 'the body cap is 100 MB here too');
  } finally { s.close(); }
});

test('a picked folder is packed with its build and without what stays home, and the answer has no path in it', async () => {
  const s = await setup();
  try {
    const dir = site({ 'package.json': NEXT, 'dist/index.html': 'built', '.env': 'SECRET=1', 'node_modules/a.js': 'x', '.venv/lib/a.py': 'x' });
    const r = await s.sam('POST', '/api/live/folder', { path: dir });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stack, 'next');
    assert.ok(!JSON.stringify(r.body).includes(dir), 'what it is, never where it was');
    const files = listing(s.app, r.body.uploadId);
    assert.ok(files.includes('dist/index.html'), 'the build stays');
    assert.ok(!files.some((f: string) => /\.env|node_modules|\.venv/.test(f)));
    for (const path of [homedir(), '/', s.app.home]) assert.equal((await s.sam('POST', '/api/live/folder', { path })).status, 400, path);
    assert.equal((await s.sam('POST', '/api/live/folder', { path: join(dir, 'nope') })).status, 400);
    const dev = await s.member('dev', 'developer');
    assert.equal((await dev('POST', '/api/live/folder', { path: dir })).status, 403, 'a folder on this computer is for owners and admins');
    const token = createToken(s.app.db, s.owner, 'an owner’s token', 'owner').token;
    assert.equal((await s.browser()('POST', '/api/live/folder', { path: dir }, token)).status, 403, 'never a token, so never an AI');
    (s.app.services as any).listen = { host: '0.0.0.0', port: 1 };
    assert.equal((await s.sam('POST', '/api/live/folder', { path: dir })).status, 403, 'and only when Unit7 runs here');
  } finally { s.close(); }
});

test('live.options says which host to connect when nothing can take it, and why a host can’t', async () => {
  const s = await setup();
  try {
    const up = (await s.sam('POST', '/api/live/upload', folderForm({ 'index.html': 'x' }))).body;
    const o = (await s.sam('POST', '/api/tools/live.options', { input: { uploadId: up.uploadId } })).body.output;
    assert.deepEqual(o.places, []);
    const vercel = o.notConnected.find((h: any) => h.to === 'vercel');
    assert.equal(vercel.ok, true);
    assert.match(vercel.why, /builds it for you/);
    const docker = (await s.sam('POST', '/api/live/upload', folderForm({ Dockerfile: 'FROM node:24\nEXPOSE 3000\n', 'a.js': 'x' }))).body;
    const d = (await s.sam('POST', '/api/tools/live.options', { input: { uploadId: docker.uploadId } })).body.output;
    assert.equal(d.notConnected.find((h: any) => h.to === 'vercel').ok, false);
    assert.match(d.notConnected.find((h: any) => h.to === 'vercel').why, /doesn’t run Docker/);
    assert.equal(d.notConnected.find((h: any) => h.to === 'coolify').ok, true);
    assert.equal(d.notConnected[0].to, 'coolify', 'the host that fits comes first');
    const next = (await s.sam('POST', '/api/live/upload', folderForm({ 'package.json': NEXT, 'app/page.tsx': 'x' }))).body;
    assert.equal((await s.sam('POST', '/api/tools/live.options', { input: { uploadId: next.uploadId } })).body.output.notConnected[0].to, 'vercel');
  } finally { s.close(); }
});

test('the settings a site reads come from its code and its example file, not from its tests or its build', async () => {
  const s = await setup();
  try {
    const dir = site({ 'package.json': NEXT, 'app/page.tsx': 'process.env.FROM_CODE', 'dist/bundle.js': 'process.env.FROM_BUILD', 'app/a.test.ts': 'process.env.FROM_TEST', '.env.example': 'FROM_EXAMPLE=\n' });
    const o = (await s.sam('POST', '/api/tools/live.options', { input: { folder: dir } })).body;
    assert.equal(o.status, 'ok', JSON.stringify(o));
    assert.deepEqual(o.output.site.settings, ['FROM_CODE', 'FROM_EXAMPLE']);
  } finally { s.close(); }
});

test('Start free only sends a host to /live when Unit7 can really put a site there', async () => {
  const s = await setup();
  try {
    const hosts = (await s.sam('GET', '/api/live/hosts')).body.map((h: { id: string }) => h.id);
    assert.deepEqual(hosts.sort(), allHosts().map((h) => h.id).sort());
    assert.ok(hosts.includes('vercel') && hosts.includes('coolify'));
    assert.equal((await s.browser()('GET', '/api/live/hosts')).status, 401);
    const hosting = PLANS.filter((p) => p.need === 'hosting' && p.connect && hosts.includes(p.connect)).map((p) => p.id);
    assert.ok(hosting.includes('vercel'), 'Vercel’s row goes to /live');
  } finally { s.close(); }
});

const wait = async <T>(what: string, f: () => Promise<T | undefined> | T | undefined): Promise<T> => {
  for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`never: ${what}`);
};

test('ui.folder: the card shows in the chat, and the AI gets an upload, its name and its stack, never a path', async () => {
  const s = await setup();
  try {
    call = { name: 'ui_folder', arguments: { note: 'Drop your site here.' } };
    const { conversationId } = (await s.sam('POST', '/api/agent/conversations', { message: 'put this live' })).body;
    const thread = async () => (await s.sam('GET', `/api/agent/conversations/${conversationId}`)).body as { running: boolean; messages: { id: string; role: string; content: any }[] };
    const ask = await wait('the card', async () => (await thread()).messages.find((m) => m.role === 'ask' && m.content.state === 'waiting'));
    assert.deepEqual(ask.content.spec, { kind: 'folder', title: 'Which site should go live?', note: 'Drop your site here.' });
    assert.ok(!(await thread()).messages.some((m) => m.role === 'tool'), 'its own card, not a step');

    const up = (await s.sam('POST', '/api/live/upload', zipForm(zipOf([{ name: 'shop/package.json', data: NEXT }]), 'shop.zip'))).body;
    // what can't answer: an AI's token, a made-up upload, someone else's, and anything that isn't an upload
    const token = createToken(s.app.db, s.owner, 'an agent', 'agent').token;
    assert.equal((await s.sam('POST', `/api/agent/asks/${ask.id}`, { uploadId: up.uploadId }, token)).status, 403);
    assert.equal((await s.sam('POST', `/api/agent/asks/${ask.id}`, { uploadId: 'upl_madeupmadeup' })).status, 400);
    const other = await setup();
    try {
      const theirs = (await other.sam('POST', '/api/live/upload', zipForm(zipOf([{ name: 'index.html', data: 'x' }])))).body.uploadId;
      assert.equal((await s.sam('POST', `/api/agent/asks/${ask.id}`, { uploadId: theirs })).status, 400, 'another org’s upload');
    } finally { other.close(); }
    assert.equal((await s.sam('POST', `/api/agent/asks/${ask.id}`, { path: '/etc' })).status, 400, 'a path is not an answer');

    const done = await s.sam('POST', `/api/agent/asks/${ask.id}`, { uploadId: up.uploadId, name: 'ignored-from-the-browser', stack: 'lies' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    await wait('the run to end', async () => { const t = await thread(); return t.running ? undefined : t; });
    const heard = JSON.parse(bodies.at(-1).messages.findLast((m: any) => m.role === 'tool').content);
    assert.deepEqual(heard, { uploadId: up.uploadId, name: 'shop', stack: 'next', runtime: 'node' }, 'from Unit7’s own look at it, nothing else');
    assert.match(askSummary({ spec: ask.content.spec, state: 'answered', answer: heard }), new RegExp(`they gave their site shop, uploadId ${up.uploadId}`), 'a later turn can still use it');
  } finally { s.close(); }
});

test('ui.folder only works in the ask box, and Not now stops it', async () => {
  const s = await setup();
  try {
    const actor = { kind: 'user', id: s.me.user.id, userId: s.me.user.id, name: 'Sam', role: 'owner' } as const;
    const r = await execute(s.app, s.me.org.id, actor, 'ui.folder', {});
    assert.equal(r.status, 'error');
    assert.equal((r as any).error.code, 'not_here');
    call = { name: 'ui_folder', arguments: {} };
    const { conversationId } = (await s.sam('POST', '/api/agent/conversations', { message: 'put this live' })).body;
    const ask = await wait('the card', async () => (await s.sam('GET', `/api/agent/conversations/${conversationId}`)).body.messages.find((m: any) => m.role === 'ask' && m.content.state === 'waiting'));
    assert.deepEqual((await s.sam('POST', `/api/agent/asks/${ask.id}`, { cancelled: true })).body.answer, { cancelled: true });
  } finally { s.close(); }
});

test('the guided flow is in what every brain is told', () => {
  assert.match(ASK_RULES, /Put this live: ui_folder, or ui_choose a repo .*then live_options, recommend the first place, live_put, one line with the link\./);
});
