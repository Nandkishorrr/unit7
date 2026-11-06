// Upkeep Unit7 does on a server with its own root access, instead of handing the person a terminal: swap when
// memory is tight, a cap on the system journal, time sync, secret files hidden on every site, and an HTTPS
// certificate renewed on request. Each one is a constant script with values as arguments, goes through the gate
// like any other tool, says what it changed, and gives back its undo where there is one.
import { z } from 'zod';
import { defineTool } from './runtime.ts';
import { get, json, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { assertHostname, guardSites, proxyFor, SITES_GUARD } from '../deploy/caddy.ts';
import { certificate, saveCert } from '../sentinel/watch.ts';
import { fmtBytes } from '../sentinel/anomaly.ts';
import { serverRow } from './servers.ts';
import { fid } from './helpers.ts';

const ROOT = 'SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"\n';
const GiB = 1024 ** 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// T1's limit: how often an AI (Warden included) did this to the same server in the last hour
const recent = (db: DB, orgId: string, tool: string, serverId: string) => get<{ n: number }>(db, `SELECT count(*) n FROM audit WHERE org_id = ? AND tool = ? AND result = 'success'
  AND actor_kind IN ('agent', 'token') AND created_at > ? AND json_extract(input, '$.serverId') = ?`, orgId, tool, new Date(Date.now() - 3600_000).toISOString(), serverId)!.n;
const kv = (out: string) => Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

// --- swap -------------------------------------------------------------------------------------------------------
export const SWAP_FILE = '/swapfile-unit7';
export const SWAP_PROBE = `awk '/^MemTotal/{print "mem=" $2*1024} /^SwapTotal/{print "swap=" $2*1024}' /proc/meminfo
df -P -B1 / | awk 'NR==2{print "free=" $4}'
grep -q '^/swapfile-unit7 ' /proc/swaps && echo ours=1; true`;
// $1 on|off, $2 the size in MB. The fstab line has a marker line above it, so the undo removes exactly what it added.
export const SWAP = ROOT + `F=/swapfile-unit7; SYS=/etc/sysctl.d/90-unit7-swap.conf
if [ "$1" = off ]; then
  if grep -q '^/swapfile-unit7 ' /proc/swaps; then $SU swapoff "$F" || exit 4; fi
  $SU rm -f "$F"
  $SU sed -i -e '/^# unit7-swap/d' -e '/^\\/swapfile-unit7 /d' /etc/fstab
  if [ -f "$SYS" ]; then was=$(sed -n 's/^# was //p' "$SYS"); $SU rm -f "$SYS"; $SU sysctl -q -w vm.swappiness="\${was:-60}" >/dev/null; fi
  echo removed; exit 0
fi
if grep -q '^/swapfile-unit7 ' /proc/swaps; then echo already; exit 0; fi
[ -f "$F" ] || $SU fallocate -l "$2M" "$F" || $SU dd if=/dev/zero of="$F" bs=1M count="$2" status=none || exit 3
$SU chmod 600 "$F" && $SU mkswap "$F" >/dev/null && $SU swapon "$F" || { $SU rm -f "$F"; exit 3; }
grep -q '^/swapfile-unit7 ' /etc/fstab || printf '# unit7-swap: added by Unit7 when memory was tight; removing the swap removes these two lines\\n/swapfile-unit7 none swap sw 0 0\\n' | $SU tee -a /etc/fstab >/dev/null
[ -f "$SYS" ] || printf '# was %s\\nvm.swappiness=10\\n' "$(cat /proc/sys/vm/swappiness)" | $SU tee "$SYS" >/dev/null
$SU sysctl -q -w vm.swappiness=10 >/dev/null
echo added`;
export const swapSize = (memTotal: number) => Math.min(2048, Math.floor(memTotal / 1024 ** 2));

defineTool({
  // not the 'memory' action key: that one is the AI's notes (bookkeeping the gate lets through at any level); this is a
  // change on a server, so it gets the server's autonomy rules, with T1's limit from assess
  name: 'server.swap', title: 'Add swap when memory is tight', risk: 'write', action: 'server_write', timeoutMs: 3 * 60_000,
  description: 'Give a server a swap file so a memory spike slows it down instead of killing apps: min(2 GB, its memory), only when it has no or little swap and at least 10 GB of disk free; vm.swappiness 10 so it is used only when needed. off: true takes it away again (swapoff, the file and its fstab lines removed). Safe to run again. Warden does this by itself when memory stays tight.',
  input: z.object({ serverId: fid('srv'), off: z.boolean().default(false) }),
  assess: (c, i) => ({ tier: 1, recent: recent(c.db, c.orgId, 'server.swap', i.serverId), shows: i.off ? `swapoff ${SWAP_FILE}, then the file and its fstab lines are removed` : `fallocate, mkswap and swapon ${SWAP_FILE}, an fstab line, vm.swappiness=10`,
    impact: i.off ? 'The server loses the extra swap; apps keep running.' : 'Adds swap. Nothing restarts.' }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const x = ssh(ctx.app);
    if (i.off) {
      await x.check(s, script(SWAP, 'off', 0), { what: 'Removing the swap', timeoutMs: 150_000 });
      ctx.emit('server.swap', `Removed Unit7’s swap from ${s.name}`, { resource: s.id });
      return { removed: SWAP_FILE };
    }
    const p = kv(await x.check(s, script(SWAP_PROBE), { what: 'Reading memory and disk', timeoutMs: 20_000 }));
    const mem = Number(p.mem ?? 0), swap = Number(p.swap ?? 0), free = Number(p.free ?? 0);
    if (p.ours) return { already: true, note: `${s.name} already has Unit7’s swap on.` };
    const mb = swapSize(mem);
    if (mb < 64) throw new Unit7Error('no_memory_info', `Unit7 couldn’t read how much memory ${s.name} has, so it added no swap.`, 502);
    if (swap >= (mb * 1024 ** 2) / 2) throw new Unit7Error('enough_swap', `${s.name} already has ${fmtBytes(swap)} of swap, so more wouldn’t help. Something is using too much memory: look at what grew.`, 409);
    if (free < 10 * GiB) throw new Unit7Error('no_room', `${s.name} has only ${fmtBytes(free)} of disk free. Unit7 adds swap only with 10 GB or more free, so the disk never fills up.`, 409);
    const out = await x.check(s, script(SWAP, 'on', mb), { what: 'Adding swap', timeoutMs: 150_000 });
    if (!out.includes('added')) return { already: true, note: `${s.name} already has Unit7’s swap on.` };
    run(ctx.db, `UPDATE servers SET facts = json_set(facts, '$.swap_total', ?) WHERE id = ?`, swap + mb * 1024 ** 2, s.id);
    const size = mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(/\.0$/, '')} GB` : `${mb} MB`;
    ctx.emit('server.swap', `Added ${size} of swap to ${s.name}: a memory spike now slows it down instead of stopping apps`, { severity: 'success', resource: s.id });
    return { added: size, file: SWAP_FILE, swappiness: 10, undo: { tool: 'server.swap', input: { serverId: s.id, off: true }, label: 'Remove the swap' } };
  },
});

// --- log upkeep ---------------------------------------------------------------------------------------------
// The system journal capped at 500 MB (a drop-in, applied with a journald restart; apps don't notice) and trimmed
// to it, and the package cache emptied. Docker itself is never restarted: containers Unit7 starts rotate their own
// logs (10 MB × 3), set per container. $1 = undo removes the cap again.
export const JOURNAL_CAP = '/etc/systemd/journald.conf.d/unit7.conf';
export const TIDY = ROOT + `C=/etc/systemd/journald.conf.d/unit7.conf
if [ "$1" = undo ]; then if [ -f "$C" ]; then $SU rm -f "$C" && $SU systemctl restart systemd-journald && echo cap=removed; fi; exit 0; fi
before=$(df -P -B1 / | awk 'NR==2{print $3}')
if command -v journalctl >/dev/null 2>&1; then
  if grep -qs '^SystemMaxUse=500M$' "$C"; then echo cap=kept
  else $SU mkdir -p /etc/systemd/journald.conf.d && printf '# Unit7: keep the system journal under 500 MB\\n[Journal]\\nSystemMaxUse=500M\\n' | $SU tee "$C" >/dev/null && $SU systemctl restart systemd-journald && echo cap=set; fi
  $SU journalctl --vacuum-size=500M >/dev/null 2>&1
fi
command -v apt-get >/dev/null 2>&1 && $SU apt-get clean && echo apt=clean
after=$(df -P -B1 / | awk 'NR==2{print $3}')
echo "freed=$((before - after))"`;

defineTool({
  name: 'server.tidy_logs', title: 'Tidy up logs on a server', risk: 'write', action: 'cleanup', timeoutMs: 5 * 60_000,
  description: 'Keep logs from filling a server’s disk, without restarting Docker: caps the system journal at 500 MB (journalctl --vacuum-size and SystemMaxUse=500M in a drop-in) and empties the package cache (apt-get clean). Apps Unit7 deploys already rotate their own logs. Safe to run again; undo: true removes the journal cap.',
  input: z.object({ serverId: fid('srv'), undo: z.boolean().default(false) }),
  // old log lines are gone for good, and after a break-in they're the evidence, so an AI or Warden always asks a person first
  assess: (_c, i) => ({ tier: i.undo ? 1 : 3,
    shows: i.undo ? `rm ${JOURNAL_CAP}, then systemctl restart systemd-journald` : `SystemMaxUse=500M in ${JOURNAL_CAP}, journalctl --vacuum-size=500M, apt-get clean`, impact: 'Old system log lines and downloaded package files go. Apps keep running.' }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const out = kv(await ssh(ctx.app).check(s, script(TIDY, i.undo ? 'undo' : ''), { what: i.undo ? 'Removing the journal cap' : 'Tidying up logs', timeoutMs: 4 * 60_000 }));
    if (i.undo) return { journal: out.cap === 'removed' ? 'no cap any more' : 'there was no cap' };
    const freed = Math.max(0, Number(out.freed) || 0);
    ctx.emit('server.tidied', `Tidied up logs on ${s.name}: freed ${fmtBytes(freed)}`, { resource: s.id });
    return {
      freed: fmtBytes(freed), journal: out.cap ? 'capped at 500 MB' : 'no system journal here', packageCache: out.apt ? 'emptied' : 'none',
      ...(out.cap === 'set' && { undo: { tool: 'server.tidy_logs', input: { serverId: s.id, undo: true }, label: 'Remove the journal cap' } }),
    };
  },
});

// --- time sync ------------------------------------------------------------------------------------------------
// $1 on|off. Turns on systemd's time sync; when there's no time service to turn on, installs one (systemd-timesyncd,
// or chrony), then waits up to 10 seconds for the first sync.
export const TIME_SYNC = ROOT + `command -v timedatectl >/dev/null 2>&1 || { echo "this server has no timedatectl" >&2; exit 3; }
echo "was=$(timedatectl show -p NTP --value 2>/dev/null)"
if [ "$1" = off ]; then $SU timedatectl set-ntp false && echo off=1; exit $?; fi
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then echo already=1; exit 0; fi
if ! $SU timedatectl set-ntp true 2>/dev/null; then
  if command -v apt-get >/dev/null 2>&1; then $SU env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd-timesyncd >/dev/null 2>&1 || $SU env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chrony >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then $SU dnf install -y -q chrony >/dev/null 2>&1 && $SU systemctl enable --now chronyd >/dev/null 2>&1
  fi
  echo installed=1
  $SU timedatectl set-ntp true || exit 4
fi
for i in 1 2 3 4 5 6 7 8 9 10; do [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && { echo synced=1; exit 0; }; sleep 1; done
echo waiting=1`;

defineTool({
  name: 'server.time_sync', title: 'Turn on time sync', risk: 'write', action: 'server_write', timeoutMs: 5 * 60_000,
  description: 'Keep a server’s clock right by itself (timedatectl set-ntp true; installs systemd-timesyncd or chrony when no time service is there). A drifting clock breaks HTTPS, sign-in codes and schedules. Safe to run again; on: false turns it off again.',
  input: z.object({ serverId: fid('srv'), on: z.boolean().default(true) }),
  // it may install a package, so it's a change with an undo, not an easy one
  assess: (_c, i) => ({ tier: 2, shows: i.on ? 'timedatectl set-ntp true (and apt-get install systemd-timesyncd, or chrony, when no time service is there)' : 'timedatectl set-ntp false', impact: 'The clock is set right by itself. Nothing restarts.' }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const out = kv(await ssh(ctx.app).check(s, script(TIME_SYNC, i.on ? 'on' : 'off'), { what: i.on ? 'Turning on time sync' : 'Turning off time sync', timeoutMs: 4 * 60_000 }));
    if (!i.on) return { timeSync: 'off' };
    if (out.already) return { already: true, note: `${s.name}’s clock is already kept in time.` };
    ctx.emit('server.time_sync', `Turned on time sync on ${s.name}`, { severity: 'success', resource: s.id });
    return {
      timeSync: 'on', ...(out.synced ? { synced: true } : { note: 'Time sync is on; the clock catches up within a few minutes.' }), ...(out.installed && { installed: 'the time service' }),
      ...(out.was !== 'yes' && { undo: { tool: 'server.time_sync', input: { serverId: s.id, on: false }, label: 'Turn it off again' } }),
    };
  },
});

// --- secret files never served ----------------------------------------------------------------------------------
defineTool({
  name: 'server.protect_sites', title: 'Hide secret files on every site', risk: 'write', action: 'proxy_config', idempotent: true, timeoutMs: 3 * 60_000,
  description: 'Make every site Unit7 routes on a server answer 404 for secret files (/.env, /.git, /.aws, /.ssh, keys at the root), whatever the app would serve. Sites written from now on have it already; this adds it to older ones in place (their routes stay exactly as they are), checked before it goes live. On a Coolify server only Unit7’s own routes change. Warden runs it by itself; safe to run again.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const r = await guardSites(ctx.app, s);
    run(ctx.db, `UPDATE servers SET facts = json_set(facts, '$.sitesGuard', ?) WHERE id = ?`, SITES_GUARD, s.id);
    if (r.updated.length) ctx.emit('server.protected', `Secret files like .env and .git are now hidden on ${r.updated.length} site${r.updated.length === 1 ? '' : 's'} on ${s.name}`, { severity: 'success', resource: s.id });
    return { sites: r.sites, updated: r.updated.length };
  },
});

// --- HTTPS certificate: renew now, then check it from outside ---------------------------------------------------
export const RENEW = `docker exec unit7-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { echo "the proxy config doesn’t validate" >&2; exit 3; }
docker exec unit7-caddy caddy reload --config /etc/caddy/Caddyfile --force 2>&1`;
// why Caddy couldn't get the certificate, from its own log (the newest few lines that name the host)
export const RENEW_WHY = `docker logs --since 48h unit7-caddy 2>&1 | grep -F -- "$1" | grep -iE 'error|obtain|challenge' | tail -n 3`;
// tests replace these: no request leaves the machine there
export const renewing = { certificate, tries: 8, waitMs: 5000 };
const reasonOf = (lines: string) => {
  for (const l of lines.split('\n').reverse()) { try { const e = JSON.parse(l); if (e.error || e.msg) return String(e.error ?? e.msg).slice(0, 220); } catch { if (l.trim()) return l.trim().slice(0, 220); } }
};

defineTool({
  name: 'domain.renew_https', title: 'Renew an HTTPS certificate now', risk: 'write', action: 'proxy_config', timeoutMs: 3 * 60_000,
  description: 'For a domain Unit7 routes through its own proxy (Caddy) whose certificate runs out soon or is broken: makes the proxy renew it now (a validated, graceful reload that redoes certificate upkeep), then checks the certificate from outside. If it still fails, says why from the proxy’s own log (usually DNS points elsewhere, or port 80 is closed).',
  input: z.object({ domainId: fid('dom') }),
  assess: () => ({ tier: 1, shows: 'caddy validate, then caddy reload --force', impact: 'The proxy reloads gracefully; no visitor is cut off.' }),
  async run(ctx, i) {
    const d = get<{ hostname: string; server_id: string | null }>(ctx.db, 'SELECT d.hostname, s.server_id FROM domains d LEFT JOIN services s ON s.id = d.service_id WHERE d.id = ? AND d.org_id = ?', i.domainId, ctx.orgId);
    if (!d?.server_id) throw new Unit7Error('not_routed', 'Unit7 doesn’t route that domain on one of your servers, so its certificate renews where it’s hosted.', 409);
    assertHostname(d.hostname);
    const s = serverRow(ctx, d.server_id);
    if (proxyFor(s).kind !== 'caddy') throw new Unit7Error('not_caddy', `${s.name}’s web traffic goes through ${proxyFor(s).kind === 'coolify' ? 'Coolify’s proxy, which renews its own certificates' : 'another program'}, so Unit7 can’t renew it here.`, 409);
    ctx.progress(`Asking the proxy on ${s.name} to renew ${d.hostname}…`);
    await ssh(ctx.app).check(s, script(RENEW), { what: 'Renewing the certificate', timeoutMs: 60_000 });
    let c: { validTo?: string; why?: string } = {};
    for (let n = 0; n < renewing.tries; n++) {
      if (n) await sleep(renewing.waitMs);
      c = await renewing.certificate(d.hostname);
      if (c.validTo && !c.why && Date.parse(c.validTo) - Date.now() > 14 * 86400_000) break;
    }
    saveCert(ctx.app, ctx.orgId, { host: d.hostname }, c);
    const left = c.validTo ? Math.floor((Date.parse(c.validTo) - Date.now()) / 86400_000) : undefined;
    if (c.validTo && !c.why && left! > 14) {
      ctx.emit('domain.renewed', `${d.hostname}’s HTTPS certificate is good for ${left} more days`, { severity: 'success', resource: d.hostname });
      return { renewed: true, hostname: d.hostname, daysLeft: left };
    }
    const why = reasonOf((await ssh(ctx.app).exec(s, script(RENEW_WHY, d.hostname), { timeoutMs: 30_000 }).catch(() => ({ stdout: '' }))).stdout);
    throw new Unit7Error('renew_failed', `The proxy tried again, but ${d.hostname}’s certificate didn’t renew${why ? `: ${ctx.redactor.redact(why)}` : ''}. Usually the name doesn’t point at this server any more, or port 80 is closed to the internet.`, 502);
  },
});

export const sitesGuarded = (facts: string) => json<{ sitesGuard?: number }>(facts, {}).sitesGuard === SITES_GUARD;
