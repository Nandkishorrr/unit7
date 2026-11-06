// The Coolify gaps: a Coolify server counts as ready, logs and wiring work with the automatic key on every version, part.update
// backs up first, deploy keys, deploy on push, previews, storage, scale, caps and health checks for services, and Coolify's
// projects in project.list and graph.get. A stand-in Coolify answers the way each real release does (read from its routes/api.php
// and controllers at the tags in ERA). The "server" runs real curl, and real sh with a stand-in docker on PATH: a shell script is
// what breaks when a fake is too kind.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { account, fakeApi, type Req } from './clouds-fakes.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { get, id, json, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { COOLIFY_PHP, CURL, composeEdit, composeParts, coolifyTiming } from '../src/connectors/coolify.ts';
import { XRAY_PROBE } from '../src/discovery/xray.ts';
import { manageDirs, manageTiming } from '../src/tools/manage.ts';
import { readyOf, parseFacts, preparing } from '../src/tools/servers.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';

coolifyTiming.pollMs = 5;
manageTiming.settleMs = 0;
const TMP = mkdtempSync(join(tmpdir(), 'unit7-gap-coolify-'));
manageDirs.backups = join(TMP, 'backups');

// what each release's API does, from its own source
const ERA = {
  '4.0.0-beta.450': { storages: false, previews: false, dbLogs: false, sensitiveLogs: false, deleteAbility: false },
  '4.1.3': { storages: true, previews: false, dbLogs: false, sensitiveLogs: false, deleteAbility: false },
  '4.3.23': { storages: true, previews: true, dbLogs: true, sensitiveLogs: false, deleteAbility: false },
  '4.4.0': { storages: true, previews: true, dbLogs: true, sensitiveLogs: true, deleteAbility: false },
  '4.6.0': { storages: true, previews: true, dbLogs: true, sensitiveLogs: true, deleteAbility: true },
} as const;
type Version = keyof typeof ERA;
const AUTO_KEY = '5|autokeyAbC123xyz0000', OLD_AUTO_KEY = '6|oldautokeyAbC123xyz', ROOT_KEY = '7|rootkeyAbC123xyz00000';
const ABILITIES: Record<string, string[]> = { [AUTO_KEY]: ['read', 'write', 'deploy', 'delete'], [OLD_AUTO_KEY]: ['read', 'write', 'deploy'], [ROOT_KEY]: ['root'] };
const ANON = 'eyJhbGciOiJIUzI1NiJ9.anonKeyValue7Qx.Sig5ature';
const COMPOSE = `services:
  # the database
  supabase-db:
    image: 'supabase/postgres:15.8'
    mem_limit: 1g
    volumes:
      - 'supabase-db-data:/var/lib/postgresql/data'
  supabase-kong:
    image: 'kong:2.8.1'
    healthcheck:
      test:
        - CMD
        - kong
        - health
      interval: 5s
  supabase-studio:
    image: 'supabase/studio:2026.01.07'
    environment:
      - 'SUPABASE_PUBLIC_URL=\${SERVICE_URL_SUPABASEKONG}'
    deploy:
      resources:
        limits:
          memory: 512m
  imgproxy:
    image: 'darthsim/imgproxy:v3.8.0'
`;

function fakeCoolify(version: Version = '4.4.0') {
  const era = ERA[version];
  const seen: { method: string; path: string; body: any }[] = [];
  const st = {
    seen, compose: COMPOSE, keys: [] as any[], made: [] as any[], failApp: false,
    apps: { shopapp01: { uuid: 'shopapp01', name: 'Shop web', build_pack: 'nixpacks', git_repository: 'git@github.com:example/shop.git', git_branch: 'main', source_id: 0, status: 'running:healthy', limits_memory: '0', settings: { is_auto_deploy_enabled: false, is_preview_deployments_enabled: false } },
      viaapp01: { uuid: 'viaapp01', name: 'Via app', build_pack: 'nixpacks', git_repository: 'example/shop', source_id: 3, settings: { is_auto_deploy_enabled: false, is_preview_deployments_enabled: false } },
      imgapp01: { uuid: 'imgapp01', name: 'Image app', build_pack: 'dockerimage', git_repository: 'coollabsio/coolify', source_id: 0, settings: {} } } as Record<string, any>,
    storages: [{ uuid: 'vol1', name: 'shopapp01-uploads', mount_path: '/app/uploads' }, { uuid: 'vol2', name: 'my-own-volume', mount_path: '/app/cache' }] as any[],
    files: [{ uuid: 'file1', mount_path: '/app/config.yml' }] as any[], swarm: false,
    githubApps: [] as any[], supaEnvs: [{ key: 'SERVICE_URL_SUPABASEKONG', value: 'https://api.shop.example.com', is_preview: false }, { key: 'SERVICE_SUPABASEANON_KEY', value: ANON, is_preview: false }],
    bulk: [] as any[],
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, 'http://x'), path = url.pathname.replace(/^\/api\/v1/, ''), body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ method: req.method!, path: path + url.search, body });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': typeof b === 'string' ? 'text/plain' : 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    const token = (req.headers.authorization ?? '').replace('Bearer ', ''), can = ABILITIES[token];
    if (!can) return send(401, { message: 'Unauthenticated.' });
    const allowed = (a: string) => can.includes('root') || can.includes(a);
    const need = (a: string) => { if (allowed(a)) return false; send(403, { message: `Missing required permissions: ${a}` }); return true; };
    const sensitive = allowed('read:sensitive');
    const r = `${req.method} ${path}`;
    let m: RegExpExecArray | null;
    if (req.method === 'DELETE' && need(era.deleteAbility ? 'delete' : 'write')) return;
    if (r === 'GET /version') return send(200, version);
    if (r === 'GET /team') return send(200, { id: 0, name: 'Sam’s team' });
    if (r === 'GET /servers') return send(200, [{ uuid: 'srvuuid01', name: 'localhost', settings: { is_swarm_manager: st.swarm } }]);
    if (r === 'GET /servers/srvuuid01/sentinel') return send(200, sensitive ? { sentinel_token: 'sentinel-token-value-1' } : { is_metrics_enabled: false });
    if (r === 'POST /projects') return send(422, { message: 'Validation failed.' });
    if (r === 'POST /deploy') return url.searchParams.get('uuid') ? send(200, { deployments: [{ message: 'Deployment queued.', deployment_uuid: url.searchParams.get('uuid') === 'broken01' ? 'depbad' : 'dep2' }] }) : send(400, { message: 'You must provide uuid or tag.' });
    if ((m = /^GET \/deployments\/(\w+)$/.exec(r))) return send(200, { deployment_uuid: m[1], status: m[1] === 'depbad' ? 'failed' : 'finished', ...(sensitive && { logs: JSON.stringify([{ output: 'from the api' }]) }) });
    if (r === 'GET /projects') return send(200, [{ uuid: 'proj01', name: 'Shop' }, { uuid: 'proj02', name: 'Relay' }]);
    if (r === 'GET /projects/proj01') return send(200, { uuid: 'proj01', name: 'Shop', environments: [{ id: 1, name: 'production', uuid: 'env01' }] });
    if (r === 'GET /projects/proj02') return send(200, { uuid: 'proj02', name: 'Relay', environments: [{ id: 2, name: 'production', uuid: 'env02' }] });
    if (r === 'GET /projects/proj01/env01' || r === 'GET /projects/proj01/production') return send(200, { applications: Object.values(st.apps).filter((a) => a.uuid === 'shopapp01'), services: [{ uuid: 'shopsupa01', name: 'Shop Supabase', service_type: 'supabase', status: 'running:healthy' }] });
    if (r === 'GET /projects/proj02/env02' || r === 'GET /projects/proj02/production') return send(200, { postgresqls: [{ uuid: 'relaydb01', name: 'relay-db', status: 'running:healthy' }] });
    if (r === 'GET /deployments/applications/shopapp01') return send(200, []);
    if (r === 'GET /github-apps') return send(200, st.githubApps);
    if ((m = /^GET \/github-apps\/([\w-]+)\/repositories$/.exec(r))) return send(200, { repositories: [{ full_name: 'example/viaapp', private: true, default_branch: 'main' }] });
    // logs, by what each release needs
    if ((m = /^GET \/(applications|databases|services)\/(\w+)\/logs$/.exec(r))) {
      if (m[1] !== 'applications' && !era.dbLogs) return send(404, { message: 'Not found.' });
      if (need(era.sensitiveLogs ? 'read:sensitive' : 'read')) return;
      if (m[1] === 'services' && !url.searchParams.get('sub_service_name')) return send(400, { message: 'Sub service name is required.' });
      return send(200, { logs: 'from the api' });
    }
    // deploy keys and new apps
    if (r === 'POST /security/keys') { const uuid = `key${st.keys.length + 1}`; st.keys.push({ uuid, ...body }); return send(201, { uuid }); }
    if ((m = /^DELETE \/security\/keys\/(\w+)$/.exec(r))) { st.keys = st.keys.filter((k) => k.uuid !== m![1]); return send(200, { message: 'Private Key deleted.' }); }
    if ((m = /^POST \/applications\/(public|private-deploy-key|private-github-app)$/.exec(r))) { if (st.failApp) return send(422, { message: 'Validation failed.', errors: { git_repository: ['Bad.'] } }); st.made.push({ route: m[1], ...body }); return send(201, { uuid: 'newapp01', domains: '' }); }
    // an application, its switches and its storage
    if ((m = /^(GET|PATCH) \/applications\/(\w+)$/.exec(r))) {
      const a = st.apps[m[2]!];
      if (!a) return send(404, { message: 'Application not found.' });
      if (m[1] === 'GET') { const { manual_webhook_secret_github: _hidden, ...rest } = a; return send(200, sensitive ? a : rest); }
      if ('is_preview_deployments_enabled' in body && !era.previews) return send(422, { message: 'Validation failed.', errors: { is_preview_deployments_enabled: ['This field is not allowed.'] } });
      for (const [k, v] of Object.entries(body)) if (k.startsWith('is_')) a.settings[k] = v; else a[k] = v;
      return send(200, { uuid: a.uuid });
    }
    if ((m = /^(GET|POST) \/(applications|services)\/(\w+)\/storages$/.exec(r))) {
      if (!era.storages) return send(404, { message: 'Not found.' });
      if (m[1] === 'GET') return send(200, { persistent_storages: st.storages, file_storages: st.files });
      if (body.type !== 'persistent' || !body.name || !body.mount_path) return send(422, { message: 'Validation failed.' });
      const v = { uuid: `vol${st.storages.length + 9}`, name: `${body.resource_uuid ?? m[3]}-${body.name}`, mount_path: body.mount_path, ...(body.resource_uuid && { resource_uuid: body.resource_uuid }) };
      st.storages.push(v);
      return send(201, v);
    }
    if ((m = /^DELETE \/applications\/(\w+)\/storages\/(\w+)$/.exec(r))) { st.storages = st.storages.filter((v) => v.uuid !== m![2]); return send(200, { message: 'Storage deleted.' }); }
    // services: the compose and the values stay hidden without read:sensitive
    if (r === 'POST /services') return send(201, { uuid: 'supa9', domains: [] });
    if ((m = /^GET \/services\/(\w+)$/.exec(r))) return send(200, { uuid: m[1], name: 'Shop Supabase', status: 'running:healthy', ...(sensitive && { docker_compose_raw: st.compose }) });
    if (r === 'PATCH /services/shopsupa01') { st.compose = Buffer.from(body.docker_compose_raw, 'base64').toString(); return send(200, { uuid: 'shopsupa01', domains: [] }); }
    if ((m = /^GET \/services\/(\w+)\/envs$/.exec(r))) return send(200, st.supaEnvs.map((e) => (sensitive ? e : { key: e.key, is_preview: e.is_preview })));
    if (r === 'PATCH /applications/shopapp01/envs/bulk') { st.bulk.push(...body.data); return send(201, []); }
    if (r === 'GET /databases/relaydb01') return send(200, { uuid: 'relaydb01', name: 'relay-db', database_type: 'standalone-postgresql', status: 'running:healthy', ...(sensitive && { internal_db_url: 'postgres://u:from-api@relaydb01:5432/app' }) });
    send(404, { message: 'Not found.' });
  });
  return new Promise<typeof st & { port: number; close: () => void }>((r) => server.listen(0, '127.0.0.1', () => r(Object.assign(st, { port: (server.address() as { port: number }).port, close: () => server.close() }))));
}

// docker and sudo stand-ins a real sh finds on PATH; containers and logs come from a JSON file a test changes
function standIns() {
  const dir = mkdtempSync(join(TMP, 'bin-')), state = join(dir, 'state.json');
  writeFileSync(join(dir, 'docker'), `#!${process.execPath}
const fs = require('fs'), st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8')), a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(`${state}.log`)}, JSON.stringify(a) + '\\n');
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st));
if (a[0] === 'ps') {
  const want = a.flatMap((x, i) => (x === '--filter' && a[i + 1].startsWith('label=') ? [a[i + 1].slice(6)] : []));
  for (const c of st.containers) if (want.every((l) => c.labels.includes(l)) && (!a.includes('status=running') || c.running !== false)) console.log(a.at(-1).includes('pullRequestId') ? c.name + '|' + (c.pr ?? '') : c.name);
} else if (a[0] === 'logs') { const n = Number(a[a.indexOf('--tail') + 1]); console.log(st.logs[a.at(-1)].slice(-n).join('\\n')); }
else if (a[0] === 'inspect') { const key = /"(\\w+)"\\}\\}\\{\\{json/.exec(a[2])[1], c = st.containers.find((x) => x.name === a[3]), v = c.env?.[key]; if (v !== undefined) console.log(JSON.stringify(key + '=' + v)); }
else if (a[0] === 'network') { if (a[1] === 'inspect' && !st.network) process.exit(1); if (a[1] === 'create') { st.network = true; save(); } }
else if (a[0] === 'exec' && a.includes('sh') && String(a[a.indexOf('-c') + 1]).includes('@@path')) { for (const p of a.slice(a.indexOf('-c') + 3)) console.log('@@path ' + p + ' ' + (st.pages?.includes(p) ? 200 : 404)); }
else if (a[0] === 'exec' && String(a.join(' ')).includes('pg_dumpall')) { if (st.dumpFails) process.exit(1); console.log('-- a dump'); }
`);
  writeFileSync(join(dir, 'sudo'), `#!/bin/sh
[ "$1" = -n ] && shift
echo "$*" >> ${JSON.stringify(`${state}.sudo`)}
exec "$@"
`);
  for (const f of ['docker', 'sudo']) chmodSync(join(dir, f), 0o755);
  const write = (s: unknown) => writeFileSync(state, JSON.stringify(s));
  const dockerCalls = () => { try { return readFileSync(`${state}.log`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; } };
  const sudoCalls = () => { try { return readFileSync(`${state}.sudo`, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { dir, write, dockerCalls, sudoCalls };
}
const SUPA_LABELS = ['coolify.serviceUuid=shopsupa01', 'com.docker.compose.project=shopsupa01'];
const CONTAINERS = [
  { name: 'shopapp01-101530000002', labels: ['com.docker.compose.project=shopapp01'], pr: '0' },
  { name: 'shopapp01-pr-7', labels: ['com.docker.compose.project=shopapp01'], pr: '7' },
  { name: 'relaydb01', labels: ['coolify.databaseUuid=relaydb01', 'com.docker.compose.project=relaydb01'] },
  { name: 'supabase-kong-shopsupa01', labels: SUPA_LABELS, env: { SUPABASE_ANON_KEY: ANON } },
  { name: 'supabase-studio-shopsupa01', labels: SUPA_LABELS, env: { SUPABASE_PUBLIC_URL: 'https://api.shop.example.com', SUPABASE_ANON_KEY: ANON } },
  { name: 'imgproxy-shopsupa01', labels: SUPA_LABELS },
];
const LOGS = { 'shopapp01-101530000002': ['app line 1', 'app line 2'], relaydb01: ['db line'], 'supabase-kong-shopsupa01': ['kong line'], 'supabase-studio-shopsupa01': ['studio line'], 'imgproxy-shopsupa01': ['img line'] };

function fakeServer(app: App, port: number, bin: ReturnType<typeof standIns>, php: { deployment_log?: unknown; db_url?: string; compose?: () => string } = {}) {
  const calls: { command: string; stdin: string }[] = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    const stdin = String(o.stdin ?? '');
    calls.push({ command, stdin });
    const done = (stdout: string, code = 0) => ({ code, stdout, stderr: '', truncated: false });
    if (stdin === XRAY_PROBE) return done(COOLIFY_HOST);
    if (command.includes('df -Pk')) return done('100000000000 50000000000\n');
    if (command === COOLIFY_PHP) {
      const op = /\/\/ unit7:(\w+)/.exec(stdin)![1]!;
      const out = op === 'deployment_log' ? { logs: php.deployment_log ?? [{ output: 'npm ERR! from the record' }] } : op === 'db_url' ? { url: php.db_url ?? 'postgres://u:from-php@relaydb01:5432/app' } : op === 'service_compose' ? { compose: Buffer.from(php.compose?.() ?? COMPOSE).toString('base64') } : undefined;
      return out ? done(`notice\n@@unit7:json ${JSON.stringify(out)}\n`) : done('', 1);
    }
    // Unit7's folders, moved under this test's own: a real shell, on nothing of this computer's
    const argv = command === CURL ? ['curl', '-K', '-'] : ['sh', '-c', command.replace(/\/var\/lib\/unit7/g, `${bin.dir}/lib`).replace(/\/etc\/unit7/g, `${bin.dir}/etc`)];
    return new Promise((resolve) => {
      const p = spawn(argv[0]!, argv.slice(1), { env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH}` } });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
      p.stdin.on('error', () => undefined);
      p.stdin.end(command === CURL ? stdin.replace('http://127.0.0.1:8000/', `http://127.0.0.1:${port}/`) : stdin);
    });
  };
  return calls;
}

const closers: (() => void)[] = [];
after(() => { for (const c of closers) c(); });
async function setup(version: Version = '4.4.0', token = AUTO_KEY, o2: { php?: Parameters<typeof fakeServer>[3]; facts?: Record<string, unknown>; status?: string } = {}) {
  const app = testApp(), c = await fakeCoolify(version), o = await testOrg(app), bin = standIns();
  closers.push(c.close);
  bin.write({ containers: CONTAINERS, logs: LOGS });
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', ?, ?)`, srv, o.orgId, o2.status ?? 'ready', JSON.stringify({ sudo: 'root', docker: '27.3.1', web: 'coolify-proxy|traefik:v3.6', ...o2.facts }));
  const calls = fakeServer(app, c.port, bin, o2.php);
  ok(await o.h('coolify.connect', { serverId: srv, token }));
  return { app, c, o, srv, calls, bin };
}
const leaked = (app: App) => JSON.stringify([...app.db.prepare('SELECT * FROM audit').all(), ...app.db.prepare('SELECT * FROM events').all(), ...app.db.prepare('SELECT * FROM changes').all()]);
const error = (r: unknown) => (r as { error: { code: string; message: string } }).error;

// --- a Coolify server counts as ready ---------------------------------------------------------------------------------
const FACTS = (extra: string) => `os=Ubuntu 24.04\nos_id=ubuntu\ncpus=4\nmem_total=8000000000\nmem_available=4000000000\ndisk_total=100000000000\ndisk_used=20000000000\nuptime=1000\nload=0.1\ndocker=27.3.1\nuser=root\nsudo=root\nports=22,80,443,8000\n${extra}`;
test('ready: Coolify counts, whichever proxy it runs; a box with only Docker doesn’t', () => {
  assert.equal(readyOf(parseFacts(FACTS('coolify=Up 3 days\nweb=coolify-proxy|traefik:v3.6'))), true);
  assert.equal(readyOf(parseFacts(FACTS('coolify=Up 3 days\nweb=coolify-proxy|lucaslorentz/caddy-docker-proxy:2.8'))), true, 'Coolify with its Caddy proxy');
  assert.equal(readyOf(parseFacts(FACTS('coolify=Up 3 days'))), true, 'its proxy off');
  assert.equal(readyOf(parseFacts(FACTS('caddy=Up 2 days'))), true, 'Unit7’s own Caddy, as before');
  assert.equal(readyOf(parseFacts(FACTS(''))), false);
  assert.equal(readyOf(parseFacts(FACTS('coolify=Up 3 days').replace('docker=27.3.1\n', ''))), false, 'Docker this user can’t reach');
});

test('connecting a Coolify server: ready at once, shared, and nothing on it changes', async () => {
  const app = testApp(), o = await testOrg(app), { default: ssh2 } = await import('ssh2');
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, e: ExecOptions = {}) => {
    seen.push(command);
    const done = (stdout = '') => ({ code: 0, stdout, stderr: '', truncated: false });
    if (command.includes('os_id=')) return done(FACTS('coolify=Up 3 days\nweb=coolify-proxy|traefik:v3.6'));
    return String(e.stdin ?? '') === XRAY_PROBE ? done(COOLIFY_HOST) : done();
  };
  const r = ok(await o.h('server.connect', { name: 'vps', host: '203.0.113.9', privateKey: ssh2.utils.generateKeyPairSync('ed25519').private }));
  assert.equal(r.status, 'ready');
  await preparing.get(r.serverId);
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM servers WHERE id = ?', r.serverId)!.status, 'ready');
  assert.ok(json<{ sharedHost?: string }>(get<{ facts: string }>(app.db, 'SELECT facts FROM servers WHERE id = ?', r.serverId)!.facts, {}).sharedHost, 'still marked as shared');
  assert.equal(get(app.db, `SELECT 1 FROM audit WHERE tool = 'server.bootstrap'`), undefined, 'never prepared');
  assert.ok(seen.every((c) => !/ufw|docker network create|apt-get|mkdir|tee/.test(c.split('\n').filter((l) => !/command -v ufw|ufw status|has=/.test(l)).join('\n'))), 'only looked');
});

test('a server left at connected turns ready at its next X-ray, and one without Coolify doesn’t', async () => {
  const { app, o, srv } = await setup('4.4.0', AUTO_KEY, { status: 'connected' });
  ok(await o.h('server.xray', { serverId: srv }));
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM servers WHERE id = ?', srv)!.status, 'ready');
  const quiet = await setup('4.4.0', AUTO_KEY, { status: 'connected', facts: { docker: undefined } });
  ok(await quiet.o.h('server.xray', { serverId: quiet.srv }));
  assert.equal(get<{ status: string }>(quiet.app.db, 'SELECT status FROM servers WHERE id = ?', quiet.srv)!.status, 'connected', 'Docker this user can’t reach: it stays, and Prepare it joins the docker group');
  const s = ok(await o.h('server.list'))[0];
  assert.equal(s.status, 'ready');
  assert.doesNotMatch(JSON.stringify(ok(await o.h('graph.get')).servers[0].status), /connected/);
});

test('the first Unit7 database on a ready Coolify server makes its own network and folders; nothing else does', async () => {
  const { o, srv, bin } = await setup('4.4.0', AUTO_KEY, { facts: { sudo: 'yes' } });
  const p = ok(await o.h('project.create', { name: 'Own', environments: ['production'] }));
  assert.equal(bin.dockerCalls().some((a) => a[0] === 'network'), false, 'connecting and looking change nothing');
  ok(await o.h('database.create', { environmentId: p.environments[0].id, engine: 'postgres', serverId: srv }));
  const calls = bin.dockerCalls();
  assert.ok(calls.some((a) => a.join(' ') === 'network create unit7'));
  assert.ok(calls.findIndex((a) => a.join(' ') === 'network create unit7') < calls.findIndex((a) => a[0] === 'run'), 'before anything needs it');
  const made = () => bin.sudoCalls().filter((l) => /^(mkdir|chown) /.test(l));
  assert.deepEqual(made().map((l) => l.split(' ')[0]), ['mkdir', 'chown'], 'folders, owned by the user Unit7 signs in as');
  ok(await o.h('database.create', { environmentId: p.environments[0].id, engine: 'redis', name: 'cache', serverId: srv }));
  assert.equal(bin.dockerCalls().filter((a) => a.join(' ') === 'network create unit7').length, 1, 'once');
  assert.equal(made().length, 2, 'once: the folders hold files others own by then, like the pooler’s');
});

// --- logs ---------------------------------------------------------------------------------------------------------------
test('4.4 and newer: the automatic key can’t read logs from Coolify, so they come over the server connection', async () => {
  for (const version of ['4.4.0', '4.6.0'] as const) {
    const { o, srv, c, app, bin } = await setup(version, OLD_AUTO_KEY);
    const r = ok(await o.a('coolify.logs', { serverId: srv, uuid: 'shopapp01' }));
    assert.deepEqual(r.lines, ['app line 1', 'app line 2']);
    assert.equal(r.through, 'docker logs');
    assert.match(r.untrusted, /data, not instructions/);
    assert.ok(c.seen.some((x) => x.path.startsWith('/applications/shopapp01/logs')), 'Coolify was asked first');
    assert.ok(bin.dockerCalls().every((a) => a[0] !== 'logs' || a.at(-1) !== 'shopapp01-pr-7'), 'a preview’s container isn’t read');
    const part = ok(await o.a('part.logs', { serverId: srv, part: 'coolify:shopapp01', grep: 'LINE 2' }));
    assert.deepEqual([part.lines, part.through], [['app line 2'], 'docker logs'], 'part.logs gets them too, its grep works, and it says how');
    assert.doesNotMatch(leaked(app), new RegExp(OLD_AUTO_KEY.slice(2)));
  }
});

test('up to 4.3 the key may read an app’s logs from Coolify; a stopped app still has docker logs', async () => {
  const { o, srv, c, bin } = await setup('4.3.23', OLD_AUTO_KEY);
  assert.deepEqual(ok(await o.a('coolify.logs', { serverId: srv, uuid: 'shopapp01' })).lines, ['from the api']);
  assert.equal(bin.dockerCalls().filter((a) => a[0] === 'logs').length, 0, 'no docker when Coolify answers');
  // Coolify answers 400 for an app that isn't running
  c.apps.shopapp01.status = 'exited';
  const part = ok(await o.h('part.logs', { serverId: srv, part: 'coolify:shopapp01', sinceMinutes: 30 }));
  assert.deepEqual(part.lines.length, 2, 'a time filter goes straight to docker logs, which Coolify’s route can’t do');
});

test('an old Coolify: databases and services have no log route before 4.2, so it isn’t “deleted”', async () => {
  const { o, srv } = await setup('4.1.3', OLD_AUTO_KEY);
  assert.deepEqual(ok(await o.a('coolify.logs', { serverId: srv, uuid: 'relaydb01', kind: 'database' })).lines, ['db line']);
  const gone = await o.a('coolify.logs', { serverId: srv, uuid: 'nothing01', kind: 'database' });
  assert.equal(error(gone).code, 'not_found', 'nothing on the server either: then Coolify’s answer stands');
});

test('a service: Coolify needs a part’s name, so docker logs reads each part when none is given, or the one asked for', async () => {
  const { o, srv, c } = await setup('4.3.23', OLD_AUTO_KEY);
  const all = ok(await o.a('coolify.logs', { serverId: srv, uuid: 'shopsupa01', kind: 'service' }));
  assert.deepEqual(all.lines.sort(), ['imgproxy-shopsupa01: img line', 'supabase-kong-shopsupa01: kong line', 'supabase-studio-shopsupa01: studio line']);
  assert.deepEqual(ok(await o.a('coolify.logs', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'supabase-kong' })).lines, ['from the api']);
  assert.ok(c.seen.some((x) => x.path.includes('sub_service_name=supabase-kong')));
  const key = await setup('4.4.0', OLD_AUTO_KEY);
  assert.deepEqual(ok(await key.o.a('coolify.logs', { serverId: key.srv, uuid: 'shopsupa01', kind: 'service', part: 'supabase-kong' })).lines, ['kong line'], 'with no permission, that part alone');
});

test('a build log: hidden from a key without read:sensitive on every version, so it comes from Coolify’s own record', async () => {
  for (const version of ['4.1.3', '4.3.23', '4.4.0'] as const) {
    const { o, srv, calls } = await setup(version, AUTO_KEY);
    assert.deepEqual(ok(await o.a('coolify.logs', { serverId: srv, uuid: 'shopapp01', deployment: 'dep2' })).lines, ['npm ERR! from the record']);
    assert.ok(calls.some((x) => x.command === COOLIFY_PHP && x.stdin.includes('unit7:deployment_log')));
  }
  const root = await setup('4.4.0', ROOT_KEY);
  assert.deepEqual(ok(await root.o.a('coolify.logs', { serverId: root.srv, uuid: 'shopapp01', deployment: 'dep2' })).lines, ['from the api'], 'a key that may read it has no need');
  assert.ok(!root.calls.some((x) => x.stdin.includes('unit7:deployment_log')));
  // a failed deploy brings the end of its log with it
  const bad = await setup('4.4.0', AUTO_KEY);
  bad.c.apps.broken01 = { uuid: 'broken01' };
  const d = ok(await bad.o.h('coolify.control', { serverId: bad.srv, uuid: 'broken01', action: 'deploy' }));
  assert.equal(d.status, 'failed');
  assert.deepEqual(d.logTail, ['npm ERR! from the record']);
});

// --- wiring with the automatic key --------------------------------------------------------------------------------------
const NEW_SUPABASE = (srv: string) => ({ serverId: srv, project: 'proj01', type: 'supabase', name: 'Shop Supabase new', injectInto: 'shopapp01', nextPublic: true });
test('Supabase wiring without read:sensitive: the same values come from the running stack, straight into the app', async () => {
  const { o, srv, c, app, bin } = await setup('4.4.0', AUTO_KEY);
  bin.write({ containers: CONTAINERS.map((x) => ({ ...x, labels: x.labels.map((l) => l.replace('shopsupa01', 'supa9')) })), logs: LOGS });
  const r = ok(await o.a('coolify.create_service', NEW_SUPABASE(srv)));
  assert.deepEqual(r.wired, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);
  assert.deepEqual(Object.fromEntries(c.bulk.map((v) => [v.key, v.value])), { SUPABASE_URL: 'https://api.shop.example.com', SUPABASE_ANON_KEY: ANON, NEXT_PUBLIC_SUPABASE_URL: 'https://api.shop.example.com', NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON });
  assert.doesNotMatch(JSON.stringify(r), /anonKeyValue/, 'never in a result');
  assert.doesNotMatch(leaked(app), /anonKeyValue/, 'nor in audit or events');
  const k = await setup('4.3.23', ROOT_KEY);
  ok(await k.o.a('coolify.create_service', NEW_SUPABASE(k.srv)));
  assert.equal(k.bin.dockerCalls().filter((a) => a[0] === 'inspect').length, 0, 'a key that can read them doesn’t need the server');
});

test('Supabase wiring when the stack isn’t up: plain words and nothing half set', async () => {
  const { o, srv, c, bin } = await setup('4.4.0', AUTO_KEY);
  bin.write({ containers: [], logs: {} });
  const r = await o.h('coolify.create_service', NEW_SUPABASE(srv));
  assert.equal(error(r).code, 'coolify_permission');
  assert.match(error(r).message, /running/);
  assert.equal(c.bulk.length, 0);
});

test('an existing database’s address, hidden without read:sensitive, is read from Coolify’s record and goes straight into the app', async () => {
  const { o, srv, c, app } = await setup('4.4.0', AUTO_KEY);
  const r = ok(await o.h('coolify.create_database', { serverId: srv, project: 'proj02', engine: 'postgresql', name: 'relay-db', injectInto: 'shopapp01' }));
  assert.equal(r.reused, true);
  assert.deepEqual(r.wired, ['DATABASE_URL']);
  assert.equal(c.bulk[0].value, 'postgres://u:from-php@relaydb01:5432/app');
  assert.doesNotMatch(JSON.stringify(r) + leaked(app), /from-php/);
});

// --- part.update ------------------------------------------------------------------------------------------------------------
test('part.update on Coolify: the fresh copy comes first, and no copy means no update', async () => {
  const { o, srv, calls, app, bin } = await setup();
  const done = ok(await o.h('part.update', { serverId: srv, part: 'coolify:relaydb01', confirm: 'relay-db' }));
  assert.equal(done.through, 'Coolify');
  const dump = calls.findIndex((x) => x.command.includes('pg_dumpall')), deploy = calls.findIndex((x) => x.stdin.includes('/deploy?uuid=relaydb01'));
  assert.ok(dump >= 0, 'a dump was taken');
  assert.ok(dump < deploy, 'before the deploy');
  assert.match(get<{ summary: string }>(app.db, `SELECT summary FROM changes WHERE verb = 'backup'`)!.summary, /before it would update it/);

  bin.write({ containers: CONTAINERS, logs: LOGS, dumpFails: true });
  const before = calls.filter((x) => x.stdin.includes('/deploy?uuid=relaydb01')).length;
  const r = await o.h('part.update', { serverId: srv, part: 'coolify:relaydb01', confirm: 'relay-db' });
  assert.equal(r.status, 'error');
  assert.match(error(r).message, /came out empty/);
  assert.equal(calls.filter((x) => x.stdin.includes('/deploy?uuid=relaydb01')).length, before, 'nothing deployed');
  // an app has no data to copy: straight to the deploy, as before
  ok(await o.h('part.update', { serverId: srv, part: 'coolify:shopapp01' }));
  assert.equal(calls.filter((x) => x.stdin.includes('/deploy?uuid=shopapp01')).length, 1);
});

// --- deploy keys ---------------------------------------------------------------------------------------------------------------
const CREATE = (srv: string, extra: Record<string, unknown> = {}) => ({ serverId: srv, project: 'proj01', name: 'Shop two', repo: 'example/shop', ...extra });
async function github(answer: (r: Req) => unknown, app: App, orgId: string) {
  const g = await fakeApi(answer);
  process.env.UNIT7_GITHUB_API = g.base;
  closers.push(() => { g.close(); delete process.env.UNIT7_GITHUB_API; });
  account(app, orgId, 'github', 'ghp_faketoken00000000');
  return g;
}
const repoSaysPrivate = (r: Req) => {
  if (r.method === 'GET' && r.path === '/repos/example/shop') return { private: true, default_branch: 'trunk', permissions: { admin: true } };
  if (r.method === 'POST' && r.path === '/repos/example/shop/keys') return [201, { id: 77 }];
  if (r.method === 'DELETE') return [204, ''];
  if (r.method === 'GET' && r.path.startsWith('/repos/example/shop/hooks')) return [];
  if (r.method === 'POST' && r.path === '/repos/example/shop/hooks') return [201, { id: 9 }];
  return undefined;
};

test('a private repo with no GitHub App: a key pair for this app, the private half only ever in Coolify', async () => {
  const { o, srv, c, app, calls } = await setup();
  const g = await github(repoSaysPrivate, app, o.orgId);
  const r = ok(await o.h('coolify.create_app', CREATE(srv)));
  assert.equal(c.made[0].route, 'private-deploy-key');
  assert.deepEqual([c.made[0].git_repository, c.made[0].private_key_uuid, c.made[0].git_branch], ['git@github.com:example/shop.git', 'key1', 'trunk']);
  assert.match(c.keys[0].private_key, /^-----BEGIN OPENSSH PRIVATE KEY-----/);
  const added = JSON.parse(g.calls.find((x) => x.method === 'POST')!.body);
  assert.match(added.key, /^ssh-ed25519 /);
  assert.equal(added.read_only, true);
  assert.equal(g.calls.find((x) => x.method === 'POST')!.auth, 'Bearer ghp_faketoken00000000');
  assert.deepEqual([r.deployKey.coolify, r.deployKey.github], ['key1', 77]);
  assert.match(r.from, /deploy key/);
  assert.doesNotMatch(JSON.stringify(r) + leaked(app), /PRIVATE KEY/);
  assert.ok(calls.every((x) => !x.command.includes('PRIVATE KEY')), 'never on a command line');
  assert.equal(get<{ n: number }>(app.db, `SELECT count(*) n FROM secrets WHERE kind = 'ssh_key'`)!.n, 0, 'and not kept in the vault either');
});

test('a public repo stays public, a GitHub App still wins, and without GitHub connected auto does what it always did', async () => {
  const pub = await setup();
  await github((r) => (r.method === 'GET' ? { private: false, default_branch: 'main' } : undefined), pub.app, pub.o.orgId);
  ok(await pub.o.h('coolify.create_app', CREATE(pub.srv)));
  assert.equal(pub.c.made[0].route, 'public');
  assert.equal(pub.c.keys.length, 0);

  const via = await setup();
  via.c.githubApps.push({ id: 3, uuid: 'ghapp1', name: 'Our app', is_public: false });
  const g = await github(repoSaysPrivate, via.app, via.o.orgId);
  ok(await via.o.h('coolify.create_app', CREATE(via.srv, { repo: 'example/viaapp' })));
  assert.equal(via.c.made[0].route, 'private-github-app');
  assert.equal(g.calls.length, 0, 'no need to ask GitHub');

  const none = await setup();
  ok(await none.o.h('coolify.create_app', CREATE(none.srv)));
  assert.equal(none.c.made[0].route, 'public');
  const must = await none.o.h('coolify.create_app', CREATE(none.srv, { source: 'deploy-key' }));
  assert.equal(error(must).code, 'no_account');
  assert.match(error(must).message, /Connect GitHub/);
});

test('a repo the account can’t see, or can’t add keys to: said before anything is made', async () => {
  const hidden = await setup();
  await github(() => undefined, hidden.app, hidden.o.orgId);
  assert.equal(error(await hidden.o.h('coolify.create_app', CREATE(hidden.srv))).code, 'no_repo');
  assert.equal(hidden.c.keys.length + hidden.c.made.length, 0);

  const reader = await setup();
  await github((r) => (r.method === 'GET' ? { private: true, permissions: { admin: false } } : undefined), reader.app, reader.o.orgId);
  const r = await reader.o.h('coolify.create_app', CREATE(reader.srv));
  assert.equal(error(r).code, 'no_repo_admin');
  assert.match(error(r).message, /admin rights/);
  assert.equal(reader.c.keys.length, 0);
});

test('if GitHub or Coolify says no halfway, this call takes back the keys it made, and only those', async () => {
  const refused = await setup();
  await github((r) => (r.method === 'POST' ? [403, { message: 'Resource not accessible by integration' }] : repoSaysPrivate(r)), refused.app, refused.o.orgId);
  const r = await refused.o.h('coolify.create_app', CREATE(refused.srv));
  assert.equal(error(r).code, 'deploy_key');
  assert.deepEqual([refused.c.keys.length, refused.c.made.length], [0, 0]);

  const bad = await setup();
  bad.c.failApp = true;
  bad.c.keys.push({ uuid: 'theirs', name: 'someone else’s key' });
  const g = await github(repoSaysPrivate, bad.app, bad.o.orgId);
  assert.equal(error(await bad.o.h('coolify.create_app', CREATE(bad.srv))).code, 'coolify_rejected');
  assert.deepEqual(bad.c.keys.map((k) => k.uuid), ['theirs']);
  assert.ok(g.calls.some((x) => x.method === 'DELETE' && x.path === '/repos/example/shop/keys/77'));
});

// --- deploy on push and previews ---------------------------------------------------------------------------------------------
test('deploy on push: an app with a deploy key needs a webhook, and the secret stays between Coolify and GitHub', async () => {
  const { o, srv, c, app } = await setup();
  const g = await github(repoSaysPrivate, app, o.orgId);
  const r = ok(await o.h('coolify.auto_deploy', { serverId: srv, uuid: 'shopapp01', on: true }));
  assert.deepEqual([r.changed, r.on, r.webhook], [true, true, 9]);
  assert.equal(c.apps.shopapp01.settings.is_auto_deploy_enabled, true);
  const hook = JSON.parse(g.calls.find((x) => x.method === 'POST')!.body);
  assert.deepEqual(hook.events, ['push', 'pull_request']);
  assert.equal(hook.config.url, 'https://coolify.example.com/webhooks/source/github/events/manual?app=shopapp01');
  assert.equal(hook.config.secret, c.apps.shopapp01.manual_webhook_secret_github);
  assert.doesNotMatch(JSON.stringify(r) + leaked(app), new RegExp(hook.config.secret));

  const u = ok(await o.h('change.undo', { changeId: r.changeId }));
  assert.match(u.undone, /deploy on push/);
  assert.equal(c.apps.shopapp01.settings.is_auto_deploy_enabled, false);
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM changes WHERE id = ?', r.changeId)!.status, 'undone');
});

test('previews: a webhook already on the repo is left alone with its secret, and a GitHub App needs none', async () => {
  const { o, srv, c, app } = await setup();
  const g = await github((r) => (r.method === 'GET' && r.path.startsWith('/repos/example/shop/hooks') ? [{ id: 1, config: { url: 'https://coolify.example.com/webhooks/source/github/events/manual' } }] : repoSaysPrivate(r)), app, o.orgId);
  c.apps.shopapp01.manual_webhook_secret_github = 'a-persons-own-secret';
  const r = ok(await o.h('coolify.previews', { serverId: srv, uuid: 'shopapp01', on: true }));
  assert.match(r.hears, /already there/);
  assert.match(r.note, /wildcard DNS/);
  assert.equal(c.apps.shopapp01.manual_webhook_secret_github, 'a-persons-own-secret');
  assert.equal(g.calls.filter((x) => x.method === 'POST').length, 0);

  g.calls.length = 0;
  const via = ok(await o.h('coolify.previews', { serverId: srv, uuid: 'viaapp01', on: true }));
  assert.match(via.hears, /GitHub App/);
  assert.equal(g.calls.length, 0);
  assert.equal(ok(await o.h('coolify.previews', { serverId: srv, uuid: 'viaapp01', on: true })).changed, false, 'twice changes nothing');
});

test('two apps on one repo: each has its own webhook, because Coolify checks a push against each app’s own secret', async () => {
  const { o, srv, app } = await setup();
  const g = await github((r) => (r.method === 'GET' && r.path.startsWith('/repos/example/shop/hooks') ? [{ id: 1, config: { url: 'https://coolify.example.com/webhooks/source/github/events/manual?app=otherapp1' } }] : repoSaysPrivate(r)), app, o.orgId);
  assert.equal(ok(await o.h('coolify.auto_deploy', { serverId: srv, uuid: 'shopapp01', on: true })).webhook, 9);
  assert.equal(g.calls.filter((x) => x.method === 'POST').length, 1);
});

test('the switches: no GitHub says how, an image has no repo, an AI asks first, and turning off leaves the webhook', async () => {
  const { o, srv, c } = await setup();
  const r = ok(await o.h('coolify.auto_deploy', { serverId: srv, uuid: 'shopapp01', on: true }));
  assert.equal(c.apps.shopapp01.settings.is_auto_deploy_enabled, true, 'the switch is set either way');
  assert.match(r.next, /GitHub isn’t connected/);
  assert.match(r.next, /Webhooks page/);
  assert.equal(error(await o.h('coolify.auto_deploy', { serverId: srv, uuid: 'imgapp01', on: true })).code, 'no_repo');
  assert.equal((await o.a('coolify.auto_deploy', { serverId: srv, uuid: 'shopapp01', on: false })).status, 'approval_required');
  const off = ok(await o.h('coolify.auto_deploy', { serverId: srv, uuid: 'shopapp01', on: false }));
  assert.deepEqual([off.on, off.changed], [false, true]);
  assert.equal(off.webhook, undefined);
});

test('an old Coolify: previews through the API came in 4.2, and it says so instead of “rejected”', async () => {
  const { o, srv, app } = await setup('4.1.3');
  const r = await o.h('coolify.previews', { serverId: srv, uuid: 'shopapp01', on: true });
  assert.equal(error(r).code, 'coolify_too_old');
  assert.match(error(r).message, /Coolify 4\.1\.3 can’t turn pull request previews on or off through its API \(that came in 4\.2\)/);
  assert.equal(get(app.db, `SELECT 1 FROM changes WHERE verb = 'coolify.setting'`), undefined, 'nothing to undo');
  ok(await o.h('coolify.auto_deploy', { serverId: srv, uuid: 'shopapp01', on: true }));
});

// --- storage ---------------------------------------------------------------------------------------------------------------------
test('storage: list, add, remove behind a person, and undo brings the same data back', async () => {
  const { o, srv, c, app } = await setup();
  const list = ok(await o.a('coolify.storage', { serverId: srv, uuid: 'shopapp01' }));
  assert.deepEqual(list.volumes.map((v: { mountPath: string }) => v.mountPath), ['/app/uploads', '/app/cache']);
  assert.deepEqual(list.files, [{ uuid: 'file1', path: '/app/config.yml' }]);

  const add = ok(await o.h('coolify.storage', { serverId: srv, uuid: 'shopapp01', op: 'add', name: 'media', mountPath: '/app/media' }));
  assert.match(add.next, /next deploy/);
  assert.deepEqual(c.seen.find((x) => x.method === 'POST' && x.path.endsWith('/storages'))!.body, { type: 'persistent', name: 'media', mount_path: '/app/media' });
  assert.equal(ok(await o.h('coolify.storage', { serverId: srv, uuid: 'shopapp01', op: 'add', name: 'other', mountPath: '/app/media' })).reused, true, 'that folder has one already');
  assert.equal((await o.h('coolify.storage', { serverId: srv, uuid: 'shopapp01', op: 'add', name: 'x', mountPath: '/app/../etc' })).status, 'error');
  assert.equal((await o.h('coolify.storage', { serverId: srv, uuid: 'shopapp01', op: 'add', name: 'x', mountPath: '/' })).status, 'error');

  // removing: an AI only ever asks, at any autonomy, and a person types the name
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const asked = await o.a('coolify.storage', { serverId: srv, uuid: 'shopapp01', op: 'remove', storage: 'vol1' });
  assert.equal(asked.status, 'approval_required');
  assert.equal(c.storages.length, 3, 'nothing removed yet');
  assert.equal(error(await o.h('coolify.storage', { serverId: srv, uuid: 'shopapp01', op: 'remove', storage: 'vol1' })).code, 'confirm_needed');
  const gone = ok(await o.h('coolify.storage', { serverId: srv, uuid: 'shopapp01', op: 'remove', storage: 'vol1', confirm: 'shopapp01-uploads' }));
  assert.deepEqual([gone.dataKept, c.storages.some((v) => v.uuid === 'vol1')], [true, false]);
  const undo = ok(await o.h('change.undo', { changeId: gone.changeId }));
  assert.match(undo.restored, /uploads/);
  assert.ok(c.storages.some((v) => v.name === 'shopapp01-uploads' && v.mount_path === '/app/uploads'), 'the same volume name, so the same data');

  // a name Coolify didn't make can't be asked for again through its API: no undo promised
  const own = ok(await o.h('coolify.storage', { serverId: srv, uuid: 'shopapp01', op: 'remove', storage: 'vol2', confirm: 'my-own-volume' }));
  assert.equal(own.changeId, undefined);
  assert.match(own.note, /my-own-volume/);
  // a file mount's removal deletes it from the server
  assert.equal(error(await o.h('coolify.storage', { serverId: srv, uuid: 'shopapp01', op: 'remove', storage: 'file1', confirm: 'x' })).code, 'file_mount');
  assert.equal(c.files.length, 1);
  assert.doesNotMatch(leaked(app), new RegExp(AUTO_KEY.slice(2)));
});

test('storage by version: before the last 4.0 betas there’s no route, and from 4.6 removing needs its own permission', async () => {
  const old = await setup('4.0.0-beta.450');
  const r = await old.o.h('coolify.storage', { serverId: old.srv, uuid: 'shopapp01' });
  assert.equal(error(r).code, 'coolify_too_old');
  assert.match(error(r).message, /Coolify 4\.0\.0-beta\.450 can’t list storage/);
  assert.equal(error(await old.o.h('coolify.storage', { serverId: old.srv, uuid: 'nothing01' })).code, 'not_found', 'an app that isn’t there is still that');

  const fresh = await setup('4.6.0', AUTO_KEY);
  ok(await fresh.o.h('coolify.storage', { serverId: fresh.srv, uuid: 'shopapp01', op: 'remove', storage: 'vol1', confirm: 'shopapp01-uploads' }));
  const key = await setup('4.6.0', OLD_AUTO_KEY);
  const no = await key.o.h('coolify.storage', { serverId: key.srv, uuid: 'shopapp01', op: 'remove', storage: 'vol1', confirm: 'shopapp01-uploads' });
  assert.equal(error(no).code, 'coolify_permission');
  assert.match(error(no).message, /needs the "delete" permission.*coolify\.connect with auto/);
  assert.equal(key.c.storages.length, 2);
  // 4.5 and older take a delete with write: the older key is fine there
  const before = await setup('4.4.0', OLD_AUTO_KEY);
  ok(await before.o.h('coolify.storage', { serverId: before.srv, uuid: 'shopapp01', op: 'remove', storage: 'vol1', confirm: 'shopapp01-uploads' }));
});

test('a service’s volume belongs to one of its parts', async () => {
  const { o, srv, c } = await setup();
  assert.match(error(await o.h('coolify.storage', { serverId: srv, uuid: 'shopsupa01', kind: 'service', op: 'add', name: 'more', mountPath: '/data/more' })).message, /resource/);
  ok(await o.h('coolify.storage', { serverId: srv, uuid: 'shopsupa01', kind: 'service', op: 'add', name: 'more', mountPath: '/data/more', resource: 'supabasedb1' }));
  assert.equal(c.storages.at(-1).name, 'supabasedb1-more');
});

// --- scale ---------------------------------------------------------------------------------------------------------------------------
test('more copies: Coolify says no on plain Docker, and on Swarm its API can’t set them, so nothing is sent', async () => {
  const { o, srv, c } = await setup();
  const r = ok(await o.a('coolify.scale', { serverId: srv, uuid: 'shopapp01', replicas: 3 }));
  assert.equal(r.scalable, false);
  assert.match(r.why, /one container/);
  assert.ok(r.instead.some((x: string) => /coolify\.memory_cap/.test(x)));
  assert.match(ok(await o.a('coolify.scale', { serverId: srv, uuid: 'shopsupa01', kind: 'service' })).why, /no replicas/);
  c.swarm = true;
  assert.match(ok(await o.a('coolify.scale', { serverId: srv, uuid: 'shopapp01' })).why, /Swarm Configuration/);
  assert.equal(c.seen.filter((x) => x.method === 'PATCH').length, 0);
});

// --- a service's compose ------------------------------------------------------------------------------------------------------------
test('compose edits touch only their lines: comments stay, a cap replaces a cap, and undo is exact', () => {
  assert.deepEqual(composeParts(COMPOSE), [
    { part: 'supabase-db', memory: '1g', health: false }, { part: 'supabase-kong', health: true }, { part: 'supabase-studio', health: false }, { part: 'imgproxy', health: false },
  ]);
  const capped = composeEdit(COMPOSE, 'imgproxy', { memory: '256m' });
  assert.match(capped, /imgproxy:\n {4}mem_limit: 256m\n {4}image:/);
  assert.match(capped, /# the database/);
  assert.equal(composeEdit(capped, 'imgproxy', { memory: null }), COMPOSE);
  const twice = composeEdit(COMPOSE, 'supabase-db', { memory: '2g' });
  assert.equal(twice.match(/mem_limit/g)!.length, 1);
  assert.deepEqual(composeParts(twice)[0], { part: 'supabase-db', memory: '2g', health: false });
  assert.equal(composeEdit(twice, 'supabase-db', { memory: '1g' }).split('\n').filter((l) => l.includes('mem_limit')).length, 1);
  assert.throws(() => composeEdit(COMPOSE, 'supabase-studio', { memory: '1g' }), /deploy\.resources/);
  assert.throws(() => composeEdit(COMPOSE, 'nope', { memory: '1g' }), /no part called nope/);
  const checked = composeEdit(COMPOSE, 'imgproxy', { health: { port: 8080, path: '/health' } });
  assert.match(checked, /imgproxy:\n {4}healthcheck:\n {6}test:\n {8}- CMD-SHELL\n {8}- 'curl -fsS http:\/\/127\.0\.0\.1:8080\/health >\/dev\/null \|\| wget/);
  assert.equal(composeParts(checked).at(-1)!.health, true);
  assert.equal(composeEdit(checked, 'imgproxy', { health: null }), COMPOSE);
  assert.match(composeEdit(COMPOSE.replace(/\n/g, '\r\n'), 'imgproxy', { memory: '1g' }), /mem_limit: 1g/);
});

test('a memory cap on a service: through its compose, read from Coolify’s record without read:sensitive, with an undo', async () => {
  let saved: string | undefined;
  const { o, srv, c, app, calls } = await setup('4.4.0', AUTO_KEY, { php: { compose: () => saved ?? COMPOSE } });
  const which = await o.h('coolify.memory_cap', { serverId: srv, uuid: 'shopsupa01', kind: 'service', memoryMb: 512 });
  assert.equal(error(which).code, 'which_part');
  assert.match(error(which).message, /supabase-db, supabase-kong/);
  const r = ok(await o.h('coolify.memory_cap', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'imgproxy', memoryMb: 512 }));
  assert.equal(r.part, 'imgproxy');
  assert.match(r.next, /next restart/);
  assert.match(c.compose, /imgproxy:\n {4}mem_limit: 512m/);
  assert.ok(calls.some((x) => x.stdin.includes('unit7:service_compose')));
  assert.ok(!c.seen.some((x) => /\/restart|\/deploy\?uuid/.test(x.path)), 'nothing restarted');
  saved = c.compose;
  ok(await o.h('change.undo', { changeId: r.changeId }));
  assert.equal(c.compose, COMPOSE);
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM changes WHERE id = ?', r.changeId)!.status, 'undone');

  // a cap that was there comes back as it was
  saved = undefined;
  const again = ok(await o.h('coolify.memory_cap', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'supabase-db', memoryMb: 2048 }));
  saved = c.compose;
  ok(await o.h('change.undo', { changeId: again.changeId }));
  assert.match(c.compose, /mem_limit: 1g/);
  assert.equal((await o.a('coolify.memory_cap', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'imgproxy', memoryMb: 512 })).status, 'approval_required');
  // an application still goes the old way
  ok(await o.h('coolify.memory_cap', { serverId: srv, uuid: 'shopapp01', memoryMb: 512 }));
  assert.equal(c.apps.shopapp01.limits_memory, '512m');
});

test('with read:sensitive the compose comes straight from Coolify’s API', async () => {
  const { o, srv, c, calls } = await setup('4.4.0', ROOT_KEY);
  ok(await o.h('coolify.memory_cap', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'imgproxy', memoryMb: 512 }));
  assert.match(c.compose, /mem_limit: 512m/);
  assert.ok(!calls.some((x) => x.stdin.includes('unit7:service_compose')));
});

test('a health check on a service: which parts have one, then one added to a part after it’s found a page, and undo takes it out', async () => {
  let saved: string | undefined;
  const { o, srv, c, bin } = await setup('4.4.0', AUTO_KEY, { php: { compose: () => saved ?? COMPOSE } });
  bin.write({ containers: CONTAINERS, logs: LOGS, pages: ['/health'] });
  const look = ok(await o.a('coolify.health_check', { serverId: srv, uuid: 'shopsupa01', kind: 'service' }));
  assert.deepEqual(look.parts.filter((p: { healthCheck: boolean }) => p.healthCheck).map((p: { part: string }) => p.part), ['supabase-kong']);
  assert.equal(ok(await o.h('coolify.health_check', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'supabase-kong' })).changed, false);
  assert.match(error(await o.h('coolify.health_check', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'imgproxy' })).message, /port/);
  const r = ok(await o.h('coolify.health_check', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'imgproxy', port: 8080 }));
  assert.deepEqual([r.changed, r.path], [true, '/health']);
  assert.match(c.compose, /imgproxy:\n {4}healthcheck:/);
  assert.match(c.compose, /127\.0\.0\.1:8080\/health/);
  assert.ok(bin.dockerCalls().some((a) => a[0] === 'exec' && a[1] === 'imgproxy-shopsupa01'), 'its container, by Coolify’s name for it');
  saved = c.compose;
  ok(await o.h('change.undo', { changeId: r.changeId }));
  assert.equal(c.compose, COMPOSE);

  bin.write({ containers: CONTAINERS, logs: LOGS, pages: [] });
  saved = undefined;
  assert.equal(error(await o.h('coolify.health_check', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'imgproxy', port: 8080 })).code, 'no_health_page');
  assert.equal(c.compose, COMPOSE, 'no page, no change');
  assert.equal((await o.a('coolify.health_check', { serverId: srv, uuid: 'shopsupa01', kind: 'service', part: 'imgproxy', port: 8080 })).status, 'approval_required');
});

// --- Coolify's projects, as projects ------------------------------------------------------------------------------------------------
test('what server.xray finds shows in project.list and graph.get, with one id readiness, passport and clients all take', async () => {
  const { o, srv, app } = await setup();
  ok(await o.h('server.xray', { serverId: srv }));
  const list = ok(await o.a('project.list'));
  const shop = list.find((p: { name: string }) => p.name === 'Shop');
  assert.ok(shop, 'Coolify’s own name for it');
  assert.match(shop.id, /^ast_/);
  assert.deepEqual([shop.source, shop.serverId, shop.server, shop.coolifyProject], ['coolify', srv, 'box', 'proj01']);
  assert.equal(list.filter((p: { source?: string }) => p.source === 'coolify').length, 4, 'relay, shop, crm, ledger: Coolify’s own containers aren’t a project');
  assert.deepEqual(shop.environments.map((e: { apps: { name: string; kind: string }[] }) => e.apps.map((a) => a.kind)), [['app', 'database']], 'its apps and stacks, not their volumes');
  const web = shop.environments[0].apps.find((a: { uuid: string }) => a.uuid === 'shopapp01');
  assert.deepEqual([web.name, web.part, web.type], ['Shop web', 'coolify:shopapp01', 'application']);
  assert.ok(shop.domains.includes('shop.example.com'));

  const g = ok(await o.a('graph.get'));
  assert.deepEqual(g.projects, [], 'Unit7’s own list is unchanged: its pages link to /projects/<id>');
  assert.equal(g.foundProjects.length, 4);
  const one = ok(await o.a('graph.get', { projectId: shop.id }));
  assert.deepEqual(one.foundProjects.map((p: { name: string }) => p.name), ['Shop']);

  const ready = ok(await o.a('project.readiness', { projectId: shop.id }));
  assert.equal(ready.projectId, shop.id);
  assert.equal(ready.name, 'Shop');
  assert.ok(ready.checks.some((c: { key: string }) => c.key === 'domain'));
  const every = ok(await o.a('project.readiness')).projects;
  assert.ok(every.some((p: { projectId: string; name: string }) => p.projectId === shop.id && p.name === 'Shop'), 'every project’s score has it too');

  const passport = ok(await o.a('project.passport', { project: shop.id }));
  assert.equal(passport.name, 'Shop');
  assert.match(passport.markdown, /Coolify/);
  assert.doesNotMatch(passport.markdown, /sup3rs3cret/);
  assert.equal(error(await o.a('project.passport', { project: 'shop' })).code, 'invalid_input', 'a name still needs its server');
  assert.equal(ok(await o.a('project.passport', { serverId: srv, project: 'Shop' })).name, 'Shop');

  const client = ok(await o.h('client.create', { name: 'Bakery' }));
  const moved = ok(await o.h('client.assign', { clientId: client.clientId, key: shop.id }));
  assert.deepEqual([moved.key, moved.name], [shop.id, 'Shop']);
  const row = ok(await o.h('client.list')).clients[0];
  assert.deepEqual(row.members.map((m: { key: string; name: string }) => [m.key, m.name]), [[shop.id, 'Shop']]);
});

test('an archived Coolify project leaves the lists, like everything else archived', async () => {
  const { o, srv, app } = await setup();
  ok(await o.h('server.xray', { serverId: srv }));
  const shop = ok(await o.a('project.list')).find((p: { name: string }) => p.name === 'Shop');
  run(app.db, 'INSERT INTO archived (org_id, key, name, kind) VALUES (?, ?, ?, ?)', o.orgId, shop.id, 'Shop', 'project');
  assert.equal(ok(await o.a('project.list')).some((p: { id: string }) => p.id === shop.id), false);
  assert.equal(ok(await o.a('graph.get')).foundProjects.some((p: { id: string }) => p.id === shop.id), false);
  assert.equal(ok(await o.a('project.readiness')).projects.some((p: { projectId: string }) => p.projectId === shop.id), false);
});

test('the id doesn’t reach what Unit7 can’t do to them, or another organisation', async () => {
  const { o, srv, app } = await setup();
  ok(await o.h('server.xray', { serverId: srv }));
  const shop = ok(await o.a('project.list')).find((p: { name: string }) => p.name === 'Shop');
  assert.equal((await o.h('project.update', { projectId: shop.id, name: 'x' })).status, 'error');
  assert.equal((await o.h('project.delete', { projectId: shop.id, confirm: 'x' })).status, 'error');
  assert.equal((await o.h('environment.create', { projectId: shop.id, name: 'qa' })).status, 'error');
  const other = await testOrg(app, 'Bo');
  assert.equal(error(await other.h('project.readiness', { projectId: shop.id })).code, 'not_found');
  assert.equal(error(await other.h('graph.get', { projectId: shop.id })).code, 'not_found');
  assert.equal(error(await other.h('project.passport', { project: shop.id })).code, 'invalid_input', 'no server of its own, and nothing of the other organisation’s');
  assert.deepEqual(ok(await other.h('project.list')), []);
});
