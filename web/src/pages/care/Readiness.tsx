// "Ready for real users": a ring with the count, the checklist with one fix for each gap, and a small ring for
// project cards. At all-done the card gets a lime "Ready" badge and, once per project, a quiet burst (none with
// reduced motion). Every tick comes from project.readiness, so it's what Unit7 saw, not what anyone said.
import { useEffect, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Rocket } from 'lucide-react';
import { navigate } from '../../lib/router';
import { act, AiButton, Badge, Button, Card, cx, HoverCard, Skeleton } from '../../ui';
import { tidy } from '../../lib/words';
import { askOnHome } from '../Help';
import { refreshReadiness, useReadinessOf, useTool, type Check as Item, type Fix, type Readiness } from './data';

const BURST = ['#c6f432', '#1f5bff', '#8b5cf6', '#c6f432', '#26b5f0', '#1f5bff', '#d16bf5', '#c6f432'];

// the ring: blue while it fills, lime when it's full. The arc eases in (still with reduced motion).
export function ReadinessRing({ done, total, size = 96, label = true, className }: { done: number; total: number; size?: number; label?: boolean; className?: string }) {
  const p = total ? done / total : 0, ready = total > 0 && done === total;
  const w = Math.max(3, Math.round(size / 11)), r = (size - w) / 2, c = 2 * Math.PI * r;
  return (
    <span role="img" aria-label={`${done} of ${total} ready`} className={cx('relative inline-grid shrink-0 place-items-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={w} />
        {p > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ready ? 'var(--lime)' : 'var(--blue)'} strokeWidth={w} strokeLinecap="round"
          strokeDasharray={`${c * p} ${c}`} className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-700" />}
      </svg>
      {label && <span aria-hidden className="tabular absolute font-semibold tracking-[-0.03em] text-ink" style={{ fontSize: Math.max(10, size * 0.24) }}>{done}<span className="text-muted">/{total}</span></span>}
    </span>
  );
}

// once per project in this browser: the moment it first reaches all-done
function firstTimeReady(projectId: string) {
  try { if (localStorage.getItem(`unit7-ready:${projectId}`)) return false; localStorage.setItem(`unit7-ready:${projectId}`, '1'); return true; } catch { return false; }
}
function ReadyBadge({ projectId }: { projectId: string }) {
  const [party] = useState(() => firstTimeReady(projectId));
  return (
    <span className="relative inline-flex">
      <Badge tone="lime" className="font-semibold"><Check size={12} strokeWidth={3} />Ready</Badge>
      {party && <span aria-hidden className="burst pointer-events-none absolute inset-0">{BURST.map((col, i) => <i key={i} style={{ background: col, ['--a' as string]: `${i * 45 + 20}deg`, animationDelay: `${120 + (i % 3) * 40}ms` }} />)}</span>}
    </span>
  );
}

// For a project card: a small ring and "7/9", or the lime Ready badge. Hover says what's next; a click opens the list.
export function ReadinessBadge({ projectId, className }: { projectId: string; className?: string }) {
  const r = useReadinessOf(projectId);
  if (!r || !r.total) return null;
  const body = r.ready ? 'Ready for real users: everything on the list is done.' : `Ready for real users: ${r.done} of ${r.total} done. Open the project to see what’s left.`;
  return (
    <HoverCard content={<p className="max-w-[240px] text-[12.5px] text-ink-2">{body}</p>}>
      <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/projects/${projectId}#readiness`); }}
        aria-label={r.ready ? 'Ready for real users' : `Ready for real users: ${r.done} of ${r.total}`}
        className={cx('inline-flex h-7 items-center gap-1.5 rounded-full pr-1 text-[12px] font-medium text-ink-2 transition hover:text-ink', className)}>
        {r.ready ? <ReadyBadge projectId={projectId} /> : <><ReadinessRing done={r.done} total={r.total} size={22} label={false} /><span className="tabular">{r.done}/{r.total}</span></>}
      </button>
    </HoverCard>
  );
}

export function FixButton({ fix, onDone }: { fix: Fix; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if ('ask' in fix) return <AiButton size="sm" onClick={() => askOnHome(fix.ask)} title="Opens Home with this ready. Nothing happens until you send it.">{fix.label}</AiButton>;
  if ('href' in fix) return <Button size="sm" variant="soft" icon={<ArrowRight size={13} />} onClick={() => navigate(fix.href)}>{fix.label}</Button>;
  return <Button size="sm" variant="secondary" loading={busy} onClick={async () => { setBusy(true); const r = await act(fix.tool, fix.input, { success: 'Done', undo: false }); setBusy(false); if (r) onDone(); }}>{fix.label}</Button>;
}

export function Row({ c, onDone }: { c: Item; onDone: () => void }) {
  return (
    <li className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 py-2.5">
      <span aria-hidden className={cx('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full', c.ok ? 'bg-lime text-lime-ink' : 'border-2 border-line-strong')}>{c.ok && <Check size={12} strokeWidth={3} />}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-ink">{c.label}<span className="sr-only">{c.ok ? ': done' : ': not yet'}</span></p>
        <p className="break-words text-[12.5px] text-muted">{tidy(c.detail)}</p>
      </div>
      {!c.ok && c.fix && <div className="shrink-0 max-sm:basis-full max-sm:pl-8"><FixButton fix={c.fix} onDone={onDone} /></div>}
    </li>
  );
}

// The project page's card: the ring, what's left (at most three at rest), and everything on "Show all"
export function ReadinessCard({ projectId, className }: { projectId: string; className?: string }) {
  const { data, error, reload } = useTool<Readiness>('project.readiness', { projectId });
  const [all, setAll] = useState(false);
  const done = () => { void reload(); void refreshReadiness(); };
  // opened from a card's ring (…#readiness): bring the list into view once it's there
  const loaded = !!data;
  useEffect(() => { if (loaded && location.hash === '#readiness') document.getElementById('readiness')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [loaded]);
  if (error && !data) return <Card className={cx('p-5', className)}><p className="text-[13px] text-bad">{tidy(error)}</p></Card>;
  if (!data) return <Skeleton className={cx('h-[220px] rounded-[24px]', className)} />;
  const left = data.checks.filter((c) => !c.ok);
  const shown = all ? data.checks : left.slice(0, 3);
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <section id="readiness" aria-label="Ready for real users" className="scroll-mt-24">
        <div className="flex items-center gap-4">
          <ReadinessRing done={data.done} total={data.total} size={84} />
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-[16.5px] font-semibold tracking-[-0.015em] text-ink">Ready for real users{data.ready && <ReadyBadge projectId={projectId} />}</h2>
            <p className="mt-0.5 text-[13px] text-muted">{data.ready ? 'Everything a real launch needs is in place.' : left.length === 1 ? 'One thing left.' : `${left.length} things left. Each has its fix right here.`}</p>
          </div>
        </div>
        {data.ready && !all ? (
          <p className="mt-4 flex items-center gap-2 rounded-[18px] bg-lime-soft px-4 py-3 text-[13px] text-ink"><Rocket size={15} aria-hidden />Own domain, HTTPS, backups, alerts and the rest: all done.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">{shown.map((c) => <Row key={c.key} c={c} onDone={done} />)}</ul>
        )}
        {(all || data.checks.length > shown.length) && (
          <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)} className="mt-2 inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-blue-text transition hover:bg-blue-soft">
            {all ? 'Show what’s left' : `Show all ${data.checks.length}`}<ChevronDown size={14} className={cx('transition-transform', all && 'rotate-180')} />
          </button>
        )}
      </section>
    </Card>
  );
}
