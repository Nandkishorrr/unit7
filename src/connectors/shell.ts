import { existsSync } from 'node:fs';

// Commands for remote shells are built here and nowhere else. The rule: scripts are constants,
// values are arguments. A value is single-quoted (the only POSIX quoting with no special
// characters inside), so `; rm -rf /` in a name stays a strange name, never a second command.
export const shq = (s: string | number) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// cmd('docker', 'logs', name) → docker 'logs' 'name'   (the program itself must be a constant)
export function cmd(program: string, ...args: (string | number)[]) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(program)) throw new Error(`refusing to run program name ${program}`);
  return [program, ...args.map(shq)].join(' ');
}

// A constant script with positional values: sh -c 'script using "$1"' unit7 'value1' ...
export function script(body: string, ...args: (string | number)[]) {
  return `sh -c ${shq(body)} unit7 ${args.map(shq).join(' ')}`.trimEnd();
}

// `dump | gzip > file` in plain sh, which has no pipefail and reports only gzip. The file stands only when the dump and gzip both finished
// and it reads back whole. Anything else is removed, so nothing later takes half a backup for a backup. Safe under set -e.
export const gzipInto = (dump: string, file: string, onFail = 'echo "the backup did not finish" >&2') =>
  `gz=0; { ${dump}; echo $? > "${file}.rc"; } | gzip > "${file}" || gz=$?; rc=$(cat "${file}.rc" 2>/dev/null || true); rm -f "${file}.rc"; if [ "$rc" != 0 ] || [ "$gz" != 0 ] || ! gzip -t "${file}" 2>/dev/null; then rm -f "${file}"; ${onFail}; exit 3; fi`;

// A secret for a script: the first line of stdin, exported under these names (a command takes it by name, as in
// `docker exec -e PGPASSWORD`), so it's never a command-line argument, which any process list on the server shows.
// The rest of stdin is left for the script.
export const secretIn = (...names: string[]) => `IFS= read -r __pw || true; export ${names.map((n) => `${n}="$__pw"`).join(' ')}; unset __pw; `;

// A system tool by its absolute path when it's there, so nothing earlier on PATH (an npm package's bin,
// a user-writable Homebrew folder) can stand in for it.
export const sysBin = (name: 'ssh' | 'ssh-keygen' | 'git') => (existsSync(`/usr/bin/${name}`) ? `/usr/bin/${name}` : name);

// Names Unit7 invents for containers, networks, volumes and paths.
export const SAFE_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
export function safeName(s: string, what = 'name') {
  if (!SAFE_NAME.test(s)) throw new Error(`${what} "${s}" has characters Unit7 doesn't allow`);
  return s;
}
