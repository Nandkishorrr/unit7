// Google Cloud Run, first deploy: gcloud builds the code and starts the service in one command, and the REST way would take a
// storage upload, a build and a service create. So it needs a gcloud sign-in with rights to create; a key can't. Only a clean copy of
// the folder goes in, because gcloud sends all it's given. docs.cloud.google.com/sdk/gcloud/reference/run/deploy and
// /run/docs/deploying-source-code (2026-11). Prompts are off (cloudcli.ts), and gcloud won't switch an API on unprompted, so Unit7 does.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, isMissing } from '../connectors/cloudcli.ts';
import { cloudRun, google, googleApi, googleCred, googleLacks, gsend } from '../connectors/google.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { accountsOf, addHost, type Host } from './hosts.ts';
import { cleanCopy, one, parts, taken, until } from './kit.ts';
import { liveTiming } from './vercel.ts';

// ponytail: one region; add a choice when someone needs it closer to their visitors
const REGION = 'us-central1';
const NEEDS = ['run.services.create', 'run.services.setIamPolicy', 'cloudbuild.builds.create', 'iam.serviceAccounts.actAs', 'serviceusage.services.use'];
const APIS = ['run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com'];
const BUILDPACKS = new Set(['node', 'python', 'go', 'ruby', 'php', 'java']);

async function apisOn(ctx: Ctx, acc: string, project: string) {
  let op = await gsend<{ name: string; done?: boolean; error?: { message?: string } }>(ctx, acc, `${googleApi('serviceusage')}/v1/projects/${project}/services:batchEnable`, { body: { serviceIds: APIS }, quotaProject: project });
  await until(ctx, 'Google', async () => {
    if (!op.done) op = await gsend(ctx, acc, `${googleApi('serviceusage')}/v1/${op.name}`, { method: 'GET', quotaProject: project });
    if (op.error) throw new Unit7Error('provider_error', `Google wouldn’t switch on Cloud Run for ${project}: ${op.error.message ?? 'no reason given'}`, 502);
    return { state: 'switching on Cloud Run', done: op.done ? true : undefined };
  });
}

export const cloudRunHost: Host = addHost({
  id: 'cloudrun', name: 'Google Cloud Run', builds: true, envNow: true,
  sizes: [{ id: '512mb', label: '512 MB', price: 'Billed by use', memoryMb: 512 }, { id: '1gb', label: '1 GB', price: 'Billed by use', memoryMb: 1024 }, { id: '2gb', label: '2 GB', price: 'Billed by use', memoryMb: 2048 }],
  costs: 'Google bills by use after a free allowance, and the project needs billing turned on.',
  places: (ctx) => [...accountsOf(ctx, 'cloudrun', 'gcp'), ...accountsOf(ctx, 'cloudrun', 'firebase')],
  fit(site) {
    const d = site.detection;
    if (d.builder === 'compose') return { ok: false, why: 'Cloud Run runs one container, not a docker-compose file. Your own server does.' };
    if (d.builder === 'static') return { ok: false, why: 'Cloud Run runs servers. A plain website belongs on Firebase Hosting or another host for websites.' };
    if (!d.dockerfile && !BUILDPACKS.has(d.runtime ?? '')) return { ok: false, why: `Cloud Run can’t build this ${d.stack} app by itself. Add a Dockerfile.` };
    return { ok: true, why: 'It builds the code, runs it, and sleeps when nobody visits.' };
  },
  async rights(ctx, place) {
    const acc = place.accountId!, c = googleCred(ctx, acc);
    if (!('cli' in c) || c.cli !== 'gcloud') return 'Cloud Run builds through gcloud, and this Google connection can’t: it’s a key, or the Firebase CLI. Run gcloud auth login on this Mac, then connect that sign-in in Connections. Its account needs the Cloud Run Source Developer, Service Account User and Service Usage Consumer roles.';
    const projects = await google.projects(ctx, acc);
    const lacks = projects.length === 1 ? await googleLacks(ctx, acc, projects[0]!.projectId, NEEDS) : [];
    return lacks.length ? `This Google sign-in can’t deploy to ${projects[0]!.projectId}: it lacks ${lacks.join(', ')}. Give it the Cloud Run Source Developer, Service Account User and Service Usage Consumer roles.` : undefined;
  },
  async put(ctx, p) {
    const acc = p.place.accountId!, c = googleCred(ctx, acc) as { account?: string }, d = p.site.detection;
    if (!/^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$/.test(p.name)) throw new Unit7Error('invalid_input', 'A Cloud Run name starts with a letter and has up to 49 letters, digits and dashes. Choose another.', 400);
    const project = one('Google projects', (await google.projects(ctx, acc)).map((x) => x.projectId), p.team);
    const had = await cloudRun.get(ctx, acc, project, REGION, p.name).catch((e) => { if (isMissing(e)) return undefined; throw e; });
    if (had && !p.update) throw taken('Cloud Run', p.name);
    await apisOn(ctx, acc, project);
    const copy = cleanCopy(p.site), box = mkdtempSync(join(tmpdir(), 'unit7-env-')), file = join(box, 'env.json'); // beside the code, never in it
    try {
      // on a command line anyone on this computer could read them; JSON is YAML to gcloud
      if (p.env.length) writeFileSync(file, JSON.stringify(Object.fromEntries(p.env.map((e) => [e.key, e.value]))), { mode: 0o600 });
      ctx.progress('Google is building it. This takes a few minutes…');
      await cli('gcloud', ['run', 'deploy', p.name, '--source', copy.dir, '--project', project, '--region', REGION, '--allow-unauthenticated', '--quiet', '--format=json',
        ...(c.account ? [`--account=${c.account}`] : []), ...(p.env.length ? ['--env-vars-file', file] : []), ...(d.dockerfile ? ['--port', String(d.port)] : []), ...(p.size?.memoryMb ? ['--memory', `${p.size.memoryMb}Mi`] : [])], liveTiming.buildMs);
    } catch (e) {
      if (/billing/i.test((e as Error).message)) throw new Unit7Error('payment_needed', `Cloud Run needs billing turned on for ${project}: https://console.cloud.google.com/billing/linkedaccount?project=${project}. Then run this again.`, 402);
      throw e;
    } finally { copy.done(); rmSync(box, { recursive: true, force: true }); }
    const svc = await cloudRun.get(ctx, acc, project, REGION, p.name);
    return { url: String(svc.uri ?? ''), project: `${project}/${REGION}/${p.name}`, point: 'Map your domain in the Cloud Run console. Unit7 can’t point domains at Cloud Run yet.', notes: [`It runs in ${REGION}.`] };
  },
  async logs(ctx, r) {
    const [project, , service] = parts(r.project, 3);
    const out = await gsend<{ entries?: { textPayload?: string; jsonPayload?: { message?: string } }[] }>(ctx, r.place.accountId!, `${googleApi('logging')}/v2/entries:list`, { quotaProject: project, body: {
      resourceNames: [`projects/${project}`], filter: `resource.type="cloud_run_revision" AND resource.labels.service_name="${service}"`, orderBy: 'timestamp desc', pageSize: 100 } });
    return (out.entries ?? []).map((e) => e.textPayload ?? e.jsonPayload?.message ?? '').filter(Boolean).reverse();
  },
  // a new revision with the new settings; values stay readable by anyone who can see the project, which is how Cloud Run keeps them
  async env(ctx, r, op) {
    const acc = r.place.accountId!, [project, region, name] = parts(r.project, 3) as [string, string, string];
    const svc = await cloudRun.get(ctx, acc, project, region, name);
    const box = (svc.template as { containers: { env?: { name: string; value?: string }[] }[] }).containers[0]!;
    const gone = new Set([...(op.unset ?? []), ...(op.set ?? []).map((e) => e.key)]);
    if (gone.size) {
      box.env = [...(box.env ?? []).filter((e) => !gone.has(e.name)), ...(op.set ?? []).map((e) => ({ name: e.key, value: e.value }))];
      let o = await cloudRun.patch(ctx, acc, svc);
      await until(ctx, 'Cloud Run', async () => {
        if (!o.done) o = await cloudRun.operation(ctx, acc, o.name);
        if (o.error) throw new Unit7Error('provider_error', `Cloud Run: ${o.error.message ?? 'the change failed'}`, 502);
        return { state: 'starting a new revision', done: o.done ? true : undefined };
      });
    }
    return (box.env ?? []).map((e) => ({ key: e.name }));
  },
});
