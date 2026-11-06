// The server page's data shaping: an X-ray (server.xray), a usage reading (server.usage) and disk sizes in,
// what the page shows out (storage bar slices, project cards, words). No runtime imports on purpose:
// test/server-page.test.ts loads this file under plain Node.

export type HealthStatus = 'ok' | 'warn' | 'bad' | 'off';
export interface Health { status: HealthStatus; reason?: string }
export type Trust = 'seen' | 'understood' | 'managed' | 'owned';
export interface XPart {
  id: string; kind: 'app' | 'database' | 'service' | 'volume' | 'job' | 'domain'; name: string; owner: string; trust: Trust; project?: string;
  product?: { id: string; name: string }; image?: string; state?: string; health?: Health; restarts?: number; containers?: string[];
  internals?: { name: string; image: string; state: string }[]; ports?: { port: number; proto: string; ip: string; public: boolean }[];
  hosts?: string[]; envKeys?: string[]; uses?: string[]; volumes?: string[]; engine?: string; version?: string; exposed?: boolean; dir?: string;
  git?: { dir: string; remote?: string; last?: string; dirty: number }; when?: string; schedule?: string; command?: string; user?: string; via?: string; target?: string;
  coolify?: { uuid: string; type: string; labels: string; environment?: string; repo?: string; branch?: string; buildPack?: string; status?: string; lastDeploy?: { uuid?: string; status?: string; at?: string; commit?: string } };
  compose?: { project: string; service?: string; workingDir?: string }; pm2?: { mode?: string; instances?: number }; unit?: string;
}
export interface XProject {
  id: string; name: string; owner: string; trust: Trust; how: string; confidence: number; system?: boolean; environments?: string[];
  parts: string[]; health: Health; domains: string[]; dir?: string; git?: { dir: string; remote?: string; last?: string; dirty: number }; coolify?: { uuid?: string };
}
export interface Xray {
  serverId: string; serverName: string; at: string; ms?: number;
  server: { os?: string; cpus?: number; memTotal?: number; memAvailable?: number; diskTotal?: number; diskUsed?: number; load?: string; docker?: string };
  paas: { id: string; name: string }[];
  coolify?: { version?: string; dashboard?: string; apiPort: number; sentinel: boolean; proxy: boolean; connected?: string; abilities?: string[] };
  projects: XProject[]; parts: XPart[]; loose: string[]; ports: { port: number; ip: string; public: boolean; process?: string; part?: string; proto: string; blockedBy?: 'unit7' }[];
  disk?: { images?: number; imagesUnused?: number; buildCache?: number; reclaimable?: number }; summary: string; notes: string[];
  stale?: { since: string; why: string }; next?: string; trend?: { at: string; diskUsed: number }[];
}
export interface Slice { id: string; name: string; system?: boolean; cpu: number; mem: number; disk?: number; share: number; cost?: number }
export interface Usage {
  at: string; source: string; method: string; server: { cpus: number; cpu: number; memTotal: number; memUsed: number; diskTotal: number; diskUsed: number };
  projects: Slice[]; loose: Slice; system: Slice; free: { mem: number; disk: number; cpu: number; cost?: number }; reclaimable?: number;
  disk?: { measuredAt: string; method: string }; price?: { monthly: number; currency: string; source: string; basis: string }; stale?: { since: string; why: string };
}

// --- numbers ---
// disks and memory as the server reports them: decimal units ("9.8 GB", "610 MB")
export function size(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Math.max(0, n);
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i < 2 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${u[i]}`;
}
const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', AUD: 'A$', CAD: 'C$' };
export function money(n: number | null | undefined, currency = 'USD'): string {
  if (n == null || !Number.isFinite(n)) return '–';
  const s = SYMBOL[currency] ?? `${currency} `;
  return `${s}${n % 1 ? n.toFixed(2) : String(n)}`;
}
// "2 h ago" style, for the stale line
export function hoursAgo(iso: string, now = Date.now()): string {
  const m = Math.max(0, (now - Date.parse(iso)) / 60_000);
  if (m < 2) return 'a minute ago';
  if (m < 60) return `${Math.round(m)} minutes ago`;
  if (m < 36 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

// --- who runs what, in words ---
export const OWNER_NAME: Record<string, string> = {
  coolify: 'Coolify', dokploy: 'Dokploy', caprover: 'CapRover', dokku: 'Dokku', easypanel: 'Easypanel', kamal: 'Kamal', portainer: 'Portainer',
  compose: 'Docker Compose', pm2: 'PM2', systemd: 'the system', unit7: 'Unit7', unmanaged: 'nobody',
};
// the logo for an owner (compose is Docker's, systemd is Linux's); unmanaged has none
export const ownerLogo = (owner: string): string | undefined => ({ compose: 'docker', systemd: 'linux', unmanaged: undefined } as Record<string, string | undefined>)[owner] ?? owner;
export const TRUST: Record<Trust, { word: string; tip: string }> = {
  seen: { word: 'Seen', tip: 'Unit7 found it but doesn’t know yet who runs it. It only suggests changes here.' },
  understood: { word: 'Understood', tip: 'Unit7 knows what it is and who runs it. Connect that tool so Unit7 can manage it for you.' },
  managed: { word: 'Managed', tip: 'Unit7 manages it through the tool that runs it, so that tool stays in charge.' },
  owned: { word: 'Owned', tip: 'Unit7 built it and runs it.' },
};
export type Tone = 'ok' | 'warn' | 'bad' | 'idle';
export const healthTone = (h?: Health): Tone => (!h ? 'idle' : h.status === 'off' ? 'idle' : h.status);
export function healthWords(h?: Health): string {
  if (!h) return 'Not checked';
  // a reason that starts with a name keeps the name as it is ("crm-web ran out of memory")
  if (h.reason) return /^(starting|stopped|nothing|restarted|crashed)\b/.test(h.reason) ? h.reason.charAt(0).toUpperCase() + h.reason.slice(1) : h.reason;
  return h.status === 'ok' ? 'Healthy' : h.status === 'off' ? 'Stopped' : h.status === 'bad' ? 'Down' : 'Needs a look';
}

// --- a project, as its card shows it ---
export interface Card {
  id: string; name: string; owner: string; trust: Trust; system?: boolean; health: Health; environment?: string;
  parts: XPart[]; domains: string[]; logos: string[]; what: string;
  main?: XPart;               // what the card's Restart / Deploy / Logs act on: its app, else its first service or database
  mem?: number; disk?: number; cost?: number; memShare?: number;
}
const logoOfPart = (p: XPart): string | undefined => p.product?.id === 'postgresql' ? 'postgres' : p.product?.id ?? (p.engine === 'postgres' ? 'postgres' : p.engine);
export const partLogo = (p: XPart): string => logoOfPart(p) ?? (p.kind === 'app' ? (p.owner === 'unit7' ? 'unit7' : 'docker') : ownerLogo(p.owner) ?? 'docker');
const ENGINE: Record<string, string> = { postgres: 'Postgres', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', redis: 'Redis', clickhouse: 'ClickHouse' };
export function partWhat(p: XPart): string {
  if (p.product?.id === 'supabase') return 'Supabase';
  if (p.kind === 'database') return p.engine ? `${ENGINE[p.engine] ?? p.engine}${p.version ? ` ${p.version}` : ''}` : p.product?.name ?? 'Database';
  if (p.product) return p.product.name;
  return p.kind === 'app' ? 'App' : p.kind === 'service' ? 'Service' : p.kind === 'job' ? 'Scheduled job' : p.kind === 'volume' ? 'Stored data' : 'Domain';
}
// "App + Supabase", "2 apps + Postgres"
export function whatsIn(parts: XPart[]): string {
  const apps = parts.filter((p) => p.kind === 'app' && !p.product);
  const named = parts.filter((p) => (p.kind === 'app' && p.product) || p.kind === 'database' || p.kind === 'service');
  const bits = [apps.length ? (apps.length === 1 ? 'App' : `${apps.length} apps`) : '', ...[...new Set(named.map((p) => (p.kind === 'database' && p.product?.id !== 'supabase' ? (ENGINE[p.engine ?? ''] ?? p.product?.name ?? 'Database') : partWhat(p))))]].filter(Boolean);
  return bits.slice(0, 3).join(' + ') || (parts.some((p) => p.kind === 'job') ? 'Scheduled jobs' : parts.some((p) => p.kind === 'volume') ? 'Stored data' : 'Nothing running');
}

export function projectCards(x: Xray, u?: Usage | null): Card[] {
  const byId = new Map(x.parts.map((p) => [p.id, p]));
  return x.projects.map((pr) => {
    const parts = pr.parts.map((id) => byId.get(id)).filter(Boolean) as XPart[];
    const run = parts.filter((p) => p.kind !== 'domain' && p.kind !== 'volume');
    const slice = u?.projects.find((s) => s.id === pr.id);
    const main = run.find((p) => p.kind === 'app') ?? run.find((p) => p.kind === 'service') ?? run.find((p) => p.kind === 'database');
    const logos = [...new Set(run.filter((p) => p.kind !== 'job').map(partLogo))].slice(0, 4);
    return {
      id: pr.id, name: pr.name, owner: pr.owner, trust: pr.trust, system: pr.system, health: pr.health, environment: pr.environments?.join(', '),
      parts, domains: pr.domains, logos, what: whatsIn(run), main,
      ...(slice && { mem: slice.mem, disk: slice.disk, cost: slice.cost, memShare: u!.server.memTotal ? slice.mem / u!.server.memTotal : undefined }),
    };
  }).sort((a, b) => +!!a.system - +!!b.system || rank(a) - rank(b) || (b.mem ?? 0) - (a.mem ?? 0) || a.name.localeCompare(b.name));
}
const RANK: Record<HealthStatus, number> = { bad: 0, warn: 1, ok: 2, off: 3 };
const rank = (c: Card) => RANK[c.health.status] ?? 2;

// --- the storage bar: a slice per project, then "not part of a project", the system, what can be cleaned up, free room ---
export interface Seg { id: string; name: string; value: number; kind: 'project' | 'loose' | 'system' | 'clean' | 'free'; color: number }
export interface Bar { total: number; used: number; segs: Seg[]; free: number; clean?: number; perProject: boolean }
// a stable color per project: the slot follows the project (its place among the projects, by id), never its size
export function colorSlots(x: Xray): Map<string, number> {
  return new Map(x.projects.filter((p) => !p.system).map((p) => p.id).sort().map((id, i) => [id, i % 8]));
}
export function storageBar(u: Usage, metric: 'mem' | 'disk', slots: Map<string, number>): Bar {
  const total = metric === 'mem' ? u.server.memTotal : u.server.diskTotal;
  const used = metric === 'mem' ? u.server.memUsed : u.server.diskUsed;
  const free = Math.max(0, total - used);
  const val = (s: Slice) => (metric === 'mem' ? s.mem : s.disk ?? 0);
  const perProject = metric === 'mem' || !!u.disk;
  if (!perProject) return { total, used, free, perProject, segs: [{ id: 'used', name: 'In use', value: used, kind: 'system', color: -1 }, { id: 'free', name: 'Free', value: free, kind: 'free', color: -1 }] };
  const own = u.projects.filter((s) => !s.system && val(s) > 0).sort((a, b) => val(b) - val(a));
  const counted = own.reduce((n, s) => n + val(s), 0) + val(u.loose);
  const clean = metric === 'disk' ? Math.min(u.reclaimable ?? 0, Math.max(0, used - counted)) : 0;
  // the system slice is the rest of what's used: the server itself, Coolify and the like, and anything not measured
  const system = Math.max(0, used - counted - clean);
  const segs: Seg[] = [
    ...own.map((s): Seg => ({ id: s.id, name: s.name, value: val(s), kind: 'project', color: slots.get(s.id) ?? 0 })),
    ...(val(u.loose) > 0 ? [{ id: 'loose', name: 'Not part of a project', value: val(u.loose), kind: 'loose', color: -1 } as Seg] : []),
    ...(system > 0 ? [{ id: 'system', name: u.projects.some((s) => s.system && /coolify/i.test(s.name)) ? 'Coolify and system' : 'System', value: system, kind: 'system', color: -1 } as Seg] : []),
    ...(clean > 0 ? [{ id: 'clean', name: 'Can be cleaned up', value: clean, kind: 'clean', color: -1 } as Seg] : []),
    { id: 'free', name: 'Free', value: free, kind: 'free', color: -1 },
  ];
  return { total, used, free, perProject, segs, ...(clean > 0 && { clean }) };
}

// --- "full in about 5 months": only from at least three days of measurements that show the disk growing ---
export function fullIn(trend: { at: string; diskUsed: number }[] | undefined, total: number | undefined): string | null {
  const pts = (trend ?? []).filter((p) => Number.isFinite(p.diskUsed) && p.diskUsed > 0).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (pts.length < 2 || !total) return null;
  const a = pts[0]!, b = pts.at(-1)!;
  const days = (Date.parse(b.at) - Date.parse(a.at)) / 86_400_000;
  const perDay = (b.diskUsed - a.diskUsed) / days;
  if (days < 3 || perDay <= 0) return null;
  const left = (total - b.diskUsed) / perDay;
  if (left > 3 * 365) return null; // years away: not worth a warning
  if (left < 14) return `full in about ${Math.max(1, Math.round(left))} day${Math.round(left) === 1 ? '' : 's'}`;
  if (left < 60) return `full in about ${Math.round(left / 7)} weeks`;
  return `full in about ${Math.round(left / 30)} months`;
}

// --- what Coolify can do with the connected token ---
export const canDeploy = (x: Xray) => !!x.coolify?.connected && (x.coolify.abilities ?? []).includes('deploy');
export const canRead = (x: Xray) => !!x.coolify?.connected && (x.coolify.abilities ?? []).some((a) => a === 'read:sensitive');
export const coolifyKind = (p: XPart): 'application' | 'database' | 'service' => (p.coolify?.type === 'database' ? 'database' : p.coolify?.type === 'service' ? 'service' : 'application');

// "full in about 5 months" → "About 5 months left on the disk"
export const roomLeft = (full: string | null) => full && `About ${full.replace(/^full in about /, '')} left on the disk`;

// --- what needs a look, as one list: the watch's risks, waste and tips and the usage jumps open right now --------------
// (shapes only, so this file stays loadable under plain Node: the page fills in the watch's own finding and alert types)
export type Bucket = 'risk' | 'waste' | 'tip';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export interface AFinding { id: string; bucket: Bucket; severity: Severity; title: string; fix?: unknown }
export interface AAlert { id: string; key: string; severity: string; title: string; cleared: string | null; fix?: unknown }
export interface Item<F extends AFinding = AFinding, A extends AAlert = AAlert> { id: string; bucket: Bucket; severity: Severity; title: string; fix?: F['fix'] | A['fix']; finding?: F; alert?: A }
const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const BUCKET_RANK: Record<Bucket, number> = { risk: 0, waste: 1, tip: 2 };
const sevOf = (s: string): Severity => (s === 'warning' ? 'medium' : s in SEV_RANK ? (s as Severity) : 'low');
// most serious first, each said once: an alert that repeats a finding (a traffic flood, a new risk) is that finding
export function attentionItems<F extends AFinding, A extends AAlert>(f: { risks: F[]; waste: F[]; tips: F[] } | null, alerts: A[]): Item<F, A>[] {
  const fs = f ? [...f.risks, ...f.waste, ...f.tips] : [];
  const ids = new Set(fs.map((x) => x.id));
  return [
    ...alerts.filter((a) => !a.cleared && !ids.has(a.key)).map((a): Item<F, A> => ({ id: `alert:${a.id}`, bucket: 'risk', severity: sevOf(a.severity), title: a.title, fix: a.fix, alert: a })),
    ...fs.map((x): Item<F, A> => ({ id: x.id, bucket: x.bucket, severity: x.severity, title: x.title, fix: x.fix, finding: x })),
  ].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]);
}

// --- the header's rings: how loaded each one is, and how that compares with the usual (from the watch's baselines) -------
// calm under 70%, amber from 70, red from 90 (the same steps as every meter in the app)
export type Load = 'none' | 'calm' | 'warm' | 'hot';
export const loadOf = (v: number | null | undefined): Load => (v == null || !Number.isFinite(v) ? 'none' : v >= 90 ? 'hot' : v >= 70 ? 'warm' : 'calm');
export interface RingTrend { dir: 'up' | 'down' | 'flat' | 'learning'; text: string }
export type Usual = number | 'learning';
type TrendPoint = { at: string; cpu: number | null; mem: number | null; disk?: number | null };
// what's usual from the whole server's line in server.trends: CPU and memory from the usual band at this hour of the week
// (memory as a share of the total), the disk as how it moved since the start of the range
export function ringUsual(s: { points: TrendPoint[]; band: { cpu: ({ mid: number | null } | null)[]; mem: ({ mid: number | null } | null)[] } } | undefined, memTotal?: number):
  { cpu?: Usual; mem?: Usual; disk?: RingTrend } {
  const pts = s?.points ?? [];
  const usual = (k: 'cpu' | 'mem', toPct: (n: number) => number): Usual | undefined => {
    const i = pts.findLastIndex((p) => p[k] != null);
    if (i < 0) return undefined;
    const mid = s!.band[k][i]?.mid;
    return mid == null ? 'learning' : toPct(mid);
  };
  const disk = (): RingTrend | undefined => {
    const ds = pts.filter((p) => p.disk != null);
    const a = ds[0], b = ds.at(-1);
    const hours = a && b ? (Date.parse(b.at) - Date.parse(a.at)) / 3_600_000 : 0;
    if (!a || !b || hours < 1) return undefined;
    const g = b.disk! - a.disk!, span = hours >= 20 ? 'the last day' : `the last ${Math.round(hours)} hours`;
    return Math.abs(g) < 200e6 ? { dir: 'flat', text: `Steady over ${span}` } : g > 0 ? { dir: 'up', text: `Grew ${size(g)} over ${span}` } : { dir: 'down', text: `${size(-g)} freed over ${span}` };
  };
  return { cpu: usual('cpu', (n) => n), ...(memTotal && { mem: usual('mem', (n) => (100 * n) / memTotal) }), disk: disk() };
}
// the ring's reading now against the usual, in words (within 3 points counts as usual)
export function vsUsual(now: number | null | undefined, usual: Usual | undefined): RingTrend | null {
  if (usual === 'learning') return { dir: 'learning', text: 'Still learning what’s normal here' };
  if (usual == null || now == null) return null;
  const d = now - usual, u = `usually about ${Math.round(usual)}% at this time`;
  return Math.abs(d) < 3 ? { dir: 'flat', text: `About usual: ${u}` } : { dir: d > 0 ? 'up' : 'down', text: `${d > 0 ? 'Higher' : 'Lower'} than usual: ${u}` };
}
