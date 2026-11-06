// The map canvas: where an unused subdomain should point, and the layout (columns, frames, bubbles, lines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive, suggestApp, isUnused, abandoned, type Asset, type MapData } from '../web/src/pages/map/data.ts';
import { layoutMap, AX, DX, S } from '../web/src/pages/map/layout.ts';

test('an unused subdomain: the app named like it, www goes where the bare domain goes, nothing when nothing fits', () => {
  const apps = [{ id: 'web', name: 'parcel-web' }, { id: 'api', name: 'parcel-api' }, { id: 'oapi', name: 'cobalt-api' }, { id: 'docs', name: 'lumen-docs' }, { id: 'bare', name: 'api' }];
  assert.equal(suggestApp('api.parcel.example', 'parcel.example', apps), 'bare', 'an app called exactly api wins');
  assert.equal(suggestApp('api.parcel.example', 'parcel.example', apps.filter((a) => a.id !== 'bare')), 'api', 'else the one in the family: parcel-api, not cobalt-api');
  assert.equal(suggestApp('www.parcel.example', 'parcel.example', apps, ['web']), 'web');
  assert.equal(suggestApp('docs.parcel.example', 'parcel.example', apps), undefined, 'lumen-docs is another family: not a good guess');
  assert.equal(suggestApp('app.lumen.example', 'lumen.example', [{ id: 'x', name: 'lumen-web' }]), 'x', 'app → the family’s web app');
  assert.equal(suggestApp('status.parcel.example', 'parcel.example', apps), undefined);
  assert.equal(suggestApp('beta.parcel.example', 'parcel.example', apps, ['web']), 'web', 'beta, preview… open the main site when no app is named for them');
});

const dom = (id: string, name: string, dns = 'cloudflare'): Asset => ({ id, provider: 'domain', kind: 'domain', name, url: null, dns, zone: name.split('.').slice(-2).join('.') });
function estate(): MapData {
  return {
    running: false, accounts: [], suggestions: [],
    issues: [{ severity: 'critical', key: 'takeover:old.shop.example', text: 'gone', about: 'old' }],
    assets: [
      dom('root', 'shop.example'), dom('api', 'api.shop.example'), dom('dev', 'dev.shop.example'), dom('old', 'old.shop.example'), dom('blog', 'blog.other.example', 'hostinger'),
      { id: 'srv', provider: 'unit7', kind: 'server', name: 'box', url: null },
      { id: 'web', provider: 'vercel', kind: 'app', name: 'shop-web', url: null, account: 'Vercel · sam' },
      { id: 'sapi', provider: 'unit7', kind: 'app', name: 'shop-api', url: null },
      { id: 'pg', provider: 'unit7', kind: 'database', name: 'shop-db', url: null },
      { id: 'neon', provider: 'neon', kind: 'database', name: 'web-db', url: null, account: 'Neon · sam' },
    ],
    edges: [
      { source: 'root', target: 'web', kind: 'domain', via: 'added on Vercel', status: 'ok', detail: null },
      { source: 'api', target: 'sapi', kind: 'domain', via: 'routed by Unit7', status: 'ok', detail: null },
      { source: 'sapi', target: 'srv', kind: 'runs_on', via: 'runs here', status: 'ok', detail: null },
      { source: 'pg', target: 'srv', kind: 'runs_on', via: 'runs here', status: 'ok', detail: null },
      { source: 'sapi', target: 'pg', kind: 'env', via: 'DATABASE_URL', status: 'ok', detail: null },
      { source: 'web', target: 'neon', kind: 'env', via: 'DATABASE_URL', status: 'ok', detail: null },
    ],
  };
}

test('unused and abandoned subdomains', () => {
  const v = derive(estate());
  assert.deepEqual(v.assets.filter((a) => a.kind === 'domain' && a.name.includes('.shop.') && isUnused(v, a)).map((a) => a.id), ['dev', 'old']);
  assert.equal(abandoned(v, v.byId.get('old')!), 'takeover');
  assert.equal(abandoned(v, v.byId.get('dev')!), undefined);
});

test('the canvas: domains → apps → data, unused subdomains in one cluster, lines between what stands for each end', () => {
  const v = derive(estate());
  const show = new Set(v.assets.map((a) => a.id));
  const L = layoutMap({ v, show, projectOf: (a) => (a.provider === 'unit7' ? { id: 'p1', name: 'shop' } : undefined) });
  const n = (id: string) => L.nodes.find((x) => x.id === id)!;
  // columns
  assert.ok(n('root').x < AX && n('web').x === AX && n('sapi').x === AX && n('pg').x === DX && n('neon').x === DX);
  // the root pill carries its linked subdomain; the unused two are one cluster under it
  assert.deepEqual(n('root').linked!.map((d) => d.id), ['api']);
  assert.deepEqual(L.nodes.find((x) => x.kind === 'cluster')!.unused!.map((d) => d.id), ['dev', 'old']);
  assert.equal(L.nodeOf.get('dev'), 'unused:shop.example');
  // a frame for the server (with the project band inside), one for each account
  assert.ok(L.frames.some((f) => f.id === 'srv' && f.kind === 'owner') && L.frames.some((f) => f.kind === 'band' && f.parent === 'srv' && f.title === 'shop'));
  assert.ok(L.frames.some((f) => f.id === 'acct:Vercel · sam') && L.frames.some((f) => f.id === 'acct:Neon · sam'));
  // the database sits level with the app that uses it
  assert.equal(n('pg').y + S.DB / 2, n('sapi').y + S.NODE / 2);
  assert.ok(Math.abs((n('neon').y + S.DB / 2) - (n('web').y + S.NODE / 2)) < 40, 'the data-only frame is placed next to its user');
  // lines: the api subdomain's line leaves from its root pill; runs_on is the frame, not a line
  const pairs = L.edges.map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(pairs, ['root>sapi', 'root>web', 'sapi>pg', 'web>neon']);
  // nothing overlaps inside a column
  const cols = [0, 1, 2].map((c) => L.nodes.filter((x) => x.col === c && x.kind !== 'server').sort((a, b) => a.y - b.y));
  for (const col of cols) for (let i = 1; i < col.length; i++) assert.ok(col[i]!.y >= col[i - 1]!.y + col[i - 1]!.h - 0.5, `${col[i]!.id} overlaps ${col[i - 1]!.id}`);
});

test('a product (map.get groups) is a band inside each account it spans', () => {
  const m = estate();
  m.assets.find((a) => a.id === 'web')!.group = 'grp_1';
  const v = derive(m);
  const L = layoutMap({ v, show: new Set(v.assets.map((a) => a.id)), product: (id) => (id === 'grp_1' ? 'shop' : undefined) });
  const band = L.frames.find((f) => f.kind === 'band' && f.parent === 'acct:Vercel · sam')!;
  assert.equal(band.title, 'shop');
  assert.deepEqual(band.members, ['web']);
});

test('a closed frame is one bubble: what is inside hands its lines to it', () => {
  const v = derive(estate());
  const show = new Set(v.assets.map((a) => a.id));
  const L = layoutMap({ v, show, open: (id) => id !== 'srv' && id !== 'dns:cloudflare' });
  assert.equal(L.rep('sapi'), 'srv');
  assert.ok(!L.nodes.some((x) => x.id === 'sapi' || x.id === 'root'), 'folded things are not drawn');
  const pairs = L.edges.map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(pairs, ['dns:cloudflare>srv', 'dns:cloudflare>web', 'web>neon']);
  const bubble = L.frames.find((f) => f.id === 'srv')!;
  assert.equal(bubble.h, S.BUBBLE);
  assert.deepEqual([bubble.counts.apps, bubble.counts.dbs], [1, 1]);
});
