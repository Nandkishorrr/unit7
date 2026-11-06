// Netlify: make the site, offer every file's SHA-1, send only what it asks for, and wait until it's ready.
//   POST /sites, POST /sites/{id}/deploys (async), PUT /deploys/{id}/files/{path}, GET /sites/{id}/deploys/{id}
// github.com/netlify/open-api, and how netlify-cli uses them. Nothing builds on this route: Netlify takes finished files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bearerFor } from '../connectors/mcp-oauth.ts';
import { rest, seg } from '../connectors/dnswrite.ts';
import { netlify, netlifyApi, netlifyDeploys, type NetlifySite } from '../connectors/hosts.ts';
import { json } from '../db.ts';
import { assertReachable } from '../netguard.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { CHANGE_UNDO } from '../tools/manage.ts';
import { NO_SETTINGS, accountsOf, addHost, fitFinished, keepUndo, published, sleep, type Host, type Put, type Ref } from './hosts.ts';
import type { SiteFile } from './source.ts';
import { liveTiming } from './vercel.ts';

const refused = (what: string) => (e: Unit7Error): never => { throw new Unit7Error('netlify_error', `Netlify refused to ${what}: ${e.message.replace(/^Netlify: /, '')}`, e.status); };
const auth = async (ctx: Ctx, acc: string) => ({ authorization: `Bearer ${await bearerFor(ctx, 'netlify', acc)}` });

async function siteFor(ctx: Ctx, acc: string, p: Put) {
  const found = (await netlify.sites(ctx, acc).catch(refused('list your sites'))).find((s) => s.name === p.name);
  // a site with nothing live is a first try that stopped half way
  if (found?.published_deploy && !p.update) throw new Unit7Error('already_exists', `${p.name} already exists on this Netlify account. Choose another name, or say you want to update it.`, 409);
  return found ?? rest<NetlifySite>('Netlify', `${netlifyApi()}/${p.team ? `${seg(p.team)}/` : ''}sites`, { headers: await auth(ctx, acc), body: { name: p.name } }).catch((e: Unit7Error) => {
    if (/unprocessable|unique|taken/i.test(e.message)) throw new Unit7Error('name_taken', `Someone else’s Netlify site is already called ${p.name}. Choose another name.`, 409);
    return refused('create the site')(e);
  });
}

async function send(ctx: Ctx, acc: string, deploy: string, f: SiteFile) {
  await assertReachable(new URL(netlifyApi()).hostname);
  const res = await fetch(`${netlifyApi()}/deploys/${deploy}/files/${f.path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT', headers: { ...await auth(ctx, acc), 'content-type': 'application/octet-stream' }, body: new Uint8Array(readFileSync(f.abs)), signal: AbortSignal.timeout(180_000),
  });
  if (res.status === 429) throw new Unit7Error('netlify_slow', 'Netlify asked Unit7 to slow down. Try again in a minute.', 429);
  if (!res.ok) throw new Unit7Error('netlify_error', `Netlify refused a file (${f.path}): ${res.statusText || res.status}`, 502);
}

async function sendAll(ctx: Ctx, acc: string, deploy: string, list: SiteFile[]) {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => { for (let f = queue.pop(); f; f = queue.pop()) await send(ctx, acc, deploy, f); }));
}

// Netlify works out what it needs first (prepared), and goes on to ready by itself once the last file is in
async function live(ctx: Ctx, acc: string, site: string, id: string, bySha: Map<string, SiteFile[]>) {
  const end = Date.now() + liveTiming.buildMs;
  let said = '', sent = false;
  while (Date.now() < end) {
    const d = await netlifyDeploys.get(ctx, acc, site, id).catch(refused('say how the upload is going'));
    if (d.state !== said) ctx.progress(`Netlify: ${(said = d.state ?? '')}`);
    if (d.state === 'ready') return;
    if (d.state === 'error') throw new Unit7Error('build_failed', `Netlify couldn’t publish it: ${d.error_message ?? 'it gave no reason'}`, 502);
    // every file with a digest it asks for: two with the same bytes are still two addresses
    if ((d.state === 'prepared' || d.state === 'uploading') && !sent) { sent = true; await sendAll(ctx, acc, id, (d.required ?? []).flatMap((sha) => bySha.get(sha) ?? [])); }
    await sleep(liveTiming.pollMs);
  }
  throw new Unit7Error('build_slow', 'Netlify is still working on it after 25 minutes. It may finish by itself: look at the site’s Deploys page.', 504);
}

const siteOf = (ctx: Ctx, r: Ref) => netlify.site(ctx, r.place.accountId!, seg(r.project)).catch(refused('find the site'));

CHANGE_UNDO['live.netlify'] = async (ctx, c) => {
  const u = json<{ accountId: string; site: string; deploy: string }>(c.undo, { accountId: '', site: '', deploy: '' });
  await netlifyDeploys.restore(ctx, u.accountId, u.site, u.deploy);
  return { restored: u.deploy };
};

export const netlifyHost: Host = addHost({
  id: 'netlify', name: 'Netlify', builds: false, price: 'Free to start, up to a monthly limit.',
  places: (ctx) => accountsOf(ctx, 'netlify', 'netlify'),
  fit: (site) => fitFinished(site, 'Netlify', 'Free, with HTTPS and a free address. It takes the finished files as they are.', ' Netlify can also build it itself once the repo is linked there, which takes one step in the browser.'),
  async put(ctx, p) {
    const acc = p.place.accountId!, { files } = published(p.site);
    ctx.progress('Getting the site ready on Netlify…');
    const site = await siteFor(ctx, acc, p);
    if (p.env.length) await netlify.setEnv(ctx, acc, site, p.env).catch(refused('save the settings'));
    const bySha = new Map<string, SiteFile[]>(), digests: Record<string, string> = {};
    for (const f of files) {
      const sha = createHash('sha1').update(readFileSync(f.abs)).digest('hex');
      digests[`/${f.path}`] = sha;
      bySha.set(sha, [...bySha.get(sha) ?? [], f]);
    }
    ctx.progress(`Sending ${files.length} file${files.length === 1 ? '' : 's'} to Netlify…`);
    const made = await rest<{ id: string }>('Netlify', `${netlifyApi()}/sites/${site.id}/deploys`, { headers: await auth(ctx, acc), body: { files: digests, async: true, draft: false } }).catch(refused('start the upload'));
    await live(ctx, acc, site.id, made.id, bySha);
    const before = site.published_deploy?.id;
    return {
      url: site.ssl_url ?? site.url ?? `https://${site.name}.netlify.app`, project: site.id, deployment: made.id, dashboard: `https://app.netlify.com/sites/${site.name}`, autoDeploy: false,
      point: { netlify: { accountId: acc, site: site.id } },
      notes: [
        ...(before ? [keepUndo(ctx, 'live.netlify', site.id, `Updated ${p.name} on Netlify`, { accountId: acc, site: site.id, deploy: before })] : []),
        ...(p.env.length ? [NO_SETTINGS] : []),
        ...(p.site.repo ? ['This went up as files, so a push won’t deploy by itself. To turn that on, link the repo in Netlify: that one step happens in the browser.'] : []),
      ],
    };
  },
  async env(ctx, r, op) {
    const acc = r.place.accountId!, site = await siteOf(ctx, r);
    if (op.set?.length) await netlify.setEnv(ctx, acc, site, op.set).catch(refused('save the settings'));
    for (const key of op.unset ?? []) await netlify.unsetEnv(ctx, acc, site, key).catch(refused('remove a setting'));
    return Object.keys(await netlify.env(ctx, acc, site)).map((key) => ({ key }));
  },
});
