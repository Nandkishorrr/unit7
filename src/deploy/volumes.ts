// Files an app keeps (a SQLite file, uploads, a data folder). Written inside a container they're gone on the next deploy,
// and the old and new versions never see the same ones. So the folders the code writes to get a named Docker volume per
// app and environment (unit7-<app>-<env>-data → /app/data), owned by the app's own unprivileged user. Both versions mount
// it during the blue-green switch: fine for a single SQLite writer, since the old version only finishes its last requests
// (the drain) before it stops. Unit7's backups include it (src/tools/backups.ts, kind 'files').
//
// Where the folders come from: the code (paths it writes to, read by the deployer's trait grep), the previous version's
// own writes (`docker diff`: the precise form of the X-ray's "data written inside containers"), self-heal after a
// permission error, and every volume the app had before (a volume, once made, is never dropped).
import type { Ctx } from '../tools/runtime.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script, safeName, shq } from '../connectors/shell.ts';

export interface AppVolume { name: string; path: string }

export const DATA_NAMES = ['data', 'uploads', 'storage'];
const DIR = /^[a-z0-9][a-z0-9_.-]{0,40}$/i;
// folders a container writes that are build output or caches, never the app's data
const NOT_DATA = new Set(['node_modules', '.next', '.nuxt', '.output', '.cache', '.npm', '.pnpm-store', '.yarn', 'dist', 'build', 'tmp', '.tmp', '__pycache__', '.git', 'logs', '.local', '.config']);

// grep patterns for the deployer's trait scan (an ERE, joined into its alternation)
export const DATA_TRAITS = [
  String.raw`['"${'`'}]\.?/?(data|uploads|storage)/[^'"${'`'} ]*['"${'`'}]`,                     // 'data/app.db', './uploads/x'
  String.raw`['"${'`'}]\./(data|uploads|storage)/?['"${'`'}]`,                                   // './data'
  String.raw`(mkdirSync|mkdir|join|resolve)\([^)]{0,80}['"${'`'}](data|uploads|storage)['"${'`'}]`, // join(cwd, 'data')
  String.raw`['"${'`'}][A-Za-z0-9_./-]*\.(sqlite3?|db)['"${'`'}]`,                                      // 'harbor.db'
].join('|');

// The folders (relative to the app's folder) the code keeps files in. A folder the repo ships files in (other than a
// placeholder) is left alone: a volume over it would keep its first copy forever and hide the repo's updates.
export function dataDirsOf(traits: string | undefined, files: string[]): { dirs: string[]; notes: string[] } {
  const dirs = new Set<string>(), notes: string[] = [];
  for (const raw of (traits ?? '').split('\n')) {
    const lit = /['"`]([^'"`]+)['"`]\s*\)?$/.exec(raw.trim())?.[1] ?? '';
    const named = /(?:^|\/)(data|uploads|storage)(?:\/|$)/.exec(lit.replace(/^\.\//, ''))?.[1];
    if (named && !lit.startsWith('/') && !lit.includes('..')) { dirs.add(named); continue; }
    const db = /^(?:\.\/)?([\w.-]+\/)?[\w.-]+\.(?:sqlite3?|db)$/.exec(lit);
    if (db?.[1] && DIR.test(db[1].slice(0, -1)) && !NOT_DATA.has(db[1].slice(0, -1))) dirs.add(db[1].slice(0, -1));
    else if (db && !db[1] && !notes.length) notes.push(`The SQLite file ${lit.replace(/^\.\//, '')} sits at the top of the app’s folder, where it’s lost on every deploy. Move it into data/ and Unit7 keeps it.`);
  }
  for (const d of [...dirs]) {
    if (files.some((f) => f.startsWith(`${d}/`) && !/\/\.(gitkeep|gitignore|keep)$/.test(f))) { dirs.delete(d); notes.push(`The repo ships files in ${d}/, so Unit7 doesn’t keep it in a volume (it would hide your updates). Keep the app’s own files in a folder of their own.`); }
  }
  return { dirs: [...dirs].sort(), notes };
}

// what the previous version wrote into its container (`docker diff` lines), as folders under /app
export function dirsFromDiff(diff: string, root = '/app'): string[] {
  const out = new Set<string>();
  for (const line of diff.split('\n')) {
    const m = new RegExp(`^A ${root.replace(/\//g, '\\/')}/([^/\\s]+)/\\S`).exec(line.trim());
    if (m && DIR.test(m[1]!) && !NOT_DATA.has(m[1]!)) out.add(m[1]!);
  }
  return [...out].sort();
}

// one volume per folder, per app and environment: unit7-harbor-1a2b3c-data → /app/data
export function appVolumes(host: string, dirs: string[], root = '/app'): AppVolume[] {
  return [...new Set(dirs)].filter((d) => DIR.test(d) && !NOT_DATA.has(d)).sort().map((d) => ({ name: safeName(`${host}-${d.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`.slice(0, 63).replace(/[-.]+$/, ''), 'volume'), path: `${root}/${d}` }));
}
export const volumeArgs = (vols: AppVolume[] | undefined) => (vols ?? []).map((v) => `-v ${shq(`${safeName(v.name, 'volume')}:${v.path}`)}`).join(' ');

// "Saves files in /app/data · kept between deploys · backed up daily"
export function filesWords(vols: AppVolume[] | undefined, backedUp?: string): string | undefined {
  if (!vols?.length) return undefined;
  return [`Saves files in ${vols.map((v) => v.path).join(', ')}`, 'kept between deploys', backedUp ? `backed up ${backedUp}` : 'not backed up yet'].join(' · ');
}

// Before a version starts: each volume exists (a new one starts with what the previous version had written there, so
// switching to a volume loses nothing), and belongs to the image's own user.
export async function prepareVolumes(ctx: Ctx, s: ServerRow, o: { image: string; service: string; previous?: string; vols: AppVolume[] }): Promise<string[]> {
  if (!o.vols.length) return [];
  const r = await ssh(ctx.app).exec(s, script(PREPARE, o.image, o.previous ?? '', o.service, ...o.vols.flatMap((v) => [safeName(v.name, 'volume'), v.path])), { timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new Error(`Couldn’t prepare the app’s saved files: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  return r.stdout.split('\n').filter((l) => l.startsWith('seeded ')).map((l) => l.slice(7));
}
export const PREPARE = String.raw`img=$1; prev=$2; svc=$3; shift 3
u=$(docker image inspect -f '{{.Config.User}}' "$img" 2>/dev/null); [ -n "$u" ] || u=0
while [ $# -ge 2 ]; do v=$1; p=$2; shift 2; deep=
  if ! docker volume inspect "$v" >/dev/null 2>&1; then
    docker volume create --label unit7.service="$svc" --label unit7.path="$p" "$v" >/dev/null || exit 1
    if [ -n "$prev" ] && docker container inspect "$prev" >/dev/null 2>&1 && docker cp "$prev:$p" - 2>/dev/null | docker run --rm -i --user 0 -v "$v:/to" --entrypoint sh "$img" -c 'mkdir -p /tmp/s && tar -x -C /tmp/s && cp -a /tmp/s/*/. /to/'; then echo "seeded $p"; deep=-R; fi
  fi
  docker run --rm --user 0 -v "$v:$p" --entrypoint sh "$img" -c 'chown '"$deep"' "$1" "$2"' x "$u" "$p" || exit 1
done`;

// what the previous version wrote inside its container, read before the new one is built
export async function previousWrites(ctx: Ctx, s: ServerRow, container: string | undefined): Promise<string[]> {
  if (!container) return [];
  const r = await ssh(ctx.app).exec(s, script('docker diff "$1" 2>/dev/null | head -2000', safeName(container, 'container name')), { timeoutMs: 30_000 }).catch(() => undefined);
  return r?.code === 0 ? dirsFromDiff(r.stdout) : [];
}
