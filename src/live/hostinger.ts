// Hostinger web hosting, through its own MCP server (connectors/hostinger.ts). A website here is a domain on a plan you
// already have, and every deploy overwrites it with no way back, so one with anything on it only changes when update says
// so and a person agrees. Buying hosting stays in hPanel: nothing here touches an order.
//   hosting_deploy-static-website           finished files, or PHP as it is
//   hosting_deploy-js-application           Hostinger builds it, on plans with Node.js
//   hosting_git_deploy-website-repository   a public PHP repo: the one route that runs composer
// The first two read a .tgz on this computer, which only the local server (a token) can do, not the hosted one (one-click).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packFiles } from '../connectors/folder.ts';
import { cloneUrl, defaultBranch, githubToken, repoIsPrivate } from '../connectors/github.ts';
import { isOAuthAccount } from '../connectors/mcp-oauth.ts';
import { Unit7Error } from '../errors.ts';
import { isAgent } from '../tools/helpers.ts';
import { hostingerExec } from '../tools/hostinger.ts';
import type { Ctx } from '../tools/runtime.ts';
import { NO_SETTINGS, accountsOf, addHost, finished, published, sleep, type Host, type Put, type Ref } from './hosts.ts';
import type { Site, SiteFile } from './source.ts';
import { liveTiming } from './vercel.ts';

const DEPLOY_MS = 15 * 60_000;
export interface Website { domain: string; username: string; website_type?: string | null; order_id?: number | null }
// what a new website comes with, none of it the person's
const FRESH = /^(default\.php|\.htaccess|\.well-known|cgi-bin)$/;
export const APPS: Record<string, string> = { wordpress: 'WordPress', builder: 'Hostinger’s website builder', horizons: 'Hostinger Horizons' };
const isPhp = (s: Site) => s.detection.runtime === 'php' || (s.detection.stack === 'unknown' && s.files.some((f) => /\.php$/.test(f.path)));

// its operations put the reason inside the JSON they quote
export const said = (why: unknown) => /"(?:message|error)"\s*:\s*"([^"]+)"/.exec(String(why))?.[1] ?? String(why).replace(/^Hostinger said: /, '').slice(0, 300);
// a refused key keeps its 401: that's what stops background work on the account until a person reconnects it
export const refused = (what: string, why: unknown) => (/\bHTTP 401\b/.test(String(why))
  ? new Unit7Error('hostinger_refused', `Hostinger didn’t accept this account’s key (unauthorized), so Unit7 couldn’t ${what}. Put a new key in Connections, then run this again.`, 401)
  : new Unit7Error('hostinger_error', `Hostinger refused to ${what}: ${said(why)}`, 502));

export async function websiteOf(ctx: Ctx, acc: string, domain?: string): Promise<Website> {
  const name = domain?.replace(/^www\./, '');
  const got = await hostingerExec(ctx, acc, 'hosting_websites_list', name ? { domain: name } : {}).catch((e: Error) => { throw refused('list your websites', e.message); });
  const rows = (Array.isArray(got) ? got : []) as Website[];
  if (!name) throw new Unit7Error('which_website', rows.length ? `Hostinger hosts one site per domain. Say which of yours this goes on: ${rows.slice(0, 10).map((r) => r.domain).join(', ')}.` : 'This Hostinger account has no websites yet. Add one in hPanel (Websites → Add website), then run this again. Unit7 doesn’t buy hosting.', 400);
  // the filter matches part of a name, so shop.example also finds myshop.example
  const w = rows.find((r) => r.domain === name);
  if (!w) throw new Unit7Error('no_website', `${name} isn’t a website on this Hostinger account. Unit7 can create it on a plan you already have (hostinger.website_create, a person says yes first), or add it in hPanel (Websites → Add website). Then run this again. Unit7 doesn’t buy hosting.`, 404);
  return w;
}

// a listing Unit7 can't read counts as full: the mistake that matters is overwriting someone's site
async function holdsSomething(ctx: Ctx, acc: string, w: Website) {
  const got = await hostingerExec(ctx, acc, 'hosting_files_list-website-and-directories', { username: w.username, domain: w.domain }).catch(() => undefined);
  const rows = Array.isArray(got) ? got : got?.items ?? got?.entries ?? got?.files;
  return !Array.isArray(rows) || rows.some((e: { name?: string; path?: string }) => !FRESH.test(String(e?.name ?? e?.path ?? e).split('/').pop()!));
}

async function settingsOf(ctx: Ctx, acc: string, w: Website): Promise<string[]> {
  const got = await hostingerExec(ctx, acc, 'hosting_nodejs_list-environment-variables', { username: w.username, domain: w.domain }).catch((e: Error) => { if (/\b404\b/.test(e.message)) return []; throw refused('list the settings', e.message); });
  const rows = got?.env_vars ?? got;
  if (Array.isArray(rows)) return rows.map((e: { key: string }) => String(e.key));
  if (rows && typeof rows === 'object') return Object.keys(rows);
  throw new Unit7Error('hostinger_error', 'Hostinger didn’t say which settings this site has, so Unit7 left them alone.', 502);
}

// Hostinger takes every setting at once, deletes what's left out and never shows a value, so one left out is gone for good
export async function saveSettings(ctx: Ctx, acc: string, w: Website, set: Put['env'], unset: string[] = []) {
  const had = await settingsOf(ctx, acc, w), lost = had.filter((k) => !unset.includes(k) && !set.some((e) => e.key === k));
  if (lost.length) throw new Unit7Error('would_erase', `Hostinger only takes all of a site’s settings together and never shows their values, so this would erase ${lost.slice(0, 8).join(', ')}. Give them all together with live.put, or change this one in hPanel.`, 409);
  await hostingerExec(ctx, acc, 'hosting_nodejs_replace-environment-variables', { username: w.username, domain: w.domain, env_vars: set.map(({ key, value }) => ({ key, value })) }).catch((e: Error) => { throw refused('save the settings', e.message); });
  return had;
}

async function withArchive<T>(dir: string, files: SiteFile[], go: (archivePath: string) => Promise<T>) {
  const tmp = mkdtempSync(join(tmpdir(), 'unit7-hostinger-'));
  try {
    // it sits in the website's folder until Hostinger unpacks it, so a name nobody can guess
    const archivePath = join(tmp, `unit7-${randomBytes(8).toString('hex')}.tgz`);
    writeFileSync(archivePath, await packFiles(dir, files.map((f) => f.path)), { mode: 0o600 });
    return await go(archivePath);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const linesOf = (r: any): string[] => {
  const rows = typeof r === 'string' ? r : r?.logs ?? r?.entries ?? [];
  return (typeof rows === 'string' ? rows.split('\n') : Array.isArray(rows) ? rows.map((e) => (typeof e === 'string' ? e : String(e?.message ?? e?.line ?? ''))) : [])
    .map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, '')).filter(Boolean);
};

async function built(ctx: Ctx, acc: string, w: Website, uuid: string) {
  const at = { username: w.username, domain: w.domain, uuid }, end = Date.now() + liveTiming.buildMs;
  let said = '';
  while (Date.now() < end) {
    const state = String((await hostingerExec(ctx, acc, 'hosting_nodejs_build', at).catch((e: Error) => { throw refused('say how the build is going', e.message); }))?.state ?? '');
    if (state !== said) ctx.progress(`Hostinger: ${(said = state)}`);
    if (state === 'completed') return;
    if (state === 'failed') {
      // kept apart from the plain message: it's written from the build's own output
      const why = await hostingerExec(ctx, acc, 'hosting_nodejs_analyse-failed-build', at).catch(() => undefined);
      const log = linesOf(await hostingerExec(ctx, acc, 'hosting_nodejs_build-logs', at).catch(() => undefined));
      throw new Unit7Error('build_failed', 'Hostinger couldn’t build it. Its log says why.', 502, { logTail: [why?.analysis, why?.solution, ...log.slice(-40)].filter(Boolean).join('\n') });
    }
    await sleep(liveTiming.pollMs);
  }
  throw new Unit7Error('build_slow', 'The build is still running on Hostinger after 25 minutes. It may finish by itself: look at the website in hPanel.', 504);
}

// finished files or PHP go up as they are; anything else Hostinger builds, from its source alone
async function deploy(ctx: Ctx, acc: string, w: Website, p: Put) {
  const site = p.site, ready = finished(site) ? published(site) : isPhp(site) ? { dir: '.', files: site.files } : undefined;
  if (isOAuthAccount(ctx.credentialFor('hostinger', acc).account.meta)) throw new Unit7Error('needs_token', 'Hostinger’s one-click sign-in can’t read files on this computer. In Connections, add a Hostinger API token too, then run this again.', 400);
  if (ready) {
    ctx.progress(`Sending the files to ${w.domain}…`);
    const r = await withArchive(join(site.dir, ready.dir), ready.files, (archivePath) => hostingerExec(ctx, acc, 'hosting_deploy-static-website', { domain: w.domain, archivePath }, DEPLOY_MS)).catch((e: Error) => { throw refused(`deploy to ${w.domain}`, e.message); });
    // a refusal after the upload comes back as an ordinary answer
    if (r?.deploy?.status !== 'success') throw refused(`deploy to ${w.domain}`, r?.deploy?.error ?? 'it gave no reason');
    return undefined;
  }
  if (p.env.length) await saveSettings(ctx, acc, w, p.env);
  ctx.progress(`Sending your code to ${w.domain}, where Hostinger builds it…`);
  const source = site.files.filter((f) => !/^(dist|build|out)\//.test(f.path));
  const r = await withArchive(site.dir, source, (archivePath) => hostingerExec(ctx, acc, 'hosting_deploy-js-application', { domain: w.domain, archivePath }, DEPLOY_MS)).catch((e: Error) => { throw refused(`deploy to ${w.domain}`, e.message); });
  if (r?.resolveSettings?.status === 'error') throw refused(`work out how to build ${w.domain}`, r.resolveSettings.error);
  if (r?.build?.status !== 'success') throw refused(`build ${w.domain}`, r?.build?.error ?? 'it gave no reason');
  const uuid = String(r.build.data?.uuid ?? r.build.data?.data?.uuid ?? '');
  if (!uuid) throw new Unit7Error('hostinger_error', `Hostinger started a build of ${w.domain} but didn’t say which one. Look at the website in hPanel.`, 502);
  await built(ctx, acc, w, uuid);
  return uuid;
}

// composer only runs on a Git deploy, and a private repo would need Hostinger's key added to it first
async function deployRepo(ctx: Ctx, acc: string, w: Website, p: Put) {
  const repo = p.site.repo, token = await githubToken(ctx);
  if (!repo || await repoIsPrivate(repo, token ?? '').catch(() => true)) throw new Unit7Error('needs_composer', 'This PHP site needs composer install, which Hostinger only runs for a public Git repo. Make the repo public, or add Hostinger’s Git key to it in hPanel, or run composer install and upload it with its vendor folder.', 400);
  ctx.progress(`Hostinger is cloning ${repo.owner}/${repo.name}…`);
  const r = await hostingerExec(ctx, acc, 'hosting_git_deploy-website-repository', { username: w.username, domain: w.domain, repository_url: cloneUrl(repo), branch: p.site.branch ?? await defaultBranch(repo, token) }, DEPLOY_MS).catch((e: Error) => { throw refused(`deploy ${repo.owner}/${repo.name}`, e.message); });
  // Git or composer failing comes back as an ordinary answer, with the log in it
  if (!r?.is_success) throw new Unit7Error('build_failed', `Hostinger couldn’t deploy ${repo.owner}/${repo.name}. Its log says why.`, 502, { logTail: String(r?.log ?? r?.output ?? '').slice(-4000) });
}

const needsComposer = (s: Site) => isPhp(s) && s.files.some((f) => f.path === 'composer.json') && !s.files.some((f) => f.path === 'vendor/autoload.php');

export const hostingerHost: Host = addHost({
  id: 'hostinger', name: 'Hostinger web hosting', builds: true, price: 'Included in your Hostinger plan.',
  places: (ctx) => accountsOf(ctx, 'hostinger', 'hostinger'),
  fit(site) {
    const d = site.detection, which = ' Say which of your websites it goes on (its domain).';
    if (d.dockerfile || d.builder === 'compose') return { ok: false, why: 'Hostinger web hosting doesn’t run Docker. Your own server or Coolify does.' };
    if (d.stack === 'laravel') return { ok: false, why: 'Laravel needs its public folder as the website’s root, which Unit7 can’t set here. Your own server or Coolify runs it.' };
    if (finished(site) || isPhp(site)) return { ok: true, why: `It goes on a website you already pay for.${which}` };
    if (d.runtime === 'node') return { ok: true, why: `Hostinger builds it, on plans with Node.js.${which}` };
    return { ok: false, why: `Hostinger web hosting runs PHP and Node.js, not ${d.stack === 'unknown' ? 'this' : d.stack}. Your own server or Coolify runs it.` };
  },
  async put(ctx, p) {
    const acc = p.place.accountId!, w = await websiteOf(ctx, acc, p.domain), kept = APPS[w.website_type ?? ''];
    if (kept) throw new Unit7Error('would_replace', `${w.domain} runs ${kept}, and a deploy would wipe it with no way back. Pick another website, or remove it in hPanel first.`, 409);
    if (!p.update && await holdsSomething(ctx, acc, w)) throw new Unit7Error('already_exists', `${w.domain} already has a site on it, and a deploy overwrites it with no way back. Say you want to replace it, or pick an empty website.`, 409);
    if (p.update && isAgent(ctx) && !ctx.approvalId) throw new Unit7Error('needs_person', `Replacing ${w.domain} can’t be undone, so a person has to do it or approve it.`, 403);
    let uuid: string | undefined;
    if (needsComposer(p.site)) await deployRepo(ctx, acc, w, p);
    else uuid = await deploy(ctx, acc, w, p);
    // a new site can show Hostinger's default page for a while
    await hostingerExec(ctx, acc, 'hosting_cache_clear-website', { username: w.username, domain: w.domain }).catch(() => undefined);
    return {
      url: `https://${w.domain}`, project: w.domain, deployment: uuid, dashboard: 'https://hpanel.hostinger.com/websites', autoDeploy: false, point: false,
      notes: [...(p.update ? ['Hostinger keeps no earlier version, so this can’t be undone.'] : []), ...(p.env.length && !uuid ? [NO_SETTINGS] : [])],
    };
  },
  async logs(ctx, r: Ref) {
    const acc = r.place.accountId!, w = await websiteOf(ctx, acc, r.project), at = { username: w.username, domain: w.domain };
    const got = await (r.deployment ? hostingerExec(ctx, acc, 'hosting_nodejs_build-logs', { ...at, uuid: r.deployment }) : hostingerExec(ctx, acc, 'hosting_nodejs_runtime-logs', { ...at, period: '1d' })).catch((e: Error) => { throw refused('share the log', e.message); });
    return linesOf(got).slice(-120);
  },
  async env(ctx, r, op) {
    const acc = r.place.accountId!, w = await websiteOf(ctx, acc, r.project);
    if (op.set?.length || op.unset?.length) await saveSettings(ctx, acc, w, op.set ?? [], op.unset);
    return (await settingsOf(ctx, acc, w)).map((key) => ({ key }));
  },
});
