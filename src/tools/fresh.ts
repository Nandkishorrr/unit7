// Keep it fresh: automatic updates with proof. Each week Unit7 updates an app's libraries (and rebuilds on a fresh base
// image, patches its servers, refreshes Coolify images), tries them on a test copy, releases them with zero downtime and
// takes them back by itself when anything looks worse. Security fixes that can't wait go the same day.
//   fresh.plan / fresh.status / fresh.report: what's outdated, what's planned, how the week went (reads)
//   fresh.run: get a batch ready (Find → Check) and ask the gate about Accept; fresh.release: Accept → Release → Watch
//   fresh.hold / fresh.settings: hold a library or an app, freeze windows, how far updates go (raising it is a person's)
//   fresh.server_patch: a server's system updates, inside its restart window
// How far updates go by themselves follows the app's autonomy (policy.ts levels): plan.ts acceptance().
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { fid } from './helpers.ts';
import { serverRow } from './servers.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { githubToken, mergePull, parseRepo, pullCheck } from '../connectors/github.ts';
import { settingsOf } from '../sentinel/schedule.ts';
import type { Summary } from '../sentinel/traffic.ts';
import type { ServiceConfig } from '../deploy/deployer.ts';
import { deployRunning, rebootView } from './reboot.ts';
import { releaseNotes, scanApp, type Scan } from '../fresh/detect.ts';
import {
  DEFAULT_MODE, MODES, MODE_WORDS, acceptance, isoWeek, majorBullets, nextRun, nice, pausedBy, planBatches, quietSlot, securityOnly, slotWords, streak, streakWords, weeklyLine,
  type Hold, type Kind, type Mode, type Plan, type Planned, type Week,
} from '../fresh/plan.ts';
import { batchesOf, loadBatch, newBatch, openBatch, runBatch, type Batch } from '../fresh/pipeline.ts';

const HOUR = 3600_000, DAY = 86400_000;
export const SCAN_EVERY = 12 * HOUR;
const LEVEL_WORDS = ['Watch', 'Suggest', 'Ask first', 'Fix itself', 'Autopilot'];
type Svc = { id: string; org_id: string; project_id: string; environment_id: string; server_id: string | null; name: string; kind: string; config: string; current_deployment_id: string | null };

// --- settings, levels, holds ------------------------------------------------------------------------------------------
export interface OrgFresh { mode?: Mode; report?: boolean; lastReport?: string; patched?: Record<string, number>; coolifyAt?: string }
export const orgFresh = (db: DB, orgId: string) => json<OrgFresh>(get<{ fresh: string }>(db, 'SELECT fresh FROM orgs WHERE id = ?', orgId)?.fresh, {});
export const saveOrgFresh = (db: DB, orgId: string, patch: Partial<OrgFresh>) => run(db, 'UPDATE orgs SET fresh = json_patch(fresh, ?) WHERE id = ?', JSON.stringify(patch), orgId);
export function modeOf(db: DB, orgId: string, svc?: Pick<Svc, 'config'>): { mode: Mode; own: boolean } {
  const own = svc && json<{ fresh?: { mode?: Mode } }>(svc.config, {}).fresh?.mode;
  return own && MODES.includes(own) ? { mode: own, own: true } : { mode: orgFresh(db, orgId).mode ?? DEFAULT_MODE, own: false };
}
// the autonomy that decides, as at the gate: the app's environment, else the organisation's
export function levelOf(db: DB, orgId: string, serviceId?: string | null): number {
  const e = serviceId ? get<{ autonomy: number }>(db, 'SELECT e.autonomy FROM environments e JOIN services s ON s.environment_id = e.id WHERE s.id = ? AND s.org_id = ?', serviceId, orgId)?.autonomy : undefined;
  return typeof e === 'number' ? e : get<{ autonomy: number }>(db, 'SELECT autonomy FROM orgs WHERE id = ?', orgId)?.autonomy ?? 3;
}
export const holdsOf = (db: DB, orgId: string): Hold[] => all<{ id: string; service_id: string | null; package: string | null; starts: string | null; until: string | null; reason: string | null; by: string | null }>(db,
  'SELECT * FROM fresh_holds WHERE org_id = ? AND (until IS NULL OR until > ?) ORDER BY created_at', orgId, now()).map((h) => ({ id: h.id, serviceId: h.service_id, package: h.package, starts: h.starts, until: h.until, reason: h.reason, by: h.by }));
export const scanOf = (db: DB, serviceId: string) => { const r = get<{ at: string; data: string }>(db, 'SELECT at, data FROM fresh_scans WHERE service_id = ?', serviceId); return r && { ...json<Scan & { notes?: Record<string, string[]> }>(r.data, {} as Scan), at: r.at }; };
const svcOf = (db: DB, orgId: string, serviceId: string) => {
  const s = get<Svc>(db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', serviceId, orgId);
  if (!s) throw new Unit7Error('not_found', 'That app was not found.', 404);
  return s;
};

// the app's quietest hour, learned from what the server watch counted for its own sites
export function slotOf(db: DB, orgId: string, svc: Pick<Svc, 'id' | 'server_id'>) {
  const hosts = all<{ hostname: string }>(db, 'SELECT hostname FROM domains WHERE service_id = ?', svc.id).map((d) => d.hostname);
  const wins = svc.server_id ? all<{ at: string; summary: string }>(db, 'SELECT at, summary FROM traffic_windows WHERE server_id = ? AND at > ?', svc.server_id, new Date(Date.now() - 28 * DAY).toISOString()) : [];
  const counted = wins.map((w) => { const s = json<Partial<Summary>>(w.summary, {}); const mine = s.hosts?.filter((h) => hosts.includes(h.host)); return { at: w.at, requests: mine?.length ? mine.reduce((a, h) => a + h.n, 0) : s.requests ?? 0 }; });
  return quietSlot(counted, settingsOf(db, orgId).tz);
}

export function planOf(db: DB, orgId: string, svc: Svc, nowMs = Date.now()): { plan: Plan; scan?: ReturnType<typeof scanOf>; mode: Mode; own: boolean; level: number } {
  const scan = scanOf(db, svc.id), m = modeOf(db, orgId, svc), level = levelOf(db, orgId, svc.id);
  const plan = scan ? planBatches(scan, { mode: m.mode, holds: holdsOf(db, orgId), serviceId: svc.id, app: svc.name, now: nowMs }) : { batches: [], held: [], later: [] };
  return { plan, scan, mode: m.mode, own: m.own, level };
}

// --- what the UI shows ---------------------------------------------------------------------------------------------------
export function batchView(db: DB, orgId: string, b: Batch) {
  const level = levelOf(db, orgId, b.service_id), mode = modeOf(db, orgId, b.service_id ? get<Svc>(db, 'SELECT config FROM services WHERE id = ?', b.service_id) : undefined).mode;
  return { id: b.id, kind: b.kind, key: b.key, status: b.status, title: b.title, items: b.items, steps: b.steps, why: b.why, createdAt: b.created_at, finishedAt: b.finished_at,
    summary: b.data.summary ?? [], notes: b.data.notes ?? {}, pr: b.data.pr ?? null, tests: b.data.tests ?? null, smoke: b.data.smoke ?? null, preview: b.data.preview ?? null,
    deploymentId: b.data.deploymentId ?? null, downSeconds: b.data.downSeconds ?? null, approvalId: b.data.approvalId ?? null, revertPr: b.data.revertPr ?? null,
    diff: b.data.diff ?? '', files: b.data.files ?? '', accept: acceptance(level, mode, b) };
}
const plannedView = (p: Planned, level: number, mode: Mode) => ({ ...p, accept: acceptance(level, mode, p) });

export function appView(db: DB, orgId: string, svc: Svc, nowMs = Date.now()) {
  const { plan, scan, mode, own, level } = planOf(db, orgId, svc, nowMs);
  const slot = slotOf(db, orgId, svc), tz = settingsOf(db, orgId).tz;
  const next = nextRun(slot, nowMs, tz, holdsOf(db, orgId), svc.id);
  const batches = batchesOf(db, orgId, svc.id, 12);
  const open = batches.find((b) => ['planned', 'running', 'waiting'].includes(b.status));
  const latest = batches.find((b) => b.status !== 'up_to_date');
  const weekly = plan.batches.find((b) => b.kind === 'weekly');
  const waiting = (weekly?.items.length ?? 0) + plan.batches.filter((b) => b.kind === 'major').length;
  const security = plan.batches.reduce((n, b) => n + b.security, 0);
  const supported = !!scan && scan.source !== 'none';
  const state = !scan ? 'unchecked' : !supported ? 'unsupported' : mode === 'off' ? 'off' : open?.status === 'running' ? 'running' : plan.paused ? 'paused'
    : open?.status === 'waiting' ? 'waiting' : latest && ['held', 'failed', 'rolled_back'].includes(latest.status) && Date.now() - Date.parse(latest.created_at) < 7 * DAY && waiting ? 'held'
    : waiting || plan.batches.length ? 'waiting' : 'fresh';
  const auto = acceptance(level, mode, { kind: 'weekly', items: [] }).auto;
  const when = next ? `${auto ? 'releasing' : 'ready'} ${slotWords(slot)}` : '';
  const line = state === 'fresh' ? 'Up to date' : state === 'unchecked' ? 'Not checked yet' : state === 'unsupported' ? 'Unit7 can’t read what this app uses'
    : state === 'off' ? 'Updates are off for this app' : state === 'paused' ? plan.paused!.why : state === 'running' ? `Updating now: ${open!.title}`
    : [waiting ? `${waiting} waiting` : plan.batches.some((b) => b.kind === 'image') ? 'A fresh base image' : '', security ? `${security} security` : '', when].filter(Boolean).join(' · ');
  return {
    serviceId: svc.id, app: svc.name, projectId: svc.project_id, state, line, mode, modeWords: MODE_WORDS[mode], modeOwn: own, level, levelWords: LEVEL_WORDS[level] ?? 'Fix itself',
    checkedAt: scan?.at ?? null, problems: scan?.problems ?? [], source: scan?.source ?? null, deps: scan?.deps ?? 0, managers: scan?.managers ?? [],
    counts: { waiting, security, majors: plan.batches.filter((b) => b.kind === 'major').length },
    batches: plan.batches.map((p) => plannedView(p, level, mode)), held: plan.held, later: plan.later, paused: plan.paused ?? null,
    base: scan?.base ?? [], advisories: (scan?.advisories ?? []).slice(0, 20),
    schedule: { slot: slotWords(slot), learned: slot.learned, next: next ? new Date(next).toISOString() : null },
    current: open ? batchView(db, orgId, open) : latest ? batchView(db, orgId, latest) : null,
    recent: batches.slice(0, 6).map((b) => ({ id: b.id, kind: b.kind, title: b.title, status: b.status, why: b.why, at: b.created_at, downSeconds: b.data.downSeconds ?? null })),
    holds: holdsOf(db, orgId).filter((h) => h.serviceId === svc.id || !h.serviceId),
    streak: streakOf(db, orgId, nowMs, svc.id),
  };
}

// apps Unit7 keeps up to date: its own, live, not previews
export const freshApps = (db: DB, orgId: string) => all<Svc>(db, `SELECT s.* FROM services s JOIN deployments d ON d.id = s.current_deployment_id WHERE s.org_id = ? AND s.kind IN ('app', 'worker')
  AND json_extract(s.config, '$.previewOf') IS NULL AND d.status IN ('live', 'stopped') ORDER BY s.name`, orgId);

// --- the week and the streak -------------------------------------------------------------------------------------------------
const HELD_WORDS: Record<string, string> = { test: 'tests failed', check: 'pages answered differently', staging: 'the test copy didn’t start', watch: 'rolled back', release: 'release didn’t go', apply: 'nothing to change' };
export function weekOf(db: DB, orgId: string, nowMs = Date.now()): Week {
  const rows = all<{ service_id: string | null; server_id: string | null; status: string; items: string; data: string; steps: string }>(db, 'SELECT service_id, server_id, status, items, data, steps FROM fresh_batches WHERE org_id = ? AND created_at > ?', orgId, new Date(nowMs - 7 * DAY).toISOString());
  const out = rows.filter((r) => r.status === 'released');
  const items = (r: { items: string }) => json<{ security?: unknown[] }[]>(r.items, []);
  const downs = out.map((r) => json<{ downSeconds?: number | null }>(r.data, {}).downSeconds).filter((d): d is number => typeof d === 'number');
  return {
    updates: out.reduce((n, r) => n + Math.max(1, items(r).length), 0), apps: new Set(out.map((r) => r.service_id ?? r.server_id)).size,
    security: out.reduce((n, r) => n + items(r).filter((i) => i.security?.length).length, 0), downSeconds: downs.length ? downs.reduce((a, b) => a + b, 0) : null,
    held: rows.filter((r) => ['held', 'failed', 'rolled_back'].includes(r.status)).map((r) => HELD_WORDS[json<{ key: string; state: string }[]>(r.steps, []).find((s) => s.state === 'failed')?.key ?? ''] ?? 'held back'),
  };
}
// a week counts as up to date when every app's last batch in it ended released or up to date
export function streakOf(db: DB, orgId: string, nowMs = Date.now(), serviceId?: string) {
  const rows = all<{ service_id: string | null; status: string; created_at: string }>(db, `SELECT service_id, status, created_at FROM fresh_batches WHERE org_id = ? ${serviceId ? 'AND service_id = ?' : ''} AND created_at > ? ORDER BY created_at`,
    ...([orgId, ...(serviceId ? [serviceId] : []), new Date(nowMs - 120 * 7 * DAY).toISOString()] as string[]));
  const last = new Map<string, Map<string, string>>();
  for (const r of rows) { const w = isoWeek(Date.parse(r.created_at)); if (!last.has(w)) last.set(w, new Map()); last.get(w)!.set(r.service_id ?? '', r.status); }
  const weeks = new Map([...last].map(([w, m]) => [w, [...m.values()].every((s) => s === 'released' || s === 'up_to_date')]));
  // a week still in progress with something only waiting doesn't break the run yet
  const cur = isoWeek(nowMs);
  if (weeks.get(cur) === false && [...last.get(cur)!.values()].every((s) => ['released', 'up_to_date', 'waiting', 'planned', 'running'].includes(s))) weeks.delete(cur);
  const n = streak(weeks, nowMs);
  return { weeks: n, words: streakWords(n) };
}
export function overview(db: DB, orgId: string, nowMs = Date.now()) {
  const where = (s: Svc) => get<{ p: string; e: string; k: string }>(db, 'SELECT p.name p, e.name e, e.kind k FROM projects p JOIN environments e ON e.id = ? WHERE p.id = ?', s.environment_id, s.project_id);
  const apps = freshApps(db, orgId).map((s) => { const v = appView(db, orgId, s, nowMs), w = where(s); return { serviceId: v.serviceId, app: v.app, projectId: v.projectId, project: w?.p ?? '', env: w?.k === 'production' ? '' : w?.e ?? '', state: v.state, line: v.line, counts: v.counts, mode: v.mode, modeOwn: v.modeOwn, level: v.level, next: v.schedule.next, slot: v.schedule.slot, checkedAt: v.checkedAt, current: v.current && { id: v.current.id, status: v.current.status, title: v.current.title, why: v.current.why } }; });
  const week = weekOf(db, orgId, nowMs), o = orgFresh(db, orgId);
  return { mode: o.mode ?? DEFAULT_MODE, modeWords: MODE_WORDS[o.mode ?? DEFAULT_MODE], report: o.report !== false, apps, week, line: weeklyLine(week), streak: streakOf(db, orgId, nowMs),
    holds: holdsOf(db, orgId), freeze: pausedBy(holdsOf(db, orgId), undefined, nowMs) ?? null };
}

// --- scanning ----------------------------------------------------------------------------------------------------------------
export async function scanAndStore(ctx: Ctx, svc: Svc) {
  const scan: Scan & { notes?: Record<string, string[]> } = await scanApp(ctx, svc);
  const token = await githubToken(ctx, json<ServiceConfig>(svc.config, {}).source?.type === 'git' ? (json<ServiceConfig>(svc.config, {}).source as { accountId?: string }).accountId : undefined).catch(() => undefined);
  // the major versions' own release notes, for the "what changes for you" bullets (a few, best effort)
  const majors = scan.updates.filter((u) => u.bump === 'major').slice(0, 4);
  scan.notes = Object.fromEntries(await Promise.all(majors.map(async (u) => [u.name, majorBullets(await releaseNotes(u.eco, u.name, u.to, token).catch(() => undefined), u.name)] as const)));
  run(ctx.db, 'INSERT INTO fresh_scans (service_id, org_id, at, data) VALUES (?, ?, ?, ?) ON CONFLICT (service_id) DO UPDATE SET at = excluded.at, data = excluded.data', svc.id, ctx.orgId, scan.at, JSON.stringify(scan));
  return scan;
}

// --- tools --------------------------------------------------------------------------------------------------------------------
const MODE = z.enum(['off', 'security', 'minor', 'all']);
const BATCH = z.string().regex(/^frb_[A-Za-z0-9_-]{12}$/, 'a batch of updates');
const PKG = z.string().min(1).max(214).regex(/^[@\w./~-]+$/, 'a library name');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, 'a date like 2026-11-01');
const iso = (d: string) => new Date(d.length === 10 ? `${d}T00:00:00Z` : d).toISOString();

defineTool({
  name: 'fresh.plan', title: 'What’s outdated', risk: 'read', action: 'read', timeoutMs: 4 * 60_000,
  description: 'Keep it fresh: for one app (serviceId), the libraries with newer versions (patch, minor, major), known security problems (OSV.dev and npm’s advisories) with their plain reason and link, a newer base image, and the batches Unit7 plans: one weekly batch with security first, each major version on its own, each with 3 plain lines of what changes, whether it goes by itself at this autonomy, and when (the app’s quietest hour). Looks again when the last look is over 12 hours old (refresh: now). Without serviceId: every app at a glance. Use for “what’s outdated?”.',
  input: z.object({ serviceId: fid('svc').optional(), refresh: z.boolean().default(false) }),
  async run(ctx, i) {
    if (!i.serviceId) return overview(ctx.db, ctx.orgId);
    const svc = svcOf(ctx.db, ctx.orgId, i.serviceId);
    const s = scanOf(ctx.db, svc.id);
    if (i.refresh || !s || Date.now() - Date.parse(s.at) > SCAN_EVERY) { ctx.progress(`Checking what ${svc.name} uses…`); await scanAndStore(ctx, svc); }
    return appView(ctx.db, ctx.orgId, svc);
  },
});

defineTool({
  name: 'fresh.status', title: 'Updates at a glance', risk: 'read', action: 'read',
  description: 'Keep it fresh, from what Unit7 already knows (no new look): one app (serviceId) or every app, with the weekly report line (“This week: 14 updates on 6 apps…”), the streak, holds and freeze windows.',
  input: z.object({ serviceId: fid('svc').optional() }),
  run: (ctx, i) => (i.serviceId ? appView(ctx.db, ctx.orgId, svcOf(ctx.db, ctx.orgId, i.serviceId)) : overview(ctx.db, ctx.orgId)),
});

defineTool({
  name: 'fresh.batch', title: 'A batch of updates', risk: 'read', action: 'read',
  description: 'One batch of updates as its steps (Find, Apply, Test, Staging, Check, Accept, Release, Watch), each with one plain line, plus its pull request, test result, page checks, release and what changes.',
  input: z.object({ batch: BATCH }),
  run(ctx, i) { const b = loadBatch(ctx.db, ctx.orgId, i.batch); if (!b) throw new Unit7Error('not_found', 'That batch of updates was not found.', 404); return batchView(ctx.db, ctx.orgId, b); },
});

// which batch: weekly (default), security (only the security part, today), image, major:<library>, or one that exists
function pick(ctx: Ctx, svc: Svc, key: string): { kind: Kind; key: string; planned?: Planned } {
  const { plan } = planOf(ctx.db, ctx.orgId, svc);
  const weekly = plan.batches.find((b) => b.kind === 'weekly');
  if (key === 'security') {
    const p = (weekly && securityOnly(weekly)) ?? plan.batches.filter((b) => b.kind === 'major' && b.security).map((b) => securityOnly(b)!)[0];
    return { kind: p?.kind ?? 'security', key: p?.key ?? 'security', planned: p };
  }
  const p = plan.batches.find((b) => b.key === key);
  return { kind: p?.kind ?? (key.startsWith('major:') ? 'major' : key === 'image' ? 'image' : 'weekly'), key, planned: p };
}

defineTool({
  name: 'fresh.run', title: 'Get updates ready', risk: 'write', action: 'fresh_prepare', timeoutMs: 3 * 3600_000,
  description: 'Keep it fresh for one app: make its batch of updates (batch: weekly by default, security for only the security fixes, image to rebuild on a fresh base image, major:<library> for one major version) on a branch with a pull request, build a test copy from it (its tests run there), compare its busiest pages with the live app, then release it when the app’s autonomy lets it go by itself (else it waits for a person’s OK, on Approvals and the phone). Stops at the first step that isn’t right and says why. A failing test is never skipped. For “update everything”, run it per app. serverId alone: that server’s system updates; serverId with uuid: a newer image for a Coolify app.',
  input: z.object({ serviceId: fid('svc').optional(), serverId: fid('srv').optional(), uuid: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/).optional(), batch: z.string().max(240).optional() }),
  async run(ctx, i) {
    const warden = ctx.actor.kind === 'agent' && ctx.actor.id === 'warden';
    if (!i.serviceId) {
      if (!i.serverId) throw new Unit7Error('invalid_input', 'Give the app (serviceId), or a server (serverId).', 400);
      const s = serverRow(ctx, i.serverId);
      const key = i.uuid ? `coolify:${i.uuid}` : 'server';
      const given = i.batch && BATCH.safeParse(i.batch).success ? loadBatch(ctx.db, ctx.orgId, i.batch) : undefined;
      const b = given ?? openBatch(ctx.db, ctx.orgId, { serverId: s.id }, key);
      const bid = b?.id ?? newBatch(ctx.db, ctx.orgId, { serverId: s.id, kind: i.uuid ? 'coolify' : 'server', key, title: i.uuid ? 'A newer image' : 'System updates', items: [], by: ctx.actor.name });
      return batchView(ctx.db, ctx.orgId, await runBatch(ctx, bid));
    }
    const svc = svcOf(ctx.db, ctx.orgId, i.serviceId);
    if (i.batch && BATCH.safeParse(i.batch).success) {
      const b = loadBatch(ctx.db, ctx.orgId, i.batch);
      if (!b || b.service_id !== svc.id) throw new Unit7Error('not_found', 'That batch of updates was not found.', 404);
      if (b.status === 'rolled_back' && b.data.revertPr && !b.data.revertPr.merged) return finishUndo(ctx, svc, b);
      if (!['planned', 'running', 'waiting'].includes(b.status)) return batchView(ctx.db, ctx.orgId, b);
      return batchView(ctx.db, ctx.orgId, await runBatch(ctx, b.id, { onlyIfAllowed: warden && b.kind === 'major' }));
    }
    if (!scanOf(ctx.db, svc.id)) await scanAndStore(ctx, svc);
    const p = pick(ctx, svc, i.batch ?? 'weekly');
    const open = openBatch(ctx.db, ctx.orgId, { serviceId: svc.id }, p.key);
    if (open) return batchView(ctx.db, ctx.orgId, await runBatch(ctx, open.id, { onlyIfAllowed: warden && open.kind === 'major' }));
    if (!p.planned) {
      // nothing to do: written down, so the week and the streak know it was checked
      newBatch(ctx.db, ctx.orgId, { serviceId: svc.id, kind: 'weekly', key: 'weekly', title: 'Up to date', items: [], status: 'up_to_date', by: ctx.actor.name });
      return { upToDate: true, app: svc.name, note: `${svc.name} is up to date${planOf(ctx.db, ctx.orgId, svc).plan.paused ? ` (${planOf(ctx.db, ctx.orgId, svc).plan.paused!.why})` : ''}.` };
    }
    const scan = scanOf(ctx.db, svc.id);
    const notes = Object.fromEntries(p.planned.items.filter((x) => scan?.notes?.[x.name]).map((x) => [x.name, scan!.notes![x.name]!]));
    const bid = newBatch(ctx.db, ctx.orgId, { serviceId: svc.id, kind: p.kind, key: p.key, title: p.planned.title, items: p.planned.items, by: ctx.actor.name,
      data: { summary: p.planned.summary, notes, level: levelOf(ctx.db, ctx.orgId, svc.id), mode: modeOf(ctx.db, ctx.orgId, svc).mode } });
    return batchView(ctx.db, ctx.orgId, await runBatch(ctx, bid, { onlyIfAllowed: warden && p.kind === 'major' }));
  },
});

// a release that rolled back by itself: its "undo" pull request goes in once its checks are green
async function finishUndo(ctx: Ctx, svc: Svc, b: Batch) {
  const cfg = json<ServiceConfig>(svc.config, {});
  const repo = cfg.source?.type === 'git' ? parseRepo(cfg.source.repo) : undefined;
  const token = repo && await githubToken(ctx, cfg.source?.type === 'git' ? cfg.source.accountId : undefined);
  if (!repo || !token || !b.data.revertPr) return batchView(ctx.db, ctx.orgId, b);
  const c = await pullCheck(repo, b.data.revertPr.number, token);
  if (c.open && c.status === 'success') await mergePull(repo, b.data.revertPr.number, token);
  if (c.merged || (c.open && c.status === 'success') || !c.open) {
    b.data.revertPr.merged = true;
    run(ctx.db, 'UPDATE fresh_batches SET data = ? WHERE id = ?', JSON.stringify(b.data), b.id);
  }
  return batchView(ctx.db, ctx.orgId, loadBatch(ctx.db, ctx.orgId, b.id)!);
}

defineTool({
  name: 'fresh.release', title: 'Release a batch of updates', risk: 'write', action: 'deploy', timeoutMs: 3 * 3600_000,
  description: 'Release a batch of updates fresh.run got ready (serviceId, or serverId for a server’s or a Coolify app’s): merge its pull request once its checks are green, deploy exactly that with zero downtime, watch it and roll back by itself if it looks worse. A batch not tested yet is tested first. Whether an AI may do this alone follows the app’s autonomy: security, patch and minor updates at “Fix itself”, majors only at Autopilot; otherwise a person approves.',
  input: z.object({ serviceId: fid('svc').optional(), serverId: fid('srv').optional(), batch: BATCH }),
  assess: (c, i) => {
    const b = loadBatch(c.db, c.orgId, i.batch);
    if (!b) return { tier: 2 };
    const svc = b.service_id ? get<Svc>(c.db, 'SELECT * FROM services WHERE id = ?', b.service_id) : undefined;
    const a = acceptance(levelOf(c.db, c.orgId, b.service_id), modeOf(c.db, c.orgId, svc).mode, b);
    return a.auto ? { tier: 1 } : { tier: 2, ask: a.why, impact: `Releases ${b.title}${svc ? ` for ${svc.name}` : ''}: merged once its checks are green, deployed with zero downtime, rolled back by itself if anything looks worse.` };
  },
  async run(ctx, i) {
    const b = loadBatch(ctx.db, ctx.orgId, i.batch);
    if (!b || (b.service_id ?? null) !== (i.serviceId ?? null) || (!b.service_id && b.server_id !== i.serverId)) throw new Unit7Error('not_found', 'That batch of updates was not found.', 404);
    if (!['planned', 'running', 'waiting'].includes(b.status)) return { ...batchView(ctx.db, ctx.orgId, b), note: b.status === 'released' ? 'Already live.' : `This batch ended (${b.why ?? b.status}). Run a new one.` };
    return batchView(ctx.db, ctx.orgId, await runBatch(ctx, b.id, { releasing: true }));
  },
});

defineTool({
  // holding back is always safe; taking a hold off lets updates go again, so that's a person's
  name: 'fresh.hold', title: 'Hold updates back', risk: 'write', action: 'service_write', peopleOnly: (i) => !!i.remove,
  description: 'Hold updates back: one library (package, for one app with serviceId or for every app), a whole app (serviceId alone), or every app for a while (a freeze window: starts and until, “not during my launch week”). until: a date; without it, until a person takes it off. remove: take a hold off (people only).',
  input: z.object({ serviceId: fid('svc').optional(), package: PKG.optional(), starts: DATE.optional(), until: DATE.optional(), reason: z.string().max(200).optional(), remove: z.string().regex(/^frh_[A-Za-z0-9_-]{12}$/).optional() }),
  run(ctx, i) {
    if (i.remove) {
      const h = get<{ package: string | null }>(ctx.db, 'SELECT package FROM fresh_holds WHERE id = ? AND org_id = ?', i.remove, ctx.orgId);
      if (!h) throw new Unit7Error('not_found', 'That hold was not found.', 404);
      run(ctx.db, 'DELETE FROM fresh_holds WHERE id = ?', i.remove);
      ctx.emit('fresh.hold', `${ctx.actor.name} let ${h.package ? nice(h.package) : 'updates'} go again`, {});
      return { holds: holdsOf(ctx.db, ctx.orgId) };
    }
    if (i.starts && (!i.until || i.package)) throw new Unit7Error('invalid_input', 'A freeze window needs a start and an end, and holds every library.', 400);
    if (!i.serviceId && !i.package && !i.starts) throw new Unit7Error('invalid_input', 'Say what to hold: a library, an app, or a freeze window.', 400);
    if (i.until && Date.parse(iso(i.until)) <= Date.now()) throw new Unit7Error('invalid_input', 'Pick a date in the future.', 400);
    const app = i.serviceId ? svcOf(ctx.db, ctx.orgId, i.serviceId).name : undefined;
    const hid = id('frh');
    run(ctx.db, 'INSERT INTO fresh_holds (id, org_id, service_id, package, starts, until, reason, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      hid, ctx.orgId, i.starts ? null : i.serviceId ?? null, i.package ?? null, i.starts ? iso(i.starts) : null, i.until ? iso(i.until) : null, i.reason ?? null, ctx.actor.name);
    const what = i.starts ? `froze updates from ${i.starts.slice(0, 10)} to ${i.until!.slice(0, 10)}` : i.package ? `held ${nice(i.package)}${app ? ` for ${app}` : ''}` : `paused updates for ${app}`;
    ctx.emit('fresh.hold', `${ctx.actor.name} ${what}${i.until && !i.starts ? ` until ${i.until.slice(0, 10)}` : ''}`, { resource: i.serviceId });
    return { hold: hid, holds: holdsOf(ctx.db, ctx.orgId), undo: { tool: 'fresh.hold', input: { remove: hid }, label: 'Take the hold off' } };
  },
});

defineTool({
  // an AI may only make updates go less far by themselves, never further
  name: 'fresh.settings', title: 'How far updates go', risk: 'write', action: 'policy_change',
  peopleOnly: (i) => (i.mode !== undefined && i.mode !== 'off' && i.mode !== 'security') || i.report !== undefined,
  description: 'Keep apps up to date: the default for every app (no serviceId) or one app’s own: mode off, security (only security fixes), minor (security, patch and minor updates; the default) or all (majors too, each on its own; majors still wait for a person below Autopilot). default (with serviceId): back to the organisation’s default. report: the weekly report on Home and the phone. Raising it is for people only.',
  input: z.object({ serviceId: fid('svc').optional(), mode: z.union([MODE, z.literal('default')]).optional(), report: z.boolean().optional() }),
  run(ctx, i) {
    if (i.serviceId) {
      const svc = svcOf(ctx.db, ctx.orgId, i.serviceId);
      const before = modeOf(ctx.db, ctx.orgId, svc);
      if (i.mode === 'default') run(ctx.db, `UPDATE services SET config = json_remove(config, '$.fresh') WHERE id = ?`, svc.id);
      else if (i.mode) run(ctx.db, `UPDATE services SET config = json_set(config, '$.fresh', json(?)) WHERE id = ?`, JSON.stringify({ mode: i.mode }), svc.id);
      const after = modeOf(ctx.db, ctx.orgId, svcOf(ctx.db, ctx.orgId, svc.id));
      ctx.emit('policy.changed', `${ctx.actor.name} set ${svc.name} to keep up to date: ${MODE_WORDS[after.mode].toLowerCase()}${after.own ? '' : ' (the default)'}`, { resource: svc.id });
      return { app: svc.name, mode: after.mode, own: after.own, undo: { tool: 'fresh.settings', input: { serviceId: svc.id, mode: before.own ? before.mode : 'default' }, label: 'Put it back' } };
    }
    const before = orgFresh(ctx.db, ctx.orgId);
    saveOrgFresh(ctx.db, ctx.orgId, { ...(i.mode && i.mode !== 'default' && { mode: i.mode }), ...(i.report !== undefined && { report: i.report }) });
    const o = orgFresh(ctx.db, ctx.orgId);
    ctx.emit('policy.changed', `${ctx.actor.name} set keeping apps up to date to ${MODE_WORDS[o.mode ?? DEFAULT_MODE].toLowerCase()}`, {});
    return { mode: o.mode ?? DEFAULT_MODE, report: o.report !== false, undo: { tool: 'fresh.settings', input: { mode: before.mode ?? DEFAULT_MODE, ...(i.report !== undefined && { report: before.report !== false }) }, label: 'Put it back' } };
  },
});

defineTool({
  name: 'fresh.report', title: 'How the week went', risk: 'read', action: 'read',
  description: 'The weekly report of keeping apps up to date: “This week: 14 updates on 6 apps, 2 security fixes, 0 seconds down, 1 held back (tests failed).”, and the streak (“12 weeks up to date”).',
  input: z.object({}),
  run(ctx) { const w = weekOf(ctx.db, ctx.orgId); return { line: weeklyLine(w), week: w, streak: streakOf(ctx.db, ctx.orgId) }; },
});

// --- a server's system updates ----------------------------------------------------------------------------------------------
export const PATCH = `SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"
count() { if command -v apt-get >/dev/null 2>&1; then apt list --upgradable 2>/dev/null | grep -ci security; elif command -v dnf >/dev/null 2>&1; then dnf -q updateinfo list --security 2>/dev/null | wc -l; else echo 0; fi; }
echo "before=$(count)"
if command -v apt-get >/dev/null 2>&1; then
  command -v unattended-upgrade >/dev/null 2>&1 || $SU env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null 2>&1
  $SU env DEBIAN_FRONTEND=noninteractive unattended-upgrade >/dev/null 2>&1 || echo failed=1
elif command -v dnf >/dev/null 2>&1; then $SU dnf -y -q upgrade --security >/dev/null 2>&1 || echo failed=1
else echo unsupported=1; fi
echo "after=$(count)"
[ -f /var/run/reboot-required ] && echo restart=1
command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo restart=1; }
true`;
export function patchWords(out: string): { line: string; restart: boolean; failed: boolean; before: number; after: number } {
  const kv = Object.fromEntries(out.split('\n').map((l) => l.trim().split('=')).filter((p) => p.length === 2)) as Record<string, string>;
  const before = Number(kv.before) || 0, after = Number(kv.after) || 0, restart = kv.restart === '1';
  if (kv.unsupported) return { line: 'Unit7 doesn’t know this system’s updater yet.', restart: false, failed: true, before, after };
  if (kv.failed) return { line: 'The system updater stopped with an error; nothing was restarted.', restart, failed: true, before, after };
  const done = Math.max(0, before - after);
  return { line: done ? `Installed ${done} security update${done === 1 ? '' : 's'}${after ? `; ${after} still waiting` : ''}.` : before ? 'Nothing could be installed yet.' : 'It was already up to date.', restart, failed: false, before, after };
}

defineTool({
  name: 'fresh.server_patch', title: 'Install a server’s security updates', risk: 'write', action: 'server_setup', timeoutMs: 40 * 60_000,
  // inside the restart window a person set, Warden's own run is theirs already; elsewhere an AI asks first
  assess: (c, i) => {
    const s = get<ServerRow>(c.db, 'SELECT * FROM servers WHERE id = ? AND org_id = ?', i.serverId, c.orgId);
    const inside = !!s && rebootView(c.db, s).inside;
    return { tier: inside && c.actor.kind === 'agent' && c.actor.id === 'warden' ? 1 : 2, impact: 'Installs the system’s security updates (apps on several servers leave rotation here first). A restart, if one is needed, waits for the restart window.' };
  },
  description: 'Install a server’s security updates (Debian/Ubuntu unattended-upgrade, or dnf --security). Apps that run on several servers stop sending visitors here first and come back after. One server at a time, never during a deploy. A restart it needs happens in the server’s restart window, after a warning.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    if (ctx.actor.id === 'warden' && !rebootView(ctx.db, s).inside) throw new Unit7Error('outside_window', `Warden only updates ${s.name} inside the restart window a person set.`, 409);
    if (deployRunning(ctx.db, s.id)) throw new Unit7Error('busy', `A deploy is running on ${s.name}. Try again once that’s done.`, 409);
    const { leaveRotation, rejoinRotation } = await import('../fleet/traffic.ts');
    const rotated = await leaveRotation(ctx, s.id);
    try {
      ctx.progress(`Installing ${s.name}’s security updates…`);
      const r = await ssh(ctx.app).exec(s, script(PATCH), { timeoutMs: 35 * 60_000, signal: ctx.signal });
      const w = patchWords(r.stdout);
      if (w.failed) throw new Unit7Error('patch_failed', w.line, 502);
      return { server: s.name, ...w };
    } finally { await rejoinRotation(ctx, s.id, rotated); }
  },
});

