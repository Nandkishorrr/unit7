// Backups. A database is dumped to /var/lib/unit7/backups on its server, gzipped, checksummed.
// Unit7 takes one automatically before anything that could lose data, and on a schedule. Restores
// are gated. "Never destroy data" means a backup exists before a destructive step runs.
import { z } from 'zod';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { cmd, gzipInto, script, safeName, secretIn, shq } from '../connectors/shell.ts';
import { serverRow } from './servers.ts';
import { fid, isAgent, requireHuman } from './helpers.ts';
import { forbidden } from '../errors.ts';

export const BACKUPS = '/var/lib/unit7/backups';
export interface DbServiceConfig { engine: 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis'; container: string; database?: string; userRef?: string; passwordRef?: string }

export interface SvcRow { id: string; org_id: string; name: string; slug: string; kind: string; config: string; server_id: string | null; environment_id: string }

export function dbService(ctx: Ctx, serviceId: string): { svc: SvcRow; s: ServerRow; db: DbServiceConfig } {
  const svc = get<SvcRow>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  if (!svc) throw new Unit7Error('not_found', 'That service was not found.', 404);
  const cfg = json<DbServiceConfig>(svc.config, {} as DbServiceConfig);
  if (!['postgres', 'mysql', 'mariadb', 'mongo', 'redis'].includes(svc.kind)) throw new Unit7Error('not_a_database', `${svc.name} is not a database.`);
  if (!svc.server_id) throw new Unit7Error('no_server', `${svc.name} isn't on a server.`);
  return { svc, s: serverRow(ctx, svc.server_id), db: { ...cfg, engine: svc.kind as DbServiceConfig['engine'], container: cfg.container } };
}

// --- an app's saved files (its volumes, src/deploy/volumes.ts): one .tgz with a folder per volume ----------------------------
type Vol = { name: string; path: string };
const volumesOf = (svc: SvcRow): Vol[] => json<{ volumes?: Vol[] }>(svc.config, {}).volumes ?? [];
// the service and server a backup belongs to: a database, or an app that keeps files
export function backupHost(ctx: Ctx, serviceId: string): { svc: SvcRow; s: ServerRow; files?: Vol[] } {
  const svc = get<SvcRow>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  const files = svc && volumesOf(svc);
  if (svc && files?.length && !DB_KINDS.includes(svc.kind)) {
    if (!svc.server_id) throw new Unit7Error('no_server', `${svc.name} isn't on a server.`);
    return { svc, s: serverRow(ctx, svc.server_id), files };
  }
  return dbService(ctx, serviceId);
}
const DB_KINDS = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
// each volume read-only under /b/<folder>, packed by a small image (the app's own may have no tar)
const filesMounts = (vols: Vol[], ro: boolean) => vols.map((v) => `-v ${shq(`${safeName(v.name, 'volume')}:/b/${v.path.split('/').pop()}${ro ? ':ro' : ''}`)}`).join(' ');
export const filesBackupScript = (vols: Vol[]) => `docker run --rm ${filesMounts(vols, true)} alpine:3 tar czf - -C /b . > "$1" && gzip -t "$1" && test -s "$1"`;
// the app's copies stop while their files are swapped back (a SQLite file mid-write would be damaged), then start again
export const filesRestoreScript = (vols: Vol[]) => `ids=$(docker ps -q --filter "label=unit7.service=$2"); [ -z "$ids" ] || docker stop $ids >/dev/null; docker run --rm -i ${filesMounts(vols, false)} alpine:3 sh -c 'for d in /b/*/; do find "$d" -mindepth 1 -delete; done; tar xzf - -C /b' < "$1"; rc=$?; [ -z "$ids" ] || docker start $ids >/dev/null; exit $rc`;

async function takeFilesBackup(ctx: Ctx, svc: SvcRow, s: ServerRow, vols: Vol[], reason: string) {
  const backupId = id('bak');
  const file = `${BACKUPS}/${svc.slug}-files-${new Date().toISOString().replace(/[:.]/g, '-')}.tgz`;
  run(ctx.db, `INSERT INTO backups (id, org_id, service_id, kind, reason, location, status) VALUES (?, ?, ?, 'files', ?, ?, 'running')`, backupId, ctx.orgId, svc.id, reason, file);
  ctx.progress(`Backing up ${svc.name}’s saved files…`);
  try {
    await ssh(ctx.app).check(s, script(`mkdir -p "$(dirname "$1")" && ${filesBackupScript(vols)}`, file), { what: 'Backing up the saved files', timeoutMs: 20 * 60_000, signal: ctx.signal });
    const meta = (await ssh(ctx.app).exec(s, script(`wc -c < "$1"; sha256sum "$1" | cut -d" " -f1`, file))).stdout.trim().split('\n');
    const size = Number(meta[0] ?? 0);
    run(ctx.db, `UPDATE backups SET status = 'done', size = ?, checksum = ?, finished_at = ? WHERE id = ?`, size, meta[1] ?? '', now(), backupId);
    ctx.emit('backup.created', `Backed up ${svc.name}’s saved files (${(size / 1024 / 1024).toFixed(1)} MB) — ${reason}`, { resource: svc.id, data: { backupId } });
    if (get<{ offsite: string }>(ctx.db, 'SELECT offsite FROM orgs WHERE id = ?', ctx.orgId)?.offsite !== 'off') void execute(ctx.app, ctx.orgId, ctx.actor, 'backup.offsite_copy', { backupId }, { reason: 'off-server copy' });
    return { backupId, size, location: file };
  } catch (e) {
    run(ctx.db, `UPDATE backups SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, (e as Error).message.slice(0, 500), now(), backupId);
    throw e;
  }
}

// What writes a raw dump to stdout, per engine. The password comes from the vault via an env var on
// the remote process. takeBackup gzips it and checks the dump's own exit status (a failed dump must
// never look like a small, valid backup).
function dumpCommand(db: DbServiceConfig): { dump: string; args: string[] } {
  const c = safeName(db.container, 'container');
  switch (db.engine) {
    case 'postgres': return { dump: `docker exec -e PGPASSWORD "$1" pg_dump -U "$4" -d "$5" --no-owner --clean --if-exists`, args: [c, '', '$PW', db.userRef ? 'unit7' : 'postgres', db.database ?? 'app'] };
    case 'mysql': case 'mariadb': return { dump: `docker exec -e MYSQL_PWD "$1" ${db.engine === 'mariadb' ? 'mariadb-dump' : 'mysqldump'} -u "$4" --single-transaction --databases "$5"`, args: [c, '', '$PW', 'root', db.database ?? 'app'] };
    case 'mongo': return { dump: `docker exec "$1" mongodump --archive --gzip`, args: [c, ''] };
    // Unit7's Redis has a password; redis-cli exits 0 even on an auth error, so check the reply is OK
    case 'redis': return { dump: `test "$(docker exec -e REDISCLI_AUTH "$1" redis-cli --no-auth-warning SAVE)" = OK && docker exec "$1" cat /data/dump.rdb`, args: [c, '', '$PW'] };
  }
}

// The password comes in on stdin (never a command-line argument, which any process list shows) and lives only in
// this shell's environment; `docker exec -e NAME` forwards it by name, so no command line ever holds the value.
const PW_IN = secretIn('PGPASSWORD', 'MYSQL_PWD', 'REDISCLI_AUTH');

const wrapDump = (dump: string) => `${gzipInto(`${dump} 2>"$2.err"`, '$2', 'cat "$2.err" >&2; rm -f "$2.err"')}; rm -f "$2.err"; test -s "$2"`;

export async function takeBackup(ctx: Ctx, serviceId: string, reason: string): Promise<{ backupId: string; size: number; location: string }> {
  const host = backupHost(ctx, serviceId);
  if (host.files) return takeFilesBackup(ctx, host.svc, host.s, host.files, reason);
  const { svc, s, db } = dbService(ctx, serviceId);
  const backupId = id('bak');
  const file = `${BACKUPS}/${svc.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.gz`;
  run(ctx.db, `INSERT INTO backups (id, org_id, service_id, kind, reason, location, status) VALUES (?, ?, ?, ?, ?, ?, 'running')`, backupId, ctx.orgId, serviceId, db.engine, reason, file);
  ctx.progress(`Backing up ${svc.name}…`);
  try {
    const { dump, args } = dumpCommand(db);
    const pw = db.passwordRef ? ctx.secret(db.passwordRef) : '';
    const resolved = args.map((a, k) => (a === '$PW' ? '' : k === 1 ? file : a));
    await ssh(ctx.app).check(s, script(PW_IN + wrapDump(dump), ...resolved), { what: 'Backing up', timeoutMs: 20 * 60_000, signal: ctx.signal, stdin: `${pw}\n` });
    const meta = (await ssh(ctx.app).exec(s, script(`wc -c < "$1"; sha256sum "$1" | cut -d" " -f1`, file))).stdout.trim().split('\n');
    const size = Number(meta[0] ?? 0);
    const checksum = meta[1] ?? '';
    run(ctx.db, `UPDATE backups SET status = 'done', size = ?, checksum = ?, finished_at = ? WHERE id = ?`, size, checksum, now(), backupId);
    ctx.emit('backup.created', `Backed up ${svc.name} (${(size / 1024 / 1024).toFixed(1)} MB) — ${reason}`, { resource: serviceId, data: { backupId } });
    // and off the server, in the background (to this computer, and the bucket if one is connected)
    if (get<{ offsite: string }>(ctx.db, 'SELECT offsite FROM orgs WHERE id = ?', ctx.orgId)?.offsite !== 'off') void execute(ctx.app, ctx.orgId, ctx.actor, 'backup.offsite_copy', { backupId }, { reason: 'off-server copy' });
    return { backupId, size, location: file };
  } catch (e) {
    run(ctx.db, `UPDATE backups SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, (e as Error).message.slice(0, 500), now(), backupId);
    throw e;
  }
}

// Called before any destructive data operation. "Never destroy data" in one place.
export async function backupBeforeChange(ctx: Ctx, serviceId: string, reason: string) {
  try {
    return await takeBackup(ctx, serviceId, `before ${reason}`);
  } catch (e) {
    throw new Unit7Error('backup_failed', `Unit7 wouldn't ${reason} because the safety backup failed: ${(e as Error).message}. Nothing was changed.`, 502);
  }
}

// Safety backups (before a deploy, a restore, a removal; manual ones) are kept a week, and never fewer than the newest 3
export const SAFETY_DAYS = 7, SAFETY_KEEP = 3;

// keep the newest `keep` scheduled backups of a database; older ones go from the server and from off the server.
// Safety backups don't count against `keep` (a busy deploy day would push out every scheduled one): they age out.
export async function pruneBackups(ctx: Ctx, serviceId: string, keep: number) {
  const cols = 'SELECT id, location, offsite, created_at FROM backups WHERE service_id = ? AND org_id = ? AND status = \'done\'';
  const old = [
    ...all<{ id: string; location: string; offsite: string | null }>(ctx.db, `${cols} AND reason LIKE 'scheduled%' ORDER BY created_at DESC LIMIT -1 OFFSET ?`, serviceId, ctx.orgId, keep),
    ...all<{ id: string; location: string; offsite: string | null }>(ctx.db, `SELECT * FROM (${cols} AND reason NOT LIKE 'scheduled%' ORDER BY created_at DESC LIMIT -1 OFFSET ?) WHERE created_at < ?`,
      serviceId, ctx.orgId, SAFETY_KEEP, new Date(Date.now() - SAFETY_DAYS * 86400_000).toISOString()),
  ];
  if (!old.length) return { removed: 0 };
  const { s } = backupHost(ctx, serviceId);
  const { removeOffsite } = await import('./offsite.ts');
  for (const b of old) {
    await ssh(ctx.app).exec(s, script('rm -f "$1"', b.location)).catch(() => undefined);
    await removeOffsite(ctx, b.offsite);
    run(ctx.db, 'DELETE FROM backups WHERE id = ?', b.id);
  }
  return { removed: old.length };
}

// --- proving a backup: restore it into a throwaway database and count what came back -------------

// tables (or collections) in a database, by engine; the same query runs on the live DB and the copy
const COUNT: Record<string, (db: string) => string> = {
  postgres: () => `select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')`,
  mysql: (db) => `select count(*) from information_schema.tables where table_schema='${db.replace(/[^\w]/g, '')}'`,
};

// The database a backup goes back into: its own, or (its service was removed, or a person chose) another
// one of the same engine. A removed service leaves its backups with no service_id.
export function backupTarget(ctx: Ctx, b: { service_id: string | null; kind: string }, serviceId?: string) {
  const target = serviceId ?? b.service_id;
  if (!target) throw new Unit7Error('service_gone', `The database this backup came from was removed. Pass serviceId: another ${b.kind} database to use it with.`, 409);
  const t = dbService(ctx, target);
  if (t.db.engine !== b.kind) throw new Unit7Error('wrong_engine', `That is a ${b.kind} backup; ${t.svc.name} is ${t.db.engine}.`, 400);
  return t;
}

export async function verifyBackup(ctx: Ctx, backupId: string, location?: string, serviceId?: string): Promise<{ ok: boolean; note: string }> {
  const b = get<{ service_id: string | null; kind: string; location: string; status: string }>(ctx.db, 'SELECT service_id, kind, location, status FROM backups WHERE id = ? AND org_id = ?', backupId, ctx.orgId);
  if (!b) throw new Unit7Error('not_found', 'That backup was not found.', 404);
  if (b.status !== 'done') throw new Unit7Error('bad_backup', 'That backup did not finish successfully.');
  if (b.kind === 'files') { // saved files: the archive reads back whole, and says how much is in it
    const { svc, s } = backupHost(ctx, serviceId ?? b.service_id!);
    const r = await ssh(ctx.app).exec(s, script('gzip -t "$1" && tar -tzf "$1" | wc -l', location ?? b.location), { timeoutMs: 10 * 60_000 });
    const n = Number(r.stdout.trim()), ok = r.code === 0 && n > 0;
    const note = ok ? `${n} files and folders read back` : (r.stderr.trim().slice(-160) || 'the archive is damaged');
    run(ctx.db, 'UPDATE backups SET verified_at = ?, verify_ok = ?, verify_note = ? WHERE id = ?', now(), ok ? 1 : 0, note, backupId);
    ctx.emit(ok ? 'backup.verified' : 'backup.verify_failed', ok ? `${svc.name}’s saved files back up cleanly (${note})` : `${svc.name}’s saved-files backup does NOT read back: ${note}`, { severity: ok ? 'success' : 'critical', resource: svc.id });
    return { ok, note };
  }
  // a removed database's backup is proven on the server (and with the image) of the one named instead
  const { svc, s, db } = backupTarget(ctx, b, b.service_id ? undefined : serviceId);
  const own = !!b.service_id;
  if (location) b.location = location; // proving a copy brought back from off the server
  const pool = ssh(ctx.app);
  const c = safeName(db.container, 'container');
  const image = (await pool.exec(s, cmd('docker', 'inspect', '-f', '{{.Config.Image}}', c))).stdout.trim();
  const scratch = `unit7-verify-${backupId.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const name = db.database ?? 'app';
  const finish = (ok: boolean, note: string) => {
    run(ctx.db, 'UPDATE backups SET verified_at = ?, verify_ok = ?, verify_note = ? WHERE id = ?', now(), ok ? 1 : 0, note, backupId);
    ctx.emit(ok ? 'backup.verified' : 'backup.verify_failed', ok ? `Backup of ${svc.name}${location ? ' (its off-server copy)' : ''} restores cleanly (${note})` : `Backup of ${svc.name}${location ? ' (its off-server copy)' : ''} does NOT restore: ${note}`, { severity: ok ? 'success' : 'critical', resource: svc.id });
    return { ok, note };
  };
  ctx.progress(`Restoring ${svc.name}'s backup into a throwaway copy to prove it works…`);
  try {
    // a file cut short (a full disk, a lost connection) can still load some tables, so it has to read back whole first
    if ((await pool.exec(s, script('gunzip -t "$1"', b.location), { timeoutMs: 10 * 60_000 })).code !== 0) return finish(false, 'the file is damaged: it doesn’t read back whole');
    if (db.engine === 'redis') {
      const r = await pool.exec(s, script('gunzip -c "$1" | docker run -i --rm "$2" sh -c "cat > /tmp/d.rdb && redis-check-rdb /tmp/d.rdb" 2>&1', b.location, image), { timeoutMs: 5 * 60_000 });
      return finish(/RDB looks OK/.test(r.stdout), /RDB looks OK/.test(r.stdout) ? 'the snapshot checks out' : r.stdout.trim().slice(-200));
    }
    const env = db.engine === 'postgres' ? ['-e', 'POSTGRES_PASSWORD=verify'] : db.engine === 'mongo' ? [] : ['-e', 'MYSQL_ROOT_PASSWORD=verify'];
    await pool.check(s, cmd('docker', 'run', '-d', '--rm', '--name', scratch, ...env, image), { what: 'Starting a throwaway database', timeoutMs: 120_000 });
    const ready = db.engine === 'postgres' ? 'pg_isready -U postgres' : db.engine === 'mongo' ? 'mongosh --quiet --eval 1' : 'mysqladmin ping -uroot -pverify --silent';
    await pool.check(s, script(`for i in $(seq 60); do docker exec "$1" sh -c "$2" >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`, scratch, ready), { what: 'Waiting for the throwaway database', timeoutMs: 90_000 });
    const { PG_SAID, provePostgres } = await import('./partbackup.ts');
    const load: Record<string, string> = {
      // psql carries on past an error, and some are harmless (a role the throwaway doesn't have), so what came back is the test, not how it went
      postgres: `gunzip -c "$1" | docker exec -i "$2" psql -U postgres -q 2>&1 >/dev/null | ${PG_SAID}; true`,
      mysql: `gunzip -c "$1" | docker exec -i "$2" mysql -uroot -pverify 2>"$1.verr"`,
      mariadb: `gunzip -c "$1" | docker exec -i "$2" mariadb -uroot -pverify 2>"$1.verr"`,
      mongo: `gunzip -c "$1" | docker exec -i "$2" mongorestore --archive --gzip --quiet 2>"$1.verr"`,
    };
    const loaded = await pool.exec(s, script(`${load[db.engine]}; rc=$?; rm -f "$1.verr"; exit $rc`, b.location, scratch), { timeoutMs: 20 * 60_000 });
    if (loaded.code !== 0) return finish(false, `the dump wouldn't load (${loaded.stderr.trim().slice(-160) || `exit ${loaded.code}`})`);
    if (db.engine === 'mongo') {
      const n = (await pool.exec(s, script('docker exec "$1" mongosh --quiet --eval "db.getMongo().getDBNames().length"', scratch))).stdout.trim();
      return finish(Number(n) > 0, `${n} databases came back`);
    }
    const q = (COUNT[db.engine] ?? COUNT.mysql!)(name);
    const pw = db.passwordRef ? ctx.secret(db.passwordRef) : '';
    // only its own live database is a fair comparison
    const inLive = !own ? 'NaN' : db.engine === 'postgres'
      ? (await pool.exec(s, script(PW_IN + 'docker exec -e PGPASSWORD "$1" psql -U "$3" -d "$4" -tAc "$2"', c, q, db.userRef ? 'unit7' : 'postgres', name), { stdin: `${pw}\n` })).stdout.trim()
      : (await pool.exec(s, script(PW_IN + 'docker exec -e MYSQL_PWD "$1" mysql -uroot -N -e "$2"', c, q), { stdin: `${pw}\n` })).stdout.trim();
    const live = Number(inLive);
    if (db.engine === 'postgres') { // table by table and row by row: a table count can't tell a full table from an empty one
      const proof = await provePostgres(ctx, s, scratch, image, b.location, loaded.stderr.split('\n').filter(Boolean)), empty = proof.empty && live === 0;
      return finish(proof.ok || !!empty, empty ? 'the database is empty, and so is its backup' : proof.note);
    }
    const copy = Number((await pool.exec(s, script('docker exec "$1" mysql -uroot -pverify -N -e "$2"', scratch, q))).stdout.trim());
    if (!Number.isFinite(copy)) return finish(false, 'the copy could not be read back');
    // tables can be added after the backup, so the copy may trail the live database, never exceed it wildly
    return finish(copy > 0 || live === 0, `${copy} table${copy === 1 ? '' : 's'} restored${Number.isFinite(live) ? ` (live has ${live})` : ''}`);
  } catch (e) {
    return finish(false, (e as Error).message.slice(0, 200));
  } finally {
    await pool.exec(s, cmd('docker', 'rm', '-f', scratch)).catch(() => undefined);
  }
}

// --- tools -------------------------------------------------------------------------------------

defineTool({
  name: 'backup.verify', title: 'Prove a backup restores', risk: 'read', action: 'read', timeoutMs: 25 * 60_000,
  description: 'Restore a backup (the latest of a database by default) into a throwaway copy, check the data came back, then delete the copy. Changes nothing on the real database. With offsite, it proves the off-server copy instead (downloaded, decrypted, restored): the disaster-recovery test. Warden runs this weekly.',
  input: z.object({ backupId: fid('bak').optional(), serviceId: fid('svc').optional(), offsite: z.boolean().default(false) }),
  async run(ctx, i) {
    const id = i.backupId ?? (i.serviceId && get<{ id: string }>(ctx.db, `SELECT id FROM backups WHERE service_id = ? AND org_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`, i.serviceId, ctx.orgId)?.id);
    if (!id) throw new Unit7Error('no_backup', 'There is no finished backup to check. Take one first.', 404);
    if (!i.offsite) return { backupId: id, ...(await verifyBackup(ctx, id, undefined, i.serviceId)) };
    const { fetchToServer } = await import('./offsite.ts');
    const scratch = `${BACKUPS}/verify-${id.slice(-8).replace(/[^A-Za-z0-9]/g, 'x')}.gz`;
    const b = get<{ service_id: string | null; kind: string }>(ctx.db, 'SELECT service_id, kind FROM backups WHERE id = ?', id)!;
    const { svc, s } = backupTarget(ctx, b, b.service_id ? undefined : i.serviceId);
    try { await fetchToServer(ctx, id, scratch, svc.id); return { backupId: id, fromOffsite: true, ...(await verifyBackup(ctx, id, scratch, i.serviceId)) }; }
    finally { await ssh(ctx.app).exec(s, script('rm -f "$1"', scratch)).catch(() => undefined); }
  },
});

defineTool({
  name: 'backup.create', title: 'Back up a database', risk: 'write', action: 'backup', green: true, timeoutMs: 20 * 60_000,
  description: 'Take a backup of a database service now. Backups are gzipped and checksummed on the server.',
  input: z.object({ serviceId: fid('svc'), reason: z.string().max(200).default('manual') }),
  run: (ctx, i) => takeBackup(ctx, i.serviceId, i.reason),
});

defineTool({
  name: 'backup.list', title: 'List backups', risk: 'read', action: 'read',
  description: 'Backups for a service (or the whole org), newest first, with size and freshness.',
  input: z.object({ serviceId: fid('svc').optional() }),
  run: (ctx, i) => all<Record<string, unknown> & { offsite: string | null }>(ctx.db, `SELECT b.id, b.service_id, s.name service, b.kind, b.reason, b.size, b.status, b.verified_at, b.verify_ok, b.created_at, b.finished_at, b.offsite
    FROM backups b LEFT JOIN services s ON s.id = b.service_id WHERE b.org_id = ? AND (? IS NULL OR b.service_id = ?) ORDER BY b.created_at DESC LIMIT 100`,
    ctx.orgId, i.serviceId ?? null, i.serviceId ?? null).map((b) => {
      const o = json<{ local?: string; folder?: string; bucket?: object; error?: string }>(b.offsite ?? '{}', {});
      return { ...b, offsite: o.error ? `failed: ${o.error}` : o.local || o.bucket ? [o.local && 'this computer', o.folder && 'synced folder', o.bucket && 'bucket'].filter(Boolean).join(' + ') : null };
    }),
});

defineTool({
  name: 'backup.schedule', title: 'Schedule backups', risk: 'write', action: 'backup', green: true,
  description: 'Keep automatic backups of a database (hourly, daily or weekly) and how many to keep.',
  input: z.object({ serviceId: fid('svc'), frequency: z.enum(['hourly', 'daily', 'weekly']).default('daily'), keep: z.number().int().min(1).max(90).default(7) }),
  run(ctx, i) {
    backupHost(ctx, i.serviceId); // validates it's a database, or an app that keeps files
    if (isAgent(ctx) && i.keep < 7) throw forbidden('An AI keeps at least 7 backups. A person can choose fewer.');
    // or an AI could lower a person's 30 to 7, then prune down to it
    const was = get<{ keep: number }>(ctx.db, 'SELECT keep FROM backup_schedules WHERE service_id = ? AND frequency = ?', i.serviceId, i.frequency)?.keep;
    if (isAgent(ctx) && was !== undefined && i.keep < was) throw forbidden(`This schedule keeps ${was} backups. Only a person can keep fewer.`);
    run(ctx.db, `INSERT INTO backup_schedules (id, org_id, service_id, frequency, keep) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(service_id, frequency) DO UPDATE SET keep = excluded.keep`, id('sch'), ctx.orgId, i.serviceId, i.frequency, i.keep);
    return { scheduled: i.frequency, keep: i.keep };
  },
});

defineTool({
  name: 'backup.prune', title: 'Prune old backups', risk: 'write', action: 'backup',
  description: `Keep only the newest scheduled backups of a database (on its server and off it). Safety backups (before a deploy, restore or removal; manual ones) are kept ${SAFETY_DAYS} days, never fewer than the newest ${SAFETY_KEEP}. Warden does this after each scheduled backup.`,
  input: z.object({ serviceId: fid('svc'), keep: z.number().int().min(1).max(365) }),
  run(ctx, i) {
    // backups are the undo for everything else: an AI may tidy them, never thin them below what a person chose
    const floor = get<{ k: number | null }>(ctx.db, 'SELECT max(keep) k FROM backup_schedules WHERE service_id = ?', i.serviceId)?.k ?? 7;
    if (isAgent(ctx) && i.keep < floor) {
      throw forbidden(`An AI keeps at least ${floor} backups here. A person can keep fewer.`);
    }
    return pruneBackups(ctx, i.serviceId, i.keep);
  },
});

defineTool({
  name: 'backup.restore', title: 'Restore a backup', risk: 'destructive', action: 'restore', timeoutMs: 30 * 60_000,
  description: 'Restore a database from a backup. This overwrites current data, so Unit7 takes a fresh safety backup first. Restricted by default. serviceId restores into another database of the same engine (a person only): needed when the backed-up database was removed.',
  input: z.object({ backupId: fid('bak'), serviceId: fid('svc').optional(), confirm: z.boolean().default(false) }),
  async run(ctx, i) {
    const b = get<{ service_id: string | null; location: string; kind: string; status: string; checksum: string | null }>(ctx.db, 'SELECT service_id, location, kind, status, checksum FROM backups WHERE id = ? AND org_id = ?', i.backupId, ctx.orgId);
    if (!b) throw new Unit7Error('not_found', 'That backup was not found.', 404);
    if (b.status !== 'done') throw new Unit7Error('bad_backup', 'That backup did not finish successfully.');
    if (i.serviceId && i.serviceId !== b.service_id) requireHuman(ctx, 'restore a backup into a different database');
    if (b.kind === 'files') { // an app's saved files go back into its own volumes
      if (!b.service_id) throw new Unit7Error('service_gone', 'The app these files came from was removed.', 409);
      const { svc, s, files } = backupHost(ctx, b.service_id);
      if (!files) throw new Unit7Error('no_files', `${svc.name} doesn’t keep saved files any more.`, 409);
      if (!i.confirm) throw new Unit7Error('confirm', `Restoring replaces ${svc.name}'s saved files. Pass confirm: true.`);
      const sum = (await ssh(ctx.app).exec(s, script('gzip -t "$1" && sha256sum "$1" | cut -d" " -f1', b.location))).stdout.trim();
      if (!sum || (b.checksum && sum !== b.checksum)) throw new Unit7Error('bad_backup', 'That backup file is damaged or isn\u2019t the one Unit7 made (its checksum differs). Nothing was changed.', 409);
      await backupBeforeChange(ctx, svc.id, 'restore');
      ctx.progress(`Putting ${svc.name}’s saved files back…`);
      await ssh(ctx.app).check(s, script(filesRestoreScript(files), b.location, svc.id), { what: 'Restoring the saved files', timeoutMs: 30 * 60_000, signal: ctx.signal });
      ctx.emit('backup.restored', `Restored ${svc.name}’s saved files from a backup`, { severity: 'warning', resource: svc.id });
      return { restored: svc.name, from: i.backupId };
    }
    const { svc, s, db } = backupTarget(ctx, b, i.serviceId);
    if (!i.confirm) throw new Unit7Error('confirm', `Restoring overwrites ${svc.name}'s current data. Pass confirm: true.`);
    // the server lost its copy (rebuilt, disk wiped), or it's another server: bring the off-server one over first
    if ((await ssh(ctx.app).exec(s, script('test -s "$1"', b.location))).code !== 0) { const { fetchToServer } = await import('./offsite.ts'); await fetchToServer(ctx, i.backupId, undefined, svc.id); }
    // A restore starts by dropping what's there: a damaged or swapped file must be caught before, not after.
    const sum = (await ssh(ctx.app).exec(s, script('gunzip -t "$1" && sha256sum "$1" | cut -d" " -f1', b.location))).stdout.trim();
    if (!sum || (b.checksum && sum !== b.checksum)) throw new Unit7Error('bad_backup', 'That backup file is damaged or isn\u2019t the one Unit7 made (its checksum differs). Nothing was changed.', 409);
    await backupBeforeChange(ctx, svc.id, 'restore');
    ctx.progress(`Restoring ${svc.name} from ${i.backupId}…`);
    const c = safeName(db.container, 'container');
    const pw = db.passwordRef ? ctx.secret(db.passwordRef) : '';
    const restore: Record<string, string> = {
      postgres: PW_IN + `gunzip -c "$1" | docker exec -i -e PGPASSWORD "$2" psql -v ON_ERROR_STOP=1 -U "$3" -d "$4" >/dev/null`, // stop (and fail) at the first error
      mysql: PW_IN + `gunzip -c "$1" | docker exec -i -e MYSQL_PWD "$2" mysql -u root >/dev/null`,
      mariadb: PW_IN + `gunzip -c "$1" | docker exec -i -e MYSQL_PWD "$2" mariadb -u root >/dev/null`,
      mongo: `gunzip -c "$1" | docker exec -i "$2" mongorestore --archive --gzip --drop >/dev/null`,
      // Redis writes its dataset on shutdown, so stop it before swapping the file in
      redis: `gunzip -c "$1" > "$1.rdb" && docker stop "$2" >/dev/null && docker cp "$1.rdb" "$2":/data/dump.rdb && docker start "$2" >/dev/null; rc=$?; rm -f "$1.rdb"; exit $rc`,
    };
    await ssh(ctx.app).check(s, script(restore[db.engine]!, b.location, c, db.userRef ? 'unit7' : db.engine === 'postgres' ? 'postgres' : 'root', db.database ?? 'app'), { what: 'Restoring', timeoutMs: 30 * 60_000, signal: ctx.signal, stdin: `${pw}\n` });
    ctx.emit('backup.restored', `Restored ${svc.name} from a backup`, { severity: 'warning', resource: svc.id });
    return { restored: svc.name, from: i.backupId };
  },
});
