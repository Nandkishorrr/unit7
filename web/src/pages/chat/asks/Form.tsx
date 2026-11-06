// A few values the AI needs, as a small form: text, numbers, a choice (pills when there are few), and secrets,
// which are masked and go straight to the vault (the AI only ever gets where it's stored).
import { useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, PenLine } from 'lucide-react';
import { Button, Input, Select, cx } from '../../../ui';
import type { AskSpec } from '../types';
import { AskFrame, Footer, answerWords, type KindProps } from './kit';

type Field = Extract<AskSpec, { kind: 'form' }>['fields'][number];
const problem = (f: Field, v: string) => (!v.trim() ? (f.required ? `${f.label} is needed.` : undefined)
  : f.type === 'number' && !Number.isFinite(Number(v)) ? 'Use a number.' : undefined);

export function Form({ spec, askId, busy, error, send }: KindProps<'form'>) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(spec.fields.map((f) => [f.id, f.type === 'secret' ? '' : f.initial ?? ''])));
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [tried, setTried] = useState(false);
  const box = useRef<HTMLFormElement>(null);
  const formId = `${askId}-form`;
  const problems = Object.fromEntries(spec.fields.map((f) => [f.id, problem(f, values[f.id] ?? '')] as const).filter(([, p]) => p));
  const set = (id: string, v: string) => setValues((s) => ({ ...s, [id]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    const bad = spec.fields.find((f) => problems[f.id]);
    if (bad) return box.current?.querySelector<HTMLElement>(`[name="${bad.id}"]`)?.focus();
    const answer = { values: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())) };
    send(answer, answerWords(spec, answer));
  };

  return (
    <AskFrame icon={<PenLine size={16} />} title={spec.title} note={spec.note} titleId={`${askId}-t`}
      footer={(
        <Footer onSkip={() => send({ cancelled: true }, 'Skipped')} busy={busy} error={error}>
          <Button type="submit" form={formId} variant="primary" loading={busy} className="min-w-[124px]">{spec.submitLabel ?? 'Send'}</Button>
        </Footer>
      )}>
      <form id={formId} ref={box} onSubmit={submit} noValidate className="stagger space-y-3.5">
        {spec.fields.map((f) => {
          const id = `${askId}-${f.id}`, err = tried ? problems[f.id] : undefined, v = values[f.id] ?? '';
          return (
            <div key={f.id}>
              <label htmlFor={id} id={`${id}-l`} className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-ink-2">
                {f.label}{!f.required && <span className="font-normal text-faint">optional</span>}
              </label>
              {f.type === 'select' && (f.options?.length ?? 0) <= 4 ? (
                <div role="radiogroup" aria-labelledby={`${id}-l`} id={id} className="flex flex-wrap gap-1.5">
                  {f.options!.map((o, i) => (
                    <button key={o} type="button" role="radio" aria-checked={v === o} name={i === 0 ? f.id : undefined} onClick={() => set(f.id, o)}
                      className={cx('h-9 rounded-full border px-4 text-[13px] font-medium transition-[background,border,color] duration-150 outline-none focus-visible:ring-4 focus-visible:ring-blue-soft',
                        v === o ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2 hover:bg-raised')}>{o}</button>
                  ))}
                </div>
              ) : f.type === 'select' ? (
                <Select value={v} onChange={(x) => set(f.id, x)} options={[{ value: '', label: f.placeholder ?? 'Choose…' }, ...f.options!.map((o) => ({ value: o, label: o }))]} className="w-full" />
              ) : (
                <div className="relative">
                  <Input id={id} name={f.id} value={v} onChange={(e) => set(f.id, e.target.value)} placeholder={f.placeholder} aria-invalid={!!err || undefined} aria-describedby={err ? `${id}-err` : f.type === 'secret' ? `${id}-hint` : undefined}
                    type={f.type === 'secret' && !reveal[f.id] ? 'password' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined}
                    autoComplete={f.type === 'secret' ? 'new-password' : 'off'} spellCheck={f.type === 'secret' ? false : undefined}
                    className={cx(f.type === 'secret' && 'pr-11 font-mono', err && 'border-bad focus:border-bad focus:ring-bad/15')} />
                  {f.type === 'secret' && (
                    <button type="button" onClick={() => setReveal((r) => ({ ...r, [f.id]: !r[f.id] }))} aria-label={reveal[f.id] ? `Hide ${f.label}` : `Show ${f.label}`}
                      className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink">
                      {reveal[f.id] ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  )}
                </div>
              )}
              {err ? <p id={`${id}-err`} className="mt-1 text-[12.5px] text-bad">{err}</p>
                : f.type === 'secret' && <p id={`${id}-hint`} className="mt-1 flex items-center gap-1.5 text-[12px] text-muted"><Lock size={12} aria-hidden />Saved in your vault. The AI only gets a reference to it.</p>}
            </div>
          );
        })}
      </form>
    </AskFrame>
  );
}
