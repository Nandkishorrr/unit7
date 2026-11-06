// Keep it fresh · plan and decide. Pure functions only (no database, no network): one weekly batch per app with
// security first, each major version kept on its own, holds and freeze windows, what autonomy lets go by itself, when
// the weekly run happens (the app's quietest hour, never Friday evening), when a security problem can't wait, and the
// words: the 3-line "what changes for you", the weekly report and the streak.
import { SEV_RANK, compare, type Advisory, type Bump, type Eco, type Manager, type Scan, type Severity, type Update } from './detect.ts';
import { clockAt } from '../sentinel/schedule.ts';

export type Mode = 'off' | 'security' | 'minor' | 'all';
export const MODES: Mode[] = ['off', 'security', 'minor', 'all'];
export const DEFAULT_MODE: Mode = 'minor';
export const MODE_WORDS: Record<Mode, string> = { off: 'Off', security: 'Security only', minor: 'Patch & minor', all: 'Everything' };
export type Kind = 'weekly' | 'security' | 'major' | 'image' | 'server' | 'coolify';

export interface Item {
  eco: Eco; name: string; from: string; to: string; bump: Bump; dev?: boolean; manager: Manager; direct: boolean;
  security?: Pick<Advisory, 'id' | 'severity' | 'summary' | 'url' | 'fixed'>[];
}
export interface Hold { id: string; serviceId: string | null; package: string | null; starts: string | null; until: string | null; reason: string | null; by?: string | null }
export interface Planned { kind: Kind; key: string; title: string; items: Item[]; security: number; worst?: Severity; rebuild?: boolean; summary: string[] }
export interface Plan { batches: Planned[]; held: (Item & { why: string })[]; later: Item[]; paused?: { why: string; until: string | null } }

// --- holds ------------------------------------------------------------------------------------------------------------
const live = (h: Hold, now: number) => (!h.until || Date.parse(h.until) > now) && (!h.starts || Date.parse(h.starts) <= now);
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
// a freeze window ("not during my launch week") or a whole app on hold, right now
export function pausedBy(holds: Hold[], serviceId: string | undefined, now = Date.now()): Hold | undefined {
  return holds.find((h) => !h.package && live(h, now) && (h.starts ? !h.serviceId || h.serviceId === serviceId : h.serviceId === serviceId));
}
export const pauseWords = (h: Hold) => `${h.starts ? `You froze updates${h.reason ? ` (${h.reason})` : ''}` : 'Updates are paused for this app'}${h.until ? ` until ${day(h.until)}` : ''}`;
const heldLib = (holds: Hold[], serviceId: string | undefined, name: string, now: number) =>
  holds.find((h) => h.package === name && (!h.serviceId || h.serviceId === serviceId) && live(h, now));

// --- the batches --------------------------------------------------------------------------------------------------------
const worstOf = (items: Item[]): Severity | undefined => items.flatMap((i) => i.security ?? []).sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])[0]?.severity;
const toItem = (u: Update): Item => ({ eco: u.eco, name: u.name, from: u.from, to: u.to, bump: u.bump, manager: u.manager, direct: u.direct, ...(u.dev && { dev: true }),
  ...(u.security?.length && { security: u.security.map(({ id, severity, summary, url, fixed }) => ({ id, severity, summary, url, ...(fixed && { fixed }) })) }) });
// security first (the worst first), then the rest by name
const order = (a: Item, b: Item) => (SEV_RANK[worstOf([b]) ?? 'low'] + (b.security ? 1 : 0)) - (SEV_RANK[worstOf([a]) ?? 'low'] + (a.security ? 1 : 0)) || a.name.localeCompare(b.name);
const majorTitle = (i: Item) => `${nice(i.name)} ${i.from.split('.')[0]} → ${i.to.split('.')[0]}`;

export function planBatches(scan: Pick<Scan, 'updates' | 'base'>, o: { mode: Mode; holds: Hold[]; serviceId?: string; app: string; now?: number }): Plan {
  const now = o.now ?? Date.now();
  const pause = pausedBy(o.holds, o.serviceId, now);
  const held: Plan['held'] = [], later: Item[] = [], weekly = new Map<string, Item>(), majors = new Map<string, Item>();
  for (const u of scan.updates) {
    const it = toItem(u);
    if (o.mode === 'off' && !it.security) { later.push(it); continue; }
    const h = heldLib(o.holds, o.serviceId, it.name, now);
    if (h) { held.push({ ...it, why: `You held ${nice(it.name)}${h.until ? ` until ${day(h.until)}` : ''}${h.reason ? `: ${h.reason}` : ''}` }); continue; }
    if (pause) { held.push({ ...it, why: pauseWords(pause) }); continue; }
    // the toolchain guard: a package manager or the runtime itself never moves to a new major as part of an update
    if (it.bump === 'major' && toolchainLib(it)) { held.push({ ...it, why: `${nice(it.name)} ${it.to.split('.')[0]} changes how every build of the app works, so Unit7 never moves it as part of an update. Pin it in the repo when you’re ready.` }); continue; }
    if (it.bump === 'major') {
      // a major version: on its own, so one that breaks never holds back the rest. Without a security reason only in "Everything".
      if (!it.security && o.mode !== 'all') { later.push(it); continue; }
      const k = `${it.eco}:${it.name}`;
      if (!majors.has(k) || compareTo(majors.get(k)!, it) < 0) majors.set(k, it);
      continue;
    }
    if (o.mode === 'security' && !it.security) { later.push(it); continue; }
    // one version per library: the newest the batch allows
    const k = `${it.eco}:${it.name}`, had = weekly.get(k);
    if (!had || compareTo(had, it) < 0) weekly.set(k, had?.security && !it.security ? { ...it, security: had.security } : it);
  }
  const batches: Planned[] = [];
  const w = [...weekly.values()].sort(order);
  if (w.length) {
    const sec = w.filter((i) => i.security).length;
    batches.push({ kind: 'weekly', key: 'weekly', title: `${w.length} update${w.length === 1 ? '' : 's'}${sec ? ` · ${sec} security` : ''}`, items: w, security: sec, ...(worstOf(w) && { worst: worstOf(w) }), summary: summaryOf(w, o.app) });
  }
  for (const m of [...majors.values()].sort(order)) {
    batches.push({ kind: 'major', key: `major:${m.name}`, title: majorTitle(m), items: [m], security: m.security ? 1 : 0, ...(worstOf([m]) && { worst: worstOf([m]) }), summary: summaryOf([m], o.app) });
  }
  // only the base image moved: rebuild on it (a code update rebuilds on the newest base anyway)
  const base = scan.base.filter((b) => b.newer);
  if (!w.length && base.length && o.mode !== 'off' && !pause) batches.push({ kind: 'image', key: 'image', title: 'A fresh base image', items: [], security: 0, rebuild: true,
    summary: [`${base.map((b) => b.image).join(' and ')} got a newer build${base.length > 1 ? 's' : ''} (usually security fixes in the system underneath).`, `Unit7 rebuilds ${o.app} on it; your code doesn’t change.`, SAFE_LINE] });
  return { batches, held, later, ...(pause && { paused: { why: pauseWords(pause), until: pause.until } }) };
}
const compareTo = (a: Item, b: Item) => compare(a.to, b.to);
// libraries that ARE the toolchain: package managers, Node's own types, Python's build tools
const TOOLCHAIN: Partial<Record<Item['eco'], Set<string>>> = {
  npm: new Set(['pnpm', 'npm', 'yarn', '@yarnpkg/cli', '@yarnpkg/cli-dist', 'corepack', 'bun', 'node', '@types/node']),
  PyPI: new Set(['pip', 'setuptools', 'poetry', 'poetry-core', 'uv', 'pipenv']),
};
export const toolchainLib = (i: Pick<Item, 'eco' | 'name'>) => !!TOOLCHAIN[i.eco]?.has(i.name);
// the security part on its own: what an emergency run releases today (the rest waits for the weekly one)
export const securityOnly = (p: Planned): Planned | undefined => {
  const items = p.items.filter((i) => i.security?.length);
  return items.length ? { ...p, kind: p.kind === 'major' ? 'major' : 'security', key: p.kind === 'major' ? p.key : 'security', title: `${items.length} security fix${items.length === 1 ? '' : 'es'}`, items, security: items.length, summary: summaryOf(items, '') } : undefined;
};

// --- words ----------------------------------------------------------------------------------------------------------------
// "@next/font" → "next/font", "next" → "Next.js": the names people know
const KNOWN: Record<string, string> = { next: 'Next.js', react: 'React', 'react-dom': 'React DOM', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', express: 'Express', fastify: 'Fastify', django: 'Django', flask: 'Flask', fastapi: 'FastAPI', prisma: 'Prisma', '@prisma/client': 'Prisma', typescript: 'TypeScript', vite: 'Vite', tailwindcss: 'Tailwind CSS', astro: 'Astro', remix: 'Remix', laravel: 'Laravel', rails: 'Rails', lodash: 'lodash' };
export const nice = (name: string) => KNOWN[name] ?? KNOWN[name.replace(/^laravel\//, '')] ?? name;
const list = (names: string[], max = 2) => (names.length <= max ? names.join(' and ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);
export const SAFE_LINE = 'Visitors won’t notice: it’s tested on a copy first, released with zero downtime, and undone by itself if anything looks worse.';
export function summaryOf(items: Item[], app: string): string[] {
  const sec = items.filter((i) => i.security?.length), rest = items.filter((i) => !i.security?.length);
  const lines: string[] = [];
  if (sec.length) {
    const worst = worstOf(sec);
    lines.push(sec.length === 1 ? `Fixes ${worst === 'critical' ? 'a serious' : 'a'} security problem in ${nice(sec[0]!.name)}: ${lower(sec[0]!.security![0]!.summary)}.` : `Fixes ${sec.length} security problems (${list(sec.map((i) => nice(i.name)))}).`);
  }
  const major = rest.filter((i) => i.bump === 'major'), small = rest.filter((i) => i.bump !== 'major');
  if (major.length) lines.push(`A new major version of ${list(major.map((i) => nice(i.name)))}: some things may work differently${app ? `, so Unit7 tries it on a copy of ${app} first` : ''}.`);
  if (small.length) lines.push(`${small.length} smaller update${small.length === 1 ? '' : 's'} (${list(small.map((i) => nice(i.name)))}) with fixes and improvements; nothing you use is taken away.`);
  lines.push(SAFE_LINE);
  return lines.slice(0, 3);
}
const lower = (s: string) => s.replace(/\.$/, '').replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());

// "what changes for you" for a major version, from its release notes when Unit7 could read them (breaking changes first)
export function majorBullets(notes: string | undefined, name: string): string[] {
  const lines = (notes ?? '').split('\n').map((l) => l.trim()).filter((l) => /^([-*•]|\d+\.)\s+/.test(l))
    .map((l) => l.replace(/^([-*•]|\d+\.)\s+/, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_]/g, '').replace(/\s*\(#\d+\)|\s*by @\S+.*$|\s+in https?:\/\/\S+/g, '').trim())
    .filter((l) => l.length > 8 && l.length < 220 && !/^(chore|ci|docs?|test|build)\b/i.test(l));
  const breaking = lines.filter((l) => /break|remov|drop|deprecat|requir|renam|no longer|instead|minimum|default/i.test(l));
  const picked = [...new Set([...breaking, ...lines])].slice(0, 3).map((l) => (l.length > 140 ? `${l.slice(0, 139)}…` : l.replace(/^\w/, (c) => c.toUpperCase())));
  return picked.length >= 2 ? picked : [`Some parts of ${nice(name)} work differently; code that used them may need a small change.`, 'Unit7 runs your tests and opens your busiest pages on a copy before anything goes live.', 'If anything looks worse after the release, the version before comes back by itself.'];
}

// --- autonomy: what goes by itself ------------------------------------------------------------------------------------
// levels: 0 Watch, 1 Suggest, 2 Ask first, 3 Fix itself (the default), 4 Autopilot
export function acceptance(level: number, mode: Mode, b: { kind: Kind; items: Pick<Item, 'bump' | 'security'>[] }): { auto: boolean; why: string } {
  const major = b.kind === 'major' || b.items.some((i) => i.bump === 'major');
  if (level <= 1) return { auto: false, why: 'Unit7 gets it ready; you release it (Autopilot is on watch or suggest).' };
  if (level === 2) return { auto: false, why: 'Ask first: one tap releases it.' };
  if (major && level < 4) return { auto: false, why: 'Major versions wait for you below Autopilot.' };
  if (mode === 'off' && !b.items.some((i) => i.security?.length) && b.kind !== 'server') return { auto: false, why: 'Keeping this app up to date is off.' };
  return { auto: true, why: level >= 4 ? 'Autopilot: it goes once the tests pass and the copy looks normal.' : 'Fix itself: security, patch and minor updates go by themselves once tests pass.' };
}

// --- when: the app's quietest hour of the week ------------------------------------------------------------------------------
export interface Slot { day: number; hour: number; learned: boolean }
export const DEFAULT_SLOT: Slot = { day: 2, hour: 3, learned: false }; // Tuesday 03:00
const DAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// never Friday evening (from 16:00): nobody wants to fix a release over the weekend
export const friday = (day: number, hour: number) => day === 5 && hour >= 16;
// windows: what the server watch counted (requests in each window). Needs a week of them; until then Tuesday 03:00.
export function quietSlot(windows: { at: string; requests: number }[], tz?: string): Slot {
  const days = new Set(windows.map((w) => w.at.slice(0, 10)));
  if (days.size < 7) return DEFAULT_SLOT;
  const sum = new Map<string, { n: number; c: number }>();
  for (const w of windows) {
    const c = clockAt(Date.parse(w.at), tz), k = `${c.day}:${Math.floor(c.minutes / 60)}`;
    const s = sum.get(k) ?? { n: 0, c: 0 };
    s.n += w.requests; s.c++; sum.set(k, s);
  }
  // the fewest visits on average; a tie goes to the hour nearest 03:00, then Tuesday
  const best = [...sum].map(([k, s]) => { const [d, h] = k.split(':').map(Number) as [number, number]; return { day: d, hour: h, avg: s.n / s.c }; })
    .filter((x) => !friday(x.day, x.hour))
    .sort((a, b) => a.avg - b.avg || Math.abs(a.hour - 3) - Math.abs(b.hour - 3) || Math.abs(a.day - 2) - Math.abs(b.day - 2))[0];
  return best ? { day: best.day, hour: best.hour, learned: true } : DEFAULT_SLOT;
}
export const slotWords = (s: Pick<Slot, 'day' | 'hour'>) => `${DAY_WORDS[s.day]} ${String(s.hour).padStart(2, '0')}:00`;
// the next start of that hour on the person's clock, outside any freeze window
export function nextRun(slot: Pick<Slot, 'day' | 'hour'>, now: number, tz?: string, holds: Hold[] = [], serviceId?: string): number | null {
  const start = Math.ceil(now / 3600_000) * 3600_000;
  for (let t = start; t < start + 120 * 86400_000; t += 3600_000) {
    const c = clockAt(t, tz);
    if (c.day !== slot.day || Math.floor(c.minutes / 60) !== slot.hour) continue;
    if (!pausedBy(holds, serviceId, t)) return t;
  }
  return null;
}
// inside the slot, or up to 6 hours after it (one pipeline per organisation at a time, so the others catch up), never
// running into Friday evening
export const SLOT_GRACE_H = 6;
export function inSlot(slot: Pick<Slot, 'day' | 'hour'>, now: number, tz?: string): boolean {
  const c = clockAt(now, tz);
  const since = (c.day * 1440 + c.minutes - (slot.day * 1440 + slot.hour * 60) + 10080) % 10080;
  return since < SLOT_GRACE_H * 60 && !friday(c.day, Math.floor(c.minutes / 60));
}
// due: in the slot now, and the last weekly run was more than 6 days ago
export function weeklyDue(slot: Pick<Slot, 'day' | 'hour'>, last: string | null | undefined, now: number, tz?: string): boolean {
  return inSlot(slot, now, tz) && (!last || now - Date.parse(last) > 6 * 86400_000);
}

// --- security problems that can't wait for the weekly run -----------------------------------------------------------------
// critical or high, with a fix, in a library the app uses: today. Critical goes at once; high waits out quiet hours.
export function emergency(p: Plan, quiet: boolean): { go: boolean; worst?: Severity; why: string } {
  const urgent = p.batches.flatMap((b) => b.items).filter((i) => i.security?.some((s) => (s.severity === 'critical' || s.severity === 'high') && (!s.fixed || compare(i.to, s.fixed) >= 0)));
  if (!urgent.length) return { go: false, why: 'nothing urgent' };
  const worst = worstOf(urgent)!;
  if (worst === 'high' && quiet) return { go: false, worst, why: 'a high-severity fix waits for your quiet hours to end' };
  return { go: true, worst, why: `${worst === 'critical' ? 'A critical' : 'A high-severity'} security fix for ${list(urgent.map((i) => nice(i.name)))}` };
}

// --- the weekly report and the streak ------------------------------------------------------------------------------------
export interface Week { updates: number; apps: number; security: number; downSeconds: number | null; held: string[] }
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
export function weeklyLine(w: Week): string {
  if (!w.updates && !w.held.length) return 'This week: everything was already up to date.';
  const parts = [`${n(w.updates, 'update')} on ${n(w.apps, 'app')}`];
  if (w.security) parts.push(n(w.security, 'security fix', 'security fixes'));
  if (w.downSeconds !== null && w.updates) parts.push(`${Math.round(w.downSeconds)} second${Math.round(w.downSeconds) === 1 ? '' : 's'} down`);
  if (w.held.length) parts.push(`${w.held.length} held back (${[...new Set(w.held)].slice(0, 2).join(', ')})`);
  return `This week: ${parts.join(', ')}.`;
}
// ISO week, "2026-W41"
export function isoWeek(ms: number): string {
  const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const y = d.getUTCFullYear(), first = new Date(Date.UTC(y, 0, 4));
  return `${y}-W${String(1 + Math.round(((d.getTime() - first.getTime()) / 86400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
}
// weeks in a row that ended up to date: this week counts once it's good (an open one doesn't break the run yet)
export function streak(weeks: Map<string, boolean>, now: number): number {
  let k = 0, t = now;
  if (weeks.get(isoWeek(t)) === false) return 0;
  if (!weeks.has(isoWeek(t))) t -= 7 * 86400_000;
  for (; weeks.get(isoWeek(t)) === true; t -= 7 * 86400_000) k++;
  return k;
}
export const streakWords = (k: number) => (k ? `${k} week${k === 1 ? '' : 's'} up to date` : '');
