// Have I been hacked? Read-only signs over SSH, against what this server looked like the first time. New keys, new cron lines, changed
// shell files, a process running from /tmp. Unit7 never tries to clean: once someone was in, the safe answer is to rebuild.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool, type Ctx } from '../tools/runtime.ts';
import { all, get, json, now, run, type DB } from '../db.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { fid } from '../tools/helpers.ts';
import { serverRow } from '../tools/servers.ts';
import { Unit7Error } from '../errors.ts';

export const SIGNS = `export LC_ALL=C PATH="$PATH:/usr/sbin:/sbin"
s() { printf '\\n@@%s\\n' "$1"; }
s keys; for u in /root /home/*; do f="$u/.ssh/authorized_keys"; [ -f "$f" ] && ssh-keygen -lf "$f" 2>/dev/null | awk -v u="$u" '{print u, $2, $NF}'; done
s users; awk -F: '$3 == 0 || ($3 >= 1000 && $3 < 65000) {print $1 ":" $3 ":" $7}' /etc/passwd
s cron; { cat /etc/crontab 2>/dev/null; cat /etc/cron.d/* 2>/dev/null; cat /var/spool/cron/crontabs/* /var/spool/cron/* 2>/dev/null; } | grep -vE '^\\s*(#|$|[A-Z_]+=)' | sort -u
s shell; for f in /root/.bashrc /root/.profile /root/.bash_profile /etc/profile /etc/ld.so.preload /etc/rc.local; do [ -f "$f" ] && echo "$f $(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)"; done; ls /etc/profile.d 2>/dev/null | sed 's#^#/etc/profile.d/#'
s preload; cat /etc/ld.so.preload 2>/dev/null
s procs; ps -eo pid=,pcpu=,comm=,args= --sort=-pcpu 2>/dev/null | head -25 | cut -c1-200
s exes; host=$(readlink /proc/1/ns/mnt 2>/dev/null); for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$' | head -2000); do [ "$(readlink /proc/$p/ns/mnt 2>/dev/null)" = "$host" ] || continue; e=$(readlink /proc/$p/exe 2>/dev/null); case "$e" in /tmp/*|/dev/shm/*|/var/tmp/*|/memfd:*) echo "$p $e" ;; esac; done | head -20
`;
const sec = (out: string, k: string) => new RegExp(`@@${k}\\n([\\s\\S]*?)(?=\\n@@|$)`).exec(out)?.[1]?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
const MINER = /\b(xmrig|xmr-stak|kinsing|kdevtmpfsi|cpuminer|minerd|c3pool|nanominer|t-rex|lolminer)\b/i, ODD_RUN = /\b(curl|wget)\b.*\|\s*(ba)?sh\b|base64\s+-d|\/dev\/tcp\/|nc\s+-e|python[\d.]*\s+-c.*socket/i;
export interface Snapshot { keys: string[]; users: string[]; cron: string[]; shell: string[] }
export const snapshotOf = (out: string): Snapshot => ({ keys: sec(out, 'keys'), users: sec(out, 'users'), cron: sec(out, 'cron').map((l) => createHash('sha1').update(l).digest('hex').slice(0, 12)), shell: sec(out, 'shell') });
const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
export interface Sign { kind: string; strong: boolean; what: string }
// (pure) what's wrong now, and what changed since the first look. A busy process alone proves nothing, so only strong things are strong.
export function signsOf(out: string, was?: Snapshot): Sign[] {
  const signs: Sign[] = [], now_ = snapshotOf(out);
  for (const l of sec(out, 'procs')) if (MINER.test(l)) signs.push({ kind: 'miner', strong: true, what: `A known crypto miner is running: ${l.split(/\s+/).slice(2, 4).join(' ')}` });
  for (const l of sec(out, 'exes')) signs.push({ kind: 'odd-exe', strong: true, what: `A program is running from a place programs shouldn’t: ${l.split(' ').slice(1).join(' ')}` });
  if (sec(out, 'preload').length) signs.push({ kind: 'preload', strong: true, what: '/etc/ld.so.preload is set, a classic way to hide a program' });
  // a job that fetches and runs something can be an honest updater, so it's only strong if it appeared after Unit7's first look
  for (const l of sec(out, 'cron')) if (ODD_RUN.test(l) || (/@reboot/.test(l) && /(\/tmp\/|\/dev\/shm|curl|wget)/.test(l))) signs.push({ kind: 'odd-cron', strong: !!was && !was.cron.includes(createHash('sha1').update(l).digest('hex').slice(0, 12)), what: `A scheduled job fetches and runs something: ${l.slice(0, 100)}` });
  for (const u of now_.users) { const [name, id] = u.split(':'); if (id === '0' && name !== 'root') signs.push({ kind: 'second-root', strong: true, what: `A second all-powerful user exists: ${name}` }); }
  if (was) {
    for (const k of added(was.keys, now_.keys)) signs.push({ kind: 'new-key', strong: false, what: `A new SSH key can sign in: ${k}` });
    for (const u of added(was.users, now_.users)) signs.push({ kind: 'new-user', strong: false, what: `A new user: ${u.split(':')[0]}` });
    if (added(was.cron, now_.cron).length) signs.push({ kind: 'new-cron', strong: false, what: `${added(was.cron, now_.cron).length} new scheduled job${added(was.cron, now_.cron).length === 1 ? '' : 's'}` });
    for (const f of added(was.shell, now_.shell)) signs.push({ kind: 'changed-shell', strong: false, what: `A sign-in file changed: ${f.split(' ')[0]}` });
  }
  return signs;
}
export function wordsFor(signs: Sign[]) {
  if (!signs.length) return { verdict: 'No signs', line: 'No signs of a break-in. That can’t prove nobody got in, only that these checks found nothing.' };
  if (signs.some((s) => s.strong)) return { verdict: 'Treat this server as broken into', line: 'Don’t try to clean it. Someone who got in can hide. Keep the evidence, make a new server, restore from a copy taken before this, and change every key.' };
  return { verdict: 'Something changed', line: 'This may be you or a teammate. If it isn’t, treat it as a break-in.' };
}
const baseline = (db: DB, serverId: string) => get<{ data: string }>(db, 'SELECT data FROM server_baseline WHERE server_id = ?', serverId);
export async function hackCheck(ctx: Ctx, s: ServerRow) {
  const r = await ssh(ctx.app).exec(s, `${json<{ sudo?: string }>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : ''}sh -s`, { stdin: SIGNS, timeoutMs: 60_000 });
  // a look that didn't finish (sudo asked for a password, say) is not "no signs", and it must never become the baseline
  if (r.code !== 0 || !r.stdout.includes('@@exes')) throw new Unit7Error('no_look', `Unit7 couldn’t look at ${s.name}, so it can’t say either way: ${r.stderr.trim().slice(0, 200) || 'the check didn’t finish'}`, 502);
  const was = baseline(ctx.db, s.id), snap = snapshotOf(r.stdout), signs = signsOf(r.stdout, was ? json<Snapshot>(was.data, { keys: [], users: [], cron: [], shell: [] }) : undefined);
  if (!was) run(ctx.db, 'INSERT INTO server_baseline (server_id, org_id, data, at) VALUES (?, ?, ?, ?)', s.id, ctx.orgId, JSON.stringify(snap), now());
  return { signs, snap, first: !was, ...wordsFor(signs) };
}
defineTool({
  name: 'security.hacked', title: 'Have I been hacked?', risk: 'read', action: 'read', timeoutMs: 90_000,
  description: 'Read-only break-in signs on a server: known miners, programs running from /tmp or deleted files, ld.so.preload, scheduled jobs that fetch and run things, a second root user, and new SSH keys, users, cron lines or changed sign-in files since Unit7’s first look. A strong sign means rebuild, not clean. It keeps evidence off the server by itself.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), r = await hackCheck(ctx, s);
    if (r.signs.some((x) => x.strong)) ctx.emit('breakin.found', `${s.name}: ${r.signs.find((x) => x.strong)!.what}. Treat it as broken into, and don’t try to clean it.`, { severity: 'critical', resource: s.id, data: { serverId: s.id } });
    return { server: s.name, verdict: r.verdict, line: r.line, signs: r.signs, first: r.first };
  },
});
defineTool({
  name: 'security.who', title: 'Who can get in', risk: 'read', action: 'read', timeoutMs: 90_000,
  description: 'Everyone and everything that can sign in: SSH keys and users on each server (new ones marked), and Unit7’s own app keys with when each was last used.',
  input: z.object({ serverId: fid('srv').optional() }),
  async run(ctx, i) {
    const servers = all<ServerRow>(ctx.db, `SELECT * FROM servers WHERE org_id = ? AND status = 'ready' AND (? IS NULL OR id = ?)`, ctx.orgId, i.serverId ?? null, i.serverId ?? null), out = [];
    for (const s of servers) { const r = await hackCheck(ctx, s).catch(() => undefined); if (!r) continue; const was = json<Snapshot>(baseline(ctx.db, s.id)?.data, { keys: [], users: [], cron: [], shell: [] }); out.push({ server: s.name, keys: r.snap.keys.map((k) => ({ key: k, fresh: !was.keys.includes(k) })), users: r.snap.users.map((u) => ({ user: u.split(':')[0], root: u.split(':')[1] === '0', fresh: !was.users.includes(u) })) }); }
    return { servers: out, unit7Keys: all(ctx.db, 'SELECT name, role, last_used_at lastUsed, expires_at expires, created_at FROM api_tokens WHERE org_id = ? ORDER BY coalesce(last_used_at, created_at) DESC', ctx.orgId) };
  },
});
defineTool({
  name: 'security.accept_baseline', title: 'These changes were mine', risk: 'write', action: 'memory', peopleOnly: true,
  description: 'People only: an AI could hide a break-in this way. After a person confirms a change was theirs (a new key, a new cron line), take today’s state as what’s normal for this server.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) { const s = serverRow(ctx, i.serverId), r = await hackCheck(ctx, s); run(ctx.db, 'INSERT INTO server_baseline (server_id, org_id, data, at) VALUES (?, ?, ?, ?) ON CONFLICT (server_id) DO UPDATE SET data = excluded.data, at = excluded.at', s.id, ctx.orgId, JSON.stringify(r.snap), now()); return { accepted: true }; },
});
