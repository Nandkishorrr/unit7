// The Home chat thread: one renderer per role (types.ts), steps folded into a tidy "Working… 3 steps" list, live
// cards (cards.tsx) and asks (asks.tsx) in line, the AI's words appearing word by word, and a scroll area that
// follows the newest message until you scroll up.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Check, ChevronRight, CircleAlert, Info, Loader2, RotateCcw, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { api } from '../../lib/api';
import { A, Button, CopyButton, cx, toast, StatusMark, askAction, ErrorLine } from '../../ui';
import { rawWords, tidy, toolWords } from '../../lib/words';
import { toolCard } from './cards';
import { AskCard } from './asks';
import { StepChoices } from './StepChoices';
import { Choices } from '../choices';
import { approvalChoices, type Choice } from '../../lib/choices';
import { AboutChip } from './Picker';
import { sendAsk } from '../Agent';
import { connectOne, type Brains } from './BrainPicker';
import type { ContextItem } from './about';
import type { ChatMsg, ToolStep } from './types';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
type ToolMsg = Extract<ChatMsg, { role: 'tool' }>;

// --- the scroll area: sticks to the bottom while you're there; scroll up and it stays put, with a pill ---
// pin false (Home's greeting): it stays at the top, so a tall greeting never hides its first lines
export function ChatScroll({ children, follow, className, pin = true }: { children: ReactNode; follow: unknown; className?: string; pin?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(pin);
  const pinned = useRef(pin);
  pinned.current = pin;
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const toBottom = (smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAway(false); setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
  };
  useEffect(() => {
    const el = scroller.current!;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap < 56) { stick.current = true; setUnseen(false); } else if (el.scrollTop < lastTop.current - 1) stick.current = false; // you scrolled up
      lastTop.current = el.scrollTop;
      setAway(!stick.current);
    };
    // the thread grows as words stream in and cards load: follow it, or note there's something new below
    const ro = new ResizeObserver(() => { if (!pinned.current) return; if (stick.current) el.scrollTop = el.scrollHeight; else setUnseen(true); });
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(content.current!);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, []);
  // a new message you sent, or another conversation: jump to its end
  useLayoutEffect(() => { if (pin) toBottom(false); else scroller.current?.scrollTo({ top: 0 }); }, [follow, pin]);
  return (
    <div className={cx('relative min-h-0 flex-1', className)}>
      <div ref={scroller} className="h-full overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <div ref={content} className="flex min-h-full flex-col">{children}</div>
      </div>
      {away && pin && (
        <button type="button" onClick={() => toBottom(true)} aria-label={unseen ? 'New messages, scroll to the newest' : 'Scroll to the newest'}
          className={cx('animate-pop absolute bottom-3 left-1/2 z-10 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink text-[12.5px] font-medium text-bg shadow-float transition hover:opacity-90', unseen ? 'px-3.5' : 'w-9 justify-center')}>
          {unseen && 'New messages'}<ArrowDown size={14} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}

// --- the thread ---
type Item = { kind: 'one'; m: ChatMsg; card?: ReactNode } | { kind: 'steps'; list: ToolMsg[] };

export function Thread({ messages, conversationId, running, stalled, working, fresh, approvals, onRetry, brains }: {
  messages: ChatMsg[]; conversationId: string; running: boolean; working: string;
  stalled?: boolean;                                    // nothing can answer yet: offer to set one up
  brains?: Brains;
  fresh: (id: string) => boolean;                       // arrived live in this visit: animate it in, stream its words
  approvals: Map<string, string>;                       // approval id → its status now: pending, approved, done, failed, rejected, expired
  onRetry?: () => void;
}) {
  // quiet steps (running or done, no card) fold together; anything that needs you, or has a card, stands alone
  const items: Item[] = [];
  // a step still "running" in a conversation that isn't (stopped, or Unit7 restarted) didn't finish
  const shown = running ? messages : messages.map((m): ChatMsg => m.role === 'tool' && m.content.status === 'running' ? { ...m, content: { ...m.content, status: 'error', error: 'Stopped before it finished.' } } : m);
  for (const m of shown) {
    const card = m.role === 'tool' && m.content.status !== 'approval_required' ? toolCard(m.content, { conversationId }) : null;
    const quiet = m.role === 'tool' && !card && (m.content.status === 'running' || m.content.status === 'ok');
    const last = items[items.length - 1];
    if (quiet && last?.kind === 'steps') last.list.push(m as ToolMsg);
    else if (quiet) items.push({ kind: 'steps', list: [m as ToolMsg] });
    else items.push({ kind: 'one', m, card });
  }
  // the last thing the AI said in each turn gets a copy button (its answer); the narration before it doesn't
  const answers = new Set<string>();
  let said: string | undefined;
  for (const m of [...messages, undefined]) {
    if (!m || m.role === 'user') { if (said) answers.add(said); said = undefined; } else if (m.role === 'assistant') said = m.id;
  }
  const tail = messages[messages.length - 1];
  const busyStep = tail?.role === 'tool' && tail.content.status === 'running';
  // the newest failed step of the last turn answers with its choices once the run is over (a card shows its own)
  const turn = shown.slice(shown.findLastIndex((m) => m.role === 'user') + 1);
  const lastTool = running ? undefined : turn.findLast((m) => m.role === 'tool');
  const failed = lastTool?.role === 'tool' && lastTool.content.status === 'error' ? lastTool : undefined; // one the AI got past doesn't count
  const choicesAt = failed && !items.some((it) => it.kind === 'one' && it.m.id === failed.id && it.card) ? failed.id : undefined;
  const waitingAsk = tail?.role === 'ask' && tail.content.state === 'waiting';
  const one = brains && connectOne(brains);

  return (
    <div className="flex flex-col gap-3.5 pb-4 pt-2">
      {items.map((it, i) => {
        const prev = i > 0 ? items[i - 1] : undefined;
        const ai = it.kind === 'steps' || it.m.role !== 'user';
        const turnStart = ai && (!prev || (prev.kind === 'one' && prev.m.role === 'user'));
        const key = it.kind === 'steps' ? it.list[0]!.id : it.m.id;
        const isNew = fresh(key);
        // a fixed answer, or word that nothing can answer: no AI said it, so it doesn't wear the AI's mark
        const said = (it.kind === 'steps' ? it.list[0]! : it.m).content as { rule?: boolean; brain?: boolean };
        if (!ai && it.kind === 'one') return <UserBubble key={key} text={(it.m.content as { text: string }).text} about={(it.m.content as { context?: ContextItem[] }).context} animate={isNew} />;
        return (
          <div key={key} className={cx('relative sm:pl-10', turnStart && i > 0 && 'mt-2', isNew && 'animate-rise')}>
            {turnStart && !said.rule && !said.brain && <AiMark />}
            {it.kind === 'steps' ? <Steps list={it.list} approvals={approvals} />
              : <One m={it.m} card={it.card} conversationId={conversationId} approvals={approvals} stream={isNew} copy={answers.has(it.m.id)} choices={it.m.id === choicesAt}
                  onRetry={!running && it.m === tail && it.m.role === 'status' && (it.m.content.tone === 'bad' || (it.m.content.brain && !stalled)) ? onRetry : undefined} />}
          </div>
        );
      })}
      {running && !busyStep && (
        <div className="relative flex min-h-7 items-center gap-2.5 text-[13px] text-muted animate-rise sm:pl-10" role="status">
          {tail?.role === 'user' && <AiMark live />}
          <TypingDots /><Working text={waitingAsk ? 'Waiting for your answer above' : working} since={tail?.id ?? ''} />
        </div>
      )}
      {/* nothing can answer yet: what it can answer anyway, and one click to connect an AI */}
      {stalled && (
        <div className="animate-rise space-y-3 sm:pl-10">
          {tail?.role === 'status' && !!tail.content.asks?.length && (
            <div role="group" aria-label="What Unit7 can answer without an AI" className="flex flex-wrap gap-1.5">
              {tail.content.asks.map((a) => <Button key={a} size="sm" variant="soft" onClick={() => sendAsk(a)}>{a}</Button>)}
            </div>
          )}
          <Choices id="brain" label="Who answers" choices={[{ ...BRAIN[0]!, label: one?.label ?? BRAIN[0]!.label }, BRAIN[1]!]} onPick={(c) => (c.key === 'brain' ? (one ? one.go() : focusBrains(), true) : false)} />
        </div>
      )}
    </div>
  );
}

// no AI picked yet: "Set it up" goes to the two accounts in the ask box (Install / Sign in there), or an API key
const BRAIN: Choice[] = [
  { key: 'brain', label: 'Set it up', setup: { kind: 'brain' }, recommended: true, why: 'nothing can answer yet; your own Claude works, no API key needed' },
  { key: 'key', label: 'Add an API key', href: '/connections#ai' },
];
const focusBrains = () => {
  const b = document.querySelector<HTMLElement>('[data-brainstrip] button, [data-brainstrip] a');
  b?.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  b?.focus({ preventScroll: true });
};

function One({ m, card, conversationId, approvals, stream, copy, onRetry, choices }: { m: ChatMsg; card?: ReactNode; conversationId: string; approvals: Map<string, string>; stream: boolean; copy: boolean; onRetry?: () => void; choices?: boolean }) {
  if (m.role === 'assistant') return <Assistant text={m.content.text} stream={stream} copy={copy} rule={m.content.rule} />;
  if (m.role === 'status') return <StatusLine tone={m.content.tone} text={m.content.text} onRetry={onRetry} />;
  if (m.role === 'ask') return <AskCard ask={m.content} conversationId={conversationId} />;
  if (m.role === 'tool') return card ? <div className="min-w-0">{card}</div> : <StepRow step={m.content} approvals={approvals} framed choicesId={choices ? m.id : undefined} />;
  return null;
}

// Unit7's little sparkle beside the first thing it says in a turn; while it thinks, a soft ring breathes out of it
function AiMark({ live }: { live?: boolean }) {
  return (
    <span aria-hidden className={cx('absolute left-0 top-0 hidden size-7 place-items-center rounded-full bg-[linear-gradient(140deg,#7fa6ff,#1f5bff_55%,#7c4dff)] text-white shadow-[0_6px_14px_-6px_var(--blue)] sm:grid', live && 'ai-ping')}>
      <svg width="14" height="14" viewBox="0 0 24 24" className={cx(live && 'motion-safe:animate-[sparkle_2.4s_ease-in-out_infinite]')}><path d="M12 2c.8 5 2.9 7.2 8 8-5.1.8-7.2 3-8 8-.8-5-2.9-7.2-8-8 5.1-.8 7.2-3 8-8z" fill="currentColor" /></svg>
    </span>
  );
}
// three dots that hop in a little wave, blue to violet
function TypingDots() {
  return <span aria-hidden className="inline-flex items-end gap-[3px] pb-0.5">{['#1f5bff', '#5a4bff', '#8b5cf6'].map((c, i) => <span key={c} className="hop size-[6px] rounded-full" style={{ background: c, animationDelay: `${i * 140}ms` }} />)}</span>;
}
// what the AI is up to, in a voice: "Claude is thinking…", then "still on it" if it takes a while
function Working({ text, since }: { text: string; since: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => { setSecs(0); const t0 = Date.now(); const t = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000); return () => clearInterval(t); }, [since]);
  const who = /^(.+) is working…$/.exec(text)?.[1];
  const line = !who ? text : secs < 6 ? `${who} is thinking…` : secs < 25 ? `${who} is still on it…` : 'Taking a little longer. Hang tight…';
  return <span key={line} className="animate-[fade_.4s_ease-out_both]">{line}</span>;
}

// your message; what you picked for it to be about rides on top as chips
function UserBubble({ text, about, animate }: { text: string; about?: ContextItem[]; animate: boolean }) {
  return (
    <div className="flex justify-end pl-8 sm:pl-10">
      <div className={cx('max-w-[min(85%,680px)] origin-bottom-right whitespace-pre-wrap break-words rounded-[22px] rounded-br-[8px] bg-ink px-4 py-2.5 text-[14.5px] leading-relaxed text-bg', animate && 'animate-[bubble-in_.36s_var(--ease-out-soft)_both]')}>
        {!!about?.length && <span className="-mx-1 mb-1.5 flex flex-wrap gap-1 whitespace-normal" aria-label={`About ${about.map((c) => c.name).join(', ')}`}>{about.map((c) => <AboutChip key={c.id} item={c} dark className="h-6 text-[12px]" />)}</span>}
        {text}
      </div>
    </div>
  );
}

function Assistant({ text, stream, copy, rule }: { text: string; stream: boolean; copy: boolean; rule?: boolean }) {
  const shown = useTyped(text, stream);
  const typing = shown.length < text.length;
  return (
    <div className="group/msg relative min-w-0">
      <div className="max-w-[70ch] pt-0.5 text-[15px] leading-relaxed text-ink">
        <Prose text={rawWords(shown)} />
        {typing && <span aria-hidden className="ml-0.5 inline-block h-[1em] w-[3px] translate-y-[2px] rounded-full bg-blue animate-working" />}
      </div>
      {rule && !typing && <p className="mt-1 text-[12px] text-muted">A fixed answer from your own data. No AI was used.</p>}
      {copy && !typing && <CopyButton text={text} className="-ml-1.5 mt-0.5 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100" />}
    </div>
  );
}

// Text that grows (the server re-sends the same message longer) appears a word at a time, a little faster the
// further behind it is. Old messages, and reduced motion, show at once.
function useTyped(text: string, animate: boolean) {
  const at = useRef(animate ? 0 : text.length);
  const [, paint] = useState(0);
  useEffect(() => {
    if (!animate || reduced()) { at.current = text.length; paint((n) => n + 1); return; }
    let raf = 0, last = performance.now(), budget = 0;
    const tick = (t: number) => {
      const rest = text.length - at.current;
      if (rest <= 0) return;
      budget += ((t - last) / 1000) * Math.max(38, (rest / 5) * 2.5); // words a second (≈5 letters a word)
      last = t;
      let moved = false;
      while (budget >= 1 && at.current < text.length) {
        const next = text.slice(at.current).search(/\S\s/);
        at.current = next === -1 ? text.length : at.current + next + 2;
        budget -= 1; moved = true;
      }
      if (moved) paint((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, animate]);
  return text.slice(0, Math.min(at.current, text.length));
}

const TONE = {
  ok: { icon: Check, cls: 'bg-ok/10 text-ok' },
  info: { icon: Info, cls: 'bg-raised text-muted' },
  warn: { icon: TriangleAlert, cls: 'bg-warn/10 text-warn' },
  bad: { icon: CircleAlert, cls: 'bg-bad/10 text-bad' },
} as const;
function StatusLine({ tone, text, onRetry }: { tone: keyof typeof TONE; text: string; onRetry?: () => void }) {
  const t = TONE[tone] ?? TONE.info;
  return (
    <div className={cx('flex items-start gap-2.5 rounded-[16px] px-3.5 py-2.5 text-[13px]', t.cls)}>
      <t.icon size={15} aria-hidden className="mt-[2px] shrink-0" />
      <div className="min-w-0 flex-1 break-words">{tone === 'bad' && (text.includes('\n') || text.length > 180) ? <ErrorLine text={text} className="text-inherit" /> : <Prose text={tidy(text)} />}</div>
      {onRetry && <button type="button" onClick={onRetry} className="-my-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-surface px-3 text-[12.5px] font-medium text-ink shadow-soft transition hover:bg-raised"><RotateCcw size={12} />Try again</button>}
    </div>
  );
}

// --- steps ---
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const secs = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
function StepIcon({ s }: { s: ToolStep['status'] }) {
  return (
    <span className={cx('grid size-6 shrink-0 place-items-center rounded-full', s === 'ok' ? 'bg-ok/12' : s === 'running' ? 'bg-blue-soft' : s === 'approval_required' ? 'bg-warn/12' : 'bg-bad/10')}>
      {s === 'running' ? <Loader2 size={13} className="animate-spin text-blue-text" />
        : s === 'ok' ? <StatusMark state="ok" size={22} label="Done" />
        : s === 'approval_required' ? <ShieldAlert size={13} className="text-warn" />
        : <X size={13} strokeWidth={2.6} className="text-bad" />}
    </span>
  );
}

// several quiet steps in a row: one line ("Working… 3 steps"), open it for the list
function Steps({ list, approvals }: { list: ToolMsg[]; approvals: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  if (list.length === 1) return <StepRow step={list[0]!.content} approvals={approvals} framed />;
  const live = list.find((s) => s.content.status === 'running');
  const ms = list.reduce((n, s) => n + (s.content.durationMs ?? 0), 0);
  return (
    <div className="overflow-hidden rounded-[18px] border border-line bg-surface">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-raised">
        <StepIcon s={live ? 'running' : 'ok'} />
        <span className="min-w-0 flex-1 truncate text-[13.5px]">
          <span className="font-medium text-ink">{live ? 'Working…' : 'Done'}</span>
          <span className="text-muted"> · {list.length} steps{live ? ` · ${toolWords(live.content.tool, live.content.title)}` : ''}</span>
        </span>
        {!live && ms > 0 && <span className="tabular text-[12px] text-faint">{secs(ms)}</span>}
        <ChevronRight size={14} aria-hidden className={cx('shrink-0 text-faint transition-transform duration-200', open && 'rotate-90')} />
      </button>
      <div className={cx('grid transition-[grid-template-rows] duration-300 ease-out-soft', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <ol className="relative space-y-0.5 border-t border-line px-1 py-1.5">
            {list.map((s) => <li key={s.id}><StepRow step={s.content} approvals={approvals} /></li>)}
          </ol>
        </div>
      </div>
    </div>
  );
}

// what became of a step that asked for your OK, in the same words as the Approvals page
const DECIDED: Record<string, [string, string]> = {
  approved: ['Approved', 'text-ok'], done: ['Approved', 'text-ok'], failed: ['Approved, didn’t work', 'text-bad'], rejected: ['Not now', 'text-muted'], expired: ['Expired', 'text-muted'],
};
// one step: what it does in plain words, how long it took, its details; Approve right here when it needs you
function StepRow({ step, approvals, framed, choicesId }: { step: ToolStep; approvals: Map<string, string>; framed?: boolean; choicesId?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const decided = step.approvalId ? approvals.get(step.approvalId) : undefined;
  const asks = step.status === 'approval_required' && (decided ?? step.approvalState ?? 'pending') === 'pending';
  const said = step.status === 'approval_required' && decided ? DECIDED[decided] : undefined;
  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject');
    try {
      const r = await api(`/api/approvals/${step.approvalId}/${approve ? 'approve' : 'reject'}`, { body: {} });
      if (r.status === 'error') toast('bad', 'Approved, but it didn’t work', r.error.message, { action: askAction(`I approved an action and it didn’t work: “${r.error.message.slice(0, 240)}”. Why, and how do I fix it?`) });
      else if (r.status === 'denied') toast('bad', 'Your rules blocked it', r.why);
      else toast(approve ? 'ok' : 'info', approve ? 'Approved' : 'Okay, not now', approve ? undefined : 'Nothing was changed.');
    } catch (e) {
      toast('bad', 'Could not record that', (e as Error).message);
    } finally { setBusy(null); }
  };
  const details = step.input != null || step.output != null || !!step.error;
  const json = (v: unknown) => rawWords(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  return (
    <div data-approval={asks ? step.approvalId : undefined} className={cx(framed && 'overflow-hidden rounded-[18px] border bg-surface', framed && (asks ? 'border-warn/30 ring-4 ring-warn/8' : 'border-line'))}>
      <button type="button" onClick={() => details && setOpen((o) => !o)} aria-expanded={details ? open : undefined}
        className={cx('flex w-full items-center gap-2.5 rounded-[14px] px-3 py-2 text-left transition', details && 'hover:bg-raised', !framed && 'py-1.5')}>
        <StepIcon s={step.status} />
        <span className={cx('min-w-0 flex-1 truncate text-[13.5px]', step.status === 'running' ? 'text-ink' : 'text-ink-2')}>{toolWords(step.tool, step.title)}</span>
        {said && <span className={cx('text-[12px] font-medium', said[1])}>{said[0]}</span>}
        {step.durationMs != null && <span className="tabular text-[12px] text-faint">{secs(step.durationMs)}</span>}
        {details && <ChevronRight size={14} aria-hidden className={cx('shrink-0 text-faint transition-transform duration-200', open && 'rotate-90')} />}
      </button>
      {(step.status === 'denied' || step.status === 'error') && step.error && !open && <ErrorLine text={step.error} detail={step.detail} title={toolWords(step.tool, step.title)} className="px-3 pb-2.5 pl-[46px]" />}
      {choicesId && !open && <StepChoices id={choicesId} step={step} className="px-3 pb-3 sm:pl-[46px]" />}
      {asks && (
        <div className="border-t border-line bg-warn/[0.04] px-3 py-2.5">
          <p className="mb-2 text-[12.5px] text-ink-2">{step.why ? cap(tidy(step.why)) : 'This waits for your OK.'}</p>
          {/* Approve as recommended when Unit7 thinks it's safe; otherwise Review it first (the Approvals page) */}
          <Choices label="Your OK" disabled={!!busy} choices={approvalChoices({ why: step.why })}
            onPick={(c) => (c.key === 'approve' ? (void decide(true), true) : c.key === 'reject' ? (void decide(false), true) : false)} />
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2.5 animate-pop">
          {step.input != null && <pre className="max-h-48 overflow-auto rounded-[12px] bg-sunken p-3 font-mono text-[11.5px] text-ink-2">{json(step.input)}</pre>}
          {step.output != null && <pre className="max-h-72 overflow-auto rounded-[12px] bg-sunken p-3 font-mono text-[11.5px] text-ink-2">{json(step.output)}</pre>}
          {step.error && <ErrorLine text={step.error} detail={step.detail} title={toolWords(step.tool, step.title)} />}
        </div>
      )}
    </div>
  );
}

// --- markdown-light: paragraphs, lists, **bold**, `code`, ``` blocks, [links](…) and bare links ---
export function Prose({ text }: { text: string }) {
  const parts = text.split(/(```[^\n]*\n?[\s\S]*?(?:```|$))/g);
  return (
    <div className="space-y-2.5 break-words">
      {parts.map((p, i) => {
        if (!p) return null;
        if (p.startsWith('```')) {
          const code = p.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').replace(/\n$/, '');
          return (
            <div key={i} className="group/code relative">
              <pre className="overflow-x-auto rounded-[14px] bg-sunken px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink-2">{code}</pre>
              <CopyButton text={code} className="absolute right-1.5 top-1.5 bg-surface/80 opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100" />
            </div>
          );
        }
        return <Fragment key={i}>{blocks(p)}</Fragment>;
      })}
    </div>
  );
}
const LIST = /^\s*([-*•]|\d+[.)])\s+/;
function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let para: string[] = [], list: { ordered: boolean; start: number; items: string[] } | null = null;
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{para.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l.replace(/^#{1,6}\s+/, ''), /^#{1,6}\s/.test(l))}</Fragment>)}</p>);
    if (list) {
      const L = list.ordered ? 'ol' : 'ul';
      out.push(<L key={out.length} start={list.ordered && list.start !== 1 ? list.start : undefined} className={cx('space-y-1 pl-5', list.ordered ? 'list-decimal' : 'list-disc marker:text-faint')}>{list.items.map((t, i) => <li key={i} className="pl-0.5">{inline(t)}</li>)}</L>);
    }
    para = []; list = null;
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) { flush(); continue; }
    const m = LIST.exec(line);
    if (m) {
      const ordered = /\d/.test(m[1]!);
      if (para.length || (list && list.ordered !== ordered)) flush();
      (list ??= { ordered, start: parseInt(m[1]!, 10) || 1, items: [] }).items.push(line.slice(m[0].length));
    } else if (list && /^\s{2,}\S/.test(line)) list.items[list.items.length - 1] += ` ${line.trim()}`;
    else { if (list) flush(); para.push(line); }
  }
  flush();
  return out;
}
const INLINE = /(\*\*[^*]+(?:\*\*|$)|(?<![\w*])[*_][^*_\s][^*_\n]*(?<!\s)[*_](?![\w*])|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|\/(?!\/))[^)\s]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
function inline(text: string, strong = false): ReactNode {
  const nodes = text.split(INLINE).map((p, i) => {
    if (i % 2 === 0) return p;
    if (p.startsWith('**')) return <strong key={i} className="font-semibold text-ink">{p.replace(/^\*\*|\*\*$/g, '')}</strong>;
    if (/^[*_]/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
    if (p.startsWith('`')) return <code key={i} className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[0.86em] text-ink">{p.slice(1, -1)}</code>;
    const md = /^\[([^\]]+)\]\((.+)\)$/.exec(p);
    const href = md ? md[2]! : p;
    if (href.startsWith('/')) return <A key={i} href={href} className="font-medium text-blue-text underline decoration-blue-text/30 underline-offset-2 hover:decoration-blue-text">{md![1]}</A>; // a page of Unit7's own
    return <a key={i} href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-blue-text underline decoration-blue-text/30 underline-offset-2 hover:decoration-blue-text">{md ? md[1] : p.replace(/^https?:\/\//, '')}</a>;
  });
  return strong ? <strong className="font-semibold text-ink">{nodes}</strong> : nodes;
}
