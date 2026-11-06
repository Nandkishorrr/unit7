// Keep it fresh · when. Warden's sweep asks this every few minutes. Per organisation, one pipeline at a time:
//  1. look again at each app every 12 hours (fresh.plan, a couple per pass)
//  2. a security fix that can't wait (critical at once, high after quiet hours): today, instead of the weekly run
//  3. the weekly run in the app's quietest hour (never Friday evening), then its major versions in "Everything"
//  4. a server's security updates inside its restart window, one server at a time
//  5. a newer image for a Coolify app, weekly
//  6. the weekly report, Monday morning on the person's clock
// Below "Ask first" nothing is prepared: a card says what's ready and a person's Release does the rest. Freeze windows
// and holds are respected throughout (plan.ts). Everything runs as Warden through the gate.
import type { App } from '../app.ts';
import type { ToolResult } from '../tools/runtime.ts';
import { all, get, json, run, type DB } from '../db.ts';
import { archivedServices } from '../archive.ts';
import { quietNow, settingsOf, clockAt } from '../sentinel/schedule.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import { rebootView } from '../tools/reboot.ts';
import { lastXray } from '../tools/xray.ts';
import type { Inventory } from '../discovery/xray.ts';
import { DEFAULT_SLOT, emergency, inSlot, pausedBy, securityOnly, weeklyDue, weeklyLine, streakWords, type Planned } from './plan.ts';
import { newBatch, openBatch, projectOf } from './pipeline.ts';
import { baseImage } from './detect.ts';
import { SCAN_EVERY, freshApps, holdsOf, levelOf, modeOf, orgFresh, planOf, saveOrgFresh, scanOf, slotOf, streakOf, weekOf } from '../tools/fresh.ts';

type Act = (orgId: string, tool: string, input: unknown, reason: string) => Promise<ToolResult>;
const DAY = 86400_000;
export const running = new Set<string>(); // organisations with a pipeline going
const tried = new Map<string, number>();  // undo pull requests looked at (at most hourly)

const recent = (db: DB, orgId: string, where: { serviceId?: string; serverId?: string }, keys: string[], sinceMs: number) => !!get(db,
  `SELECT 1 FROM fresh_batches WHERE org_id = ? AND ${where.serviceId ? 'service_id' : 'server_id'} = ? AND key IN (${keys.map(() => '?').join(',')}) AND created_at > ? LIMIT 1`,
  orgId, where.serviceId ?? where.serverId!, ...keys, new Date(sinceMs).toISOString());

// below "Ask first": nothing is prepared, a card says what's ready (once per batch)
function card(app: App, orgId: string, svc: { id: string; name: string }, p: Planned, urgent = false) {
  const open = openBatch(app.db, orgId, { serviceId: svc.id }, p.key);
  // a card already showing gets this week's list (one that's being prepared is left alone)
  if (open && open.status === 'waiting' && !open.steps.some((x) => x.key === 'apply')) run(app.db, 'UPDATE fresh_batches SET title = ?, items = ?, data = json_set(data, \'$.summary\', json(?)) WHERE id = ?', p.title, JSON.stringify(p.items), JSON.stringify(p.summary), open.id);
  if (open) return;
  const bid = newBatch(app.db, orgId, { serviceId: svc.id, kind: p.kind, key: p.key, title: p.title, items: p.items, status: 'waiting', by: 'Warden', data: { summary: p.summary } });
  const at = new Date().toISOString();
  run(app.db, 'UPDATE fresh_batches SET steps = ? WHERE id = ?', JSON.stringify([{ key: 'find', state: 'done', at, ms: 0, note: p.title }, { key: 'accept', state: 'waiting', at, note: 'Ready when you are: Release tests it on a copy first, then ships it.' }]), bid);
  app.events.emit(orgId, 'fresh.ready', `${p.kind === 'major' ? p.title : `${p.items.length || 1} update${p.items.length === 1 ? '' : 's'}`} ready for ${svc.name}${p.security ? ` (${p.security} security)` : ''} · Release`, { severity: urgent ? 'warning' : 'info', projectId: projectOf(app.db, svc.id), resource: svc.id, data: { batch: bid, serviceId: svc.id } });
}

// returns the pipelines it started (they carry on in the background; tests wait for them)
export async function freshTick(app: App, act: Act, nowMs = Date.now()): Promise<Promise<ToolResult>[]> {
  const { db } = app;
  const out: Promise<ToolResult>[] = [];
  for (const { id: org } of all<{ id: string }>(db, 'SELECT id FROM orgs WHERE paused_at IS NULL')) {
    const archived = archivedServices(db, org);
    const apps = freshApps(db, org).filter((s) => !archived.has(s.id) && modeOf(db, org, s).mode !== 'off' && json<{ source?: { type?: string } }>(s.config, {}).source?.type !== 'upload');
    // 1. look again every 12 hours
    let looked = 0;
    for (const s of apps) {
      const sc = scanOf(db, s.id);
      if (looked < 2 && (!sc || nowMs - Date.parse(sc.at) > SCAN_EVERY)) { looked++; await act(org, 'fresh.plan', { serviceId: s.id }, 'looking for updates'); }
    }
    report(app, org, nowMs);
    if (running.has(org)) continue;
    const work = pickWork(app, org, apps, nowMs);
    if (!work) continue;
    running.add(org);
    // one at a time; the pipeline can take a while, so it carries on in the background
    out.push(act(org, 'fresh.run', work.input, work.reason).finally(() => running.delete(org)));
  }
  return out;
}

function pickWork(app: App, org: string, apps: ReturnType<typeof freshApps>, nowMs: number): { input: Record<string, unknown>; reason: string } | undefined {
  const { db } = app;
  const tz = settingsOf(db, org).tz, quiet = quietNow(db, org, nowMs), holds = holdsOf(db, org);
  // an undo pull request after a rollback goes in once green
  for (const b of all<{ id: string; service_id: string; data: string }>(db, `SELECT id, service_id, data FROM fresh_batches WHERE org_id = ? AND status = 'rolled_back' AND created_at > ?`, org, new Date(nowMs - 14 * DAY).toISOString())) {
    const pr = json<{ revertPr?: { merged?: boolean } }>(b.data, {}).revertPr;
    if (pr && !pr.merged && nowMs - (tried.get(b.id) ?? 0) > 3600_000) { tried.set(b.id, nowMs); return { input: { serviceId: b.service_id, batch: b.id }, reason: 'taking a rolled-back update back out of the main branch' }; }
  }
  for (const s of apps) {
    const { plan, level } = planOf(db, org, s, nowMs);
    if (plan.paused) continue;
    // 2. can't wait
    const e = emergency(plan, quiet);
    if (e.go && !recent(db, org, { serviceId: s.id }, ['security', 'weekly'], nowMs - DAY)) {
      const p = plan.batches.map((b) => securityOnly(b)).find((b) => !!b);
      if (p && level >= 2) return { input: { serviceId: s.id, batch: 'security' }, reason: e.why };
      if (p) card(app, org, s, p, true);
    }
    // 3. the weekly run, in the app's quietest hour
    const slot = slotOf(db, org, s);
    const last = get<{ at: string }>(db, `SELECT max(created_at) at FROM fresh_batches WHERE org_id = ? AND service_id = ? AND key IN ('weekly', 'image')`, org, s.id)?.at;
    if (weeklyDue(slot, last, nowMs, tz)) {
      const p = plan.batches.find((b) => b.kind === 'weekly') ?? plan.batches.find((b) => b.kind === 'image');
      if (!p) { newBatch(db, org, { serviceId: s.id, kind: 'weekly', key: 'weekly', title: 'Up to date', items: [], status: 'up_to_date', by: 'Warden' }); continue; }
      if (level >= 2) return { input: { serviceId: s.id, batch: p.key }, reason: `the weekly updates for ${s.name}` };
      card(app, org, s, p);
      continue;
    }
    // …then its major versions, each on its own (prepared, then they wait for a person below Autopilot)
    if (inSlot(slot, nowMs, tz)) {
      for (const m of plan.batches.filter((b) => b.kind === 'major').slice(0, 2)) {
        if (recent(db, org, { serviceId: s.id }, [m.key], nowMs - 6 * DAY) || openBatch(db, org, { serviceId: s.id }, m.key)) continue;
        if (level >= 2) return { input: { serviceId: s.id, batch: m.key }, reason: `trying ${m.title} on a copy of ${s.name}` };
        card(app, org, s, m);
      }
    }
  }
  if (pausedBy(holds, undefined, nowMs)) return undefined;
  // 4. a server's security updates, inside its restart window
  const o = orgFresh(db, org);
  const report = get<{ findings: string }>(db, 'SELECT findings FROM security_reports WHERE org_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1', org, new Date(nowMs - 7 * DAY).toISOString());
  const findings = json<{ id: string; title: string }[]>(report?.findings, []);
  for (const s of all<ServerRow>(db, `SELECT s.* FROM servers s JOIN reboot_windows w ON w.server_id = s.id WHERE s.org_id = ? AND s.status = 'ready'`, org)) {
    const v = rebootView(db, s, nowMs);
    const pending = Number(/(\d+) security update/.exec(findings.find((f) => f.id === `server:updates:${s.id}`)?.title ?? '')?.[1] ?? 0);
    if (!v.inside || !pending || !v.next || o.patched?.[s.id] === Date.parse(v.next)) continue;
    if (all(db, `SELECT 1 FROM fresh_batches WHERE org_id = ? AND kind = 'server' AND status = 'running'`, org).length) break;
    saveOrgFresh(db, org, { patched: { ...o.patched, [s.id]: Date.parse(v.next) } });
    return { input: { serverId: s.id }, reason: `${pending} security update${pending === 1 ? '' : 's'} waiting on ${s.name}` };
  }
  return undefined;
}

// 5. Coolify apps' images: weekly, in the organisation's default slot (Tuesday 03:00 on the person's clock). Network
// lookups, so it runs on its own (Warden calls it hourly); the run itself goes through fresh.run like any other.
export async function coolifyImages(app: App, act: Act, nowMs = Date.now()) {
  const { db } = app;
  for (const { id: org } of all<{ id: string }>(db, 'SELECT id FROM orgs WHERE paused_at IS NULL')) {
    const o = orgFresh(db, org), c = clockAt(nowMs, settingsOf(db, org).tz);
    if ((o.mode ?? 'minor') === 'off' || running.has(org) || pausedBy(holdsOf(db, org), undefined, nowMs)) continue;
    if (c.day !== DEFAULT_SLOT.day || Math.floor(c.minutes / 60) !== DEFAULT_SLOT.hour || (o.coolifyAt && nowMs - Date.parse(o.coolifyAt) < 6 * DAY)) continue;
    saveOrgFresh(db, org, { coolifyAt: new Date(nowMs).toISOString() });
    for (const s of all<{ id: string }>(db, `SELECT id FROM servers WHERE org_id = ? AND status = 'ready'`, org)) {
      const inv = lastXray<Inventory>(db, org, s.id)?.data;
      for (const p of (inv?.parts ?? []).filter((x) => x.coolify?.uuid && (x.coolify.type === 'service' || x.coolify.type === 'application') && x.startedAt)) {
        const images = [p.image, ...(p.internals ?? []).map((i) => i.image)].filter((i): i is string => !!i && !/^[a-z0-9]{20,}(:|$)/.test(i)); // built locally: not on a registry
        const newer = (await Promise.all(images.slice(0, 4).map((i) => baseImage(i, p.startedAt)))).filter((b) => b.newer);
        if (!newer.length || openBatch(db, org, { serverId: s.id }, `coolify:${p.coolify!.uuid}`)) continue;
        const bid = newBatch(db, org, { serverId: s.id, kind: 'coolify', key: `coolify:${p.coolify!.uuid}`, title: `A newer image for ${p.name}`, items: [], by: 'Warden',
          data: { uuid: p.coolify!.uuid, coolifyKind: p.coolify!.type, part: p.name, image: newer[0]!.image, summary: [`${newer.map((b) => b.image).join(' and ')} has a newer build.`, 'Coolify pulls it and checks its health before the old one stops.', 'Nothing in your settings changes.'] } });
        if (levelOf(db, org) >= 2) { running.add(org); void act(org, 'fresh.run', { serverId: s.id, uuid: p.coolify!.uuid, batch: bid }, `a newer image for ${p.name}`).finally(() => running.delete(org)); return; }
      }
    }
  }
}

// 6. Monday from 08:00 on the person's clock, once a week, when something happened
export function report(app: App, org: string, nowMs = Date.now()) {
  const { db } = app;
  const o = orgFresh(db, org), c = clockAt(nowMs, settingsOf(db, org).tz);
  if (o.report === false || c.day !== 1 || c.minutes < 8 * 60 || c.minutes >= 12 * 60 || (o.lastReport && nowMs - Date.parse(o.lastReport) < 6 * DAY)) return false;
  if (!get(db, 'SELECT 1 FROM fresh_batches WHERE org_id = ? AND created_at > ? LIMIT 1', org, new Date(nowMs - 7 * DAY).toISOString())) return false;
  saveOrgFresh(db, org, { lastReport: new Date(nowMs).toISOString() });
  const w = weekOf(db, org, nowMs), st = streakOf(db, org, nowMs);
  app.events.emit(org, 'fresh.weekly', `${weeklyLine(w)}${st.weeks ? ` ${streakWords(st.weeks)}.` : ''}`, { severity: 'info', data: { week: w, streak: st.weeks } });
  return true;
}
