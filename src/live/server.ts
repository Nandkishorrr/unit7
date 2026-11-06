// Your own server, without Coolify: Unit7's own deploy. Each step is an ordinary Unit7 tool, so the gate decides each one,
// and a step that waited for a person can be run again: what's already made is reused. A folder or upload goes up packed
// from the files source.ts checked, never as it came: the original can hold keys that were left out.
import { all, get, run } from '../db.ts';
import { packFiles, saveUpload } from '../connectors/folder.ts';
import { Unit7Error } from '../errors.ts';
import type { Source } from '../deploy/deployer.ts';
import type { Ctx } from '../tools/runtime.ts';
import { step } from './coolify.ts';
import { addHost, OWN_PRICE, OWN_SIZES, type Host, type Put } from './hosts.ts';

async function productionOf(ctx: Ctx, name: string) {
  const had = get<{ id: string }>(ctx.db, `SELECT e.id FROM environments e JOIN projects p ON p.id = e.project_id WHERE p.org_id = ? AND p.name = ? AND e.kind = 'production'`, ctx.orgId, name);
  if (had) return had.id;
  const made = await step<{ environments: { id: string; kind: string }[] }>(ctx, 'project.create', { name, environments: ['production'] });
  return made.environments.find((e) => e.kind === 'production')!.id;
}

async function sourceOf(ctx: Ctx, p: Put): Promise<Source> {
  if (p.site.repo) return { type: 'git', repo: `${p.site.repo.owner}/${p.site.repo.name}`, ...(p.site.branch && { branch: p.site.branch }) };
  ctx.progress('Packing your files…');
  return { type: 'upload', uploadId: saveUpload(ctx.app, ctx.orgId, ctx.actor.userId, await packFiles(p.site.dir, p.site.files.map((f) => f.path))) };
}

export const serverHost: Host = addHost({
  id: 'server', name: 'Your own server', builds: true, price: OWN_PRICE, sizes: OWN_SIZES, pushes: true, tunes: true,
  // a server with Coolify connected builds through Coolify, which has its own place
  places: (ctx) => all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM servers s WHERE org_id = ? AND status = 'ready' AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = s.org_id AND a.provider = 'coolify' AND json_extract(a.meta, '$.serverId') = s.id) ORDER BY name`, ctx.orgId)
    .map((s) => ({ host: 'server', serverId: s.id, label: s.name })),
  fit(site) {
    const d = site.detection;
    if (d.builder === 'compose') return { ok: false, why: 'This runs from a compose file, which Unit7’s own deploy doesn’t read. Coolify on your server does, or add a Dockerfile.' };
    if (d.stack === 'unknown') return { ok: false, why: 'Unit7 can’t tell how to build this. Add a Dockerfile, or an index.html for a plain website.' };
    return { ok: true, best: !!d.dockerfile || !!d.needs.length, why: 'It runs on your own server.' };
  },
  async put(ctx, p) {
    const environmentId = await productionOf(ctx, p.name);
    const had = get<{ id: string; current_deployment_id: string | null }>(ctx.db, 'SELECT id, current_deployment_id FROM services WHERE environment_id = ? AND name = ?', environmentId, p.name);
    const live = !!had?.current_deployment_id;
    if (live && !p.update) throw new Unit7Error('already_exists', `${p.name} already runs on your server. Choose another name, or say you want to update it.`, 409);
    // a service made on an earlier try already holds its source
    const source = had && !live ? undefined : await sourceOf(ctx, p);
    const serviceId = had?.id ?? (await step<{ serviceId: string }>(ctx, 'service.create', { environmentId, name: p.name, serverId: p.place.serverId, source })).serviceId;
    const { staticDir: _, ...tuned } = p.tuned ?? {}, how = { ...tuned, ...(p.size?.memoryMb && { memoryMb: p.size.memoryMb }) };
    if (Object.keys(how).length) await step(ctx, 'service.settings', { serviceId, ...how });
    for (const e of p.env) await step(ctx, 'env.set', { serviceId, key: e.key, value: e.value, secret: e.secret });
    const fresh = live && source?.type === 'upload' ? { source } : {};
    const d = await step<{ deploymentId: string; url?: string; previousDeploymentId?: string }>(ctx, 'deployment.create', { serviceId, ...fresh });
    // or a plain redeploy later would build the upload the service started with
    if (fresh.source) run(ctx.db, `UPDATE services SET config = json_set(config, '$.source', json(?)) WHERE id = ?`, JSON.stringify(fresh.source), serviceId);
    return {
      url: d.url ?? '', project: serviceId, deployment: d.deploymentId, autoDeploy: !!p.site.repo, point: { serviceId },
      notes: d.previousDeploymentId ? [`deployment.rollback with serviceId ${serviceId} and deploymentId ${d.previousDeploymentId} puts the version before this one back.`] : [],
    };
  },
  logs: async (ctx, r) => (await step<{ lines?: string[] }>(ctx, 'deployment.logs', r.deployment ? { deploymentId: r.deployment } : { serviceId: r.project, lines: 200 })).lines ?? [],
  async env(ctx, r, op) {
    for (const e of op.set ?? []) await step(ctx, 'env.set', { serviceId: r.project, key: e.key, value: e.value, secret: e.secret });
    for (const key of op.unset ?? []) await step(ctx, 'env.unset', { serviceId: r.project, key });
    return (await step<{ variables: { key: string }[] }>(ctx, 'env.list', { serviceId: r.project })).variables.map((v) => ({ key: v.key }));
  },
});
