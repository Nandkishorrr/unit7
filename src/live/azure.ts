// Azure Static Web Apps, first deploy, on the Free plan, over Azure's REST API with a signed-in az or a service principal that has the
// rights. It takes no files: Azure's zip deploy reads from a public address, so a folder goes through a private GitHub repo, and Azure
// adds a GitHub Actions workflow that builds it there. learn.microsoft.com/rest/api/appservice/static-sites (2024-11-01) and
// /azure/static-web-apps/plans (2026-11). Builds run on GitHub, so their logs are on the repo's Actions tab, not here.
import { armGet, armList, armSend, azure } from '../connectors/azure.ts';
import { isMissing } from '../connectors/cloudcli.ts';
import { githubToken } from '../connectors/github.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { repoFor } from './coolify.ts';
import { accountsOf, addHost, type Host } from './hosts.ts';
import { finished, keptIn, one, parts, taken, until } from './kit.ts';

export const azureTiming = { waitMs: 10 * 60_000 };
const API = 'api-version=2024-11-01', GROUP = 'unit7-sites', WHERE = 'centralus';
const NEEDS = ['Microsoft.Web/staticSites/write', 'Microsoft.Resources/subscriptions/resourceGroups/write'];
const sites = (s: string, g: string) => `/subscriptions/${s}/resourceGroups/${g}/providers/Microsoft.Web/staticSites`;
const matches = (rule: string, action: string) => new RegExp(`^${rule.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(action);

const settings = async (ctx: Ctx, acc: string, path: string) => (await armSend<{ properties?: Record<string, string> }>(ctx, acc, `${path}/listAppSettings?${API}`)).properties ?? {};
const saveSettings = (ctx: Ctx, acc: string, path: string, properties: Record<string, string>) => armSend(ctx, acc, `${path}/config/appsettings?${API}`, { method: 'PUT', body: { properties } });

export const azureHost: Host = addHost({
  id: 'azure', name: 'Azure Static Web Apps', builds: true,
  places: (ctx) => accountsOf(ctx, 'azure', 'azure'),
  fit(site) {
    const d = site.detection;
    if (d.dockerfile || d.builder === 'compose') return { ok: false, why: 'Static Web Apps doesn’t run Docker. Your own server does.' };
    if (d.builder !== 'static') return { ok: false, why: `Static Web Apps hosts websites, not an always-on ${d.stack} server.` };
    return { ok: true, why: finished(site) || d.buildCommand ? 'It’s free for small sites and builds on GitHub, so every push goes live.' : 'It’s free for small sites, and every push goes live.' };
  },
  // Azure answers for a resource group: this subscription's own, or the first there is. With none, the real call says
  async rights(ctx, place) {
    const acc = place.accountId!, subs = await azure.subscriptions(ctx, acc);
    if (subs.length !== 1) return undefined;
    const s = subs[0]!.subscriptionId, groups = await armList<{ name: string }>(ctx, acc, `/subscriptions/${s}/resourcegroups?api-version=2021-04-01`);
    const g = groups.find((x) => x.name === GROUP) ?? groups[0];
    if (!g) return undefined;
    const held = await armList<{ actions?: string[]; notActions?: string[] }>(ctx, acc, `/subscriptions/${s}/resourcegroups/${encodeURIComponent(g.name)}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`);
    const lacks = NEEDS.filter((n) => !held.some((p) => p.actions?.some((a) => matches(a, n)) && !p.notActions?.some((a) => matches(a, n))));
    return lacks.length ? `This Azure sign-in can only read: it lacks ${lacks.join(', ')}. Give it the Contributor role on the subscription, or run az login on this Mac and connect that.` : undefined;
  },
  async put(ctx, p) {
    const acc = p.place.accountId!, d = p.site.detection;
    const s = one('Azure subscriptions', (await azure.subscriptions(ctx, acc)).map((x) => x.subscriptionId), p.team), path = `${sites(s, GROUP)}/${p.name}`;
    const had = await armGet(ctx, acc, `${path}?${API}`).catch((e) => { if (isMissing(e)) return undefined; throw e; });
    if (had && !p.update) throw taken('Azure', p.name);
    const { repo, branch } = await repoFor(ctx, p);
    const token = await githubToken(ctx);
    if (!token) throw new Unit7Error('no_account', 'Azure builds from a GitHub repo, and GitHub isn’t connected yet. Connect it in Connections, then run this again.', 400);
    await armGet(ctx, acc, `/subscriptions/${s}/resourcegroups/${GROUP}?api-version=2021-04-01`).catch(async (e) => { if (!isMissing(e)) throw e; await armSend(ctx, acc, `/subscriptions/${s}/resourcegroups/${GROUP}?api-version=2021-04-01`, { method: 'PUT', body: { location: WHERE } }); });
    if (!had) {
      ctx.progress('Creating the site on Azure…');
      await armSend(ctx, acc, `${path}?${API}`, { method: 'PUT', body: { location: WHERE, sku: { name: 'Free', tier: 'Free' }, properties: { repositoryUrl: `https://github.com/${repo.owner}/${repo.name}`, branch, repositoryToken: token, buildProperties: { appLocation: '/', outputLocation: d.staticDir === '.' ? '' : d.staticDir } } } })
        .catch((e: Unit7Error) => { throw e.status === 403 ? e : new Unit7Error('github_refused', `Azure couldn’t set up a build on ${repo.owner}/${repo.name}: ${e.message.slice(0, 200)}. The GitHub connection needs the repo and workflow scopes.`, 502); });
    }
    if (p.env.length) await saveSettings(ctx, acc, path, { ...(await settings(ctx, acc, path)), ...Object.fromEntries(p.env.map((e) => [e.key, e.value])) });
    // a build that fails on GitHub never reaches Azure, so this waits ten minutes, then says where to look
    const ready = await until(ctx, 'Azure', async () => {
      const state = String((await armGet(ctx, acc, `${path}/builds/default?${API}`).catch((e) => { if (isMissing(e)) return undefined; throw e; }))?.properties?.status ?? 'WaitingForDeployment');
      if (state === 'Failed') throw new Unit7Error('build_failed', 'Azure couldn’t put it live. The build log is on the repo’s Actions tab on GitHub.', 502);
      return { state: state.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(), done: state === 'Ready' ? true : undefined };
    }, azureTiming.waitMs).catch((e: Unit7Error) => { if (e.code === 'build_slow') return false; throw e; });
    const host = (await armGet(ctx, acc, `${path}?${API}`)).properties?.defaultHostname;
    return { url: host ? `https://${host}` : '', project: `${s}/${GROUP}/${p.name}`, autoDeploy: true, point: 'Add your domain in the Azure portal, under Custom domains. Unit7 can’t point domains at Static Web Apps yet.',
      notes: [...keptIn(p, repo), ...(ready ? [] : [`It’s still building on GitHub. Look at the Actions tab of ${repo.owner}/${repo.name}.`]), ...(p.env.length ? ['Settings reach the site’s API functions only. A build on GitHub doesn’t see them.'] : [])] };
  },
  // they reach the site's API functions, not its build. Azure's call replaces them all, so they're read first
  async env(ctx, r, op) {
    const acc = r.place.accountId!, [s, g, name] = parts(r.project, 3) as [string, string, string], path = `${sites(s, g)}/${name}`, vars = await settings(ctx, acc, path);
    for (const key of op.unset ?? []) delete vars[key];
    for (const e of op.set ?? []) vars[e.key] = e.value;
    if (op.set?.length || op.unset?.length) await saveSettings(ctx, acc, path, vars);
    return Object.keys(vars).map((key) => ({ key }));
  },
});
