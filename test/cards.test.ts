// The Home chat's result cards: raw tool outputs shaped into what each card shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, deploySteps, domainGroups, parseTable, pickTab, usage } from '../web/src/pages/chat/cards/shape.ts';
import { derive } from '../web/src/pages/map/data.ts';

test('a deploy log becomes a few plain steps, live and finished', () => {
  const log = ['10:00:00 Cloning sam/shop (main)…', '10:00:02 Commit 1c1c051.', '10:00:04 Detected next. Port 3000.', '10:02:04 Starting web-42…', '10:02:20 Healthy (HTTP 200).', '10:02:22 Traffic now goes to deploy #42.'];
  const done = deploySteps(log, 'ok');
  assert.deepEqual(done.map((s) => s.state), ['done', 'done', 'done', 'done', 'done'], 'no database step when nothing migrated');
  assert.equal(done.find((s) => s.key === 'build')?.secs, 120);
  const live = deploySteps(log.slice(0, 3), 'running');
  assert.deepEqual(live.map((s) => s.state), ['done', 'active', 'todo', 'todo', 'todo']);
  assert.equal(live[1]!.detail, 'Detected next. Port 3000.');
  assert.deepEqual(deploySteps([], 'running').map((s) => s.state)[0], 'active', 'nothing heard yet: the first step is under way');
  const failed = deploySteps([...log.slice(0, 3), '10:01:00 Build failed.'], 'failed');
  assert.equal(failed.find((s) => s.state === 'failed')?.key, 'build');
  assert.ok(deploySteps(['Running database migrations (2 new): npx prisma migrate deploy'], 'running').some((s) => s.key === 'migrate'));
});

test('the map card opens on the tab the question was about', () => {
  const counts = { domain: 3, app: 4, server: 1, database: 1, account: 2 };
  assert.equal(pickTab('show me my domains', counts), 'domain');
  assert.equal(pickTab('how busy is my server?', counts), 'server');
  assert.equal(pickTab('which apps are down', counts), 'app');
  assert.equal(pickTab(undefined, { ...counts, domain: 0 }), 'app');
});

test('domains group under their root with what each points at; Unit7-only lists keep just theirs', () => {
  const v = derive({ running: false, accounts: [], suggestions: [], issues: [],
    assets: [
      { id: 'a', provider: 'unit7', kind: 'app', name: 'web', url: 'https://example.com', end: { kind: 'unit7', serviceId: 'svc_1' } },
      { id: 'd', provider: 'domain', kind: 'domain', name: 'example.com', url: null, dns: 'cloudflare' },
      { id: 'w', provider: 'domain', kind: 'domain', name: 'www.example.com', url: null, dns: 'cloudflare' },
      { id: 's', provider: 'domain', kind: 'domain', name: 'shop.example.com', url: null, dns: 'cloudflare' },
    ],
    edges: [{ source: 'd', target: 'a', kind: 'domain', via: 'routed', status: 'ok', detail: null }, { source: 's', target: 'a', kind: 'dns', via: 'CNAME', status: 'misconfigured', detail: null }] });
  const [g] = domainGroups(v, (a) => a.name);
  assert.equal(g!.root, 'example.com');
  assert.equal(g!.dns, 'cloudflare');
  assert.equal(g!.target?.name, 'web');
  assert.deepEqual(g!.subs.map((s) => [s.label, s.tone]), [['shop', 'bad'], ['www', 'idle']]);
  assert.equal(g!.tone, 'bad', 'a broken subdomain marks the whole domain');
  const only = domainGroups(v, (a) => a.name, [{ id: 'dom_1', hostname: 'app.example.org', status: 'pending', tls: 'pending', service: 'web' }], new Set(['www.example.com', 'app.example.org']));
  assert.deepEqual(only.map((x) => [x.root, x.subs.map((s) => s.name)]), [['example.org', ['app.example.org']], ['example.com', ['www.example.com']]], 'not on the map yet still shows; problems first');
});

test('numbers read plainly', () => {
  assert.equal(bytes(15_351_153), '14.6 MB');
  assert.equal(bytes(512), '512 B');
  const u = usage({ cpus: 2, load: '0.5 0.4 0.3', mem_total: 100, mem_available: 25, disk_total: 200, disk_used: 50 });
  assert.deepEqual([u.cpu, u.mem, u.disk], [25, 75, 25]);
  const t = parseTable(' table | rows | size\n-------+------+-------\n users |  120 | 64 kB\n posts |    9 | 16 kB\n(2 rows)\n');
  assert.deepEqual(t, { head: ['table', 'rows', 'size'], rows: [['users', '120', '64 kB'], ['posts', '9', '16 kB']] });
  assert.equal(parseTable('db0:keys=3'), null);
});
