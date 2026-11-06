// What goes live: a folder a person picked, an upload (`unit7 live`, a dropped ZIP) or a repo. Each becomes a plain folder, so a
// host only ever reads files. What must never leave this computer stays out here, whichever host it's going to.
import { execFile } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { get } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { detectSecrets } from '../redact.ts';
import type { Ctx } from '../tools/runtime.ts';
import { checkFolder, factsOf } from '../connectors/folder.ts';
import { detect, type Detection } from '../connectors/detect.ts';
import { cloneUrl, githubAuthEnv, githubBase, githubToken, parseRepo, type Repo } from '../connectors/github.ts';
import { sysBin } from '../connectors/shell.ts';

const exec = promisify(execFile);
export interface SiteFile { path: string; abs: string; size: number }
export interface Site {
  dir: string; name: string; detection: Detection; files: SiteFile[]; bytes: number;
  secrets: { file: string; kinds: string[] }[]; repo?: Repo; branch?: string; uploadId?: string;
  image?: string; copyOf?: string; // no code: a ready image, or a copy of an app already on the host
  done(): void; // removes what Unit7 unpacked; a person's own folder is left alone
}

const SKIP = new Set(['node_modules', '.git', '.next', '.vercel', '.netlify', '.turbo', '.cache', '.svelte-kit', '.nuxt', '.output', '.wrangler', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage']);
const NEVER = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.npmrc|\.netrc|\.git-credentials|\.pgpass|credentials(\.json)?|\.DS_Store|\._.*)$/i;
const EXAMPLE = /^\.env\.(example|sample|template)$/i;
const TEXT = /\.(html?|css|js|mjs|cjs|jsx|ts|tsx|vue|svelte|astro|json|ya?ml|toml|ini|txt|md|py|rb|php|go|sh|map)$/i;
const TESTS = /(^|\/)(tests?|__tests__|fixtures?|e2e|cypress)\/|\.(test|spec)\.[a-z]+$/i;
// public on purpose: a Supabase public key and a Firebase web key belong in a website
const PUBLIC_BY_DESIGN = new Set(['jwt', 'google key']);
export const LIMITS = { files: 20_000, bytes: 1024 ** 3, scan: 512 * 1024 };

export function walk(dir: string, sub = '', out: SiteFile[] = []): SiteFile[] {
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const path = sub ? `${sub}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue; // never follows a link out of the folder
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(dir, path, out); continue; }
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

export const siteName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52) || 'my-site';

function open(dir: string, name: string, done: () => void, extra: Partial<Site> = {}): Site {
  try {
    const files = walk(dir), bytes = files.reduce((n, f) => n + f.size, 0);
    if (!files.length) throw new Unit7Error('empty_site', 'There are no files to put live in that.', 400);
    if (bytes > LIMITS.bytes) throw new Unit7Error('too_large', 'That is more than 1 GB. Leave out what the site doesn’t need, like videos or old builds.', 413);
    return { dir, name: siteName(name), detection: detect(factsOf(dir)), files, bytes, secrets: secretsIn(files), done, ...extra };
  } catch (e) { done(); throw e; }
}

export interface SourceInput { folder?: string; uploadId?: string; repo?: string; branch?: string; image?: string; copyOf?: string }
export async function openSource(ctx: Pick<Ctx, 'app' | 'db' | 'orgId' | 'signal'> & Partial<Ctx>, i: SourceInput, name?: string): Promise<Site> {
  if (i.image || i.copyOf) return { dir: '', name: siteName(name ?? (i.copyOf ? `${i.copyOf}-copy` : basename(i.image!).split(/[:@]/)[0]!)), detection: detect({ files: [], manifests: {} }), files: [], bytes: 0, secrets: [], image: i.image, copyOf: i.copyOf, done: () => undefined };
  if (i.folder) { const dir = checkFolder(i.folder, ctx.app.home); return open(dir, name ?? basename(dir), () => undefined); }
  const tmp = mkdtempSync(join(tmpdir(), 'unit7-live-')), done = () => rmSync(tmp, { recursive: true, force: true });
  try {
    if (i.uploadId) {
      const up = get<{ path: string }>(ctx.db, 'SELECT path FROM uploads WHERE id = ? AND org_id = ?', i.uploadId, ctx.orgId);
      if (!up) throw new Unit7Error('not_found', 'That upload was not found.', 404);
      await exec('tar', ['-xzf', up.path, '-C', tmp], { timeout: 120_000 });
      return open(tmp, name ?? 'my-site', done, { uploadId: i.uploadId });
    }
    const repo = parseRepo(i.repo ?? '');
    if (!repo) throw new Unit7Error('invalid_input', 'The repo should look like owner/name.', 400);
    const token = await githubToken(ctx as Ctx);
    const args = ['clone', '--depth', '1', ...(i.branch ? ['--branch', i.branch] : []), '--', cloneUrl(repo), tmp];
    await exec(sysBin('git'), args, { timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(token && githubBase().startsWith('https://') ? githubAuthEnv(token) : {}) } })
      .catch((e: Error) => { throw new Unit7Error('git_unreachable', `Unit7 couldn’t read ${repo.owner}/${repo.name}. Check the repo’s name and that your GitHub connection can reach it.${token ? '' : ' GitHub isn’t connected.'} ${e.message.replaceAll(token ?? '\u0000', '***').slice(0, 160)}`, 502); });
    // the branch it really is: a repo's default isn't always main
    return open(tmp, name ?? repo.name, done, { repo, branch: i.branch ?? (await exec(sysBin('git'), ['-C', tmp, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() });
  } catch (e) { done(); throw e; }
}
