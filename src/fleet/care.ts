// Fleet care: the same settings on every server (and a warning when they drift), one HTTPS certificate for a name on
// every server, OS restarts one server at a time, and "Add a server to shop" with a server bought by a person.
//  · Settings: each server's copy runs with an env file Unit7 wrote at its deploy. Unit7 compares a fingerprint of each
//    (sha256 of its sorted lines, worked out on the server: the values never leave it) with what it would write now.
//    Bringing them together: a server behind is taken out of rotation, its copies restart with the current settings, are
//    checked and go back in, one at a time; the main server takes a normal release (it rolls out to the rest).
//  · Certificates: with a front proxy the main server holds the only one visitors ever see. With DNS (and for a standby)
//    Unit7 copies the main server's certificate into the other servers' proxies, which then use it instead of asking
//    Let's Encrypt themselves (a challenge sent to "any server of the name" can't be answered reliably).
//  · Restarts (tools/reboot.ts): one server of an organisation at a time, each out of rotation first; Warden also waits
//    while this server is the only one left serving one of its apps.
//  · Buying: a person's own purchase (provider_purchase, people-only), then Unit7 connects, prepares and adds the server.
import { createHash } from 'node:crypto';
import { all, get, json, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { listening, ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { call } from '../connectors/cloudcli.ts';
import { assertHostname } from '../deploy/caddy.ts';
import { APPS, containerName, healthCheck, replicaNames, startContainer, stayUp, type ServiceConfig, type ServiceRow } from '../deploy/deployer.ts';
import { resolveValues } from '../tools/env.ts';
import { execute, type Ctx } from '../tools/runtime.ts';
import type { Facts } from '../tools/servers.ts';
import { planOf, targetsOf, type Target } from './model.ts';
import { envFor } from './rolling.ts';

// --- settings drift --------------------------------------------------------------------------------------------------
// the fingerprint: sorted KEY=value lines, so the order Unit7 lists them in never counts as a change
export const envPrint = (env: Record<string, string>) => createHash('sha256').update(Object.entries(env).map(([k, v]) => `${k}=${v}`).sort().join('\n') + '\n').digest('hex');
export const ENV_PRINT = 'f="$1"; [ -f "$f" ] || { echo missing; exit 0; }; SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"; $SU cat "$f" | grep -v "^$" | LC_ALL=C sort | sha256sum | cut -c1-64';

export interface EnvLook { serverId: string; name: string; want: string; have: string | null }
// who runs with other settings than Unit7 would give them now; a server Unit7 couldn't read counts as unknown, never same
export function envDrift(rows: EnvLook[]) {
  const differs = rows.filter((r) => r.have && r.have !== r.want), unknown = rows.filter((r) => !r.have);
  return {
    same: !differs.length && !unknown.length, differs: differs.map((r) => r.serverId), unknown: unknown.map((r) => r.serverId),
    words: differs.length ? `${differs.map((r) => r.name).join(', ')} ${differs.length === 1 ? 'runs' : 'run'} with older settings` : unknown.length ? `Couldn’t read the settings on ${unknown.map((r) => r.name).join(', ')}` : undefined,
  };
}
// what the copy on this server should run with: the main server's is the deploy's own (PORT set); the others' add
// UNIT7_RUN_JOBS=0 (rolling.ts envFor)
export function wantEnv(ctx: Ctx, svc: ServiceRow, t: Pick<Target, 'primary' | 'deploymentId'>) {
  const cfg = json<ServiceConfig>(svc.config, {});
  const port = planOf(ctx.db, t.deploymentId).port ?? (cfg.detection?.builder === 'static' ? 80 : cfg.port ?? 3000);
  if (!t.primary) return envFor(ctx, svc, port);
  const env = resolveValues(ctx, svc.id);
  env.PORT ??= String(port);
  return env;
}
export async function readEnvDrift(ctx: Ctx, svc: ServiceRow) {
  const rows: EnvLook[] = [];
  for (const t of targetsOf(ctx.db, svc)) {
    if (t.number === null || !t.deploymentId) continue;
    const s = get<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE id = ?', t.serverId)!;
    const out = await ssh(ctx.app).exec(s, script(ENV_PRINT, `${APPS}/${containerName(svc, t.number)}.env`), { timeoutMs: 15_000 }).catch(() => null);
    const have = out && /^[0-9a-f]{64}$/.test(out.stdout.trim()) ? out.stdout.trim() : null;
    rows.push({ serverId: t.serverId, name: t.name, want: envPrint(wantEnv(ctx, svc, t)), have });
  }
  return envDrift(rows);
}

// One server (not the main one) back on the current settings without visitors noticing: out of rotation (in-flight
// requests finish), its copies restart with the settings written fresh, checked, then back in. Through fleet.rotate.
export async function refreshServer(ctx: Ctx, svc: ServiceRow, serverId: string) {
  const t = targetsOf(ctx.db, svc).find((x) => x.serverId === serverId);
  if (!t || t.primary) throw new Unit7Error('main_server', 'The main server takes its settings with a normal release.', 409);
  if (t.number === null || !t.deploymentId) throw new Unit7Error('not_running', `${svc.name} isn’t running on ${t.name} yet.`, 409);
  const s = get<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE id = ?', serverId)!;
  const dep = get<{ image: string | null }>(ctx.db, 'SELECT image FROM deployments WHERE id = ?', t.deploymentId);
  if (!dep?.image) throw new Unit7Error('no_image', `Unit7 doesn’t know the image of v${t.number}.`, 409);
  const cfg = json<ServiceConfig>(svc.config, {});
  const plan = planOf(ctx.db, t.deploymentId);
  const port = plan.port ?? cfg.port ?? 3000, path = plan.healthPath ?? cfg.healthPath ?? cfg.detection?.healthPath ?? '/';
  const wasIn = t.state === 'in' && t.role !== 'standby';
  const rotate = async (out: boolean) => {
    const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'fleet.rotate', { serviceId: svc.id, serverId, out }, { reason: 'new settings for this server', signal: ctx.signal, ...(ctx.approvalId && { underApproval: ctx.approvalId }) });
    if (r.status !== 'ok') throw new Unit7Error('rotate_failed', r.status === 'error' ? r.error.message : `Taking ${t.name} out waits for a person (${'why' in r ? r.why : r.status}).`, 409);
  };
  if (wasIn) await rotate(true);
  const name = containerName(svc, t.number);
  // a copy that fails stays out of rotation on purpose: the others carry on until a person looks
  for (const c of [name, ...(svc.kind === 'worker' ? [] : replicaNames(name, cfg.replicas))]) {
    await startContainer(ctx, s, c, dep.image, { ...cfg, port }, wantEnv(ctx, svc, t), svc);
    const h = svc.kind === 'worker' ? await stayUp(ctx, s, c, () => undefined) : await healthCheck(ctx, s, c, port, path, () => undefined);
    if (!h.healthy) throw new Unit7Error('unhealthy', `${svc.name} didn’t pass its health check on ${t.name} with the new settings: ${h.detail.split('\n')[0]}. It stays out of rotation, so visitors don’t see it.`, 502);
  }
  if (wasIn) await rotate(false);
  return { server: t.name, restarted: true };
}

// --- certificates ----------------------------------------------------------------------------------------------------
export function certPlan(o: { mode: 'single' | 'front' | 'dns'; cloudflare: boolean; dnsPlugin: boolean; standby?: boolean }) {
  if (o.mode !== 'dns' && !o.standby) return { shared: true, how: 'front', words: 'Visitors only ever reach the front server, so its one certificate covers every server.' };
  if (o.cloudflare && o.dnsPlugin) return { shared: true, how: 'dns-check', words: 'Every server can prove the name through Cloudflare’s DNS, so each gets the same certificate on its own.' };
  return { shared: true, how: 'copy', words: `Unit7 copies the main server’s certificate to ${o.standby ? 'the standby' : 'the other servers'} after each renewal, so ${o.standby ? 'it shows' : 'they all show'} the same one.${o.cloudflare ? '' : ' Connecting Cloudflare (free) lets every server prove the name itself.'}` };
}
const CERTS = '/data/caddy/certificates';
// does this server's proxy have the Cloudflare DNS module (a custom Caddy build)? Unit7's own image doesn't.
export async function hasDnsPlugin(ctx: Pick<Ctx, 'app'>, s: ServerRow) {
  const r = await ssh(ctx.app).exec(s, script('docker exec unit7-caddy caddy list-modules 2>/dev/null | grep -c "^dns.providers.cloudflare"'), { timeoutMs: 20_000 }).catch(() => null);
  return Number(r?.stdout.trim()) > 0;
}
// the main server's certificate for these names into another server's proxy, then a reload there so it's used
export async function copyCerts(ctx: Pick<Ctx, 'app'>, from: ServerRow, to: ServerRow, hostnames: string[]) {
  const names = hostnames.filter((h) => { try { assertHostname(h); return true; } catch { return false; } });
  if (!names.length) return { copied: 0 };
  const list = `docker exec unit7-caddy ${script(`cd ${CERTS} 2>/dev/null || exit 0; for h in "$@"; do for d in */"$h"; do [ -d "$d" ] && echo "$d"; done; done; true`, ...names)}`;
  const have = (await ssh(ctx.app).exec(from, list, { timeoutMs: 20_000 }).catch(() => ({ stdout: '' }))).stdout
    .split('\n').map((x) => x.trim()).filter((x) => /^[\w.-]+\/[a-z0-9.-]+$/i.test(x));
  if (!have.length) return { copied: 0 };
  // the key travels through Unit7's own connection (never written to this computer) and lands only in the proxy's storage
  await ssh(ctx.app).relay(from, script(`docker exec unit7-caddy tar -cz -C ${CERTS} "$@"`, ...have), to, script(`docker exec -i unit7-caddy sh -c 'mkdir -p ${CERTS} && tar -xz -C ${CERTS}'`), { timeoutMs: 120_000 });
  await ssh(ctx.app).exec(to, script('docker exec unit7-caddy caddy reload --config /etc/caddy/Caddyfile --force >/dev/null 2>&1; true'), { timeoutMs: 30_000 }).catch(() => undefined);
  return { copied: have.length };
}

// --- restarts --------------------------------------------------------------------------------------------------------
// the apps this server is the last one serving, when they run on more servers (their partner is out or sick): a
// scheduled restart waits rather than take them down
export function restartWouldDown(db: DB, serverId: string): string[] {
  const out: string[] = [];
  for (const r of all<{ service_id: string; name: string }>(db, `SELECT t.service_id, s.name FROM service_targets t JOIN services s ON s.id = t.service_id WHERE t.server_id = ? AND t.state = 'in' AND t.deployment_id IS NOT NULL`, serverId)) {
    const others = all<{ n: number }>(db, `SELECT 1 n FROM service_targets WHERE service_id = ? AND server_id != ? AND role != 'standby'`, r.service_id, serverId).length;
    const serving = all<{ n: number }>(db, `SELECT 1 n FROM service_targets WHERE service_id = ? AND server_id != ? AND state = 'in' AND deployment_id IS NOT NULL AND coalesce(health, 'ok') != 'bad'`, r.service_id, serverId).length;
    if (others > 0 && serving === 0) out.push(r.name);
  }
  return out;
}

// --- a new server, bought by a person ----------------------------------------------------------------------------------
const HZ = () => process.env.UNIT7_HETZNER_API ?? 'https://api.hetzner.cloud/v1';
const hz = <T = any>(ctx: Ctx, acc: string, path: string, body?: unknown, method?: string) => call<T>('Hetzner', `${HZ()}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), ...(body !== undefined && { body }), headers: { authorization: `Bearer ${ctx.credentialFor('hetzner', acc).value.trim()}` } });
export interface Offer { provider: 'hetzner' | 'hostinger'; accountId: string; plan: string; label: string; cores: number; memoryGb: number; diskGb: number; monthly: number | null; currency: string; location: string; where: string; itemId?: string; templateId?: number; dataCenterId?: number }
const archOf = (f: Facts) => (/arm|aarch/i.test(f.arch ?? '') ? 'arm' : 'x86');
// the cheapest plans at least as big as the main server, on the same kind of processor (the image has to run there)
export function pickPlans<T extends { cores: number; memoryGb: number; monthly: number | null; arch?: string }>(plans: T[], main: { cores: number; memoryGb: number; arch: string }, n = 3): T[] {
  const fits = plans.filter((p) => (p.arch ?? 'x86') === main.arch && p.cores >= main.cores && p.memoryGb + 0.25 >= main.memoryGb);
  return (fits.length ? fits : plans.filter((p) => (p.arch ?? 'x86') === main.arch)).sort((a, b) => (a.monthly ?? 1e9) - (b.monthly ?? 1e9)).slice(0, n);
}
export async function hetznerOffers(ctx: Ctx, accountId: string, main: Facts): Promise<Offer[]> {
  const [types, locs] = await Promise.all([hz<{ server_types: any[] }>(ctx, accountId, '/server_types?per_page=50'), hz<{ locations: any[] }>(ctx, accountId, '/locations')]);
  const where = new Map((locs.locations ?? []).map((l) => [String(l.name), `${l.city}, ${l.country}`]));
  const plans = (types.server_types ?? []).filter((t) => !t.deprecation && !t.deprecated).flatMap((t) => (t.prices ?? []).map((p: any) => ({
    provider: 'hetzner' as const, accountId, plan: String(t.name), label: `${String(t.name).toUpperCase()} · ${t.cores} CPU, ${t.memory} GB`, cores: Number(t.cores), memoryGb: Number(t.memory), diskGb: Number(t.disk),
    monthly: Number(p.price_monthly?.gross) || null, currency: 'EUR', location: String(p.location), where: where.get(String(p.location)) ?? String(p.location), arch: t.architecture === 'arm' ? 'arm' : 'x86',
  })));
  return pickPlans(plans, { cores: main.cpus ?? 1, memoryGb: (main.mem_total ?? 0) / 1024 ** 3, arch: archOf(main) }, 4).map(({ arch: _a, ...o }) => o);
}

export const buyDeps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), listening, pollMs: 5000, waitMs: 6 * 60_000 };
async function until<T>(f: () => Promise<T | undefined>, ms = buyDeps.waitMs): Promise<T | undefined> {
  for (const end = Date.now() + ms; ;) {
    const v = await f().catch(() => undefined);
    if (v !== undefined || Date.now() >= end) return v;
    await buyDeps.sleep(buyDeps.pollMs);
  }
}

// Hetzner: Unit7's key goes in at creation, so the server is reachable the moment it boots
export async function buyHetzner(ctx: Ctx, o: { accountId: string; plan: string; location: string; name: string; publicKey: string }) {
  const key = await hz<{ ssh_key: { id: number } }>(ctx, o.accountId, '/ssh_keys', { name: `${o.name}-unit7`, public_key: o.publicKey });
  const made = await hz<{ server: { id: number; public_net?: { ipv4?: { ip?: string } } } }>(ctx, o.accountId, '/servers',
    { name: o.name, server_type: o.plan, image: 'ubuntu-24.04', location: o.location, ssh_keys: [key.ssh_key.id], labels: { 'managed-by': 'unit7' }, start_after_create: true });
  const id = made.server.id;
  const ip = await until(async () => {
    const s = (await hz<{ server: { status: string; public_net?: { ipv4?: { ip?: string } } } }>(ctx, o.accountId, `/servers/${id}`)).server;
    return s.status === 'running' && s.public_net?.ipv4?.ip ? s.public_net.ipv4.ip : undefined;
  });
  if (!ip) throw new Unit7Error('server_slow', `Hetzner made the server (${o.name}) but it isn’t running yet. It shows in your Hetzner project; connect it from Servers once it’s up.`, 504);
  return { providerRef: `hetzner:server:${id}`, host: ip };
}

// Hostinger: its own purchase operation (found by Hostinger's search, like every Hostinger call), with Unit7's key in
// the setup so the VPS is reachable once it's installed
export async function buyHostinger(ctx: Ctx, o: { accountId: string; itemId: string; templateId: number; dataCenterId: number; name: string; publicKey: string }) {
  const { hostinger } = await import('../connectors/hostinger.ts');
  const { listVps } = await import('../tools/hostinger.ts');
  const found = JSON.parse(await hostinger(ctx.app).call(ctx, o.accountId, 'search', { query: 'purchase new virtual machine', limit: 10 })) as { operation: string }[];
  const op = found.find((x) => /purchase/i.test(x.operation) && /vps|virtual/i.test(x.operation))?.operation;
  if (!op) throw new Unit7Error('hostinger_operation', 'Hostinger has no operation to buy a VPS right now. Buy it in Hostinger, then add it from Servers.', 502);
  const before = new Set((await listVps(ctx, o.accountId, true)).map((v) => v.id));
  await hostinger(ctx.app).call(ctx, o.accountId, 'execute', { operation: op, params: { item_id: o.itemId, setup: { template_id: o.templateId, data_center_id: o.dataCenterId, hostname: o.name, public_key: { name: `${o.name}-unit7`, key: o.publicKey } } } }, 5 * 60_000);
  const vm = await until(async () => (await listVps(ctx, o.accountId, true)).find((v) => !before.has(v.id) && v.ip && /running/i.test(v.state)));
  if (!vm) throw new Unit7Error('server_slow', 'Hostinger took the order but the VPS isn’t running yet. Add it from Servers once it’s up.', 504);
  return { providerRef: `hostinger:vm:${vm.id}`, host: vm.ip! };
}

// Buying is one job, for an app's next server or a very first one: bought with Unit7's own key in it, then connected, and a
// fresh box prepares itself. Bought but not reachable yet says so: the money is spent, and the server is there to connect.
export interface Purchase { provider: 'hetzner' | 'hostinger'; accountId: string; plan?: string; location?: string; item?: string; templateId?: number; dataCenterId?: number }
export async function buyAndConnect(ctx: Ctx, i: Purchase, o: { name: string; forWhat?: string; resource?: string; data?: Record<string, unknown> }) {
  const { generateKeyPair, preparing } = await import('../tools/servers.ts');
  const { privateKey, publicKey } = await generateKeyPair(`unit7@${o.name}`);
  ctx.redactor.add(privateKey, 'the new server’s key');
  ctx.progress(`Buying ${o.name}…`);
  const bought = i.provider === 'hetzner'
    ? await buyHetzner(ctx, { accountId: i.accountId, plan: i.plan ?? 'cx22', location: i.location ?? 'nbg1', name: o.name, publicKey })
    : await buyHostinger(ctx, { accountId: i.accountId, itemId: i.item ?? '', templateId: i.templateId ?? 0, dataCenterId: i.dataCenterId ?? 0, name: o.name, publicKey });
  const why = o.forWhat ? ` for ${o.forWhat}` : '';
  ctx.emit('server.bought', `${ctx.actor.name} bought ${o.name} (${i.provider === 'hetzner' ? 'Hetzner' : 'Hostinger'})${why}.`, { severity: 'success', resource: o.resource, data: { ...o.data, provider: i.provider } });
  ctx.progress(`Waiting for ${o.name} to accept Unit7’s key…`);
  for (const end = Date.now() + buyDeps.waitMs; !(await buyDeps.listening(bought.host, 22, 3000)) && Date.now() < end;) await buyDeps.sleep(buyDeps.pollMs);
  const c = await execute(ctx.app, ctx.orgId, ctx.actor, 'server.connect', { name: o.name, host: bought.host, privateKey, accountId: i.accountId, providerRef: bought.providerRef }, { reason: `the server bought${why}` });
  if (c.status !== 'ok') return { host: bought.host, why: `It’s bought but Unit7 couldn’t connect yet: ${c.status === 'error' ? c.error.message : 'why' in c ? c.why : c.status}. Connect it from Servers.` };
  const serverId = (c.output as { serverId: string }).serverId;
  await preparing.get(serverId); // the fresh box is prepared once, not twice
  return { host: bought.host, serverId };
}

// what the main server is, for the offers (and the name of the new one)
export function mainFacts(db: DB, svc: ServiceRow): Facts {
  return json<Facts>(get<{ facts: string }>(db, 'SELECT facts FROM servers WHERE id = ?', svc.server_id ?? '')?.facts, {});
}
export const newServerName = (svc: Pick<ServiceRow, 'slug'>, n: number) => `${svc.slug}-${n + 1}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
export const usableAccount = (db: DB, orgId: string, provider: string) => all<{ id: string; name: string }>(db, `SELECT id, name FROM accounts WHERE org_id = ? AND provider = ? AND status != 'failing'`, orgId, provider);
