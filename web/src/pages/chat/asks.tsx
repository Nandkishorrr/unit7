// Interactive asks in the Home chat: pickers, confirmations and small forms the AI shows instead of asking in
// text. While it waits, the card is live; once answered it folds into one line ("Which domain? example.com"),
// and an ask nobody answered in time (or that Stop ended) says so.
import { useEffect, useState } from 'react';
import { Check, CircleSlash, Clock } from 'lucide-react';
import { api, type ApiError } from '../../lib/api';
import { BrandLogo } from '../../brand/BrandLogo';
import { cx } from '../../ui';
import type { Ask, AskAnswer } from './types';
import { Choose } from './asks/Choose';
import { Confirm } from './asks/Confirm';
import { FolderAsk } from './asks/Folder';
import { Form } from './asks/Form';
import { Hide } from './asks/Hide';
import { DeleteAsk } from './asks/Delete';
import { answerWords } from './asks/kit';

export function AskCard({ ask }: { ask: Ask; conversationId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<{ answer: AskAnswer; words: string }>(); // answered here; the thread catches up live
  const [gone, setGone] = useState(false); // the server says it isn't open anymore
  const late = useExpired(ask.expiresAt, ask.state === 'waiting' && !sent);

  const send = async (answer: AskAnswer, words?: string) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await api(`/api/agent/asks/${ask.askId}`, { body: answer });
      setSent({ answer, words: words ?? answerWords(ask.spec, answer) });
    } catch (e) {
      if ((e as ApiError).status === 409) setGone(true); else setError((e as Error).message);
    } finally { setBusy(false); }
  };

  if (ask.state === 'answered' && ask.answer) return <Summary ask={ask} answer={ask.answer} words={answerWords(ask.spec, ask.answer)} />;
  if (sent) return <Summary ask={ask} answer={sent.answer} words={sent.words} />;
  if (ask.state === 'cancelled') return <Closed icon={<CircleSlash size={14} />} text="Stopped before you answered" title={ask.spec.title} />;
  if (ask.state === 'expired' || late || gone) return <Closed icon={<Clock size={14} />} text="No answer in time" title={ask.spec.title} />;
  const props = { askId: ask.askId, busy, error, send };
  if (ask.spec.kind === 'choose') return <Choose spec={ask.spec} {...props} />;
  if (ask.spec.kind === 'confirm') return <Confirm spec={ask.spec} {...props} />;
  if (ask.spec.kind === 'hide') return <Hide spec={ask.spec} {...props} />;
  if (ask.spec.kind === 'delete') return <DeleteAsk spec={ask.spec} {...props} />;
  if (ask.spec.kind === 'folder') return <FolderAsk spec={ask.spec} {...props} />;
  return <Form spec={ask.spec} {...props} />;
}

// true once an open ask's time is up (the server says so too, unless it restarted in between)
function useExpired(at: string | undefined, open: boolean) {
  const [, tick] = useState(0);
  const ms = at ? Date.parse(at) - Date.now() : Infinity;
  useEffect(() => {
    if (!open || !Number.isFinite(ms) || ms <= 0) return;
    const t = setTimeout(() => tick((x) => x + 1), ms + 250);
    return () => clearTimeout(t);
  }, [at, open]);
  return open && ms <= 0;
}

// the answer, folded into one line
function Summary({ ask, answer, words }: { ask: Ask; answer: AskAnswer; words: string }) {
  const no = 'cancelled' in answer || ('ok' in answer && !answer.ok) || ('hidden' in answer && !answer.hidden);
  const first = 'choice' in answer ? (answer.items?.[0] as { dns?: string; provider?: string } | undefined) : undefined;
  const logo = 'choice' in answer ? ask.spec.kind === 'choose' && ask.spec.options?.find((o) => o.id === answer.choice[0])?.logo || first?.dns || (first?.provider !== 'unit7' ? first?.provider : undefined) : undefined;
  return (
    <div role="status" title={`${ask.spec.title} ${words}`}
      className="animate-pop inline-flex max-w-full items-center gap-2.5 rounded-[20px] border border-line bg-surface py-1.5 pl-1.5 pr-4 shadow-soft">
      <span className={cx('grid size-7 shrink-0 place-items-center rounded-full', no ? 'bg-raised text-muted' : 'bg-lime text-lime-ink')}>
        {no ? <CircleSlash size={14} /> : <Check size={14} strokeWidth={3} />}
      </span>
      {logo && <BrandLogo id={logo} size={16} />}
      <span className="line-clamp-2 min-w-0 text-[13.5px] leading-snug"><span className="text-muted">{ask.spec.title} </span><span className="font-medium text-ink">{words}</span></span>
    </div>
  );
}

function Closed({ icon, text, title }: { icon: React.ReactNode; text: string; title: string }) {
  return (
    <div role="status" className="animate-pop inline-flex max-w-full items-center gap-2.5 rounded-[20px] border border-dashed border-line-strong py-1.5 pl-1.5 pr-4 text-[13px] text-muted">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-raised">{icon}</span>
      <span className="line-clamp-2 min-w-0 leading-snug">{text} · <span className="text-ink-2">{title}</span></span>
    </div>
  );
}
