// Railway: a project, a service from a GitHub repo, a deploy, over its GraphQL API with an account token. Its file upload route is
// undocumented, so a folder goes through a private GitHub repo instead, like Render and Coolify.
// docs.railway.com/integrations/api/api-cookbook, guides/manage-services, guides/manage-deployments, guides/manage-variables (2026-11).
import { railway, railwayKind, railwayQuery as rw } from '../connectors/hosts.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { repoFor } from './coolify.ts';
import { accountsOf, addHost, type Host, type Put, type Ref } from './hosts.ts';
import { keptIn, parts, taken, until } from './kit.ts';

type Target = { project: string; environment: string; service: string };
const target = (r: Ref): Target => { const [project, environment, service] = parts(r.project, 3) as [string, string, string]; return { project, environment, service }; };

// a project left empty by an earlier try is used again, so trying twice never makes two
async function projectFor(ctx: Ctx, acc: string, p: Put) {
  const { me } = await rw<{ me: { workspaces: { id: string }[] } }>(ctx, acc, '{ me { workspaces { id } } }');
  const workspaceId = p.team ?? me.workspaces[0]?.id;
  const fields = 'id name environments(first: 5) { edges { node { id name } } }';
  const list = await rw(ctx, acc, `query($w: String) { projects(workspaceId: $w, first: 100) { edges { node { ${fields} } } } }`, { w: workspaceId });
  const pj = list.projects.edges.map((e: any) => e.node).find((x: any) => x.name === p.name)
    ?? (await rw(ctx, acc, `mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { ${fields} } }`, { i: { name: p.name, ...(workspaceId && { workspaceId }) } })).projectCreate;
  const envs = pj.environments.edges.map((e: any) => e.node);
  return { project: pj.id as string, environment: (envs.find((e: any) => e.name === 'production') ?? envs[0]).id as string };
}

async function lines(ctx: Ctx, acc: string, t: Target, deployment?: string) {
  const id = deployment ?? (await rw(ctx, acc, 'query($s: String!, $e: String!) { serviceInstance(serviceId: $s, environmentId: $e) { latestDeployment { id } } }', { s: t.service, e: t.environment })).serviceInstance?.latestDeployment?.id;
  if (!id) return [];
  const r = await rw(ctx, acc, 'query($id: String!) { buildLogs(deploymentId: $id, limit: 200) { message } deploymentLogs(deploymentId: $id, limit: 200) { message } }', { id });
  return [...r.buildLogs, ...r.deploymentLogs].map((l: { message: string }) => l.message);
}

export const railwayHost: Host = addHost({
  id: 'railway', name: 'Railway', builds: true, pushes: true,
  price: 'From $5 a month, which includes $5 of use. More use is billed, about $10 per GB of memory a month.',
  costs: 'Railway bills what a running app uses, after a small monthly credit.',
  places: (ctx) => accountsOf(ctx, 'railway', 'railway'),
  fit(site) {
    const d = site.detection;
    if (d.builder === 'compose') return { ok: false, why: 'Railway doesn’t run docker-compose files. Your own server does.' };
    if (!d.dockerfile && d.builder !== 'static' && !d.startCommand) return { ok: false, why: `Railway can’t tell how to run this ${d.stack} app. Add a Dockerfile.` };
    return { ok: true, why: 'It builds from GitHub and keeps the app running. Its GitHub app needs to reach the repo.' };
  },
  async rights(ctx, place) {
    const { kind } = await railwayKind(ctx, place.accountId!);
    return kind === 'account' ? undefined : `This Railway token reaches one ${kind} only, and a new project needs an account token. Make one at https://railway.com/account/tokens with No workspace chosen, then reconnect Railway.`;
  },
  async put(ctx, p) {
    const acc = p.place.accountId!, d = p.site.detection, there = (await railway.instances(ctx, acc)).filter((s) => s.projectName === p.name);
    const had = there.find((s) => s.name === p.name) ?? there[0];
    if (had && !p.update) throw taken('Railway', p.name);
    const { repo, branch } = await repoFor(ctx, p);
    let t: Target, domain = had?.domains[0];
    if (had) t = { project: had.project, environment: had.environment, service: had.service };
    else {
      ctx.progress('Creating the project on Railway…');
      const pj = await projectFor(ctx, acc, p);
      const made = await rw(ctx, acc, 'mutation($i: ServiceCreateInput!) { serviceCreate(input: $i) { id } }', { i: { projectId: pj.project, name: p.name, source: { repo: `${repo.owner}/${repo.name}` }, branch } })
        .catch((e: Error) => { throw new Unit7Error('repo_unreachable', `Railway can’t read ${repo.owner}/${repo.name}: ${e.message.slice(0, 160)}. Give its GitHub app that repo at https://github.com/settings/installations (Railway App, Configure), then run this again.`, 400); });
      t = { ...pj, service: made.serviceCreate.id };
    }
    if (p.env.length) await railway.setEnv(ctx, acc, t, p.env);
    domain ??= (await rw(ctx, acc, 'mutation($i: ServiceDomainCreateInput!) { serviceDomainCreate(input: $i) { domain } }', { i: { serviceId: t.service, environmentId: t.environment, ...(d.dockerfile && { targetPort: d.port }) } })).serviceDomainCreate.domain;
    const id: string = (await rw(ctx, acc, 'mutation($s: String!, $e: String!) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e) }', { s: t.service, e: t.environment })).serviceInstanceDeployV2;
    await until(ctx, 'Railway', async () => {
      const state: string = (await rw(ctx, acc, 'query($id: String!) { deployment(id: $id) { status } }', { id })).deployment.status;
      if (/FAILED|CRASHED|REMOVED/.test(state)) throw new Unit7Error('build_failed', `Railway couldn’t put it live: ${state.toLowerCase()}.`, 502, { logTail: (await lines(ctx, acc, t, id).catch(() => [])).slice(-40).join('\n') });
      return { state: state.toLowerCase(), done: state === 'SUCCESS' ? true : undefined };
    });
    return { url: `https://${domain}`, project: `${t.project}/${t.environment}/${t.service}`, deployment: id, autoDeploy: true, point: { railway: { accountId: acc, ...t } }, notes: keptIn(p, repo) };
  },
  logs: (ctx, r) => lines(ctx, r.place.accountId!, target(r), r.deployment),
  async env(ctx, r, op) {
    const acc = r.place.accountId!, t = target(r);
    if (op.set?.length) await railway.setEnv(ctx, acc, t, op.set);
    for (const name of op.unset ?? []) await rw(ctx, acc, 'mutation($i: VariableDeleteInput!) { variableDelete(input: $i) }', { i: { projectId: t.project, environmentId: t.environment, serviceId: t.service, name } });
    return Object.keys(await railway.variables(ctx, acc, t)).filter((k) => !k.startsWith('RAILWAY_')).map((key) => ({ key }));
  },
});
