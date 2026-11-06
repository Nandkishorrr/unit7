// What's on a server, read without changing anything: server.xray (projects → parts, who runs each), server.sizes
// (disk per project, slow, cached), server.usage (CPU, memory, network and disk per project right now, with the
// server's price split between them) and server.price (the optional monthly price that split uses).
import { z } from 'zod';
import { defineTool, type Ctx, type AccountRow } from './runtime.ts';
import { all, get, id, json, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { fid } from './helpers.ts';
import { serverRow, parseMetrics, type Facts } from './servers.ts';
import { perMonth } from './budget.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { cmd } from '../connectors/shell.ts';
import { hostinger } from '../connectors/hostinger.ts';
import { coolifyApi, enrich, tree } from '../connectors/coolify.ts';
import {
  XRAY_PROBE, SIZES_PROBE, USAGE_PROBE, buildInventory, parseSizes, sizeTargets, sections, parseSentinel, parseDockerStats, rollup, summarize,
  type Inventory, type Sizes,
} from '../discovery/xray.ts';

// --- storage: every run kept, the last good one always there ------------------------------------------
const KEEP = 200; // ponytail: a fixed number of runs per server; roll up into daily frames when the time machine needs months
export function saveXray(db: DB, orgId: string, serverId: string, kind: 'fast' | 'deep' | 'usage', data: unknown, note?: string, ms?: number) {
  run(db, 'INSERT INTO xrays (id, org_id, server_id, kind, ok, note, ms, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id('xry'), orgId, serverId, kind, data ? 1 : 0, note ?? null, ms ?? null, data ? JSON.stringify(data) : '{}');
  run(db, 'DELETE FROM xrays WHERE server_id = ? AND id NOT IN (SELECT id FROM xrays WHERE server_id = ? ORDER BY created_at DESC LIMIT ?)', serverId, serverId, KEEP);
}
export function lastXray<T = Inventory>(db: DB, orgId: string, serverId: string, kind: 'fast' | 'deep' | 'usage' = 'fast'): { at: string; data: T } | undefined {
  const r = get<{ created_at: string; data: string }>(db, 'SELECT created_at, data FROM xrays WHERE org_id = ? AND server_id = ? AND kind = ? AND ok = 1 ORDER BY created_at DESC LIMIT 1', orgId, serverId, kind);
  return r && { at: r.created_at, data: json<T>(r.data, {} as T) };
}

// --- Coolify on a server: its account, and an API client for it -----------------------------------------
export const coolifyAccount = (ctx: Pick<Ctx, 'db' | 'orgId'>, serverId: string) =>
  get<AccountRow>(ctx.db, `SELECT * FROM accounts WHERE org_id = ? AND provider = 'coolify' AND json_extract(meta, '$.serverId') = ?`, ctx.orgId, serverId);
export function coolifyFor(ctx: Ctx, s: ServerRow) {
  const account = coolifyAccount(ctx, s.id);
  if (!account) return undefined;
  const meta = json<{ apiPort?: string; facts?: { abilities?: string[]; version?: string } }>(account.meta, {});
  const { value } = ctx.credentialFor('coolify', account.id);
  return { account, abilities: meta.facts?.abilities ?? [], version: meta.facts?.version, api: coolifyApi(ctx.app, s, value, Number(meta.apiPort) || 8000, ctx.signal) };
}

const withTimeout = <T>(p: Promise<T>, ms: number, why: string) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(why)), ms).unref())]);
const asRoot = (s: ServerRow) => (json<Facts>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : '');

export type Xray = Inventory & { stale?: { since: string; why: string } };
export async function runXray(ctx: Ctx, s: ServerRow, o: { coolify?: boolean } = {}): Promise<Xray> {
  const t0 = Date.now();
  const unit7 = Object.fromEntries(all<{ id: string; name: string; project: string }>(ctx.db, 'SELECT s.id, s.name, p.name project FROM services s JOIN projects p ON p.id = s.project_id WHERE s.server_id = ? AND s.org_id = ?', s.id, ctx.orgId)
    .map((r) => [r.id, { name: r.name, project: r.project }]));
  const acc = coolifyAccount(ctx, s.id);
  const abilities = json<{ facts?: { abilities?: string[] } }>(acc?.meta, {}).facts?.abilities ?? [];
  try {
    // environment values come back with docker inspect: they stay in this function, only hostnames and keys are kept
    const r = await ssh(ctx.app).exec(s, `${asRoot(s)}sh -s`, { stdin: XRAY_PROBE, timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024, signal: ctx.signal });
    if (!r.stdout.includes('@@unit7:host')) throw new Unit7Error('xray_failed', `The X-ray of ${s.name} came back empty: ${r.stderr.trim().slice(-300) || `exit ${r.code}`}`, 502);
    let inv = buildInventory(r.stdout, { unit7, serverHost: s.host, coolify: acc ? { accountId: acc.id, managed: abilities.includes('deploy') && acc.status !== 'failing', abilities } : undefined });
    if (acc && inv.coolify && o.coolify !== false) {
      try {
        inv = enrich(inv, await withTimeout(tree(coolifyFor(ctx, s)!.api, { deployments: true }), 45_000, 'took longer than 45 seconds'));
        inv.summary = summarize(inv);
      } catch (e) { inv.notes.push(`Coolify’s API couldn’t be read, so names and domains come from its labels (${(e as Error).message.slice(0, 200)}).`); }
    }
    // what a person adopted (part.adopt) is managed, whatever the server's labels say
    for (const a of all<{ part: string; trust: Inventory['parts'][number]['trust'] }>(ctx.db, 'SELECT part, trust FROM part_trust WHERE org_id = ? AND server_id = ?', ctx.orgId, s.id)) {
      const p = inv.parts.find((x) => x.id === a.part);
      if (p) p.trust = a.trust;
    }
    inv.ms = Date.now() - t0;
    saveXray(ctx.db, ctx.orgId, s.id, 'fast', inv, undefined, inv.ms);
    return inv;
  } catch (e) {
    const why = (e as Error).message.slice(0, 300);
    saveXray(ctx.db, ctx.orgId, s.id, 'fast', undefined, why, Date.now() - t0);
    const last = lastXray(ctx.db, ctx.orgId, s.id);
    if (!last) throw e;
    return { ...last.data, stale: { since: last.at, why } };
  }
}
// the last X-ray if it's recent enough, else a new one
export async function inventoryOf(ctx: Ctx, s: ServerRow, maxAgeMs = 10 * 60_000): Promise<Xray> {
  const last = lastXray(ctx.db, ctx.orgId, s.id);
  return last && Date.now() - Date.parse(last.at) < maxAgeMs ? last.data : runXray(ctx, s);
}

const nextOf = (inv: Inventory) => {
  if (inv.coolify && !inv.coolify.connected) return `Coolify runs here and Unit7 found its projects from its labels. Connect it (coolify.connect shows the three steps) so Unit7 can show real names, domains and deploys, and manage them through Coolify.`;
  if (inv.loose.length) return 'Things in "Not part of a project" can be tidied up or adopted later.';
  return undefined;
};

defineTool({
  name: 'server.xray', title: 'X-ray a server', risk: 'read', action: 'read', timeoutMs: 150_000,
  description: 'Everything on a server, grouped into projects: apps, databases, services, volumes, scheduled jobs and domains, each with who runs it (Coolify, Dokploy, CapRover, Docker Compose, PM2, systemd, Unit7, or nothing) and how far Unit7 understands it (seen, understood, managed, owned). Supabase and other multi-container products show as one part. Databases say their engine, version and whether they are open to the internet. One read-only SSH trip of a few seconds; also reads Coolify’s API when Coolify is connected. Every X-ray is saved; when the server can’t be reached the last good one comes back marked stale. Use before changing anything on a server.',
  input: z.object({ serverId: fid('srv'), coolify: z.boolean().default(true).describe('Also read Coolify’s API when it is connected') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    ctx.progress(`X-raying ${s.name}…`);
    const inv = await runXray(ctx, s, { coolify: i.coolify });
    // the disk then and now (the oldest X-ray of the last 30 days and the newest), so the page can say when it fills up
    const trend = all<{ at: string; diskUsed: number | null }>(ctx.db, `SELECT created_at at, json_extract(data, '$.server.diskUsed') diskUsed FROM xrays
      WHERE org_id = ? AND server_id = ? AND kind = 'fast' AND ok = 1 AND created_at > ? ORDER BY created_at`, ctx.orgId, s.id, new Date(Date.now() - 30 * 86_400_000).toISOString())
      .filter((r) => r.diskUsed != null);
    return { serverId: s.id, serverName: s.name, ...inv, next: nextOf(inv), ...(trend.length > 1 && { trend: [trend[0], trend.at(-1)] }) };
  },
});

defineTool({
  name: 'server.sizes', title: 'Measure disk use on a server', risk: 'read', action: 'read', timeoutMs: 15 * 60_000,
  description: 'How much disk each project on a server takes: its volumes, folders, container layers and logs, and each database’s own size (measured inside its container with its own settings, so no password leaves the server). Also what can be cleaned up (unused images, build cache, volumes nothing uses). Slow (seconds to minutes on a big disk), so the last measurement is reused for 6 hours unless fresh is true. Read-only.',
  input: z.object({ serverId: fid('srv'), fresh: z.boolean().default(false) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const cached = lastXray<Sizes>(ctx.db, ctx.orgId, s.id, 'deep');
    if (cached && !i.fresh && Date.now() - Date.parse(cached.at) < 6 * 3600_000) return { ...cached.data, cached: true };
    try {
      const inv = await inventoryOf(ctx, s);
      ctx.progress(`Measuring disk use on ${s.name} (this can take a few minutes)…`);
      const t0 = Date.now();
      const r = await ssh(ctx.app).exec(s, `${asRoot(s)}${cmd('sh', '-s', '--', ...sizeTargets(inv))}`, { stdin: SIZES_PROBE, timeoutMs: 12 * 60_000, maxBytes: 16 * 1024 * 1024, signal: ctx.signal });
      if (!r.stdout.includes('@@unit7:df')) throw new Unit7Error('sizes_failed', `Measuring ${s.name} failed: ${r.stderr.trim().slice(-300) || `exit ${r.code}`}`, 502);
      const sizes = parseSizes(r.stdout, inv);
      saveXray(ctx.db, ctx.orgId, s.id, 'deep', sizes, undefined, Date.now() - t0);
      return { ...sizes, cached: false };
    } catch (e) {
      // the server didn't answer: the last measurement, however old, marked stale
      if (!cached) throw e;
      return { ...cached.data, cached: true, stale: { since: cached.at, why: (e as Error).message.slice(0, 300) } };
    }
  },
});

// --- the server's price (yours, or Hostinger's for a Hostinger VPS) -----------------------------------
interface Price { monthly: number; currency: string; source: string }
async function hostingerPrice(ctx: Ctx, s: ServerRow): Promise<Price | undefined> {
  const vm = /^hostinger:vm:(\d+)$/.exec(s.provider_ref ?? '')?.[1];
  if (!vm || !s.account_id) return undefined;
  const call = async (operation: string, params: Record<string, unknown> = {}) => { const j = JSON.parse(await hostinger(ctx.app).call(ctx, s.account_id!, 'execute', { operation, params }, 60_000)); return j?.data ?? j; };
  const machine = await call('vps_virtual-machines_get', { virtualMachineId: Number(vm) });
  const subs = await call('billing_subscriptions_list');
  const sub = (Array.isArray(subs) ? subs : []).find((x: { id?: unknown }) => machine?.subscription_id && String(x.id) === String(machine.subscription_id));
  const cents = sub?.renewal_price ?? sub?.total_price;
  return cents ? { monthly: Math.round(perMonth(cents / 100, sub.billing_period ?? 1, sub.billing_period_unit ?? 'month') * 100) / 100, currency: sub.currency_code ?? 'USD', source: 'Hostinger' } : undefined;
}
export async function serverPrice(ctx: Ctx, s: ServerRow): Promise<Price | undefined> {
  const p = get<{ monthly_price: number | null; price_currency: string | null; price_source: string | null }>(ctx.db, 'SELECT monthly_price, price_currency, price_source FROM servers WHERE id = ?', s.id);
  if (p?.monthly_price != null) return { monthly: p.monthly_price, currency: p.price_currency ?? 'USD', source: p.price_source ?? 'you' };
  const h = await hostingerPrice(ctx, s).catch(() => undefined);
  if (h) run(ctx.db, 'UPDATE servers SET monthly_price = ?, price_currency = ?, price_source = ? WHERE id = ?', h.monthly, h.currency, h.source, s.id);
  return h;
}

defineTool({
  name: 'server.price', title: 'A server’s monthly price', risk: (i) => (i.monthly !== undefined ? 'write' : 'read'), action: (i) => (i.monthly !== undefined ? 'settings_write' : 'read'),
  description: 'What a server costs a month, which server.usage splits into a cost per project. Without monthly it reads it (for a Hostinger VPS Unit7 looks it up in the plan). With monthly it sets it (null clears it).',
  input: z.object({ serverId: fid('srv'), monthly: z.number().min(0).max(100_000).nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).default('USD') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    if (i.monthly !== undefined) run(ctx.db, 'UPDATE servers SET monthly_price = ?, price_currency = ?, price_source = ? WHERE id = ?', i.monthly, i.monthly === null ? null : i.currency, i.monthly === null ? null : 'you', s.id);
    return (await serverPrice(ctx, s)) ?? { monthly: null, note: 'No price known. Set it with monthly, and server.usage shows what each project costs.' };
  },
});

defineTool({
  name: 'server.usage', title: 'What each project uses', risk: 'read', action: 'read', timeoutMs: 120_000,
  description: 'CPU, memory, network and disk per project on a server right now, with the server itself and the free room shown separately, and (when the server’s monthly price is known) what each project costs as a share of it. On a Coolify server it reads Coolify’s own monitor (Sentinel) from inside the server; otherwise docker stats. Disk comes from the last server.sizes measurement. When the server can’t be reached the last reading comes back marked stale. Read-only.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    try {
      const inv = await inventoryOf(ctx, s);
      const r = await ssh(ctx.app).exec(s, `${asRoot(s)}sh -s`, { stdin: USAGE_PROBE, timeoutMs: 60_000, maxBytes: 8 * 1024 * 1024, signal: ctx.signal });
      const sec = sections(r.stdout);
      if (!sec.host) throw new Unit7Error('usage_failed', `Couldn't read ${s.name}'s usage: ${r.stderr.trim().slice(-300) || `exit ${r.code}`}`, 502);
      const m = parseMetrics(sec.host);
      const host = { cpus: Number(/cpus=(\d+)/.exec(sec.host)?.[1]) || inv.server.cpus || 1, cpu: m.cpu, memTotal: m.memTotal, memUsed: m.memUsed, diskTotal: m.diskTotal, diskUsed: m.diskUsed };
      const sentinel = sec.sentinel !== undefined;
      const sizes = lastXray<Sizes>(ctx.db, ctx.orgId, s.id, 'deep')?.data;
      const u = { serverId: s.id, serverName: s.name, ...rollup(inv, host, sentinel ? parseSentinel(sec.sentinel) : parseDockerStats(sec.stats), sentinel ? 'sentinel' : 'docker-stats', { sizes, price: await serverPrice(ctx, s) }),
        ...(!sizes && { next: 'Disk per project needs one server.sizes run (slow; cached afterwards).' }) };
      // only the last reading is kept: it's what the server page shows while the server doesn't answer
      run(ctx.db, `DELETE FROM xrays WHERE server_id = ? AND kind = 'usage'`, s.id);
      saveXray(ctx.db, ctx.orgId, s.id, 'usage', u);
      return u;
    } catch (e) {
      const last = lastXray<Record<string, unknown>>(ctx.db, ctx.orgId, s.id, 'usage');
      if (!last) throw e;
      return { ...last.data, stale: { since: last.at, why: (e as Error).message.slice(0, 300) } };
    }
  },
});
