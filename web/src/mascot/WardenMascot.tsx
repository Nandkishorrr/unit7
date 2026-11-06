// Warden: a small round face (40px) in the bottom-right corner. It blinks now and then, glances around every twenty
// seconds or so and bobs gently while it works on something; its visor glows by mood (green calm, amber something to do,
// red alert) and a dot counts what needs you. When there's something worth saying, a speech bubble pops out of it for a
// few seconds with one short line ("2 things need a look", "api is live again · Undo"): each thing at most once a
// session, never while you type, dismissable, and clicking it opens the panel. The panel is a calm list of suggestions,
// each with one action, and a line on what Warden did today. A first visit gets a one-time hello. It steps aside while
// you scroll down and comes back when you scroll up. Open a project and it speaks for that project only.
// Reduced motion: it holds still, and the bubble simply appears.
import { useEffect, useRef, useState } from 'react';
import { X, Loader2, Shield, ArrowRight } from 'lucide-react';
import { onLive, useApi } from '../lib/api';
import { match, navigate, usePath } from '../lib/router';
import { runAction, type Suggestion } from '../lib/actions';
import { ExplainBlock, SnoozeMenu } from '../pages/explain';
import { act, cx, StatusMark } from '../ui';
import { lookWords, toolWords } from '../lib/words';
import { didToday, nextSay, type DidRow } from './say';

type Mood = 'calm' | 'working' | 'alert';
const MOOD_COLOR: Record<Mood, string> = { calm: '#c6f432', working: '#f5b041', alert: '#ff5a5a' };

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const dismissedMap = (): Record<string, number> => { try { return JSON.parse(store.get('unit7-warden-dismissed') ?? '{}'); } catch { return {}; } };
// what the bubble already said this session (a reload doesn't say it again; a new session may)
const said = {
  get: (): Set<string> => { try { return new Set(JSON.parse(sessionStorage.getItem('unit7-warden-said') ?? '[]')); } catch { return new Set(); } },
  add: (keys: string[]) => { try { sessionStorage.setItem('unit7-warden-said', JSON.stringify([...new Set([...said.get(), ...keys])].slice(-200))); } catch { /* private mode */ } },
};

interface Bubble { key: string; text: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'hello'; action?: { label: string; run: () => unknown }; ms?: number }
const DOT: Record<Bubble['tone'], string> = { ok: 'bg-lime', warn: 'bg-[#f59e0b]', bad: 'bg-bad-solid', info: 'bg-blue', hello: 'bg-lime' };
// live events that mean Warden (or a deploy it watches) is busy, and the ones that say it's done
const WORK_START = new Set(['deployment.started', 'deployment.healing', 'sync.started', 'backup.started', 'agent.claimed']);
const WORK_END = new Set(['deployment.succeeded', 'deployment.failed', 'deployment.healed', 'sync.done', 'backup.done', 'agent.done']);

export function WardenMascot() {
  const path = usePath();
  const projectId = match('/projects/:id', path)?.id ?? match('/projects/:id/services/:sid', path)?.id;
  const sugg = useApi<{ scope: string; items: Suggestion[] }>(`/api/suggestions${projectId ? `?projectId=${projectId}` : ''}`, { live: (e) => !e.live || e.type === 'agent.done' });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissed] = useState(dismissedMap); // older one-day hides in this browser; new ones are snoozes on the server
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [held, setHeld] = useState(false);
  const [pop, setPop] = useState(false);
  const [working, setWorking] = useState(false);
  const [tucked, setTucked] = useState(false);
  const queue = useRef<Bubble[]>([]);
  const [queued, setQueued] = useState(0); // bumps when something joins the queue
  // on phones the badge steps aside while you type, so it never sits on the keyboard or the Send button; and the bubble
  // never talks over your typing anywhere
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const on = () => setTyping(!!(document.activeElement as HTMLElement | null)?.closest('input, textarea, [contenteditable=true]'));
    const off = () => setTimeout(on, 0);
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', off);
    return () => { document.removeEventListener('focusin', on); document.removeEventListener('focusout', off); };
  }, []);
  const items = (sugg.data?.items ?? []).filter((s) => !(dismissed[s.id] > Date.now()) && s.id !== 'all-clear');
  const alerts = items.filter((s) => s.severity === 'alert').length;
  const todo = items.filter((s) => s.severity !== 'info').length;
  const mood: Mood = busy ? 'working' : alerts ? 'alert' : todo ? 'working' : 'calm';
  // a popover: Esc or a click outside closes it, and the keyboard goes back to the badge
  const box = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // a menu opened from the panel ("This is fine") is drawn outside it, in the top layer (like toasts and pop-ups); a
    // press there isn't "away" (closing the panel unmounted the menu before its click, so nothing was ever hidden)
    const away = (e: PointerEvent) => { const t = e.target as Element; if (!box.current?.contains(t) && !t.closest?.('[popover], dialog[open]')) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { setOpen(false); badge.current?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  // --- the bubble: one thing at a time, from a small queue; something live goes to the front ---
  const say = (b: Bubble, now = false) => {
    if (now) queue.current = [b, ...queue.current.filter((x) => x.key !== b.key)];
    else if (!queue.current.some((x) => x.key === b.key)) queue.current.push(b);
    if (now) setBubble(null); // what it was saying gives way
    setQueued((n) => n + 1);
  };
  useEffect(() => {
    if (bubble || typing || open || !queue.current.length) return;
    const t = setTimeout(() => {
      const next = queue.current.shift();
      if (!next) return;
      if (next.tone === 'hello') store.set('unit7-warden-hello', '1');
      setBubble(next); setPop(true); setTimeout(() => setPop(false), 1000);
    }, 600); // a breath between two bubbles
    return () => clearTimeout(t);
  }, [bubble, typing, open, queued]);
  useEffect(() => {
    if (!bubble || held) return;
    const t = setTimeout(() => setBubble(null), bubble.ms ?? (bubble.tone === 'bad' ? 9000 : 6500));
    return () => clearTimeout(t);
  }, [bubble, held]);
  useEffect(() => { if (open) setBubble(null); }, [open]);

  // a first visit: one friendly hello, once
  useEffect(() => {
    if (store.get('unit7-warden-hello')) return;
    say({ key: 'hello', tone: 'hello', text: 'Hi, I’m Warden. I keep watch and tell you when something needs you.', ms: 8000 });
  }, []);

  // what needs a look: said once a session (all of it in one line the first time, then each new thing)
  useEffect(() => {
    if (!sugg.data) return;
    const s = nextSay(items, said.get());
    if (!s) return;
    const t = setTimeout(() => {
      said.add(s.keys);
      say({ key: `say:${s.keys.join(',')}`, text: s.text, tone: s.tone, action: { label: 'See', run: () => setOpen(true) } });
    }, 1400);
    return () => clearTimeout(t);
  }, [sugg.data, dismissed]);

  // something happening live: said straight away
  useEffect(() => {
    let done: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => {
      if (WORK_START.has(e.type)) { setWorking(true); clearTimeout(done); done = setTimeout(() => setWorking(false), 30_000); }
      if (WORK_END.has(e.type)) { setWorking(false); clearTimeout(done); }
      const undo = e.data?.undo && typeof e.data.undo.tool === 'string' ? { label: 'Undo', run: () => act(e.data.undo.tool, e.data.undo.input, { success: 'Undone', undo: false }) } : undefined;
      const tell = (text: string, tone: Bubble['tone'], action?: Bubble['action']) => say({ key: `live:${e.id}`, text, tone, action }, true);
      if (e.type === 'deployment.healed' || e.type.startsWith('autofix.') || e.type === 'warden.fixed') tell(`${e.message.replace(/\.$/, '')}. Handled it.`, 'ok', undo);
      else if (e.type === 'deployment.healing') tell(e.message, 'warn');
      else if (e.type === 'deployment.succeeded') tell('Your new version is live.', 'ok');
      else if (e.type === 'agent.connected' || e.type === 'account.connected') tell(`${e.message.replace(/\.$/, '')}. I’ll keep an eye on it.`, 'ok');
      else if (e.type === 'shield.blocked') tell(`${e.message.replace(/\.$/, '')}. Not on my watch.`, 'warn');
      else if (['deployment.failed', 'service.down', 'incident.opened', 'server.unreachable'].includes(e.type)) tell(e.message, 'bad', { label: 'What to do', run: () => setOpen(true) });
    });
    return () => { off(); clearTimeout(done); };
  }, []);

  // it steps aside while you scroll down (on the page or in a list), and comes back when you scroll up
  useEffect(() => {
    const last = new WeakMap<object, number>();
    const on = (e: Event) => {
      const el = e.target === document ? document.scrollingElement : e.target;
      if (!(el instanceof Element) || box.current?.contains(el)) return;
      const y = el.scrollTop, before = last.get(el) ?? 0;
      last.set(el, y);
      if (y > before + 2 && y > 120) setTucked(true);
      else if (y < before - 2 || y < 40) setTucked(false);
    };
    document.addEventListener('scroll', on, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', on, { capture: true });
  }, []);
  useEffect(() => setTucked(false), [path]);

  const run = async (s: Suggestion, a: Suggestion['actions'][number]) => {
    setBusy(`${s.id}:${a.label}`);
    const ok = await runAction(a);
    setBusy(null);
    if (ok) { if (a.kind === 'navigate') setOpen(false); sugg.reload(); }
  };
  const talking = !!bubble && !open && !typing;

  return (
    <div ref={box} className={cx('fixed bottom-[calc(80px+env(safe-area-inset-bottom))] right-3 z-40 flex flex-col items-end gap-2 transition-[transform,opacity] duration-300 ease-out-soft lg:bottom-5 lg:right-5',
      typing && !open && 'max-lg:hidden', path === '/' && !open && 'max-lg:hidden', tucked && !open && 'pointer-events-none translate-y-[calc(100%+28px)] opacity-0')}>
      {open && (
        <div role="dialog" aria-label="Warden" className="animate-pop w-[340px] max-w-[calc(100vw-24px)] origin-bottom-right overflow-hidden rounded-[24px] border border-line bg-surface shadow-float">
          <div className="flex items-center gap-3 px-4 pb-2 pt-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-raised"><Face mood={mood} size={32} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold tracking-[-0.015em]">Warden</p>
              <p className="truncate text-[12px] text-muted">{sugg.data?.scope ?? 'Everything'} · {lookWords(todo, items.length - todo)}</p>
            </div>
            <button onClick={() => { setOpen(false); badge.current?.focus(); }} className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink" aria-label="Close"><X size={16} /></button>
          </div>
          <ul className="max-h-[52vh] space-y-0.5 overflow-y-auto px-2 pb-2" aria-label="Suggestions">
            {!items.length && (
              <li className="flex items-center gap-2.5 px-2.5 py-4 text-[13.5px] text-muted"><StatusMark state="ok" size={22} label="All good" />All good. Nothing needs you right now.</li>
            )}
            {items.map((s) => {
              const a = s.actions[0];
              return (
                <li key={s.id} className="group/row rounded-[16px] px-2.5 py-2.5 transition hover:bg-raised">
                  <div className="flex gap-2.5">
                    <span aria-hidden className={cx('mt-[7px] size-2 shrink-0 rounded-full', s.severity === 'alert' ? 'bg-bad-solid' : s.severity === 'warn' ? 'bg-[#f59e0b]' : 'bg-blue')} />
                    <p className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink">{s.text}</p>
                    <span className="-mr-1 -mt-1 opacity-60 transition group-hover/row:opacity-100 focus-within:opacity-100"><SnoozeMenu id={s.id} title={s.text} kind="suggestion" iconOnly onDone={sugg.reload} /></span>
                  </div>
                  {s.explain?.why && <ExplainBlock compact className="ml-[18px] mt-1.5" e={{ ...s.explain, what: '', advanced: undefined }} />}
                  {a && (
                    <button type="button" disabled={!!busy} onClick={() => run(s, a)}
                      className="ml-[18px] mt-2 inline-flex h-7 items-center gap-1.5 rounded-full bg-blue-soft px-3 text-[12.5px] font-medium text-blue-text transition hover:bg-blue hover:text-white active:scale-[0.97] disabled:opacity-60">
                      {busy === `${s.id}:${a.label}` ? <Loader2 size={11} className="animate-spin" /> : null}{a.label}{a.kind === 'navigate' && <ArrowRight size={12} />}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <WardenToday />
        </div>
      )}
      {talking && (
        // the speech bubble: one short line; the line opens the panel, its button does the one thing, × lets it go
        <div role="status" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
          className="warden-bubble relative mr-1 flex max-w-[min(300px,calc(100vw-72px))] items-center gap-1 rounded-[18px] border border-line bg-surface py-1.5 pl-3 pr-1.5 text-[13px] text-ink shadow-float">
          <button type="button" onClick={() => { setBubble(null); setOpen(true); }} className="flex min-w-0 items-center gap-2 py-1 text-left outline-none focus-visible:underline">
            <span aria-hidden className={cx('size-2 shrink-0 rounded-full', DOT[bubble.tone])} />
            <span className="min-w-0">{bubble.text}</span>
          </button>
          {bubble.action && bubble.action.label !== 'See' && (
            <button type="button" onClick={() => { const a = bubble.action!; setBubble(null); void a.run(); }} className="ml-1 shrink-0 rounded-full bg-blue-soft px-2.5 py-1 text-[12px] font-semibold text-blue-text transition hover:bg-blue hover:text-white">{bubble.action.label}</button>
          )}
          <button type="button" onClick={() => setBubble(null)} aria-label="Dismiss" className="grid size-7 shrink-0 place-items-center rounded-full text-faint transition hover:bg-raised hover:text-ink"><X size={13} /></button>
        </div>
      )}
      <button ref={badge} onClick={() => setOpen((o) => !o)} aria-expanded={open}
        aria-label={`Warden, ${lookWords(todo, items.length - todo)}. Click for suggestions.`}
        className={cx('relative grid size-10 place-items-center rounded-full border border-line bg-surface shadow-float transition duration-300 ease-out-soft hover:-translate-y-0.5 hover:shadow-lift', open && 'ring-4 ring-blue-soft', pop && 'warden-pop')}>
        <Face mood={mood} size={36} bob={working || !!busy} />
        {todo > 0 && (
          <span className={cx('absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10.5px] font-semibold tabular ring-2 ring-bg', alerts ? 'bg-bad-solid text-white' : 'bg-[#f59e0b] text-[#1f1300]')}>{todo}</span>
        )}
      </button>
    </div>
  );
}

// "What Warden did today", at the foot of the panel (read only while the panel is open)
function WardenToday() {
  const rows = useApi<DidRow[]>('/api/audit?limit=200', { live: false });
  return (
    <button type="button" onClick={() => navigate('/activity')}
      className="flex w-full items-center gap-2.5 border-t border-line px-4 py-3 text-left text-[12.5px] text-muted transition hover:bg-raised hover:text-ink">
      <Shield size={14} className="shrink-0 text-blue-text" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{rows.data ? didToday(rows.data, (t) => toolWords(t)) : 'Checking what I did today…'}</span>
      <ArrowRight size={13} className="shrink-0" aria-hidden />
    </button>
  );
}

export function SuggestionItems({ items, busy, run, dismiss }: { items: Suggestion[]; busy: string | null; run: (s: Suggestion, a: Suggestion['actions'][number]) => void; dismiss: () => void }) {
  return (
    <>
      {items.map((s) => (
        <div key={s.id} className="px-4 py-3">
          <div className="flex gap-2">
            <span className={cx('mt-[7px] size-2 shrink-0 rounded-full', s.severity === 'alert' ? 'bg-bad-solid' : s.severity === 'warn' ? 'bg-[#f59e0b]' : 'bg-blue')} />
            <p className="text-[13.5px] leading-snug text-ink">{s.text}</p>
          </div>
          {s.explain?.why && <ExplainBlock compact className="mt-1.5 pl-4" e={{ ...s.explain, what: '', advanced: undefined }} />}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-4">
            {s.actions.map((a, k) => (
              <button key={a.label} disabled={!!busy} onClick={() => run(s, a)}
                className={cx('inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium transition active:scale-[0.97] disabled:opacity-60', k === 0 ? 'bg-blue text-white hover:brightness-110' : 'bg-raised text-ink hover:bg-sunken')}>
                {busy === `${s.id}:${a.label}` && <Loader2 size={11} className="animate-spin" />}{a.label}
              </button>
            ))}
            <span className="ml-auto"><SnoozeMenu id={s.id} title={s.text} kind="suggestion" small onDone={dismiss} /></span>
          </div>
        </div>
      ))}
    </>
  );
}

// On a project's page: that project's suggestions, and what Unit7 has learned about it.
export function ProjectWarden({ projectId }: { projectId: string }) {
  const sugg = useApi<{ scope: string; items: Suggestion[] }>(`/api/suggestions?projectId=${projectId}`, { live: (e) => !e.live || e.type === 'agent.done' });
  const memory = useApi<{ content: string }[]>(`/api/projects/${projectId}/memory`, { live: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissed] = useState(dismissedMap); // older one-day hides in this browser; new ones are snoozes on the server
  const items = (sugg.data?.items ?? []).filter((s) => !(dismissed[s.id] > Date.now()) && s.id !== 'all-clear');
  const profile = (memory.data ?? []).filter((m) => m.content.startsWith('Profile · ')).map((m) => m.content.slice(10));
  const run = async (s: Suggestion, a: Suggestion['actions'][number]) => { setBusy(`${s.id}:${a.label}`); const ok = await runAction(a); setBusy(null); if (ok) sugg.reload(); };
  const dismiss = () => sugg.reload();
  if (!sugg.data) return null;
  return (
    <div className="mb-8 grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="overflow-hidden rounded-[24px] border border-line bg-surface shadow-soft">
        <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
          <Face mood={items.some((s) => s.severity === 'alert') ? 'alert' : items.some((s) => s.severity === 'warn') ? 'working' : 'calm'} size={24} />
          <p className="flex-1 text-[15px] font-medium">Warden’s suggestions</p>
          <span className="text-[12px] text-muted">{items.length || 'none'}</span>
        </div>
        {items.length ? <div className="divide-y divide-line"><SuggestionItems items={items} busy={busy} run={run} dismiss={dismiss} /></div>
          : <p className="flex items-center gap-2 px-4 py-4 text-[13px] text-muted"><StatusMark state="ok" size={18} label="All good" />This project is secure. Nothing needs you right now.</p>}
      </div>
      <div className="rounded-[24px] border border-line bg-surface p-5 shadow-soft">
        <p className="text-[15px] font-medium">What Unit7 knows</p>
        {profile.length ? <ul className="mt-2 space-y-2 text-[12.5px] leading-snug text-muted">{profile.map((p) => <li key={p}>{p.split(' · ').map((part, i) => <span key={i} className={i === 0 ? 'block font-medium text-ink-2' : ''}>{i > 0 && '· '}{part} </span>)}</li>)}</ul>
          : <p className="mt-2 text-[12.5px] text-muted">Deploy it once and Unit7 reads the code: framework, database, settings it needs, and whether it can run as several copies.</p>}
      </div>
    </div>
  );
}

// Warden's face: helmet cap, visor, two glowing eyes. Blinks now and then, glances side to side every twenty seconds or
// so, the visor glow breathes with mood, and it bobs gently while it works (bob). All still under reduced motion.
export function Face({ mood, size = 42, bob }: { mood: Mood; size?: number; bob?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className={cx('warden-face', bob && 'warden-bob')} style={{ ['--mood' as string]: MOOD_COLOR[mood] }}>
      <circle cx="24" cy="26" r="15" fill="#eef0f3" />
      <rect x="12.5" y="21.5" width="23" height="9.5" rx="4.75" fill="#0b0f19" />
      <g className="warden-look">
        <ellipse className="warden-glow" cx="19.5" cy="26.2" rx="4" ry="3.2" fill="var(--mood)" opacity="0.25" />
        <ellipse className="warden-glow" cx="28.5" cy="26.2" rx="4" ry="3.2" fill="var(--mood)" opacity="0.25" />
        <g className="warden-eyes">
          <circle cx="19.5" cy="26.2" r="2.1" fill="var(--mood)" />
          <circle cx="28.5" cy="26.2" r="2.1" fill="var(--mood)" />
        </g>
      </g>
      <path d="M10.5 17 Q24 3 37.5 17 L37.5 19.5 L10.5 19.5 Z" fill="#1f5bff" />
      <path d="M8.5 19.5 Q24 15.5 40 20 Q38.5 23 24 22 Q11 21.5 8.5 19.5 Z" fill="#0e0e12" />
      <circle cx="24" cy="12.5" r="2.2" fill="#c6f432" />
    </svg>
  );
}
