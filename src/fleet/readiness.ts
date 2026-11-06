// "Ready for many servers · 4 of 6": what would break if the app ran on a second server, from what Unit7 has seen (the
// code it read at the last deploy, the server's X-ray, the app's settings and its databases), never from what anyone
// says. Every check is always on the list (a tick means nothing was found), and each unticked one carries one fix: a
// Unit7 tool through the gate where there is one, or the request for the person's AI where it takes a code change.
import { all, get, json, type DB } from '../db.ts';
import type { ServiceConfig, ServiceRow } from '../deploy/deployer.ts';
import { lastXray } from '../tools/xray.ts';
import type { Inventory } from '../discovery/xray.ts';
import type { Check, Fix } from '../care/readiness.ts';

export interface ReadyIn {
  name: string; serviceId: string; environmentId: string; serverName: string;
  scaleRisks: string[];          // what the code does that breaks with a second copy (detect.ts, at the last deploy)
  envKeys: string[];             // every setting the code reads
  healthRoute: boolean; healthPath: string;
  disk: string[];                // volumes and folders of the server mounted into the app (from the X-ray)
  sameServerDbs: string[];       // databases on the app's own server, which another server can't reach
  hasRedis: boolean;             // a Redis already in this environment
  deployed: boolean;
}
export interface FleetReadiness { serviceId: string; name: string; done: number; total: number; ready: boolean; checks: Check[] }

const has = (risks: string[], re: RegExp) => risks.find((r) => re.test(r));

export function readinessChecks(i: ReadyIn): Check[] {
  const checks: Check[] = [];
  const add = (key: string, label: string, ok: boolean, detail: string, fix?: Fix) => checks.push({ key, label, ok, detail, ...(!ok && fix && { fix }) });

  // 1. files written to the app's own disk: an upload on one server is missing on the others
  const uploads = has(i.scaleRisks, /upload/i);
  add('files', 'Files are kept off the server', !uploads && !i.disk.length,
    uploads ? `${i.name} saves uploads to its own disk, so a file uploaded on one server is missing on the others.`
      : i.disk.length ? `${i.name} writes to ${i.disk.slice(0, 2).join(' and ')} on its server, which the other servers can't see.` : 'Nothing is saved to the server’s own disk.',
    { ask: `Move ${i.name}'s uploaded files to Cloudflare R2 (free up to 10 GB) or S3, and set the storage settings so every server uses the same bucket`, label: 'Move uploads to R2' });

  // 2. a database that is a file
  const sqlite = has(i.scaleRisks, /sqlite/i);
  add('sqlite', 'The database isn’t a file', !sqlite, sqlite ? `${i.name} keeps its data in a SQLite file: each server would have its own copy.` : 'No SQLite file.',
    { ask: `Move ${i.name} from its SQLite file to a Postgres database every server can reach, and copy the data over`, label: 'Move to Postgres' });

  // 3. logins kept in memory (and live connections, and rate limits): a visitor sent to another server is signed out
  const sessions = has(i.scaleRisks, /session/i), sockets = has(i.scaleRisks, /websocket/i), limit = has(i.scaleRisks, /rate limit/i);
  const memory = sessions || sockets || limit;
  add('sessions', 'Logins work on every server', !memory,
    sessions ? `${i.name} keeps logins in memory, so a visitor sent to another server would be signed out.`
      : sockets ? `${i.name} uses live connections (websockets), which need Redis to reach people on the other servers.`
      : limit ? `${i.name}'s rate limit lives in memory, so each server would count on its own.` : 'Nothing is kept in one server’s memory.',
    i.hasRedis ? { ask: `Keep ${i.name}'s ${sessions ? 'logins (sessions)' : sockets ? 'live connections' : 'rate limit'} in the Redis this project already has (REDIS_URL)`, label: 'Use Redis for it' }
      : { tool: 'database.create', input: { environmentId: i.environmentId, engine: 'redis', name: `${i.name}-sessions`.slice(0, 60), injectInto: i.serviceId }, label: 'Add Redis' });

  // 4. scheduled jobs: Unit7 sets UNIT7_RUN_JOBS=0 on every server but the main one, and the code has to listen
  const cron = has(i.scaleRisks, /scheduled|cron/i);
  const listens = i.envKeys.includes('UNIT7_RUN_JOBS');
  add('jobs', 'Scheduled jobs run once', !cron || listens,
    !cron ? 'No scheduled jobs in the code.' : listens ? `They run on ${i.serverName} only.` : `${i.name}'s scheduled jobs would run once per server. Unit7 tells every server but ${i.serverName} not to (UNIT7_RUN_JOBS=0); the code has to check it.`,
    { ask: `Make ${i.name}'s scheduled jobs skip when the setting UNIT7_RUN_JOBS is "0" (Unit7 sets it on every server except the main one)`, label: 'Run jobs on one server' });

  // 5. a database on the app's own server: the other servers can't reach it (Unit7 never opens a database to the internet)
  add('database', 'Every server can reach the database', !i.sameServerDbs.length,
    i.sameServerDbs.length ? `${i.sameServerDbs.join(', ')} ${i.sameServerDbs.length === 1 ? 'runs' : 'run'} on ${i.serverName} and only answers there, so the other servers can't reach ${i.sameServerDbs.length === 1 ? 'it' : 'them'}.` : 'Nothing the app needs is tied to one server.',
    { ask: `Point every server of ${i.name} at one database they can all reach: move ${i.sameServerDbs.join(', ') || 'its database'} to a managed one (Neon or Supabase have free plans), copy the data, and connect it`, label: 'Point all servers at one database' });

  // 6. a real health page: the front proxy takes a sick server out within seconds only with one
  const health = i.healthPath !== '/' || i.healthRoute;
  add('health', 'It has a health page', health, health ? `Checked at ${i.healthPath === '/' ? 'its health route' : i.healthPath}.` : `Without one, a sick server is only noticed when visitors' requests fail.`,
    { ask: `Add a /health route to ${i.name} that answers 200 when the app and its database work, and 503 when they don't`, label: 'Add a health page' });
  return checks;
}

const DBS = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
export function fleetReadiness(db: DB, orgId: string, svc: ServiceRow): FleetReadiness {
  const cfg = json<ServiceConfig>(svc.config, {});
  const d = cfg.detection;
  const server = svc.server_id ? get<{ name: string }>(db, 'SELECT name FROM servers WHERE id = ?', svc.server_id) : undefined;
  const container = get<{ container: string | null }>(db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.container ?? undefined;
  // the app's own part in the server's X-ray: what it mounts from the server
  const parts = svc.server_id ? lastXray<Inventory>(db, orgId, svc.server_id)?.data?.parts ?? [] : [];
  const mine = container ? parts.find((p) => p.containers?.some((c) => c === container || c.startsWith(`${container}-r`)) || p.match?.includes(container)) : undefined;
  // ...and the files Unit7 keeps for it in volumes (src/deploy/volumes.ts), known before the next X-ray
  const disk = [...new Set([...(mine?.volumes ?? []), ...(mine?.binds ?? []), ...(cfg.volumes ?? []).map((v) => v.name)])].filter((v) => !/\.env$|^\/var\/run\/docker\.sock/.test(v));
  const dbs = all<{ name: string; kind: string; server_id: string | null }>(db, `SELECT name, kind, server_id FROM services WHERE environment_id = ? AND kind IN (${DBS.map(() => '?').join(', ')})`, svc.environment_id, ...DBS);
  const checks = readinessChecks({
    name: svc.name, serviceId: svc.id, environmentId: svc.environment_id, serverName: server?.name ?? 'its server',
    scaleRisks: d?.scaleRisks ?? [], envKeys: d?.envKeys ?? [], healthRoute: !!d?.healthRoute, healthPath: cfg.healthPath ?? d?.healthPath ?? '/',
    disk, sameServerDbs: dbs.filter((x) => x.server_id && x.server_id === svc.server_id).map((x) => x.name), hasRedis: dbs.some((x) => x.kind === 'redis'),
    deployed: !!svc.current_deployment_id,
  });
  const done = checks.filter((c) => c.ok).length;
  return { serviceId: svc.id, name: svc.name, done, total: checks.length, ready: done === checks.length, checks };
}
