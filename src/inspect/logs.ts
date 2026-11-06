// What an app's own logs say, made small. A digest folds 12 hours of lines into a page of patterns with counts, so an AI can read
// them for very little. And outside services: "your carrier refused 20 of 20 calls" sits in the logs and nobody reads it.
import type { Detection } from './detectors.ts';

const MASK: [RegExp, string][] = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<time>'], [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'], [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>'], [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}\b/g, '<key>'], [/\b[0-9a-f]{8,}\b/gi, '<hex>'], [/"[^"]{0,200}"/g, '"<s>"'], [/'[^']{0,200}'/g, "'<s>'"], [/\b\d+(\.\d+)?(ms|s|kb|mb|gb)?\b/gi, '<n>'],
];
export const patternOf = (line: string) => MASK.reduce((l, [re, to]) => l.replace(re, to), line.trim()).replace(/(<\w+>)(\s*\1)+/g, '$1').slice(0, 200);
export interface Pattern { pattern: string; n: number; errors: boolean }
export function digestLog(text: string, max = 40): { lines: number; patterns: Pattern[] } {
  const m = new Map<string, number>();
  let lines = 0;
  for (const raw of text.split('\n')) { if (!raw.trim()) continue; lines++; const p = patternOf(raw); m.set(p, (m.get(p) ?? 0) + 1); }
  return { lines, patterns: [...m].sort((a, b) => b[1] - a[1]).slice(0, max).map(([pattern, n]) => ({ pattern, n, errors: /\b(error|exception|fatal|failed|timeout|refused|denied|unauthori[sz]ed|forbidden)\b/i.test(pattern) })) };
}

// (pure) calls to other companies seen in log lines: which host, how they ended. Only what a line states, with a host and a status.
const HOST = /https?:\/\/([a-z0-9][a-z0-9.-]+\.[a-z]{2,})/i, STATUS = /\b(?:status(?:code|_code)?|code|http)\b[^\d\n]{0,8}([1-5]\d\d)\b|\b([45]\d\d)\s+(?:error|forbidden|unauthori[sz]ed|bad gateway|service unavailable|too many)/i, DOWN = /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|socket hang up|timed? ?out)\b/i;
const OWN = /(^|\.)(localhost|supabase\.co|sentry\.io|github\.com|vercel\.app|coolify\.io|docker\.io)$/i;
export interface Outside { host: string; ok: number; failed: number; codes: Record<string, number> }
export function outsideCalls(text: string, self: string[] = []): Outside[] {
  const m = new Map<string, Outside>();
  for (const line of text.split('\n')) {
    const host = HOST.exec(line)?.[1]?.toLowerCase();
    if (!host || OWN.test(host) || self.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    const s = STATUS.exec(line), code = s?.[1] ?? s?.[2], down = DOWN.exec(line)?.[1];
    if (!code && !down) continue;
    const o = m.get(host) ?? { host, ok: 0, failed: 0, codes: {} };
    const bad = down || Number(code) >= 400;
    if (bad) { o.failed++; const k = code ?? down!; o.codes[k] = (o.codes[k] ?? 0) + 1; } else o.ok++;
    m.set(host, o);
  }
  return [...m.values()].sort((a, b) => b.failed - a.failed);
}
// an outside service worth saying something about: most of its calls failing, more than a blip
export function outsideDetections(list: Outside[], app: string, hours: number): Detection[] {
  return list.filter((o) => o.failed >= 5 && o.failed >= 0.8 * (o.ok + o.failed)).map((o) => {
    const total = o.ok + o.failed, top = Object.entries(o.codes).sort((a, b) => b[1] - a[1])[0]?.[0], name = o.host.replace(/^(api|www|app)\./, '').split('.')[0]!;
    return { key: `outside:${o.host}`, detector: 'outside', title: `${name} refuses ${o.failed === total ? 'every call' : 'most calls'}`, plain: `${o.failed} of ${total} calls to ${o.host} failed in the last ${hours} hours${top ? `, mostly with ${top}` : ''}. The fault may be on their side, or your key or plan with them.`, confidence: 'medium', severity: 'medium', who: 'you',
      numbers: { calls: total, failed: o.failed }, hypotheses: [top === '401' || top === '403' ? 'A key has expired, or the plan doesn’t allow this.' : top === '429' ? 'Your app calls them faster than they allow.' : 'Their service is having trouble, or an address changed.'], search: [o.host], evidence: { source: `${app}’s logs`, columns: ['service', 'calls', 'failed', 'most common'], rows: [[o.host, String(total), String(o.failed), top ?? 'unknown']] } };
  });
}

// (pure) when a cron line fires inside the hour, for finding what piles up. An unreadable or per-hour rule gives nothing.
export function fireMinutes(schedule: string): number[] {
  const m = schedule.trim().split(/\s+/)[0] ?? '';
  if (schedule.startsWith('@')) return /hourly|daily|midnight|weekly|monthly|yearly|annually/.test(schedule) ? [0] : [];
  if (m === '*') return Array.from({ length: 60 }, (_, i) => i);
  const every = /^\*\/(\d+)$/.exec(m);
  if (every) { const n = Number(every[1]); return n > 0 ? Array.from({ length: Math.ceil(60 / n) }, (_, i) => i * n) : []; }
  const v = m.split(',').flatMap((x) => { const r = /^(\d+)-(\d+)$/.exec(x); return r ? Array.from({ length: Number(r[2]) - Number(r[1]) + 1 }, (_, i) => i + Number(r[1])) : /^\d+$/.test(x) ? [Number(x)] : []; });
  return v.filter((x) => x >= 0 && x < 60);
}
export interface Job { name: string; schedule: string; when?: string; where: string; last?: string; failedRuns?: number; enabled?: boolean }
export function overlaps(jobs: Job[]) {
  const by = new Map<number, string[]>();
  for (const j of jobs) { if (j.enabled === false) continue; const f = fireMinutes(j.schedule); if (f.length > 12) continue; for (const m of f) by.set(m, [...(by.get(m) ?? []), j.name]); }
  return [...by].filter(([, n]) => n.length >= 2).sort((a, b) => b[1].length - a[1].length).map(([minute, names]) => ({ minute, names: [...new Set(names)] }));
}

// (pure) where a line is heading: a straight fit over the points, and when it reaches a limit. Noise says nothing.
export function forecast(points: { at: number; v: number }[], limit: number): { days: number; perDay: number } | undefined {
  if (points.length < 24) return undefined;
  const t0 = points[0]!.at, xs = points.map((p) => (p.at - t0) / 86400_000), ys = points.map((p) => p.v), n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0), sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  if (!sxx || !syy) return undefined;
  const slope = sxy / sxx, r2 = (sxy * sxy) / (sxx * syy), last = ys.at(-1)!;
  if (slope <= 0 || r2 < 0.7 || last >= limit) return undefined;
  if (xs.at(-1)! < 3) return undefined; // under three days isn't a trend
  const days = (limit - last) / slope;
  return days <= 60 ? { days: Math.round(days), perDay: slope } : undefined;
}
