// Services and deployments: create an app service, deploy it, watch it, roll it back, read its logs.
import { z } from 'zod';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh } from '../connectors/ssh.ts';
import { cmd } from '../connectors/shell.ts';
import { serverRow } from './servers.ts';
import { fid, name, uniqueSlug, isAgent } from './helpers.ts';
import { deploy, rollback, replicaNames, routeService, startContainer, healthCheck, removeCopies, MAX_REPLICAS, type ServiceRow, type Source, type ServiceConfig } from '../deploy/deployer.ts';
import { resolveValues, merged, learnSecrets } from './env.ts';
import { filesWords } from '../deploy/volumes.ts';
import { diagnoseFailure, applyHeal, describe, classifyBuild, fixesFor, choicesFor, type Choice, type Failure, type FailureKind } from '../deploy/heal.ts';
import { PIN_SPEC, parsePin, slotOf, specOf, type Pins } from '../deploy/pins.ts';
import { scanDeployment } from '../deploy/security.ts';
import type { Detection } from '../connectors/detect.ts';
import { hashedPath } from '../deploy/caddy.ts';
import { script } from '../connectors/shell.ts';
import { uploadFolder } from '../connectors/folder.ts';
import { execute } from './runtime.ts';
import type { Assessment } from '../policy.ts';
import type { TestResult } from '../deploy/testgate.ts';
import type { DbCheck } from '../deploy/migcheck.ts';
import { proofSummary, releaseSettings } from './release.ts';
import { watching } from '../deploy/release.ts';

const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('git'), repo: z.string().min(1).max(300), branch: z.string().max(100).optional(), accountId: fid('acc').optional() }),
  z.object({ type: z.literal('upload'), uploadId: fid('upl') }),
  z.object({ type: z.literal('image'), image: z.string().min(1).max(300) }),
]);

function svcRow(ctx: Ctx, serviceId: string): ServiceRow {
  const svc = get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  if (!svc) throw new Unit7Error('not_found', 'That service was not found.', 404);
  return svc;
}

// pick the server with the most free memory when the caller doesn't name one
function chooseServer(ctx: Ctx): string {
  const servers = all<{ id: string; facts: string }>(ctx.db, `SELECT id, facts FROM servers WHERE org_id = ? AND status = 'ready'`, ctx.orgId);
  if (!servers.length) throw new Unit7Error('no_server', 'No prepared server yet. Connect one and run server.bootstrap, then deploy.');
  return servers.map((s) => ({ id: s.id, free: json<{ mem_available?: number }>(s.facts, {}).mem_available ?? 0 })).sort((a, b) => b.free - a.free)[0]!.id;
}

defineTool({
  // new code, commands or a server for an app is running code with its secrets: an AI asks first in production
  name: 'service.create', title: 'Create a service', risk: (i) => (i.source || i.buildCommand || i.startCommand || i.serverId ? 'destructive' : 'write'), action: 'service_write',
  description: 'Create an app or worker in an environment, with a source (git repo, uploaded folder or image). Does not deploy yet; call deployment.create.',
  input: z.object({
    environmentId: fid('env'), name, kind: z.enum(['app', 'worker']).default('app'), serverId: fid('srv').optional(),
    source: sourceSchema.optional(), port: z.number().int().min(1).max(65535).optional(), buildCommand: z.string().max(500).optional(), startCommand: z.string().max(500).optional(),
  }),
  run(ctx, i) {
    const env = get<{ project_id: string }>(ctx.db, 'SELECT project_id FROM environments WHERE id = ?', i.environmentId)!;
    const slug = uniqueSlug(ctx, 'SELECT 1 FROM services WHERE environment_id = ? AND slug = ?', i.name, i.environmentId);
    const serviceId = id('svc');
    const cfg: ServiceConfig = { source: i.source, port: i.port, buildCommand: i.buildCommand, startCommand: i.startCommand };
    run(ctx.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      serviceId, ctx.orgId, env.project_id, i.environmentId, i.serverId ?? null, i.name, slug, i.kind, JSON.stringify(cfg));
    ctx.resources.push(serviceId);
    return { serviceId, slug, next: 'Deploy it with deployment.create.' };
  },
});

defineTool({
  name: 'service.get', title: 'Service details', risk: 'read', action: 'read',
  description: 'A service with its current deployment, domains, recent deployments and config (no secrets).',
  input: z.object({ serviceId: fid('svc') }),
  run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const cfg = json<ServiceConfig>(svc.config, {});
    return {
      id: svc.id, name: svc.name, kind: svc.kind, status: svc.status, serverId: svc.server_id,
      stack: cfg.detection?.stack, port: cfg.port, source: cfg.source && (cfg.source.type === 'git' ? { type: 'git', repo: cfg.source.repo, branch: cfg.source.branch } : cfg.source), folder: (cfg as { folder?: string }).folder,
      autoDeploy: cfg.source?.type === 'git' ? cfg.autoDeploy !== false : undefined, previews: cfg.source?.type === 'git' ? cfg.previews !== false : undefined,
      startCommand: cfg.startCommand, buildCommand: cfg.buildCommand, migrations: cfg.detection?.migrate, pooled: !!(cfg as { pool?: object }).pool, replicas: cfg.replicas ?? 1, autoscale: (cfg as { autoscale?: object }).autoscale ?? null, scaleRisks: cfg.detection?.scaleRisks ?? [], fixPrs: (cfg as { autoFixPrs?: boolean }).autoFixPrs !== false, mergeFixes: !!(cfg as { autoMergeFixes?: boolean }).autoMergeFixes, fixPr: (cfg as { fixPr?: object }).fixPr ?? null,
      current: svc.current_deployment_id ? get(ctx.db, 'SELECT id, number, status, image, started_at, finished_at FROM deployments WHERE id = ?', svc.current_deployment_id) : null,
      domains: all(ctx.db, 'SELECT id, hostname, status, tls, auto FROM domains WHERE service_id = ?', svc.id),
      deployments: all(ctx.db, "SELECT id, number, status, triggered_by, started_at, finished_at, error, downtime_seconds, failed_requests, json_extract(plan, '$.proof.measured') proof_measured, json_extract(plan, '$.proof.why') proof_why, json_extract(plan, '$.proof.requests') proof_requests, json_extract(plan, '$.steps[0].key') first_step FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 10", svc.id),
      safety: safetyOf(ctx, svc.id, cfg),
      // how releases work for it (drain, watch, rolling back by itself) and the measured proof of the last 20
      release: { ...releaseSettings(cfg), proof: proofSummary(ctx, svc.id), watching: !!watching(svc.id) },
      // the toolchain the last build used and why (src/deploy/pins.ts), and what the newest deploy offers (a failure's choices,
      // or "pin it in the repo"): the shared choice buttons render these
      pins: cfg.detection?.pins ?? null,
      choices: choicesOf(ctx, svc.id),
      // the files it keeps between deploys (src/deploy/volumes.ts): "Saves files in /app/data · kept between deploys · backed up daily"
      savedFiles: cfg.volumes?.length ? { paths: cfg.volumes.map((v) => v.path), words: filesWords(cfg.volumes, get<{ frequency: string }>(ctx.db, 'SELECT frequency FROM backup_schedules WHERE service_id = ? ORDER BY created_at LIMIT 1', svc.id)?.frequency) } : null,
    };
  },
});

function choicesOf(ctx: Ctx, serviceId: string) {
  const d = get<{ id: string; number: number; status: string; plan: string }>(ctx.db, 'SELECT id, number, status, plan FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1', serviceId);
  const p = json<{ choices?: Choice[]; failure?: { words: string }; healedFrom?: { words: string } }>(d?.plan, {});
  return d && p.choices?.length ? { deploymentId: d.id, number: d.number, status: d.status, words: p.failure?.words ?? p.healedFrom?.words, choices: p.choices } : null;
}

// ZD-SAFE: the newest deploy's Test and Database steps (plan.tests, plan.dbCheck), and the "Run tests before deploying" switch
function safetyOf(ctx: Ctx, serviceId: string, cfg: ServiceConfig) {
  const last = get<{ id: string; number: number; status: string; plan: string }>(ctx.db, 'SELECT id, number, status, plan FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1', serviceId);
  const p = json<{ tests?: TestResult; dbCheck?: DbCheck }>(last?.plan, {});
  const seen = get<{ s: string }>(ctx.db, `SELECT json_extract(plan, '$.tests.status') s FROM deployments WHERE service_id = ? AND json_extract(plan, '$.tests.status') IS NOT NULL ORDER BY number DESC LIMIT 1`, serviceId)?.s;
  const stoppedAt = last?.status !== 'failed' ? undefined : p.tests && ['failed', 'timeout'].includes(p.tests.status) ? 'tests' : p.dbCheck?.held ? 'database' : undefined;
  return { deploymentId: last?.id, number: last?.number, tests: p.tests, dbCheck: p.dbCheck, stoppedAt, runTests: cfg.runTests !== false, hasTests: seen === undefined ? undefined : seen !== 'none' };
}

defineTool({
  // redeploying the app's own source is routine; other code (source) or another server (serverId) is not
  name: 'deployment.create', title: 'Deploy a service', risk: (i) => (i.allowDestructiveMigration || i.source || i.serverId || i.commit ? 'destructive' : 'write'), action: 'deploy', timeoutMs: 25 * 60_000,
  description: 'Build and deploy a service: detect the stack, build, run its tests, check its database changes against the version still serving, start the new version beside the old one, health-check it, then switch traffic. Rolls back automatically if the new version is unhealthy. If it fails, Unit7 fixes common causes itself (missing secrets, a missing database, wrong port, Node version, build memory) and retries once. Assigns a server automatically if none is set.',
  input: z.object({
    serviceId: fid('svc'), source: sourceSchema.optional(), serverId: fid('srv').optional(),
    noHeal: z.boolean().optional().describe('Skip self-heal (Unit7 normally fixes common causes and retries once)'),
    allowDestructiveMigration: z.boolean().optional().describe('Run a migration that drops or renames data (Unit7 backs up first). Needs approval for an AI.'),
    allowRiskyMigration: z.boolean().optional().describe('Go ahead with a database change that can break the version still serving (a renamed column, a new required one). An AI always waits for a person’s approval.'),
    skipTests: z.boolean().optional().describe('Deploy without running the app’s tests. People only: an AI can’t skip them.'),
    pin: z.string().regex(PIN_SPEC, 'like pnpm@10 or node@20').optional().describe('Build with this version this time ("pnpm@10", "node@20"), whatever the repo implies'),
    pinPr: z.boolean().optional().describe('With pin: once it’s live, keep building with it and open a pull request that writes it into the repo'),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/i, 'a git commit').optional().describe('Build exactly this commit of a git source (deployment.promote uses it to ship what Staging runs). Other code, so an AI asks a person in production.'),
  }),
  // ZD-SAFE: skipping the tests is a person's choice; going ahead with a risky database change waits for one when an AI asks.
  // No tier otherwise, so deploys keep exactly the policy rules they had.
  peopleOnly: (i) => !!i.skipTests,
  assess: (_c, i) => (i.allowRiskyMigration ? { tier: 2, ask: 'This deploy runs a database change that can break the version still serving, so a person decides.' } : {}) as Assessment,
  async dryRun(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const cfg = json<ServiceConfig>(svc.config, {});
    return { wouldDeploy: svc.name, source: i.source ?? cfg.source, server: svc.server_id ?? i.serverId ?? 'auto-selected', note: 'A real deploy builds on the server and switches traffic only after a health check passes.' };
  },
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    if (!svc.server_id && !i.serverId) run(ctx.db, 'UPDATE services SET server_id = ? WHERE id = ?', chooseServer(ctx), svc.id);
    else if (i.serverId) run(ctx.db, 'UPDATE services SET server_id = ? WHERE id = ?', i.serverId, svc.id);
    const movedFrom = i.serverId && svc.server_id && svc.server_id !== i.serverId ? svc.server_id : undefined;
    const commit = i.commit ?? (i.source ? undefined : pinnedCommit(ctx, svc));
    // A folder on this computer (linked in the web app): a person's deploy packs it fresh, like `unit7 deploy`.
    // Anyone else (a token, an AI, Warden) redeploys the copy packed last, so whatever writes into the folder
    // can't put new code live without a person.
    const linked = json<{ folder?: string; source?: Source }>(svc.config, {});
    const folder = !i.source && ctx.actor.kind === 'user' ? linked.folder : undefined;
    if (!i.source && !folder && linked.folder && !linked.source) throw new Unit7Error('needs_person', `${svc.name} deploys from a folder on this computer, and its first deploy is a person’s: press Deploy in the web app.`, 403);
    if (folder) ctx.progress('Packing your folder…');
    const source: Source | undefined = folder ? { type: 'upload', uploadId: await uploadFolder(ctx.app, ctx.orgId, ctx.actor.userId, folder) } : i.source;
    let r;
    try {
      r = await deploy({ ...ctx, signal: ctx.signal }, svcRow(ctx, i.serviceId), { source, allowDestructiveMigration: i.allowDestructiveMigration, allowRiskyMigration: i.allowRiskyMigration, skipTests: i.skipTests, commit, pin: i.pin });
    } catch (e) {
      // ZD-SAFE: an AI's deploy paused on a risky database change asks a person by itself (Approvals), the same deploy going ahead
      if (e instanceof Unit7Error && e.code === 'migration_risky' && isAgent(ctx) && !i.allowRiskyMigration) {
        const asked = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { ...i, allowRiskyMigration: true }, { reason: `${svc.name}: a database change that can break the version still serving`, conversationId: ctx.conversationId });
        const [first, ...rest] = e.message.split('\n');
        if (asked.status === 'approval_required') throw new Unit7Error('migration_risky', [first, 'Unit7 asked a person: it’s waiting on the Approvals page. Don’t retry.', ...rest].join('\n'), 409, { approvalId: asked.approvalId });
      }
      // a failure Unit7 recognises gets plain words and choices, healed or not (src/deploy/heal.ts classifyBuild)
      if (e instanceof Unit7Error && (!HEALABLE.has(e.code) || i.noHeal)) throw failedWithChoices(ctx, svcRow(ctx, i.serviceId), e, classify(ctx, svcRow(ctx, i.serviceId), e));
      if (!(e instanceof Unit7Error) || !HEALABLE.has(e.code) || i.noHeal) throw e;
      r = await selfHeal(ctx, i.serviceId, source, e, commit, i.pin);
    }
    // "Build with pnpm 10 and pin it for me": it's live, so keep it for this app and write it into the repo
    const pinned = i.pin && i.pinPr ? { pinPr: await pinItForMe(ctx, i.serviceId, i.pin) } : !i.pin ? pinOffer(ctx, i.serviceId, r.deploymentId) ?? settingsOffer(ctx, i.serviceId, r.deploymentId) : undefined;
    if (folder) run(ctx.db, `UPDATE services SET config = json_set(config, '$.source', json(?)) WHERE id = ?`, JSON.stringify(source), svc.id);
    if (movedFrom) await leaveServer(ctx, svc, movedFrom);
    // an app on several servers (src/fleet): the others follow, one at a time; a failure there puts all of them back
    else { const { followFleet } = await import('../fleet/rolling.ts'); await followFleet(ctx, i.serviceId, r); }
    return withUndo(i.serviceId, { ...r, ...pinned });
  },
});

// A redeploy by an agent ships the commit that is live in production, never whatever the branch head
// has become: otherwise anything that can push to the repo could get new code running with production's
// secrets without a person approving it (a redeploy is only a 'write'). New commits go live when a person
// deploys, or through push-to-deploy (Warden), which a person left on.
function pinnedCommit(ctx: Ctx, svc: ServiceRow): string | undefined {
  const cfg = json<ServiceConfig>(svc.config, {});
  if (!isAgent(ctx) || cfg.source?.type !== 'git' || !svc.current_deployment_id) return undefined;
  if (ctx.actor.kind === 'agent' && ctx.actor.id === 'warden' && cfg.autoDeploy !== false) return undefined;
  if (get<{ kind: string }>(ctx.db, 'SELECT kind FROM environments WHERE id = ?', svc.environment_id)?.kind !== 'production') return undefined;
  const commit = json<{ commit?: string }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', svc.current_deployment_id)?.plan ?? '{}', {}).commit;
  if (!commit) throw new Unit7Error('needs_person', `Unit7 doesn't know which commit of ${svc.name} is live, so an agent can't redeploy it in production: that could ship new code. Ask a person to deploy it.`, 403);
  return commit;
}

// The app now runs on another server: stop it on the old one and take its sites down there, so two
// copies never serve (or run jobs against the same database) at once. Best effort, said out loud.
async function leaveServer(ctx: Ctx, svc: ServiceRow, serverId: string) {
  try {
    const s = serverRow(ctx, serverId);
    await ssh(ctx.app).check(s, script('ids=$(docker ps -q --filter "label=unit7.service=$1"); [ -z "$ids" ] || docker stop $ids >/dev/null', svc.id), { what: 'Stopping the old copy', timeoutMs: 90_000 });
    const { removeSite } = await import('../deploy/caddy.ts');
    for (const d of all<{ hostname: string }>(ctx.db, 'SELECT hostname FROM domains WHERE service_id = ?', svc.id)) await removeSite(ctx.app, s, d.hostname);
    ctx.progress(`Stopped ${svc.name} on ${s.name}, its old server.`);
  } catch (e) {
    ctx.emit('service.move_cleanup_failed', `${svc.name} moved servers, but Unit7 couldn't stop the old copy: ${(e as Error).message}`, { severity: 'warning', resource: svc.id });
  }
}

// Every reversible action says how to undo it (the Autopilot page shows it next to what Unit7 did).
const withUndo = <T extends { previousDeploymentId?: string }>(serviceId: string, r: T) =>
  r.previousDeploymentId ? { ...r, undo: { tool: 'deployment.rollback', input: { serviceId, deploymentId: r.previousDeploymentId }, label: 'Roll back to the previous version' } } : r;

// A deploy failed: fix the common causes and try once more. If that's not enough, say exactly what's
// needed, and hand it to a brain (Unit7's model or your AI) unless an AI started this deploy.
const HEALABLE = new Set(['build_failed', 'unhealthy', 'deploy_failed', 'migration_failed']);
const escalated = new Map<string, number>(); // serviceId -> last hand-off (one per 30 min)
async function selfHeal(ctx: Ctx, serviceId: string, source: Source | undefined, first: Unit7Error, commit?: string, pin?: string) {
  const svc = svcRow(ctx, serviceId);
  const plan = healPlan(ctx, svc, first);
  // a build that failed on Unit7's own pick (a package manager version, the server's memory, a registry blip): fixed too
  const failure = classify(ctx, svc, first);
  for (const x of fixesFor(failure)) if (!plan.fixes.some((y) => y.kind === x.kind)) plan.fixes.push(x);
  const failedDep = newestDeployment(ctx, serviceId);
  if (failure && failedDep?.status === 'failed') recordFailure(ctx, failedDep, failure);
  const pinnedBefore = json<ServiceConfig>(svc.config, {}).pinned ?? [];
  let last = first;
  if (plan.fixes.length) {
    const done = await applyHeal(ctx, svc, plan);
    if (done.length) {
      ctx.progress(`Unit7 fixed it: ${done.join('; ')}. Deploying again…`);
      ctx.emit('deployment.healing', `${svc.name}: ${plan.cause}. Unit7 ${done.join(', ')}, deploying again.`, { resource: svc.id });
      try {
        const r = await deploy({ ...ctx, signal: ctx.signal }, svcRow(ctx, serviceId), { source, triggeredBy: 'Unit7 (self-heal)', commit, pin });
        ctx.emit('deployment.healed', `${svc.name} is live after Unit7 ${done.join(', ')}`, { severity: 'success', resource: svc.id });
        return { ...r, healed: done, ...(failure && healedChoices(ctx, svc, failure, r.deploymentId, done)) };
      } catch (e) {
        if (!(e instanceof Unit7Error)) throw e;
        last = e;
        // a version that didn't help isn't remembered
        if (plan.fixes.some((x) => x.kind === 'pm-pin')) run(ctx.db, `UPDATE services SET config = json_set(config, '$.pinned', json(?)) WHERE id = ?`, JSON.stringify(pinnedBefore), serviceId);
      }
    }
  }
  const needs = plan.needsYou.length ? `\nNeeds you: set ${plan.needsYou.join(', ')} in this project’s variables (Unit7 can’t make up a value someone else issues).` : '';
  let handed = '';
  // the second failure after a version switch isn't about the version
  const final = last === first ? failure : classify(ctx, svcRow(ctx, serviceId), last, failure && (failure.kind === 'pm-version' || failure.kind === 'node-version' || failure.kind === 'permissions') ? [failure.kind] : undefined);
  const autonomy = get<{ autonomy: number }>(ctx.db, 'SELECT autonomy FROM environments WHERE id = ?', svc.environment_id)?.autonomy ?? 2;
  // a failure with choices waits for the person's pick; the AI is only handed what Unit7 can't name, or a code mistake
  if ((!final || final.kind === 'code') && ctx.actor.kind !== 'agent' && autonomy >= 1 && Date.now() - (escalated.get(serviceId) ?? 0) > 30 * 60_000) {
    escalated.set(serviceId, Date.now());
    const { escalate, untrusted } = await import('../agent/escalate.ts');
    const r = await escalate(ctx.app, ctx.orgId, `Deploy of ${svc.name} failed`, `The deploy of service ${svc.name} (${svc.id}) failed and Unit7's automatic fixes weren't enough. Cause so far: ${plan.cause}.${plan.needsYou.length ? ` It needs: ${plan.needsYou.join(', ')}.` : ''} Read the logs with deployment_logs, find the real cause, fix what you safely can (config, variables, or tell the user the code change needed), redeploy, and summarise.\n\n${untrusted('the build and deploy log', `${last.message}\n${logOf(last)}`.slice(-2000))}`);
    handed = r.via === 'your-ai' ? '\nI’ve handed this to your AI (Claude Code, /unit7 watch) to dig in.' : '\nUnit7’s AI is looking into it.';
  }
  throw failedWithChoices(ctx, svcRow(ctx, serviceId), new Unit7Error(last.code, `${last.message}${plan.fixes.length ? `\nUnit7 tried: ${plan.fixes.map(describe).join('; ')}.` : ''}${needs}${handed}`, 502, last.detail), final);
}

// --- failures in plain words, with choices ------------------------------------------------------------------------------
// the log a failure carries apart from its plain message (src/deploy/deployer.ts detail.logTail)
const logOf = (e: Unit7Error) => { const t = (e.detail as { logTail?: unknown } | undefined)?.logTail; return typeof t === 'string' ? t : ''; };
const newestDeployment = (ctx: Ctx, serviceId: string) => get<{ id: string; status: string; log: string | null; plan: string; error: string | null }>(ctx.db, 'SELECT id, status, log, plan, error FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1', serviceId);
function classify(ctx: Ctx, svc: ServiceRow, e: Unit7Error, skip?: FailureKind[]): Failure | undefined {
  const cfg = json<ServiceConfig>(svc.config, {});
  const dep = newestDeployment(ctx, svc.id);
  const plan = json<{ pins?: Pins; nodeVersion?: number; builder?: string; dockerfileRev?: number }>(dep?.plan, {});
  return classifyBuild({
    builder: plan.builder ?? cfg.detection?.builder, rev: plan.dockerfileRev, dataDirs: [...(cfg.dataDirs ?? []), ...(cfg.volumes ?? []).map((v) => v.path.replace(/^\/app\//, ''))],
    text: `${e.message}\n${logOf(e)}\n${dep?.log ?? ''}`.slice(-20_000), code: e.code, pins: plan.pins ?? cfg.detection?.pins, nodeVersion: plan.nodeVersion ?? cfg.detection?.nodeVersion,
    packageManager: cfg.detection?.packageManager, setKeys: new Set(merged(ctx.db, ctx.orgId, { type: 'service', id: svc.id, label: svc.name }).map((v) => v.key)), skip,
  });
}
// the same app in Production with every one of these settings, for "Copy them from Production"
function fromProduction(ctx: Ctx, svc: ServiceRow, keys: string[] = []) {
  if (!keys.length || get<{ kind: string }>(ctx.db, 'SELECT kind FROM environments WHERE id = ?', svc.environment_id)?.kind === 'production') return undefined;
  const twin = get<{ id: string; name: string }>(ctx.db, `SELECT s.id, s.name FROM services s JOIN environments e ON e.id = s.environment_id WHERE s.project_id = ? AND e.kind = 'production' AND s.slug = ? AND s.id != ? AND s.org_id = ?`, svc.project_id, svc.slug, svc.id, ctx.orgId);
  const has = twin && new Set(merged(ctx.db, ctx.orgId, { type: 'service', id: twin.id, label: twin.name }).map((v) => v.key));
  return has && keys.every((k) => has.has(k)) ? { serviceId: twin.id, environmentId: svc.environment_id } : undefined;
}
const optionLines = (cs: Choice[]) => `What you can do:\n${cs.map((c) => `• ${c.label}${c.recommended ? ' (recommended)' : ''}`).join('\n')}`;
// what failed, kept on the deployment, and its timeline's failed step said plainly (it showed the build's raw first line)
function recordFailure(ctx: Ctx, dep: { id: string; plan: string }, f: Failure, choices?: Choice[]) {
  const steps = json<{ steps?: { state: string; note?: string }[] }>(dep.plan, {}).steps?.map((x) => (x.state === 'failed' ? { ...x, note: f.words } : x));
  run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ failure: { kind: f.kind, words: f.words, ...(f.where && { where: f.where }), ...(f.line && { line: f.line }) }, ...(choices && { choices }), ...(steps && { steps }) }), dep.id);
}
// the deploy's failure, said plainly first, with the choices kept on the deployment (service.get shows them)
function failedWithChoices(ctx: Ctx, svc: ServiceRow, e: Unit7Error, f: Failure | undefined): Unit7Error {
  const dep = newestDeployment(ctx, svc.id);
  if (!f || !dep || dep.status !== 'failed') return e;
  const choices = choicesFor(f, { app: svc.name, serviceId: svc.id, deploymentId: dep.id, state: 'failed', fromProduction: f.kind === 'build-env' ? fromProduction(ctx, svc, f.keys) : undefined });
  const lead = `${f.words}\nThe version that was live keeps serving.\n${optionLines(choices)}`;
  recordFailure(ctx, dep, f, choices);
  // the tests' own message is already plain words; a build's raw output moves below the plain ones
  if (e.code === 'tests_failed') return e;
  if (dep.error && !dep.error.startsWith(f.words)) run(ctx.db, 'UPDATE deployments SET error = ? WHERE id = ?', `${lead}\n\n${dep.error}`, dep.id);
  return new Unit7Error(e.code, `${lead}\n\n${e.message}`, e.status, e.detail);
}
// healed: said after, and for a version the repo should carry, the offer to write it in
function healedChoices(ctx: Ctx, svc: ServiceRow, f: Failure, deploymentId: string, done: string[]) {
  const told = `${f.words} Unit7 ${done.join(', ')}, and it’s live.`;
  const choices = (f.kind === 'pm-version' || f.kind === 'node-version') && f.pin ? choicesFor(f, { app: svc.name, serviceId: svc.id, deploymentId, state: 'healed' }) : undefined;
  run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ healedFrom: { kind: f.kind, words: f.words }, ...(choices && { choices }) }), deploymentId);
  return { told, ...(choices && { choices }) };
}
// a package manager version Unit7 worked out from the lockfile (the repo doesn't say it): offered once per app
function pinOffer(ctx: Ctx, serviceId: string, deploymentId: string) {
  const svc = svcRow(ctx, serviceId);
  const cfg = json<ServiceConfig & { pinOffered?: string; pinPr?: object }>(svc.config, {});
  const pm = json<{ pins?: Pins }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', deploymentId)?.plan, {}).pins?.pm;
  if (!pm || (pm.source !== 'lockfile' && pm.source !== 'default') || cfg.pinOffered === specOf(pm) || cfg.pinPr || cfg.source?.type !== 'git') return undefined;
  run(ctx.db, `UPDATE services SET config = json_set(config, '$.pinOffered', ?) WHERE id = ?`, specOf(pm), serviceId);
  const f: Failure = { kind: 'pm-version', words: `Unit7 built ${svc.name} with ${pm.tool} ${pm.version} because ${pm.why}; your repo doesn’t say it yet.`, pin: specOf(pm) };
  const choices = choicesFor(f, { app: svc.name, serviceId, deploymentId, state: 'healed' });
  run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ choices }), deploymentId);
  return { pinned: f.words, choices };
}
// pnpm 11 ignored package.json's "pnpm" settings, so the build had them in pnpm-workspace.yaml: offered once per app, to move
// them there in the repo (src/tools/pins.ts settingsChanges)
function settingsOffer(ctx: Ctx, serviceId: string, deploymentId: string) {
  const svc = svcRow(ctx, serviceId);
  const cfg = json<ServiceConfig & { settingsOffered?: boolean }>(svc.config, {});
  const keys = json<{ pnpmSettings?: string[] }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', deploymentId)?.plan, {}).pnpmSettings;
  if (!keys?.length || cfg.settingsOffered || cfg.source?.type !== 'git') return undefined;
  run(ctx.db, `UPDATE services SET config = json_set(config, '$.settingsOffered', json('true')) WHERE id = ?`, serviceId);
  const words = `The pnpm that builds ${svc.name} no longer reads ${keys.join(', ')} from package.json, so Unit7 put ${keys.length > 1 ? 'them' : 'it'} in pnpm-workspace.yaml for each build.`;
  const choices: Choice[] = [
    { label: 'Move them into pnpm-workspace.yaml for me', why: 'Opens a pull request that moves them, so every build and every computer uses them. Nothing changes until it’s merged.', recommended: true, tool: 'deployment.pin_pr', input: { serviceId, moveSettings: true } },
    { label: 'Show me how', why: 'Do it yourself in the repo.', recommended: false, steps: [`Move ${keys.join(', ')} out of the "pnpm" field in package.json into pnpm-workspace.yaml (in pnpm 11, onlyBuiltDependencies becomes allowBuilds: { name: true }).`, 'Commit and push; Unit7 deploys it like any push.'] },
    { label: 'Not now', why: `Unit7 keeps adding them to each build of ${svc.name}.`, recommended: false },
  ];
  run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ choices, healedFrom: { kind: 'pnpm-settings', words } }), deploymentId);
  return { pinned: words, choices };
}
// remember a person's pick for this app (over the repo's own, until the pull request is merged), and open the pull request
// through the gate, like any action
async function pinItForMe(ctx: Ctx, serviceId: string, pin: string) {
  const p = parsePin(pin)!;
  const cfg = json<ServiceConfig>(svcRow(ctx, serviceId).config, {});
  const mine = [...(cfg.pinnedByYou ?? []).filter((s) => { const q = parsePin(s); return !q || slotOf(q.tool) !== slotOf(p.tool); }), pin];
  run(ctx.db, `UPDATE services SET config = json_set(config, '$.pinnedByYou', json(?)) WHERE id = ?`, JSON.stringify(mine), serviceId);
  const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.pin_pr', { serviceId, pins: [pin] }, { reason: `pin ${pin}, which the build just used`, conversationId: ctx.conversationId, signal: ctx.signal });
  return r.status === 'ok' ? r.output : r.status === 'error' ? { error: r.error.message } : r.status === 'approval_required' ? { waiting: 'It’s waiting on the Approvals page.' } : { error: 'why' in r ? r.why : r.status };
}

function healPlan(ctx: Ctx, svc: ServiceRow, e: Unit7Error) {
  const cfg = json<ServiceConfig>(svc.config, {});
  const dep = get<{ log: string; plan: string }>(ctx.db, 'SELECT log, plan FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1', svc.id);
  const kinds = new Set(all<{ kind: string }>(ctx.db, 'SELECT kind FROM services WHERE environment_id = ?', svc.environment_id).map((r) => r.kind));
  const mem = svc.server_id ? json<{ mem_total?: number }>(get<{ facts: string }>(ctx.db, 'SELECT facts FROM servers WHERE id = ?', svc.server_id)?.facts ?? '{}', {}).mem_total : undefined;
  return diagnoseFailure({
    text: `${e.message}\n${logOf(e)}\n${dep?.log ?? ''}`.slice(-20_000),
    detection: { ...(cfg.detection ?? {}), ...json<Partial<Detection>>(dep?.plan ?? '{}', {}) } as Detection,
    cfg, setKeys: new Set(merged(ctx.db, ctx.orgId, { type: 'service', id: svc.id, label: svc.name }).map((v) => v.key)),
    has: { postgres: kinds.has('postgres'), redis: kinds.has('redis'), mongo: kinds.has('mongo') },
    hostMemMb: mem ? Math.round(mem / 1024 / 1024) : undefined,
  });
}

defineTool({
  name: 'deployment.logs', title: 'Deployment or runtime logs', risk: 'read', action: 'read', timeoutMs: 30_000,
  description: 'The build log of a deployment, or the running container’s recent logs for a service. Secrets redacted.',
  input: z.object({ serviceId: fid('svc').optional(), deploymentId: fid('dep').optional(), lines: z.number().int().min(1).max(2000).default(200) }).refine((v) => v.serviceId || v.deploymentId, 'give serviceId or deploymentId'),
  async run(ctx, i) {
    if (i.deploymentId) {
      const d = get<{ log: string; status: string; error: string | null }>(ctx.db, 'SELECT log, status, error FROM deployments WHERE id = ? AND org_id = ?', i.deploymentId, ctx.orgId);
      if (!d) throw new Unit7Error('not_found', 'That deployment was not found.', 404);
      return { kind: 'build', status: d.status, lines: (d.log || '').split('\n'), error: d.error };
    }
    const svc = svcRow(ctx, i.serviceId!);
    if (!svc.current_deployment_id || !svc.server_id) return { kind: 'runtime', lines: [], note: 'Nothing is deployed yet.' };
    const container = get<{ container: string }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id)?.container;
    if (!container) return { kind: 'runtime', lines: [], note: 'No running container.' };
    learnSecrets(ctx, svc.id);
    const r = await ssh(ctx.app).exec(serverRow(ctx, svc.server_id), `${cmd('docker', 'logs', '--timestamps', '--tail', String(i.lines), container)} 2>&1`, { timeoutMs: 25_000 });
    return { kind: 'runtime', container, lines: r.stdout.split('\n').filter(Boolean).map((l) => ctx.redactor.redact(l)) };
  },
});

defineTool({
  name: 'service.restart', title: 'Restart a service', risk: 'write', action: 'restart_service', timeoutMs: 120_000,
  description: 'Restart a service’s container and confirm it comes back healthy.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    if (!svc.current_deployment_id || !svc.server_id) throw new Unit7Error('not_deployed', `${svc.name} isn't deployed.`);
    const container = get<{ container: string }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id)!.container;
    const s = serverRow(ctx, svc.server_id);
    await ssh(ctx.app).check(s, cmd('docker', 'restart', container!), { what: 'Restarting', timeoutMs: 110_000 });
    const { healthCheck } = await import('../deploy/deployer.ts');
    const cfg = json<ServiceConfig>(svc.config, {});
    const h = await healthCheck(ctx, s, container!, cfg.port ?? 3000, cfg.healthPath ?? '/', (m) => ctx.progress(m));
    if (!h.healthy) { ctx.emit('service.unhealthy', `${svc.name} did not come back healthy after a restart`, { severity: 'critical', resource: svc.id }); throw new Unit7Error('unhealthy_after_restart', `${svc.name} restarted but isn't healthy: ${h.detail}`); }
    ctx.emit('service.restarted', `Restarted ${svc.name}`, { resource: svc.id });
    return { restarted: svc.name, health: h.detail };
  },
});

defineTool({
  name: 'deployment.rollback', title: 'Roll back a service', risk: 'write', action: 'rollback', timeoutMs: 180_000,
  description: 'Switch a service back to its previous healthy deployment (or a specific one). Instant: the old container was only stopped, not removed.',
  input: z.object({ serviceId: fid('svc'), deploymentId: fid('dep').optional() }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const migrated = json<{ migrated?: string[] }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.plan ?? '{}', {}).migrated ?? [];
    const r = await rollback(ctx, svc, i.deploymentId);
    return migrated.length ? { ...r, warning: `The version you left ran ${migrated.length} database migration${migrated.length > 1 ? 's' : ''}. The older code may not match the new schema; check it works, or restore the backup Unit7 took before migrating.` } : r;
  },
});

// Run several copies of a service behind Caddy's load balancer (least busy copy first, unhealthy copies
// taken out automatically). Refused while the code has something that breaks with two copies.
defineTool({
  name: 'service.autoscale', title: 'Autoscale an app', risk: 'write', action: 'scale',
  description: `Let Unit7 run more copies of an app when responses get slow or its server is busy, and fewer when it has been calm for 30 minutes, between min and max (up to ${MAX_REPLICAS}). Off keeps the number of copies where it is. Refused for apps that can't run as several copies.`,
  input: z.object({ serviceId: fid('svc'), on: z.boolean(), min: z.number().int().min(1).max(MAX_REPLICAS).default(1), max: z.number().int().min(1).max(MAX_REPLICAS).default(3) }),
  run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const cfg = json<ServiceConfig>(svc.config, {});
    const risks = cfg.detection?.scaleRisks ?? [];
    if (i.on && i.max > 1 && risks.length) throw new Unit7Error('unsafe_to_scale', `${svc.name} can't run as several copies yet: ${risks.join('; ')}. Fix that first (your AI can do it), then turn on autoscaling.`, 409);
    if (i.min > i.max) throw new Unit7Error('bad_input', 'The minimum can\u2019t be above the maximum.', 400);
    run(ctx.db, 'UPDATE services SET config = ? WHERE id = ?', JSON.stringify({ ...cfg, autoscale: i.on ? { on: true, min: i.min, max: i.max } : { on: false, min: i.min, max: i.max } }), svc.id);
    return { app: svc.name, autoscale: i.on ? `${i.min}–${i.max} copies` : 'off', note: i.on ? 'Warden checks every 2 minutes: slow responses or a busy server add a copy; 30 calm minutes remove one.' : undefined };
  },
});

defineTool({
  name: 'service.scale', title: 'Run more copies of a service', risk: 'write', action: 'scale', timeoutMs: 10 * 60_000,
  description: `Run 1–${MAX_REPLICAS} copies of a deployed service on its server, load-balanced by Caddy with health checks. Use when one copy is maxed out (high CPU, slow responses) and the server has room. Refuses if the code keeps sessions, uploads, scheduled jobs or a SQLite database inside the app, since those break with two copies.`,
  input: z.object({ serviceId: fid('svc'), replicas: z.number().int().min(1).max(MAX_REPLICAS) }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const cfg = json<ServiceConfig>(svc.config, {});
    const dep = get<{ container: string | null; image: string | null }>(ctx.db, 'SELECT container, image FROM deployments WHERE id = ?', svc.current_deployment_id ?? '');
    if (!svc.server_id || !dep?.container || !dep.image) throw new Unit7Error('not_deployed', `${svc.name} isn't running yet. Deploy it first.`);
    const risks = cfg.detection?.scaleRisks ?? [];
    if (i.replicas > 1 && risks.length) throw new Unit7Error('unsafe_to_scale', `${svc.name} can't run as several copies yet: ${risks.join('; ')}. Fix that first (your AI can do it), then scale.`, 409);
    const s = serverRow(ctx, svc.server_id);
    const pool = ssh(ctx.app);
    const port = cfg.detection?.builder === 'static' ? 80 : cfg.port ?? 3000;
    const healthPath = cfg.healthPath ?? cfg.detection?.healthPath ?? '/';
    const have = replicaNames(dep.container, cfg.replicas);
    const want = replicaNames(dep.container, i.replicas);
    const env = resolveValues(ctx, svc.id);
    env.PORT ??= String(port);
    for (const r of want.filter((n) => !have.includes(n))) {
      ctx.progress(`Starting another copy (${r})…`);
      await startContainer(ctx, s, r, dep.image, cfg, env, svc);
      const h = await healthCheck(ctx, s, r, port, healthPath, (m) => ctx.progress(m));
      if (!h.healthy) { await pool.exec(s, cmd('docker', 'rm', '-f', r)).catch(() => undefined); throw new Unit7Error('unhealthy', `The new copy didn't pass its health check, so nothing changed.\n${h.detail}`, 502); }
    }
    // route first, then remove copies nobody sends traffic to anymore
    await routeService(ctx, s, svc, dep.container, want);
    const extra = have.filter((n) => !want.includes(n));
    if (extra.length) await pool.exec(s, cmd('docker', 'rm', '-f', ...extra)).catch(() => undefined);
    run(ctx.db, 'UPDATE services SET config = ? WHERE id = ?', JSON.stringify({ ...cfg, replicas: i.replicas }), svc.id);
    const before = Math.max(1, cfg.replicas ?? 1);
    ctx.emit('service.scaled', `${svc.name} now runs ${i.replicas} cop${i.replicas > 1 ? 'ies' : 'y'}${i.replicas > 1 ? ' behind the load balancer' : ''}`, { severity: 'success', resource: svc.id });
    return { service: svc.name, replicas: i.replicas, loadBalancer: i.replicas > 1 ? 'least busy copy first, health-checked every 10s' : 'off',
      ...(before !== i.replicas && { undo: { tool: 'service.scale', input: { serviceId: svc.id, replicas: before }, label: `Back to ${before} cop${before > 1 ? 'ies' : 'y'}` } }) };
  },
});

defineTool({
  name: 'service.cache_static', title: 'Cache build files for a year', risk: 'write', action: 'proxy_config', timeoutMs: 120_000,
  description: 'Tell browsers to keep a service’s fingerprinted build files (JS, CSS, images under /assets and similar) for a year. Faster repeat visits, less bandwidth. Never applied to pages or APIs.',
  input: z.object({ serviceId: fid('svc'), on: z.boolean().default(true) }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const cfg = json<ServiceConfig>(svc.config, {});
    const path = hashedPath(cfg.detection?.stack);
    if (i.on && !path) throw new Unit7Error('nothing_to_cache', `${svc.name} (${cfg.detection?.stack ?? 'unknown stack'}) has no fingerprinted build folder Unit7 knows, or already caches its own.`, 409);
    const dep = get<{ container: string | null }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id ?? '');
    if (!svc.server_id || !dep?.container) throw new Unit7Error('not_deployed', `${svc.name} isn't running yet.`);
    const next = { ...cfg, cacheStatic: i.on ? path : undefined };
    run(ctx.db, 'UPDATE services SET config = ? WHERE id = ?', JSON.stringify(next), svc.id);
    await routeService(ctx, serverRow(ctx, svc.server_id), { ...svc, config: JSON.stringify(next) }, dep.container, replicaNames(dep.container, cfg.replicas));
    return { service: svc.name, cached: i.on ? path : 'off', undo: { tool: 'service.cache_static', input: { serviceId: svc.id, on: !i.on }, label: i.on ? 'Stop caching build files' : 'Cache build files again' } };
  },
});

defineTool({
  name: 'security.scan', title: 'Scan a service for vulnerabilities', risk: 'read', action: 'read', timeoutMs: 20 * 60_000,
  description: 'Scan the running image of a service for fixable critical and high vulnerabilities (OS packages and npm/pip/go dependencies). Unit7 runs this after every deploy and weekly.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const dep = get<{ id: string; image: string | null }>(ctx.db, 'SELECT id, image FROM deployments WHERE id = ?', svc.current_deployment_id ?? '');
    if (!svc.server_id || !dep?.image) throw new Unit7Error('not_deployed', `${svc.name} isn't running yet.`);
    const rep = await scanDeployment(ctx, serverRow(ctx, svc.server_id), dep.id, dep.image, svc.name);
    if (!rep) throw new Unit7Error('scan_failed', 'The scanner could not run on this server (it needs to download its database once).', 502);
    return rep;
  },
});

defineTool({
  name: 'service.settings', title: 'Change how a service builds and deploys', risk: (i) => (i.buildCommand !== undefined || i.startCommand !== undefined ? 'destructive' : 'write'), action: 'service_write',
  description: 'Turn push-to-deploy or pull-request previews on/off, or override the port, build or start command or memory cap. Takes effect on the next deploy.',
  input: z.object({
    serviceId: fid('svc'), autoDeploy: z.boolean().optional(), previews: z.boolean().optional(),
    port: z.number().int().min(1).max(65535).optional(), buildCommand: z.string().max(500).optional(), startCommand: z.string().max(500).optional(),
    memoryMb: z.number().int().min(64).max(1_048_576).optional().describe('A memory cap, used from the next deploy'),
    runTests: z.boolean().optional().describe('Run the app’s tests before each deploy (on by default when it has tests). Only a person can turn it off.'),
    testTimeoutMin: z.number().int().min(1).max(60).optional().describe('How long the tests may take, in minutes (10 by default)'),
  }),
  // ZD-SAFE: turning the test gate off is a person's choice, like "Deploy anyway"
  peopleOnly: (i) => i.runTests === false,
  run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    const { serviceId: _, ...changes } = i;
    const cfg = { ...json<ServiceConfig>(svc.config, {}), ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
    run(ctx.db, 'UPDATE services SET config = ? WHERE id = ?', JSON.stringify(cfg), svc.id);
    const changed = Object.keys(changes).filter((k) => (changes as Record<string, unknown>)[k] !== undefined);
    // undo restores the old values (switches default to on); a value that wasn't set before can't be "unset" this way
    const old = json<Record<string, unknown>>(svc.config, {});
    const prev = Object.fromEntries(changed.map((k) => [k, k === 'autoDeploy' || k === 'previews' || k === 'runTests' ? old[k] !== false : k === 'testTimeoutMin' ? old[k] ?? 10 : old[k]]));
    return { service: svc.name, changed, ...(Object.values(prev).every((v) => v !== undefined) && { undo: { tool: 'service.settings', input: { serviceId: svc.id, ...prev }, label: 'Put the previous settings back' } }) };
  },
});

defineTool({
  name: 'service.stop', title: 'Stop a service', risk: 'write', action: 'restart_service', timeoutMs: 60_000,
  description: 'Stop a service’s container (it can be started again by deploying or rolling back). Removes its routes.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    if (svc.server_id && svc.current_deployment_id) {
      const container = get<{ container: string }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id)?.container;
      const s = serverRow(ctx, svc.server_id);
      if (container) await ssh(ctx.app).exec(s, script('docker stop "$@" >/dev/null 2>&1; true', container, ...replicaNames(container, MAX_REPLICAS))).catch(() => undefined);
      const { removeSite } = await import('../deploy/caddy.ts');
      for (const d of all<{ hostname: string }>(ctx.db, 'SELECT hostname FROM domains WHERE service_id = ?', svc.id)) await removeSite(ctx.app, s, d.hostname).catch(() => undefined);
    }
    run(ctx.db, `UPDATE services SET status = 'stopped' WHERE id = ?`, svc.id);
    return { stopped: svc.name };
  },
});

defineTool({
  name: 'service.remove', title: 'Remove a service', risk: 'destructive', action: 'service_delete', timeoutMs: 120_000,
  description: 'Remove a service: stop and delete its containers and routes. For a database, a final backup is taken first and its volume is kept unless you say otherwise.',
  input: z.object({ serviceId: fid('svc'), deleteData: z.boolean().default(false) }),
  async run(ctx, i) {
    const svc = svcRow(ctx, i.serviceId);
    if (['postgres', 'mysql', 'mariadb', 'mongo'].includes(svc.kind) && !i.deleteData) {
      const { backupBeforeChange } = await import('./backups.ts');
      await backupBeforeChange(ctx, svc.id, 'remove the database');
    }
    if (svc.server_id) {
      const s = serverRow(ctx, svc.server_id);
      // every copy of every version, with its env file (secrets in plain text on the server's disk)
      const containers = all<{ container: string }>(ctx.db, 'SELECT container FROM deployments WHERE service_id = ? AND container IS NOT NULL', svc.id);
      for (const c of containers) await removeCopies(ctx, s, c.container).catch(() => undefined);
      // a database has no deployments: its container (and its pooler) are named in its config
      const cfg = json<{ container?: string; pool?: { container?: string } }>(svc.config, {});
      const dbContainers = [cfg.container, cfg.pool?.container].filter((c): c is string => !!c);
      if (dbContainers.length) await ssh(ctx.app).exec(s, cmd('docker', 'rm', '-f', ...dbContainers)).catch(() => undefined);
      const { removeSite } = await import('../deploy/caddy.ts');
      for (const d of all<{ hostname: string }>(ctx.db, 'SELECT hostname FROM domains WHERE service_id = ?', svc.id)) await removeSite(ctx.app, s, d.hostname).catch(() => undefined);
      if (i.deleteData && cfg.container) await ssh(ctx.app).exec(s, cmd('docker', 'volume', 'rm', `${cfg.container}-data`)).catch(() => undefined);
    }
    run(ctx.db, 'DELETE FROM services WHERE id = ?', svc.id);
    ctx.emit('service.removed', `Removed ${svc.name}${i.deleteData ? ' and its data' : ' (data kept)'}`, { severity: 'warning' });
    return { removed: svc.name, dataKept: !i.deleteData };
  },
});
