// The chat cards' data shaping: raw tool outputs in, what a card shows out. No runtime imports on purpose:
// test/cards.test.ts loads this file under plain Node (the map's derived view is passed in).
import type { Asset, Derived } from '../../map/data.ts'; // .ts: the root typecheck resolves it the way Node does

export const LIST_MAX = 6; // a list longer than this shows 6 and "Show all n"

// --- numbers & times ---
export function bytes(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
// "Today 14:17", "Yesterday 09:02", then "4 Oct"
export function when(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '–';
  const d = new Date(iso), day = (x: number) => Math.floor((x - new Date(x).getTimezoneOffset() * 60_000) / 86_400_000);
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const diff = day(now) - day(d.getTime());
  if (diff === 0) return `Today ${hm}`;
  if (diff === 1) return `Yesterday ${hm}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
export const host = (url?: string | null) => (url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// --- which part of the map the question was about ---
export type MapTab = 'domain' | 'app' | 'server' | 'database' | 'account';
export function pickTab(question: string | undefined, counts: Record<MapTab, number>): MapTab {
  const q = (question ?? '').toLowerCase();
  const said: [MapTab, RegExp][] = [['domain', /domain|dns|subdomain|website address|\burl/], ['server', /server|vps|cpu|memory|disk/], ['database', /database|\bdb\b|postgres|mysql|redis|mongo|supabase/], ['account', /account|connected|provider/], ['app', /\bapps?\b|site|deploy|project/]];
  const hit = said.find(([t, re]) => re.test(q) && counts[t] > 0);
  if (hit) return hit[0];
  return (['domain', 'app', 'server', 'database', 'account'] as const).find((t) => counts[t] > 0) ?? 'domain';
}

// --- domains, grouped under their root, each with what it points at ---
export type Tone = 'ok' | 'warn' | 'bad' | 'idle';
export interface Target { id: string; name: string; logo: string; ok: boolean }
export interface DomLine { id?: string; name: string; label: string; tone: Tone; target?: Target; managed?: Managed }
export interface DomGroup { root: string; id?: string; dns?: string; tone: Tone; target?: Target; subs: DomLine[]; https?: boolean; email?: boolean; free: boolean }
export interface Managed { id: string; hostname: string; status: string; tls: string; service: string | null }

const worst = (ts: Tone[]): Tone => (ts.includes('bad') ? 'bad' : ts.includes('warn') ? 'warn' : ts.includes('ok') ? 'ok' : 'idle');
const managedTone = (m?: Managed): Tone | undefined => (!m ? undefined : m.status === 'broken' ? 'bad' : m.status === 'active' ? 'ok' : 'warn');
export const isFree = (root: string) => /(^|\.)(sslip|nip)\.io$/.test(root);

// `label` names an app the way the map does ("acme · web"); `only` keeps just these hostnames (domain.list)
export function domainGroups(v: Derived, label: (a: Asset) => string, managed: Managed[] = [], only?: Set<string>): DomGroup[] {
  const byHost = new Map(managed.map((m) => [m.hostname, m]));
  const line = (d: Asset, root: string): DomLine => {
    const e = v.out(d.id).find((x) => x.kind === 'domain' || x.kind === 'dns');
    const t = e && v.byId.get(e.target);
    const issues = v.issuesOf(d.id);
    const m = byHost.get(d.name);
    const tone: Tone = managedTone(m) ?? (issues.some((i) => i.severity === 'critical') || e?.status === 'misconfigured' ? 'bad'
      : issues.some((i) => i.severity === 'warning') || (d.site && d.site.status !== 'up') ? 'warn' : t ? 'ok' : 'idle');
    return { id: d.id, name: d.name, label: d.name === root ? '@' : d.name.endsWith(`.${root}`) ? d.name.slice(0, -root.length - 1) : d.name, tone, managed: m,
      target: t ? { id: t.id, name: label(t), logo: t.kind === 'domain' ? 'domain' : t.provider === 'unit7' ? 'unit7' : t.provider, ok: e!.status === 'ok' } : undefined };
  };
  const out = v.groups.flatMap((g): DomGroup[] => {
    const subs = g.subs.filter((d) => !only || only.has(d.name)).map((d) => line(d, g.root));
    const own = g.asset && (!only || only.has(g.asset.name)) ? line(g.asset, g.root) : undefined;
    if (only && !own && !subs.length) return [];
    const tls = g.asset?.checks?.tls?.status, mail = g.asset?.checks?.email?.status;
    return [{ root: g.root, id: g.asset?.id, dns: g.dns, subs, target: own?.target, tone: worst([own?.tone ?? 'idle', ...subs.map((s) => s.tone)]),
      https: tls ? tls === 'ok' : own?.managed ? own.managed.tls === 'active' : undefined,
      email: mail ? mail === 'ok' : g.asset && v.issuesOf(g.asset.id).some((i) => i.key.startsWith('email:')) ? false : undefined, free: isFree(g.root) }];
  });
  // a hostname Unit7 serves that the map hasn't seen yet (no sync since) still shows, under its last two labels
  const seen = new Set(out.flatMap((g) => [g.root, ...g.subs.map((s) => s.name)]));
  for (const m of managed.filter((x) => (!only || only.has(x.hostname)) && !seen.has(x.hostname))) {
    const root = m.hostname.split('.').slice(-2).join('.'); // ponytail: last two labels; co.uk-style roots group one level too high
    const g = out.find((x) => x.root === root) ?? (out.push({ root, subs: [], tone: 'idle', free: isFree(root) }), out.at(-1)!);
    const tone = managedTone(m)!;
    g.subs.push({ name: m.hostname, label: m.hostname === root ? '@' : m.hostname.slice(0, -root.length - 1), tone, managed: m });
    g.tone = worst([g.tone, tone]);
  }
  const rank = (g: DomGroup) => (g.free ? 3 : g.tone === 'bad' ? 0 : g.tone === 'warn' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.root.localeCompare(b.root));
}

// --- a deploy as a few plain steps, from its log (or live progress lines) ---
export type StepState = 'done' | 'active' | 'failed' | 'todo';
export interface DeployStep { key: string; label: string; state: StepState; detail?: string; secs?: number }
const MILESTONES: { key: string; label: string; re: RegExp; optional?: boolean }[] = [
  { key: 'code', label: 'Getting your code', re: /^(Packing your folder|Cloning|Commit [0-9a-f]+|Uploading your code|Using image)/i },
  { key: 'build', label: 'Building', re: /^(Building|Writing a Dockerfile|Detected )/i },
  { key: 'migrate', label: 'Updating the database', re: /^(Backing up .* before migrating|Running database migrations|Migrated:|Database is up to date)/i, optional: true },
  { key: 'start', label: 'Starting the new version', re: /^Starting /i },
  { key: 'health', label: 'Checking it works', re: /^(Checking .* (is healthy|keeps running)|Healthy\b|Worker is up)/i },
  { key: 'live', label: 'Switching visitors over', re: /^(Traffic now goes to|No domain set|Worker is running)/i },
];
const STAMP = /^(\d\d):(\d\d):(\d\d) /;
export function deploySteps(lines: string[], end: 'running' | 'ok' | 'failed'): DeployStep[] {
  let at = -1;
  const first: (number | undefined)[] = [], last: (string | undefined)[] = [];
  for (const raw of lines) {
    const m = raw.match(STAMP);
    const text = raw.replace(STAMP, '').trim();
    if (!text) continue;
    const i = MILESTONES.findIndex((s) => s.re.test(text));
    if (i > at) { at = i; if (m) first[i] = +m[1]! * 3600 + +m[2]! * 60 + +m[3]!; }
    if (at >= 0) last[at] = text;
  }
  const cur = Math.max(0, at);
  return MILESTONES.flatMap((s, i): DeployStep[] => {
    if (s.optional && last[i] === undefined) return [];
    const state: StepState = end === 'ok' || i < cur ? 'done' : i > cur ? 'todo' : end === 'failed' ? 'failed' : 'active';
    const next = first.findIndex((t, j) => j > i && t !== undefined);
    const secs = first[i] !== undefined && next > 0 ? (first[next]! - first[i]! + 86_400) % 86_400 : undefined; // past midnight still counts forward
    return [{ key: s.key, label: s.label, state, detail: state === 'active' || state === 'failed' ? last[i]?.slice(0, 120) : undefined, secs }];
  });
}
export const secsWords = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

// --- a server's three numbers, as percentages ---
export function usage(f: { cpus?: number; load?: string; mem_total?: number; mem_available?: number; disk_total?: number; disk_used?: number } | undefined) {
  if (!f) return { cpu: null, mem: null, disk: null };
  const load = Number(String(f.load ?? '').split(' ')[0]);
  return {
    cpu: f.cpus && f.load && Number.isFinite(load) ? Math.min(100, (load / f.cpus) * 100) : null,
    mem: f.mem_total && f.mem_available != null ? ((f.mem_total - f.mem_available) / f.mem_total) * 100 : null,
    disk: f.disk_total && f.disk_used != null ? (f.disk_used / f.disk_total) * 100 : null,
  };
}
// server.list says "46.6 GB of 96.7 GB"
export function diskPct(disk?: string) {
  const m = disk?.match(/([\d.]+) GB of ([\d.]+) GB/);
  return m ? (Number(m[1]) / Number(m[2])) * 100 : null;
}

// --- a database's tables, from psql's or mysql's plain output ---
export function parseTable(text: string): { head: string[]; rows: string[][] } | null {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  const sep = lines.findIndex((l) => /^-+(\+-+)*$/.test(l.trim()));
  if (sep === 1) {
    const cells = (l: string) => l.split('|').map((c) => c.trim());
    return { head: cells(lines[0]!), rows: lines.slice(2).filter((l) => !/^\(\d+ rows?\)$/.test(l.trim())).map(cells) };
  }
  if (lines[0]?.includes('\t')) return { head: lines[0].split('\t'), rows: lines.slice(1).map((l) => l.split('\t')) };
  return null;
}

// --- rows grouped under who they belong to, biggest group first ---
export function groupBy<T>(rows: T[], key: (r: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return [...m.entries()];
}
