// AWS Amplify, first deploy, over its REST API with a signed-in AWS CLI or a key that has the rights. Finished files go as a .zip
// (CreateDeployment, StartDeployment: no GitHub needed). Code that still needs a build goes through a GitHub repo, and Amplify's GitHub
// app has to be installed on it first, in a browser (docs.aws.amazon.com/amplify/latest/userguide/setting-up-GitHub-access.html).
// docs.aws.amazon.com/amplify/latest/APIReference (2026-11): CreateApp, CreateBranch, CreateDeployment, StartDeployment, GetJob, UpdateApp.
import { aws, awsCall, awsOps, tag } from '../connectors/aws.ts';
import { githubToken } from '../connectors/github.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { repoFor } from './coolify.ts';
import { accountsOf, addHost, type Host, type Put } from './hosts.ts';
import { finished, keptIn, parts, publicFiles, send, taken, textOf, until, zipOf } from './kit.ts';

const NEEDS = ['amplify:CreateApp', 'amplify:CreateBranch', 'amplify:CreateDeployment', 'amplify:StartDeployment', 'amplify:StartJob', 'amplify:GetJob'];
const FRAMEWORK: Record<string, string> = { next: 'Next.js - SSR', nuxt: 'Nuxt', vite: 'Web', react: 'React', angular: 'Angular', astro: 'Astro' };
const NOT_ALLOWED = `This AWS sign-in can’t create on Amplify. It needs ${NEEDS.join(', ')}.`;
const am = async <T = any>(ctx: Ctx, acc: string, region: string, path: string, body?: unknown) =>
  JSON.parse(await awsCall(ctx, acc, { host: `amplify.${region}.amazonaws.com`, region, service: 'amplify', path, ...(body !== undefined && { body }) })
    .catch((e: Unit7Error) => { throw e.status === 403 && /authori[sz]ed|denied/i.test(e.message) ? new Unit7Error('no_rights', NOT_ALLOWED, 403) : e; })) as T;

const regionOf = (team?: string) => {
  if (team && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(team)) throw new Unit7Error('invalid_input', 'On AWS, team is the region, like eu-west-1.', 400);
  return team ?? 'us-east-1';
};

async function lines(ctx: Ctx, acc: string, region: string, app: string, branch: string, job?: string) {
  const id = job ?? (await awsOps.amplifyJobs(ctx, acc, region, app, branch))[0]?.jobId;
  if (!id) return [];
  const { job: j } = await am<{ job: { steps?: { logUrl?: string }[] } }>(ctx, acc, region, `/apps/${app}/branches/${encodeURIComponent(branch)}/jobs/${id}`);
  const logs = await Promise.all((j.steps ?? []).filter((s) => s.logUrl).map((s) => textOf(s.logUrl!)));
  return logs.join('\n').split('\n').filter(Boolean).slice(-200);
}
const wait = (ctx: Ctx, acc: string, region: string, app: string, branch: string, job: string) => until(ctx, 'Amplify', async () => {
  const state = (await awsOps.amplifyJob(ctx, acc, region, app, branch, job)).status ?? 'PENDING';
  if (state === 'FAILED' || state === 'CANCELLED') throw new Unit7Error('build_failed', `Amplify couldn’t put it live: ${state.toLowerCase()}.`, 502, { logTail: (await lines(ctx, acc, region, app, branch, job).catch(() => [])).slice(-40).join('\n') });
  return { state: state.toLowerCase(), done: state === 'SUCCEED' ? true : undefined };
});

// a person's file-only app: its files as a .zip with index.html at the top
async function sendZip(ctx: Ctx, acc: string, region: string, app: string, branch: string, p: Put) {
  const dep = await am<{ jobId: string; zipUploadUrl: string }>(ctx, acc, region, `/apps/${app}/branches/${encodeURIComponent(branch)}/deployments`, {});
  ctx.progress('Sending the files to Amplify…');
  const up = await send(dep.zipUploadUrl, { method: 'PUT', raw: zipOf(publicFiles(p.site)) });
  if (up.status >= 400) throw new Unit7Error('provider_error', `Amplify’s storage wouldn’t take the files (${up.status}). Run this again.`, 502);
  await am(ctx, acc, region, `/apps/${app}/branches/${encodeURIComponent(branch)}/deployments/start`, { jobId: dep.jobId });
  return dep.jobId;
}

export const amplifyHost: Host = addHost({
  id: 'amplify', name: 'AWS Amplify', builds: true,
  costs: 'AWS bills what the site uses: storage, visits and any build minutes.',
  places: (ctx) => accountsOf(ctx, 'amplify', 'aws'),
  fit(site) {
    const d = site.detection;
    if (d.dockerfile || d.builder === 'compose') return { ok: false, why: 'Amplify doesn’t run Docker. Your own server does.' };
    if (!finished(site) && d.builder !== 'static' && d.stack !== 'next') return { ok: false, why: `Amplify hosts websites, not an always-on ${d.stack} server.` };
    return { ok: true, why: finished(site) ? 'It serves finished files with HTTPS and a free address, and needs no GitHub.' : 'It builds from GitHub, once Amplify’s GitHub app is on the repo.' };
  },
  // IAM answers for a user (a pasted key). A role or an SSO sign-in can't be asked, so the real call says
  async rights(ctx, place) {
    const acc = place.accountId!, { arn } = await aws.whoami(ctx, acc);
    if (!arn.includes(':user/')) return undefined;
    const said = await Promise.all(NEEDS.map(async (action) => tag(await awsCall(ctx, acc, { host: 'iam.amazonaws.com', region: 'us-east-1', service: 'iam', query: { Action: 'SimulatePrincipalPolicy', Version: '2010-05-08', PolicySourceArn: arn, 'ActionNames.member.1': action } }), 'EvalDecision') === 'allowed' ? undefined : action));
    const lacks = said.filter(Boolean);
    return lacks.length ? `This AWS key can’t create on Amplify: it lacks ${lacks.join(', ')}. Add those to the user, or sign in with the AWS CLI on this Mac and connect that.` : undefined;
  },
  async put(ctx, p) {
    const acc = p.place.accountId!, region = regionOf(p.team), d = p.site.detection, files = finished(p.site);
    const env = Object.fromEntries(p.env.map((e) => [e.key, e.value]));
    const had = (await aws.amplifyApps(ctx, acc, region)).find((a) => a.name === p.name);
    if (had && !p.update) throw taken('Amplify', p.name);
    let app = had?.appId, domain = had?.defaultDomain, branch = had?.productionBranch?.branchName ?? 'main', job: string, notes: string[] = [];
    const linked = !!app && !!(await awsOps.amplifyApp(ctx, acc, region, app)).repository, plain = !!files && !linked;
    if (plain && p.env.length) throw new Unit7Error('no_settings', 'These are finished files, so settings can’t reach them. Build them in, then run this again.', 400);
    if (plain) {
      publicFiles(p.site); // before anything is made
      if (!app) {
        ctx.progress('Creating the app on Amplify…');
        const made = (await am(ctx, acc, region, '/apps', { name: p.name, platform: 'WEB' })).app;
        app = made.appId as string; domain = made.defaultDomain;
        await am(ctx, acc, region, `/apps/${app}/branches`, { branchName: branch, stage: 'PRODUCTION' });
      }
      job = await sendZip(ctx, acc, region, app!, branch, p);
    } else {
      const { repo, branch: from } = await repoFor(ctx, p);
      branch = from; notes = keptIn(p, repo);
      if (!app) {
        ctx.progress('Creating the app on Amplify…');
        const made = (await am(ctx, acc, region, '/apps', { name: p.name, repository: `https://github.com/${repo.owner}/${repo.name}`, accessToken: await githubToken(ctx), platform: d.stack === 'next' ? 'WEB_COMPUTE' : 'WEB', environmentVariables: env })
          .catch((e: Error) => { if (e.message === NOT_ALLOWED) throw e; throw new Unit7Error('repo_unreachable', `Amplify can’t reach ${repo.owner}/${repo.name}: ${e.message.slice(0, 160)}. Install its GitHub app once at https://github.com/apps/aws-amplify-${region}/installations/new and give it that repo. The GitHub token needs the admin:repo_hook scope. Then run this again.`, 400); })).app;
        app = made.appId as string; domain = made.defaultDomain;
        await am(ctx, acc, region, `/apps/${app}/branches`, { branchName: branch, stage: 'PRODUCTION', enableAutoBuild: true, ...(FRAMEWORK[d.stack] && { framework: FRAMEWORK[d.stack] }) });
      }
      job = (await awsOps.amplifyStart(ctx, acc, region, app!, branch, { jobType: 'RELEASE', jobReason: 'From Unit7' })).jobId;
    }
    await wait(ctx, acc, region, app!, branch, job);
    return { url: `https://${branch}.${domain}`, project: `${region}/${app}`, deployment: job, autoDeploy: !plain, point: 'Add your domain in the Amplify console, under Hosting. Unit7 can’t point domains at Amplify yet.', notes };
  },
  async logs(ctx, r) {
    const acc = r.place.accountId!, [region, app] = parts(r.project, 2) as [string, string];
    return lines(ctx, acc, region, app, (await awsOps.amplifyApp(ctx, acc, region, app)).productionBranch?.branchName ?? 'main', r.deployment && parts(r.deployment)[0]);
  },
  // these reach a build, so a site made from finished files never sees them
  async env(ctx, r, op) {
    const acc = r.place.accountId!, [region, app] = parts(r.project, 2) as [string, string];
    const vars = (await am<{ app: { environmentVariables?: Record<string, string> } }>(ctx, acc, region, `/apps/${app}`)).app.environmentVariables ?? {};
    for (const key of op.unset ?? []) delete vars[key];
    for (const e of op.set ?? []) vars[e.key] = e.value;
    if (op.set?.length || op.unset?.length) await am(ctx, acc, region, `/apps/${app}`, { environmentVariables: vars });
    return Object.keys(vars).map((key) => ({ key }));
  },
});
