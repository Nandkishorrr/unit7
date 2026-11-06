// Shield tools (edge security) and host hardening. The blocking safety rules live in shield.ts; the
// hardening checklist is applied idempotently, then verified.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { json, run } from '../db.ts';
import { publicKeyOf, ssh } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { serverRow, inspect, type Facts } from './servers.ts';
import { proxyOf } from '../deploy/caddy.ts';
import { block, unblock, listBlocks, applyBlocklist } from '../sentinel/shield.ts';
import { fid } from './helpers.ts';
import { keepPorts } from '../secure/ports.ts';

const CIDR = z.string().regex(/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/, 'an IPv4 address or CIDR');

defineTool({
  // one address is routine; a whole range may be a whole office or carrier: an AI asks first
  name: 'shield.block', title: 'Block an IP', risk: (i) => (i.ip.includes('/') && !i.ip.endsWith('/32') ? 'destructive' : 'write'), action: 'shield_block', timeoutMs: 60_000,
  description: 'Block an abusive IP (or /24–/32) across every app on a server. Blocks escalate on repeat offenders (15m→1h→24h→7d) and lift on their own. Refuses private ranges, the server itself, and anything wider than /24.',
  input: z.object({ serverId: fid('srv'), ip: CIDR, reason: z.string().max(200).default('manual') }),
  run: (ctx, i) => block(ctx, i.serverId, i.ip, i.reason),
});

defineTool({
  name: 'shield.unblock', title: 'Unblock an IP', risk: 'write', action: 'shield_block',
  description: 'Remove an IP from a server’s blocklist.',
  input: z.object({ serverId: fid('srv'), ip: CIDR }),
  async run(ctx, i) { await unblock(ctx, i.serverId, i.ip); return { unblocked: i.ip }; },
});

defineTool({
  name: 'shield.list', title: 'List blocked IPs', risk: 'read', action: 'read',
  description: 'Currently blocked IPs on a server, with why and when each expires.',
  input: z.object({ serverId: fid('srv') }),
  run: (ctx, i) => listBlocks(ctx.app, serverRow(ctx, i.serverId).id).map((b) => ({ ...b, expiresIn: `${Math.round((b.until - Date.now()) / 60000)}m` })),
});

// --- host hardening -----------------------------------------------------------------------------

const su = (f: Facts) => (f.sudo === 'root' ? '' : 'sudo -n ');

const SSHD = `PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
X11Forwarding no`;

const SYSCTL = `net.ipv4.tcp_syncookies=1
net.ipv4.conf.all.accept_redirects=0
net.ipv4.conf.all.send_redirects=0
net.ipv4.conf.all.accept_source_route=0
net.ipv6.conf.all.accept_redirects=0
kernel.kptr_restrict=2
kernel.dmesg_restrict=1
fs.suid_dumpable=0
net.core.somaxconn=4096
net.ipv4.tcp_max_syn_backlog=4096
vm.swappiness=10`;

// Only Caddy's ports reach the internet; everything else (databases, admin) stays on the private
// network. This DROP chain closes the well-known Docker-bypasses-the-firewall hole.
const DOCKER_USER = `*filter
:DOCKER-USER - [0:0]
-F DOCKER-USER
-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 80 -j RETURN
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 443 -j RETURN
-A DOCKER-USER -p udp -m conntrack --ctorigdstport 443 -j RETURN
-A DOCKER-USER -i lo -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -i EXT_IF -j DROP
-A DOCKER-USER -j RETURN
COMMIT`; // EXT_IF: the internet-facing interface, filled in on the server (new connections from it stop here)

defineTool({
  // turns password sign-in off: done wrong, it locks people out, so an AI asks first
  name: 'server.harden', title: 'Harden a server', risk: 'destructive', action: 'server_harden', timeoutMs: 5 * 60_000,
  description: 'Apply Unit7’s security baseline to a server and verify it: SSH (keys only, no root password login), kernel sysctl hardening, automatic security updates, and a check that no database ports are exposed to the internet. Safe to run again.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const pool = ssh(ctx.app);
    const f = await inspect(ctx, s);
    if (f.sudo === 'no') throw new Error(`${s.username} can't use sudo without a password; harden as root or grant passwordless sudo.`);
    const sudo = su(f);
    const steps: string[] = [];
    const say = (m: string) => { steps.push(m); ctx.progress(m); };

    // SSH: drop a config fragment that wins over cloud-init, test it, then reload
    say('Locking SSH to keys only…');
    await pool.check(s, script(`${sudo}mkdir -p /etc/ssh/sshd_config.d && printf '%s\\n' "$1" | ${sudo}tee /etc/ssh/sshd_config.d/00-unit7.conf >/dev/null && ${sudo}sshd -t && (${sudo}systemctl reload ssh 2>/dev/null || ${sudo}systemctl reload sshd 2>/dev/null || ${sudo}service ssh reload 2>/dev/null || true)`, SSHD), { what: 'Hardening SSH', timeoutMs: 30_000 });

    // sysctl
    say('Applying kernel hardening…');
    await pool.exec(s, script(`printf '%s\\n' "$1" | ${sudo}tee /etc/sysctl.d/99-unit7.conf >/dev/null && ${sudo}sysctl -p /etc/sysctl.d/99-unit7.conf >/dev/null 2>&1 || true`, SYSCTL), { timeoutMs: 30_000 });

    // DOCKER-USER guard (iptables), persisted best-effort
    const haveIptables = (await pool.exec(s, script('command -v iptables-restore'))).code === 0;
    if (haveIptables && proxyOf(f).kind !== 'caddy') say('Left Docker’s published ports alone: other apps on this server (like Coolify) need theirs.');
    else if (haveIptables) {
      await pool.exec(s, script(`ext=$(ip route show default 2>/dev/null | awk '{print $5; exit}'); [ -n "$ext" ] || exit 0; printf '%s\\n' "$1" | sed "s/EXT_IF/$ext/" | ${sudo}iptables-restore -n 2>/dev/null || true`, DOCKER_USER), { timeoutMs: 30_000 });
      // it survives a restart with the ports Unit7 closed, and restoring it just emptied Docker's chain, so those go back in now
      await pool.exec(s, script(`${sudo}mkdir -p /etc/unit7 && printf '%s\\n' "$1" | ${sudo}tee /etc/unit7/docker-user.rules >/dev/null`, DOCKER_USER), { timeoutMs: 30_000 });
      await keepPorts(ctx, s, 0, 'open');
      await pool.exec(s, script(`[ -f /etc/unit7/ports ] && ${sudo}sh /etc/unit7/ports.sh; true`), { timeoutMs: 30_000 });
      say('Closed the Docker firewall-bypass (only 80/443 reach the internet).');
    }

    // automatic security updates
    if (f.has?.includes('apt-get')) {
      await pool.exec(s, script(`${sudo}env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null 2>&1 && echo 'APT::Periodic::Update-Package-Lists "1"; APT::Periodic::Unattended-Upgrade "1";' | ${sudo}tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null`), { timeoutMs: 180_000 });
      say('Automatic security updates are on.');
    }

    // verify: which ports listen on a public interface, and is SSH really key-only
    const audit = await pool.exec(s, script(`echo "=sshd="; ${sudo}sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin|maxauthtries)' ; echo "=ports="; (ss -tlnH 2>/dev/null || netstat -tln 2>/dev/null) | awk '{print $4}' | grep -vE '127\\.0\\.0\\.1|::1|\\[::1\\]'`), { timeoutMs: 20_000 });
    const out = audit.stdout;
    const exposedDbPorts = [...out.matchAll(/:(5432|3306|6379|27017|9200|5984)\b/g)].map((m) => m[1]);
    const findings: string[] = [];
    if (!/passwordauthentication no/.test(out)) findings.push('SSH still allows password auth — check /etc/ssh/sshd_config.d.');
    const unit7Key = publicKeyOf(ctx.app, s)?.split(/\s+/)[1] ?? '';
    const others = await pool.exec(s, script(`cat ~/.ssh/authorized_keys 2>/dev/null | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$' | grep -vcF "$1"`, unit7Key || '-'), { timeoutMs: 15_000 });
    if (unit7Key && Number(others.stdout.trim() || 0) === 0) findings.push(`Only Unit7's key can sign in to ${s.username} now (passwords are off). Add your own SSH key so you can always get in without Unit7.`);
    if (exposedDbPorts.length) findings.push(`A database port (${[...new Set(exposedDbPorts)].join(', ')}) is listening on a public interface — it should be on the private unit7 network only.`);

    run(ctx.db, `UPDATE servers SET facts = json_set(facts, '$.hardenedAt', ?) WHERE id = ?`, new Date().toISOString(), s.id);
    ctx.emit('server.hardened', `Hardened ${s.name}${findings.length ? ` — ${findings.length} finding(s)` : ''}`, { severity: findings.length ? 'warning' : 'success', resource: s.id });
    return { steps, findings: findings.length ? findings : ['No exposed database ports; SSH is key-only.'], verified: findings.length === 0 };
  },
});
