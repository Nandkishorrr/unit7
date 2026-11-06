// A fake server whose shell is real: every command Unit7 sends runs in dash (the sh Ubuntu has) with its paths moved into a
// temporary folder, and with stand-ins only for what needs a real machine: docker, iptables, useradd and friends. So the
// scripts themselves are tested, quoting and all, not a fake's idea of them.
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ssh, type ExecOptions, type ExecResult, type ServerRow } from '../src/connectors/ssh.ts';
import { Unit7Error } from '../src/errors.ts';
import { XRAY_PROBE } from '../src/discovery/xray.ts';
import type { App } from '../src/app.ts';

const MOVED = ['/etc/passwd', '/etc/group', '/etc/sudoers.d', '/etc/unit7', '/etc/systemd', '/etc/crontab', '/etc/cron.d', '/var/backups/unit7', '/var/lib/unit7', '/data/coolify', '/home/*', '/root/.ssh'];
const script = (body: string) => `#!/bin/dash\n${body}\n`;
// iptables: its rules are lines in a file; -C looks, -I adds, -D removes one
const IPTABLES = script(`f="$FAKE_ROOT/iptables.rules"; touch "$f"; a="$1"; shift
case "$a" in
  -n) case "$2$3" in *DOCKER-USER*) grep -q '^docker$' "$FAKE_ROOT/chains" 2>/dev/null ;; esac; exit $? ;;
  -S) cat "$f"; exit 0 ;;
  -C) grep -qxF -- "-A $*" "$f"; exit $? ;;
  -I) c="$1"; shift 2; echo "-A $c $*" >> "$f"; exit 0 ;;
  -D) grep -qxF -- "-A $*" "$f" || exit 1; grep -vxF -- "-A $*" "$f" > "$f.n"; mv "$f.n" "$f"; exit 0 ;;
esac`);
const STUBS: Record<string, string> = {
  iptables: IPTABLES, ip: script(`echo "default via 203.0.113.1 dev eth0"`),
  sshd: script(`cat "$FAKE_ROOT/sshd" 2>/dev/null; true`), systemctl: script(`echo "$*" >> "$FAKE_ROOT/systemctl.log"`), chown: script('exit 0'), passwd: script('exit 0'), visudo: script('exit 0'), usermod: script('exit 0'),
  id: script(`case "$1" in -u) echo 0 ;; -gn) echo "$2" ;; -nG) cat "$FAKE_ROOT/groups-$2" 2>/dev/null || echo "$2" ;; *) echo 0 ;; esac`),
  useradd: script(`for u; do :; done; n=$(($(wc -l < "$FAKE_ROOT/etc/passwd") + 2000)); mkdir -p "$FAKE_ROOT/home/$u"; echo "$u:x:$n:$n::$FAKE_ROOT/home/$u:/bin/bash" >> "$FAKE_ROOT/etc/passwd"`),
  userdel: script(`grep -v "^$1:" "$FAKE_ROOT/etc/passwd" > "$FAKE_ROOT/p.n"; mv "$FAKE_ROOT/p.n" "$FAKE_ROOT/etc/passwd"`),
  pgrep: script(`[ -f "$FAKE_ROOT/busy-$2" ]`),
  sha256sum: script(`shasum -a 256 "$@"`), uname: script('echo x86_64'),
};
export function stubDir() {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-stubs-'));
  for (const [name, body] of Object.entries(STUBS)) { writeFileSync(join(dir, name), body); chmodSync(join(dir, name), 0o755); }
  copyFileSync(fileURLToPath(new URL('./fake-docker.mjs', import.meta.url)), join(dir, 'docker')); chmodSync(join(dir, 'docker'), 0o755);
  symlinkSync('/bin/dash', join(dir, 'sh'));
  return dir;
}

export interface Box { root: string; run: (command: string, stdin?: string) => Promise<ExecResult> }
// a server's disk: / is a temporary folder, /etc/passwd lists root (the home here) and whoever else
export function makeBox(users: { name: string; uid: number; shell?: string }[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'unit7-box-'));
  for (const d of ['etc/systemd/system', 'root/.ssh', 'home', 'docker']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'etc/passwd'), [`root:x:0:0:root:${root}/root:/bin/bash`, 'daemon:x:1:1::/usr/sbin:/usr/sbin/nologin', ...users.map((u) => { mkdirSync(join(root, 'home', u.name, '.ssh'), { recursive: true }); return `${u.name}:x:${u.uid}:${u.uid}::${root}/home/${u.name}:${u.shell ?? '/bin/bash'}`; })].join('\n') + '\n');
  writeFileSync(join(root, 'etc/group'), 'sudo:x:27:\n');
  return root;
}

export function realShell(app: App, roots: Record<string, string>, o: { xray?: string; bin?: string } = {}) {
  const bin = o.bin ?? stubDir(), seen: { server: string; command: string; stdin: string }[] = [];
  const moved = (root: string, t: string) => MOVED.reduce((s, p) => s.replaceAll(p, `${root}${p}`), t).replaceAll('for u in /root ', `for u in ${root}/root `);
  const proc = (root: string, command: string) => spawn('/bin/dash', ['-c', moved(root, command)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ROOT: root, LC_ALL: 'C' } });
  const rootOf = (s: ServerRow) => { const r = roots[s.id]; if (!r) throw new Error(`no fake disk for ${s.name}`); return r; };
  ssh(app).exec = async (s: ServerRow, command: string, x: ExecOptions = {}) => {
    const text = typeof x.stdin === 'string' ? x.stdin : '';
    seen.push({ server: s.name, command, stdin: text });
    if (text === XRAY_PROBE) return { code: 0, stdout: o.xray ?? '', stderr: '', truncated: false };
    const root = rootOf(s), p = proc(root, command);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.stdin.on('error', () => undefined);
    p.stdin.end(moved(root, text));
    return new Promise((resolve) => p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false })));
  };
  // real bytes through a real pipe, and a side that fails fails the copy
  ssh(app).relay = async (from: ServerRow, a: string, to: ServerRow, b: string) => {
    seen.push({ server: from.name, command: a, stdin: '' }, { server: to.name, command: b, stdin: '' });
    const out = proc(rootOf(from), a), into = proc(rootOf(to), b);
    let why = '';
    out.stderr.on('data', (d) => { why += d; }); into.stderr.on('data', (d) => { why += d; });
    into.stdin.on('error', () => undefined);
    out.stdout.pipe(into.stdin);
    const codes = await Promise.all([out, into].map((p) => new Promise<number>((r) => p.on('close', (c) => r(c ?? -1)))));
    if (codes.some((c) => c !== 0)) throw new Unit7Error('transfer_failed', `Copying failed: ${why.trim().slice(-200) || codes.join(', ')}`, 502);
  };
  return seen;
}
