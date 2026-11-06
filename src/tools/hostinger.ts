// Hostinger tools. Thin, safe wrappers over the official MCP server (connectors/hostinger.ts).
// `hostinger.do` is the general path: Unit7 looks up the operation's verb to set the risk, so a
// `purchase` or `recreate` goes through the approval gate while a `list` is a plain read. Curated
// shortcuts cover the common VPS/DNS jobs so the agent (and the UI) don't have to know operation ids.
import { z } from 'zod';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { get } from '../db.ts';
import { Unit7Error, forbidden } from '../errors.ts';
import { hostinger, hostingerRisk } from '../connectors/hostinger.ts';
import { keyCommand } from '../connectors/ssh.ts';
import { serverRow } from './servers.ts';
import { verifiers } from './core.ts';
import { fid } from './helpers.ts';
import { MONEY_OP } from '../policy.ts';
import { databaseOn, portRisk } from '../secure/ports.ts';
import { lastXray } from './xray.ts';
import type { ServerRow } from '../connectors/ssh.ts';

// an operation that buys, pays, renews or cancels: people-only for an AI (MONEY_OP); a person's write is a provider_purchase
const money = (op: string) => MONEY_OP.test(op);
const moneyWrite = (op: string) => money(op) && hostingerRisk(op) !== 'read';

// Prove a Hostinger token works and learn the account: list VPS + domains.
verifiers.hostinger = async (ctx, account, _token) => {
  if (JSON.parse(account.meta || '{}').auth === 'oauth') return { connected: 'one-click sign-in', checkedAt: new Date().toISOString() };
  const out = await hostinger(ctx.app).call(ctx, account.id, 'execute', { operation: 'vps_virtual-machines_list', params: {} }, 60_000); // a refused token must fail the check
  let vms = 0;
  try { const parsed = JSON.parse(out); vms = Array.isArray(parsed) ? parsed.length : (parsed?.data?.length ?? 0); } catch { /* text form */ }
  return { vps: vms, checkedAt: new Date().toISOString() };
};

function account(ctx: Ctx, accountId?: string): string {
  if (accountId) return accountId;
  if (ctx.env) {
    const a = get<{ account_id: string }>(ctx.db, `SELECT account_id FROM environment_accounts WHERE environment_id = ? AND provider = 'hostinger'`, ctx.env.id);
    if (a) return a.account_id;
  }
  const only = get<{ id: string; n: number }>(ctx.db, `SELECT min(id) id, count(*) n FROM accounts WHERE org_id = ? AND provider = 'hostinger'`, ctx.orgId);
  if (only?.n === 1) return only.id;
  throw new Unit7Error('which_account', 'Which Hostinger account? Pass accountId, or bind one to this environment.');
}

defineTool({
  name: 'hostinger.search', title: 'Search Hostinger operations', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'Search the Hostinger API for operations by keyword (e.g. "create vps", "dns record"). Use this to discover the exact operation id before hostinger.do.',
  input: z.object({ query: z.string().min(2).max(200), accountId: fid('acc').optional() }),
  run: (ctx, i) => hostinger(ctx.app).call(ctx, account(ctx, i.accountId), 'search', { query: i.query }).then((r) => ({ result: r })),
});

defineTool({
  name: 'hostinger.do', title: 'Run a Hostinger operation', risk: (i) => hostingerRisk(i.operation), action: (i) => (moneyWrite(i.operation) ? 'provider_purchase' : `hostinger_${hostingerRisk(i.operation)}`), timeoutMs: 5 * 60_000,
  peopleOnly: (i) => money(i.operation),
  description: 'Run one Hostinger API operation by id (from hostinger.search), e.g. vps_virtual-machines_list, dns_records_update, vps_virtual-machines_setup. Reads run freely; writes follow policy; destructive operations need approval. Anything that buys, pays, renews, cancels or touches billing is for a person only.',
  input: z.object({ operation: z.string().min(3).max(120), params: z.record(z.string(), z.unknown()).default({}), accountId: fid('acc').optional() }),
  async run(ctx, i) {
    const out = await hostinger(ctx.app).call(ctx, account(ctx, i.accountId), 'execute', { operation: i.operation, params: i.params }, 5 * 60_000);
    ctx.emit('hostinger.operation', `Hostinger: ${i.operation}`, { data: { operation: i.operation } });
    return { operation: i.operation, result: tryJson(out) };
  },
});

defineTool({
  name: 'hostinger.batch', title: 'Run several Hostinger operations', risk: (i) => i.operations.map((o: { operation: string }) => hostingerRisk(o.operation)).reduce((a: string, b: string) => (b === 'destructive' || a === 'destructive' ? 'destructive' : b === 'write' || a === 'write' ? 'write' : 'read'), 'read') as 'read' | 'write' | 'destructive',
  action: (i) => (i.operations.some((o: { operation: string }) => moneyWrite(o.operation)) ? 'provider_purchase' : 'hostinger_batch'), timeoutMs: 10 * 60_000,
  peopleOnly: (i) => i.operations.some((o: { operation: string }) => money(o.operation)),
  description: 'Run up to 20 Hostinger operations in one call (Hostinger multi-execute) — e.g. create a VPS, then set its firewall and DNS. Risk is the highest among them.',
  input: z.object({ operations: z.array(z.object({ operation: z.string(), params: z.record(z.string(), z.unknown()).default({}) })).min(1).max(20), accountId: fid('acc').optional() }),
  async run(ctx, i) {
    const out = await hostinger(ctx.app).call(ctx, account(ctx, i.accountId), 'multi-execute', { operations: i.operations }, 10 * 60_000);
    return { count: i.operations.length, result: tryJson(out) };
  },
});

defineTool({
  name: 'hostinger.vps_list', title: 'List Hostinger VPS', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'List the VPS machines in a Hostinger account, with their IPs and state.',
  input: z.object({ accountId: fid('acc').optional() }),
  run: async (ctx, i) => ({ vps: await listVps(ctx, account(ctx, i.accountId)) }),
});

defineTool({
  name: 'hostinger.dns_list', title: 'List DNS records', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'List the DNS records for a domain in a Hostinger account.',
  input: z.object({ domain: z.string().min(3).max(253), accountId: fid('acc').optional() }),
  run: (ctx, i) => hostinger(ctx.app).call(ctx, account(ctx, i.accountId), 'execute', { operation: 'dns_records_list', params: { domain: i.domain } }).then((r) => ({ result: tryJson(r) })),
});

function tryJson(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }

// For other tools (Doctor): run one Hostinger operation and get its data back.
export async function hostingerExec(ctx: Ctx, accountId: string, operation: string, params: Record<string, unknown> = {}): Promise<any> {
  return unwrap(tryJson(await hostinger(ctx.app).call(ctx, accountId, 'execute', { operation, params }, 120_000)));
}
export { account as hostingerAccount };

// --- one click: a Hostinger VPS becomes a ready Unit7 server ---------------------------------------
// Unit7 makes its own SSH key and registers the server; a person adds the key once (from the server's
// page), then Unit7 prepares (Docker, HTTPS proxy, firewall) the machine. Operation names come from
// Hostinger's own search, so a renamed operation doesn't break this.

interface Op { operation: string; inputSchema?: { properties?: Record<string, unknown> } }
const opCache = new Map<string, Op>();
async function findOp(ctx: Ctx, accountId: string, query: string, want: RegExp): Promise<Op> {
  const hit = opCache.get(query);
  if (hit) return hit;
  const found = (tryJson(await hostinger(ctx.app).call(ctx, accountId, 'search', { query, limit: 10 })) as Op[] | string);
  const op = Array.isArray(found) ? found.find((o) => want.test(o.operation)) : undefined;
  if (!op) throw new Unit7Error('hostinger_operation', `Hostinger has no operation for “${query}” right now.`, 502);
  opCache.set(query, op);
  return op;
}
const unwrap = (r: unknown): any => (r && typeof r === 'object' && 'data' in (r as object) ? (r as { data: unknown }).data : r);

export interface Vps { id: number; hostname: string; state: string; ip?: string; plan?: string; os?: string }
// asked again at most once a minute, so the Servers page opens instantly
const vpsCache = new Map<string, { at: number; list: Vps[] }>();
export async function listVps(ctx: Ctx, accountId: string, fresh = false): Promise<Vps[]> {
  ctx.credentialFor('hostinger', accountId); // the same account check a live call gets
  const key = `${ctx.orgId}:${accountId}`;
  const hit = vpsCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.list;
  const list = await fetchVps(ctx, accountId);
  vpsCache.set(key, { at: Date.now(), list });
  return list;
}
async function fetchVps(ctx: Ctx, accountId: string): Promise<Vps[]> {
  const op = await findOp(ctx, accountId, 'list virtual machines', /^vps_.*virtual-machines?_(list|get-list)$/).catch(() => ({ operation: 'vps_virtual-machines_list' }));
  const rows = unwrap(tryJson(await hostinger(ctx.app).call(ctx, accountId, 'execute', { operation: op.operation, params: {} }, 60_000)));
  return (Array.isArray(rows) ? rows : []).map((v: any) => ({
    id: v.id, hostname: v.hostname ?? `vps-${v.id}`, state: v.state ?? 'unknown', ip: v.ipv4?.[0]?.address ?? v.ip_address ?? v.ipv4_address,
    plan: v.plan ?? v.plan_name, os: v.template?.name ?? v.os,
  }));
}

defineTool({
  name: 'hostinger.vps_use', title: 'Use a Hostinger VPS', risk: 'write', action: 'server_write', timeoutMs: 6 * 60_000,
  description: 'Add a Hostinger VPS as a Unit7 server: Unit7 creates its SSH key and registers the server. The key then has to be added to the VPS once (the server page offers one click, or a one-line command); Unit7 never re-sends keys through Hostinger, which only installs them at reinstall. Get vmId from hostinger.vps_list.',
  input: z.object({ vmId: z.number().int().positive(), accountId: fid('acc').optional() }),
  async run(ctx, i) {
    const acc = account(ctx, i.accountId);
    const vm = (await listVps(ctx, acc, true)).find((v) => v.id === i.vmId);
    if (!vm) throw new Unit7Error('not_found', 'That VPS isn’t in this Hostinger account.', 404);
    if (!vm.ip) throw new Unit7Error('vps_not_ready', `${vm.hostname} has no public IP yet. Finish its setup in Hostinger, then try again.`, 409);
    const already = get<{ id: string }>(ctx.db, 'SELECT id FROM servers WHERE org_id = ? AND provider_ref = ?', ctx.orgId, `hostinger:vm:${vm.id}`);
    if (already) return { serverId: already.id, status: 'already_connected' };

    ctx.progress(`Connecting ${vm.hostname} (${vm.ip})…`);
    const c = await execute(ctx.app, ctx.orgId, ctx.actor, 'server.connect', { name: vm.hostname.split('.')[0]!.slice(0, 40), host: vm.ip, accountId: acc, providerRef: `hostinger:vm:${vm.id}` }, { reason: 'hostinger.vps_use' });
    if (c.status !== 'ok') throw new Unit7Error('connect_failed', c.status === 'error' ? c.error.message : `Connecting the server needs ${c.status === 'approval_required' ? 'approval' : 'permission'}.`, 409);
    const { serverId, publicKey } = c.output as { serverId: string; publicKey: string };
    // Unit7's new key isn't on the VPS yet: Hostinger only installs attached keys when a VPS is (re)installed,
    // so attaching it now would change nothing on the server and trying to sign in would only be refused.
    // Unit7 waits for a person to add it once (one click on the server's page, or the command).
    const command = keyCommand(ctx.app, serverRow(ctx, serverId));
    const note = `Add Unit7’s key to ${vm.hostname} once: on the server’s page press “Add it using this Mac’s SSH access”, or run the command shown there. Unit7 doesn’t sign in until then.`;
    ctx.emit('server.key_needed', `${vm.hostname}: ${note}`, { severity: 'warning', resource: serverId });
    return { serverId, status: 'awaiting_key', host: vm.ip, publicKey, command, note };
  },
});

// --- Hostinger's own firewall, in front of the VPS -----------------------------------------------------------------------
// A VPS has at most one on. It drops everything without a rule, so a port opened on the server alone stays shut from
// outside; with none on, Hostinger blocks nothing. Unit7 changes rules on the one that's on and never turns one on or off:
// a firewall switched on without its SSH rule would lock everyone out.
interface FwRule { id: number; protocol: string; port: string; source?: string; source_detail?: string }
interface Fw { id: number; name: string; rules: FwRule[]; synced?: boolean }
export async function vpsFirewall(ctx: Ctx, accountId: string, vmId: number): Promise<Fw | undefined> {
  const vm = await hostingerExec(ctx, accountId, 'vps_virtual-machines_get', { virtualMachineId: vmId });
  if (!vm?.firewall_group_id) return undefined;
  const f = await hostingerExec(ctx, accountId, 'vps_firewall_get', { firewallId: vm.firewall_group_id });
  return { id: vm.firewall_group_id, name: String(f?.name ?? 'your firewall'), rules: Array.isArray(f?.rules) ? f.rules : [], ...(typeof f?.is_synced === 'boolean' && { synced: f.is_synced }) };
}
// does this accept rule let the TCP port in? (a single port or a range like 1024:2048, Hostinger's own names for the well-known ones)
const NAMED: Record<string, number> = { SSH: 22, HTTP: 80, HTTPS: 443, MYSQL: 3306, POSTGRESQL: 5432 };
export const coversPort = (r: Pick<FwRule, 'protocol' | 'port'>, port: number) => {
  const p = r.protocol.toUpperCase();
  if (NAMED[p]) return NAMED[p] === port;
  if (p !== 'TCP' && p !== 'ANY') return false;
  if (String(r.port).toLowerCase() === 'any') return true;
  const [a, b] = String(r.port).split(':').map(Number);
  return a! <= port && port <= (b ?? a!);
};
export async function hostingerFirewallPort(ctx: Ctx, s: ServerRow, port: number, how: 'open' | 'close') {
  const vmId = Number(/^hostinger:vm:(\d+)$/.exec(s.provider_ref ?? '')?.[1]);
  if (!vmId || !s.account_id) throw new Unit7Error('not_hostinger', `${s.name} isn’t linked to a Hostinger VPS.`, 409);
  const fw = await vpsFirewall(ctx, s.account_id, vmId);
  if (!fw) return { firewall: false, said: 'Hostinger’s firewall is off for this VPS, so it blocks nothing.' };
  const hits = fw.rules.filter((r) => coversPort(r, port));
  if (how === 'open' && hits.length) return { firewall: fw.name, already: true };
  // only a rule for exactly this port goes: a range or a named rule may be there for something else
  const mine = hits.filter((r) => /^(tcp|any)$/i.test(r.protocol) && String(r.port) === String(port));
  if (how === 'close' && !mine.length) return { firewall: fw.name, already: !hits.length, ...(hits.length && { said: `Port ${port} is let in by a wider rule in ${fw.name}. Change that one in Hostinger.` }) };
  if (how === 'open') await hostingerExec(ctx, s.account_id, 'vps_firewall_create-rule', { firewallId: fw.id, protocol: 'TCP', port: String(port), source: 'any', source_detail: 'any' });
  else for (const r of mine) await hostingerExec(ctx, s.account_id, 'vps_firewall_delete-rule', { firewallId: fw.id, ruleId: r.id });
  await hostingerExec(ctx, s.account_id, 'vps_firewall_sync-to-all-assigned-v-ms', { firewallId: fw.id }); // a changed rule does nothing until it's synced
  return { firewall: fw.name, changed: true };
}

defineTool({
  name: 'hostinger.firewall', title: 'Change Hostinger’s firewall for a VPS', risk: (i) => (i.op === 'list' ? 'read' : 'destructive'), action: (i) => (i.op === 'list' ? 'read' : 'server_write'), timeoutMs: 120_000,
  peopleOnly: (i) => i.op === 'open' && !!portRisk(i.port ?? 0),
  assess: (c, i) => {
    if (i.op === 'list') return { tier: 0 };
    if (i.op === 'open' && c.actor.kind !== 'user' && databaseOn(lastXray(c.db, c.orgId, i.serverId)?.data, i.port ?? 0)) throw forbidden(`A database answers on port ${i.port}, so only a person can open it.`);
    return { tier: 2, ask: 'This changes what the internet can reach on the VPS, and on any other VPS using the same firewall, so a person decides.', impact: `${i.op === 'open' ? 'Lets in' : 'Stops letting in'} TCP port ${i.port} at Hostinger.` };
  },
  description: 'The firewall Hostinger runs in front of a VPS. list: whether one is on, and its rules. open: add a rule letting one TCP port in. close: remove the rule for exactly that port. Each change is synced to the VPS. Refuses to touch the SSH port and the web ports. Database and admin ports are people only. Unit7 never turns this firewall on or off: a person does that in hPanel. server.open_port uses this by itself for a VPS at Hostinger.',
  input: z.object({ serverId: fid('srv'), op: z.enum(['list', 'open', 'close']).default('list'), port: z.number().int().min(1).max(65535).optional() }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), vmId = Number(/^hostinger:vm:(\d+)$/.exec(s.provider_ref ?? '')?.[1]);
    if (!vmId || !s.account_id) throw new Unit7Error('not_hostinger', `${s.name} isn’t a Hostinger VPS Unit7 knows.`, 409);
    if (i.op === 'list') {
      const fw = await vpsFirewall(ctx, s.account_id, vmId);
      return fw ? { on: true, firewall: fw.name, synced: fw.synced, rules: fw.rules.map((r) => ({ protocol: r.protocol, port: r.port, from: r.source_detail ?? r.source ?? 'any' })) } : { on: false, said: 'Hostinger’s firewall is off for this VPS, so it blocks nothing.' };
    }
    if (!i.port) throw new Unit7Error('invalid_input', 'Say which port.', 400);
    if (i.op === 'close' && [s.port, 22, 80, 443].includes(i.port)) throw new Unit7Error('unsafe_port', `Port ${i.port} is how you sign in or how visitors arrive. Unit7 won’t take its rule away.`, 400);
    const out = await hostingerFirewallPort(ctx, s, i.port, i.op);
    ctx.emit('server.port', `Hostinger’s firewall: ${i.op === 'open' ? 'opened' : 'closed'} port ${i.port} for ${s.name}`, { resource: s.id });
    return { ...out, ...('changed' in out && { undo: { tool: 'hostinger.firewall', input: { serverId: s.id, op: i.op === 'open' ? 'close' : 'open', port: i.port }, label: i.op === 'open' ? 'Close it again' : 'Open it again' } }) };
  },
});
