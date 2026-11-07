// Where Unit7's control plane may connect. Cloud metadata endpoints are never allowed (they hand out
// cloud credentials). Private and loopback ranges are allowed by default — a self-hosted Unit7
// manages machines on its own network — and blocked when UNIT7_BLOCK_PRIVATE_HOSTS=1, which a
// shared multi-tenant Unit7 must set so one tenant can't make it reach into its own network.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Unit7Error } from './errors.ts';

const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
export const validHost = (h: string) => isIP(h) !== 0 || HOSTNAME.test(h);

// Compared as numbers, not text: one address has many spellings (::1, 0:0:0:0:0:0:0:1), and an IPv4 inside an IPv6 (::ffff:a9fe:a9fe) counts as that IPv4.
const ranges = (...list: [string, number][]) => { const b = new BlockList(); for (const [net, bits] of list) b.addSubnet(net, bits, isIP(net) === 4 ? 'ipv4' : 'ipv6'); return b; };
const METADATA = ranges(['169.254.0.0', 16], ['fe80::', 10], ['fd00:ec2::254', 128]); // link-local, incl. 169.254.169.254
const INVALID = ranges(['0.0.0.0', 8], ['224.0.0.0', 3], ['::', 128]);
const LOOPBACK = ranges(['127.0.0.0', 8], ['::1', 128]);
const PRIVATE = ranges(['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['fc00::', 7]);

export function classify(ip: string): 'public' | 'private' | 'loopback' | 'metadata' | 'invalid' {
  const family = isIP(ip);
  if (!family) return 'invalid';
  const is = (b: BlockList) => b.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  return is(METADATA) ? 'metadata' : is(INVALID) ? 'invalid' : is(LOOPBACK) ? 'loopback' : is(PRIVATE) ? 'private' : 'public';
}

// Resolve and check every address a name points at (a name can't sneak past by resolving late).
export async function assertReachable(host: string): Promise<string[]> {
  if (!validHost(host)) throw new Unit7Error('bad_host', `"${host}" is not a valid hostname or IP address.`);
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => {
    throw new Unit7Error('bad_host', `"${host}" does not resolve.`);
  })).map((a) => a.address);
  for (const ip of addrs) {
    const c = classify(ip);
    if (c === 'metadata' || c === 'invalid') throw new Unit7Error('blocked_host', `Unit7 won't connect to ${host} (${ip}): that address is reserved.`, 403);
    if ((c === 'private' || c === 'loopback') && process.env.UNIT7_BLOCK_PRIVATE_HOSTS === '1') {
      throw new Unit7Error('blocked_host', `This Unit7 doesn't connect to private network addresses (${host} → ${ip}).`, 403);
    }
  }
  return addrs;
}
