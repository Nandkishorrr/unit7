// The security check. One read-only pass over everything Unit7 can see: each server (what answers the
// internet, SSH settings, failed sign-ins, firewall, containers, disk, updates, secrets printed in logs),
// each app (known security holes, secrets with public names, .env or .git served on the web), each
// domain (HTTPS, registration, email spoofing, takeover) and Unit7 itself (Autopilot, keys, backups).
// Every finding says what it is in plain words and carries its fix: a tool to run (run and approved like
// any other) or the steps when a person has to do it. Each run is saved as a report; Warden runs it
// weekly and alerts on what's new and serious. Nothing here changes anything; the fixes are other tools.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { proxyOf } from '../deploy/caddy.ts';
import { assertReachable, classify } from '../netguard.ts';
import { pool } from '../discovery/scanners.ts';
import { askPath, checkDaily, serverOf, targets, watchRows } from '../sentinel/watch.ts';
import { isPublicKey, learnSecrets } from './env.ts';
import { leakPlan } from './autopilot.ts';
import { serverRow, type Facts } from './servers.ts';
import { fid } from './helpers.ts';
import { AUTONOMY } from '../policy.ts';
import { serverFindings as xrayFindings, stillOpenFinding, closedWords, portWhat } from '../discovery/findings.ts';
import { checkOutside, forgetOutside, type Reach } from '../discovery/outside.ts';
import { coolifyLockout } from './coolify-dashboard.ts';
import { lastXray } from './xray.ts';
import { explainFinding, type Explain } from '../explain.ts';
import { snoozeState, stillHidden, visible } from '../snooze.ts';
import { alertsVerified } from '../sentinel/phone.ts';
import { appsOf, partChecks } from '../care/partchecks.ts';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
type Act = { tool: string; input: Record<string, unknown>; label: string };
// a tool to run (change: what it does, in one line; safe: low-risk and reversible, so "Fix all safe ones" may
// run it; byHand: optional extra steps a person may take; typeName: hard to undo, so the person types this name first)
// or the steps a person takes (ask: a question the button sends straight to Unit7's AI instead)
// alt: other one-click ways to fix the same thing, offered second (e.g. "Use Coolify's backups" next to Unit7's own)
// flow: a guided pop-up does it in steps (coolify-domain: give Coolify a domain, then close its port), manual the fallback
export type Fix = (Act & { change: string; safe?: boolean; undo?: Act; byHand?: string[]; typeName?: string; alt?: (Act & { change: string; safe?: boolean; undo?: Act })[] }) | { manual: string[]; label?: string; href?: string; ask?: string; flow?: { kind: 'coolify-domain'; serverId: string } };
export interface Finding {
  id: string; severity: Severity; area: 'server' | 'app' | 'domain' | 'unit7'; title: string; detail: string;
  evidence?: string; about?: { kind: 'server' | 'app' | 'domain'; id?: string; name: string }; serverId?: string; fix?: Fix; by: 'unit7' | 'ai';
  at?: string; // when an AI added it
  explain?: Explain; // plain words (src/explain.ts), added where findings are shown
  back?: string;     // a person hid it for a while and it's still here ("Back after 7 days: still here")
}
export interface Coverage { apps: { checked: number; found: number }; skipped: string[]; unscanned?: string[] }
export interface Report { coverage?: Coverage; id: string; at: string; serverId: string | null; by: string; score: number; counts: Record<Severity, number>; findings: Finding[]; notes: string[]; fresh: string[]; ms: number }

const WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1, info: 0 };
const countsOf = (f: Finding[]) => Object.fromEntries(SEVERITIES.map((s) => [s, f.filter((x) => x.severity === s).length])) as Record<Severity, number>;
// 100 with nothing to fix; each problem takes off less as they add up, so a long list still shows progress as it shrinks
const scoreOf = (c: Record<Severity, number>) => Math.round(100 / (1 + SEVERITIES.reduce((n, s) => n + WEIGHT[s] * (c[s] ?? 0), 0) / 50));
// a door Unit7 saw open caps the score, so a long list of small wins can never hide a readable database
export const capOf = (f: Pick<Finding, 'severity' | 'by'>[]) => (f.some((x) => x.by === 'unit7' && x.severity === 'critical') ? 40 : f.some((x) => x.by === 'unit7' && x.severity === 'high') ? 70 : 100);
export const score = (f: Finding[]) => Math.min(scoreOf(countsOf(f)), capOf(f));
const rank = (s: Severity) => SEVERITIES.indexOf(s);
// tests and demo copies set this: no requests to real sites or DNS
const offline = () => !!process.env.UNIT7_SKIP_NET_PROBE;

// --- servers ---------------------------------------------------------------------------------------
// One round trip. Sections start with "@@unit7 <name>"; logs are read for secrets here and never kept.
const AUDIT = `SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"
echo "@@unit7 sshd"; $SU sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|maxauthtries) '
echo "@@unit7 listen"; { $SU ss -tlnpH 2>/dev/null || ss -tlnH 2>/dev/null || netstat -tln 2>/dev/null | tail -n +3; } | awk '{print $4, $6}'
echo "@@unit7 ufw"; command -v ufw >/dev/null 2>&1 && $SU ufw status 2>/dev/null
echo "@@unit7 iptables"; $SU iptables -S 2>/dev/null | grep -E 'DOCKER-USER|unit7-close'
echo "@@unit7 docker"; docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null
echo "@@unit7 inspect"; docker ps -q 2>/dev/null | head -60 | xargs -r docker inspect --format '{{.Name}}|{{.HostConfig.Privileged}}|{{range .Mounts}}{{.Source}};{{end}}' 2>/dev/null
echo "@@unit7 disk"; df -P / 2>/dev/null | awk 'NR==2{print $5}'
echo "@@unit7 reboot"; [ -f /var/run/reboot-required ] && echo yes
echo "@@unit7 updates"; command -v apt-get >/dev/null 2>&1 && apt list --upgradable 2>/dev/null | grep -c -- '-security'
echo "@@unit7 auto"; grep -s 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades
echo "@@unit7 clock"; command -v timedatectl >/dev/null 2>&1 && { timedatectl show -p NTPSynchronized -p NTP 2>/dev/null; timedatectl timesync-status 2>/dev/null | grep -i 'offset:'; }; command -v chronyc >/dev/null 2>&1 && chronyc tracking 2>/dev/null | grep -i '^system time'
echo "@@unit7 fails"; L=$($SU journalctl -u ssh -u sshd --since "24 hours ago" --no-pager -q 2>/dev/null); [ -n "$L" ] || L=$($SU tail -n 20000 /var/log/auth.log 2>/dev/null)
printf '%s\\n' "$L" | grep -E 'Failed password|Invalid user|authentication failure' | grep -oE 'from [0-9a-fA-F.:]+' | awk '{print $2}' | sort | uniq -c | sort -rn | head -5
for c in $(docker ps --format '{{.Names}}' 2>/dev/null | head -25); do echo "@@unit7 log $c"; docker logs --tail 300 "$c" 2>&1 | tail -c 30000; done
echo "@@unit7 end"`;

export function sections(out: string) {
  const m = new Map<string, string[]>();
  let cur: string[] | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('@@unit7 ')) m.set(line.slice(8).trim(), (cur = []));
    else if (cur && line.trim()) cur.push(line.trimEnd());
  }
  return m;
}

const DB_PORTS: Record<number, string> = { 5432: 'PostgreSQL', 3306: 'MySQL', 6379: 'Redis', 27017: 'MongoDB', 9200: 'Elasticsearch', 5984: 'CouchDB', 11211: 'Memcached' };
const COOLIFY_PORTS: Record<number, string> = { 8000: 'Coolify’s dashboard', 6001: 'Coolify’s live updates', 6002: 'Coolify’s terminal' };
const wildcard = (a: string) => ['0.0.0.0', '*', '::', ''].includes(a) || classify(a) === 'public';
const closeFix = (serverId: string, port: number, safe: boolean, label = 'Close this port'): Fix => ({
  tool: 'server.close_port', input: { serverId, port }, label, safe,
  change: `Blocks port ${port} from the internet at the server’s own firewall. Nothing else changes; you can open it again.`,
  undo: { tool: 'server.close_port', input: { serverId, port, open: true }, label: 'Open it again' },
});
const look = (label: string, q: string, manual: string[]): Fix => ({ label, manual, ask: `${q} Look first, read-only, and tell me in plain words what you’d change. Ask before changing anything.` });
const harden = (serverId: string, label = 'Lock it down'): Fix => ({ tool: 'server.harden', input: { serverId }, label,
  change: 'Turns off password logins (keys still work), turns on automatic security updates and kernel hardening.' });

// What the audit says, as findings. Pure, so it can be tested with made-up output.
export function serverFindings(s: Pick<ServerRow, 'id' | 'name' | 'port' | 'provider_ref'>, facts: Facts & { hardenedAt?: string }, out: string): { findings: Finding[]; notes: string[] } {
  const sec = sections(out), list = (k: string) => sec.get(k) ?? [];
  const findings: Finding[] = [], notes: string[] = [];
  const about = { kind: 'server' as const, id: s.id, name: s.name };
  const add = (f: Omit<Finding, 'about' | 'by' | 'area' | 'serverId'>) => findings.push({ ...f, area: 'server', about, serverId: s.id, by: 'unit7' });
  const proxy = proxyOf(facts);
  // sharedHost: the box already ran other things when Unit7 came (servers.ts); prepare leaves its firewall alone
  const shared = proxy.kind !== 'caddy' || !!(facts as { sharedHost?: string }).sharedHost, coolify = proxy.kind === 'coolify';

  // SSH: who can sign in, and how
  const sshd = Object.fromEntries(list('sshd').map((l) => l.toLowerCase().split(/\s+/) as [string, string]));
  const passwords = sshd.passwordauthentication === 'yes' || sshd.kbdinteractiveauthentication === 'yes';
  if (!list('sshd').length) notes.push(`Couldn’t read ${s.name}’s sign-in settings (that needs root or passwordless sudo).`);
  else if (passwords) add({ id: `server:ssh-password:${s.id}`, severity: sshd.permitrootlogin === 'yes' ? 'critical' : 'high',
    title: sshd.permitrootlogin === 'yes' ? `Anyone can try to guess ${s.name}’s root password` : `${s.name} accepts passwords to sign in`,
    detail: 'Passwords can be guessed by bots that try all day. Keys can’t.', evidence: `SSH settings: password sign-in on, root sign-in ${sshd.permitrootlogin ?? 'unknown'}, ${sshd.maxauthtries ?? '?'} tries per connection`, fix: harden(s.id) });
  else if (Number(sshd.maxauthtries) > 6) add({ id: `server:ssh-tries:${s.id}`, severity: 'low', title: `${s.name} allows many sign-in tries per connection`, detail: 'Fewer tries means bots give up sooner.', evidence: `MaxAuthTries ${sshd.maxauthtries}`, fix: harden(s.id) });

  // failed sign-ins in the last day
  const fails = list('fails').map((l) => l.trim().split(/\s+/)).filter((x) => x.length === 2).map(([n, ip]) => ({ n: Number(n), ip: ip! }));
  const total = fails.reduce((a, f) => a + f.n, 0);
  if (total >= 50) {
    const top = fails[0]!;
    add({ id: `server:ssh-guessing:${s.id}`, severity: passwords ? 'high' : 'low', title: `${total} failed sign-in tries on ${s.name} in the last day`,
      detail: passwords ? 'Someone is guessing passwords, and password sign-in is on.' : 'Bots are guessing, but sign-in needs a key, so guessing can’t get in.',
      evidence: `Most from: ${fails.slice(0, 3).map((f) => `${f.ip} (${f.n})`).join(', ')}`,
      fix: passwords ? harden(s.id, 'Turn off passwords') : /^\d+\.\d+\.\d+\.\d+$/.test(top.ip) && classify(top.ip) === 'public' ? { tool: 'shield.block', input: { serverId: s.id, ip: top.ip, reason: 'many failed sign-ins' }, label: `Block ${top.ip}`, safe: true,
        change: `Blocks ${top.ip} for 15 minutes, longer if it comes back. It lifts by itself.`, undo: { tool: 'shield.unblock', input: { serverId: s.id, ip: top.ip }, label: 'Unblock it' } } : undefined });
  }

  // what answers the internet: Docker's published ports (they skip ufw), and programs on the server where nothing filters
  const ufw = list('ufw');
  const ufwOn = /Status: active/i.test(ufw[0] ?? '');
  const ipt = list('iptables');
  const closed = new Set([...ipt.join('\n').matchAll(/unit7-close-(\d+)/g)].map((m) => Number(m[1])));
  const guard = ipt.some((l) => /^-A DOCKER-USER -i \S+ -j DROP$/.test(l)); // server.harden's: only 80/443 reach containers
  const open = new Map<number, string>(); // port -> what answers on it
  const containers = list('docker').map((l) => { const [name = '', image = '', ports = ''] = l.split('|'); return { name, image, ports }; });
  for (const c of containers) {
    for (const m of c.ports.matchAll(/(?:(\[::\]|::|[\d.]+):)?(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp/g)) {
      if (m[1] && !wildcard(m[1].replace(/[[\]]/g, ''))) continue;
      for (let p = Number(m[2]); p <= Number(m[3] ?? m[2]); p++) if (!(guard && p !== 80 && p !== 443)) open.set(p, `${c.name} (${c.image})`);
    }
  }
  for (const l of list('listen')) {
    const [local = '', proc = ''] = l.split(/\s+/);
    const i = local.lastIndexOf(':'), addr = local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, ''), port = Number(local.slice(i + 1));
    if (!port || !wildcard(addr) || open.has(port)) continue;
    const allowed = !ufwOn || ufw.some((u) => new RegExp(`^${port}(/tcp)?\\s+ALLOW`, 'i').test(u));
    const name = /users:\(\("([^"]+)"/.exec(proc)?.[1];
    if (allowed && name !== 'docker-proxy') open.set(port, name ? `the program ${name}` : 'a program on the server');
  }
  const coolifyOwn: number[] = [];
  const outside = (facts as { outside?: Record<string, Reach> }).outside ?? {};
  for (const [port, what] of [...open].sort((a, b) => a[0] - b[0])) {
    // closed by Unit7: gone, unless the outside check (from this computer) still got through
    if (closed.has(port) && outside[String(port)]?.state === 'open') { add(stillOpenFinding(s.id, s.name, port, coolify && COOLIFY_PORTS[port] ? COOLIFY_PORTS[port]! : what, outside[String(port)]!, { docker: !what.startsWith('the program') && !what.startsWith('a program'), chains: [...new Set(ipt.filter((l) => l.includes(`unit7-close-${port} `)).map((l) => /^-[AI] (\S+)/.exec(l)?.[1]).filter(Boolean) as string[])] })); continue; }
    if (port === s.port || port === 22 || port === 80 || port === 443 || closed.has(port)) continue;
    if (coolify && COOLIFY_PORTS[port]) { coolifyOwn.push(port); continue; }
    const base = { evidence: `Port ${port}: ${what}` };
    if (port === 2375 || port === 2376) add({ ...base, id: `server:port:${s.id}:${port}`, severity: 'critical', title: `Docker’s control port is open on ${s.name}`, detail: 'Anyone who reaches it can run anything on the server, as its owner.', fix: closeFix(s.id, port, true) });
    else if (DB_PORTS[port]) add({ ...base, id: `server:port:${s.id}:${port}`, severity: 'high', title: `A ${DB_PORTS[port]} database on ${s.name} answers the internet`, detail: 'Databases belong on the private network, where only your apps reach them. Bots try database passwords all day.', fix: closeFix(s.id, port, true) });
    else if (coolify && port === 8080) add({ ...base, id: `server:port:${s.id}:${port}`, severity: 'high', title: `Coolify’s proxy dashboard is open on ${s.name}`, detail: 'Port 8080 shows every site and route on this server to anyone, without a password. Coolify doesn’t need it open.', fix: closeFix(s.id, port, true) });
    else if (port === 2019) add({ ...base, id: `server:port:${s.id}:${port}`, severity: 'high', title: `The web proxy’s admin port is open on ${s.name}`, detail: 'Whoever reaches it can change where your sites go.', fix: closeFix(s.id, port, true) });
    else add({ ...base, id: `server:port:${s.id}:${port}`, severity: 'medium', title: `Port ${port} on ${s.name} is open to the internet`, detail: 'Something answers there directly, without HTTPS or Shield in front. If nothing outside needs it, close it.', fix: closeFix(s.id, port, false) });
  }
  if (coolifyOwn.length) add({ id: `server:coolify-ports:${s.id}`, severity: 'info', title: `Coolify’s own ports are open on ${s.name}`, detail: `${coolifyOwn.map((p) => `${p} (${COOLIFY_PORTS[p]})`).join(', ')}. Coolify needs these; that’s expected.` });

  // firewall: on a shared server (Coolify) other apps need their own ports, so Unit7 closes single ports instead
  if (!ufwOn) {
    if (shared) add({ id: `server:firewall:${s.id}`, severity: 'info', title: `${s.name} has no firewall, on purpose`, detail: `${coolify ? 'Coolify' : proxy.kind === 'other' ? proxy.name : 'Other apps'} manage${coolify || proxy.kind === 'other' ? 's' : ''} this server’s ports, so Unit7 leaves the firewall to ${coolify || proxy.kind === 'other' ? 'it' : 'them'}. It closes single ports instead: each open one is listed here with its own fix.` });
    else add({ id: `server:firewall:${s.id}`, severity: 'medium', title: `${s.name}’s firewall is off`, detail: 'A firewall keeps every door shut except the ones your apps need.', evidence: ufw.length ? ufw[0] : 'No firewall (ufw) installed',
      fix: { tool: 'server.bootstrap', input: { serverId: s.id, swap: false, securityUpdates: false }, label: 'Turn it on', change: 'Turns the firewall on: only sign-in (SSH) and web (80, 443) stay open. Everything else Unit7 set up stays as it is.' } });
  }

  // containers that can take over the whole server
  const strong = list('inspect').map((l) => { const [name = '', priv = '', mounts = ''] = l.split('|'); return { name: name.replace(/^\//, ''), priv: priv === 'true', sock: /docker\.sock/.test(mounts) }; }).filter((c) => c.priv || c.sock);
  const expected = strong.filter((c) => /^coolify(-|$)/.test(c.name));
  for (const c of strong.filter((x) => !expected.includes(x))) add({ id: `server:container:${s.id}:${c.name}`, severity: 'medium', title: `${c.name} can control all of ${s.name}`,
    detail: `It runs ${c.priv ? 'with full privileges' : 'with Docker’s control socket'}. If it’s broken into, so is the server.`, evidence: `${c.name}: ${[c.priv && 'privileged', c.sock && 'docker.sock mounted'].filter(Boolean).join(', ')}`,
    fix: look('Ask Unit7 to check it', `On my server ${s.name}: ${c.name} runs ${c.priv ? 'privileged' : 'with Docker’s control socket'}. Does it really need that?`, [`Check that ${c.name} really needs this (tools like Portainer or Watchtower do).`, 'If not, remove the privileged setting or the docker.sock volume from its settings and restart it.']) });
  if (expected.length) add({ id: `server:coolify-docker:${s.id}`, severity: 'info', title: 'Coolify’s own containers control Docker', detail: `${expected.map((c) => c.name).join(', ')}. That’s how Coolify works; expected.` });

  // disk, restarts, updates
  const disk = Number((list('disk')[0] ?? '').replace('%', ''));
  if (disk >= 80) add({ id: `server:disk:${s.id}`, severity: disk >= 90 ? 'high' : 'medium', title: `${s.name}’s disk is ${disk}% full`, detail: 'A full disk stops databases and logins. Old images and build leftovers are usually the cause.', evidence: `Disk ${disk}% used`,
    fix: { tool: 'docker.prune', input: { serverId: s.id }, label: 'Free up space', safe: true, change: 'Removes unused images and build leftovers older than a day. Never touches data.' } });
  if (list('reboot').length) add({ id: `server:reboot:${s.id}`, severity: 'low', title: `${s.name} needs a restart to finish updates`, detail: 'Some security updates only take effect after a restart.',
    fix: { tool: 'server.reboot', input: { serverId: s.id }, label: 'Restart it now', change: 'Restarts the server: a fresh backup of its databases first, about a minute offline, then Unit7 checks every site comes back.',
      alt: [{ tool: 'reboot.window', input: { serverId: s.id, days: [0, 1, 2, 3, 4, 5, 6], start: '04:00', minutes: 60 }, label: 'Restart at night instead', change: 'Lets Unit7 restart it between 04:00 and 05:00 (server time) whenever updates need it, with a warning 10 minutes before. You can change or remove the window.' }],
      byHand: ['Pick a quiet moment.', 'Restart the server from your provider’s dashboard (or run: sudo reboot).', 'Your apps come back by themselves.'] } });
  const pending = Number(list('updates')[0] ?? 0), auto = list('auto').length > 0;
  if (list('updates').length && !auto) add({ id: `server:updates:${s.id}`, severity: pending ? 'medium' : 'low', title: pending ? `${pending} security update${pending === 1 ? '' : 's'} waiting on ${s.name}` : `Security updates don’t install by themselves on ${s.name}`,
    detail: 'Turn on automatic security updates and they install every night.', evidence: `${pending} security updates pending, automatic updates off`, fix: harden(s.id, 'Turn on updates') });
  else if (pending > 0) add({ id: `server:updates:${s.id}`, severity: 'info', title: `${pending} security update${pending === 1 ? '' : 's'} install tonight on ${s.name}`, detail: 'Automatic updates are on; nothing to do.' });

  // the clock: kept in time by itself, or drifting (only where systemd's timedatectl answers)
  const clock = Object.fromEntries(list('clock').filter((l) => /^NTP\w*=/.test(l)).map((l) => l.split('=') as [string, string]));
  const off = clockOffset(list('clock'));
  if (clock.NTPSynchronized === 'no') add({ id: `server:clock:${s.id}`, severity: off !== undefined && Math.abs(off) >= 5 ? 'high' : 'medium', title: `${s.name}’s clock isn’t kept in time`,
    detail: 'A drifting clock breaks HTTPS, sign-in codes and scheduled backups. Time sync keeps it right by itself.',
    evidence: `Time sync ${clock.NTP === 'yes' ? 'on, but not synced yet' : 'off'}${off !== undefined ? `; ${Math.abs(off) < 1 ? `${Math.round(Math.abs(off) * 1000)} ms` : `${Math.abs(off).toFixed(1)} seconds`} ${off < 0 ? 'behind' : 'ahead'}` : ''}`,
    fix: { tool: 'server.time_sync', input: { serverId: s.id }, label: 'Turn on time sync', change: 'Turns on the server’s own time sync (adds the small time service if it’s missing). Nothing restarts.' } });
  return { findings, notes };
}

// seconds the clock is off (positive: ahead), from systemd's "Offset: +1.234ms" or chrony's "System time: 0.5 seconds fast"
export function clockOffset(lines: string[]): number | undefined {
  for (const l of lines) {
    const t = /offset:\s*([+-]?[\d.]+)(us|µs|ms|s|min)\b/i.exec(l);
    if (t) return Number(t[1]) * ({ us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1, min: 60 } as Record<string, number>)[t[2]!.toLowerCase()]!;
    const c = /system time\s*:\s*([\d.]+) seconds (fast|slow)/i.exec(l);
    if (c) return Number(c[1]) * (c[2]!.toLowerCase() === 'fast' ? 1 : -1);
  }
}

// secrets printed in container logs: the values Unit7 knows (env settings) and well-known key shapes
function logFindings(ctx: Ctx, s: ServerRow, out: string): Finding[] {
  const svcs = all<{ id: string; name: string; project_id: string; container: string }>(ctx.db, `SELECT s.id, s.name, s.project_id, d.container FROM services s JOIN deployments d ON d.id = s.current_deployment_id
    WHERE s.server_id = ? AND s.org_id = ? AND d.container IS NOT NULL`, s.id, ctx.orgId);
  for (const svc of svcs) learnSecrets(ctx, svc.id);
  const findings: Finding[] = [];
  for (const [k, lines] of sections(out)) {
    if (!k.startsWith('log ')) continue;
    const name = k.slice(4), hits = new Map<string, number>();
    for (const m of ctx.redactor.redact(lines.join('\n')).matchAll(/\[redacted(?: ([^\]]+))?\]/g)) {
      const label = !m[1] ? 'a password in a web address' : m[1].startsWith('credential://') ? 'a database password' : m[1];
      hits.set(label, (hits.get(label) ?? 0) + 1);
    }
    if (!hits.size) continue;
    const svc = svcs.find((x) => name === x.container || name.startsWith(`${x.container}-r`));
    const keys = [...hits.keys()].filter((l) => l.startsWith('env ')).map((l) => l.slice(4));
    const plan = svc && keys.length ? leakPlan(ctx.db, ctx.orgId, svc.id, keys).plan[0] : undefined;
    findings.push({ id: `app:log-secret:${s.id}:${svc?.id ?? name}`, severity: keys.length ? 'high' : 'medium', area: 'app', by: 'unit7', serverId: s.id,
      about: svc ? { kind: 'app', id: svc.id, name: svc.name } : { kind: 'server', id: s.id, name: s.name },
      title: `${svc?.name ?? name} prints secrets in its logs`, detail: 'Anyone who can read the logs (a support tool, a log service, a teammate) can read these. Treat them as known.',
      evidence: `${[...hits].map(([l, n]) => `${l.replace(/^env /, '')} ×${n}`).join(', ')} (values hidden)`,
      fix: plan ? { tool: plan.tool, input: plan.input, label: 'Change it now', change: plan.tool === 'link.rotate' ? 'Gives the connection a new key; the old one keeps working for a day.' : 'Changes the database password and redeploys the apps that use it.' }
        : { manual: [`Change ${keys.length ? keys.join(', ') : 'the secret'} where it comes from (the provider’s dashboard), then paste the new value into Unit7.`, 'Ask your AI to stop the app printing it (remove the log line).'], href: svc ? `/projects/${svc.project_id}?tab=variables` : undefined,
          label: 'Ask Unit7 to help', ask: `${svc?.name ?? name} on ${s.name} prints secrets in its logs (${keys.length ? keys.join(', ') : 'values Unit7 hid'}). Find the line that prints them and stop it, and help me change the secret where it comes from. Ask before changing anything.` } });
  }
  return findings;
}

async function checkServer(ctx: Ctx, s: ServerRow): Promise<{ findings: Finding[]; notes: string[] }> {
  ctx.progress(`Looking inside ${s.name}: open ports, sign-in, firewall, containers…`);
  const facts = json<Facts & { hardenedAt?: string }>(s.facts, {});
  try {
    const r = await ssh(ctx.app).exec(s, script(AUDIT), { timeoutMs: 40_000, maxBytes: 3 * 1024 * 1024, signal: ctx.signal });
    const res = serverFindings(s, facts, r.stdout);
    ctx.progress(`Reading ${s.name}’s logs for leaked secrets…`);
    return { findings: [...res.findings, ...logFindings(ctx, s, r.stdout)], notes: res.notes };
  } catch (e) {
    const why = (e as Error).message.replace(/ Unit7 tries again in .*$/, '');
    return { notes: [`Couldn’t reach ${s.name}: ${why}`], findings: [{ id: `server:unreachable:${s.id}`, severity: 'low', area: 'server', by: 'unit7', serverId: s.id, about: { kind: 'server', id: s.id, name: s.name },
      title: `Couldn’t look inside ${s.name}`, detail: `Unit7 couldn’t reach it, so its ports, sign-in and logs weren’t checked. ${why}`,
      fix: { manual: ['Open the server and run its health check: Unit7 finds out why and offers a fix.'], label: 'Show me how', href: `/servers/${s.id}` } }] };
  }
}

// --- apps --------------------------------------------------------------------------------------------
function appFindings(db: DB, orgId: string, serverId?: string): Finding[] {
  const out: Finding[] = [];
  for (const a of all<{ id: string; name: string; server_id: string | null; config: string; plan: string }>(db, `SELECT s.id, s.name, s.server_id, s.config, d.plan FROM services s JOIN deployments d ON d.id = s.current_deployment_id
      WHERE s.org_id = ? AND d.status = 'live' AND (? IS NULL OR s.server_id = ?)`, orgId, serverId ?? null, serverId ?? null)) {
    const sec = json<{ security?: { critical: number; high: number; top: { id: string; pkg: string; installed: string; fixed: string }[] } }>(a.plan, {}).security;
    if (!sec || sec.critical + sec.high === 0) continue;
    const git = json<{ source?: { type?: string } }>(a.config, {}).source?.type === 'git';
    out.push({ id: `app:vulns:${a.id}`, severity: sec.critical ? 'high' : 'medium', area: 'app', by: 'unit7', serverId: a.server_id ?? undefined, about: { kind: 'app', id: a.id, name: a.name },
      title: `${a.name} uses packages with known security holes`, detail: `${sec.critical} critical and ${sec.high} high, each with a fixed version available.`,
      evidence: sec.top.slice(0, 3).map((v) => `${v.pkg} ${v.installed} → ${v.fixed} (${v.id})`).join('; '),
      fix: git ? { tool: 'security.fix_pr', input: { serviceId: a.id }, label: 'Open a fix', change: 'Opens a pull request that updates these packages; a preview deploys for it. Nothing goes live until it’s merged.' }
        : { label: 'Ask Unit7 to update them', ask: `${a.name} uses packages with known security holes. Upgrade ${sec.top.slice(0, 3).map((v) => `${v.pkg} to ${v.fixed}`).join(', ')}, then redeploy it. Show me the plan first.`, manual: [`Ask your AI to upgrade ${sec.top.slice(0, 3).map((v) => `${v.pkg} to ${v.fixed}`).join(', ')}, then redeploy.`] } });
  }
  if (serverId) return out;
  // a secret under a public name ships to every visitor's browser
  for (const v of all<{ key: string; scope_type: string; scope_id: string }>(db, `SELECT DISTINCT key, scope_type, scope_id FROM env_vars WHERE org_id = ? AND secret = 1 AND deleted_at IS NULL`, orgId).filter((v) => isPublicKey(v.key)).slice(0, 5)) {
    const project = v.scope_type === 'project' ? v.scope_id : get<{ p: string }>(db, v.scope_type === 'environment' ? 'SELECT project_id p FROM environments WHERE id = ?' : 'SELECT project_id p FROM services WHERE id = ?', v.scope_id)?.p;
    out.push({ id: `app:public-secret:${v.scope_id}:${v.key}`, severity: 'high', area: 'app', by: 'unit7', title: `${v.key} would ship to every visitor’s browser`,
      detail: 'It holds a secret, but its name starts with a public prefix, so the build puts it in the page for anyone to read.',
      fix: { manual: [`Rename ${v.key} without the public prefix (NEXT_PUBLIC_, VITE_, …) and read it only on the server.`, 'If it was already deployed, change the secret where it comes from.'], href: project ? `/projects/${project}?tab=variables` : undefined,
        label: 'Ask Unit7 to fix it', ask: `The secret setting ${v.key} has a public prefix, so the build ships it to every visitor’s browser. Rename it so it stays on the server, change where the code reads it, and help me change the secret. Show me the plan first.` } });
  }
  return out;
}

// .env and .git/config served over the web: a small read of each, never more than the first few KB
const ENV_FILE = /^\s*(?:export\s+)?[A-Z_][A-Z0-9_]*=\S/m, GIT_CONFIG = /\[core\][\s\S]*repositoryformatversion/;
export function exposedFiles(path: string, text: string) {
  if (/<(html|!doctype|head|body)\b/i.test(text)) return undefined; // a page (a single-page app answers every path)
  if (path === '/.env' && ENV_FILE.test(text)) return { first: /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/m.exec(text)?.[1] };
  if (path === '/.git/config' && GIT_CONFIG.test(text)) return {};
}
async function siteFindings(ctx: Ctx): Promise<Finding[]> {
  if (offline()) return [];
  const list = targets(ctx.app, ctx.orgId).filter((t) => !/\.(sslip|nip)\.io$/.test(t.host)).slice(0, 40);
  if (!list.length) return [];
  ctx.progress(`Checking ${list.length} site${list.length === 1 ? '' : 's'} for exposed files…`);
  const out: Finding[] = [];
  await pool(list, 8, async (t) => {
    try { await assertReachable(t.host); } catch { return; }
    const s = await serverOf(ctx.app, ctx.orgId, t.host);
    for (const path of ['/.env', '/.git/config']) {
      const r = await askPath(ctx.app, s, t.host, path);
      const hit = r?.status === 200 && exposedFiles(path, r.text);
      if (!hit) continue;
      const env = path === '/.env';
      out.push({ id: `app:exposed:${t.host}:${path}`, severity: env ? 'critical' : 'high', area: 'app', by: 'unit7', about: { kind: 'app', id: t.asset, name: t.name },
        title: env ? `${t.host} shows its secret settings file to anyone` : `${t.host} shows its code history to anyone`,
        detail: env ? 'Its .env file (passwords and keys) downloads from the web. Assume everything in it is known.' : 'Its .git folder downloads from the web, so anyone can rebuild your code and any secret ever committed.',
        evidence: `https://${t.host}${path} answered${'first' in hit && hit.first ? ` with settings (starts with ${hit.first}=…, values hidden)` : ' with the file'}`,
        fix: { label: 'Ask Unit7 to fix it', ask: `https://${t.host}${path} downloads from the web. Stop the site serving ${env ? 'its .env file' : 'its .git folder'} (block dot-files), then help me change ${env ? 'every key and password that was in it' : 'any secret that was ever committed'}. Show me the plan first.`, manual: env ? [`Stop serving ${path}: move it out of the site’s public folder (or ask your AI to block dot-files).`, 'Change every key and password that was in it, starting with the database and payment keys.', 'Run this check again.']
          : [`Stop serving ${path}: remove the .git folder from the deployed files (or ask your AI to block dot-files).`, 'If a secret was ever committed, change it.', 'Run this check again.'] } });
    }
  });
  return out;
}

// --- domains (the outside checks Warden keeps, refreshed when they're old) ----------------------------------
async function domainFindings(ctx: Ctx): Promise<Finding[]> {
  const fresh = (rows: ReturnType<typeof watchRows>) => rows.filter((w) => w.kind !== 'site').map((w) => w.checked_at ?? '').sort().at(-1);
  let rows = watchRows(ctx.app, ctx.orgId);
  const last = fresh(rows);
  if (!offline() && targets(ctx.app, ctx.orgId).length && (!last || Date.parse(last) < Date.now() - 86400_000)) {
    ctx.progress('Checking HTTPS certificates, domain renewals and email protection…');
    await checkDaily(ctx.app, ctx.orgId).catch(() => undefined);
    rows = watchRows(ctx.app, ctx.orgId);
  } else ctx.progress('Checking HTTPS, domains and email protection…');
  const managed = new Map(all<{ id: string; hostname: string }>(ctx.db, 'SELECT id, hostname FROM domains WHERE org_id = ?', ctx.orgId).map((d) => [d.hostname, d.id]));
  // names Unit7 routes through its own proxy (Caddy) can be renewed right here
  const caddy = new Set(all<{ hostname: string; facts: string }>(ctx.db, `SELECT d.hostname, sv.facts FROM domains d JOIN services s ON s.id = d.service_id JOIN servers sv ON sv.id = s.server_id WHERE d.org_id = ?`, ctx.orgId)
    .filter((d) => proxyOf(json(d.facts, {})).kind === 'caddy').map((d) => d.hostname));
  const renew = (host: string): Fix => ({ tool: 'domain.renew_https', input: { domainId: managed.get(host) }, label: 'Renew now', safe: true, change: 'Asks Unit7’s web proxy to renew the certificate now, then checks it from outside. Nothing else changes.' });
  const recheck = (host: string): Fix => managed.has(host) ? { tool: 'domain.check', input: { domainId: managed.get(host) }, label: 'Check again', safe: true, change: 'Checks DNS and HTTPS again. HTTPS certificates renew by themselves; this confirms it.' }
    : { tool: 'watch.check', input: { daily: true }, label: 'Check again', safe: true, change: 'Runs the outside checks again: sites, certificates, renewals, email.' };
  const out: Finding[] = [];
  const add = (f: Omit<Finding, 'area' | 'by'>) => out.push({ ...f, area: 'domain', by: 'unit7' });
  for (const w of rows) {
    const about = { kind: 'domain' as const, name: w.host };
    // a temporary address (sslip.io, nip.io) never gets a real certificate: that's how it is, not a renewal failing
    if (w.kind === 'tls' && !/\.(sslip|nip)\.io$/.test(w.host) && (w.status === 'expiring' || w.status === 'broken')) {
      const left = w.value ? Math.floor((Date.parse(w.value) - Date.now()) / 86400_000) : undefined;
      add({ id: `domain:tls:${w.host}`, about, severity: w.status === 'broken' || (left !== undefined && left <= 3) ? 'high' : 'medium', title: w.status === 'broken' ? `${w.host}’s HTTPS certificate is broken` : `${w.host}’s HTTPS certificate runs out soon`,
        detail: 'Visitors get a scary warning when it lapses. It should renew by itself; this means renewal is failing.', evidence: w.detail ?? undefined, fix: caddy.has(w.host) && managed.has(w.host) ? renew(w.host) : recheck(w.host) });
    }
    if (w.kind === 'registration' && w.status !== 'ok') add({ id: `domain:registration:${w.host}`, about, severity: w.status === 'expired' ? 'critical' : 'high', title: w.status === 'expired' ? `${w.host} has expired` : `${w.host} expires soon`,
      detail: 'If the registration lapses, everything on it goes offline and someone else can buy it.', evidence: w.detail ?? undefined,
      fix: { manual: ['Renew it at your registrar (it costs money, so Unit7 never does it by itself).', 'Turn on auto-renew while you’re there.'], label: 'Show me how' } });
    if (w.kind === 'email' && w.status !== 'ok') add({ id: `domain:email:${w.host}`, about, severity: w.status === 'unprotected' ? 'medium' : 'low', title: `Anyone can send email pretending to be ${w.host}`,
      detail: w.status === 'unprotected' ? 'Without SPF and DMARC, fake emails in your name look real, and your own mail lands in spam more.' : 'This domain sends no email, but nothing says so, so fakes look real.', evidence: w.detail?.split(':')[0],
      fix: { tool: 'domain.protect_email', input: { domain: w.host }, label: 'Protect it', safe: true, change: `Adds a DMARC record at _dmarc.${w.host} so receivers reject fakes. No other record changes.` } });
  }
  // a name pointing at a deleted app on a platform: whoever creates that app gets the domain (found by the map's sync)
  const summary = json<{ issues?: { key: string; text: string }[] }>(get<{ summary: string }>(ctx.db, `SELECT summary FROM sync_runs WHERE org_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`, ctx.orgId)?.summary ?? '{}', {});
  for (const i of (summary.issues ?? []).filter((x) => x.key.startsWith('takeover:'))) {
    const host = i.key.slice(9);
    add({ id: `domain:takeover:${host}`, about: { kind: 'domain', name: host }, severity: 'critical', title: `Someone could take over ${host}`, detail: i.text,
      fix: { manual: [`At your DNS host, open the records for ${host}.`, 'Delete the record that points at the app that no longer exists (or point it at a live app).', 'Run this check again.'], label: 'Ask Unit7 to remove it',
        ask: `${host} points at an app that no longer exists, so someone could take it over. Find the DNS record and remove it (or point it at a live app). Show me the record and ask before deleting it.` } });
  }
  return out;
}

// --- Unit7 itself ------------------------------------------------------------------------------------------
function unit7Findings(db: DB, orgId: string): Finding[] {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, 'area' | 'by'>) => out.push({ ...f, area: 'unit7', by: 'unit7' });
  const org = get<{ paused_at: string | null; rotate_links_days: number; rotate_db_days: number }>(db, 'SELECT paused_at, rotate_links_days, rotate_db_days FROM orgs WHERE id = ?', orgId);
  if (org?.paused_at) add({ id: 'unit7:paused', severity: 'info', title: 'Autopilot is paused', detail: 'Warden and your AI can look but can’t fix anything until you turn it back on.', fix: { manual: ['Open Autopilot and press Turn back on.'], href: '/autopilot', label: 'Open Autopilot' } });
  for (const e of all<{ id: string; name: string; project: string; autonomy: number }>(db, `SELECT e.id, e.name, p.name project, e.autonomy FROM environments e JOIN projects p ON p.id = e.project_id WHERE e.org_id = ? AND e.kind = 'production' AND e.autonomy >= 4`, orgId)) {
    add({ id: `unit7:autopilot:${e.id}`, severity: 'low', title: `${e.project}’s live app runs on ${AUTONOMY[e.autonomy] ?? 'full autopilot'}`, detail: 'Risky changes to what visitors use don’t wait for your OK.', fix: { manual: ['Open Autopilot and pick “Fix itself, ask for risky” for production.'], href: '/autopilot', label: 'Open Autopilot' } });
  }
  // databases without a safety net, and backups nobody proved restore
  for (const d of all<{ id: string; name: string }>(db, `SELECT s.id, s.name FROM services s WHERE s.org_id = ? AND s.kind IN ('postgres','mysql','mariadb','mongo','redis') AND NOT EXISTS (SELECT 1 FROM backup_schedules b WHERE b.service_id = s.id)`, orgId)) {
    add({ id: `unit7:no-backup:${d.id}`, severity: 'high', about: { kind: 'app', id: d.id, name: d.name }, title: `${d.name} has no backups`, detail: 'If the server dies or a bad change deletes data, there’s no way back.',
      fix: { tool: 'backup.schedule', input: { serviceId: d.id, frequency: 'daily', keep: 7 }, label: 'Back up daily', safe: true, change: 'Backs it up every day and keeps the last 7, copied off the server.' } });
  }
  for (const b of all<{ id: string; service_id: string; name: string; verify_ok: number | null; verified_at: string | null }>(db, `SELECT b.id, b.service_id, s.name, b.verify_ok, b.verified_at FROM backups b JOIN services s ON s.id = b.service_id
      WHERE b.org_id = ? AND b.status = 'done' AND b.created_at = (SELECT max(created_at) FROM backups x WHERE x.service_id = b.service_id AND x.status = 'done')`, orgId)) {
    if (b.verify_ok === 0) add({ id: `unit7:backup-broken:${b.service_id}`, severity: 'high', about: { kind: 'app', id: b.service_id, name: b.name }, title: `${b.name}’s latest backup doesn’t restore`, detail: 'Your safety net has a hole: this copy wouldn’t bring the data back.',
      fix: { tool: 'backup.create', input: { serviceId: b.service_id, reason: 'after a failed restore test' }, label: 'Back up again', safe: true, change: 'Takes a fresh backup now; Warden tests it this week.' } });
    else if (!b.verified_at || Date.parse(b.verified_at) < Date.now() - 14 * 86400_000) add({ id: `unit7:backup-untested:${b.service_id}`, severity: 'low', about: { kind: 'app', id: b.service_id, name: b.name }, title: `${b.name}’s backup was never test-restored`, detail: 'A backup you never restored might not work when you need it.',
      fix: { tool: 'backup.verify', input: { backupId: b.id }, label: 'Test it', safe: true, change: 'Restores the latest copy into a throwaway database and checks it. Your real data isn’t touched.' } });
  }
  // keys that should have changed by now
  if (org && org.rotate_links_days > 0) {
    for (const l of all<{ id: string }>(db, `SELECT id FROM links WHERE org_id = ? AND vars LIKE '%_API_KEY%' AND previous_until IS NULL AND coalesce(rotated_at, created_at) < ?`, orgId, new Date(Date.now() - (org.rotate_links_days + 7) * 86400_000).toISOString())) {
      add({ id: `unit7:rotate:${l.id}`, severity: 'medium', title: 'A connection key is overdue for a change', detail: `Keys are meant to change every ${org.rotate_links_days} days; this one didn’t.`,
        fix: { tool: 'link.rotate', input: { linkId: l.id }, label: 'Change it now', change: 'Gives the connection a new key; the old one keeps working for a day, so nothing breaks.' } });
    }
  }
  if (org?.rotate_db_days === 0 && get(db, `SELECT 1 FROM services WHERE org_id = ? AND kind IN ('postgres','mysql','mariadb')`, orgId)) add({ id: 'unit7:db-passwords', severity: 'info', title: 'Database passwords never change by themselves', detail: 'Changing them now and then limits the damage of a leak. Apps redeploy when it happens.', fix: { tool: 'secrets.rotation', input: { databases: 90 }, label: 'Change them every 90 days', change: 'Unit7 changes each database password every 90 days, at 03:00 UTC, and redeploys the apps that use it.',
    undo: { tool: 'secrets.rotation', input: { databases: 0 }, label: 'Stop changing them' } } });
  // app keys nobody uses that never expire
  const stale = new Date(Date.now() - 90 * 86400_000).toISOString();
  for (const t of all<{ id: string; name: string }>(db, `SELECT id, name FROM api_tokens WHERE org_id = ? AND expires_at IS NULL AND coalesce(last_used_at, created_at) < ?`, orgId, stale)) {
    add({ id: `unit7:token:${t.id}`, severity: 'low', title: `An app key hasn’t been used in 3 months`, detail: 'Unused keys that never expire are easy to forget and hard to notice if leaked.', evidence: `Key “${t.name.replace(/^.*·\s*/, '')}”`,
      fix: { manual: ['Open Settings → Connected AI apps and turn it off if nothing uses it.'], href: '/settings?tab=ai', label: 'Open settings' } });
  }
  if (!alertsVerified(db, orgId)) add({ id: 'unit7:alerts', severity: 'low', title: 'Nobody hears about problems at night', detail: 'With phone alerts, Unit7 tells you the moment something needs you. They count once your phone proves it gets them.', fix: { manual: ['Open Connections and set up phone alerts: scan the code with your phone, then tap once to prove it works (free).'], href: '/connections#alerts', label: 'Set up alerts' } });
  for (const a of all<{ name: string }>(db, `SELECT name FROM accounts WHERE org_id = ? AND status = 'failing'`, orgId)) add({ id: `unit7:account:${a.name}`, severity: 'low', title: `${a.name} refused Unit7’s sign-in`, detail: 'Unit7 can’t watch what’s in that account until it’s reconnected.', fix: { manual: ['Open Connections and reconnect it.'], href: '/connections', label: 'Reconnect' } });
  return out;
}

// --- the run --------------------------------------------------------------------------------------------
const rowOf = (r: { id: string; created_at: string; server_id: string | null; by: string; score: number; counts: string; findings: string; notes: string; fresh?: string | null; ms: number | null; coverage?: string | null }): Report => ({
  ...(r.coverage && { coverage: json<Coverage>(r.coverage, { apps: { checked: 0, found: 0 }, skipped: [] }) }), id: r.id, at: r.created_at, serverId: r.server_id, by: r.by, score: r.score, counts: json(r.counts, countsOf([])), findings: json(r.findings, []), notes: json(r.notes, []), fresh: json(r.fresh ?? '[]', []), ms: r.ms ?? 0,
});
const latest = (db: DB, orgId: string, serverId: string | null) => {
  const r = get<Parameters<typeof rowOf>[0]>(db, `SELECT * FROM security_reports WHERE org_id = ? AND (server_id IS ? OR (? IS NOT NULL AND server_id IS NULL)) ORDER BY created_at DESC LIMIT 1`, orgId, serverId, serverId);
  return r && rowOf(r);
};

// A clean report only means something next to what it looked at. The deep app checks (known security holes, secrets with
// public names) read what Unit7 deployed; anything else found on a server is counted here, so it's never silently skipped.
function coverageOf(ctx: Ctx, servers: ServerRow[], parts: { read: string[]; unread: string[]; unscanned: string[] }[]): Coverage {
  const live = all<{ server_id: string | null }>(ctx.db, `SELECT s.server_id FROM services s JOIN deployments d ON d.id = s.current_deployment_id WHERE s.org_id = ? AND d.status = 'live'`, ctx.orgId);
  const ours = servers.reduce((n, s) => n + live.filter((l) => l.server_id === s.id).length, 0);
  const found = servers.flatMap((s) => appsOf(lastXray(ctx.db, ctx.orgId, s.id)?.data).map((p) => p.name)), read = new Set(parts.flatMap((p) => p.read));
  return { apps: { checked: ours + found.filter((n) => read.has(n)).length, found: ours + found.length }, skipped: found.filter((n) => !read.has(n)).slice(0, 20), unscanned: parts.flatMap((p) => p.unscanned).slice(0, 20) };
}

export async function securityCheck(ctx: Ctx, serverId?: string): Promise<Report> {
  const t0 = Date.now();
  const servers = serverId ? [serverRow(ctx, serverId)] : all<ServerRow>(ctx.db, `SELECT * FROM servers WHERE org_id = ? AND status NOT IN ('new', 'bootstrapping') ORDER BY name`, ctx.orgId);
  const [srv, sites, domains] = await Promise.all([
    pool(servers, 4, (s) => checkServer(ctx, s)),
    serverId ? Promise.resolve([]) : siteFindings(ctx),
    serverId ? Promise.resolve([]) : domainFindings(ctx),
  ]);
  const parts = await pool(servers, 4, (s) => partChecks(ctx, s));
  ctx.progress(serverId ? 'Checking its apps for known security holes…' : 'Checking apps, backups and Unit7’s own settings…');
  const before = latest(ctx.db, ctx.orgId, serverId ?? null);
  // what an AI found can't be re-checked here, so it stays a week (or until a deep check finds it again)
  const ai = serverId ? [] : (before?.findings ?? []).filter((f) => f.by === 'ai' && Date.parse(f.at ?? '') > Date.now() - 7 * 86400_000);
  const seen = new Set<string>();
  // the X-ray's own risks too (restart loops, running out of memory, no backups, disk forecast, Redis or Coolify left open),
  // from what's stored; ports and sign-in are checked live above, so only the X-ray's own kinds join
  const xray = servers.flatMap((s) => xrayFindings(ctx.db, ctx.orgId, s).filter((f) => f.bucket === 'risk' && f.id.startsWith('xray:')));
  const findings = [...srv.flatMap((x) => x.findings), ...xray, ...appFindings(ctx.db, ctx.orgId, serverId), ...parts.flatMap((p) => p.findings), ...sites, ...domains, ...(serverId ? [] : unit7Findings(ctx.db, ctx.orgId)), ...ai]
    .filter((f) => !seen.has(f.id) && !!seen.add(f.id)).sort((a, b) => rank(a.severity) - rank(b.severity));
  const known = new Set(before?.findings.map((f) => f.id) ?? []);
  const coverage = coverageOf(ctx, servers, parts);
  const report: Report = { id: id('sec'), at: now(), serverId: serverId ?? null, by: ctx.actor.agent ?? ctx.actor.name, score: score(findings), counts: countsOf(findings), findings, coverage,
    notes: srv.flatMap((x) => x.notes), fresh: findings.filter((f) => !known.has(f.id)).map((f) => f.id), ms: Date.now() - t0 };
  run(ctx.db, 'INSERT INTO security_reports (id, org_id, server_id, by, score, counts, findings, notes, fresh, ms, created_at, coverage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    report.id, ctx.orgId, report.serverId, report.by, report.score, JSON.stringify(report.counts), JSON.stringify(findings), JSON.stringify(report.notes), JSON.stringify(report.fresh), report.ms, report.at, JSON.stringify(coverage));
  run(ctx.db, `DELETE FROM security_reports WHERE org_id = ? AND id NOT IN (SELECT id FROM security_reports WHERE org_id = ? ORDER BY created_at DESC LIMIT 100)`, ctx.orgId, ctx.orgId);
  // Warden's weekly run says what's new and serious; a person looking at the screen already sees it
  const hidden = snoozeState(ctx.db, ctx.orgId).hidden;
  const serious = findings.filter((f) => report.fresh.includes(f.id) && rank(f.severity) <= rank('high') && !stillHidden(hidden.get(f.id), f.severity));
  if (ctx.actor.kind !== 'user' && serious.length) ctx.emit('security.found', `Security check: ${serious.length} new serious problem${serious.length === 1 ? '' : 's'}: ${serious.slice(0, 3).map((f) => f.title).join('; ')}`, { severity: serious.some((f) => f.severity === 'critical') ? 'critical' : 'warning', data: { reportId: report.id } });
  ctx.progress(findings.length ? `Done: ${findings.filter((f) => f.severity !== 'info').length} things to look at.` : 'Done: nothing to fix.');
  return report;
}

// organisations due their weekly check (Warden asks hourly)
export const weeklyDue = (db: DB) => all<{ id: string }>(db, `SELECT o.id FROM orgs o WHERE o.security_weekly = 1
  AND (EXISTS (SELECT 1 FROM servers s WHERE s.org_id = o.id) OR EXISTS (SELECT 1 FROM assets a WHERE a.org_id = o.id))
  AND NOT EXISTS (SELECT 1 FROM security_reports r WHERE r.org_id = o.id AND r.server_id IS NULL AND r.created_at > ?)`, new Date(Date.now() - 7 * 86400_000).toISOString()).map((o) => o.id);

// --- tools -------------------------------------------------------------------------------------------------

defineTool({
  name: 'security.check', title: 'Run a security check', risk: 'read', action: 'read', timeoutMs: 3 * 60_000,
  description: 'Check everything Unit7 can see for security problems, read-only: each server (ports open to the internet, SSH password/root sign-in, failed sign-in bursts, firewall, databases published publicly, privileged containers, disk, reboots, security updates, secrets printed in logs), each app (known vulnerabilities, secrets with public names, .env/.git served on the web), each domain (HTTPS, renewal, SPF/DMARC, takeover) and Unit7 itself (Autopilot, overdue key changes, backups never restored). Returns findings with severity, plain words, redacted evidence and the fix (a tool to run, or steps). Saved as a report. Give serverId for one server.',
  input: z.object({ serverId: fid('srv').optional() }),
  run: (ctx, i) => securityCheck(ctx, i.serverId),
});

defineTool({
  name: 'security.reports', title: 'Security check reports', risk: 'read', action: 'read',
  description: 'The latest security check report (findings and fixes) and the history of past runs, with whether the weekly check is on. Give serverId for one server’s view.',
  input: z.object({ serverId: fid('srv').optional(), limit: z.number().int().min(1).max(50).default(12) }),
  run(ctx, i) {
    const last = latest(ctx.db, ctx.orgId, i.serverId ?? null);
    if (last && i.serverId && !last.serverId) { // the full report, this server's part
      const name = serverRow(ctx, i.serverId).name;
      last.findings = last.findings.filter((f) => f.serverId === i.serverId);
      last.notes = last.notes.filter((n) => n.includes(name));
    }
    if (last) {
      last.findings = visible(ctx.db, ctx.orgId, last.findings, (f) => f.id).map((f) => ({ ...f, explain: explainFinding(f) }));
      last.counts = countsOf(last.findings); last.score = score(last.findings);
    }
    const history = all<{ id: string; at: string; serverId: string | null; by: string; score: number; counts: string }>(ctx.db, `SELECT id, created_at at, server_id serverId, by, score, counts FROM security_reports
      WHERE org_id = ? AND (server_id IS ? OR (? IS NOT NULL AND server_id IS NULL)) ORDER BY created_at DESC LIMIT ?`, ctx.orgId, i.serverId ?? null, i.serverId ?? null, i.limit).map((h) => { const counts = json(h.counts, countsOf([])); return { ...h, counts, score: scoreOf(counts) }; });
    return { latest: last ?? null, history, weekly: get<{ w: number }>(ctx.db, 'SELECT security_weekly w FROM orgs WHERE id = ?', ctx.orgId)?.w === 1 };
  },
});

defineTool({
  // an AI's own findings join the latest report, marked as found by AI; only bookkeeping, nothing on any server changes
  name: 'security.note', title: 'Add a finding to the security report', risk: 'read', action: 'read',
  description: 'Add a security problem you found yourself (beyond Unit7’s own check) to the latest security report, marked “found by AI”, so the person sees it with the rest. Plain words: title (what’s wrong), detail (why it matters), evidence (what you saw, never a secret value), steps (how to fix it). Call it once per problem.',
  input: z.object({
    title: z.string().trim().min(3).max(140), severity: z.enum(SEVERITIES), detail: z.string().trim().max(1000).default(''),
    area: z.enum(['server', 'app', 'domain', 'unit7']).default('server'), evidence: z.string().max(500).optional(), steps: z.array(z.string().max(300)).max(8).optional(), serverId: fid('srv').optional(),
  }),
  run(ctx, i) {
    const row = get<Parameters<typeof rowOf>[0]>(ctx.db, 'SELECT * FROM security_reports WHERE org_id = ? ORDER BY created_at DESC LIMIT 1', ctx.orgId);
    let r = row && rowOf(row);
    if (!r) {
      r = { id: id('sec'), at: now(), serverId: null, by: ctx.actor.agent ?? ctx.actor.name, score: 100, counts: countsOf([]), findings: [], notes: [], fresh: [], ms: 0 };
      run(ctx.db, 'INSERT INTO security_reports (id, org_id, server_id, by, score, counts, findings, notes, fresh, ms, created_at) VALUES (?, ?, NULL, ?, 100, ?, ?, ?, ?, 0, ?)', r.id, ctx.orgId, r.by, JSON.stringify(r.counts), '[]', '[]', '[]', r.at);
    }
    if (r.findings.filter((f) => f.by === 'ai').length >= 30) throw new Unit7Error('too_many', 'This report already has 30 findings from AI. Run a new security check first.', 409);
    const fid_ = `ai:${createHash('sha1').update(i.title.toLowerCase()).digest('hex').slice(0, 12)}`;
    const s = i.serverId ? serverRow(ctx, i.serverId) : undefined;
    // whatever the AI read (logs, settings) may have put a secret in its words: every field is scrubbed before it's kept
    const clean = (t: string) => ctx.redactor.redact(t);
    const f: Finding = { id: fid_, severity: i.severity, area: i.area, title: clean(i.title), detail: clean(i.detail), evidence: i.evidence && clean(i.evidence), by: 'ai', at: now(),
      ...(s && { serverId: s.id, about: { kind: 'server' as const, id: s.id, name: s.name } }), ...(i.steps?.length && { fix: { manual: i.steps.map(clean) } }) };
    const findings = [...r.findings.filter((x) => x.id !== fid_), f].sort((a, b) => rank(a.severity) - rank(b.severity));
    run(ctx.db, 'UPDATE security_reports SET findings = ?, counts = ?, score = ? WHERE id = ?', JSON.stringify(findings), JSON.stringify(countsOf(findings)), score(findings), r.id);
    return { added: f.title, report: r.id, score: score(findings) };
  },
});

defineTool({
  name: 'security.weekly', title: 'Weekly security check', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'Turn the weekly security check on or off. On: Warden runs the check once a week and alerts on new critical or high findings. People only.',
  input: z.object({ on: z.boolean() }),
  run(ctx, i) { run(ctx.db, 'UPDATE orgs SET security_weekly = ? WHERE id = ?', i.on ? 1 : 0, ctx.orgId); return { weekly: i.on }; },
});

// --- closing one port ------------------------------------------------------------------------------------
// The careful alternative to a firewall, safe on a server shared with Coolify: one DROP rule for one port on the
// internet-facing interface, tagged so it can be found and removed. In DOCKER-USER (Docker's published ports skip
// INPUT and ufw) and INPUT (programs on the server). --ctdir ORIGINAL: only connections that start outside, so an
// app's own calls out to some service on that port keep working.
// ponytail: plain iptables rules don't survive a reboot without netfilter-persistent; the weekly check sees the port
// open again and offers the same fix. A boot-time restore would close that gap.
const PORT_RULES = `P="$1"; ACT="$2"; SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"
command -v iptables >/dev/null 2>&1 || { echo "no iptables on this server" >&2; exit 3; }
ext=$(ip route show default 2>/dev/null | awk '{print $5; exit}'); [ -n "$ext" ] || { echo "couldn't find the internet-facing network interface" >&2; exit 3; }
tag="unit7-close-$P"
rule() { ipt="$1"; c="$2"; shift 2
  if [ "$ACT" = close ]; then $SU $ipt -C "$c" "$@" -m comment --comment "$tag" -j DROP 2>/dev/null || $SU $ipt -I "$c" 1 "$@" -m comment --comment "$tag" -j DROP
  else while $SU $ipt -D "$c" "$@" -m comment --comment "$tag" -j DROP 2>/dev/null; do :; done; fi; }
rule iptables INPUT -i "$ext" -p tcp --dport "$P" || exit 4
if $SU iptables -n -L DOCKER-USER >/dev/null 2>&1; then rule iptables DOCKER-USER -i "$ext" -p tcp -m conntrack --ctorigdstport "$P" --ctdir ORIGINAL || exit 4; fi
command -v ip6tables >/dev/null 2>&1 && { rule ip6tables INPUT -i "$ext" -p tcp --dport "$P" 2>/dev/null || true; }
command -v netfilter-persistent >/dev/null 2>&1 && $SU netfilter-persistent save >/dev/null 2>&1
echo done`;

defineTool({
  name: 'server.close_port', title: 'Close a port to the internet', risk: 'write', action: 'server_write', timeoutMs: 60_000,
  // closing Coolify's own dashboard port without a working HTTPS address locks the person out: only they can choose that
  peopleOnly: (i) => !!i.anyway,
  description: 'Block one TCP port from the internet at the server’s own firewall (open: true removes the block), then test it from outside (from this computer). Works on servers shared with Coolify, where Unit7 never turns a firewall on. Refuses the SSH port and the web ports (80, 443). Refuses Coolify’s dashboard port (8000) until Coolify answers at its own HTTPS address: coolify.dashboard_domain gives it one and then closes the port (anyway: true closes it regardless, people only). Use for databases or dashboards answering the internet.',
  input: z.object({ serverId: fid('srv'), port: z.number().int().min(1).max(65535), open: z.boolean().default(false),
    anyway: z.boolean().default(false).describe('Close Coolify’s dashboard port even without a working HTTPS address (people only: the dashboard then opens only through an SSH tunnel)') }),
  async dryRun(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    guardPort(s, i.port);
    const lock = i.open ? undefined : await coolifyLockout(ctx, s, i.port);
    if (lock && !i.anyway) throw lock.error;
    return { change: i.open ? `Port ${i.port} on ${s.name} answers the internet again.` : `Blocks new connections from the internet to port ${i.port} on ${s.name}. Everything else stays as it is.`, ...(lock && { warning: lock.warning, tunnel: lock.tunnel }) };
  },
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    guardPort(s, i.port);
    const lock = i.open ? undefined : await coolifyLockout(ctx, s, i.port);
    if (lock && !i.anyway) throw lock.error;
    const r = await ssh(ctx.app).exec(s, script(PORT_RULES, i.port, i.open ? 'open' : 'close'), { timeoutMs: 45_000 });
    if (r.code !== 0) throw new Unit7Error('port_failed', `Couldn’t ${i.open ? 'open' : 'close'} port ${i.port} on ${s.name}: ${(r.stderr || r.stdout).trim().slice(-200) || `exit ${r.code}`}`, 502);
    const closed = new Set(json<{ closedPorts?: number[] }>(s.facts, {}).closedPorts ?? []);
    if (i.open) closed.delete(i.port); else closed.add(i.port);
    run(ctx.db, `UPDATE servers SET facts = json_set(facts, '$.closedPorts', json(?)) WHERE id = ?`, JSON.stringify([...closed].sort((a, b) => a - b)), s.id);
    ctx.emit('server.port', `${i.open ? 'Opened' : 'Closed'} port ${i.port} on ${s.name}`, { severity: 'success', resource: s.id });
    if (i.open) { forgetOutside(ctx.db, s.id, i.port); return { opened: i.port, server: s.name }; }
    // the real test: a connection from this computer, outside the server
    const o = (await checkOutside(ctx.db, s, [i.port]).catch(() => ({} as Record<string, Reach>)))[String(i.port)];
    const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data, what = portWhat(inv, i.port);
    return {
      closed: i.port, server: s.name, undo: { tool: 'server.close_port', input: { serverId: s.id, port: i.port, open: true }, label: 'Open it again' },
      ...(o && { outside: o.state, said: o.state === 'closed' ? closedWords(what, !!inv?.coolify && /^Coolify/.test(what)) : o.state === 'open' ? stillOpenFinding(s.id, s.name, i.port, what, o).detail : `Not tested from outside: ${o.why ?? 'no answer from the server at all'}.` }),
      ...(lock && { warning: lock.warning, tunnel: lock.tunnel }),
    };
  },
});

function guardPort(s: ServerRow, port: number) {
  if (port === s.port || port === 22) throw new Unit7Error('unsafe_port', `Port ${port} is how Unit7 and you sign in to ${s.name}. Unit7 won’t close it.`, 400);
  if (port === 80 || port === 443) throw new Unit7Error('unsafe_port', `Port ${port} carries your sites’ visitors. Unit7 won’t close it.`, 400);
}
