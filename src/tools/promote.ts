// "Promote Staging to Production": the version an app runs in one environment (usually Staging) goes to the same app in
// another (usually Production) through the normal zero-downtime deploy: built from the same commit (or the same image or
// upload), tested, health-checked beside the live version, then switched. The old one stays ready for Roll back.
import { z } from 'zod';
import { defineTool, getTool, type Ctx } from './runtime.ts';
import { get, json } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { fid } from './helpers.ts';
import type { ServiceConfig, Source } from '../deploy/deployer.ts';
import type { Assessment } from '../policy.ts';

type Svc = { id: string; name: string; slug: string; project_id: string; environment_id: string; current_deployment_id: string | null; config: string; env: string; env_kind: string };
const svcOf = (ctx: Ctx, id: string) => get<Svc>(ctx.db, `SELECT s.id, s.name, s.slug, s.project_id, s.environment_id, s.current_deployment_id, s.config, e.name env, e.kind env_kind
  FROM services s JOIN environments e ON e.id = s.environment_id WHERE s.id = ? AND s.org_id = ?`, id, ctx.orgId);

// what the from-app runs now, and where it goes: the same app (same slug) in the target environment of the same project
export function promotePlan(ctx: Ctx, i: { fromServiceId: string; serviceId?: string }) {
  const from = svcOf(ctx, i.fromServiceId);
  if (!from) throw new Unit7Error('not_found', 'That app was not found.', 404);
  const twin = i.serviceId ?? get<{ id: string }>(ctx.db, `SELECT s.id FROM services s JOIN environments e ON e.id = s.environment_id
    WHERE s.project_id = ? AND s.slug = ? AND e.kind = 'production' AND s.id != ? AND s.org_id = ?`, from.project_id, from.slug, from.id, ctx.orgId)?.id;
  const to = twin ? svcOf(ctx, twin) : undefined;
  if (!to) throw new Unit7Error('no_target', `${from.name} has no copy in Production yet. Add it to Production first (Make a test copy works the other way round).`, 409);
  if (to.id === from.id) throw new Unit7Error('invalid_input', 'Pick two different environments.');
  if (to.project_id !== from.project_id) throw new Unit7Error('invalid_input', `${to.name} is in another project, so Unit7 won’t promote into it.`);
  const dep = from.current_deployment_id ? get<{ number: number; status: string; source: string; plan: string }>(ctx.db, 'SELECT number, status, source, plan FROM deployments WHERE id = ?', from.current_deployment_id) : undefined;
  if (!dep || dep.status !== 'live') throw new Unit7Error('nothing_live', `Nothing is live in ${from.env} for ${from.name} yet, so there’s nothing to promote. Deploy it there first.`, 409);
  const commit = json<{ commit?: string }>(dep.plan, {}).commit;
  const ran = json<Source | null>(dep.source, null) ?? json<ServiceConfig>(from.config, {}).source;
  if (!ran) throw new Unit7Error('no_source', `Unit7 doesn’t know what ${from.name} in ${from.env} was built from, so it can’t promote it.`, 409);
  // a git app keeps its own source (repo, branch, sign-in) and only builds that commit: a later deploy still follows its branch
  const mine = json<ServiceConfig>(to.config, {}).source;
  if (ran.type === 'git' && mine?.type === 'git' && mine.repo.replace(/\/\/[^@]+@/, '//') !== ran.repo) throw new Unit7Error('different_repo', `${to.name} in ${to.env} builds from another repository than ${from.env}, so Unit7 won’t swap it. Deploy it from its own repo instead.`, 409);
  const source: Source = ran.type === 'git' && mine?.type === 'git' ? mine : ran;
  if (source.type === 'git' && !commit) throw new Unit7Error('no_commit', `Unit7 doesn’t know which commit ${from.name} runs in ${from.env}, so it can’t ship exactly that. Deploy it there once more, then promote.`, 409);
  const live = to.current_deployment_id ? get<{ number: number }>(ctx.db, `SELECT number FROM deployments WHERE id = ? AND status = 'live'`, to.current_deployment_id)?.number : undefined;
  const what = source.type === 'git' ? `commit ${commit!.slice(0, 7)}` : source.type === 'image' ? `the image ${source.image}` : 'the same uploaded files';
  return {
    from: { serviceId: from.id, name: from.name, environment: from.env, version: dep.number },
    to: { serviceId: to.id, name: to.name, environment: to.env, version: live ?? null },
    source, ...(commit && source.type === 'git' && { commit }),
    says: `${to.name} in ${to.env} gets v${dep.number} from ${from.env} (${what}). It’s built, tested and health-checked beside the live version, then visitors switch over with no downtime; ${live ? `v${live} stays ready to roll back to` : 'it’s the first version there'}.`,
  };
}

defineTool({
  name: 'deployment.promote', title: 'Promote to Production', risk: 'destructive', action: 'deploy', timeoutMs: 25 * 60_000,
  description: 'Ship what an app runs in one environment (fromServiceId, usually Staging) to the same app in Production (serviceId, found by itself when left out): the same commit, image or upload, through the normal zero-downtime deploy (built, tested, health-checked beside the live version, then switched; the old version stays ready to roll back). A dry run says exactly what happens. New code in Production, so an AI asks a person first.',
  input: z.object({ fromServiceId: fid('svc'), serviceId: fid('svc').optional().describe('The app to promote into (its Production copy when left out)') }),
  // whatever autonomy Staging has, an AI's promote is new code in Production: a person approves it (the target may be
  // left out of the input, so the gate can't see Production from the ids alone)
  assess: () => ({ tier: 2, ask: 'Promoting puts new code live in Production, so a person approves it first.' }) as Assessment,
  dryRun: (ctx, i) => promotePlan(ctx, i),
  async run(ctx, i) {
    const p = promotePlan(ctx, i);
    ctx.progress(p.says);
    // the deploy itself, inside this already-approved action: self-heal, the release checks and the fleet all as usual
    const out = await getTool('deployment.create')!.run(ctx, { serviceId: p.to.serviceId, source: p.source, ...(p.commit && { commit: p.commit }) } as never) as Record<string, unknown>;
    ctx.emit('deployment.promoted', `${p.to.name}: v${p.from.version} from ${p.from.environment} went to ${p.to.environment}`, { resource: p.to.serviceId, data: { from: p.from, to: p.to } });
    return { ...out, promoted: { from: p.from, to: p.to } };
  },
});
