// Heroku: an app, the code as a source blob, a build, and Heroku releases it by itself. A second app can start from what a first one
// runs: a built version (a slug) can be released to another app. devcenter.heroku.com/articles/platform-api-reference and
// build-and-release-using-the-api (2026-11). Heroku has no free dynos, so a person starts this.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packFolder } from '../connectors/folder.ts';
import { HEROKU_API, heroku, herokuAuth } from '../connectors/hosts.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { accountsOf, addHost, type Host, type Put } from './hosts.ts';
import { cleanCopy, parts, send, taken, textOf, until, type Sent } from './kit.ts';

const LANGUAGES = new Set(['node', 'python', 'go', 'ruby', 'php', 'java']);
const NAME = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const call = async (ctx: Ctx, acc: string, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  send(`${HEROKU_API()}${path}`, { ...o, headers: { ...(await herokuAuth(ctx, acc)), ...o.headers } });
function refused(what: string, r: Sent) {
  const why = String(r.data?.message ?? r.status);
  if (r.status === 401) return new Unit7Error('provider_refused', 'Heroku refused this token (unauthorized). Check it in Connections.', 401);
  if (r.status === 402 || /verif|payment|credit card/i.test(why)) return new Unit7Error('payment_needed', `Heroku wants a payment method first: ${why}. Add one at https://dashboard.heroku.com/account/billing, then run this again.`, 402);
  return new Unit7Error('heroku_error', `Heroku refused to ${what}: ${why}`, r.status === 403 ? 403 : 502);
}

const buildLines = async (ctx: Ctx, acc: string, app: string, id: string) => {
  const url = (await call(ctx, acc, `/apps/${app}/builds/${id}`)).data?.output_stream_url;
  return url ? (await textOf(url)).replaceAll('\0', '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-200) : [];
};

// the code as Heroku wants it: a .tgz of only what may leave this computer, with a Procfile saying how to start it
async function source(p: Put) {
  const d = p.site.detection, copy = cleanCopy(p.site);
  try {
    if (d.startCommand && !existsSync(join(copy.dir, 'Procfile'))) writeFileSync(join(copy.dir, 'Procfile'), `web: ${d.startCommand}\n`);
    return await packFolder(copy.dir, undefined, { keepBuild: true });
  } finally { copy.done(); }
}
async function build(ctx: Ctx, acc: string, app: string, p: Put) {
  ctx.progress('Sending the code to Heroku…');
  const blob = await call(ctx, acc, '/sources', { body: {} });
  if (blob.status >= 400) throw refused('take the code', blob);
  const sent = await send(blob.data.source_blob.put_url, { method: 'PUT', raw: await source(p) });
  if (sent.status >= 400) throw new Unit7Error('heroku_error', `Heroku’s storage wouldn’t take the code (${sent.status}). Run this again.`, 502);
  const made = await call(ctx, acc, `/apps/${app}/builds`, { body: { source_blob: { url: blob.data.source_blob.get_url, version: 'unit7' } } });
  if (made.status >= 400) throw refused('start the build', made);
  const id = String(made.data.id);
  await until(ctx, 'Heroku', async () => {
    const b = await call(ctx, acc, `/apps/${app}/builds/${id}`), state = String(b.data?.status ?? 'pending');
    if (b.status >= 400) throw refused('say how the build is going', b);
    if (state === 'failed') throw new Unit7Error('build_failed', 'Heroku couldn’t build it.', 502, { logTail: (await buildLines(ctx, acc, app, id).catch(() => [])).slice(-40).join('\n') });
    return { state, done: state === 'succeeded' ? true : undefined };
  });
  return id;
}
async function copy(ctx: Ctx, acc: string, app: string, from: string) {
  const rel = await call(ctx, acc, `/apps/${from}/releases`, { headers: { range: 'version ..; order=desc,max=10' } });
  if (rel.status >= 400) throw refused(`read ${from}`, rel);
  const rows = rel.data as { current?: boolean; slug?: { id: string } | null }[], slug = (rows.find((r) => r.current && r.slug) ?? rows.find((r) => r.slug))?.slug?.id;
  if (!slug) throw new Unit7Error('nothing_live', `${from} has no built version to copy.`, 409);
  const made = await call(ctx, acc, `/apps/${app}/releases`, { body: { slug, description: `Copied from ${from} by Unit7` } });
  if (made.status >= 400) throw refused(`release what ${from} runs`, made);
}

export const herokuHost: Host = addHost({
  id: 'heroku', name: 'Heroku', builds: true, noCode: true, envNow: true,
  costs: 'Heroku has no free apps: Eco is $5 a month and Basic is $7.',
  places: (ctx) => accountsOf(ctx, 'heroku', 'heroku'),
  fit(site) {
    const d = site.detection;
    if (site.copyOf) return { ok: true, why: 'Heroku starts a second app from what that one runs.' };
    if (site.image) return { ok: false, why: 'Heroku builds from code. Give it the code, or a copy of an app already on Heroku (copyOf).' };
    if (d.dockerfile || d.builder === 'compose') return { ok: false, why: 'Heroku builds from code by itself. A Dockerfile needs a heroku.yml, which Unit7 doesn’t set up.' };
    if (d.builder === 'static') return { ok: false, why: 'Heroku runs apps. A plain website belongs on a host for websites.' };
    if (!LANGUAGES.has(d.runtime ?? '')) return { ok: false, why: `Heroku has no build for this ${d.stack} app. Add a Dockerfile and use a host that runs one.` };
    return { ok: true, why: 'Heroku builds it and keeps it running.' };
  },
  async put(ctx, p) {
    const acc = p.place.accountId!;
    if (!NAME.test(p.name)) throw new Unit7Error('invalid_input', 'A Heroku app name starts with a letter and has 3 to 30 letters, digits and dashes. Choose another.', 400);
    let app = await call(ctx, acc, `/apps/${p.name}`);
    if (app.status === 401) throw refused('read the app', app);
    if (app.status < 400 && !p.update) throw taken('Heroku', p.name);
    if (app.status >= 400) {
      ctx.progress('Creating the app on Heroku…');
      app = await call(ctx, acc, '/apps', { body: { name: p.name } });
      if (app.status === 422 && /taken/i.test(String(app.data?.message))) throw new Unit7Error('name_taken', `The name ${p.name} is taken on Heroku, and names there are shared by everyone. Choose another.`, 409);
      if (app.status >= 400) throw refused('create the app', app);
    }
    if (p.env.length) await heroku.setEnv(ctx, acc, p.name, p.env);
    const deployment = p.site.copyOf ? (await copy(ctx, acc, p.name, p.site.copyOf), undefined) : await build(ctx, acc, p.name, p);
    // a new app can come up with its web process at zero
    const form = await call(ctx, acc, `/apps/${p.name}/formation`);
    if (Array.isArray(form.data) && form.data.some((f: { type: string; quantity: number }) => f.type === 'web' && !f.quantity)) await call(ctx, acc, `/apps/${p.name}/formation`, { method: 'PATCH', body: { updates: [{ type: 'web', quantity: 1 }] } });
    return { url: String(app.data.web_url ?? '').replace(/\/$/, ''), project: p.name, deployment, point: { heroku: { accountId: acc, app: p.name } }, notes: p.site.copyOf ? [`It runs what ${p.site.copyOf} runs, without its settings or add-ons. Give it test keys with live.env.`] : [] };
  },
  async logs(ctx, r) {
    const acc = r.place.accountId!, app = parts(r.project)[0]!;
    if (r.deployment) return buildLines(ctx, acc, app, parts(r.deployment)[0]!);
    return (await heroku.recentLines(ctx, acc, app, new Date(Date.now() - 3600_000))).map((l) => l.text);
  },
  async env(ctx, r, op) {
    const acc = r.place.accountId!, app = parts(r.project)[0]!;
    if (op.set?.length) await heroku.setEnv(ctx, acc, app, op.set);
    if (op.unset?.length) { const gone = await call(ctx, acc, `/apps/${app}/config-vars`, { method: 'PATCH', body: Object.fromEntries(op.unset.map((k) => [k, null])) }); if (gone.status >= 400) throw refused('remove a setting', gone); }
    return Object.keys(await heroku.env(ctx, acc, app)).map((key) => ({ key }));
  },
});
