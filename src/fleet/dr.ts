// A warm standby: a copy of an app on a second server, ready to take over if its server dies.
//  · The copy is a fleet target with the role "standby": out of rotation (no visitors), and every release reaches it like
//    any other server of the app (rolling.ts), so it always runs the same version. It answers the app's names on its own
//    proxy, with the main server's certificate copied over (care.ts copyCerts).
//  · Its databases: each of the app's databases on the main server gets a copy on the standby under the same private
//    name, password and volume name, so the app's settings work there unchanged. Every N hours (6 by default) Unit7 takes
//    a fresh backup of each (backup.create) and restores it there. Redis is a cache: its copy starts empty. A streaming
//    replica (Postgres replication) would lose minutes instead of hours; that's for later.
//  · Failover moves every visitor: the app's DNS records point at the standby instead of the main server. Warden does it
//    by itself only when the main server has been down 5 minutes or more AND the environment runs at "Production
//    autonomy" or higher (with a phone alert); otherwise Warden asks (one tap). A person can switch at any time.
//  · Switching back copies what the standby collected back to the main server first (after a fresh backup there).
//  · The monthly drill, in a quiet hour, only when the standby is healthy: refresh the data now, then ask the standby for
//    the app's real name over HTTPS, the way visitors would reach it after a switch. It doesn't move real visitors: their
//    writes would land in the copy and be lost when switching back.
// The promise line comes from these numbers: "If this server dies, you're back in about N minutes, losing at most H hours
// of data."
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { App } from '../app.ts';
import { all, get, json, now, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { gzipInto, script, safeName } from '../connectors/shell.ts';
import { APPS, LOG_OPTS, containerName, healthCheck, removeCopies, replicaNames, startContainer, writeEnvFile, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';
import { backupBeforeChange } from '../tools/backups.ts';
import { RESTORE } from '../tools/staging.ts';
import { execute, type Actor, type Ctx, type ToolResult } from '../tools/runtime.ts';
import { isTestHost } from '../care/readiness.ts';
import { planOf, setTarget, targetsOf, type Target } from './model.ts';
import { copyTo, envFor } from './rolling.ts';
import { dnsRotate, fleetDeps } from './traffic.ts';
import { publicAddress } from './network.ts';
import { copyCerts, wantEnv } from './care.ts';
import { DNS_ACCOUNT, EDITORS } from '../connectors/dnswrite.ts';

export const DR_HOURS = 6, DOWN_MINUTES = 5, DRILL_DAYS = 30;
export interface DrDb { serviceId: string; name: string; engine: string; container: string; database: string; volume: string }
export interface Drill { at: string; ok: boolean; refreshSeconds?: number; answerMs?: number; requests: number; failed: number; note: string }
export interface DrRow {
  service_id: string; org_id: string; server_id: string; status: 'preparing' | 'ready' | 'active' | 'failed'; hours: number; dbs: string;
  refreshed_at: string | null; data_at: string | null; refresh_error: string | null; drill: string | null; failover_at: string | null; dns: string | null; by: string | null; created_at: string;
}

// --- the decisions (pure; test/fleet-dr.test.ts) -------------------------------------------------------------------------
export const refreshDue = (r: Pick<DrRow, 'status' | 'hours' | 'refreshed_at'>, nowMs: number) =>
  r.status === 'ready' && (!r.refreshed_at || nowMs - Date.parse(r.refreshed_at) >= r.hours * 3600_000 - 60_000);

export type FailoverAct = { act: 'none' | 'wait' | 'failover' | 'ask' | 'alert'; why: string; msLeft?: number };
// main down 5+ minutes: Warden switches by itself at autonomy 3 or more, else asks; never to a standby that's not healthy
export function failoverDecision(o: { status: string; standbyHealthy: boolean; mainDownSince: string | null; nowMs: number; autonomy: number }): FailoverAct {
  if (o.status !== 'ready') return { act: 'none', why: o.status === 'active' ? 'Visitors are on the standby already.' : 'The standby isn’t ready.' };
  if (!o.mainDownSince) return { act: 'none', why: 'The main server answers.' };
  const down = o.nowMs - Date.parse(o.mainDownSince), left = DOWN_MINUTES * 60_000 - down;
  if (left > 0) return { act: 'wait', why: `The main server has been down ${Math.round(down / 60_000)} min; Unit7 waits ${DOWN_MINUTES} min before switching.`, msLeft: left };
  if (!o.standbyHealthy) return { act: 'alert', why: 'The main server is down and the standby doesn’t answer either, so switching wouldn’t help.' };
  return o.autonomy >= 3 ? { act: 'failover', why: `The main server has been down for ${Math.round(down / 60_000)} minutes.` } : { act: 'ask', why: `The main server has been down for ${Math.round(down / 60_000)} minutes; at this autonomy a person decides.` };
}

export interface Promise_ { ready: boolean; minutes: number | null; hoursLost: number | null; auto: boolean; words: string }
export function promiseOf(o: { status: string; hours: number; dataAt: string | null; nowMs: number; auto: boolean; dnsEditable: boolean; hasData: boolean; drill: Drill | null; main: string; name?: string; standbyIp?: string }): Promise_ {
  const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (o.status === 'preparing') return { ready: false, minutes: null, hoursLost: null, auto: o.auto, words: 'The standby is getting ready.' };
  if (o.status === 'failed') return { ready: false, minutes: null, hoursLost: null, auto: o.auto, words: 'The standby couldn’t be set up. Try again from here.' };
  if (o.status === 'active') return { ready: true, minutes: 0, hoursLost: null, auto: o.auto, words: `Visitors are on the standby now. Switch back once ${o.main} is fine again.` };
  // the data: everything since the last copy can be lost; while copies keep working that's at most one cadence
  const age = o.dataAt ? Math.ceil((o.nowMs - Date.parse(o.dataAt)) / 3600_000) : null;
  const hoursLost = !o.hasData ? 0 : age === null ? null : Math.max(o.hours, age);
  const loss = hoursLost === 0 ? 'losing nothing it keeps on that server' : hoursLost === null ? 'once its first data copy is done' : `losing at most ${pl(hoursLost, 'hour')} of data`;
  // the time: the DNS change reaching visitors (a 60-second record), the standby's answer (from the last drill), and with
  // the automatic switch the 5 minutes Unit7 waits to be sure the server is really down
  const switchMin = 1 + Math.max(1, Math.ceil((o.drill?.ok ? o.drill.answerMs ?? 0 : 30_000) / 60_000));
  if (!o.dnsEditable) return { ready: true, minutes: null, hoursLost, auto: false, words: `If ${o.main} dies, point ${o.name ?? 'your domain'} at ${o.standbyIp ?? 'the standby'} and you’re back as soon as that reaches visitors, ${loss}.` };
  const minutes = (o.auto ? DOWN_MINUTES : 0) + switchMin;
  return { ready: true, minutes, hoursLost, auto: o.auto, words: o.auto ? `If ${o.main} dies, you’re back in about ${pl(minutes, 'minute')}, ${loss}.` : `If ${o.main} dies, you’re back about ${pl(minutes, 'minute')} after you tap Switch to the standby, ${loss}.` };
}

// once a month, in a quiet hour (03:00–05:00 on the server's clock), never before the standby has been up a day
export const quietHour = (nowMs: number, offsetMin = 0) => { const h = new Date(nowMs + offsetMin * 60_000).getUTCHours(); return h >= 3 && h < 5; };
export const drillDue = (r: Pick<DrRow, 'status' | 'drill' | 'created_at'>, nowMs: number, offsetMin = 0) => {
  if (r.status !== 'ready' || !quietHour(nowMs, offsetMin)) return false;
  const last = json<Drill | null>(r.drill, null)?.at ?? r.created_at;
  return nowMs - Date.parse(last) >= (json<Drill | null>(r.drill, null) ? DRILL_DAYS * 86400_000 : 86400_000);
};

// --- records ---------------------------------------------------------------------------------------------------------
export const drOf = (db: DB, serviceId: string) => get<DrRow>(db, 'SELECT * FROM dr_standbys WHERE service_id = ?', serviceId);
const serverOf = (db: DB, id: string) => get<ServerRow>(db, 'SELECT * FROM servers WHERE id = ?', id)!;
const ownNames = (db: DB, svc: ServiceRow) => all<{ hostname: string; target: string | null }>(db, 'SELECT hostname, target FROM domains WHERE service_id = ? AND org_id = ?', svc.id, svc.org_id)
  .filter((d) => !isTestHost(d.hostname) && !json<{ redirectTo?: string }>(d.target, {}).redirectTo).map((d) => d.hostname);
const allNames = (db: DB, svc: ServiceRow) => all<{ hostname: string }>(db, 'SELECT hostname FROM domains WHERE service_id = ? AND org_id = ?', svc.id, svc.org_id).map((d) => d.hostname).filter((h) => !isTestHost(h));
const autonomyOf = (db: DB, envId: string) => get<{ autonomy: number }>(db, 'SELECT autonomy FROM environments WHERE id = ?', envId)?.autonomy ?? 2;
const standbyOf = (db: DB, svc: ServiceRow, r: DrRow) => targetsOf(db, svc).find((t) => t.serverId === r.server_id);
const mainDownSince = (db: DB, svc: ServiceRow) => { const s = svc.server_id ? serverOf(db, svc.server_id) : undefined; return s?.status === 'unreachable' ? json<{ wardenDown?: string }>(s.facts, {}).wardenDown ?? null : null; };

// --- the database copies ----------------------------------------------------------------------------------------------
const DATA = new Set(['postgres', 'mysql', 'mariadb', 'mongo']); // Redis is a cache: its copy starts empty
const PATHS: Record<string, string> = { postgres: '/var/lib/postgresql/data', mysql: '/var/lib/mysql', mariadb: '/var/lib/mysql', mongo: '/data/db', redis: '/data' };
// over TCP: on first boot a temporary server answers on the socket alone, then restarts
const READY: Record<string, string> = {
  postgres: 'docker exec "$1" pg_isready -h 127.0.0.1 -U postgres', mysql: 'docker exec "$1" mysqladmin ping -h 127.0.0.1 --silent', mariadb: 'docker exec "$1" mariadb-admin ping -h 127.0.0.1 --silent',
  mongo: 'docker exec "$1" mongosh --quiet --eval "db.runCommand({ping:1})"', redis: 'docker exec "$1" redis-cli ping',
};
const envOfDb = (engine: string, pw: string, database: string): Record<string, string> => ({
  postgres: { POSTGRES_PASSWORD: pw, POSTGRES_DB: database }, mysql: { MYSQL_ROOT_PASSWORD: pw, MYSQL_DATABASE: database }, mariadb: { MARIADB_ROOT_PASSWORD: pw, MARIADB_DATABASE: database },
  mongo: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: pw }, redis: { REDIS_PASSWORD: pw },
}[engine] ?? {});
const userOf = (engine: string) => (engine === 'postgres' ? 'postgres' : 'root');
// the dump of a copy on the standby (switching back), with the password on stdin and the dump's own exit code kept
const DUMP: Record<string, string> = {
  postgres: 'PGPASSWORD="$P" docker exec -e PGPASSWORD "$1" pg_dump -U postgres -d "$2" --no-owner --clean --if-exists',
  mysql: 'MYSQL_PWD="$P" docker exec -e MYSQL_PWD "$1" mysqldump -u root --single-transaction --databases "$2"',
  mariadb: 'MYSQL_PWD="$P" docker exec -e MYSQL_PWD "$1" mariadb-dump -u root --single-transaction --databases "$2"',
  mongo: 'docker exec "$1" mongodump --archive --gzip',
};

// the app's databases on its main server, as the standby needs them
export function standbyDbs(db: DB, svc: ServiceRow): { dbs: DrDb[]; refusal?: string } {
  const rows = all<{ id: string; name: string; kind: string; config: string }>(db, `SELECT id, name, kind, config FROM services WHERE environment_id = ? AND server_id = ? AND kind IN ('postgres', 'mysql', 'mariadb', 'mongo', 'redis')`, svc.environment_id, svc.server_id ?? '');
  const dbs: DrDb[] = [];
  for (const r of rows) {
    const c = json<{ container?: string; database?: string; volume?: string; passwordRef?: string; pool?: unknown; userRef?: string }>(r.config, {});
    if (c.pool) return { dbs, refusal: `${r.name} has a connection pooler in front of it, which the standby can’t copy yet.` };
    if (c.userRef) return { dbs, refusal: `${r.name} uses its own database user, which the standby can’t copy yet.` };
    if (!c.container || !c.passwordRef) return { dbs, refusal: `Unit7 doesn’t know how ${r.name} was made, so it can’t copy it.` };
    dbs.push({ serviceId: r.id, name: r.name, engine: r.kind, container: c.container, database: c.database ?? 'app', volume: c.volume ?? `${c.container}-data` });
  }
  return { dbs };
}
const passwordOf = (ctx: Ctx, d: DrDb) => ctx.secret(json<{ passwordRef: string }>(get<{ config: string }>(ctx.db, 'SELECT config FROM services WHERE id = ?', d.serviceId)!.config, { passwordRef: '' }).passwordRef);

async function startDbCopy(ctx: Ctx, main: ServerRow, s: ServerRow, d: DrDb) {
  const pool = ssh(ctx.app);
  const c = safeName(d.container, 'container');
  const image = (await pool.check(main, script('docker inspect -f "{{.Config.Image}}" "$1"', c), { what: `Reading ${d.name}’s version`, timeoutMs: 20_000 })).trim();
  if (!/^[\w./:@-]{1,200}$/.test(image)) throw new Unit7Error('bad_image', `${main.name} answered with something that isn’t an image name for ${d.name}.`, 502);
  const envFile = `${APPS}/${c}.env`;
  await writeEnvFile(ctx, s, envFile, envOfDb(d.engine, passwordOf(ctx, d), d.database));
  await pool.check(s, script(`docker rm -f "$1" >/dev/null 2>&1; docker run -d --name "$1" --restart unless-stopped --network unit7 --env-file "$2" -v "$3:$4" --label unit7.standby="$5" ${LOG_OPTS.join(' ')} "$6" ${d.engine === 'redis' ? 'sh -c "$7"' : ''} >/dev/null`,
    c, envFile, safeName(d.volume, 'volume'), PATHS[d.engine]!, d.serviceId, image, 'exec redis-server - <<EOF\nrequirepass $REDIS_PASSWORD\nmaxmemory-policy allkeys-lru\nEOF'), { what: `Starting a copy of ${d.name}`, timeoutMs: 180_000 });
  await pool.check(s, script(`for n in $(seq 1 60); do ${READY[d.engine]} >/dev/null 2>&1 && exit 0; sleep 1; done; docker logs --tail 20 "$1" >&2; exit 1`, c), { what: `Waiting for the copy of ${d.name}`, timeoutMs: 90_000 });
}

// one database's data: a fresh backup on the main server, sent to the standby, checked, restored into the copy there
async function copyData(ctx: Ctx, main: ServerRow, s: ServerRow, d: DrDb) {
  const b = await execute(ctx.app, ctx.orgId, ctx.actor, 'backup.create', { serviceId: d.serviceId, reason: 'for the standby copy' }, { reason: 'the standby’s data refresh', signal: ctx.signal, ...(ctx.approvalId && { underApproval: ctx.approvalId }) });
  if (b.status !== 'ok') throw new Unit7Error('backup_failed', `The backup of ${d.name} didn’t work: ${b.status === 'error' ? b.error.message : 'why' in b ? b.why : b.status}`, 502);
  const { backupId, location } = b.output as { backupId: string; location: string };
  const sum = get<{ checksum: string | null; created_at: string }>(ctx.db, 'SELECT checksum, created_at FROM backups WHERE id = ?', backupId)!;
  const pool = ssh(ctx.app);
  try {
    await pool.relay(main, script('cat "$1"', location), s, script('mkdir -p "$(dirname "$1")" && umask 077 && cat > "$1"', location), { timeoutMs: 60 * 60_000 });
    const there = (await pool.exec(s, script('gunzip -t "$1" && sha256sum "$1" | cut -d" " -f1', location))).stdout.trim();
    if (!there || (sum.checksum && there !== sum.checksum)) throw new Unit7Error('bad_copy', `The copy of ${d.name}’s backup arrived damaged on ${s.name}, so the standby keeps the data it had.`, 502);
    await pool.check(s, script(RESTORE[d.engine]!, location, safeName(d.container, 'container'), userOf(d.engine), d.database), { what: `Loading ${d.name}’s data into the standby`, stdin: `${passwordOf(ctx, d)}\n`, timeoutMs: 60 * 60_000, signal: ctx.signal });
  } finally {
    await pool.exec(s, script('rm -f "$1"', location)).catch(() => undefined);
  }
  return sum.created_at;
}

// --- set up, refresh, take down -----------------------------------------------------------------------------------------
export async function setupStandby(ctx: Ctx, svc: ServiceRow, s: ServerRow, hours = DR_HOURS) {
  const main = serverOf(ctx.db, svc.server_id!);
  run(ctx.db, `INSERT INTO dr_standbys (service_id, org_id, server_id, status, hours, dbs, by) VALUES (?, ?, ?, 'preparing', ?, '[]', ?)
    ON CONFLICT (service_id) DO UPDATE SET server_id = excluded.server_id, status = 'preparing', hours = excluded.hours, refresh_error = NULL, by = excluded.by`, svc.id, ctx.orgId, s.id, hours, ctx.actor.name);
  const { dbs } = standbyDbs(ctx.db, svc);
  run(ctx.db, 'UPDATE dr_standbys SET dbs = ? WHERE service_id = ?', JSON.stringify(dbs), svc.id);
  setTarget(ctx.db, ctx.orgId, svc.id, main.id, { role: 'primary', deploymentId: svc.current_deployment_id });
  setTarget(ctx.db, ctx.orgId, svc.id, s.id, { role: 'standby', state: 'out', deploymentId: null });
  try {
    for (const d of dbs) { ctx.progress(`Starting a copy of ${d.name} on ${s.name}…`); await startDbCopy(ctx, main, s, d); }
    ctx.progress('Copying the HTTPS certificate…');
    await copyCerts(ctx, main, s, allNames(ctx.db, svc)).catch(() => undefined); // none yet is fine: the proxy asks for its own once DNS points there
    await refreshStandby(ctx, svc, drOf(ctx.db, svc.id)!, { status: 'preparing' });
    ctx.progress(`Starting ${svc.name} on ${s.name} (out of rotation)…`);
    await copyTo(ctx, get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ?', svc.id)!, s, svc.current_deployment_id!, (k, detail) => ctx.progress(detail ?? k));
  } catch (e) {
    await takeDown(ctx, svc, s, dbs).catch(() => undefined);
    run(ctx.db, `UPDATE dr_standbys SET status = 'failed', refresh_error = ? WHERE service_id = ?`, (e as Error).message.slice(0, 400), svc.id);
    throw e;
  }
  run(ctx.db, `UPDATE dr_standbys SET status = 'ready' WHERE service_id = ?`, svc.id);
  ctx.emit('dr.ready', `${svc.name} has a warm standby on ${s.name}: same version, data copied every ${hours} hours, ready to take over.`, { severity: 'success', resource: svc.id, data: { serviceId: svc.id, serverId: s.id } });
  return drView(ctx, svc);
}

export async function refreshStandby(ctx: Ctx, svc: ServiceRow, r: DrRow, o: { status?: string } = {}) {
  const main = serverOf(ctx.db, svc.server_id!), s = serverOf(ctx.db, r.server_id);
  const t0 = Date.now();
  let dataAt: string | undefined;
  try {
    for (const d of json<DrDb[]>(r.dbs, []).filter((x) => DATA.has(x.engine))) { ctx.progress(`Copying ${d.name}’s data to the standby…`); dataAt = await copyData(ctx, main, s, d); }
    await copyCerts(ctx, main, s, allNames(ctx.db, svc)).catch(() => undefined);
  } catch (e) {
    run(ctx.db, 'UPDATE dr_standbys SET refresh_error = ? WHERE service_id = ?', (e as Error).message.slice(0, 400), svc.id);
    if (o.status !== 'preparing') ctx.emit('dr.refresh_failed', `The standby of ${svc.name} couldn’t get fresh data: ${(e as Error).message.split('\n')[0]} It keeps the copy from ${r.data_at ?? 'before'}.`, { severity: 'warning', resource: svc.id, data: { serviceId: svc.id } });
    throw e;
  }
  const at = now();
  run(ctx.db, 'UPDATE dr_standbys SET refreshed_at = ?, data_at = ?, refresh_error = NULL WHERE service_id = ?', at, dataAt ?? at, svc.id);
  return { seconds: Math.round((Date.now() - t0) / 1000), dataAt: dataAt ?? at };
}

async function takeDown(ctx: Ctx, svc: ServiceRow, s: ServerRow, dbs: DrDb[]) {
  const t = targetsOf(ctx.db, svc).find((x) => x.serverId === s.id);
  if (t?.number !== null && t?.number !== undefined) await removeCopies(ctx, s, containerName(svc, t.number)).catch(() => undefined);
  for (const d of dbs) await ssh(ctx.app).exec(s, script('docker rm -f "$1" >/dev/null 2>&1; docker volume rm "$2" >/dev/null 2>&1; rm -f "$3"; true', d.container, d.volume, `${APPS}/${d.container}.env`)).catch(() => undefined);
  run(ctx.db, 'DELETE FROM service_targets WHERE service_id = ? AND server_id = ?', svc.id, s.id);
  if (targetsOf(ctx.db, svc).length < 2) run(ctx.db, 'DELETE FROM service_targets WHERE service_id = ?', svc.id);
}
export async function removeStandby(ctx: Ctx, svc: ServiceRow, r: DrRow) {
  if (r.status === 'active') throw new Unit7Error('standby_serving', 'Visitors are on the standby right now. Switch back first.', 409);
  await takeDown(ctx, svc, serverOf(ctx.db, r.server_id), json<DrDb[]>(r.dbs, []));
  run(ctx.db, 'DELETE FROM dr_standbys WHERE service_id = ?', svc.id);
  ctx.emit('dr.removed', `${svc.name} no longer keeps a standby on ${serverOf(ctx.db, r.server_id).name}.`, { resource: svc.id, data: { serviceId: svc.id } });
}

// --- switching -------------------------------------------------------------------------------------------------------
// the copies on a server restarted with these settings and checked (the standby takes the jobs while it serves)
async function restartWith(ctx: Ctx, svc: ServiceRow, s: ServerRow, t: Target, env: Record<string, string>) {
  if (t.number === null || !t.deploymentId) throw new Unit7Error('not_running', `${svc.name} isn’t running on ${s.name}.`, 409);
  const dep = get<{ image: string | null }>(ctx.db, 'SELECT image FROM deployments WHERE id = ?', t.deploymentId);
  const cfg = json<ServiceConfig>(svc.config, {});
  const plan = planOf(ctx.db, t.deploymentId);
  const port = plan.port ?? cfg.port ?? 3000, path = plan.healthPath ?? cfg.healthPath ?? '/';
  const name = containerName(svc, t.number);
  for (const c of [name, ...replicaNames(name, cfg.replicas)]) {
    await startContainer(ctx, s, c, dep!.image!, { ...cfg, port }, env, svc);
    const h = await healthCheck(ctx, s, c, port, path, () => undefined);
    if (!h.healthy) throw new Unit7Error('unhealthy', `${svc.name} didn’t come up healthy on ${s.name}: ${h.detail.split('\n')[0]}`, 502);
  }
}

export async function failover(ctx: Ctx, svc: ServiceRow, r: DrRow, o: { auto?: boolean } = {}) {
  if (r.status !== 'ready') throw new Unit7Error('standby_not_ready', r.status === 'active' ? 'Visitors are on the standby already.' : 'The standby isn’t ready yet.', 409);
  const main = serverOf(ctx.db, svc.server_id!), s = serverOf(ctx.db, r.server_id);
  const t = standbyOf(ctx.db, svc, r);
  if (!t?.deploymentId) throw new Unit7Error('standby_not_ready', `${svc.name} isn’t running on the standby yet.`, 409);
  if (!(await fleetDeps.probe(ctx, svc, t).catch(() => false))) throw new Unit7Error('standby_unhealthy', `The standby of ${svc.name} on ${s.name} doesn’t answer right now, so switching wouldn’t help. Nothing changed.`, 409);
  const names = ownNames(ctx.db, svc);
  if (!names.length) throw new Unit7Error('no_domain', `${svc.name} has no domain of its own (only a test address that points at ${main.name}), so visitors can’t be moved. Connect a domain first.`, 409);
  // DNS first, before anything changes: without a way to edit it, the person moves the record
  const dns = await fleetDeps.dns(ctx, names[0]!);
  const standbyIp = await publicAddress(s);
  if (!dns) throw new Unit7Error('dns_manual', `Unit7 can’t edit ${names[0]}’s DNS. The standby is ready: point ${names.join(', ')} at ${standbyIp} where your DNS lives (an A record), and visitors arrive there within minutes.`, 409);
  const mainIp = await publicAddress(main).catch(() => main.host);
  ctx.progress(`Starting the standby’s scheduled jobs on ${s.name}…`);
  await restartWith(ctx, svc, s, t, wantEnv(ctx, svc, { primary: true, deploymentId: t.deploymentId }));
  ctx.progress(`Pointing ${names.join(', ')} at ${s.name}…`);
  await dnsRotate(dns, names, [standbyIp], [mainIp, standbyIp]);
  setTarget(ctx.db, ctx.orgId, svc.id, main.id, { role: 'primary', state: 'out' });
  setTarget(ctx.db, ctx.orgId, svc.id, s.id, { state: 'in' });
  run(ctx.db, `UPDATE dr_standbys SET status = 'active', failover_at = ?, dns = ? WHERE service_id = ?`, now(), JSON.stringify({ names, mainIp, standbyIp }), svc.id);
  ctx.emit('dr.failover', `${o.auto ? 'Unit7 moved' : `${ctx.actor.name} moved`} ${svc.name}’s visitors to the standby on ${s.name}${o.auto ? `: ${main.name} hadn’t answered for ${DOWN_MINUTES} minutes` : ''}. Its data is from ${r.data_at ? new Date(r.data_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'the last copy'}.`,
    { severity: 'critical', resource: svc.id, data: { serviceId: svc.id, serverId: s.id, auto: !!o.auto } });
  return drView(ctx, svc);
}

// back to the main server: the standby stops taking visitors (its copies stop for the few minutes of the data copy), what
// it collected goes back into the main databases (after a fresh backup of each), DNS points home, the standby sleeps again
export async function switchBack(ctx: Ctx, svc: ServiceRow, r: DrRow) {
  if (r.status !== 'active') throw new Unit7Error('not_switched', 'Visitors are on the main server already.', 409);
  const main = serverOf(ctx.db, svc.server_id!), s = serverOf(ctx.db, r.server_id);
  const primary = targetsOf(ctx.db, svc).find((x) => x.primary)!;
  if (!(await fleetDeps.probe(ctx, svc, primary).catch(() => false))) throw new Unit7Error('main_down', `${svc.name} doesn’t answer on ${main.name} yet, so visitors stay on the standby.`, 409);
  const d0 = json<{ names: string[]; mainIp: string; standbyIp: string }>(r.dns, { names: ownNames(ctx.db, svc), mainIp: main.host, standbyIp: s.host });
  const dns = await fleetDeps.dns(ctx, d0.names[0]!);
  if (!dns) throw new Unit7Error('dns_manual', `Unit7 can’t edit ${d0.names[0]}’s DNS. Point it back at ${d0.mainIp} there.`, 409);
  const t = standbyOf(ctx.db, svc, r)!;
  const pool = ssh(ctx.app);
  const name = containerName(svc, t.number ?? 0);
  ctx.progress('Stopping visits to the standby while its data goes back…');
  await pool.exec(s, script('docker stop "$@" >/dev/null 2>&1; true', name, ...replicaNames(name, json<ServiceConfig>(svc.config, {}).replicas)), { timeoutMs: 120_000 });
  for (const d of json<DrDb[]>(r.dbs, []).filter((x) => DATA.has(x.engine))) {
    const file = `/var/lib/unit7/backups/${safeName(d.container, 'container')}-from-standby-${Date.now()}.gz`;
    ctx.progress(`Copying ${d.name}’s new data back to ${main.name}…`);
    await pool.check(s, script(`mkdir -p "$(dirname "$3")"; IFS= read -r P; ${gzipInto(DUMP[d.engine]!, '$3')}; test -s "$3"`, d.container, d.database, file), { what: `Saving ${d.name} on the standby`, stdin: `${passwordOf(ctx, d)}\n`, timeoutMs: 60 * 60_000 });
    await pool.relay(s, script('cat "$1"', file), main, script('mkdir -p "$(dirname "$1")" && umask 077 && cat > "$1"', file), { timeoutMs: 60 * 60_000 });
    await backupBeforeChange(ctx, d.serviceId, 'putting back the data the standby collected');
    await pool.check(main, script(RESTORE[d.engine]!, file, d.container, userOf(d.engine), d.database), { what: `Loading ${d.name}’s data on ${main.name}`, stdin: `${passwordOf(ctx, d)}\n`, timeoutMs: 60 * 60_000 });
    await pool.exec(s, script('rm -f "$1"', file)).catch(() => undefined);
    await pool.exec(main, script('rm -f "$1"', file)).catch(() => undefined);
  }
  await dnsRotate(dns, d0.names, [d0.mainIp], [d0.mainIp, d0.standbyIp]);
  setTarget(ctx.db, ctx.orgId, svc.id, main.id, { state: 'in' });
  setTarget(ctx.db, ctx.orgId, svc.id, s.id, { state: 'out' });
  // the standby sleeps again: no jobs, no visitors
  await restartWith(ctx, svc, s, t, envFor(ctx, svc, planOf(ctx.db, t.deploymentId).port ?? json<ServiceConfig>(svc.config, {}).port ?? 3000)).catch(() => undefined);
  run(ctx.db, `UPDATE dr_standbys SET status = 'ready', failover_at = NULL, dns = NULL WHERE service_id = ?`, svc.id);
  ctx.emit('dr.back', `${svc.name}’s visitors are back on ${main.name}, with what the standby collected meanwhile. The standby is warm again.`, { severity: 'success', resource: svc.id, data: { serviceId: svc.id } });
  return drView(ctx, svc);
}

// --- the drill ----------------------------------------------------------------------------------------------------------
// the app's real name, asked at the standby's address over HTTPS (its own certificate), the way visitors reach it after a switch
export function askByName(ip: string, hostname: string, path: string, tls: boolean): Promise<{ code: number; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = (tls ? httpsRequest : httpRequest)({ host: ip, port: tls ? 443 : 80, path, method: 'GET', servername: hostname, headers: { host: hostname, 'user-agent': 'unit7-standby-drill' }, timeout: 10_000 }, (res) => { res.resume(); res.on('end', () => resolve({ code: res.statusCode ?? 0, ms: Date.now() - t0 })); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ code: 0, ms: Date.now() - t0 }));
    req.end();
  });
}
export const drDeps = { ask: askByName };

export async function drill(ctx: Ctx, svc: ServiceRow, r: DrRow) {
  if (r.status !== 'ready') throw new Unit7Error('standby_not_ready', r.status === 'active' ? 'Visitors are on the standby right now: no drill needed.' : 'The standby isn’t ready yet.', 409);
  const s = serverOf(ctx.db, r.server_id), t = standbyOf(ctx.db, svc, r);
  const save = (d: Drill) => { run(ctx.db, 'UPDATE dr_standbys SET drill = ? WHERE service_id = ?', JSON.stringify(d), svc.id); return d; };
  if (!t?.deploymentId || !(await fleetDeps.probe(ctx, svc, t).catch(() => false))) {
    throw new Unit7Error('standby_unhealthy', `The standby on ${s.name} doesn’t answer right now, so the drill didn’t run. Unit7 says when it does again.`, 409);
  }
  ctx.progress('Copying fresh data to the standby…');
  let refresh: { seconds: number } | undefined, note = '';
  try { refresh = await refreshStandby(ctx, svc, r); } catch (e) { note = `The data copy didn’t work: ${(e as Error).message.split('\n')[0]}`; }
  const names = ownNames(ctx.db, svc);
  const domain = names[0] ? get<{ tls_mode: string }>(ctx.db, 'SELECT tls_mode FROM domains WHERE hostname = ?', names[0]) : undefined;
  const plan = planOf(ctx.db, t.deploymentId);
  const path = ((plan as { readyPath?: string }).readyPath ?? plan.healthPath ?? '/').replace(/[^\w/.-]/g, '') || '/';
  const answers: { code: number; ms: number }[] = [];
  if (names[0]) {
    const ip = await publicAddress(s);
    ctx.progress(`Asking ${s.name} for ${names[0]}, as visitors would after a switch…`);
    for (let k = 0; k < 5; k++) answers.push(await drDeps.ask(ip, names[0], path, domain?.tls_mode !== 'off'));
  } else answers.push(...[await fleetDeps.probe(ctx, svc, t).then((ok) => ({ code: ok ? 200 : 0, ms: 0 }), () => ({ code: 0, ms: 0 }))]);
  const good = answers.filter((a) => a.code > 0 && a.code < 500);
  const ms = good.map((a) => a.ms).sort((a, b) => a - b);
  const ok = !!refresh && good.length === answers.length;
  const d = save({
    at: now(), ok, ...(refresh && { refreshSeconds: refresh.seconds }), ...(ms.length && { answerMs: ms[Math.floor(ms.length / 2)] }), requests: answers.length, failed: answers.length - good.length,
    note: note || (ok ? `The standby answered ${names[0] ?? svc.name} ${good.length} times out of ${answers.length}${ms.length ? `, in ${ms[Math.floor(ms.length / 2)]} ms` : ''}, with data copied ${refresh!.seconds < 90 ? `in ${refresh!.seconds} seconds` : `in ${Math.round(refresh!.seconds / 60)} minutes`}.` : `The standby answered ${good.length} of ${answers.length} times.`),
  });
  const v = drView(ctx, svc);
  ctx.emit('dr.drill', `${ok ? 'Drill passed' : 'Drill found a problem'} for ${svc.name}: ${d.note}${ok && v.promise ? ` ${v.promise.words}` : ''}`, { severity: ok ? 'success' : 'warning', resource: svc.id, data: { serviceId: svc.id, ok } });
  return { drill: d, ...v };
}

// --- what the panel shows ------------------------------------------------------------------------------------------------
export function drView(ctx: Pick<Ctx, 'db' | 'orgId'>, svc: ServiceRow, nowMs = Date.now()) {
  const r = drOf(ctx.db, svc.id);
  const main = svc.server_id ? serverOf(ctx.db, svc.server_id) : undefined;
  if (!r) return { serviceId: svc.id, standby: null, promise: null as Promise_ | null, notes: [] as string[] };
  const s = serverOf(ctx.db, r.server_id), t = targetsOf(ctx.db, svc).find((x) => x.serverId === r.server_id);
  const dbs = json<DrDb[]>(r.dbs, []);
  const names = ownNames(ctx.db, svc);
  // ponytail: "an account that edits DNS is connected" stands in for "it edits this name's DNS"; the switch itself checks for real
  const editors = [...new Set(Object.keys(EDITORS).map((p) => DNS_ACCOUNT[p] ?? p))];
  const dnsEditable = !!names.length && !!editors.length && !!get(ctx.db, `SELECT 1 FROM accounts WHERE org_id = ? AND provider IN (${editors.map(() => '?').join(', ')})`, ctx.orgId, ...editors);
  const auto = autonomyOf(ctx.db, svc.environment_id) >= 3;
  const facts = json<{ publicIp?: string }>(s.facts, {});
  const drillRow = json<Drill | null>(r.drill, null);
  const promise = promiseOf({ status: r.status, hours: r.hours, dataAt: r.data_at, nowMs, auto, dnsEditable, hasData: dbs.some((d) => DATA.has(d.engine)), drill: drillRow, main: main?.name ?? 'the main server', name: names[0], standbyIp: facts.publicIp ?? s.host });
  // what the standby can't carry: files on the main server's own disk (uploads, a SQLite file) aren't copied
  const risks = json<{ detection?: { scaleRisks?: string[] } }>(svc.config, {}).detection?.scaleRisks ?? [];
  const notes = [...(risks.some((r) => /upload/i.test(r)) ? ['Uploaded files on the main server’s disk aren’t copied to the standby: move them to R2 or S3 so both servers see them.'] : []),
    ...(risks.some((r) => /sqlite/i.test(r)) ? ['Its SQLite file isn’t copied to the standby: move the data to Postgres so the standby gets it.'] : [])];
  return {
    serviceId: svc.id, promise, notes,
    standby: { serverId: s.id, server: s.name, status: r.status, hours: r.hours, version: t?.number ?? null, health: t?.health ?? null, refreshedAt: r.refreshed_at, dataAt: r.data_at, refreshError: r.refresh_error,
      databases: dbs.map((d) => ({ name: d.name, engine: d.engine, copied: DATA.has(d.engine) })), drill: drillRow, failoverAt: r.failover_at, auto, dnsEditable, by: r.by },
  };
}

// --- Warden's minute -------------------------------------------------------------------------------------------------------
const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };
const asked = new Map<string, number>(); // a switch Warden asked for (or alerted about): once per 30 minutes per app
const busy = new Set<string>();
export async function drTick(app: App, act: (orgId: string, tool: string, input: unknown, reason: string) => Promise<ToolResult> = (o, t, i, r) => execute(app, o, WARDEN, t, i, { reason: r }), nowMs = Date.now()) {
  for (const r of all<DrRow>(app.db, `SELECT * FROM dr_standbys WHERE status IN ('ready', 'active')`)) {
    if (busy.has(r.service_id)) continue;
    const svc = get<ServiceRow>(app.db, 'SELECT * FROM services WHERE id = ?', r.service_id);
    if (!svc) continue;
    busy.add(r.service_id);
    try {
      const down = mainDownSince(app.db, svc);
      if (down) {
        const t = standbyOf(app.db, svc, r);
        const healthy = !!t && (t.health === 'ok' || (t.health === null && await fleetDeps.probe({ app, db: app.db }, svc, t).catch(() => false)));
        const d = failoverDecision({ status: r.status, standbyHealthy: healthy, mainDownSince: down, nowMs, autonomy: autonomyOf(app.db, svc.environment_id) });
        if ((d.act === 'failover' || d.act === 'ask' || d.act === 'alert') && nowMs - (asked.get(svc.id) ?? 0) > 30 * 60_000) {
          asked.set(svc.id, nowMs);
          if (d.act === 'alert') app.events.emit(svc.org_id, 'dr.cant_switch', `${svc.name}: ${d.why}`, { severity: 'critical', resource: svc.id, data: { serviceId: svc.id } });
          else await act(svc.org_id, 'dr.failover', { serviceId: svc.id, auto: true }, d.why);
        }
        continue; // nothing else while the main server is down
      }
      const offset = get<{ utc_offset: number | null }>(app.db, 'SELECT utc_offset FROM reboot_windows WHERE server_id = ?', r.server_id)?.utc_offset ?? 0; // the server's clock, when Unit7 knows it
      if (drillDue(r, nowMs, offset)) await act(svc.org_id, 'dr.drill', { serviceId: svc.id }, 'the monthly standby drill, in a quiet hour');
      else if (refreshDue(r, nowMs)) await act(svc.org_id, 'dr.refresh', { serviceId: svc.id }, `the standby’s data, every ${r.hours} hours`);
    } catch { /* said in Activity by the tool itself */ } finally { busy.delete(r.service_id); }
  }
}

// may Warden switch by itself right now? (the gate's assess: autonomy 3+ and the main server down 5+ minutes)
export function autoFailoverOk(db: DB, serviceId: string, nowMs = Date.now()) {
  const svc = get<ServiceRow>(db, 'SELECT * FROM services WHERE id = ?', serviceId), r = drOf(db, serviceId);
  if (!svc || !r) return false;
  const d = failoverDecision({ status: r.status, standbyHealthy: true, mainDownSince: mainDownSince(db, svc), nowMs, autonomy: autonomyOf(db, svc.environment_id) });
  return d.act === 'failover';
}
