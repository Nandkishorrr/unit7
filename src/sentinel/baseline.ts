// "Normal for this time": a band per metric from its own history, robust to the odd spike. The middle is the
// median of past values at the same hour of the week (falling back to the same hour of any day, then to all
// of them while history is short); the width is the median absolute deviation, never thinner than a floor,
// and never below the usual peak. Plain statistics anyone can check by hand.

export interface Sample { at: string | number; v: number | null | undefined; max?: number | null }
export interface Band { mid: number; lo: number; hi: number; n: number; basis: 'week' | 'day' | 'all' }

const ms = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t));
export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
// scaled so it estimates a standard deviation for normal data
export const mad = (xs: number[], m = median(xs)) => 1.4826 * median(xs.map((x) => Math.abs(x - m)));

// UTC, so a server's band doesn't move with the viewer's clock (the pattern is the server's visitors')
export const hourOfWeek = (t: string | number) => { const d = new Date(ms(t)); return d.getUTCDay() * 24 + d.getUTCHours(); };
export const hourOfDay = (t: string | number) => new Date(ms(t)).getUTCHours();

// floor: the narrowest half-width that still counts as a real band (so a flat line doesn't flag every wiggle)
export function bandOf(history: Sample[], at: string | number, floor: (mid: number) => number, k = 3): Band | undefined {
  const ok = history.filter((h) => typeof h.v === 'number' && Number.isFinite(h.v));
  const how = hourOfWeek(at), hod = hourOfDay(at);
  const week = ok.filter((h) => hourOfWeek(h.at) === how), day = ok.filter((h) => hourOfDay(h.at) === hod);
  const [pick, basis] = week.length >= 4 ? [week, 'week' as const] : day.length >= 4 ? [day, 'day' as const] : ok.length >= 12 ? [ok, 'all' as const] : [[], 'all' as const];
  if (!pick.length) return undefined;
  const vals = pick.map((h) => h.v as number), mid = median(vals);
  const half = Math.max(k * mad(vals, mid), floor(mid));
  const peaks = pick.map((h) => h.max).filter((x): x is number => typeof x === 'number');
  return { mid, lo: Math.max(0, mid - half), hi: Math.max(mid + half, peaks.length ? median(peaks) : 0), n: pick.length, basis };
}

// least squares over (hours, value): slope per hour and how well a straight line explains it (r²)
export function linearFit(pts: { at: string | number; v: number }[]): { slope: number; intercept: number; r2: number; t0: number } {
  const t0 = pts.length ? ms(pts[0]!.at) : 0;
  const xs = pts.map((p) => (ms(p.at) - t0) / 3600_000), ys = pts.map((p) => p.v);
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0, t0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0, t0 };
}
