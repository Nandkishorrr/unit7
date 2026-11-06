// DigitalOcean App Platform: POST /apps with a spec that builds from a GitHub repo, so a folder goes through a private repo first.
// DigitalOcean-public.v2.yaml (2026-11): apps_create, app_spec, app_variable_definition, apps_deployment_phase. Reading a repo needs
// DigitalOcean's GitHub link, made once in a browser: no token can (docs.digitalocean.com/products/app-platform/how-to/manage-source-repo).
import { DO, doAuth } from '../connectors/dnswrite.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { repoFor } from './coolify.ts';
import { accountsOf, addHost, type Host, type Put } from './hosts.ts';
import { keptIn, parts, send, taken, textOf, until, type Sent } from './kit.ts';

const API = () => process.env.UNIT7_DIGITALOCEAN_API ?? DO; // overridable for offline tests
const call = async (ctx: Ctx, acc: string, path: string, o: { method?: string; body?: unknown } = {}) => send(`${API()}${path}`, { ...o, headers: await doAuth(ctx, acc) });
const LINK = 'Link GitHub to DigitalOcean once at https://cloud.digitalocean.com/apps/new and give it that repo, then run this again.';
function refused(what: string, r: Sent, repo?: string) {
  const why = String(r.data?.message ?? r.status);
  if (r.status === 401) return new Unit7Error('provider_refused', 'DigitalOcean refused this token (unauthorized). Check it in Connections.', 401);
  if (repo && /repo|\bgit/i.test(why)) return new Unit7Error('repo_unreachable', `DigitalOcean can’t read ${repo}: ${why.slice(0, 160)}. ${LINK}`, 400);
  return new Unit7Error('digitalocean_error', `DigitalOcean refused to ${what}: ${why}`, r.status === 403 ? 403 : 502);
}
async function read(ctx: Ctx, acc: string, path: string, what: string) {
  const r = await call(ctx, acc, path);
  if (r.status >= 400) throw refused(what, r);
  return r.data;
}

function spec(p: Put, repo: string, branch: string) {
  const d = p.site.detection, github = { repo, branch, deploy_on_push: true };
  const envs = p.env.map((e) => ({ key: e.key, value: e.value, type: e.secret ? 'SECRET' : 'GENERAL', scope: 'RUN_AND_BUILD_TIME' }));
  if (d.builder === 'static') return { name: p.name, envs, static_sites: [{ name: 'web', github, ...(d.buildCommand && { build_command: d.buildCommand }), ...(d.staticDir !== '.' && { output_dir: d.staticDir }) }] };
  return { name: p.name, envs, services: [{ name: 'web', github, http_port: d.port, instance_count: 1, instance_size_slug: 'apps-s-1vcpu-0.5gb', ...(d.dockerfile ? { dockerfile_path: d.dockerfile } : { run_command: d.startCommand }) }] };
}
const latest = async (ctx: Ctx, acc: string, app: string) => (await read(ctx, acc, `/apps/${app}/deployments?per_page=1`, 'say how the build is going')).deployments?.[0] as { id: string; phase?: string } | undefined;

async function lines(ctx: Ctx, acc: string, app: string, deployment?: string) {
  const id = deployment ?? (await latest(ctx, acc, app))?.id;
  if (!id) return [];
  const out: string[] = [];
  for (const type of ['BUILD', 'RUN']) {
    const r = await call(ctx, acc, `/apps/${app}/deployments/${id}/logs?type=${type}&follow=false`);
    for (const url of r.status < 400 ? r.data.historic_urls ?? [] : []) out.push(...(await textOf(url)).split('\n'));
  }
  return out.filter(Boolean).slice(-200);
}

export const digitaloceanHost: Host = addHost({
  id: 'digitalocean', name: 'DigitalOcean App Platform', builds: true, envNow: true,
  costs: 'DigitalOcean charges from $5 a month for an app with a server. Up to three plain websites are free.',
  places: (ctx) => accountsOf(ctx, 'digitalocean', 'digitalocean'),
  fit(site) {
    const d = site.detection;
    if (d.builder === 'compose') return { ok: false, why: 'App Platform doesn’t run docker-compose files. Your own server does.' };
    if (!d.dockerfile && d.builder !== 'static' && !d.startCommand) return { ok: false, why: `App Platform can’t tell how to run this ${d.stack} app. Add a Dockerfile.` };
    return { ok: true, why: 'It builds from GitHub. Its GitHub link is made once in a browser.' };
  },
  async put(ctx, p) {
    const acc = p.place.accountId!;
    if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(p.name)) throw new Unit7Error('invalid_input', 'A name on App Platform starts with a letter and has up to 32 letters, digits and dashes. Choose another.', 400);
    const had = ((await read(ctx, acc, '/apps?per_page=200', 'list your apps')).apps as { id: string; spec: { name: string } }[] | undefined)?.find((a) => a.spec.name === p.name);
    if (had && !p.update) throw taken('DigitalOcean', p.name);
    const { repo, branch } = await repoFor(ctx, p), full = `${repo.owner}/${repo.name}`;
    let id = had?.id, started: string | undefined;
    if (id) {
      if (p.env.length) await digitaloceanHost.env!(ctx, { place: p.place, project: id }, { set: p.env });
      const again = await call(ctx, acc, `/apps/${id}/deployments`, { body: { force_build: true } });
      if (again.status >= 400) throw refused('start a build', again, full);
      started = again.data.deployment?.id;
    } else {
      ctx.progress('Creating the app on DigitalOcean…');
      const made = await call(ctx, acc, '/apps', { body: { spec: spec(p, full, branch) } });
      if (made.status >= 400) throw refused('create the app', made, full);
      id = String(made.data.app.id);
    }
    const app = id;
    const deployment = await until(ctx, 'DigitalOcean', async () => {
      const d = started ? (await read(ctx, acc, `/apps/${app}/deployments/${started}`, 'say how the build is going')).deployment as { id: string; phase?: string } : await latest(ctx, acc, app), state = d?.phase ?? 'PENDING_BUILD';
      if (state === 'ERROR' || state === 'CANCELED') throw new Unit7Error('build_failed', `DigitalOcean couldn’t put it live: ${state.toLowerCase()}.`, 502, { logTail: (await lines(ctx, acc, app, d?.id).catch(() => [])).slice(-40).join('\n') });
      return { state: state.toLowerCase().replace(/_/g, ' '), done: state === 'ACTIVE' || state === 'SUPERSEDED' ? d!.id : undefined };
    });
    const live = (await read(ctx, acc, `/apps/${app}`, 'say the address')).app as { live_url?: string; default_ingress?: string };
    return { url: live.live_url ?? live.default_ingress ?? '', project: app, deployment, autoDeploy: true, point: 'Add your domain in the app’s Settings on DigitalOcean. Unit7 can’t point domains at App Platform yet.', notes: keptIn(p, repo) };
  },
  logs: (ctx, r) => lines(ctx, r.place.accountId!, parts(r.project)[0]!, r.deployment && parts(r.deployment)[0]),
  // the whole spec goes back: SECRET values come as sealed values that stay valid, and DigitalOcean rebuilds it by itself
  async env(ctx, r, op) {
    const acc = r.place.accountId!, id = parts(r.project)[0]!, { app } = await read(ctx, acc, `/apps/${id}`, 'read the app');
    const gone = new Set([...(op.unset ?? []), ...(op.set ?? []).map((e) => e.key)]);
    const envs = [...(app.spec.envs ?? []).filter((e: { key: string }) => !gone.has(e.key)), ...(op.set ?? []).map((e) => ({ key: e.key, value: e.value, type: e.secret ? 'SECRET' : 'GENERAL', scope: 'RUN_AND_BUILD_TIME' }))];
    if (gone.size) { const up = await call(ctx, acc, `/apps/${id}`, { method: 'PUT', body: { spec: { ...app.spec, envs } } }); if (up.status >= 400) throw refused('change a setting', up); }
    return envs.map((e: { key: string }) => ({ key: e.key }));
  },
});
