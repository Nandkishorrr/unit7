// Usage over time: one metric of one project (or the whole server) as a line, the band that's normal for each
// hour of the week behind it, and what happened when (deploys, restarts, out-of-memory kills) as dots along the
// bottom. Plain SVG sized to its box, a crosshair and tooltip on hover or arrow keys, a table for the numbers.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Cpu, MemoryStick, Network } from 'lucide-react';
import { runTool } from '../../lib/api';
import { ChipSelect, Select, Skeleton, cx } from '../../ui';
import { tidy } from '../../lib/words';
import { METRIC, clock, when, type Mark, type Metric, type Range, type TBand, type Trends } from './shape';

const MARK: Record<Mark['kind'], { color: string; word: string }> = {
  deploy: { color: 'var(--blue)', word: 'Deploy' }, restart: { color: '#f59e0b', word: 'Restart' }, oom: { color: 'var(--bad)', word: 'Out of memory' },
  alert: { color: 'var(--bad)', word: 'Unusual' }, change: { color: 'var(--faint)', word: 'Change' },
};

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
// 0, then two clean steps above, covering the line and the band
function ticks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 2, pow = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  return [0, step, step * 2];
}

export interface ChartProps {
  points: { at: string; v: number | null }[]; band?: (TBand | null)[]; marks?: Mark[]; fmt: (n?: number | null) => string; range: Range;
  height?: number; alertSince?: string; label: string; blind?: { from: string; to: string }[];
  // bars: one bar per time slot of `step` ms (points[i].at is where its slot starts), with an optional part of each bar
  // drawn in its own colour (server errors inside the visits) and words for the tooltip
  bars?: { step: number; part?: number[]; partLabel?: string; partColor?: string; valueLabel?: string; bandLabel?: string };
}
const BAR_PAD = 0.32; // the gap between bars, as a share of a slot
export function TrendChart({ points, band = [], marks = [], fmt, range, height = 180, alertSince, label, bars, blind = [] }: ChartProps) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const PAD = { l: 52, r: 12, t: 10, b: 34 };
  const W = Math.max(width, 240), plotW = W - PAD.l - PAD.r, plotH = height - PAD.t - PAD.b;
  const t0 = points.length ? Date.parse(points[0]!.at) : 0;
  // bars fill their slot, so the last one ends a slot after it starts
  const t1 = points.length ? Date.parse(points.at(-1)!.at) + (bars?.step ?? 0) : 1;
  const x = (iso: string) => PAD.l + (t1 > t0 ? ((Date.parse(iso) - t0) / (t1 - t0)) * plotW : plotW / 2);
  const slot = bars && points.length ? plotW / points.length : 0;
  const cx_ = (i: number) => (bars ? PAD.l + (i + 0.5) * slot : x(points[i]!.at)); // where a point sits: the line's vertex or the bar's middle
  const top = Math.max(0, ...points.map((p) => p.v ?? 0), ...band.map((b) => b?.hi ?? 0));
  const yt = ticks(top * 1.08);
  const ymax = yt.at(-1)!;
  const y = (v: number) => PAD.t + plotH - (v / ymax) * plotH;
  // paths broken where there's no reading (a gap stays a gap)
  const { line, area, bandMid } = useMemo(() => {
    let line = '', area = '', bandMid = '';
    let seg: { x: number; lo: number; hi: number; mid?: number }[] = [];
    const flush = () => {
      if (seg.length > 1) {
        area += `M${seg.map((s) => `${s.x},${s.hi}`).join('L')}L${[...seg].reverse().map((s) => `${s.x},${s.lo}`).join('L')}Z`;
        if (bars) bandMid += `M${seg.map((s) => `${s.x},${s.mid}`).join('L')}`;
      }
      seg = [];
    };
    let pen = false;
    points.forEach((p, i) => {
      if (p.v == null) pen = false; else { line += `${pen ? 'L' : 'M'}${cx_(i).toFixed(1)},${y(p.v).toFixed(1)}`; pen = true; }
      const b = band[i];
      if (b?.lo != null && b.hi != null) seg.push({ x: +cx_(i).toFixed(1), lo: +y(b.lo).toFixed(1), hi: +y(b.hi).toFixed(1), mid: +y(b.mid ?? (b.lo + b.hi) / 2).toFixed(1) }); else flush();
    });
    flush();
    return { line, area, bandMid };
  }, [points, band, W, height, ymax, !!bars]);
  const step = bars?.step ?? (points.length > 1 ? (Date.parse(points.at(-1)!.at) - t0) / (points.length - 1) : 3600_000);
  const near = (i: number) => marks.filter((m) => (bars ? Date.parse(m.at) >= Date.parse(points[i]!.at) && Date.parse(m.at) < Date.parse(points[i]!.at) + step : Math.abs(Date.parse(m.at) - Date.parse(points[i]!.at)) <= step / 2));
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (bars) { setHover(Math.max(0, Math.min(points.length - 1, Math.floor((px - PAD.l) / slot)))); return; }
    const t = t0 + ((px - PAD.l) / plotW) * (t1 - t0);
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(Date.parse(p.at) - t) < Math.abs(Date.parse(points[best]!.at) - t)) best = i; });
    setHover(best);
  };
  const keys = (e: KeyboardEvent) => {
    if (!points.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setHover((h) => Math.max(0, Math.min(points.length - 1, (h ?? points.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)))); }
    if (e.key === 'Escape') setHover(null);
  };
  const xTicks = points.length > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (points.length - 1))) : [];
  const h = hover != null ? points[hover] : undefined;
  const hb = hover != null ? band[hover] : undefined;
  const hx = hover != null ? cx_(hover) : 0;
  const tipLeft = h ? Math.min(Math.max(hx - 90, 0), W - 180) : 0;
  const bw = Math.max(1.5, slot * (1 - BAR_PAD));
  const day = step >= 86400_000;
  return (
    <div ref={box} className="relative w-full min-w-0 select-none">
      {width > 0 && (
        <svg width={W} height={height} role="img" aria-label={label} tabIndex={0} onKeyDown={keys} onPointerMove={pick} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
          className="block touch-pan-y rounded-[12px] outline-none focus-visible:ring-2 focus-visible:ring-blue/50">
          {yt.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
              <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="fill-muted text-[10.5px] tabular-nums">{fmt(v)}</text>
            </g>
          ))}
          {blind.filter((g) => Date.parse(g.to) > t0 && Date.parse(g.from) < t1).map((g) => { const a = Math.max(PAD.l, x(g.from)), b = Math.min(W - PAD.r, x(g.to)); return <rect key={g.from} x={a} y={PAD.t} width={Math.max(1, b - a)} height={plotH} fill="var(--raised)" opacity={0.8}><title>Unit7 wasn’t watching here</title></rect>; })}
          {alertSince && points.length > 0 && Date.parse(alertSince) <= t1 && (
            <rect x={Math.max(PAD.l, x(alertSince))} y={PAD.t} width={Math.max(4, W - PAD.r - Math.max(PAD.l, x(alertSince)))} height={plotH} fill="var(--bad)" opacity={0.07} rx={6} />
          )}
          {bars && h && <rect x={PAD.l + hover! * slot} y={PAD.t} width={slot} height={plotH} rx={4} fill="var(--ink)" opacity={0.05} />}
          {area && <path d={area} fill={bars ? 'var(--ink)' : 'var(--blue)'} opacity={bars ? 0.07 : 0.1} />}
          {bars ? points.map((p, i) => {
            if (p.v == null) return null;
            const bx = cx_(i) - bw / 2, hgt = Math.max(p.v > 0 ? 1.5 : 0, (p.v / ymax) * plotH);
            const part = Math.min(p.v, bars.part?.[i] ?? 0), ph = part > 0 ? Math.min(hgt, Math.max(2, (part / ymax) * plotH)) : 0;
            return (
              <g key={p.at} opacity={hover != null && hover !== i ? 0.55 : 1}>
                <rect x={bx} y={PAD.t + plotH - hgt} width={bw} height={hgt} rx={Math.min(3, bw / 2)} fill="var(--blue)" />
                {ph > 0 && <rect x={bx} y={PAD.t + plotH - ph} width={bw} height={ph} rx={Math.min(2, bw / 2)} fill={bars.partColor ?? 'var(--bad)'} />}
              </g>
            );
          }) : line && <path d={line} fill="none" stroke="var(--blue)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {bandMid && <path d={bandMid} fill="none" stroke="var(--ink)" strokeOpacity={0.35} strokeWidth={1.25} strokeDasharray="3 4" />}
          {xTicks.map((i, k) => <text key={k} x={cx_(i)} y={height - 6} textAnchor={k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'} className="fill-muted text-[10.5px]">{clock(points[i]!.at, range)}</text>)}
          {marks.filter((m) => Date.parse(m.at) >= t0 - step && Date.parse(m.at) <= t1 + step).map((m, i) => (
            <circle key={`${m.at}${i}`} cx={Math.min(Math.max(x(m.at), PAD.l), W - PAD.r)} cy={PAD.t + plotH + 8} r={4} fill={MARK[m.kind].color} stroke="var(--surface)" strokeWidth={2}><title>{`${MARK[m.kind].word}: ${m.label}`}</title></circle>
          ))}
          {h && !bars && (
            <g pointerEvents="none">
              <line x1={hx} x2={hx} y1={PAD.t} y2={PAD.t + plotH} stroke="var(--ink)" strokeOpacity={0.35} strokeWidth={1} />
              {h.v != null && <circle cx={hx} cy={y(h.v)} r={4.5} fill="var(--blue)" stroke="var(--surface)" strokeWidth={2} />}
            </g>
          )}
        </svg>
      )}
      {!width && <div style={{ height }} />}
      {h && (
        <div role="status" className="pointer-events-none absolute top-1 z-10 w-[180px] rounded-[14px] border border-line bg-surface px-3 py-2 text-[12px] shadow-lg animate-pop" style={{ left: tipLeft }}>
          <p className="text-muted">{day ? new Date(h.at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : when(h.at)}</p>
          <p className="mt-0.5 text-[14px] font-semibold tabular-nums text-ink">{h.v == null && bars ? 'No check' : fmt(h.v)}{bars?.valueLabel && h.v != null && <span className="text-[12px] font-normal text-muted"> {bars.valueLabel}</span>}</p>
          {bars?.part && h.v != null && <p className="flex items-center gap-1.5 text-ink-2"><span className="size-2 rounded-[2px]" style={{ background: bars.partColor ?? 'var(--bad)' }} />{fmt(bars.part[hover!] ?? 0)} {bars.partLabel}</p>}
          {hb?.lo != null && <p className="text-muted">{bars?.bandLabel ?? 'Usual'} {fmt(hb.lo)}–{fmt(hb.hi)}</p>}
          {near(hover!).map((m, i) => <p key={i} className="mt-1 flex items-start gap-1.5 text-ink-2"><span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: MARK[m.kind].color }} />{tidy(m.label)}</p>)}
        </div>
      )}
    </div>
  );
}

// --- one server's trends: metric, range and project pickers around the chart ---------------------------------
const ICON = { cpu: Cpu, mem: MemoryStick, net: Network } as const;
export function TrendsView({ data, range, onRange, compact, initialScope }: { data: Trends; range?: Range; onRange?: (r: Range) => void; compact?: boolean; initialScope?: string }) {
  // open on what's unusual: its project, and its metric
  const first = data.anomalies.find((a) => !a.cleared && (!initialScope || a.scope === initialScope));
  const [metric, setMetric] = useState<Metric>(first?.metric === 'mem' || first?.metric === 'restarts' ? 'mem' : first?.metric === 'net' ? 'net' : 'cpu');
  const [scope, setScope] = useState(initialScope ?? (first?.scope && data.series.some((s) => s.scope === first.scope) ? first.scope : 'server'));
  const s = data.series.find((x) => x.scope === scope) ?? data.series[0];
  if (!s) return <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">{tidy(data.next ?? 'No usage history yet.')}</p>;
  const m = METRIC[metric];
  const pts = s.points.map((p) => ({ at: p.at, v: p[metric] }));
  const last = [...pts].reverse().find((p) => p.v != null);
  const lb = s.band[metric]?.[pts.lastIndexOf(last!)];
  const open = data.anomalies.find((a) => !a.cleared && (a.scope ?? 'server') === s.scope && (a.metric === metric || (a.metric === 'restarts' && metric === 'mem')));
  const marks = data.events.filter((e) => !e.scope || e.scope === s.scope || s.scope === 'server');
  const over = last?.v != null && lb?.hi != null && last.v > lb.hi;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="What to show" className="flex gap-1 rounded-full bg-raised p-1">
          {(['cpu', 'mem', 'net'] as Metric[]).map((k) => { const I = ICON[k]; return (
            <button key={k} role="tab" type="button" aria-selected={metric === k} onClick={() => setMetric(k)}
              className={cx('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition', metric === k ? 'bg-ink text-bg' : 'text-ink-2 hover:text-ink')}>
              <I size={13} />{METRIC[k].short}
            </button>
          ); })}
        </div>
        {data.series.length > 1 && <Select value={s.scope} onChange={setScope} options={data.series.map((x) => ({ value: x.scope, label: x.scope === 'server' ? 'Whole server' : x.name }))} className="h-9 max-w-[220px]" />}
        {onRange && <span className="ml-auto"><ChipSelect label="Time range" value={range ?? data.range} onChange={(v) => onRange(v as Range)} options={[{ value: '6h', label: '6h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} /></span>}
      </div>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[24px] font-semibold tracking-[-0.03em] text-ink">{m.fmt(last?.v)}</span>
        <span className={cx('text-[12.5px]', over ? 'font-medium text-bad' : 'text-muted')}>
          {lb?.mid != null ? `${over ? 'above' : 'usually'} ${m.fmt(lb.lo)}–${m.fmt(lb.hi)} at this time` : data.learning ? 'still learning what’s normal here' : 'now'}
        </span>
      </p>
      <div className="mt-2"><TrendChart points={pts} band={s.band[metric]} marks={marks} fmt={m.fmt} range={data.range} height={compact ? 150 : 190} blind={data.blind} alertSince={open?.started ?? open?.since}
        label={`${m.label} of ${s.scope === 'server' ? data.serverName : s.name} over the last ${data.range}: now ${m.fmt(last?.v)}${lb?.mid != null ? `, usually ${m.fmt(lb.mid)} at this time` : ''}.`} /></div>
      <p className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-blue" />{s.scope === 'server' ? 'Whole server' : s.name}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px] bg-blue/15" />Normal for this time</span>
        {!!data.blind?.length && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px] bg-raised" />Unit7 wasn’t watching</span>}
        {(['deploy', 'restart', 'oom'] as const).filter((k) => marks.some((e) => e.kind === k)).map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: MARK[k].color }} />{MARK[k].word}</span>)}
      </p>
      {!compact && (
        <details className="group mt-2 text-[12px]">
          <summary className="cursor-pointer list-none text-muted hover:text-ink">Show the numbers</summary>
          <table className="mt-2 w-full text-left tabular-nums">
            <thead><tr className="text-muted"><th className="py-1 font-medium">Time</th><th className="font-medium">{m.label}</th><th className="font-medium">Usual</th></tr></thead>
            <tbody>{pts.slice(-12).reverse().map((p, i) => { const b = s.band[metric]?.[pts.length - 1 - i]; return <tr key={p.at} className="border-t border-line"><td className="py-1 text-ink-2">{when(p.at)}</td><td>{m.fmt(p.v)}</td><td className="text-muted">{b?.lo != null ? `${m.fmt(b.lo)}–${m.fmt(b.hi)}` : '–'}</td></tr>; })}</tbody>
          </table>
        </details>
      )}
      {data.note && <p className="mt-2 text-[12px] text-muted">{tidy(data.note)}</p>}
    </div>
  );
}

// self-loading, for the server page
export function ServerTrends({ serverId, scope }: { serverId: string; scope?: string }) {
  const [range, setRange] = useState<Range>('24h');
  const [data, setData] = useState<Trends | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    runTool('server.trends', { serverId, range }).then((r) => { if (!alive) return; if (r.status === 'ok') { setData(r.output); setErr(null); } else setErr(r.status === 'error' ? r.error.message : 'Not allowed'); }, (e) => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [serverId, range]);
  if (err) return <p className="text-[13px] text-bad">{tidy(err)}</p>;
  if (!data) return <Skeleton className="h-[250px]" />;
  return <TrendsView data={data} range={range} onRange={setRange} initialScope={scope} />;
}
