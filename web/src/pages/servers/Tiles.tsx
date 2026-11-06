// The server page at a glance: three rings in the header (CPU, memory, disk, each with its number; the details on hover) and the
// Overview's four tiles (Apps, Traffic, Attention, Room). Each tile is one big number, a line of words and one small
// picture; it opens its tab or its pop-up. On the first look the numbers count up and the sparkline draws itself in.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Cpu, Gauge as GaugeIcon, Globe, HardDrive, Hourglass, LayoutGrid, Lightbulb, Minus, PackagePlus, Pencil, TrendingDown, TrendingUp } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { A, Button, CountUp, HoverCard, Input, Skeleton, cx, timeAgo } from '../../ui';
import { runTool } from '../../lib/api';
import { tidy } from '../../lib/words';
import { SEV } from '../security/SecurityCheck';
import { TrafficSpark, useTrafficSeries } from '../watch';
import { count, pct, type Trends } from '../watch/shape';
import { OWNER_NAME, colorSlots, fullIn, healthTone, hoursAgo, loadOf, money, ownerLogo, ringUsual, roomLeft, size, storageBar, type Card, type Load, type RingTrend, vsUsual } from './shape';
import { Legend, StorageBar, type ServerXray } from './Xray';
import { ItemAction, countsLine, type Item, type ServerWatch } from './Attention';

// --- the header's rings -----------------------------------------------------------------------------------------------
// Each ring holds its percentage; its colour moves from calm blue to amber (70%) to red (90%). It fills up once when it
// first shows (reduced motion: drawn at once) and glides when a fresh reading comes in. Hover or focus shows the exact
// numbers and how that compares with the usual for this time, from the watch's baselines (asked for once, on the first
// hover over any ring, so a page at rest makes no extra call).
const ringColor = (v: number | null) => (v == null ? 'var(--line-strong)' : v >= 90 ? 'var(--bad)' : v >= 70 ? '#f59e0b' : 'var(--blue)');
const RING: Record<Load, { from: string; to: string; num: string; word: string }> = {
  none: { from: 'var(--line-strong)', to: 'var(--line-strong)', num: 'text-muted', word: 'Not measured yet' },
  calm: { from: 'var(--blue)', to: 'var(--ai-4)', num: 'text-ink', word: 'Plenty of room' },
  // the numbers a shade darker than the arc in light mode, so they keep AA contrast on the card's tinted corner
  warm: { from: '#f59e0b', to: '#fbbf24', num: 'text-[#9a3f06] dark:text-warn', word: 'Getting busy' },
  hot: { from: 'var(--bad-solid)', to: '#fb7185', num: 'text-[#b91c1c] dark:text-bad', word: 'Close to the limit' },
};
const TREND_ICON = { up: TrendingUp, down: TrendingDown, flat: Minus, learning: Hourglass } as const;
type Trend3 = ReturnType<typeof ringUsual>;
const trendCache = new Map<string, { at: number; p: Promise<Trend3> }>();
function loadTrends(serverId: string, memTotal?: number): Promise<Trend3> {
  const hit = trendCache.get(serverId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p;
  const p = runTool('server.trends', { serverId, range: '24h', scope: 'server' })
    .then((r) => (r.status === 'ok' ? ringUsual((r.output as Trends).series.find((x) => x.scope === 'server'), memTotal ?? (r.output as Trends).memTotal) : {}), () => ({}));
  trendCache.set(serverId, { at: Date.now(), p });
  return p;
}
function Ring({ label, sub, value, detail, icon, trend, px }: { label: string; sub?: string; value: number | null; detail: ReactNode; icon: ReactNode; trend?: RingTrend | null; px: number }) {
  const id = `ring${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const v = value == null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
  const t = RING[loadOf(v)];
  const TI = trend ? TREND_ICON[trend.dir] : null;
  return (
    <HoverCard content={
      <div className="w-[min(248px,calc(100vw-48px))]">
        <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted">{icon}{label}</p>
        <p className="mt-0.5 flex items-baseline gap-2"><span className={cx('tabular text-[22px] font-semibold tracking-[-0.03em]', t.num)}>{v == null ? '–' : `${Math.round(v)}%`}</span><span className="text-[12px] text-muted">{t.word}</span></p>
        <div className="mt-0.5 text-[12.5px] text-ink-2">{detail}</div>
        {trend !== null && (
          <div className="mt-2.5 flex items-start gap-1.5 border-t border-line pt-2.5 text-[12px] text-ink-2">
            {trend === undefined ? <Skeleton className="h-4 w-44" /> : <>{TI && <TI size={14} aria-hidden className={cx('mt-px shrink-0', trend.dir === 'up' ? 'text-warn' : 'text-muted')} />}<span>{trend.text}</span></>}
          </div>
        )}
      </div>}>
      <button type="button" aria-label={`${label}: ${v == null ? 'not measured yet' : `${Math.round(v)}% used`}`} className="group relative z-10 flex shrink-0 flex-col items-center gap-1 rounded-[16px] px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-blue">
        <span className="relative grid place-items-center transition-transform duration-300 ease-out-soft group-hover:scale-[1.04]" style={{ width: px, height: px }}>
          <svg viewBox="0 0 40 40" className="absolute inset-0 size-full -rotate-90" aria-hidden>
            <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" style={{ stopColor: t.from }} /><stop offset="1" style={{ stopColor: t.to }} /></linearGradient></defs>
            <circle cx="20" cy="20" r="16.5" fill="none" stroke="currentColor" strokeWidth="3.5" className="text-ink/[0.07]" />
            {v != null && v > 0 && <circle cx="20" cy="20" r="16.5" fill="none" stroke={`url(#${id})`} strokeWidth="3.5" strokeLinecap="round" pathLength={100} strokeDasharray={`${Math.max(v, 1.5)} 100`}
              style={{ animation: 'gauge-in 1s var(--ease-out-soft) both', transition: 'stroke-dasharray 0.6s var(--ease-out-soft)' }} />}
          </svg>
          <span aria-hidden className={cx('tabular relative flex items-baseline font-semibold leading-none tracking-[-0.04em]', t.num)} style={{ fontSize: Math.round(px * 0.26) }}>
            {v == null ? '–' : <><CountUp value={v} duration={1000} /><span className="ml-px text-[0.62em] font-medium opacity-70">%</span></>}
          </span>
        </span>
        <span className="text-[11px] font-medium leading-tight text-muted transition group-hover:text-ink">{label}</span>
        {sub && <span className="-mt-0.5 text-[11px] leading-tight text-faint">{sub}</span>}
      </button>
    </HoverCard>
  );
}
export function ServerRings({ serverId, cpu, mem, disk, cpus, memUsed, memTotal, diskUsed, diskTotal, live, px = 56, sizes, className }: {
  serverId?: string; cpu: number | null; mem: number | null; disk: number | null; cpus?: number; memUsed?: number; memTotal?: number; diskUsed?: number; diskTotal?: number; live: boolean;
  px?: number; sizes?: boolean; className?: string;
}) {
  const when = live ? 'right now' : 'at the last check';
  const [tr, setTr] = useState<Trend3 | null>(null);
  const asked = useRef(false);
  const want = () => { if (!serverId || asked.current) return; asked.current = true; void loadTrends(serverId, memTotal).then(setTr); };
  // undefined while it's on its way (a line of skeleton), null when there's nothing to compare with
  const trend = (k: 'cpu' | 'mem', now: number | null) => (!serverId ? null : tr ? vsUsual(now, tr[k]) : undefined);
  return (
    <div className={cx('flex items-start gap-1.5', className)} role="group" aria-label="How busy it is" onPointerEnter={want} onFocus={want}>
      <Ring px={px} label="CPU" sub={sizes && cpus ? `${cpus} CPUs` : undefined} value={cpu} icon={<Cpu size={12} />} trend={trend('cpu', cpu)}
        detail={cpu == null ? <>Not measured yet.</> : cpus ? <>Using {Math.round(cpu)}% of its {cpus} CPUs {when}.</> : <>Busy {Math.round(cpu)}% of the time {when}.</>} />
      <Ring px={px} label="Memory" sub={sizes && memTotal ? size(memTotal) : undefined} value={mem} icon={<GaugeIcon size={12} />} trend={trend('mem', mem)}
        detail={memTotal ? <>{size(memUsed)} of {size(memTotal)} in use {when}.</> : <>Not measured yet.</>} />
      <Ring px={px} label="Disk" sub={sizes && diskTotal ? size(diskTotal) : undefined} value={disk} icon={<HardDrive size={12} />} trend={!serverId ? null : tr ? tr.disk ?? null : undefined}
        detail={diskTotal ? <>{size(diskUsed)} of {size(diskTotal)} used, {size(Math.max(0, diskTotal - (diskUsed ?? 0)))} free.</> : <>Not measured yet.</>} />
    </div>
  );
}

// "Add a tool": the way to put database tools, analytics, uptime checks or automations on this server, next to the rings.
// A lime pill with a small raised tile for its icon (the look is .tool-btn in styles.css).
export function AddToolButton({ serverId, className }: { serverId: string; className?: string }) {
  return (
    <A href={`/add?server=${serverId}`} title="Database tools, analytics, uptime checks, automations: one click each, on this server"
      className={cx('tool-btn inline-flex h-11 shrink-0 items-center gap-2.5 rounded-full pl-1.5 pr-4 text-[13.5px] font-semibold', className)}>
      <span className="tool-3d grid size-8 place-items-center rounded-[11px]"><PackagePlus size={16} strokeWidth={2.2} aria-hidden /></span>Add a tool
    </A>
  );
}

// --- a tile -------------------------------------------------------------------------------------------------------
function Tile({ title, icon, onOpen, children, hint }: { title: string; icon: ReactNode; onOpen: () => void; children: ReactNode; hint: string }) {
  return (
    <article className="lift group relative flex min-h-[232px] min-w-0 flex-col rounded-[24px] border border-line bg-surface p-5 shadow-soft">
      <h2 className="flex items-center gap-2.5 text-[13.5px] font-medium text-ink-2">
        <span className="grid size-8 place-items-center rounded-full bg-raised text-ink-2">{icon}</span>
        <button type="button" onClick={onOpen} title={hint} className="outline-none after:absolute after:inset-0 after:rounded-[24px] focus-visible:after:ring-2 focus-visible:after:ring-blue">{title}<span className="sr-only">. {hint}</span></button>
        <ChevronRight size={16} aria-hidden className="ml-auto text-faint transition group-hover:translate-x-0.5 group-hover:text-ink" />
      </h2>
      <div className="mt-4 flex min-h-0 flex-1 flex-col">{children}</div>
    </article>
  );
}
const Big = ({ children, unit }: { children: ReactNode; unit?: string }) => (
  <p className="flex items-baseline gap-2"><span className="tabular text-[38px] font-semibold leading-none tracking-[-0.045em] text-ink">{children}</span>{unit && <span className="text-[14px] text-muted">{unit}</span>}</p>
);
const Num = ({ value, animate, format }: { value: number; animate: boolean; format?: (n: number) => string }) => (animate ? <CountUp value={value} format={format} duration={900} /> : <span className="tabular">{(format ?? ((n: number) => String(Math.round(n))))(value)}</span>);

// --- Apps ---
export function AppsTile({ cards, onOpen, animate }: { cards: Card[]; onOpen: () => void; animate: boolean }) {
  const own = cards.filter((c) => !c.system);
  const bad = own.filter((c) => healthTone(c.health) === 'bad').length, warn = own.filter((c) => healthTone(c.health) === 'warn').length;
  const owners = [...own.reduce((m, c) => m.set(c.owner, (m.get(c.owner) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const word = !own.length ? 'Nothing deployed yet' : bad ? `${bad} ${bad === 1 ? 'is' : 'are'} down` : warn ? `${warn} need${warn === 1 ? 's' : ''} a look` : own.length === 1 ? 'Healthy' : 'All healthy';
  const tone = bad ? 'bg-bad' : warn ? 'bg-[#f59e0b]' : own.length ? 'bg-ok' : 'bg-faint';
  return (
    <Tile title="Apps" icon={<LayoutGrid size={15} />} onOpen={onOpen} hint="See every project on this server">
      <Big unit={own.length === 1 ? 'project' : 'projects'}><Num value={own.length} animate={animate} /></Big>
      <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-2"><span className={cx('size-2 rounded-full', tone)} />{word}</p>
      <div className="mt-auto pt-4">
        <ul className="flex flex-wrap gap-1.5" aria-label="Who runs them">
          {owners.slice(0, 4).map(([o, n]) => (
            <li key={o} title={`${n} run by ${OWNER_NAME[o] ?? o}`} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-raised pl-1 pr-2.5 text-[12px] font-medium text-ink-2">
              <span className="grid size-5 place-items-center rounded-full bg-surface">{ownerLogo(o) ? <BrandLogo id={ownerLogo(o)!} size={12} /> : <span className="text-[10px] text-muted">?</span>}</span>
              <span className="tabular">{n}</span><span className="sr-only">run by {OWNER_NAME[o] ?? o}</span>
            </li>
          ))}
        </ul>
        {own.length > 1 && <p aria-hidden className="mt-3 flex flex-wrap gap-1">{own.slice(0, 36).map((c) => { const t = healthTone(c.health); return <span key={c.id} className={cx('size-2 rounded-full', t === 'bad' ? 'bg-bad' : t === 'warn' ? 'bg-[#f59e0b]' : t === 'idle' ? 'bg-line-strong' : 'bg-ok/70')} />; })}</p>}
      </div>
    </Tile>
  );
}

// --- Traffic ---
export function TrafficTile({ serverId, onOpen, animate }: { serverId: string; onOpen: () => void; animate: boolean }) {
  const s = useTrafficSeries(serverId, '24h');
  const d = s.data;
  const vs = d?.usual ? (d.totals.visits - d.usual) / Math.max(1, d.usual) : undefined;
  return (
    <Tile title="Traffic" icon={<Globe size={15} />} onOpen={onOpen} hint="See visits, errors and who’s calling">
      {!d && !s.err ? <><Skeleton className="h-9 w-28" /><Skeleton className="mt-3 h-4 w-36" /><Skeleton className="mt-auto h-14" /></>
        : !d || !d.totals.visits ? (
          <>
            <Big>–</Big>
            <p className="mt-2 text-[13px] text-ink-2">{s.err ? 'Couldn’t read the traffic just now.' : 'No visits counted yet.'}</p>
            <p className="mt-auto pt-4 text-[12.5px] text-muted">Open it to see why, and how to turn it on.</p>
          </>
        ) : (
          <>
            <Big unit="visits"><Num value={d.totals.visits} animate={animate} format={count} /></Big>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
              <span>in the last 24 hours</span>
              {vs !== undefined && Math.abs(vs) >= 0.01 && (
                <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium', vs >= 2 ? 'bg-warn/10 text-warn' : 'bg-raised text-ink-2')}>
                  {vs >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{vs >= 0 ? '+' : '−'}{pct(Math.abs(vs * 100))} vs usual
                </span>
              )}
            </p>
            <div className="mt-auto pt-3"><TrafficSpark series={d} draw={animate} /></div>
          </>
        )}
    </Tile>
  );
}

// --- Attention ---
export function AttentionTile({ w, onOpen, onItem, animate }: { w: ServerWatch; onOpen: () => void; onItem: (it: Item) => void; animate: boolean }) {
  const top = w.items[0];
  return (
    <Tile title="Attention" icon={<Lightbulb size={15} />} onOpen={onOpen} hint="See every risk, waste and tip, each with its fix">
      {w.loading ? <><Skeleton className="h-9 w-20" /><Skeleton className="mt-3 h-4 w-40" /><Skeleton className="mt-auto h-12" /></>
        : !top ? (
          <>
            <Big>0</Big>
            <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-2"><span className="size-2 rounded-full bg-ok" />All clear</p>
            <p className="mt-auto pt-4 text-[12.5px] text-muted">{w.err ? tidy(w.err) : 'Nothing to fix and nothing wasted that Unit7 can see.'}</p>
          </>
        ) : (
          <>
            <Big unit={w.items.length === 1 ? 'thing to look at' : 'things to look at'}><Num value={w.items.length} animate={animate} /></Big>
            <p className="mt-2 text-[13px] text-ink-2">{countsLine(w.counts)}</p>
            <div className="mt-auto pt-4">
              <p className="flex items-start gap-2 text-[13px] leading-snug text-ink"><span aria-hidden className={cx('mt-[5px] size-2 shrink-0 rounded-full', SEV[top.severity].dot)} /><span className="line-clamp-2">{tidy(top.title)}</span></p>
              <div className="mt-2.5 pl-4"><ItemAction it={top} onDetails={() => onItem(top)} /></div>
            </div>
          </>
        )}
    </Tile>
  );
}

// --- Room ---
const usedOf = (sx: ServerXray) => {
  const u = sx.u?.server, h = sx.x?.server;
  const memTotal = u?.memTotal ?? h?.memTotal, memUsed = u?.memUsed ?? (h?.memTotal && h.memAvailable != null ? h.memTotal - h.memAvailable : undefined);
  const diskTotal = u?.diskTotal ?? h?.diskTotal, diskUsed = u?.diskUsed ?? h?.diskUsed;
  return { memTotal, memUsed, diskTotal, diskUsed, mem: memTotal && memUsed != null ? (100 * memUsed) / memTotal : null, disk: diskTotal && diskUsed != null ? (100 * diskUsed) / diskTotal : null };
};
function Fill({ label, v, sub }: { label: string; v: number | null; sub: string }) {
  return (
    <div>
      <p className="flex items-baseline justify-between text-[13px]"><span className="text-ink-2">{label}</span><span className="tabular font-semibold text-ink">{v == null ? '–' : `${Math.round(v)}%`}</span></p>
      <span role="meter" aria-label={label} aria-valuenow={v == null ? undefined : Math.round(v)} aria-valuemin={0} aria-valuemax={100} className="mt-1.5 block h-2 overflow-hidden rounded-full bg-sunken">
        <span className="block h-full rounded-full transition-[width] duration-700 ease-out-soft" style={{ width: `${Math.max(v ? 3 : 0, v ?? 0)}%`, background: ringColor(v) }} />
      </span>
      <p className="tabular mt-1 text-[11.5px] text-muted">{sub}</p>
    </div>
  );
}
export function RoomTile({ sx, onOpen }: { sx: ServerXray; onOpen: () => void }) {
  const r = usedOf(sx);
  const full = fullIn(sx.x?.trend, r.diskTotal);
  const clean = sx.u ? storageBar(sx.u, 'disk', colorSlots(sx.x!)).clean : undefined;
  const words = roomLeft(full) ?? (r.disk != null && r.mem != null && r.disk < 70 && r.mem < 70 ? 'Plenty of room for now' : r.disk != null && r.disk >= 85 ? 'The disk is nearly full' : 'Room to grow');
  return (
    <Tile title="Room" icon={<HardDrive size={15} />} onOpen={onOpen} hint="See what each project uses, and the price">
      {!sx.x ? <><Skeleton className="h-10" /><Skeleton className="mt-3 h-10" /></> : (
        <>
          <div className="space-y-3">
            <Fill label="Memory" v={r.mem} sub={r.memTotal ? `${size(r.memUsed)} of ${size(r.memTotal)}` : 'Not measured yet'} />
            <Fill label="Disk" v={r.disk} sub={r.diskTotal ? `${size(r.diskUsed)} of ${size(r.diskTotal)}` : 'Not measured yet'} />
          </div>
          <p className="mt-auto pt-3 text-[12.5px] text-ink-2">{words}{clean ? <span className="text-muted"> · {size(clean)} can be cleaned up</span> : null}</p>
        </>
      )}
    </Tile>
  );
}

// --- the Room pop-up: memory and disk split by project, the disk measurement, the price ----------------------------
export function RoomDetail({ sx, human }: { sx: ServerXray; human: boolean }) {
  const { x, u } = sx;
  if (!x) return null;
  const slots = colorSlots(x);
  const r = usedOf(sx);
  const full = fullIn(x.trend, r.diskTotal);
  return (
    <div className="space-y-5">
      {!u ? (sx.uErr ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">What each project uses shows once the server answers.</p> : <div className="space-y-4" aria-hidden><Skeleton className="h-3.5 rounded-full" /><Skeleton className="h-3.5 rounded-full" /></div>) : (() => {
        const mem = storageBar(u, 'mem', slots), disk = storageBar(u, 'disk', slots);
        const at = u.stale ? `from ${hoursAgo(u.stale.since)}` : `measured ${timeAgo(u.at)}`;
        return (
          <>
            <StorageBar label={`Memory · ${size(mem.total)}`} bar={mem} note={`free ${size(mem.free)}`} title={`${tidy(u.method)}, ${at}`} />
            <StorageBar label={`Disk · ${size(disk.total)}`} bar={disk} title={u.disk ? `${tidy(u.disk.method)}, measured ${timeAgo(u.disk.measuredAt)}` : 'Disk per project needs one measurement'}
              note={[`free ${size(disk.free)}`, disk.clean ? `can clean up ${size(disk.clean)}` : ''].filter(Boolean).join(' · ')} />
            <Legend bars={[mem, disk]} />
            <div className="flex flex-wrap items-center gap-3 rounded-[18px] bg-raised px-4 py-3">
              <p className="min-w-[200px] flex-1 text-[13px] text-ink-2">{roomLeft(full) ? `${roomLeft(full)}, at the rate it’s been growing.` : 'Unit7 says when the disk will fill up once it has a few days of measurements.'} <span className="text-muted">Usage {at}.</span></p>
              <Button size="sm" variant="secondary" icon={<HardDrive size={13} />} loading={sx.measuring} onClick={() => void sx.measure()} title="Measures each project’s folders and databases. Takes a minute or two; read-only.">{disk.perProject ? 'Measure again' : 'Measure disk'}</Button>
            </div>
          </>
        );
      })()}
      <PriceLine sx={sx} human={human} />
    </div>
  );
}

// "What does this server cost a month?"
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD'];
function PriceLine({ sx, human }: { sx: ServerXray; human: boolean }) {
  const p = sx.price;
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState('');
  const [cur, setCur] = useState('USD');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (p?.monthly != null) { setV(String(p.monthly)); setCur(p.currency ?? 'USD'); } }, [p?.monthly, p?.currency]);
  if (!p) return null;
  const save = async () => { setBusy(true); const ok = await sx.setPrice(v.trim() === '' ? null : Number(v), cur); setBusy(false); if (ok) setEdit(false); };
  const free = sx.u?.free.cost;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4 text-[13px]">
      {edit || p.monthly == null ? (
        human ? (
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label htmlFor="srv-price" className="font-medium text-ink">What does this server cost a month?</label>
            <span className="inline-flex items-center gap-1.5">
              <Input id="srv-price" inputMode="decimal" type="number" min={0} step="0.01" value={v} onChange={(e) => setV(e.target.value)} placeholder="12.00" className="h-8 w-24 text-[13px]" />
              <select aria-label="Currency" value={cur} onChange={(e) => setCur(e.target.value)} className="h-8 rounded-[12px] border border-line-strong bg-surface px-2 text-[12.5px]">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
              <Button type="submit" size="sm" variant="primary" loading={busy} disabled={v.trim() !== '' && !(Number(v) >= 0)}>Save</Button>
              {edit && <Button type="button" size="sm" variant="ghost" onClick={() => setEdit(false)}>Cancel</Button>}
            </span>
            <span className="text-[12px] text-muted">Unit7 splits it by what each project uses.</span>
          </form>
        ) : <span className="text-muted">No price set for this server.</span>
      ) : (
        <>
          <span className="text-ink-2">This server costs <b className="tabular font-semibold text-ink">{money(p.monthly, p.currency)}</b> a month{p.source && p.source !== 'you' ? <span className="text-muted"> · from {p.source}</span> : ''}</span>
          {free != null && <span className="text-muted" title="The part of the price nothing uses right now">· {money(free, p.currency)} of it is free room</span>}
          {human && <button type="button" onClick={() => setEdit(true)} className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-blue-text hover:bg-blue-soft"><Pencil size={12} />Change</button>}
        </>
      )}
    </div>
  );
}
