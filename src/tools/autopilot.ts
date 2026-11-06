// Autopilot: how much Unit7 does on its own, and the switch that stops it. Pausing is instant and
// people-only; while paused, every AI actor (Warden, Unit7's own AI, agent tokens, your Claude Code)
// can still read but can't change anything. Per-environment levels are environment.policy.
import { z } from 'zod';
import { defineTool } from './runtime.ts';
import { all, get, json, now, run } from '../db.ts';
import { requireHuman, requireRole } from './helpers.ts';
import { Unit7Error } from '../errors.ts';
import { enablePhoneApprovals } from '../sentinel/phone.ts';
import { AUTONOMY } from '../policy.ts';
import { blockedSummary } from './activity.ts';
import { budgetOf, forecast, type CostKind } from './budget.ts';
import { autoSync } from './map.ts';

defineTool({
  name: 'autopilot.set', title: 'Pause or resume Autopilot', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'Pause (or resume) everything Unit7 and AI agents do on their own in this organization. People only. While paused, AI can read but not change anything.',
  input: z.object({ paused: z.boolean() }),
  run(ctx, i) {
    requireHuman(ctx, 'pause or resume Autopilot');
    run(ctx.db, 'UPDATE orgs SET paused_at = ? WHERE id = ?', i.paused ? now() : null, ctx.orgId);
    ctx.emit(i.paused ? 'autopilot.paused' : 'autopilot.resumed', i.paused ? `${ctx.actor.name} paused Autopilot` : `${ctx.actor.name} resumed Autopilot`, { severity: i.paused ? 'warning' : 'success' });
    return { paused: i.paused };
  },
});

// Everything on one page: the switch, each environment's level, and what Unit7 did on its own lately
// (each reversible action carries its own undo).
export function autopilotView(db: Parameters<typeof get>[0], orgId: string) {
  const org = get<{ paused_at: string | null; rotate_links_days: number; rotate_db_days: number }>(db, 'SELECT paused_at, rotate_links_days, rotate_db_days FROM orgs WHERE id = ?', orgId);
  return {
    paused: !!org?.paused_at, pausedAt: org?.paused_at ?? null, blocked: blockedSummary(db, orgId),
    rotation: { links: org?.rotate_links_days ?? 90, databases: org?.rotate_db_days ?? 0 },
    autoSync: autoSync(db, orgId),
    budget: budgetView(db, orgId),
    levels: AUTONOMY.map((label, level) => ({ level, label })),
    environments: all<{ id: string; name: string; kind: string; autonomy: number; project: string; projectId: string; earn: number; earn_cap: number | null; earn_note: string | null; earn_changed_at: string | null }>(db,
      `SELECT e.id, e.name, e.kind, e.autonomy, p.name project, p.id projectId, e.earn, e.earn_cap, e.earn_note, e.earn_changed_at FROM environments e JOIN projects p ON p.id = e.project_id WHERE e.org_id = ? ORDER BY p.name, CASE e.kind WHEN 'production' THEN 0 WHEN 'staging' THEN 1 ELSE 2 END`, orgId),
    actions: all<{ id: string; tool: string; actor_name: string; reason: string | null; result: string; output: string | null; created_at: string }>(db,
      `SELECT id, tool, actor_name, reason, result, output, created_at FROM audit WHERE org_id = ? AND actor_kind = 'agent' AND risk != 'read' ORDER BY created_at DESC LIMIT 60`, orgId)
      .map((a) => ({ id: a.id, tool: a.tool, who: a.actor_name, why: a.reason, result: a.result, at: a.created_at, undo: json<{ undo?: { tool: string; input: unknown; label: string } }>(a.output ?? '{}', {}).undo ?? null })),
  };
}

defineTool({
  name: 'alerts.phone_approvals', title: 'Approve from your phone', risk: 'write', action: 'settings_write', peopleOnly: true,
  description: 'Put Approve / Reject buttons on the phone alert for actions waiting for an OK (ntfy). Tapping one decides as the person who turned this on; nothing on this computer is opened to the internet. People only (owners and admins).',
  input: z.object({ on: z.boolean() }),
  run(ctx, i) {
    requireHuman(ctx, 'decide from a phone');
    requireRole(ctx, ['owner', 'admin'], 'approve from a phone');
    const acc = get<{ id: string }>(ctx.db, `SELECT id FROM accounts WHERE org_id = ? AND provider = 'ntfy' ORDER BY created_at LIMIT 1`, ctx.orgId);
    if (!acc) throw new Unit7Error('no_account', 'Set up phone alerts first (Connections → Phone alerts).', 409);
    enablePhoneApprovals(ctx.app, ctx.orgId, acc.id, i.on ? ctx.actor.userId : null);
    return { phoneApprovals: i.on, decidesAs: i.on ? ctx.actor.name : undefined };
  },
});

// --- Earned autonomy --------------------------------------------------------------------------------------
// With the switch on, an environment's autonomy follows the record of what AI did there. Up one level
// after a week or more in which people approved what it asked (8+ times) with no rejection and no AI action
// failing; down one level at once after rejections, an AI deploy that failed, or repeated errors. Never above
// the ceiling a person set, never below Recommend. Off = the level stays where a person put it.
const RAISE_AFTER = 8, QUIET_DAYS = 7;
export function earnedCheck(app: { db: Parameters<typeof get>[0]; events: { emit: (org: string, type: string, msg: string, o?: object) => unknown } }, envId: string) {
  const e = get<{ id: string; org_id: string; name: string; kind: string; autonomy: number; earn: number; earn_cap: number | null; earn_changed_at: string | null }>(app.db,
    'SELECT id, org_id, name, kind, autonomy, earn, earn_cap, earn_changed_at FROM environments WHERE id = ?', envId);
  if (!e?.earn) return undefined;
  const since = e.earn_changed_at && Date.parse(e.earn_changed_at) > Date.now() - 30 * 86400_000 ? e.earn_changed_at : new Date(Date.now() - 30 * 86400_000).toISOString();
  // what led to the last change already counted: only what happened since then can lower it again
  const after = (iso: string) => (e.earn_changed_at && e.earn_changed_at > iso ? e.earn_changed_at : iso);
  const week = after(new Date(Date.now() - QUIET_DAYS * 86400_000).toISOString()), day = after(new Date(Date.now() - 86400_000).toISOString());
  const count = (sql: string, ...a: unknown[]) => get<{ n: number }>(app.db, sql, ...(a as never[]))!.n;
  const agentApprovals = `FROM approvals WHERE environment_id = ? AND json_extract(actor, '$.kind') = 'agent'`;
  const approved = count(`SELECT count(*) n ${agentApprovals} AND status IN ('approved', 'executing', 'done') AND decided_at > ?`, e.id, since);
  const rejectedWeek = count(`SELECT count(*) n ${agentApprovals} AND status = 'rejected' AND decided_at > ?`, e.id, week);
  const rejectedSince = count(`SELECT count(*) n ${agentApprovals} AND status = 'rejected' AND decided_at > ?`, e.id, since);
  const errorsDay = count(`SELECT count(*) n FROM audit WHERE environment_id = ? AND actor_kind = 'agent' AND risk != 'read' AND result = 'error' AND created_at > ?`, e.id, day);
  const errorsSince = count(`SELECT count(*) n FROM audit WHERE environment_id = ? AND actor_kind = 'agent' AND risk != 'read' AND result = 'error' AND created_at > ?`, e.id, since);
  const failedDeploys = count(`SELECT count(*) n FROM audit WHERE environment_id = ? AND actor_kind = 'agent' AND tool LIKE 'deployment.%' AND result = 'error' AND created_at > ?`, e.id, week);
  const cap = e.earn_cap ?? (e.kind === 'production' ? 3 : 4);
  const change = (to: number, why: string) => {
    run(app.db, 'UPDATE environments SET autonomy = ?, earn_changed_at = ?, earn_note = ? WHERE id = ?', to, now(), why, e.id);
    app.events.emit(e.org_id, to > e.autonomy ? 'autonomy.raised' : 'autonomy.lowered', `${e.name}: autonomy ${to > e.autonomy ? 'raised' : 'lowered'} to ${AUTONOMY[to]} (${why})`, { severity: to > e.autonomy ? 'success' : 'warning', environmentId: e.id, resource: e.id });
    return { from: e.autonomy, to, why };
  };
  // down first: trust is lost faster than it's earned
  if (e.autonomy > 1 && (rejectedWeek >= 2 || failedDeploys > 0 || errorsDay >= 3)) {
    return change(e.autonomy - 1, rejectedWeek >= 2 ? `${rejectedWeek} of its requests were rejected this week` : failedDeploys ? 'a deploy it started failed' : `${errorsDay} of its actions failed today`);
  }
  if (e.autonomy > cap) return change(cap, `the ceiling is ${AUTONOMY[cap]}`);
  const quietLongEnough = !e.earn_changed_at || Date.parse(e.earn_changed_at) < Date.now() - QUIET_DAYS * 86400_000;
  if (e.autonomy < cap && quietLongEnough && approved >= RAISE_AFTER && rejectedSince === 0 && errorsSince === 0) {
    return change(e.autonomy + 1, `${approved} of its requests approved, none rejected, nothing failed`);
  }
  return { from: e.autonomy, to: e.autonomy, why: 'no change', approved, rejected: rejectedSince, errors: errorsSince, cap };
}

defineTool({
  name: 'environment.earn', title: 'Earned autonomy', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'Let an environment earn autonomy (on) or keep its level fixed (off). On: Unit7 raises the level one step after a week of approved requests with no rejections or failures, and lowers it at once after rejections or failures; never above the ceiling (default: production 3, others 4). People only.',
  input: z.object({ environmentId: z.string().regex(/^env_[\w-]{12}$/), on: z.boolean(), cap: z.number().int().min(1).max(4).optional() }),
  run(ctx, i) {
    requireHuman(ctx, 'change how autonomy is decided');
    const e = get<{ id: string; name: string; kind: string }>(ctx.db, 'SELECT id, name, kind FROM environments WHERE id = ? AND org_id = ?', i.environmentId, ctx.orgId);
    if (!e) throw new Unit7Error('not_found', 'That environment was not found.', 404);
    run(ctx.db, 'UPDATE environments SET earn = ?, earn_cap = coalesce(?, earn_cap), earn_changed_at = ?, earn_note = ? WHERE id = ?', i.on ? 1 : 0, i.cap ?? null, now(), i.on ? 'started earning' : null, e.id);
    ctx.emit('policy.changed', `${ctx.actor.name} ${i.on ? `let ${e.name} earn autonomy (ceiling ${AUTONOMY[i.cap ?? (e.kind === 'production' ? 3 : 4)]})` : `fixed ${e.name}'s autonomy`}`, { severity: 'warning', resource: e.id });
    return { environment: e.name, earn: i.on, cap: i.cap ?? (e.kind === 'production' ? 3 : 4) };
  },
});

// --- Secret rotation --------------------------------------------------------------------------------------
defineTool({
  name: 'secrets.rotation', title: 'Rotate secrets automatically', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'How often Unit7 changes secrets by itself (days; 0 = never): connection keys (no downtime: the API accepts the old key for a day) and Unit7-run database passwords (apps redeploy; done at 03:00 UTC). A secret found in the code is changed at once either way. People only.',
  input: z.object({ links: z.number().int().min(0).max(3650).optional(), databases: z.number().int().min(0).max(3650).optional() }),
  run(ctx, i) {
    requireHuman(ctx, 'change how often secrets rotate');
    run(ctx.db, 'UPDATE orgs SET rotate_links_days = coalesce(?, rotate_links_days), rotate_db_days = coalesce(?, rotate_db_days) WHERE id = ?', i.links ?? null, i.databases ?? null, ctx.orgId);
    return get<{ links: number; databases: number }>(ctx.db, 'SELECT rotate_links_days links, rotate_db_days databases FROM orgs WHERE id = ?', ctx.orgId);
  },
});

// What to change, and how, when a secret shows up in an app's code: a connection's key, a Unit7 database's
// password, or (something Unit7 can't change, like a provider token) a person is told to revoke it.
export function leakPlan(db: Parameters<typeof get>[0], orgId: string, serviceId: string, keys: string[]) {
  const plan: { tool: string; input: Record<string, unknown>; key: string }[] = [], manual: string[] = [];
  const links = all<{ id: string; source: string; target: string; vars: string }>(db, 'SELECT id, source, target, vars FROM links WHERE org_id = ?', orgId);
  for (const key of keys) {
    const link = links.find((l) => (l.target.includes(serviceId) || l.source.includes(serviceId)) && json<{ key: string }[]>(l.vars, []).some((v) => v.key === key && /_API_KEY(_PREVIOUS)?$/.test(key)));
    if (link) { if (!plan.some((p) => p.input.linkId === link.id)) plan.push({ tool: 'link.rotate', input: { linkId: link.id }, key }); continue; }
    const ref = get<{ ref: string | null }>(db, `SELECT v.ref FROM env_vars v WHERE v.org_id = ? AND v.key = ? AND v.deleted_at IS NULL ORDER BY v.version DESC LIMIT 1`, orgId, key)?.ref;
    const m = ref && /^(credential:\/\/(?:postgres|mysql|mariadb)\/[^/]+\/)(?:url|pool-url|password)$/.exec(ref);
    const dbSvc = m && get<{ id: string }>(db, `SELECT id FROM services WHERE org_id = ? AND json_extract(config, '$.passwordRef') = ?`, orgId, `${m[1]}password`);
    if (dbSvc) { if (!plan.some((p) => p.input.serviceId === dbSvc.id)) plan.push({ tool: 'database.rotate_password', input: { serviceId: dbSvc.id, reason: `${key} was found in code` }, key }); continue; }
    manual.push(key);
  }
  return { plan, manual };
}

// the budget, the costs last read, and the month so far
function budgetView(db: Parameters<typeof get>[0], orgId: string) {
  const b = budgetOf({ db, orgId });
  const costs = all<{ provider: string; account: string; label: string; amount: number; kind: CostKind; original: string | null; at: string }>(db, 'SELECT provider, account, label, amount, kind, original, at FROM costs WHERE org_id = ? ORDER BY amount DESC', orgId);
  const f = forecast(costs);
  return { ...b, costs, soFar: Number(f.soFar.toFixed(2)), forecast: Number(f.forecast.toFixed(2)), checkedAt: costs[0]?.at ?? null };
}
