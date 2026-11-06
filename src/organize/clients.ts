// Client spaces. The person builds for clients (a CRM for a bakery, a site for a gym): a client owns products, Unit7
// projects and things on the map, each at most one client (none = the person's own). Pages filter to one client; each
// client's monthly cost comes from the providers' costs and each server's price split by the projects on it, with a CSV
// to copy for invoicing. Its status page lives in status.ts.
import { z } from 'zod';
import { defineTool, execute, getTool, type Ctx } from '../tools/runtime.ts';
import { all, get, id, json, now, run, tx, type DB } from '../db.ts';
import { Unit7Error, notFound } from '../errors.ts';
import { assetIdOf } from '../archive.ts';
import { lastXray } from '../tools/xray.ts';
import { dnsDeps } from '../tools/clouds-dns.ts';
import { assertHostname } from '../deploy/caddy.ts';
import type { Inventory, Usage } from '../discovery/xray.ts';
import { index, healthOf, logoOf, ownerKey, worst, type Health, type Index } from './groups.ts';

const COLOR = /^#[0-9a-f]{6}$/i;
const LOGO = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/; // a small picture kept here: no outside address to load
const PALETTE = ['#2f5bea', '#7a9a01', '#c2410c', '#0f766e', '#9333ea', '#be123c', '#0369a1', '#a16207'];
export const colorFor = (name: string) => PALETTE[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length]!;

export interface ClientRow { id: string; name: string; color: string | null; logo: string | null; contact: string | null; status: string; created_at: string }
export const clientRow = (db: DB, orgId: string, clientId: string) => {
  const c = get<ClientRow>(db, 'SELECT id, name, color, logo, contact, status, created_at FROM clients WHERE id = ? AND org_id = ?', clientId, orgId);
  if (!c) throw notFound('That client');
  return c;
};

// --- who owns what ------------------------------------------------------------------------------------------------------
// A product's client is its own row; a thing in a product belongs to the product's client; anything else to its own row.
// ids: every id a client owns, for filtering any page: products (grp_), Unit7 projects (prj_) and their apps (svc_), map
// things (ast_, and the parts inside a server project), and the servers they run on (srv_ and the server's map id).
export function ownership(db: DB, orgId: string, ix: Index = index(db, orgId, { withArchived: true })) {
  const direct = new Map(all<{ key: string; client_id: string }>(db, 'SELECT key, client_id FROM client_members WHERE org_id = ?', orgId).map((r) => [r.key, r.client_id]));
  const ofKey = (k: string) => direct.get(ix.members.get(k) ?? '') ?? direct.get(k);
  const clientOf = (anyId: string): string | undefined => (anyId.startsWith('grp_') ? direct.get(anyId) : ofKey(anyId.startsWith('ast_') ? ix.up(anyId) ?? anyId : anyId));
  const ids = new Map<string, Set<string>>();
  const add = (c: string | undefined, ...xs: (string | undefined | null)[]) => { if (!c) return; let s = ids.get(c); if (!s) ids.set(c, (s = new Set())); for (const x of xs) if (x) s.add(x); };
  for (const [k, c] of direct) if (k.startsWith('grp_')) add(c, k);
  for (const k of ix.members.keys()) add(ofKey(k), k);
  for (const p of ix.projects.keys()) add(ofKey(p), p);
  for (const a of ix.rows) {
    const c = clientOf(a.id);
    const server = ix.meta(a).server;
    add(c, a.id, server && assetIdOf(orgId, server), server?.replace(/^unit7:/, ''));
  }
  for (const s of all<{ id: string; project_id: string; server_id: string | null }>(db, 'SELECT id, project_id, server_id FROM services WHERE org_id = ?', orgId)) {
    const c = ofKey(s.project_id);
    add(c, s.id, assetIdOf(orgId, `unit7:${s.id}`), s.server_id, s.server_id && assetIdOf(orgId, `unit7:${s.server_id}`));
  }
  return { direct, clientOf, ids, ix };
}
export type Ownership = ReturnType<typeof ownership>;

// --- money: this month per client ------------------------------------------------------------------------------------------
export interface CostLine { clientId?: string; product: string; item: string; source: string; amount: number; currency: string }
// Lines from elsewhere (the cost radar): a key when it knows what a line is about (ast_/prj_/grp_), else matched by name
export interface OutsideCost { key?: string; label: string; provider?: string; amount: number; currency: string }
const round2 = (n: number) => Math.round(n * 100) / 100;

// Each server's price split by what runs on it (server.usage's last reading: half memory, half CPU), the costs the
// budget read from providers (matched to a thing by name, or a Cloudflare plan by its domain), and lines passed in.
// The server itself and its free room stay unassigned.
export function costLines(db: DB, orgId: string, extra: OutsideCost[] = [], own: Ownership = ownership(db, orgId)): CostLine[] {
  const { ix } = own;
  const nameOf = (k: string) => (k.startsWith('grp_') ? ix.groups.get(k)?.name : ix.projects.get(k)?.name ?? ix.byId.get(k)?.name) ?? 'Something';
  const productOf = (k: string) => { const g = ix.members.get(k); return g ? ix.groups.get(g)?.name ?? nameOf(k) : nameOf(k); };
  const line = (k: string | undefined, item: string, source: string, amount: number, currency: string): CostLine => {
    const member = k ? (k.startsWith('ast_') ? ix.up(k) ?? k : k) : undefined;
    return { clientId: member ? own.clientOf(member) : undefined, product: member ? productOf(member) : 'Not assigned', item, source, amount: round2(amount), currency };
  };
  const out: CostLine[] = [];
  for (const s of all<{ id: string; name: string }>(db, 'SELECT id, name FROM servers WHERE org_id = ?', orgId)) {
    const u = lastXray<Usage>(db, orgId, s.id, 'usage')?.data;
    if (!u?.price) continue;
    const inv = lastXray<Inventory>(db, orgId, s.id)?.data;
    for (const sl of u.projects ?? []) {
      if (!sl.cost || sl.system) continue;
      const owner = inv?.projects.find((p) => p.id === sl.id)?.owner;
      if (owner === 'unit7') {
        // ponytail: Unit7's own apps on one server are one slice, split evenly between them; per-app stats would split it by use
        const apps = all<{ project_id: string; name: string }>(db, `SELECT project_id, name FROM services WHERE server_id = ? AND org_id = ? AND kind NOT IN ('postgres','mysql','mariadb','mongo','redis')`, s.id, orgId);
        const dbs = all<{ project_id: string; name: string }>(db, `SELECT project_id, name FROM services WHERE server_id = ? AND org_id = ? AND kind IN ('postgres','mysql','mariadb','mongo','redis')`, s.id, orgId);
        const each = [...apps, ...dbs];
        for (const a of each) out.push(line(a.project_id, a.name, 'Server share', sl.cost / each.length, u.price.currency));
      } else if (owner) out.push(line(assetIdOf(orgId, `${owner}:${s.id}/p/${sl.id}`), sl.name, 'Server share', sl.cost, u.price.currency));
    }
  }
  // provider costs: a line named like a thing is that thing's (and "example.com (Pro)" is that domain's plan)
  const byName = new Map<string, string>();
  for (const g of ix.groups.values()) byName.set(g.name.toLowerCase(), g.id);
  for (const p of ix.projects.values()) if (!byName.has(p.name.toLowerCase())) byName.set(p.name.toLowerCase(), p.id);
  for (const a of ix.rows) if (a.kind !== 'server' && !byName.has(a.name.toLowerCase())) byName.set(a.name.toLowerCase(), a.id);
  const match = (label: string) => byName.get(label.toLowerCase()) ?? byName.get(label.split(' (')[0]!.trim().toLowerCase());
  const word = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);
  for (const c of all<{ provider: string; label: string; amount: number; currency: string }>(db, 'SELECT provider, label, amount, currency FROM costs WHERE org_id = ?', orgId)) {
    out.push(line(match(c.label), c.label, word(c.provider), c.amount, c.currency));
  }
  for (const e of extra) out.push(line(e.key ?? match(e.label), e.label, e.provider ? word(e.provider) : 'Other', e.amount, e.currency));
  // the same thing twice (an app in production and its staging copy on one server) is one line
  const same = new Map<string, CostLine>();
  for (const l of out.filter((x) => x.amount > 0)) {
    const k = [l.clientId, l.product, l.item, l.source, l.currency].join('\n'), prev = same.get(k);
    if (prev) prev.amount = round2(prev.amount + l.amount); else same.set(k, { ...l });
  }
  return [...same.values()];
}

export const totals = (lines: CostLine[]) => {
  const t = new Map<string, number>();
  for (const l of lines) t.set(l.currency, (t.get(l.currency) ?? 0) + l.amount);
  return [...t].map(([currency, amount]) => ({ currency, amount: round2(amount) }));
};

// A spreadsheet cell: quoted when it must be, and never read as a formula (a name like "=HYPERLINK(…)" from a provider)
const cell = (v: string | number) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function costsCsv(lines: CostLine[], clientName: (id?: string) => string, month: string): string {
  const rows = [['Month', 'Client', 'Product', 'Item', 'Source', 'Amount', 'Currency'], ...lines.map((l) => [month, clientName(l.clientId), l.product, l.item, l.source, l.amount.toFixed(2), l.currency])];
  return `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`;
}

// --- what the cards show -----------------------------------------------------------------------------------------------------
function healthOfIds(db: DB, orgId: string, ids: Set<string>, ix: Index): Health {
  let h: Health = 'ok';
  const sites = new Map(all<{ asset: string; status: string }>(db, `SELECT asset, status FROM watch WHERE org_id = ? AND kind = 'site' AND asset IS NOT NULL`, orgId).map((w) => [w.asset, w.status]));
  for (const i of ids) {
    const a = ix.byId.get(i);
    if (a) { const m = ix.meta(a) as { status?: string; health?: { status: string } }; h = worst(h, healthOf({ id: a.id, kind: a.kind, status: m.status, health: m.health, site: sites.has(a.id) ? { status: sites.get(a.id)! } : undefined })); }
    if (i.startsWith('svc_')) { const s = get<{ status: string }>(db, 'SELECT status FROM services WHERE id = ?', i); if (s && /failed|unhealthy|down/.test(s.status)) h = 'bad'; }
  }
  return h;
}

// what a client was given, as a row: a product (with its members' logos), a project, a thing on the map
function memberView(ix: Index, k: string) {
  if (k.startsWith('grp_')) {
    const keys = [...ix.members].filter(([, g]) => g === k).map(([m]) => m);
    const logos = [...new Set(keys.map((m) => (m.startsWith('prj_') ? 'unit7' : ix.byId.get(m) ? logoOf(ix.byId.get(m)!, ix.meta(ix.byId.get(m)!)) : '')).filter(Boolean))].slice(0, 4);
    return { key: k, name: ix.groups.get(k)?.name ?? 'A product', kind: 'product', logos, count: keys.length };
  }
  if (k.startsWith('prj_')) return { key: k, name: ix.projects.get(k)?.name ?? 'A project that’s gone', kind: 'project', logos: ['unit7'] };
  const a = ix.byId.get(k);
  return { key: k, name: a?.name ?? 'Not on the map since the last sync', kind: a?.kind ?? 'gone', logos: a ? [logoOf(a, ix.meta(a))] : [] };
}

export function listClients(db: DB, orgId: string, extra: OutsideCost[] = []) {
  const own = ownership(db, orgId);
  const lines = costLines(db, orgId, extra, own);
  const count = (ids: Set<string>, p: string) => [...ids].filter((x) => x.startsWith(p)).length;
  const things = (ids: Set<string>) => [...ids].filter((x) => x.startsWith('ast_') && own.ix.up(x) === x && !own.ix.members.has(x) && own.ix.byId.get(x)?.kind !== 'server').length;
  const clients = all<ClientRow>(db, 'SELECT id, name, color, logo, contact, status, created_at FROM clients WHERE org_id = ? ORDER BY name', orgId).map((c) => {
    const ids = own.ids.get(c.id) ?? new Set<string>();
    const st = json<{ on?: boolean; domain?: string; serverId?: string; publishedAt?: string; error?: string }>(c.status, {});
    return { id: c.id, name: c.name, color: c.color ?? colorFor(c.name), logo: c.logo, contact: c.contact,
      products: count(ids, 'grp_'), projects: [...ids].filter((x) => x.startsWith('prj_') && !own.ix.members.has(x)).length, things: things(ids), health: healthOfIds(db, orgId, ids, own.ix),
      cost: totals(lines.filter((l) => l.clientId === c.id)),
      members: [...own.direct].filter(([, cid]) => cid === c.id).map(([k]) => memberView(own.ix, k)),
      statusPage: { on: !!st.on, ...(st.on && { domain: st.domain, updatedAt: st.publishedAt }), ...(st.error && { problem: st.error }) },
      ids: [...ids] };
  });
  const mineIds = new Set([...own.ix.projects.keys(), ...own.ix.groups.keys()].filter((k) => !own.clientOf(k)));
  return { month: now().slice(0, 7), clients, mine: { products: count(mineIds, 'grp_'), projects: count(mineIds, 'prj_'), cost: totals(lines.filter((l) => !l.clientId)) } };
}

// For the cost radar (and anything else that knows map things): whose is this? undefined = the person's own
export function clientOfKey(db: DB, orgId: string): (anyId: string) => string | undefined {
  return ownership(db, orgId).clientOf;
}

// --- tools -------------------------------------------------------------------------------------------------------------------
const NAME = z.string().trim().min(1).max(60);
const fields = {
  color: z.string().regex(COLOR, 'a colour like #2f5bea').nullable().optional(),
  logo: z.string().max(120_000).regex(LOGO, 'a small PNG, JPEG, WebP or GIF picture').nullable().optional(),
  contact: z.string().trim().max(120).nullable().optional(),
};
const CLIENT_ID = z.string().regex(/^cli_[A-Za-z0-9_-]{12}$/, 'must be a cli_ id');
const taken = (db: DB, orgId: string, name: string, except = '') => !!get(db, 'SELECT 1 FROM clients WHERE org_id = ? AND name = ? AND id != ?', orgId, name, except);

defineTool({
  name: 'client.create', title: 'Add a client', risk: 'write', action: 'client_write',
  description: 'Add a client the person builds for (a name, optionally a colour like #2f5bea, a small logo picture and a contact name). Then client.assign gives it products, projects and things.',
  input: z.object({ name: NAME, ...fields }),
  run(ctx, i) {
    if (taken(ctx.db, ctx.orgId, i.name)) throw new Unit7Error('exists', `There’s already a client called ${i.name}.`, 409);
    const cid = id('cli');
    run(ctx.db, 'INSERT INTO clients (id, org_id, name, color, logo, contact) VALUES (?, ?, ?, ?, ?, ?)', cid, ctx.orgId, i.name, i.color ?? colorFor(i.name), i.logo ?? null, i.contact ?? null);
    ctx.emit('client.created', `${ctx.actor.name} added the client ${i.name}`, { severity: 'info', resource: cid });
    return { clientId: cid, name: i.name, undo: { tool: 'client.remove', input: { clientId: cid }, label: 'Remove it' } };
  },
});

defineTool({
  name: 'client.update', title: 'Change a client', risk: 'write', action: 'client_write',
  description: 'Change a client’s name, colour, logo picture or contact name (null clears one).',
  input: z.object({ clientId: CLIENT_ID, name: NAME.optional(), ...fields }),
  run(ctx, i) {
    const c = clientRow(ctx.db, ctx.orgId, i.clientId);
    if (i.name && taken(ctx.db, ctx.orgId, i.name, c.id)) throw new Unit7Error('exists', `There’s already a client called ${i.name}.`, 409);
    const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
    run(ctx.db, 'UPDATE clients SET name = ?, color = ?, logo = ?, contact = ? WHERE id = ?', i.name ?? c.name, pick(i.color, c.color), pick(i.logo, c.logo), pick(i.contact, c.contact), c.id);
    return { clientId: c.id, name: i.name ?? c.name };
  },
});

defineTool({
  name: 'client.remove', title: 'Remove a client', risk: 'destructive', action: 'client_delete', peopleOnly: true,
  description: 'Remove a client: its products, projects and things become the person’s own again (nothing at any provider changes), and its status page is taken down. People only.',
  input: z.object({ clientId: CLIENT_ID }),
  async run(ctx, i) {
    const c = clientRow(ctx.db, ctx.orgId, i.clientId);
    if (json<{ on?: boolean; leftover?: unknown }>(c.status, {}).on) {
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'client.status_link', { clientId: c.id, enabled: false }, { reason: `removing the client ${c.name}` });
      if (r.status !== 'ok') throw new Unit7Error('status_page', `Couldn’t take ${c.name}’s status page down first: ${r.status === 'error' ? r.error.message : r.status}. Try again.`, 409);
    }
    const n = get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM client_members WHERE client_id = ?', c.id)!.n;
    run(ctx.db, 'DELETE FROM clients WHERE id = ? AND org_id = ?', c.id, ctx.orgId);
    ctx.emit('client.removed', `${ctx.actor.name} removed the client ${c.name}; its ${n} thing${n === 1 ? ' is' : 's are'} your own again`, { severity: 'info' });
    return { removed: c.name, released: n };
  },
});

defineTool({
  name: 'client.assign', title: 'Move something to a client', risk: 'write', action: 'client_write',
  description: 'Give a product (grp_…), a Unit7 project (prj_…) or a map thing (ast_…) to a client; clientId null makes it the person’s own again. A thing belongs to one client at most, so it moves from any other; a thing in a product moves with its whole product. Returns how to undo it.',
  input: z.object({ clientId: CLIENT_ID.nullable(), key: z.string().max(40) }),
  run(ctx, i) {
    const own = ownership(ctx.db, ctx.orgId);
    const key = ownerKey(own.ix, i.key);
    const name = key.startsWith('grp_') ? own.ix.groups.get(key)!.name : own.ix.projects.get(key)?.name ?? own.ix.byId.get(key)!.name;
    const before = own.direct.get(key);
    const to = i.clientId ? clientRow(ctx.db, ctx.orgId, i.clientId) : undefined;
    tx(ctx.db, () => {
      if (to) run(ctx.db, 'INSERT INTO client_members (org_id, key, client_id) VALUES (?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET client_id = excluded.client_id', ctx.orgId, key, to.id);
      else run(ctx.db, 'DELETE FROM client_members WHERE org_id = ? AND key = ?', ctx.orgId, key);
      // a product's things follow it: none keeps a client of its own
      if (key.startsWith('grp_')) run(ctx.db, `DELETE FROM client_members WHERE org_id = ? AND key IN (SELECT key FROM group_members WHERE group_id = ?)`, ctx.orgId, key);
    });
    const from = before ? get<{ name: string }>(ctx.db, 'SELECT name FROM clients WHERE id = ?', before)?.name : undefined;
    return { key, name, client: to?.name ?? null, ...(from && from !== to?.name && { from }), ...(key !== i.key && { note: `${name} moved as a whole, so it stays together.` }),
      undo: { tool: 'client.assign', input: { clientId: before ?? null, key }, label: from ? `Give it back to ${from}` : 'Make it yours again' } };
  },
});

// A subdomain per client: one name, one call. It's domain.point underneath (one approval for the whole thing), so a Coolify
// app, an app of Unit7's own or one on a hosted platform all work; a name that already goes somewhere is never taken over.
const clientApps = async (ctx: Ctx, clientId: string) => {
  const { sourceOptions } = await import('../agent/asks.ts');
  const own = ownership(ctx.db, ctx.orgId), mine = own.ids.get(clientId) ?? new Set<string>();
  return { own, all: sourceOptions(ctx.app, ctx.orgId, 'apps').filter((o) => o.use.pointWith), mine: (o: { id: string }) => mine.has(o.id) };
};
const subdomainInput = z.object({
  clientId: CLIENT_ID,
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'one part of a name, like acme'),
  domain: z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'a domain, like example.com'),
  target: z.record(z.string(), z.unknown()).optional().describe('The app: what domain.point takes (a pointWith from ui_choose or a dry run). Left out, the client’s only app.'),
});
defineTool({
  name: 'client.subdomain', title: 'Give a client their own address',
  risk: (i) => (i.target && !i.target.serviceId && !i.target.coolify && !i.target.server ? 'destructive' : 'write'), action: 'dns_write', timeoutMs: 20 * 60_000,
  description: 'Give a client’s app its own address, like acme.example.com, in one call: the app (the client’s only app, or target) gets the name, DNS is written, HTTPS follows, the way domain.point does it, on a Coolify app, an app here or a hosted one. A dry run lists the client’s apps with their target. A name that already goes somewhere is refused, and so is another client’s app.',
  input: subdomainInput,
  async dryRun(ctx, i) {
    const c = clientRow(ctx.db, ctx.orgId, i.clientId), apps = await clientApps(ctx, c.id);
    return { client: c.name, hostname: `${i.name}.${i.domain}`, apps: apps.all.filter(apps.mine).map((o) => ({ id: o.id, label: o.label, target: o.use.pointWith })) };
  },
  async run(ctx, i) {
    const c = clientRow(ctx.db, ctx.orgId, i.clientId), hostname = `${i.name}.${i.domain}`;
    assertHostname(hostname);
    const apps = await clientApps(ctx, c.id);
    let target = i.target;
    if (!target) {
      const mine = apps.all.filter(apps.mine);
      if (mine.length !== 1) throw new Unit7Error('which_app', mine.length ? `${c.name} has ${mine.length} apps (${mine.map((o) => o.label).join(', ')}). Say which one with target.` : `${c.name} has no app Unit7 can give an address yet. Give target, or assign the app to them first.`, 400);
      target = mine[0]!.use.pointWith as Record<string, unknown>;
    }
    const app = apps.all.find((o) => JSON.stringify(o.use.pointWith) === JSON.stringify(target));
    const owner = app && apps.own.clientOf(app.id);
    if (owner && owner !== c.id) throw new Unit7Error('other_client', `${app!.label} belongs to another client.`, 409);
    const point = getTool('domain.point')!;
    const input = point.input.safeParse({ hostname, ...target });
    if (!input.success) throw new Unit7Error('invalid_input', 'Say which app this address should open: target is what domain.point takes.', 400);
    if (get(ctx.db, 'SELECT 1 FROM domains WHERE hostname = ?', hostname)) throw new Unit7Error('domain_taken', `${hostname} already goes somewhere. Pick another name.`, 409);
    const [a, cname] = await Promise.all([dnsDeps.answers(hostname, 'A'), dnsDeps.answers(hostname, 'CNAME')]);
    if (cname.length || a.length) throw new Unit7Error('domain_taken', `${hostname} already points at ${[...cname, ...a].join(', ')}. Pick another name.`, 409);
    const out = await point.run(ctx, input.data) as Record<string, unknown>;
    ctx.emit('client.subdomain', `${c.name} now has ${hostname}`, { severity: 'success', resource: c.id });
    return { client: c.name, ...out };
  },
});

defineTool({
  name: 'client.list', title: 'Clients', risk: 'read', action: 'read',
  description: 'Every client with its products, projects and things (counts, and ids for filtering pages to one client), its health (its worst thing), this month’s cost and whether its status page is on; and what’s the person’s own.',
  input: z.object({}),
  run: (ctx) => listClients(ctx.db, ctx.orgId),
});

defineTool({
  name: 'client.costs', title: 'What each client costs', risk: 'read', action: 'read',
  description: 'This month’s cost per client: each server’s price split by what runs on it (from its last usage reading), and provider costs from the last budget check matched to things by name. Lines Unit7 can’t tie to a client are listed as not assigned. Returns a CSV to copy for invoicing (one client, or everyone).',
  input: z.object({ clientId: CLIENT_ID.optional() }),
  run(ctx: Ctx, i) {
    const own = ownership(ctx.db, ctx.orgId);
    const all_ = costLines(ctx.db, ctx.orgId, [], own);
    const names = new Map(all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM clients WHERE org_id = ?', ctx.orgId).map((c) => [c.id, c.name]));
    if (i.clientId && !names.has(i.clientId)) throw notFound('That client');
    const lines = i.clientId ? all_.filter((l) => l.clientId === i.clientId) : all_;
    const month = now().slice(0, 7);
    const say = (cid?: string) => (cid ? names.get(cid) ?? 'A client' : 'Your own');
    return { month, lines: lines.map((l) => ({ ...l, client: say(l.clientId) })), total: totals(lines),
      perClient: [...names].map(([cid, name]) => ({ clientId: cid, name, total: totals(all_.filter((l) => l.clientId === cid)) })),
      unassigned: totals(all_.filter((l) => !l.clientId)), csv: costsCsv(lines, say, month),
      basis: 'Server shares split each server’s monthly price by what runs on it (half memory, half CPU, from its last reading). An allocation, not a bill.' };
  },
});
