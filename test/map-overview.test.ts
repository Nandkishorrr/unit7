// The Map's Overview (sections, grouping, folding) and the canvas minimap's viewport maths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive, type Asset, type MapData } from '../web/src/pages/map/data.ts';
import { appGroups, domainCards, fold, foldGroups, listOf, needFirst, providersOf, serviceGroups } from '../web/src/pages/map/sections.ts';
import { camAt, camDrag, inside, miniFit, viewRect } from '../web/src/pages/map/minimap.ts';

const dom = (id: string, name: string, dns = 'cloudflare'): Asset => ({ id, provider: 'domain', kind: 'domain', name, url: null, dns, zone: name.split('.').slice(-2).join('.') });
const app = (id: string, name: string, o: Partial<Asset> = {}): Asset => ({ id, provider: 'vercel', kind: 'app', name, url: null, account: 'Vercel · sam', ...o });
function estate(): MapData {
  return {
    running: false, suggestions: [], groups: [{ id: 'g1', name: 'Shop' }],
    accounts: [
      { id: 'a1', name: 'Vercel · sam', provider: 'vercel', ok: true, found: 3 }, { id: 'a2', name: 'Vercel · studio', provider: 'vercel', ok: true, found: 1 },
      { id: 'a3', name: 'Neon · sam', provider: 'neon', ok: false, found: 0 }, { id: 'u', name: 'Unit7', provider: 'unit7', ok: true, found: 2 },
    ],
    issues: [{ severity: 'critical', key: 'takeover:old.shop.example', text: 'gone', about: 'old' }],
    assets: [
      dom('root', 'shop.example'), dom('api', 'api.shop.example'), dom('dev', 'dev.shop.example'), dom('old', 'old.shop.example'),
      dom('park', 'parked.example'), dom('blog', 'blog.other.example', 'hostinger'), dom('oroot', 'other.example', 'hostinger'),
      app('web', 'shop-web', { group: 'g1' }), app('sapi', 'shop-api', { provider: 'unit7', account: undefined }), app('lone', 'lone-site'), app('down', 'broken-site', { site: { status: 'down', ms: null, host: 'x' } }),
      { id: 'srv', provider: 'hetzner', kind: 'server', name: 'box', url: null, projects: [{ id: 'p', name: 'tools', owner: 'coolify', trust: 'understood', parts: [] }] },
      { id: 'p', provider: 'coolify', kind: 'project', name: 'tools', url: null, owner: 'coolify', server: 'srv' },
      app('n8n', 'n8n', { provider: 'coolify', account: undefined, owner: 'coolify', server: 'srv', project: 'p' }),
      { id: 'kuma', provider: 'coolify', kind: 'service', name: 'uptime-kuma', url: null, owner: 'coolify', server: 'srv', product: { id: 'uptime-kuma', name: 'Uptime Kuma' } },
      { id: 'proxy', provider: 'coolify', kind: 'service', name: 'coolify-proxy', url: null, owner: 'coolify', server: 'srv', system: true },
      { id: 'vol', provider: 'coolify', kind: 'volume', name: 'kuma-data', url: null, owner: 'coolify', server: 'srv' },
      { id: 'cron', provider: 'coolify', kind: 'job', name: 'nightly-backup', url: null, owner: 'coolify', server: 'srv' },
      { id: 'pg', provider: 'unit7', kind: 'database', name: 'shop-db', url: null },
      { id: 'open', provider: 'coolify', kind: 'database', name: 'tools-postgres', url: null, owner: 'coolify', server: 'srv', exposed: true },
    ],
    edges: [
      { source: 'root', target: 'web', kind: 'domain', via: 'added on Vercel', status: 'ok', detail: null },
      { source: 'api', target: 'sapi', kind: 'domain', via: 'routed by Unit7', status: 'ok', detail: null },
      { source: 'blog', target: 'lone', kind: 'dns', via: 'CNAME', status: 'misconfigured', detail: null },
      { source: 'sapi', target: 'pg', kind: 'env', via: 'DATABASE_URL', status: 'ok', detail: null },
    ],
  };
}
const all = (m: MapData) => new Set(m.assets.map((a) => a.id));
const projectOf = (a: Asset) => (a.id === 'sapi' ? { id: 'prj_1', name: 'shop backend' } : undefined);
const product = (id: string) => (id === 'g1' ? 'Shop' : undefined);

test('folding: the first few unless open, never just one left over; groups fold rows and count what is hidden', () => {
  assert.deepEqual(fold([1, 2, 3, 4, 5], 3, false), { shown: [1, 2, 3], hidden: 2 });
  assert.deepEqual(fold([1, 2, 3, 4], 3, false), { shown: [1, 2, 3, 4], hidden: 0 }, 'folding one saves nothing');
  assert.deepEqual(fold([1, 2, 3, 4, 5], 3, true), { shown: [1, 2, 3, 4, 5], hidden: 0 });
  const groups = [{ id: 'a', items: [1, 2, 3, 4, 5, 6] }, { id: 'b', items: [1] }, { id: 'c', items: [1, 2] }, { id: 'd', items: [1, 2, 3] }];
  const f = foldGroups(groups, { groups: 2, rows: 4 }, false);
  assert.deepEqual(f.groups.map((g) => [g.id, g.shown.length, g.more]), [['a', 4, 2], ['b', 1, 0]]);
  assert.equal(f.hidden, 2 + 2 + 3, 'two rows of a, and all of c and d');
  assert.equal(foldGroups(groups.slice(0, 3), { groups: 2, rows: 4 }, false).groups.length, 3, 'three groups: folding one group saves nothing either');
  assert.equal(foldGroups(groups, { groups: 2, rows: 4 }, true).hidden, 0);
  assert.deepEqual(needFirst(['b', 'a', 'c'], (x) => x === 'c', (x) => x), ['c', 'a', 'b']);
});

test('accounts: a circle per provider, the ones that can’t be read first, Unit7 itself left out, search by name', () => {
  const v = derive(estate());
  const p = providersOf(v.accounts);
  assert.deepEqual(p.map((x) => [x.provider, x.accounts.length, x.bad]), [['neon', 1, 1], ['vercel', 2, 0]]);
  assert.deepEqual(providersOf(v.accounts, 'studio').map((x) => x.accounts.map((a) => a.name)), [['Vercel · studio']]);
});

test('domains: a card per root with its status, what it opens, its subdomains counted (unused, risky), problems first', () => {
  const m = estate(), v = derive(m);
  const cards = domainCards(v, all(m), '', { label: (a) => a.name });
  assert.deepEqual(cards.map((c) => [c.root, c.tone]), [['other.example', 'bad'], ['shop.example', 'bad'], ['parked.example', 'idle']], 'a misconfigured line and a takeover first; parked last');
  const shop = cards.find((c) => c.root === 'shop.example')!;
  assert.deepEqual([shop.subs.length, shop.unused.map((d) => d.id), shop.risky], [3, ['dev', 'old'], 1]);
  assert.deepEqual(shop.targets.map((t) => t.id).sort(), ['sapi', 'web']);
  assert.equal(shop.open?.id, 'root', 'the card opens the root');
  assert.deepEqual(domainCards(v, all(m), 'dev.shop').map((c) => c.root), ['shop.example'], 'a subdomain’s name finds its root');
  assert.deepEqual(domainCards(v, new Set(['api'])).map((c) => [c.root, c.open?.id, c.subs.length]), [['shop.example', 'api', 1]], 'a filter keeps only what it shows');
});

test('apps: by product, then the project they came from, then where they’re hosted; a group’s name keeps it whole', () => {
  const m = estate(), v = derive(m);
  const g = appGroups(v, all(m), '', { product, projectOf });
  assert.deepEqual(g.map((b) => [b.kind, b.name, b.items.map((a) => a.id)]), [
    ['product', 'Shop', ['web']], ['project', 'shop backend', ['sapi']], ['project', 'tools', ['n8n']], ['host', 'vercel', ['down', 'lone']],
  ]);
  assert.equal(g.find((b) => b.kind === 'host')!.need, 2, 'down, and lone’s domain points elsewhere');
  assert.equal(g[2]!.sub, 'on box');
  assert.deepEqual(appGroups(v, all(m), 'shop backend', { product, projectOf }).map((b) => b.items.length), [1]);
  assert.deepEqual(appGroups(v, all(m), 'lone', { product, projectOf }).map((b) => b.items.map((a) => a.id)), [['lone']]);
});

test('services: tools, stored data and jobs, the server’s own machinery last; databases open to the internet need a look', () => {
  const m = estate(), v = derive(m);
  assert.deepEqual(serviceGroups(v, all(m)).map((b) => [b.kind, b.items.map((a) => a.id)]), [['tools', ['kuma', 'proxy']], ['data', ['vol']], ['jobs', ['cron']]]);
  assert.deepEqual(serviceGroups(v, all(m), 'kuma').map((b) => b.items.map((a) => a.id)), [['kuma'], ['vol']], 'searching for the tool finds its data too');
  assert.deepEqual(listOf(v, all(m), 'database').map((a) => a.id), ['open', 'pg']);
  assert.deepEqual(listOf(v, all(m), 'server').map((a) => a.name), ['box']);
});

test('minimap: fits the world, draws the screen where the camera is, and a click or drag moves the camera', () => {
  const world = { x: -24, y: -48, w: 1000, h: 2000 };
  const f = miniFit(world, { w: 196, h: 124 });
  assert.equal(f.s, 124 / 2000);
  assert.deepEqual([f.w, f.h], [62, 124]);
  const vp = { w: 1200, h: 700 }, cam = { x: 100, y: -500, k: 0.5 };
  const r = viewRect(cam, vp, world, f.s);
  // the screen's top left is world (-200, 1000): left of the world's corner by 176, below it by 1048
  assert.ok(Math.abs(r.x + 176 * f.s) < 1e-9 && Math.abs(r.y - 1048 * f.s) < 1e-9);
  assert.ok(Math.abs(r.w - 2400 * f.s) < 1e-9 && Math.abs(r.h - 1400 * f.s) < 1e-9);
  // a click centres the screen there: the new rectangle's middle is the clicked point, zoom unchanged
  const to = camAt(30, 60, cam, vp, world, f.s);
  const r2 = viewRect(to, vp, world, f.s);
  assert.equal(to.k, cam.k);
  assert.ok(Math.abs(r2.x + r2.w / 2 - 30) < 1e-9 && Math.abs(r2.y + r2.h / 2 - 60) < 1e-9);
  // dragging the rectangle by (5, 10) moves it exactly that far
  const r3 = viewRect(camDrag(cam, 5, 10, f.s), vp, world, f.s);
  assert.ok(Math.abs(r3.x - r.x - 5) < 1e-9 && Math.abs(r3.y - r.y - 10) < 1e-9);
  assert.ok(inside(r, r.x + 1, r.y + 1) && !inside(r, r.x - 1, r.y));
});
