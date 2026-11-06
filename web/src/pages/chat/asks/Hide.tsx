// "Hide “shop.example.com is down” for 7 days?": an AI never hides anything itself. The person picks how long and
// presses Hide it, which runs "This is fine" (snooze.set) as them, the same as on every list; then the AI hears back.
// A serious one can only be hidden for a while.
import { useState } from 'react';
import { EyeOff } from 'lucide-react';
import { Button, cx } from '../../../ui';
import { hide, type SnoozeFor } from '../../explain';
import { AskFrame, Footer, type KindProps } from './kit';

const CHOICES: { value: SnoozeFor; label: string; until: string }[] = [
  { value: 'tomorrow', label: 'Until tomorrow', until: 'until tomorrow' }, { value: '7d', label: '7 days', until: 'for 7 days' },
  { value: '15d', label: '15 days', until: 'for 15 days' }, { value: 'forever', label: 'For good', until: 'for good' },
];
// short enough for a title: cut on a word near 64 characters
const clip = (t: string) => {
  const s = t.replace(/\.$/, '');
  if (s.length <= 66) return s;
  const cut = s.lastIndexOf(' ', 64);
  return `${s.slice(0, cut > 40 ? cut : 64).replace(/[,:;]$/, '')}…`;
};

export function Hide({ spec, askId, busy, error, send }: KindProps<'hide'>) {
  const serious = spec.severity === 'critical';
  const [f, setF] = useState<SnoozeFor>(serious && spec.for === 'forever' ? '7d' : spec.for);
  const [working, setWorking] = useState(false);
  const pick = CHOICES.find((c) => c.value === f)!;
  const go = async () => {
    setWorking(true);
    const ok = await hide(spec.key, f, { title: spec.what.slice(0, 200), kind: spec.itemKind, severity: spec.severity });
    setWorking(false);
    if (ok) send({ done: true }, f === 'forever' ? 'Fine for good' : `Hidden ${pick.until}`);
  };
  return (
    <AskFrame icon={<EyeOff size={17} />} tone={serious ? 'bad' : 'soft'} title={`Hide “${clip(spec.what)}” ${pick.until}?`} note={spec.note} titleId={`${askId}-t`}
      footer={(
        <Footer onSkip={() => send({ cancelled: true }, 'Kept it showing')} skipLabel="Keep showing it" busy={busy || working} error={error}>
          <Button variant="primary" icon={<EyeOff size={15} />} loading={busy || working} onClick={() => void go()} className="min-w-[124px]">Hide it</Button>
        </Footer>
      )}>
      <div role="radiogroup" aria-label="For how long" className="flex flex-wrap gap-1.5">
        {CHOICES.map((c) => {
          const off = c.value === 'forever' && serious;
          return (
            <button key={c.value} type="button" role="radio" aria-checked={f === c.value} disabled={off} onClick={() => setF(c.value)}
              title={off ? 'Serious ones can only be hidden for a while' : undefined}
              className={cx('h-9 rounded-full px-3.5 text-[13px] font-medium transition active:scale-[0.97] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-45',
                f === c.value ? 'bg-ink text-bg' : 'bg-raised text-ink-2 enabled:hover:bg-sunken enabled:hover:text-ink')}>{c.label}</button>
          );
        })}
      </div>
      <p className="mt-2.5 text-[12.5px] text-muted">
        {serious ? 'It’s serious, so it can only be hidden for a while. ' : ''}{f === 'forever' ? 'Unit7 stops showing it and won’t alert you. Hidden in Settings brings it back.' : 'It comes back by itself if it’s still there.'}
      </p>
    </AskFrame>
  );
}
