// A place a site can go. Each host says what it takes and does one job: put these files or this repo live. Tools in
// src/tools/live.ts do the rest (what is it, is it safe to publish, which host), so adding a host is one small file.
import type { Ctx } from '../tools/runtime.ts';
import { all, id, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import type { Detection } from '../connectors/detect.ts';
import type { Site, SiteFile } from './source.ts';

export interface Place { host: string; accountId?: string; serverId?: string; label: string }
export interface Fit { ok: boolean; why: string; best?: boolean }
export interface Put { name: string; site: Site; place: Place; env: { key: string; value: string; secret: boolean }[]; domain?: string; update: boolean; team?: string; port?: number }
// point: what domain.point takes for this app, in words what to do instead, or false when the domain is already the site itself
export interface Placed { url: string; project: string; deployment?: string; dashboard?: string; notes?: string[]; autoDeploy?: boolean; point?: Record<string, unknown> | string | false }
export interface Ref { place: Place; project: string; deployment?: string }
export interface Host {
  id: string; name: string;
  // takes finished files as they are, or builds them there
  builds: boolean;
  // starts from a ready image or a copy of an app of its own, with no code
  noCode?: boolean;
  // going live here can cost money, in words: an AI never starts these, and a person names them
  costs?: string;
  // a new setting reaches the running app by itself, with no build
  envNow?: boolean;
  places(ctx: Pick<Ctx, 'db' | 'orgId'>): Place[];
  fit(site: Site): Fit;
  // what this sign-in lacks to create here, in words; nothing when it can, or when that can't be told
  rights?(ctx: Ctx, place: Place): Promise<string | undefined>;
  put(ctx: Ctx, p: Put): Promise<Placed>;
  logs?(ctx: Ctx, r: Ref): Promise<string[]>;
  env?(ctx: Ctx, r: Ref, op: { set?: { key: string; value: string; secret: boolean }[]; unset?: string[] }): Promise<{ key: string }[]>;
}

export const accountsOf = (ctx: Pick<Ctx, 'db' | 'orgId'>, host: string, provider: string): Place[] =>
  all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM accounts WHERE org_id = ? AND provider = ? AND status != 'failing' ORDER BY name`, ctx.orgId, provider)
    .map((a) => ({ host, accountId: a.id, label: a.name }));

const hosts = new Map<string, Host>();
export const addHost = (h: Host) => { hosts.set(h.id, h); return h; };
export const allHosts = () => [...hosts.values()];
export const hostOf = (id: string) => hosts.get(id);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// finished files read no settings: what they need was fixed when they were built
export const NO_SETTINGS = 'These are finished files, so they can’t read settings: what the site needs was fixed when it was built. Set them before you build it.';

// A server that also keeps built pages isn't a plain website: publishing the pages alone would leave its server behind.
export const runsServer = (d: Detection) => (!!d.runtime && d.runtime !== 'node') || ['express', 'fastify', 'hono', 'nest'].includes(d.stack) || (d.stack === 'node' && !!d.startCommand);

// What a host with no build of its own publishes: a plain site as it is, or what a build left in dist, build or out,
// with paths from that folder. Frameworks keep a public folder of source files, so it only counts on a plain site.
export function finished(site: Site): { dir: string; files: SiteFile[] } | undefined {
  const d = site.detection;
  if (d.dockerfile || d.builder === 'compose' || runsServer(d)) return undefined;
  const has = (dir: string) => site.files.some((f) => f.path === (dir === '.' ? 'index.html' : `${dir}/index.html`));
  const plain = d.stack === 'static';
  const dir = plain && has('.') ? '.' : [...(plain ? ['public', 'site', '_site'] : [d.staticDir]), 'dist', 'build', 'out'].find((x) => x && has(x)) ?? (plain ? '.' : undefined);
  if (!dir) return undefined;
  return { dir, files: dir === '.' ? site.files : site.files.filter((f) => f.path.startsWith(`${dir}/`)).map((f) => ({ ...f, path: f.path.slice(dir.length + 1) })) };
}

// The same, for a put: live.put only stops a plain site for keys, and built files are just as public on these hosts
export function published(site: Site) {
  const out = finished(site);
  if (!out) throw new Unit7Error('wrong_host', 'This site has no finished files to publish.', 400);
  const keys = site.secrets.filter((s) => out.dir === '.' || s.file.startsWith(`${out.dir}/`));
  if (keys.length) throw new Unit7Error('keys_in_site', `Stopped: these files would put secret keys on the internet: ${keys.slice(0, 5).map((s) => `${s.file} (${s.kinds.join(', ')})`).join('; ')}. Take them out, build it again, then run this again.`, 400);
  return out;
}

// fit for a host that only takes finished files: why not, and what would work instead
export function fitFinished(site: Site, name: string, why: string, build = ''): Fit {
  const d = site.detection;
  if (finished(site)) return { ok: true, why };
  if (d.dockerfile || d.builder === 'compose') return { ok: false, why: `${name} doesn’t run Docker. Your own server or Coolify does.` };
  if (runsServer(d)) return { ok: false, why: `${name} only serves finished web pages, not an always-on ${d.stack} app. Your own server or Coolify runs it.` };
  if (d.stack === 'unknown') return { ok: false, why: `${name} serves web pages, and Unit7 can’t find any here. It needs an index.html. Your own server can run other kinds of app.` };
  return { ok: false, why: `${name} takes finished files, and this has to be built first. Run ${d.buildCommand ?? 'its build'} and put the result live with its ${d.staticDir ?? 'dist'} folder, or use Vercel, Coolify or your own server, which build it for you.${build}` };
}

// An update that can be taken back: change.undo (Undo in Activity) puts the version before it live again, through what
// the host registers in CHANGE_UNDO under this verb
export function keepUndo(ctx: Ctx, verb: string, project: string, summary: string, undo: Record<string, unknown>) {
  const changeId = id('chg');
  run(ctx.db, 'INSERT INTO changes (id, org_id, server_id, part, verb, summary, undo, status, actor) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)', changeId, ctx.orgId, project, verb, summary, JSON.stringify({ steps: [], ...undo }), 'done', ctx.actor.name);
  ctx.emit('change.made', `${summary}. It can be undone.`, { resource: project, data: { changeId, part: project, undo: 'change.undo' } });
  return `change.undo with changeId ${changeId} puts the version before this one back.`;
}
