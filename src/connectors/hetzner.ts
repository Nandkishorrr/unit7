// Hetzner Cloud: a project API token (Read is enough). Servers and, since Hetzner moved DNS into the Cloud API
// (the old dns.hetzner.com API closed in May 2026), that project's DNS zones. UNIT7_HETZNER_API points at a fake in tests.
import type { Ctx } from '../tools/runtime.ts';
import { call } from './cloudcli.ts';
import { Unit7Error } from '../errors.ts';

const H = () => process.env.UNIT7_HETZNER_API ?? 'https://api.hetzner.cloud/v1';
async function hz<T>(ctx: Ctx, acc: string, path: string, field: string): Promise<T[]> {
  const token = ctx.credentialFor('hetzner', acc).value.trim();
  const out: T[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await call<Record<string, any>>('Hetzner', `${H()}${path}${path.includes('?') ? '&' : '?'}per_page=50&page=${page}`, { headers: { authorization: `Bearer ${token}` } });
    out.push(...(r[field] ?? []));
    if (!r.meta?.pagination?.next_page) break;
  }
  return out;
}
export const hetzner = {
  // a refused token fails here, before anything else is asked
  servers: (ctx: Ctx, acc: string) => hz<{ id: number; name: string; status: string; public_net?: { ipv4?: { ip?: string } | null; ipv6?: { ip?: string } | null } }>(ctx, acc, '/servers', 'servers'),
  zones: (ctx: Ctx, acc: string) => hz<{ id: number; name: string }>(ctx, acc, '/zones', 'zones'),
  records: (ctx: Ctx, acc: string, zone: number | string) => hz<{ name: string; type: string; ttl?: number | null; records: { value: string }[] }>(ctx, acc, `/zones/${encodeURIComponent(zone)}/rrsets`, 'rrsets'),
};

// --- changes (Phase 2+): only ever called by Unit7's tools, each through the gate -------------------------------------
// DNS record sets in the Cloud API: create one, set / add / remove its records (each returns an action Hetzner finishes
// in the background), or delete it. Names are relative and lowercase ('@' is the apex); TXT values are quoted.
// https://docs.hetzner.cloud/reference/cloud#tag/zones (spec: https://docs.hetzner.cloud/cloud.spec.json)
export const hsend = <T = any>(ctx: Ctx, acc: string, path: string, o: { method?: string; body?: unknown } = {}) =>
  call<T>('Hetzner', `${H()}${path}`, { method: o.method ?? 'POST', body: o.body, headers: { authorization: `Bearer ${ctx.credentialFor('hetzner', acc).value.trim()}` } });
export interface HzRRSet { name: string; type: string; ttl?: number | null; records: { value: string; comment?: string }[] }
const rr = (zone: string, name: string, type: string) => `/zones/${encodeURIComponent(zone)}/rrsets/${encodeURIComponent(name)}/${type}`;
export const hetznerDns = {
  zone: (ctx: Ctx, acc: string, zone: string) => hsend<{ zone: { id: number; name: string } }>(ctx, acc, `/zones/${encodeURIComponent(zone)}`, { method: 'GET' }).then((r) => r.zone, (e) => { if ((e as { status?: number }).status === 404) return undefined; throw e; }),
  get: (ctx: Ctx, acc: string, zone: string, name: string, type: string) => hsend<{ rrset: HzRRSet }>(ctx, acc, rr(zone, name, type), { method: 'GET' }).then((r) => r.rrset, (e) => { if ((e as { status?: number }).status === 404) return undefined; throw e; }),
  create: (ctx: Ctx, acc: string, zone: string, s: HzRRSet) => hsend(ctx, acc, `/zones/${encodeURIComponent(zone)}/rrsets`, { body: s }),
  setRecords: (ctx: Ctx, acc: string, zone: string, name: string, type: string, records: { value: string }[]) => hsend(ctx, acc, `${rr(zone, name, type)}/actions/set_records`, { body: { records } }),
  remove: (ctx: Ctx, acc: string, zone: string, name: string, type: string) => hsend(ctx, acc, rr(zone, name, type), { method: 'DELETE' }),
};

// --- one server: snapshots, its plan, power and delete (tools/vps.ts). These need a Read & Write token ------------------
export interface HzServer { id: number; name: string; status: string; primary_disk_size?: number; server_type: { name: string; cores: number; memory: number; disk: number; architecture?: string }; datacenter?: { location?: { name?: string } } }
export interface HzImage { id: number; description?: string; created?: string; image_size?: number | null; created_from?: { id: number; name?: string } | null }
export interface HzType { name: string; cores: number; memory: number; disk: number; architecture?: string; deprecated?: boolean; deprecation?: unknown; prices?: { location: string; price_monthly?: { gross?: string } }[] }
const server = (id: number) => `/servers/${id}`;
// a read-only token gets a plain way forward: "Read is enough" was all it needed until now
const canWrite = <T>(p: Promise<T>) => p.catch((e: Unit7Error) => {
  if (e.status === 403) throw new Unit7Error('read_only_token', 'Hetzner refused: this token can only read. In your Hetzner project open Security → API tokens, make a Read & Write token, then reconnect Hetzner in Connections.', 403);
  throw e;
});
export const hetznerBox = {
  get: (ctx: Ctx, acc: string, id: number) => hsend<{ server: HzServer }>(ctx, acc, server(id), { method: 'GET' }).then((r) => r.server),
  types: (ctx: Ctx, acc: string) => hz<HzType>(ctx, acc, '/server_types', 'server_types'),
  // Hetzner lists every snapshot in the project; created_from says whose it is
  snapshots: async (ctx: Ctx, acc: string, id: number) => (await hz<HzImage>(ctx, acc, '/images?type=snapshot&sort=created:desc', 'images')).filter((x) => x.created_from?.id === id),
  snapshot: (ctx: Ctx, acc: string, id: number, description: string) => canWrite(hsend<{ image: HzImage }>(ctx, acc, `${server(id)}/actions/create_image`, { body: { type: 'snapshot', description, labels: { 'managed-by': 'unit7' } } }).then((r) => r.image)),
  rebuild: (ctx: Ctx, acc: string, id: number, image: number) => canWrite(hsend(ctx, acc, `${server(id)}/actions/rebuild`, { body: { image } })),
  power: (ctx: Ctx, acc: string, id: number, verb: 'shutdown' | 'poweroff' | 'poweron') => canWrite(hsend(ctx, acc, `${server(id)}/actions/${verb}`)),
  changeType: (ctx: Ctx, acc: string, id: number, type: string, upgradeDisk: boolean) => canWrite(hsend(ctx, acc, `${server(id)}/actions/change_type`, { body: { server_type: type, upgrade_disk: upgradeDisk } })),
  remove: (ctx: Ctx, acc: string, id: number) => canWrite(hsend(ctx, acc, server(id), { method: 'DELETE' })),
};
