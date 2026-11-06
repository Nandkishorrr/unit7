// "Point example.com at your website?" as a preview: each change as before → after, how to undo it, then
// Confirm or Not now. Deletes and restores get the red button.
import { ArrowRight, ShieldCheck, TriangleAlert, Undo2 } from 'lucide-react';
import { Button, cx } from '../../../ui';
import { AskFrame, Footer, type KindProps } from './kit';

export function Confirm({ spec, askId, busy, error, send }: KindProps<'confirm'>) {
  const yes = spec.confirmLabel ?? 'Confirm';
  return (
    <AskFrame icon={spec.danger ? <TriangleAlert size={17} /> : <ShieldCheck size={17} />} tone={spec.danger ? 'bad' : 'soft'} title={spec.title} note={spec.note} titleId={`${askId}-t`}
      footer={(
        <Footer onSkip={() => send({ ok: false }, 'Not now')} busy={busy} error={error}>
          <Button variant={spec.danger ? 'danger' : 'primary'} onClick={() => send({ ok: true }, 'Confirmed')} loading={busy} className="min-w-[124px]">{yes}</Button>
        </Footer>
      )}>
      <ul className={cx('stagger divide-y overflow-hidden rounded-[18px] border', spec.danger ? 'divide-bad/15 border-bad/25 bg-bad/[0.04]' : 'divide-line border-line bg-raised/50')}>
        {spec.changes.map((c, i) => (
          <li key={i} className="px-3.5 py-3">
            <p className="text-[12.5px] font-medium text-muted">{c.label}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13.5px]">
              {c.before
                ? <span className="max-w-full break-words rounded-[10px] bg-surface px-2.5 py-1 text-muted ring-1 ring-line">{c.before}</span>
                : <span className="rounded-full bg-lime px-2 py-0.5 text-[11.5px] font-semibold text-lime-ink">New</span>}
              <ArrowRight size={14} aria-hidden className="shrink-0 text-faint" /><span className="sr-only">becomes</span>
              <span className={cx('max-w-full break-words rounded-[10px] px-2.5 py-1 font-medium ring-1', spec.danger ? 'bg-bad/8 text-bad ring-bad/20' : 'bg-blue-soft text-blue-text ring-blue/15')}>{c.after}</span>
            </div>
          </li>
        ))}
      </ul>
      {spec.undo && (
        <p className="mt-3 flex items-start gap-2 text-[13px] text-muted">
          <Undo2 size={14} aria-hidden className="mt-[3px] shrink-0" /><span><span className="font-medium text-ink-2">To undo: </span>{spec.undo}</span>
        </p>
      )}
    </AskFrame>
  );
}
