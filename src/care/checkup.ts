// The Check-up: "is everything OK?" as one button. Is there room, is the data safe, is anything open, and is the app
// behaving, each in a sentence, then what to do first and who does it. Most of it needs no AI: fixed read-only steps, so it
// works with nothing connected, costs nothing and can run on a schedule. Every report says what it checked and what it
// couldn't, because "nothing wrong" only means something next to what was looked at.
import type { Ctx } from '../tools/runtime.ts';
import { execute } from '../tools/runtime.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { readPoints } from '../sentinel/usage.ts';
import { lastXray } from '../tools/xray.ts';
import { blindMs, gapsIn } from '../sentinel/gaps.ts';
import { LEVEL_WORDS, protectionOf, type Guarded } from './safetynet.ts';
import { reducePlan, size, unusedStackParts, type Saving } from './reduce.ts';
import { lowCoverage } from './coverage.ts';
import { seenAuth, senderFix, senderProblem } from './mail.ts';
import { learnable, playbookFor } from './judge.ts';
import { memoryForecasts, signalsOf } from '../inspect/index.ts';
import type { Finding, Fix, Report as Security, Coverage } from '../tools/security.ts';
import type { Sizes, Inventory } from '../discovery/xray.ts';
import type { Summary } from '../sentinel/traffic.ts';
import type { ServerRow } from '../connectors/ssh.ts';

export type Area = 'room' | 'protection' | 'safety' | 'app';
export type Who = 'unit7' | 'your-ai' | 'you';
export const WHO_WORDS: Record<Who, string> = { unit7: 'Unit7 can do this', 'your-ai': 'Your AI', you: 'Only you' };
export interface Item { id: string; area: Area; severity: string; title: string; why: string; ignore?: string; who: Who; fix?: Fix; serverId?: string; evidence?: string; about?: { id?: string; name: string } }
export interface Checked { id: string; label: string; ok: boolean; why?: string; fix?: { tool: string; input: Record<string, unknown>; label: string } }
export interface RoomServer {
  id: string; name: string; word: 'Plenty' | 'Getting tight' | 'Tight'; ram: { used: number; total: number; pct: number; peakPct?: number }; cpu: { now: number; peak?: number };
  disk: { used: number; total: number; pct: number; daysLeft?: number }; projects: { id: string; name: string; mem: number; cpu: number; disk?: number }[];
}
export interface Verdict { word: string; line: string; tone: 'good' | 'look' | 'act' }
export interface Checkup {
  id: string; at: string; by: string; ms: number; quick: boolean; level: 'good' | 'look' | 'act'; line: string; since?: { fixed: string[]; fresh: string[]; same: number };
  verdicts: Record<Area, Verdict>; room: RoomServer[]; protection: Guarded[]; who?: NonNullable<Summary['who']>; requests?: number; topPaths?: Summary['topPaths']; p95?: number;
  items: Item[]; reduce: Saving[]; checked: Checked[]; blindHours: number; done: string[]; coverage?: Coverage; learn?: { finding: string; title: string; tool: string }[];
}

const RANK = ['critical', 'high', 'medium', 'warning', 'low', 'info'];
const order = (a: Item, b: Item) => RANK.indexOf(a.severity) - RANK.indexOf(b.severity) || a.title.localeCompare(b.title);
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

// who fixes it: Unit7 when a tool does it, your builder when it's in the code, you when it's outside both
export function whoFixes(f: Pick<Finding, 'fix' | 'area'>): Who {
  const fix = f.fix;
  if (!fix) return 'you';
  if ('tool' in fix) return 'unit7';
  if ('ask' in fix && f.area === 'app') return 'your-ai';
  return 'you';
}
const areaOf = (f: Finding): Area => (/no-backup|weak-backup|backup/.test(f.id) ? 'protection' : /disk|memory|oom|restart|reclaim|no-caps|logs-grow/.test(f.id) ? 'room' : /^logs:|traffic:surge|errors|^db:/.test(f.id) ? 'app' : 'safety');
export function asItem(f: Finding): Item {
  return { id: f.id, area: areaOf(f), severity: f.severity, title: f.title, why: f.explain?.why ?? f.detail, ...(f.explain?.next && { ignore: f.explain.why }), who: whoFixes(f), ...(f.fix && { fix: f.fix }), ...(f.serverId && { serverId: f.serverId }), ...(f.evidence && { evidence: f.evidence }), ...(f.about && { about: { ...(f.about.id && { id: f.about.id }), name: f.about.name } }) };
}

// (pure) the four sentences and the headline
export function verdictsOf(c: Pick<Checkup, 'room' | 'protection' | 'items' | 'coverage'> & { requests?: number; who?: Checkup['who'] }): { verdicts: Record<Area, Verdict>; level: Checkup['level']; line: string } {
  const worst = c.room.find((r) => r.word === 'Tight') ?? c.room.find((r) => r.word === 'Getting tight');
  const room: Verdict = !c.room.length ? { word: 'Not read', line: 'No server answered.', tone: 'look' }
    : worst ? { word: worst.word, line: `${worst.name}: RAM ${worst.ram.pct}%, disk ${worst.disk.pct}%`, tone: worst.word === 'Tight' ? 'act' : 'look' }
    : { word: 'Plenty', line: c.room.length === 1 ? `RAM ${c.room[0]!.ram.pct}%, disk ${c.room[0]!.disk.pct}%` : `${c.room.length} servers with room to spare`, tone: 'good' };
  const important = c.protection.filter((g) => g.important), proven = important.filter((g) => g.level === 'proven').length, naked = important.filter((g) => g.level === 'unprotected').length, weak = important.filter((g) => g.level === 'weak').length;
  const failed = important.filter((g) => g.failed).length; // a copy that wouldn't come back isn't protection, so it's never "nothing urgent"
  const protection: Verdict = !important.length ? { word: 'Nothing to protect', line: 'No important database found.', tone: 'good' }
    : failed ? { word: 'Not proven', line: `${failed} of ${important.length} failed a test restore`, tone: 'act' }
    : naked ? { word: 'At risk', line: `${naked} of ${important.length} have no copy anywhere`, tone: 'act' }
    : weak ? { word: 'Weak', line: `${weak} of ${important.length} only have copies on this server`, tone: 'look' }
    : proven === important.length ? { word: 'Proven', line: `All ${important.length} restored in a test this week`, tone: 'good' } : { word: 'Protected', line: `${proven} of ${important.length} proven, the rest copied off the server`, tone: 'look' };
  const risky = c.items.filter((i) => i.area === 'safety' && ['critical', 'high'].includes(i.severity));
  const notes = c.items.filter((i) => i.area === 'safety' && ['medium', 'warning'].includes(i.severity));
  const partly = lowCoverage(c.coverage);
  const safety: Verdict = risky.length ? { word: `${risky.length} urgent`, line: risky[0]!.title, tone: 'act' }
    : partly ? { word: 'Partly checked', line: `Apps checked: ${c.coverage!.apps.checked} of ${c.coverage!.apps.found}`, tone: 'look' }
    : notes.length ? { word: `${notes.length} to do`, line: notes[0]!.title, tone: 'look' } : { word: 'No open doors', line: 'Nothing serious found', tone: 'good' };
  const appItems = c.items.filter((i) => i.area === 'app');
  const app: Verdict = appItems.length ? { word: `${appItems.length} to look at`, line: appItems[0]!.title, tone: appItems.some((i) => ['critical', 'high'].includes(i.severity)) ? 'act' : 'look' }
    : c.requests ? { word: 'Looks normal', line: c.who ? `${c.who.visitors} real visitors in the last check` : `${c.requests} requests in the last check`, tone: 'good' } : { word: 'Not read', line: 'No traffic log to read yet.', tone: 'look' };
  const verdicts = { room, protection, safety, app };
  const tones = Object.values(verdicts).map((v) => v.tone);
  const level = tones.includes('act') ? 'act' : tones.includes('look') ? 'look' : 'good';
  const todo = c.items.filter((i) => i.severity !== 'info' && i.severity !== 'low').length;
  const line = level === 'act' ? `Needs you: ${c.items.filter((i) => ['critical', 'high'].includes(i.severity)).length || 'a few'} urgent thing${c.items.filter((i) => ['critical', 'high'].includes(i.severity)).length === 1 ? '' : 's'}.`
    : level === 'look' ? `Healthy. Nothing urgent.${todo ? ` ${todo} thing${todo === 1 ? '' : 's'} worth doing.` : ''}` : 'Healthy. Nothing needs you.';
  return { verdicts, level, line };
}

export function sinceLast(prev: Pick<Checkup, 'items'> | undefined, items: Item[]) {
  if (!prev) return undefined;
  const was = new Map(prev.items.map((i) => [i.id, i.title])), is = new Set(items.map((i) => i.id));
  return { fixed: [...was].filter(([k]) => !is.has(k)).map(([, t]) => t), fresh: items.filter((i) => !was.has(i.id)).map((i) => i.title), same: items.filter((i) => was.has(i.id)).length };
}

export const wordOf = (ram: number, disk: number): RoomServer['word'] => (ram >= 90 || disk >= 90 ? 'Tight' : ram >= 75 || disk >= 75 ? 'Getting tight' : 'Plenty');

const ok = async <T>(ctx: Ctx, tool: string, input: object, checked: Checked[], label: string, why = 'the check-up'): Promise<T | undefined> => {
  const r = await execute(ctx.app, ctx.orgId, ctx.actor, tool, input, { reason: why, signal: ctx.signal }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'internal', message: e.message } }));
  checked.push(r.status === 'ok' ? { id: `${tool}:${JSON.stringify(input)}`, label, ok: true } : { id: `${tool}:${JSON.stringify(input)}`, label, ok: false, why: r.status === 'error' ? r.error.message.slice(0, 160) : r.status === 'denied' ? r.why : r.status });
  return r.status === 'ok' ? r.output as T : undefined;
};

export const lastCheckup = (db: DB, orgId: string, skip?: string) => { const r = get<{ data: string }>(db, 'SELECT data FROM checkups WHERE org_id = ? AND (? IS NULL OR id != ?) ORDER BY created_at DESC LIMIT 1', orgId, skip ?? null, skip ?? null); return r ? json<Checkup>(r.data, {} as Checkup) : undefined; };

// quick: only what Unit7 already has (a daily look, no trips to the server beyond one reading each)
export async function runCheckup(ctx: Ctx, o: { quick?: boolean; serverId?: string } = {}): Promise<Checkup> {
  const t0 = Date.now(), quick = !!o.quick, checked: Checked[] = [], items: Item[] = [], room: RoomServer[] = [], reduce: Saving[] = [];
  const add = (i: Item) => { if (!items.some((x) => x.id === i.id)) items.push(i); };
  const servers = all<ServerRow>(ctx.db, `SELECT * FROM servers WHERE org_id = ? AND status NOT IN ('new', 'bootstrapping') AND (? IS NULL OR id = ?) ORDER BY name`, ctx.orgId, o.serverId ?? null, o.serverId ?? null);
  let requests = 0, topPaths: Summary['topPaths'] | undefined, p95: number | undefined;
  const who = { people: 0, visitors: 0, own: 0, programs: 0, bots: 0, unit7: 0 };
  let told = false;
  for (const s of servers) {
    ctx.progress(`Reading ${s.name}…`);
    const m = await ok<{ now: { cpu: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number; containers?: unknown[] } }>(ctx, 'server.metrics', { serverId: s.id }, checked, `Disk, memory and CPU on ${s.name}`);
    const u = m ? await ok<{ projects: { id: string; name: string; cpu: number; mem: number; disk?: number; system?: boolean }[] }>(ctx, 'server.usage', { serverId: s.id }, checked, `What each project uses on ${s.name}`) : undefined;
    const week = readPoints(ctx.db, s.id, '1h', Date.now() - 7 * 86400_000, 'server').get('server')?.points ?? [];
    const memPeak = Math.max(0, ...week.map((p) => p.memMax ?? p.mem ?? 0)), cpuPeak = Math.max(0, ...week.map((p) => p.cpuMax ?? p.cpu ?? 0));
    if (m) {
      const n = m.now, ramPct = pct(n.memUsed, n.memTotal), diskPct = pct(n.diskUsed, n.diskTotal);
      const f = await ok<{ risks: Finding[]; waste: Finding[]; tips: Finding[]; notes: string[] }>(ctx, 'server.findings', { serverId: s.id, fresh: !quick }, checked, `Risks and waste on ${s.name}`);
      const forecast = [...(f?.risks ?? []), ...(f?.tips ?? [])].find((x) => /disk/.test(x.id) && /days?/.test(x.title));
      room.push({ id: s.id, name: s.name, word: wordOf(ramPct, diskPct), ram: { used: n.memUsed, total: n.memTotal, pct: ramPct, ...(memPeak && { peakPct: pct(memPeak, n.memTotal) }) }, cpu: { now: Math.round(n.cpu), ...(cpuPeak && { peak: Math.round(cpuPeak) }) },
        disk: { used: n.diskUsed, total: n.diskTotal, pct: diskPct, ...(forecast && { daysLeft: Number(/(\d+) days?/.exec(forecast.title)?.[1]) || undefined }) },
        projects: (u?.projects ?? []).filter((p) => !p.system).sort((a, b) => b.mem - a.mem).map((p) => ({ id: p.id, name: p.name, mem: p.mem, cpu: p.cpu, ...(p.disk !== undefined && { disk: p.disk }) })) });
      for (const x of [...(f?.risks ?? []), ...(f?.tips ?? [])]) if (x.severity !== 'info') add(asItem(x));
      for (const t of memoryForecasts(ctx.db, s.id, lastXray(ctx.db, ctx.orgId, s.id)?.data, n.memTotal)) add({ id: `forecast:mem:${s.id}:${t.name}`, area: 'room', severity: t.days <= 14 ? 'medium' : 'low', title: `${t.name} ${t.what}: trouble in about ${t.days} days`, why: 'If nothing changes, it runs out of memory and apps get killed.', who: 'your-ai', serverId: s.id });
      const inv: Inventory | undefined = lastXray(ctx.db, ctx.orgId, s.id)?.data, sizes = lastXray<Sizes>(ctx.db, ctx.orgId, s.id, 'deep')?.data;
      const scopes = readPoints(ctx.db, s.id, '1h', Date.now() - 7 * 86400_000), memPeaks = Object.fromEntries([...scopes].map(([k, v]) => [k, Math.max(0, ...v.points.map((p) => p.memMax ?? p.mem ?? 0))]));
      reduce.push(...reducePlan({ serverId: s.id, serverName: s.name, inv, sizes, memTotal: n.memTotal, memPeakServer: memPeak, memPeak: memPeaks }));
      reduce.push(...unusedStackParts(s.id, s.name, inv, all<{ at: string; stack: string | null }>(ctx.db, `SELECT at, json_extract(summary, '$.stack') stack FROM traffic_windows WHERE server_id = ? AND at > ? ORDER BY at`, s.id, new Date(Date.now() - 8 * 86400_000).toISOString()).map((w) => ({ at: w.at, ...(w.stack && { stack: json<Record<string, Record<string, number>>>(w.stack, {}) }) }))));
    }
    const t = await ok<{ summary: Summary; findings: Finding[]; stale?: unknown }>(ctx, 'server.traffic', { serverId: s.id, fresh: !quick }, checked, `Traffic and logs on ${s.name}`);
    if (t) {
      requests += t.summary.requests ?? 0; topPaths = [...(topPaths ?? []), ...(t.summary.topPaths ?? [])].sort((a, b) => b.n - a.n).slice(0, 8); p95 = Math.max(p95 ?? 0, t.summary.p95 ?? 0) || undefined;
      if (t.summary.who) { told = true; for (const k of Object.keys(who) as (keyof typeof who)[]) who[k] += t.summary.who[k]; }
      for (const x of t.findings ?? []) if (x.severity !== 'info') add(asItem(x));
      if (!t.summary.sources?.some((x) => x.lines > 0)) checked.push({ id: `access-log:${s.id}`, label: `Access log on ${s.name}`, ok: false, why: t.summary.sources?.find((x) => x.note)?.note ?? 'no access log to read yet' });
    }
  }
  let coverage: Coverage | undefined;
  if (!o.serverId) {
    ctx.progress('Checking sites and security…');
    if (!quick) await ok(ctx, 'watch.check', { daily: false }, checked, 'Every site from the outside');
    const sec = quick ? (await ok<{ latest?: Security }>(ctx, 'security.reports', {}, checked, 'The last security check'))?.latest : await ok<Security>(ctx, 'security.check', {}, checked, 'Security: ports, sign-in, apps and domains');
    coverage = sec?.coverage;
    if (!quick) {
      ctx.progress('Looking from outside, as a stranger…');
      for (const [tool, label] of [['security.stranger', 'What a stranger can do from outside'], ['security.panels', 'Control panels and their versions']] as const) for (const f of (await ok<{ findings: Finding[] }>(ctx, tool, {}, checked, label))?.findings ?? []) add(asItem(f));
      for (const s of servers) {
        for (const [tool, label] of [['security.doors', `Database door rules on ${s.name}`], ['security.defaults', `Default passwords on ${s.name}`]] as const) for (const f of (await ok<{ findings: Finding[] }>(ctx, tool, { serverId: s.id }, checked, label))?.findings ?? []) add(asItem(f));
        const h = await ok<{ verdict: string; line: string; signs: { what: string; strong: boolean }[] }>(ctx, 'security.hacked', { serverId: s.id }, checked, `Signs of a break-in on ${s.name}`);
        if (h?.signs.length) add({ id: `hacked:${s.id}`, area: 'safety', severity: h.signs.some((x) => x.strong) ? 'critical' : 'medium', title: `${s.name}: ${h.verdict}`, why: `${h.signs[0]!.what}. ${h.line}`, who: 'you', serverId: s.id });
      }
    }
    for (const f of sec?.findings ?? []) if (f.severity !== 'info') add(asItem(f));
    for (const name of coverage?.skipped.slice(0, 8) ?? []) checked.push({ id: `app:${name}`, label: `Logs and settings of ${name}`, ok: false, why: 'Unit7 couldn’t read them this time' });
    for (const name of coverage?.unscanned?.slice(0, 8) ?? []) checked.push({ id: `image:${name}`, label: `Known security holes in ${name}`, ok: false, why: 'Not scanned yet. The first scan downloads about 1 GB to the server, so it waits for your OK', ...(servers[0] && { fix: { tool: 'part.scan_images', input: { serverId: servers[0].id }, label: 'Scan my images' } }) });
  }
  // what the Call Inspector is sure of. Not during its silent first week, and never a guess it saw once.
  for (const sig of signalsOf(ctx.db, ctx.orgId).filter((x) => x.shown && (!o.serverId || x.serverId === o.serverId))) add({ id: sig.key, area: 'app', severity: sig.detection.severity, title: sig.title, why: sig.detection.plain, who: sig.detection.who, serverId: sig.serverId, ...(sig.detection.host && { about: { name: sig.detection.host } }) });
  const protection = protectionOf(ctx.db, ctx.orgId).filter((g) => !o.serverId || g.serverId === o.serverId);
  checked.push({ id: 'protection', label: 'Backups of every database', ok: true });
  for (const g of protection.filter((x) => x.important && x.level !== 'proven')) add({ id: `protect:${g.key}`, area: 'protection', severity: g.level === 'unprotected' || g.failed ? 'high' : 'medium', title: g.failed ? `${g.name}: its last test restore failed` : `${g.name}: ${LEVEL_WORDS[g.level].toLowerCase()}`, why: g.failed ?? (g.level === 'unprotected' ? 'If the server dies or data gets deleted, there’s no way back.' : g.level === 'weak' ? 'If the server dies, those copies go with it.' : 'A copy nobody restored may not work when you need it.'), who: 'unit7', serverId: g.serverId,
    fix: { tool: 'safety.protect', input: { key: g.key }, label: 'Protect it now', change: 'Makes a copy, sends it off the server encrypted, copies files and settings, and test-restores it. Nothing that exists changes.', safe: true } });
  // sign-up emails that can't reach real people, from the last X-ray and sync
  checked.push({ id: 'mail', label: 'Who sends sign-up emails', ok: true });
  for (const s of seenAuth(ctx.db, ctx.orgId, o.serverId).filter((x) => x.sender !== 'own')) {
    const p = senderProblem(s), f = senderFix(ctx.db, ctx.orgId, s);
    add({ id: `mail:${s.key}`, area: 'app', severity: 'medium', title: p.title, why: p.why, who: 'tool' in f ? 'unit7' : 'your-ai', ...('serverId' in s.at && { serverId: s.at.serverId }), about: { name: s.name },
      fix: 'tool' in f ? { ...f, change: 'Sets up sending from the domain, or puts your sender into Supabase. Mail records wait for your OK.' } : { manual: [p.why], label: f.label, ...('ask' in f && { ask: f.ask }) } });
  }
  // the backup findings say the same thing as the line above
  const said = new Set(protection.filter((g) => g.important).map((g) => g.part));
  const clean = items.filter((i) => !(/^xray:(no|weak)-backup:/.test(i.id) && [...said].some((p) => i.id.endsWith(p)))).sort(order);
  const prev = lastCheckup(ctx.db, ctx.orgId);
  const facts = { room, protection, items: clean, coverage, requests, ...(told && { who }) };
  const v = verdictsOf(facts);
  const blind = blindMs(gapsIn(ctx.db, Date.now() - 7 * 86400_000, Date.now())) / 3600_000;
  const done = all<{ name: string; steps: string }>(ctx.db, `SELECT name, steps FROM safety_runs WHERE org_id = ? AND status = 'done' AND created_at > ? ORDER BY created_at DESC LIMIT 6`, ctx.orgId, prev?.at ?? new Date(Date.now() - 7 * 86400_000).toISOString()).filter((r) => json<string[]>(r.steps, []).length).map((r) => `Protected ${r.name}`);
  // a fix a person ran that really made the finding go away: offer to do it by itself next time
  const learn = (prev?.items ?? []).filter((i) => i.fix && 'tool' in i.fix && !clean.some((x) => x.id === i.id) && learnable(i.fix.tool) && !playbookFor(ctx.db, ctx.orgId, i.id, i.fix.tool)
    && get(ctx.db, `SELECT 1 FROM audit WHERE org_id = ? AND tool = ? AND actor_kind = 'user' AND result = 'success' AND created_at > ?`, ctx.orgId, (i.fix as { tool: string }).tool, prev!.at)).slice(0, 3).map((i) => ({ finding: i.id, title: i.title, tool: (i.fix as { tool: string }).tool }));
  const c: Checkup = { id: id('chk'), at: now(), by: ctx.actor.agent ?? ctx.actor.name, ms: Date.now() - t0, quick, ...(learn.length && { learn }), ...v, since: sinceLast(prev, clean), room, protection, ...(told && { who }), requests, ...(topPaths && { topPaths }), ...(p95 && { p95 }), items: clean, reduce, checked, blindHours: Math.round(blind), done, ...(coverage && { coverage }) };
  run(ctx.db, 'INSERT INTO checkups (id, org_id, by, scope, level, line, data, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', c.id, ctx.orgId, c.by, o.serverId ?? 'all', c.level, c.line, JSON.stringify(c), c.ms, c.at);
  run(ctx.db, 'DELETE FROM checkups WHERE org_id = ? AND id NOT IN (SELECT id FROM checkups WHERE org_id = ? ORDER BY created_at DESC LIMIT 60)', ctx.orgId, ctx.orgId);
  return c;
}
export { size };

// Short daily, full weekly, in the server's calm hour (a Mac that sleeps through it runs it when it wakes). A person's "off" holds.
const DAY = 86400_000;
export function checkupDue(db: DB, orgId: string, nowMs = Date.now(), calm = true): { quick: boolean } | undefined {
  if (json<{ checkup?: string }>(get<{ safety: string }>(db, 'SELECT safety FROM orgs WHERE id = ?', orgId)?.safety, {}).checkup === 'off') return undefined;
  if (!get(db, `SELECT 1 FROM servers WHERE org_id = ? AND status NOT IN ('new', 'bootstrapping')`, orgId)) return undefined;
  const at = (q: string) => { const r = get<{ a: string | null }>(db, `SELECT max(created_at) a FROM checkups WHERE org_id = ? AND scope = 'all' ${q}`, orgId)?.a; return r ? nowMs - Date.parse(r) : Infinity; };
  const any = at(''), full = at(`AND json_extract(data, '$.quick') = 0`);
  if (full >= 7 * DAY && (calm || full >= 7.5 * DAY)) return { quick: false };
  if (any >= DAY && (calm || any >= 1.25 * DAY)) return { quick: true };
  return undefined;
}
// what a check-up that nobody was watching should say on the phone: only what's new and serious
export const worthSaying = (c: Pick<Checkup, 'items' | 'since'>) => { const fresh = new Set(c.since?.fresh ?? []); return c.items.filter((i) => ['critical', 'high'].includes(i.severity) && fresh.has(i.title)); };

// Two moments side by side: what changed, and what got better or worse. Pure, from the saved records.
export function compareCheckups(a: Checkup, b: Checkup) {
  const [old, young] = a.at <= b.at ? [a, b] : [b, a];
  const was = new Map(old.items.map((i) => [i.id, i])), is = new Map(young.items.map((i) => [i.id, i]));
  const rank = (t: Verdict['tone']) => ({ good: 0, look: 1, act: 2 })[t];
  return { from: old.at, to: young.at, fixed: [...was].filter(([k]) => !is.has(k)).map(([, i]) => i.title), fresh: [...is].filter(([k]) => !was.has(k)).map(([, i]) => i.title), same: [...is.keys()].filter((k) => was.has(k)).length,
    areas: (Object.keys(young.verdicts) as Area[]).map((k) => { const x = old.verdicts[k], y = young.verdicts[k]; return { area: k, from: x?.word, to: y.word, moved: x ? (rank(y.tone) < rank(x.tone) ? 'better' : rank(y.tone) > rank(x.tone) ? 'worse' : 'same') : 'same' }; }),
    room: young.room.map((r) => { const o = old.room.find((x) => x.id === r.id); return { name: r.name, ram: [o?.ram.pct, r.ram.pct], disk: [o?.disk.pct, r.disk.pct] }; }) };
}