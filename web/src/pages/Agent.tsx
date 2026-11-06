// The conversation with Unit7's AI: the thread's state (load, follow live, send, stop) and the ask box. Home lays
// them out full screen (Home.tsx); the thread itself renders in chat/Thread.tsx.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, AtSign, Square } from 'lucide-react';
import { api, onLive, useApi, useConnected, type ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import { AiSparkle, Button, cx, toast } from '../ui';
import { BrainPicker, BrainStrip, BridgeChip, useBrains, type BrainStatus } from './chat/BrainPicker';
import { AboutChip, ContextPicker } from './chat/Picker';
import type { ContextItem, PickItem } from './chat/about';
import type { ChatMsg } from './chat/types';
import type { NextReply } from './chat/next';

// Put a request in the ask box from anywhere on the page (quick actions, card buttons), with what it's about as chips…
type Ask = { text: string; context?: ContextItem[] };
export function fillAsk(text: string, context?: ContextItem[]) { window.dispatchEvent(new CustomEvent<Ask>('unit7:ask', { detail: { text, context } })); }
// …or send it straight away (a card's button that is itself the request)
export function sendAsk(text: string, context?: ContextItem[]) { window.dispatchEvent(new CustomEvent<Ask>('unit7:send', { detail: { text, context } })); }
const askOf = (e: Event): Ask => { const d = (e as CustomEvent<Ask | string>).detail; return typeof d === 'string' ? { text: d } : d; };
const bare = (c: ContextItem[]) => c.map(({ kind, id, name }) => ({ kind, id, name }));

const upsert = (list: ChatMsg[], m: ChatMsg) => {
  const i = list.findIndex((x) => x.id === m.id);
  if (i === -1) return [...list, m];
  const next = list.slice();
  next[i] = m;
  return next;
};
const urlFor = (id: string | null) => window.history.replaceState(null, '', id ? `/?c=${id}` : '/');

export function useChat() {
  const [convId, setConvId] = useState<string | null>(() => new URLSearchParams(location.search).get('c'));
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [nonce, setNonce] = useState(0);   // bumps to jump to the end (a message you sent, another conversation)
  const live = useRef(new Set<string>());  // arrived while you watched: these animate in and stream word by word
  const streamLoad = useRef(false);        // the first load of a conversation you just started streams too
  const connected = useConnected();
  // refreshed when your AI picks something up or finishes, and every 10s (to notice it start listening)
  const status = useApi<BrainStatus>('/api/agent/status', { live: (e) => e.type === 'agent.claimed' || e.type === 'agent.done' || e.type === 'agent.queued' });
  useEffect(() => { const t = setInterval(() => status.reload(), 10_000); return () => clearInterval(t); }, []);

  // load a conversation, then follow it live; again after the live connection comes back
  useEffect(() => {
    if (!convId) return;
    let alive = true, loaded = false;
    const early: ChatMsg[] = [];
    api<{ messages: ChatMsg[]; running: boolean }>(`/api/agent/conversations/${convId}`).then((r) => {
      if (!alive) return;
      if (streamLoad.current) { r.messages.forEach((m) => m.role !== 'user' && live.current.add(m.id)); streamLoad.current = false; }
      setMessages(early.reduce(upsert, r.messages));
      setRunning(r.running);
      setFailed(null);
      loaded = true;
    }).catch((e: ApiError) => {
      if (!alive) return;
      if (e.status === 404) { setConvId(null); setMessages([]); urlFor(null); } else setFailed(e.message);
    });
    const off = onLive((e) => {
      if (!e.type.startsWith('agent.') || e.data?.conversationId !== convId) return;
      if (e.type === 'agent.message') { live.current.add(e.data.message.id); if (loaded) setMessages((m) => upsert(m, e.data.message)); else early.push(e.data.message); }
      if (e.type === 'agent.done') setRunning(false);
      if (e.type === 'agent.claimed') { status.reload(); setRunning(true); } // your AI just picked up what was waiting
    });
    return () => { alive = false; off(); };
  }, [convId, connected, tries]);

  const send = async (text: string, context: ContextItem[] = []) => {
    const message = text.trim();
    if (!message || running) return false;
    const mine: ChatMsg = { id: `local-${Date.now()}`, role: 'user', content: { text: message, ...(context.length && { context: bare(context) }) }, created_at: new Date().toISOString() };
    live.current.add(mine.id);
    setMessages((m) => [...m, mine]);
    setRunning(true);
    setNonce((n) => n + 1);
    try {
      const r = await api<{ conversationId: string; via: string; watching?: boolean }>('/api/agent/conversations', { body: { message, conversationId: convId ?? undefined, ...(context.length && { context: bare(context) }) } });
      if (r.conversationId !== convId) { streamLoad.current = true; setConvId(r.conversationId); urlFor(r.conversationId); }
      return true;
    } catch (err) {
      setRunning(false);
      setMessages((m) => m.filter((x) => x.id !== mine.id));
      toast('bad', 'Unit7 couldn’t start on that', (err as Error).message);
      return false;
    }
  };
  const stop = () => { if (convId) api(`/api/agent/conversations/${convId}/stop`, { body: {} }).catch(() => undefined); };
  const open = (id: string) => {
    if (id === convId) return;
    setMessages([]); setRunning(false); setFailed(null); setConvId(id); urlFor(id); setNonce((n) => n + 1);
  };
  const fresh = () => {
    setConvId(null); setMessages([]); setRunning(false); setFailed(null); urlFor(null);
    requestAnimationFrame(() => document.getElementById('unit7-command')?.focus());
  };
  const lastAsk = [...messages].reverse().find((m) => m.role === 'user')?.content.text as string | undefined;
  const st = status.data;
  // nothing can answer yet (no AI picked, your Claude Code isn't listening): the last word in the thread says what to connect
  const said = messages[messages.length - 1];
  const stalled = !!st && !st.ready && !st.bridge?.watching && said?.role === 'status' && !!said.content.brain;
  const working = st && !st.ready ? (st.bridge?.watching ? 'Your Claude Code is on it…' : 'Looking…')
    : st?.brain ? `${st.brain === 'claude' ? 'Claude' : 'Gemini'} is working…` : 'Unit7 is working…';
  return {
    convId, messages, running, stalled, failed, nonce, connected, status: st, reloadStatus: status.reload, working, lastAsk,
    fresh: (id: string) => live.current.has(id), send, stop, open, newChat: fresh, retry: () => { setFailed(null); setTries((n) => n + 1); },
  };
}
export type Chat = ReturnType<typeof useChat>;

// a few more things to start from, as chips in the empty box (the quick-action cards cover the big four)
export interface Starter { label: string; ask: string }
const STARTERS: Starter[] = [
  { label: 'Add a database', ask: 'Add a Postgres database to my app and connect it' },
  { label: 'Fix my site', ask: 'My site isn’t working right. Find out why and fix it' },
  { label: 'What did Unit7 do today?', ask: 'What did Unit7 do today, in short?' },
];

const FITS = ['@min-[7.5rem]:inline-flex', '@min-[14rem]:inline-flex', '@min-[26rem]:inline-flex'];

// "Approve it": the step's own Approve button in the thread (it scrolls into view, focused), or the Approvals page
function openApproval(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-approval="${CSS.escape(id)}"]`);
  if (!el) return navigate('/approvals');
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.querySelector<HTMLElement>('[data-approve], [data-recommended]')?.focus({ preventScroll: true });
}
// a choice row's recommended button (the Tab suggestion of a failed step or an AI's pick): into view and focused, so
// Enter takes it; the newest row in the thread when that one isn't there
function focusChoice(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-choices="${CSS.escape(id)}"] [data-recommended], [data-ask="${CSS.escape(id)}"] [data-recommended]`)
    ?? [...document.querySelectorAll<HTMLElement>('[data-choices] [data-recommended]')].at(-1);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
}

// The ask box: pinned at the bottom of Home. Enter sends, Shift+Enter is a new line, ↑ in an empty box brings back
// your last message, Esc stops a run. Who answers sits in its corner, with sign-in right there. @ (or + Add context)
// picks what the chat is about: each pick is a chip over the text, sent with the message; Backspace in an empty box
// takes the last one off. After a reply, the likely next reply waits in gray in the empty box (next, chat/next.ts):
// Tab fills it in, ↑↓ switch between the options (small chips above the box; on phones, chips to tap), Esc puts them
// away. They only ever fill the box.
export function Composer({ chat, items = [], starters = STARTERS, next = [] }: { chat: Chat; items?: PickItem[]; starters?: Starter[]; next?: NextReply[] }) {
  const [text, setText] = useState('');
  const [about, setAbout] = useState<ContextItem[]>([]);
  const [picking, setPicking] = useState<null | 'at' | 'button'>(null);
  const caret = useRef(0); // where an @ was typed: an @ that picks nothing goes back there
  const [flying, setFlying] = useState(false); // the send arrow takes off, then Stop takes its place
  const box = useRef<HTMLTextAreaElement>(null);
  const brains = useBrains(chat.status, chat.reloadStatus);
  const st = chat.status;
  const yourAI = st && !st.ready;
  const watching = !!st?.bridge?.watching;
  const logoOf = (id: string) => items.find((i) => i.id === id)?.logo;
  const addAbout = (c: ContextItem[]) => setAbout((a) => [...a, ...c.filter((x) => !a.some((y) => y.id === x.id))].slice(0, 12));

  // grow with the text, up to a point
  useLayoutEffect(() => { const b = box.current; if (b) { b.style.height = 'auto'; b.style.height = `${Math.min(b.scrollHeight, 260)}px`; } }, [text]);

  // quick actions and card buttons hand us a request (and what it's about): fill the box (caret at the end), or send it
  useEffect(() => {
    const fill = (e: Event) => {
      const { text: t, context } = askOf(e);
      setText(t);
      if (context?.length) addAbout(context);
      requestAnimationFrame(() => { const b = box.current; if (b) { b.focus(); b.setSelectionRange(t.length, t.length); } });
    };
    const go = (e: Event) => { const { text: t, context } = askOf(e); void chat.send(t, context); };
    window.addEventListener('unit7:ask', fill);
    window.addEventListener('unit7:send', go);
    return () => { window.removeEventListener('unit7:ask', fill); window.removeEventListener('unit7:send', go); };
  }, [chat.send]);
  // another conversation, or a new one: its picks start over
  useEffect(() => { setAbout([]); }, [chat.convId]);

  // Esc stops a run from anywhere on the page that isn't another field or an open panel
  useEffect(() => {
    if (!chat.running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t !== box.current && t.closest('input, textarea, select, dialog, [role=dialog], [role=menu]')) return;
      chat.stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chat.running, chat.stop]);

  const focusAt = (at: number) => requestAnimationFrame(() => { const b = box.current; if (b) { b.focus(); b.setSelectionRange(at, at); } });

  // the next replies on offer (none while it works, or once you put them away with Esc)
  const nextKey = next.map((n) => n.text).join('\n');
  const [nextAt, setNextAt] = useState(0);
  const [putAway, setPutAway] = useState<string | null>(null);
  useEffect(() => { setNextAt(0); }, [nextKey]);
  const offer = !chat.running && putAway !== nextKey ? next : [];
  const ghost = text ? undefined : offer[Math.min(nextAt, offer.length - 1)];
  const take = (n: NextReply) => {
    if (n.approvalId) return openApproval(n.approvalId);
    if (n.choiceOf) return focusChoice(n.choiceOf);
    const t = n.text.endsWith(':') ? `${n.text} ` : n.text; // "Change the plan: " waits for the rest
    setText(t); focusAt(t.length);
  };
  const closePicker = (how: 'esc' | 'away' | 'picked') => {
    const from = picking;
    setPicking(null);
    if (from !== 'at') { if (how !== 'away') focusAt(box.current?.selectionStart ?? text.length); return; }
    const at = caret.current;
    if (how === 'picked') return focusAt(at);
    setText((t) => `${t.slice(0, at)}@${t.slice(at)}`); // nothing picked: the @ you typed stays
    if (how === 'esc') focusAt(at + 1);
  };
  const pick = (i: PickItem) => {
    setAbout((a) => (a.some((x) => x.id === i.id) ? a.filter((x) => x.id !== i.id) : [...a, { kind: i.kind, id: i.id, name: i.name }].slice(0, 12)));
    closePicker('picked');
  };

  const starting = !chat.convId && !text;
  const submit = async () => {
    const t = text, c = about;
    if (!t.trim() || chat.running) return;
    setText(''); setAbout([]);
    setFlying(true);
    setTimeout(() => setFlying(false), 520);
    if (!(await chat.send(t, c))) { setText(t); setAbout(c); }
  };

  return (
    <>
    {/* two or three next replies: small chips just over the box (one is enough to show on a phone, with no Tab key) */}
    {offer.length > 0 && !text && (
      <div key={nextKey} className={cx('mb-2 min-w-0 items-center gap-1 px-1 motion-safe:animate-[fade_.4s_ease-out_both]', offer.length > 1 ? 'flex' : 'hidden pointer-coarse:flex')}>
        <ul aria-label="Suggested replies" className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pointer-coarse:pr-6 pointer-coarse:[mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)]">
          {offer.map((n, i) => (
            <li key={n.text} className="shrink-0">
              <button type="button" onClick={() => take(n)} title={n.approvalId ? 'Opens the step that waits for your OK' : n.choiceOf ? 'Goes to the recommended button. Nothing runs until you press it.' : 'Puts it in the box. Nothing sends until you do.'}
                className={cx('h-7 max-w-[280px] truncate rounded-full px-3 text-[12.5px] transition-colors active:scale-[0.98]', i === Math.min(nextAt, offer.length - 1) ? 'bg-raised text-ink' : 'text-muted hover:bg-raised hover:text-ink')}>{n.text}</button>
            </li>
          ))}
        </ul>
        {offer.length > 1 && <span aria-hidden className="shrink-0 pl-2 text-[11.5px] text-faint pointer-coarse:hidden">↑↓ to switch</span>}
      </div>
    )}
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}
      className="relative overflow-visible rounded-[28px] border border-line-strong bg-surface shadow-[0_18px_40px_-24px_rgb(16_16_24/0.35)] transition focus-within:border-blue/50 focus-within:ring-4 focus-within:ring-blue-soft dark:shadow-[0_18px_40px_-20px_rgb(0_0_0/0.8)] md:rounded-[30px]">
      {yourAI && !watching && <BrainStrip brains={brains} />}
      {about.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3 md:px-6 md:pt-4" aria-label="What this chat is about">
          {about.map((c) => <AboutChip key={c.id} item={c} logo={logoOf(c.id)} className="animate-pop" onRemove={() => { setAbout((a) => a.filter((x) => x.id !== c.id)); box.current?.focus(); }} />)}
        </div>
      )}
      <div className={cx('relative flex gap-3 px-4 md:gap-3.5 md:px-6', about.length ? 'pt-2.5 md:pt-3' : 'pt-4 md:pt-5')}>
        {/* the picker rises from the line you type on (over the sign-in strip, if it shows) */}
        {picking && <ContextPicker items={items} picked={about} onPick={pick} onClose={closePicker} />}
        <AiSparkle size={20} still={!chat.running || chat.stalled} className="mt-[3px] shrink-0" />
        <div className="relative min-w-0 flex-1">
        <textarea
          id="unit7-command"
          ref={box}
          value={text}
          onChange={(e) => {
            const v = e.target.value, at = e.target.selectionStart;
            // an @ typed at the start of a word opens the picker (on every keyboard, phones too) instead of going in
            if (items.length && v.length === text.length + 1 && v[at - 1] === '@' && (at === 1 || /\s/.test(v[at - 2]!))) {
              setText(v.slice(0, at - 1) + v.slice(at));
              caret.current = at - 1;
              setPicking('at');
              return;
            }
            setText(v);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (ghost && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              if (e.key === 'Tab') { e.preventDefault(); take(ghost); return; }
              if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && offer.length > 1) { e.preventDefault(); setNextAt((i) => (i + (e.key === 'ArrowDown' ? 1 : offer.length - 1)) % offer.length); return; }
              if (e.key === 'Escape') { e.preventDefault(); setPutAway(nextKey); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
            else if (e.key === 'ArrowUp' && !text && chat.lastAsk) { e.preventDefault(); setText(chat.lastAsk); requestAnimationFrame(() => box.current?.setSelectionRange(chat.lastAsk!.length, chat.lastAsk!.length)); }
            else if (e.key === 'Backspace' && !text && about.length) { e.preventDefault(); setAbout((a) => a.slice(0, -1)); }
            else if (e.key === 'Escape' && chat.running) { e.preventDefault(); chat.stop(); }
          }}
          rows={1}
          placeholder={ghost ? '' : chat.convId ? 'Reply to Unit7…' : 'Ask me anything…'}
          aria-label="Tell Unit7 what to do"
          aria-describedby={ghost ? 'unit7-next' : undefined}
          className="block max-h-[260px] min-h-[30px] w-full resize-none bg-transparent text-[16px] leading-relaxed text-ink outline-none placeholder:text-faint md:min-h-[56px] md:text-[16.5px]"
        />
        {/* the likely next reply, in gray where you type: Tab takes it */}
        {ghost && (
          <div key={`${nextKey}:${ghost.text}`} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 flex min-w-0 items-baseline gap-2 text-[16px] leading-relaxed text-faint motion-safe:animate-[fade_.45s_ease-out_both] md:text-[16.5px]">
            <span className="min-w-0 truncate">{ghost.text}</span>
            <kbd className="shrink-0 translate-y-[-1px] rounded-[6px] border border-line bg-surface px-1.5 font-sans text-[11px] font-medium leading-[18px] text-faint shadow-[0_1px_0_var(--line)] pointer-coarse:hidden">Tab</kbd>
          </div>
        )}
        {ghost && <span id="unit7-next" className="sr-only">Suggested reply: {ghost.text}. Press Tab to {ghost.approvalId ? 'open it' : ghost.choiceOf ? 'go to that button' : 'use it'}{offer.length > 1 ? `, or the up and down arrows for the other ${offer.length - 1}` : ''}.</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-2 md:px-4 md:pb-3.5">
        {yourAI && watching ? <BridgeChip watching /> : <BrainPicker brains={brains} working={chat.running && !chat.stalled} />}
        {items.length > 0 && (
          <button type="button" onClick={() => setPicking((p) => (p ? null : 'button'))} aria-expanded={!!picking} aria-label="Add context: pick what this chat is about" title="Pick what this chat is about (@)"
            className={cx('inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-medium transition active:scale-[0.97]',
              picking ? 'border-blue/40 bg-blue-soft text-blue-text' : 'border-line text-ink-2 hover:border-line-strong hover:bg-raised hover:text-ink')}>
            <AtSign size={13} strokeWidth={2.2} /><span className="hidden sm:inline">Add context</span>
          </button>
        )}
        {/* as many starters as fit beside the picker (a container query, so a cut-off chip never shows) */}
        {starting ? (
          <span className="@container flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden pl-1 max-lg:invisible">
            {starters.slice(0, 3).map((c, i) => (
              <button key={c.label} type="button" onClick={() => fillAsk(c.ask)}
                className={cx('hidden h-8 shrink-0 items-center rounded-full px-2.5 text-[12.5px] text-muted transition-colors hover:bg-raised hover:text-ink', FITS[i])}>{c.label}</button>
            ))}
          </span>
        ) : <span className="flex-1" />}
        {/* (not there at all beside the starters, which would lose its room) */}
        <span className={cx('hidden text-[12px] text-faint transition-opacity', !starting && 'md:block', text ? 'opacity-100' : 'opacity-0')}>Enter to send · Shift+Enter for a new line</span>
        {chat.running && !chat.stalled && !flying
          ? <Button type="button" size="md" variant="dark" className="animate-pop" onClick={chat.stop} title="Stop (Esc)" icon={<Square size={12} fill="currentColor" />}>Stop</Button>
          : <button disabled={(!text.trim() || chat.running) && !flying} aria-label="Send" title="Send (Enter)"
              className={cx('grid size-11 place-items-center overflow-hidden rounded-full bg-blue text-white shadow-[0_8px_20px_-8px_var(--blue)] transition hover:brightness-110 active:scale-95 disabled:bg-sunken disabled:text-faint disabled:shadow-none', flying && 'send-fly pointer-events-none')}><ArrowUp size={20} strokeWidth={2.3} /></button>}
      </div>
    </form>
    </>
  );
}
