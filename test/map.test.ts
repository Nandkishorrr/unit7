// The map's logic: what points at what, and what's wrong — from scanner output alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envRefs, mergeFound, resolve, UNCLAIMED, type Found, type Ref } from '../src/discovery/model.ts';

const SB = 'abcdefghijklmnopqrst';
test('settings: hosts in URLs and connection strings, Supabase pooler users, *_HOST; never localhost', () => {
  const r = envRefs('vercel:site', {
    DATABASE_URL: `postgresql://postgres.${SB}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`,
    CRM_URL: 'https://crm.shop.com/api', REDIS_HOST: '203.0.113.9', LOCAL: 'http://localhost:3000', PLAIN: 'hello',
  });
  assert.deepEqual(r.map((x) => `${x.via}:${x.host ?? x.ip ?? 'sb:' + x.supabase}`).sort(),
    ['CRM_URL:crm.shop.com', 'DATABASE_URL:aws-0-eu-west-1.pooler.supabase.com', `DATABASE_URL:sb:${SB}`, 'REDIS_HOST:203.0.113.9']);
});

test('a CRM on a VPS, a site on Vercel, Supabase, Cloudflare DNS: wired up, and the problems found', () => {
  const found: Found[] = [
    { provider: 'hostinger', kind: 'server', extId: 'vm-1', name: 'srv1', ips: ['203.0.113.9'], platform: 'vps' },
    { provider: 'hostinger', kind: 'app', extId: 'vm-1/crm', name: 'crm', hosts: ['crm.shop.com'], platform: 'vps' },
    { provider: 'vercel', kind: 'app', extId: 'prj', name: 'site', hosts: ['site.vercel.app', 'www.shop.com', 'shop.com'], platform: 'vercel' },
    { provider: 'supabase', kind: 'database', extId: SB, name: 'shop-db', hosts: [`${SB}.supabase.co`], status: 'INACTIVE (paused)' },
  ];
  const zone = (name: string, via: string, r: Partial<Ref>): [Found, Ref] => [{ provider: 'domain', kind: 'domain', extId: name, name, dns: 'cloudflare' }, { from: `domain:${name}`, kind: 'dns', via, ...r }];
  const dns = [
    zone('www.shop.com', 'CNAME abc.vercel-dns-017.com', { host: 'abc.vercel-dns-017.com' }),
    zone('shop.com', 'A 192.0.2.50', { ip: '192.0.2.50' }),                 // added on Vercel, but DNS points elsewhere
    zone('crm.shop.com', 'A 203.0.113.9', { ip: '203.0.113.9' }),
    zone('blog.shop.com', 'CNAME oldblog.netlify.app', { host: 'oldblog.netlify.app' }), // no such site in any account
  ];
  const refs: Ref[] = [
    ...dns.map((d) => d[1]),
    { from: 'hostinger:vm-1/crm', kind: 'runs_on', via: 'Docker', to: 'hostinger:vm-1' },
    { from: 'hostinger:vm-1/crm', kind: 'domain', via: 'routed on the VPS', host: 'crm.shop.com' },
    ...envRefs('hostinger:vm-1/crm', { DATABASE_URL: `postgres://postgres:pw@db.${SB}.supabase.co:5432/postgres` }),
    { from: 'vercel:prj', kind: 'domain', via: 'added on Vercel', host: 'www.shop.com' },
    { from: 'vercel:prj', kind: 'domain', via: 'added on Vercel', host: 'shop.com' },
    ...envRefs('vercel:prj', { CRM_URL: 'https://crm.shop.com', NEXT_PUBLIC_SUPABASE_URL: `https://${SB}.supabase.co`, OTHER_DB: 'postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:pw@aws-0.pooler.supabase.com:5432/postgres' }),
  ];
  const { edges, issues, dangling } = resolve(mergeFound([...found, ...dns.map((d) => d[0])]), refs);
  const has = (from: string, to: string, kind: string, status = 'ok') => edges.some((e) => e.from === from && e.to === to && e.kind === kind && e.status === status);

  assert.ok(has('domain:www.shop.com', 'vercel:prj', 'domain'), 'www → site, and DNS agrees');
  assert.ok(has('domain:shop.com', 'vercel:prj', 'domain', 'misconfigured'));
  assert.ok(has('domain:crm.shop.com', 'hostinger:vm-1/crm', 'domain'), 'crm.shop.com → the CRM (its address is the VPS it runs on)');
  assert.ok(has('vercel:prj', 'hostinger:vm-1/crm', 'env'), 'the site calls the CRM (CRM_URL)');
  assert.ok(has('vercel:prj', `supabase:${SB}`, 'env') && has('hostinger:vm-1/crm', `supabase:${SB}`, 'env'), 'both use the Supabase project');
  assert.ok(has('hostinger:vm-1/crm', 'hostinger:vm-1', 'runs_on'));
  assert.ok(!edges.some((e) => e.from === 'domain:crm.shop.com' && e.to === 'hostinger:vm-1'), 'the domain belongs to the app, not listed again under its server');
  assert.deepEqual(dangling, [{ domain: 'blog.shop.com', target: 'oldblog.netlify.app', platform: 'netlify' }], 'a CNAME to a site no account has: checked for takeover');

  const text = issues.map((i) => i.text).join('\n');
  assert.match(text, /shop\.com is added to site but its DNS points elsewhere \(A 192\.0\.2\.50\)/);
  assert.match(text, /uses shop-db, which is inactive \(paused\)/);
  assert.match(text, /Supabase project zzzzzzzzzzzzzzzzzzzz, which isn't in any connected Supabase account/);
});

test('shared web hosting with unknown addresses: no false alarm', () => {
  const found = mergeFound([
    { provider: 'hostinger', kind: 'app', extId: 'web-a.com', name: 'a.com', hosts: ['a.com'], platform: 'hostinger-web' },
    { provider: 'domain', kind: 'domain', extId: 'a.com', name: 'a.com' },
  ]);
  const { edges, issues } = resolve(found, [{ from: 'hostinger:web-a.com', kind: 'domain', via: 'website on Hostinger', host: 'a.com' }, { from: 'domain:a.com', kind: 'dns', via: 'A 198.51.100.7', ip: '198.51.100.7' }]);
  assert.equal(edges[0]!.status, 'unknown');
  assert.equal(issues.length, 0);
});

test('takeover signatures: the page a platform shows for a name nobody has', () => {
  assert.ok(UNCLAIMED.netlify!.test('<h1>Not Found - Request ID: 01J...</h1>'));
  assert.ok(UNCLAIMED['github-pages']!.test("There isn't a GitHub Pages site here."));
  assert.ok(!UNCLAIMED.netlify!.test('<h1>Welcome to my blog</h1>'));
});

test('one machine seen twice (a Hostinger VPS that Unit7 also manages): one server, both names, refs to either land on it', () => {
  const found = mergeFound([
    { provider: 'hostinger', kind: 'server', extId: 'vm-1', name: 'srv1.hstgr.cloud', accountId: 'acc_h', ips: ['203.0.113.9'], platform: 'vps' },
    { provider: 'hostinger', kind: 'app', extId: 'vm-1/crm', name: 'crm', hosts: ['crm.shop.com'], platform: 'vps' },
    { provider: 'unit7', kind: 'server', extId: 'srv_1', name: 'srv1', ips: ['203.0.113.9'], platform: 'unit7' },
    { provider: 'digitalocean', kind: 'server', extId: 'droplet-2', name: 'other', ips: ['198.51.100.7', '10.0.0.5'] },
    { provider: 'unit7', kind: 'server', extId: 'srv_lan', name: 'lan-box', ips: ['10.0.0.5'] }, // a private address is no proof
    { provider: 'domain', kind: 'domain', extId: 'crm.shop.com', name: 'crm.shop.com', dns: 'cloudflare' },
    { provider: 'domain', kind: 'domain', extId: 'box.shop.com', name: 'box.shop.com', dns: 'cloudflare' },
  ]);
  assert.deepEqual([...found.values()].filter((f) => f.kind === 'server').map((s) => s.name).sort(), ['lan-box', 'other', 'srv1'], 'Unit7’s name wins');
  assert.deepEqual(found.get('unit7:srv_1')!.also, [{ provider: 'hostinger', extId: 'vm-1', name: 'srv1.hstgr.cloud', accountId: 'acc_h' }]);
  const { edges } = resolve(found, [
    { from: 'hostinger:vm-1/crm', kind: 'runs_on', via: 'Docker on this VPS', to: 'hostinger:vm-1' },
    { from: 'hostinger:vm-1/crm', kind: 'domain', via: 'routed on the VPS', host: 'crm.shop.com' },
    { from: 'domain:crm.shop.com', kind: 'dns', via: 'A 203.0.113.9', ip: '203.0.113.9' },
    { from: 'domain:box.shop.com', kind: 'dns', via: 'A 203.0.113.9', ip: '203.0.113.9' },
  ]);
  const has = (from: string, to: string, kind: string) => edges.some((e) => e.from === from && e.to === to && e.kind === kind && e.status === 'ok');
  assert.ok(has('hostinger:vm-1/crm', 'unit7:srv_1', 'runs_on'), 'the Docker app runs on the merged server');
  assert.ok(has('domain:crm.shop.com', 'hostinger:vm-1/crm', 'domain'), 'its domain still checks out through the server’s address');
  assert.ok(has('domain:box.shop.com', 'unit7:srv_1', 'dns'));
});

test('the map page: one server card, domains under their root, issues pinned to what they are about', async () => {
  const { derive, guessRoot } = await import('../web/src/pages/map/data.ts');
  assert.equal(guessRoot('api.example.com', new Set(['example.com'])), 'example.com');
  assert.equal(guessRoot('a.b.example.co.uk', new Set()), 'example.co.uk');
  assert.equal(guessRoot('sandbox-x.203-0-113-10.sslip.io', new Set()), 'sslip.io');
  const v = derive({ running: false, accounts: [], suggestions: [], issues: [{ severity: 'warning', key: 'email:example.com', text: '' }],
    assets: [
      { id: 'f', provider: 'unit7', kind: 'server', name: 'srv1', url: null },
      { id: 'h', provider: 'hostinger', kind: 'server', name: 'srv1.hstgr.cloud', url: null, account: 'Hostinger' }, // synced before the model merged them
      { id: 'd', provider: 'domain', kind: 'domain', name: 'example.com', url: null },
      { id: 's', provider: 'domain', kind: 'domain', name: 'api.example.com', url: null },
    ],
    edges: [{ source: 's', target: 'h', kind: 'dns', via: 'A 203.0.113.9', status: 'ok', detail: null }] });
  assert.deepEqual(v.assets.filter((a) => a.kind === 'server').map((a) => a.name), ['srv1']);
  assert.equal(v.byId.get('f')!.also![0]!.name, 'srv1.hstgr.cloud');
  assert.equal(v.out('s')[0]?.target, 'f', 'edges follow the merge');
  assert.deepEqual(v.groups.map((g) => [g.root, g.asset?.id, g.subs.map((x) => x.id)]), [['example.com', 'd', ['s']]]);
  assert.equal(v.issuesOf('d').length, 1, 'email issue pinned by its host');
});
