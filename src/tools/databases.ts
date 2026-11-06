// Databases as containers on the private unit7 network: never published to the internet. Unit7
// generates the password into the vault, injects DATABASE_URL/REDIS_URL into the app's env as a
// reference, inspects schemas, runs read-only queries by default, and backs up before any
// destructive change. "Never blindly destroy production data."
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { cmd, script, safeName, secretIn } from '../connectors/shell.ts';
import { ensureBase, serverRow } from './servers.ts';
import { makeRef } from '../vault.ts';
import { setVar } from './env.ts';
import { backupBeforeChange } from './backups.ts';
import { fid, name, uniqueSlug } from './helpers.ts';
import { LOG_OPTS } from '../deploy/deployer.ts';

type Engine = 'postgres' | 'mysql' | 'mariadb' | 'redis' | 'mongo';
const IMAGES: Record<Engine, string> = { postgres: 'postgres:17-alpine', mysql: 'mysql:8.4', mariadb: 'mariadb:11', redis: 'redis:7-alpine', mongo: 'mongo:7' };
const PORTS: Record<Engine, number> = { postgres: 5432, mysql: 3306, mariadb: 3306, redis: 6379, mongo: 27017 };

interface DbConfig { engine: Engine; container: string; database?: string; port: number; passwordRef?: string; volume: string; pool?: { container: string; mode: 'transaction' | 'session' } }

function dbService(ctx: Ctx, serviceId: string) {
  const svc = get<{ id: string; name: string; slug: string; kind: string; config: string; server_id: string | null; environment_id: string }>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  if (!svc) throw new Unit7Error('not_found', 'That service was not found.', 404);
  if (!(svc.kind in IMAGES)) throw new Unit7Error('not_a_database', `${svc.name} is not a database.`);
  if (!svc.server_id) throw new Unit7Error('no_server', `${svc.name} isn't on a server.`);
  return { svc, cfg: json<DbConfig>(svc.config, {} as DbConfig), s: serverRow(ctx, svc.server_id) };
}

// A database's other vault entries sit next to its password. Newer ones are named by service id, older
// ones by slug (credential://postgres/db/…); deriving from the stored passwordRef keeps both working.
const refOf = (cfg: DbConfig, name: 'url' | 'pool-url' | 'readonly-password') => cfg.passwordRef!.replace(/[^/]+$/, name);

const urlFor = (engine: Engine, container: string, pw: string, db: string) => {
  const p = PORTS[engine];
  if (engine === 'redis') return `redis://:${pw}@${container}:${p}`;
  if (engine === 'mongo') return `mongodb://root:${pw}@${container}:${p}/${db}?authSource=admin`;
  const scheme = engine === 'postgres' ? 'postgresql' : 'mysql';
  const user = engine === 'postgres' ? 'postgres' : 'root';
  return `${scheme}://${user}:${pw}@${container}:${p}/${db}`;
};

defineTool({
  name: 'database.create', title: 'Create a database', risk: (i) => (i.serverId ? 'destructive' : 'write'), action: 'database_create', timeoutMs: 5 * 60_000,
  description: 'Provision a database (postgres, mysql, mariadb, redis, mongo) as a private container. Unit7 generates the password into the vault and can inject the connection URL into an app. Never exposed to the internet.',
  input: z.object({
    environmentId: fid('env'), engine: z.enum(['postgres', 'mysql', 'mariadb', 'redis', 'mongo']), name: name.optional(),
    serverId: fid('srv').optional(), database: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/).default('app'),
    injectInto: fid('svc').optional(), memoryMb: z.number().int().min(128).max(32768).optional(),
  }),
  async run(ctx, i) {
    const env = get<{ project_id: string }>(ctx.db, 'SELECT project_id FROM environments WHERE id = ?', i.environmentId)!;
    const serverId = i.serverId ?? get<{ server_id: string | null }>(ctx.db, 'SELECT server_id FROM services WHERE environment_id = ? AND server_id IS NOT NULL LIMIT 1', i.environmentId)?.server_id
      ?? all<{ id: string }>(ctx.db, `SELECT id FROM servers WHERE org_id = ? AND status = 'ready' LIMIT 1`, ctx.orgId)[0]?.id;
    if (!serverId) throw new Unit7Error('no_server', 'No prepared server. Connect one and run server.bootstrap first.');
    const s = serverRow(ctx, serverId);
    await ensureBase(ctx, s);
    const label = i.name ?? i.engine;
    const slug = uniqueSlug(ctx, 'SELECT 1 FROM services WHERE environment_id = ? AND slug = ?', label, i.environmentId);
    const container = safeName(`unit7-${slug}-${i.environmentId.slice(-6)}`.toLowerCase(), 'container');
    const volume = `${container}-data`;
    const password = randomBytes(18).toString('base64url');
    const serviceId = id('svc');
    // by service id, not slug: a `db` in staging and a `db` in production must not share a password
    const pwRef = makeRef(i.engine, serviceId, 'password');
    ctx.redactor.add(password, pwRef);

    ctx.progress(`Starting ${i.engine} on ${s.name}…`);
    const image = IMAGES[i.engine];
    const mem = i.memoryMb ? `--memory ${i.memoryMb}m` : '';
    // the password reaches docker by name only (`-e NAME`, its value exported from stdin), never on a command line
    const PW: Record<Engine, string> = { postgres: 'POSTGRES_PASSWORD', mysql: 'MYSQL_ROOT_PASSWORD', mariadb: 'MARIADB_ROOT_PASSWORD', mongo: 'MONGO_INITDB_ROOT_PASSWORD', redis: 'REDIS_PASSWORD' };
    const envArgs: Record<Engine, string[]> = {
      postgres: ['-e', PW.postgres, '-e', `POSTGRES_DB=${i.database}`],
      mysql: ['-e', PW.mysql, '-e', `MYSQL_DATABASE=${i.database}`],
      mariadb: ['-e', PW.mariadb, '-e', `MARIADB_DATABASE=${i.database}`],
      mongo: ['-e', `MONGO_INITDB_ROOT_USERNAME=root`, '-e', PW.mongo],
      redis: ['-e', PW.redis],
    };
    // Redis reads its password from a config on its stdin (`redis-server -`), so it isn't in redis-server's arguments either
    const runArgs = i.engine === 'redis'
      ? ['run', '-d', '--name', container, '--restart', 'unless-stopped', '--network', 'unit7', '-v', `${volume}:/data`, ...(mem ? mem.split(' ') : []), ...envArgs.redis, '--label', `unit7.service=${serviceId}`, ...LOG_OPTS, image,
        'sh', '-c', 'exec docker-entrypoint.sh redis-server - <<EOF\nrequirepass $REDIS_PASSWORD\nmaxmemory-policy allkeys-lru\nEOF']
      : ['run', '-d', '--name', container, '--restart', 'unless-stopped', '--network', 'unit7', '-v', `${volume}:${i.engine === 'mongo' ? '/data/db' : i.engine === 'postgres' ? '/var/lib/postgresql/data' : '/var/lib/mysql'}`, ...(mem ? mem.split(' ') : []), ...envArgs[i.engine], '--label', `unit7.service=${serviceId}`, ...LOG_OPTS, image];
    await ssh(ctx.app).check(s, script(`${secretIn(PW[i.engine])}exec docker "$@"`, ...runArgs), { what: `Starting ${i.engine}`, timeoutMs: 180_000, stdin: `${password}\n` });

    const cfg: DbConfig = { engine: i.engine, container, database: i.database, port: PORTS[i.engine], passwordRef: pwRef, volume };
    run(ctx.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting')`,
      serviceId, ctx.orgId, env.project_id, i.environmentId, serverId, label, slug, i.engine, JSON.stringify(cfg));
    ctx.app.vault.put(ctx.orgId, pwRef, password, { kind: 'db_password', by: ctx.actor.name });
    ctx.resources.push(serviceId);

    // wait until it accepts connections
    const ready: Record<Engine, string> = {
      postgres: `docker exec "$1" pg_isready -U postgres`, mysql: `docker exec "$1" mysqladmin ping -h localhost --silent`,
      mariadb: `docker exec "$1" mariadb-admin ping -h localhost --silent`, mongo: `docker exec "$1" mongosh --quiet --eval "db.runCommand({ping:1})"`,
      redis: `docker exec "$1" redis-cli ping`,
    };
    await ssh(ctx.app).check(s, script(`for n in $(seq 1 60); do ${ready[i.engine]} >/dev/null 2>&1 && exit 0; sleep 1; done; docker logs --tail 20 "$1" >&2; exit 1`, container), { what: `Waiting for ${i.engine}`, timeoutMs: 90_000 });
    run(ctx.db, `UPDATE services SET status = 'healthy' WHERE id = ?`, serviceId);

    const urlRef = refOf(cfg, 'url');
    ctx.app.vault.put(ctx.orgId, urlRef, urlFor(i.engine, container, password, i.database), { kind: 'connection_url', by: ctx.actor.name });
    let injected: string | undefined;
    if (i.injectInto) {
      const key = i.engine === 'redis' ? 'REDIS_URL' : i.engine === 'mongo' ? 'MONGODB_URI' : 'DATABASE_URL';
      const target = get<{ name: string }>(ctx.db, 'SELECT name FROM services WHERE id = ? AND org_id = ?', i.injectInto, ctx.orgId);
      if (target) { setVar(ctx, { type: 'service', id: i.injectInto, label: target.name }, key, urlRef, true); injected = `${key} → ${target.name}`; }
    }
    ctx.emit('database.created', `Created ${i.engine} "${label}"${injected ? `, wired into the app` : ''}`, { severity: 'success', resource: serviceId });
    return { serviceId, engine: i.engine, connectionUrl: urlRef, passwordRef: pwRef, injected, note: `The connection URL is a vault reference (${urlRef}); the app resolves it at deploy time.` };
  },
});

// --- PgBouncer: a connection pooler in front of Postgres ------------------------------------------------
// Many app copies, workers and jobs each holding connections run Postgres out of slots ("too many
// clients"). The pooler takes them all and keeps a few real ones. Built on the server from Alpine's own
// package (no third-party image), on the private network only. Apps' DATABASE_URL moves to the pooler,
// DIRECT_URL keeps the direct line (migrations use it: they need session features). PgBouncer 1.21+
// keeps prepared statements working in transaction mode, so Prisma and postgres.js need no changes.
const POOL_IMAGE = 'unit7/pgbouncer:1';
const POOL_DOCKERFILE = 'FROM alpine:3.21\nRUN apk add --no-cache pgbouncer && adduser -D -H -u 6432 forgepool\nUSER 6432\nENTRYPOINT ["pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]\n';
const poolIni = (dbHost: string, mode: string, poolSize: number) => `[databases]
* = host=${dbHost} port=5432

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = ${mode}
max_client_conn = 2000
default_pool_size = ${poolSize}
max_prepared_statements = 200
ignore_startup_parameters = extra_float_digits,options
server_tls_sslmode = disable
`;

// the settings that use this database's direct URL (current versions only)
const usersOf = (ctx: Ctx, ref: string) => all<{ scope_type: string; scope_id: string; key: string }>(ctx.db,
  `SELECT v.scope_type, v.scope_id, v.key FROM env_vars v WHERE v.org_id = ? AND v.ref = ? AND v.deleted_at IS NULL
   AND v.version = (SELECT max(version) FROM env_vars w WHERE w.scope_type = v.scope_type AND w.scope_id = v.scope_id AND w.key = v.key)`, ctx.orgId, ref);

defineTool({
  name: 'database.pool', title: 'Connection pooling (PgBouncer)', risk: 'write', action: 'database_write', timeoutMs: 15 * 60_000,
  description: 'Put PgBouncer in front of a Postgres database (or take it away). Apps\u2019 DATABASE_URL moves to the pooler and DIRECT_URL keeps the direct line for migrations; apps using it redeploy. Fixes "too many clients" when an app runs several copies, workers or jobs. Warden turns it on by itself when an app runs out of connections.',
  input: z.object({ serviceId: fid('svc'), on: z.boolean().default(true), mode: z.enum(['transaction', 'session']).default('transaction'), poolSize: z.number().int().min(2).max(200).default(20) }),
  async run(ctx, i) {
    const { svc, cfg, s } = dbService(ctx, i.serviceId);
    if (svc.kind !== 'postgres') throw new Unit7Error('unsupported', 'Connection pooling is for Postgres databases.', 400);
    const pool = safeName(`${cfg.container}-pool`, 'container');
    const urlRef = refOf(cfg, 'url'), poolRef = refOf(cfg, 'pool-url');
    const label = (type: string, scopeId: string) => get<{ name: string }>(ctx.db, `SELECT name FROM ${type === 'service' ? 'services' : type === 'environment' ? 'environments' : 'projects'} WHERE id = ?`, scopeId)?.name ?? type;
    const moved: { scope_type: string; scope_id: string; key: string }[] = [];

    if (i.on) {
      const pw = ctx.secret(cfg.passwordRef!);
      ctx.progress(`Preparing PgBouncer on ${s.name}…`);
      await ssh(ctx.app).check(s, script(`docker image inspect "$1" >/dev/null 2>&1 && exit 0
        docker image inspect alpine:3.21 >/dev/null 2>&1 || docker pull -q alpine:3.21 >/dev/null 2>&1 || { docker pull -q mirror.gcr.io/library/alpine:3.21 >/dev/null && docker tag mirror.gcr.io/library/alpine:3.21 alpine:3.21; }
        printf '%b' "$2" | docker build -q -t "$1" - >/dev/null`, POOL_IMAGE, POOL_DOCKERFILE), { what: 'Building PgBouncer', timeoutMs: 10 * 60_000 });
      const dir = `/var/lib/unit7/pool/${pool}`;
      // the password goes in over stdin, never on a command line
      await ssh(ctx.app).check(s, script('umask 077; mkdir -p "$1" && cat > "$1/userlist.txt" && printf %s "$2" > "$1/pgbouncer.ini" && chown -R 6432:6432 "$1"', dir, poolIni(cfg.container, i.mode, i.poolSize)),
        { what: 'Writing the pooler\u2019s settings', stdin: `"postgres" "${pw.replace(/"/g, '""')}"\n` });
      await ssh(ctx.app).exec(s, cmd('docker', 'rm', '-f', pool));
      await ssh(ctx.app).check(s, cmd('docker', 'run', '-d', '--name', pool, '--restart', 'unless-stopped', '--network', 'unit7', '-v', `${dir}:/etc/pgbouncer:ro`, '--label', `unit7.pool=${svc.id}`, POOL_IMAGE), { what: 'Starting PgBouncer', timeoutMs: 120_000 });
      // prove it: a query through the pooler, from the database's own container
      await ssh(ctx.app).check(s, script(`${secretIn('PGPASSWORD')}for n in $(seq 1 30); do docker exec -e PGPASSWORD "$1" psql -h "$2" -p 6432 -U postgres -d "$3" -tAc "select 1" >/dev/null 2>&1 && exit 0; sleep 1; done; docker logs --tail 20 "$2" >&2; exit 1`,
        cfg.container, pool, cfg.database ?? 'app'), { what: 'Checking the pooler', timeoutMs: 60_000, stdin: `${pw}\n` });
      ctx.app.vault.put(ctx.orgId, poolRef, `postgresql://postgres:${pw}@${pool}:6432/${cfg.database ?? 'app'}`, { kind: 'connection_url', by: ctx.actor.name });
      for (const u of usersOf(ctx, urlRef).filter((x) => x.key !== 'DIRECT_URL')) {
        const scope = { type: u.scope_type as 'service', id: u.scope_id, label: label(u.scope_type, u.scope_id) };
        setVar(ctx, scope, u.key, poolRef, true);
        if (!usersOf(ctx, urlRef).some((x) => x.scope_id === u.scope_id && x.key === 'DIRECT_URL')) setVar(ctx, scope, 'DIRECT_URL', urlRef, true);
        moved.push(u);
      }
      run(ctx.db, 'UPDATE services SET config = ? WHERE id = ?', JSON.stringify({ ...cfg, pool: { container: pool, mode: i.mode } }), svc.id);
    } else {
      for (const u of usersOf(ctx, poolRef)) { setVar(ctx, { type: u.scope_type as 'service', id: u.scope_id, label: label(u.scope_type, u.scope_id) }, u.key, urlRef, true); moved.push(u); }
      await ssh(ctx.app).exec(s, cmd('docker', 'rm', '-f', pool));
      const { pool: _gone, ...rest } = cfg;
      run(ctx.db, 'UPDATE services SET config = ? WHERE id = ?', JSON.stringify(rest), svc.id);
    }

    // apps whose settings changed pick it up on a redeploy
    const apps = new Set<string>();
    for (const u of moved) {
      const ids = u.scope_type === 'service' ? [u.scope_id] : all<{ id: string }>(ctx.db, `SELECT id FROM services WHERE ${u.scope_type === 'environment' ? 'environment_id' : 'project_id'} = ? AND current_deployment_id IS NOT NULL`, u.scope_id).map((x) => x.id);
      for (const x of ids) if (get(ctx.db, `SELECT 1 FROM services WHERE id = ? AND current_deployment_id IS NOT NULL AND kind NOT IN ('postgres','mysql','mariadb','mongo','redis')`, x)) apps.add(x);
    }
    const redeployed: string[] = [];
    for (const appId of apps) {
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { serviceId: appId }, { reason: i.on ? 'use the connection pooler' : 'stop using the connection pooler' });
      redeployed.push(`${get<{ name: string }>(ctx.db, 'SELECT name FROM services WHERE id = ?', appId)!.name}: ${r.status === 'ok' ? 'redeployed' : r.status === 'error' ? r.error.message.slice(0, 120) : r.status}`);
    }
    ctx.emit('database.pooled', i.on ? `${svc.name} now has a connection pooler (PgBouncer, ${i.mode} mode)` : `${svc.name}'s connection pooler was removed`, { severity: 'success', resource: svc.id });
    return { database: svc.name, pooler: i.on ? `${pool}:6432 (${i.mode} mode, ${i.poolSize} real connections)` : 'off', settingsChanged: moved.map((u) => `${u.key} (${u.scope_type})`), redeployed,
      note: i.on ? 'DATABASE_URL goes through the pooler; DIRECT_URL is the direct line (Unit7 runs migrations with it).' : 'Apps connect to the database directly again.' };
  },
});

// --- changing a database's password --------------------------------------------------------------------
// The new password goes to the database over stdin (never a command line), then into the vault and the
// pooler, then every app using the database redeploys with it. If an app doesn't come back, the old
// password is put back everywhere. The current one signs in from stdin's first line; the SQL follows it.
async function setDbPassword(ctx: Ctx, s: ServerRow, engine: Engine, container: string, current: string, next: string) {
  if (engine === 'postgres') {
    await ssh(ctx.app).check(s, script(`${secretIn('PGPASSWORD')}docker exec -i -e PGPASSWORD "$1" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f -`, container), { what: 'Changing the password', stdin: `${current}\nALTER USER postgres WITH PASSWORD '${next}';\n` });
  } else {
    const client = engine === 'mariadb' ? 'mariadb' : 'mysql';
    await ssh(ctx.app).check(s, script(`${secretIn('MYSQL_PWD')}docker exec -i -e MYSQL_PWD "$1" ${client} -uroot`, container), { what: 'Changing the password', stdin: `${current}\nALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY '${next}'; ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY '${next}'; FLUSH PRIVILEGES;\n` });
  }
}

export async function rotateDbPassword(ctx: Ctx, serviceId: string, reason: string) {
  const { svc, cfg, s } = dbService(ctx, serviceId);
  if (!['postgres', 'mysql', 'mariadb'].includes(svc.kind)) throw new Unit7Error('unsupported', `Changing a ${svc.kind} password isn\u2019t automated yet (Postgres, MySQL and MariaDB are).`, 400);
  const engine = svc.kind as Engine, db = cfg.database ?? 'app';
  const urlRef = refOf(cfg, 'url'), poolRef = refOf(cfg, 'pool-url');
  const old = ctx.secret(cfg.passwordRef!), next = randomBytes(18).toString('base64url');
  ctx.redactor.add(next, 'new database password');
  const write = async (pw: string) => {
    ctx.app.vault.put(ctx.orgId, cfg.passwordRef!, pw, { kind: 'db_password', by: `rotation (${reason})` });
    ctx.app.vault.put(ctx.orgId, urlRef, urlFor(engine, cfg.container, pw, db), { kind: 'connection_url', by: 'rotation' });
    if (cfg.pool) {
      ctx.app.vault.put(ctx.orgId, poolRef, `postgresql://postgres:${pw}@${cfg.pool.container}:6432/${db}`, { kind: 'connection_url', by: 'rotation' });
      // a restart (about a second) rather than a reload signal: PgBouncer kept the old user list after SIGHUP in testing
      await ssh(ctx.app).check(s, script('umask 077; cat > "$1/userlist.txt" && chown 6432:6432 "$1/userlist.txt" && docker restart "$2" >/dev/null', `/var/lib/unit7/pool/${cfg.pool.container}`, cfg.pool.container), { what: 'Updating the pooler', stdin: `"postgres" "${pw.replace(/"/g, '""')}"\n` });
      await ssh(ctx.app).check(s, script(`${secretIn('PGPASSWORD')}for n in $(seq 1 20); do docker exec -e PGPASSWORD "$1" psql -h "$2" -p 6432 -U postgres -d "$3" -tAc "select 1" >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`, cfg.container, cfg.pool.container, db), { what: 'Checking the pooler', timeoutMs: 40_000, stdin: `${pw}\n` });
    }
  };
  ctx.progress(`Changing ${svc.name}'s password…`);
  await setDbPassword(ctx, s, engine, cfg.container, old, next);
  try { await write(next); } catch (e) {
    // the database already has the new password, but the vault or pooler didn't take it: put the old one
    // back in the database (and the vault), or every app loses its connection
    await setDbPassword(ctx, s, engine, cfg.container, next, old);
    await write(old).catch(() => undefined);
    throw e;
  }
  // every app using it gets the new password on a redeploy
  const apps = new Set<string>();
  for (const u of [...usersOf(ctx, urlRef), ...usersOf(ctx, poolRef)]) {
    const ids = u.scope_type === 'service' ? [u.scope_id] : all<{ id: string }>(ctx.db, `SELECT id FROM services WHERE ${u.scope_type === 'environment' ? 'environment_id' : 'project_id'} = ?`, u.scope_id).map((x) => x.id);
    for (const x of ids) if (get(ctx.db, `SELECT 1 FROM services WHERE id = ? AND current_deployment_id IS NOT NULL AND kind NOT IN ('postgres','mysql','mariadb','mongo','redis')`, x)) apps.add(x);
  }
  const failed: string[] = [], switched: string[] = [];
  for (const appId of apps) {
    const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { serviceId: appId }, { reason: `new ${svc.name} password` });
    if (r.status !== 'ok') failed.push(`${get<{ name: string }>(ctx.db, 'SELECT name FROM services WHERE id = ?', appId)!.name}: ${r.status === 'error' ? r.error.message.slice(0, 120) : r.status}`);
    else switched.push(appId);
  }
  if (failed.length) {
    await setDbPassword(ctx, s, engine, cfg.container, next, old);
    await write(old);
    // the apps that already moved to the new password go back too, or they'd be the ones that break
    for (const appId of switched) await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { serviceId: appId }, { reason: `${svc.name} password change undone` });
    ctx.emit('secret.rotation_failed', `${svc.name}'s password change was undone: ${failed.join('; ')}`, { severity: 'warning', resource: svc.id });
    throw new Unit7Error('rotation_undone', `An app didn\u2019t come back with the new password, so the old one was put back everywhere: ${failed.join('; ')}`, 502);
  }
  ctx.emit('secret.rotated', `${svc.name}'s password changed (${reason}); ${apps.size} app${apps.size === 1 ? '' : 's'} redeployed with it`, { severity: 'success', resource: svc.id });
  return { database: svc.name, redeployed: apps.size, reason };
}

defineTool({
  name: 'database.rotate_password', title: 'Change a database\u2019s password', risk: 'write', action: 'database_write', timeoutMs: 30 * 60_000,
  description: 'Give a Unit7-run Postgres, MySQL or MariaDB database a new password and redeploy every app using it. If an app doesn\u2019t come back, the old password is put back everywhere. Warden does this on the schedule you set, and at once if the password leaks.',
  input: z.object({ serviceId: fid('svc'), reason: z.string().max(200).default('manual') }),
  run: (ctx, i) => rotateDbPassword(ctx, i.serviceId, i.reason),
});

// A write is plain (no backup, and routine where writes are) only when it's one INSERT, one UPDATE with a WHERE,
// or one simple Redis SET/HSET-style command. Everything else counts as destructive: a list of dangerous words
// can always be dodged (DO $$ EXECUTE 'DR' || 'OP …' $$, PREPARE … FROM CONCAT(…), db.users['dro'+'p']()).
// The tool's risk is decided before the engine is known, so the Redis shapes exclude SQL's persistent SETs.
const PLAIN_SQL = /^\s*(insert\s+into|update)\s+[\w."`]+/i;
const PLAIN_REDIS = /^[ \t]*(set(?![ \t]+(password|default|resource|global|persist\w*|role|session|local)\b)|hset|sadd|lpush|rpush|zadd|incr|incrby|decr)([ \t]+[^\s;=()\\]+)+[ \t]*$/i;
export function plainWrite(sql: string): boolean {
  if (PLAIN_REDIS.test(sql)) return true;
  if (!PLAIN_SQL.test(sql) || /;\s*\S/.test(sql) || /\\/.test(sql)) return false; // one statement, no client escapes
  if (/\b(do|execute|prepare|call|select|returning)\b/i.test(sql) || /^\s*(system|delimiter|source)\b/im.test(sql)) return false;
  if (/^\s*update\b/i.test(sql) && !/\bwhere\b/i.test(sql)) return false; // every row
  // nothing that looks like a function call (VALUES (…) and the column list aren't)
  return !/[\w$"`\]]\s*\(/.test(sql.replace(PLAIN_SQL, '').replace(/\bvalues\s*\(/gi, '('));
}

defineTool({
  name: 'database.inspect', title: 'Inspect a database', risk: 'read', action: 'read', timeoutMs: 30_000,
  description: 'Schema overview: tables with row estimates and sizes (SQL), or keyspace/info (Redis), or collections (Mongo).',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const { svc, cfg, s } = dbService(ctx, i.serviceId);
    const q = query(cfg, {
      postgres: `SELECT relname AS table, n_live_tup AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC`,
      mysql: `SELECT table_name AS 'table', table_rows AS 'rows', ROUND((data_length+index_length)/1024/1024,1) AS 'size_mb' FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY data_length+index_length DESC`,
      mongo: `db.getCollectionNames().map(c=>({collection:c,count:db[c].countDocuments()}))`,
      redis: `INFO keyspace`,
    });
    const out = await withPassword(ctx, s, cfg, q, { what: 'Inspecting the database', timeoutMs: 25_000 });
    return { engine: cfg.engine, database: cfg.database, result: parseDbOutput(cfg, out) };
  },
});

defineTool({
  name: 'database.query', title: 'Run a query', risk: (i) => (i.write ? (plainWrite(i.sql) ? 'write' : 'destructive') : 'read'),
  action: (i) => (i.write ? 'database_write' : 'read'), timeoutMs: 60_000,
  description: 'Run SQL (or a Redis/Mongo command). Read-only by default, as a database user that can only read. Set write:true for changes. Only a single INSERT, an UPDATE with a WHERE, or a simple Redis SET/HSET-style command counts as a plain write; anything else is destructive and takes a backup first.',
  input: z.object({ serviceId: fid('svc'), sql: z.string().min(1).max(20_000), write: z.boolean().default(false) }),
  async run(ctx, i) {
    const { svc, cfg, s } = dbService(ctx, i.serviceId);
    if (cfg.engine === 'redis' || cfg.engine === 'mongo') {
      if (!i.write && /\b(set|del|flush|drop|rename|expire|insert|update|remove|deleteone|deletemany|createcollection)\b/i.test(i.sql)) throw new Unit7Error('needs_write', 'That looks like a write. Set write: true.');
    }
    const destructive = !plainWrite(i.sql);
    if (!i.write && cfg.engine !== 'redis' && cfg.engine !== 'mongo' && (/\\/.test(i.sql) || /^\s*system\b/im.test(i.sql))) {
      // psql's \! and mysql's system run a shell in the client: never part of a read
      throw new Unit7Error('client_command', 'Client commands (a backslash, or system) aren\u2019t allowed in a query.', 400);
    }
    if (i.write && destructive) await backupBeforeChange(ctx, i.serviceId, 'run a destructive query');
    const out = i.write
      ? await withPassword(ctx, s, cfg, query(cfg, { postgres: i.sql, mysql: i.sql, mongo: i.sql, redis: i.sql }), { what: 'Running the query', timeoutMs: 55_000, signal: ctx.signal })
      : await readOnlyQuery(ctx, cfg, s, i.sql);
    if (i.write) ctx.emit('database.write', `Query ran on ${svc.name}`, { resource: svc.id, data: { destructive } });
    return { result: ctx.redactor.redact(out.slice(0, 40_000)) };
  },
});

defineTool({
  name: 'database.slow_queries', title: 'Slowest queries', risk: 'read', action: 'read', timeoutMs: 30_000,
  description: 'Postgres: the slowest statements from pg_stat_statements (enables the extension if needed). Use to find missing indexes.',
  input: z.object({ serviceId: fid('svc'), limit: z.number().int().min(1).max(50).default(15) }),
  async run(ctx, i) {
    const { cfg, s } = dbService(ctx, i.serviceId);
    if (cfg.engine !== 'postgres') throw new Unit7Error('unsupported', 'Slow-query analysis is Postgres-only for now.');
    const q = `CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT round(mean_exec_time::numeric,1) AS mean_ms, calls, round(total_exec_time::numeric,0) AS total_ms, left(query,160) AS query FROM pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%' ORDER BY mean_exec_time DESC LIMIT ${i.limit}`;
    const out = await withPassword(ctx, s, cfg, query(cfg, { postgres: q, mysql: '', mongo: '', redis: '' }), { what: 'Reading slow queries', timeoutMs: 25_000 });
    return { note: 'pg_stat_statements records stats since it was enabled. Highest mean time first.', result: parseDbOutput(cfg, out) };
  },
});

// --- helpers ------------------------------------------------------------------------------------

type ByEngine = { postgres: string; mysql: string; mongo: string; redis: string; mariadb?: string };
const pick = (cfg: DbConfig, m: ByEngine) => (cfg.engine === 'mariadb' ? m.mariadb ?? m.mysql : m[cfg.engine]);
function query(cfg: DbConfig, byEngine: ByEngine) { return { cfg, sql: pick(cfg, byEngine) }; }

// Run a query as the database's admin: the password on stdin's first line, handed to the client by name only
// (never in argv or logs). mongosh takes none from the environment, so it signs in from its script (process.env).
function withPassword(ctx: Ctx, s: ServerRow, cfg: DbConfig, q: { cfg: DbConfig; sql: string }, o: { what: string; timeoutMs: number; signal?: AbortSignal }) {
  const pw = cfg.passwordRef ? ctx.secret(cfg.passwordRef) : '';
  const c = safeName(cfg.container, 'container');
  const db = cfg.database ?? 'app';
  const body: Record<Engine, string> = {
    postgres: `${secretIn('PGPASSWORD')}exec docker exec -i -e PGPASSWORD "$1" psql -U postgres -d "$2" -v ON_ERROR_STOP=1 -c "$3"`,
    mysql: `${secretIn('MYSQL_PWD')}exec docker exec -i -e MYSQL_PWD "$1" mysql -u root "$2" -e "$3"`,
    mariadb: `${secretIn('MYSQL_PWD')}exec docker exec -i -e MYSQL_PWD "$1" mariadb -u root "$2" -e "$3"`,
    mongo: `${secretIn('UNIT7_PW')}exec docker exec -i -e UNIT7_PW "$1" mongosh "mongodb://localhost:27017/$2" --quiet --eval "db.getSiblingDB('admin').auth('root', process.env.UNIT7_PW); $3"`,
    // the command is data for redis-cli to parse, never shell: printf hands it over as one line
    redis: `${secretIn('REDISCLI_AUTH')}exec docker exec -i -e REDISCLI_AUTH "$1" sh -c 'printf "%s\\n" "$1" | redis-cli' unit7 "$3"`,
  };
  return ssh(ctx.app).check(s, script(body[cfg.engine], c, db, q.sql), { ...o, stdin: `${pw}\n` });
}

// --- read-only queries ------------------------------------------------------------------------------
// "Read" must not depend on reading the SQL right. A read runs as a database user that can only read, in a
// throwaway client container with no volumes on the private network: the database refuses writes whatever
// the text says, and client escapes (psql \!, mysql `system`, mongosh's require) reach only that empty
// container. Passwords go on stdin, never on a command line. The user is (re)set on each read, so a
// restarted Redis (whose ACL users live in memory) or a rotated password just works.
const RO = 'unit7_readonly';
const jsq = (s: string) => JSON.stringify(s);
async function readOnlyQuery(ctx: Ctx, cfg: DbConfig, s: ServerRow, sql: string) {
  const ref = refOf(cfg, 'readonly-password');
  let ro: string;
  try { ro = ctx.secret(ref); } catch {
    ro = randomBytes(18).toString('base64url');
    ctx.app.vault.put(ctx.orgId, ref, ro, { kind: 'db_password', by: 'Unit7' });
    ctx.redactor.add(ro, ref);
  }
  const admin = cfg.passwordRef ? ctx.secret(cfg.passwordRef) : '';
  const c = safeName(cfg.container, 'container');
  const db = cfg.database ?? 'app'; // validated at create: [a-zA-Z_][a-zA-Z0-9_]*
  const image = IMAGES[cfg.engine];
  const pool = ssh(ctx.app);
  // first stdin line → $P (exported only to the one command that needs it), the rest → the client
  const withP = (body: string, ...args: string[]) => script(`IFS= read -r P; ${body}`, ...args);
  const setup: Record<Engine, { cmd: string; input: string }> = {
    postgres: { cmd: withP('PGPASSWORD="$P" exec docker exec -i -e PGPASSWORD "$1" psql -X -q -U postgres -d "$2" -v ON_ERROR_STOP=1', c, db), input:
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RO}') THEN CREATE ROLE ${RO}; END IF; END $$;
ALTER ROLE ${RO} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${ro}';
GRANT pg_read_all_data TO ${RO};
ALTER ROLE ${RO} SET default_transaction_read_only = on;
` },
    mysql: { cmd: withP('MYSQL_PWD="$P" exec docker exec -i -e MYSQL_PWD "$1" mysql -u root', c), input:
      `CREATE USER IF NOT EXISTS '${RO}'@'%' IDENTIFIED BY '${ro}';
ALTER USER '${RO}'@'%' IDENTIFIED BY '${ro}';
GRANT SELECT, SHOW VIEW ON \`${db}\`.* TO '${RO}'@'%';
` },
    mariadb: { cmd: withP('MYSQL_PWD="$P" exec docker exec -i -e MYSQL_PWD "$1" mariadb -u root', c), input:
      `CREATE USER IF NOT EXISTS '${RO}'@'%' IDENTIFIED BY '${ro}';
ALTER USER '${RO}'@'%' IDENTIFIED BY '${ro}';
GRANT SELECT, SHOW VIEW ON \`${db}\`.* TO '${RO}'@'%';
` },
    mongo: { cmd: withP(`exec docker exec -i "$1" sh -c 'f=$(mktemp); cat > "$f"; mongosh mongodb://localhost:27017/admin --quiet --file "$f"; r=$?; rm -f "$f"; exit $r'`, c), input:
      `const a = db.getSiblingDB('admin'); a.auth('root', ${jsq(admin)});
const roles = [{ role: 'read', db: ${jsq(db)} }];
if (a.getUser(${jsq(RO)})) a.updateUser(${jsq(RO)}, { pwd: ${jsq(ro)}, roles }); else a.createUser({ user: ${jsq(RO)}, pwd: ${jsq(ro)}, roles });
` },
    redis: { cmd: withP('REDISCLI_AUTH="$P" exec docker exec -i -e REDISCLI_AUTH "$1" redis-cli', c), input:
      `ACL SETUSER ${RO} reset on >${ro} ~* &* +@read +@connection -@dangerous +info
` },
  };
  // the client runs as nobody, with no capabilities and a read-only filesystem (mongosh needs a writable HOME)
  const box = '--rm -i --network unit7 --user 65534 --cap-drop ALL --read-only --security-opt no-new-privileges --tmpfs /tmp -e HOME=/tmp';
  const read: Record<Engine, string> = {
    postgres: withP(`PGPASSWORD="$P" exec docker run ${box} -e PGPASSWORD --entrypoint psql "$1" -X -h "$2" -U "$3" -d "$4" -v ON_ERROR_STOP=1`, image, c, RO, db),
    mysql: withP(`MYSQL_PWD="$P" exec docker run ${box} -e MYSQL_PWD --entrypoint mysql "$1" -h "$2" -u "$3" "$4"`, image, c, RO, db),
    mariadb: withP(`MYSQL_PWD="$P" exec docker run ${box} -e MYSQL_PWD --entrypoint mariadb "$1" -h "$2" -u "$3" "$4"`, image, c, RO, db),
    // mongosh takes no password from the environment, so it signs in from its script (process.env), not its arguments
    mongo: withP(`P="$P" exec docker run ${box} -e P --entrypoint sh "$1" -c 'exec mongosh "mongodb://$1:27017/$2" --quiet --eval "db.getSiblingDB(\\"admin\\").auth(\\"$0\\", process.env.P); $(cat)"' "$3" "$2" "$4"`, image, c, RO, db),
    redis: withP(`REDISCLI_AUTH="$P" exec docker run ${box} -e REDISCLI_AUTH --entrypoint redis-cli "$1" -h "$2" --user "$3"`, image, c, RO),
  };
  await pool.check(s, setup[cfg.engine].cmd, { what: 'Preparing the read-only database user', stdin: `${admin}\n${setup[cfg.engine].input}`, timeoutMs: 30_000, signal: ctx.signal });
  return pool.check(s, read[cfg.engine], { what: 'Running the query', stdin: `${ro}\n${sql}\n`, timeoutMs: 55_000, signal: ctx.signal });
}

function parseDbOutput(cfg: DbConfig, out: string) {
  if (cfg.engine === 'mongo' || cfg.engine === 'redis') return out.trim();
  return out.trim();
}
