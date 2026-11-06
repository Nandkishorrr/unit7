// Access to self-hosted apps on a server: found from the X-ray, a scoped credential made through each app's own way,
// secrets only ever on the SSH command's stdout (never a command line, file, log, audit row, event or result), the
// vault for every one, people-only reveals, disconnect and Undo that take back what Unit7 made, wiring through
// links, and auto-connect only at Full autopilot outside production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { buildInventory, type Inventory } from '../src/discovery/xray.ts';
import { saveXray } from '../src/tools/xray.ts';
import { decideApproval, type Actor } from '../src/tools/runtime.ts';
import { ADAPTERS, DROP_ROLE_SQL, MYSQL, PSQL, PSQL_SUPABASE, ROLE, adapterOf, keysTemplate, make, parseKeys, readKeys } from '../src/serverapps/adapters.ts';
import { serverAppSuggestions } from '../src/tools/serverapps.ts';
import { COMPOSE_HOST, COOLIFY_HOST, ctr, probe } from './xray-fixtures.ts';

// --- made-up secrets the stand-in server prints, and must never show up anywhere but the vault -----------------------
const S = {
  anon: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.YW5vbnNpZ25hdHVyZTEyMw', service: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2VydmljZXNpZ25hdHVyZQ',
  dash: 'dashPassw0rdXyz', pw: 'a3f9c2e81b7d4056a3f9c2e81b7d4056a3f9c2e81b7d4056', minio: 'minioSecretKey1234567890', grafana: 'glsa_viewerToken0123456789abcdef',
  n8n: 'n8nApiKeyPasted1234567890', redisRoot: 'redisRootPassw0rd99',
};
const ALL = Object.values(S);

// a host with the other apps: n8n, MinIO, Grafana, MySQL, MongoDB, Redis, and a Postgres in a Coolify staging environment
const HOST = 'os=Ubuntu 24.04.1 LTS\ncpus=4\nmem_total=16000000000\nmem_available=9000000000\ndisk_total=200000000000\ndisk_used=59000000000\nload=0.3\ndocker=27.3.1\nuser=root\nhas_docker=1';
const compose = (project: string, service: string) => ({ 'com.docker.compose.project': project, 'com.docker.compose.service': service, 'com.docker.compose.project.working_dir': `/srv/${project}` });
const APPS_HOST = probe({
  host: HOST, volumes: '', dangling: '', df: '', ports: '', pids: '', units: '', pm2: '', nginx: '', caddy: '', traefik: '', cron: '', markers: '', git: '',
  ctrs: JSON.stringify([
    ctr({ name: 'stagedb01', image: 'postgres:16-alpine', labels: { 'coolify.managed': 'true', 'coolify.type': 'database', 'coolify.name': 'stagedb01', 'coolify.resourceName': 'shop-staging-db', 'coolify.projectName': 'shop', 'coolify.environmentName': 'staging', 'coolify.databaseUuid': 'stagedb01', 'com.docker.compose.project': 'stagedb01' }, nets: { coolify: [] } }),
    ctr({ name: 'n8n-1', image: 'n8nio/n8n:1.64.0', labels: { ...compose('auto', 'n8n'), 'traefik.http.routers.n8n.rule': 'Host(`n8n.example.com`)' } }),
    ctr({ name: 'files-minio-1', image: 'minio/minio:RELEASE.2025-04-22T22-12-26Z', labels: { ...compose('files', 'minio'), 'traefik.http.routers.s3.rule': 'Host(`s3.example.com`)' } }),
    ctr({ name: 'mon-grafana-1', image: 'grafana/grafana:11.2.0', labels: { ...compose('mon', 'grafana'), 'traefik.http.routers.g.rule': 'Host(`grafana.example.com`)' } }),
    ctr({ name: 'blog-db-1', image: 'mysql:8.4', labels: compose('blog', 'db') }),
    ctr({ name: 'events-mongo-1', image: 'mongo:7', labels: compose('events', 'mongo') }),
    ctr({ name: 'events-cache-1', image: 'redis:7-alpine', labels: compose('events', 'cache') }),
  ]),
});

// --- a stand-in server: records every command and what went in on stdin, answers like the real scripts would ----------
type Reply = { code?: number; stdout?: string; stderr?: string } | undefined;
function fakeServer(app: App, reply: (command: string, stdin: string) => Reply = () => undefined) {
  const seen: { command: string; stdin: string }[] = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    const stdin = String(o.stdin ?? '');
    seen.push({ command, stdin });
    const r = reply(command, stdin) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', truncated: false };
  };
  return seen;
}
const keyLine = (c: string, k: string, v: string) => `/${c}|${JSON.stringify(`${k}=${v}`)}`;
const sec = (name: string, body: string) => `\n@@unit7:${name}\n${body}\n`;
// what each script prints, by what it is
function server(o: { redis?: 'acl' | 'old'; mc?: boolean; grafana?: 'ok' | 'login' } = {}) {
  return (cmd: string): Reply => {
    let out = '';
    if (cmd.includes('@@unit7:keys')) {
      const lines: string[] = [];
      for (const s of ['shopsupa01', 'crmsupa01', 'ledgsupa01']) if (cmd.includes(`'supabase-kong-${s}'`)) lines.push(keyLine(`supabase-kong-${s}`, 'SUPABASE_ANON_KEY', S.anon), keyLine(`supabase-kong-${s}`, 'SUPABASE_SERVICE_KEY', S.service), keyLine(`supabase-kong-${s}`, 'DASHBOARD_USERNAME', 'supabase'), keyLine(`supabase-kong-${s}`, 'DASHBOARD_PASSWORD', S.dash), keyLine(`supabase-kong-${s}`, 'SERVICE_URL_SUPABASEKONG', `https://api.${s.slice(0, 4)}.example.com`));
      if (cmd.includes(`'supabase-kong'`)) lines.push(keyLine('supabase-kong', 'SUPABASE_ANON_KEY', S.anon), keyLine('supabase-kong', 'SUPABASE_SERVICE_KEY', S.service), keyLine('supabase-kong', 'DASHBOARD_PASSWORD', S.dash), keyLine('supabase-studio', 'SUPABASE_PUBLIC_URL', 'http://203.0.113.9:8000'));
      if (cmd.includes(`'events-cache-1'`)) lines.push(keyLine('events-cache-1', 'REDIS_PASSWORD', S.redisRoot));
      if (cmd.includes(`'files-minio-1'`)) lines.push(keyLine('files-minio-1', 'MINIO_ROOT_USER', 'admin'), keyLine('files-minio-1', 'MINIO_ROOT_PASSWORD', S.minio));
      out += sec('keys', lines.join('\n'));
    }
    if (cmd.includes('@@unit7:secret')) {
      const reply = cmd.includes('redis-cli') ? (o.redis === 'old' ? `ERR unknown command 'ACL', with args beginning with: 'SETUSER' '${ROLE}' 'on' 'resetpass' '>${S.pw}'` : 'OK\nERR This Redis instance is not configured to use an ACL file\nERR The server is running without a config file')
        : cmd.includes('mongosh') ? '{ ok: 1 }\nunit7-done' : '';
      out += sec('secret', S.pw) + sec('reply', reply) + sec('exit', '0');
    }
    if (cmd.includes('svcacct add')) out += o.mc === false ? sec('account', 'unit7-no-mc') + sec('exit', '0') : sec('account', JSON.stringify({ status: 'success', accessKey: 'U7ACCESSKEY01', secretKey: S.minio, accountStatus: 'on' })) + sec('exit', '0');
    if (cmd.includes('/api/serviceaccounts') && cmd.includes('$b/$id/tokens')) out += o.grafana === 'login' ? sec('account', 'unit7-login') : sec('account', 'sa=7') + sec('token', JSON.stringify({ id: 1, name: 'unit7-x', key: S.grafana }));
    if (cmd.includes('text=$3') && !cmd.includes('@@unit7:secret')) out += sec('reply', cmd.includes('PING') ? 'PONG' : '') + sec('exit', '0');
    if (cmd.includes('svcacct rm') || cmd.includes('-X DELETE')) out += sec('reply', '') + sec('exit', '0');
    if (cmd.includes('header=$4')) out += sec('http', '200');
    if (cmd.includes('@@unit7:http') && cmd.includes('path=$3') && !cmd.includes('header=$4')) out += sec('http', '401');
    return { stdout: out };
  };
}

async function setup(host = COOLIFY_HOST, o: { sudo?: string; user?: string } = {}) {
  const app = testApp();
  const org = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', ?, 'credential://ssh/box/private-key', 'ready', ?)`, srv, org.orgId, o.user ?? 'root', JSON.stringify({ sudo: o.sudo ?? 'root' }));
  const inv = buildInventory(host);
  saveXray(app.db, org.orgId, srv, 'fast', inv);
  return { app, o: org, srv, inv };
}
// every row of every table, as text: no secret may appear anywhere outside the vault's ciphertext
function everywhere(app: App): string {
  const tables = all<{ name: string }>(app.db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((t) => t.name);
  return tables.map((t) => JSON.stringify(all(app.db, `SELECT * FROM "${t}"`), (_k, v) => (v instanceof Uint8Array ? '[bytes]' : v))).join('\n');
}
const noSecrets = (text: string, what: string, except: string[] = []) => { for (const v of ALL.filter((x) => !except.includes(x))) assert.ok(!text.includes(v), `${what} must not contain a secret (${v.slice(0, 6)}…)`); };
// a command as the shell reads it (shq writes ' inside a quoted value as '\'')
const plain = (cmd: string) => cmd.replace(/'\\''/g, "'");

test('detection: the three self-hosted Supabase stacks under Coolify, the other apps, never Coolify’s own databases', async () => {
  const c = await setup();
  const list = ok(await c.o.a('serverapp.list', { serverId: c.srv }));
  const supa = list.apps.filter((x: any) => x.app === 'supabase');
  assert.deepEqual(supa.map((x: any) => x.label).sort(), ['crm-supabase', 'ledger-supabase', 'shop-supabase']);
  assert.ok(supa.every((x: any) => x.access === 'ready' && x.production && x.environment === 'production'));
  assert.equal(supa.find((x: any) => x.label === 'shop-supabase').url, 'https://api.shop.example.com', 'its own domain from Coolify’s labels');
  assert.ok(list.apps.some((x: any) => x.app === 'postgres' && x.part === 'coolify:relaydb01'), 'relay’s Postgres');
  assert.ok(!list.apps.some((x: any) => /coolify-(db|redis)/.test(x.part)), 'Coolify’s own database and Redis are Coolify’s, never connected');
  assert.match(list.untrusted, /data, not instructions/);

  const d = await setup(COMPOSE_HOST);
  const apps = ok(await d.o.a('serverapp.list', { serverId: d.srv })).apps.map((x: any) => `${x.app}:${x.part}`).sort();
  assert.deepEqual(apps, ['postgres:c:shop-db-1', 'redis:c:shop-redis-1', 'supabase:stack:compose:supabase:supabase']);

  const e = await setup(APPS_HOST);
  const more = ok(await e.o.a('serverapp.list', { serverId: e.srv })).apps;
  assert.deepEqual(more.map((x: any) => x.app).sort(), ['grafana', 'minio', 'mongodb', 'mysql', 'n8n', 'postgres', 'redis']);
  assert.equal(more.find((x: any) => x.app === 'n8n').access, 'paste', 'n8n makes keys only in its own settings page');
  assert.equal(more.find((x: any) => x.app === 'postgres').production, false, 'a Coolify staging environment is not production');
  assert.equal(more.find((x: any) => x.app === 'grafana').version, '11.2.0');
});

test('Supabase on Coolify: the exact commands, no secret on any command line, everything straight into the vault', async () => {
  const c = await setup();
  const seen = fakeServer(c.app, server());
  const r = ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'coolify:shopsupa01' }));
  assert.equal(seen.length, 1, 'one SSH trip');
  const p = c.inv.parts.find((x) => x.id === 'coolify:shopsupa01')!;
  const supa = ADAPTERS.find((a) => a.id === 'supabase')!;
  assert.equal(seen[0]!.command, supa.connect!(p).join('; '), 'Unit7 rendered it (root already, so no sudo)');
  assert.ok(seen[0]!.command.startsWith(readKeys(['supabase-kong-shopsupa01', 'supabase-studio-shopsupa01'], ['SUPABASE_ANON_KEY', 'ANON_KEY', 'SUPABASE_SERVICE_KEY', 'SERVICE_ROLE_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'DASHBOARD_USERNAME', 'DASHBOARD_PASSWORD', 'SUPABASE_PUBLIC_URL', 'SERVICE_URL_SUPABASEKONG', 'SERVICE_URL_SUPABASEKONG_8000', 'SERVICE_FQDN_SUPABASEKONG', 'API_EXTERNAL_URL'])), 'only the named settings, from kong and studio');
  assert.ok(seen[0]!.command.includes(`'supabase-db-shopsupa01' '${PSQL_SUPABASE}'`), 'the read-only role is made by psql inside the stack’s own database');
  assert.match(plain(seen[0]!.command), /ALTER ROLE unit7_read WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD '%s'/);
  assert.match(plain(seen[0]!.command), /SET log_statement = 'none'/, 'the password never lands in the server log');
  assert.match(seen[0]!.command, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO unit7_read/);
  noSecrets(seen.map((x) => x.command + x.stdin).join('\n'), 'what Unit7 sent');

  // the result: names and references only
  noSecrets(JSON.stringify(r), 'the result');
  assert.deepEqual(r.keys.map((k: any) => k.name).sort(), ['anon-key', 'dashboard-password', 'db-read-password', 'service-role-key']);
  assert.ok(r.keys.every((k: any) => /^credential:\/\/serverapp\/srv-[a-z0-9-]+\/supabase\.[a-z-]+$/.test(k.ref)));
  assert.deepEqual(r.madeByUnit7, ['Read-only database login']);
  assert.equal(r.url, 'https://api.shop.example.com');
  // the vault: each value, with what it is, what it can do, that Unit7 keeps it, and how it's taken back
  const vault = c.app.vault.list(c.o.orgId, 'credential://serverapp/');
  assert.equal(vault.length, 4);
  const byName = Object.fromEntries(vault.map((v) => [JSON.parse(v.meta).name, { ...v, meta: JSON.parse(v.meta) }]));
  assert.equal(c.app.vault.resolve(c.o.orgId, byName['anon-key'].ref), S.anon);
  assert.equal(c.app.vault.resolve(c.o.orgId, byName['db-read-password'].ref), S.pw);
  assert.equal(c.app.vault.resolve(c.o.orgId, byName['dashboard-password'].ref), S.dash);
  const m = byName['db-read-password'].meta;
  assert.deepEqual([m.app, m.serverId, m.part, m.createdBy, m.made, m.user], ['supabase', c.srv, 'coolify:shopsupa01', 'Unit7', true, ROLE]);
  assert.match(m.scope, /read-only/);
  assert.match(m.revoke, /Disconnect takes it back/);
  assert.equal(m.revokeSteps.length, 1);
  assert.ok(m.revokeSteps[0].includes(`'supabase-db-shopsupa01'`) && m.revokeSteps[0].includes('DROP ROLE IF EXISTS unit7_read'));
  assert.equal(byName['service-role-key'].meta.made, false, 'read from the stack: Supabase can’t make a narrower key');
  assert.match(byName['service-role-key'].meta.how, /can’t make a narrower one/);
  assert.equal(byName['dashboard-password'].meta.people, true);
  // nowhere else: audit, events, changes, X-rays, approvals, messages
  noSecrets(everywhere(c.app), 'the database');
  // Activity: a change with an Undo
  const ch = get<{ verb: string; status: string; undo: string }>(c.app.db, 'SELECT verb, status, undo FROM changes WHERE id = ?', r.changeId)!;
  assert.deepEqual([ch.verb, ch.status], ['connect', 'done']);
  assert.ok(get(c.app.db, `SELECT 1 FROM events WHERE type = 'change.made' AND json_extract(data, '$.changeId') = ?`, r.changeId));
});

test('the scripts themselves: a password made on the server never reaches any command line, only stdout and the client’s stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-serverapps-'));
  const bin = join(dir, 'bin'), log = join(dir, 'argv.log'), stdinLog = join(dir, 'stdin.log');
  mkdirSync(bin);
  // docker: inspect prints the env of a container (filtered by the named keys), exec runs the client here with the
  // container's env; psql records what it got on stdin. Every program logs its command line.
  writeFileSync(join(dir, 'kong.env'), `SUPABASE_ANON_KEY=${S.anon}\nDASHBOARD_PASSWORD=${S.dash}\nOTHER_SECRET=neverReadMe123\n`);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "docker $*" >> "${log}"
if [ "$1" = inspect ]; then shift 2; tpl=$1; shift; for c in "$@"; do while IFS= read -r l; do k=\${l%%=*}; case "$tpl" in *"\\"$k\\""*) printf '/%s|"%s"\\n' "$c" "$l";; esac; done < "${dir}/kong.env"; done; exit 0; fi
if [ "$1" = exec ]; then shift; [ "$1" = -i ] && shift; shift; exec "$@"; fi`);
  writeFileSync(join(bin, 'psql'), `#!/bin/sh\nprintf '%s\\n' "psql $*" >> "${log}"\ncat >> "${stdinLog}"\n`);
  for (const f of ['docker', 'psql']) chmodSync(join(bin, f), 0o755);
  const runIt = (command: string) => spawnSync('sh', ['-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir }, encoding: 'utf8' });

  const out = runIt(`${readKeys(['kong'], ['SUPABASE_ANON_KEY', 'DASHBOARD_PASSWORD'])}; ${make('db', PSQL, 'SET log_statement = \'none\';', `ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '%s';`, 'GRANT USAGE ON SCHEMA public TO unit7_read;')}`);
  assert.equal(out.status, 0, out.stderr);
  const keys = parseKeys(out.stdout.split('@@unit7:keys')[1]!.split('@@unit7:secret')[0]);
  assert.deepEqual(keys, { kong: { SUPABASE_ANON_KEY: S.anon, DASHBOARD_PASSWORD: S.dash } }, 'only the named settings come back');
  assert.ok(!out.stdout.includes('neverReadMe123'), 'never the whole environment');
  const pw = /@@unit7:secret\n([0-9a-f]{48})\n/.exec(out.stdout)?.[1];
  assert.ok(pw, 'a 48-character password, printed first');
  assert.match(out.stdout, /@@unit7:exit\n0/);
  const argv = readFileSync(log, 'utf8');
  assert.ok(!argv.includes(pw!), 'the new password is on no command line');
  assert.ok(!argv.includes(S.anon) && !argv.includes(S.dash), 'and neither is anything read');
  assert.match(argv, /psql -X -q -v ON_ERROR_STOP=1/);
  const sent = readFileSync(stdinLog, 'utf8');
  assert.equal(sent, `SET log_statement = 'none';\nALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${pw}';\nGRANT USAGE ON SCHEMA public TO unit7_read;\n`, 'exactly one ALTER ROLE line, on stdin');
  assert.deepEqual(readdirSync(dir).sort(), ['argv.log', 'bin', 'kong.env', 'stdin.log'], 'no file left behind');
  assert.throws(() => keysTemplate(['A; rm -rf /']), /refusing/);
});

test('every other adapter: its own scoped credential, the right client, fallbacks only where the app can’t do better', async () => {
  const c = await setup(APPS_HOST);
  let seen = fakeServer(c.app, server());
  // Postgres (Coolify staging): a read-only role through psql as the image's own superuser
  const pg = ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'coolify:stagedb01' }));
  assert.ok(seen[0]!.command.includes(`'stagedb01' '${PSQL}'`));
  assert.deepEqual(pg.madeByUnit7, ['Read-only database login']);
  // MySQL: a user that reads the app databases only (the grants come from the server's own list, mysql.* left out)
  ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'c:blog-db-1' }));
  assert.match(plain(seen[1]!.command), /DROP USER IF EXISTS 'unit7_read'@'%%'; CREATE USER/);
  assert.match(plain(seen[1]!.command), /schema_name NOT IN \('mysql'/);
  assert.match(seen[1]!.command, /export MYSQL_PWD=/, 'root signs in with the image’s own password, kept in the client’s environment');
  // MongoDB: readAnyDatabase, signed in inside the container from the image's own settings
  ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'c:events-mongo-1' }));
  assert.match(seen[2]!.command, /readAnyDatabase/);
  assert.match(seen[2]!.command, /process\.env\.MONGO_INITDB_ROOT_PASSWORD/);
  // Redis 7: an ACL user that can only read; this one has no ACL file, so it says it's forgotten on restart
  const rd = ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'c:events-cache-1' }));
  assert.match(seen[3]!.command, /ACL SETUSER unit7_read on resetpass #%s resetkeys ~\* -@all \+@read -@dangerous/, 'only the password’s SHA-256 reaches Redis');
  assert.match(seen[3]!.command, /'sha256'$/);
  assert.match(rd.note, /forgets the user when it restarts/);
  // MinIO: a service account limited to S3 (no admin), made by mc with MC_HOST_ (never `mc alias set` with keys)
  const mn = ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'c:files-minio-1' }));
  assert.match(seen[4]!.command, /mc admin user svcacct add unit7/);
  assert.ok(!/mc alias set/.test(seen[4]!.command));
  assert.match(seen[4]!.command, /"Action":\["s3:\*"\]/);
  assert.equal(get<{ meta: string }>(c.app.db, `SELECT meta FROM secrets WHERE ref LIKE '%minio.secret-key' AND retired_at IS NULL`)!.meta.includes('"accessKey":"U7ACCESSKEY01"'), true);
  assert.equal(mn.keys[0].login, 'U7ACCESSKEY01', 'the access key is a name, the secret key stays in the vault');
  // Grafana: a Viewer service account and its token, over Grafana's own API from inside the server
  ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'c:mon-grafana-1' }));
  assert.match(seen[5]!.command, /"role":"Viewer"/);
  assert.match(seen[5]!.command, /curl -s -m 10 -K -/, 'the admin login reaches curl on its stdin');
  noSecrets(seen.map((x) => x.command + x.stdin).join('\n'), 'what Unit7 sent');
  noSecrets(everywhere(c.app), 'the database');
  assert.equal(c.app.vault.list(c.o.orgId, 'credential://serverapp/').length, 6);

  // the fallbacks: Redis 5 has one shared password; a MinIO image without mc; Grafana whose first password was changed
  const d = await setup(APPS_HOST);
  seen = fakeServer(d.app, server({ redis: 'old', mc: false, grafana: 'login' }));
  const old = ok(await d.o.h('serverapp.connect', { serverId: d.srv, part: 'c:events-cache-1' }));
  assert.equal(seen.length, 2, 'the scoped way first, then the fallback');
  assert.ok(seen[1]!.command.includes(keysTemplate(['REDIS_PASSWORD']).slice(0, 30)));
  assert.equal(old.keys[0].madeByUnit7, false);
  assert.match(old.note, /can’t make a narrower user/);
  noSecrets(JSON.stringify(old), 'the result (the Redis error echoed the password)');
  const nomc = ok(await d.o.h('serverapp.connect', { serverId: d.srv, part: 'c:files-minio-1' }));
  assert.match(nomc.note, /no mc/);
  const gl = ok(await d.o.h('serverapp.connect', { serverId: d.srv, part: 'c:mon-grafana-1' }));
  assert.equal(gl.needsPaste, true);
  assert.equal(gl.connected, false);
  noSecrets(everywhere(d.app), 'the database');
});

test('n8n: a person pastes the key once; it’s checked from inside the server on stdin and kept in the vault', async () => {
  const c = await setup(APPS_HOST);
  const seen = fakeServer(c.app, server());
  const steps = ok(await c.o.a('serverapp.connect', { serverId: c.srv, part: 'c:n8n-1' }));
  assert.equal(steps.needsPaste, true);
  assert.match(steps.steps.join(' '), /Settings, then n8n API/);
  assert.equal(steps.open, 'https://n8n.example.com');
  const ai = await c.o.a('serverapp.connect', { serverId: c.srv, part: 'c:n8n-1', token: S.n8n });
  assert.equal(ai.status, 'denied', 'pasting a key is for people');
  const r = ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'c:n8n-1', token: S.n8n }));
  assert.equal(r.connected, true);
  const check = seen.find((x) => x.command.includes('header=$4'))!;
  assert.ok(!check.command.includes(S.n8n), 'never on a command line');
  assert.equal(check.stdin, `${S.n8n}\n`, 'the key reaches curl on stdin');
  assert.match(check.command, /'X-N8N-API-KEY'/);
  noSecrets(everywhere(c.app), 'the database (the audit row keeps the input as [sensitive])');
  assert.ok(get(c.app.db, `SELECT 1 FROM audit WHERE tool = 'serverapp.connect' AND input LIKE '%[sensitive]%'`));
});

test('reveal is people only (owners and admins), audited; an AI is refused whatever the level', async () => {
  const c = await setup();
  fakeServer(c.app, server());
  ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'coolify:shopsupa01' }));
  run(c.app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', c.o.orgId);
  const ai = await c.o.a('serverapp.reveal', { serverId: c.srv, part: 'coolify:shopsupa01', key: 'dashboard-password' }) as any;
  assert.equal(ai.status, 'denied');
  const dev = await c.o.as(c.o.role('developer'))('serverapp.reveal', { serverId: c.srv, part: 'coolify:shopsupa01', key: 'dashboard-password' }) as any;
  assert.equal(dev.status, 'error');
  assert.match(dev.error.message, /cannot see keys/);
  const token: Actor = { ...c.o.human, kind: 'token' };
  assert.equal((await c.o.as(token)('serverapp.reveal', { serverId: c.srv, part: 'coolify:shopsupa01', key: 'dashboard-password' })).status, 'denied', 'a token could be any program on the computer');
  const r = ok(await c.o.h('serverapp.reveal', { serverId: c.srv, part: 'coolify:shopsupa01', key: 'dashboard-password' }));
  assert.equal(r.value, S.dash);
  assert.equal(r.login, 'supabase');
  const audit = get<{ output: string; action: string }>(c.app.db, `SELECT output, action FROM audit WHERE tool = 'serverapp.reveal' AND result = 'success'`)!;
  assert.equal(audit.action, 'secret_reveal');
  assert.ok(!audit.output.includes(S.dash) && audit.output.includes('shown only to the person who asked'));
  assert.ok(get(c.app.db, `SELECT 1 FROM events WHERE type = 'secret.revealed'`));
  noSecrets(everywhere(c.app), 'the database');
});

test('disconnect takes back what Unit7 made and retires the vault entries; Undo does the same', async () => {
  const c = await setup();
  const seen = fakeServer(c.app, server());
  const r = ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'coolify:shopsupa01' }));
  const d = ok(await c.o.h('serverapp.disconnect', { serverId: c.srv, part: 'coolify:shopsupa01' }));
  assert.equal(d.disconnected, true);
  assert.equal(d.removedInApp, true);
  const revoke = seen.at(-1)!;
  assert.ok(revoke.command.includes(`'supabase-db-shopsupa01'`) && revoke.command.includes(DROP_ROLE_SQL.split('\n').at(-1)!), 'the role is dropped in the stack’s database');
  assert.match(d.note, /Anon key, Dashboard login, Service key are Supabase’s own/);
  assert.equal(c.app.vault.list(c.o.orgId, 'credential://serverapp/').length, 0, 'every vault entry retired');
  assert.equal(get<{ status: string }>(c.app.db, 'SELECT status FROM changes WHERE id = ?', r.changeId)!.status, 'undone');
  assert.equal(ok(await c.o.h('serverapp.list', { serverId: c.srv })).apps.find((x: any) => x.part === 'coolify:shopsupa01').access, 'ready');

  // a revoke that fails keeps the keys (so they can be taken back later), unless forced
  const again = ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'coolify:crmsupa01' }));
  fakeServer(c.app, (cmd) => (cmd.includes('DROP ROLE') ? { stdout: sec('reply', 'psql: error: connection refused') + sec('exit', '2') } : server()(cmd)));
  const failed = await c.o.h('serverapp.disconnect', { serverId: c.srv, part: 'coolify:crmsupa01' }) as any;
  assert.equal(failed.error.code, 'revoke_failed');
  assert.equal(c.app.vault.list(c.o.orgId, 'credential://serverapp/').length, 4);
  const forced = ok(await c.o.h('serverapp.disconnect', { serverId: c.srv, part: 'coolify:crmsupa01', force: true }));
  assert.match(forced.warning, /may still be there/);
  assert.equal(c.app.vault.list(c.o.orgId, 'credential://serverapp/').length, 0);
  void again;

  // Undo from Activity (change.undo) runs the same revoke, and the keys leave the vault
  const e = await setup();
  const eseen = fakeServer(e.app, server());
  const conn = ok(await e.o.h('serverapp.connect', { serverId: e.srv, part: 'coolify:ledgsupa01' }));
  ok(await e.o.h('change.undo', { changeId: conn.changeId }));
  assert.ok(eseen.at(-1)!.command.includes('DROP ROLE IF EXISTS unit7_read') && eseen.at(-1)!.command.includes(`'supabase-db-ledgsupa01'`));
  assert.equal(ok(await e.o.h('serverapp.keys', { serverId: e.srv, part: 'coolify:ledgsupa01' })).keys.length, 0);
  assert.equal(e.app.vault.list(e.o.orgId, 'credential://serverapp/').length, 0);
});

test('wire: the URL and anon key reach an app through links, values never through the result; the service key only where server code reads it', async () => {
  const c = await setup();
  fakeServer(c.app, server());
  ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'coolify:shopsupa01' }));
  const env = ok(await c.o.h('project.create', { name: 'Shop', environments: ['production'] })).environments[0].id;
  const web = ok(await c.o.h('service.create', { environmentId: env, name: 'web', source: { type: 'git', repo: 'sam/web' } })).serviceId;
  const r = ok(await c.o.h('serverapp.wire', { serverId: c.srv, part: 'coolify:shopsupa01', target: { kind: 'unit7', serviceId: web } }));
  assert.deepEqual(r.set.sort(), ['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL']);
  assert.match(r.note, /Only the public anon key/);
  noSecrets(JSON.stringify(r), 'the result');
  const link = get<{ source: string; vars: string }>(c.app.db, 'SELECT source, vars FROM links WHERE id = ?', r.linkId)!;
  assert.deepEqual(JSON.parse(link.source), { kind: 'serverapp', serverId: c.srv, part: 'coolify:shopsupa01' });
  assert.ok(JSON.parse(link.vars).every((v: any) => /^[0-9a-f]{16}$/.test(v.fp)), 'the link keeps fingerprints only');
  assert.equal(ok(await c.o.h('env.reveal', { serviceId: web, key: 'SUPABASE_URL' })).value, 'https://api.shop.example.com');
  assert.equal(ok(await c.o.h('env.reveal', { serviceId: web, key: 'SUPABASE_ANON_KEY' })).value, S.anon);
  // re-sync through the links machinery (Warden does this daily): nothing changed, nothing written
  assert.deepEqual(ok(await c.o.a('link.sync', { linkId: r.linkId })).set, []);
  assert.equal(ok(await c.o.h('link.list', {}))[0].from.name, 'Supabase on box');
  // server code that reads the service key gets it, as a secret
  run(c.app.db, `UPDATE services SET config = json_set(config, '$.detection', json('{"stack":"express","envKeys":["SUPABASE_URL","SUPABASE_ANON_KEY","SUPABASE_SERVICE_ROLE_KEY"]}')) WHERE id = ?`, web);
  const api = ok(await c.o.h('serverapp.wire', { serverId: c.srv, part: 'coolify:shopsupa01', target: { kind: 'unit7', serviceId: web } }));
  assert.deepEqual(api.set, ['SUPABASE_SERVICE_ROLE_KEY']);
  // an AI handing over a full-access key always asks a person first, whatever the autonomy
  run(c.app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', c.o.orgId);
  run(c.app.db, 'UPDATE environments SET autonomy = 4 WHERE id = ?', env);
  const asked = await c.o.a('serverapp.wire', { serverId: c.srv, part: 'coolify:shopsupa01', target: { kind: 'unit7', serviceId: web } }) as any;
  assert.equal(asked.status, 'approval_required');
  assert.match(asked.why, /service key/);
  // the app's keys as references: logins and full-access keys never by an AI, the rest only once a person says yes
  const refs = Object.fromEntries(c.app.vault.list(c.o.orgId, 'credential://serverapp/').map((e) => [e.ref.slice(e.ref.lastIndexOf('.') + 1), e.ref]));
  for (const k of ['service-role-key', 'dashboard-password']) {
    const no = await c.o.a('env.set', { serviceId: web, key: 'SB_KEY', value: refs[k] }) as any;
    assert.equal(no.status, 'denied', k);
    assert.match(no.why, /meant for people/);
  }
  const anon = await c.o.a('env.set', { serviceId: web, key: 'SB_ANON', value: refs['anon-key'] }) as any;
  assert.equal(anon.status, 'approval_required', 'an app’s key from a server waits for a person');
  assert.equal((await decideApproval(c.app, c.o.orgId, c.o.human, anon.approvalId, true)).status, 'ok');
  ok(await c.o.h('env.set', { serviceId: web, key: 'SB_SERVICE', value: refs['service-role-key'] }));
  // a path that doesn't name the key in its input (bringing an older version back) is refused for an AI too
  const back = await c.o.a('env.restore', { serviceId: web, key: 'SB_SERVICE', version: 1 }) as any;
  assert.equal(back.status, 'error');
  assert.match(back.error.message, /meant for people/);
  run(c.app.db, 'UPDATE orgs SET autonomy = 3 WHERE id = ?', c.o.orgId);
  // the anon key is public by design (an app's settings show it like any plain setting); everything else stays sealed
  noSecrets(everywhere(c.app), 'the database', [S.anon]);
  // disconnected: the link can't sync any more and says why
  ok(await c.o.h('serverapp.disconnect', { serverId: c.srv, part: 'coolify:shopsupa01' }));
  assert.match((await c.o.a('link.sync', { linkId: r.linkId }) as any).error.message, /isn’t connected/);
  // a read-only database login is for Unit7, not for apps
  ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'coolify:relaydb01' }));
  assert.match((await c.o.h('serverapp.wire', { serverId: c.srv, part: 'coolify:relaydb01', target: { kind: 'unit7', serviceId: web } }) as any).error.message, /read-only login/);
});

test('the gate and auto-connect: an AI asks first in production; at Full autopilot it connects test copies by itself, once', async () => {
  const c = await setup(APPS_HOST);
  fakeServer(c.app, server());
  // production (Supabase-like compose apps, nothing says otherwise): an AI asks, whatever the level; a person clicks once
  run(c.app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', c.o.orgId);
  const ask = await c.o.a('serverapp.connect', { serverId: c.srv, part: 'c:blog-db-1' }) as any;
  assert.equal(ask.status, 'approval_required');
  assert.match(ask.why, /read-only user/, 'the card says what it makes');
  ok(await c.o.h('serverapp.connect', { serverId: c.srv, part: 'c:blog-db-1' }));

  // auto-connect at level 3: nothing by itself, everything suggested
  run(c.app.db, 'UPDATE orgs SET autonomy = 3 WHERE id = ?', c.o.orgId);
  const warden: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };
  const three = ok(await c.o.as(warden)('serverapp.autoconnect', { serverId: c.srv }));
  assert.deepEqual(three.connected, []);
  assert.ok(three.suggested.some((x: any) => x.part === 'coolify:stagedb01'));
  // at Full autopilot: only the staging database, by itself, recorded with an Undo
  run(c.app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', c.o.orgId);
  const four = ok(await c.o.as(warden)('serverapp.autoconnect', { serverId: c.srv }));
  assert.deepEqual(four.connected, ['PostgreSQL (shop-staging-db)']);
  assert.ok(four.suggested.every((x: any) => x.part !== 'coolify:stagedb01') && four.suggested.some((x: any) => x.app === 'MinIO'), 'production apps stay suggestions');
  const change = get<{ id: string; actor: string }>(c.app.db, `SELECT id, actor FROM changes WHERE part = 'coolify:stagedb01' AND verb = 'connect' AND status = 'done'`)!;
  assert.equal(change.actor, 'Warden');
  assert.ok(get(c.app.db, `SELECT 1 FROM events WHERE type = 'change.made' AND json_extract(data, '$.changeId') = ?`, change.id), 'in Activity, with its Undo');
  // a person takes it back; Warden never connects it again by itself
  ok(await c.o.h('change.undo', { changeId: change.id }));
  const after = ok(await c.o.as(warden)('serverapp.autoconnect', { serverId: c.srv }));
  assert.deepEqual(after.connected, []);
  assert.ok(after.suggested.some((x: any) => x.part === 'coolify:stagedb01'), 'once per app: now it only suggests');
  // paused Autopilot: nothing at all
  run(c.app.db, `UPDATE orgs SET paused_at = ? WHERE id = ?`, new Date().toISOString(), c.o.orgId);
  run(c.app.db, `DELETE FROM audit WHERE tool = 'serverapp.connect'`);
  const paused = await c.o.as(warden)('serverapp.autoconnect', { serverId: c.srv });
  assert.equal(paused.status, 'denied', 'auto-connect is a change: paused Autopilot stops it whole');
  assert.match((paused as any).why, /Autopilot is paused/);
  run(c.app.db, `UPDATE orgs SET paused_at = NULL WHERE id = ?`, c.o.orgId);
  // it's gated as the change it is: below Safe actions an AI's auto-connect asks first, and the audit says it writes
  run(c.app.db, 'UPDATE orgs SET autonomy = 2 WHERE id = ?', c.o.orgId);
  assert.equal((await c.o.as(warden)('serverapp.autoconnect', { serverId: c.srv })).status, 'approval_required');
  assert.deepEqual({ ...get<{ risk: string; action: string }>(c.app.db, `SELECT risk, action FROM audit WHERE tool = 'serverapp.autoconnect' ORDER BY created_at DESC, rowid DESC LIMIT 1`) }, { risk: 'write', action: 'serverapp_admin' });

  // suggestions: one click for what isn't connected yet
  const sug = serverAppSuggestions(c.app, c.o.orgId);
  assert.ok(sug.length > 0 && sug.every((x) => x.actions[0]!.tool === 'serverapp.connect'));
  assert.match(sug[0]!.text, /runs on box/);
  // not root and no sudo: no access, and it says why
  const n = await setup(APPS_HOST, { user: 'deploy', sudo: 'no' });
  fakeServer(n.app, server());
  assert.equal(ok(await n.o.h('serverapp.list', { serverId: n.srv })).root, false);
  assert.match((await n.o.h('serverapp.connect', { serverId: n.srv, part: 'c:blog-db-1' }) as any).error.message, /isn’t root/);
  assert.equal(serverAppSuggestions(n.app, n.o.orgId).length, 0);
});

test('a name built to break out of a command is refused, never run; adapters skip Unit7’s own and system parts', async () => {
  const c = await setup(APPS_HOST);
  const inv: Inventory = JSON.parse(JSON.stringify(c.inv));
  inv.parts.find((p) => p.id === 'c:blog-db-1')!.containers = ["blog'; rm -rf /"];
  saveXray(c.app.db, c.o.orgId, c.srv, 'fast', inv);
  const seen = fakeServer(c.app, server());
  assert.match((await c.o.h('serverapp.connect', { serverId: c.srv, part: 'c:blog-db-1' }) as any).error.message, /won’t put in a command/);
  assert.equal(seen.length, 0);
  const own = buildInventory(COOLIFY_HOST);
  assert.equal(adapterOf(own, own.parts.find((p) => p.containers?.includes('coolify-db'))!), undefined);
});

test('every adapter’s scripts run in a real shell: secrets only on stdout and stdin, never a command line, no file left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-serverapps-'));
  const bin = join(dir, 'bin'), log = join(dir, 'argv.log'), stdinLog = join(dir, 'stdin.log'), tmp = join(dir, 'tmp');
  mkdirSync(bin); mkdirSync(tmp);
  const ROOTPW = 'rootPassw0rdForTheImage', GPW = 'grafanaAdminPassw0rd';
  // every container's settings (what docker inspect / exec see)
  const ENV: Record<string, string> = {
    db: `POSTGRES_USER=app\nPOSTGRES_PASSWORD=${ROOTPW}`, my: `MYSQL_ROOT_PASSWORD=${ROOTPW}`, mongo: `MONGO_INITDB_ROOT_USERNAME=root\nMONGO_INITDB_ROOT_PASSWORD=${ROOTPW}`,
    cache: `REDIS_PASSWORD=${ROOTPW}`, minio: `MINIO_ROOT_USER=admin\nMINIO_ROOT_PASSWORD=${ROOTPW}`, graf: `GF_SECURITY_ADMIN_USER=admin\nGF_SECURITY_ADMIN_PASSWORD=${GPW}`,
  };
  for (const [c, e] of Object.entries(ENV)) writeFileSync(join(dir, `${c}.env`), `${e}\n`);
  const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake('docker', `if [ "$1" = inspect ]; then shift 2; tpl=$1; shift
  case "$tpl" in *IPAddress*) echo 172.18.0.5; exit 0;; esac
  for c in "$@"; do while IFS= read -r l; do k=\${l%%=*}; case "$tpl" in *"\\"$k\\""*) case "$tpl" in *'{{json .}}'*) printf '/%s|"%s"\\n' "$c" "$l";; *) printf '%s' "$l";; esac;; esac; done < "${dir}/$c.env"; done; exit 0; fi
if [ "$1" = exec ]; then shift; [ "$1" = -i ] && shift; c=$1; shift; set -a; . "${dir}/$c.env"; set +a; exec "$@"; fi`);
  const client = `{ printf '%s\\n' "--- $0"; cat; } >> "${stdinLog}"`;
  for (const c of ['psql', 'redis-cli', 'mongosh', 'pg_isready', 'mysqladmin']) fake(c, `${client}${c === 'redis-cli' ? '; echo OK' : c === 'mongosh' ? '; echo unit7-done' : ''}`);
  fake('sha256sum', 'shasum -a 256 "$@" 2>/dev/null || command sha256sum "$@"');
  fake('mysql', `case "$*" in *' -e '*) echo shop; echo blog;; *) ${client};; esac`);
  fake('mc', `[ -n "$MC_HOST_unit7" ] || exit 3; for a in "$@"; do case "$a" in /*) [ -f "$a" ] && { cat "$a" >> "${stdinLog}"; echo >> "${stdinLog}"; };; esac; done; echo '{"status":"success","accessKey":"U7ACCESS","secretKey":"minioMadeSecret123456"}'`);
  fake('curl', `cfg=$(cat); printf '%s\\n' "--- curl config: $cfg" >> "${stdinLog}"; case "$*" in *tokens*) echo '{"id":1,"name":"unit7","key":"glsa_madeToken1234567890"}';; *serviceaccounts*) echo '{"id":7,"name":"unit7"}';; *) printf 200;; esac`);
  const shell = (command: string) => spawnSync('sh', ['-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp }, encoding: 'utf8' });
  const part = (id: string, product: string, engine?: string) => ({ id, kind: engine ? 'database' : 'app', name: id, owner: 'compose', trust: 'seen', containers: [id], product: { id: product, name: product }, ...(engine && { engine }) }) as any;
  const parts: [string, any][] = [['postgres', part('db', 'postgresql', 'postgres')], ['mysql', part('my', 'mysql', 'mysql')], ['mongodb', part('mongo', 'mongodb', 'mongo')], ['redis', part('cache', 'redis', 'redis')], ['minio', part('minio', 'minio')], ['grafana', part('graf', 'grafana')]];
  const made: string[] = [];
  for (const [appId, p] of parts) {
    const a = ADAPTERS.find((x) => x.id === appId)!;
    assert.ok(a.detect(p), `${appId} is recognised`);
    const out = shell(a.connect!(p).join('; '));
    assert.equal(out.status, 0, `${appId}: ${out.stderr}`);
    const got = a.parse!(out.stdout, p);
    assert.equal(got.problem, undefined, `${appId}: ${got.problem}`);
    assert.ok(got.creds.length && got.creds.every((c) => c.made), `${appId} made its own credential`);
    made.push(...got.creds.map((c) => c.value));
    for (const r of got.revoke) assert.equal(shell(r).status, 0, `${appId}'s revoke runs`);
    if (a.health) assert.equal(shell(a.health(p)).status, 0, `${appId}'s health check runs`);
  }
  const argv = readFileSync(log, 'utf8'), sent = readFileSync(stdinLog, 'utf8');
  for (const v of [...made, ROOTPW, GPW]) assert.ok(!argv.includes(v), `no secret on a command line (${v.slice(0, 6)}…)`);
  const redisPw = made.find((v) => /^[0-9a-f]{48}$/.test(v) && sent.includes(`#${createHash('sha256').update(v).digest('hex')}`));
  assert.ok(redisPw && !sent.includes(`>${redisPw}`), 'Redis got the SHA-256 of its new password, never the password');
  for (const v of made.filter((x) => /^[0-9a-f]{48}$/.test(x))) assert.ok(v === redisPw ? !sent.includes(v) : sent.includes(v), 'each new password reached its client on stdin (Redis: only its hash)');
  assert.match(sent, /GRANT SELECT, SHOW VIEW ON `shop`\.\* TO unit7_read@'%';\nGRANT SELECT, SHOW VIEW ON `blog`/, 'MySQL grants per app database');
  assert.match(sent, /"Action":\["s3:\*"\]/, 'MinIO got its S3-only policy (from a file it removed)');
  assert.match(sent, new RegExp(`curl config: user = "admin:${GPW}"`), 'Grafana’s admin login went to curl on stdin');
  assert.match(argv, /mc admin user svcacct add unit7 admin --name unit7/);
  assert.match(argv, /mc admin user svcacct rm unit7 U7ACCESS/);
  assert.match(argv, /curl .*-X DELETE http:\/\/172\.18\.0\.5:3000\/api\/serviceaccounts\/7/);
  assert.deepEqual(readdirSync(tmp), [], 'no file left behind');
});

test('MySQL: a database name built to break out of the grant gets no grant at all (and nothing is split or globbed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-mysql-'));
  const evil = "x`.*TO/**/unit7_read;GRANT/**/ALL/**/ON*.*TO/**/appuser@'%';#";
  // the schema query answers with plain names and hostile ones; the stdin run prints what root would execute
  writeFileSync(join(dir, 'names'), ['shop', 'my-app$2', evil, 'two words', '*', 'a`b', ''].join('\n'));
  writeFileSync(join(dir, 'mysql'), `#!/bin/sh\ncase "$*" in *' -e '*) cat '${dir}/names';; *) cat;; esac\n`);
  chmodSync(join(dir, 'mysql'), 0o755);
  writeFileSync(join(dir, 'decoy'), '');
  const out = spawnSync('sh', ['-c', MYSQL], { cwd: dir, input: 'SET SESSION sql_log_off = 1;\n', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MYSQL_ROOT_PASSWORD: 'rootpw' }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const grants = out.stdout.split('\n').filter((l) => l.startsWith('GRANT'));
  assert.deepEqual(grants, ["GRANT SELECT, SHOW VIEW ON `shop`.* TO unit7_read@'%';", "GRANT SELECT, SHOW VIEW ON `my-app$2`.* TO unit7_read@'%';"]);
  assert.ok(!/GRANT ALL|appuser|decoy|two/.test(out.stdout), out.stdout);
});

test('Supabase’s own compose (an Envoy gateway, ANON_KEY / SERVICE_ROLE_KEY, the newer publishable and secret keys) reads the same way', () => {
  const supa = ADAPTERS.find((a) => a.id === 'supabase')!;
  const p = { id: 'stack:compose:supabase:supabase', kind: 'database', name: 'Supabase', owner: 'compose', trust: 'understood', product: { id: 'supabase', name: 'Supabase' },
    containers: ['supabase-envoy', 'supabase-studio', 'supabase-db'],
    internals: [{ name: 'supabase-envoy', image: 'envoyproxy/envoy:v1.33.0', state: 'running' }, { name: 'supabase-studio', image: 'supabase/studio:2026.09.01', state: 'running' }, { name: 'supabase-db', image: 'supabase/postgres:17.6.1.136', state: 'running' }] } as any;
  assert.ok(supa.detect(p));
  const steps = supa.connect!(p);
  assert.ok(steps[0]!.includes(`'supabase-envoy' 'supabase-studio'`) && steps[1]!.includes(`'supabase-db'`));
  const out = sec('keys', [keyLine('supabase-envoy', 'ANON_KEY', S.anon), keyLine('supabase-envoy', 'SERVICE_ROLE_KEY', S.service), keyLine('supabase-envoy', 'DASHBOARD_PASSWORD', S.dash),
    keyLine('supabase-envoy', 'SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_demo123456'), keyLine('supabase-studio', 'SUPABASE_PUBLIC_URL', 'https://supa.example.com/')].join('\n')) + sec('secret', S.pw) + sec('reply', '') + sec('exit', '0');
  const got = supa.parse!(out, p);
  assert.deepEqual(got.creds.map((c) => c.name).sort(), ['anon-key', 'dashboard-password', 'db-read-password', 'publishable-key', 'service-role-key']);
  assert.equal(got.facts.url, 'https://supa.example.com');
  assert.equal(got.problem, undefined);
});
