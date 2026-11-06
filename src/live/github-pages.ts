// GitHub Pages: free, finished files only. They go on their own gh-pages branch, so a repo's code is never touched, and
// Pages serves that branch. A site from an upload gets a new public repo holding only those files, since Pages on a
// private repo is a paid plan. POST /repos/{o}/{r}/pages, GET …/pages/builds/latest (docs.github.com/en/rest/pages/pages)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo, githubApi, githubToken, headSha, parseRepo, pushFolder, repoExists, type Repo } from '../connectors/github.ts';
import { seg } from '../connectors/dnswrite.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { NO_SETTINGS, accountsOf, addHost, fitFinished, published, sleep, type Host, type Put } from './hosts.ts';
import type { SiteFile } from './source.ts';
import { liveTiming } from './vercel.ts';

const BRANCH = 'gh-pages';
interface Pages { html_url: string; source?: { branch?: string } }
interface Build { status: string; commit?: string; error?: { message?: string | null }; created_at?: string }
const at = (r: Repo) => `/repos/${seg(r.owner)}/${seg(r.name)}/pages`;

// what GitHub's refusals mean for a person
function plain(e: Error) {
  if (!(e instanceof Unit7Error) || e.code !== 'github_api') return e;
  if (/said 40[13]/.test(e.message)) return new Unit7Error('github_rights', 'GitHub won’t let this connection create repos or turn on Pages. In Connections, connect GitHub with a token instead (Generate token, with repo ticked), then run this again.', 403);
  const why = e.message.split(': ').slice(1).join(': ');
  if (/said 422/.test(e.message) && /\/pages/.test(e.message)) return new Unit7Error('pages_refused', `GitHub refused to turn on Pages: ${why}. Pages on a private repo needs a paid plan: make the repo public, or upload the finished files so Unit7 puts them in a new public repo.`, 409);
  return new Unit7Error('github_api', `GitHub refused: ${why || e.message}`, e.status);
}

// a build for this commit: on an update, the last one still says built until GitHub picks up the new push
async function built(ctx: Ctx, token: string, repo: Repo, sha: string) {
  const end = Date.now() + liveTiming.buildMs;
  let said = '';
  while (Date.now() < end) {
    // nothing to read until the first build has started
    const b = await githubApi<Build>(token, `${at(repo)}/builds/latest`).catch((e: Error) => { if (!/said 404/.test(e.message)) throw e; });
    if (b?.commit === sha) {
      if (b.status !== said) ctx.progress(`GitHub Pages: ${(said = b.status)}`);
      if (b.status === 'built') return;
      if (b.status === 'errored') throw new Unit7Error('build_failed', `GitHub Pages couldn’t publish it: ${b.error?.message ?? 'it gave no reason'}`, 502);
    }
    await sleep(liveTiming.pollMs);
  }
  throw new Unit7Error('build_slow', 'GitHub Pages is still publishing it after 25 minutes. It may finish by itself: look at the repo’s Actions tab.', 504);
}

// .nojekyll: without it GitHub runs Jekyll, which drops every folder starting with _ (Next.js and Astro keep their files in one)
async function push(files: SiteFile[], repo: Repo, token: string, update: boolean) {
  const tmp = mkdtempSync(join(tmpdir(), 'unit7-pages-'));
  try {
    writeFileSync(join(tmp, '.nojekyll'), '');
    const existing = !!await headSha(repo, BRANCH, token).catch(() => undefined);
    return await pushFolder([...files, { path: '.nojekyll', abs: join(tmp, '.nojekyll'), size: 0 }], repo, token, { branch: BRANCH, message: update ? 'Update from Unit7' : 'First version, from Unit7', existing });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

async function publish(ctx: Ctx, p: Put, token: string, files: SiteFile[]) {
  // a repo the site came from, or one of this name
  const had = p.site.repo ?? await repoExists(token, p.name);
  const on = had && await githubApi<Pages>(token, at(had)).catch((e: Error) => { if (!/said 404/.test(e.message)) throw e; });
  if (!p.update && (on || (had && !p.site.repo))) throw new Unit7Error('already_exists', `${had!.owner}/${had!.name} already ${on ? 'has a GitHub Pages site' : 'exists'}. Choose another name, or say you want to update it.`, 409);
  ctx.progress(had ? `Saving the finished files in ${had.owner}/${had.name}…` : 'Saving the finished files in a new public GitHub repo…');
  const repo = had ?? await createRepo(token, p.name, { private: false, description: 'A website, published by Unit7' });
  const sha = await push(files, repo, token, !!had);
  const source = { source: { branch: BRANCH, path: '/' }, build_type: 'legacy' };
  // an update on a site that was served from another branch has to move too, or the new files would never show
  if (on && on.source?.branch !== BRANCH) await githubApi(token, at(repo), { method: 'PUT', body: source });
  const site = on ?? await githubApi<Pages>(token, at(repo), { method: 'POST', body: source });
  await built(ctx, token, repo, sha);
  return { repo, sha, url: site.html_url };
}

export const githubPagesHost: Host = addHost({
  id: 'github-pages', name: 'GitHub Pages', builds: false, price: 'Free on a public repo. A private repo needs a paid GitHub plan.',
  places: (ctx) => accountsOf(ctx, 'github-pages', 'github'),
  fit: (site) => fitFinished(site, 'GitHub Pages', 'Free, from a public GitHub repo. It takes the finished files as they are.'),
  async put(ctx, p) {
    const token = await githubToken(ctx, p.place.accountId);
    if (!token) throw new Unit7Error('no_account', 'GitHub isn’t connected yet. Connect it in Connections.', 400);
    const { files } = published(p.site);
    const { repo, sha, url } = await publish(ctx, p, token, files).catch((e: Error) => { throw plain(e); });
    const home = files.find((f) => f.path === 'index.html');
    // these sites live under /name/, so a page that loads /assets/app.js looks in the wrong place
    const rooted = !p.domain && !!home && /(?:src|href)=["']\/(?!\/)/.test(readFileSync(home.abs, 'utf8').slice(0, 262_144));
    return {
      url, project: `${repo.owner}/${repo.name}`, deployment: sha, dashboard: `https://github.com/${repo.owner}/${repo.name}/settings/pages`, autoDeploy: false,
      point: { github: { accountId: p.place.accountId, repo: `${repo.owner}/${repo.name}` } },
      notes: [
        `The finished files are on the ${BRANCH} branch of ${repo.owner}/${repo.name}. Going back is a normal commit: earlier versions stay in its history.`,
        ...(p.env.length ? [NO_SETTINGS] : []),
        ...(rooted ? [`This site’s pages load files from the top of the address, but GitHub serves it under /${repo.name}/, so they may not be found. Build it with its base path set to /${repo.name}/, or point a domain at it.`] : []),
      ],
    };
  },
  async logs(ctx, r) {
    const repo = parseRepo(r.project);
    if (!repo) throw new Unit7Error('invalid_input', 'The project should look like owner/name.', 400);
    const rows = await githubApi<Build[]>(await githubToken(ctx, r.place.accountId), `${at(repo)}/builds?per_page=10`).catch((e: Error) => { throw plain(e); });
    return rows.map((b) => `${b.created_at ?? ''} ${b.status} ${b.commit?.slice(0, 7) ?? ''}${b.error?.message ? `: ${b.error.message}` : ''}`.trim());
  },
});
