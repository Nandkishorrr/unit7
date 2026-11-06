// Redeploy, restart and roll back apps on the big clouds, from the map: Cloud Run (a new revision from the same image;
// roll back = traffic to the revision before), App Engine (a restart: its instances are replaced), Firebase Hosting
// (release the live version again; roll back = release the one before), AWS Amplify (a new build of the branch; roll
// back = the build before, again), EC2 and Lightsail (a reboot) and Azure App Service (a restart). Each goes through the
// gate with its honest tier (a restart is easy to undo; a redeploy or a rollback changes what's live and has an undo),
// and says how it's going until the provider says it's done.
// Vercel, Netlify and Render apps too: redeploy (a new build, live when it's ready) and roll back (the last good version
// before the live one, no rebuild), then a look at the live address (verified), with Undo putting back what was live.
// Railway the same. Fly.io and Heroku only roll back: a new version there comes from live.put.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { get, json } from '../db.ts';
import { assertReachable } from '../netguard.ts';
import { vercel, vercelDeploys } from '../connectors/clouds.ts';
import { flyMachines, herokuReleases, netlifyDeploys, railwayDeploys, renderDeploys, type FlyMachine } from '../connectors/hosts.ts';
import { Unit7Error } from '../errors.ts';
import type { Assessment } from '../policy.ts';
import { cloudRun, appEngine, hosting } from '../connectors/google.ts';
import { awsOps } from '../connectors/aws.ts';
import { azure, webAppPower } from '../connectors/azure.ts';

export const deployTiming = { pollMs: 5000, runMs: 6 * 60_000, buildMs: 15 * 60_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ASSET = z.string().regex(/^ast_[A-Za-z0-9_-]{12}$/, 'a map item id (ast_…)');
type Mode = 'redeploy' | 'restart' | 'rollback';
export interface CloudAsset { id: string; provider: string; kind: string; ext_id: string; name: string; account_id: string | null }
export const assetRow = (db: Ctx['db'], orgId: string, asset: string) => get<CloudAsset>(db, 'SELECT id, provider, kind, ext_id, name, account_id FROM assets WHERE id = ? AND org_id = ?', asset, orgId);

// what each kind of thing can do, in words (the buttons show only these)
export function canDo(a: Pick<CloudAsset, 'provider' | 'kind' | 'ext_id'>): { modes: Mode[]; why?: string } {
  if (a.provider === 'cloudrun') return { modes: ['redeploy', 'rollback'] };
  if (HOSTS.has(a.provider) && a.kind === 'app') return NO_REBUILD[a.provider] ? { modes: ['rollback'], why: NO_REBUILD[a.provider] } : { modes: ['redeploy', 'rollback'] };
  if (a.provider === 'appengine') return { modes: ['restart'] };
  if (a.provider === 'firebase' && a.ext_id.includes('/hosting/')) return { modes: ['redeploy', 'rollback'] };
  if (a.provider === 'amplify') return { modes: ['redeploy', 'rollback'] };
  if ((a.provider === 'ec2' || a.provider === 'lightsail') && a.kind === 'server') return { modes: ['restart'] };
  if (a.provider === 'azure' && a.ext_id.startsWith('site/')) return { modes: ['restart'] };
  if (a.provider === 'azure' && a.ext_id.startsWith('swa/')) return { modes: [], why: 'Static Web Apps rebuild from your code: push a commit, or run the GitHub workflow again. Azure has no restart for them.' };
  return { modes: [], why: 'Unit7 can’t redeploy this kind of thing yet.' };
}
const modeOf = (a: CloudAsset, m: Mode): Mode => (m === 'restart' && canDo(a).modes.includes('redeploy') && !canDo(a).modes.includes('restart') ? 'redeploy' : m);

const NO_REBUILD: Record<string, string> = {
  fly: 'Fly.io runs a ready image, so a new version goes live with live.put. Here it can roll back.',
  heroku: 'Heroku builds what it’s sent, so a new version goes live with live.put (update: true). Here it can roll back.',
};
// what else a roll back changes, said before it runs
const ROLLBACK_ALSO: Record<string, string> = {
  vercel: ' Until then, new pushes don’t go live by themselves.',
  render: ' Auto-deploys stay on, so your next push goes live again.',
  railway: ' Its settings go back too, to what that version had.',
  heroku: ' Its settings go back too, to what that version had. Add-ons and the data in them don’t change.',
  fly: ' Every machine restarts on the image before this one. Its settings don’t change.',
};
const WORDS: Record<string, string> = { vercel: 'Vercel', netlify: 'Netlify', render: 'Render', railway: 'Railway', fly: 'Fly.io', heroku: 'Heroku', cloudrun: 'Cloud Run', appengine: 'App Engine', firebase: 'Firebase Hosting', amplify: 'AWS Amplify', ec2: 'EC2', lightsail: 'Lightsail', azure: 'Azure App Service' };
function impactOf(a: CloudAsset, m: Mode, to?: string): string {
  const p = a.provider;
  if (HOSTS.has(p)) {
    if (NO_REBUILD[p] && m !== 'rollback') return NO_REBUILD[p]!;
    if (m === 'rollback' && to) return `Puts the version of ${a.name} that was live before back on ${WORDS[p]}. Nothing is rebuilt.`;
    if (m === 'rollback') return `Puts ${a.name}’s last good version before the live one back on ${WORDS[p]}. Nothing is rebuilt; Undo puts today’s back.${ROLLBACK_ALSO[p] ?? ''}`;
    return `Builds ${a.name} again on ${WORDS[p]} and puts it live when the build is ready. If the build fails, the live site doesn’t change. Undo: the version before.`;
  }
  if (m === 'restart') return p === 'ec2' || p === 'lightsail' ? `Reboots ${a.name} on ${WORDS[p]}: it’s offline for a minute or two, and keeps its disk and address.`
    : p === 'appengine' ? `Replaces ${a.name}’s instances on App Engine; with one instance it may answer slowly for a few seconds.` : `Restarts ${a.name} on ${WORDS[p] ?? p}: a few seconds offline.`;
  if (m === 'rollback') return p === 'cloudrun' ? `Sends all of ${a.name}’s traffic to the revision before the live one. Undo: redeploy.` : p === 'amplify' ? `Builds ${a.name} again from the last good build before the live one.` : `Puts ${a.name}’s previous release live again.`;
  return p === 'cloudrun' ? `Starts a new revision of ${a.name} from the same image and sends traffic to it. Undo: roll back.` : p === 'amplify' ? `Builds and deploys ${a.name}’s branch again from its latest commit.` : `Releases ${a.name}’s live version again.`;
}
const recentByAi = (db: Ctx['db'], orgId: string, asset: string) => get<{ n: number }>(db, `SELECT count(*) n FROM audit WHERE org_id = ? AND tool = 'cloud.redeploy' AND result = 'success' AND actor_kind IN ('agent', 'token') AND created_at > ? AND json_extract(input, '$.asset') = ?`,
  orgId, new Date(Date.now() - 3600_000).toISOString(), asset)!.n;

defineTool({
  name: 'cloud.redeploy', title: 'Redeploy or restart a cloud app', risk: 'write', timeoutMs: 20 * 60_000,
  action: (i) => (i.mode === 'restart' ? 'restart_service' : i.mode === 'rollback' ? 'rollback' : 'deploy'),
  description: 'For an app on the big clouds (asset: its map item id): redeploy (Cloud Run: a new revision from the same image; Firebase Hosting: the live version released again; Amplify: a new build of the branch), restart (EC2 / Lightsail: reboot; Azure App Service: restart; App Engine: fresh instances) or rollback (Cloud Run: traffic to the revision before; Firebase Hosting: the release before; Amplify: the build before, again). Vercel, Netlify, Render and Railway apps: redeploy (a new build, live when ready) or rollback (the last good version before the live one, no rebuild; to: an exact version). Fly.io and Heroku apps: rollback only (Fly.io: every machine back on the image before this one; Heroku: the release before, as a new release). Railway and Heroku roll settings back too. Waits and says how it’s going until the provider says it’s done, then checks the live address (verified); the result’s undo puts back what was live.',
  input: z.object({ asset: ASSET, mode: z.enum(['redeploy', 'restart', 'rollback']).default('redeploy'),
    to: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'a version id').optional().describe('Vercel, Netlify, Render, Railway, Fly.io, Heroku: roll back to this exact version (Undo uses it); otherwise the last good one before the live one') }),
  assess: (c, i): Assessment => {
    const a = assetRow(c.db, c.orgId, i.asset);
    if (!a) return { tier: 2 };
    const m = modeOf(a, i.mode);
    return { tier: m === 'restart' ? 1 : 2, recent: m === 'restart' ? recentByAi(c.db, c.orgId, a.id) : 0, impact: impactOf(a, m, i.to) };
  },
  async run(ctx, i) {
    const a = assetRow(ctx.db, ctx.orgId, i.asset);
    if (!a || !a.account_id) throw new Unit7Error('not_found', 'That isn’t on the map anymore. Refresh the map and try again.', 404);
    const can = canDo(a), mode = modeOf(a, i.mode);
    if (!can.modes.includes(mode)) throw new Unit7Error('unsupported', can.why ?? `${a.name} can’t be ${mode === 'rollback' ? 'rolled back' : `${mode}ed`} on ${WORDS[a.provider] ?? a.provider}.`, 400);
    const out = HOSTS.has(a.provider) ? await hostRun(ctx, a.account_id, a, mode, i.to) : await (RUN[a.provider]!)(ctx, a.account_id, a, mode);
    ctx.emit(mode === 'rollback' ? 'cloud.rolled_back' : 'cloud.redeployed', `${a.name} on ${WORDS[a.provider] ?? a.provider}: ${out.said}`, { severity: out.done === false ? 'info' : 'success', resource: a.id, data: { provider: a.provider } });
    const undo = HOSTS.has(a.provider) ? (out.before ? { tool: 'cloud.redeploy', input: { asset: a.id, mode: 'rollback', to: out.before } } : undefined) : mode === 'restart' || a.provider === 'firebase' && mode === 'redeploy' ? undefined : { tool: 'cloud.redeploy', input: { asset: a.id, mode: mode === 'rollback' ? 'redeploy' : 'rollback' } };
    return { name: a.name, provider: a.provider, mode, ...out, ...(undo && { undo }) };
  },
});

type Out = { said: string; done?: boolean; revision?: string; version?: string; job?: string; url?: string; before?: string; verified?: Verified };
const RUN: Record<string, (ctx: Ctx, acc: string, a: CloudAsset, mode: Mode) => Promise<Out>> = {
  async cloudrun(ctx, acc, a, mode) {
    const [p, region, name] = a.ext_id.split('/') as [string, string, string];
    const svc = await cloudRun.get(ctx, acc, p, region, name);
    let op;
    if (mode === 'rollback') {
      const live = svc.traffic?.find((t) => (t.percent ?? 0) > 0 && t.revision)?.revision ?? svc.latestReadyRevision;
      const ready = (await cloudRun.revisions(ctx, acc, svc.name)).filter((r) => r.conditions?.some((c) => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED'));
      const at = ready.findIndex((r) => r.name === live);
      const prev = ready[at + 1] ?? (at === -1 ? ready[1] : undefined);
      if (!prev) throw new Unit7Error('nothing_before', `${a.name} has no earlier working revision to go back to.`, 409);
      ctx.progress(`Sending ${a.name}’s traffic to ${prev.name.split('/').pop()}…`);
      op = await cloudRun.patch(ctx, acc, { ...svc, traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: prev.name.split('/').pop(), percent: 100 }] }, { updateMask: 'traffic' });
    } else {
      ctx.progress(`Starting a new revision of ${a.name} from the same image…`);
      op = await cloudRun.patch(ctx, acc, { ...svc, traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }] }, { forceNewRevision: true });
    }
    const end = Date.now() + deployTiming.runMs;
    while (!op.done && Date.now() < end) { await sleep(deployTiming.pollMs); op = await cloudRun.operation(ctx, acc, op.name); ctx.progress(`${a.name}: Google is still ${mode === 'rollback' ? 'moving the traffic' : 'starting the new revision'}…`); }
    if (op.error) throw new Unit7Error('provider_error', `Cloud Run: ${op.error.message ?? 'the change failed'}`, 502);
    const after = await cloudRun.get(ctx, acc, p, region, name).catch(() => svc);
    const rev = (mode === 'rollback' ? after.traffic?.find((t) => t.revision)?.revision : after.latestReadyRevision)?.split('/').pop();
    return op.done ? { said: mode === 'rollback' ? `rolled back to ${rev}` : `new revision ${rev} is live`, revision: rev } : { said: 'still starting; Google finishes it by itself', done: false };
  },
  async appengine(ctx, acc, a) {
    const [p, svcId = 'default'] = a.ext_id.split('/') as [string, string?];
    const versions = Object.keys((await appEngine.service(ctx, acc, p, svcId)).split?.allocations ?? {});
    let n = 0;
    for (const v of versions) for (const inst of await appEngine.instances(ctx, acc, p, svcId, v)) { ctx.progress(`Replacing instance ${++n} of ${a.name}…`); await appEngine.stopInstance(ctx, acc, p, svcId, v, inst.id); }
    return { said: n ? `${n} instance${n === 1 ? '' : 's'} replaced; App Engine starts fresh ones` : 'nothing was running (it starts on the next visit)' };
  },
  async firebase(ctx, acc, a, mode) {
    const site = a.ext_id.split('/hosting/')[1]!;
    const rels = (await hosting.releases(ctx, acc, site)).filter((r) => r.type !== 'SITE_DISABLE' && r.version?.name);
    const current = rels[0]?.version?.name;
    if (!current) throw new Unit7Error('nothing_live', `${a.name} has nothing released yet.`, 409);
    const pick = mode === 'rollback' ? rels.find((r) => r.version!.name !== current && r.version!.status !== 'DELETED')?.version?.name : current;
    if (!pick) throw new Unit7Error('nothing_before', `${a.name} has no earlier release to go back to.`, 409);
    ctx.progress(mode === 'rollback' ? `Putting ${a.name}’s previous release live…` : `Releasing ${a.name}’s live version again…`);
    await hosting.release(ctx, acc, site, pick, mode === 'rollback' ? 'Rolled back by Unit7' : 'Released again by Unit7');
    return { said: mode === 'rollback' ? 'the previous release is live' : 'released again', version: pick.split('/').pop() };
  },
  async amplify(ctx, acc, a, mode) {
    const [region, appId] = a.ext_id.split('/') as [string, string];
    const app = await awsOps.amplifyApp(ctx, acc, region, appId);
    const branch = app.productionBranch?.branchName;
    if (!branch) throw new Unit7Error('no_branch', `${a.name} has no production branch on Amplify yet.`, 409);
    if (!app.repository) throw new Unit7Error('unsupported', `${a.name} is deployed by hand (a zip), not from a repository, so Amplify can’t rebuild it. Upload it again in Amplify.`, 400);
    let job;
    if (mode === 'rollback') {
      const jobs = await awsOps.amplifyJobs(ctx, acc, region, appId, branch);
      const prev = jobs.slice(1).find((j) => j.status === 'SUCCEED');
      if (!prev) throw new Unit7Error('nothing_before', `${a.name} has no earlier good build to go back to.`, 409);
      ctx.progress(`Building ${a.name} again from build ${prev.jobId}…`);
      job = await awsOps.amplifyStart(ctx, acc, region, appId, branch, { jobType: 'RETRY', jobId: prev.jobId, jobReason: 'Rolled back by Unit7' });
    } else {
      ctx.progress(`Starting a new build of ${a.name} (${branch})…`);
      job = await awsOps.amplifyStart(ctx, acc, region, appId, branch, { jobType: 'RELEASE', jobReason: 'Redeployed by Unit7' });
    }
    const end = Date.now() + deployTiming.buildMs;
    let status = job.status ?? 'PENDING';
    while (!['SUCCEED', 'FAILED', 'CANCELLED'].includes(status) && Date.now() < end) {
      await sleep(deployTiming.pollMs * 2);
      status = (await awsOps.amplifyJob(ctx, acc, region, appId, branch, job.jobId)).status ?? status;
      ctx.progress(`${a.name}: ${status === 'RUNNING' ? 'building' : status === 'PROVISIONING' ? 'getting a build machine' : status.toLowerCase()}…`);
    }
    if (status === 'FAILED' || status === 'CANCELLED') throw new Unit7Error('build_failed', `Amplify’s build ${job.jobId} of ${a.name} ${status === 'FAILED' ? 'failed' : 'was cancelled'}. Its log is in the Amplify console; the live site didn’t change.`, 502);
    return status === 'SUCCEED' ? { said: mode === 'rollback' ? `the earlier build is live again (build ${job.jobId})` : `build ${job.jobId} is live`, job: job.jobId } : { said: `build ${job.jobId} is still running; Amplify finishes it by itself`, done: false, job: job.jobId };
  },
  async ec2(ctx, acc, a) {
    const [region, id] = a.ext_id.split('/') as [string, string];
    ctx.progress(`Rebooting ${a.name}…`);
    await awsOps.ec2(ctx, acc, region, id, 'reboot');
    return { said: 'rebooting; it’s back in a minute or two' };
  },
  async lightsail(ctx, acc, a) {
    const [region, name] = a.ext_id.split('/') as [string, string];
    ctx.progress(`Rebooting ${a.name}…`);
    await awsOps.lightsail(ctx, acc, region, name, 'reboot');
    return { said: 'rebooting; it’s back in a minute or two' };
  },
  async azure(ctx, acc, a) {
    ctx.progress(`Restarting ${a.name}…`);
    await webAppPower(ctx, acc, await webAppId(ctx, acc, a.ext_id), 'restart');
    return { said: 'restarted' };
  },
};

// --- Vercel, Netlify, Render, Railway, Fly.io, Heroku: one flow, each host's own calls ----------------------------------
const HOSTS = new Set(['vercel', 'netlify', 'render', 'railway', 'fly', 'heroku']);
type State = 'ready' | 'failed' | 'busy';
interface HostOps {
  live(): Promise<string | undefined>;                         // the version live now
  versions(): Promise<{ id: string; good: boolean }[]>;       // production versions, newest first; good = can go live again
  putLive(id: string, undo: boolean): Promise<string>;        // no rebuild; what to wait for (Render makes a new deploy of it)
  isLive(id: string): Promise<boolean>;                        // throws when the switch failed
  build?(): Promise<string>;                                   // a new build; its id (not on hosts in NO_REBUILD)
  state?(id: string): Promise<State>;
  ready?(id: string): Promise<void>;                           // after a good build
}
// the last good version before the live one (or, when the live one isn't listed, the newest good one that isn't it)
export function previousGood(versions: { id: string; good: boolean }[], live?: string) {
  const at = live ? versions.findIndex((v) => v.id === live) : -1;
  return (at >= 0 ? versions.slice(at + 1) : versions.filter((v) => v.id !== live)).find((v) => v.good)?.id;
}
const couldnt = (a: CloudAsset, where: string, why: string) => new Unit7Error('build_failed', `${where} couldn’t put that version of ${a.name} back (${why}). The live site didn’t change.`, 502);
function railwayOps(ctx: Ctx, acc: string, a: CloudAsset, project: string | undefined): HostOps {
  const [environment = '', service = ''] = a.ext_id.split('/');
  if (!project) throw new Unit7Error('not_found', `Unit7 doesn’t know ${a.name}’s Railway project yet. Refresh the map and try again.`, 404);
  const t = { project, environment, service }, list = () => railwayDeploys.list(ctx, acc, t);
  // a crashed one is still what's on: the version before it is the one to go back to
  const live = async () => (await list()).find((d) => ['SUCCESS', 'SLEEPING', 'CRASHED'].includes(d.status))?.id;
  return {
    live,
    versions: async () => (await list()).map((d) => ({ id: d.id, good: !!d.canRollback && !['FAILED', 'CRASHED'].includes(d.status) })),
    putLive: async (id) => (await railwayDeploys.rollback(ctx, acc, id)).id ?? id,
    isLive: async (id) => {
      const s = await railwayDeploys.status(ctx, acc, id);
      if (['FAILED', 'CRASHED'].includes(s)) throw couldnt(a, 'Railway', s.toLowerCase());
      return s === 'SUCCESS' || s === 'SLEEPING';
    },
    build: async () => {
      const id = await live() ?? (await list())[0]?.id;
      if (!id) throw new Unit7Error('nothing_live', `${a.name} has nothing deployed on Railway yet.`, 409);
      return (await railwayDeploys.redeploy(ctx, acc, id)).id;
    },
    state: async (id) => { const s = await railwayDeploys.status(ctx, acc, id); return s === 'SUCCESS' || s === 'SLEEPING' ? 'ready' : /FAILED|CRASHED|REMOVED|SKIPPED/.test(s) ? 'failed' : 'busy'; },
  };
}
const herokuOps = (ctx: Ctx, acc: string, a: CloudAsset, app: string): HostOps => ({
  live: async () => (await herokuReleases.list(ctx, acc, app)).find((r) => r.current)?.id,
  // the first release of an app has no build in it, and an old one expires
  versions: async () => (await herokuReleases.list(ctx, acc, app)).map((r) => ({ id: r.id, good: r.status === 'succeeded' && r.eligible_for_rollback !== false && !!(r.slug || r.artifacts?.length) })),
  putLive: async (id) => (await herokuReleases.rollback(ctx, acc, app, id)).id,
  isLive: async (id) => {
    const s = (await herokuReleases.get(ctx, acc, app, id)).status;
    if (s === 'failed') throw couldnt(a, 'Heroku', 'its release failed');
    return s === 'succeeded';
  },
});
function flyOps(ctx: Ctx, acc: string, a: CloudAsset, app: string): HostOps {
  const machines = async () => {
    const list = (await flyMachines.list(ctx, acc, app)).filter((m) => m.config?.image && m.state !== 'destroyed');
    if (!list.length) throw new Unit7Error('nothing_live', `${a.name} has no machine on Fly.io to roll back.`, 409);
    return list;
  };
  const imageOf = async (list: FlyMachine[], id: string) => {
    for (const m of list) { const image = (await flyMachines.versions(ctx, acc, app, m.id)).find((v) => v.version === id)?.user_config?.image; if (image) return image; }
    throw new Unit7Error('not_found', `Fly.io doesn’t keep that version of ${a.name} anymore.`, 404);
  };
  return {
    live: async () => (await machines())[0]!.instance_id,
    // a settings change is a version too, with the same image: only a different image is a version to go back to
    versions: async () => { const [m] = await machines(); return (await flyMachines.versions(ctx, acc, app, m!.id)).map((v) => ({ id: v.version, good: !!v.user_config?.image && v.user_config.image !== m!.config.image })); },
    async putLive(id) {
      const list = await machines(), image = await imageOf(list, id);
      for (const [n, m] of list.entries()) {
        if (n) await sleep(Math.min(1100, deployTiming.pollMs)); // Fly allows about one update a second
        await flyMachines.setImage(ctx, acc, app, m, image).catch((e: Error) => {
          throw n ? new Unit7Error('provider_error', `Fly.io stopped after ${n} of ${list.length} machines, so ${a.name} is running two versions: ${e.message}. Run this again with to: ${id} to finish.`, 502) : e;
        });
      }
      return image;
    },
    isLive: async (image) => {
      const list = await machines();
      if (list.some((m) => m.state === 'failed')) throw couldnt(a, 'Fly.io', 'a machine failed to start');
      return list.every((m) => m.config.image === image && ['started', 'stopped', 'suspended'].includes(m.state ?? ''));
    },
  };
}
function opsFor(ctx: Ctx, acc: string, a: CloudAsset & { meta: string }): HostOps {
  const end = json<{ end?: { team?: string; project?: string; app?: string } }>(a.meta, {}).end;
  if (a.provider === 'railway') return railwayOps(ctx, acc, a, end?.project);
  if (a.provider === 'heroku') return herokuOps(ctx, acc, a, end?.app ?? a.ext_id);
  if (a.provider === 'fly') return flyOps(ctx, acc, a, end?.app ?? a.name);
  if (a.provider === 'vercel') {
    const team = end?.team;
    const project = () => vercel.project(ctx, acc, a.ext_id, team);
    return {
      live: async () => (await project()).productionDeployment,
      versions: async () => (await vercelDeploys.list(ctx, acc, a.ext_id, team)).map((d) => ({ id: d.uid, good: (d.readyState ?? d.state) === 'READY' && d.isRollbackCandidate !== false })),
      putLive: async (id, undo) => { await (undo ? vercelDeploys.promote : vercelDeploys.rollback)(ctx, acc, a.ext_id, id, team); return id; },
      isLive: async (id) => (await project()).productionDeployment === id,
      build: async () => (await vercel.redeploy(ctx, acc, await project())).id,
      state: async (id) => { const s = (await vercelDeploys.get(ctx, acc, id, team)).readyState; return s === 'READY' ? 'ready' : s === 'ERROR' || s === 'CANCELED' ? 'failed' : 'busy'; },
      // after a rollback Vercel stops putting new production builds live by itself, so a ready one that isn't live is promoted
      ready: async (id) => { if ((await project()).productionDeployment !== id) await vercelDeploys.promote(ctx, acc, a.ext_id, id, team); },
    };
  }
  if (a.provider === 'netlify') return {
    live: () => netlifyDeploys.live(ctx, acc, a.ext_id),
    versions: async () => (await netlifyDeploys.list(ctx, acc, a.ext_id)).map((d) => ({ id: d.id, good: d.state === 'ready' })),
    putLive: async (id) => { await netlifyDeploys.restore(ctx, acc, a.ext_id, id); return id; },
    isLive: async (id) => (await netlifyDeploys.live(ctx, acc, a.ext_id)) === id,
    build: async () => { const b = await netlifyDeploys.build(ctx, acc, a.ext_id); if (!b.deploy_id) throw new Unit7Error('provider_error', 'Netlify started a build but didn’t say which deploy it is.', 502); return b.deploy_id; },
    state: async (id) => { const s = (await netlifyDeploys.get(ctx, acc, a.ext_id, id)).state; return s === 'ready' ? 'ready' : s === 'error' || s === 'rejected' ? 'failed' : 'busy'; },
  };
  const FAILED = new Set(['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed', 'deactivated']);
  return {
    live: async () => (await renderDeploys.list(ctx, acc, a.ext_id)).find((d) => d.status === 'live')?.id,
    // deactivated: it was live and something newer replaced it (a failed build never was)
    versions: async () => (await renderDeploys.list(ctx, acc, a.ext_id)).map((d) => ({ id: d.id, good: d.status === 'live' || d.status === 'deactivated' })),
    putLive: async (id) => (await renderDeploys.rollback(ctx, acc, a.ext_id, id)).id ?? id,
    isLive: async (id) => {
      const s = (await renderDeploys.get(ctx, acc, a.ext_id, id)).status ?? '';
      if (FAILED.has(s) && s !== 'deactivated') throw new Unit7Error('build_failed', `Render couldn’t put that version of ${a.name} back (${s.replace(/_/g, ' ')}). The live site didn’t change.`, 502);
      return s === 'live';
    },
    build: async () => (await renderDeploys.deploy(ctx, acc, a.ext_id)).id ?? (await renderDeploys.list(ctx, acc, a.ext_id))[0]?.id ?? '',
    state: async (id) => { const s = (await renderDeploys.get(ctx, acc, a.ext_id, id)).status ?? ''; return s === 'live' ? 'ready' : FAILED.has(s) ? 'failed' : 'busy'; },
  };
}

async function hostRun(ctx: Ctx, acc: string, a: CloudAsset, mode: Mode, to?: string): Promise<Out> {
  const row = get<{ url: string | null; meta: string }>(ctx.db, 'SELECT url, meta FROM assets WHERE id = ?', a.id)!;
  const ops = opsFor(ctx, acc, { ...a, meta: row.meta }), where = WORDS[a.provider]!;
  const before = await ops.live();
  const end = Date.now() + deployTiming.buildMs;
  let target: string;
  if (mode === 'rollback') {
    const pick = to ?? previousGood(await ops.versions(), before);
    if (!pick) throw new Unit7Error('nothing_before', `${a.name} has no earlier working version on ${where} to go back to.`, 409);
    if (pick === before) return { said: 'that version is already live', version: pick };
    target = pick;
    ctx.progress(to ? `Putting the version of ${a.name} that was live before back…` : `Putting ${a.name}’s previous version live on ${where}…`);
    const wait = await ops.putLive(target, !!to);
    let n = 0, live = await ops.isLive(wait);
    while (!live && Date.now() < end) { await sleep(deployTiming.pollMs); live = await ops.isLive(wait); if (!live && ++n % 3 === 0) ctx.progress(`${a.name}: ${where} is still switching versions…`); }
    if (!live) return { said: `${where} is still switching; it finishes by itself`, done: false, version: target, before };
  } else {
    ctx.progress(`Starting a new build of ${a.name} on ${where}…`);
    target = await ops.build!();
    let s: State = 'busy';
    while (s === 'busy' && Date.now() < end) {
      await sleep(deployTiming.pollMs);
      s = await ops.state!(target);
      ctx.progress(`${a.name}: ${s === 'busy' ? 'building' : s === 'ready' ? 'the new version is live' : 'the build failed'}…`);
    }
    if (s === 'failed') throw new Unit7Error('build_failed', `${where}’s new build of ${a.name} failed. Its log is on ${where}; the live site didn’t change.`, 502);
    if (s === 'busy') return { said: `still building; ${where} finishes it by itself`, done: false, version: target, before };
    await ops.ready?.(target);
  }
  ctx.progress(`Checking ${a.name} answers…`);
  const verified = await liveCheck(row.url);
  const said = mode === 'rollback' ? (to ? 'the version from before is live again' : 'the previous version is live') : 'the new build is live';
  return { said: verified && !verified.fixed ? `${said}, but it isn’t answering yet` : said, version: target, ...(before && before !== target && { before }), ...(verified && { verified }), ...(row.url && { url: row.url }) };
}

// After a change: does the live address answer with HTTP 2xx or 3xx? A few tries: a fresh version can take seconds.
type Verified = { fixed: boolean; still?: string; checked: string[] };
export async function liveCheck(url: string | null | undefined): Promise<Verified | undefined> {
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  let why = 'it doesn’t answer';
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(deployTiming.pollMs);
    try {
      await assertReachable(new URL(url).hostname);
      // manual: a redirect is an answer, and is never followed to an address Unit7 didn't check
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Unit7 check' } });
      void res.body?.cancel();
      if (res.status < 400) return { fixed: true, checked: [url] };
      why = `it answers with an error (HTTP ${res.status})`;
    } catch (e) { why = (e as Error).name === 'TimeoutError' ? 'no answer in 10 seconds' : 'it doesn’t answer'; }
  }
  return { fixed: false, still: `${new URL(url).hostname} isn’t working yet: ${why}.`, checked: [url] };
}

// an App Service app's resource id (the map keeps its subscription and name; the resource group comes from Azure)
export async function webAppId(ctx: Ctx, acc: string, extId: string) {
  const [, s, name] = extId.split('/') as [string, string, string];
  const site = (await azure.webApps(ctx, acc, s)).find((w) => w.name === name);
  if (!site) throw new Unit7Error('not_found', `${name} isn’t in that Azure subscription anymore.`, 404);
  return site.id;
}

// what a person can start beside an app (tools/hosted.ts): which tool, and where it goes
function addsTo(ctx: Ctx, a: CloudAsset) {
  if (a.kind !== 'app' || !a.account_id) return undefined;
  const accountId = a.account_id;
  if (a.provider === 'render') return { adds: { database: { tool: 'render.create_database', input: { accountId, into: a.ext_id } }, cron: { tool: 'render.create_cron', input: { accountId } } } };
  const end = json<{ end?: { project?: string; environment?: string; service?: string } }>(get<{ meta: string }>(ctx.db, 'SELECT meta FROM assets WHERE id = ?', a.id)?.meta, {}).end;
  return a.provider === 'railway' && end?.project ? { adds: { database: { tool: 'railway.create_database', input: { accountId, project: end.project, environment: end.environment, into: end.service } } } } : undefined;
}

// what the buttons on a cloud app offer (a database read, no provider call)
defineTool({
  name: 'cloud.app_actions', title: 'What a cloud app can do', risk: 'read', action: 'read',
  description: 'For a map item on the big clouds, Vercel, Netlify, Render, Railway, Fly.io or Heroku (asset): which of redeploy, restart and rollback cloud.redeploy can do, or why none.',
  input: z.object({ asset: ASSET }),
  run(ctx, i) {
    const a = assetRow(ctx.db, ctx.orgId, i.asset);
    if (!a) throw new Unit7Error('not_found', 'That isn’t on the map anymore.', 404);
    return { name: a.name, provider: a.provider, where: WORDS[a.provider] ?? a.provider, ...canDo(a), impact: Object.fromEntries(canDo(a).modes.map((m) => [m, impactOf(a, m)])), ...addsTo(ctx, a) };
  },
});
