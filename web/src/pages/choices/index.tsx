// The one way a decision looks in Unit7: a row of two to four real buttons (lib/choices.ts builds them), the one we
// recommend in the strong animated AI style with "Recommended: … because …" under the row, the others calm. Keys 1–4
// pick one while the row has focus; on phones they stack with the recommended one first. A click runs the tool as the
// person (through the gate), opens the page, sends the sentence to Unit7's AI, or opens what needs setting up; risky
// ones are held to confirm or need the name typed. Afterwards the row folds into one line, with Undo where there is one.
// openChoices shows a row in a small pop-up (a toast's "More"); mount <ChoicesHost /> once.
import { useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUpRight, Check, ListChecks, Plus, RefreshCw, Undo2, UserRound, Wand2 } from 'lucide-react';
import { A, AiButton, Button, HoldButton, Modal, act, cx, promptDialog } from '../../ui';
import { navigate } from '../../lib/router';
import { tidy } from '../../lib/words';
import { setupHref, type Choice, type Setup } from '../../lib/choices';
import { askOnHome } from '../Help';
import { openDomainLaunch } from '../flow/DomainLaunch';
import { openCoolifyDomain } from '../servers/CoolifyDomain';
import { confirmField, runAct, type ActResult } from '../watch/QuickFix';

export type { Choice };
type Act = { tool: string; input: Record<string, unknown>; label: string };
type St = { s: 'idle' } | { s: 'busy'; at: number } | { s: 'done'; label: string; undo?: Act; checked?: boolean } | { s: 'undone' } | { s: 'wait' } | { s: 'error'; why: string; at: number } | { s: 'asked'; label: string };

const open = (href: string) => (/^https?:\/\//.test(href) ? window.open(href, '_blank', 'noopener') : navigate(href));
// a setup outside the chat: its page, or the domain pop-up
export function openSetup(s: Setup) {
  if (s.kind === 'domain') return openDomainLaunch();
  const href = setupHref(s);
  if (href) navigate(href);
}

// the typed name, when the choice is hard to undo; null when they backed out
async function typed(c: Choice): Promise<Record<string, unknown> | null> {
  const input = c.input ?? {};
  if (!c.typeName || !c.tool) return input;
  const t = await promptDialog({ title: `${c.label}?`, label: `Type ${c.typeName} to confirm`, placeholder: c.typeName, hint: c.change, confirm: c.label,
    warn: (v) => (v && v.toLowerCase() !== c.typeName!.toLowerCase() ? 'That isn’t the name.' : undefined) });
  return t && t.toLowerCase() === c.typeName.toLowerCase() ? { ...input, [confirmField(c.tool)]: t } : null;
}

// Run one choice away from a row (a toast's button): tools through act(), so its toast says what happened
export async function runChoice(c: Choice) {
  if (c.setup) return openSetup(c.setup);
  if (c.flow) return openCoolifyDomain(c.flow.serverId);
  if (c.href) return open(c.href);
  if (c.ask) return askOnHome(c.ask, { send: true });
  if (c.tool) { const input = await typed(c); if (input) await act(c.tool, input, { success: 'Done' }); }
}

const ICON = (c: Choice, size: number): ReactNode =>
  c.setup ? <Plus size={size} /> : c.steps ? <ListChecks size={size} /> : c.look && (c.tool || c.key === 'check') ? <RefreshCw size={size} /> : c.tool || c.flow ? <Wand2 size={size} /> : undefined;

// onPick: the caller runs it its own way (Resolve's checks, Approve, an ask's answer, a setup in the chat) and returns
// true; anything else and the row runs it. id: data-choices, so the ask box's Tab can focus the recommended one.
// extra: something quieter at the end of the row (the Map's "This is fine")
export function Choices({ choices, onPick, onDone, size = 'sm', label = 'Your choices', id, disabled, why = true, extra, className }: {
  choices: Choice[]; onPick?: (c: Choice) => unknown; onDone?: (c: Choice) => void; size?: 'sm' | 'md'; label?: string; id?: string; disabled?: boolean; why?: boolean; extra?: ReactNode; className?: string;
}) {
  const [st, setSt] = useState<St>({ s: 'idle' });
  const [steps, setSteps] = useState<number | null>(null);
  if (!choices.length) return null;
  const rec = choices.find((c) => c.recommended);
  const busy = st.s === 'busy' || !!disabled;

  const go = async (c: Choice, at: number) => {
    if (busy) return;
    if (c.steps && !c.tool) { setSteps((s) => (s === at ? null : at)); return; }
    if (onPick && (await onPick(c)) === true) return;
    if (c.setup) return openSetup(c.setup);
    if (c.flow) return openCoolifyDomain(c.flow.serverId);
    if (c.href) return open(c.href);
    if (c.ask) { setSt({ s: 'asked', label: c.label }); askOnHome(c.ask, { send: true }); return onDone?.(c); }
    if (!c.tool) return;
    const input = await typed(c);
    if (!input) return;
    setSt({ s: 'busy', at });
    const r: ActResult = await runAct({ tool: c.tool, input, label: c.label });
    if (r.s === 'done') { setSt({ s: 'done', label: c.look ? `${c.label}: done` : c.label, undo: r.undo, checked: r.checked }); onDone?.(c); }
    else if (r.s === 'wait') setSt({ s: 'wait' });
    else if (r.s === 'no') setSt({ s: 'error', why: r.why, at });
  };
  const undo = async (a: Act) => { setSt({ s: 'busy', at: -1 }); const r = await runAct(a); setSt(r.s === 'done' ? { s: 'undone' } : r.s === 'no' ? { s: 'error', why: r.why, at: -1 } : { s: 'wait' }); };

  // the row folded into one line
  if (st.s === 'done') return (
    <p role="status" data-choices={id} className={cx('flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] animate-pop', className)}>
      <span className="inline-flex items-center gap-1.5 font-medium text-ok"><Check size={14} strokeWidth={3} />{st.checked ? 'Fixed and checked' : 'Done'}</span>
      <span className="min-w-0 text-ink-2">{st.label}</span>
      {st.undo && <button type="button" onClick={() => void undo(st.undo!)} className="inline-flex h-7 items-center gap-1 rounded-full px-2 font-medium text-muted transition hover:bg-raised hover:text-ink"><Undo2 size={12} />{st.undo.label || 'Undo'}</button>}
    </p>
  );
  if (st.s === 'undone') return <p role="status" data-choices={id} className={cx('flex min-h-8 items-center text-[12.5px] text-muted animate-pop', className)}>Put back the way it was</p>;
  if (st.s === 'asked') return <p role="status" data-choices={id} className={cx('flex min-h-8 items-center gap-1.5 text-[12.5px] text-ink-2 animate-pop', className)}><Check size={14} strokeWidth={3} className="text-ok" />Asked Unit7: {st.label}</p>;
  if (st.s === 'wait') return <A href="/approvals" className={cx('inline-flex min-h-8 items-center gap-1 text-[12.5px] font-medium text-warn hover:underline', className)}>Waiting for your OK<ArrowUpRight size={12} /></A>;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-4]$/.test(e.key) || (e.target as HTMLElement).closest('input, textarea, select')) return;
    const n = Number(e.key) - 1, c = choices[n];
    if (!c) return;
    e.preventDefault();
    if (c.risk === 'danger' && !c.typeName) { e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button')[n]?.focus(); return; } // a held one is still held
    void go(c, n);
  };
  const h = size === 'md' ? 'h-10 px-4.5 text-[13.5px]' : 'h-8 px-3.5 text-[12.5px]';
  return (
    <div data-choices={id} className={cx('min-w-0', className)}>
      <div role="group" aria-label={label} onKeyDown={onKey} className="group/choices flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {choices.map((c, n) => {
          const isRec = !!c.recommended;
          const hint = <span aria-hidden className={cx('hidden size-[18px] place-items-center rounded-[6px] text-[10.5px] font-semibold tabular pointer-fine:group-focus-within/choices:inline-grid', isRec ? 'bg-white/20 text-white' : 'bg-raised text-muted')}>{n + 1}</span>;
          const title = [c.change && tidy(c.change), c.peopleOnly && 'Only a person can do this'].filter(Boolean).join(' · ') || undefined;
          const common = { 'data-choice': '', 'data-recommended': isRec || undefined, 'aria-keyshortcuts': String(n + 1), title, disabled: busy, className: cx('max-sm:w-full', isRec && 'max-sm:order-first') } as const;
          const loading = st.s === 'busy' && st.at === n;
          if (c.risk === 'danger' && !c.typeName) return (
            <HoldButton key={c.label} size={size} loading={loading} disabled={busy} onConfirm={() => go(c, n)} icon={ICON(c, 13)}
              className={cx(isRec ? 'ai-btn ai-btn-strong choice-rec max-sm:order-first' : 'border border-line-strong bg-surface text-ink hover:bg-raised', 'max-sm:w-full')} fillClassName={isRec ? 'bg-white/25' : 'bg-bad/15'}>{c.label}</HoldButton>
          );
          return isRec
            ? <AiButton key={c.label} strong size={size} {...common} className={cx(common.className, 'choice-rec')} loading={loading} icon={ICON(c, size === 'md' ? 15 : 13)} onClick={() => void go(c, n)}>
                {c.label}{c.href && !c.setup && <ArrowUpRight size={12} />}{c.peopleOnly && <UserRound size={12} aria-hidden className="opacity-80" />}{hint}
              </AiButton>
            : <Button key={c.label} size={size} variant="secondary" {...common} className={cx(common.className, h)} loading={loading} icon={ICON(c, 13)} onClick={() => void go(c, n)}>
                {c.label}{c.href && !c.setup && <ArrowUpRight size={12} className="text-muted" />}{c.peopleOnly && <UserRound size={12} aria-hidden className="text-muted" />}{hint}
              </Button>;
        })}
        {extra}
      </div>
      {why && rec?.why && <p className="mt-2 text-[12px] leading-snug text-muted"><span className="font-medium text-ink-2">Recommended:</span> {rec.label} because {rec.why.replace(/[.\s]+$/, '')}.</p>}
      {st.s === 'error' && <p role="alert" className="mt-2 text-[12.5px] text-bad">{tidy(st.why)}</p>}
      {steps !== null && choices[steps]?.steps && (
        <ol className="mt-2.5 list-decimal space-y-1 rounded-[14px] bg-raised py-2.5 pl-8 pr-3 text-[12.5px] text-ink-2 animate-pop">{choices[steps]!.steps!.map((m, i) => <li key={i}>{tidy(m)}</li>)}</ol>
      )}
    </div>
  );
}

// --- a row in a small pop-up: the full choices behind a toast's "More" --------------------------------------------
let shown: { title: string; body?: string; choices: Choice[] } | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());
export function openChoices(o: { title: string; body?: string; choices: Choice[] }) { shown = o; tell(); }
export function ChoicesHost() {
  const o = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => shown);
  const close = () => { shown = null; tell(); };
  return (
    <Modal open={!!o} onClose={close} size="sm" title={o?.title ?? ''}>
      {o && <div className="space-y-4">
        {o.body && <p className="text-[13.5px] text-ink-2 [overflow-wrap:anywhere]">{tidy(o.body)}</p>}
        <Choices choices={o.choices} size="md" onPick={(c) => { if (c.href || c.ask || c.setup || c.flow) close(); }} />
      </div>}
    </Modal>
  );
}
