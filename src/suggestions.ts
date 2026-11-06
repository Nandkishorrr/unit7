// What Warden suggests right now. Every suggestion is a real situation in this org's state with one
// or two one-click fixes, most urgent first. Open a project and only that project's suggestions show,
// including what Warden learned from its code (project memory), its server's load and its traffic.
// Warden's voice: a small, loyal tactical bodyguard: crisp status reports, a little
// dramatic, always ending in an action.
import type { App } from './app.ts';
import { all, get, json } from './db.ts';
import { isPublicKey, merged } from './tools/env.ts';
import { runsDevServer } from './connectors/detect.ts';
import { hashedPath } from './deploy/caddy.ts';
import { replicaNames, MAX_REPLICAS, type ServiceConfig } from './deploy/deployer.ts';
import { sentence } from './tools/errors.ts';
import { assetIdOf, dropArchived } from './archive.ts';
import { keptMarks } from './kept.ts';
import { groupSuggestions } from './organize/groups.ts';
import { serverAppSuggestions } from './tools/serverapps.ts';

export type SuggestionAction =
  | { label: string; kind: 'tool'; tool: string; input: Record<string, unknown>; success?: string; preview?: boolean } // preview: show its dry run first
  | { label: string; kind: 'navigate'; href: string }
  | { label: string; kind: 'connect'; agent: string }
  | { label: string; kind: 'ask'; prompt: string }; // a code change: copy a ready prompt for your own AI

export interface Suggestion { id: string; severity: 'info' | 'warn' | 'alert'; text: string; actions: SuggestionAction[] }

interface Options { agents?: { id: string; name: string; installed: boolean; connected: boolean }[]; projectId?: string }

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export function suggestions(app: App, orgId: string, o: Options = {}): Suggestion[] {
  const { db } = app;
  const out: Suggestion[] = [];
  const add = (s: Suggestion) => out.push(s);
  const pid = o.projectId;
  const inProject = (projectId: string | null | undefined) => !pid || projectId === pid;

  for (const inc of all<{ id: string; title: string; project_id: string | null }>(db, `SELECT id, title, project_id FROM incidents WHERE org_id = ? AND status IN ('open','investigated') ORDER BY created_at DESC LIMIT 5`, orgId).filter((i) => inProject(i.project_id)).slice(0, 2)) {
    add({ id: `incident:${inc.id}`, severity: 'alert', text: `Incident on the perimeter: ${inc.title}. I'm on it, but you'll want to look.`, actions: [{ label: 'See what happened', kind: 'navigate', href: '/activity' }] });
  }

  const pending = get<{ n: number }>(db, `SELECT count(*) n FROM approvals WHERE org_id = ? AND status = 'pending' AND expires_at > ?`, orgId, new Date().toISOString())!.n;
  if (pending) add({ id: 'approvals', severity: 'warn', text: `${pending} thing${pending > 1 ? 's are' : ' is'} waiting for your OK.`, actions: [{ label: 'Review', kind: 'navigate', href: '/approvals' }] });

  // a backup that didn't make it off its server
  for (const b of all<{ id: string; service: string; project_id: string; service_id: string }>(db, `SELECT b.id, s.name service, s.project_id, b.service_id FROM backups b JOIN services s ON s.id = b.service_id
      WHERE b.org_id = ? AND b.status = 'done' AND json_extract(b.offsite, '$.error') IS NOT NULL AND b.created_at > ? ORDER BY b.created_at DESC LIMIT 2`, orgId, ago(2 * 86400_000)).filter((x) => inProject(x.project_id))) {
    add({ id: `offsite:${b.id}`, severity: 'warn', text: `${b.service}'s latest backup didn't make it off the server. If the server dies, so does that backup.`, actions: [{ label: 'Retry', kind: 'tool', tool: 'backup.offsite_copy', input: { backupId: b.id }, success: 'Copied off the server' }] });
  }

  // the last deploy of a service failed (the previous version is still serving)
  for (const d of all<{ service_id: string; name: string; project_id: string; error: string }>(db, `SELECT d.service_id, s.name, s.project_id, d.error FROM deployments d JOIN services s ON s.id = d.service_id
      WHERE d.org_id = ? AND d.status = 'failed' AND d.error LIKE 'The new version''s migration removes data%' AND d.number = (SELECT max(number) FROM deployments x WHERE x.service_id = d.service_id)`, orgId).filter((d) => inProject(d.project_id))) {
    const line = d.error.split('\n')[1] ?? '';
    add({ id: `migration:${d.service_id}`, severity: 'warn', text: `${d.name}'s new version wants to change the database in a way that removes data (${line.slice(0, 90)}). I stopped before running it.`,
      actions: [{ label: 'Back up & run it', kind: 'tool', tool: 'deployment.create', input: { serviceId: d.service_id, allowDestructiveMigration: true }, success: 'Backed up, migrated and deployed' }, { label: 'See it', kind: 'navigate', href: `/projects/${d.project_id}/services/${d.service_id}` }] });
  }
  for (const d of all<{ service_id: string; name: string; project_id: string; number: number }>(db, `SELECT d.service_id, s.name, s.project_id, d.number FROM deployments d JOIN services s ON s.id = d.service_id
      WHERE d.org_id = ? AND d.status = 'failed' AND coalesce(d.error, '') NOT LIKE 'The new version''s migration removes data%' AND d.number = (SELECT max(number) FROM deployments x WHERE x.service_id = d.service_id) AND d.started_at > ?`, orgId, ago(2 * 86400_000)).filter((d) => inProject(d.project_id)).slice(0, 2)) {
    add({ id: `deployfail:${d.service_id}:${d.number}`, severity: 'alert', text: `${d.name}'s deploy #${d.number} failed. The old version is still holding the line.`, actions: [{ label: 'See why', kind: 'navigate', href: `/projects/${d.project_id}/services/${d.service_id}` }] });
  }

  // a secret with a public prefix gets baked into every visitor's browser
  for (const v of all<{ key: string; scope_type: string; scope_id: string }>(db, `SELECT DISTINCT key, scope_type, scope_id FROM env_vars WHERE org_id = ? AND secret = 1 AND deleted_at IS NULL`, orgId).filter((v) => isPublicKey(v.key))) {
    const project = v.scope_type === 'project' ? v.scope_id : v.scope_type === 'environment' ? get<{ p: string }>(db, 'SELECT project_id p FROM environments WHERE id = ?', v.scope_id)?.p : v.scope_type === 'service' ? get<{ p: string }>(db, 'SELECT project_id p FROM services WHERE id = ?', v.scope_id)?.p : undefined;
    if (!inProject(project) || out.filter((s) => s.id.startsWith('leak:')).length >= 2) continue;
    add({ id: `leak:${v.scope_id}:${v.key}`, severity: 'alert', text: `${v.key} is a secret with a public name, so it would ship to every browser. Not on my watch. Rename it without the public prefix.`, actions: project ? [{ label: 'Show me', kind: 'navigate', href: `/projects/${project}?tab=variables` }] : [] });
  }

  // org-wide setup: only on the general view
  const servers = all<{ id: string; name: string; status: string; facts: string; provider_ref: string | null }>(db, 'SELECT id, name, status, facts, provider_ref FROM servers WHERE org_id = ? ORDER BY created_at', orgId);
  const projectServers = pid ? new Set(all<{ server_id: string }>(db, 'SELECT DISTINCT server_id FROM services WHERE project_id = ? AND server_id IS NOT NULL', pid).map((r) => r.server_id)) : undefined;
  if (!pid) {
    if (o.agents && !o.agents.some((a) => a.connected)) {
      const installed = o.agents.filter((a) => a.installed).slice(0, 3);
      if (installed.length) add({ id: 'no-agent', severity: 'warn', text: 'No AI connected. I’m guarding an empty command post. Pick your AI and just ask it to deploy.', actions: installed.map((a) => ({ label: a.name, kind: 'connect' as const, agent: a.id })) });
    }
    if (!servers.length) add({ id: 'no-server', severity: 'info', text: 'No server to guard yet. Give me one and I’ll set it up: Docker, HTTPS, firewall.', actions: [{ label: 'Get a server', kind: 'navigate', href: '/servers' }] });
  }
  for (const s of servers.filter((x) => !projectServers || projectServers.has(x.id))) {
    const f = json<{ hardenedAt?: string; blocks?: { until: number }[] }>(s.facts, {});
    if (s.status === 'unreachable' || s.status === 'error') add({ id: `down:${s.id}`, severity: 'alert', text: `${s.name} stopped answering me. I can check why and fix it.`, actions: [{ label: 'Diagnose & fix', kind: 'navigate', href: `/servers/${s.id}` }] });
    else if (s.status !== 'ready' && s.status !== 'bootstrapping') add({ id: `prepare:${s.id}`, severity: 'warn', text: `${s.name} is connected but not prepared yet.`, actions: [{ label: 'Prepare it', kind: 'tool', tool: 'server.bootstrap', input: { serverId: s.id }, success: `${s.name} is ready` }] });
    else if (s.status === 'ready' && !f.hardenedAt) add({ id: `harden:${s.id}`, severity: 'warn', text: `${s.name}’s doors aren’t checked yet: password logins and open ports.`, actions: [{ label: 'Secure it', kind: 'tool', tool: 'server.harden', input: { serverId: s.id }, success: `${s.name} is locked down` }] });
    const m = get<{ disk_used: number; disk_total: number }>(db, 'SELECT disk_used, disk_total FROM metrics WHERE server_id = ? ORDER BY at DESC LIMIT 1', s.id);
    const disk = m?.disk_total ? Math.round((m.disk_used / m.disk_total) * 100) : 0;
    if (disk > 85) add({ id: `disk:${s.id}`, severity: 'warn', text: `${s.name}’s disk is ${disk}% full. Permission to sweep old images?`, actions: [{ label: 'Free space', kind: 'tool', tool: 'docker.prune', input: { serverId: s.id }, success: 'Space freed' }] });
    // a server that coasted all week: a smaller plan would do (needs ≥ 3 days of metrics)
    if (!pid && s.status === 'ready') {
      const w = get<{ n: number; first: string | null; cpu: number | null; mem: number | null }>(db, 'SELECT count(*) n, min(at) first, avg(cpu) cpu, max(1.0 * mem_used / nullif(mem_total, 0)) mem FROM metrics WHERE server_id = ? AND at > ?', s.id, ago(7 * 86400_000))!;
      if (w.first && Date.now() - Date.parse(w.first) > 3 * 86400_000 && (w.cpu ?? 100) < 10 && (w.mem ?? 1) < 0.35) {
        add({ id: `rightsize:${s.id}`, severity: 'info', text: `${s.name} averaged ${Math.round(w.cpu!)}% CPU and never used more than ${Math.round(w.mem! * 100)}% of its memory this week. A smaller plan would do, for less money.`,
          actions: [s.provider_ref?.startsWith('hostinger:') ? { label: 'See plans', kind: 'navigate', href: 'https://hpanel.hostinger.com/vps' } : { label: 'See the server', kind: 'navigate', href: `/servers/${s.id}` }] });
      }
    }
    const blocked = (f.blocks ?? []).filter((b) => b.until > Date.now()).length;
    if (blocked && !pid) add({ id: `blocked:${s.id}:${blocked}`, severity: 'info', text: `${blocked} attacker${blocked > 1 ? 's are' : ' is'} blocked at ${s.name}’s gate right now.`, actions: [{ label: 'See them', kind: 'navigate', href: `/servers/${s.id}` }] });
  }

  // databases without a backup schedule
  for (const d of all<{ id: string; name: string; project_id: string }>(db, `SELECT s.id, s.name, s.project_id FROM services s WHERE s.org_id = ? AND s.kind IN ('postgres','mysql','mariadb','mongo','redis')
      AND NOT EXISTS (SELECT 1 FROM backup_schedules b WHERE b.service_id = s.id)`, orgId).filter((d) => inProject(d.project_id)).slice(0, 3)) {
    add({ id: `backup:${d.id}`, severity: 'warn', text: `${d.name} is running without a safety net.`, actions: [{ label: 'Back up daily', kind: 'tool', tool: 'backup.schedule', input: { serviceId: d.id, frequency: 'daily', keep: 7 }, success: `Daily backups on for ${d.name}` }] });
  }

  // a backup that wouldn't restore: the safety net has a hole
  for (const b of all<{ service_id: string; name: string; project_id: string; verify_note: string }>(db, `SELECT b.service_id, s.name, s.project_id, b.verify_note FROM backups b JOIN services s ON s.id = b.service_id
      WHERE b.org_id = ? AND b.verify_ok = 0 AND b.created_at = (SELECT max(created_at) FROM backups x WHERE x.service_id = b.service_id AND x.status = 'done')`, orgId).filter((b) => inProject(b.project_id))) {
    add({ id: `badbackup:${b.service_id}`, severity: 'alert', text: `${b.name}'s latest backup doesn't restore (${b.verify_note}). Your safety net has a hole.`,
      actions: [{ label: 'Back up again', kind: 'tool', tool: 'backup.create', input: { serviceId: b.service_id, reason: 'after a failed restore test' }, success: 'New backup taken' }, { label: 'Test it', kind: 'tool', tool: 'backup.verify', input: { serviceId: b.service_id }, success: 'Restore test done' }] });
  }

  appSuggestions(app, orgId, pid, servers, add);
  // self-hosted apps on a server (Supabase, n8n…) that Unit7 could keep a key for
  if (!pid) for (const x of serverAppSuggestions(app, orgId)) add(x);

  if (!pid) {
    const ready = servers.some((s) => s.status === 'ready');
    const deployed = get<{ n: number }>(db, `SELECT count(*) n FROM deployments WHERE org_id = ? AND status = 'live'`, orgId)!.n;
    if (ready && !deployed) add({ id: 'first-deploy', severity: 'info', text: 'Server’s ready and waiting. Want to put something live? In Claude Code type: /unit7 deploy this folder', actions: [{ label: 'Copy it', kind: 'ask', prompt: '/unit7 deploy this folder' }] });
  }

  // things across providers that look like one product: group them (src/organize/groups.ts)
  if (!pid) for (const g of groupSuggestions(app, orgId)) add(g);
  dropArchived(db, orgId, out); // archived (asset.archive): Unit7 doesn't suggest anything about it
  if (!out.length) add({ id: 'all-clear', severity: 'info', text: pid ? 'This project is secure. Nothing needs you right now.' : 'Perimeter secure. All systems normal. I’ll shout if anything moves.', actions: [] });
  const rank = { alert: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// Settings the code reads that nobody set, said with the environment ("api in Staging needs 2 settings"). When the same
// app in Production has them, the first button copies them over (a preview first, then undo); the second opens that
// environment's Variables.
export function missingSettings(app: App, orgId: string, s: Pick<Svc, 'id' | 'name' | 'project_id' | 'environment_id' | 'env_kind' | 'env_name'>, missing: string[]): Suggestion {
  const n = missing.length, list = `${missing.slice(0, 4).join(', ')}${n > 4 ? '…' : ''}`;
  const prod = s.env_kind === 'production' ? undefined : get<{ id: string; env: string }>(app.db, `SELECT x.id, e.name env FROM services x JOIN environments e ON e.id = x.environment_id
    WHERE x.org_id = ? AND x.project_id = ? AND e.kind = 'production' AND x.name = ? LIMIT 1`, orgId, s.project_id, s.name);
  const there = prod ? new Set(merged(app.db, orgId, { type: 'service', id: prod.id, label: s.name }).map((v) => v.key)) : new Set<string>();
  const has = missing.filter((k) => there.has(k));
  const them = n > 1 ? 'them' : 'it';
  const tail = !prod || !has.length ? `Expect errors where ${n > 1 ? 'they’re' : 'it’s'} used.` : has.length === n ? `${prod.env} has ${them}.` : `${prod.env} has ${has.join(', ')}.`;
  const setThem = { label: n > 1 ? 'Set them' : 'Set it', kind: 'navigate' as const, href: `/projects/${s.project_id}?env=${s.environment_id}&tab=variables` };
  return {
    id: `envmissing:${s.id}:${n}`, severity: 'warn', text: `${s.name} in ${s.env_name} needs ${n} setting${n > 1 ? 's' : ''}: ${list}. ${tail}`,
    actions: prod && has.length
      ? [{ label: `Copy from ${prod.env}`, kind: 'tool', tool: 'env.copy', input: { fromServiceId: prod.id, environmentId: s.environment_id, keys: has }, success: `Copied to ${s.env_name}`, preview: true }, setThem]
      : [setThem],
  };
}

// --- per app: from what Unit7 learned of its code, its server's load and its traffic --------------

interface Svc { id: string; name: string; project_id: string; environment_id: string; server_id: string | null; config: string; env_kind: string; env_name: string; container: string | null; finished_at: string | null }

function appSuggestions(app: App, orgId: string, pid: string | undefined, servers: { id: string; name: string; facts: string; provider_ref: string | null }[], add: (s: Suggestion) => void) {
  const { db } = app;
  const svcs = all<Svc>(db, `SELECT s.id, s.name, s.project_id, s.environment_id, s.server_id, s.config, e.kind env_kind, e.name env_name, d.container, d.finished_at
    FROM services s JOIN environments e ON e.id = s.environment_id JOIN deployments d ON d.id = s.current_deployment_id
    WHERE s.org_id = ? AND d.status = 'live' AND s.kind NOT IN ('postgres','mysql','mariadb','mongo','redis') ${pid ? 'AND s.project_id = ?' : ''}`, ...(pid ? [orgId, pid] : [orgId]));
  const svcPage = (s: Svc) => `/projects/${s.project_id}/services/${s.id}`;
  const kept = keptMarks(db, orgId); // a person said it's in use (asset.keep): never suggested for stopping as idle

  for (const s of svcs) {
    const cfg = json<ServiceConfig>(s.config, {});
    const det = cfg.detection;
    const prod = s.env_kind === 'production';

    // a background process from the Procfile that nobody is running
    for (const [name, command] of Object.entries(det?.processes ?? {}).filter(([k]) => !['web', 'release'].includes(k)).slice(0, 2)) {
      if (get(db, `SELECT 1 FROM services WHERE environment_id = ? AND json_extract(config, '$.workerOf') = ? AND json_extract(config, '$.workerName') = ?`, s.environment_id, s.id, name)) continue;
      add({ id: `worker:${s.id}:${name}`, severity: 'info', text: `${s.name}'s Procfile has a background process that isn't running (${name}: ${command.slice(0, 60)}).`,
        actions: [{ label: `Run the ${name}`, kind: 'tool', tool: 'service.add_worker', input: { serviceId: s.id, name, command }, success: `${name} is running` }] });
    }
    // a scheduled job whose last run failed
    for (const j of all<{ id: string; name: string; last_status: string }>(db, `SELECT id, name, last_status FROM jobs WHERE service_id = ? AND last_status LIKE 'failed%'`, s.id).slice(0, 2)) {
      add({ id: `job:${j.id}`, severity: 'warn', text: `${s.name}'s scheduled job "${j.name}" ${j.last_status} on its last run.`,
        actions: [{ label: 'Run again', kind: 'tool', tool: 'job.run', input: { jobId: j.id }, success: `Ran ${j.name}` }, { label: 'See it', kind: 'navigate', href: svcPage(s) }] });
    }
    // a staging/dev app nobody visited for two days (only when Warden was watching the whole time)
    if (!prod && s.finished_at && Date.now() - Date.parse(s.finished_at) > 2 * 86400_000 && s.server_id && !kept.has(assetIdOf(orgId, `unit7:${s.id}`))) {
      const hostsIdle = all<{ hostname: string }>(db, 'SELECT hostname FROM domains WHERE service_id = ?', s.id).map((d) => d.hostname);
      const watched = get<{ n: number }>(db, 'SELECT count(*) n FROM metrics WHERE server_id = ? AND at > ?', s.server_id, ago(2 * 86400_000))!.n > 2 * 24 * 60; // ≥ half the expected samples
      const visits = hostsIdle.length ? get<{ n: number }>(db, `SELECT coalesce(sum(requests),0) n FROM traffic WHERE hostname IN (${hostsIdle.map(() => '?').join(',')}) AND at > ?`, ...hostsIdle, ago(2 * 86400_000))!.n : 0;
      if (watched && hostsIdle.length && visits === 0) {
        add({ id: `idle:${s.id}`, severity: 'info', text: `${s.name} (${s.env_kind}) had no visitors in two days. Stop it to free the server? It starts again on the next deploy.`,
          actions: [{ label: 'Stop it', kind: 'tool', tool: 'service.stop', input: { serviceId: s.id }, success: `${s.name} stopped` }] });
      }
    }

    // errors happening now (grouped from the app's logs), worst first
    const hour = ago(3600_000);
    for (const g of all<{ id: string; kind: string; message: string; frame: string | null; sample: string; first_deploy: number | null; n: number }>(db, `SELECT g.id, g.kind, g.message, g.frame, g.sample, g.first_deploy,
        (SELECT coalesce(sum(n),0) FROM error_hits h WHERE h.group_id = g.id AND h.at > ?) n FROM error_groups g WHERE g.service_id = ? AND g.resolved_at IS NULL ORDER BY n DESC LIMIT 2`, hour, s.id).filter((g) => g.n >= 3)) {
      const curNo = get<{ number: number }>(db, 'SELECT number FROM deployments WHERE id = (SELECT current_deployment_id FROM services WHERE id = ?)', s.id)?.number;
      const fromLatest = g.first_deploy && g.first_deploy === curNo;
      const canRollback = fromLatest && !!get(db, `SELECT 1 FROM deployments WHERE service_id = ? AND status = 'stopped' AND container IS NOT NULL`, s.id);
      add({ id: `error:${g.id}`, severity: g.n >= 20 ? 'alert' : 'warn', text: sentence({ service: s.name, kind: g.kind, message: g.message, frame: g.frame, lastHour: g.n, firstDeploy: g.first_deploy }) + '.',
        actions: [
          { label: 'Fix it with my AI', kind: 'ask', prompt: `/unit7 fix this error in ${s.name}: ${g.kind}: ${g.message}${g.frame ? ` (at ${g.frame})` : ''}. Find the cause in the code, fix it, and redeploy.\n\nStack trace:\n${g.sample.slice(0, 1500)}` },
          ...(canRollback ? [{ label: 'Roll back', kind: 'tool' as const, tool: 'deployment.rollback', input: { serviceId: s.id }, success: `${s.name} is back on the previous version` }] : []),
          { label: 'Mark fixed', kind: 'tool', tool: 'errors.resolve', input: { groupId: g.id }, success: 'Marked fixed; it comes back if it happens again' },
        ] });
    }

    // fixable critical/high vulnerabilities in the running image (trivy, after each deploy and weekly)
    const sec = json<{ security?: { critical: number; high: number; top: { pkg: string; installed: string; fixed: string }[] } }>(get<{ plan: string }>(db, 'SELECT d.plan FROM deployments d JOIN services s ON s.current_deployment_id = d.id WHERE s.id = ?', s.id)?.plan ?? '{}', {}).security;
    if (sec && sec.critical + sec.high > 0) {
      const list = sec.top.slice(0, 5).map((v) => `${v.pkg} ${v.installed} → ${v.fixed}`).join(', ');
      add({ id: `vuln:${s.id}:${sec.critical}:${sec.high}`, severity: sec.critical ? 'alert' : 'warn', text: `${s.name} has ${sec.critical ? `${sec.critical} critical and ` : ''}${sec.high} high vulnerabilities, all with fixes: ${list}.`,
        actions: [{ label: 'Ask my AI to upgrade', kind: 'ask', prompt: `/unit7 upgrade these vulnerable packages in ${s.name} to their fixed versions, run the tests, and redeploy: ${list}` }, { label: 'Scan again', kind: 'tool', tool: 'security.scan', input: { serviceId: s.id }, success: 'Scanned' }] });
    }

    // a development server in production: slow, leaks code on errors, restarts on file changes
    if (prod && runsDevServer(cfg.startCommand ?? det?.startCommand)) {
      add({ id: `devserver:${s.id}`, severity: 'alert', text: `${s.name} is running a development server in production. Slow, and it can leak code on errors.`, actions: [{ label: 'Ask my AI to fix it', kind: 'ask', prompt: `/unit7 ${s.name} runs a dev server in production (${cfg.startCommand ?? det?.startCommand}). Switch it to a production build and start command, then redeploy.` }] });
    }

    // settings the code reads that nobody set
    if (det?.envKeys.length) {
      const set = new Set(merged(db, orgId, { type: 'service', id: s.id, label: s.name }).map((v) => v.key));
      const missing = det.envKeys.filter((k) => !set.has(k) && !/^(NODE_ENV|PORT|HOST|NEXT_RUNTIME|VERCEL.*)$/.test(k));
      if (missing.length) add(missingSettings(app, orgId, s, missing));
    }

    // no health route: deploys and the load balancer can only check the home page
    if (det && det.builder !== 'static' && det.healthRoute === false) {
      add({ id: `health:${s.id}`, severity: 'info', text: `${s.name} has no health route, so I can only check its home page during deploys.`, actions: [{ label: 'Ask my AI to add one', kind: 'ask', prompt: `/unit7 add a GET /health route to ${s.name} that returns 200 when the app and its database are reachable, then redeploy with Unit7.` }] });
    }

    // production on a temporary sslip.io address only
    if (prod && !get(db, 'SELECT 1 FROM domains WHERE service_id = ? AND auto = 0', s.id)) {
      add({ id: `domain:${s.id}`, severity: 'info', text: `${s.name} lives on a temporary address. Give it your own domain; HTTPS is automatic.`, actions: [{ label: 'Add a domain', kind: 'navigate', href: svcPage(s) }] });
    }

    // --- traffic (Caddy access log, summarised every 30s) ---
    const hosts = all<{ hostname: string }>(db, 'SELECT hostname FROM domains WHERE service_id = ?', s.id).map((d) => d.hostname);
    if (hosts.length) {
      const q = (since: number) => get<{ req: number; err: number; sh: number; su: number }>(db,
        `SELECT coalesce(sum(requests),0) req, coalesce(sum(errors),0) err, coalesce(sum(static_hits),0) sh, coalesce(sum(static_uncached),0) su FROM traffic WHERE hostname IN (${hosts.map(() => '?').join(',')}) AND at > ?`, ...hosts, ago(since))!;
      const t15 = q(15 * 60_000);
      // a burst of server errors, most likely from the latest deploy
      if (t15.err >= 10 && t15.err / Math.max(1, t15.req) >= 0.2) {
        const pct = Math.round((t15.err / t15.req) * 100);
        const afterDeploy = s.finished_at && Date.now() - Date.parse(s.finished_at) < 45 * 60_000;
        const canRollback = !!get(db, `SELECT 1 FROM deployments WHERE service_id = ? AND status = 'stopped' AND container IS NOT NULL`, s.id);
        add({ id: `5xx:${s.id}`, severity: 'alert', text: `${s.name} is failing ${pct}% of requests${afterDeploy ? ' since its last deploy' : ''}. Visitors are seeing errors.`,
          actions: afterDeploy && canRollback ? [{ label: 'Roll back', kind: 'tool', tool: 'deployment.rollback', input: { serviceId: s.id }, success: `${s.name} is back on the previous version` }, { label: 'See logs', kind: 'navigate', href: svcPage(s) }]
            : [{ label: 'See logs', kind: 'navigate', href: svcPage(s) }] });
      }
      // fingerprinted build files served without a long cache
      const t60 = q(60 * 60_000);
      const path = hashedPath(det?.stack);
      if (path && !cfg.cacheStatic && t60.sh >= 200 && t60.su / Math.max(1, t60.req) >= 0.25) {
        add({ id: `cache:${s.id}`, severity: 'info', text: `${s.name} re-sends the same build files on every visit. Browsers could keep them a year.`, actions: [{ label: 'Cache them', kind: 'tool', tool: 'service.cache_static', input: { serviceId: s.id }, success: `${s.name}'s build files are cached` }] });
      }
    }

    // --- load (docker stats per container, every 30s) ---
    if (!s.server_id || !s.container) continue;
    const samples = all<{ cpu: number; containers: string }>(db, 'SELECT cpu, containers FROM metrics WHERE server_id = ? ORDER BY at DESC LIMIT 20', s.server_id);
    if (samples.length < 10) continue;
    const mine = new Set([s.container, ...replicaNames(s.container, cfg.replicas)]);
    const per = samples.map((m) => json<{ name: string; cpu: number; memPct: number }[]>(m.containers, []).filter((c) => mine.has(c.name)));
    const busy = per.filter((cs) => cs.length && cs.every((c) => c.cpu >= 85)).length;
    const memFull = per.filter((cs) => cs.some((c) => c.memPct >= 90)).length;
    const hostCpu = samples.reduce((a, m) => a + (m.cpu ?? 0), 0) / samples.length;
    const server = servers.find((x) => x.id === s.server_id);
    const cpus = json<{ cpus?: number }>(server?.facts ?? '{}', {}).cpus ?? 1;
    const replicas = Math.max(1, cfg.replicas ?? 1);
    if (busy >= Math.ceil(samples.length * 0.9)) {
      if (hostCpu < 60 && cpus > replicas && replicas < MAX_REPLICAS) {
        const risks = det?.scaleRisks ?? [];
        if (risks.length) add({ id: `scale-blocked:${s.id}`, severity: 'warn', text: `${s.name} is maxing out one core while ${server?.name ?? 'the server'} has room. A second copy would help, but first: ${risks.join('; ')}.`, actions: [{ label: 'Ask my AI to prepare it', kind: 'ask', prompt: `/unit7 make ${s.name} safe to run as several copies behind a load balancer: ${risks.join('; ')}. Use Redis or the database for shared state, then redeploy.` }] });
        else add({ id: `scale:${s.id}`, severity: 'warn', text: `${s.name} is maxing out one core while ${server?.name ?? 'the server'} has room. Add a copy and I’ll spread the load between them.`, actions: [{ label: `Run ${replicas + 1} copies`, kind: 'tool', tool: 'service.scale', input: { serviceId: s.id, replicas: replicas + 1 }, success: `${s.name} now runs ${replicas + 1} copies behind the load balancer` }] });
      } else if (hostCpu >= 80) {
        add({ id: `server-max:${s.id}`, severity: 'warn', text: `${server?.name ?? 'The server'} is maxed out (${Math.round(hostCpu)}% CPU) and ${s.name} is feeling it. Time for a bigger plan.`,
          actions: [server?.provider_ref?.startsWith('hostinger:') ? { label: 'See plans', kind: 'navigate', href: 'https://hpanel.hostinger.com/vps' } : { label: 'See the server', kind: 'navigate', href: `/servers/${s.server_id}` }] });
      }
    }
    if (memFull >= Math.ceil(samples.length * 0.8)) {
      add({ id: `mem:${s.id}`, severity: 'warn', text: `${s.name} is at the edge of its memory. It will be killed and restarted if it keeps growing.`, actions: [{ label: 'See it', kind: 'navigate', href: svcPage(s) }, { label: 'Ask my AI why', kind: 'ask', prompt: `/unit7 ${s.name} keeps using over 90% of its memory. Find out why (a leak or just too little memory) and fix it.` }] });
    }
  }

  // a project live in production with nothing on staging: changes go straight to visitors
  if (pid) {
    const envs = all<{ kind: string; live: number }>(db, `SELECT e.kind, count(d.id) live FROM environments e LEFT JOIN services s ON s.environment_id = e.id LEFT JOIN deployments d ON d.id = s.current_deployment_id AND d.status = 'live' WHERE e.project_id = ? GROUP BY e.id`, pid);
    if (envs.some((e) => e.kind === 'production' && e.live) && envs.some((e) => e.kind === 'staging') && !envs.some((e) => e.kind === 'staging' && e.live)) {
      add({ id: `staging:${pid}`, severity: 'info', text: 'Every change goes straight to your visitors. Try it on staging first; it’s one command.', actions: [{ label: 'Copy the command', kind: 'ask', prompt: '/unit7 deploy this folder to staging' }] });
    }
  }
}
