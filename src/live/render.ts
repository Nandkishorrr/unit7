// Render builds from a repo, so a folder goes through a private GitHub repo first. POST /services starts the first deploy by
// itself. A web service goes on the free plan (leaving it out means a paid one).
// api-docs.render.com/openapi/render-public-api-1.json (2026-11): servicePOST, serviceAndDeploy, /owners, /logs.
// A repo Render can't read needs GitHub connected on its dashboard: no API adds that (render.com/docs/github).
import { rest } from '../connectors/dnswrite.ts';
import { RENDER_API, render, renderAuth, renderDeploys } from '../connectors/hosts.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { repoFor } from './coolify.ts';
import { accountsOf, addHost, type Host, type Put } from './hosts.ts';
import { keptIn, one, parts, send, taken, until, type Sent } from './kit.ts';

const RUNTIME: Record<string, string> = { node: 'node', python: 'python', go: 'go', rust: 'rust', ruby: 'ruby', elixir: 'elixir' };
const INSTALL: Record<string, string> = { npm: 'npm install', pnpm: 'pnpm install', yarn: 'yarn install', bun: 'bun install', pip: 'pip install -r requirements.txt', poetry: 'poetry install' };
const CONNECT = 'A private repo needs GitHub connected on Render’s dashboard once: https://dashboard.render.com/u/settings#account-security. Then check Render’s app can reach it: https://github.com/apps/render/installations/new. Run this again after that.';

const call = async (ctx: Ctx, acc: string, path: string, body?: unknown) => send(`${RENDER_API()}${path}`, { body, headers: await renderAuth(ctx, acc) });
function refused(what: string, r: Sent, repo?: string) {
  const why = String(r.data?.message ?? r.status);
  if (r.status === 401) return new Unit7Error('provider_refused', 'Render refused this key (unauthorized). Check it in Connections.', 401);
  if (r.status === 402) return new Unit7Error('payment_needed', `Render wants a payment method first: ${why}. Add one at https://dashboard.render.com/billing, then run this again.`, 402);
  if (repo && /repo|\bgit|branch|access/i.test(why)) return new Unit7Error('repo_unreachable', `Render can’t read ${repo}. ${CONNECT}`, 400);
  return new Unit7Error('render_error', `Render refused to ${what}: ${why}`, r.status === 403 ? 403 : 502);
}

async function workspace(ctx: Ctx, acc: string, team?: string) {
  const r = await call(ctx, acc, '/owners?limit=50');
  if (r.status >= 400) throw refused('list your workspaces', r);
  const owners = (r.data as { owner: { id: string; name: string } }[]).map((x) => x.owner);
  const name = one('Render workspaces', owners.map((o) => o.name), owners.find((o) => o.id === team)?.name ?? team);
  return owners.find((o) => o.name === name)!.id;
}

function service(p: Put, ownerId: string, repo: string, branch: string) {
  const d = p.site.detection, build = [INSTALL[d.packageManager ?? ''], d.buildCommand].filter(Boolean).join(' && ');
  const base = { name: p.name, ownerId, repo, branch, autoDeployTrigger: 'commit', envVars: p.env.map(({ key, value }) => ({ key, value })) };
  if (d.builder === 'static') return { ...base, type: 'static_site', serviceDetails: { ...(build && { buildCommand: build }), publishPath: d.staticDir } };
  return { ...base, type: 'web_service', serviceDetails: { plan: p.size?.id ?? 'free', ...(d.dockerfile
    ? { runtime: 'docker', envSpecificDetails: { dockerfilePath: `./${d.dockerfile}` } }
    : { runtime: RUNTIME[d.runtime!], envSpecificDetails: { buildCommand: build || 'true', startCommand: d.startCommand } }) } };
}

async function lines(ctx: Ctx, acc: string, id: string) {
  const q = new URLSearchParams({ ownerId: (await render.service(ctx, acc, id)).ownerId ?? '', resource: id, direction: 'backward', limit: '100', startTime: new Date(Date.now() - 7 * 86400_000).toISOString() });
  q.append('type', 'build'); q.append('type', 'app');
  const r = await rest<{ logs: { message: string }[] }>('Render', `${RENDER_API()}/logs?${q}`, { headers: await renderAuth(ctx, acc) });
  return r.logs.map((l) => l.message).reverse();
}

export const renderHost: Host = addHost({
  id: 'render', name: 'Render', builds: true, pushes: true, tunes: true,
  price: 'Free to start. A plain website stays free.',
  sizes: [
    { id: 'free', label: 'Free: 512 MB, sleeps after 15 minutes with no visitors', price: 'Free' },
    { id: 'starter', label: '512 MB, always on', price: '$7 a month', paid: true },
    { id: 'standard', label: '2 GB, always on', price: '$25 a month', paid: true },
  ],
  places: (ctx) => accountsOf(ctx, 'render', 'render'),
  fit(site) {
    const d = site.detection;
    if (d.builder === 'compose') return { ok: false, why: 'Render doesn’t run docker-compose files. Your own server does.' };
    if (!d.dockerfile && d.builder !== 'static' && !(RUNTIME[d.runtime ?? ''] && d.startCommand)) return { ok: false, why: `Render can’t tell how to run this ${d.stack} app. Add a Dockerfile.` };
    return { ok: true, why: 'It builds from GitHub and has a free plan (a free app sleeps when nobody visits). A private repo needs GitHub connected on Render’s dashboard once.' };
  },
  async put(ctx, p) {
    const acc = p.place.accountId!;
    const had = (await render.services(ctx, acc)).find((s) => s.name === p.name);
    if (had && !p.update) throw taken('Render', p.name);
    const { repo, branch } = await repoFor(ctx, p);
    let id = had?.id, deploy: string | undefined;
    if (id) {
      if (p.env.length) await render.setEnv(ctx, acc, id, p.env);
      deploy = (await renderDeploys.deploy(ctx, acc, id)).id;
    } else {
      ctx.progress('Creating the service on Render…');
      const made = await call(ctx, acc, '/services', service(p, await workspace(ctx, acc, p.team), `https://github.com/${repo.owner}/${repo.name}`, branch));
      if (made.status >= 400) throw refused('create the service', made, `${repo.owner}/${repo.name}`);
      id = String(made.data.service.id); deploy = made.data.deployId;
    }
    const app = id;
    await until(ctx, 'Render', async () => {
      const state = (deploy ? await renderDeploys.get(ctx, acc, app, deploy) : (await renderDeploys.list(ctx, acc, app))[0])?.status ?? 'queued';
      if (/failed|canceled/.test(state)) throw new Unit7Error('build_failed', `Render couldn’t put it live: ${state.replace(/_/g, ' ')}.`, 502, { logTail: (await lines(ctx, acc, app).catch(() => [])).slice(-40).join('\n') });
      return { state: state.replace(/_/g, ' '), done: state === 'live' || state === 'deactivated' ? true : undefined };
    });
    return { url: (await render.service(ctx, acc, id)).serviceDetails?.url ?? '', project: id, deployment: deploy, autoDeploy: true, point: { render: { accountId: acc, service: id } }, notes: keptIn(p, repo) };
  },
  logs: (ctx, r) => lines(ctx, r.place.accountId!, parts(r.project)[0]!),
  async env(ctx, r, op) {
    const acc = r.place.accountId!, id = parts(r.project)[0]!;
    if (op.set?.length) await render.setEnv(ctx, acc, id, op.set);
    for (const key of op.unset ?? []) await rest('Render', `${RENDER_API()}/services/${id}/env-vars/${encodeURIComponent(key)}`, { method: 'DELETE', headers: await renderAuth(ctx, acc) });
    return Object.keys(await render.env(ctx, acc, id)).map((key) => ({ key }));
  },
});
