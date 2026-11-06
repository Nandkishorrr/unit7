// "Which domain?" as a picker: a grid of option cards with logos and live facts (a domain's DNS host and
// subdomains, a website's host, status and address, a server's provider and health), search when there are
// many, one or several picks, and an "add new" card. Arrow keys move, Enter picks, Enter again continues.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, ArrowUpRight, Check, Globe, Plus, RotateCw } from 'lucide-react';
import { api } from '../../../lib/api';
import { BrandLogo, providerName } from '../../../brand/BrandLogo';
import { Badge, Button, Dot, SearchInput, Skeleton, cx } from '../../../ui';
import type { AskSource, ChoiceOption } from '../types';
import { AskFrame, Footer, SOURCE_WORDS, sourceIcon, type KindProps } from './kit';
import { Choices } from '../../choices';
import { pick } from '../../../lib/choices';

const NEW = '__new';
const SHOW = 8; // then "Show all"
const BADGE_TONE = { ok: 'ok', warn: 'warn', bad: 'bad', idle: 'neutral' } as const;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const hostOf = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '');

// the second line of a card, in plain words
function lineOf(o: ChoiceOption, source?: AskSource): string | undefined {
  if (o.detail) return o.detail;
  const host = o.provider && o.provider !== 'unit7' ? providerName(o.provider) : undefined;
  if (source === 'domains') return o.provider ? `DNS at ${providerName(o.provider)}` : 'DNS not connected';
  if (source === 'accounts') return o.provider ? providerName(o.provider) : undefined;
  if (source === 'apps' || source === 'databases' || source === 'servers') return [host, o.sub].filter(Boolean).join(' · ') || (o.provider === 'unit7' ? 'On Unit7' : undefined);
  return o.sub;
}

function useOptions(askId: string, source?: AskSource, given?: ChoiceOption[]) {
  const [s, set] = useState<{ list?: ChoiceOption[]; error?: string }>(source ? {} : { list: given ?? [] });
  const [n, retry] = useState(0);
  useEffect(() => {
    if (!source) return;
    let alive = true;
    set({});
    api<{ options: ChoiceOption[] }>(`/api/agent/asks/${askId}/options`).then((r) => alive && set({ list: r.options }), (e: Error) => alive && set({ error: e.message }));
    return () => { alive = false; };
  }, [askId, source, n]);
  return { ...s, retry: () => retry((x) => x + 1) };
}

// A few fixed options with one the AI recommends (ui.choose's recommended/why): the shared choice row, the
// recommended one in the strong style with its why under the row; a press answers. More, or live data: the cards.
export function Choose(props: KindProps<'choose'>) {
  const { spec, askId, busy, error, send } = props;
  const opts = spec.options ?? [];
  if (spec.source || spec.multiple || spec.allowNew || opts.length < 2 || opts.length > 4 || !opts.some((o) => o.recommended)) return <Cards {...props} />;
  const Icon = sourceIcon(spec.source);
  // the AI's own way out ("Not now") stands in for the card's
  const own = opts.some((o) => /^(not now|skip|cancel|no thanks|later|leave it)\b/i.test(o.label));
  return (
    <AskFrame icon={<Icon size={17} />} title={spec.title} note={spec.note} titleId={`${askId}-t`}
      footer={own ? (error ? <span role="alert" className="text-[12.5px] text-bad">{error}</span> : undefined) : <Footer onSkip={() => send({ cancelled: true }, 'Skipped')} busy={busy} error={error}>{null}</Footer>}>
      <Choices id={askId} size="md" label={spec.title} disabled={busy}
        choices={pick(opts.map((o) => ({ key: o.id, label: o.label, why: o.why, recommended: o.recommended, change: o.detail })))}
        onPick={(c) => { send({ choice: [c.key!], labels: [c.label] }, c.label); return true; }} />
    </AskFrame>
  );
}

function Cards({ spec, askId, busy, error, send }: KindProps<'choose'>) {
  const { list, error: loadError, retry } = useOptions(askId, spec.source, spec.options);
  // what the AI recommends is picked at first (its own preselect wins)
  const [sel, setSel] = useState<string[]>(() => (spec.preselect ? [spec.preselect] : spec.options?.filter((o) => o.recommended).slice(0, 1).map((o) => o.id) ?? []));
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const Icon = sourceIcon(spec.source);
  const words = spec.source ? SOURCE_WORDS[spec.source] : ['option', 'options'];

  const options = list ?? [];
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hit = t ? options.filter((o) => [o.label, o.detail, o.sub, o.url, o.provider && providerName(o.provider)].some((x) => x?.toLowerCase().includes(t))) : options;
    return all || t ? hit : hit.slice(0, SHOW);
  }, [options, q, all]);
  const ids = [...shown.map((o) => o.id), ...(spec.allowNew ? [NEW] : [])];
  // a preselect that isn't on the list doesn't count
  useEffect(() => { if (list && spec.preselect && !list.some((o) => o.id === spec.preselect)) setSel([]); }, [list]);

  const toggle = (id: string) => setSel((s) => {
    if (id === NEW || !spec.multiple) return s[0] === id && spec.multiple ? [] : [id];
    const rest = s.filter((x) => x !== NEW);
    return rest.includes(id) ? rest.filter((x) => x !== id) : [...rest, id];
  });
  const go = () => {
    if (!sel.length || busy) return;
    if (sel[0] === NEW) return send({ new: true }, spec.allowNew?.label);
    const picked = sel.map((x) => options.find((o) => o.id === x)).filter(Boolean) as ChoiceOption[];
    send({ choice: picked.map((o) => o.id), labels: picked.map((o) => o.label) }, picked.map((o) => o.label).join(', '));
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to = (j: number) => { e.preventDefault(); refs.current[(j + ids.length) % ids.length]?.focus(); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') to(i + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') to(i - 1);
    else if (e.key === 'Home') to(0);
    else if (e.key === 'End') to(ids.length - 1);
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!spec.multiple && sel[0] === ids[i]))) { e.preventDefault(); go(); }
  };
  const focusable = Math.max(0, ids.findIndex((x) => sel.includes(x)));
  const hidden = !q && !all ? options.length - shown.length : 0;

  return (
    <AskFrame icon={<Icon size={17} />} title={spec.title} note={spec.note} titleId={`${askId}-t`}
      footer={(
        <Footer onSkip={() => send({ cancelled: true }, 'Skipped')} busy={busy} error={error}>
          <Button variant="primary" onClick={go} disabled={!sel.length} loading={busy} className="min-w-[124px]">
            {spec.multiple && sel.length > 1 && sel[0] !== NEW ? `Use these ${sel.length}` : 'Continue'}{!busy && <ArrowRight size={15} />}
          </Button>
        </Footer>
      )}>
      {options.length > 6 && (
        <SearchInput value={q} onChange={setQ} placeholder={`Search ${options.length} ${words[1]}`} label={`Search ${words[1]}`} className="mb-3" />
      )}
      {!list && !loadError && (
        <div className="grid grid-cols-1 gap-2 @md:grid-cols-2" aria-busy="true" aria-label={`Loading your ${words[1]}`}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[74px] rounded-[18px]" />)}
        </div>
      )}
      {loadError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[16px] bg-bad/8 px-3.5 py-3 text-[13px] text-bad">
          <span className="flex-1">Couldn’t load your {words[1]}: {loadError}</span>
          <Button size="sm" variant="secondary" icon={<RotateCw size={13} />} onClick={retry}>Try again</Button>
        </div>
      )}
      {list && (
        <>
          {!options.length && <p className="mb-2 text-[13px] text-muted">No {words[1]} yet{spec.allowNew ? '.' : ' to pick from.'}</p>}
          {q && !shown.length && <p className="mb-2 text-[13px] text-muted">Nothing matches “{q}”.</p>}
          <div role="listbox" data-choices={askId} aria-labelledby={`${askId}-t`} aria-multiselectable={spec.multiple || undefined} className="stagger grid grid-cols-1 gap-2 @md:grid-cols-2">
            {shown.map((o, i) => (
              <OptionCard key={o.id} o={o} source={spec.source} on={sel.includes(o.id)} multiple={!!spec.multiple} tab={i === focusable}
                ref={(el) => { refs.current[i] = el; }} onPick={() => toggle(o.id)} onKey={(e) => onKey(e, i)} />
            ))}
            {spec.allowNew && (
              <button type="button" role="option" aria-selected={sel[0] === NEW} aria-label={spec.allowNew.label} tabIndex={ids.length - 1 === focusable ? 0 : -1}
                ref={(el) => { refs.current[ids.length - 1] = el; }} onClick={(e) => { e.currentTarget.focus(); toggle(NEW); }} onKeyDown={(e) => onKey(e, ids.length - 1)}
                className={cx('flex min-h-[74px] w-full items-center gap-3 rounded-[18px] border border-dashed p-3 text-left outline-none transition-[border,background,transform] duration-200 focus-visible:ring-4 focus-visible:ring-blue-soft active:scale-[0.99]',
                  sel[0] === NEW ? 'border-blue bg-blue-soft' : 'border-line-strong hover:border-blue/60 hover:bg-blue-soft/50')}>
                <span className="grid size-10 shrink-0 place-items-center rounded-[13px] bg-blue-soft text-blue-text"><Plus size={18} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-blue-text">{spec.allowNew.label}</span>
                  {spec.allowNew.hint && <span className="block truncate text-[12.5px] text-muted">{spec.allowNew.hint}</span>}
                </span>
                <Mark on={sel[0] === NEW} multiple={false} />
              </button>
            )}
          </div>
          {hidden > 0 && (
            <button type="button" onClick={() => setAll(true)} className="mt-2 inline-flex h-8 items-center rounded-full px-2.5 text-[12.5px] font-medium text-blue-text transition hover:bg-blue-soft">
              Show all {options.length}
            </button>
          )}
        </>
      )}
    </AskFrame>
  );
}

type CardProps = { o: ChoiceOption; source?: AskSource; on: boolean; multiple: boolean; tab: boolean; onPick: () => void; onKey: (e: KeyboardEvent<HTMLButtonElement>) => void; ref: (el: HTMLButtonElement | null) => void };
function OptionCard({ o, source, on, multiple, tab, onPick, onKey, ref }: CardProps) {
  const logo = o.logo ?? o.provider;
  const line = lineOf(o, source);
  const count = o.count ? (source === 'domains' ? plural(o.count, 'subdomain') : source === 'projects' ? plural(o.count, 'app') : undefined) : undefined;
  return (
    <button type="button" role="option" aria-selected={on} aria-label={[o.label, o.recommended && 'recommended', line, o.state?.text, count].filter(Boolean).join(', ')} tabIndex={tab ? 0 : -1} ref={ref} data-recommended={o.recommended || undefined}
      onClick={(e) => { e.currentTarget.focus(); onPick(); }} onKeyDown={onKey}
      className={cx('group flex min-h-[74px] w-full items-center gap-3 rounded-[18px] border p-3 text-left outline-none transition-[border,background,box-shadow,transform] duration-200 focus-visible:ring-4 focus-visible:ring-blue-soft active:scale-[0.99]',
        on ? 'border-blue bg-blue-soft/70 shadow-[inset_0_0_0_1px_var(--blue)]' : 'border-line bg-surface hover:border-line-strong hover:bg-raised/70')}>
      {(logo || source) && (
        <span className="grid size-10 shrink-0 place-items-center rounded-[13px] bg-raised text-ink">
          {logo ? <BrandLogo id={logo} size={21} /> : <Globe size={18} className="text-muted" />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[14px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">{o.label}{o.recommended && <span className="ai-btn ai-btn-strong ml-2 inline-flex h-5 items-center rounded-full px-2 align-[2px] text-[11px] font-semibold">Recommended</span>}</span>
        {o.recommended && o.why && <span className="block truncate text-[12px] text-blue-text">{o.why}</span>}
        {line && <span className="block truncate text-[12.5px] text-muted">{line}</span>}
        {(o.state || count || o.url) && (
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {o.state && <Badge tone={BADGE_TONE[o.state.tone]} className="h-5 gap-1.5 px-2 text-[11.5px]"><Dot tone={o.state.tone} />{o.state.text}</Badge>}
            {count && <span className="text-[12px] text-faint">{count}</span>}
            {o.url && <span className="inline-flex min-w-0 items-center gap-0.5 text-[12px] text-faint"><span className="truncate">{hostOf(o.url)}</span><ArrowUpRight size={11} className="shrink-0" /></span>}
          </span>
        )}
      </span>
      <Mark on={on} multiple={multiple} />
    </button>
  );
}

// the tick in a card's corner: round for one pick, square for several
function Mark({ on, multiple }: { on: boolean; multiple: boolean }) {
  return (
    <span aria-hidden className={cx('grid size-5 shrink-0 place-items-center border transition-[background,border,transform] duration-200', multiple ? 'rounded-[6px]' : 'rounded-full',
      on ? 'scale-100 border-blue bg-blue text-white' : 'scale-90 border-line-strong bg-surface text-transparent group-hover:border-faint')}>
      <Check size={12} strokeWidth={3} />
    </span>
  );
}
