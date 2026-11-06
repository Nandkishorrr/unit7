// The outside check: does a port on a server still answer the internet? Unit7 runs on the person's own computer,
// outside the server, so a plain TCP connection from here is a real internet test (the X-ray only sees what listens
// inside). Each port is tried next to the SSH port: if that one doesn't answer either, this computer can't reach the
// server at all just now, and nothing is said about the port. Results are kept on the server row (facts.outside).
import { connect, isIP } from 'node:net';
import { get, json, run, type DB } from '../db.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import { classify } from '../netguard.ts';
import { probe } from '../sentinel/watch.ts';
import { publicResolver, type Lookup } from '../connectors/dnsinfo.ts';

export interface Reach { state: 'open' | 'closed' | 'unknown'; at: string; ms?: number; why?: string }
export interface Tcp { open: boolean; ms: number; why?: string }

// connected = it answers; refused, or silence until the timeout (a DROP rule) = it doesn't
export function tcpReach(host: string, port: number, timeoutMs = 2500): Promise<Tcp> {
  const t0 = Date.now();
  return new Promise((done) => {
    let over = false;
    const sock = connect({ host, port });
    const end = (open: boolean, why?: string) => { if (over) return; over = true; sock.destroy(); done({ open, ms: Date.now() - t0, ...(why && { why }) }); };
    sock.setTimeout(timeoutMs, () => end(false, 'no answer'));
    sock.once('connect', () => end(true));
    sock.once('error', (e: NodeJS.ErrnoException) => end(false, e.code === 'ECONNREFUSED' ? 'refused' : e.code ?? e.message));
  });
}

// tests and demo copies set UNIT7_SKIP_NET_PROBE: nothing leaves the computer (tests swap these for fakes)
const offline = () => !!process.env.UNIT7_SKIP_NET_PROBE;
export const outside = {
  tcp: (host: string, port: number): Promise<Tcp | undefined> => (offline() ? Promise.resolve(undefined) : tcpReach(host, port)),
  https: (host: string): Promise<{ ok: boolean; code?: number; why?: string } | undefined> => (offline() ? Promise.resolve(undefined) : probe(host)),
  dns: (): Lookup | undefined => (offline() ? undefined : publicResolver()),
};

export const targetOf = (s: Pick<ServerRow, 'host' | 'facts'>) => json<{ publicIp?: string }>(s.facts, {}).publicIp ?? s.host;
export const outsideOf = (facts: string | null | undefined) => json<{ outside?: Record<string, Reach> }>(facts ?? '{}', {}).outside ?? {};
const factsOf = (db: DB, serverId: string) => get<{ facts: string }>(db, 'SELECT facts FROM servers WHERE id = ?', serverId)?.facts;
const keep = (db: DB, serverId: string, next: Record<string, Reach>) =>
  run(db, `UPDATE servers SET facts = json_set(COALESCE(NULLIF(facts, ''), '{}'), '$.outside', json(?)) WHERE id = ?`, JSON.stringify(next), serverId);
export function forgetOutside(db: DB, serverId: string, port: number) {
  const cur = outsideOf(factsOf(db, serverId));
  if (!(String(port) in cur)) return;
  delete cur[String(port)];
  keep(db, serverId, cur);
}

// the ports a check looks at: what Unit7 closed (the firewall rules the X-ray read, and its own list)
export const closedPortsOf = (s: Pick<ServerRow, 'facts'>, blocked?: { port: number }[]) =>
  [...new Set([...(blocked ?? []).map((b) => b.port), ...(json<{ closedPorts?: number[] }>(s.facts, {}).closedPorts ?? [])])].sort((a, b) => a - b);

// tries each port from here (at most 8, all at once) and keeps what it found; offline it checks nothing
export async function checkOutside(db: DB, s: Pick<ServerRow, 'id' | 'host' | 'port' | 'facts'>, ports: number[], o: { skipNewerThanMs?: number } = {}): Promise<Record<string, Reach>> {
  const before = outsideOf(factsOf(db, s.id));
  const fresh = (p: number) => !!o.skipNewerThanMs && Date.now() - Date.parse(before[String(p)]?.at ?? '') < o.skipNewerThanMs;
  const want = [...new Set(ports)].filter((p) => p > 0 && p < 65536 && !fresh(p)).slice(0, 8);
  if (!want.length) return before;
  const host = targetOf(s), at = new Date().toISOString();
  let got: Record<string, Reach>;
  if (isIP(host) && classify(host) !== 'public') {
    got = Object.fromEntries(want.map((p) => [p, { state: 'unknown', at, why: 'Unit7 reaches this server over a private network, so it can’t test it from the internet' } as Reach]));
  } else {
    const [ctl, ...tries] = await Promise.all([outside.tcp(host, s.port || 22), ...want.map((p) => outside.tcp(host, p))]);
    if (!ctl) return before;
    got = Object.fromEntries(want.map((p, n): [number, Reach] => {
      const t = tries[n];
      if (t?.open) return [p, { state: 'open', at, ms: t.ms }];
      return [p, ctl.open ? { state: 'closed', at, ...(t && { ms: t.ms, why: t.why }) } : { state: 'unknown', at, why: 'Unit7 couldn’t reach the server at all from this computer just now' }];
    }));
  }
  const next = { ...outsideOf(factsOf(db, s.id)), ...got };
  keep(db, s.id, next);
  return next;
}
