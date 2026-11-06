// The Safety Net: Unit7 protects first. Something important with no safe copy doesn't get a suggestion, it gets a copy,
// proven by a test restore, and one calm line afterwards. Everything here only creates or copies (the green band in
// policy.ts): it never deletes, overwrites or restarts anything of yours, and never changes a running app, a setting or
// DNS. The only things it may remove are its own: the throwaway test copy, and its own older automatic copies once a newer
// one is proven (part.backup's pruning keeps the newest). It needs no AI: fixed rules, so nothing in a log can talk it into
// anything. A person can turn it off; an AI can't.
import type { App } from '../app.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { lastXray } from '../tools/xray.ts';
import { withoutArchived } from '../archive.ts';
import { canDump } from '../discovery/findings.ts';
import { keptMarks } from '../kept.ts';
import { isTestHost } from './readiness.ts';
import { assetIdOf } from '../archive.ts';
import type { Inventory, Part, Project, Sizes } from '../discovery/xray.ts';
import type { Summary } from '../sentinel/traffic.ts';
import type { ToolResult } from '../tools/runtime.ts';

const HOUR = 3600_000, DAY = 86400_000;
const STALE = 8 * DAY;     // a copy or a proof older than this no longer counts
const RETRY = 6 * HOUR;    // after a failed ladder

export type Level = 'unprotected' | 'weak' | 'protected' | 'proven';
export const LEVELS: Level[] = ['unprotected', 'weak', 'protected', 'proven'];
export const LEVEL_WORDS: Record<Level, string> = {
  unprotected: 'No copy anywhere', weak: 'Copies only on this server', protected: 'A copy is safe off the server', proven: 'Copied off the server, and a test restore worked',
};
export interface Copy { at: string; off: Record<string, unknown> | null; verifiedAt?: string | null; verifyOk?: number | null; verifyNote?: string | null }
export interface CoolifySeen { count: number; lastOk: string | null; offServer: boolean }
export interface Guarded {
  key: string; serverId: string; serverName: string; part: string; name: string; engine: string; project?: string; projectName?: string;
  important: boolean; why: string[]; by: 'you' | 'unit7'; level: Level; copies: { here: number; off: number; mine?: number }; lastCopy: string | null; provenAt: string | null;
  where: string[]; coolify?: CoolifySeen; schedule?: { frequency: string; keep: number }; extrasAt: string | null; system?: boolean;
  next: string; service?: string; // a database Unit7 runs itself
  failed?: string; // why the newest test restore failed, until a later one works
}
export interface SafetySettings { busy?: { from: string; to: string; tz?: string } | null; checkup?: 'on' | 'off'; announced?: string; inspector?: 'show' | 'learn' }

// --- what matters (pure) ---------------------------------------------------------------------------------------------
export interface Signals { name: string; env?: string; domains: string[]; traffic: number; bytes?: number; money: boolean; marked?: boolean }
const TEST_NAME = /\b(preview|staging|stage|test|testing|dev|demo|sandbox|tmp|temp)\b/i;
export const MONEY_KEYS = /STRIPE|RAZORPAY|PAYPAL|PADDLE|LEMONSQUEEZY|CASHFREE|PAYU|PHONEPE/i;
const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
export function judge(s: Signals): { important: boolean; why: string[]; by: 'you' | 'unit7' } {
  if (s.marked !== undefined) return { important: s.marked, why: [s.marked ? 'You marked it important' : 'You said it isn’t important'], by: 'you' };
  const why: string[] = [];
  const own = s.domains.find((d) => !isTestHost(d));
  if (TEST_NAME.test(`${s.name} ${s.env ?? ''}`)) return { important: false, why: ['Its name says it’s a test copy'], by: 'unit7' };
  if (own) why.push(`It has its own domain (${own})`);
  if (s.money) why.push('It handles payments');
  if (s.traffic >= 20) why.push('It was used in the last day');
  if ((s.bytes ?? 0) >= 10e6) why.push(`It holds ${mb(s.bytes!)} of data`);
  return { important: !!own || s.money || why.length >= 2, why, by: 'unit7' };
}

// --- how safe a copy history is (pure) ---------------------------------------------------------------------------------
export function levelOf(copies: Copy[], seen: CoolifySeen | undefined, nowMs = Date.now()) {
  const fresh = (at?: string | null) => !!at && nowMs - Date.parse(at) < STALE;
  const recent = copies.filter((c) => fresh(c.at));
  const off = recent.filter((c) => c.off && (c.off.local || c.off.bucket || c.off.folder));
  const proofs = copies.filter((c) => c.verifyOk === 1 && fresh(c.verifiedAt)).map((c) => c.verifiedAt!).sort();
  const tried = copies.filter((c) => c.verifiedAt).sort((a, b) => Date.parse(b.verifiedAt!) - Date.parse(a.verifiedAt!))[0];
  const coolifyHere = !!seen?.count && fresh(seen.lastOk);
  const coolifyOff = coolifyHere && !!seen?.offServer;
  const level: Level = (off.length || coolifyOff) ? (proofs.length ? 'proven' : 'protected') : recent.length || coolifyHere ? 'weak' : 'unprotected';
  const where = new Set<string>();
  if (recent.length || coolifyHere) where.add('this server');
  for (const c of off) { if (c.off!.local) where.add('this computer'); if (c.off!.folder) where.add('your synced folder'); if (c.off!.bucket) where.add('your bucket'); }
  if (coolifyOff) where.add('Coolify’s bucket');
  return { level, here: recent.length + (coolifyHere ? seen!.count : 0), mine: recent.length, off: off.length, lastCopy: [copies[0]?.at, seen?.lastOk].filter(Boolean).sort().at(-1) ?? null, provenAt: proofs.at(-1) ?? null, where: [...where], ...(tried?.verifyOk === 0 && { failed: tried.verifyNote || 'Its last test restore failed.' }) };
}

// the next step of the ladder for one thing, in words
export const nextStep = (l: Level, important: boolean) => (!important ? 'Unit7 suggests a backup, but it only acts by itself on what’s important.'
  : l === 'proven' ? 'Nothing to do: a fresh copy is off the server and restores.' : l === 'protected' ? 'Next: a test restore, in a quiet moment.' : 'Next: a copy, as soon as the server is calm.');

// --- what's on the servers --------------------------------------------------------------------------------------------
const marksOf = (db: DB, orgId: string) => new Map(all<{ key: string; important: number }>(db, 'SELECT key, important FROM safety_marks WHERE org_id = ?', orgId).map((m) => [m.key, !!m.important]));
const copiesOf = (db: DB, orgId: string, serverId: string, part: string): Copy[] => all<{ created_at: string; offsite: string | null; verified_at: string | null; verify_ok: number | null; verify_note: string | null }>(db,
  `SELECT created_at, offsite, verified_at, verify_ok, verify_note FROM backups WHERE org_id = ? AND server_id = ? AND part = ? AND status = 'done' ORDER BY created_at DESC LIMIT 40`, orgId, serverId, part)
  .map((b) => ({ at: b.created_at, off: json<Record<string, unknown> | null>(b.offsite, null), verifiedAt: b.verified_at, verifyOk: b.verify_ok, verifyNote: b.verify_note }));
const seenOf = (db: DB, serverId: string, part: string) => { const r = get<{ count: number; last_ok: string | null; off_server: number }>(db, 'SELECT count, last_ok, off_server FROM coolify_backups_seen WHERE server_id = ? AND part = ?', serverId, part); return r ? { count: r.count, lastOk: r.last_ok, offServer: !!r.off_server } : undefined; };

function trafficOf(db: DB, serverId: string, domains: string[], nowMs: number) {
  if (!domains.length) return 0;
  const set = new Set(domains);
  return all<{ summary: string }>(db, 'SELECT summary FROM traffic_windows WHERE server_id = ? AND at > ?', serverId, new Date(nowMs - DAY).toISOString())
    .flatMap((w) => json<Summary>(w.summary, {} as Summary).callers ?? []).filter((c) => set.has(c.host)).reduce((n, c) => n + c.people + c.programs + c.api, 0);
}
// a database, and Coolify's own (a project called "system"): everything else on that server depends on it
const guardable = (p: Part, marked: boolean) => canDump(p) && (p.engine !== 'redis' || marked);

export function protectionOf(db: DB, orgId: string, nowMs = Date.now()): Guarded[] {
  const out: Guarded[] = [], marks = marksOf(db, orgId), kept = keptMarks(db, orgId);
  for (const s of all<{ id: string; name: string }>(db, `SELECT id, name FROM servers WHERE org_id = ? AND status NOT IN ('new', 'bootstrapping') ORDER BY name`, orgId)) {
    const inv = withoutArchived(db, orgId, s.id, lastXray(db, orgId, s.id)?.data);
    if (!inv) continue;
    const sizes = lastXray<Sizes>(db, orgId, s.id, 'deep')?.data;
    const mine: Guarded[] = [];
    for (const p of inv.parts) {
      const key = `${s.id}:${p.id}`, marked = marks.get(key) ?? (kept.get(assetIdOf(orgId, p.project ?? p.id))?.important ? true : undefined);
      if (!guardable(p, !!marked)) continue;
      const project: Project | undefined = inv.projects.find((x) => x.id === p.project);
      if (project?.system) continue; // Coolify itself is judged below, from what it runs
      const group = inv.parts.filter((x) => x.project === p.project && x.kind !== 'volume');
      const v = judge({ name: `${project?.name ?? ''} ${p.name}`, env: p.coolify?.environment, domains: project?.domains ?? p.hosts ?? [], traffic: trafficOf(db, s.id, project?.domains ?? [], nowMs),
        bytes: sizes?.databases.filter((d) => d.part === p.id).reduce((n, d) => n + d.bytes, 0), money: group.some((x) => x.envKeys?.some((k) => MONEY_KEYS.test(k))), marked });
      mine.push(guardedOf(db, orgId, s, p, project, v, nowMs));
    }
    // Coolify itself: if it holds anything important, its own database and keys are what bring the rest back
    const coolify = inv.parts.find((p) => p.containers?.includes('coolify-db') && p.engine === 'postgres');
    if (coolify && canDump(coolify)) {
      const marked = marks.get(`${s.id}:${coolify.id}`);
      const v = marked !== undefined ? judge({ name: '', domains: [], traffic: 0, money: false, marked }) : { important: mine.some((g) => g.important), why: ['It holds the settings of your other projects'], by: 'unit7' as const };
      mine.push({ ...guardedOf(db, orgId, s, coolify, inv.projects.find((x) => x.id === coolify.project), v, nowMs), name: 'Coolify itself', system: true });
    }
    out.push(...mine);
  }
  // databases Unit7 runs itself
  for (const d of all<{ id: string; name: string; kind: string; server_id: string | null; project_id: string; env: string; project: string }>(db,
    `SELECT s.id, s.name, s.kind, s.server_id, s.project_id, e.kind env, p.name project FROM services s JOIN environments e ON e.id = s.environment_id JOIN projects p ON p.id = s.project_id
     WHERE s.org_id = ? AND s.kind IN ('postgres', 'mysql', 'mariadb', 'mongo') AND s.status != 'removed'`, orgId)) {
    const rows = all<{ created_at: string; offsite: string | null; verified_at: string | null; verify_ok: number | null; verify_note: string | null }>(db, `SELECT created_at, offsite, verified_at, verify_ok, verify_note FROM backups WHERE service_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 40`, d.id);
    const l = levelOf(rows.map((b) => ({ at: b.created_at, off: json(b.offsite, null), verifiedAt: b.verified_at, verifyOk: b.verify_ok, verifyNote: b.verify_note })), undefined, nowMs);
    const v = judge({ name: `${d.project} ${d.name}`, env: d.env, domains: [], traffic: 0, money: false, marked: marks.get(`svc:${d.id}`) ?? (d.env === 'production' ? true : undefined) });
    const important = d.env === 'production' || v.important;
    const sch = get<{ frequency: string; keep: number }>(db, 'SELECT frequency, keep FROM backup_schedules WHERE service_id = ? LIMIT 1', d.id);
    out.push({ key: `svc:${d.id}`, serverId: d.server_id ?? '', serverName: '', part: d.id, name: d.name, engine: d.kind, projectName: d.project, important, why: d.env === 'production' ? ['It’s a production database'] : v.why, by: v.by,
      level: l.level, copies: { here: l.here, off: l.off, mine: l.mine }, lastCopy: l.lastCopy, provenAt: l.provenAt, where: l.where, ...(sch && { schedule: sch }), extrasAt: null, next: l.failed ?? nextStep(l.level, important), ...(l.failed && { failed: l.failed }), service: d.id });
  }
  return out.sort((a, b) => Number(b.important) - Number(a.important) || LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.name.localeCompare(b.name));
}

function guardedOf(db: DB, orgId: string, s: { id: string; name: string }, p: Part, project: Project | undefined, v: { important: boolean; why: string[]; by: 'you' | 'unit7' }, nowMs: number): Guarded {
  const seen = seenOf(db, s.id, p.id);
  const l = levelOf(copiesOf(db, orgId, s.id, p.id), seen, nowMs);
  const sch = get<{ frequency: string; keep: number }>(db, 'SELECT frequency, keep FROM part_backup_schedules WHERE server_id = ? AND part = ? AND org_id = ?', s.id, p.id, orgId);
  const extras = get<{ at: string | null }>(db, `SELECT max(created_at) at FROM backups WHERE org_id = ? AND server_id = ? AND part = ? AND status = 'done'`, orgId, s.id, `extras:${p.id}`)?.at ?? null;
  return { key: `${s.id}:${p.id}`, serverId: s.id, serverName: s.name, part: p.id, name: p.name, engine: p.engine ?? 'database', project: p.project, projectName: project?.name, important: v.important, why: v.why, by: v.by,
    level: l.level, copies: { here: l.here, off: l.off, mine: l.mine }, lastCopy: l.lastCopy, provenAt: l.provenAt, where: l.where, ...(seen && { coolify: seen }), ...(sch && { schedule: sch }), extrasAt: extras, next: l.failed ?? nextStep(l.level, v.important), ...(l.failed && { failed: l.failed }) };
}

// --- calm enough? ------------------------------------------------------------------------------------------------------
export const settingsOf = (db: DB, orgId: string): SafetySettings => json<SafetySettings>(get<{ safety: string }>(db, 'SELECT safety FROM orgs WHERE id = ?', orgId)?.safety, {});
const minutesAt = (t: number, tz?: string) => { const p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(tz && { timeZone: tz }) }).format(t).split(':').map(Number); return p[0]! * 60 + p[1]!; };
const hhmm = (s: string) => { const [h, m] = s.split(':').map(Number); return h! * 60 + m!; };
export function inBusyHours(s: SafetySettings, nowMs = Date.now()) {
  if (!s.busy) return false;
  const at = minutesAt(nowMs, s.busy.tz), from = hhmm(s.busy.from), to = hhmm(s.busy.to);
  return from <= to ? at >= from && at < to : at >= from || at < to;
}
// The quietest hour of a server's day, from its own traffic (UTC, with how sure that is), and how calm this hour is
export function quietHourOf(db: DB, serverId: string, nowMs = Date.now()): { hour: number; calmNow: boolean; known: boolean } {
  const rows = all<{ at: string; summary: string }>(db, 'SELECT at, summary FROM traffic_windows WHERE server_id = ? AND at > ?', serverId, new Date(nowMs - 14 * DAY).toISOString());
  const by = new Map<number, number[]>();
  for (const w of rows) { const h = new Date(w.at).getUTCHours(), s = json<Summary>(w.summary, {} as Summary); by.set(h, [...(by.get(h) ?? []), (s.requests ?? 0) / Math.max(1, s.minutes ?? 30)]); }
  if (by.size < 6) return { hour: 3, calmNow: true, known: false }; // too little history to know: nothing says this hour is busy
  const avg = [...by].map(([h, v]) => [h, v.reduce((a, b) => a + b, 0) / v.length] as const).sort((a, b) => a[1] - b[1]);
  const mid = avg[avg.length >> 1]![1], here = by.get(new Date(nowMs).getUTCHours());
  const nowAvg = here ? here.reduce((a, b) => a + b, 0) / here.length : 0;
  return { hour: avg[0]![0], calmNow: nowAvg <= mid * 1.25, known: true };
}
// the server's load right now, from the last reading: heavy work waits when it's already busy
export function loadOk(db: DB, serverId: string, nowMs = Date.now()) {
  const m = get<{ at: string; cpu: number | null; mem_used: number | null; mem_total: number | null }>(db, 'SELECT at, cpu, mem_used, mem_total FROM metrics WHERE server_id = ? ORDER BY at DESC LIMIT 1', serverId);
  if (!m || nowMs - Date.parse(m.at) > 15 * 60_000) return false; // no fresh reading: Unit7 doesn't know, so it waits
  return (m.cpu ?? 0) <= 70 && (m.mem_total ?? 0) - (m.mem_used ?? 0) >= 500e6;
}

// The brakes every automatic copy obeys, wherever it starts: the Safety Net switch, Pause, Observe, the hours a person called busy, and
// the server's load. The gate checks Pause and Observe again; Warden's routine work also waits for a calm hour (safetyTick).
export function mayCopy(db: DB, orgId: string, serverId?: string, nowMs = Date.now()) {
  const o = get<{ safety_net: number; autonomy: number; paused_at: string | null }>(db, 'SELECT safety_net, autonomy, paused_at FROM orgs WHERE id = ?', orgId);
  if (!o?.safety_net || o.autonomy < 1 || o.paused_at || inBusyHours(settingsOf(db, orgId), nowMs)) return false;
  return !serverId || loadOk(db, serverId, nowMs);
}

// --- one ladder --------------------------------------------------------------------------------------------------------
type Act = (orgId: string, tool: string, input: unknown, reason: string) => Promise<ToolResult>;
export interface Step { tool: string; input: Record<string, unknown>; label: string }
// what this thing still needs, in order (pure)
export function ladderFor(g: Pick<Guarded, 'level' | 'serverId' | 'part' | 'schedule' | 'extrasAt' | 'service' | 'provenAt' | 'copies'>, nowMs = Date.now()): Step[] {
  const steps: Step[] = [], thin = g.level === 'unprotected' || g.level === 'weak';
  // Each step stops being needed once it's done, whatever the level: copies that stay on this server don't get safer by taking more
  // of them, and only a person can send them off it. A ladder that never ended would dump the database every 15 minutes.
  if (g.service) {
    if (!g.schedule) steps.push({ tool: 'backup.schedule', input: { serviceId: g.service, frequency: 'daily', keep: 7 }, label: 'daily copies' });
    if (g.level === 'unprotected') steps.push({ tool: 'backup.create', input: { serviceId: g.service, reason: 'safety net' }, label: 'a copy' });
    return steps;
  }
  const base = { serverId: g.serverId, part: g.part };
  if (thin && !g.schedule) steps.push({ tool: 'part.backup_schedule', input: { ...base, frequency: 'daily', keep: 7 }, label: 'daily copies' }); // it takes the first copy
  else if (g.level === 'unprotected') steps.push({ tool: 'part.backup', input: { ...base, reason: 'safety net' }, label: 'a copy' });
  // proof first: if the files are too big to copy by itself, the database still gets proven. Only a copy Unit7 took can be tested here.
  if (!g.provenAt && (steps.length || g.copies.mine)) steps.push({ tool: 'part.verify', input: base, label: 'a test restore' });
  if (!g.extrasAt || nowMs - Date.parse(g.extrasAt) > STALE) steps.push({ tool: 'part.copy_extras', input: base, label: 'files and settings' });
  return steps;
}

export async function runLadder(app: App, orgId: string, g: Guarded, act: Act) {
  const runId = id('srn'), done: string[] = [];
  let proof: string | undefined;
  run(app.db, 'INSERT INTO safety_runs (id, org_id, server_id, part, name, status, steps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', runId, orgId, g.serverId || null, g.part, g.name, 'running', '[]', now());
  const failed = (why: string) => {
    run(app.db, 'UPDATE safety_runs SET status = ?, steps = ?, why = ?, finished_at = ? WHERE id = ?', 'failed', JSON.stringify(done), why.slice(0, 400), now(), runId);
    const fails = get<{ n: number }>(app.db, `SELECT count(*) n FROM safety_runs WHERE org_id = ? AND part = ? AND status = 'failed' AND created_at > ?`, orgId, g.part, new Date(Date.now() - 2 * DAY).toISOString())!.n;
    if (fails === 2) app.events.emit(orgId, 'safety.failed', `The Safety Net couldn’t protect ${g.name}: ${why.slice(0, 200)}`, { severity: 'warning', resource: g.serverId || undefined, data: { part: g.part } });
    return { ok: false, done, why };
  };
  for (const step of ladderFor(g)) {
    const r = await act(orgId, step.tool, step.input, `the Safety Net: ${step.label} for ${g.name}`);
    if (r.status !== 'ok') {
      const why = r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? r.why : r.status;
      // a copy that came back short is still a copy, and files and settings don't depend on it: they're taken anyway
      if (step.tool === 'part.verify') { proof = why; continue; }
      return failed(why);
    }
    done.push(step.label);
  }
  if (proof) return failed(proof);
  run(app.db, 'UPDATE safety_runs SET status = ?, steps = ?, finished_at = ? WHERE id = ?', 'done', JSON.stringify(done), now(), runId);
  if (done.length) app.events.emit(orgId, 'safety.protected', g.level === 'unprotected' ? `${g.name} had no safe copy. Unit7 made ${done.join(', ')}. Nothing else changed.` : `Unit7 refreshed ${g.name}’s protection: ${done.join(', ')}. Nothing else changed.`, { severity: 'success', resource: g.serverId || undefined, data: { part: g.part, level: g.level } });
  return { ok: true, done };
}

// --- what Coolify keeps by itself --------------------------------------------------------------------------------------
export async function refreshCoolifySeen(app: App, orgId: string, act: Act) {
  for (const s of all<{ id: string }>(app.db, `SELECT id FROM servers WHERE org_id = ? AND status = 'ready'`, orgId)) {
    const inv: Inventory | undefined = lastXray(app.db, orgId, s.id)?.data;
    if (!inv?.coolify?.connected) continue;
    for (const p of inv.parts.filter((x) => x.coolify?.type === 'database')) {
      const r = await act(orgId, 'coolify.backup', { serverId: s.id, uuid: p.coolify!.uuid, op: 'list' }, 'what Coolify keeps by itself');
      if (r.status !== 'ok') continue;
      const list = (r.output ?? []) as { offServer?: boolean; recent?: { status?: string; at?: string }[] }[];
      const ok = list.flatMap((x) => x.recent ?? []).filter((x) => x.status === 'success' && x.at).map((x) => new Date(x.at!).toISOString()).sort();
      run(app.db, `INSERT INTO coolify_backups_seen (org_id, server_id, part, count, last_ok, off_server, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (server_id, part)
        DO UPDATE SET count = excluded.count, last_ok = excluded.last_ok, off_server = excluded.off_server, at = excluded.at`, orgId, s.id, p.id, ok.length, ok.at(-1) ?? null, list.some((x) => x.offServer) ? 1 : 0, now());
    }
  }
}

// Warden, every 15 minutes: one thing at a time, per organisation, only when it's on, not paused, not Observe, and the
// server is calm. A failed ladder rests for six hours.
export async function safetyTick(app: App, act: Act, nowMs = Date.now()) {
  for (const o of all<{ id: string; autonomy: number; safety_net: number }>(app.db, 'SELECT id, autonomy, safety_net FROM orgs WHERE paused_at IS NULL')) {
    if (!o.safety_net || o.autonomy < 1) continue;
    await refreshCoolifySeen(app, o.id, act).catch(() => undefined);
    const s = settingsOf(app.db, o.id);
    // the first time, it says what it's about to do before doing it, and then never again
    const important = protectionOf(app.db, o.id, nowMs).filter((x) => x.important), waiting = important.filter((g) => ladderFor(g, nowMs).length);
    if (!s.announced && important.length) {
      run(app.db, 'UPDATE orgs SET safety = ? WHERE id = ?', JSON.stringify({ ...s, announced: new Date(nowMs).toISOString() }), o.id);
      app.events.emit(o.id, 'safety.started', `I found ${important.length} important database${important.length === 1 ? '' : 's'}.${waiting.length ? ' Making safe copies now.' : ''} This changes nothing.`, { severity: 'success' });
    }
    for (const g of important) {
      if (!ladderFor(g, nowMs).length) continue;
      if (!mayCopy(app.db, o.id, g.serverId || undefined, nowMs) || (g.serverId && !quietHourOf(app.db, g.serverId, nowMs).calmNow)) continue;
      if (get(app.db, `SELECT 1 FROM safety_runs WHERE org_id = ? AND part = ? AND status = 'failed' AND created_at > ?`, o.id, g.part, new Date(nowMs - RETRY).toISOString())) continue;
      await runLadder(app, o.id, g, act);
      break;
    }
  }
}
