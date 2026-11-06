// Push to deploy, and a preview URL per pull request. Warden runs these once a minute (previews every
// five); each is an ordinary Unit7 tool, so the gate, audit and autonomy settings apply as usual.
import { z } from 'zod';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { cloneUrl, githubToken, headSha, lastAttemptedSha, listRepos, rememberSha, openPulls, parseRepo, setStatus, upsertComment, type Repo, type RepoInfo } from '../connectors/github.ts';
import type { ServiceConfig } from '../deploy/deployer.ts';
import { fid, isAgent } from './helpers.ts';
import { Unit7Error } from '../errors.ts';

interface Svc { id: string; name: string; slug: string; project_id: string; environment_id: string; server_id: string | null; config: string; current_deployment_id: string | null }
const svcOf = (ctx: Ctx, serviceId: string) => get<Svc>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
const urlOf = (ctx: Ctx, serviceId: string) => { const d = get<{ hostname: string; tls_mode: string }>(ctx.db, 'SELECT hostname, tls_mode FROM domains WHERE service_id = ? ORDER BY auto, created_at LIMIT 1', serviceId); return d && `${d.tls_mode === 'off' ? 'http' : 'https'}://${d.hostname}`; };
const gitOf = (cfg: ServiceConfig): { repo: Repo; branch?: string; accountId?: string } | undefined => {
  if (cfg.source?.type !== 'git') return undefined;
  const repo = parseRepo(cfg.source.repo);
  return repo && { repo, branch: cfg.source.branch, accountId: cfg.source.accountId };
};

// The repos every connected GitHub account can reach, to start a project from (New project → From GitHub).
// Names and dates only: tokens stay in the vault.
defineTool({
  name: 'github.repos', title: 'List GitHub repos', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'The repos each connected GitHub account can reach (name, private or public, last push, default branch), newest first. Use one as a git source for service.create. Never returns tokens.',
  input: z.object({}),
  async run(ctx) {
    const accounts = all<{ id: string; name: string; meta: string }>(ctx.db, `SELECT id, name, meta FROM accounts WHERE org_id = ? AND provider = 'github' ORDER BY created_at`, ctx.orgId);
    const repos: (RepoInfo & { accountId: string; account: string })[] = [];
    const problems: { account: string; message: string }[] = [];
    for (const a of accounts) {
      try {
        const token = await githubToken(ctx, a.id);
        if (!token) continue;
        for (const r of await listRepos(token, json<{ auth?: string }>(a.meta, {}).auth === 'github-app')) repos.push({ ...r, accountId: a.id, account: a.name });
      } catch (e) { problems.push({ account: a.name, message: (e as Error).message }); }
    }
    // one repo reachable from two accounts shows once
    const seen = new Set<string>();
    return { connected: accounts.length > 0, repos: repos.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).filter((r) => !seen.has(r.fullName) && seen.add(r.fullName)), problems };
  },
});

defineTool({
  name: 'service.sync_git', title: 'Deploy new commits', risk: 'write', action: 'deploy', timeoutMs: 30 * 60_000, idle: (o: { deployed: boolean; status?: string }) => !o.deployed && !o.status,
  description: 'If the service’s GitHub branch has a commit Unit7 hasn’t deployed, deploy it and mark the commit green or red on GitHub. Warden runs this every minute for services with auto-deploy on.',
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcOf(ctx, i.serviceId);
    const cfg = json<ServiceConfig>(svc?.config ?? '{}', {});
    const git = gitOf(cfg);
    if (!svc || !git) return { deployed: false, note: 'not a GitHub source' };
    if (!svc.current_deployment_id) return { deployed: false, note: 'deploy it once by hand first' };
    // shipping a new commit to production is push-to-deploy's job (Warden, switched on by a person) or a person's
    if (isAgent(ctx) && ctx.actor.id !== 'warden' && ctx.env?.kind === 'production') {
      throw new Unit7Error('needs_person', 'Deploying a new commit to production is for push-to-deploy or a person. Ask for it in the web app.', 403);
    }
    const token = await githubToken(ctx, git.accountId);
    const sha = await headSha(git.repo, git.branch, token);
    if (!sha || sha === lastAttemptedSha(ctx, svc.id)) return { deployed: false, sha };
    rememberSha(ctx, svc.id, sha);
    ctx.emit('deployment.auto', `New commit ${sha.slice(0, 7)} on ${git.repo.owner}/${git.repo.name}: deploying ${svc.name}`, { resource: svc.id });
    await setStatus(git.repo, sha, 'pending', 'Unit7 is deploying', undefined, token);
    const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { serviceId: svc.id }, { reason: `new commit ${sha.slice(0, 7)}` });
    const url = r.status === 'ok' ? (r.output as { url?: string }).url : undefined;
    await setStatus(git.repo, sha, r.status === 'ok' ? 'success' : 'failure', r.status === 'ok' ? 'Live' : r.status === 'approval_required' ? 'Waiting for approval in Unit7' : 'Deploy failed', url, token);
    return { deployed: r.status === 'ok', sha, status: r.status, url };
  },
});

// Previews live in their own environment at full autopilot, so they never mix with your staging.
function previewEnv(ctx: Ctx, projectId: string): string {
  const e = get<{ id: string }>(ctx.db, `SELECT id FROM environments WHERE project_id = ? AND slug = 'previews'`, projectId);
  if (e) return e.id;
  const envId = id('env');
  run(ctx.db, `INSERT INTO environments (id, org_id, project_id, name, slug, kind, autonomy) VALUES (?, ?, ?, 'Previews', 'previews', 'custom', ?)`, envId, ctx.orgId, projectId, isAgent(ctx) ? 2 : 4);
  return envId;
}

const MAX_PREVIEWS = 2; // per app: a small VPS shouldn't drown in preview containers

defineTool({
  name: 'service.sync_previews', title: 'Keep pull-request previews up to date', risk: 'write', action: 'deploy', timeoutMs: 45 * 60_000,
  description: `Give each open pull request (from the same repo, never a fork) its own preview URL, posted as a comment on the PR and updated on every push; remove it when the PR closes. At most ${MAX_PREVIEWS} per app.`,
  input: z.object({ serviceId: fid('svc') }),
  async run(ctx, i) {
    const svc = svcOf(ctx, i.serviceId);
    const cfg = json<ServiceConfig>(svc?.config ?? '{}', {});
    const git = gitOf(cfg);
    if (!svc || !git || !svc.current_deployment_id) return { previews: [] };
    const token = await githubToken(ctx, git.accountId);
    // a fork's code is someone else's code: never run it on your server
    const prs = (await openPulls(git.repo, token)).filter((p) => p.sameRepo).sort((a, b) => b.number - a.number).slice(0, MAX_PREVIEWS);
    const existing = all<Svc>(ctx.db, `SELECT * FROM services WHERE org_id = ? AND json_extract(config, '$.previewOf') = ?`, ctx.orgId, svc.id);
    const out: { pr: number; url?: string; status: string }[] = [];

    // previews whose PR closed (or fell out of the newest few) go away
    for (const p of existing.filter((x) => !prs.some((pr) => pr.number === json<{ pr?: number }>(x.config, {}).pr))) {
      await execute(ctx.app, ctx.orgId, ctx.actor, 'service.remove', { serviceId: p.id }, { reason: 'pull request closed' });
      out.push({ pr: json<{ pr?: number }>(p.config, {}).pr ?? 0, status: 'removed' });
    }
    for (const pr of prs) {
      let prev = existing.find((x) => json<{ pr?: number }>(x.config, {}).pr === pr.number);
      if (!prev) {
        const envId = previewEnv(ctx, svc.project_id);
        const pcfg: ServiceConfig & { previewOf: string; pr: number } = { ...cfg, source: { type: 'git', repo: cloneUrl(git.repo), branch: pr.branch, accountId: git.accountId }, previewOf: svc.id, pr: pr.number, replicas: 1, cacheStatic: undefined };
        const pid = id('svc');
        run(ctx.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) VALUES (?, ?, ?, ?, ?, ?, ?, 'app', ?)`,
          pid, ctx.orgId, svc.project_id, envId, svc.server_id, `${svc.name} PR #${pr.number}`, `${svc.slug}-pr-${pr.number}`.slice(0, 48), JSON.stringify(pcfg));
        prev = svcOf(ctx, pid)!;
      }
      if (pr.sha === lastAttemptedSha(ctx, prev.id)) { out.push({ pr: pr.number, url: urlOf(ctx, prev.id), status: 'current' }); continue; }
      rememberSha(ctx, prev.id, pr.sha);
      await setStatus(git.repo, pr.sha, 'pending', 'Unit7 is building a preview', undefined, token, 'Unit7 preview');
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'deployment.create', { serviceId: prev.id }, { reason: `preview for PR #${pr.number}` });
      const url = r.status === 'ok' ? (r.output as { url?: string }).url : undefined;
      await setStatus(git.repo, pr.sha, r.status === 'ok' ? 'success' : 'failure', r.status === 'ok' ? 'Preview is live' : 'Preview failed to deploy', url, token, 'Unit7 preview');
      await upsertComment(git.repo, pr.number, r.status === 'ok'
        ? `**Preview is live:** ${url}\n\nCommit \`${pr.sha.slice(0, 7)}\` · updates on every push · removed when this PR closes. — Unit7`
        : `**Preview didn't deploy** for commit \`${pr.sha.slice(0, 7)}\`. Details are in Unit7. — Unit7`, token);
      out.push({ pr: pr.number, url, status: r.status });
    }
    return { previews: out };
  },
});
