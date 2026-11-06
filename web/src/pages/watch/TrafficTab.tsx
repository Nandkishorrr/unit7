// The server page's Traffic tab: visits per hour as bars with server errors inside them, the normal band for each hour
// and deploy marks (24h, 7d, 30d); four big numbers next to it; the busiest pages and who's calling below. When no access
// log can be read, a calm empty state says why and offers the fix. Also the small sparkline the Overview tile draws.
import { useEffect, useState, type ReactNode } from 'react';
import { BarChart3, Bot, Globe, RefreshCw, ScanSearch, Users } from 'lucide-react';
import { runTool } from '../../lib/api';
import { Button, Card, CardHeader, Empty, Skeleton, cx, timeAgo } from '../../ui';
import { tidy } from '../../lib/words';
import { TrendChart } from './TrendChart';
import { FixAction } from './QuickFix';
import { count, pct, type TrafficOut, type TrafficRange, type TrafficSeriesOut } from './shape';

const load = async <T,>(tool: string, input: unknown): Promise<{ data?: T; err?: string }> => {
  try { const r = await runTool(tool, input); return r.status === 'ok' ? { data: r.output as T } : { err: r.status === 'error' ? r.error.message : 'Not allowed' }; }
  catch (e) { return { err: (e as Error).message }; }
};
export function useTrafficSeries(serverId: string, range: TrafficRange, nonce = 0) {
  const [s, setS] = useState<{ data?: TrafficSeriesOut; err?: string; range?: TrafficRange }>({});
  useEffect(() => { let on = true; void load<TrafficSeriesOut>('server.traffic_series', { serverId, range }).then((r) => on && setS({ ...r, range })); return () => { on = false; }; }, [serverId, range, nonce]);
  return s.range === range ? s : { ...s, data: s.data && s.data.range === range ? s.data : undefined };
}
// the last traffic check: who's there right now, which logs it could read, and the fix when it couldn't
export function useLastTraffic(serverId: string) {
  const [s, setS] = useState<{ data?: TrafficOut; err?: string; busy?: boolean }>({});
  const go = (fresh = false) => { setS((x) => ({ ...x, busy: true })); return load<TrafficOut>('server.traffic', { serverId, fresh }).then((r) => setS((x) => ({ data: r.data ?? x.data, err: r.err, busy: false }))); };
  useEffect(() => { setS({}); void go(); }, [serverId]);
  return { ...s, refresh: () => go(true) };
}
// nothing could be read: say which log and why, with the finding's fix
export const noLog = (t?: TrafficOut) => !!t && !t.summary.sources?.some((x) => x.lines > 0) && !t.summary.requests;
export const noLogWhy = (t: TrafficOut) => t.summary.sources?.filter((x) => x.note).map((x) => `${x.name}: ${tidy(x.note!)}.`).join(' ') || 'Unit7 found no web server log it could read on this server.';
export const noLogFinding = (t?: TrafficOut) => t?.findings.find((f) => f.id.includes(':no-log:'));

// --- the Overview tile's sparkline: the last 24 hours, drawn in once -------------------------------------------------
export function TrafficSpark({ series, draw, className }: { series: TrafficSeriesOut; draw?: boolean; className?: string }) {
  const pts = series.points;
  const firstData = pts.findIndex((p) => p.visits != null);
  if (firstData < 0) return null;
  const vs = pts.map((p) => p.visits ?? 0);
  const max = Math.max(1, ...vs, ...pts.map((p) => p.band?.hi ?? 0));
  const W = 240, H = 56, X = (i: number) => (i / (pts.length - 1)) * W, Y = (v: number) => H - 3 - (v / max) * (H - 8);
  const line = vs.map((v, i) => (i < firstData ? '' : `${i === firstData ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`)).join('');
  const band = pts.map((p, i) => [i, p.band] as const).filter(([, b]) => b);
  const bandPath = band.length > 1 ? `M${band.map(([i, b]) => `${X(i).toFixed(1)},${Y(b!.hi).toFixed(1)}`).join('L')}L${[...band].reverse().map(([i, b]) => `${X(i).toFixed(1)},${Y(b!.lo).toFixed(1)}`).join('L')}Z` : '';
  const last = vs.length - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cx('block h-14 w-full overflow-visible', className)} aria-hidden>
      {bandPath && <path d={bandPath} fill="var(--ink)" fillOpacity={0.07} style={draw ? { animation: 'fade 0.6s ease-out 0.5s both' } : undefined} />}
      <path d={`${line}L${X(last)},${H}L${X(firstData)},${H}Z`} fill="var(--blue)" fillOpacity={0.12} style={draw ? { animation: 'fade 0.6s ease-out 0.6s both' } : undefined} />
      <path d={line} fill="none" stroke="var(--blue)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={100} strokeDasharray="100 100"
        style={draw ? { animation: 'gauge-in 1.1s var(--ease-out-soft) 0.15s both' } : undefined} />
    </svg>
  );
}

// --- the tab ----------------------------------------------------------------------------------------------------
const RANGES: TrafficRange[] = ['24h', '7d', '30d'];
const share = (a: number, b: number) => (b ? (100 * a) / b : 0);
function Big({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' | 'warn' }) {
  return (
    <div className="min-w-0 rounded-[22px] border border-line bg-surface px-4 py-3.5 shadow-soft">
      <p className="truncate text-[12.5px] text-muted">{label}</p>
      <p className={cx('tabular mt-0.5 text-[28px] font-semibold leading-tight tracking-[-0.035em]', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-ink')}>{value}</p>
      {sub && <p className="truncate text-[12px] text-muted" title={sub}>{sub}</p>}
    </div>
  );
}
function Bars({ rows, empty }: { rows: { key: string; label: ReactNode; n: number; note?: ReactNode; color?: string; title?: string }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) return <p className="text-[13px] text-muted">{empty}</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} className="min-w-0" title={r.title}>
          <p className="flex items-baseline gap-2 text-[12.5px]"><span className="min-w-0 flex-1 truncate text-ink-2">{r.label}</span>{r.note}<span className="tabular shrink-0 font-medium text-ink">{count(r.n)}</span></p>
          <span aria-hidden className="mt-1 block h-1.5 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${Math.max(2, (100 * r.n) / max)}%`, background: r.color ?? 'var(--blue)' }} /></span>
        </li>
      ))}
    </ul>
  );
}

export function ServerTrafficTab({ serverId }: { serverId: string }) {
  const [range, setRange] = useState<TrafficRange>('24h');
  const [nonce, setNonce] = useState(0);
  const last = useLastTraffic(serverId);
  const s = useTrafficSeries(serverId, range, nonce);
  const [steps, setSteps] = useState(false);
  const d = s.data;
  if (!d && !s.err) return <div className="grid gap-4 lg:grid-cols-12" aria-busy="true" aria-label="Loading traffic"><Skeleton className="h-[340px] rounded-[24px] lg:col-span-8" /><Skeleton className="h-[340px] rounded-[24px] lg:col-span-4" /></div>;
  if (!d) return <Empty icon={<Globe size={24} />} title="Traffic didn’t load" body={tidy(s.err ?? '')} action={<Button variant="soft" icon={<RefreshCw size={14} />} onClick={() => setNonce((n) => n + 1)}>Try again</Button>} />;
  const t = last.data;
  // nothing counted in this range, and the last check couldn't read any access log (or there's no check yet)
  if (!d.totals.visits && (noLog(t) || !t)) {
    const f = noLogFinding(t);
    return (
      <Card className="mx-auto max-w-2xl p-6 text-center md:p-8">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-raised text-muted"><BarChart3 size={24} /></span>
        <h2 className="mt-4 text-[18px] font-semibold tracking-[-0.02em]">Unit7 can’t count requests here yet</h2>
        <p className="mx-auto mt-1.5 max-w-md text-[13.5px] text-ink-2">{t ? noLogWhy(t) : tidy(last.err ?? 'The first traffic check hasn’t run yet. It runs every 30 minutes while Unit7 runs.')}</p>
        {f && <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">{tidy(f.detail)}</p>}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {f?.fix && <FixAction fix={f.fix} strong onDetails={() => setSteps((v) => !v)} onDone={() => void last.refresh().then(() => setNonce((n) => n + 1))} />}
          <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} loading={last.busy} onClick={() => void last.refresh().then(() => setNonce((n) => n + 1))}>Check again</Button>
        </div>
        {steps && f?.fix && 'manual' in f.fix && <ol className="mx-auto mt-4 max-w-md list-decimal space-y-1.5 rounded-[18px] bg-raised py-3 pl-9 pr-4 text-left text-[13px] text-ink-2 animate-pop">{f.fix.manual.map((m, i) => <li key={i}>{tidy(m)}</li>)}</ol>}
      </Card>
    );
  }
  const vs = d.usual ? (d.totals.visits - d.usual) / Math.max(1, d.usual) : undefined;
  const errRate = share(d.totals.errors, d.totals.visits), anonRate = share(d.totals.anon, d.totals.visits);
  const word = range === '24h' ? 'last 24 hours' : range === '7d' ? 'last 7 days' : 'last 30 days';
  const c = d.callers, all_ = c.people + c.bots + c.scanners;
  const read = t?.summary.sources?.filter((x) => x.lines > 0).map((x) => x.name) ?? [];
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="min-w-0 p-5 md:p-6 lg:col-span-8">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-[16.5px] font-semibold tracking-[-0.015em]">Requests</h2>
              <p className="text-[12.5px] text-muted">Per {d.step === '1h' ? 'hour' : 'day'}, {word}</p>
            </div>
            <div role="tablist" aria-label="Time range" className="flex gap-1 rounded-full bg-raised p-1">
              {RANGES.map((r) => (
                <button key={r} role="tab" type="button" aria-selected={range === r} onClick={() => setRange(r)}
                  className={cx('inline-flex h-8 items-center rounded-full px-3.5 text-[12.5px] font-medium transition', range === r ? 'bg-ink text-bg' : 'text-ink-2 hover:text-ink')}>{r}</button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <TrendChart points={d.points.map((p) => ({ at: p.at, v: p.visits }))} band={d.points.map((p) => p.band)} marks={d.deploys} fmt={count} range={range} height={250}
              bars={{ step: d.step === '1h' ? 3600_000 : 86400_000, part: d.points.map((p) => p.errors), partLabel: 'server errors', valueLabel: 'requests', bandLabel: 'Usual' }}
              label={`Requests per ${d.step === '1h' ? 'hour' : 'day'} on ${d.serverName} over the ${word}: ${count(d.totals.visits)} in all, ${count(d.totals.errors)} with a server error.`} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] bg-blue" />Requests</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] bg-bad" />Server errors</span>
            {d.points.some((p) => p.band) && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px] bg-ink/10" />Normal for this hour</span>}
            {d.deploys.length > 0 && <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-blue ring-2 ring-surface" />Deploy</span>}
          </p>
        </Card>
        <div className="grid grid-cols-2 gap-3 self-start lg:col-span-4">
          <Big label="Visits" value={count(d.totals.visits)} sub={vs === undefined ? word : `${vs >= 0 ? '+' : '−'}${pct(Math.abs(vs * 100))} vs usual`} tone={vs !== undefined && vs >= 2 ? 'warn' : undefined} />
          <Big label="Unique visitors" value={t ? count(t.summary.ips) : '–'} sub={t ? `last ${t.minutes} min${t.usual.ips !== undefined ? ` · usually ${count(t.usual.ips)}` : ''}` : undefined} />
          <Big label="Error rate" value={pct(errRate)} sub={`${count(d.totals.errors)} server error${d.totals.errors === 1 ? '' : 's'}`} tone={errRate >= 5 ? 'bad' : errRate >= 2 ? 'warn' : undefined} />
          <Big label="Without sign-in" value={pct(anonRate)} sub={`${count(d.totals.anon)} call${d.totals.anon === 1 ? '' : 's'}`} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="min-w-0 p-5 md:p-6">
          <CardHeader icon={<Globe size={18} />} title="Top pages" sub={word.charAt(0).toUpperCase() + word.slice(1)} />
          <div className="mt-4"><Bars empty="No visits yet." rows={d.topPaths.slice(0, 5).map((p) => ({ key: p.path, n: p.n, label: <span className="font-mono text-[12px]">{p.path}</span>, title: p.path,
            note: p.errors > 0 ? <span className="tabular shrink-0 text-[11.5px] text-bad">{count(p.errors)} errors</span> : undefined }))} /></div>
        </Card>
        <Card className="min-w-0 p-5 md:p-6">
          <CardHeader icon={<Users size={18} />} title="Who’s calling" sub={d.agents.length ? `Mostly ${d.agents.slice(0, 3).map((a) => a.agent).join(', ')}` : word} />
          <div className="mt-4"><Bars empty="No visits yet." rows={[
            { key: 'people', n: c.people, label: <span className="inline-flex items-center gap-1.5"><Users size={13} className="text-muted" />People<span className="text-faint">· {pct(share(c.people, all_))}</span></span> },
            { key: 'bots', n: c.bots, color: 'var(--faint)', label: <span className="inline-flex items-center gap-1.5"><Bot size={13} className="text-muted" />Bots and scripts<span className="text-faint">· {pct(share(c.bots, all_))}</span></span>, title: d.agents.filter((a) => a.bot).map((a) => a.agent).join(', ') },
            { key: 'scanners', n: c.scanners, color: '#f59e0b', label: <span className="inline-flex items-center gap-1.5"><ScanSearch size={13} className="text-muted" />Scanners probing for weak spots<span className="text-faint">· {pct(share(c.scanners, all_))}</span></span> },
          ]} /></div>
        </Card>
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12px] text-muted">
        <span>{d.lastCheck ? `Last check ${timeAgo(d.lastCheck)}` : 'No check yet'}{read.length ? ` · from ${read.join(' and ')}` : ''}{t?.every ? ` · every ${t.every} minutes` : ''}{t?.stale ? ' · the server didn’t answer just now' : ''}</span>
        <Button size="sm" variant="ghost" loading={last.busy} icon={<RefreshCw size={13} />} onClick={() => void last.refresh().then(() => setNonce((n) => n + 1))}>Check now</Button>
      </p>
    </div>
  );
}
