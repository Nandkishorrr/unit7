// Home's "At a glance" counts what the Map shows: every account's apps and servers, domains under their root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive, type Asset } from '../web/src/pages/map/data.ts';
import { glance } from '../web/src/pages/glance.ts';

const dom = (id: string, name: string, zone?: string): Asset => ({ id, provider: 'domain', kind: 'domain', name, url: null, zone });

test('domains and subdomains from the map, not only the ones Unit7 manages', () => {
  const v = derive({
    running: false, accounts: [], suggestions: [],
    issues: [{ severity: 'warning', key: 'email:example.com', text: 'Email can be faked' }],
    assets: [
      dom('d1', 'example.com', 'example.com'), dom('d2', 'www.example.com', 'example.com'), dom('d3', 'api.example.com', 'example.com'),
      dom('d4', 'example.org', 'example.org'), dom('d5', 'shop.example.org', 'example.org'),
      dom('d6', 'app.example.net'), // no zone from a scan: grouped under its guessed root, which isn't on the map itself
      { id: 'a1', provider: 'vercel', kind: 'app', name: 'site', url: 'https://site.example.com', site: { status: 'down', ms: null, host: 'site.example.com' } },
      { id: 'a2', provider: 'coolify', kind: 'app', name: 'crm', url: null, owner: 'coolify', server: 's1' }, // found inside the VPS by its X-ray
      { id: 'a4', provider: 'unmanaged', kind: 'app', name: 'blog', url: null, owner: 'unmanaged', server: 's1' },
      { id: 'x1', provider: 'coolify', kind: 'service', name: 'Coolify itself', url: null, owner: 'coolify', server: 's1', system: true }, // not an app
      { id: 'a3', provider: 'unit7', kind: 'app', name: 'api', url: null, end: { kind: 'unit7', serviceId: 'svc_1' } },
      { id: 's1', provider: 'hostinger', kind: 'server', name: 'vps-1', url: null, account: 'Hostinger · sam' },
      { id: 'db', provider: 'supabase', kind: 'database', name: 'db', url: null },
    ],
    edges: [],
  });
  const g = glance(v, { apps: [{ id: 'svc_1', sick: true }, { id: 'svc_2', sick: false }], servers: [{ name: 'box', ready: true }], domains: [] });
  assert.equal(g.synced, true);
  assert.deepEqual(g.domains, { n: 3, subs: 4, look: 1 }, '3 roots (example.com, example.org, example.net), 4 subdomains, the email issue');
  assert.deepEqual(g.apps, { n: 5, look: 2, hosts: ['vercel', 'coolify', 'docker', 'unit7'] }, 'Vercel, Coolify, Docker and Unit7 apps, plus one made since the sync; the down site and the sick Unit7 app need a look');
  assert.deepEqual(g.servers, { n: 2, look: 0 }, 'the known VPS, plus a Unit7 server not synced yet');
});

test('before the first sync: what Unit7 itself knows', () => {
  const g = glance(null, { apps: [{ id: 'svc_1', sick: false }], servers: [{ name: 'box', ready: false }], domains: [{ active: true }, { active: false }] });
  assert.deepEqual(g, { synced: false, apps: { n: 1, look: 0, hosts: ['unit7'] }, servers: { n: 1, look: 1 }, domains: { n: 2, subs: 0, look: 1 } });
});

test('domains that need a look count by root, like the Map’s Overview: two subdomains with problems are one domain', () => {
  const v = derive({
    running: false, accounts: [], suggestions: [],
    issues: [{ severity: 'warning', key: 'email:example.com', text: 'Email can be faked' }, { severity: 'critical', key: 'takeover:old.example.com', about: 'd2', text: 'Can be taken over' }, { severity: 'warning', key: 'tls:www.example.com', about: 'd3', text: 'HTTPS' }],
    assets: [dom('d1', 'example.com', 'example.com'), dom('d2', 'old.example.com', 'example.com'), dom('d3', 'www.example.com', 'example.com'), dom('d4', 'example.org', 'example.org')],
    edges: [],
  });
  assert.deepEqual(glance(v, { apps: [], servers: [], domains: [] }).domains, { n: 2, subs: 2, look: 1 });
});
