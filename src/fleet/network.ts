// The private network between an app's servers, so the front proxy can reach the copies on the others without anything
// being opened to the internet. When every server already sits on the provider's own private network (a Hetzner network,
// a DigitalOcean VPC) and they reach each other there, Unit7 uses it. Otherwise WireGuard: each server makes its own key
// pair (the private key is written on the server and never leaves it; only the public key comes back through Unit7), gets
// an address in 10.77.0.0/24, and lists the others as peers. The firewall lets WireGuard in only from the peers.
import { isIP } from 'node:net';
import { all, get, now, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import type { Ctx } from '../tools/runtime.ts';
import type { Facts } from '../tools/servers.ts';

export const WG_PORT = 51820;
export const WG_NET = '10.77.0';
const SU = 'SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"\n';

// --- the commands (constants: values only ever go in as arguments) ----------------------------------------------------
// install WireGuard's tools if they're missing
export const WG_INSTALL = `${SU}command -v wg >/dev/null 2>&1 || {
  if command -v apt-get >/dev/null 2>&1; then $SU env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wireguard-tools >/dev/null
  elif command -v dnf >/dev/null 2>&1; then $SU dnf install -y -q wireguard-tools >/dev/null
  elif command -v apk >/dev/null 2>&1; then $SU apk add -q wireguard-tools >/dev/null; fi; }
command -v wg >/dev/null 2>&1`;
// the key pair, made on the server: the private key stays in /etc/wireguard/unit7.key (0600); only the public key is printed
export const WG_KEYGEN = `${SU}$SU sh -c 'umask 077; mkdir -p /etc/wireguard; [ -s /etc/wireguard/unit7.key ] || wg genkey > /etc/wireguard/unit7.key'
$SU sh -c 'wg pubkey < /etc/wireguard/unit7.key'`;
// write the config ($1) and (re)start the interface; Docker starts after it, so the private port's address exists
export const WG_APPLY = `${SU}printf '%s' "$1" | $SU tee /etc/wireguard/wg0.conf >/dev/null && $SU chmod 600 /etc/wireguard/wg0.conf
$SU mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\\nAfter=wg-quick@wg0.service\\nWants=wg-quick@wg0.service\\n' | $SU tee /etc/systemd/system/docker.service.d/unit7-wg.conf >/dev/null
$SU systemctl daemon-reload && $SU systemctl enable wg-quick@wg0 >/dev/null 2>&1; $SU systemctl restart wg-quick@wg0`;
// the provider's own private addresses: every IPv4 on interfaces that aren't Docker's, WireGuard's or loopback
export const PRIVATE_ADDRS = `ip -4 -o addr show 2>/dev/null | awk '{print $2, $4}'`;

const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/; // a WireGuard (curve25519) public key, base64
export const isWgKey = (k: string) => KEY.test(k.trim());
const ip4 = (s: string) => isIP(s) === 4;

// The WireGuard config of one server. No PrivateKey line: wg-quick loads it from the server's own key file (PostUp), so
// the file Unit7 writes never holds it.
export function wgConfig(me: { address: string }, peers: { publicKey: string; address: string; endpoint: string }[]): string {
  if (!ip4(me.address)) throw new Unit7Error('bad_address', `${me.address} isn't a private address Unit7 gave out.`, 400);
  const lines = ['[Interface]', `Address = ${me.address}/24`, `ListenPort = ${WG_PORT}`, 'PostUp = wg set %i private-key /etc/wireguard/unit7.key', ''];
  for (const p of peers) {
    // what a server printed is untrusted: only a real key and real addresses get into a config
    if (!isWgKey(p.publicKey) || !ip4(p.address) || !ip4(p.endpoint)) throw new Unit7Error('bad_peer', 'A server answered with something that isn’t a WireGuard key or an address, so Unit7 stopped.', 502);
    lines.push('[Peer]', `PublicKey = ${p.publicKey.trim()}`, `AllowedIPs = ${p.address}/32`, `Endpoint = ${p.endpoint}:${WG_PORT}`, 'PersistentKeepalive = 25', '');
  }
  return lines.join('\n');
}

// The firewall: WireGuard's port only from the peers' public addresses, and traffic on the private interface only from
// the peers' private addresses. Unit7's earlier rules (comment unit7-fleet) are removed first, so a server that left
// loses its way in. Only when ufw is on: Unit7 never switches a firewall on as a side effect.
export function ufwScript(peers: { address: string; endpoint: string }[], iface = 'wg0') {
  for (const p of peers) if (!ip4(p.address) || !ip4(p.endpoint)) throw new Unit7Error('bad_peer', 'Not an address.', 400);
  const allow = peers.flatMap((p) => [
    `$SU ufw allow proto udp from ${p.endpoint} to any port ${WG_PORT} comment unit7-fleet >/dev/null`,
    `$SU ufw allow in on ${iface} from ${p.address} comment unit7-fleet >/dev/null`,
  ]);
  return `${SU}command -v ufw >/dev/null 2>&1 && $SU ufw status 2>/dev/null | grep -q '^Status: active' || exit 0
for n in $($SU ufw status numbered | awk -F'[][]' '/unit7-fleet/ {print $2}' | sort -rn); do $SU ufw --force delete "$n" >/dev/null; done
${allow.join('\n')}`;
}

// a private address on the provider's own network (not Docker's, WireGuard's or loopback): the first one of 10/8, 172.16/12, 192.168/16
export function providerAddress(ipOut: string): string | undefined {
  for (const line of ipOut.split('\n')) {
    const [iface = '', cidr = ''] = line.trim().split(/\s+/);
    if (/^(lo|docker|br-|veth|wg|tailscale|cni|flannel|virbr)/.test(iface)) continue;
    const addr = cidr.split('/')[0] ?? '';
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(addr) && !addr.startsWith(`${WG_NET}.`) && ip4(addr)) return addr;
  }
}
// both on one provider network: the same /16
export const sameNet = (a: string, b: string) => a.split('.').slice(0, 2).join('.') === b.split('.').slice(0, 2).join('.');

// --- applying it ---------------------------------------------------------------------------------------------------------
export interface NetRow { server_id: string; kind: 'wireguard' | 'provider'; address: string; public_key: string | null; endpoint: string | null }
export const netOf = (db: DB, serverId: string) => get<NetRow>(db, 'SELECT server_id, kind, address, public_key, endpoint FROM fleet_net WHERE server_id = ?', serverId);

export async function publicAddress(s: ServerRow): Promise<string> {
  const f = JSON.parse(s.facts || '{}') as Facts & { publicIp?: string };
  if (f.publicIp && ip4(f.publicIp)) return f.publicIp;
  if (ip4(s.host)) return s.host;
  const { lookup } = await import('node:dns/promises');
  return (await lookup(s.host, { family: 4 })).address;
}

// the next free 10.77.0.x in this organisation (1 is the first server)
function nextAddress(db: DB, orgId: string) {
  const used = new Set(all<{ address: string }>(db, `SELECT address FROM fleet_net WHERE org_id = ? AND kind = 'wireguard'`, orgId).map((r) => Number(r.address.split('.')[3])));
  for (let n = 1; n < 255; n++) if (!used.has(n)) return `${WG_NET}.${n}`;
  throw new Unit7Error('network_full', 'The private network is full (254 servers).', 409);
}

// Every server of a fleet on one private network. Returns each server's private address.
export async function connectServers(ctx: Ctx, servers0: ServerRow[], say: (m: string) => void = () => undefined): Promise<Map<string, string>> {
  const pool = ssh(ctx.app);
  const out = new Map<string, string>();
  // ponytail: one private network per organisation. Once a server is on WireGuard, every fleet server joins it (and keeps
  // the peers of the organisation's other fleets), instead of mixing networks per app.
  const inWg = all<{ server_id: string }>(ctx.db, `SELECT server_id FROM fleet_net WHERE org_id = ? AND kind = 'wireguard'`, ctx.orgId).map((r) => r.server_id);
  const servers = [...servers0, ...inWg.filter((x) => !servers0.some((s) => s.id === x)).map((x) => get<ServerRow>(ctx.db, 'SELECT * FROM servers WHERE id = ?', x)).filter((s): s is ServerRow => !!s)];
  // 1. the provider's own network, when all of them are on it and the first one reaches the others
  const found = inWg.length ? [] : await Promise.all(servers.map(async (s) => providerAddress((await pool.exec(s, script(PRIVATE_ADDRS), { timeoutMs: 15_000 }).catch(() => ({ stdout: '' }))).stdout)));
  if (!inWg.length && found.every(Boolean) && found.every((a) => sameNet(a!, found[0]!))) {
    const [first] = servers;
    const reach = await Promise.all(found.slice(1).map((a) => pool.exec(first!, script('ping -c 1 -W 2 "$1" >/dev/null 2>&1 && echo ok', a!), { timeoutMs: 15_000 }).then((r) => r.stdout.includes('ok'), () => false)));
    if (reach.every(Boolean)) {
      say('Your servers share the provider’s private network, so Unit7 uses it.');
      servers.forEach((s, k) => { save(ctx, s, { kind: 'provider', address: found[k]!, public_key: null, endpoint: null }); out.set(s.id, found[k]!); });
      return out;
    }
  }
  // 2. WireGuard: keys made on each server (only the public half comes back), an address each, everyone a peer
  say('Setting up a private network between your servers (WireGuard)…');
  const peers: { s: ServerRow; publicKey: string; address: string; endpoint: string }[] = [];
  for (const s of servers) {
    await pool.check(s, script(WG_INSTALL), { what: 'Installing WireGuard', timeoutMs: 300_000 });
    const publicKey = (await pool.check(s, script(WG_KEYGEN), { what: 'Making the WireGuard key', timeoutMs: 30_000 })).trim().split('\n').pop()!.trim();
    if (!isWgKey(publicKey)) throw new Unit7Error('bad_key', `${s.name} didn’t answer with a WireGuard public key.`, 502);
    const known = netOf(ctx.db, s.id);
    const address = known?.kind === 'wireguard' ? known.address : nextAddress(ctx.db, ctx.orgId);
    const endpoint = await publicAddress(s);
    save(ctx, s, { kind: 'wireguard', address, public_key: publicKey, endpoint });
    peers.push({ s, publicKey, address, endpoint });
  }
  for (const me of peers) {
    const others = peers.filter((p) => p !== me);
    await pool.check(me.s, script(WG_APPLY, wgConfig(me, others)), { what: 'Starting the private network', timeoutMs: 60_000 });
    await pool.check(me.s, script(ufwScript(others)), { what: 'Letting only your servers in', timeoutMs: 60_000 });
    out.set(me.s.id, me.address);
  }
  return out;
}
function save(ctx: Ctx, s: ServerRow, n: Omit<NetRow, 'server_id'>) {
  run(ctx.db, `INSERT INTO fleet_net (server_id, org_id, kind, address, public_key, endpoint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (server_id) DO UPDATE SET kind = excluded.kind, address = excluded.address, public_key = excluded.public_key, endpoint = excluded.endpoint`,
    s.id, ctx.orgId, n.kind, n.address, n.public_key, n.endpoint, now());
}
