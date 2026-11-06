// Shield: Unit7's edge defence. It keeps a blocklist that every site imports, so one update blocks
// an IP across every app on a server instantly (a validated `caddy reload`, no downtime). Blocks
// escalate 15m → 1h → 24h → 7d and expire on their own. When nftables is present it also drops the
// IP at L3 (before Docker's NAT); otherwise the Caddy 403 is the floor. Hard safety rules live here:
// never block the allowlist, the server's own IPs, private ranges, or anything /16-or-wider.
import type { App } from '../app.ts';
import type { Ctx } from '../tools/runtime.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script, safeName } from '../connectors/shell.ts';
import { serverRow } from '../tools/servers.ts';
import { classify } from '../netguard.ts';
import { proxyFor } from '../deploy/caddy.ts';

const SNIPPET = '/etc/unit7/caddy/snippets.caddy';
const LADDER = [15 * 60_000, 60 * 60_000, 24 * 3600_000, 7 * 24 * 3600_000]; // 15m,1h,24h,7d

export interface Block { ip: string; reason: string; until: number; strikes: number }

const ipKey = (s: ServerRow) => `shield:${s.id}`;

// in-DB state (survives restarts): reuse the events/audit tables is overkill; keep it in a tiny json
// column on the server's facts under `.blocks`.
function readBlocks(app: App, serverId: string): Block[] {
  const f = json<{ blocks?: Block[] }>(get<{ facts: string }>(app.db, 'SELECT facts FROM servers WHERE id = ?', serverId)?.facts ?? '{}', {});
  return (f.blocks ?? []).filter((b) => b.until > Date.now());
}
function writeBlocks(app: App, serverId: string, blocks: Block[]) {
  run(app.db, `UPDATE servers SET facts = json_set(facts, '$.blocks', json(?)) WHERE id = ?`, JSON.stringify(blocks), serverId);
}

export function assertBlockable(ctx: Ctx | { db: App['db']; orgId: string }, s: ServerRow, cidr: string) {
  const ip = cidr.split('/')[0]!;
  const bits = cidr.includes('/') ? Number(cidr.split('/')[1]) : 32;
  const kind = classify(ip);
  if (kind === 'invalid') throw new Unit7Error('bad_ip', `"${cidr}" is not an IP address.`);
  if (kind !== 'public') throw new Unit7Error('unsafe_block', `Unit7 won't block ${cidr}: it's a ${kind} address, not a public client.`);
  if (bits < 24) throw new Unit7Error('block_too_wide', `Blocking ${cidr} would hit too many people (/${bits}). A person must do blocks wider than /24.`);
  const selfIps = json<{ publicIp?: string }>(s.facts, {}).publicIp;
  if (selfIps && ip === selfIps) throw new Unit7Error('unsafe_block', `That's the server's own address.`);
  if (ip === s.host) throw new Unit7Error('unsafe_block', `That's the address Unit7 connects to.`);
}

// IPv4 only (CIDR is IPv4 in the tools): is `ip` inside `cidr`?
const num = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
export function inCidr(ip: string, cidr: string) {
  const [base, bits = '32'] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && Math.floor(num(ip) / size) === Math.floor(num(base!) / size);
}

// The address Unit7 (this computer, usually the owner's own connection) reaches the server from. Blocking it
// would cut Unit7 off for good: lifting a block needs SSH. Asked fresh each time: home addresses change.
async function controllerIp(app: App, s: ServerRow) {
  return (await ssh(app).exec(s, script('echo "${SSH_CLIENT%% *}"'), { timeoutMs: 15_000 }).catch(() => ({ stdout: '' }))).stdout.trim();
}

function renderSnippet(blocks: Block[]): string {
  // a sentinel keeps the matcher non-empty (an empty client_ip matcher is a Caddyfile error)
  const cidrs = ['192.0.2.1', ...blocks.map((b) => b.ip)];
  return `(unit7_blocklist) {\n\t@unit7_blocked client_ip ${cidrs.join(' ')}\n\tabort @unit7_blocked\n}\n`;
}

export async function applyBlocklist(app: App, s: ServerRow) {
  const blocks = readBlocks(app, s.id);
  if (proxyFor(s).kind !== 'caddy') { await ssh(app).exec(s, script(nftScript(blocks))).catch(() => undefined); return; }
  const su = s.username === 'root' ? '' : 'sudo ';
  await ssh(app).check(s, script(`printf '%s' "$2" | ${su}tee "$1" >/dev/null`, SNIPPET, renderSnippet(blocks)), { what: 'Writing the blocklist', timeoutMs: 20_000 });
  // validate then reload; a broken snippet must never take the proxy down
  await ssh(app).check(s, script('docker exec unit7-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && docker exec unit7-caddy caddy reload --config /etc/caddy/Caddyfile 2>&1'), { what: 'Reloading the proxy', timeoutMs: 30_000 });
  // best-effort L3 drop when nft is available
  await ssh(app).exec(s, script(nftScript(blocks))).catch(() => undefined);
}

function nftScript(blocks: Block[]): string {
  const su = ''; // run as whatever user; nft needs root, errors are swallowed by the caller
  // each element carries its own timeout, so a block lifts even if Unit7 can never reach the server again
  const elems = blocks.filter((b) => classify(b.ip.split('/')[0]!) === 'public').map((b) => `${b.ip} timeout ${Math.max(1, Math.ceil((b.until - Date.now()) / 1000))}s`).join(', ');
  return `command -v nft >/dev/null 2>&1 || exit 0
${su}nft list table inet unit7 >/dev/null 2>&1 || ${su}nft -f - <<'NFT'
table inet unit7 {
  set block4 { type ipv4_addr; flags interval,timeout; }
  chain pre { type filter hook prerouting priority -150; policy accept; ip saddr @block4 drop; }
}
NFT
${su}nft flush set inet unit7 block4 2>/dev/null || true
${elems ? elems.split(', ').map((ip) => `${su}nft add element inet unit7 block4 { ${ip} } 2>/dev/null`).join('\n') : 'true'}`;
}

// The core, with no Ctx — Warden calls this directly. Returns the block, or null if it was refused
// (private/self/too-wide) — Warden should never crash on a bad candidate.
export async function blockIp(app: App, s: ServerRow, ip: string, reason: string, emit = true): Promise<Block | null> {
  try { assertBlockable({ db: app.db, orgId: s.org_id }, s, ip); } catch { return null; }
  const me = await controllerIp(app, s);
  if (!me || inCidr(me, ip)) return null; // never cut Unit7 (and the owner's own address) off
  const blocks = readBlocks(app, s.id);
  const existing = blocks.find((b) => b.ip === ip);
  const strikes = (existing?.strikes ?? 0) + 1;
  const dur = LADDER[Math.min(strikes - 1, LADDER.length - 1)]!;
  const b: Block = { ip, reason, until: Date.now() + dur, strikes };
  writeBlocks(app, s.id, [...blocks.filter((x) => x.ip !== ip), b]);
  await applyBlocklist(app, s);
  if (emit) app.events.emit(s.org_id, 'shield.blocked', `Blocked ${ip} on ${s.name} for ${Math.round(dur / 60000)}m (${reason})`, { severity: 'warning', resource: s.id, data: { ip, strikes } });
  return b;
}

export async function block(ctx: Ctx, serverId: string, ip: string, reason: string): Promise<Block> {
  const s = serverRow(ctx, serverId);
  assertBlockable(ctx, s, ip); // throws with a clear message for the human caller
  const me = await controllerIp(ctx.app, s);
  if (me && inCidr(me, ip)) throw new Unit7Error('unsafe_block', `${ip} includes ${me}, the address Unit7 reaches ${s.name} from (likely your own). Blocking it would lock Unit7 and you out.`);
  const b = await blockIp(ctx.app, s, ip, reason, true);
  if (!b) throw new Unit7Error('unsafe_block', `Unit7 won't block ${ip}.`);
  return b;
}

export async function unblock(ctx: Ctx, serverId: string, ip: string) {
  const s = serverRow(ctx, serverId);
  const blocks = readBlocks(ctx.app, serverId).filter((b) => b.ip !== ip);
  writeBlocks(ctx.app, serverId, blocks);
  await applyBlocklist(ctx.app, s);
  ctx.emit('shield.unblocked', `Unblocked ${ip} on ${s.name}`, { resource: serverId });
}

export function listBlocks(app: App, serverId: string) { return readBlocks(app, serverId); }

// Called by Warden: prune expired blocks (their timers lapsed) and re-apply so the snippet matches.
export async function reconcile(app: App, s: ServerRow) {
  const live = readBlocks(app, s.id);
  const all = json<{ blocks?: Block[] }>(get<{ facts: string }>(app.db, 'SELECT facts FROM servers WHERE id = ?', s.id)?.facts ?? '{}', {}).blocks ?? [];
  if (live.length !== all.length) { writeBlocks(app, s.id, live); await applyBlocklist(app, s).catch(() => undefined); }
}
