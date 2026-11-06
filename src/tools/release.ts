// How a release went (the timeline the UI draws), "Looks good, stop watching", and how releases work for an app
// (drain, watch, rolling back by itself, the text a page must contain). Turning a safety off is for people only.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { fid, isAgent } from './helpers.ts';
import { DEFAULTS, stopWatch, watching, type ReleaseSettings, type Step } from '../deploy/release.ts';
import type { ServiceConfig } from '../deploy/deployer.ts';

type DepRow = { id: string; service_id: string; number: number; status: string; plan: string; log: string; error: string | null; triggered_by: string | null; started_at: string; finished_at: string | null; downtime_seconds: number | null; failed_requests: number | null };

// how long this app's deploys usually take, from the last 10 that went live (the median)
export function usualMs(ctx: Pick<Ctx, 'db'>, serviceId: string): number | null {
  const ms = all<{ started_at: string; finished_at: string }>(ctx.db, `SELECT started_at, finished_at FROM deployments WHERE service_id = ? AND finished_at IS NOT NULL AND status IN ('live','stopped') ORDER BY number DESC LIMIT 10`, serviceId)
    .map((d) => Date.parse(d.finished_at) - Date.parse(d.started_at)).filter((n) => n > 0).sort((a, b) => a - b);
  return ms.length ? ms[Math.floor(ms.length / 2)]! : null;
}

// "Last 20 deploys: 0 seconds of downtime": only deploys Unit7 measured count; the rest are said to be not measured
export function proofSummary(ctx: Pick<Ctx, 'db'>, serviceId: string) {
  const rows = all<{ downtime_seconds: number | null; failed_requests: number | null; plan: string }>(ctx.db, `SELECT downtime_seconds, failed_requests, plan FROM deployments WHERE service_id = ? AND status IN ('live','stopped') ORDER BY number DESC LIMIT 20`, serviceId);
  const measured = rows.filter((r) => r.downtime_seconds !== null);
  return { deploys: rows.length, measured: measured.length, downtimeSeconds: measured.reduce((a, r) => a + (r.downtime_seconds ?? 0), 0), failedRequests: measured.reduce((a, r) => a + (r.failed_requests ?? 0), 0) };
}

// the settings with their defaults filled in, for the "How releases work" card
export function releaseSettings(cfg: ServiceConfig) {
  const r = cfg.release ?? {};
  const ws = !!r.websockets || !!cfg.detection?.scaleRisks?.some((x) => /websocket/i.test(x));
  return { drainSeconds: r.drainSeconds ?? (ws ? DEFAULTS.wsDrainSeconds : DEFAULTS.drainSeconds), drainSet: r.drainSeconds !== undefined, websockets: ws, watchMinutes: r.watchMinutes ?? DEFAULTS.watchMinutes,
    autoRollback: r.autoRollback !== false, mustContain: r.mustContain ?? '', workerGraceSeconds: r.workerGraceSeconds ?? DEFAULTS.workerGraceSeconds };
}

defineTool({
  name: 'deployment.release', title: 'How a release went', risk: 'read', action: 'read',
  description: 'One deploy as its release timeline: the steps (Build, Test, Database, Start, Check, Switch, Drain, Watch, Done) with their times and plain notes, the commit messages it shipped, how long deploys of this app usually take, the measured proof (seconds down and failed requests while traffic moved) and the watch after the switch. Give a deploymentId, or a serviceId for its newest deploy.',
  input: z.object({ deploymentId: fid('dep').optional(), serviceId: fid('svc').optional() }).refine((v) => v.deploymentId || v.serviceId, 'give deploymentId or serviceId'),
  run(ctx, i) {
    const d = i.deploymentId
      ? get<DepRow>(ctx.db, 'SELECT * FROM deployments WHERE id = ? AND org_id = ?', i.deploymentId, ctx.orgId)
      : get<DepRow>(ctx.db, 'SELECT * FROM deployments WHERE service_id = ? AND org_id = ? ORDER BY number DESC LIMIT 1', i.serviceId!, ctx.orgId);
    if (!d) return null;
    const p = json<{ steps?: Step[]; commits?: string[]; commit?: string; proof?: object; watch?: { status?: string; until?: string }; warm?: object; tests?: object; choices?: unknown[] }>(d.plan, {});
    const svc = get<{ name: string; kind: string }>(ctx.db, 'SELECT name, kind FROM services WHERE id = ?', d.service_id);
    // a watch Unit7 no longer runs (it restarted meanwhile) isn't shown as still going
    const w = p.watch?.status === 'watching' && !(watching(d.service_id)?.deploymentId === d.id) ? { ...p.watch, status: 'ended' } : p.watch;
    return {
      deploymentId: d.id, serviceId: d.service_id, service: svc?.name, kind: svc?.kind, number: d.number, status: d.status, triggeredBy: d.triggered_by,
      startedAt: d.started_at, finishedAt: d.finished_at, error: d.error, steps: p.steps ?? [], commits: p.commits ?? [], commit: p.commit, choices: p.choices,
      proof: d.downtime_seconds !== null ? { measured: true, downtimeSeconds: d.downtime_seconds, failed: d.failed_requests, ...(p.proof as object) } : p.proof ?? null,
      watch: w ?? null, warm: p.warm ?? null, tests: p.tests ?? null, usualMs: usualMs(ctx, d.service_id),
      lines: (d.log || '').split('\n'),
    };
  },
});

defineTool({
  name: 'deployment.watch_stop', title: 'Stop watching a new version', risk: 'write', action: 'service_write',
  description: 'End the few minutes of watching after a deploy ("Looks good, stop watching"). After that, Unit7 no longer rolls this version back by itself. People only.',
  input: z.object({ serviceId: fid('svc') }),
  run(ctx, i) {
    if (isAgent(ctx)) throw new Unit7Error('needs_person', 'Stopping the watch after a deploy turns off rolling back by itself, so only a person can do it. Use “Looks good, stop watching” on the app page.', 403);
    const name = get<{ name: string }>(ctx.db, 'SELECT name FROM services WHERE id = ?', i.serviceId)?.name ?? 'The app';
    const stopped = stopWatch(ctx.app, i.serviceId, `${ctx.actor.name} said it looks good`);
    return { stopped, note: stopped ? `${name} is no longer being watched.` : `${name} wasn’t being watched.` };
  },
});

defineTool({
  name: 'release.settings', title: 'How releases work for an app', risk: 'write', action: 'service_write',
  description: `How a new version takes over: drainSeconds (how long the old version may finish its open requests, default ${DEFAULTS.drainSeconds}, ${DEFAULTS.wsDrainSeconds} with live connections), watchMinutes (how long Unit7 watches the new version, default ${DEFAULTS.watchMinutes}; 0 turns watching off), autoRollback (roll back by itself when errors jump, default on), mustContain (text the health page must contain; empty clears it), workerGraceSeconds (how long an old worker may finish its job, default ${DEFAULTS.workerGraceSeconds}). Turning watching or rolling back by itself off is for people only.`,
  input: z.object({
    serviceId: fid('svc'), drainSeconds: z.number().int().min(5).max(600).optional(), watchMinutes: z.number().int().min(0).max(60).optional(),
    autoRollback: z.boolean().optional(), mustContain: z.string().max(200).optional(), workerGraceSeconds: z.number().int().min(5).max(600).optional(),
  }),
  run(ctx, i) {
    const svc = get<{ name: string; config: string }>(ctx.db, 'SELECT name, config FROM services WHERE id = ? AND org_id = ?', i.serviceId, ctx.orgId);
    if (!svc) throw new Unit7Error('not_found', 'That app was not found.', 404);
    const cfg = json<ServiceConfig>(svc.config, {});
    const before = cfg.release ?? {};
    if (isAgent(ctx) && (i.autoRollback === false || i.watchMinutes === 0 || (i.mustContain === '' && !!before.mustContain))) {
      throw new Unit7Error('needs_person', 'Turning off a release safety (watching, rolling back by itself, or the page check) is for people only. Change it on the app page under “How releases work”.', 403);
    }
    const { serviceId: _, ...changes } = i;
    const next: ReleaseSettings = { ...before, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
    if (next.mustContain !== undefined && !next.mustContain.trim()) delete next.mustContain;
    run(ctx.db, `UPDATE services SET config = json_set(config, '$.release', json(?)) WHERE id = ?`, JSON.stringify(next), i.serviceId);
    return { service: svc.name, release: releaseSettings({ ...cfg, release: next }), undo: { tool: 'release.settings', input: { serviceId: i.serviceId, ...undoOf(before, Object.keys(changes) as (keyof ReleaseSettings)[]) }, label: 'Put the previous release settings back' } };
  },
});

// the values to put back (a setting that wasn't set goes back to its default)
function undoOf(before: ReleaseSettings, keys: (keyof ReleaseSettings)[]) {
  const d: Record<string, unknown> = { drainSeconds: DEFAULTS.drainSeconds, watchMinutes: DEFAULTS.watchMinutes, autoRollback: true, mustContain: '', workerGraceSeconds: DEFAULTS.workerGraceSeconds };
  return Object.fromEntries(keys.filter((k) => k in d).map((k) => [k, before[k] ?? d[k]]));
}
