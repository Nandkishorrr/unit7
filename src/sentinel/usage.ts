// Usage history: every few minutes, one read-only SSH trip samples each server's CPU, memory, network, restarts
// and out-of-memory kills, per project. Coolify's own monitor (Sentinel) when it runs, else the containers'
// cgroup v2 files, else docker stats. Rates are deltas between samples (a true 5-minute average, not a blip),
// and the X-ray says which containers make up which project. Kept as rollups in SQLite: 5-minute points for 2
// days, hourly for 30 days, daily for a year. Nothing on the server changes.
import type { App } from '../app.ts';
import { all, get, json, run, type DB } from '../db.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { sections, parseSentinel, parseDockerStats, rollup, type Inventory, type Stat } from '../discovery/xray.ts';
import type { Point } from './anomaly.ts';

const PRELUDE = `export LC_ALL=C PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin"
if command -v timeout >/dev/null 2>&1; then t() { n=$1; shift; timeout "$n" "$@" 2>/dev/null; }; else t() { shift; "$@" 2>/dev/null; }; fi
s() { printf '\\n@@unit7:%s\\n' "$1"; }
`;
// cgroup lines: <id> <usage_usec> <memory.current> <inactive_file> <oom_kill> <rx> <tx> (net "-" when the
// container shares the host's network, where its counters would be the whole server's)
export const SAMPLE_PROBE = PRELUDE + `s host
head -1 /proc/stat; sleep 0.5; head -1 /proc/stat
echo "cpus=$(nproc 2>/dev/null)"
awk '/^MemTotal/{print "mem_total=" $2*1024} /^MemAvailable/{print "mem_available=" $2*1024}' /proc/meminfo
df -P -B1 / | awk 'NR==2{print "disk_total=" $2; print "disk_used=" $3}'
tail -n +3 /proc/net/dev | sed 's/:/ /' | awk '$1 !~ /^(lo|docker|veth|br-|virbr|cni|flannel|cali|tun|wg|tailscale)/ {rx+=$2; tx+=$10} END {printf "net_rx=%.0f\\nnet_tx=%.0f\\n", rx, tx}'
ids=$(t 5 docker ps -aq --no-trunc | head -300)
s ctrs
[ -n "$ids" ] && t 15 docker inspect -f '{{.Id}}|{{.Name}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{.State.Status}}' $ids
o=''
if t 5 docker ps --format '{{.Names}}' | grep -qx coolify-sentinel; then
  o=$(t 8 docker exec coolify-sentinel sh -c 'printf "Authorization: Bearer %s\\n" "$TOKEN" | curl -s -m 6 -H @- http://localhost:8888/api/containers/current')
fi
case "$o" in
  '['*'"percent"'*) s sentinel; echo "$o" ;;
  *)
    hostns=$(readlink /proc/1/ns/net 2>/dev/null)
    cg=$(for id in $(t 5 docker ps -q --no-trunc | head -300); do
      for d in /sys/fs/cgroup/system.slice/docker-$id.scope /sys/fs/cgroup/docker/$id; do
        [ -r "$d/cpu.stat" ] || continue
        p=$(head -1 "$d/cgroup.procs" 2>/dev/null); net='- -'
        if [ -n "$p" ] && [ "$(readlink /proc/$p/ns/net 2>/dev/null)" != "$hostns" ]; then net=$(tail -n +3 /proc/$p/net/dev 2>/dev/null | sed 's/:/ /' | awk '$1 != "lo" {rx+=$2; tx+=$10} END {printf "%.0f %.0f", rx, tx}'); fi
        echo "$id $(awk '/^usage_usec/{print $2}' $d/cpu.stat) $(cat $d/memory.current 2>/dev/null || echo 0) $(awk '/^inactive_file /{print $2}' $d/memory.stat 2>/dev/null || echo 0) $(awk '/^oom_kill /{print $2}' $d/memory.events 2>/dev/null || echo 0) $net"
        break
      done
    done)
    if [ -n "$cg" ]; then s cg; echo "$cg"; elif [ -n "$ids" ]; then s stats; t 20 docker stats --no-stream --format '{{json .}}'; fi ;;
esac
`;

// --- one sample, parsed ---------------------------------------------------------------------------
interface Raw {
  at: number; cpus: number; cpuInstant: number; cpuTicks?: { busy: number; total: number }; memTotal: number; memUsed: number; diskTotal: number; diskUsed: number;
  net?: { rx: number; tx: number }; source: 'sentinel' | 'cgroup' | 'docker-stats' | 'none';
  ctrs: Map<string, { name: string; restarts: number; oomKilled: boolean; state: string }>; // by full id
  cg: Map<string, { usec: number; mem: number; oom: number; rx?: number; tx?: number }>;    // by full id
  inst: Map<string, Stat>;                                                                // by name (Sentinel / docker stats)
}
const kvs = (t = '') => Object.fromEntries(t.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const ticks = (l?: string) => { const x = (l ?? '').trim().split(/\s+/).slice(1, 9).map(Number); const total = x.reduce((a, b) => a + (b || 0), 0); return { busy: total - (x[3] ?? 0) - (x[4] ?? 0), total }; };

export function parseSample(out: string, at = Date.now()): Raw {
  const sec = sections(out), h = kvs(sec.host);
  const cpuLines = (sec.host ?? '').split('\n').filter((l) => l.startsWith('cpu '));
  const a = ticks(cpuLines[0]), b = ticks(cpuLines[1] ?? cpuLines[0]);
  const ctrs: Raw['ctrs'] = new Map();
  for (const l of (sec.ctrs ?? '').split('\n')) {
    const [id, name, restarts, oom, state] = l.trim().split('|');
    if (id && name) ctrs.set(id, { name: name.replace(/^\//, ''), restarts: Number(restarts) || 0, oomKilled: oom === 'true', state: state ?? '' });
  }
  const cg: Raw['cg'] = new Map();
  for (const l of (sec.cg ?? '').split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length >= 5 && /^[0-9a-f]{12,}$/.test(f[0]!)) cg.set(f[0]!, { usec: Number(f[1]) || 0, mem: Math.max(0, (Number(f[2]) || 0) - (Number(f[3]) || 0)), oom: Number(f[4]) || 0, ...(f[5] && f[5] !== '-' && { rx: Number(f[5]) || 0, tx: Number(f[6]) || 0 }) });
  }
  const source = sec.sentinel !== undefined ? 'sentinel' : cg.size ? 'cgroup' : sec.stats !== undefined ? 'docker-stats' : 'none';
  const inst = source === 'sentinel' ? parseSentinel(sec.sentinel) : source === 'docker-stats' ? parseDockerStats(sec.stats) : new Map<string, Stat>();
  const memTotal = Number(h.mem_total) || 0;
  return {
    at, cpus: Number(h.cpus) || 1, cpuInstant: b.total - a.total > 0 ? Math.round((1000 * (b.busy - a.busy)) / (b.total - a.total)) / 10 : 0, cpuTicks: cpuLines.length ? b : undefined,
    memTotal, memUsed: memTotal - (Number(h.mem_available) || 0), diskTotal: Number(h.disk_total) || 0, diskUsed: Number(h.disk_used) || 0,
    ...(h.net_rx !== undefined && { net: { rx: Number(h.net_rx) || 0, tx: Number(h.net_tx) || 0 } }), source, ctrs, cg, inst,
  };
}

// --- between two samples: rates, and what restarted ---------------------------------------------------
export interface Taken {
  at: string; source: Raw['source']; cpus: number;
  host: { cpu: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number; net: number | null };
  per: Map<string, Stat>;              // by container name: cpu (% of one core), mem, rx/tx (bytes a second)
  restarts: Map<string, number>; oom: Map<string, number>; // by container name: since the last sample
}
export function between(prev: Raw | undefined, cur: Raw): Taken {
  const dt = prev ? (cur.at - prev.at) / 1000 : 0;
  const rate = (a?: number, b?: number) => (prev && dt > 0 && a !== undefined && b !== undefined && b >= a ? (b - a) / dt : undefined);
  const per = new Map<string, Stat>();
  const restarts = new Map<string, number>(), oom = new Map<string, number>();
  for (const [id, c] of cur.ctrs) {
    const p = prev?.ctrs.get(id);
    const r = p ? Math.max(0, c.restarts - p.restarts) : 0;
    const cgNow = cur.cg.get(id), cgBefore = prev?.cg.get(id);
    const o = Math.max(c.oomKilled && r > 0 ? r : 0, cgNow && cgBefore && cgNow.oom >= cgBefore.oom ? cgNow.oom - cgBefore.oom : 0);
    if (r) restarts.set(c.name, r);
    if (o) oom.set(c.name, o);
    if (cur.source === 'cgroup' && cgNow) {
      const usec = rate(cgBefore?.usec, cgNow.usec);
      per.set(c.name, { cpu: usec !== undefined ? usec / 1e4 : NaN, mem: cgNow.mem, rx: rate(cgBefore?.rx, cgNow.rx) ?? 0, tx: rate(cgBefore?.tx, cgNow.tx) ?? 0 });
    }
  }
  if (cur.source === 'sentinel') for (const [name, s] of cur.inst) per.set(name, s);
  if (cur.source === 'docker-stats') {
    // docker stats gives network as totals since each container started: a rate needs the one before
    for (const [name, s] of cur.inst) { const b = prev?.inst.get(name); per.set(name, { cpu: s.cpu, mem: s.mem, rx: rate(b?.netTotal, s.netTotal) ?? 0, tx: 0 }); }
  }
  const ticksDelta = prev?.cpuTicks && cur.cpuTicks && cur.cpuTicks.total > prev.cpuTicks.total ? Math.round((1000 * (cur.cpuTicks.busy - prev.cpuTicks.busy)) / (cur.cpuTicks.total - prev.cpuTicks.total)) / 10 : undefined;
  const netRate = prev?.net && cur.net ? rate(prev.net.rx + prev.net.tx, cur.net.rx + cur.net.tx) : undefined;
  return {
    at: new Date(cur.at).toISOString(), source: cur.source, cpus: cur.cpus,
    host: { cpu: ticksDelta ?? cur.cpuInstant, memUsed: cur.memUsed, memTotal: cur.memTotal, diskUsed: cur.diskUsed, diskTotal: cur.diskTotal, net: netRate ?? null },
    per, restarts, oom,
  };
}

// --- per project, as points ---------------------------------------------------------------------------
export interface Row { scope: string; name: string; system?: boolean; cpu: number | null; mem: number | null; net: number | null; restarts: number; oom: number; disk?: number | null }
export function toRows(t: Taken, inv?: Inventory): Row[] {
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const out: Row[] = [{ scope: 'server', name: 'The whole server', cpu: t.host.cpu, mem: t.host.memUsed, net: t.host.net, restarts: total(t.restarts), oom: total(t.oom), disk: t.host.diskUsed }];
  if (!inv?.projects?.length) return out;
  // rollup() sums whatever it's handed; a NaN CPU (no earlier sample yet) would poison the sum, so it goes as 0 and the point says null
  const firstCpu = [...t.per.values()].some((s) => Number.isNaN(s.cpu));
  const per = new Map([...t.per].map(([k, s]) => [k, { ...s, cpu: Number.isNaN(s.cpu) ? 0 : s.cpu }]));
  // every source is a rate here (bytes a second), the shape rollup() keeps as rx/tx
  const u = rollup(inv, { cpus: t.cpus, cpu: t.host.cpu, memTotal: t.host.memTotal, memUsed: t.host.memUsed, diskTotal: t.host.diskTotal, diskUsed: t.host.diskUsed }, per, 'sentinel');
  const ctrsOf = new Map(inv.projects.map((p) => [p.id, inv.parts.filter((x) => x.project === p.id).flatMap((x) => x.match ?? x.containers ?? [])]));
  const count = (m: Map<string, number>, id: string) => (ctrsOf.get(id) ?? []).reduce((a, c) => a + (m.get(c) ?? 0), 0);
  for (const s of u.projects) out.push({ scope: s.id, name: s.name, ...(s.system && { system: true }), cpu: firstCpu ? null : s.cpu, mem: s.mem, net: (s.rx ?? 0) + (s.tx ?? 0), restarts: count(t.restarts, s.id), oom: count(t.oom, s.id) });
  return out;
}

// --- storage: rollups ---------------------------------------------------------------------------------
export const RES = { '5m': 5 * 60_000, '1h': 3600_000, '1d': 86400_000 } as const;
export type Res = keyof typeof RES;
export const KEEP: Record<Res, number> = { '5m': 2 * 86400_000, '1h': 30 * 86400_000, '1d': 365 * 86400_000 };
export const bucket = (at: string | number, res: Res) => { const t = typeof at === 'number' ? at : Date.parse(at); return new Date(Math.floor(t / RES[res]) * RES[res]).toISOString(); };

// a running average and max per bucket, restarts and out-of-memory kills summed; append-only upserts
const avg = (c: string) => `${c} = CASE WHEN excluded.${c} IS NULL THEN ${c} WHEN ${c} IS NULL THEN excluded.${c} ELSE (${c} * n + excluded.${c}) / (n + 1) END`;
const top = (c: string, src: string) => `${c} = max(coalesce(${c}, excluded.${src}), coalesce(excluded.${src}, ${c}))`;
const UPSERT = `INSERT INTO usage_points (org_id, server_id, scope, name, res, at, n, cpu, cpu_max, mem, mem_max, net, net_max, restarts, oom, disk)
  VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(server_id, scope, res, at) DO UPDATE SET name = excluded.name, ${avg('cpu')}, ${top('cpu_max', 'cpu_max')}, ${avg('mem')}, ${top('mem_max', 'mem_max')},
  ${avg('net')}, ${top('net_max', 'net_max')}, restarts = restarts + excluded.restarts, oom = oom + excluded.oom, disk = coalesce(excluded.disk, disk), n = n + 1`;
export function storeRows(db: DB, orgId: string, serverId: string, at: string, rows: Row[]) {
  for (const r of rows) for (const res of Object.keys(RES) as Res[]) {
    run(db, UPSERT, orgId, serverId, r.scope, r.name, res, bucket(at, res), r.cpu, r.cpu, r.mem, r.mem, r.net, r.net, r.restarts, r.oom, r.disk ?? null);
  }
}
export function prune(db: DB, now = Date.now()) {
  for (const res of Object.keys(KEEP) as Res[]) run(db, 'DELETE FROM usage_points WHERE res = ? AND at < ?', res, new Date(now - KEEP[res]).toISOString());
}

interface PointRow { scope: string; name: string; at: string; cpu: number | null; cpu_max: number | null; mem: number | null; mem_max: number | null; net: number | null; net_max: number | null; restarts: number; oom: number; disk: number | null }
const asPoint = (r: PointRow): Point => ({ at: r.at, cpu: r.cpu, cpuMax: r.cpu_max, mem: r.mem, memMax: r.mem_max, net: r.net, netMax: r.net_max, restarts: r.restarts, oom: r.oom, disk: r.disk });
export function readPoints(db: DB, serverId: string, res: Res, sinceMs: number, scope?: string): Map<string, { name: string; points: Point[] }> {
  const rows = all<PointRow>(db, `SELECT scope, name, at, cpu, cpu_max, mem, mem_max, net, net_max, restarts, oom, disk FROM usage_points
    WHERE server_id = ? AND res = ? AND at >= ? AND (? IS NULL OR scope = ?) ORDER BY at`, serverId, res, new Date(sinceMs).toISOString(), scope ?? null, scope ?? null);
  const out = new Map<string, { name: string; points: Point[] }>();
  for (const r of rows) { const s = out.get(r.scope) ?? { name: r.name, points: [] }; s.name = r.name; s.points.push(asPoint(r)); out.set(r.scope, s); }
  return out;
}
export const lastSampleAt = (db: DB, serverId: string) => get<{ at: string | null }>(db, `SELECT max(at) at FROM usage_points WHERE server_id = ? AND res = '5m' AND scope = 'server'`, serverId)?.at ?? undefined;

// --- the sampler: the last raw sample per server stays in memory (rates need the one before) -----------
// ponytail: the previous sample lives in memory, so the first one after Unit7 starts has no container CPU; a
// persisted copy (or the opt-in on-server buffer from the research) fills that when it matters
const previous = new Map<string, Raw>();
const asRoot = (s: ServerRow) => (json<{ sudo?: string }>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : '');
export async function sample(app: App, s: ServerRow, inv?: Inventory): Promise<{ rows: Row[]; source: string; host: Taken['host'] }> {
  const r = await ssh(app).exec(s, `${asRoot(s)}sh -s`, { stdin: SAMPLE_PROBE, timeoutMs: 45_000, maxBytes: 4 * 1024 * 1024 });
  if (!r.stdout.includes('@@unit7:host')) throw new Error(`No usage sample from ${s.name}: ${r.stderr.trim().slice(-200) || `exit ${r.code}`}`);
  const raw = parseSample(r.stdout);
  const p = previous.get(s.id);
  const t = between(p && raw.at - p.at < 30 * 60_000 ? p : undefined, raw);
  previous.set(s.id, raw);
  const rows = toRows(t, inv);
  storeRows(app.db, s.org_id, s.id, t.at, rows);
  return { rows, source: t.source, host: t.host };
}
