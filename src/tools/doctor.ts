// Unit7 Doctor: when a server stops answering, Unit7 checks what is wrong, explains it in plain
// words, and offers to fix it with one click (or shows the steps to do it yourself). Every fix uses
// an official, documented provider operation on the user's own server.
//
// Checks: can this computer reach the server's SSH port, is the server switched on (provider says),
// does the provider firewall allow SSH, and can the rest of the internet reach it. From that:
//   off            -> start the VPS (provider API)
//   provider-wall  -> add an allow-SSH rule to the provider firewall and sync it (provider API)
//   reachable-not-here -> the server answers the world but not this computer; the usual cause is a
//                     host-based block (fail2ban / CrowdSec / local firewall). Unit7 offers to clear
//                     it, or shows the one-line command to run in the provider's browser terminal.
//   down           -> nobody can reach it: restart the VPS (provider API)
//   key            -> the server refused Unit7's key: add it to root's authorized keys (with this computer's
//                     own SSH access, on a person's click), or show the one-line command. Attaching a key
//                     through Hostinger doesn't help here: it only lands on a VPS at (re)install.
//   host-key       -> the server's SSH identity changed: trust it if it was rebuilt
import { z } from 'zod';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { get, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { execFile } from 'node:child_process';
import { keyCommand, listening, publicKeyOf, ssh, type ServerRow } from '../connectors/ssh.ts';
import { requireHuman } from './helpers.ts';
import { generateKeyPair, serverRow } from './servers.ts';
import { afterKeyWorks } from './servers.ts';
import { hostingerExec } from './hostinger.ts';
import { fid } from './helpers.ts';
import { sysBin } from '../connectors/shell.ts';

type Cause = 'ok' | 'off' | 'provider-wall' | 'reachable-not-here' | 'down' | 'key' | 'no-key' | 'host-key' | 'unknown';
type FixId = 'start' | 'allow-ssh' | 'restart' | 'install-key' | 'check-key' | 'trust-host-key';
interface Check { name: string; ok: boolean | null; detail: string }
interface Fix { id: FixId; label: string; explain: string }
export interface Diagnosis { cause: Cause; title: string; explain: string; checks: Check[]; fixes: Fix[]; manual?: { steps: string[]; command?: string; link?: string }; at: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Is the server reachable from outside this network? Three probes from other countries via
// check-host.net (only the server's public address and port are sent). undefined if unavailable.
export async function fromInternet(host: string, port: number): Promise<{ ok: number; total: number } | undefined> {
  if (process.env.UNIT7_SKIP_NET_PROBE) return undefined; // tests set this; production calls out
  try {
    const headers = { accept: 'application/json' };
    const start = await (await fetch(`https://check-host.net/check-tcp?host=${encodeURIComponent(`${host}:${port}`)}&max_nodes=3`, { headers, signal: AbortSignal.timeout(8000) })).json() as { request_id?: string; nodes?: Record<string, unknown> };
    if (!start.request_id) return undefined;
    const want = Object.keys(start.nodes ?? {}).length || 3;
    for (let i = 0; i < 6; i++) {
      await sleep(1500);
      const res = await (await fetch(`https://check-host.net/check-result/${start.request_id}`, { headers, signal: AbortSignal.timeout(8000) })).json() as Record<string, unknown>;
      const vals = Object.values(res).filter((v) => v !== null);
      if (vals.length >= want) {
        const ok = vals.filter((v) => Array.isArray(v) && v[0] && typeof v[0] === 'object' && 'address' in (v[0] as object)).length;
        return { ok, total: vals.length };
      }
    }
  } catch { /* the probe service is optional */ }
  return undefined;
}

const vmId = (s: ServerRow): number | undefined => {
  const m = /^hostinger:vm:(\d+)$/.exec(s.provider_ref ?? '');
  return m ? Number(m[1]) : undefined;
};
const UNBLOCK = 'sudo fail2ban-client unban --all 2>/dev/null; sudo cscli decisions delete --all 2>/dev/null; sudo ufw allow 22/tcp 2>/dev/null; echo done'; // never iptables -F: it wipes Docker's rules and takes every app offline

// Look at the server through the provider (Hostinger): is it running, and does its firewall allow SSH?
async function askProvider(ctx: Ctx, s: ServerRow): Promise<{ running?: boolean; firewallBlocksSsh?: boolean; accountId: string } | undefined> {
  const id = vmId(s);
  const acc = s.account_id && get<{ id: string }>(ctx.db, `SELECT id FROM accounts WHERE id = ? AND provider = 'hostinger'`, s.account_id)?.id;
  if (!id || !acc) return undefined;
  try {
    const vm = await hostingerExec(ctx, acc, 'vps_virtual-machines_get', { virtualMachineId: id });
    const running = vm?.state === 'running';
    let firewallBlocksSsh: boolean | undefined;
    if (vm?.firewall_group_id) {
      const groups = await hostingerExec(ctx, acc, 'vps_firewall_list', {});
      const g = (Array.isArray(groups) ? groups : []).find((x: { id: number }) => x.id === vm.firewall_group_id);
      if (g) firewallBlocksSsh = !(g.rules ?? []).some((r: { action: string; protocol: string; port: string }) =>
        r.action === 'accept' && /TCP|SSH|any/i.test(r.protocol) && (r.port === '22' || r.port === 'any' || r.port === '' || /(^|:)22(:|$)/.test(r.port)));
    }
    return { running, firewallBlocksSsh, accountId: acc };
  } catch { return { accountId: acc }; }
}

// The whole diagnosis, read-only. Nothing is changed here.
export async function diagnose(ctx: Ctx, s: ServerRow): Promise<Diagnosis> {
  const checks: Check[] = [];
  const at = new Date().toISOString();
  // Unit7 has no login key for it here (made on another computer, or removed): nothing else matters until it has one
  if (!ctx.app.vault.list(s.org_id, s.key_ref).length) {
    return {
      cause: 'no-key', title: `Unit7 doesn’t have the login key for ${s.name}`, at,
      checks: [{ name: 'Unit7 has a login key', ok: false, detail: 'there is no key for this server on this computer' }],
      explain: 'Unit7 signs in to your server with its own key, and that key isn’t here (it may have been made on another computer). Add the login key: Unit7 makes a new one and adds it to the server with this Mac’s own SSH access.',
      fixes: [{ id: 'install-key', label: 'Add the login key', explain: `Makes a new key for Unit7 and adds it to ${s.username}@${s.host} by signing in once with this Mac’s own SSH key. Nothing else changes.` }],
    };
  }
  const here = await listening(s.host, s.port, 4000);
  checks.push({ name: 'Reachable from this computer', ok: here, detail: here ? `${s.host}:${s.port} answered` : `${s.host}:${s.port} did not answer in 4s` });

  if (here) {
    // the port answers, so the wait after "no answer" is over; Unit7's own rules still stop a refused key
    ssh(ctx.app).answered(s.id);
    const probe = await execute(ctx.app, ctx.orgId, ctx.actor, 'server.inspect', { serverId: s.id }, { reason: 'doctor' });
    if (probe.status === 'ok') return { cause: 'ok', title: `${s.name} is reachable`, explain: 'Unit7 can connect and run commands. Nothing to fix.', checks: [...checks, { name: 'Unit7 can log in', ok: true, detail: 'connected' }], fixes: [], at };
    const msg = probe.status === 'error' ? probe.error.message : 'could not connect';
    const code = probe.status === 'error' ? probe.error.code : '';
    if (code !== 'key_refused' && code !== 'host_key_changed') {
      checks.push({ name: 'Unit7 can log in', ok: false, detail: msg.slice(0, 200) });
      return { cause: 'unknown', title: `${s.name} answers, but Unit7 can’t sign in`, explain: msg, checks, fixes: vmId(s) ? [{ id: 'restart', label: 'Restart the server', explain: 'Often the fastest way back when the cause is unclear.' }] : [], at };
    }
    if (code === 'host_key_changed') { checks.push({ name: 'Server identity', ok: false, detail: 'the SSH host key changed since Unit7 first connected' }); return { cause: 'host-key', title: `${s.name}'s identity changed`, explain: 'The server’s SSH fingerprint is different from the one Unit7 trusted. This happens when a server is rebuilt. If you rebuilt it, trust the new identity. If you didn’t, do not: something is intercepting the connection.', checks, fixes: [{ id: 'trust-host-key', label: 'I rebuilt it — trust it', explain: 'Unit7 will pin the new identity and connect.' }], at }; }
    checks.push({ name: 'Unit7 can log in', ok: false, detail: 'the server refused Unit7’s key' });
    return {
      cause: 'key', title: `${s.name} doesn’t have Unit7’s key`, at, checks,
      explain: 'The server answers, but Unit7’s SSH key isn’t in its authorized keys yet, so it refuses Unit7. Unit7 has stopped trying (rejected logins in a row get addresses banned). Add the key once and Unit7 connects.',
      fixes: [
        { id: 'install-key', label: 'Add the login key', explain: `Signs in once to ${s.username}@${s.host} with your own SSH key (the way you do) and adds Unit7’s key to its authorized keys. Nothing else changes. One attempt only.` },
        { id: 'check-key', label: 'I’ve added it — check again', explain: 'Unit7 signs in once to confirm.' },
      ],
      manual: { steps: ['On a computer that can already sign in to the server, run the command below once. (Hostinger’s browser terminal only works if password sign-in is still on.)'], command: keyCommand(ctx.app, s) },
    };
  }

  // not reachable from here. Ask the provider and the wider internet to tell apart the causes.
  const [provider, world] = await Promise.all([askProvider(ctx, s), fromInternet(s.host, s.port)]);
  if (provider) {
    checks.push({ name: 'Switched on (Hostinger)', ok: provider.running ?? null, detail: provider.running === undefined ? 'unknown' : provider.running ? 'the VPS is running' : 'the VPS is powered off' });
    if (provider.firewallBlocksSsh !== undefined) checks.push({ name: 'Provider firewall allows SSH', ok: !provider.firewallBlocksSsh, detail: provider.firewallBlocksSsh ? 'no accept rule for TCP port 22' : 'SSH is allowed' });
  }
  if (world) checks.push({ name: 'Reachable from the internet', ok: world.ok > 0, detail: `${world.ok} of ${world.total} probes in other countries connected` });

  if (provider && provider.running === false) {
    return { cause: 'off', title: `${s.name} is switched off`, explain: 'Hostinger reports the VPS is powered off. Start it and it will come back.', checks, fixes: [{ id: 'start', label: 'Start the server', explain: 'Unit7 powers the VPS on through Hostinger.' }], at };
  }
  if (provider?.firewallBlocksSsh) {
    return { cause: 'provider-wall', title: `${s.name}’s firewall is blocking SSH`, explain: 'Hostinger’s firewall on this VPS has no rule allowing SSH (TCP 22), so Unit7 cannot reach it. Unit7 can add that rule for you.', checks, fixes: [{ id: 'allow-ssh', label: 'Allow SSH', explain: 'Unit7 adds an accept rule for TCP 22 to the VPS firewall and applies it.' }], at };
  }
  if (world && world.ok > 0) {
    // the server answers other countries but not this computer: a host-based block on your address
    return {
      cause: 'reachable-not-here',
      title: `${s.name} answers the internet, but not this computer`,
      explain: 'The server is up and reachable from other places, but it will not answer your computer. The usual cause is a block on your internet address on the server itself (fail2ban, CrowdSec, or a local firewall rule), often after failed logins.',
      checks,
      fixes: vmId(s) ? [{ id: 'restart', label: 'Restart the server', explain: 'A reboot clears most temporary blocks (fail2ban forgets them). Quick, and your apps come back by themselves.' }] : [],
      manual: {
        steps: [
          'Open your provider’s browser terminal for this server (Hostinger: VPS → Browser terminal; it only works if password sign-in is still on), or connect from a phone hotspot or over Tailscale.',
          'Paste the command below and press Enter. It lifts the block on your address and keeps SSH open.',
          'Come back and click Check again.',
          'If it still won’t connect, your own network may block it: try once from a phone hotspot.',
        ],
        command: UNBLOCK,
        link: vmId(s) ? 'https://hpanel.hostinger.com/vps' : undefined,
      },
      at,
    };
  }
  if (world && world.ok === 0 && vmId(s)) {
    return { cause: 'down', title: `${s.name} is not reachable from anywhere`, explain: 'No one can reach the server, not this computer and not other countries, even though Hostinger says it exists. It may be frozen or mid-boot. A restart usually brings it back.', checks, fixes: [{ id: 'restart', label: 'Restart the server', explain: 'Unit7 reboots the VPS through Hostinger.' }], at };
  }
  return {
    cause: 'unknown',
    title: `Unit7 can’t reach ${s.name}`,
    explain: `${s.host}:${s.port} did not answer. The server may be off, firewalled, or on a network that blocks your computer.`,
    checks,
    fixes: vmId(s) ? [{ id: 'restart', label: 'Restart the server', explain: 'Often the fastest way back when the cause is unclear.' }] : [],
    manual: { steps: ['Check the server is on in your provider.', 'Make sure its firewall allows SSH (TCP 22).', 'Try the browser terminal command below to clear any local block.'], command: UNBLOCK },
    at,
  };
}

// One sign-in to prove a fix worked (and bring the server's status back). Only a success counts as fixed.
async function signIn(ctx: Ctx, s: ServerRow, did?: string) {
  const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'server.inspect', { serverId: s.id }, { reason: 'repair check' });
  if (r.status === 'ok') return;
  const e = r.status === 'error' ? r.error : { code: 'not_checked', message: 'Unit7 couldn’t check.' };
  throw new Unit7Error(e.code === 'key_refused' ? 'still_refused' : 'not_fixed', `${did ? `${did}, but ` : ''}Unit7 still can’t sign in: ${e.message}`, 409, { command: keyCommand(ctx.app, s) });
}

// Carry out one fix. Each is a documented provider action or a Unit7 tool, on the user's own server.
async function applyFix(ctx: Ctx, s: ServerRow, fix: FixId): Promise<{ done: string; thenCheck?: boolean; prepare?: 'checking' | 'ready' }> {
  const id = vmId(s);
  const acc = s.account_id && get<{ id: string }>(ctx.db, `SELECT id FROM accounts WHERE id = ? AND provider = 'hostinger'`, s.account_id)?.id;
  const needHostinger = () => { if (!id || !acc) throw new Unit7Error('no_provider', 'This fix needs the Hostinger account that owns the server.', 409); return acc; };

  if (fix === 'trust-host-key') {
    run(ctx.db, `UPDATE servers SET host_key = NULL, ssh_block = NULLIF(ssh_block, 'host_key') WHERE id = ?`, s.id);
    await signIn(ctx, s, 'Trusted the server’s new identity');
    return { done: `Trusted ${s.name}’s new identity and signed in.` };
  }
  if (fix === 'start') { await hostingerExec(ctx, needHostinger(), 'vps_virtual-machines_start', { virtualMachineId: id }); return { done: `Starting ${s.name}. It takes a minute to boot.`, thenCheck: true }; }
  if (fix === 'restart') { await hostingerExec(ctx, needHostinger(), 'vps_virtual-machines_restart', { virtualMachineId: id }); return { done: `Restarting ${s.name}. Give it about a minute, then Unit7 checks again.`, thenCheck: true }; }
  if (fix === 'check-key') {
    ssh(ctx.app).unblock(s.id);
    await signIn(ctx, s);
    // the key works now: a fresh server is prepared by itself (servers.ts afterKeyWorks)
    return { done: `Unit7 signed in to ${s.name}. It’s fixed.`, prepare: afterKeyWorks(ctx.app, ctx.orgId, ctx.actor, s.id) };
  }
  if (fix === 'install-key') {
    // a person's click: this computer signs in with its own SSH key and appends Unit7's public key (idempotent)
    requireHuman(ctx, 'add Unit7’s key with this computer’s SSH access');
    let key = publicKeyOf(ctx.app, s);
    if (!key && !ctx.app.vault.list(s.org_id, s.key_ref).length) {
      // no login key here at all: make one (a new key pair, the private half in the vault), then add it like any other
      const k = await generateKeyPair(`unit7@${s.name}`);
      ctx.app.vault.put(s.org_id, s.key_ref, k.privateKey, { kind: 'ssh_key', meta: { publicKey: k.publicKey }, by: ctx.actor.name });
      key = k.publicKey;
    }
    if (!key) throw new Unit7Error('no_key', 'Unit7 doesn’t have a public key on file for this server. Reconnect it from the Servers page.', 409);
    const out = await new Promise<{ code: number; err: string }>((resolve) => {
      const child = execFile(sysBin('ssh'), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '-p', String(s.port), `${s.username}@${s.host}`,
        'umask 077; mkdir -p ~/.ssh; k=$(cat); grep -qxF "$k" ~/.ssh/authorized_keys 2>/dev/null || printf "%s\\n" "$k" >> ~/.ssh/authorized_keys'], { timeout: 20_000 },
        (e, _o, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, err: String(err).trim() }));
      child.stdin?.end(`${key}\n`);
    });
    if (out.code !== 0) throw new Unit7Error('install_failed', `This Mac couldn’t sign in to ${s.host} with its own SSH key either (${out.err.slice(0, 160) || `exit ${out.code}`}). Run this from somewhere that can sign in: ${keyCommand(ctx.app, s)}`, 502, { command: keyCommand(ctx.app, s) });
    ssh(ctx.app).unblock(s.id);
    await signIn(ctx, s, 'Added Unit7’s key');
    return { done: `Added Unit7’s key to ${s.username}@${s.host} and signed in. It’s fixed.`, prepare: afterKeyWorks(ctx.app, ctx.orgId, ctx.actor, s.id) };
  }
  if (fix === 'allow-ssh') {
    const a = needHostinger();
    const vm = await hostingerExec(ctx, a, 'vps_virtual-machines_get', { virtualMachineId: id });
    if (!vm?.firewall_group_id) throw new Unit7Error('no_firewall', 'This VPS has no Hostinger firewall group, so there is no provider rule to change.', 409);
    await hostingerExec(ctx, a, 'vps_firewall_create-rule', { firewallId: vm.firewall_group_id, protocol: 'TCP', port: '22', source: 'any', source_detail: 'any' });
    await hostingerExec(ctx, a, 'vps_firewall_sync', { firewallId: vm.firewall_group_id, virtualMachineId: id }).catch(() => undefined);
    return { done: 'Added an allow-SSH rule to the firewall and applied it.', thenCheck: true };
  }
  throw new Unit7Error('unknown_fix', `Unit7 doesn’t know the fix "${fix}".`, 400);
}

// --- tools ---------------------------------------------------------------------------------------

defineTool({
  name: 'server.diagnose', title: 'Find out why a server is unreachable', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'When a server is not answering, work out why (off, provider firewall, a block on this computer’s address, down, a key or host-key problem) and return the cause, the checks behind it, and the fixes Unit7 can apply. Read-only; changes nothing.',
  input: z.object({ serverId: fid('srv') }),
  run: (ctx, i) => diagnose(ctx, serverRow(ctx, i.serverId)),
});

defineTool({
  name: 'server.repair', title: 'Fix a server problem', risk: 'write', action: 'server_write', timeoutMs: 3 * 60_000,
  // a changed host key may be someone in the middle: only a person decides to trust it
  peopleOnly: (i) => i.fix === 'trust-host-key',
  description: 'Apply one fix from server.diagnose (start, restart, allow-ssh, install-key, check-key, trust-host-key). Provider actions use official operations on the user’s own server; install-key (people only) adds Unit7’s key with this computer’s own SSH access. Returns what was done and whether to check again.',
  input: z.object({ serverId: fid('srv'), fix: z.enum(['start', 'allow-ssh', 'restart', 'install-key', 'check-key', 'trust-host-key']) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const r = await applyFix(ctx, s, i.fix);
    ctx.emit('server.repair', `${s.name}: ${r.done}`, { severity: 'info', resource: s.id });
    return r;
  },
});
