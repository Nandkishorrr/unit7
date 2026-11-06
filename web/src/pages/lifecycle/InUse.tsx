// "In use": the cards' little "Used 3 min ago · by 2 apps" line and the Important star, from one shared fetch
// (asset.pulse) refreshed when something is marked, archived, deleted or synced; keep() marks something in use or
// important. Nothing shows when Unit7 knows nothing (never "unused" by default).
import { useSyncExternalStore } from 'react';
import { Star } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { act, cx, Dot, HoverCard } from '../../ui';
import type { LifecycleItem } from './Lifecycle';

export interface Pulse { label: 'Used' | 'Last visit' | 'Deployed' | 'Changed' | 'Live'; at?: string; by?: number; detail: string[] }
export interface KeptRow { key: string; name: string; important: boolean; note: string | null; by: string | null; created_at: string }

let state = { kept: new Map<string, KeptRow>(), pulse: {} as Record<string, Pulse>, loaded: false };
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
function load() {
  loading ??= runTool('asset.pulse').then((r) => {
    if (r.status !== 'ok') return;
    const o = r.output as { kept: KeptRow[]; pulse: Record<string, Pulse> };
    state = { kept: new Map(o.kept.map((k) => [k.key, k])), pulse: o.pulse, loaded: true };
    subs.forEach((f) => f());
  }).catch(() => {}).finally(() => { loading = null; });
  return loading;
}
let offLive: (() => void) | undefined;
function subscribe(f: () => void) {
  subs.add(f);
  if (!state.loaded) void load();
  offLive ??= onLive((e) => { if (/^(asset\.(kept|unkept|archived|unarchived|deleted)|sync\.done)$/.test(e.type)) void load(); });
  return () => { subs.delete(f); };
}
export function useInUse() {
  const s = useSyncExternalStore(subscribe, () => state);
  return { ...s, reload: load };
}

// mark it in use (o.important: and important), or take the mark off (o.kept false); the toast carries Undo
export async function keep(item: LifecycleItem, o: { important?: boolean; kept?: boolean } = {}) {
  const r = await act('asset.keep', { key: item.key, ...o }, {
    success: o.kept === false ? `${item.name} may show in Clean up again` : o.important ? `${item.name} is marked important` : o.important === false ? `${item.name} is no longer marked important` : `${item.name} is marked in use`,
  });
  if (r) await load();
  return r;
}

const ago = (iso: string) => {
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  return m < 2 ? 'just now' : m < 90 ? `${Math.round(m)} min ago` : m < 36 * 60 ? `${Math.round(m / 60)} hours ago` : m < 45 * 1440 ? `${Math.round(m / 1440)} days ago` : `${Math.round(m / 43200)} months ago`;
};
export function pulseWords(p: Pulse) {
  const when = p.at ? ago(p.at) : '', by = p.by ? `by ${p.by} app${p.by === 1 ? '' : 's'}` : '';
  switch (p.label) {
    case 'Used': return when ? `Used ${when}${by ? ` · ${by}` : ''}` : `Used ${by}`;
    case 'Last visit': return `Last visit ${when}${by ? ` · used ${by}` : ''}`;
    case 'Deployed': return `Deployed ${when}`;
    case 'Changed': return `Code changed ${when}`;
    default: return 'Live: its domain answers';
  }
}

// how Unit7 knows it's used, as a short list (the pulse's hover, or a card's own hover card)
export function PulseDetail({ k, className }: { k?: string; className?: string }) {
  const p = useInUse().pulse[k ?? ''];
  if (!p) return null;
  return (
    <div className={className}>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">In use · how Unit7 knows</p>
      <ul className="space-y-0.5 text-[12.5px] leading-snug text-ink-2">{p.detail.map((d) => <li key={d} className="flex gap-2"><span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-ok" />{d}</li>)}</ul>
    </div>
  );
}

// the one quiet line, with how Unit7 knows on hover (plain: no hover of its own, inside a card that has one)
export function UsedPulse({ k, className, plain, except }: { k?: string; className?: string; plain?: boolean; except?: Pulse['label'][] }) {
  const { pulse } = useInUse();
  const p = k ? pulse[k] : undefined;
  if (!p || except?.includes(p.label)) return null; // e.g. a card that already says when it was last deployed
  const recent = !!p.at && Date.now() - Date.parse(p.at) < 3600_000 && (p.label === 'Used' || p.label === 'Last visit');
  const line = (
    <span tabIndex={plain ? undefined : 0} className={cx('relative z-10 inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full text-[12px] text-muted outline-none focus-visible:ring-2 focus-visible:ring-blue', className)}>
      <span className="scale-75"><Dot tone="ok" working={recent} /></span>
      <span className="truncate">{pulseWords(p)}</span>
    </span>
  );
  return plain ? line : <HoverCard content={<PulseDetail k={k} className="w-[min(260px,calc(100vw-48px))]" />}>{line}</HoverCard>;
}

// a tiny star on something marked important, with what that means on hover
export function KeepStar({ k, className, plain, label }: { k?: string; className?: string; plain?: boolean; label?: boolean }) {
  const { kept } = useInUse();
  const m = k ? kept.get(k) : undefined;
  if (!m?.important) return null;
  if (plain) return <span title="Important: in use, Unit7 takes extra care" className={cx('inline-grid size-5 shrink-0 place-items-center rounded-full bg-warn/12 text-warn', className)}><Star size={11} strokeWidth={2.4} className="fill-current" aria-hidden /><span className="sr-only">Important</span></span>;
  return (
    <HoverCard content={
      <div className="w-[min(250px,calc(100vw-48px))] text-[12.5px] leading-snug">
        <p className="flex items-center gap-1.5 font-semibold text-ink"><Star size={13} className="fill-current text-warn" aria-hidden />Important</p>
        <p className="mt-1 text-ink-2">In use, even without visitors. Unit7 never suggests archiving or deleting it, and an AI asks you before changing it.</p>
        {m.note && <p className="mt-1.5 text-muted">“{m.note}”</p>}
      </div>
    }>
      <span tabIndex={0} aria-label={label ? undefined : 'Important'} className={cx('relative z-10 inline-flex shrink-0 items-center justify-center gap-1 rounded-full bg-warn/12 text-warn outline-none focus-visible:ring-2 focus-visible:ring-blue', label ? 'h-6 px-2.5 text-[12px] font-medium' : 'size-5', className)}>
        <Star size={label ? 12 : 11} strokeWidth={2.4} className="fill-current" aria-hidden />{label && 'Important'}
      </span>
    </HoverCard>
  );
}
