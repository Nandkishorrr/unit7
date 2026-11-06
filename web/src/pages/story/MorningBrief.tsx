// The morning brief on Home: three short lines (yesterday, what Unit7 fixed overnight, the one decision it needs from
// you, with a link), or "Everything is fine". The same brief reaches your phone at 09:00 unless it's switched off in
// Settings → Watch.
import { useEffect, useState } from 'react';
import { ArrowUpRight, BarChart3, CheckCircle2, Hand, Sunrise, Wrench, EyeOff } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { A, cx, IconCircle, Skeleton } from '../../ui';
import { rawWords } from '../../lib/words';
import { hhmm, type BriefLine, type BriefOut } from './shape';

const ICON = { yesterday: BarChart3, fixed: Wrench, decision: Hand, fine: CheckCircle2, blind: EyeOff } as const;

export function useBrief(given?: BriefOut) {
  const [b, set] = useState<BriefOut | null | undefined>(given);
  useEffect(() => {
    if (given) return;
    const load = () => runTool('story.brief', {}).then((r) => set(r.status === 'ok' ? r.output : null), () => set(null));
    void load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => { if (!e.live && /^(story\.brief|approval\.|watch\.|deployment\.)/.test(e.type)) { clearTimeout(t); t = setTimeout(load, 800); } });
    return () => { off(); clearTimeout(t); };
  }, [given]);
  return b;
}

function Row({ l, i }: { l: BriefLine; i: number }) {
  const I = ICON[l.key];
  const need = l.key === 'decision' && !!l.href;
  const body = (
    <>
      <span aria-hidden className={cx('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full', need ? 'bg-blue text-white' : l.key === 'fine' ? 'bg-lime text-lime-ink' : 'bg-raised text-ink-2')}><I size={12.5} /></span>
      <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{rawWords(l.text)}</span>
      {need && <ArrowUpRight size={14} aria-hidden className="mt-0.5 shrink-0 text-blue-text" />}
    </>
  );
  const cls = 'flex items-start gap-2.5 rounded-[14px] p-1.5 animate-rise';
  return need
    ? <li style={{ animationDelay: `${i * 70}ms` }} className="contents"><A href={l.href!} className={cx(cls, 'bg-blue-soft hover:bg-blue-soft/70 transition-colors')} style={{ animationDelay: `${i * 70}ms` }}>{body}</A></li>
    : <li className={cls} style={{ animationDelay: `${i * 70}ms` }}>{body}</li>;
}

// the Home card (side panel). Hidden when the brief is switched off, or there's nothing to brief about yet (a new install).
// hideApprovals: the approval it would point at is already in the "Waiting for you" card right under it
export function MorningBrief({ brief: given, className, hideApprovals }: { brief?: BriefOut; className?: string; hideApprovals?: boolean }) {
  const b = useBrief(given);
  if (b === null || (b && (!b.on || b.empty) && !given)) return null;
  return (
    <section aria-label="Morning brief" className={cx('relative overflow-hidden rounded-[24px] border border-line bg-surface p-4 shadow-soft', className)}>
      <div aria-hidden className="pointer-events-none absolute -right-12 -top-14 size-36 rounded-full bg-[#ffd27a]/30 blur-2xl dark:bg-[#ffd27a]/10" />
      <div className="relative flex items-center gap-2.5">
        <IconCircle size={34} tone="lime"><Sunrise size={16} /></IconCircle>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14.5px] font-medium tracking-[-0.01em]">Morning brief</h2>
          <p className="truncate text-[12px] text-muted">{!b ? 'Reading yesterday…' : b.sentAt && new Date(b.sentAt).toDateString() === new Date().toDateString() ? `Sent at ${hhmm(b.sentAt)}` : 'Arrives at 09:00 on your clock'}</p>
        </div>
      </div>
      {!b ? <div className="relative mt-3 space-y-2"><Skeleton className="h-5 rounded-full" /><Skeleton className="h-5 w-4/5 rounded-full" /></div> : (
        <ul className="relative mt-3 space-y-1">{b.lines.filter((l) => !(hideApprovals && l.key === 'decision' && l.href === '/approvals')).map((l, i) => <Row key={l.key} l={l} i={i} />)}</ul>
      )}
    </section>
  );
}
