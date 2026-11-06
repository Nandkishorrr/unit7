// Hostinger web hosting's websites and databases, and Firebase Hosting's domains and logs, offline. Hostinger is its real MCP server
// talking to a fake REST API, so its operation names and error shapes are the real ones, and Google is a fake API that answers the
// way its reference says (trailing dots, an operation that stays open). What matters most here: a yes that only means queued is
// followed and never sent twice, a full plan stops, a password never comes back, and nothing goes near an order or a bill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { all, get, run } from '../src/db.ts';
import { hostinger } from '../src/connectors/hostinger.ts';
import { dnsLook } from '../src/connectors/dnswrite.ts';
import { packFolder, saveUpload } from '../src/connectors/folder.ts';
import { liveTiming } from '../src/live/vercel.ts';
import { pointing } from '../src/tools/domains.ts';
import { decideApproval } from '../src/tools/runtime.ts';

liveTiming.pollMs = 1; liveTiming.answerMs = 20; liveTiming.buildMs = 1_500;
pointing.pollMs = 1; pointing.waitMs = 300;

const SITE = { domain: 'shop.example', username: 'u1', website_type: 'nodejs', order_id: 11, is_enabled: true };
const OTHER = { domain: 'blog.example', username: 'u1', website_type: 'other', order_id: 11, is_enabled: true };
const SECOND = { domain: 'client.example', username: 'u2', website_type: 'other', order_id: 22, is_enabled: true };
const done = (domain: string) => [{ domain, username: 'u1', type: null, status: 'completed' }];
const running = (domain: string) => [{ domain, username: 'u1', type: null, status: 'running' }];

interface Fake {
  sites: any[]; setups: any[][]; dbs: any[]; lag: number; env: string[]; zone: any[];
  saved: any[][]; created: any[]; dbMade: any[]; deployed: string[]; wired: string[]; archives: Map<string, Buffer>; sizes: Map<string, string>;
  full?: boolean; badKey?: boolean; busy?: boolean; owned?: boolean; refuseDb?: [number, unknown]; refuseEnv?: boolean; refuseSetup?: [number, unknown];
  google: Google;
}
interface Google { sites: any[]; domain?: any; reads: number; added: string[]; wants?: any; after: number; entries?: any[]; logStatus?: number; badKey?: boolean; bodies: any[]; opError?: string }

function hostingerApi(h: Fake, base: () => string) {
  return (r: Req) => {
    const u = new URL(r.path, 'http://x'), p = u.pathname, m = r.method, json = r.body && r.headers['content-type']?.toString().includes('json') ? JSON.parse(r.body) : undefined;
    if (h.badKey) return [401, { message: 'Unauthenticated.', correlation_id: 'x' }];
    if (p.startsWith('/tus/')) {
      const name = p.slice(5), has = h.archives.get(name) ?? Buffer.alloc(0);
      if (m === 'POST') { h.archives.set(name, has); h.sizes.set(name, String(r.headers['upload-length'])); return [201, '']; }
      if (m === 'HEAD') return [200, '', { 'upload-offset': String(has.length), 'upload-length': h.sizes.get(name)!, 'tus-resumable': '1.0.0' }];
      const whole = Buffer.concat([has, r.raw]); h.archives.set(name, whole);
      return [204, '', { 'upload-offset': String(whole.length), 'tus-resumable': '1.0.0' }];
    }
    if (p === '/api/hosting/v1/websites' && m === 'GET') return { data: h.sites.filter((s) => (s.domain ?? '').includes(u.searchParams.get('domain') ?? '')), meta: { current_page: 1, per_page: 15, total: h.sites.length } };
    if (p === '/api/hosting/v1/websites') {
      h.created.push(json);
      if (h.busy) return [429, { message: 'Too many requests, rate limit exceeded.' }];
      if (h.full) return [422, { message: 'This plan has reached its limit of websites.', errors: {} }];
      h.sites.push({ domain: json.domain, username: 'u1', website_type: 'other', order_id: json.order_id, is_enabled: true });
      return {};
    }
    if (p === '/api/hosting/v1/onboardings') return h.setups.length > 1 ? h.setups.shift() : h.setups[0] ?? [];
    if (p === '/api/hosting/v1/domains/verify-ownership') return { domain: json.domain, is_accessible: !h.owned, txt_to_verify: 'hostinger-site-verification=demo' };
    if (/^\/api\/hosting\/v1\/accounts\/[^/]+\/databases$/.test(p) && m === 'GET') {
      if (h.lag > 0) { h.lag--; return { data: h.dbs.filter((d) => !d.queued), meta: {} }; }
      return { data: h.dbs.map(({ queued: _, ...d }) => d), meta: {} };
    }
    if (p === '/api/hosting/v1/accounts/u1/databases') {
      h.dbMade.push(json);
      if (h.refuseDb) return h.refuseDb;
      h.dbs.push({ name: `u1_${json.name}`, user: `u1_${json.user}`, host: 'srv1.hstgr.example', port: 3306, domain: json.website_domain, disk_usage_mb: 0, max_size_mb: 1024, queued: true });
      return {};
    }
    const w = /^\/api\/hosting\/v1\/accounts\/u1\/websites\/([^/]+)(\/.*)$/.exec(p), rest = w?.[2];
    if (rest === '/databases/setup') {
      h.wired.push(w![1]!);
      if (h.refuseSetup) return h.refuseSetup;
      h.env.push('DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DATABASE_URL');
      return { database: { name: 'u1_made', user: 'u1_made', host: '127.0.0.1', port: 3306 }, env_var_keys: ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DATABASE_URL'] };
    }
    if (rest === '/nodejs/builds/settings/env' && m === 'GET') return h.env.map((key) => ({ key, value: '********' }));
    if (rest === '/nodejs/builds/settings/env') {
      if (h.refuseEnv) return [404, { message: 'This website has no Node.js app.' }];
      h.saved.push(json.env_vars); h.env = json.env_vars.map((e: { key: string }) => e.key);
      return {};
    }
    if (rest === '/deploy') { h.deployed.push(`${w![1]} ${json.archive_path}`); return { success: true }; }
    if (rest === '/cache/clear') return {};
    if (/^\/api\/hosting\/v1\/accounts\/u1\/domains\/[^/]+\/files$/.test(p)) return { data: [{ name: 'default.php', type: 'file' }], total_items: 1 };
    if (p === '/api/hosting/v1/files/upload-urls') return { url: `${base()}/tus`, auth_key: 'demo-auth', rest_auth_key: 'demo-rest' };
    if (p === '/api/dns/v1/zones/shop.example' && m === 'GET') return h.zone;
    if (p === '/api/dns/v1/zones/shop.example') {
      for (const n of json.zone) {
        const at = h.zone.find((z) => z.name === n.name && z.type === n.type);
        if (at && json.overwrite) at.records = n.records; else if (at) at.records.push(...n.records); else h.zone.push(n);
      }
      return {};
    }
    return [404, { message: `no fake for ${m} ${p}` }];
  };
}

const D = '/firebasehosting/v1beta1/projects/shop-prod/sites/shop/customDomains';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY = JSON.stringify({ type: 'service_account', client_email: 'sa@shop-prod.iam.example', private_key: keys, project_id: 'shop-prod' });
function googleApi(g: Google, base: () => string) {
  return (r: Req, p: string) => {
    const u = new URL(r.path, 'http://x'), m = r.method, json = r.body && r.headers['content-type']?.toString().includes('json') ? JSON.parse(r.body) : undefined;
    if (p === '/oauth2/token') return { access_token: 'ya29.key', expires_in: 3600 };
    if (g.badKey) return [401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } }];
    if (p === '/cloudresourcemanager/v1/projects') return { projects: [{ projectId: 'shop-prod' }] };
    if (p === '/cloudresourcemanager/v1/projects/shop-prod:testIamPermissions') return { permissions: json.permissions };
    if (p === '/firebasehosting/v1beta1/projects/shop-prod/sites' && m === 'GET') return { sites: g.sites };
    if (p === '/firebasehosting/v1beta1/projects/shop-prod/sites') { const site = { name: `projects/shop-prod/sites/${u.searchParams.get('siteId')}` }; g.sites.push(site); return site; }
    if (p === '/firebasehosting/v1beta1/sites/shop/versions') return { name: 'sites/shop/versions/v1', status: 'CREATED' };
    if (p === '/firebasehosting/v1beta1/sites/shop/versions/v1:populateFiles') return { uploadRequiredHashes: Object.values(json.files), uploadUrl: `${base()}/google/upload` };
    if (p.startsWith('/upload/')) return {};
    if (p === '/firebasehosting/v1beta1/sites/shop/versions/v1') return {};
    if (p === '/firebasehosting/v1beta1/sites/shop/releases') return { name: 'sites/shop/releases/r1' };
    if (p === D && m === 'GET') return { customDomains: g.domain ? [g.domain] : [] };
    if (p === '/firebasehosting/v1beta1/sites/shop/domains') return { domains: [{ domainName: 'shop.web.app' }] };
    if (p === D && g.opError) return { name: 'op', done: true, error: { code: 9, message: g.opError } };
    if (p === D) { g.added.push(u.searchParams.get('customDomainId')!); g.domain = { name: `projects/shop-prod/sites/shop/customDomains/${u.searchParams.get('customDomainId')}`, reconciling: true, hostState: 'HOST_UNHOSTED' }; return { name: `${g.domain.name}/operations/op1`, done: false }; }
    if (p === `${D}/shop.example`) {
      if (!g.domain) return [404, { error: { code: 404, message: 'Requested entity was not found.' } }];
      return ++g.reads > g.after && g.wants ? { ...g.domain, requiredDnsUpdates: g.wants, reconciling: false } : g.domain;
    }
    if (p === '/logging/v2/entries:list') { g.bodies.push(json); return g.logStatus ? [g.logStatus, { error: { message: 'The caller does not have permission.' } }] : { entries: g.entries ?? [] }; }
    return undefined;
  };
}

const onlyFromHere = (calls: Req[]) => { const near = calls.map((c) => `${c.method} ${c.path.split('?')[0]}`).filter((c) => /order|billing|purchase|payment|subscription/i.test(c)); assert.deepEqual(near, [], 'nothing near money'); };
const require = createRequire(import.meta.url);
const hostingerEntry = () => { const pkg = require.resolve('@hostinger/mcp/package.json'); return join(dirname(pkg), (require(pkg) as { bin: { mcp: string } }).bin.mcp); };
const folder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  for (const [k, v] of Object.entries(files)) { mkdirSync(join(dir, k, '..'), { recursive: true }); writeFileSync(join(dir, k), v); }
  return dir;
};

async function world(o: Partial<Fake> = {}, g: Partial<Google> = {}, connect: { hostinger?: boolean; firebase?: boolean } = { hostinger: true }) {
  const app = testApp(), org = await testOrg(app), google: Google = { sites: [], reads: 0, added: [], after: 1, bodies: [], ...g };
  const h: Fake = { sites: [SITE, OTHER], setups: [], dbs: [], lag: 0, env: [], zone: [], saved: [], created: [], dbMade: [], deployed: [], wired: [], archives: new Map(), sizes: new Map(), google, ...o };
  let base = '';
  const host = hostingerApi(h, () => base), goog = googleApi(google, () => base);
  const api = await fakeApi((r) => (r.path.startsWith('/google/') ? goog(r, r.path.split('?')[0]!.slice('/google'.length)) : host(r)));
  base = api.base;
  // Unit7 starts the server with a clean environment, so the address goes in through env
  process.env.UNIT7_HOSTINGER_CMD = '/usr/bin/env';
  process.env.UNIT7_HOSTINGER_ARGS = [`API_BASE_URL=${api.base}`, process.execPath, hostingerEntry()].join('\n');
  process.env.UNIT7_GOOGLE_API = `${api.base}/google`;
  const dns = dnsLook.host;
  return { app, org, api, h, g: google, acc: connect.hostinger ? account(app, org.orgId, 'hostinger', 'hostinger-demo-token', 'Hostinger demo') : '',
    fire: connect.firebase ? account(app, org.orgId, 'firebase', KEY, 'Firebase demo') : '',
    dnsAt: (host?: string) => { dnsLook.host = async () => ({ zone: 'shop.example', host, nameservers: [] }); },
    up: async (files: Record<string, string>) => saveUpload(app, org.orgId, org.userId, await packFolder(folder(files), undefined, { keepBuild: true })),
    posts: (path: string) => api.calls.filter((c) => c.method === 'POST' && c.path.split('?')[0] === path),
    reads: (path: string) => api.calls.filter((c) => c.method === 'GET' && c.path.split('?')[0] === path),
    close() {
      hostinger(app).closeAll(); api.close(); dnsLook.host = dns;
      delete process.env.UNIT7_HOSTINGER_CMD; delete process.env.UNIT7_HOSTINGER_ARGS; delete process.env.UNIT7_GOOGLE_API;
      onlyFromHere(api.calls);
    } };
}
const CREATE = '/api/hosting/v1/websites', SETUPS = '/api/hosting/v1/onboardings', DBS = '/api/hosting/v1/accounts/u1/databases';
const refused = (r: any, code: string, re: RegExp) => { assert.equal(r.status, 'error', JSON.stringify(r)); assert.equal(r.error.code, code); assert.match(r.error.message, re); assert.doesNotMatch(r.error.message, /undefined|\[object|—/); return r; };
const failing = (w: { app: { db: any } }, id: string) => get<{ status: string }>(w.app.db, 'SELECT status FROM accounts WHERE id = ?', id)!.status;
// every place a value could land once a tool has run
const stored = (w: Awaited<ReturnType<typeof world>>) => JSON.stringify([...all(w.app.db, 'SELECT * FROM audit'), ...all(w.app.db, 'SELECT * FROM events'), ...all(w.app.db, 'SELECT * FROM approvals'), ...all(w.app.db, 'SELECT * FROM changes')]);

// --- a website on a plan you already have ---------------------------------------------------------------------------------

test('a new website: queued, followed on its read until done, and the write goes once', async () => {
  const s = await world({ setups: [[], running('new.example'), running('new.example'), done('new.example')] });
  try {
    const out = ok<any>(await s.org.h('hostinger.website_create', { domain: 'new.example' }));
    assert.equal(out.status, 'ready');
    assert.equal(out.website, 'new.example');
    assert.equal(out.plan, 11, 'the plan the other websites are on, found without an order route');
    assert.deepEqual(s.h.created, [{ domain: 'new.example', order_id: 11 }]);
    assert.equal(s.posts(CREATE).length, 1, 'never sent twice');
    assert.ok(s.reads(SETUPS).length >= 4, 'each read until it said completed');
    assert.ok(s.reads(SETUPS).every((c) => c.path.includes('domain=new.example')), 'its own setup, not any');
  } finally { s.close(); }
});

test('a website already there, even still being set up, is followed and never created again', async () => {
  const s = await world({ sites: [SITE, { ...OTHER, domain: 'new.example' }], setups: [running('new.example'), done('new.example')] });
  try {
    const out = ok<any>(await s.org.h('hostinger.website_create', { domain: 'www.new.example' }));
    assert.equal(out.already, true);
    assert.equal(out.website, 'new.example', 'a website never starts with www.');
    assert.equal(s.posts(CREATE).length, 0);
    assert.ok(s.reads(SETUPS).length >= 2);
  } finally { s.close(); }
  const old = await world({ setups: [[]] }); // a setup isn't listed after a day: that isn't a queue
  try {
    const out = ok<any>(await old.org.h('hostinger.website_create', { domain: 'shop.example' }));
    assert.equal(out.already, true);
    assert.equal(old.reads(SETUPS).length, 1);
  } finally { old.close(); }
});

test('a setup that fails or never ends says so, and nothing is sent again', async () => {
  const bad = await world({ setups: [running('new.example'), [{ domain: 'new.example', status: 'failed' }]] });
  try {
    refused(await bad.org.h('hostinger.website_create', { domain: 'new.example' }), 'setup_failed', /couldn’t finish setting up new\.example.*hPanel/);
    assert.equal(bad.posts(CREATE).length, 1);
    bad.h.setups = [[{ domain: 'new.example', status: 'failed' }]];
    refused(await bad.org.h('hostinger.website_create', { domain: 'new.example' }), 'setup_failed', /couldn’t finish/);
    assert.equal(bad.posts(CREATE).length, 1, 'trying again reads it, it doesn’t send it again');
  } finally { bad.close(); }
  const stuck = await world({ setups: [running('new.example')] });
  try {
    refused(await stuck.org.h('hostinger.website_create', { domain: 'new.example' }), 'still_working', /longer than usual.*Nothing is sent twice/);
    assert.equal(stuck.posts(CREATE).length, 1);
  } finally { stuck.close(); }
});

test('a plan with no room says so and stops, and only what’s really a full plan is called that', async () => {
  const s = await world({ full: true });
  try {
    const r = refused(await s.org.h('hostinger.website_create', { domain: 'new.example' }), 'no_room', /no room for another website: remove one or upgrade the plan in hPanel.*doesn’t buy hosting.*This plan has reached its limit of websites/);
    assert.doesNotMatch(r.error.message, /\.”\./, 'the sentence reads cleanly');
    assert.equal(s.posts(CREATE).length, 1, 'one try');
    assert.equal(s.reads(SETUPS).length, 0, 'nothing is queued, so nothing is followed');
    assert.equal(s.h.sites.length, 2);
  } finally { s.close(); }
  const busy = await world({ busy: true });
  try {
    const r = await busy.org.h('hostinger.website_create', { domain: 'new.example' }) as any;
    assert.equal(r.status, 'error');
    assert.notEqual(r.error.code, 'no_room', 'a rate limit isn’t a full plan');
  } finally { busy.close(); }
});

test('several plans ask which, an account with none says where to start, and a domain that isn’t proven yet says how', async () => {
  const s = await world({ sites: [SITE, OTHER, SECOND], setups: [done('new.example')] });
  try {
    const out = ok<any>(await s.org.h('hostinger.website_create', { domain: 'new.example' }));
    assert.equal(out.status, 'choose_plan');
    assert.deepEqual(out.plans, [{ plan: 11, websites: ['shop.example', 'blog.example'] }, { plan: 22, websites: ['client.example'] }]);
    assert.ok(out.untrusted);
    assert.equal(s.posts(CREATE).length, 0, 'a client’s plan is never picked by guessing');
    const picked = ok<any>(await s.org.h('hostinger.website_create', { domain: 'new.example', plan: 22 }));
    assert.equal(picked.plan, 22);
    assert.deepEqual(s.h.created, [{ domain: 'new.example', order_id: 22 }]);
  } finally { s.close(); }
  const quiet = await world({ sites: [SITE, { ...OTHER, domain: null, order_id: 11 }, SECOND] }); // a builder site can have no domain
  try {
    assert.deepEqual(ok<any>(await quiet.org.h('hostinger.website_create', { domain: 'new.example' })).plans[0].websites, ['shop.example']);
  } finally { quiet.close(); }
  const none = await world({ sites: [] });
  try {
    refused(await none.org.h('hostinger.website_create', { domain: 'new.example' }), 'no_plan', /add the first one in hPanel.*doesn’t buy hosting/);
    assert.equal(none.posts(CREATE).length, 0);
  } finally { none.close(); }
  const proof = await world({ owned: true });
  try {
    const out = ok<any>(await proof.org.h('hostinger.website_create', { domain: 'new.example' }));
    assert.equal(out.status, 'needs_proof');
    assert.deepEqual(out.addThis, { type: 'TXT', name: 'new.example', value: 'hostinger-site-verification=demo' });
    assert.match(out.next, /saying hostinger-site-verification=demo/, 'a page shows this line alone, so the value is in it');
    assert.equal(proof.posts(CREATE).length, 0, 'it would only be refused');
  } finally { proof.close(); }
});

test('an AI’s new website waits for a person, and a person’s yes runs it once', async () => {
  const s = await world({ setups: [done('new.example')] });
  try {
    const asked = await s.org.a('hostinger.website_create', { domain: 'new.example' }) as any;
    assert.equal(asked.status, 'approval_required');
    assert.match(asked.why, /place on your plan/);
    assert.equal(s.posts(CREATE).length, 0, 'nothing happens until a person says yes');
    const yes = await decideApproval(s.app, s.org.orgId, s.org.human, asked.approvalId, true) as any;
    assert.equal(yes.status, 'ok');
    assert.equal(s.posts(CREATE).length, 1);
  } finally { s.close(); }
});

test('a refused key reads in plain words, stops at the first call, and marks the account for a person', async () => {
  const s = await world({ badKey: true });
  try {
    refused(await s.org.h('hostinger.website_create', { domain: 'new.example' }), 'hostinger_refused', /didn’t accept this account’s key.*Connections/);
    assert.equal(s.posts(CREATE).length, 0);
    assert.equal(failing(s, s.acc), 'failing', 'background work stops until a person reconnects it');
  } finally { s.close(); }
  for (const call of [['hostinger.database_list', {}], ['hostinger.database_create', { website: 'shop.example', name: 'db1' }], ['hostinger.database_connect', { website: 'shop.example' }]] as const) {
    const t = await world({ badKey: true });
    try {
      refused(await t.org.h(call[0], call[1]), 'hostinger_refused', /didn’t accept this account’s key/);
      assert.equal(failing(t, t.acc), 'failing');
      assert.equal(t.h.dbMade.length, 0);
      assert.equal(t.app.vault.list(t.org.orgId).filter((x) => /db-password/.test(x.ref)).length, 0, 'no password kept for nothing');
    } finally { t.close(); }
  }
  const put = await world({ badKey: true });
  try {
    const id = await put.up({ 'index.html': 'hi' });
    refused(await put.org.h('live.put', { uploadId: id, to: 'hostinger', domain: 'shop.example', name: 'shop' }), 'hostinger_refused', /Connections/);
  } finally { put.close(); }
});

test('Put this live: an upload with no matching website offers to create it, and then goes live there', async () => {
  const s = await world({ setups: [running('new.example'), done('new.example')] });
  try {
    const uploadId = await s.up({ 'index.html': '<h1>hi</h1>' }), put = { uploadId, to: 'hostinger', domain: 'new.example', name: 'shop' };
    refused(await s.org.h('live.put', put), 'no_website', /new\.example isn’t a website on this Hostinger account.*hostinger\.website_create.*a person says yes first.*hPanel.*doesn’t buy hosting/);
    assert.equal(s.posts(CREATE).length, 0, 'it offers, it doesn’t do it by itself');
    assert.equal(ok<any>(await s.org.h('hostinger.website_create', { domain: 'new.example', accountId: s.acc })).status, 'ready');
    const out = ok<any>(await s.org.h('live.put', put));
    assert.equal(out.url, 'https://new.example');
    assert.match(s.h.deployed[0]!, /^new\.example unit7-[0-9a-f]{16}\.tgz$/);
    assert.equal(s.posts(CREATE).length, 1);
  } finally { s.close(); }
});

// --- its databases --------------------------------------------------------------------------------------------------------

test('a new database: queued, followed until it shows, the password in the vault and nowhere else, and only once', async () => {
  const s = await world({ lag: 3 });
  try {
    const out = ok<any>(await s.org.a('hostinger.database_create', { website: 'shop.example', name: 'shopdb' })); // it only creates, so an AI may
    const sent = s.h.dbMade[0], password = sent.password as string;
    assert.equal(s.h.dbMade.length, 1);
    assert.deepEqual({ ...sent, password: '' }, { name: 'shopdb', user: 'shopdb', password: '', website_domain: 'shop.example' });
    assert.match(password, /[a-z]/); assert.match(password, /[A-Z]/); assert.match(password, /[0-9]/);
    assert.ok(password.length >= 24);
    assert.equal(out.database, 'u1_shopdb');
    assert.equal(out.host, '127.0.0.1', 'from the app, never the outside address Hostinger lists');
    assert.match(out.passwordRef, /^credential:\/\/hostinger\//);
    assert.equal(s.app.vault.resolve(s.org.orgId, out.passwordRef), password);
    assert.ok(s.reads(DBS).length >= 4, 'each read until it showed');
    assert.ok(!JSON.stringify(out).includes(password), 'never in a result');
    assert.ok(!stored(s).includes(password), 'nor the audit, an event or an approval');
    // again: the same one, and the password in the vault isn't replaced with one the database doesn't have
    assert.deepEqual(ok<any>(await s.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' })), out);
    assert.equal(s.h.dbMade.length, 1);
    assert.equal(s.app.vault.resolve(s.org.orgId, out.passwordRef), password);
  } finally { s.close(); }
});

test('a database still queued when the wait ends is picked up by the next try, and never sent again', async () => {
  const s = await world({ lag: 1_000_000 });
  try {
    refused(await s.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }), 'still_working', /Nothing is sent twice/);
    const password = s.h.dbMade[0].password;
    s.h.lag = 1;
    const out = ok<any>(await s.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }));
    assert.equal(s.h.dbMade.length, 1);
    assert.equal(s.app.vault.resolve(s.org.orgId, out.passwordRef), password);
  } finally { s.close(); }
});

test('a password left from a database removed since doesn’t hold a new one up', async () => {
  const s = await world({ lag: 1 });
  try {
    const first = ok<any>(await s.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }));
    s.h.dbs = []; // someone removed it in hPanel
    run(s.app.db, `UPDATE secrets SET created_at = '2026-01-01T00:00:00.000Z' WHERE ref = ?`, first.passwordRef);
    ok(await s.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }));
    assert.equal(s.h.dbMade.length, 2);
    assert.notEqual(s.h.dbMade[1].password, s.h.dbMade[0].password);
    assert.equal(s.app.vault.resolve(s.org.orgId, first.passwordRef), s.h.dbMade[1].password, 'the vault follows the database that’s really there');
  } finally { s.close(); }
});

test('a database Hostinger turned down keeps no password, and one that’s already there isn’t taken over', async () => {
  const s = await world({ refuseDb: [422, { message: 'That name is too long.' }] });
  try {
    refused(await s.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }), 'hostinger_error', /refused to create u1_shopdb: That name is too long\./);
    assert.deepEqual(s.app.vault.list(s.org.orgId).filter((x) => /db-password/.test(x.ref)), []);
    s.h.refuseDb = undefined;
    ok(await s.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }));
    assert.equal(s.h.dbMade.length, 2, 'a no isn’t a queue, so this is a new try');
  } finally { s.close(); }
  // a 500 may still have made it, so its password stays
  const odd = await world({ refuseDb: [500, { message: 'Try later.' }], lag: 1_000_000 });
  try {
    const r = await odd.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }) as any;
    assert.equal(r.status, 'error');
    assert.equal(odd.app.vault.list(odd.org.orgId).filter((x) => /db-password/.test(x.ref)).length, 1);
  } finally { odd.close(); }
  const had = await world({ dbs: [{ name: 'u1_shopdb', user: 'u1_shopdb', domain: 'shop.example' }] });
  try {
    refused(await had.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }), 'already_exists', /doesn’t hold its password/);
    assert.equal(had.h.dbMade.length, 0);
  } finally { had.close(); }
  const site = await world();
  try {
    assert.equal((await site.org.h('hostinger.database_create', { website: 'shop.example', name: '../etc' }) as any).error.code, 'invalid_input');
    refused(await site.org.h('hostinger.database_create', { website: 'none.example', name: 'db1' }), 'no_website', /isn’t a website/);
  } finally { site.close(); }
});

test('the list shows what’s there, never a password, and only the asked website’s', async () => {
  const s = await world({ dbs: [{ name: 'u1_a', user: 'u1_a', host: 'srv1.hstgr.example', port: 3306, domain: 'shop.example', disk_usage_mb: 3, max_size_mb: 1024 }, { name: 'u1_b', user: 'u1_b', domain: 'blog.example', max_size_mb: 1024 }] });
  try {
    const all = ok<any>(await s.org.a('hostinger.database_list', {}));
    assert.deepEqual(all.databases.map((d: any) => d.name), ['u1_a', 'u1_b']);
    assert.equal(all.databases[0].passwordKept, false);
    assert.deepEqual(all.appConnectsTo, { host: '127.0.0.1', port: 3306 });
    assert.ok(all.untrusted);
    assert.ok(!('host' in all.databases[0]), 'the outside address isn’t offered to an app');
    const one = ok<any>(await s.org.a('hostinger.database_list', { website: 'shop.example' }));
    assert.deepEqual(one.databases.map((d: any) => d.name), ['u1_a']);
  } finally { s.close(); }
});

test('connecting a database: an AI waits for a person, the password reaches the app, and never a result', async () => {
  const s = await world({ lag: 1 });
  try {
    const made = ok<any>(await s.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' })), password = s.h.dbMade[0].password as string;
    const asked = await s.org.a('hostinger.database_connect', { website: 'shop.example', database: 'u1_shopdb' }) as any;
    assert.equal(asked.status, 'approval_required', 'like any stored key an app can read');
    assert.match(asked.why, /An app can read a database password/);
    assert.deepEqual(s.h.saved, [], 'nothing placed until a person says yes');
    const yes = await decideApproval(s.app, s.org.orgId, s.org.human, asked.approvalId, true) as any;
    assert.equal(yes.status, 'ok', JSON.stringify(yes));
    const put = Object.fromEntries((s.h.saved as any[][])[0]!.map((e: { key: string; value: string }) => [e.key, e.value]));
    assert.deepEqual(put, { DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'u1_shopdb', DB_USER: 'u1_shopdb', DB_PASSWORD: password, DATABASE_URL: `mysql://u1_shopdb:${encodeURIComponent(password)}@127.0.0.1:3306/u1_shopdb` });
    assert.deepEqual(yes.output.settings, Object.keys(put));
    assert.ok(!JSON.stringify(yes).includes(password));
    assert.ok(!stored(s).includes(password));
    assert.equal(made.database, yes.output.database);
    // what it put there comes back out, and nothing else
    const undone = ok<any>(await s.org.h('change.undo', { changeId: yes.output.changeId }));
    assert.deepEqual(undone.removed, Object.keys(put));
    assert.deepEqual(s.h.saved[1], []);
  } finally { s.close(); }
});

test('connecting never erases a setting, and a database Unit7 has no password for says what to do', async () => {
  const s = await world({ lag: 1, env: ['STRIPE_KEY'] });
  try {
    ok(await s.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }));
    refused(await s.org.h('hostinger.database_connect', { website: 'shop.example', database: 'u1_shopdb' }), 'would_erase', /would erase STRIPE_KEY.*Or leave out database/);
    assert.deepEqual(s.h.saved, []);
    refused(await s.org.h('hostinger.database_connect', { website: 'shop.example', database: 'u1_none' }), 'not_found', /hostinger\.database_list/);
  } finally { s.close(); }
  const hand = await world({ dbs: [{ name: 'u1_old', user: 'u1_old', domain: 'shop.example' }] });
  try {
    refused(await hand.org.h('hostinger.database_connect', { website: 'shop.example', database: 'u1_old' }), 'no_password', /Hostinger never shows one.*Leave out database/);
  } finally { hand.close(); }
  // settings it replaced can't be read back, so there's no undo that would pretend otherwise
  const again = await world({ lag: 1, env: ['DB_HOST'] });
  try {
    ok(await again.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }));
    const out = ok<any>(await again.org.h('hostinger.database_connect', { website: 'shop.example', database: 'u1_shopdb' }));
    assert.equal(out.changeId, undefined);
  } finally { again.close(); }
});

test('with no database named, Hostinger makes one and wires it in, keeping what the app has, and nobody sees the password', async () => {
  const s = await world({ env: ['STRIPE_KEY'] });
  try {
    const asked = await s.org.a('hostinger.database_connect', { website: 'shop.example' }) as any;
    assert.equal(asked.status, 'approval_required');
    assert.deepEqual(s.h.wired, []);
    const out = ok<any>(await s.org.h('hostinger.database_connect', { website: 'shop.example' }));
    assert.deepEqual(s.h.wired, ['shop.example']);
    assert.equal(out.database, 'u1_made');
    assert.ok(out.settings.includes('DB_PASSWORD'));
    assert.ok(s.h.env.includes('STRIPE_KEY'), 'the others stay');
    assert.deepEqual(s.h.saved, [], 'nothing replaced them');
    assert.match(out.next, /nobody sees it/);
  } finally { s.close(); }
  const taken = await world({ refuseSetup: [422, { message: 'DB_HOST already exists.' }] });
  try {
    refused(await taken.org.h('hostinger.database_connect', { website: 'shop.example' }), 'hostinger_error', /DB_HOST already exists\./);
  } finally { taken.close(); }
});

test('sites that can’t take settings say what would work, and WordPress keeps its own', async () => {
  const php = await world({ lag: 1, sites: [{ ...OTHER, domain: 'shop.example' }], refuseEnv: true, refuseSetup: [422, { message: 'This website has no Node.js app.' }] });
  try {
    ok(await php.org.h('hostinger.database_create', { website: 'shop.example', name: 'shopdb' }));
    refused(await php.org.h('hostinger.database_connect', { website: 'shop.example', database: 'u1_shopdb' }), 'hostinger_error', /no Node\.js app\..*runs PHP.*from a file on the server.*vault/);
    refused(await php.org.h('hostinger.database_connect', { website: 'shop.example' }), 'hostinger_error', /no Node\.js app\..*runs PHP/);
  } finally { php.close(); }
  const wp = await world({ sites: [{ ...SITE, website_type: 'wordpress' }] });
  try {
    refused(await wp.org.h('hostinger.database_connect', { website: 'shop.example' }), 'no_settings', /runs WordPress, which keeps its own database settings/);
    assert.deepEqual(wp.h.wired, []);
  } finally { wp.close(); }
});

// --- Firebase Hosting: your domain ----------------------------------------------------------------------------------------

const WANTS = {
  desired: [{ domainName: 'shop.example.', records: [
    { domainName: 'shop.example.', type: 'A', rdata: '203.0.113.7', requiredAction: 'ADD' },
    { domainName: 'shop.example.', type: 'TXT', rdata: 'hosting-site=shop', requiredAction: 'ADD' },
  ] }],
  discovered: [{ domainName: 'shop.example.', records: [
    { domainName: 'shop.example.', type: 'A', rdata: '203.0.113.99', requiredAction: 'REMOVE' },
    { domainName: 'shop.example.', type: 'AAAA', rdata: '2001:db8::1', requiredAction: 'REMOVE' },
    { domainName: 'shop.example.', type: 'TXT', rdata: 'v=spf1 include:_spf.mail.example ~all', requiredAction: 'NONE' },
  ] }],
};
const ZONE = () => [{ name: '@', type: 'A', ttl: 300, records: [{ content: '203.0.113.99' }] }, { name: '@', type: 'AAAA', ttl: 300, records: [{ content: '2001:db8::1' }] }, { name: '@', type: 'TXT', ttl: 300, records: [{ content: 'v=spf1 include:_spf.mail.example ~all' }] }];
const contents = (zone: any[], type: string) => zone.find((z) => z.type === type)?.records.map((r: { content: string }) => r.content);
const PLAIN = { 'index.html': '<h1>hi</h1>' };

test('Firebase: your domain on Put this live: it’s added once, its records go where the DNS lives, and SPF stays', async () => {
  const s = await world({ zone: ZONE() }, { wants: WANTS, after: 2 }, { hostinger: true, firebase: true });
  try {
    s.dnsAt('hostinger');
    const out = ok<any>(await s.org.h('live.put', { uploadId: await s.up(PLAIN), to: 'firebase', name: 'shop', domain: 'shop.example' }));
    assert.deepEqual(s.g.added, ['shop.example']);
    assert.deepEqual(contents(s.h.zone, 'A'), ['203.0.113.7'], 'the old address is replaced, with no trailing dot');
    assert.deepEqual(contents(s.h.zone, 'TXT'), ['v=spf1 include:_spf.mail.example ~all', 'hosting-site=shop'], 'beside the SPF record, never over it');
    assert.deepEqual(contents(s.h.zone, 'AAAA'), ['2001:db8::1'], 'nothing is removed by itself');
    assert.equal(out.domain.error, undefined);
    assert.match(out.domain.note, /Firebase Hosting issues HTTPS/);
    assert.equal(out.domain.also.length, 1, 'the old A is dealt with, the AAAA is the person’s');
    assert.match(out.domain.also[0], /AAAA shop\.example → 2001:db8::1 gone.*dns\.remove/);
    assert.ok(out.domain.untrusted);
    const row = get<{ target: string; status: string }>(s.app.db, 'SELECT target, status FROM domains WHERE hostname = ?', 'shop.example')!;
    assert.deepEqual(JSON.parse(row.target), { kind: 'firebase', accountId: s.fire, project: 'shop-prod', site: 'shop' });
    assert.equal(row.status, 'pending', 'Warden checks it from here');
    // again: nothing sent twice, no second copy of the record
    ok(await s.org.h('live.put', { uploadId: await s.up(PLAIN), to: 'firebase', name: 'shop', update: true, domain: 'shop.example' }));
    assert.deepEqual(s.g.added, ['shop.example']);
    assert.deepEqual(contents(s.h.zone, 'TXT'), ['v=spf1 include:_spf.mail.example ~all', 'hosting-site=shop']);
  } finally { s.close(); }
});

test('Firebase: DNS Unit7 can’t write is handed to the person, with the bare domain as @', async () => {
  const s = await world({}, { wants: WANTS }, { firebase: true });
  try {
    s.dnsAt('squarespace');
    const out = ok<any>(await s.org.h('domain.point', { hostname: 'shop.example', firebase: { accountId: s.fire, project: 'shop-prod', site: 'shop' } }));
    assert.equal(out.dns, 'needs you');
    assert.deepEqual(out.addThese, [{ type: 'A', name: '@', value: '203.0.113.7' }, { type: 'TXT', name: '@', value: 'hosting-site=shop' }]);
    assert.equal(out.also.length, 2, 'nothing was written, so both old records still stand');
  } finally { s.close(); }
});

test('Firebase: two of a kind both stay, a quoted TXT loses its quotes, and a type DNS writers don’t have is said', async () => {
  const wants = { desired: [{ records: [
    { domainName: 'shop.example.', type: 'A', rdata: '203.0.113.7', requiredAction: 'ADD' }, { domainName: 'shop.example.', type: 'A', rdata: '203.0.113.8', requiredAction: 'ADD' },
    { domainName: 'shop.example.', type: 'TXT', rdata: '"hosting-site=shop"', requiredAction: 'NONE' }, { domainName: 'shop.example.', type: 'CAA', rdata: '0 issue "pki.goog"', requiredAction: 'ADD' },
  ] }] };
  const s = await world({ zone: ZONE() }, { wants, after: 0 }, { hostinger: true, firebase: true });
  try {
    s.dnsAt('hostinger');
    const out = ok<any>(await s.org.h('domain.point', { hostname: 'shop.example', firebase: { accountId: s.fire, project: 'shop-prod', site: 'shop' } }));
    assert.deepEqual(contents(s.h.zone, 'A'), ['203.0.113.7', '203.0.113.8']);
    assert.ok(contents(s.h.zone, 'TXT').includes('hosting-site=shop'));
    assert.match(out.also[0], /also wants CAA shop\.example.*dns\.set/);
  } finally { s.close(); }
});

test('Firebase: it says so when Google hasn’t answered yet, a refused key is a refusal, and an AI waits for a person', async () => {
  const s = await world({}, {}, { firebase: true });
  try {
    s.dnsAt('hostinger');
    const point = { hostname: 'shop.example', firebase: { accountId: s.fire, project: 'shop-prod', site: 'shop' } };
    refused(await s.org.h('domain.point', point), 'firebase_waiting', /hasn’t said which DNS records.*nothing is sent twice/);
    s.g.wants = WANTS;
    assert.equal((await s.org.a('domain.point', point) as any).status, 'approval_required');
    assert.deepEqual(s.g.added, ['shop.example'], 'only the person’s try added it');
    assert.equal(s.posts('/google/firebasehosting/v1beta1/projects/shop-prod/sites/shop/customDomains').length, 1);
  } finally { s.close(); }
  const op = await world({}, { opError: 'This domain is in use by another project.' }, { firebase: true });
  try {
    refused(await op.org.h('domain.point', { hostname: 'shop.example', firebase: { accountId: op.fire, project: 'shop-prod', site: 'shop' } }), 'firebase_error', /wouldn’t take shop\.example: This domain is in use by another project\./);
  } finally { op.close(); }
  const k = await world({}, { badKey: true }, { firebase: true });
  try {
    const r = await k.org.h('domain.point', { hostname: 'shop.example', firebase: { accountId: k.fire, project: 'shop-prod', site: 'shop' } }) as any;
    assert.equal(r.status, 'error');
    assert.match(r.error.message, /unauthorized/);
    assert.equal(failing(k, k.fire), 'failing');
  } finally { k.close(); }
  const bad = await world({}, {}, { firebase: true });
  try {
    for (const firebase of [{ accountId: bad.fire, project: 'shop-prod', site: '../x' }, { accountId: bad.fire, project: '../x', site: 'shop' }]) assert.equal((await bad.org.h('domain.point', { hostname: 'shop.example', firebase }) as any).error.code, 'invalid_input');
    assert.equal(bad.g.added.length, 0);
  } finally { bad.close(); }
});

// --- Firebase Hosting: logs -------------------------------------------------------------------------------------------------

test('Firebase logs: what Cloud Logging holds, oldest first; none says how to link them; no right says which role', async () => {
  const entries = [{ timestamp: '2026-11-07T10:01:00Z', httpRequest: { requestMethod: 'GET', requestUrl: 'https://shop.web.app/new?oobCode=a-reset-code', status: 404 } }, { timestamp: '2026-11-07T10:00:00Z', httpRequest: { requestMethod: 'GET', requestUrl: 'https://shop.web.app/', status: 200 } }];
  const s = await world({}, { entries, domain: { name: 'projects/shop-prod/sites/shop/customDomains/shop.example' } }, { firebase: true });
  try {
    const out = ok<any>(await s.org.h('live.logs', { to: 'firebase', project: 'shop' }));
    assert.deepEqual(out.lines, ['2026-11-07T10:00:00Z 200 GET https://shop.web.app/', '2026-11-07T10:01:00Z 404 GET https://shop.web.app/new']);
    assert.ok(out.untrusted);
    const b = s.g.bodies[0];
    assert.deepEqual(b.resourceNames, ['projects/shop-prod']);
    assert.equal(b.filter, 'resource.type="firebase_domain" AND resource.labels.domain_name=("shop.web.app" OR "shop.firebaseapp.com" OR "shop.example")');
    assert.equal(b.orderBy, 'timestamp desc');
    s.g.entries = [];
    refused(await s.org.h('live.logs', { to: 'firebase', project: 'shop' }), 'no_logs', /has no build log.*https:\/\/console\.firebase\.google\.com\/project\/shop-prod\/settings\/integrations\/cloudlogging.*30 minutes/);
    s.g.logStatus = 404;
    refused(await s.org.h('live.logs', { to: 'firebase', project: 'shop' }), 'no_logs', /has no build log/);
    s.g.logStatus = 403;
    refused(await s.org.h('live.logs', { to: 'firebase', project: 'shop' }), 'no_logs', /Logs Viewer role.*console\.cloud\.google\.com\/logs/);
    assert.equal(failing(s, s.fire), 'verified', 'a missing role isn’t a refused key');
    refused(await s.org.h('live.logs', { to: 'firebase', project: '../x' }), 'invalid_input', /isn’t a project here/);
  } finally { s.close(); }
  const k = await world({}, {}, { firebase: true });
  try {
    k.g.badKey = true;
    const r = await k.org.h('live.logs', { to: 'firebase', project: 'shop' }) as any;
    assert.equal(r.status, 'error');
    assert.match(r.error.message, /unauthorized/);
    assert.equal(failing(k, k.fire), 'failing');
  } finally { k.close(); }
});
