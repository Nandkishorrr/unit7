// What goes live: a folder a person picked, an upload (`unit7 live`, a dropped ZIP) or a repo. Each becomes a plain folder, so a
// host only ever reads files. What must never leave this computer stays out here, whichever host it's going to.
import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { get } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { detectSecrets, redact } from '../redact.ts';
import type { Ctx } from '../tools/runtime.ts';
import { HEAVY, checkFolder, factsOf } from '../connectors/folder.ts';
import { detect, type Detection } from '../connectors/detect.ts';
import { cloneUrl, githubAuthEnv, githubBase, githubToken, parseRepo, type Repo } from '../connectors/github.ts';
import { sysBin } from '../connectors/shell.ts';

const exec = promisify(execFile);
export interface SiteFile { path: string; abs: string; size: number }
export interface Site {
  dir: string; name: string; detection: Detection; files: SiteFile[]; bytes: number; home?: string;
  secrets: { file: string; kinds: string[] }[]; repo?: Repo; branch?: string; uploadId?: string;
  image?: string; copyOf?: string; // no code: a ready image, or a copy of an app already on the host
  done(): void; // removes what Unit7 unpacked; a person's own folder is left alone
}

const NEVER = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.npmrc|\.netrc|\.git-credentials|\.pgpass|credentials(\.json)?|\.DS_Store|\._.*)$/i;
const EXAMPLE = /^\.env\.(example|sample|template)$/i;
const TEXT = /\.(html?|css|js|mjs|cjs|jsx|ts|tsx|vue|svelte|astro|json|ya?ml|toml|ini|txt|md|py|rb|php|go|sh|map)$/i;
const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte|astro|py|rb|php|go)$/i;
const BUILT = /(^|\/)(dist|build|out|public|vendor)\//;
const TESTS = /(^|\/)(tests?|__tests__|fixtures?|e2e|cypress)\/|\.(test|spec)\.[a-z]+$/i;
// public on purpose: a Supabase public key and a Firebase web key belong in a website
const PUBLIC_BY_DESIGN = new Set(['jwt', 'google key']);
export const LIMITS = { files: 20_000, bytes: 1024 ** 3, scan: 512 * 1024, sample: 2 * 1024 ** 2 };

// by its path alone, what never goes into a site: a heavy folder, or a file that must not leave this computer
export function leftOut(path: string) {
  const parts = path.split('/'), file = parts.at(-1)!;
  return parts.slice(0, -1).some((p) => HEAVY.has(p)) || (NEVER.test(file) && !EXAMPLE.test(file));
}

export function walk(dir: string, sub = '', out: SiteFile[] = []): SiteFile[] {
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const path = sub ? `${sub}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue; // never follows a link out of the folder
    if (e.isDirectory()) { if (!HEAVY.has(e.name)) walk(dir, path, out); continue; }
    if (!e.isFile() || (NEVER.test(e.name) && !EXAMPLE.test(e.name))) continue;
    if (out.length >= LIMITS.files) throw new Unit7Error('too_large', `That folder has more than ${LIMITS.files} files. Leave out what the site doesn’t need.`, 413);
    out.push({ path, abs: join(dir, path), size: lstatSync(join(dir, path)).size });
  }
  return out;
}

// keys in files about to go on the internet. Test files are full of fake ones.
export function secretsIn(files: SiteFile[]) {
  const out: Site['secrets'] = [];
  for (const f of files) {
    if (f.size > LIMITS.scan || !TEXT.test(f.path) || TESTS.test(f.path)) continue;
    const kinds = detectSecrets(readFileSync(f.abs, 'utf8')).filter((k) => !PUBLIC_BY_DESIGN.has(k));
    if (kinds.length) out.push({ file: f.path, kinds });
  }
  return out;
}

// the settings a site reads are in its code: a file listing and package.json can't say
function readsOf(files: SiteFile[]) {
  let sourceSample = '';
  for (const f of files) {
    if (sourceSample.length > LIMITS.sample) break;
    if (f.size <= LIMITS.scan && CODE.test(f.path) && !BUILT.test(f.path) && !TESTS.test(f.path)) sourceSample += `${readFileSync(f.abs, 'utf8')}\n`;
  }
  const example = files.find((f) => EXAMPLE.test(f.path));
  return { sourceSample, ...(example && { envExample: readFileSync(example.abs, 'utf8').slice(0, 8192) }) };
}

// A little about a project, for the guide: its README's start, its description and page title, and its top-level names. Never its code.
export function aboutOf(site: Site) {
  const at = (name: RegExp) => site.files.find((f) => name.test(f.path) && f.size <= LIMITS.scan);
  const read = (f?: SiteFile) => (f ? readFileSync(f.abs, 'utf8') : '');
  let pkg: { name?: string; description?: string; dependencies?: Record<string, unknown> } = {};
  try { pkg = JSON.parse(read(at(/^package\.json$/)) || '{}'); } catch { /* a broken one says nothing */ }
  const page = read(at(/^index\.html?$/i)).slice(0, 8192);
  const title = /<title[^>]*>([^<]{1,200})/i.exec(page)?.[1]?.trim(), meta = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})/i.exec(page)?.[1]?.trim();
  return {
    said: pkg.description || meta || title,
    brief: redact([
      `Name: ${pkg.name ?? site.name}`, `Unit7 detected: ${site.detection.stack}`, title && `Page title: ${title}`, (pkg.description || meta) && `Description: ${pkg.description || meta}`,
      pkg.dependencies && `Packages: ${Object.keys(pkg.dependencies).slice(0, 30).join(', ')}`,
      `Top-level files: ${[...new Set(site.files.map((f) => f.path.split('/')[0]))].slice(0, 40).join(', ')}`,
      `README start:\n${read(at(/^readme(\.\w+)?$/i)).slice(0, 1500)}`,
    ].filter(Boolean).join('\n')),
  };
}

export const siteName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52) || 'my-site';

// A plain site with no index.html: hosts open index.html first, so the home page goes up under that name too. Only ever in a copy of the
// code: a repo or an upload is one already, and a person's own folder is copied, so nothing of theirs changes.
function addHome(dir: string, home: string, ours: boolean) {
  let at = dir;
  if (!ours) { at = mkdtempSync(join(tmpdir(), 'unit7-live-')); cpSync(dir, at, { recursive: true, filter: (from) => !lstatSync(from).isSymbolicLink() && !leftOut(relative(dir, from)) }); }
  copyFileSync(join(at, home), join(at, dirname(home), 'index.html'));
  return at;
}

function open(dir: string, name: string, done: () => void, extra: Partial<Site> & { own?: boolean } = {}): Site {
  const { own, ...more } = extra;
  try {
    const files = walk(dir), bytes = files.reduce((n, f) => n + f.size, 0);
    if (!files.length) throw new Unit7Error('empty_site', 'There are no files to put live in that.', 400);
    if (bytes > LIMITS.bytes) throw new Unit7Error('too_large', 'That is more than 1 GB. Leave out what the site doesn’t need, like videos or old builds.', 413);
    const detection = detect({ ...factsOf(dir), ...readsOf(files) }), { pages } = detection;
    if (more.home && !pages?.includes(more.home)) throw new Unit7Error('invalid_input', pages ? `${more.home} isn’t a page in this site.` : 'This site already has its own home page.', 400);
    const home = more.home ?? detection.home;
    if (!home) return { dir, name: siteName(name), detection, files, bytes, secrets: secretsIn(files), done, ...more };
    const at = addHome(dir, home, !own), full = walk(at);
    return { dir: at, name: siteName(name), detection, files: full, bytes, secrets: secretsIn(full), done: own ? () => { rmSync(at, { recursive: true, force: true }); done(); } : done, ...more, home };
  } catch (e) { done(); throw e; }
}

export interface SourceInput { folder?: string; uploadId?: string; repo?: string; branch?: string; image?: string; copyOf?: string; home?: string }
export async function openSource(ctx: Pick<Ctx, 'app' | 'db' | 'orgId' | 'signal'> & Partial<Ctx>, i: SourceInput, name?: string): Promise<Site> {
  if (i.image || i.copyOf) return { dir: '', name: siteName(name ?? (i.copyOf ? `${i.copyOf}-copy` : basename(i.image!).split(/[:@]/)[0]!)), detection: detect({ files: [], manifests: {} }), files: [], bytes: 0, secrets: [], image: i.image, copyOf: i.copyOf, done: () => undefined };
  if (i.folder) { const dir = checkFolder(i.folder, ctx.app.home); return open(dir, name ?? basename(dir), () => undefined, { own: true, home: i.home }); }
  const tmp = mkdtempSync(join(tmpdir(), 'unit7-live-')), done = () => rmSync(tmp, { recursive: true, force: true });
  try {
    if (i.uploadId) {
      const up = get<{ path: string }>(ctx.db, 'SELECT path FROM uploads WHERE id = ? AND org_id = ?', i.uploadId, ctx.orgId);
      if (!up) throw new Unit7Error('not_found', 'That upload was not found.', 404);
      await exec('tar', ['-xzf', up.path, '-C', tmp], { timeout: 120_000 });
      return open(tmp, name ?? 'my-site', done, { uploadId: i.uploadId, home: i.home });
    }
    const repo = parseRepo(i.repo ?? '');
    if (!repo) throw new Unit7Error('invalid_input', 'The repo should look like owner/name.', 400);
    const token = await githubToken(ctx as Ctx);
    const args = ['clone', '--depth', '1', ...(i.branch ? ['--branch', i.branch] : []), '--', cloneUrl(repo), tmp];
    await exec(sysBin('git'), args, { timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(token && githubBase().startsWith('https://') ? githubAuthEnv(token) : {}) } })
      .catch((e: Error) => { throw new Unit7Error('git_unreachable', `Unit7 couldn’t read ${repo.owner}/${repo.name}. Check the repo’s name and that your GitHub connection can reach it.${token ? '' : ' GitHub isn’t connected.'} ${e.message.replaceAll(token ?? '\u0000', '***').slice(0, 160)}`, 502); });
    // the branch it really is: a repo's default isn't always main. An empty repo has a branch name and no commit, so this still answers
    return open(tmp, name ?? repo.name, done, { repo, home: i.home, branch: i.branch ?? (await exec(sysBin('git'), ['-C', tmp, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim() });
  } catch (e) { done(); throw e; }
}
