// Vulnerable packages fixed by pull request. When the image scan finds fixable vulnerabilities in an app
// deployed from GitHub, Unit7 clones the repo in a throwaway container on the app's server, runs the package
// manager's own audit fix, pushes a branch and opens a PR listing what it fixes. The PR gets its preview like
// any other; with "merge when healthy" on, Unit7 merges it once the preview is green, and push-to-deploy ships it.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { get, json, now, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { defaultBranch, githubAuthEnv, githubToken, mergePull, openPull, parseRepo, pullCheck } from '../connectors/github.ts';
import { writeEnvFile, APPS, type ServiceConfig } from '../deploy/deployer.ts';
import type { ImageReport } from '../deploy/security.ts';
import { serverRow } from './servers.ts';
import { fid, isAgent } from './helpers.ts';
import { forbidden } from '../errors.ts';

type FixCfg = ServiceConfig & { fixPr?: { number: number; url: string; branch: string; at: string }; fixTriedAt?: string; autoFixPrs?: boolean; autoMergeFixes?: boolean };
const app = (ctx: Ctx, serviceId: string) => {
  const s = get<{ id: string; name: string; server_id: string | null; config: string; current_deployment_id: string | null }>(ctx.db, 'SELECT id, name, server_id, config, current_deployment_id FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  if (!s) throw new Unit7Error('not_found', 'That app was not found.', 404);
  return { ...s, cfg: json<FixCfg>(s.config, {}) };
};
const save = (ctx: Ctx, id: string, patch: Partial<FixCfg>) => run(ctx.db, 'UPDATE services SET config = json_patch(config, ?) WHERE id = ?', JSON.stringify(patch), id);

// npm and pnpm do the fixing themselves (only what stays within the allowed version ranges); nothing else is touched
const FIX = `set -e
apk add --no-cache git >/dev/null
git clone -q --depth 1 -b "$BASE" "https://github.com/$REPO.git" /w 2>/dev/null
cd /w && git checkout -q -b "$BRANCH"
if [ -f pnpm-lock.yaml ]; then corepack enable >/dev/null 2>&1; pnpm audit --fix >/dev/null 2>&1 || true; pnpm install --lockfile-only >/dev/null 2>&1 || true
elif [ -f package-lock.json ] || [ -f package.json ]; then npm audit fix --package-lock-only >/dev/null 2>&1 || true
else echo UNSUPPORTED; exit 0; fi
if git diff --quiet; then echo NOCHANGE; exit 0; fi
git -c user.name=Unit7 -c user.email=unit7@users.noreply.github.com commit -qam "Fix vulnerable dependencies"
git push -q origin "$BRANCH" 2>&1 || exit 1
echo PUSHED; git diff --shortstat HEAD~1`;

export async function openFixPr(ctx: Ctx, serviceId: string) {
  const a = app(ctx, serviceId);
  const src = a.cfg.source;
  const repo = src?.type === 'git' ? parseRepo(src.repo) : undefined;
  if (!repo) throw new Unit7Error('unsupported', `${a.name} isn’t deployed from GitHub, so there’s no repo to send a fix to.`, 400);
  if (!a.server_id) throw new Unit7Error('no_server', `${a.name} isn’t on a server.`, 409);
  const token = await githubToken(ctx, src!.type === 'git' ? src!.accountId : undefined);
  if (!token) throw new Unit7Error('no_account', 'Connect GitHub (with write access to this repo) so Unit7 can open the fix PR.', 409);
  if (a.cfg.fixPr && (await pullCheck(repo, a.cfg.fixPr.number, token).then((p) => p.open, () => false))) return { already: a.cfg.fixPr.url };
  const report = json<{ security?: ImageReport }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', a.current_deployment_id ?? '')?.plan ?? '{}', {}).security;
  const base = (src!.type === 'git' && src!.branch) || await defaultBranch(repo, token);
  const branch = `unit7/fix-vulnerabilities-${now().slice(0, 10)}`;
  const s = serverRow(ctx, a.server_id);
  const envFile = `${APPS}/fix-${a.id.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}.env`;
  ctx.redactor.add(token, 'GitHub token');
  save(ctx, a.id, { fixTriedAt: now() });
  await writeEnvFile(ctx, s, envFile, { ...githubAuthEnv(token, 'https://github.com'), REPO: `${repo.owner}/${repo.name}`, BASE: base, BRANCH: branch });
  ctx.progress(`Fixing ${a.name}'s vulnerable packages in a throwaway copy of the repo…`);
  const r = await ssh(ctx.app).exec(s, script('docker run --rm --env-file "$1" node:22-alpine sh -c "$2" 2>&1; rc=$?; rm -f "$1"; exit $rc', envFile, FIX), { timeoutMs: 15 * 60_000, signal: ctx.signal });
  const out = ctx.redactor.redact(r.stdout);
  if (/UNSUPPORTED/.test(out)) return { nothingToDo: 'Unit7 fixes npm and pnpm projects; this one uses something else.' };
  if (/NOCHANGE/.test(out)) return { nothingToDo: 'The package manager found nothing it could fix within the allowed versions. What remains needs a major upgrade: ask your AI to do it.' };
  if (r.code !== 0 || !/PUSHED/.test(out)) throw new Unit7Error('fix_failed', `Unit7 couldn’t push the fix: ${out.trim().slice(-300)}`, 502);
  const rows = (report?.top ?? []).map((v) => `| ${v.pkg} | ${v.installed} → ${v.fixed} | ${v.id} | ${v.severity.toLowerCase()} |`).join('\n');
  const pr = await openPull(repo, { title: 'Fix vulnerable dependencies', head: branch, base, body:
    `Unit7's scan of the running image found ${report ? `${report.critical} critical and ${report.high} high` : 'fixable'} vulnerabilities. This updates the affected packages within their allowed version ranges (\`${/pnpm/.test(out) ? 'pnpm audit --fix' : 'npm audit fix'}\`).\n\n${rows ? `| Package | Version | Advisory | Severity |\n|---|---|---|---|\n${rows}\n\n` : ''}A preview deploys for this PR.${a.cfg.autoMergeFixes ? ' Unit7 merges it once the preview is healthy.' : ''}` }, token);
  save(ctx, a.id, { fixPr: { number: pr.number, url: pr.html_url, branch, at: now() } });
  ctx.emit('security.fix_pr', `${a.name}: opened a PR fixing vulnerable packages (${pr.html_url})`, { severity: 'success', resource: a.id });
  return { pr: pr.html_url, branch, changed: out.split('\n').find((l) => /changed/.test(l))?.trim() };
}

// merge it once the preview (or the repo's own checks) are green
export async function mergeFixPr(ctx: Ctx, serviceId: string) {
  const a = app(ctx, serviceId);
  const src = a.cfg.source, repo = src?.type === 'git' ? parseRepo(src.repo) : undefined;
  if (!repo || !a.cfg.fixPr) return { nothing: 'No fix PR is open.' };
  const token = await githubToken(ctx, src!.type === 'git' ? src!.accountId : undefined);
  if (!token) throw new Unit7Error('no_account', 'Connect GitHub so Unit7 can merge the fix.', 409);
  const p = await pullCheck(repo, a.cfg.fixPr.number, token);
  if (!p.open) { save(ctx, a.id, { fixPr: undefined }); return { closed: true, merged: p.merged }; }
  if (p.status !== 'success') return { waiting: `checks are ${p.status}` };
  await mergePull(repo, a.cfg.fixPr.number, token);
  ctx.emit('security.fix_merged', `${a.name}: merged the vulnerability fix (${a.cfg.fixPr.url}); it deploys like any push`, { severity: 'success', resource: a.id });
  const url = a.cfg.fixPr.url;
  run(ctx.db, `UPDATE services SET config = json_remove(config, '$.fixPr') WHERE id = ?`, a.id);
  return { merged: url };
}

defineTool({
  name: 'security.fix_pr', title: 'Open a PR fixing vulnerable packages', risk: 'write', action: 'deploy', timeoutMs: 20 * 60_000,
  description: 'Fix an app’s vulnerable packages (npm or pnpm, within allowed version ranges) in a throwaway copy of its GitHub repo, and open a pull request listing what it fixes. A preview deploys for it. Warden does this by itself when a scan finds fixable vulnerabilities.',
  input: z.object({ serviceId: fid('svc') }),
  run: (ctx, i) => openFixPr(ctx, i.serviceId),
});

defineTool({
  name: 'security.merge_fix', title: 'Merge a vulnerability fix', risk: 'write', action: 'deploy', timeoutMs: 60_000,
  description: 'Merge the open vulnerability-fix PR once its checks (Unit7’s preview included) are green; push-to-deploy then ships it. Warden does this by itself when "merge when healthy" is on.',
  input: z.object({ serviceId: fid('svc') }),
  run(ctx, i) {
    if (isAgent(ctx) && !app(ctx, i.serviceId).cfg.autoMergeFixes) throw forbidden('Merging fixes by itself is off for this app. A person can merge it, or turn on "merge when healthy".');
    return mergeFixPr(ctx, i.serviceId);
  },
});

defineTool({
  name: 'security.fix_settings', title: 'Vulnerability fix settings', risk: 'write', action: 'service_write', peopleOnly: (i) => i.autoMerge !== undefined,
  description: 'For an app deployed from GitHub: open fix PRs by itself when vulnerabilities are found (on by default), and merge them once the preview is healthy (off by default).',
  input: z.object({ serviceId: fid('svc'), openPrs: z.boolean().optional(), autoMerge: z.boolean().optional() }),
  run(ctx, i) {
    const a = app(ctx, i.serviceId);
    save(ctx, a.id, { ...(i.openPrs !== undefined && { autoFixPrs: i.openPrs }), ...(i.autoMerge !== undefined && { autoMergeFixes: i.autoMerge }) });
    const c = app(ctx, i.serviceId).cfg;
    return { app: a.name, openPrs: c.autoFixPrs !== false, autoMerge: !!c.autoMergeFixes };
  },
});
