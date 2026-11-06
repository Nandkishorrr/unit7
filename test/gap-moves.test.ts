// Moving a site, offline: a fake Vercel as the old host, a fake Render as the new one, GoDaddy as the DNS, a real local git repo,
// and two small sites to compare. What must hold: a plan only reads and never shows a value, move.run only creates, nothing
// switches without a person, and the old site is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { all, get, now, run } from '../src/db.ts';
import { dnsLook } from '../src/connectors/dnswrite.ts';
import { dnsDeps } from '../src/tools/clouds-dns.ts';
import { domainDns } from '../src/tools/domains.ts';
import { liveTiming } from '../src/live/vercel.ts';
import { hostOf } from '../src/live/hosts.ts';
import { decideApproval, type ToolResult } from '../src/tools/runtime.ts';
import { differs, linksOf, moveTiming } from '../src/tools/moves.ts';
import { Unit7Error } from '../src/errors.ts';

liveTiming.pollMs = 1; liveTiming.answerMs = 20;
Object.assign(moveTiming, { tries: 2, waitMs: 1, pageMs: 2000 });
process.env.UNIT7_RECHECK = 'off';
const SECRET = 'demo-secret-value-1', RAW = 'typed-by-a-person-1', ZONE = 'shop.example';
const saved = { look: { ...dnsLook }, deps: { ...dnsDeps }, dom: { ...domainDns } };
after(() => { Object.assign(dnsLook, saved.look); Object.assign(dnsDeps, saved.deps); Object.assign(domainDns, saved.dom); });

const SHOP = {
  'package.json': JSON.stringify({ name: 'shop', scripts: { build: 'vite build' }, dependencies: { react: '19.0.0', 'react-router-dom': '7.0.0', stripe: '14.0.0', '@vercel/analytics': '1.0.0' }, devDependencies: { vite: '6.0.0' } }),
  'index.html': '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  'src/main.tsx': 'const u = process.env.VERCEL_URL;\nexport const App = () => <Routes><Route path="/" element={<Home />} /><Route path="/about" element={<About />} /></Routes>;',
  'vercel.json': JSON.stringify({ crons: [{ path: '/api/daily', schedule: '0 8 * * *' }], redirects: [{ source: '/old', destination: '/new' }] }),
  'api/webhooks/stripe.ts': 'export default () => null',
  '.github/workflows/nightly.yml': 'on:\n  schedule:\n    - cron: "0 3 * * *"\n',
};

function repoAt(root: string, name: string, files: Record<string, string>) {
  const bare = join(root, 'demo', `${name}.git`), work = mkdtempSync(join(tmpdir(), 'work-'));
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  for (const [k, v] of Object.entries(files)) { mkdirSync(join(work, k, '..'), { recursive: true }); writeFileSync(join(work, k), v); }
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...a], { cwd: work, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('add', '-A', '-f'); git('commit', '-q', '-m', 'first'); git('push', '-q', `file://${bare}`, 'main');
}

const godaddy = (rows: any[]) => ({ method, path, body }: Req) => {
  const p = decodeURIComponent(path.split('?')[0]!);
  if (p === `/v1/domains/${ZONE}`) return { domain: ZONE };
  if (p === `/v1/domains/${ZONE}/records`) {
    if (method === 'GET') return rows;
    if (method === 'PATCH') { rows.push(...JSON.parse(body)); return {}; }
    return [400, { message: 'never replace the whole zone' }];
  }
  const m = new RegExp(`^/v1/domains/${ZONE}/records/([A-Z]+)/(.+)$`).exec(p);
  if (!m) return undefined;
  const here = (r: any) => r.type === m[1] && r.name === m[2];
  if (method === 'GET') return rows.filter(here);
  // a CNAME stands alone at its name, as at every real DNS host
  if (method === 'PUT' && rows.some((r) => r.name === m[2] && !here(r) && (r.type === 'CNAME' || m[1] === 'CNAME') && ['A', 'AAAA', 'CNAME'].includes(r.type))) return [422, { message: 'That name already has another record' }];
  const others = rows.filter((r) => !here(r));
  rows.length = 0; rows.push(...others);
  if (method === 'PUT') rows.push(...JSON.parse(body).map((r: any) => ({ ...r, type: m[1], name: m[2] })));
  return {};
};
const HOME = '<html><head><title>Shop</title></head><body><h1>Welcome to the shop</h1><p>Good things for sale here</p><a href="/about">About</a><a href="/style.css">x</a></body></html>';
const ABOUT = '<html><head><title>About us</title></head><body><p>We make good things by hand</p></body></html>';

interface World { site?: Partial<Record<string, [number, string]>>; dead?: boolean; plan?: string; envs?: any[]; build?: string[]; files?: Record<string, string>; repo?: boolean; rows?: any[]; taken?: boolean; refuse?: boolean; dnsAt?: string }
async function world(o: World = {}) {
  const app = testApp(), org = await testOrg(app), root = mkdtempSync(join(tmpdir(), 'remote-'));
  repoAt(root, 'shop', o.files ?? SHOP);
  const st = { oldHostWrites: [] as string[], made: (o.taken ? [{ id: 'srv-1', name: 'shop', type: 'web_service' }] : []) as any[], domains: [] as string[], deploys: o.build ?? ['live'], rebuilt: 0 };
  const rows = o.rows ?? [{ type: 'A', name: '@', data: '192.0.2.10', ttl: 3600 }, { type: 'CNAME', name: 'www', data: 'cname.old-host.example', ttl: 3600 }, { type: 'MX', name: '@', data: 'mx1.example.net', ttl: 3600, priority: 10 }];
  const oldSite = await fakeApi(({ path }) => (path === '/' ? HOME : path === '/about' ? ABOUT : [404, 'nothing here']));
  const newSite = await fakeApi(({ path }) => (o.dead ? [503, 'down'] : o.site?.[path] ?? (path === '/' ? HOME : path === '/about' ? ABOUT : [404, 'nothing here'])));
  const vercel = await fakeApi(({ method, path }) => {
    const p = path.split('?')[0]!;
    if (method !== 'GET') st.oldHostWrites.push(`${method} ${p}`);
    if (p === '/v2/user') return { user: { username: 'ada', defaultTeamId: null, billing: { plan: o.plan ?? 'hobby' } } };
    if (p === '/v2/teams') return { teams: [] };
    if (p === '/v9/projects/prj_old/domains') return { domains: [{ name: ZONE, redirect: null }, { name: `www.${ZONE}`, redirect: ZONE }] };
    if (p === '/v10/projects/prj_old/env') return { envs: o.envs ?? [
      { key: 'PUBLIC_NAME', type: 'plain', value: 'demo', target: ['production', 'preview'] },
      { key: 'API_KEY', type: 'encrypted', value: SECRET, decrypted: true, target: ['production'] },
      { key: 'STRIPE_SECRET_KEY', type: 'sensitive', value: '', target: ['production'] },
      { key: 'STRIPE_WEBHOOK_SECRET', type: 'encrypted', value: 'ciphertext-not-opened', decrypted: false, target: ['production'] },
      { key: 'PREVIEW_ONLY', type: 'plain', value: 'x', target: ['preview'] },
      { key: 'VERCEL_URL', type: 'system', value: 'shop.vercel.app', target: ['production'] },
    ] };
    return undefined;
  });
  const render = await fakeApi(({ method, path, body }) => {
    const p = path.split('?')[0]!, id = 'srv-1';
    if (p === '/services' && method === 'GET') return st.made.map((service) => ({ service, cursor: 'c' }));
    if (p === '/owners') return [{ owner: { id: 'own-1', name: 'Ada' }, cursor: 'c' }];
    if (p === '/services' && method === 'POST' && o.refuse) return [401, { message: 'unauthorized' }];
    if (p === '/services' && method === 'POST') { const b = JSON.parse(body); st.made.push({ ...b, id, serviceDetails: { url: newSite.base } }); return [201, { service: { id }, deployId: 'dep-1' }]; }
    if (p === `/services/${id}`) return { id, name: 'shop', type: 'static_site', ownerId: 'own-1', serviceDetails: { url: newSite.base } };
    if (p === `/services/${id}/deploys/dep-1`) return { id: 'dep-1', status: st.deploys.length > 1 ? st.deploys.shift() : st.deploys[0] };
    if (p === `/services/${id}/deploys` && method === 'POST') { st.rebuilt++; st.deploys = ['live']; return [201, { id: 'dep-1' }]; }
    if (/^\/services\/srv-1\/env-vars\//.test(p) && method === 'PUT') { const key = decodeURIComponent(p.split('/').pop()!); st.made[0].envVars = [...(st.made[0].envVars ?? []).filter((e: any) => e.key !== key), { key, value: JSON.parse(body).value }]; return {}; }
    if (p === `/services/${id}/custom-domains` && method === 'POST') { st.domains.push(JSON.parse(body).name); return [201, {}]; }
    if (p === `/services/${id}/env-vars`) return (st.made[0]?.envVars ?? []).map((envVar: unknown) => ({ envVar, cursor: 'c' }));
    if (p === '/logs') return { logs: [{ message: 'npm ERR! missing script: build' }] };
    if (/\/verify$/.test(p)) return {};
    return undefined;
  });
  const dns = await fakeApi(godaddy(rows) as never);
  const info = async () => ({ zone: ZONE, host: o.dnsAt ?? 'godaddy', nameservers: [] });
  dnsLook.host = info; dnsDeps.host = info; domainDns.host = info; dnsDeps.answers = async () => [];
  domainDns.look = () => ({ soa: async () => ({}), ns: async () => [], a: async () => ['192.0.2.20'], cname: async () => [] });
  domainDns.https = async () => true;
  process.env.UNIT7_VERCEL_API = vercel.base; process.env.UNIT7_RENDER_API = render.base; process.env.UNIT7_GODADDY_API = dns.base; process.env.UNIT7_GITHUB_URL = `file://${root}`;
  const acc = account(app, org.orgId, 'vercel', 'tok-demo-old', 'Vercel old'), renderAcc = account(app, org.orgId, 'render', 'rnd-demo-key', 'Render'), dnsAcc = account(app, org.orgId, 'godaddy', 'gd-demo-token', 'GoDaddy');
  const assetId = 'ast_shopshopshop';
  run(app.db, `INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, 'vercel', 'app', 'prj_old', 'shop', ?, ?, ?)`, assetId, org.orgId, acc, oldSite.base,
    JSON.stringify({ hosts: [ZONE, `www.${ZONE}`, 'shop.vercel.app'], envKeys: ['PUBLIC_NAME', 'API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], ...(o.repo !== false && { repo: 'demo/shop' }), end: { kind: 'vercel', accountId: acc, project: 'prj_old' }, platform: 'vercel' }), now());
  const close = () => { for (const s of [oldSite, newSite, vercel, render, dns]) s.close(); for (const k of ['UNIT7_VERCEL_API', 'UNIT7_RENDER_API', 'UNIT7_GODADDY_API', 'UNIT7_GITHUB_URL', 'UNIT7_SUPABASE_API']) delete process.env[k]; };
  return { app, org, st, rows, oldSite, newSite, vercel, render, dns, acc, renderAcc, dnsAcc, assetId, root, close };
}

test('a plan says what a Vercel site is, where it can go and all that comes along, and it never shows a value or changes anything', async () => {
  const w = await world();
  try {
    run(w.app.db, `INSERT INTO costs (org_id, provider, account, label, amount, currency, kind, at) VALUES (?, 'vercel', 'old', 'Vercel old', 20, 'USD', 'spent', ?)`, w.org.orgId, now());
    run(w.app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts, monthly_price, price_currency) VALUES ('srv_demodemodemo', ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready', '{}', 12, 'USD')`, w.org.orgId);
    const res = await w.org.a('move.plan', { assetId: w.assetId });
    const out = ok<any>(res), text = JSON.stringify(res);
    assert.equal(out.what.host, 'Vercel');
    assert.equal(out.what.plan, 'hobby');
    assert.deepEqual(out.comes.settings.canCopy, ['PUBLIC_NAME', 'API_KEY'], 'plain and opened ones can be copied; a preview-only one and a host’s own aren’t the site’s');
    assert.deepEqual(out.comes.settings.personGives, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], 'a sensitive one, and an encrypted one Vercel didn’t open');
    assert.ok(!text.includes(SECRET) && !text.includes('ciphertext-not-opened'), 'no value ever comes back');
    const [apex, www] = out.comes.domains;
    assert.deepEqual([apex.name, www.name], [ZONE, `www.${ZONE}`], 'the host’s own free address isn’t a domain to move');
    assert.equal(apex.dnsAt, 'GoDaddy');
    assert.equal(apex.unit7CanChange, true);
    assert.equal(apex.ttl, 3600);
    assert.match(apex.email, /stay/);
    assert.deepEqual(out.comes.cron.map((c: any) => c.when), ['0 8 * * *', '0 3 * * *']);
    assert.match(out.comes.cron[0].says, /only on Vercel/);
    assert.match(out.comes.cron[1].says, /GitHub runs this/);
    assert.equal(out.comes.redirects[0].where, 'vercel.json');
    assert.match(out.comes.redirects.find((r: any) => r.where === 'The app’s own pages').says, /refreshing a page gives a 404/);
    assert.deepEqual(out.comes.redirects.find((r: any) => r.where === `www.${ZONE}`).says, `It sends visitors to ${ZONE}. Vercel does that, so after the switch domain.canonical or domain.redirect sets it up again.`);
    assert.equal(out.comes.webhooks[0].from, 'Stripe');
    assert.match(out.staysBehind.join(' '), /Vercel Analytics/);
    assert.match(out.staysBehind.join(' '), /VERCEL_URL/);
    assert.match(out.warnings[0], /^This looks commercial \(it takes payments \(stripe\)\).*Hobby plan is for personal, non-commercial use only/, 'a Hobby site that takes payments is warned about');
    assert.deepEqual(out.costsNow.lines, ['Vercel old: 20 USD so far this month']);
    assert.match(out.whereTo.find((p: any) => p.to === 'server').costs, /already costs 12 USD a month/);
    const render = out.whereTo.find((p: any) => p.to === 'render');
    assert.equal(render.ok, true);
    assert.ok(!out.whereTo.some((p: any) => p.to === 'vercel' && p.accountId === w.acc), 'the account it’s already on isn’t somewhere to go');
    assert.deepEqual(w.st.oldHostWrites, [], 'it only read');
    assert.equal(w.dns.calls.filter((c) => c.method !== 'GET').length, 0);
    assert.equal(all(w.app.db, 'SELECT id FROM changes WHERE org_id = ?', w.org.orgId).length, 0);
  } finally { w.close(); }
});

test('a plan warns about what a move can trip over: another project on the same host, a commercial site on Hobby there, and DNS living on the host being left', async () => {
  const w = await world({ dnsAt: 'vercel' });
  try {
    const other = account(w.app, w.org.orgId, 'vercel', 'tok-demo-other', 'Vercel other');
    const out = ok<any>(await w.org.h('move.plan', { assetId: w.assetId }));
    const place = out.whereTo.find((p: any) => p.to === 'vercel' && p.accountId === other);
    assert.match(place.costs, /Pro is \$20 a month/);
    assert.match(place.warnings[0], /A domain can only be on one project here/);
    assert.match(place.warnings[1], /Hobby plan is for personal/);
    assert.match(out.comes.domains[0].warning, /Its DNS is on Vercel, the host being left.*domain\.move_dns/);
  } finally { w.close(); }
});

test('a repo’s files are data: a broken vercel.json or package.json doesn’t stop a plan', async () => {
  const w = await world({ files: { 'index.html': '<h1>hi</h1>', 'vercel.json': '{ // comments\n "crons": [] }', 'package.json': 'not json' } });
  try {
    const out = ok<any>(await w.org.h('move.plan', { assetId: w.assetId }));
    assert.deepEqual(out.comes.cron, []);
    assert.deepEqual(out.comes.redirects.filter((r: any) => r.where === 'vercel.json'), []);
  } finally { w.close(); }
});

test('a Pro project draws no Hobby warning, and a Hobby one that takes no payments draws none either', async () => {
  const pro = await world({ plan: 'pro' });
  try { assert.deepEqual(ok<any>(await pro.org.h('move.plan', { assetId: pro.assetId })).warnings, []); } finally { pro.close(); }
  const plain = await world({ envs: [{ key: 'PUBLIC_NAME', type: 'plain', value: 'demo', target: ['production'] }], files: { 'index.html': '<h1>A diary</h1>' } });
  try { assert.deepEqual(ok<any>(await plain.org.h('move.plan', { assetId: plain.assetId })).warnings, []); } finally { plain.close(); }
});

test('a site with no repo Unit7 knows gets a plan from the map alone, and it says the code is the missing piece', async () => {
  const w = await world({ repo: false });
  try {
    const out = ok<any>(await w.org.h('move.plan', { assetId: w.assetId }));
    assert.equal(out.comes.code.from, null);
    assert.match(out.comes.code.says, /doesn’t know where/);
    assert.deepEqual(out.whereTo, []);
    assert.deepEqual(out.comes.settings.personGives, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
  } finally { w.close(); }
});

const LOVABLE = {
  'package.json': JSON.stringify({ name: 'vite_react_shadcn_ts', scripts: { build: 'vite build' }, dependencies: { react: '19.0.0', '@supabase/supabase-js': '2.0.0' }, devDependencies: { vite: '6.0.0', 'lovable-tagger': '1.0.0' } }),
  'index.html': '<div id="root"></div>',
  'src/integrations/supabase/client.ts': 'const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co"; export const k = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;',
  '.env': 'VITE_SUPABASE_URL="https://abcdefghijklmnopqrst.supabase.co"\nVITE_SUPABASE_PUBLISHABLE_KEY="public-demo-key"\nOPENAI_API_KEY="sk-private-demo"\n',
};
test('a repo from a builder: Lovable, Bolt and v0 are named, and a Supabase project nobody connected stays, with the new site pointing at it', async () => {
  const w = await world({ files: LOVABLE });
  try {
    const out = ok<any>(await w.org.a('move.plan', { repo: 'demo/shop' }));
    assert.equal(out.what.builder, 'Lovable');
    assert.equal(out.comes.supabase.how, 'stays');
    assert.match(out.comes.supabase.says, /abcdefghijklmnopqrst.*stays where it is and the new site points at it/);
    assert.match(out.comes.auth[0].says, /whoever owns the project/);
    assert.deepEqual(out.comes.settings.comeByThemselves.sort(), ['VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_URL'], 'public values in the repo’s .env go by themselves');
    assert.match(out.warnings.join(' '), /\.env file with OPENAI_API_KEY/);
    assert.ok(!JSON.stringify(out).includes('sk-private-demo'));
    assert.match(out.staysBehind.join(' '), /Lovable’s editor/);
  } finally { w.close(); }
  for (const [files, name] of [[{ ...SHOP, '.bolt/config.json': '{"template":"bolt-vite-react-ts"}' }, 'Bolt'], [{ 'package.json': JSON.stringify({ name: 'my-v0-project', dependencies: { next: '15.0.0' } }), 'app/page.tsx': 'export default () => null' }, 'v0']] as const) {
    const b = await world({ files });
    try { assert.equal(ok<any>(await b.org.h('move.plan', { repo: 'demo/shop' })).what.builder, name); } finally { b.close(); }
  }
});

const fakeSupabase = async (auth: Record<string, unknown>) => {
  const writes: any[] = [];
  const api = await fakeApi(({ method, path, body }) => {
    const p = path.split('?')[0]!;
    if (p === '/projects') return [{ ref: 'abcdefghijklmnopqrst', name: 'Shop data', status: 'ACTIVE_HEALTHY' }];
    if (p === '/projects/abcdefghijklmnopqrst/api-keys') return [{ name: 'anon', type: 'legacy', api_key: 'anon-demo-key' }];
    if (p === '/projects/abcdefghijklmnopqrst/config/auth') { if (method === 'PATCH') { writes.push(JSON.parse(body)); Object.assign(auth, JSON.parse(body)); } return auth; }
    return undefined;
  });
  process.env.UNIT7_SUPABASE_API = api.base;
  return Object.assign(api, { writes });
};
test('a connected Supabase project moves with supabase.*: the plan says so and shows its sign-in list', async () => {
  const w = await world({ files: LOVABLE }), sb = await fakeSupabase({ site_url: 'https://shop.lovable.example', uri_allow_list: 'https://shop.lovable.example/**' });
  account(w.app, w.org.orgId, 'supabase', 'sbp_demo_token', 'Supabase');
  try {
    const out = ok<any>(await w.org.h('move.plan', { repo: 'demo/shop' }));
    assert.equal(out.comes.supabase.how, 'moves');
    assert.match(out.comes.supabase.says, /Shop data is in your connected Supabase account, so it moves with supabase/);
    assert.deepEqual(out.comes.auth[0].allowed, ['https://shop.lovable.example', 'https://shop.lovable.example/**']);
    assert.equal(sb.writes.length, 0);
  } finally { sb.close(); w.close(); }
});

const GIVEN = { PUBLIC_NAME: 'demo', API_KEY: 'given-by-a-person', STRIPE_SECRET_KEY: RAW, STRIPE_WEBHOOK_SECRET: RAW };
const failed = (r: ToolResult) => (r.status === 'error' ? r.error : assert.fail(JSON.stringify(r)));
const moveRow = (w: { app: any; org: any }, moveId: string) => { const r = get<{ undo: string; status: string; verb: string; summary: string }>(w.app.db, 'SELECT undo, status, verb, summary FROM changes WHERE id = ? AND org_id = ?', moveId, w.org.orgId)!; return { ...r, m: JSON.parse(r.undo) }; };

test('move.run only creates: a copy from the repo with the settings a person gave, compared page by page, and the old site and DNS stay as they were', async () => {
  const w = await world();
  try {
    const res = await w.org.a('move.run', { assetId: w.assetId, to: 'render', env: GIVEN });
    const out = ok<any>(res);
    assert.equal(out.ready, true);
    assert.equal(out.url, w.newSite.base);
    assert.deepEqual(out.pages.map((p: any) => [p.path, p.old, p.new, p.same]), [['/', 200, 200, true], ['/about', 200, 200, true]], 'the home page, and a path from the code');
    assert.equal(w.st.made[0].repo, 'https://github.com/demo/shop');
    assert.deepEqual(w.st.made[0].envVars.find((e: any) => e.key === 'STRIPE_SECRET_KEY').value, RAW);
    assert.deepEqual(out.settings.notOnTheHost, []);
    assert.ok(!JSON.stringify(res).includes(RAW), 'a value never comes back');
    assert.deepEqual(w.st.oldHostWrites, [], 'the old host was only read');
    assert.equal(w.dns.calls.filter((c) => c.method !== 'GET').length, 0, 'DNS wasn’t touched');
    assert.deepEqual(w.st.domains, [], 'no domain went on the new site');
    const row = moveRow(w, out.moveId);
    assert.equal(row.verb, 'move');
    assert.equal(row.status, 'kept');
    assert.equal(row.m.stage, 'built');
    assert.ok(!row.undo.includes(RAW), 'the state keeps names, never values');
    assert.ok(!JSON.stringify(all(w.app.db, 'SELECT input, output FROM audit WHERE org_id = ?', w.org.orgId)).includes(RAW), 'and so does the audit');
    assert.match(failed(await w.org.h('change.undo', { changeId: out.moveId })).message, /nothing to undo/);
  } finally { w.close(); }
});

test('settings whose values can’t be read stop it before anything is made, and skipMissing goes on without them', async () => {
  const w = await world();
  try {
    const e = failed(await w.org.a('move.run', { assetId: w.assetId, to: 'render' }));
    assert.equal(e.code, 'settings_missing');
    assert.match(e.message, /before anything was made/);
    assert.match(e.message, /can’t read STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, so a person gives them/);
    assert.match(e.message, /can read PUBLIC_NAME, API_KEY: copySettings/);
    assert.equal(w.st.made.length, 0);
    assert.equal(all(w.app.db, `SELECT id FROM changes WHERE org_id = ?`, w.org.orgId).length, 0, 'no move was started');
    const out = ok<any>(await w.org.a('move.run', { assetId: w.assetId, to: 'render', skipMissing: true }));
    assert.deepEqual(out.settings.missing, ['PUBLIC_NAME', 'API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
    const again = ok<any>(await w.org.a('move.run', { moveId: out.moveId, env: { STRIPE_SECRET_KEY: RAW, STRIPE_WEBHOOK_SECRET: RAW }, skipMissing: true }));
    assert.equal(again.moveId, out.moveId);
    assert.equal(w.st.rebuilt, 1, 'a value given later builds the copy again');
    assert.equal(w.st.made[0].envVars.find((v: any) => v.key === 'STRIPE_SECRET_KEY').value, RAW);
  } finally { w.close(); }
});

test('copying what Unit7 can read waits for a person when an AI asks, the value is sealed while it waits, and the yes carries it across', async () => {
  const w = await world();
  try {
    const asked = await w.org.a('move.run', { assetId: w.assetId, to: 'render', copySettings: true, env: { STRIPE_SECRET_KEY: RAW, STRIPE_WEBHOOK_SECRET: RAW } }) as any;
    assert.equal(asked.status, 'approval_required');
    assert.match(asked.why, /Whoever runs code on the new host/);
    assert.equal(w.st.made.length, 0);
    const list = ok<any[]>(await w.org.a('approval.list'));
    assert.equal(list[0].input.env, 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET', 'an approver sees names');
    assert.ok(!JSON.stringify(list).includes(RAW));
    assert.ok(!JSON.stringify(all(w.app.db, 'SELECT input FROM approvals WHERE org_id = ?', w.org.orgId)).includes(RAW), 'and it isn’t on disk in the clear');
    const out = await decideApproval(w.app, w.org.orgId, w.org.human, asked.approvalId, true) as any;
    assert.equal(out.status, 'ok', JSON.stringify(out));
    const sent = Object.fromEntries(w.st.made[0].envVars.map((e: any) => [e.key, e.value]));
    assert.deepEqual([sent.API_KEY, sent.STRIPE_SECRET_KEY, sent.PUBLIC_NAME], [SECRET, RAW, 'demo']);
    assert.ok(!('PREVIEW_ONLY' in sent), 'production’s settings only');
    assert.ok(!('VERCEL_URL' in sent), 'and never what a host sets by itself');
    assert.ok(!JSON.stringify(out).includes(SECRET));
    const stepRow = get<{ actor_kind: string; actor_name: string }>(w.app.db, `SELECT actor_kind, actor_name FROM audit WHERE org_id = ? AND tool = 'live.put' AND result = 'success'`, w.org.orgId)!;
    assert.equal(stepRow.actor_kind, 'user', 'a yes to the whole covers its steps: they don’t wait again');
    assert.match(stepRow.actor_name, /Unit7 agent \(approved by Ada\)/, 'and the audit says who said yes');
    // a stored key is the same call for an AI
    const stored = { assetId: w.assetId, to: 'render', name: 'shop-two', skipMissing: true, env: { STRIPE_SECRET_KEY: 'credential://demo/acct/stripe' } };
    assert.equal((await w.org.a('move.run', stored)).status, 'approval_required');
  } finally { w.close(); }
});

test('a new site that doesn’t answer isn’t ready, says so, and the old site is left alone; once it answers, a check is all it takes', async () => {
  const flags = { dead: true }, w = await world(flags);
  try {
    const out = ok<any>(await w.org.a('move.run', { assetId: w.assetId, to: 'render', env: GIVEN }));
    assert.equal(out.ready, false);
    assert.equal(out.answered, false);
    assert.match(out.why, /answers 503/);
    assert.match(out.next, /It isn’t ready/);
    assert.deepEqual(w.st.oldHostWrites, []);
    assert.equal(moveRow(w, out.moveId).m.check.answered, false);
    flags.dead = false;
    const again = ok<any>(await w.org.a('move.run', { moveId: out.moveId }));
    assert.equal(again.ready, true);
    assert.equal(w.st.made.length, 1, 'a check builds nothing');
    assert.equal(w.st.rebuilt, 0);
  } finally { w.close(); }
});

test('a page that only fails on the new host is named, and so is one that says something else', async () => {
  const w = await world({ site: { '/about': [404, 'nothing here'] } });
  try {
    const out = ok<any>(await w.org.a('move.run', { assetId: w.assetId, to: 'render', env: GIVEN }));
    assert.equal(out.ready, false);
    assert.equal(out.answered, true);
    assert.equal(out.pages.find((p: any) => p.path === '/about').why, '/about answers 200 on the old site and 404 on the new one.');
    assert.match(out.next, /index\.html/);
  } finally { w.close(); }
  assert.equal(differs('/', { status: 200, text: HOME }, { status: 200, text: HOME.replace('style.css', 'style.abc123.css') }), undefined);
  assert.match(differs('/', { status: 200, text: HOME }, { status: 200, text: HOME.replace('<title>Shop', '<title>Parked') })!, /another title/);
  assert.match(differs('/', { status: 200, text: '<p>one two three four five six</p>' }, { status: 200, text: '<p>seven eight nine ten eleven twelve</p>' })!, /says something else/);
  assert.equal(differs('/x', { status: 404, text: 'a' }, { status: 404, text: 'b' }), undefined, 'gone on both is the same');
  assert.deepEqual(linksOf(HOME, 'http://shop.example/'), ['/about'], 'pages, not files');
  assert.deepEqual(linksOf('<a href="https://other.example/x">x</a><a href="https://shop.example/y">y</a>', 'https://shop.example/'), ['/y'], 'this site’s own');
});

test('a failed build can be tried again over what it made, and a name that was already there is never built over', async () => {
  const w = await world({ build: ['build_failed'] });
  try {
    const e = failed(await w.org.a('move.run', { assetId: w.assetId, to: 'render', env: GIVEN }));
    assert.equal(e.code, 'build_failed');
    assert.match(e.message, /Nothing changed on the old site/);
    assert.match((e as { logTail?: string }).logTail!, /missing script/, 'the build’s log comes along');
    const moveId = /moveId (chg_[\w-]+)/.exec(e.message)![1]!;
    assert.equal(moveRow(w, moveId).m.made, true);
    const out = ok<any>(await w.org.h('move.run', { moveId, rebuild: true, env: GIVEN }));
    assert.equal(out.ready, true);
    assert.equal(w.st.made.length, 1, 'the same service, built again');
    assert.equal(w.st.rebuilt, 1);
  } finally { w.close(); }
  const t = await world({ taken: true });
  try {
    const e = failed(await t.org.a('move.run', { assetId: t.assetId, to: 'render', env: GIVEN }));
    assert.match(e.message, /already exists on Render/);
    const moveId = /moveId (chg_[\w-]+)/.exec(e.message)![1]!;
    assert.equal(moveRow(t, moveId).m.made, false);
    assert.match(failed(await t.org.h('move.run', { moveId, rebuild: true, env: GIVEN })).message, /already exists on Render/, 'trying again doesn’t become an update');
    assert.equal(t.st.rebuilt, 0);
  } finally { t.close(); }
});

test('a new host refusing its key doesn’t get the old host’s account marked as failing', async () => {
  const w = await world({ refuse: true });
  try {
    const e = failed(await w.org.h('move.run', { assetId: w.assetId, to: 'render', env: GIVEN }));
    assert.match(e.message, /unauthorized/);
    const status = (acc: string) => get<{ status: string }>(w.app.db, 'SELECT status FROM accounts WHERE id = ?', acc)!.status;
    assert.equal(status(w.acc), 'verified', 'Vercel did nothing wrong');
    assert.equal(status(w.renderAcc), 'failing', 'the account that refused is the one marked');
  } finally { w.close(); }
});

test('a step inside the build that waits for a person is picked up by the next run, on what it had started', async () => {
  const w = await world(), render = hostOf('render')!, real = render.put;
  render.put = async () => { throw new Unit7Error('approval_required', 'coolify.envs is waiting on the Approvals page. Run this again once it’s approved.', 409); };
  try {
    const out = ok<any>(await w.org.h('move.run', { assetId: w.assetId, to: 'render', env: GIVEN }));
    assert.equal(out.waiting, true);
    assert.match(out.next, /goes on from there/);
    assert.equal(moveRow(w, out.moveId).m.made, true);
    render.put = real;
    const done = ok<any>(await w.org.h('move.run', { moveId: out.moveId, env: GIVEN }));
    assert.equal(done.ready, true);
  } finally { render.put = real; w.close(); }
});

test('a host that can cost money: an AI can’t start it, and a person’s build waits on Approvals once, then the move goes on from there', async () => {
  const w = await world(), render = hostOf('render')!;
  render.costs = 'Render can cost money in this test.';
  try {
    const denied = await w.org.a('move.run', { assetId: w.assetId, to: 'render', env: GIVEN }) as any;
    assert.equal(denied.status, 'denied');
    assert.match(denied.why, /can cost money/);
    const out = ok<any>(await w.org.h('move.run', { assetId: w.assetId, to: 'render', env: GIVEN }));
    assert.equal(out.waiting, true);
    assert.equal(w.st.made.length, 0);
    const [a] = ok<any[]>(await w.org.h('approval.list'));
    assert.equal(a.tool, 'live.put');
    assert.ok(!JSON.stringify(a).includes(RAW), 'a list of settings is sealed while it waits');
    assert.ok(!JSON.stringify(all(w.app.db, 'SELECT input FROM approvals WHERE org_id = ?', w.org.orgId)).includes(RAW));
    assert.equal(ok<any>(await w.org.h('move.run', { moveId: out.moveId })).waiting, true, 'still waiting');
    assert.equal((await decideApproval(w.app, w.org.orgId, w.org.human, a.id, true)).status, 'ok');
    assert.equal(w.st.made[0].envVars.find((e: any) => e.key === 'STRIPE_SECRET_KEY').value, RAW, 'a sealed list opens whole');
    const done = ok<any>(await w.org.h('move.run', { moveId: out.moveId }));
    assert.equal(done.ready, true);
    assert.equal(done.url, w.newSite.base);
  } finally { delete render.costs; w.close(); }
});

test('a builder’s repo: public values from its .env go by themselves, a connected Supabase project is wired in, and an old address can be given', async () => {
  const w = await world({ files: LOVABLE });
  try {
    const out = ok<any>(await w.org.a('move.run', { repo: 'demo/shop', to: 'render', oldUrl: w.oldSite.base }));
    const sent = Object.fromEntries(w.st.made[0].envVars.map((e: any) => [e.key, e.value]));
    assert.equal(sent.VITE_SUPABASE_URL, 'https://abcdefghijklmnopqrst.supabase.co', 'the new site points at the same project');
    assert.equal(sent.VITE_SUPABASE_PUBLISHABLE_KEY, 'public-demo-key');
    assert.ok(!('OPENAI_API_KEY' in sent), 'a private value in that file never travels by itself');
    assert.equal(out.compared, true);
    assert.equal(moveRow(w, out.moveId).m.supabase, undefined);
  } finally { w.close(); }
  const c = await world({ files: LOVABLE }), sb = await fakeSupabase({ site_url: 'https://shop.lovable.example', uri_allow_list: '' });
  account(c.app, c.org.orgId, 'supabase', 'sbp_demo_token', 'Supabase');
  try {
    const out = ok<any>(await c.org.a('move.run', { repo: 'demo/shop', to: 'render', oldUrl: c.oldSite.base }));
    const sent = Object.fromEntries(c.st.made[0].envVars.map((e: any) => [e.key, e.value]));
    assert.equal(sent.VITE_SUPABASE_PUBLISHABLE_KEY, 'anon-demo-key', 'a connected project’s own key wins');
    assert.equal(moveRow(c, out.moveId).m.supabase.ref, 'abcdefghijklmnopqrst');
    assert.equal(sb.writes.length, 0, 'move.run changes nothing at Supabase');
  } finally { sb.close(); c.close(); }
});

const built = async (w: Awaited<ReturnType<typeof world>>, o: Record<string, unknown> = {}) => ok<any>(await w.org.h('move.run', { assetId: w.assetId, to: 'render', env: GIVEN, ...o }));
const approve = async (w: Awaited<ReturnType<typeof world>>, r: ToolResult) => {
  assert.equal(r.status, 'approval_required', JSON.stringify(r));
  return decideApproval(w.app, w.org.orgId, w.org.human, (r as { approvalId: string }).approvalId, true) as Promise<ToolResult>;
};
const writes = (w: Awaited<ReturnType<typeof world>>) => w.dns.calls.filter((c) => c.method !== 'GET').length;
const at = (w: Awaited<ReturnType<typeof world>>, name: string) => w.rows.filter((r) => r.name === name).map((r) => `${r.type} ${r.data} ${r.ttl}`).sort();

test('an AI calling move.switch only asks: nothing moves, and a person’s own click waits on Approvals too', async () => {
  const w = await world();
  try {
    const { moveId } = await built(w);
    const before = writes(w);
    const ai = await w.org.a('move.switch', { moveId }) as any;
    assert.equal(ai.status, 'approval_required');
    assert.match(ai.why, /restricted/);
    assert.match(ai.why, /Points shop\.example, www\.shop\.example at /);
    const human = await w.org.h('move.switch', { moveId }) as any;
    assert.equal(human.status, 'approval_required', 'approval always, whoever asks');
    assert.equal(writes(w), before, 'no DNS changed');
    assert.deepEqual(w.st.domains, []);
    await assert.rejects(decideApproval(w.app, w.org.orgId, { ...w.org.human, kind: 'token' }, ai.approvalId, true), /Only a person can approve/);
    run(w.app.db, 'UPDATE orgs SET rules = ? WHERE id = ?', JSON.stringify({ site_switch: 'allowed' }), w.org.orgId);
    const ruled = failed(await w.org.h('move.switch', { moveId }));
    assert.equal(ruled.code, 'approval_needed', 'a rule can’t turn the approval off');
    assert.equal(writes(w), before);
    assert.equal(moveRow(w, moveId).m.stage, 'built');
  } finally { w.close(); }
});

test('the switch lowers the TTL first, waits it out, then moves the domain, keeps email and the old site, and one undo puts it all back', async () => {
  const rows = [{ type: 'A', name: '@', data: '192.0.2.10', ttl: 3600 }, { type: 'AAAA', name: '@', data: '2001:db8::10', ttl: 3600 }, { type: 'CNAME', name: 'www', data: 'cname.old-host.example', ttl: 3600 }, { type: 'MX', name: '@', data: 'mx1.example.net', ttl: 3600, priority: 10 }];
  const w = await world({ rows });
  try {
    const { moveId } = await built(w);
    const first = await approve(w, await w.org.a('move.switch', { moveId })) as any;
    assert.equal(first.status, 'ok', JSON.stringify(first));
    assert.equal(first.output.waiting, true);
    assert.deepEqual(first.output.switched, []);
    assert.match(first.output.next, /Nothing points anywhere new yet.*now: true/);
    assert.deepEqual(at(w, '@').filter((r) => r.startsWith('A ')), ['A 192.0.2.10 600'], 'the same address, a lower TTL');
    assert.deepEqual(at(w, 'www'), ['CNAME cname.old-host.example 600']);
    assert.deepEqual(w.st.domains, [], 'nothing pointed yet');

    const early = await w.org.a('move.switch', { moveId }) as any;
    assert.equal(early.status, 'error');
    assert.equal(early.error.code, 'too_soon', 'nothing to approve until the old answer runs out');

    const done = await approve(w, await w.org.a('move.switch', { moveId, now: true })) as any;
    assert.equal(done.status, 'ok', JSON.stringify(done));
    assert.deepEqual(done.output.switched, ['shop.example', 'www.shop.example']);
    assert.deepEqual(w.st.domains, ['shop.example', 'www.shop.example']);
    assert.deepEqual(at(w, '@').filter((r) => !r.startsWith('MX')), ['A 216.24.57.1 600'], 'the new address, and the old AAAA would have kept some visitors behind');
    assert.ok(at(w, 'www')[0]!.startsWith('CNAME 127.0.0.1'), 'www follows');
    assert.deepEqual(at(w, '@').filter((r) => r.startsWith('MX')), ['MX mx1.example.net 3600'], 'email stays');
    assert.deepEqual(w.st.oldHostWrites, [], 'the old site wasn’t touched');
    assert.match(done.output.goBack[0], /change\.undo with changeId chg_.*old DNS back/);
    assert.equal(moveRow(w, moveId).m.stage, 'switched');
    assert.equal(all(w.app.db, `SELECT id FROM changes WHERE org_id = ? AND status = 'done' AND verb = 'dns.remove'`, w.org.orgId).length, 0, 'one undo for the whole switch, not one per step');

    const later = await w.org.a('move.switch', { moveId }) as any;
    assert.equal(later.error.code, 'already_switched');

    const back = ok<any>(await w.org.h('change.undo', { changeId: done.output.changeId }));
    assert.deepEqual(back.restored, ['shop.example', 'www.shop.example']);
    assert.deepEqual(at(w, '@').filter((r) => !r.startsWith('MX')).sort(), ['A 192.0.2.10 600', 'AAAA 2001:db8::10 600'].sort());
    assert.deepEqual(at(w, 'www'), ['CNAME cname.old-host.example 600']);
    assert.equal(all(w.app.db, 'SELECT hostname FROM domains WHERE org_id = ?', w.org.orgId).length, 0);
    assert.equal(moveRow(w, moveId).m.stage, 'built', 'the move can go again');
  } finally { w.close(); }
});

test('a record of the wrong kind goes first and comes back if the new one fails, because a CNAME stands alone', async () => {
  const rows = [{ type: 'A', name: 'www', data: '192.0.2.10', ttl: 600 }, { type: 'A', name: '@', data: '192.0.2.10', ttl: 600 }];
  const w = await world({ rows });
  try {
    const { moveId } = await built(w);
    const done = await approve(w, await w.org.h('move.switch', { moveId, hostnames: [`www.${ZONE}`] })) as any;
    assert.equal(done.status, 'ok', JSON.stringify(done));
    assert.deepEqual(at(w, 'www').map((r) => r.split(' ')[0]), ['CNAME'], 'an A became a CNAME');
    ok(await w.org.h('change.undo', { changeId: done.output.changeId }));
    assert.deepEqual(at(w, 'www'), ['A 192.0.2.10 600']);
  } finally { w.close(); }
  const f = await world({ rows: [{ type: 'A', name: 'www', data: '192.0.2.10', ttl: 600 }] });
  try {
    const { moveId } = await built(f);
    run(f.app.db, 'DELETE FROM accounts WHERE id = ?', f.renderAcc);
    const r = await approve(f, await f.org.h('move.switch', { moveId, hostnames: [`www.${ZONE}`] })) as any;
    assert.equal(r.status, 'error');
    assert.match(r.error.message, /The old DNS stays as it was/);
    assert.deepEqual(at(f, 'www'), ['A 192.0.2.10 600'], 'the old record is back');
    assert.equal(moveRow(f, moveId).m.stage, 'built');
  } finally { f.close(); }
});

test('a new site that stopped answering stops the switch before DNS, and different pages need a person to say anyway', async () => {
  const flags: { dead: boolean; site?: Record<string, [number, string]> } = { dead: false }, w = await world(flags);
  try {
    const { moveId } = await built(w);
    const before = writes(w);
    flags.dead = true;
    const r = await approve(w, await w.org.h('move.switch', { moveId, now: true })) as any;
    assert.equal(r.error.code, 'not_ready');
    assert.match(r.error.message, /Stopped before DNS changed.*answers 503/);
    flags.dead = false; flags.site = { '/about': [404, 'gone'] };
    const d = await approve(w, await w.org.h('move.switch', { moveId, now: true })) as any;
    assert.equal(d.error.code, 'pages_differ');
    assert.equal(writes(w), before);
    assert.deepEqual(w.st.domains, []);
    const go = await approve(w, await w.org.h('move.switch', { moveId, now: true, anyway: true })) as any;
    assert.equal(go.status, 'ok', JSON.stringify(go));
    assert.equal(go.output.switched.length, 2);
  } finally { w.close(); }
});

test('DNS Unit7 can’t edit gets the exact records for a person, and says what it said before, as the way back', async () => {
  const w = await world();
  try {
    const { moveId } = await built(w);
    run(w.app.db, 'DELETE FROM accounts WHERE id = ?', w.dnsAcc);
    dnsDeps.answers = async (_n, t) => (t === 'A' ? ['192.0.2.10'] : []);
    const r = await approve(w, await w.org.h('move.switch', { moveId, now: true, hostnames: [ZONE] })) as any;
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.deepEqual(r.output.switched, []);
    assert.equal(r.output.addThese[0].hostname, ZONE);
    assert.equal(r.output.addThese[0].addThese[0].value, '216.24.57.1');
    assert.match(r.output.goBack[0], /set shop\.example to what it said before: 192\.0\.2\.10/);
    assert.equal(r.output.changeId, undefined, 'Unit7 changed nothing it could undo');
  } finally { w.close(); }
});

test('a host Unit7 can’t point a domain at says what to do, with nothing to approve, and a site with no known domain asks which', async () => {
  const w = await world();
  try {
    const { moveId } = await built(w), row = moveRow(w, moveId);
    run(w.app.db, 'UPDATE changes SET undo = ? WHERE id = ?', JSON.stringify({ ...row.m, to: { ...row.m.to, point: 'Add your domain in the Firebase console.' } }), moveId);
    const r = await w.org.a('move.switch', { moveId }) as any;
    assert.equal(r.status, 'error');
    assert.equal(r.error.message, 'Add your domain in the Firebase console.');
    run(w.app.db, 'UPDATE changes SET undo = ? WHERE id = ?', JSON.stringify({ ...row.m, domains: [] }), moveId);
    assert.equal((await w.org.a('move.switch', { moveId }) as any).error.code, 'which_domain');
  } finally { w.close(); }
});

test('a dry run shows what would change, and changes nothing', async () => {
  const w = await world();
  try {
    const { moveId } = await built(w), before = writes(w);
    const r = await w.org.a('move.switch', { moveId }, { dryRun: true }) as any;
    assert.equal(r.status, 'dry_run');
    assert.deepEqual(r.plan.names[0].now, [`A ${ZONE} → 192.0.2.10`]);
    assert.equal(r.plan.names[0].ttl, 3600);
    assert.equal(writes(w), before);
  } finally { w.close(); }
});

test('a connected Supabase project’s sign-in list gets the new domain at the switch, with its own undo, and a sign-in failure never stops it', async () => {
  const w = await world({ files: LOVABLE }), sb = await fakeSupabase({ site_url: 'https://old-shop.example', uri_allow_list: 'https://old-shop.example/**' });
  account(w.app, w.org.orgId, 'supabase', 'sbp_demo_token', 'Supabase');
  try {
    const { moveId } = ok<any>(await w.org.a('move.run', { repo: 'demo/shop', to: 'render', oldUrl: w.oldSite.base }));
    const out = await approve(w, await w.org.a('move.switch', { moveId, now: true, hostnames: [ZONE] })) as any;
    assert.equal(out.status, 'ok', JSON.stringify(out));
    assert.equal(sb.writes.length, 1);
    assert.equal(sb.writes[0].uri_allow_list, `https://old-shop.example/**,https://${ZONE}/**`, 'added next to what was there');
    assert.equal(sb.writes[0].site_url, undefined, 'the site address is only moved off the old site’s own address');
    assert.match(out.output.signIn, /Supabase sign-in now allows shop\.example\. change\.undo with changeId chg_/);
  } finally { sb.close(); w.close(); }
  const d = await world({ files: LOVABLE }), sb2 = await fakeSupabase({ site_url: 'https://old-shop.example', uri_allow_list: '' });
  account(d.app, d.org.orgId, 'supabase', 'sbp_demo_token', 'Supabase');
  try {
    const { moveId } = ok<any>(await d.org.a('move.run', { repo: 'demo/shop', to: 'render', oldUrl: d.oldSite.base }));
    sb2.close(); // the switch goes on without Supabase
    const out = await approve(d, await d.org.a('move.switch', { moveId, now: true, hostnames: [ZONE] })) as any;
    assert.equal(out.status, 'ok', JSON.stringify(out));
    assert.deepEqual(out.output.switched, [ZONE]);
    assert.match(out.output.signIn, /DNS moved, but Unit7 couldn’t add shop\.example/);
  } finally { d.close(); }
});

test('move.finish only suggests: it waits for the switch and a few good days, and it never removes anything', async () => {
  const w = await world();
  try {
    const { moveId } = await built(w);
    const early = ok<any>(await w.org.a('move.finish', { moveId }));
    assert.equal(early.ready, false);
    assert.match(early.says, /still the live one/);
    const r = await approve(w, await w.org.h('move.switch', { moveId, now: true, hostnames: [ZONE] })) as any;
    assert.equal(r.status, 'ok', JSON.stringify(r));
    const pending = ok<any>(await w.org.a('move.finish', { moveId }));
    assert.equal(pending.ready, false);
    assert.match(pending.says, /Not every domain reaches/);
    domainDns.look = () => ({ soa: async () => ({}), ns: async () => [], a: async () => ['216.24.57.1'], cname: async () => [] });
    const soon = ok<any>(await w.org.a('move.finish', { moveId }));
    assert.equal(soon.ready, false);
    assert.match(soon.says, /give it 3 days/);
    const row = moveRow(w, moveId);
    run(w.app.db, 'UPDATE changes SET undo = ? WHERE id = ?', JSON.stringify({ ...row.m, switchedAt: new Date(Date.now() - 4 * 86400_000).toISOString() }), moveId);
    const later = ok<any>(await w.org.a('move.finish', { moveId }));
    assert.equal(later.ready, true);
    assert.match(later.suggests[0], /Remove shop on Vercel\. A person does that/);
    assert.match(later.keep, /never removes/);
    assert.deepEqual(w.st.oldHostWrites, [], 'nothing was asked of the old host');
    assert.ok(get(w.app.db, 'SELECT 1 FROM assets WHERE id = ?', w.assetId), 'and it’s still on the map');
  } finally { w.close(); }
});
