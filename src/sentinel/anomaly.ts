// Jumps worth a look, from the usage history: CPU or memory well above their usual band for 10+ minutes,
// memory climbing like a leak, restart loops, the disk filling faster than usual, a sudden network spike.
// Each comes with a reason in plain words ("Memory is 2.3× its usual level for this time of day"). Pure.
import { bandOf, linearFit, median, type Band, type Sample } from './baseline.ts';

export interface Point { at: string; cpu: number | null; cpuMax?: number | null; mem: number | null; memMax?: number | null; net: number | null; netMax?: number | null; restarts: number; oom: number; disk?: number | null }
export type Metric = 'cpu' | 'mem' | 'net' | 'disk' | 'restarts';
export interface Anomaly {
  key: string; kind: 'high' | 'spike' | 'leak' | 'restarts' | 'disk'; metric: Metric; scope: string; name: string;
  severity: 'warning' | 'critical'; since: string; value: number; usual?: number; ratio?: number; reason: string; forecast?: string;
  quiet?: boolean; // worth seeing on the server's page, not worth a buzz: above its usual, but nothing is in danger yet
}
export interface Series { scope: string; name: string; recent: Point[]; hourly: Point[]; daily?: Point[] }
export interface Host { memTotal?: number; diskTotal?: number; diskUsed?: number; memUsed?: number }

const MIN = 60_000, HOUR = 3600_000;
export const fmtBytes = (n: number) => {
  const a = Math.abs(n);
  return a >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : a >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : a >= 1e6 ? `${Math.round(n / 1e6)} MB` : a >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${Math.round(n)} B`;
};
export const fmtRate = (n: number) => `${fmtBytes(n)}/s`;
export const fmtTimes = (r: number) => `${r >= 10 ? Math.round(r) : r.toFixed(1).replace(/\.0$/, '')}×`;
export const fmtHours = (h: number) => (h < 1.5 ? 'about an hour' : h < 36 ? `about ${Math.round(h)} hours` : `about ${Math.round(h / 24)} days`);
const fmtMins = (m: number) => (m >= 90 ? `${Math.round(m / 60)} hours` : `${Math.round(m)} minutes`);

// how wide "normal" must at least be, per metric (half-width around the middle)
export const FLOOR: Record<'cpu' | 'mem' | 'net', (mid: number) => number> = {
  cpu: (m) => Math.max(1.5, 0.3 * m),         // percentage points of the server
  mem: (m) => Math.max(50e6, 0.08 * m),       // bytes
  net: (m) => Math.max(50e3, 0.5 * m),        // bytes per second
};
const hist = (pts: Point[], k: 'cpu' | 'mem' | 'net'): Sample[] => pts.map((p) => ({ at: p.at, v: p[k], max: p[`${k}Max` as 'cpuMax'] }));
export const bandFor = (s: Series, k: 'cpu' | 'mem' | 'net', at: string): Band | undefined => bandOf(hist(s.hourly, k), at, FLOOR[k]);

const WHAT: Record<'cpu' | 'mem' | 'net', string> = { cpu: 'CPU', mem: 'Memory', net: 'Network traffic' };
const show = (k: 'cpu' | 'mem' | 'net', v: number) => (k === 'cpu' ? `${Math.round(v)}%` : k === 'mem' ? fmtBytes(v) : fmtRate(v));
const label = (s: Series) => (s.scope === 'server' ? '' : ` of ${s.name}`);

// over the band for this many 5-minute points in a row, at least `ratio` × the usual and `abs` above it
const HIGH = { cpu: { ratio: 1.5, abs: 10 }, mem: { ratio: 1.3, abs: 100e6 } } as const;

export function detect(s: Series, host: Host = {}, now = Date.now()): Anomaly[] {
  const out: Anomaly[] = [];
  const recent = s.recent.filter((p) => Date.parse(p.at) <= now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!recent.length) return out;
  const last = recent.at(-1)!;
  if (now - Date.parse(last.at) > 20 * MIN) return out; // nothing fresh: no claims about "now"
  const key = (kind: string, m: string) => `${s.scope}:${kind}:${m}`;

  // 1. well above its usual for 10+ minutes
  for (const k of ['cpu', 'mem'] as const) {
    let run = 0, b: Band | undefined, first = last;
    for (let i = recent.length - 1; i >= 0; i--) {
      const p = recent[i]!, v = p[k];
      const band = bandFor(s, k, p.at);
      if (k === 'mem' && !band?.mid) break; // running things use memory: "usually 0" means it wasn't measured then, so there's nothing to compare with
      if (v == null || !band || !(v > band.hi && v >= band.mid * HIGH[k].ratio && v - band.mid >= HIGH[k].abs)) break;
      if (k === 'mem' && s.scope === 'server' && host.memTotal && v - band.mid < 0.05 * host.memTotal) break;
      run++; first = p; b ??= band;
    }
    if (run < 2 || !b) continue;
    const v = last[k]!, ratio = v / Math.max(b.mid, k === 'cpu' ? 0.5 : 1);
    const mins = (Date.parse(last.at) - Date.parse(first.at)) / MIN + 5;
    const full = k === 'mem' ? (host.memTotal ? (s.scope === 'server' ? v : host.memUsed ?? v) / host.memTotal : 0) : v / 100;
    out.push({ key: key('high', k), kind: 'high', metric: k, scope: s.scope, name: s.name, since: first.at, value: v, usual: b.mid, ratio,
      severity: full >= 0.9 || (ratio >= 4 && full >= 0.5) ? 'critical' : 'warning', quiet: full < 0.7 && mins < 30,
      reason: `${WHAT[k]}${label(s)} is ${fmtTimes(ratio)} its usual level for this time of day (${show(k, v)}, usually ${show(k, b.mid)}) for ${fmtMins(mins)}.` });
  }

  // 2. a sudden network spike (one 5-minute average is enough: it's already an average)
  if (last.net != null) {
    const b = bandFor(s, 'net', last.at);
    if (b && last.net > b.hi && last.net >= 4 * Math.max(b.mid, 1) && last.net - b.mid >= 200e3) {
      const ratio = last.net / Math.max(b.mid, 1);
      out.push({ key: key('spike', 'net'), kind: 'spike', metric: 'net', scope: s.scope, name: s.name, since: last.at, value: last.net, usual: b.mid, ratio, severity: last.net >= 50e6 ? 'critical' : 'warning', quiet: last.net < 10e6,
        reason: `${WHAT.net}${label(s)} jumped to ${fmtRate(last.net)}, ${fmtTimes(ratio)} the usual for this time of day (${fmtRate(b.mid)}).` });
    }
  }

  // 3. memory climbing steadily, without a restart to reset it: a leak until shown otherwise
  const win = recent.filter((p) => Date.parse(p.at) >= now - 6 * HOUR && p.mem != null);
  if (win.length >= 36 && !win.some((p) => p.restarts > 0)) {
    const fit = linearFit(win.map((p) => ({ at: p.at, v: p.mem! })));
    const hours = (Date.parse(win.at(-1)!.at) - Date.parse(win[0]!.at)) / HOUR;
    const from = fit.intercept, to = fit.intercept + fit.slope * hours, rise = to - from;
    const half = win.slice(0, win.length >> 1).map((p) => p.mem!);
    const tail = win.slice(-6).map((p) => p.mem!);
    if (fit.r2 >= 0.8 && rise >= Math.max(150e6, 0.25 * Math.max(from, 1)) && median(tail) >= Math.max(...half)) {
      const room = host.memTotal ? host.memTotal - (s.scope === 'server' ? win.at(-1)!.mem! : host.memUsed ?? win.at(-1)!.mem!) : undefined;
      const left = room !== undefined && fit.slope > 0 ? room / fit.slope : undefined;
      out.push({ key: key('leak', 'mem'), kind: 'leak', metric: 'mem', scope: s.scope, name: s.name, since: win[0]!.at, value: win.at(-1)!.mem!, usual: from, ratio: to / Math.max(from, 1),
        severity: left !== undefined && left < 6 ? 'critical' : 'warning',
        reason: `Memory${label(s)} has climbed steadily for ${fmtMins(hours * 60)} (from ${fmtBytes(Math.max(0, from))} to ${fmtBytes(to)}) without levelling off: it may be leaking.`,
        ...(left !== undefined && { forecast: `At this rate the server runs out of memory in ${fmtHours(left)}.` }) });
    }
  }

  // 4. restart loops: 3+ restarts in half an hour, or out of memory twice in an hour
  const sum = (mins: number, f: (p: Point) => number) => recent.filter((p) => Date.parse(p.at) > now - mins * MIN).reduce((a, p) => a + f(p), 0);
  const r30 = sum(30, (p) => p.restarts), oom60 = sum(60, (p) => p.oom);
  if (r30 >= 3 || oom60 >= 2) {
    const firstR = recent.find((p) => Date.parse(p.at) > now - 60 * MIN && (p.restarts > 0 || p.oom > 0)) ?? last;
    const what = s.scope === 'server' ? 'Apps on this server' : s.name;
    out.push({ key: key('restarts', 'restarts'), kind: 'restarts', metric: 'restarts', scope: s.scope, name: s.name, since: firstR.at, value: Math.max(r30, oom60),
      severity: r30 >= 6 || oom60 >= 3 ? 'critical' : 'warning',
      reason: r30 >= 3
        ? `${what} restarted ${r30} times in the last 30 minutes${oom60 ? ` (ran out of memory ${oom60 === 1 ? 'once' : `${oom60} times`} in the last hour)` : ''}.`
        : `${what} ran out of memory ${oom60} times in the last hour.` });
  }

  // 5. the disk filling faster than usual (the server only: disk is the server's)
  if (s.scope === 'server' && host.diskTotal) {
    const dw = recent.filter((p) => Date.parse(p.at) >= now - 6 * HOUR && p.disk != null).map((p) => ({ at: p.at, v: p.disk! }));
    if (dw.length >= 12) {
      const perHour = linearFit(dw).slope;
      const days = (s.daily ?? []).filter((p) => p.disk != null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const deltas = days.slice(1).map((p, i) => p.disk! - days[i]!.disk!);
      const usual = deltas.length >= 3 ? Math.max(0, median(deltas)) / 24 : undefined; // bytes an hour
      const used = dw.at(-1)!.v, leftH = perHour > 0 ? (host.diskTotal - used) / perHour : Infinity;
      const faster = usual !== undefined ? perHour >= 3 * Math.max(usual, 1) && perHour * 24 >= 1e9 : perHour * 24 >= 20e9;
      if ((faster || leftH < 48) && perHour > 0) {
        const grew = dw.at(-1)!.v - dw[0]!.v;
        const ratio = usual ? perHour / Math.max(usual, 1) : undefined;
        out.push({ key: key('disk', 'disk'), kind: 'disk', metric: 'disk', scope: s.scope, name: s.name, since: dw[0]!.at, value: perHour * 24, usual: usual !== undefined ? usual * 24 : undefined, ratio,
          severity: leftH < 24 ? 'critical' : 'warning',
          reason: `The disk is filling ${ratio && ratio >= 1.5 ? `${fmtTimes(ratio)} faster than usual` : 'fast'}: +${fmtBytes(Math.max(grew, 0))} in the last ${fmtMins((Date.parse(dw.at(-1)!.at) - Date.parse(dw[0]!.at)) / MIN)}.`,
          forecast: Number.isFinite(leftH) ? `At this rate it's full in ${fmtHours(leftH)}.` : undefined });
      }
    }
  }
  return out;
}

// the long view for findings: when the disk fills at its daily pace (least squares over the daily points)
export function diskForecast(daily: Point[], diskTotal?: number): { perDay: number; days?: number } | undefined {
  const pts = daily.filter((p) => p.disk != null).map((p) => ({ at: p.at, v: p.disk! }));
  if (pts.length < 3 || !diskTotal) return undefined;
  const perDay = linearFit(pts).slope * 24;
  const left = diskTotal - pts.at(-1)!.v;
  return { perDay, ...(perDay > 0 && { days: left / perDay }) };
}
