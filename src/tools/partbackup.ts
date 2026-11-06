// Backups of databases Unit7 found on a server but doesn't run itself: a Coolify Supabase, a Compose Postgres, a
// plain-Docker MySQL, MongoDB or Redis. The dump is the same one Unit7 takes before anything risky (manage.ts
// freshBackup: pg_dumpall, mysqldump, mongodump, a Redis snapshot, run inside the database's own container); each copy
// is checksummed, kept in the backups table, and goes off the server encrypted like every other backup (offsite.ts).
// "Back up daily with Unit7" saves a schedule (Warden runs it), takes the first backup right away, and shows in
// Activity with Undo, which stops the schedule (a person only: backups are the undo for everything else).
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { fid, requireHuman, seesReal } from './helpers.ts';
import { aiHears, hideShapes, isRows, maskRows, parseCsv, readMask, readStatement, usesDynamic } from './datamask.ts';
import { forbidden } from '../errors.ts';
import { serverRow } from './servers.ts';
import { lastXray, runXray } from './xray.ts';
import { CHANGE_UNDO, ROOM_PROBE, findPart, freshBackup, manageDirs, mongoAs, roomVerdict } from './manage.ts';
import { copyOffsite, removeOffsite } from './offsite.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script, secretIn, shq } from '../connectors/shell.ts';
import { engineOf, type Inventory, type Part, type Sizes } from '../discovery/xray.ts';
import { makeRef } from '../vault.ts';
import { canDump } from '../discovery/findings.ts';

const FREQ = { hourly: 3600_000, daily: 86400_000, weekly: 7 * 86400_000 } as const;
const PART = z.string().trim().min(1).max(300).describe('The database’s id from server.xray (or its exact name)');
export const asRoot = (s: ServerRow) => (json<{ sudo?: string }>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : '');
type Schedule = { id: string; frequency: string; keep: number; last_run_at: string | null };
const due = (r: Pick<Schedule, 'frequency' | 'last_run_at'>, nowMs = Date.now()) => !r.last_run_at || nowMs - Date.parse(r.last_run_at) >= (FREQ[r.frequency as keyof typeof FREQ] ?? FREQ.daily) - 60_000;
// Only Warden's own scheduled run prunes old backups: decided here from who asks and the schedule row, never from input
// (an AI could otherwise say "scheduled" seven times and push every good copy out)
const isWarden = (ctx: Ctx) => ctx.actor.kind === 'agent' && ctx.actor.id === 'warden' && ctx.actor.userId === null;
const wardenRun = (ctx: Ctx, sch: Schedule | undefined): sch is Schedule => isWarden(ctx) && !!sch && due(sch);
// a label only a scheduled run may carry, since pruning counts those rows
const unscheduled = (reason: string) => (/^scheduled/i.test(reason) ? `extra (${reason})` : reason);
// an AI's (or a token's) extra backups of one database: at most 2 an hour; Warden's scheduled runs don't count
function extraLimit(ctx: Ctx, s: ServerRow, p: Part) {
  if (ctx.actor.kind === 'user') return;
  const names = [...new Set([p.id, p.name, ...(p.containers ?? [])])];
  const n = get<{ n: number }>(ctx.db, `SELECT count(*) n FROM audit WHERE org_id = ? AND tool IN ('part.backup', 'part.backup_schedule') AND result = 'success' AND actor_kind != 'user'
    AND created_at > ? AND json_extract(input, '$.serverId') = ? AND json_extract(input, '$.part') IN (${names.map(() => '?').join(', ')})
    AND NOT (actor_id = 'warden' AND tool = 'part.backup' AND json_extract(input, '$.reason') LIKE 'scheduled%')`, ctx.orgId, new Date(Date.now() - 3600_000).toISOString(), s.id, ...names)!.n;
  if (n >= 2) throw new Unit7Error('too_many', `An AI already backed up ${p.name} twice in the last hour. A person can take more.`, 429);
}

async function partOf(ctx: Ctx, serverId: string, ref: string) {
  const s = serverRow(ctx, serverId);
  let p = (() => { const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data; return inv && findPart(inv, ref); })();
  if (!p) p = findPart(await runXray(ctx, s), ref); // a fresh look before saying it isn't there
  if (!p) throw new Unit7Error('not_found', `Unit7 didn’t find “${ref}” on ${s.name}.`, 404);
  if (!canDump(p)) throw new Unit7Error('cannot_dump', `Unit7 can’t make a backup of ${p.name} by itself${p.owner === 'unit7' ? ': it’s one of Unit7’s own databases, so use its Backups' : ' (it isn’t a database Unit7 can reach)'}.`, 409);
  return { s, p };
}

// one backup: the dump on the server, its size and checksum, a row in backups, the off-server copy, and pruning
export async function takePartBackup(ctx: Ctx, s: ServerRow, p: Part, reason: string, keep?: number) {
  const file = await freshBackup(ctx, s, p, 'be copied off the server');
  const meta = (await ssh(ctx.app).exec(s, asRoot(s) + script('wc -c < "$1"; sha256sum "$1" | cut -d" " -f1', file))).stdout.trim().split('\n');
  const size = Number(meta[0] ?? 0), backupId = id('bak');
  run(ctx.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`,
    backupId, ctx.orgId, s.id, p.id, p.engine ?? 'database', reason, file, size, meta[1] ?? null, now());
  ctx.emit('backup.created', `Backed up ${p.name} on ${s.name} (${(size / 1048576).toFixed(1)} MB) — ${reason}`, { resource: s.id, data: { backupId, part: p.id } });
  // off the server before saying it's safe (offsite.ts: this computer, the synced folder, the bucket; encrypted)
  let offsite: Awaited<ReturnType<typeof copyOffsite>> | undefined, offsiteProblem: string | undefined;
  if (get<{ offsite: string }>(ctx.db, 'SELECT offsite FROM orgs WHERE id = ?', ctx.orgId)?.offsite !== 'off') {
    try { offsite = await copyOffsite(ctx, backupId); } catch (e) { offsiteProblem = (e as Error).message.slice(0, 200); }
  }
  const removed = keep ? await prunePart(ctx, s, p.id, keep) : 0;
  return { backupId, size, location: file, offServer: offsite ? ['this computer', offsite.syncedFolder && 'your synced folder', offsite.bucket].filter(Boolean) as string[] : [], ...(offsiteProblem && { offsiteProblem }), ...(removed && { removedOld: removed }) };
}

// a copy of files on the server: its size and checksum, a row in backups, and (off: unless it's only a moment's undo) the copy off the server
export async function keepCopy(ctx: Ctx, s: ServerRow, part: string, kind: string, reason: string, file: string, off = true) {
  const meta = (await ssh(ctx.app).exec(s, asRoot(s) + script('wc -c < "$1"; sha256sum "$1" | cut -d" " -f1', file))).stdout.trim().split('\n');
  const backupId = id('bak'), size = Number(meta[0] ?? 0);
  run(ctx.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`,
    backupId, ctx.orgId, s.id, part, kind, reason, file, size, meta[1] ?? null, now());
  let copied: Awaited<ReturnType<typeof copyOffsite>> | undefined;
  if (off && get<{ offsite: string }>(ctx.db, 'SELECT offsite FROM orgs WHERE id = ?', ctx.orgId)?.offsite !== 'off') { try { copied = await copyOffsite(ctx, backupId); } catch { /* the copy stays on the server, and the level says so */ } }
  return { backupId, size, checksum: meta[1] ?? null, offServer: copied ? ['this computer', copied.syncedFolder && 'your synced folder', copied.bucket].filter(Boolean) as string[] : [] };
}

// the newest `keep` automatic backups of a part stay; older ones go from the server and from off it. After signs of a break-in the old
// copies are the clean ones, so nothing goes for a month, until a person has had time to look.
async function prunePart(ctx: Ctx, s: ServerRow, part: string, keep: number, kind = 'scheduled%') {
  if (get(ctx.db, `SELECT 1 FROM events WHERE org_id = ? AND type = 'breakin.found' AND resource = ? AND created_at > ?`, ctx.orgId, s.id, new Date(Date.now() - 30 * 86400_000).toISOString())) return 0;
  const old = all<{ id: string; location: string; offsite: string | null }>(ctx.db, `SELECT id, location, offsite FROM backups WHERE org_id = ? AND server_id = ? AND part = ? AND status = 'done'
    AND reason LIKE ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`, ctx.orgId, s.id, part, kind, keep);
  for (const b of old) {
    await ssh(ctx.app).exec(s, asRoot(s) + script('rm -f "$1"', b.location)).catch(() => undefined);
    await removeOffsite(ctx, b.offsite);
    run(ctx.db, 'DELETE FROM backups WHERE id = ?', b.id);
  }
  return old.length;
}

defineTool({
  name: 'part.backup', title: 'Back up a database on a server', risk: 'write', action: 'backup', green: true, timeoutMs: 65 * 60_000,
  description: 'Back up a database Unit7 found on a server (server.xray), where it runs: Postgres (pg_dumpall; Supabase as its own admin), MySQL or MariaDB (mysqldump), MongoDB (mongodump) or Redis (a fresh snapshot), inside its own container. Gzipped and checksummed on the server, then copied off it encrypted (this computer, a synced folder, a bucket). Changes nothing in the database. An AI may take 2 an hour per database; only Warden’s scheduled run removes old ones.',
  input: z.object({ serverId: fid('srv'), part: PART, reason: z.string().max(120).default('manual') }),
  async run(ctx, i) {
    const { s, p } = await partOf(ctx, i.serverId, i.part);
    const sch = get<Schedule>(ctx.db, 'SELECT id, frequency, keep, last_run_at FROM part_backup_schedules WHERE server_id = ? AND part = ? AND org_id = ?', s.id, p.id, ctx.orgId);
    const scheduled = wardenRun(ctx, sch);
    if (!scheduled) extraLimit(ctx, s, p);
    // Warden's extra copies (before a deploy, say) keep to a few of their own, or a busy project fills the disk and every backup stops
    const auto = isWarden(ctx) && !scheduled;
    const out = scheduled ? await takePartBackup(ctx, s, p, `scheduled (${sch.frequency})`, sch.keep) : await takePartBackup(ctx, s, p, auto ? `auto (${i.reason})` : unscheduled(i.reason));
    if (auto) await prunePart(ctx, s, p.id, 3, 'auto%');
    if (scheduled) run(ctx.db, 'UPDATE part_backup_schedules SET last_run_at = ? WHERE id = ?', now(), sch.id);
    return { part: p.name, server: s.name, ...out };
  },
});

defineTool({
  name: 'part.backup_schedule', title: 'Back up a database on a server every day', risk: 'write', action: 'backup', green: (i) => !i.off, timeoutMs: 65 * 60_000,
  // stopping backups is a person's call: backups are the undo for everything else
  peopleOnly: (i) => !!i.off,
  description: 'Keep automatic backups of a database Unit7 found on a server (a Coolify Supabase, a Compose Postgres…): hourly, daily or weekly, keeping the newest `keep` (at least 7 for an AI; once set, only a person changes how often or how many). Takes the first backup right away and copies it off the server, encrypted. Shows in Activity, where Undo stops it. off: true stops it (people only).',
  input: z.object({ serverId: fid('srv'), part: PART, frequency: z.enum(['hourly', 'daily', 'weekly']).default('daily'), keep: z.number().int().min(1).max(90).default(7), off: z.boolean().default(false) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    if (i.off) {
      requireHuman(ctx, 'stop backups');
      const p = lastXray(ctx.db, ctx.orgId, s.id)?.data;
      const part = (p && findPart(p, i.part))?.id ?? i.part;
      const gone = run(ctx.db, 'DELETE FROM part_backup_schedules WHERE server_id = ? AND part = ? AND org_id = ?', s.id, part, ctx.orgId).changes > 0;
      if (gone) ctx.emit('backup.schedule_stopped', `${ctx.actor.name} stopped the backups of ${part} on ${s.name}. Backups already made stay.`, { severity: 'warning', resource: s.id });
      return { stopped: gone };
    }
    const { p } = await partOf(ctx, i.serverId, i.part);
    // people only: fewer than 7, and any change to a schedule that exists (hourly keep 7 would cut a week to 7 hours)
    const person = ctx.actor.kind === 'user';
    if (!person && i.keep < 7) throw forbidden('An AI keeps at least 7 backups. A person can choose fewer.');
    const was = get<{ id: string; frequency: string; keep: number }>(ctx.db, 'SELECT id, frequency, keep FROM part_backup_schedules WHERE server_id = ? AND part = ?', s.id, p.id);
    if (!person && was && (i.keep !== was.keep || i.frequency !== was.frequency)) throw forbidden(`These backups run ${was.frequency}, keeping ${was.keep}. Only a person can change that.`);
    if (was) extraLimit(ctx, s, p);
    const schId = was?.id ?? id('pbs');
    run(ctx.db, `INSERT INTO part_backup_schedules (id, org_id, server_id, part, name, engine, frequency, keep, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (server_id, part) DO UPDATE SET frequency = excluded.frequency, keep = excluded.keep, name = excluded.name`, schId, ctx.orgId, s.id, p.id, p.name, p.engine ?? 'database', i.frequency, i.keep, ctx.actor.name);
    const every = i.frequency === 'daily' ? 'every day' : i.frequency === 'hourly' ? 'every hour' : 'every week';
    let first: Awaited<ReturnType<typeof takePartBackup>>;
    try {
      ctx.progress(`Taking the first backup of ${p.name}…`);
      // never prunes (only Warden's scheduled run does); on a schedule that exists it's an extra backup, not a scheduled one
      first = await takePartBackup(ctx, s, p, was ? 'manual' : `scheduled (${i.frequency}, the first)`);
    } catch (e) {
      // nothing half-done: no schedule that has never worked
      if (!was) run(ctx.db, 'DELETE FROM part_backup_schedules WHERE id = ?', schId);
      throw new Unit7Error('backup_failed', `Unit7 couldn’t back up ${p.name}: ${(e as Error).message.slice(0, 300)}${was ? '' : ' Nothing was scheduled.'}`, 502);
    }
    if (!was) run(ctx.db, 'UPDATE part_backup_schedules SET last_run_at = ? WHERE id = ?', now(), schId);
    if (was) return { part: p.name, scheduled: i.frequency, keep: i.keep, firstBackup: first, already: true };
    const changeId = id('chg'), summary = `Backs up ${p.name} on ${s.name} ${every}, keeping the last ${i.keep}`;
    run(ctx.db, 'INSERT INTO changes (id, org_id, server_id, part, verb, summary, undo, status, actor) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
      changeId, ctx.orgId, `backup:${s.id}:${p.id}`, 'part.backup_schedule', summary, JSON.stringify({ steps: [], serverId: s.id, part: p.id, name: p.name }), 'done', ctx.actor.name);
    ctx.emit('change.made', `${summary}. The first backup is done${first.offServer.length ? ` and safe off the server (${first.offServer.join(', ')})` : ''}. It can be undone.`,
      { severity: 'success', resource: s.id, data: { changeId, part: p.id, undo: 'change.undo' } });
    return { part: p.name, scheduled: i.frequency, keep: i.keep, firstBackup: first, changeId, undo: { tool: 'change.undo', input: { changeId }, label: 'Stop these backups' } };
  },
});

// Activity's Undo: the schedule stops; the backups already made stay (a person only)
CHANGE_UNDO['part.backup_schedule'] = async (ctx, ch) => {
  requireHuman(ctx, 'stop backups');
  const u = json<{ serverId: string; part: string; name: string }>(ch.undo, { serverId: '', part: '', name: '' });
  run(ctx.db, 'DELETE FROM part_backup_schedules WHERE org_id = ? AND server_id = ? AND part = ?', ctx.orgId, u.serverId, u.part);
  return { stopped: `the backups of ${u.name}`, kept: 'The backups already made stay where they are.' };
};

// Warden's minute: each schedule that's due, once at a time (it moves on only when a backup was made)
export const dueSchedules = (db: Ctx['db'], nowMs = Date.now()) =>
  all<{ id: string; org_id: string; server_id: string; part: string; name: string; frequency: keyof typeof FREQ; last_run_at: string | null }>(db, 'SELECT id, org_id, server_id, part, name, frequency, last_run_at FROM part_backup_schedules')
    .filter((r) => due(r, nowMs));

// --- what a database's dump doesn't hold --------------------------------------------------------------------------------
// A project comes back from more than its database: uploaded files (Supabase Storage is a folder on the server), the other
// volumes and folders its containers keep, and its settings. Coolify itself needs its database, its key and its SSH keys.
// All of it is read through read-only mounts by a throwaway container, so nothing that runs is touched.
const DB_STORE = /(^|[/_-])(db|database|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis)([/_-]|$)|db-data|db-config|cache|\/logs?(\/|$)/i;
const SYSTEM_DIR = /^\/(proc|sys|dev|run|etc|boot|var\/run|usr|bin|sbin|lib\w*|tmp)?(\/|$)|docker\.sock/;
export const COOLIFY_KEEP = ['/data/coolify/source/.env', '/data/coolify/ssh', '/data/coolify/proxy'];
export function extrasOf(inv: Inventory, p: Part) {
  const group = inv.parts.filter((x) => x.kind !== 'volume' && x.kind !== 'domain' && x.kind !== 'job' && (p.project ? x.project === p.project : x.id === p.id));
  const system = inv.projects.find((x) => x.id === p.project)?.system;
  const paths = system ? COOLIFY_KEEP : [...new Set(group.flatMap((x) => x.binds ?? []))].filter((b) => b.startsWith('/') && !SYSTEM_DIR.test(b) && !DB_STORE.test(b) && !/[\n\r:]/.test(b));
  const volumes = system ? [] : [...new Set(group.flatMap((x) => x.volumes ?? []))].filter((v) => !DB_STORE.test(v) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v));
  const containers = group.flatMap((x) => [...(x.internals?.map((c) => c.name) ?? []), ...(x.containers ?? [])]).filter((c, i, a) => a.indexOf(c) === i && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(c));
  return { paths, volumes, containers };
}
const EXTRAS_GB = 20; // bigger than this, a person decides
export const extrasScript = (paths: string[], volumes: string[]) => {
  const m = [...paths.map((b, i) => `--mount ${shq(`type=bind,src=${b},dst=/b/f${i}-${b.split('/').pop() || 'root'},readonly`)}`), ...volumes.map((v) => `--mount ${shq(`type=volume,src=${v},dst=/b/v-${v},readonly`)}`)].join(' ');
  return `umask 077; mkdir -p "$(dirname "$1")" && docker run --rm --network none ${m} alpine:3 tar czf - -C /b . > "$1" && gzip -t "$1" && test -s "$1"`;
};

defineTool({
  name: 'part.copy_extras', title: 'Copy a project’s files and settings', risk: 'write', action: 'backup', green: true, timeoutMs: 65 * 60_000,
  description: 'Copy what a database backup doesn’t hold, for the project a database belongs to: uploaded files and other volumes and folders (read through read-only mounts by a throwaway container), and each container’s settings (encrypted before they leave the server). For Coolify itself: its key file, SSH keys and proxy settings. Nothing that runs is touched. An AI may take one an hour; only Warden’s own run removes old ones, keeping the newest 3.',
  input: z.object({ serverId: fid('srv'), part: PART }),
  async run(ctx, i) {
    const { s, p } = await partOf(ctx, i.serverId, i.part);
    const warden = isWarden(ctx), part = `extras:${p.id}`;
    if (ctx.actor.kind !== 'user' && !warden && get(ctx.db, 'SELECT 1 FROM backups WHERE org_id = ? AND server_id = ? AND part = ? AND created_at > ?', ctx.orgId, s.id, part, new Date(Date.now() - 3600_000).toISOString())) throw new Unit7Error('too_many', `${p.name}’s files were copied in the last hour. A person can take more.`, 429);
    const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data!;
    const { paths: wanted, volumes, containers } = extrasOf(inv, p);
    const here = wanted.length ? (await ssh(ctx.app).exec(s, asRoot(s) + script('for p in "$@"; do [ -e "$p" ] && echo "$p"; done', ...wanted))).stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    const sizes = lastXray<Sizes>(ctx.db, ctx.orgId, s.id, 'deep')?.data;
    const bytes = here.reduce((n, b) => n + (sizes?.binds[b] ?? 0), 0) + volumes.reduce((n, v) => n + (sizes?.volumes[v] ?? 0), 0);
    if (ctx.actor.kind !== 'user' && bytes > EXTRAS_GB * 1e9) throw new Unit7Error('too_big', `${p.name}’s files are about ${(bytes / 1e9).toFixed(0)} GB, so copying them is a person’s call.`, 409);
    const dir = `${manageDirs.backups}/${p.id.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80)}`, t = new Date().toISOString().replace(/[:.]/g, '-');
    const tight = roomVerdict((await ssh(ctx.app).exec(s, script(ROOM_PROBE, dir), { timeoutMs: 20_000 })).stdout, ctx.actor.kind === 'user');
    if (tight) throw new Unit7Error('no_room', `Unit7 didn’t copy ${p.name}’s files: ${tight}.`, 507);
    const made: { kind: string; size: number; offServer: string[] }[] = [];
    const keep = async (kind: string, file: string) => { const c = await keepCopy(ctx, s, part, kind, warden ? 'scheduled (safety net)' : 'extra (files and settings)', file); made.push({ kind, size: c.size, offServer: c.offServer }); };
    if (here.length || volumes.length) {
      ctx.progress(`Copying ${p.name}’s files…`);
      const file = `${dir}/${t}.files.tgz`;
      await ssh(ctx.app).check(s, asRoot(s) + script(extrasScript(here, volumes), file), { what: `Copying ${p.name}’s files`, timeoutMs: 60 * 60_000, signal: ctx.signal });
      await keep('files', file);
    }
    if (containers.length) {
      ctx.progress(`Copying ${p.name}’s settings…`);
      const file = `${dir}/${t}.settings.json.gz`;
      await ssh(ctx.app).check(s, asRoot(s) + script('f="$1"; shift; umask 077; mkdir -p "$(dirname "$f")" && docker inspect "$@" | gzip > "$f" && test -s "$f"', file, ...containers), { what: `Copying ${p.name}’s settings`, timeoutMs: 120_000, signal: ctx.signal });
      await keep('settings', file);
    }
    const removed = warden ? await prunePart(ctx, s, part, 6) : 0; // two files a run: the newest three runs
    return { part: p.name, copied: made, ...(removed && { removed }) };
  },
});

// --- proving one ---------------------------------------------------------------------------------------------------------
// A backup you never restored isn't a backup. This one restores into a throwaway container with no network, compares what came
// back with what the file holds, and removes that container, whatever happened: the only thing it deletes is what it made.
const COUNT: Record<string, string> = {
  mysql: `docker exec -e MYSQL_PWD "$1" sh -c 'if command -v mysql >/dev/null; then c=mysql; else c=mariadb; fi; "$c" -uroot -N -e "select count(*) from information_schema.tables where table_schema not in (\\"mysql\\",\\"sys\\",\\"performance_schema\\",\\"information_schema\\")"'`,
  mongo: `docker exec "$1" sh -c 'if command -v mongosh >/dev/null; then c=mongosh; else c=mongo; fi; "$c" --quiet --eval "db.getMongo().getDBNames().filter(function(d){return [\\"admin\\",\\"local\\",\\"config\\"].indexOf(d)<0}).length"'`,
  redis: `docker exec "$1" redis-cli DBSIZE`,
};
COUNT.mariadb = COUNT.mysql!;

// Postgres: what the file really holds, table by table. "More than nothing" proves nothing: Supabase's image starts with tables of
// its own, and a database that isn't called postgres starts with none where a simple count would look.
export const PG_MANIFEST = String.raw`gunzip -c "$1" | awk 'inc && /^\\\.$/ { print db "\t" t "\t" n; inc = 0; next } inc { n++; next } /^\\connect / { db = $2; gsub(/"/, "", db); next } /^COPY / { t = $0; sub(/^COPY /, "", t); sub(/ *(\(.*\))? *FROM stdin;$/, "", t); n = 0; inc = 1 }'`;
export interface Table { db: string; table: string; rows: number }
export const parseManifest = (text: string): Table[] => text.split('\n').flatMap((l) => { const [db, table, rows] = l.split('\t'); return db && table && rows ? [{ db, table, rows: Number(rows) }] : []; });
export const countsSql = (tables: Table[]) => tables.map((t) => `select '${t.table.replace(/'/g, `''`)}', count(*) from ${t.table};`).join('\n') + '\n';
export const parseCounts = (text: string) => new Map(text.split('\n').flatMap((l) => { const at = l.lastIndexOf('|'); return at > 0 ? [[l.slice(0, at), Number(l.slice(at + 1))] as const] : []; }));
// What Postgres said during a restore, one line each, on stderr: "table: why" for a COPY that failed. Never row data: DETAIL and
// the row in CONTEXT stay out, and so do the lines psql makes of a table's rows once its COPY never started.
export const PG_SAID = String.raw`awk '/syntax error at or near|invalid command/ { next } /ERROR:/ { if (e != "") print e; e = $0; sub(/^.*ERROR: */, "", e); sub(/: ".*$/, "", e); next } /^CONTEXT: +COPY / { t = $3; sub(/,$/, "", t); print t ": " e; e = "" } END { if (e != "") print e }' | cut -c1-200 | tail -n 200 >&2`;
// (pure) did it all come back? A table counts as short if it's gone or has fewer rows than the file
export function proofOf(want: Table[], got: Map<string, number>, said: string[] = []) {
  const count = (t: Table) => got.get(`${t.db}\t${t.table}`);
  const short = want.filter((t) => (count(t) ?? -1) < t.rows), rows = want.reduce((n, t) => n + t.rows, 0);
  if (!want.length) return { ok: false, note: 'the file holds no tables' };
  const why = [...new Set(short.flatMap((t) => said.find((l) => l.includes(t.table.split('.').pop()!.replace(/"/g, ''))) ?? []))].slice(0, 2);
  return short.length ? { ok: false, note: `${short.length} of ${want.length} tables came back short: ${short.slice(0, 5).map((t) => `${t.table} (${count(t) === undefined ? 'missing' : `${count(t)!.toLocaleString('en-US')} of ${t.rows.toLocaleString('en-US')} rows`})`).join(', ')}${why.length ? `. Postgres said: ${why.join('; ')}` : ''}` }
    : { ok: true, note: `all ${want.length} table${want.length === 1 ? '' : 's'} and ${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'} came back` };
}
export const SUPABASE = /(^|\/)supabase\/postgres(:|$)/;
const pgAs = (image: string) => (SUPABASE.test(image) ? '-h 127.0.0.1 -U supabase_admin' : '-U postgres');
// A check that reads another table refuses its rows while that table is still empty, and a dump's tables come in name order, so a real
// restore loses them too. What came back empty goes again once the rest is in, in rounds for a chain of them. Only its rows go, with
// triggers off as they were for the first load. Only empty ones: a COPY is all or nothing, and a second one over rows would double them.
// $1 the container, $2 the database, $3 the file, $4 the tables, one a line, as the manifest names them
export const pgAgain = (as: string) => String.raw`gunzip -c "$3" | D="$2" T="$4" awk 'BEGIN { n = split(ENVIRON["T"], l, "\n"); for (i = 1; i <= n; i++) w[l[i]] = 1; print "\\set ON_ERROR_STOP on"; print "SET session_replication_role = replica;"; print "\\set ON_ERROR_STOP off" } inc { if (on) print; if ($0 == "\\.") { inc = 0; on = 0 } next } /^\\connect / { db = $2; gsub(/"/, "", db); next } /^SET client_encoding = / { print; next } /^COPY / { t = $0; sub(/^COPY /, "", t); sub(/ *(\(.*\))? *FROM stdin;$/, "", t); inc = 1; on = (db == ENVIRON["D"]) && (t in w); if (on) print }' | docker exec -i "$1" psql -q ${as} -d "$2" 2>&1 >/dev/null | ${PG_SAID} || true`;
// A foreign key can't be added while the table it points at is empty, so the ones pointing at those tables go again too. A dump is text
// a visitor can reach, so only a line that can be nothing but one such key counts: no second statement, no quote, no psql command.
// One that's already there just says so. Same arguments as pgAgain.
export const pgKeysAgain = (as: string) => String.raw`gunzip -c "$3" | D="$2" T="$4" awk 'BEGIN { n = split(ENVIRON["T"], l, "\n"); for (i = 1; i <= n; i++) w[l[i]] = 1 } inc { if ($0 == "\\.") inc = 0; next } /^\\connect / { db = $2; gsub(/"/, "", db); next } /^COPY / { inc = 1; next } a != "" { if ($0 ~ /^    ADD CONSTRAINT [^;\\\047]* FOREIGN KEY [^;\\\047]* REFERENCES [^;\\\047]*;$/) { r = $0; sub(/^.* REFERENCES /, "", r); sub(/\(.*$/, "", r); if (db == ENVIRON["D"] && (r in w)) { print a; print } } a = "" } /^ALTER TABLE (ONLY )?[^;\\\047]+$/ { a = $0 }' | docker exec -i "$1" psql -q ${as} -d "$2" >/dev/null 2>&1 || true`;
export async function provePostgres(ctx: Ctx, s: ServerRow, name: string, image: string, file: string, said: string[], as = pgAs(image)) {
  const want = parseManifest(await ssh(ctx.app).check(s, asRoot(s) + script(PG_MANIFEST, file), { what: 'Reading the backup', timeoutMs: 30 * 60_000, maxBytes: 16 * 1024 * 1024, signal: ctx.signal })), got = new Map<string, number>();
  const count = async (db: string) => {
    const r = await ssh(ctx.app).exec(s, asRoot(s) + script(`docker exec -i "$1" psql ${as} -d "$2" -AtqX -F '|'`, name, db), { stdin: countsSql(want.filter((t) => t.db === db)), timeoutMs: 20 * 60_000, maxBytes: 16 * 1024 * 1024, signal: ctx.signal });
    for (const [t, n] of parseCounts(r.stdout)) got.set(`${db}\t${t}`, n);
  };
  for (const db of [...new Set(want.map((t) => t.db))]) await count(db);
  const left = () => want.filter((t) => t.rows && got.get(`${t.db}\t${t.table}`) === 0), first = left();
  for (let round = 0, before = Infinity; round < 3 && left().length && left().length < before; round++) {
    const empty = left();
    before = empty.length;
    ctx.progress?.(`${empty.length} table${empty.length === 1 ? ' was' : 's were'} refused at first. Trying again now the rest is in…`);
    for (const db of [...new Set(empty.map((t) => t.db))]) {
      const r = await ssh(ctx.app).exec(s, asRoot(s) + script(pgAgain(as), name, db, file, empty.filter((t) => t.db === db).map((t) => t.table).join('\n')), { timeoutMs: 30 * 60_000, signal: ctx.signal });
      said = [...r.stderr.split('\n').filter(Boolean), ...said]; // the latest word first: it's what stands if a table still won't load
      await count(db);
    }
  }
  for (const db of [...new Set(first.map((t) => t.db))]) await ssh(ctx.app).exec(s, asRoot(s) + script(pgKeysAgain(as), name, db, file, first.filter((t) => t.db === db).map((t) => t.table).join('\n')), { timeoutMs: 30 * 60_000, signal: ctx.signal });
  return proofOf(want, got, said);
}
export async function proveCount(ctx: Ctx, s: ServerRow, name: string, engine: string, password: string) {
  const r = await ssh(ctx.app).exec(s, asRoot(s) + script(`${COPY_PW}${COUNT[engine]!}`, name), { stdin: `${password}\n`, timeoutMs: 60_000 });
  const n = Number(/\d+/.exec(r.stdout)?.[0] ?? NaN);
  return Number.isFinite(n) && n > 0 ? { ok: true, note: `${n} ${engine === 'redis' ? 'keys' : engine === 'mongo' ? 'databases' : 'tables'} came back` } : { ok: false, note: 'it restored, but nothing came back' };
}
// a sleep or a lost connection can leave a test copy behind, so each test first clears any older than a test can take
const PROOF_HOURS = 2;
async function clearProofs(ctx: Ctx, s: ServerRow, nowMs = Date.now()) {
  const out = (await ssh(ctx.app).exec(s, asRoot(s) + `docker ps -a --filter name=^unit7-proof- --format '{{.Names}}|{{.Label "unit7.copy-of"}}|{{.CreatedAt}}'`, { timeoutMs: 20_000 })).stdout;
  for (const l of out.split('\n').filter(Boolean)) {
    const at = Date.parse(copyLine(l).at);
    if (nowMs - at > PROOF_HOURS * 3600_000) await ssh(ctx.app).exec(s, asRoot(s) + script(REMOVE_COPY, copyLine(l).name)).catch(() => undefined);
  }
}

defineTool({
  name: 'part.verify', title: 'Prove a database backup restores', risk: 'write', action: 'backup', green: true, timeoutMs: 65 * 60_000,
  description: 'Restore the newest backup of a database found on a server (or a given one) into a throwaway container with no network, compare what came back with what the file holds, and remove that container. The live database isn’t touched. The result shows as Proven on the project.',
  input: z.object({ serverId: fid('srv'), part: PART, backupId: fid('bak').optional() }),
  async run(ctx, i) {
    const { s, p } = await partOf(ctx, i.serverId, i.part);
    const b = get<{ id: string; location: string; checksum: string | null; size: number | null; created_at: string }>(ctx.db, `SELECT id, location, checksum, size, created_at FROM backups WHERE org_id = ? AND server_id = ? AND part = ? AND status = 'done' AND (? IS NULL OR id = ?) ORDER BY created_at DESC LIMIT 1`,
      ctx.orgId, s.id, p.id, i.backupId ?? null, i.backupId ?? null);
    if (!b) throw new Unit7Error('no_backup', `There’s no backup of ${p.name} to prove yet.`, 404);
    const image = imageOf(p);
    if (!image || !p.engine || !COPY[p.engine] || (p.engine !== 'postgres' && !COUNT[p.engine])) throw new Unit7Error('cannot_prove', `Unit7 can’t test-restore ${p.name} yet.`, 409);
    const free = Number((await ssh(ctx.app).exec(s, script(`awk '/^MemAvailable/{print $2*1024}' /proc/meminfo`))).stdout.trim());
    if (free && free < 700e6) throw new Unit7Error('no_room', `Unit7 didn’t test-restore ${p.name}: only ${Math.round(free / 1e6)} MB of memory is free.`, 507);
    // a restored database takes several times its compressed file, and it mustn't fill the disk of what's running
    const tight = roomVerdict((await ssh(ctx.app).exec(s, script(ROOM_PROBE, b.location), { timeoutMs: 20_000 })).stdout, ctx.actor.kind === 'user', Math.max(1e9, (b.size ?? 0) * 8));
    if (tight) throw new Unit7Error('no_room', `Unit7 didn’t test-restore ${p.name}: ${tight}.`, 507);
    await clearProofs(ctx, s).catch(() => undefined);
    const sum = (await ssh(ctx.app).exec(s, asRoot(s) + script('gunzip -t "$1" && sha256sum "$1" | cut -d" " -f1', b.location))).stdout.trim();
    const mark = (ok: boolean, note: string) => run(ctx.db, 'UPDATE backups SET verified_at = ?, verify_ok = ?, verify_note = ? WHERE id = ?', now(), ok ? 1 : 0, note, b.id);
    if (!sum || (b.checksum && sum !== b.checksum)) { mark(false, 'the file is missing or damaged'); throw new Unit7Error('bad_backup', `The newest backup of ${p.name} is missing or damaged.`, 409); }
    const name = `unit7-proof-${id('x').slice(2, 10).toLowerCase().replace(/[^a-z0-9]/g, '0')}`, password = randomBytes(18).toString('base64url');
    ctx.redactor.add(password, 'the test copy’s password');
    ctx.progress(`Testing the backup of ${p.name}…`);
    try {
      const r = await ssh(ctx.app).exec(s, asRoot(s) + script(`${COPY_PW}set -e; ${COPY[p.engine]!}`, name, image, b.location, 'none', `proof:${p.id}`), { timeoutMs: 60 * 60_000, signal: ctx.signal, stdin: `${password}\n` });
      // a dropped connection says nothing about the backup: only a restore that really failed counts against it
      if (r.code === -1) throw new Unit7Error('connection', `The connection to ${s.name} dropped while testing ${p.name}’s backup.`, 502, { retryable: true });
      if (r.code !== 0) throw new Unit7Error('bad_backup', `The backup of ${p.name} didn’t restore: ${(r.stderr || r.stdout).trim().slice(-300) || 'no output'}`, 409);
      const proof = p.engine === 'postgres' ? await provePostgres(ctx, s, name, image, b.location, r.stderr.split('\n').filter(Boolean)) : await proveCount(ctx, s, name, p.engine, password);
      if (!proof.ok) throw new Unit7Error('bad_backup', `The backup of ${p.name} didn’t restore: ${proof.note}.`, 409);
      mark(true, proof.note);
      return { part: p.name, ok: true, note: proof.note, backupId: b.id };
    } catch (e) {
      if ((e as Unit7Error).code === 'bad_backup') {
        mark(false, (e as Error).message.slice(0, 600));
        ctx.emit('backup.verify_failed', (e as Error).message, { severity: 'critical', resource: s.id, data: { backupId: b.id, part: p.id } });
      }
      throw e;
    } finally { await ssh(ctx.app).exec(s, asRoot(s) + script(REMOVE_COPY, name)).catch(() => undefined); }
  },
});

// --- bringing one back -------------------------------------------------------------------------------------------------
// The backups of each database Unit7 backs up on a server, newest first. Restoring goes into a test copy by default: a
// new container next to the live one, from the same image, with no port open to the internet, so the live one is
// untouched until a person decides (Activity's Undo removes the copy). Over the live one is a person's call: they type
// its name, and Unit7 takes a fresh backup first so the restore itself can be undone.
// A copy and whatever it holds: its unnamed data volume, which `docker rm` alone leaves on the disk, and a folder named after it
export const REMOVE_COPY = `m=$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$1" 2>/dev/null); docker rm -fv "$1" >/dev/null 2>&1; for d in $m; do case "$d" in */"$1") rm -rf "$d" ;; esac; done`;
export const liveContainer = (p: Part) => p.internals?.find((x) => engineOf(x.image))?.name ?? (p.engine ? p.containers?.[0] : undefined);
export const imageOf = (p: Part) => p.internals?.find((x) => engineOf(x.image))?.image ?? p.image;
const WAIT = (probe: string) => `i=0; until ${probe}; do i=$((i+1)); [ $i -lt 180 ] || { echo "the copy didn't start" >&2; exit 3; }; sleep 1; done`;
// $1 the copy's name, $2 the image, $3 the backup file, $4 a network ('' for none), $5 which part it copies, $6 where its data
// goes when that has to last (server.move: a volume on the new server, "name:/path"; a copy's is thrown away); the copy's password
// comes on stdin's first line and reaches docker by name only (COPY_PW), never on a command line
export const COPY_PW = secretIn('POSTGRES_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD', 'MYSQL_PWD');
// Supabase's image fills a new database with its own older tables, and then its real ones can't come back (0 sign-in users, tested
// on the real image). So a copy starts empty, with its usual superuser, and the backup brings everything: roles, auth, storage, your data.
// A backup also carries the old passwords, so the copy's own password goes back in last.
export const COPY: Record<string, string> = {
  postgres: `u=postgres; a=''; e=''; case "$2" in *supabase/postgres*) u=supabase_admin; a='-h 127.0.0.1'; e='--tmpfs /docker-entrypoint-initdb.d -e POSTGRES_USER=supabase_admin' ;; esac; docker run -d --name "$1" --label unit7.copy-of="$5" \${4:+--network "$4"} \${6:+-v "$6"} $e -e POSTGRES_PASSWORD "$2" >/dev/null; ${WAIT('docker exec "$1" pg_isready -h 127.0.0.1 -U "$u" >/dev/null 2>&1')}; gunzip -c "$3" | docker exec -i "$1" psql -q $a -U "$u" -d postgres 2>&1 >/dev/null | ${PG_SAID} || true; printf "ALTER ROLE %s PASSWORD '%s';ALTER ROLE postgres PASSWORD '%s';\n" "$u" "$POSTGRES_PASSWORD" "$POSTGRES_PASSWORD" | docker exec -i "$1" psql -q $a -U "$u" -d postgres >/dev/null; docker exec "$1" psql -Atq $a -U "$u" -d postgres -c 'select 1' >/dev/null`,
  mysql: `docker run -d --name "$1" --label unit7.copy-of="$5" \${4:+--network "$4"} \${6:+-v "$6"} -e MYSQL_ROOT_PASSWORD -e MARIADB_ROOT_PASSWORD "$2" >/dev/null; ${WAIT(`docker exec -e MYSQL_PWD "$1" sh -c 'mysqladmin ping -h 127.0.0.1 -uroot --silent 2>/dev/null || mariadb-admin ping -h 127.0.0.1 -uroot --silent' >/dev/null 2>&1`)}; gunzip -c "$3" | docker exec -i -e MYSQL_PWD "$1" sh -c 'if command -v mysql >/dev/null; then exec mysql -h 127.0.0.1 -uroot; else exec mariadb -h 127.0.0.1 -uroot; fi'`,
  mongo: `docker run -d --name "$1" --label unit7.copy-of="$5" \${4:+--network "$4"} \${6:+-v "$6"} "$2" >/dev/null; ${WAIT(`docker exec "$1" sh -c 'mongosh --quiet --eval 1 || mongo --quiet --eval 1' >/dev/null 2>&1`)}; gunzip -c "$3" | docker exec -i "$1" mongorestore --quiet --archive --drop`,
  redis: `d="$(dirname "$3")/$1"; mkdir -p "$d"; gunzip -c "$3" > "$d/dump.rdb"; chmod 644 "$d/dump.rdb"; docker run -d --name "$1" --label unit7.copy-of="$5" \${4:+--network "$4"} -v "$d":/data "$2" >/dev/null; ${WAIT(`docker exec "$1" redis-cli ping 2>/dev/null | grep -q PONG`)}`,
};
COPY.mariadb = COPY.mysql!;
// over the live one, the same way each engine's dump is read back: every table and collection is replaced
const OVER: Record<string, string> = {
  mysql: `gunzip -c "$1" | docker exec -i "$2" sh -c 'export MYSQL_PWD="\${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; if command -v mysql >/dev/null; then exec mysql -uroot; else exec mariadb -uroot; fi'`,
  mongo: `gunzip -c "$1" | docker exec -i "$2" sh -c '${mongoAs('mongorestore --quiet --archive --drop')}'`,
  // Redis writes its data when it stops, so the file goes in while it's stopped
  redis: `set -e; d=$(docker exec "$2" sh -c 'export REDISCLI_AUTH="\${REDIS_PASSWORD:-$REDISCLI_AUTH}"; redis-cli CONFIG GET dir | tail -n 1'); f=$(docker exec "$2" sh -c 'export REDISCLI_AUTH="\${REDIS_PASSWORD:-$REDISCLI_AUTH}"; redis-cli CONFIG GET dbfilename | tail -n 1'); gunzip -c "$1" > "$1.rdb"; docker stop "$2" >/dev/null; docker cp "$1.rdb" "$2":"\${d:-/data}/\${f:-dump.rdb}"; docker start "$2" >/dev/null; rm -f "$1.rdb"`,
};
OVER.mariadb = OVER.mysql!;
// Postgres: pg_dumpall's file only adds, so each database in it goes first, then it's read back the way a test copy is (a role that
// exists already just says so, and carries on). The proof decides, not psql's exit status. The dump's own \connect lines name the
// databases; a name that isn't plain stops it here, before anything is dropped. $1 the file, $2 the container, $3 psql's login (pgIn).
OVER.postgres = String.raw`set -e; set -f; f=$1; c=$2; q=$3
run() { docker exec -i "$c" sh -c "$q" unit7 "$@"; }
dbs=$(gunzip -c "$f" | awk '/^\\connect /{print $2}' | tr -d '"' | sort -u | grep -v -x -e template0 -e template1 || true)
for d in $dbs; do case "$d" in *[!A-Za-z0-9_-]*) echo "the backup holds a database with a name Unit7 won't put in a command: $d" >&2; exit 3;; esac; done
n=$(echo 'show server_version_num' | run -At); force=''; [ "$n" -ge 130000 ] && force=' WITH (FORCE)'
for d in $dbs; do printf 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid();\nDROP DATABASE IF EXISTS "%s"%s;\n' "'$d'" "$d" "$force"; done | run -v ON_ERROR_STOP=1 >/dev/null
case " $(echo $dbs) " in *' postgres '*) echo 'CREATE DATABASE postgres TEMPLATE template0;' | run -v ON_ERROR_STOP=1 >/dev/null;; esac
gunzip -c "$f" | run 2>&1 >/dev/null | ${PG_SAID} || true`;
// psql in a live database's own container, as its own superuser, on template1 (the one database a restore never drops)
const pgIn = (image: string) => `export PGPASSWORD="\${POSTGRES_PASSWORD:-}"; exec psql -X -q ${SUPABASE.test(image) ? '-h 127.0.0.1 -U supabase_admin' : '-U "\${POSTGRES_USER:-postgres}"'} -d template1 "$@"`;
// Nothing from outside the container can connect while it's restored: reject lines go on top of pg_hba.conf, and a reload takes them.
// No restart. The file comes back from the copy kept next to it, and a closed database opens again from Activity if Unit7 lost the connection.
const PG_CLOSE = String.raw`set -e; c=$1; q=$2
f=$(echo 'show hba_file' | docker exec -i "$c" sh -c "$q" unit7 -At)
docker exec -i "$c" sh -c '[ -e "$1.unit7" ] || cp -p "$1" "$1.unit7"; { printf "host all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\nhost all all all reject\n"; cat "$1.unit7"; } > "$1.new"; cat "$1.new" > "$1"; rm -f "$1.new"' unit7 "$f"
echo 'select pg_reload_conf()' | docker exec -i "$c" sh -c "$q" unit7 -At >/dev/null`;
const PG_OPEN = String.raw`set -e; c=$1; q=$2
f=$(echo 'show hba_file' | docker exec -i "$c" sh -c "$q" unit7 -At)
docker exec -i "$c" sh -c 'if [ -e "$1.unit7" ]; then cat "$1.unit7" > "$1"; rm -f "$1.unit7"; fi' unit7 "$f"
echo 'select pg_reload_conf()' | docker exec -i "$c" sh -c "$q" unit7 -At >/dev/null`;
export const openPgCommand = (s: ServerRow, c: string, image: string) => asRoot(s) + script(PG_OPEN, c, pgIn(image));
export const closePg = (ctx: Ctx, s: ServerRow, c: string, image: string, name: string) => ssh(ctx.app).check(s, asRoot(s) + script(PG_CLOSE, c, pgIn(image)), { what: `Closing ${name} to apps`, timeoutMs: 60_000, signal: ctx.signal });
// its superuser, as the proof signs in: a Compose or Coolify Postgres can have its own
async function pgLogin(ctx: Ctx, s: ServerRow, c: string, image: string) {
  if (SUPABASE.test(image)) return undefined;
  const u = (await ssh(ctx.app).check(s, asRoot(s) + script(`docker exec "$1" sh -c 'printf %s "\${POSTGRES_USER:-postgres}"'`, c), { what: 'Reading its superuser' })).trim();
  if (!/^[a-zA-Z_][\w$-]{0,62}$/.test(u)) throw new Unit7Error('unsafe_name', `The superuser “${u.slice(0, 60)}” has characters Unit7 won’t put in a command.`, 400);
  return `-U ${shq(u)}`;
}
// one file, over what's there, proven against that same file
export async function replayPg(ctx: Ctx, s: ServerRow, c: string, image: string, file: string) {
  const r = await ssh(ctx.app).exec(s, asRoot(s) + script(OVER.postgres!, file, c, pgIn(image)), { timeoutMs: 60 * 60_000, signal: ctx.signal });
  if (r.code !== 0) return { ok: false, note: (r.stderr || r.stdout).trim().slice(-300) || `exit ${r.code}` };
  return provePostgres(ctx, s, c, image, file, r.stderr.split('\n').filter(Boolean), await pgLogin(ctx, s, c, image));
}
// Over a live Postgres. If the file doesn't come back whole, the fresh backup goes back the same way. If that fails too it stays
// closed: apps writing into a half-restored database is the one thing worse than being down.
async function overPostgres(ctx: Ctx, s: ServerRow, p: Part, c: string, image: string, file: string, safety: string) {
  const open = openPgCommand(s, c, image), changeId = id('chg');
  run(ctx.db, 'INSERT INTO changes (id, org_id, server_id, part, verb, summary, undo, status, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', changeId, ctx.orgId, s.id, p.id, 'restore_open', `Closed ${p.name} to apps while it was restored`, JSON.stringify({ steps: [open] }), 'done', ctx.actor.name);
  await closePg(ctx, s, c, image, p.name);
  const done = await replayPg(ctx, s, c, image, file).catch((e: Error) => ({ ok: false, note: e.message.slice(0, 300) }));
  if (!done.ok) {
    ctx.progress(`That didn’t come back whole, so ${p.name} goes back to how it was…`);
    const back = await replayPg(ctx, s, c, image, safety).catch((e: Error) => ({ ok: false, note: e.message.slice(0, 300) }));
    if (!back.ok) {
      ctx.emit('backup.restore_failed', `Restoring ${p.name} on ${s.name} failed, and so did putting it back. It stays closed to apps so nothing writes into it. Undo in Activity opens it again.`, { severity: 'critical', resource: s.id, data: { part: p.id, changeId } });
      throw new Unit7Error('restore_failed', `Restoring ${p.name} failed (${done.note}), and so did putting back the backup taken just before (${back.note}). It stays closed to apps. Undo in Activity opens it again.`, 502, { changeId });
    }
  }
  await ssh(ctx.app).check(s, open, { what: `Opening ${p.name} to apps again`, timeoutMs: 60_000 });
  run(ctx.db, `UPDATE changes SET status = 'kept' WHERE id = ?`, changeId);
  if (!done.ok) throw new Unit7Error('restore_undone', `That backup didn’t come back whole (${done.note}), so ${p.name} was put back as it was just before. Nothing was lost.`, 409);
  return done;
}

defineTool({
  name: 'part.backups', title: 'Backups of the databases on a server', risk: 'read', action: 'read',
  description: 'The backups Unit7 took of databases it found on a server (part.backup, part.backup_schedule), newest first per database, with its schedule. part.restore brings one back.',
  input: z.object({ serverId: fid('srv') }),
  run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const rows = all<{ id: string; part: string; kind: string; reason: string; size: number | null; offsite: string | null; created_at: string }>(ctx.db,
      `SELECT id, part, kind, reason, size, offsite, created_at FROM backups WHERE org_id = ? AND server_id = ? AND part IS NOT NULL AND status = 'done' ORDER BY created_at DESC LIMIT 300`, ctx.orgId, s.id);
    const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
    const schedules = all<{ part: string; name: string; frequency: string; keep: number }>(ctx.db, 'SELECT part, name, frequency, keep FROM part_backup_schedules WHERE org_id = ? AND server_id = ?', ctx.orgId, s.id);
    const parts = [...new Set([...schedules.map((x) => x.part), ...rows.map((r) => r.part)])];
    return parts.map((part) => {
      const p = inv && findPart(inv, part), sch = schedules.find((x) => x.part === part);
      return {
        part, name: p?.name ?? sch?.name ?? part, engine: p?.engine ?? rows.find((r) => r.part === part)?.kind, canRestoreOverLive: !!(p?.engine && OVER[p.engine]),
        schedule: sch ? { frequency: sch.frequency, keep: sch.keep } : null,
        backups: rows.filter((r) => r.part === part).slice(0, 20).map((r) => ({ id: r.id, at: r.created_at, size: r.size, reason: r.reason, offServer: !!r.offsite && !json<{ error?: string }>(r.offsite, {}).error })),
      };
    });
  },
});

defineTool({
  name: 'part.restore', title: 'Bring back a database from a backup',
  risk: (i) => (i.into === 'live' ? 'destructive' : 'write'), action: (i) => (i.into === 'live' ? 'restore' : 'database_create'),
  peopleOnly: (i) => i.into === 'live', timeoutMs: 65 * 60_000,
  description: 'Restore a backup Unit7 took of a database it found on a server (part.backups lists them). into copy (the default): a new container next to the live one, from the same image, no port open to the internet; the live one is untouched, and Undo removes the copy. into live: over the live database (a person only, typing its name as confirmName), after a fresh backup so it can be undone. Postgres and Supabase also pass a test restore first, stay closed to apps while it runs, and go back by themselves if the result doesn’t match the file.',
  input: z.object({ serverId: fid('srv'), part: PART, backupId: fid('bak').optional().describe('Which backup; the newest by default'), into: z.enum(['copy', 'live']).default('copy'), confirmName: z.string().max(300).optional() }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
    const p = inv && findPart(inv, i.part);
    if (!p?.engine) throw new Unit7Error('not_found', `Unit7 didn’t find the database “${i.part}” on ${s.name}.`, 404);
    const b = get<{ id: string; location: string; checksum: string | null; created_at: string }>(ctx.db, `SELECT id, location, checksum, created_at FROM backups WHERE org_id = ? AND server_id = ? AND part = ? AND status = 'done' AND (? IS NULL OR id = ?) ORDER BY created_at DESC LIMIT 1`,
      ctx.orgId, s.id, p.id, i.backupId ?? null, i.backupId ?? null);
    if (!b) throw new Unit7Error('no_backup', `There’s no backup of ${p.name} to bring back${i.backupId ? ' with that id' : ''}.`, 404);
    if (i.into === 'live') {
      requireHuman(ctx, 'restore over a live database');
      if (!OVER[p.engine]) throw new Unit7Error('copy_only', `Unit7 brings ${p.name}’s backups back as a test copy, not over the live one: restore into a copy, check it, then point your app at it.`, 409);
      // its name, or the short id the Approvals card asks for
      if (![p.name, p.id.replace(/^(stack:.*:|[a-z0-9]+:)/, '')].includes(i.confirmName?.trim() ?? '')) throw new Unit7Error('confirm_name', `To restore over ${p.name}, type its name exactly.`, 400);
    }
    // a damaged or swapped file is caught before anything changes
    const sum = (await ssh(ctx.app).exec(s, asRoot(s) + script('gunzip -t "$1" && sha256sum "$1" | cut -d" " -f1', b.location))).stdout.trim();
    if (!sum || (b.checksum && sum !== b.checksum)) throw new Unit7Error('bad_backup', 'That backup file is missing on the server, damaged, or isn’t the one Unit7 made. Nothing was changed.', 409);
    const when = new Date(b.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (i.into === 'live') {
      const c = liveContainer(p), pg = p.engine === 'postgres', image = imageOf(p) ?? '';
      if (!c) throw new Unit7Error('not_found', `Unit7 couldn’t tell which container is ${p.name}’s database.`, 409);
      if (pg) {
        const t = await execute(ctx.app, ctx.orgId, ctx.actor, 'part.verify', { serverId: s.id, part: p.id, backupId: b.id }, { reason: 'before a restore over the live one', signal: ctx.signal });
        if (t.status !== 'ok') throw new Unit7Error('test_failed', `That backup didn’t pass its test restore, so the live ${p.name} wasn’t touched: ${t.status === 'error' ? t.error.message : t.status === 'denied' ? t.why : 'it waits for approval'}`, 409);
      }
      ctx.progress(`Backing up ${p.name} as it is now, first…`);
      const safety = await takePartBackup(ctx, s, p, 'before a restore');
      ctx.progress(`Restoring ${p.name} from ${when}…`);
      const proof = pg ? await overPostgres(ctx, s, p, c, image, b.location, safety.location) : undefined;
      if (!pg) await ssh(ctx.app).check(s, asRoot(s) + script(OVER[p.engine]!, b.location, c), { what: `Restoring ${p.name}`, timeoutMs: 60 * 60_000, signal: ctx.signal });
      ctx.emit('backup.restored', `${ctx.actor.name} restored ${p.name} on ${s.name} from the backup of ${when}`, { severity: 'warning', resource: s.id, data: { backupId: b.id, part: p.id, safetyBackup: safety.backupId } });
      return { restored: p.name, into: 'live', from: when, ...(proof && { proof: proof.note }), safetyBackup: safety.backupId, undo: `To go back, restore the backup taken just before (${safety.backupId}) the same way.` };
    }
    const image = imageOf(p);
    if (!image) throw new Unit7Error('not_found', `Unit7 couldn’t tell which image ${p.name} runs, so it can’t make a copy.`, 409);
    const name = `${p.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40) || 'db'}-copy-${b.created_at.slice(0, 10).replace(/-/g, '')}-${id('x').slice(2, 6).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;
    const password = randomBytes(18).toString('base64url');
    ctx.redactor.add(password, 'the test copy’s password');
    const network = p.engine === 'postgres' || p.engine === 'mysql' || p.engine === 'mariadb' ? p.networks?.[0] ?? '' : '';
    ctx.progress(`Making a test copy of ${p.name} from ${when}…`);
    try {
      await ssh(ctx.app).check(s, asRoot(s) + script(`${COPY_PW}set -e; ${COPY[p.engine]!}`, name, image, b.location, network, p.id), { what: `Making a copy of ${p.name}`, timeoutMs: 60 * 60_000, signal: ctx.signal, stdin: `${password}\n` });
    } catch (e) {
      await ssh(ctx.app).exec(s, asRoot(s) + script(REMOVE_COPY, name)).catch(() => undefined);
      throw e;
    }
    const ref = makeRef('copy', `${s.id}-${name}`, 'PASSWORD');
    if (p.engine !== 'mongo' && p.engine !== 'redis') ctx.app.vault.put(ctx.orgId, ref, password, { kind: 'db_password', by: ctx.actor.name, meta: { label: `Password of the test copy ${name}`, people: true } });
    const changeId = id('chg'), summary = `Made a test copy of ${p.name} from the backup of ${when} (${name})`;
    run(ctx.db, 'INSERT INTO changes (id, org_id, server_id, part, verb, summary, undo, status, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', changeId, ctx.orgId, s.id, p.id, 'restore_copy', summary,
      JSON.stringify({ steps: [asRoot(s) + script(`${REMOVE_COPY}; true`, name)] }), 'done', ctx.actor.name);
    ctx.emit('change.made', `${summary} on ${s.name}. The live one is untouched. It can be undone.`, { severity: 'success', resource: s.id, data: { changeId, part: p.id, undo: 'change.undo' } });
    return {
      restored: p.name, into: 'copy', from: when, copy: name, ...(network && { network }), changeId,
      next: `The live ${p.name} is untouched. The copy “${name}” runs next to it${network ? ` on the same network, so an app there can reach it at ${name}` : ''}, with no port open to the internet. Undo in Activity removes it.`,
      ...(p.engine !== 'mongo' && p.engine !== 'redis' && { passwordRef: ref }),
    };
  },
});

// --- open a past copy ------------------------------------------------------------------------------------------------------
// part.restore into a copy gives yesterday's data as a side copy with no public port. These read it: look at a table, pull
// one table out to a file, and put it away. Nothing here touches the live database, and these only ever act on a container
// Unit7 made as a copy, known by its label and its name. Nothing removes one by itself: an app may run on it by now. After
// two days a person is reminded, once.
const OPEN_COPY = /^[a-z0-9][a-z0-9_.-]*-copy-\d{8}-[a-z0-9]{4}$/;
const COPY_REF = z.string().regex(OPEN_COPY, 'a copy’s name, from part.copies');
const COPY_DAYS = 2;
const copyLine = (l: string) => { const [name = '', of = '', at = ''] = l.split('|'); return { name, of, at: new Date(at.replace(/ [A-Z]+$/, '').replace(' ', 'T').replace(' ', '')).toISOString() }; };
async function copiesOn(ctx: Ctx, s: ServerRow) {
  const out = (await ssh(ctx.app).exec(s, asRoot(s) + `docker ps -a --filter label=unit7.copy-of --format '{{.Names}}|{{.Label "unit7.copy-of"}}|{{.CreatedAt}}'`, { timeoutMs: 20_000 })).stdout;
  return out.split('\n').filter(Boolean).filter((l) => OPEN_COPY.test(l.split('|')[0] ?? '')).map((l) => { try { return copyLine(l); } catch { return undefined; } }).filter((x) => !!x);
}
async function theCopy(ctx: Ctx, serverId: string, name: string) {
  const s = serverRow(ctx, serverId), c = (await copiesOn(ctx, s)).find((x) => x.name === name);
  if (!c) throw new Unit7Error('not_a_copy', `${name} isn’t a copy Unit7 made on ${s.name}.`, 404);
  return { s, c };
}
const PG_COPY = (flags: string) => `docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' "$1" psql -U postgres -v ON_ERROR_STOP=1 -qX ${flags}`;

defineTool({
  name: 'part.copies', title: 'Past copies open now', risk: 'read', action: 'read',
  description: 'Side copies of a database on a server, made by part.restore: each has no public port. Unit7 reminds a person after two days and never removes one by itself.',
  input: z.object({ serverId: fid('srv') }),
  run: async (ctx, i) => ({ copies: await copiesOn(ctx, serverRow(ctx, i.serverId)) }),
});

defineTool({
  name: 'part.copy_read', title: 'Look inside a past copy', risk: 'read', action: 'read', timeoutMs: 40_000,
  description: 'Run one read-only query on a past copy (Postgres), to find a row or a table as it was. The live database isn’t touched. At most 200 rows come back. The copy holds real data, so an AI sees of it what part.query shows: plain columns whose names aren’t personal, and counts.',
  input: z.object({ serverId: fid('srv'), copy: COPY_REF, sql: z.string().min(3).max(4000) }),
  async run(ctx, i) {
    const st = readStatement(i.sql, 'pg'), real = seesReal(ctx);
    const { s } = await theCopy(ctx, i.serverId, i.copy);
    // the query goes to psql alone, on stdin: it never passes through a shell on the server
    const ask = (flags: string, text: string) => ssh(ctx.app).exec(s, asRoot(s) + script(PG_COPY(flags), i.copy), { stdin: `${text}\n;\n`, timeoutMs: 35_000, signal: ctx.signal });
    const hears = (r: { stderr: string }) => new Unit7Error('query_failed', real ? ctx.redactor.redact(r.stderr).slice(0, 300) : aiHears(r.stderr), 400);
    if (real) {
      const r = await ask(`-At -F '|'`, st.text);
      if (r.code !== 0) throw hears(r);
      const rows = r.stdout.split('\n').filter(Boolean);
      return { rows: rows.slice(0, 200).map((l) => ctx.redactor.redact(l)), more: Math.max(0, rows.length - 200) };
    }
    // a past copy holds the same rows as the live one, and this login is its superuser, so the same masks as part.query
    let plan: unknown;
    if (isRows(st.first)) {
      const p = await ask('-At', `EXPLAIN (VERBOSE, FORMAT JSON)\n${st.text}`);
      if (p.code !== 0) throw hears(p);
      try { plan = (JSON.parse(p.stdout) as { Plan: unknown }[])[0]?.Plan; } catch { plan = undefined; }
    }
    if (usesDynamic(`${st.text.toLowerCase()} ${JSON.stringify(plan ?? '')}`)) throw new Unit7Error('not_for_ai', 'That function runs text as a query or reads outside the tables, so Unit7 can’t tell what comes back. A person can run it.', 403);
    const r = await ask('--csv', st.text);
    if (r.code !== 0) throw hears(r);
    const [columns = [], ...rows] = parseCsv(r.stdout), name = (c: string) => ctx.redactor.redact(hideShapes(c)), out = maskRows(columns, rows.slice(0, 200), readMask(st, plan, columns));
    return { columns: columns.map(name), rows: out.rows.map((x) => x.map((c) => ctx.redactor.redact(c)).join('|')), masked: out.masked.map(name), more: Math.max(0, rows.length - 200) };
  },
});

defineTool({
  name: 'part.copy_export', title: 'Pull one table out of a past copy', risk: 'write', action: 'backup', green: true, timeoutMs: 15 * 60_000,
  description: 'Write one table of a past copy (Postgres) to a compressed SQL file on the server, next to the backups. Only creates a file. Loading it back into the live database is a separate step a person takes.',
  input: z.object({ serverId: fid('srv'), copy: COPY_REF, table: z.string().regex(/^[a-zA-Z_][\w$]*(\.[a-zA-Z_][\w$]*)?$/, 'a table name') }),
  async run(ctx, i) {
    const { s, c } = await theCopy(ctx, i.serverId, i.copy);
    const dir = `${manageDirs.backups}/exports`, file = `${dir}/${i.copy}-${i.table.replace(/\W/g, '_')}.sql.gz`;
    await ssh(ctx.app).check(s, asRoot(s) + script('set -e; mkdir -p "$1"; docker exec "$2" pg_dump -U postgres --data-only -t "$3" | gzip > "$4"; [ "$(gzip -dc "$4" | head -c 1 | wc -c)" -gt 0 ]', dir, i.copy, i.table, file), { what: `Pulling ${i.table} out of the copy`, timeoutMs: 14 * 60_000, signal: ctx.signal });
    const size = Number((await ssh(ctx.app).exec(s, asRoot(s) + script('wc -c < "$1"', file))).stdout.trim());
    ctx.emit('backup.exported', `Pulled ${i.table} out of a past copy of ${c.of} into a file on ${s.name}`, { resource: s.id });
    return { file, size, next: 'The file is on the server. Loading it into the live database changes live data, so that stays your call.' };
  },
});

defineTool({
  name: 'part.copy_remove', title: 'Put a past copy away', risk: 'destructive', action: 'cleanup',
  description: 'Remove a side copy Unit7 made, with its data. An app may run on it by now, so an AI asks a person first. Only ever a copy: the live database and the backup file aren’t touched.',
  input: z.object({ serverId: fid('srv'), copy: COPY_REF }),
  assess: () => ({ tier: 3, impact: 'The copy and everything in it go for good. The live database and the backup file stay.' }),
  async run(ctx, i) { const { s } = await theCopy(ctx, i.serverId, i.copy); await removeCopy(ctx, s, i.copy); return { removed: i.copy }; },
});
// a drill or a rehearsal puts away the copy it opened a moment ago, and nothing else
export const removeCopy = (ctx: Ctx, s: ServerRow, copy: string) => ssh(ctx.app).check(s, asRoot(s) + script(REMOVE_COPY, copy), { what: 'Removing the copy' });

// Warden: an old copy holds real data, so a person hears about it, once
export async function remindCopies(ctx: Ctx, nowMs = Date.now()) {
  const old: string[] = [];
  for (const s of all<ServerRow>(ctx.db, `SELECT * FROM servers WHERE org_id = ? AND status = 'ready'`, ctx.orgId)) {
    for (const c of await copiesOn(ctx, s).catch(() => [])) {
      if (nowMs - Date.parse(c.at) <= COPY_DAYS * 86400_000 || get(ctx.db, `SELECT 1 FROM events WHERE org_id = ? AND type = 'copy.old' AND resource = ?`, ctx.orgId, c.name)) continue;
      old.push(c.name);
      ctx.emit('copy.old', `The past copy ${c.name} on ${s.name} is more than two days old and holds real data. Put it away on Protect once nothing uses it.`, { severity: 'warning', resource: c.name });
    }
  }
  return { reminded: old };
}
defineTool({ name: 'part.copies_remind', title: 'Say which past copies are old', risk: 'read', action: 'read', idle: (o: { reminded: string[] }) => !o.reminded.length, description: 'Tell a person about side copies older than two days, once each. Removes nothing. Warden does this hourly.', input: z.object({}), run: (ctx) => remindCopies(ctx) });
