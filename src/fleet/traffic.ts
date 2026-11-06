// Visitors across an app's servers. Two ways, picked from what's connected, and said in words:
//  · front proxy (the default): the main server's Caddy takes every visitor and passes each one to a healthy copy, its
//    own or one on another server over the private network (src/fleet/network.ts). On each other server a small Caddy
//    (the "edge", unit7-edge) listens only on that server's private address, one port per app, and hands requests to the
//    app's containers there. Caddy's own health checks skip a sick copy within seconds (caddy.ts's lb config).
//  · DNS: the app's domain gets one A record per server, and Unit7's health check (Warden, every minute) removes a sick
//    server's record and puts it back once it recovers. No single front server, but a change takes about a minute to reach
//    everyone. Cloudflare's Load Balancing does the same as a paid add-on: Unit7 only mentions it, never buys it.
// "Take out" (rotation out) drains a server: no new visitors, the ones in flight finish, then it's free for updates.
import type { App } from '../app.ts';
import { all, get, json, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script, safeName } from '../connectors/shell.ts';
import { replicaNames, containerName, routeService, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';
import type { Ctx, ToolResult } from '../tools/runtime.ts';
import { isTestHost } from '../care/readiness.ts';
import { fleetOf, planOf, setTarget, shares, targetsOf, type Target } from './model.ts';
import { netOf } from './network.ts';

// --- the edge on each other server ---------------------------------------------------------------------------------------
export const EDGE = 'unit7-edge';
export const EDGE_PORTS = [7001, 7032] as const; // ponytail: 32 fleet apps per organisation; widen the published range if needed
const EDGE_DIR = '/etc/unit7/edge';

export function renderEdge(entries: { port: number; upstreams: string[]; appPort: number }[]): string {
  const blocks = entries.map((e) => {
    if (!Number.isInteger(e.port) || e.port < EDGE_PORTS[0] || e.port > EDGE_PORTS[1]) throw new Unit7Error('bad_port', `Port ${e.port} isn't one of Unit7's private ports.`, 400);
    e.upstreams.forEach((u) => safeName(u, 'container name'));
    return `:${e.port} {\n\treverse_proxy ${e.upstreams.map((u) => `${u}:${Math.trunc(e.appPort)}`).join(' ')} {\n\t\tlb_policy least_conn\n\t\tlb_try_duration 5s\n\t}\n}\n`;
  });
  // the front proxy's X-Forwarded-For is trusted (it comes over the private network), so apps still see the visitor's address
  return `{\n\tadmin localhost:2019\n\tauto_https off\n\tservers {\n\t\ttrusted_proxies static 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16\n\t}\n}\n${blocks.join('\n')}`;
}

// what the edge on a server should hold: every fleet app placed there, at the version it runs there
export function edgeEntries(db: DB, serverId: string) {
  return all<{ id: string; slug: string; environment_id: string; config: string; deployment_id: string; edge_port: number }>(db, `SELECT s.id, s.slug, s.environment_id, s.config, t.deployment_id, f.edge_port FROM service_targets t
    JOIN services s ON s.id = t.service_id JOIN fleets f ON f.service_id = s.id AND f.mode = 'front' AND f.edge_port IS NOT NULL
    WHERE t.server_id = ? AND t.deployment_id IS NOT NULL AND coalesce(s.server_id, '') != ? ORDER BY f.edge_port`, serverId, serverId).flatMap((r) => {
    const n = get<{ number: number }>(db, 'SELECT number FROM deployments WHERE id = ?', r.deployment_id)?.number;
    if (n === undefined) return [];
    const cfg = json<ServiceConfig>(r.config, {});
    const primary = containerName(r as Pick<ServiceRow, 'slug' | 'environment_id'> as ServiceRow, n);
    const plan = planOf(db, r.deployment_id);
    return [{ port: r.edge_port, upstreams: [primary, ...replicaNames(primary, cfg.replicas)], appPort: plan.port ?? (cfg.detection?.builder === 'static' ? 80 : cfg.port ?? 3000) }];
  });
}

// the same pinned Caddy as the main proxy (CADDY_IMAGE in tools/servers.ts), so every server runs one known version
const EDGE_RUN = `ok=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$2" 2>/dev/null | grep -c "\\"$1\\"")
if [ "$ok" = 0 ]; then
  docker rm -f "$2" >/dev/null 2>&1
  docker run -d --name "$2" --restart unless-stopped --network unit7 -p "$1:$3-$4:$3-$4" -v "$5:/etc/caddy" --log-opt max-size=10m --log-opt max-file=3 caddy:2.11.7-alpine >/dev/null
fi`;
// the edge's config written aside, validated, then swapped in with a graceful reload (in-flight requests finish)
const EDGE_WRITE = `SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"
$SU mkdir -p "$1" && printf '%s' "$2" | $SU tee "$1/Caddyfile.next" >/dev/null
docker exec "$3" caddy validate --config /etc/caddy/Caddyfile.next --adapter caddyfile >/dev/null 2>&1 || { $SU rm -f "$1/Caddyfile.next"; echo "the new config didn't validate" >&2; exit 1; }
$SU mv -f "$1/Caddyfile.next" "$1/Caddyfile" && docker exec "$3" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null`;

// the edge on this server, listening on its private address only, with what it should hold now
export async function syncEdge(ctx: Pick<Ctx, 'app' | 'db'>, s: ServerRow) {
  const net = netOf(ctx.db, s.id);
  if (!net) throw new Unit7Error('no_private_network', `${s.name} isn't on the private network yet.`, 409);
  const body = renderEdge(edgeEntries(ctx.db, s.id));
  const pool = ssh(ctx.app);
  // first time: an empty config so the container starts
  await pool.check(s, script(`SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"; $SU mkdir -p "$1"; [ -f "$1/Caddyfile" ] || printf '%s' "$2" | $SU tee "$1/Caddyfile" >/dev/null`, EDGE_DIR, renderEdge([])), { what: 'Preparing the private entrance', timeoutMs: 20_000 });
  await pool.check(s, script(EDGE_RUN, net.address, EDGE, EDGE_PORTS[0], EDGE_PORTS[1], EDGE_DIR), { what: 'Starting the private entrance', timeoutMs: 180_000 });
  await pool.check(s, script(EDGE_WRITE, EDGE_DIR, body, EDGE), { what: 'Pointing the private entrance at the app', timeoutMs: 60_000 });
}

// requests still in flight to these containers, from Caddy's own count (admin API /reverse_proxy/upstreams)
export function inFlight(upstreamsJson: string, containers: string[]): number {
  let rows: { address?: string; num_requests?: number }[] = [];
  try { rows = JSON.parse(upstreamsJson); } catch { return 0; }
  return rows.filter((r) => containers.some((c) => r.address?.startsWith(`${c}:`))).reduce((n, r) => n + (r.num_requests ?? 0), 0);
}

// --- the front: re-point the main server's site (putSite adds the copies in rotation) -------------------------------------
export async function routeFront(ctx: Ctx, svc: ServiceRow) {
  if (!svc.server_id || !svc.current_deployment_id) return;
  const live = get<{ container: string | null }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id)?.container;
  if (!live) return;
  const main = get<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE id = ?', svc.server_id)!;
  const plan = planOf(ctx.db, svc.current_deployment_id);
  const cfg = json<ServiceConfig>(svc.config, {});
  await routeService(ctx, main, svc, live, replicaNames(live, cfg.replicas), undefined, plan.port ? { port: plan.port, healthPath: plan.healthPath ?? cfg.healthPath ?? cfg.detection?.healthPath ?? '/' } : undefined);
}

// --- DNS: one A record per server in rotation, on whichever DNS host Unit7 can edit --------------------------------------
export interface DnsHost { list(name: string): Promise<string[]>; add(name: string, ip: string): Promise<void>; remove(name: string, ip: string): Promise<void> }
export async function dnsFor(ctx: Ctx, hostname: string): Promise<DnsHost | undefined> {
  const { dnsHost } = await import('../connectors/dnsinfo.ts');
  const { EDITORS, DNS_ACCOUNT, SAME_SIGNIN } = await import('../connectors/dnswrite.ts');
  const { zone, host } = await dnsHost(hostname);
  const provider = host && (DNS_ACCOUNT[host] ?? host);
  const ed = provider ? EDITORS[provider] : undefined;
  if (!zone || !provider || !ed) return undefined;
  const kinds = SAME_SIGNIN[provider] ?? [provider];
  for (const { id } of all<{ id: string }>(ctx.db, `SELECT id FROM accounts WHERE org_id = ? AND provider IN (${kinds.map(() => '?').join(', ')})`, ctx.orgId, ...kinds)) {
    const ok = await ed.find(ctx, id, zone, { name: hostname, type: 'A' }).then(() => true, () => false);
    if (!ok) continue;
    return {
      list: async (name) => (await ed.find(ctx, id, zone, { name, type: 'A' })).map((r) => r.content),
      add: (name, ip) => ed.add(ctx, id, zone, { type: 'A', name, content: ip, ttl: 60 }),
      remove: async (name, ip) => { await ed.del(ctx, id, zone, { name, type: 'A', value: ip }); },
    };
  }
}
// Make each name's A records match the servers in rotation. Only the fleet's own addresses are ever touched, and the
// last record is never removed (a site with every server sick still answers somewhere rather than nowhere).
export async function dnsRotate(dns: DnsHost, names: string[], want: string[], fleetIps: string[]) {
  const added: string[] = [], removed: string[] = [];
  for (const name of names) {
    const have = await dns.list(name);
    for (const ip of want) if (!have.includes(ip)) { await dns.add(name, ip); added.push(`${name} ${ip}`); }
    const extra = have.filter((ip) => fleetIps.includes(ip) && !want.includes(ip));
    const left = have.length + want.filter((ip) => !have.includes(ip)).length;
    for (const ip of extra.slice(0, Math.max(0, left - 1))) { await dns.remove(name, ip); removed.push(`${name} ${ip}`); }
  }
  return { added, removed };
}

const ownNames = (db: DB, orgId: string, serviceId: string) => all<{ hostname: string }>(db, 'SELECT hostname FROM domains WHERE service_id = ? AND org_id = ?', serviceId, orgId).map((d) => d.hostname).filter((h) => !isTestHost(h));

// things tests swap for fakes (a DNS host, the health probe, the waits)
export const fleetDeps = {
  dns: dnsFor,
  probe: probeTarget,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  drainMs: 30_000,
};

export async function applyDns(ctx: Ctx, svc: ServiceRow) {
  const names = ownNames(ctx.db, ctx.orgId, svc.id);
  if (!names.length) return { added: [], removed: [] };
  const dns = await fleetDeps.dns(ctx, names[0]!);
  if (!dns) throw new Unit7Error('dns_unavailable', `Unit7 can't edit ${names[0]}'s DNS, so it can't spread visitors with DNS. Connect the account that runs it (Cloudflare is free), or keep the front proxy.`, 409);
  const { publicAddress } = await import('./network.ts');
  const ts = targetsOf(ctx.db, svc);
  const ip = async (t: Target) => publicAddress(get<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE id = ?', t.serverId)!);
  const fleetIps = await Promise.all(ts.map(ip));
  const want = (await Promise.all(ts.map(async (t) => (t.state === 'in' && t.deploymentId ? ip(t) : '')))).filter(Boolean);
  return dnsRotate(dns, names, want, fleetIps);
}

// --- in and out of rotation ----------------------------------------------------------------------------------------------
// out: no new visitors, the ones in flight finish (up to 30 seconds), then the server is free. in: back to taking visitors.
// state 'out' is a person's (maintenance), 'sick' is health's: Warden only ever puts back what health took out.
export async function rotate(ctx: Ctx, svc: ServiceRow, serverId: string, out: boolean, by: 'person' | 'health' = 'person') {
  const ts = targetsOf(ctx.db, svc);
  const t = ts.find((x) => x.serverId === serverId);
  if (!t) throw new Unit7Error('not_in_fleet', 'That server doesn’t run this app.', 404);
  const f = fleetOf(ctx.db, svc.id);
  const mode = f?.mode ?? 'front';
  if (out) {
    if (mode === 'front' && t.primary) throw new Unit7Error('front_server', `${t.name} is the front server: every visitor comes in through it, so it can’t be taken out. Take out another server, or spread visitors with DNS instead.`, 409);
    const left = ts.filter((x) => x.serverId !== serverId && x.state === 'in' && x.deploymentId);
    if (!left.length) throw new Unit7Error('last_server', `${t.name} is the only server taking visitors, so taking it out would take the app offline.`, 409);
  } else if (by === 'health' && t.state === 'out') return { server: t.name, state: t.state, changed: false }; // a person's maintenance stays
  else if (t.role === 'standby' && t.state === 'out') throw new Unit7Error('standby', `${t.name} keeps a warm copy of ${svc.name} for emergencies. To send visitors there, switch to the standby from the app’s page.`, 409);
  const state = out ? (by === 'health' ? 'sick' : 'out') : 'in';
  if (t.state === state) return { server: t.name, state, changed: false };
  const was = t.state;
  setTarget(ctx.db, ctx.orgId, svc.id, serverId, { state, role: t.primary ? 'primary' : 'replica' });
  try {
    if (mode === 'front') await routeFront(ctx, svc);
    else await applyDns(ctx, svc);
  } catch (e) { setTarget(ctx.db, ctx.orgId, svc.id, serverId, { state: was }); throw e; }
  let drained: number | undefined;
  if (out) drained = await drain(ctx, svc, t, mode);
  ctx.emit(out ? 'fleet.taken_out' : 'fleet.put_back', out ? `${t.name} no longer takes visitors for ${svc.name}${by === 'health' ? ' (it failed its health checks)' : ''}${drained !== undefined ? `; the last requests finished in ${drained} s` : ''}.` : `${t.name} takes visitors for ${svc.name} again.`,
    { severity: out && by === 'health' ? 'warning' : 'info', resource: svc.id, data: { serviceId: svc.id, serverId, state } });
  return { server: t.name, state, changed: true, ...(drained !== undefined && { drainedIn: drained }) };
}

// wait until the server's copies have nothing in flight (front: the edge's own count), at most drainMs
async function drain(ctx: Ctx, svc: ServiceRow, t: Target, mode: 'front' | 'dns') {
  const t0 = Date.now();
  if (mode === 'dns') { await fleetDeps.sleep(Math.min(fleetDeps.drainMs, 30_000)); return Math.round((Date.now() - t0) / 1000); } // ponytail: DNS has no count to read; resolvers forget the record within its 60 s TTL
  const s = get<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE id = ?', t.serverId)!;
  const n = t.number ?? 0;
  const primary = containerName(svc, n);
  const containers = [primary, ...replicaNames(primary, json<ServiceConfig>(svc.config, {}).replicas)];
  while (Date.now() - t0 < fleetDeps.drainMs) {
    const r = await ssh(ctx.app).exec(s, script('docker exec "$1" wget -qO- http://localhost:2019/reverse_proxy/upstreams 2>/dev/null', EDGE), { timeoutMs: 10_000 }).catch(() => ({ stdout: '[]' }));
    if (inFlight(r.stdout, containers) === 0) break;
    await fleetDeps.sleep(1000);
  }
  return Math.round((Date.now() - t0) / 1000);
}

// --- health, every minute (Warden) ---------------------------------------------------------------------------------------
// Is this server's copy answering? From the main server over the private network (front), or on the server through its
// own Caddy (DNS). What a server prints is only ever compared with a status code.
export async function probeTarget(ctx: Pick<Ctx, 'app' | 'db'>, svc: ServiceRow, t: Target): Promise<boolean> {
  const f = fleetOf(ctx.db, svc.id);
  const plan = planOf(ctx.db, t.deploymentId);
  const cfg = json<ServiceConfig>(svc.config, {});
  const path = (plan.healthPath ?? cfg.healthPath ?? cfg.detection?.healthPath ?? '/').replace(/[^\w/.-]/g, '') || '/';
  const ok = (out: string) => { const c = Number(out.trim().slice(-3)); return path === '/' ? c > 0 && c < 500 : c >= 200 && c < 400; };
  const s = get<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE id = ?', t.serverId)!;
  const main = svc.server_id ? get<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE id = ?', svc.server_id) : undefined;
  const pool = ssh(ctx.app);
  if ((f?.mode ?? 'front') === 'front' && t.role !== 'standby') { // a standby answers on its own proxy: asked like DNS below
    if (t.primary || !main) {
      const name = containerName(svc, t.number ?? 0);
      return (await pool.exec(s, script('docker inspect -f "{{.State.Running}}" "$1" 2>/dev/null', name), { timeoutMs: 15_000 })).stdout.trim() === 'true';
    }
    if (!t.address || !f?.edge_port) return false;
    return ok((await pool.exec(main, script('curl -s -o /dev/null -w "%{http_code}" --max-time 4 "http://$1:$2$3" 2>/dev/null || echo 000', t.address, f.edge_port, path), { timeoutMs: 15_000 })).stdout);
  }
  const name = ownNames(ctx.db, svc.org_id, svc.id)[0];
  if (!name && t.role === 'standby') return (await pool.exec(s, script('docker inspect -f "{{.State.Running}}" "$1" 2>/dev/null', containerName(svc, t.number ?? 0)), { timeoutMs: 15_000 })).stdout.trim() === 'true';
  if (!name) return false;
  return ok((await pool.exec(s, script('curl -sk -o /dev/null -w "%{http_code}" --max-time 4 --resolve "$1:443:127.0.0.1" "https://$1$2" 2>/dev/null || echo 000', name, path), { timeoutMs: 15_000 })).stdout);
}

// two looks in a row decide: out after 2 failed, back after 2 good. Front: Caddy already skips a sick copy, so Unit7 only
// records it (and says so once). DNS: Warden takes the record out and puts it back, through the gate.
const streaks = new Map<string, { ok: boolean; n: number }>();
const certsCopied = new Map<string, number>(); // D4: per app, the last daily copy of the main server's certificate (DNS, standby)
export async function fleetTick(app: App, act: (orgId: string, tool: string, input: unknown, reason: string) => Promise<ToolResult>) {
  const { fleetServices } = await import('./model.ts');
  for (const o of all<{ id: string }>(app.db, 'SELECT DISTINCT org_id id FROM service_targets')) {
    for (const svc of fleetServices(app.db, o.id)) {
      const f = fleetOf(app.db, svc.id);
      // the main server renews its certificate; once a day the others (with DNS) and a standby get the newest one
      if (svc.server_id && Date.now() - (certsCopied.get(svc.id) ?? 0) > 86400_000) {
        certsCopied.set(svc.id, Date.now());
        const { copyCerts } = await import('./care.ts');
        const main = get<ServerRow>(app.db, 'SELECT * FROM servers WHERE id = ?', svc.server_id);
        const names = all<{ hostname: string }>(app.db, 'SELECT hostname FROM domains WHERE service_id = ?', svc.id).map((d) => d.hostname);
        for (const t of targetsOf(app.db, svc)) {
          if (t.primary || !main || !t.deploymentId || (f?.mode !== 'dns' && t.role !== 'standby')) continue;
          const s = get<ServerRow>(app.db, 'SELECT * FROM servers WHERE id = ?', t.serverId);
          if (s) await copyCerts({ app }, main, s, names).catch(() => undefined);
        }
      }
      for (const t of targetsOf(app.db, svc)) {
        if (!t.deploymentId || t.status !== 'ready') continue;
        const healthy = await fleetDeps.probe({ app, db: app.db }, svc, t).catch(() => false);
        const key = `${svc.id}:${t.serverId}`, prev = streaks.get(key);
        const s = prev && prev.ok === healthy ? { ok: healthy, n: prev.n + 1 } : { ok: healthy, n: 1 };
        streaks.set(key, s);
        if (s.n < 2) continue;
        const was = t.health;
        setTarget(app.db, o.id, svc.id, t.serverId, { health: healthy ? 'ok' : 'bad' });
        if (was !== (healthy ? 'ok' : 'bad') && was !== null) app.events.emit(o.id, healthy ? 'fleet.healthy' : 'fleet.unhealthy', healthy ? `${svc.name} answers on ${t.name} again.` : t.role === 'standby' ? `The standby copy of ${svc.name} on ${t.name} doesn't answer, so it couldn't take over right now.` : `${svc.name} doesn't answer on ${t.name}.${f?.mode === 'dns' ? ' Unit7 takes it out of rotation.' : ' The front proxy skips it until it recovers.'}`, { severity: healthy ? 'success' : 'warning', resource: svc.id, data: { serviceId: svc.id, serverId: t.serverId } });
        if (f?.mode !== 'dns') continue;
        if (!healthy && t.state === 'in') await act(o.id, 'fleet.rotate', { serviceId: svc.id, serverId: t.serverId, out: true }, `${t.name} failed two health checks in a row`);
        if (healthy && t.state === 'sick') await act(o.id, 'fleet.rotate', { serviceId: svc.id, serverId: t.serverId, out: false }, `${t.name} passed two health checks in a row`);
      }
    }
  }
}

// --- what fleet.traffic shows ---------------------------------------------------------------------------------------------
export function trafficView(db: DB, svc: ServiceRow) {
  const ts = targetsOf(db, svc);
  const f = fleetOf(db, svc.id);
  const share = shares(ts);
  return {
    serviceId: svc.id, name: svc.name, mode: f?.mode ?? (ts.length > 1 ? 'front' : 'single'), why: f?.why ?? null,
    servers: ts.map((t) => ({ serverId: t.serverId, name: t.name, primary: t.primary, role: t.role, state: t.state, health: t.health, checkedAt: t.checkedAt, share: share[t.serverId] ?? 0, version: t.number })),
  };
}

// --- a server restarting (reboot windows, tools/reboot.ts): out of every app's rotation first, back afterwards ----------
// Only where it isn't the front server (that one carries every visitor of its apps) and others keep serving.
export async function leaveRotation(ctx: Ctx, serverId: string): Promise<string[]> {
  const { execute } = await import('../tools/runtime.ts');
  const out: string[] = [];
  for (const r of all<{ service_id: string }>(ctx.db, `SELECT service_id FROM service_targets WHERE server_id = ? AND org_id = ? AND state = 'in' AND deployment_id IS NOT NULL`, serverId, ctx.orgId)) {
    const x = await execute(ctx.app, ctx.orgId, ctx.actor, 'fleet.rotate', { serviceId: r.service_id, serverId, out: true }, { reason: 'the server restarts for its updates', signal: ctx.signal, ...(ctx.approvalId && { underApproval: ctx.approvalId }) });
    if (x.status === 'ok' && (x.output as { changed?: boolean }).changed) out.push(r.service_id);
  }
  if (out.length) ctx.progress(`Took it out of rotation for ${out.length} app${out.length === 1 ? '' : 's'}: the other servers serve while it restarts.`);
  return out;
}
export async function rejoinRotation(ctx: Ctx, serverId: string, serviceIds: string[]) {
  const { execute } = await import('../tools/runtime.ts');
  for (const id of serviceIds) await execute(ctx.app, ctx.orgId, ctx.actor, 'fleet.rotate', { serviceId: id, serverId, out: false }, { reason: 'the server is back from its restart', signal: ctx.signal, ...(ctx.approvalId && { underApproval: ctx.approvalId }) });
}
