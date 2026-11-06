// Scheduled jobs and background workers — the right home for work that must not run once per copy.
// A job runs its command once on a schedule in a one-off container from the app's current image, with
// the app's settings, on Unit7's private network. A worker is a long-running sibling of the app (same
// code, its own start command, no web address, never copied). Warden runs due jobs every minute.
import { z } from 'zod';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ExecResult } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { serverRow } from './servers.ts';
import { resolveValues } from './env.ts';
import { writeEnvFile, APPS, type ServiceConfig } from '../deploy/deployer.ts';
import { fid } from './helpers.ts';

// "every 15m" | "every 2h" | "every 1d" | "hourly" | "daily" | "weekly" | "daily 03:30" (UTC)
const SCHEDULE = /^(?:every (\d{1,4})(m|h|d)|hourly|daily|weekly|daily ([01]\d|2[0-3]):([0-5]\d))$/;
export function nextRun(schedule: string, last: Date | null, nowAt = new Date()): Date {
  const m = SCHEDULE.exec(schedule.trim().toLowerCase());
  if (!m) throw new Unit7Error('bad_schedule', `"${schedule}" isn't a schedule Unit7 knows. Try "every 15m", "every 2h", "daily 03:30" (UTC), "hourly", "daily" or "weekly".`);
  if (m[3]) { // a time of day, UTC
    const t = new Date(Date.UTC(nowAt.getUTCFullYear(), nowAt.getUTCMonth(), nowAt.getUTCDate(), Number(m[3]), Number(m[4])));
    const after = last ?? new Date(nowAt.getTime() - 1);
    while (t <= after) t.setUTCDate(t.getUTCDate() + 1);
    return t;
  }
  const every = m[1] ? Number(m[1]) * { m: 60_000, h: 3600_000, d: 86400_000 }[m[2] as 'm' | 'h' | 'd'] : { hourly: 3600_000, daily: 86400_000, weekly: 604800_000 }[schedule.trim().toLowerCase() as 'hourly'];
  if (every < 60_000) throw new Unit7Error('bad_schedule', 'Jobs run at most once a minute.');
  return last ? new Date(last.getTime() + every) : nowAt; // a new job runs on the next sweep
}

// One run of a job at a time, whoever starts it (Warden's schedule, "Run now", an AI), so a job never runs twice at once,
// during a deploy's overlap or when a slow run meets the next one: a second start is skipped and says so. The run's
// container name on the server is the second lock (it holds even across a restart of Unit7).
const runningJobs = new Set<string>();
const SKIPPED = 'skipped (already running)';
async function runJob(ctx: Ctx, jobId: string) {
  if (runningJobs.has(jobId)) {
    const name = get<{ name: string }>(ctx.db, 'SELECT name FROM jobs WHERE id = ? AND org_id = ?', jobId, ctx.orgId)?.name;
    if (!name) throw new Unit7Error('not_found', 'That job was not found.', 404);
    return { job: name, ok: true, skipped: 'It’s already running, so this run was skipped: a job never runs twice at once.' };
  }
  runningJobs.add(jobId);
  try { return await runJobOnce(ctx, jobId); } finally { runningJobs.delete(jobId); }
}

async function runJobOnce(ctx: Ctx, jobId: string) {
  const job = get<{ id: string; service_id: string; name: string; command: string }>(ctx.db, 'SELECT id, service_id, name, command FROM jobs WHERE id = ? AND org_id = ?', jobId, ctx.orgId);
  if (!job) throw new Unit7Error('not_found', 'That job was not found.', 404);
  const svc = get<{ name: string; server_id: string | null; current_deployment_id: string | null }>(ctx.db, 'SELECT name, server_id, current_deployment_id FROM services WHERE id = ?', job.service_id)!;
  const t0 = Date.now();
  const tag = job.id.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  const envFile = `${APPS}/job-${tag}.env`;
  // named, so a run that times out or is stopped is really stopped on the server, and the next one
  // can't start beside it (the name is taken while it runs)
  const container = `unit7-job-${tag}`;
  let r: ExecResult | undefined, why = 'failed';
  try {
    const image = get<{ image: string | null }>(ctx.db, 'SELECT image FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.image;
    if (!svc.server_id || !image) { why = 'failed (not deployed)'; throw new Unit7Error('not_deployed', `${svc.name} isn't deployed yet, so its job has nothing to run.`); }
    const s = serverRow(ctx, svc.server_id);
    try {
      await writeEnvFile(ctx, s, envFile, resolveValues(ctx, job.service_id));
      ctx.progress(`Running ${job.name} for ${svc.name}…`);
      r = await ssh(ctx.app).exec(s, script('docker run --rm --name "$4" --network unit7 --env-file "$1" "$2" sh -c "$3" 2>&1; rc=$?; rm -f "$1"; exit $rc', envFile, image, job.command, container), { timeoutMs: 30 * 60_000, signal: ctx.signal });
    } catch (e) {
      why = `failed (${e instanceof Unit7Error ? e.code : 'error'})`;
      await ssh(ctx.app).exec(s, script('docker rm -f "$1" >/dev/null 2>&1; rm -f "$2"', container, envFile)).catch(() => undefined);
      throw e;
    }
  } finally {
    // every attempt is recorded, so the schedule moves on and a failure shows instead of retrying every minute
    if (!r) run(ctx.db, 'UPDATE jobs SET last_run_at = ?, last_status = ?, last_ms = ? WHERE id = ?', now(), why, Date.now() - t0, job.id);
  }
  // the name is taken: a run of this job is still going on the server (started before Unit7 restarted, say)
  if (r.code === 125 && /already in use/i.test(r.stdout)) {
    run(ctx.db, 'UPDATE jobs SET last_run_at = ?, last_status = ?, last_ms = ? WHERE id = ?', now(), SKIPPED, Date.now() - t0, job.id);
    return { job: job.name, ok: true, skipped: 'It’s already running on the server, so this run was skipped: a job never runs twice at once.' };
  }
  const ok = r.code === 0;
  const output = ctx.redactor.redact(r.stdout.trim()).slice(-3000);
  run(ctx.db, 'UPDATE jobs SET last_run_at = ?, last_status = ?, last_output = ?, last_ms = ? WHERE id = ?', now(), ok ? 'ok' : `failed (exit ${r.code})`, output, Date.now() - t0, job.id);
  if (!ok) ctx.emit('job.failed', `${svc.name}: job "${job.name}" failed (exit ${r.code})`, { severity: 'warning', resource: job.service_id });
  return { job: job.name, ok, exitCode: r.code, ms: Date.now() - t0, output: output.slice(-800) };
}

defineTool({
  // any command, with the app's secrets: as risky as server.exec
  name: 'job.schedule', title: 'Schedule a job', risk: 'destructive', action: 'service_write',
  description: 'Run a command for an app on a schedule (once, never per copy): "every 15m", "every 2h", "daily 03:30" (UTC), "hourly", "daily", "weekly". Runs in a one-off container from the app’s image, with its settings. Same name replaces the old job.',
  input: z.object({ serviceId: fid('svc'), name: z.string().min(1).max(60), schedule: z.string().min(4).max(30), command: z.string().min(1).max(1000) }),
  run(ctx, i) {
    nextRun(i.schedule, null); // validates
    const jobId = get<{ id: string }>(ctx.db, 'SELECT id FROM jobs WHERE service_id = ? AND name = ?', i.serviceId, i.name)?.id ?? id('job');
    run(ctx.db, `INSERT INTO jobs (id, org_id, service_id, name, schedule, command) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_id, name) DO UPDATE SET schedule = excluded.schedule, command = excluded.command`, jobId, ctx.orgId, i.serviceId, i.name, i.schedule.trim().toLowerCase(), i.command);
    return { jobId, name: i.name, schedule: i.schedule, firstRun: 'within a minute' };
  },
});

defineTool({
  name: 'job.list', title: 'Scheduled jobs', risk: 'read', action: 'read',
  description: 'Scheduled jobs (for one app or all), with their last run, result and next run.',
  input: z.object({ serviceId: fid('svc').optional() }),
  run: (ctx, i) => all<{ id: string; service_id: string; name: string; schedule: string; command: string; last_run_at: string | null; last_status: string | null; last_output: string | null; last_ms: number | null }>(ctx.db,
    'SELECT id, service_id, name, schedule, command, last_run_at, last_status, last_output, last_ms FROM jobs WHERE org_id = ? AND (? IS NULL OR service_id = ?) ORDER BY name', ctx.orgId, i.serviceId ?? null, i.serviceId ?? null)
    .map((j) => ({ ...j, next_run: nextRun(j.schedule, j.last_run_at ? new Date(j.last_run_at) : null).toISOString() })),
});

defineTool({
  name: 'job.run', title: 'Run a job now', risk: 'write', action: 'service_write', timeoutMs: 31 * 60_000,
  description: 'Run a scheduled job right now (Warden also runs due jobs every minute).',
  input: z.object({ jobId: fid('job') }),
  run: (ctx, i) => runJob(ctx, i.jobId),
});

defineTool({
  name: 'job.remove', title: 'Remove a scheduled job', risk: 'write', action: 'service_write',
  description: 'Stop and remove a scheduled job.',
  input: z.object({ jobId: fid('job') }),
  run(ctx, i) { run(ctx.db, 'DELETE FROM jobs WHERE id = ? AND org_id = ?', i.jobId, ctx.orgId); return { removed: true }; },
});

defineTool({
  name: 'service.add_worker', title: 'Run a background worker', risk: 'destructive', action: 'deploy', timeoutMs: 30 * 60_000,
  description: 'Add a background worker next to an app (same code and settings, its own start command, e.g. a queue consumer) and deploy it. Workers have no web address and are never copied.',
  input: z.object({ serviceId: fid('svc'), command: z.string().min(1).max(500), name: z.string().min(1).max(40).default('worker') }),
  async run(ctx, i) {
    const app = get<{ project_id: string; environment_id: string; server_id: string | null; name: string; slug: string; config: string }>(ctx.db, 'SELECT project_id, environment_id, server_id, name, slug, config FROM services WHERE id = ? AND org_id = ?', i.serviceId, ctx.orgId);
    if (!app) throw new Unit7Error('not_found', 'That app was not found.', 404);
    const cfg = json<ServiceConfig>(app.config, {});
    const existing = get<{ id: string }>(ctx.db, `SELECT id FROM services WHERE environment_id = ? AND json_extract(config, '$.workerOf') = ? AND json_extract(config, '$.workerName') = ?`, app.environment_id, i.serviceId, i.name);
    const workerId = existing?.id ?? id('svc');
    const wcfg = { source: cfg.source, buildCommand: cfg.buildCommand, startCommand: i.command, nodeVersion: cfg.nodeVersion, nodeOptions: cfg.nodeOptions, pinned: cfg.pinned, pinnedByYou: cfg.pinnedByYou, workerOf: i.serviceId, workerName: i.name, previews: false };
    if (existing) run(ctx.db, 'UPDATE services SET config = ? WHERE id = ?', JSON.stringify(wcfg), workerId);
    else run(ctx.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) VALUES (?, ?, ?, ?, ?, ?, ?, 'worker', ?)`,
      workerId, ctx.orgId, app.project_id, app.environment_id, app.server_id, `${app.name} ${i.name}`, `${app.slug}-${i.name}`.slice(0, 48), JSON.stringify(wcfg));
    // the worker shares the app's settings: point it at the same variables
    const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { serviceId: workerId }, { reason: `worker for ${app.name}` });
    if (r.status !== 'ok') throw new Unit7Error('worker_failed', r.status === 'error' ? r.error.message : `The worker deploy needs ${r.status === 'approval_required' ? 'approval' : 'permission'}.`, 502);
    return { workerId, ...(r.output as object) };
  },
});

export { runJob };
