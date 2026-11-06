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

liveTiming.pollMs = 1; liveTiming.answerMs = 20;
process.env.UNIT7_RECHECK = 'off';
const SECRET = 'demo-secret-value-1', RAW = 'typed-by-a-person-1', ZONE = 'shop.example';
const saved = { look: { ...dnsLook }, deps: { ...dnsDeps }, dom: { ...domainDns } };
after(() => { Object.assign(dnsLook, saved.look); Object.assign(dnsDeps, saved.deps); Object.assign(domainDns, saved.dom); });

const SHOP = {
  'package.json': JSON.stringify({ name: 'shop', scripts: { build: 'vite build' }, dependencies: { react: '19.0.0', 'react-router-dom': '7.0.0', stripe: '14.0.0', '@vercel/analytics': '1.0.0' }, devDependencies: { vite: '6.0.0' } }),
  'index.html': '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  'src/main.tsx': 'const key = import.meta.env.VITE_PUBLIC_NAME; const u = process.env.VERCEL_URL; const r = "<Route path=\\"/about\\" element={x} />"',
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

interface World { site?: Partial<Record<string, [number, string]>>; dead?: boolean; plan?: string; envs?: any[]; build?: string[]; files?: Record<string, string>; repo?: boolean; rows?: any[] }
async function world(o: World = {}) {
  const app = testApp(), org = await testOrg(app), root = mkdtempSync(join(tmpdir(), 'remote-'));
  repoAt(root, 'shop', o.files ?? SHOP);
  const st = { oldHostWrites: [] as string[], made: [] as any[], domains: [] as string[], deploys: o.build ?? ['live'] };
  const rows = o.rows ?? [{ type: 'A', name: '@', data: '192.0.2.10', ttl: 3600 }, { type: 'CNAME', name: 'www', data: 'cname.old-host.example', ttl: 3600 }, { type: 'MX', name: '@', data: 'mx1.example.net', ttl: 3600, priority: 10 }];
  const oldSite = await fakeApi(({ path }) => (path === '/' ? HOME : path === '/about' ? ABOUT : [404, 'nothing here']));
  const newSite = await fakeApi(({ path }) => (o.dead ? [503, 'down'] : o.site?.[path] ?? (path === '/' ? HOME : path === '/about' ? ABOUT : [404, 'nothing here'])));
  const vercel = await fakeApi(({ method, path }) => {
    const p = path.split('?')[0]!;
    if (method !== 'GET') st.oldHostWrites.push(`${method} ${p}`);
    if (p === '/v2/user') return { user: { username: 'ada', defaultTeamId: null, billing: { plan: o.plan ?? 'hobby' } } };
    if (p === '/v2/teams') return { teams: [] };
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
    if (p === '/services' && method === 'POST') { const b = JSON.parse(body); st.made.push({ ...b, id, serviceDetails: { url: newSite.base } }); return [201, { service: { id }, deployId: 'dep-1' }]; }
    if (p === `/services/${id}`) return { id, name: 'shop', type: 'static_site', ownerId: 'own-1', serviceDetails: { url: newSite.base } };
    if (p === `/services/${id}/deploys/dep-1`) return { id: 'dep-1', status: st.deploys.length > 1 ? st.deploys.shift() : st.deploys[0] };
    if (p === `/services/${id}/deploys` && method === 'POST') { st.deploys = ['live']; return [201, { id: 'dep-1' }]; }
    if (p === `/services/${id}/custom-domains` && method === 'POST') { st.domains.push(JSON.parse(body).name); return [201, {}]; }
    if (/\/verify$/.test(p)) return {};
    return undefined;
  });
  const dns = await fakeApi(godaddy(rows) as never);
  const info = async () => ({ zone: ZONE, host: 'godaddy', nameservers: [] });
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
    assert.match(out.comes.redirects.at(-1).says, /refreshing a page gives a 404/);
    assert.equal(out.comes.webhooks[0].from, 'Stripe');
    assert.match(out.staysBehind.join(' '), /Vercel Analytics/);
    assert.match(out.staysBehind.join(' '), /VERCEL_URL/);
    assert.match(out.warnings[0], /Hobby plan is for personal, non-commercial use only.*stripe|\(.*stripe.*\)/i, 'a Hobby site that takes payments is warned about');
    assert.deepEqual(out.costsNow.lines, ['Vercel old: 20 USD so far this month']);
    const render = out.whereTo.find((p: any) => p.to === 'render');
    assert.equal(render.ok, true);
    assert.ok(!out.whereTo.some((p: any) => p.to === 'vercel' && p.accountId === w.acc), 'the account it’s already on isn’t somewhere to go');
    assert.deepEqual(w.st.oldHostWrites, [], 'it only read');
    assert.equal(w.dns.calls.filter((c) => c.method !== 'GET').length, 0);
    assert.equal(all(w.app.db, 'SELECT id FROM changes WHERE org_id = ?', w.org.orgId).length, 0);
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
