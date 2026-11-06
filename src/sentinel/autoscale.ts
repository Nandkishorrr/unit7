// Autoscaling for apps on your servers: more copies when responses get slow or the server is busy (one
// copy for a busy server, more only while responses stay slow), fewer when it's been calm for a while. Within the min and max you set, never for apps that can't run
// as several copies, and never twice in quick succession (no flapping).
import type { App } from '../app.ts';
import { all, get, json } from '../db.ts';
import type { ServiceConfig } from '../deploy/deployer.ts';

export interface Autoscale { on: boolean; min: number; max: number; lastChange?: string; lastWhy?: string }
export interface Load { p95?: number; cpu?: number; requests: number }

const SLOW = 800, BUSY = 75, FAST = 300, CALM = 30;

// The decision on its own, so it can be tested: the number of copies to run now, and why
export function decide(replicas: number, a: Autoscale, recent: Load, calmWindow: Load, nowMs = Date.now()): { replicas: number; why: string } {
  const since = a.lastChange ? (nowMs - Date.parse(a.lastChange)) / 60_000 : Infinity;
  if (replicas < a.min) return { replicas: a.min, why: `the minimum is ${a.min}` };
  if (replicas > a.max) return { replicas: a.max, why: `the maximum is ${a.max}` };
  const slow = recent.requests >= 10 && (recent.p95 ?? 0) >= SLOW, busy = (recent.cpu ?? 0) >= BUSY;
  // CPU is the whole server's (other apps count too): if the last copy added for it didn't calm the server,
  // another won't either, so only slow responses add more
  const cpuDidntHelp = !slow && busy && !!a.lastWhy?.includes('the server is busy');
  if ((slow || busy) && !cpuDidntHelp && replicas < a.max && since >= 5) return { replicas: replicas + 1, why: slow ? `responses are slow (p95 ${recent.p95} ms)` : `the server is busy (CPU ${Math.round(recent.cpu!)}%)` };
  // calm over the last 30 minutes, and not slow or busy right now
  const calm = !slow && !busy && (calmWindow.requests < 10 || (calmWindow.p95 ?? 0) < FAST) && (calmWindow.cpu ?? 0) < CALM;
  if (calm && replicas > a.min && since >= 15) return { replicas: replicas - 1, why: 'calm for 30 minutes' };
  return { replicas, why: 'steady' };
}

// Load on a service over the last few minutes: its sites' response times (weighted by traffic) and its server's CPU
export function load(app: App, serviceId: string, serverId: string, minutes: number): Load {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const hosts = all<{ hostname: string }>(app.db, 'SELECT hostname FROM domains WHERE service_id = ?', serviceId).map((d) => d.hostname);
  const t = hosts.length ? get<{ requests: number | null; weighted: number | null }>(app.db,
    `SELECT sum(requests) requests, sum(p95_ms * requests) weighted FROM traffic WHERE server_id = ? AND at > ? AND hostname IN (${hosts.map(() => '?').join(',')})`, serverId, since, ...hosts) : undefined;
  const c = get<{ cpu: number | null }>(app.db, 'SELECT avg(cpu) cpu FROM metrics WHERE server_id = ? AND at > ?', serverId, since);
  const requests = t?.requests ?? 0;
  return { requests, p95: requests ? Math.round((t!.weighted ?? 0) / requests) : undefined, cpu: c?.cpu ?? undefined };
}

// The services Warden looks after, and what each needs now
export function plans(app: App) {
  return all<{ id: string; org_id: string; name: string; server_id: string; config: string }>(app.db,
    `SELECT id, org_id, name, server_id, config FROM services WHERE server_id IS NOT NULL AND current_deployment_id IS NOT NULL AND json_extract(config, '$.autoscale.on') = 1`)
    .map((s) => {
      const cfg = json<ServiceConfig & { autoscale: Autoscale }>(s.config, {} as never);
      const d = decide(cfg.replicas ?? 1, cfg.autoscale, load(app, s.id, s.server_id, 5), load(app, s.id, s.server_id, 30));
      return { serviceId: s.id, orgId: s.org_id, name: s.name, from: cfg.replicas ?? 1, ...d };
    }).filter((p) => p.replicas !== p.from);
}
