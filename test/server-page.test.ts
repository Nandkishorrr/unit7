// The server page's shaping: a real X-ray (the Coolify fixture) and a usage reading become storage-bar
// slices, project cards and a "full in" forecast; the map folds subdomains that reach nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInventory, parseSentinel, rollup, parseSizes } from '../src/discovery/xray.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { colorSlots, fullIn, money, projectCards, size, storageBar, whatsIn, type Usage, type Xray } from '../web/src/pages/servers/shape.ts';
import { splitSubs, type Asset } from '../web/src/pages/map/data.ts';

const GB = 1e9;
const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
const x = { serverId: 'srv_1', serverName: 'box', ...inv } as unknown as Xray;
const ctrs = inv.parts.flatMap((p) => p.containers ?? []);
const sentinel = JSON.stringify(ctrs.map((n) => ({ id: n, cpu: { percent: '1' }, memory: { used: n.startsWith('shop') ? 1 * GB : 0.1 * GB } })));
const host = { cpus: 4, cpu: 20, memTotal: 16 * GB, memUsed: 10 * GB, diskTotal: 200 * GB, diskUsed: 60 * GB };

test('memory: a slice per project by size, then the system, then free room; colors follow the project, not its rank', () => {
  const u = rollup(inv, host, parseSentinel(sentinel), 'sentinel') as unknown as Usage;
  const slots = colorSlots(x);
  const bar = storageBar(u, 'mem', slots);
  const own = bar.segs.filter((s) => s.kind === 'project');
  assert.equal(own[0]!.name, 'shop', 'the biggest first');
  assert.ok(own.every((s, i) => i === 0 || s.value <= own[i - 1]!.value));
  assert.equal(bar.segs.at(-1)!.kind, 'free');
  assert.equal(Math.round(bar.segs.reduce((n, s) => n + s.value, 0)), 16 * GB, 'the slices add up to the whole memory');
  assert.ok(bar.segs.some((s) => s.kind === 'system' && s.name === 'Coolify and system'));
  assert.deepEqual(own.map((s) => s.color), own.map((s) => slots.get(s.id)), 'the slot is the project’s, whatever its size');
});

test('disk: per project only once it was measured, with what can be cleaned up as its own slice', () => {
  const plain = storageBar(rollup(inv, host, new Map(), 'docker-stats') as unknown as Usage, 'disk', colorSlots(x));
  assert.equal(plain.perProject, false);
  assert.deepEqual(plain.segs.map((s) => s.kind), ['system', 'free']);
  const sizes = parseSizes(`\n@@unit7:df\n${JSON.stringify({ Volumes: [{ Name: 'shopsupa01_supabase-db-data', UsageData: { Size: 9 * GB } }], Images: [{ Id: 'a', Size: 4 * GB, SharedSize: 0, Containers: 0 }], BuildCache: [{ Size: 2 * GB, InUse: false }] })}\n`, inv);
  const u = rollup(inv, host, new Map(), 'docker-stats', { sizes }) as unknown as Usage;
  const bar = storageBar(u, 'disk', colorSlots(x));
  assert.equal(bar.perProject, true);
  assert.equal(bar.segs.find((s) => s.name === 'shop')!.value, 9 * GB);
  assert.equal(bar.clean, 6 * GB, 'unused images and build cache');
  assert.equal(Math.round(bar.segs.reduce((n, s) => n + s.value, 0)), 200 * GB);
});

test('"full in": only from three days or more of a growing disk', () => {
  const at = (d: number) => new Date(Date.parse('2026-10-07T00:00:00Z') - d * 86_400_000).toISOString();
  assert.equal(fullIn([{ at: at(1), diskUsed: 50 * GB }, { at: at(0), diskUsed: 60 * GB }], 200 * GB), null, 'a day says nothing');
  assert.equal(fullIn([{ at: at(30), diskUsed: 61 * GB }, { at: at(0), diskUsed: 60 * GB }], 200 * GB), null, 'shrinking');
  assert.equal(fullIn([{ at: at(30), diskUsed: 50 * GB }, { at: at(0), diskUsed: 60 * GB }], 200 * GB), 'full in about 14 months');
  assert.equal(fullIn([{ at: at(10), diskUsed: 100 * GB }, { at: at(0), diskUsed: 190 * GB }], 200 * GB), 'full in about 1 day');
  assert.equal(fullIn([{ at: at(30), diskUsed: 59 * GB }, { at: at(0), diskUsed: 60 * GB }], 200 * GB), null, 'years away');
});

test('project cards: the troubled first, what each is made of in words, and what Restart acts on', () => {
  const cards = projectCards(x);
  assert.equal(cards[0]!.name, 'crm', 'it keeps running out of memory');
  assert.equal(cards.at(-1)!.system, true, 'Coolify itself last');
  const shop = cards.find((c) => c.name === 'shop')!;
  assert.equal(shop.what, 'App + Supabase');
  assert.equal(shop.main?.name, 'shop-web');
  assert.deepEqual(shop.domains.sort(), ['api.shop.example.com', 'shop.example.com']);
  assert.ok(shop.logos.includes('supabase'));
  assert.equal(cards.find((c) => c.name === 'relay')!.what, 'App + Postgres');
  assert.equal(whatsIn([]), 'Nothing running');
  assert.equal(size(9_840_000_000), '9.8 GB');
  assert.equal(size(610_000_000), '610 MB');
  assert.equal(money(1.4, 'USD'), '$1.40');
  assert.equal(money(12, 'EUR'), '€12');
});

test('the map folds two or more subdomains that reach nothing, and keeps the ones that need a fix in view', () => {
  const d = (name: string): Asset => ({ id: name, provider: 'domain', kind: 'domain', name, url: null });
  const subs = ['app.example.com', 'old.example.com', 'test.example.com', 'bad.example.com'].map(d);
  const v = { out: (id: string) => (id === 'app.example.com' ? [{ source: id, target: 'x', kind: 'domain' as const, via: '', status: 'ok' as const, detail: null }] : []), issuesOf: (id: string) => (id === 'bad.example.com' ? [{ severity: 'warning' as const, key: 'dns:bad.example.com', text: '' }] : []) };
  const r = splitSubs(v, subs);
  assert.deepEqual(r.linked.map((s) => s.name), ['app.example.com', 'bad.example.com']);
  assert.deepEqual(r.idle.map((s) => s.name), ['old.example.com', 'test.example.com']);
  assert.equal(splitSubs(v, subs.slice(0, 2)).idle.length, 0, 'one row folded saves nothing');
});
