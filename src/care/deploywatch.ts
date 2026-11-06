// Coolify tells nobody when it deploys, so Unit7 looks: every few minutes, each app's last deploy. A new one becomes a record
// and an event that other things hang on: a fresh copy of what's important, a check-up afterwards, and the fix check. A deploy
// that's over in between two looks is still seen; the copy then comes just after it instead of just before, which is why the
// daily copy still matters.
import { z } from 'zod';
import { all, get, now, run, type DB } from '../db.ts';
import { defineTool, type Ctx } from '../tools/runtime.ts';
import { coolifyFor, lastXray } from '../tools/xray.ts';
import { lastDeployOf } from '../connectors/coolify.ts';
import { pool } from '../discovery/scanners.ts';
import type { ServerRow } from '../connectors/ssh.ts';

export interface Deploy { serverId: string; uuid: string; name: string; deployment: string; status: string; commit?: string; at: string; project?: string; fresh?: boolean }
const list = (b: unknown, k: string) => (Array.isArray(b) ? b : (b as Record<string, unknown>)?.[k] as unknown[] ?? []);
const COPY_GAP = 6 * 3600_000;

// (pure) what to do with one app's latest deploy, given what was stored. The first time an app is seen nothing happened.
export function deployChange(seen: { deployment: string; status: string } | undefined, d: { deployment: string; status: string }): 'first' | 'started' | 'finished' | 'same' {
  if (!seen) return 'first';
  if (seen.deployment !== d.deployment) return 'started';
  return seen.status === d.status ? 'same' : 'finished';
}

export async function syncDeploys(ctx: Ctx): Promise<{ seen: Deploy[] }> {
  const out: Deploy[] = [];
  await pool(all<ServerRow>(ctx.db, `SELECT * FROM servers WHERE org_id = ? AND status NOT IN ('new', 'bootstrapping')`, ctx.orgId), 3, async (s) => {
    const c = coolifyFor(ctx, s);
    if (!c) return;
    const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
    const apps = (inv?.parts ?? []).filter((p) => p.coolify?.type === 'application' && p.coolify.uuid);
    await pool(apps, 4, async (p) => {
      const last = lastDeployOf(list(await c.api.call('GET', `/deployments/applications/${encodeURIComponent(p.coolify!.uuid)}?skip=0&take=1`).catch(() => undefined), 'deployments')[0]);
      if (!last?.uuid) return;
      const seen = get<{ deployment: string; status: string }>(ctx.db, 'SELECT deployment, status FROM deploys_seen WHERE server_id = ? AND uuid = ? ORDER BY at DESC LIMIT 1', s.id, p.coolify!.uuid);
      const status = last.status ?? 'unknown', change = deployChange(seen, { deployment: last.uuid, status });
      if (change === 'same') return;
      const at = last.at ?? now();
      run(ctx.db, `INSERT INTO deploys_seen (org_id, server_id, uuid, name, deployment, status, commit_sha, project, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id, uuid, deployment) DO UPDATE SET status = excluded.status`, ctx.orgId, s.id, p.coolify!.uuid, p.name, last.uuid, status, last.commit ?? null, p.project ?? null, at);
      if (change === 'first') return;
      const d: Deploy = { serverId: s.id, uuid: p.coolify!.uuid, name: p.name, deployment: last.uuid, status, at, ...(last.commit && { commit: last.commit }), ...(p.project && { project: p.project }), fresh: change === 'started' };
      out.push(d);
      ctx.emit(change === 'started' ? 'deploy.seen' : 'deploy.finished', change === 'started' ? `Coolify is deploying ${p.name}` : `Coolify finished deploying ${p.name}: ${status}`, { resource: s.id, data: { ...d } });
    });
  });
  run(ctx.db, 'DELETE FROM deploys_seen WHERE org_id = ? AND at < ?', ctx.orgId, new Date(Date.now() - 90 * 86400_000).toISOString());
  return { seen: out };
}

defineTool({
  name: 'deploys.sync', title: 'See what Coolify deployed', risk: 'read', action: 'read', timeoutMs: 60_000, idle: (o: { seen: Deploy[] }) => !o.seen.length,
  description: 'Read each Coolify app’s latest deploy and note any new one. Warden does this every 5 minutes.',
  input: z.object({}),
  run: (ctx) => syncDeploys(ctx),
});

// a fresh copy when a deploy is seen, at most once per project in 6 hours (busy repos deploy all day)
export function copyWorthTaking(db: DB, orgId: string, d: Deploy, nowMs = Date.now()) {
  return !get(db, `SELECT 1 FROM events WHERE org_id = ? AND type = 'safety.deploy_copy' AND resource = ? AND created_at > ?`, orgId, d.project ?? d.uuid, new Date(nowMs - COPY_GAP).toISOString());
}
export const lastDeploys = (db: DB, orgId: string, n = 20) => all<{ server_id: string; uuid: string; name: string; deployment: string; status: string; commit_sha: string | null; at: string }>(db, 'SELECT server_id, uuid, name, deployment, status, commit_sha, at FROM deploys_seen WHERE org_id = ? ORDER BY at DESC LIMIT ?', orgId, n);
