// A scratch Postgres for tests that want the real thing: a Unix socket only, no port. The SSH layer stays fake, but runs what Unit7
// sends in a real shell, with a stand-in `docker` that treats this computer as the container. Only what a shell and a database can
// judge is proven this way: quoting, psql's output, a dump coming back. Skipped where there's no Postgres or the sandbox forbids one.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import type { App } from '../src/app.ts';

const DOCKER = `#!/bin/sh
# a stand-in for docker: the "container" is this computer
cmd=$1; shift
case "$cmd" in
  exec)
    while :; do case "$1" in -i) shift ;; -e) shift 2 ;; *) break ;; esac; done
    shift
    exec "$@"
    ;;
  inspect)
    printf 'unit7 127.0.0.1\\n'
    ;;
  run)
    # the box: everything up to the image is docker's, the rest is the client. PGPASSWORD and PGOPTIONS come through the environment.
    e=''
    while [ $# -gt 0 ]; do
      case "$1" in
        --entrypoint) e=$2; shift 2 ;;
        --rm|-i|--read-only) shift ;;
        --user|--cap-drop|--security-opt|--tmpfs|--memory|--network|-e) shift 2 ;;
        *) break ;;
      esac
    done
    shift
    a=''; n=0
    for x in "$@"; do n=$((n+1)); done
    set -- "$@"
    while [ $n -gt 0 ]; do
      x=$1; shift; n=$((n-1))
      if [ "$x" = -h ]; then shift; n=$((n-1)); continue; fi
      set -- "$@" "$x"
    done
    exec "$e" "$@"
    ;;
  *) echo "docker stand-in: no $cmd" >&2; exit 9 ;;
esac
`;

export function havePostgres() {
  return spawnSync('initdb', ['--version'], { encoding: 'utf8' }).status === 0;
}

export function startPostgres() {
  const dir = mkdtempSync(join(tmpdir(), 'u7pg-')), sock = join(dir, 's'), bin = join(dir, 'bin'), data = join(dir, 'data');
  execFileSync('mkdir', ['-p', sock, bin]);
  writeFileSync(join(bin, 'docker'), DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const env = { ...process.env, LC_ALL: 'C', PATH: `${bin}:${process.env.PATH}`, PGHOST: sock, PGUSER: 'postgres', POSTGRES_USER: 'postgres', POSTGRES_DB: 'shop' };
  const stop = () => { spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', 'stop'], { env }); rmSync(dir, { recursive: true, force: true }); };
  const init = spawnSync('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { env, encoding: 'utf8' });
  if (init.status !== 0) { rmSync(dir, { recursive: true, force: true }); return undefined; } // the sandbox forbids shared memory
  const up = spawnSync('pg_ctl', ['-D', data, '-w', '-l', join(dir, 'log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${sock}' -c shared_buffers=16MB -c max_connections=30`, 'start'], { env, encoding: 'utf8' });
  if (up.status !== 0) { stop(); return undefined; }
  const sql = (text: string, db = 'postgres') => execFileSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db], { env, input: text, encoding: 'utf8' });
  return { dir, env, sql, stop, dumpTo: (file: string) => execFileSync('sh', ['-c', 'pg_dumpall -U postgres | gzip > "$1"', 'unit7', file], { env }) };
}
export type Pg = NonNullable<ReturnType<typeof startPostgres>>;

// ssh(app).exec, for real: the command in sh, stdin as it would arrive. Everything Unit7 sends is kept in `seen`.
export function realShell(app: App, pg: Pg) {
  const seen: { command: string; stdin: string }[] = [];
  ssh(app).exec = (_s, command, o: ExecOptions = {}) => new Promise((resolve, reject) => {
    const stdin = o.stdin === undefined ? '' : String(o.stdin);
    seen.push({ command, stdin });
    const p = spawn('sh', ['-c', command], { env: pg.env });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
    p.stdin.on('error', () => undefined); // a client that has what it needs stops reading
    p.stdin.end(stdin);
  });
  ssh(app).check = async (s, command, o = {}) => {
    const r = await ssh(app).exec(s, command, o);
    if (r.code !== 0) throw new Error(`${o.what ?? 'A command'} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  return seen;
}
