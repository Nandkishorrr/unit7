// What the test-copy and add-a-tool pop-ups share: the steps as they happen (from the tool's own progress lines), the
// room meter (what it needs against what the server has free), a small segmented choice, and the success moment.
import { useEffect, useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { onLive } from '../../lib/api';
import { cx, StatusMark } from '../../ui';

export const size = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10_240 ? 0 : 1)} GB` : `${Math.round(mb)} MB`);
export const host = (url?: string) => (url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');

// "Step 3 of 7: …" lines a tool says while it runs: which step it's on, the titles said so far, and the last other thing
export function useSteps(tool: string, on: boolean) {
  const [s, set] = useState<{ at: number; of: number; titles: string[]; note?: string }>({ at: 0, of: 0, titles: [] });
  useEffect(() => {
    if (!on) { set({ at: 0, of: 0, titles: [] }); return; }
    return onLive((e) => {
      if (e.type !== 'tool.progress' || e.data?.tool !== tool) return;
      const m = /^Step (\d+) of (\d+): (.+)$/.exec(e.message);
      set((x) => {
        if (!m) return { ...x, note: e.message };
        const titles = [...x.titles]; titles[Number(m[1]) - 1] = m[3]!;
        return { at: Number(m[1]), of: Number(m[2]), titles };
      });
    });
  }, [tool, on]);
  return s;
}

// each step: done, happening (with the last thing it said), stopped, or still to come
export function StepList({ steps, at, note, failed, done }: { steps: string[]; at: number; note?: string; failed?: { step: string; why: string }; done?: boolean }) {
  const bad = failed ? steps.indexOf(failed.step) : -1;
  return (
    <ol className="space-y-2" aria-live="polite">
      {steps.map((s, i) => {
        const state = i === bad ? 'bad' : done || (bad >= 0 ? i < bad : i < at - 1) ? 'ok' : !failed && i === at - 1 ? 'run' : 'wait';
        return (
          <li key={i} className={cx('flex items-start gap-3 text-[13.5px]', state === 'wait' && 'text-muted')}>
            {state === 'ok' || state === 'bad' ? <StatusMark state={state} size={22} solid label={state === 'ok' ? 'Done' : 'Failed'} className="mt-px" /> : (
              <span aria-hidden className={cx('mt-px grid size-[22px] shrink-0 place-items-center rounded-full text-[11px] font-semibold transition-colors duration-300', state === 'run' ? 'bg-blue text-white' : 'border border-line-strong text-faint')}>
                {state === 'run' ? <span className="size-2 rounded-full bg-white animate-working" /> : i + 1}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className={cx(state === 'run' && 'font-medium text-ink')}>{s || (state === 'wait' ? 'Next' : `Step ${i + 1}`)}</span>
              <span className="sr-only">{state === 'ok' ? ', done' : state === 'run' ? ', happening now' : state === 'bad' ? ', stopped' : ''}</span>
              {state === 'run' && note && <span className="block truncate text-[12px] text-muted">{note.replace(/https?:\/\//g, '')}</span>}
              {state === 'bad' && failed && <span className="block text-[12.5px] text-bad">{failed.why}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// what it needs against what's free; amber when it's tight, red when it won't fit
export function RoomMeter({ needMb, freeMb, fits, label = 'Needs about' }: { needMb: number; freeMb?: number; fits?: boolean; label?: string }) {
  const pct = freeMb ? Math.min(100, Math.round((needMb / Math.max(1, freeMb)) * 100)) : 0;
  const tone = fits === false ? (freeMb !== undefined && freeMb >= needMb ? 'warn' : 'bad') : 'ok';
  return (
    <div className="min-w-0">
      <p className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="text-ink-2">{label} <span className="tabular font-medium text-ink">{size(needMb)}</span></span>
        <span className={cx('tabular', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-muted')}>{freeMb === undefined ? 'free room not measured yet' : `${size(freeMb)} free`}</span>
      </p>
      {freeMb !== undefined && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Uses ${pct}% of the free memory`}>
          <div className={cx('h-full rounded-full transition-[width] duration-700 ease-out-soft', tone === 'bad' ? 'bg-bad-solid' : tone === 'warn' ? 'bg-[#f59e0b]' : 'bg-blue')} style={{ width: `${Math.max(4, pct)}%` }} />
        </div>
      )}
    </div>
  );
}

// a few choices as one row of pills (a radio group underneath)
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; danger?: boolean }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-full bg-raised p-1">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cx('h-7 rounded-full px-3 text-[12.5px] font-medium transition',
            value === o.value ? (o.danger ? 'bg-bad-solid text-white' : 'bg-surface text-ink shadow-soft') : 'text-ink-2 hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// the one moment per pop-up: a check that pops, the name, and where it lives now
export function LiveMoment({ title, url, children }: { title: ReactNode; url?: string; children?: ReactNode }) {
  return (
    <div className="animate-pop text-center">
      <StatusMark state="ok" size={56} solid className="mx-auto" label="Done" />
      <p className="mt-4 text-[17px] font-semibold tracking-[-0.02em] text-ink">{title}</p>
      {url && (
        <a href={url} target="_blank" rel="noopener" className="mt-1.5 inline-flex max-w-full items-center gap-1.5 text-[13.5px] font-medium text-blue-text hover:underline">
          <span className="truncate">{host(url)}</span><span aria-hidden>·</span>Open<ExternalLink size={13} />
        </a>
      )}
      {children && <div className="mt-5 text-left">{children}</div>}
    </div>
  );
}

// a quiet box of words under a section
export const Note = ({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn' | 'bad' | 'info'; children: ReactNode }) => (
  <p className={cx('rounded-[14px] px-3 py-2 text-[12.5px]', tone === 'warn' ? 'bg-[#f59e0b]/12 text-ink-2' : tone === 'bad' ? 'bg-bad/8 text-bad' : tone === 'info' ? 'bg-blue-soft text-blue-text' : 'bg-raised text-ink-2')}>{children}</p>
);
