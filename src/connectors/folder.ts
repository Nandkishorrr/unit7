// A project folder on this computer: pick it with the Mac's own folder window, see what it is, and pack it
// for a deploy the way `unit7 deploy` does. The web routes that reach this are for a person signed in on
// this computer only (src/server/http.ts).
import { execFile, spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { App } from '../app.ts';
import { run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { detect } from './detect.ts';

// The Mac's folder window. Undefined when the person cancels (or walks away for five minutes).
export function chooseFolder(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return Promise.reject(new Unit7Error('no_picker', 'The folder window is only on a Mac. Type the folder’s path instead.', 501));
  // `activate` brings the window to the front: Unit7 runs in the background, so it would open behind the browser
  return new Promise((done, fail) => execFile('/usr/bin/osascript', ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "Pick your project folder")'], { timeout: 5 * 60_000 }, (e, out) => {
    if (!e) return done(out.trim().replace(/(.)\/$/, '$1'));
    if (e.killed || /-128/.test(e.message)) return done(undefined); // -128: Cancel
    fail(new Unit7Error('picker_failed', 'The folder window didn’t open. Type the folder’s path instead.', 500));
  }));
}

// A real folder, and never one whose contents mustn't leave this computer: the whole disk, your home folder,
// or anything holding Unit7's own data.
export function checkFolder(path: string, unit7Home: string): string {
  const raw = path.trim().replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(raw)) throw new Unit7Error('bad_folder', 'Give the full path, like ~/code/shop.', 400);
  const dir = resolve(raw);
  let isDir = false;
  try { isDir = statSync(dir).isDirectory(); } catch { /* missing */ }
  if (!isDir) throw new Unit7Error('bad_folder', `${dir} isn’t a folder on this computer.`, 400);
  const inside = (a: string, b: string) => { const r = relative(a, b); return !r.startsWith('..') && !isAbsolute(r); };
  if (dir === '/' || dir === homedir() || inside(dir, resolve(unit7Home))) throw new Unit7Error('bad_folder', 'Pick your project’s own folder, not one that holds your whole computer or Unit7’s data.', 400);
  return dir;
}

const SKIP = new Set(['node_modules', '.git', 'dist', '.next']);
const MANIFEST = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|composer\.json|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|\.nvmrc|\.node-version|Procfile)$/;

// files three levels deep, like the listing a deploy reads on the server
function list(root: string, sub = '', depth = 0, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(join(root, sub), { withFileTypes: true }); } catch (e) {
    if (!sub) throw new Unit7Error('bad_folder', `Unit7 can’t read ${root}. On a Mac, allow it under System Settings → Privacy & Security → Files and Folders.`, 400);
    return out; // an unreadable subfolder: skip it
  }
  for (const e of entries) {
    if (out.length >= 400) break;
    const p = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) { if (depth < 2 && !SKIP.has(e.name)) list(root, p, depth + 1, out); } else if (e.isFile()) out.push(p);
  }
  return out;
}

// What the folder is: its name, and the stack a deploy would build it as (the same detection, read locally)
export function factsOf(dir: string) {
  const files = list(dir);
  const manifests: Record<string, string> = {};
  for (const f of files.filter((x) => MANIFEST.test(x)).sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 20)) {
    try { manifests[f] = readFileSync(join(dir, f), 'utf8').slice(0, 32_768); } catch { /* unreadable: skip */ }
  }
  return { files, manifests };
}
export function inspectFolder(path: string, unit7Home: string) {
  const dir = checkFolder(path, unit7Home), d = detect(factsOf(dir));
  return { path: dir, name: basename(dir), stack: d.stack, runtime: d.runtime ?? null };
}

// The folder as a .tgz, leaving out the usual heavy and secret files (the server rebuilds from source anyway)
export const MAX_PACK = 90 * 1024 * 1024;
export const packFolder = (dir: string, max = MAX_PACK, o: { keepBuild?: boolean } = {}) =>
  tgz(['-cf', '-', '--exclude=.git', '--exclude=node_modules', '--exclude=.next', ...(o.keepBuild ? [] : ['--exclude=dist']), '--exclude=.env', '--exclude=.env.*', '--exclude=._*', '--exclude=.DS_Store', '-C', dir, '.'], max);
// These files and nothing else: what a host gets when the folder or upload could hold more than Unit7 checked (a .pem, an .npmrc)
export const packFiles = (dir: string, paths: string[], max = MAX_PACK) => tgz(['--null', '-cf', '-', '-C', dir, '-T', '-'], max, paths.join('\0'));

async function tgz(args: string[], max: number, list?: string): Promise<Buffer> {
  // COPYFILE_DISABLE: macOS tar otherwise adds hidden ._ "AppleDouble" files next to every file
  const tar = spawn('tar', args, { stdio: [list === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
  tar.stdin?.on('error', () => undefined); // tar gone early: reading its output below says so
  tar.stdin?.end(list);
  const gz = tar.stdout!.pipe(createGzip());
  tar.once('error', (e) => gz.destroy(e)); // no tar at all: fail this deploy, not the whole server
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const ch of gz) {
    chunks.push(ch as Buffer);
    if ((size += (ch as Buffer).length) > max) { tar.kill(); throw new Unit7Error('too_large', `That folder is larger than ${Math.round(max / 1024 / 1024)} MB packed. Add big files to an exclude or deploy from a git repo.`, 413); }
  }
  return Buffer.concat(chunks);
}

// Kept like an upload from `unit7 deploy` (UNIT7_HOME/uploads), so a deploy reads it the same way
export function saveUpload(app: App, orgId: string, userId: string | null, buf: Buffer): string {
  const uploadId = `upl_${randomBytes(9).toString('base64url')}`;
  const dir = join(app.home, 'uploads');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${uploadId}.tgz`);
  writeFileSync(path, buf, { mode: 0o600 });
  run(app.db, 'INSERT INTO uploads (id, org_id, path, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?)', uploadId, orgId, path, buf.length, createHash('sha256').update(buf).digest('hex'), userId);
  return uploadId;
}

export async function uploadFolder(app: App, orgId: string, userId: string | null, folder: string): Promise<string> {
  return saveUpload(app, orgId, userId, await packFolder(checkFolder(folder, app.home)));
}
