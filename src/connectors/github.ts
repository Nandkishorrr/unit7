// GitHub, from Unit7's side: what's the latest commit on a branch, which pull requests are open,
// mark a commit green/red, and leave one comment with a preview link. Unit7 runs on your Mac, so
// GitHub can't call it; Unit7 asks instead (once a minute).
//
// New commits are found with `git ls-remote` (works for public and private repos, no API rate
// limit). The API is used only for pull requests, commit statuses and the preview comment.
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Ctx } from '../tools/runtime.ts';
import { get, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { dnsHost } from './dnsinfo.ts';
import { assertReachable } from '../netguard.ts';
import { githubAppToken } from './oneclick.ts';
import { sysBin } from './shell.ts';

export interface Repo { owner: string; name: string }

// github.com/owner/name(.git), git@github.com:owner/name.git, or owner/name
export function parseRepo(url: string): Repo | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}
// overridable so the whole flow can be tested offline (a local bare repo, a fake API)
const GH = () => process.env.UNIT7_GITHUB_URL ?? 'https://github.com';
export const githubBase = GH;
// How git sends a token without it ever being part of a URL or a command line (pass it via GIT_CONFIG_* env).
export const githubAuthHeader = (token: string) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
// git's own environment for that header (for a throwaway container's --env-file, or execFile's env)
export const githubAuthEnv = (token: string, base = GH()) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${base}/.extraheader`, GIT_CONFIG_VALUE_0: githubAuthHeader(token) });
const API = () => process.env.UNIT7_GITHUB_API ?? 'https://api.github.com';
export const cloneUrl = (r: Repo) => `${GH()}/${r.owner}/${r.name}.git`;

// A token for the GitHub account a service uses (or the org's only one). Undefined = public access.
export async function githubToken(ctx: Ctx, accountId?: string): Promise<string | undefined> {
  try {
    const { value, account } = ctx.credentialFor('github', accountId);
    return json<{ auth?: string }>(account.meta, {}).auth === 'github-app' ? await githubAppToken(ctx.app, ctx.orgId, account, value) : value;
  } catch (e) {
    if ((e as Unit7Error).code === 'no_account') return undefined;
    throw e;
  }
}

// The commit a branch points at, without cloning. Throws if the repo or branch can't be read.
export function headSha(repo: Repo, branch: string | undefined, token?: string): Promise<string | undefined> {
  const url = cloneUrl(repo);
  const auth = token && GH().startsWith('https://') ? githubAuthEnv(token) : {};
  return new Promise((resolve, reject) => {
    execFile(sysBin('git'), ['ls-remote', url, branch ? `refs/heads/${branch}` : 'HEAD'], { timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...auth } }, (e, out) => {
      if (e) return reject(new Unit7Error('git_unreachable', `Couldn't read ${repo.owner}/${repo.name}: ${(e.message || '').replace(token ?? '\u0000', '***').slice(0, 200)}`, 502));
      resolve(out.trim().split(/\s+/)[0] || undefined);
    });
  });
}

export async function githubApi<T>(token: string | undefined, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`${API()}${path}`, {
    method: init.method ?? 'GET',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Unit7', 'x-github-api-version': '2022-11-28', ...(token && { authorization: `Bearer ${token}` }), ...(init.body !== undefined && { 'content-type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) {
    const why = (await r.json().catch(() => ({})) as { message?: string }).message;
    throw new Unit7Error('github_api', `GitHub said ${r.status} for ${path}${why ? `: ${why}` : ''}`, 502, { status: r.status, why });
  }
  return r.status === 204 ? (undefined as T) : r.json() as Promise<T>;
}
const api = githubApi;

// Files that mention a term, for "where to look". Code search needs a token, and it indexes the default branch.
export const searchCode = (repo: Repo, term: string, token: string) => api<{ items?: { path: string }[] }>(token, `/search/code?q=${encodeURIComponent(`${term} repo:${repo.owner}/${repo.name}`)}&per_page=5`).then((r) => (r.items ?? []).map((x) => x.path));
export const repoIsPrivate = (repo: Repo, token: string) => api<{ private: boolean }>(token, `/repos/${repo.owner}/${repo.name}`).then((r) => r.private === true);
export const repoAccess = (repo: Repo, token: string) => api<{ private: boolean; default_branch?: string; permissions?: { admin?: boolean } }>(token, `/repos/${repo.owner}/${repo.name}`);
// a read-only key on one repo, for a server that clones it
export const addDeployKey = (repo: Repo, o: { title: string; key: string }, token: string) => api<{ id: number }>(token, `/repos/${repo.owner}/${repo.name}/keys`, { method: 'POST', body: { ...o, read_only: true } });
export const removeDeployKey = (repo: Repo, id: number, token: string) => api(token, `/repos/${repo.owner}/${repo.name}/keys/${id}`, { method: 'DELETE' });
export const repoHooks = (repo: Repo, token: string) => api<{ id: number; config?: { url?: string } }[]>(token, `/repos/${repo.owner}/${repo.name}/hooks?per_page=100`);
export const addHook = (repo: Repo, o: { url: string; secret: string }, token: string) => api<{ id: number }>(token, `/repos/${repo.owner}/${repo.name}/hooks`, { method: 'POST', body: { name: 'web', active: true, events: ['push', 'pull_request'], config: { url: o.url, content_type: 'json', secret: o.secret } } });
export const createIssue = (repo: Repo, o: { title: string; body: string }, token: string) => api<{ number: number; html_url: string }>(token, `/repos/${repo.owner}/${repo.name}/issues`, { method: 'POST', body: o });

// A file's text (e.g. package.json), or undefined when it isn't there or can't be read
export const fileText = (repo: Repo, path: string, token?: string) =>
  api<{ content?: string }>(token, `/repos/${repo.owner}/${repo.name}/contents/${path}`).then((r) => (r.content ? Buffer.from(r.content, 'base64').toString('utf8') : undefined), () => undefined);

export const defaultBranch = (repo: Repo, token?: string) => api<{ default_branch: string }>(token, `/repos/${repo.owner}/${repo.name}`).then((r) => r.default_branch);
export const openPull = (repo: Repo, o: { title: string; head: string; base: string; body: string }, token: string) =>
  api<{ number: number; html_url: string }>(token, `/repos/${repo.owner}/${repo.name}/pulls`, { method: 'POST', body: o });
// a PR's state, its head commit and the combined status of that commit (Unit7's preview reports there)
export async function pullCheck(repo: Repo, n: number, token?: string) {
  const pr = await api<{ state: 'open' | 'closed'; merged: boolean; head: { sha: string } }>(token, `/repos/${repo.owner}/${repo.name}/pulls/${n}`);
  const status = await api<{ state: 'success' | 'pending' | 'failure' | 'error' }>(token, `/repos/${repo.owner}/${repo.name}/commits/${pr.head.sha}/status`).then((r) => r.state, () => 'pending' as const);
  return { open: pr.state === 'open', merged: pr.merged, status };
}
export const mergePull = (repo: Repo, n: number, token: string) => api(token, `/repos/${repo.owner}/${repo.name}/pulls/${n}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });

export interface PullRequest { number: number; title: string; sha: string; branch: string; sameRepo: boolean; url: string }
export async function openPulls(repo: Repo, token?: string): Promise<PullRequest[]> {
  const rows = await api<any[]>(token, `/repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=30`);
  return rows.map((p) => ({ number: p.number, title: p.title, sha: p.head.sha, branch: p.head.ref, sameRepo: p.head.repo?.full_name === `${repo.owner}/${repo.name}`, url: p.html_url }));
}
export async function pullState(repo: Repo, n: number, token?: string): Promise<'open' | 'closed'> {
  return (await api<{ state: 'open' | 'closed' }>(token, `/repos/${repo.owner}/${repo.name}/pulls/${n}`)).state;
}

// The repos a token can reach, most recently pushed first. A GitHub App's install token sees the repos the
// app was installed on; a personal or CLI token sees the person's own and their organizations'.
export interface RepoInfo { fullName: string; private: boolean; updatedAt: string; defaultBranch: string; description: string | null }
export async function listRepos(token: string, githubApp: boolean): Promise<RepoInfo[]> {
  const out: RepoInfo[] = [];
  for (let page = 1; page <= 3; page++) { // ponytail: the newest 300; a server-side search if people have more
    const rows = githubApp
      ? (await api<{ repositories: any[] }>(token, `/installation/repositories?per_page=100&page=${page}`)).repositories
      : await api<any[]>(token, `/user/repos?per_page=100&sort=pushed&page=${page}`);
    out.push(...rows.map((r) => ({ fullName: String(r.full_name), private: !!r.private, updatedAt: String(r.pushed_at ?? r.updated_at), defaultBranch: String(r.default_branch ?? 'main'), description: r.description ? String(r.description).slice(0, 200) : null })));
    if (rows.length < 100) break;
  }
  return out;
}

// Green or red on the commit in GitHub, linking to the live URL. Best effort: needs write access.
export async function setStatus(repo: Repo, sha: string, state: 'pending' | 'success' | 'failure', description: string, targetUrl: string | undefined, token: string | undefined, context = 'Unit7') {
  if (!token) return;
  await api(token, `/repos/${repo.owner}/${repo.name}/statuses/${sha}`, { method: 'POST', body: { state, description: description.slice(0, 140), context, ...(targetUrl && { target_url: targetUrl }) } }).catch(() => undefined);
}

// One comment per PR, edited in place on every new deploy (found by a hidden marker).
const MARK = '<!-- unit7-preview -->';
export async function upsertComment(repo: Repo, n: number, body: string, token: string | undefined) {
  if (!token) return;
  const text = `${MARK}\n${body}`;
  const mine = (await api<any[]>(token, `/repos/${repo.owner}/${repo.name}/issues/${n}/comments?per_page=100`).catch(() => [])).find((c) => String(c.body).startsWith(MARK));
  if (mine) await api(token, `/repos/${repo.owner}/${repo.name}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: text } }).catch(() => undefined);
  else await api(token, `/repos/${repo.owner}/${repo.name}/issues/${n}/comments`, { method: 'POST', body: { body: text } }).catch(() => undefined);
}

// The commit Unit7 last tried for a service: remembered before deploying, so a commit that fails
// (even at clone time) is tried once, not every minute. Falls back to the last deploy's commit.
export const lastAttemptedSha = (ctx: Ctx, serviceId: string) =>
  json<{ lastSha?: string }>(get<{ config: string }>(ctx.db, 'SELECT config FROM services WHERE id = ?', serviceId)?.config ?? '{}', {}).lastSha
  ?? json<{ commit?: string }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1', serviceId)?.plan ?? '{}', {}).commit;
export const rememberSha = (ctx: Ctx, serviceId: string, sha: string) =>
  run(ctx.db, `UPDATE services SET config = json_set(config, '$.lastSha', ?) WHERE id = ?`, sha, serviceId);

// A few small files as one commit on a NEW branch, through the API (no clone): the base branch is only read, never
// written. Used for pull requests that change a line or two (the toolchain pins, src/tools/pins.ts).
export async function commitFiles(repo: Repo, o: { base: string; branch: string; message: string; files: { path: string; content: string }[] }, token: string): Promise<string> {
  const r = `/repos/${repo.owner}/${repo.name}`;
  const head = await api<{ object: { sha: string } }>(token, `${r}/git/ref/heads/${encodeURIComponent(o.base)}`);
  const parent = await api<{ tree: { sha: string } }>(token, `${r}/git/commits/${head.object.sha}`);
  const tree = await api<{ sha: string }>(token, `${r}/git/trees`, { method: 'POST', body: { base_tree: parent.tree.sha, tree: o.files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) } });
  const commit = await api<{ sha: string }>(token, `${r}/git/commits`, { method: 'POST', body: { message: o.message, tree: tree.sha, parents: [head.object.sha] } });
  await api(token, `${r}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${o.branch}`, sha: commit.sha } });
  return commit.sha;
}

// A repo for a person's site: new and private unless they say otherwise. A name the account already has is an answer, not a failure.
export async function createRepo(token: string, name: string, o: { private: boolean; org?: string; description?: string }): Promise<Repo> {
  const r = await api<{ owner: { login: string }; name: string }>(token, o.org ? `/orgs/${encodeURIComponent(o.org)}/repos` : '/user/repos', { method: 'POST', body: { name, private: o.private, ...(o.description && { description: o.description }) } })
    .catch((e: Unit7Error) => { throw /422/.test(e.message) ? new Unit7Error('already_exists', `You already have a repo called ${name}. Choose another name, or say you want to update it.`, 409) : e; });
  return { owner: r.owner.login, name: r.name };
}
// GitHub Pages on a domain: GitHub is told the name, then DNS points at the owner's github.io
// ponytail: one of GitHub's four addresses for a bare domain; DNS writers replace a name's record, so add the others when they can keep several
export async function pagesDomain(repo: Repo, domain: string, token: string | undefined): Promise<{ type: 'A' | 'CNAME'; name: string; content: string }[]> {
  await api(token, `/repos/${repo.owner}/${repo.name}/pages`, { method: 'PUT', body: { cname: domain } });
  return [(await dnsHost(domain)).zone === domain ? { type: 'A', name: domain, content: '185.199.108.153' } : { type: 'CNAME', name: domain, content: `${repo.owner.toLowerCase()}.github.io` }];
}
export async function repoExists(token: string, name: string): Promise<Repo | undefined> {
  const me = await api<{ login: string }>(token, '/user');
  return api<{ owner: { login: string }; name: string }>(token, `/repos/${encodeURIComponent(me.login)}/${encodeURIComponent(name)}`).then((r) => ({ owner: r.owner.login, name: r.name }), () => undefined);
}
// These files as one commit, from a throwaway folder so a person's own .git is never touched. Never a force push: on an
// existing repo it's a normal commit on top, so every earlier version stays and can be gone back to.
export async function pushFolder(files: { path: string; abs: string }[], repo: Repo, token: string | undefined, o: { branch: string; message: string; existing: boolean }): Promise<string> {
  const exec = promisify(execFile), tmp = mkdtempSync(join(tmpdir(), 'unit7-push-'));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(token && GH().startsWith('https://') ? githubAuthEnv(token) : {}) };
  const git = (...args: string[]) => exec(sysBin('git'), ['-c', 'user.name=Unit7', '-c', 'user.email=unit7@users.noreply.github.com', ...args], { cwd: tmp, env, timeout: 300_000, maxBuffer: 1 << 24 })
    .catch((e: Error) => { throw new Unit7Error('git_failed', `git ${args[0]} failed for ${repo.owner}/${repo.name}: ${e.message.replaceAll(token ?? '\u0000', '***').slice(-240)}`, 502); });
  try {
    if (o.existing) {
      await git('clone', '--depth', '1', '--branch', o.branch, '--', cloneUrl(repo), '.');
      for (const name of readdirSync(tmp)) if (name !== '.git') rmSync(join(tmp, name), { recursive: true, force: true });
    } else {
      await git('init', '-q', '-b', o.branch);
      await git('remote', 'add', 'origin', cloneUrl(repo));
    }
    for (const f of files) { mkdirSync(dirname(join(tmp, f.path)), { recursive: true }); cpSync(f.abs, join(tmp, f.path)); }
    await git('add', '-A');
    const changed = (await git('status', '--porcelain')).stdout.trim();
    if (changed) await git('commit', '-q', '-m', o.message);
    if (changed || !o.existing) await git('push', '-q', 'origin', `HEAD:refs/heads/${o.branch}`);
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// --- Actions: what ran, why it failed, and running it again --------------------------------------------------------------
export interface WorkflowRun { id: number; name: string; title: string; status: string; conclusion: string | null; branch: string; commit: string; event: string; url: string; at: string }
const runOf = (r: any): WorkflowRun => ({ id: r.id, name: String(r.name ?? r.path ?? 'Workflow'), title: String(r.display_title ?? ''), status: r.status, conclusion: r.conclusion ?? null, branch: String(r.head_branch ?? ''), commit: String(r.head_sha ?? '').slice(0, 7), event: String(r.event ?? ''), url: r.html_url, at: r.updated_at ?? r.created_at });
const actionsPath = (repo: Repo) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/actions`;
export const workflowRuns = (repo: Repo, token: string, o: { branch?: string; status?: string; limit?: number } = {}) => {
  const q = new URLSearchParams({ per_page: String(o.limit ?? 15), ...(o.branch && { branch: o.branch }), ...(o.status && { status: o.status }) });
  return api<{ workflow_runs: any[] }>(token, `${actionsPath(repo)}/runs?${q}`).then((r) => r.workflow_runs.map(runOf));
};
export const workflowRun = (repo: Repo, id: number, token: string) => api<any>(token, `${actionsPath(repo)}/runs/${id}`).then(runOf);
export interface WorkflowJob { id: number; name: string; status: string; conclusion: string | null; url: string; failedStep?: string }
export const runJobs = (repo: Repo, runId: number, token: string) => api<{ jobs: any[] }>(token, `${actionsPath(repo)}/runs/${runId}/jobs?filter=latest&per_page=100`).then((r) => r.jobs.map((j): WorkflowJob => ({
  id: j.id, name: String(j.name), status: j.status, conclusion: j.conclusion ?? null, url: j.html_url, failedStep: (j.steps as { name: string; conclusion: string | null }[] | undefined)?.find((s) => s.conclusion === 'failure')?.name })));
// A job's log is a redirect to a short-lived address on another host: checked first, and the token stays behind
export async function jobLog(repo: Repo, jobId: number, token: string): Promise<string> {
  const path = `${actionsPath(repo)}/jobs/${jobId}/logs`;
  const r = await fetch(`${API()}${path}`, { redirect: 'manual', headers: { accept: 'application/vnd.github+json', 'user-agent': 'Unit7', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const where = r.status >= 300 && r.status < 400 ? r.headers.get('location') : undefined;
  if (!where && !r.ok) throw new Unit7Error('github_api', `GitHub said ${r.status} for ${path}`, 502, { status: r.status });
  if (!where) return r.text();
  await assertReachable(new URL(where).hostname);
  const log = await fetch(where, { signal: AbortSignal.timeout(30_000) });
  if (!log.ok) throw new Unit7Error('github_log', 'GitHub no longer has this log, or it’s still being written. Try again in a minute.', 502);
  return log.text();
}
export const rerunWorkflow = (repo: Repo, runId: number, failedOnly: boolean, token: string) => api(token, `${actionsPath(repo)}/runs/${runId}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, { method: 'POST', body: {} });
export const actionsSecrets = (repo: Repo, token: string) => api<{ secrets: { name: string; updated_at?: string }[] }>(token, `${actionsPath(repo)}/secrets?per_page=100`).then((r) => r.secrets.map((s) => ({ name: s.name, updatedAt: s.updated_at })));

// GitHub only takes a secret sealed to the repo's own key, which needs a crypto library Unit7 doesn't carry, so gh does the sealing.
// The token goes in its environment and the value on stdin: neither is ever on a command line.
export function ghSecret(args: string[], token: string, value?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.UNIT7_GH_BIN ?? 'gh', ['secret', ...args], { timeout: 30_000, env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } }, (e, _out, err) => {
      if (!e) return resolve();
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Unit7Error('gh_missing', 'Setting a GitHub secret needs GitHub’s command-line tool (gh), and it isn’t installed on the computer running Unit7. Install it (brew install gh) and try again. It doesn’t need signing in. Or add the secret yourself on GitHub, under the repo’s Settings → Secrets and variables → Actions.', 409));
      reject(new Unit7Error('gh_failed', `GitHub refused that: ${String(err || e.message).replaceAll(token, '***').trim().split('\n').filter(Boolean).pop()?.slice(0, 240) ?? 'no reason given'}`, 502));
    });
    child.stdin?.on('error', () => undefined); // gh exited first: the callback above says why
    child.stdin?.end(value ?? '');
  });
}

// GitHub's code search skips repos it hasn't indexed and says nothing, so an empty answer proves nothing: look in the code itself
export async function grepRepo(repo: Repo, term: string, token: string | undefined, limit = 5): Promise<string[]> {
  const exec = promisify(execFile), tmp = mkdtempSync(join(tmpdir(), 'unit7-grep-'));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(token && GH().startsWith('https://') ? githubAuthEnv(token) : {}) };
  try {
    await exec(sysBin('git'), ['clone', '-q', '--depth', '1', '--', cloneUrl(repo), tmp], { env, timeout: 60_000, maxBuffer: 1 << 24 });
    const out = await exec(sysBin('git'), ['grep', '-l', '-I', '-F', '--', term], { cwd: tmp, env, timeout: 20_000, maxBuffer: 1 << 24 }).then((r) => r.stdout, () => ''); // git grep exits 1 when nothing matches
    return out.split('\n').filter(Boolean).slice(0, limit);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
