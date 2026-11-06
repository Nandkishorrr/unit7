// Coolify, on a server you own. Its API takes no files, so a folder goes through a private GitHub repo first, which also
// gives you history and rollbacks. Every step is an ordinary Unit7 tool, so the gate decides each one.
import { all } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { execute, type Ctx } from '../tools/runtime.ts';
import { createRepo, githubToken, pushFolder, repoExists, type Repo } from '../connectors/github.ts';
import { addHost, type Host, type Put } from './hosts.ts';

export async function step<T = any>(ctx: Ctx, tool: string, input: Record<string, unknown>): Promise<T> {
  const r = await execute(ctx.app, ctx.orgId, ctx.actor, tool, input, { reason: 'a step of putting a site live', signal: ctx.signal, conversationId: ctx.conversationId, underApproval: ctx.approvalId });
  if (r.status === 'ok') return r.output as T;
  if (r.status === 'approval_required') throw new Unit7Error('approval_required', `${tool} is waiting on the Approvals page. Run this again once it’s approved.`, 409, { approvalId: r.approvalId });
  // nested: that run already noted any trouble on its own account, so whoever called it doesn't pin it on one of theirs
  throw new Unit7Error(r.status === 'error' ? r.error.code : 'denied', r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : `${tool} didn’t run.`, 409, { nested: true });
}

// a private repo holding this site, new or updated
export async function repoFor(ctx: Ctx, p: Put): Promise<{ repo: Repo; branch: string }> {
  if (p.site.repo) return { repo: p.site.repo, branch: p.site.branch ?? 'main' };
  const token = await githubToken(ctx);
  if (!token) throw new Unit7Error('no_account', 'This host builds from a GitHub repo, and GitHub isn’t connected yet. Connect it in Connections, then run this again.', 400);
  ctx.progress('Saving your code in a private GitHub repo…');
  const had = p.update ? await repoExists(token, p.name) : undefined;
  const repo = had ?? await createRepo(token, p.name, { private: true });
  await pushFolder(p.site.files, repo, token, { branch: 'main', message: p.update ? 'Update from Unit7' : 'First version, from Unit7', existing: !!had });
  return { repo, branch: 'main' };
}

const buildOf = (p: Put) => {
  const d = p.site.detection;
  if (d.dockerfile) return { buildPack: 'dockerfile' };
  if (d.builder === 'compose') return { buildPack: 'dockercompose' };
  if (d.stack === 'static') return { buildPack: 'static', port: 80 };
  // a site that builds to plain files has no start of its own: serve what it built
  if (d.staticDir && !d.startCommand) return { buildPack: 'nixpacks', port: 3000, startCommand: `npx --yes serve -s ${d.staticDir} -l 3000` };
  return { buildPack: 'nixpacks', port: d.port };
};

export const coolifyHost: Host = addHost({
  id: 'coolify', name: 'Coolify on your server', builds: true,
  places: (ctx) => all<{ id: string; name: string; server_id: string; srv: string }>(ctx.db, `SELECT a.id, a.name, s.id server_id, s.name srv FROM accounts a JOIN servers s ON s.org_id = a.org_id AND a.provider = 'coolify' AND a.status != 'failing' AND json_extract(a.meta, '$.serverId') = s.id WHERE a.org_id = ?`, ctx.orgId)
    .map((a) => ({ host: 'coolify', accountId: a.id, serverId: a.server_id, label: `Coolify on ${a.srv}` })),
  fit: (site) => ({ ok: true, best: !!site.detection.dockerfile || site.detection.builder === 'compose' || !!site.detection.needs.length, why: 'It runs on your own server, so it costs nothing extra and any app works.' }),
  async put(ctx, p) {
    const serverId = p.place.serverId!;
    const { repo, branch } = await repoFor(ctx, p);
    ctx.progress('Creating the app in Coolify…');
    const pj = await step(ctx, 'coolify.create_project', { serverId, name: p.name, environment: 'production' });
    const app = await step(ctx, 'coolify.create_app', { serverId, project: pj.project, environment: 'production', name: p.name, repo: `${repo.owner}/${repo.name}`, branch, ...buildOf(p), ...(p.domain && { domains: [p.domain] }), deploy: !p.env.length, reuse: true });
    if (app.reused && !p.update) throw new Unit7Error('already_exists', `Coolify already has an app called ${p.name} in that project. Choose another name, or say you want to update it.`, 409);
    for (const e of p.env) await step(ctx, 'coolify.envs', { serverId, uuid: app.uuid, kind: 'application', op: 'set', key: e.key, value: e.value });
    if (p.env.length) await step(ctx, 'coolify.control', { serverId, uuid: app.uuid, kind: 'application', action: 'deploy' });
    else if (p.update) await step(ctx, 'coolify.control', { serverId, uuid: app.uuid, kind: 'application', action: 'deploy' });
    const url = app.domains?.[0] ? `https://${String(app.domains[0]).replace(/^https?:\/\//, '')}` : '';
    return { url, project: app.uuid, notes: [`The code is in the private repo ${repo.owner}/${repo.name}.`, ...(url ? [] : ['Coolify gave it no address yet. Add a domain to reach it.'])], autoDeploy: false };
  },
  logs: async (ctx, r) => (await step<{ lines?: string[] }>(ctx, 'coolify.logs', { serverId: r.place.serverId, uuid: r.project, kind: 'application', lines: 200 })).lines ?? [],
});
