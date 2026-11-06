// Warden fixes safe things by itself. A finding (the security check's, or the X-ray's) whose fix is marked safe AND has
// an undo runs on its own, through the gate as Warden, only when all of this holds: the fix is no riskier than "change
// with undo" (tier 2), the environment's (or the organisation's) autonomy is "Fix itself" or higher, Autopilot isn't
// paused, the thing isn't archived, the switch is on, and the limits hold: 5 fixes an hour per organisation, one per
// finding a day, and never the same fix twice (a fix a person took back stays taken back). Each one lands in Activity
// with Undo and on the phone as a calm "Fixed by itself". Below "Fix itself" nothing changes: findings only suggest.
import { z } from 'zod';
import type { App } from '../app.ts';
import { all, get, id, json, run, type DB } from '../db.ts';
import { defineTool, getTool, type ToolResult } from './runtime.ts';
import { tierOf } from '../policy.ts';
import type { Finding, Fix } from './security.ts';
import { serverFindings } from '../discovery/findings.ts';
import { archivedServices, touchesArchived, withoutArchived } from '../archive.ts';
import { lastXray } from './xray.ts';
import { distrusted, playbookFor } from '../care/judge.ts';

const HOUR = 3600_000, DAY = 86400_000;
export const LIMITS = { perHour: 5, perFindingPerDay: 1 };
type ToolFix = Extract<Fix, { tool: string }>;
export interface Candidate { finding: Pick<Finding, 'id' | 'title' | 'about' | 'serverId'>; fix: ToolFix }
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

// What could be fixed: the latest security checks of the last day, and the X-ray's findings for each server Unit7
// watches (from what's stored; the watch refreshes the X-ray hourly). Stale views are left out.
export function candidates(db: DB, orgId: string, nowMs = Date.now()): Candidate[] {
  const out = new Map<string, Candidate>();
  const add = (f: Finding) => { if (f.fix && 'tool' in f.fix && !out.has(f.id)) out.set(f.id, { finding: f, fix: f.fix }); };
  for (const r of all<{ findings: string }>(db, 'SELECT findings FROM security_reports WHERE org_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20', orgId, new Date(nowMs - DAY).toISOString())) {
    for (const f of json<Finding[]>(r.findings, [])) add(f);
  }
  for (const s of all<{ id: string; name: string }>(db, `SELECT id, name FROM servers WHERE org_id = ? AND status = 'ready'`, orgId)) {
    const x = lastXray(db, orgId, s.id);
    if (!x || Date.parse(x.at) < nowMs - 2 * HOUR) continue;
    for (const f of serverFindings(db, orgId, s)) add(f);
  }
  return [...out.values()];
}

// the autonomy that decides, as at the gate: the environment's when the fix touches an app, the organisation's otherwise
function level(db: DB, orgId: string, input: Record<string, unknown>, c: Candidate): number {
  const org = get<{ autonomy: number }>(db, 'SELECT autonomy FROM orgs WHERE id = ?', orgId)?.autonomy ?? 3;
  const svc = typeof input.serviceId === 'string' ? input.serviceId : c.finding.about?.kind === 'app' && c.finding.about.id?.startsWith('svc_') ? c.finding.about.id : undefined;
  const env = typeof input.environmentId === 'string' ? input.environmentId : svc ? get<{ e: string }>(db, 'SELECT environment_id e FROM services WHERE id = ? AND org_id = ?', svc, orgId)?.e : undefined;
  const e = env && get<{ autonomy: number }>(db, 'SELECT autonomy FROM environments WHERE id = ? AND org_id = ?', env, orgId)?.autonomy;
  return typeof e === 'number' ? e : org;
}

// archived (asset.archive): the thing itself, or what answers on the port a fix would close
function archived(db: DB, orgId: string, input: Record<string, unknown>, c: Candidate): boolean {
  if (touchesArchived(db, orgId, input)) return true;
  if (c.finding.about?.kind === 'app' && c.finding.about.id && archivedServices(db, orgId).has(c.finding.about.id)) return true;
  if (typeof input.serverId === 'string' && typeof input.port === 'number') {
    const inv = lastXray(db, orgId, input.serverId)?.data;
    const owner = inv?.parts.find((p) => p.ports?.some((x) => x.port === input.port));
    const kept = owner && withoutArchived(db, orgId, input.serverId, inv);
    if (owner && kept && !kept.parts.some((p) => p.id === owner.id)) return true;
  }
  return false;
}

// Why Warden may not run this fix by itself right now (undefined: it may)
export function whyNot(db: DB, orgId: string, c: Candidate, nowMs = Date.now()): string | undefined {
  const org = get<{ paused_at: string | null; autofix: number }>(db, 'SELECT paused_at, autofix FROM orgs WHERE id = ?', orgId);
  if (!org) return 'no such organisation';
  if (!org.autofix) return 'the switch is off';
  if (org.paused_at) return 'Autopilot is paused';
  const f = c.fix;
  if (distrusted(db, orgId, c.finding.id)) return 'people said this kind was wrong';
  if ((f.safe !== true || !f.undo || typeof f.undo.tool !== 'string') && !playbookFor(db, orgId, c.finding.id, f.tool)) return 'not marked safe with an undo';
  const t = getTool(f.tool);
  const parsed = t?.input.safeParse(f.input);
  if (!t || !parsed?.success) return 'not a fix Unit7 can run';
  const input = parsed.data as Record<string, unknown>;
  const tier = tierOf(typeof t.action === 'function' ? t.action(input) : t.action, typeof t.risk === 'function' ? t.risk(input) : t.risk);
  if (tier > 2) return 'riskier than a change with an undo';
  if (level(db, orgId, input, c) < 3) return 'autonomy is below “Fix itself”';
  if (archived(db, orgId, input, c)) return 'it’s archived';
  // a port Unit7 already closed (the X-ray still sees Docker publish it): nothing to fix
  if (f.tool === 'server.close_port' && !input.open && typeof input.serverId === 'string'
    && (json<{ closedPorts?: number[] }>(get<{ facts: string }>(db, 'SELECT facts FROM servers WHERE id = ?', input.serverId)?.facts, {}).closedPorts ?? []).includes(input.port as number)) return 'already done';
  // never twice: one that worked stays done (and one a person undid stays undone)
  if (get(db, `SELECT 1 FROM autofixes WHERE org_id = ? AND tool = ? AND input = ? AND status = 'applied'`, orgId, f.tool, stable(input))) return 'already done once';
  if (get<{ n: number }>(db, `SELECT count(*) n FROM autofixes WHERE org_id = ? AND status = 'applied' AND created_at > ?`, orgId, new Date(nowMs - HOUR).toISOString())!.n >= LIMITS.perHour) return `${LIMITS.perHour} fixes this hour already`;
  if (get<{ n: number }>(db, 'SELECT count(*) n FROM autofixes WHERE org_id = ? AND finding = ? AND created_at > ?', orgId, c.finding.id, new Date(nowMs - DAY).toISOString())!.n >= LIMITS.perFindingPerDay) return 'tried this one today already';
}

// what Unit7 did, in a few words
const DID: Record<string, (i: Record<string, unknown>) => string> = {
  'server.close_port': (i) => `closed port ${i.port} to the internet`,
  'shield.block': (i) => `blocked ${i.ip}`,
  'docker.prune': () => 'cleared old images',
  'backup.schedule': () => 'scheduled daily backups',
};
const did = (f: ToolFix) => DID[f.tool]?.(f.input) ?? `did “${f.label.toLowerCase()}”`;

// One pass for an organisation: every eligible fix, through `act` (Warden's, so the gate and its backoff apply)
export async function autofixPass(app: App, orgId: string, act: (orgId: string, tool: string, input: unknown, reason: string, extra?: { onlyIfAllowed?: boolean }) => Promise<ToolResult>, nowMs = Date.now()) {
  const applied: { finding: string; tool: string }[] = [];
  for (const c of candidates(app.db, orgId, nowMs)) {
    if (whyNot(app.db, orgId, c, nowMs)) continue;
    const input = getTool(c.fix.tool)!.input.parse(c.fix.input) as Record<string, unknown>;
    // only what the gate lets Warden do without a person: one it would ask about stays a suggestion (the finding already
    // shows the fix), so no approval a day and nothing on the phone
    const r = await act(orgId, c.fix.tool, c.fix.input, `fixing by itself: ${c.finding.title}`, { onlyIfAllowed: true });
    if (r.status === 'approval_required') continue;
    const status = r.status === 'ok' ? 'applied' : 'failed';
    const fixId = id('afx');
    run(app.db, 'INSERT INTO autofixes (id, org_id, server_id, finding, title, tool, input, undo, status, audit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      fixId, orgId, typeof input.serverId === 'string' ? input.serverId : c.finding.serverId ?? null, c.finding.id, c.finding.title, c.fix.tool, stable(input), JSON.stringify(c.fix.undo ?? {}), status, 'auditId' in r ? r.auditId || null : null);
    if (status !== 'applied') continue;
    applied.push({ finding: c.finding.id, tool: c.fix.tool });
    app.events.emit(orgId, 'autofix.applied', `Fixed by itself: ${c.finding.title.replace(/\.$/, '')}, so Unit7 ${did(c.fix)} · Undo`, {
      severity: 'success', resource: typeof input.serverId === 'string' ? input.serverId : c.finding.about?.id ?? null,
      data: { fixId, finding: c.finding.id, tool: c.fix.tool, undo: c.fix.undo, auditId: 'auditId' in r ? r.auditId : undefined },
    });
  }
  return applied;
}

// --- the switch, and what it did ------------------------------------------------------------------------------------
export function autofixView(db: DB, orgId: string) {
  const org = get<{ autonomy: number; paused_at: string | null; autofix: number }>(db, 'SELECT autonomy, paused_at, autofix FROM orgs WHERE id = ?', orgId);
  const on = !!org?.autofix, level = org?.autonomy ?? 3;
  return {
    on, level, paused: !!org?.paused_at, working: on && level >= 3 && !org?.paused_at, limits: LIMITS,
    recent: all<{ id: string; title: string; tool: string; status: string; created_at: string; server_id: string | null }>(db,
      `SELECT id, title, tool, status, created_at, server_id FROM autofixes WHERE org_id = ? ORDER BY created_at DESC LIMIT 10`, orgId)
      .map((r) => ({ id: r.id, title: r.title, tool: r.tool, status: r.status, at: r.created_at, serverId: r.server_id })),
  };
}

defineTool({
  name: 'autofix.status', title: 'What Warden fixes by itself', risk: 'read', action: 'read',
  description: 'Whether Warden applies safe fixes (marked safe, with an undo) by itself, whether that is working now (it needs “Fix itself” autonomy and Autopilot running), its limits, and the last fixes it made.',
  input: z.object({}),
  run: (ctx) => autofixView(ctx.db, ctx.orgId),
});

defineTool({
  // an AI never loosens (or sets) its own leash
  name: 'autofix.settings', title: 'Let Warden fix safe things by itself', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'People only. Turn on or off Warden applying safe fixes (each marked safe and with an undo) by itself at “Fix itself” autonomy or higher. Off: they wait for a person, as suggestions.',
  input: z.object({ on: z.boolean() }),
  run(ctx, i) {
    run(ctx.db, 'UPDATE orgs SET autofix = ? WHERE id = ?', i.on ? 1 : 0, ctx.orgId);
    ctx.emit('policy.changed', `${ctx.actor.name} ${i.on ? 'let Warden fix safe things by itself' : 'stopped Warden fixing things by itself'}`, { severity: 'info' });
    return autofixView(ctx.db, ctx.orgId);
  },
});
