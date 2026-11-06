// What happened: the audit trail, the event stream and pending approvals, readable by agents too.
import { z } from 'zod';
import { defineTool, viewInput } from './runtime.ts';
import { all, get, json, now, type DB } from '../db.ts';
import type { App } from '../app.ts';
import { fid } from './helpers.ts';

defineTool({
  name: 'audit.search', title: 'Search the audit trail', risk: 'read', action: 'read',
  description: 'Who did what, when, and the result. Filter by tool name, project or environment.',
  input: z.object({ tool: z.string().optional(), projectId: fid('prj').optional(), environmentId: fid('env').optional(), limit: z.number().int().min(1).max(200).default(30) }),
  run: (ctx, i) => all(ctx.db, `SELECT actor_name, agent, tool, action, risk, reason, result, error, duration_ms, created_at FROM audit
    WHERE org_id = ? AND (? IS NULL OR tool = ?) AND (? IS NULL OR project_id = ?) AND (? IS NULL OR environment_id = ?)
    ORDER BY created_at DESC LIMIT ?`, ctx.orgId, i.tool ?? null, i.tool ?? null, i.projectId ?? null, i.projectId ?? null,
    i.environmentId ?? null, i.environmentId ?? null, i.limit),
});

defineTool({
  name: 'events.recent', title: 'Recent events', risk: 'read', action: 'read',
  description: 'Recent events (deployments, failures, alerts like server.cpu_high or service.unhealthy). Filter by type prefix, e.g. "deployment.".',
  input: z.object({ type: z.string().optional(), projectId: fid('prj').optional(), sinceMinutes: z.number().int().min(1).max(10_080).default(1440), limit: z.number().int().min(1).max(200).default(50) }),
  run: (ctx, i) => all<{ data: string }>(ctx.db, `SELECT type, severity, message, project_id, environment_id, resource, data, created_at FROM events
    WHERE org_id = ? AND created_at > ? AND (? IS NULL OR substr(type, 1, length(?)) = ?) AND (? IS NULL OR project_id = ?)
    ORDER BY created_at DESC LIMIT ?`, ctx.orgId, new Date(Date.now() - i.sinceMinutes * 60_000).toISOString(),
    i.type ?? null, i.type ?? null, i.type ?? null, i.projectId ?? null, i.projectId ?? null, i.limit).map((e) => ({ ...e, data: json(e.data, {}) })),
});

defineTool({
  name: 'approval.list', title: 'Pending approvals', risk: 'read', action: 'read',
  description: 'Actions waiting for a person to approve.',
  input: z.object({}),
  run: (ctx) => all<{ input: string }>(ctx.db, `SELECT id, tool, input, reason, why, created_at, expires_at FROM approvals WHERE org_id = ? AND status = 'pending' ORDER BY created_at`, ctx.orgId)
    .map((a) => ({ ...a, input: viewInput(a.input) })),
});

// What Unit7 stopped: actions the rules denied (or a person-only check refused), and approvals a person
// rejected or let expire. Proof the guardrails work, on the Autopilot page and in a weekly alert.
export function blockedSummary(db: DB, orgId: string, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const reasons = all<{ tool: string; why: string; who: string; count: number; last: string }>(db, `SELECT tool, coalesce(error, 'denied') why,
      max(actor_name) who, count(*) count, max(created_at) last FROM audit
    WHERE org_id = ? AND created_at > ? AND (result = 'denied' OR (result = 'error' AND error LIKE 'forbidden:%'))
    GROUP BY tool, why ORDER BY count DESC, last DESC LIMIT 50`, orgId, since)
    .map((r) => ({ ...r, why: r.why.replace(/^forbidden: /, '') }));
  const a = get<{ rejected: number; expired: number }>(db, `SELECT
      coalesce(sum(status = 'rejected' AND decided_at > ?), 0) rejected,
      coalesce(sum((status = 'expired' OR (status = 'pending' AND expires_at < ?)) AND created_at > ?), 0) expired
    FROM approvals WHERE org_id = ?`, since, now(), since, orgId)!;
  const denied = reasons.reduce((n, r) => n + r.count, 0);
  return { days, since, total: denied + a.rejected + a.expired, denied, rejected: a.rejected, expired: a.expired, reasons };
}

defineTool({
  name: 'audit.blocked', title: 'What Unit7 blocked', risk: 'read', action: 'read',
  description: 'Actions Unit7 stopped in the last N days (default 7): denied by the rules, refused as people-only, or approvals rejected or expired. Grouped by tool and reason.',
  input: z.object({ days: z.number().int().min(1).max(90).default(7) }),
  run: (ctx, i) => blockedSummary(ctx.db, ctx.orgId, i.days),
});

// Once a week per organization (counted from its start, then from the last summary): one alert with
// what was stopped. Quiet weeks send nothing.
export function weeklyBlocked(app: App) {
  const week = 7 * 86400_000;
  for (const o of all<{ id: string; created_at: string }>(app.db, 'SELECT id, created_at FROM orgs')) {
    const last = get<{ at: string }>(app.db, `SELECT max(created_at) at FROM events WHERE org_id = ? AND type = 'safety.weekly'`, o.id)?.at ?? o.created_at;
    if (Date.now() - Date.parse(last) < week) continue;
    const s = blockedSummary(app.db, o.id);
    if (!s.total) continue;
    const top = s.reasons.slice(0, 3).map((r) => `${r.tool} ×${r.count}`).join(', ');
    const parts = [s.denied && `${s.denied} denied${top ? ` (${top})` : ''}`, s.rejected && `${s.rejected} rejected by you`, s.expired && `${s.expired} approvals expired`].filter(Boolean);
    app.events.emit(o.id, 'safety.weekly', `This week Unit7 stopped ${s.total} risky action${s.total === 1 ? '' : 's'}: ${parts.join('; ')}.`, { severity: 'info', data: s });
  }
}
