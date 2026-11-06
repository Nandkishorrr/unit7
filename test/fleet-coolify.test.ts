// D6 Coolify fleets, against a stand-in Coolify: an app made in Coolify runs on one more server through Coolify's own
// "additional servers" (its destinations), its deploys show as one lane per server, and what Coolify refuses (Docker
// Compose, files in a volume, no registry image) is said first in plain words. Unit7's own fleet refusal on a Coolify
// server points at this path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { id, run } from '../src/db.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { CURL, coolifyTiming } from '../src/connectors/coolify.ts';
import { coolifyFleetRefusal, coolifyLanes } from '../src/fleet/coolify.ts';
import type { App } from '../src/app.ts';
import { XRAY_PROBE } from '../src/discovery/xray.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';

const TOKEN = '3|unit7testtokenAbC123xyz';
coolifyTiming.pollMs = 1;

test('what Coolify refuses, in plain words, and one lane per server from its deployments', () => {
  assert.match(coolifyFleetRefusal({ build_pack: 'dockercompose', docker_registry_image_name: 'ghcr.io/sam/shop' }, 0)!.reason, /Docker Compose app/);
  const vol = coolifyFleetRefusal({ build_pack: 'nixpacks', docker_registry_image_name: 'ghcr.io/sam/shop' }, 1)!;
  assert.match(vol.reason, /volumes aren’t shared between servers/);
  assert.match(vol.fix!, /S3 or Cloudflare R2/);
  assert.match(coolifyFleetRefusal({ build_pack: 'nixpacks', docker_registry_image_name: '' }, 0)!.fix!, /General tab and set Image/);
  assert.equal(coolifyFleetRefusal({ build_pack: 'nixpacks', docker_registry_image_name: 'ghcr.io/sam/shop' }, 0), undefined);
  const lanes = coolifyLanes([{ uuid: 'd1', name: 'main', serverUuid: 's1', serverId: 1, primary: true }, { uuid: 'd2', name: 'two', serverUuid: 's2', serverId: 2, primary: false }, { uuid: 'd3', name: 'three', serverUuid: 's3', serverId: 3, primary: false }],
    [{ server_id: 1, status: 'finished', created_at: '2026-10-08T01:00:00Z', commit: '3f2a1c9e' }, { server_id: 1, status: 'failed', created_at: '2026-10-07T01:00:00Z' }, { server_id: 2, status: 'in_progress', created_at: '2026-10-08T01:01:00Z' }], (d) => d.name);
  assert.deepEqual(lanes.map((l) => [l.name, l.state, l.detail]), [['main', 'done', 'Done · 3f2a1c9'], ['two', 'running', 'Deploying'], ['three', 'waiting', undefined]]);
});

// a stand-in Coolify 4.4 answering the curl config Unit7 sends over SSH
function fakeCoolify(o: { buildPack?: string; storages?: number; image?: string } = {}) {
  const seen: { method: string; path: string; body: any }[] = [];
  const dests = [{ uuid: 'dest-main', name: 'coolify', network: 'coolify', server_uuid: 'srv-one', server_id: 1, is_primary: true }];
  const answer = (method: string, url: string, body: any): [number, unknown] => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
    seen.push({ method, path, body });
    const r = `${method} ${path}`;
    if (r === 'GET /version') return [200, '4.4.2'];
    if (r === 'GET /team') return [200, { name: 'Sam’s team' }];
    if (r === 'GET /servers') return [200, [{ uuid: 'srv-one', name: 'localhost', ip: 'host.docker.internal' }, { uuid: 'srv-two', name: 'box-two', ip: '203.0.113.20' }]];
    if (r === 'GET /servers/srv-one/sentinel') return [200, {}];
    if (r === 'POST /projects') return [422, { message: 'name is required' }];
    if (r === 'POST /deploy' && !url.includes('uuid=')) return [400, { message: 'uuid or tag required' }];
    if (r === 'GET /applications/shopapp01') return [200, { uuid: 'shopapp01', name: 'Shop web', build_pack: o.buildPack ?? 'nixpacks', docker_registry_image_name: o.image ?? 'ghcr.io/sam/shop' }];
    if (r === 'GET /applications/shopapp01/destinations') return [200, dests];
    if (r === 'GET /applications/shopapp01/storages') return [200, { persistent_storages: [...Array(o.storages ?? 0)].map((_, k) => ({ uuid: `st${k}` })), file_storages: [] }];
    if (r === 'GET /servers/srv-two/destinations') return [200, [{ uuid: 'dest-two', name: 'coolify', network: 'coolify', server_id: 2 }]];
    if (r === 'POST /applications/shopapp01/destinations') {
      if (body?.destination_uuid !== 'dest-two') return [404, { message: 'Destination not found.' }];
      dests.push({ uuid: 'dest-two', name: 'coolify', network: 'coolify', server_uuid: 'srv-two', server_id: 2, is_primary: false });
      return [201, { message: 'Destination attached.', uuid: 'dest-two' }];
    }
    if (r === 'DELETE /applications/shopapp01/destinations/dest-two') { dests.splice(dests.findIndex((d) => d.uuid === 'dest-two'), 1); return [200, { message: 'Destination detached.' }]; }
    if (r === 'POST /deploy') return [200, { deployments: [{ message: 'Deployment queued.', deployment_uuid: 'dep9' }] }];
    if (r === 'GET /deployments/dep9') return [200, { deployment_uuid: 'dep9', status: 'finished' }];
    if (r === 'GET /deployments/applications/shopapp01') return [200, seen.some((x) => x.path === '/deploy' && x.method === 'POST' && x.body === undefined)
      ? [{ server_id: 1, server_name: 'localhost', status: 'finished', created_at: '2026-10-08T02:00:00Z', commit: 'abc1234def' }, { server_id: 2, server_name: 'box-two', status: 'finished', created_at: '2026-10-08T02:01:00Z' }] : []];
    return [404, { message: 'Not found.' }];
  };
  return { seen, dests, answer };
}
function onServer(app: App, c: ReturnType<typeof fakeCoolify>) {
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    if (String(o.stdin ?? '') === XRAY_PROBE) return { code: 0, stdout: COOLIFY_HOST, stderr: '', truncated: false };
    if (command !== CURL) return { code: 0, stdout: '', stderr: '', truncated: false };
    const conf = String(o.stdin ?? '');
    const get = (k: string) => { const m = new RegExp(`^${k} = "((?:[^"\\\\]|\\\\.)*)"$`, 'm').exec(conf); return m ? JSON.parse(`"${m[1]}"`) as string : undefined; };
    if (!conf.includes(`Authorization: Bearer ${TOKEN}`)) return { code: 0, stdout: '{"message":"Unauthenticated."}\n401', stderr: '', truncated: false };
    const data = get('data-binary');
    const [status, body] = c.answer(get('request')!, get('url')!, data ? JSON.parse(data) : undefined);
    return { code: 0, stdout: `${typeof body === 'string' ? body : JSON.stringify(body)}\n${status}`, stderr: '', truncated: false };
  };
}
async function setup(o?: Parameters<typeof fakeCoolify>[0]) {
  const app = testApp();
  const org = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, org.orgId, JSON.stringify({ sudo: 'root', web: 'coolify-proxy|traefik:v3.1' }));
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status) VALUES (?, ?, 'Box two', '203.0.113.20', 'root', 'credential://ssh/b2/private-key', 'ready')`, id('srv'), org.orgId);
  const c = fakeCoolify(o);
  onServer(app, c);
  ok(await org.h('coolify.connect', { serverId: srv, token: TOKEN }));
  return { app, org, srv, c };
}

test('a Coolify app on one more server: Coolify’s own destinations, a deploy everywhere, one lane per server, and back', async () => {
  const { org, srv, c } = await setup();
  const before = ok(await org.h('coolify.servers', { serverId: srv, uuid: 'shopapp01' }));
  assert.equal(before.refusal, undefined);
  assert.deepEqual(before.candidates.map((x: any) => x.uuid), ['srv-two']);
  assert.match(before.traffic, /doesn’t spread visitors/);
  // an AI asks first: the app would start on another server with its settings
  assert.equal((await org.a('coolify.add_server', { serverId: srv, uuid: 'shopapp01', to: 'srv-two' })).status, 'approval_required');
  assert.ok(!c.seen.some((x) => x.method === 'POST' && x.path.endsWith('/destinations')));
  const r = ok(await org.h('coolify.add_server', { serverId: srv, uuid: 'shopapp01', to: 'srv-two' }));
  assert.deepEqual(c.seen.find((x) => x.method === 'POST' && x.path === '/applications/shopapp01/destinations')!.body, { destination_uuid: 'dest-two' }, 'the other server’s own Docker network in Coolify');
  assert.equal(r.deploy, 'finished');
  assert.deepEqual(r.lanes.map((l: any) => [l.name, l.state, l.primary]), [['localhost', 'done', true], ['box-two', 'done', false]]);
  const after = ok(await org.h('coolify.servers', { serverId: srv, uuid: 'shopapp01' }));
  assert.equal(after.servers.find((x: any) => x.serverUuid === 'srv-two').unit7Name, 'Box two', 'Unit7’s own name for that server');
  const main = await org.h('coolify.remove_server', { serverId: srv, uuid: 'shopapp01', destination: 'dest-main' });
  assert.match((main as any).error.message, /main server in Coolify/);
  ok(await org.h('coolify.remove_server', { serverId: srv, uuid: 'shopapp01', destination: 'dest-two' }));
  assert.equal(c.dests.length, 1);
});

test('refused before anything changes: a Compose app, files in a volume, no registry image', async () => {
  for (const [o, why] of [[{ buildPack: 'dockercompose' }, /Docker Compose app/], [{ storages: 2 }, /volumes aren’t shared/], [{ image: '' }, /registry image/]] as const) {
    const { org, srv, c } = await setup(o);
    const r = await org.h('coolify.add_server', { serverId: srv, uuid: 'shopapp01', to: 'srv-two' });
    assert.equal(r.status, 'error');
    assert.match((r as any).error.message, why);
    assert.ok(!c.seen.some((x) => x.method === 'POST' && x.path.endsWith('/destinations')), 'nothing attached');
  }
});

test('Unit7’s own fleet on a Coolify server says why, and points at Coolify’s way for apps made there', async () => {
  const { app, org, srv } = await setup();
  const proj = ok(await org.h('project.create', { name: 'Shop', environments: ['production'] }));
  const svcId = id('svc'), depId = id('dep');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status, current_deployment_id) VALUES (?, ?, ?, ?, ?, 'shop', 'shop', 'app', '{}', 'healthy', ?)`, svcId, org.orgId, proj.projectId ?? proj.id, proj.environments[0].id, srv, depId);
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, image, container) VALUES (?, ?, ?, 1, 'live', 'unit7/shop:1', 'unit7-shop-1')`, depId, org.orgId, svcId);
  const other = get2(app, org.orgId);
  const r = await org.h('fleet.add_server', { serviceId: svcId, serverId: other });
  assert.match((r as any).error.message, /through Coolify’s proxy.*Apps made in Coolify can run on more servers through Coolify itself/s);
});
const get2 = (app: App, orgId: string) => (app.db.prepare(`SELECT id FROM servers WHERE org_id = ? AND name = 'Box two'`).get(orgId) as { id: string }).id;
