// Where Unit7's control plane may connect. Cloud metadata endpoints are never allowed (they hand out
// cloud credentials). Private and loopback ranges are allowed by default — a self-hosted Unit7
// manages machines on its own network — and blocked when UNIT7_BLOCK_PRIVATE_HOSTS=1, which a
// shared multi-tenant Unit7 must set so one tenant can't make it reach into its own network.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Unit7Error } from './errors.ts';

const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
export const validHost = (h: string) => isIP(h) !== 0 || HOSTNAME.test(h);

function v4(ip: string) { return ip.split('.').map(Number) as [number, number, number, number]; }

export function classify(ip: string): 'public' | 'private' | 'loopback' | 'metadata' | 'invalid' {
  if (isIP(ip) === 4) {
    const [a, b] = v4(ip);
    if (a === 169 && b === 254) return 'metadata'; // link-local, incl. 169.254.169.254
    if (a === 0 || a >= 224) return 'invalid';
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    return 'public';
  }
  if (isIP(ip) === 6) {
    const x = ip.toLowerCase();
    if (x === '::1') return 'loopback';
    if (x.startsWith('fe80:') || x === 'fd00:ec2::254') return 'metadata';
    if (x.startsWith('::ffff:')) return classify(x.slice(7));
    if (x.startsWith('fc') || x.startsWith('fd')) return 'private';
    if (x === '::') return 'invalid';
    return 'public';
  }
  return 'invalid';
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
