// Cloudflare Pages, Direct Upload: hashes first, only what's missing sent, then a deployment that names every file.
//   POST /accounts/{id}/pages/projects, GET …/{name}/upload-token, POST /pages/assets/check-missing, upload, upsert-hashes,
//   POST …/{name}/deployments (multipart). Cloudflare's reference gives the paths but not the bodies or the hash, so those
//   are wrangler's (workers-sdk: packages/wrangler/src/pages/upload.ts, src/api/pages/deploy.ts), matched without its WASM.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { cf, cloudflare } from '../connectors/cloudflare.ts';
import { seg } from '../connectors/dnswrite.ts';
import { json } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { CHANGE_UNDO } from '../tools/manage.ts';
import { pagesHash } from './blake3.ts';
import { NO_SETTINGS, accountsOf, addHost, finished, fitFinished, keepUndo, published, sleep, type Host, type Put } from './hosts.ts';
import type { SiteFile } from './source.ts';
import { liveTiming } from './vercel.ts';

const MB = 1024 * 1024;
// wrangler's limits: 25 MiB a file, 40 MiB or 2,000 files a request
const MAX_FILE = 25 * MB, MAX_BUCKET = 40 * MB, MAX_BUCKET_FILES = 2000;
// Pages serves a file with the type it was uploaded with, so without one a page would download instead of opening
const TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', map: 'application/json', txt: 'text/plain', xml: 'application/xml',
  webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
};
// settings files Pages reads from the deployment itself, not as pages of the site. _routes.json only steers Functions
const SETTINGS = new Set(['_headers', '_redirects', '_routes.json']);

const refused = (what: string) => (e: Unit7Error): never => {
  // a token made before Pages can still edit DNS, so the account stays good and only needs a new key for this
  if (e.status === 403) throw new Unit7Error('cloudflare_rights', 'Your Cloudflare token can’t publish sites yet. In Connections, add a new Cloudflare key: the button pre-fills the right permissions.', 403);
  throw new Unit7Error('cloudflare_error', `Cloudflare refused to ${what}: ${e.message.replace(/^Cloudflare: /, '')}`, e.status);
};
const base = (cid: string, name: string) => `/accounts/${cid}/pages/projects/${seg(name)}`;

async function projectFor(ctx: Ctx, acc: string, cid: string, p: Put) {
  const found = await cf(ctx, acc, base(cid, p.name)).catch((e: Unit7Error) => (e.status === 404 ? undefined : refused('find the project')(e)));
  // a project with nothing live is a first try that stopped half way
  if (found?.latest_deployment && !p.update) throw new Unit7Error('already_exists', `${p.name} already exists on this Cloudflare account. Choose another name, or say you want to update it.`, 409);
  return found ?? cf(ctx, acc, `/accounts/${cid}/pages/projects`, { body: { name: p.name, production_branch: 'main' } }).catch(refused('create the project'));
}

async function upload(ctx: Ctx, acc: string, cid: string, name: string, files: { hash: string; file: SiteFile }[]) {
  // a fresh upload token each time: they run out, and a big site takes a while
  const jwt = async () => (await cf(ctx, acc, `${base(cid, name)}/upload-token`).catch(refused('open an upload'))).jwt as string;
  const hashes = [...new Set(files.map((f) => f.hash))];
  const missing = new Set(await cf(ctx, acc, '/pages/assets/check-missing', { jwt: await jwt(), body: { hashes } }).catch(refused('check the files')) as string[]);
  let bucket: typeof files = [], size = 0;
  const flush = async () => {
    if (!bucket.length) return;
    ctx.progress(`Sending ${bucket.length} file${bucket.length === 1 ? '' : 's'} to Cloudflare…`);
    const body = bucket.map(({ hash, file }) => ({ key: hash, value: readFileSync(file.abs).toString('base64'), metadata: { contentType: TYPES[extname(file.path).slice(1).toLowerCase()] ?? 'application/octet-stream' }, base64: true }));
    await cf(ctx, acc, '/pages/assets/upload', { jwt: await jwt(), body, timeoutMs: 180_000 }).catch(refused('take the files'));
    bucket = []; size = 0;
  };
  // ponytail: one bucket at a time; wrangler sends three at once, so run them side by side if big sites feel slow
  for (const f of files) {
    if (!missing.delete(f.hash)) continue;
    if (bucket.length >= MAX_BUCKET_FILES || size + f.file.size > MAX_BUCKET) await flush();
    bucket.push(f); size += f.file.size;
  }
  await flush();
  // only makes the next deploy quicker: wrangler carries on when this fails too
  await cf(ctx, acc, '/pages/assets/upsert-hashes', { jwt: await jwt(), body: { hashes } }).catch(() => undefined);
}

async function live(ctx: Ctx, acc: string, cid: string, name: string, id: string) {
  const end = Date.now() + liveTiming.buildMs;
  let said = '';
  while (Date.now() < end) {
    const s = (await cf(ctx, acc, `${base(cid, name)}/deployments/${seg(id)}`).catch(refused('say how the deployment is going'))).latest_stage as { name?: string; status?: string } | undefined;
    const state = s?.status ?? '';
    if (state !== said) ctx.progress(`Cloudflare: ${(said = state)}`);
    if (state === 'failure' || state === 'canceled') throw new Unit7Error('build_failed', `Cloudflare couldn’t publish it (the ${s?.name} step ended with ${state}). Its log is in live.logs.`, 502);
    if (s?.name === 'deploy' && state === 'success') return;
    await sleep(liveTiming.pollMs);
  }
  throw new Unit7Error('build_slow', 'Cloudflare is still working on it after 25 minutes. It may finish by itself: look at the project’s page there.', 504);
}

const secretsFor = (set: { key: string; value: string; secret: boolean }[] = [], unset: string[] = []) => ({
  deployment_configs: { production: { env_vars: { ...Object.fromEntries(set.map((e) => [e.key, { type: e.secret ? 'secret_text' : 'plain_text', value: e.value }])), ...Object.fromEntries(unset.map((k) => [k, null])) } } },
});

CHANGE_UNDO['live.pages'] = async (ctx, c) => {
  const u = json<{ accountId: string; project: string; deployment: string }>(c.undo, { accountId: '', project: '', deployment: '' });
  await cf(ctx, u.accountId, `${base(await cloudflare.accountOf(ctx, u.accountId), u.project)}/deployments/${seg(u.deployment)}/rollback`, { method: 'POST' });
  return { restored: u.deployment };
};

export const pagesHost: Host = addHost({
  id: 'cloudflare-pages', name: 'Cloudflare Pages', builds: false, price: 'Free for plain sites, with no limit on visitors.',
  places: (ctx) => accountsOf(ctx, 'cloudflare-pages', 'cloudflare'),
  fit(site) {
    const files = finished(site)?.files ?? [];
    if (files.some((f) => /^(_worker\.js(\/|$)|functions\/)/.test(f.path))) return { ok: false, why: 'This site has its own Cloudflare code (_worker.js or a functions folder), which wrangler has to bundle. Run wrangler pages deploy for it, or use Vercel or your own server.' };
    const big = files.find((f) => f.size > MAX_FILE);
    if (big) return { ok: false, why: `Cloudflare Pages takes files up to 25 MB, and ${big.path} is bigger. Host it elsewhere and link to it, or use Netlify or your own server.` };
    return fitFinished(site, 'Cloudflare Pages', 'Free, with HTTPS and a free address. It takes the finished files as they are.');
  },
  async put(ctx, p) {
    const acc = p.place.accountId!, { files } = published(p.site);
    ctx.progress('Getting the project ready on Cloudflare…');
    const cid = await cloudflare.accountOf(ctx, acc).catch(refused('say which account this token belongs to'));
    const project = await projectFor(ctx, acc, cid, p);
    if (p.env.length) await cf(ctx, acc, base(cid, p.name), { method: 'PATCH', body: secretsFor(p.env) }).catch(refused('save the settings'));
    const pages = files.filter((f) => !SETTINGS.has(f.path)).map((file) => ({ file, hash: pagesHash(readFileSync(file.abs), file.path) }));
    await upload(ctx, acc, cid, p.name, pages);
    const form = new FormData();
    form.set('manifest', JSON.stringify(Object.fromEntries(pages.map((f) => [`/${f.file.path}`, f.hash]))));
    form.set('branch', project.production_branch ?? 'main');
    for (const f of files) if (f.path === '_headers' || f.path === '_redirects') form.set(f.path, new File([readFileSync(f.abs)], f.path));
    const made = await cf(ctx, acc, `${base(cid, p.name)}/deployments`, { form, timeoutMs: 120_000 }).catch(refused('start the deployment'));
    await live(ctx, acc, cid, p.name, made.id);
    const before = project.canonical_deployment?.id as string | undefined;
    return {
      url: `https://${project.subdomain ?? `${p.name}.pages.dev`}`, project: p.name, deployment: made.id, dashboard: `https://dash.cloudflare.com/${cid}/pages/view/${p.name}`, autoDeploy: false,
      point: { pages: { accountId: acc, project: p.name } },
      notes: [
        ...(before ? [keepUndo(ctx, 'live.pages', p.name, `Updated ${p.name} on Cloudflare Pages`, { accountId: acc, project: p.name, deployment: before })] : []),
        ...(p.env.length ? [NO_SETTINGS] : []),
        ...(p.site.repo ? ['This project takes uploads, and Cloudflare can’t turn it into one that deploys on push later. For that, connect the repo in Cloudflare as a new project: it takes one step in the browser.'] : []),
      ],
    };
  },
  async logs(ctx, r) {
    const acc = r.place.accountId!, path = base(await cloudflare.accountOf(ctx, acc).catch(refused('say which account this token belongs to')), r.project);
    const id = r.deployment ?? (await cf(ctx, acc, `${path}/deployments?per_page=1`).catch(refused('list its deployments')))[0]?.id;
    if (!id) return [];
    const got = await cf(ctx, acc, `${path}/deployments/${seg(id)}/history/logs`).catch(refused('share the log'));
    return (got.data ?? []).map((l: { line: string }) => l.line);
  },
  async env(ctx, r, op) {
    const acc = r.place.accountId!, path = base(await cloudflare.accountOf(ctx, acc).catch(refused('say which account this token belongs to')), r.project);
    if (op.set?.length || op.unset?.length) await cf(ctx, acc, path, { method: 'PATCH', body: secretsFor(op.set, op.unset) }).catch(refused('save the settings'));
    return Object.keys((await cf(ctx, acc, path).catch(refused('find the project'))).deployment_configs?.production?.env_vars ?? {}).map((key) => ({ key }));
  },
});
