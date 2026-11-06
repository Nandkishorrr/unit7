// The cost radar: one monthly number across everything a person pays for, and where it goes. It reads what Unit7
// already knows and never asks a provider by itself (budget.check does that, daily): the costs it last read (Vercel,
// Railway, DigitalOcean, Heroku, Cloudflare, Hostinger, AWS and Azure spend, your own entries), each server's monthly
// price, and the last usage reading of each server, which splits its price between the projects on it. Then "Save $N"
// ideas, each from a real signal (no deploys and no visits, a server that's mostly idle, two of the same database,
// old images), with one action a person takes. Nothing here buys, resizes or deletes anything by itself.
import { all, get, now, run, type DB } from '../db.ts';
import { budgetOf, forecast, fxRates, type CostKind } from '../tools/budget.ts';
import { lastXray } from '../tools/xray.ts';
import { readPoints } from '../sentinel/usage.ts';
import { archivedKeys, archivedAssets } from '../archive.ts';
import { gather, findingsFor } from '../discovery/findings.ts';
import { clientOfKey } from '../organize/clients.ts';
import { inUse } from '../tools/lifecycle.ts';
import { keptMarks } from '../kept.ts';

export interface Line { key: string; name: string; amount: number; estimate?: boolean; provider?: string; projectId?: string; note?: string }
export interface LifecycleItem { key: string; name: string; kind: string; provider?: string; projectId?: string }
export type SaveAction = { kind: 'lifecycle'; item: LifecycleItem } | { kind: 'tool'; tool: string; input: Record<string, unknown>; label: string } | { kind: 'open'; href: string; label: string };
export interface Saving { id: string; kind: 'idle' | 'oversized' | 'duplicate' | 'cleanup'; title: string; detail: string; amount: number | null; action: SaveAction }
export interface Radar {
  currency: string; month: string; total: number; soFar: number; lastMonth: number | null; budget: number | null; estimate: boolean;
  byProvider: Line[]; byProject: Line[]; byClient: Line[]; savings: Saving[]; save: number; notes: string[]; checkedAt: string | null;
}
type Fx = (from: string[], to: string) => Promise<Record<string, number>>;

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86400_000;
const DBS = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];

interface UsageSlice { id: string; name: string; share: number; system?: boolean }
interface Usage { projects?: UsageSlice[]; server?: { memTotal?: number }; at?: string }

// how a server's monthly price splits between projects: the last usage reading's shares (half memory, half CPU)
function splitServer(db: DB, orgId: string, s: { id: string; name: string }, monthly: number, byName: Map<string, { id: string; name: string }>): Line[] {
  const u = lastXray<Usage>(db, orgId, s.id, 'usage')?.data;
  const slices = (u?.projects ?? []).filter((p) => !p.system && p.share > 0);
  if (!slices.length) return [{ key: `server:${s.id}`, name: `${s.name} (not split yet)`, amount: monthly, estimate: true, note: 'Open the server and check what each project uses to split it.' }];
  const lines = slices.map((p): Line => {
    const prj = byName.get(p.name.toLowerCase());
    return { key: prj?.id ?? `xray:${s.id}:${p.id}`, name: prj?.name ?? p.name, amount: monthly * p.share, estimate: true, ...(prj && { projectId: prj.id }) };
  });
  const rest = monthly - lines.reduce((n, l) => n + l.amount, 0);
  if (rest > 0.005) lines.push({ key: 'room', name: 'Spare room on your servers', amount: rest, estimate: true });
  return lines;
}

const merge = (lines: Line[]) => {
  const m = new Map<string, Line>();
  for (const l of lines) { const x = m.get(l.key); m.set(l.key, x ? { ...x, amount: x.amount + l.amount, estimate: x.estimate || l.estimate } : { ...l }); }
  return [...m.values()].map((l) => ({ ...l, amount: r2(l.amount) })).filter((l) => l.amount > 0).sort((a, b) => b.amount - a.amount);
};

export async function costRadar(ctx: { db: DB; orgId: string }, o: { fx?: Fx; at?: Date } = {}): Promise<Radar> {
  const { db, orgId } = ctx;
  const at = o.at ?? new Date();
  const b = budgetOf(ctx);
  const notes: string[] = [];
  const costs = all<{ provider: string; account: string; label: string; amount: number; kind: CostKind; at: string }>(db, 'SELECT provider, account, label, amount, kind, at FROM costs WHERE org_id = ?', orgId);
  const checkedAt = costs.map((c) => c.at).sort().at(-1) ?? null;
  const servers = all<{ id: string; name: string; monthly_price: number | null; price_currency: string | null; price_source: string | null; provider_ref: string | null }>(db,
    'SELECT id, name, monthly_price, price_currency, price_source, provider_ref FROM servers WHERE org_id = ? AND monthly_price IS NOT NULL', orgId);
  const fx = await (o.fx ?? fxRates)(servers.map((s) => s.price_currency ?? 'USD'), b.currency).catch(() => ({ [b.currency]: 1 }) as Record<string, number>);
  const priced = servers.flatMap((s) => {
    const rate = fx[s.price_currency ?? 'USD'];
    if (!rate) { notes.push(`${s.name}: no exchange rate for ${s.price_currency}, left out`); return []; }
    const provider = s.price_source === 'Hostinger' || /^hostinger:/.test(s.provider_ref ?? '') ? 'hostinger' : s.provider_ref?.split(':')[0] || 'servers';
    return [{ ...s, provider, monthly: s.monthly_price! * rate }];
  });
  // a Hostinger VPS's price is one of the Hostinger plans budget.check already read: counted once
  const covered = (s: { provider: string }) => s.provider === 'hostinger' && costs.some((c) => c.provider === 'hostinger');

  // by provider: what each costs this month (usage so far is projected over the month: an estimate)
  const providers = new Map<string, { amount: number; kind: CostKind }[]>();
  for (const c of costs) providers.set(c.provider, [...(providers.get(c.provider) ?? []), { amount: c.amount, kind: c.kind }]);
  for (const s of priced) if (!covered(s)) providers.set(s.provider, [...(providers.get(s.provider) ?? []), { amount: s.monthly, kind: 'monthly' }]);
  const byProvider = [...providers].map(([provider, list]): Line => ({ key: provider, provider, name: provider, amount: r2(forecast(list, at).forecast), estimate: list.some((x) => x.kind === 'spent') }))
    .filter((l) => l.amount > 0).sort((a, z) => z.amount - a.amount);
  const everything = [...providers.values()].flat();
  const f = forecast(everything, at);

  // by project: each server split by its last usage reading; provider bills that aren't one server stay shared
  const projects = all<{ id: string; name: string; slug: string; created_at: string }>(db, 'SELECT id, name, slug, created_at FROM projects WHERE org_id = ?', orgId);
  const byName = new Map(projects.flatMap((p) => [[p.name.toLowerCase(), p], [p.slug.toLowerCase(), p]] as const));
  const serverLines = priced.flatMap((s) => splitServer(db, orgId, s, s.monthly, byName));
  const hostingerServers = priced.filter(covered).reduce((n, s) => n + s.monthly, 0);
  const shared = byProvider.reduce((n, l) => n + l.amount, 0) - priced.filter((s) => !covered(s)).reduce((n, s) => n + s.monthly, 0) - hostingerServers;
  const byProject = merge([...serverLines, ...(shared > 0.005 ? [{ key: 'shared', name: 'Accounts not tied to one project', amount: shared, estimate: everything.some((x) => x.kind === 'spent') }] : [])]);
  // the same project name on two servers (a live box and a test box) says which server
  const named = new Map<string, number>();
  for (const l of byProject) named.set(l.name, (named.get(l.name) ?? 0) + 1);
  const serverName = new Map(priced.map((s) => [s.id, s.name]));
  for (const l of byProject) if ((named.get(l.name) ?? 0) > 1 && l.key.startsWith('xray:')) l.name = `${l.name} · ${serverName.get(l.key.split(':')[1]!) ?? 'server'}`;

  // by client (client spaces): a project's client, everything else is the person's own
  let byClient: Line[] = [];
  try {
    // whose a project is: given to a client itself, or through the product it's in (organize/clients.ts)
    const names = new Map(all<{ id: string; name: string }>(db, 'SELECT id, name FROM clients WHERE org_id = ?', orgId).map((r) => [r.id, r.name]));
    const whose = names.size ? clientOfKey(db, orgId) : undefined;
    if (whose) byClient = merge(byProject.map((l) => { const c = l.projectId ? names.get(whose(l.projectId) ?? '') : undefined; return { key: c ? `client:${c}` : 'own', name: c || 'Your own', amount: l.amount, estimate: l.estimate }; }));
  } catch { /* client spaces aren't there yet */ }

  // this month against last month (Unit7 keeps each month's total from the first time it looks)
  const month = at.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const last = get<{ total: number; currency: string }>(db, 'SELECT total, currency FROM cost_months WHERE org_id = ? AND month = ?', orgId, prev);
  const total = r2(f.forecast);
  run(db, `INSERT INTO cost_months (org_id, month, total, currency, data, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, month) DO UPDATE SET total = excluded.total,
    currency = excluded.currency, data = excluded.data, at = excluded.at`, orgId, month, total, b.currency, JSON.stringify({ byProvider }), now());

  const share = new Map(byProject.filter((l) => l.projectId).map((l) => [l.projectId!, l.amount]));
  const savings = savingsFor(db, orgId, at.getTime(), { share, priced });
  if (!costs.length) notes.push('Unit7 hasn’t read your providers’ bills yet: check costs once to fill this in.');
  if (byProject.some((l) => l.estimate)) notes.push('A project’s part of a server is its share of the server’s use right now: an estimate, not a bill.');
  return {
    currency: b.currency, month, total, soFar: r2(f.soFar), lastMonth: last && last.currency === b.currency ? r2(last.total) : null, budget: b.monthly,
    estimate: everything.some((x) => x.kind === 'spent') || byProject.some((l) => l.estimate), byProvider, byProject, byClient, savings,
    save: r2(savings.reduce((n, s) => n + (s.amount ?? 0), 0)), notes, checkedAt,
  };
}

// --- "Save $N": each from something Unit7 measured; a person takes the action --------------------------------------
export function savingsFor(db: DB, orgId: string, at: number, o: { share: Map<string, number>; priced: { id: string; name: string; monthly: number }[] }): Saving[] {
  const out: Saving[] = [];
  const off = archivedKeys(db, orgId);
  const memo = new Map<string, unknown>();

  // a project nobody works on or visits: no deploy in 90 days, no visits in 30
  for (const p of all<{ id: string; name: string; created_at: string }>(db, 'SELECT id, name, created_at FROM projects WHERE org_id = ?', orgId)) {
    if (off.has(p.id)) continue;
    const lastDeploy = get<{ t: string | null }>(db, `SELECT max(coalesce(d.finished_at, d.started_at)) t FROM deployments d JOIN services s ON s.id = d.service_id WHERE s.project_id = ?`, p.id)?.t;
    const since = lastDeploy ?? p.created_at;
    if (Date.parse(since) > at - 90 * DAY) continue;
    const hosts = all<{ hostname: string }>(db, 'SELECT d.hostname FROM domains d JOIN services s ON s.id = d.service_id WHERE s.project_id = ?', p.id).map((h) => h.hostname);
    const visits = hosts.length ? get<{ n: number }>(db, `SELECT coalesce(sum(requests), 0) n FROM traffic WHERE hostname IN (${hosts.map(() => '?').join(',')}) AND at > ?`, ...hosts, new Date(at - 30 * DAY).toISOString())!.n : 0;
    if (visits > 0) continue;
    // marked in use (asset.keep), or another sign of use: an API other servers call, apps that use it, its logs, jobs…
    if (inUse({ db, orgId }, p.id, at, memo)) continue;
    const days = Math.floor((at - Date.parse(since)) / DAY);
    out.push({ id: `idle:${p.id}`, kind: 'idle', title: `${p.name} looks unused`, amount: o.share.get(p.id) ?? null,
      detail: `${lastDeploy ? `No deploy in ${days} days` : `Never deployed in ${days} days`} and no visits in 30 days. Archive it so Unit7 stops watching it, or delete it if you’re done with it.`,
      action: { kind: 'lifecycle', item: { key: p.id, name: p.name, kind: 'project', projectId: p.id } } });
  }

  // a server that's mostly idle for 30 days: a smaller plan would likely do (people pick and buy plans, never Unit7)
  for (const s of o.priced) {
    const days = readPoints(db, s.id, '1d', at - 30 * DAY, 'server').get('server')?.points ?? [];
    const memTotal = lastXray<Usage>(db, orgId, s.id, 'usage')?.data.server?.memTotal ?? lastXray<{ server?: { memTotal?: number } }>(db, orgId, s.id)?.data.server?.memTotal;
    if (days.length < 21 || !memTotal) continue;
    const cpu = Math.max(...days.map((p) => p.cpuMax ?? p.cpu ?? 0)), mem = Math.max(...days.map((p) => p.memMax ?? p.mem ?? 0)) / memTotal;
    if (cpu >= 25 || mem >= 0.35) continue;
    out.push({ id: `oversized:${s.id}`, kind: 'oversized', title: `${s.name} is bigger than it needs to be`, amount: r2(s.monthly / 2),
      detail: `Its busiest in 30 days: ${Math.round(cpu)}% CPU and ${Math.round(mem * 100)}% memory. A plan half the size would likely do and usually costs about half. You pick the plan at your provider; Unit7 never changes it.`,
      action: { kind: 'open', href: `/servers/${s.id}`, label: 'See the server' } });
  }

  // two of the same database: in one environment here, or the same name at two providers
  for (const g of all<{ environment_id: string; kind: string; n: number; names: string; project_id: string; env: string; project: string }>(db,
    `SELECT s.environment_id, s.kind, count(*) n, group_concat(s.name, ', ') names, s.project_id, e.name env, p.name project FROM services s JOIN environments e ON e.id = s.environment_id
     JOIN projects p ON p.id = s.project_id WHERE s.org_id = ? AND s.kind IN (${DBS.map(() => '?').join(',')}) GROUP BY s.environment_id, s.kind HAVING count(*) > 1`, orgId, ...DBS)) {
    if (off.has(g.project_id)) continue;
    out.push({ id: `duplicate:${g.environment_id}:${g.kind}`, kind: 'duplicate', title: `${g.project} ${g.env} has ${g.n} ${g.kind} databases`, amount: null,
      detail: `${g.names}. If one isn’t used, removing it frees its share of the server.`, action: { kind: 'open', href: `/projects/${g.project_id}`, label: 'See the project' } });
  }
  const gone = archivedAssets(db, orgId);
  const kept = keptMarks(db, orgId);
  const byName = new Map<string, { id: string; provider: string; name: string }[]>();
  for (const a of all<{ id: string; provider: string; name: string }>(db, `SELECT id, provider, name FROM assets WHERE org_id = ? AND kind = 'database' AND provider != 'unit7'`, orgId)) {
    if (gone.has(a.id) || kept.has(a.id)) continue; // one a person marked in use is never the "old copy"
    const k = a.name.trim().toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), a]);
  }
  for (const [, list] of byName) {
    if (new Set(list.map((a) => a.provider)).size < 2) continue;
    out.push({ id: `duplicate:${list[0]!.name.toLowerCase()}`, kind: 'duplicate', title: `${list[0]!.name} is at ${[...new Set(list.map((a) => a.provider))].length} providers`, amount: null,
      detail: 'The same database name in more than one place is often an old copy. If one is left over, archive or delete it.', action: { kind: 'lifecycle', item: { key: list.at(-1)!.id, name: list.at(-1)!.name, kind: 'database', provider: list.at(-1)!.provider } } });
  }

  // old images, build cache and volumes nothing uses: the findings engine's own cleanup, one click (or the server page)
  for (const s of all<{ id: string; name: string }>(db, 'SELECT id, name FROM servers WHERE org_id = ?', orgId)) {
    for (const w of findingsFor(gather(db, orgId, s)).filter((x) => x.bucket === 'waste' && /^xray:(reclaim|volume):/.test(x.id))) {
      const fix = w.fix;
      out.push({ id: `cleanup:${w.id}`, kind: 'cleanup', title: `${s.name}: ${w.title}`, detail: w.detail, amount: null,
        action: fix && 'tool' in fix && fix.safe ? { kind: 'tool', tool: fix.tool, input: fix.input as Record<string, unknown>, label: fix.label ?? 'Clean up' } : { kind: 'open', href: `/servers/${s.id}`, label: 'Look first' } });
    }
  }
  return out.sort((a, z) => (z.amount ?? 0) - (a.amount ?? 0));
}
