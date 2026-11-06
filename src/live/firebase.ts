// Firebase Hosting takes finished files: a version, the list of hashes, what it doesn't have yet, finalize, release. It builds
// nothing, and it needs a service account key or a gcloud sign-in, never a plain token. firebase.google.com/docs/hosting/api-deploy
// (2026-11). A gcloud sign-in is billed to a quota project; a service account uses its own (google.ts).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { google, googleApi, googleCred, googleLacks, googleToken, gsend, lastPart } from '../connectors/google.ts';
import { isMissing } from '../connectors/cloudcli.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { accountsOf, addHost, type Host } from './hosts.ts';
import { finished, one, send, taken } from './kit.ts';

const API = () => `${googleApi('firebasehosting')}/v1beta1`;
const NEEDS = ['firebasehosting.sites.create', 'firebasehosting.sites.update'];
const quotaOf = (ctx: Ctx, acc: string, project: string) => ('cli' in googleCred(ctx, acc) ? project : undefined);

async function upload(ctx: Ctx, acc: string, url: string, want: string[], byHash: Map<string, string>, quota?: string) {
  const headers = { authorization: `Bearer ${await googleToken(ctx, acc)}`, 'content-type': 'application/octet-stream', ...(quota && { 'x-goog-user-project': quota }) }, queue = [...want];
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (let hash = queue.pop(); hash; hash = queue.pop()) {
      const r = await send(`${url}/${hash}`, { raw: gzipSync(readFileSync(byHash.get(hash)!)), headers });
      if (r.status >= 400) throw new Unit7Error('firebase_error', `Firebase wouldn’t take a file: ${r.data?.error?.message ?? r.status}`, 502);
    }
  }));
}

export const firebaseHost: Host = addHost({
  id: 'firebase', name: 'Firebase Hosting', builds: false,
  places: (ctx) => [...accountsOf(ctx, 'firebase', 'firebase'), ...accountsOf(ctx, 'firebase', 'gcp')],
  fit: (site) => (finished(site)
    ? { ok: true, why: 'It serves finished files fast, with HTTPS and a free address.' }
    : { ok: false, why: site.detection.staticDir ? `Firebase Hosting only takes finished files, and there’s no built ${site.detection.staticDir} folder here. Build it first, or pick a host that builds.` : `Firebase Hosting serves websites, not an always-on ${site.detection.stack} server.` }),
  async rights(ctx, place) {
    const acc = place.accountId!, c = googleCred(ctx, acc);
    if ('cli' in c && c.cli !== 'gcloud') return 'This Firebase sign-in comes from the Firebase CLI, which Unit7 only reads with. Connect a gcloud sign-in (run gcloud auth login, then Google Cloud in Connections) or a service account key with the Firebase Hosting Admin role.';
    const projects = await google.projects(ctx, acc);
    const lacks = projects.length === 1 ? await googleLacks(ctx, acc, projects[0]!.projectId, NEEDS) : [];
    return lacks.length ? `This Google sign-in can only read Firebase Hosting: it lacks ${lacks.join(', ')}. Give it the Firebase Hosting Admin role, or connect a gcloud sign-in that has it.` : undefined;
  },
  async put(ctx, p) {
    const acc = p.place.accountId!, site = p.name, files = finished(p.site)!;
    if (p.env.length) throw new Unit7Error('no_settings', 'Firebase Hosting serves finished files, so settings can’t reach them. Build them in, then run this again.', 400);
    if (site.length > 30) throw new Unit7Error('invalid_input', 'A Firebase site name has up to 30 letters, digits and dashes. Choose a shorter one.', 400);
    const project = one('Google projects', (await google.projects(ctx, acc)).map((x) => x.projectId), p.team), quotaProject = quotaOf(ctx, acc, project);
    const g = (path: string, o: { method?: string; body?: unknown } = {}) => gsend(ctx, acc, `${API()}${path}`, { ...o, quotaProject });
    const sites = await g(`/projects/${project}/sites`, { method: 'GET' }).catch((e) => { if (isMissing(e)) throw new Unit7Error('no_firebase', `Firebase isn’t turned on for ${project}. Add it at https://console.firebase.google.com, then run this again.`, 404); throw e; });
    const had = ((sites.sites ?? []) as { name: string }[]).some((s) => lastPart(s.name) === site);
    if (had && !p.update) throw taken('Firebase Hosting', site);
    if (!had) await g(`/projects/${project}/sites?siteId=${encodeURIComponent(site)}`, { body: {} }).catch((e: Error) => { throw new Unit7Error('name_taken', `Firebase wouldn’t make a site called ${site}: ${e.message.slice(0, 200)}. Site names are shared by everyone on Firebase, so try another.`, 409); });
    ctx.progress(`Sending ${files.length} file${files.length === 1 ? '' : 's'} to Firebase…`);
    const version: string = (await g(`/sites/${site}/versions`, { body: {} })).name;
    const byHash = new Map<string, string>(), list = files.map((f) => { const hash = createHash('sha256').update(gzipSync(readFileSync(f.abs))).digest('hex'); byHash.set(hash, f.abs); return [`/${f.path}`, hash] as const; });
    for (let at = 0; at < list.length; at += 1000) { // a call takes 1,000 hashes, and each adds to the version
      const r = await g(`/${version}:populateFiles`, { body: { files: Object.fromEntries(list.slice(at, at + 1000)) } });
      if (r.uploadRequiredHashes?.length) await upload(ctx, acc, r.uploadUrl, r.uploadRequiredHashes, byHash, quotaProject);
    }
    await g(`/${version}?update_mask=status`, { method: 'PATCH', body: { status: 'FINALIZED' } });
    await g(`/sites/${site}/releases?versionName=${encodeURIComponent(version)}`, { body: { message: 'From Unit7' } });
    return { url: `https://${site}.web.app`, project: site, deployment: lastPart(version), point: 'Add your domain in the Firebase console, under Hosting. Unit7 can’t point domains at Firebase Hosting yet.' };
  },
});
