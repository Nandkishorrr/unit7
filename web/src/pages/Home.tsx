// Home is a full-screen chat with Unit7. The page never scrolls: past chats in a slim rail on the left, the
// conversation in the middle (only the thread scrolls) with the ask box pinned at the bottom, and what's waiting for
// you plus a tiny health summary on the right. The three share the whole width. Before the first message: a greeting
// for the time of day over a slowly drifting sky, and five suggested tasks from what Unit7 knows as one quiet list (the
// four quick actions when there's nothing to suggest; plus the three setup steps on a brand-new install); the first
// message turns it into the chat, where the ask box offers the likely next reply after each answer (chat/next.ts).
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow, ArrowRight, ArrowUpRight, BellRing, Bug, Check, Database, DatabaseBackup, Globe, HardDrive, History, Loader2, Lock, MailWarning, RefreshCw, Repeat,
  Server, ShieldAlert, ShieldCheck, SquarePen, TriangleAlert, Wallet, WifiOff,
} from 'lucide-react';
import { api, onLive, runTool, useApi } from '../lib/api';
import { navigate } from '../lib/router';
import { A, AiSparkle, Badge, Button, CountUp, Drawer, HoverCard, IconCircle, Skeleton, act, cx, timeAgo, toast, askAction, StatusMark, nextAction, type MarkState } from '../ui';
import { taskCheck, verifiedOf } from '../lib/alertActions';
import { BrandLogo, providerName } from '../brand/BrandLogo';
import { Composer, fillAsk, useChat, type Starter } from './Agent';
import { GetStarted, useSetup } from './GetStarted';
import { ChatScroll, Thread } from './chat/Thread';
import { nextReplies } from './chat/next';
import { Rail, RailList } from './chat/Rail';
import { AboutLogo } from './chat/Picker';
import { aboutOf, pickItems, type ContextItem } from './chat/about';
import { isDb } from './kit';
import { derive, logoOf, type MapData } from './map/data';
import { glance, type Glance } from './glance';
import { approvalWords, changeWords, tidy } from '../lib/words';
import { APPROVAL_LABELS, ExplainBlock, SnoozeMenu, type Explain } from './explain';
import { explainOf } from './Approvals';
import { SevenLine } from './seven';
import type { Me } from '../App';
import { MorningBrief } from './story';
import { CostRadar } from './care';
import { FreshHomeCard } from './fresh';
import { SaveAsRoutine } from './flow/Routines';
import { openDomainLaunch } from './flow/DomainLaunch';
import { Choices } from './choices';
import { approvalChoices } from '../lib/choices';

const ASK = {
  deploy: 'Deploy my app and give me the link',
  domain: 'Connect my domain ',
  backup: 'Back up all my databases now',
  servers: 'Check my servers and tell me if anything needs attention',
};
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
// the chat column: wide enough for cards and the ask box; the AI's words keep a readable measure inside (Thread)
const COLUMN = 'mx-auto w-full max-w-[880px] min-[105rem]:max-w-[1000px]';

export function Home({ me }: { me: Me }) {
  const chat = useChat();
  const setup = useSetup();
  const graph = useApi<any>('/api/graph');
  const map = useMapData();
  const approvals = useApi<any[]>('/api/approvals', { live: (e) => e.type.startsWith('approval.') || e.type.startsWith('action.') });
  const now = new Date().toISOString();
  const pending = (approvals.data ?? []).filter((a) => a.status === 'pending' && (!a.expires_at || a.expires_at > now));
  // each approval's state now, for the chat's steps (the same words as the Approvals page)
  const decided = useMemo(() => {
    const at = new Date().toISOString();
    return new Map<string, string>((approvals.data ?? []).map((a) => [a.id,
      a.status === 'pending' && a.expires_at && a.expires_at <= at ? 'expired' : a.status === 'done' ? (a.result === 'success' ? 'done' : 'failed') : a.status]));
  }, [approvals.data]);
  // the conversation's own title, the same one the rail shows
  const convs = useApi<{ id: string; title: string }[]>('/api/agent/conversations', { live: (e) => e.type === 'agent.done' });
  useEffect(() => { if (chat.convId && !convs.data?.some((c) => c.id === chat.convId)) convs.reload(); }, [chat.convId]);
  const g = useMemo(() => (graph.data && map !== undefined ? glanceOf(graph.data, map) : null), [graph.data, map]);
  const [folded, setFolded] = useState(() => store.get('unit7-rail') === 'folded');
  const fold = (f: boolean) => { setFolded(f); store.set('unit7-rail', f ? 'folded' : 'open'); };
  const [sheet, setSheet] = useState<'rail' | 'panel' | null>(null);
  // what you can pick for a chat to be about (@), and what this one is about so far
  const items = useMemo(() => pickItems(graph.data, map, { logoOf, providerName }), [graph.data, map]);
  const about = useMemo(() => aboutOf(chat.messages), [chat.messages]);
  const logoFor = (id: string) => items.find((i) => i.id === id)?.logo;
  // five suggested tasks; doing one fills the ask box (with what it's about), opens its chat or page, or runs its fix
  const tasks = useTasks();
  const [busy, setBusy] = useState<string | null>(null);
  const doTask = async (t: Task, direct = true) => {
    if (t.fix && direct) {
      setBusy(t.id);
      const r = await act(t.fix.tool, t.fix.input);
      setBusy(null);
      // Unit7 looked again at what it touched: "fixed" only when that check no longer sees it
      const v = verifiedOf(r?.output);
      if (r) toast(v && !v.fixed ? 'warn' : 'ok', v ? (v.fixed ? 'Fixed and checked' : 'Still there') : t.fix.success ?? `${t.fix.label}: done`, v ? (v.fixed ? t.text : v.still) : undefined,
        v && !v.fixed ? (t.ask ? { action: { label: 'Ask Unit7 to fix it', onClick: () => fillAsk(t.ask!, t.about ? [t.about] : undefined) } } : undefined) : { action: nextAction(r.output) });
      if (r) tasks.reload();
    } else if (t.href) navigate(t.href);
    else if (t.conversationId) { chat.open(t.conversationId); fillAsk(t.ask ?? 'Please pick up where you left off and finish this.'); }
    else fillAsk(t.ask ?? t.text, t.about ? [t.about] : undefined);
  };

  // empty → chat: the greeting shrinks away first, then the thread comes in
  const chatting = chat.messages.length > 0 || !!chat.convId;
  const [phase, setPhase] = useState<'hero' | 'leaving' | 'chat'>(chatting ? 'chat' : 'hero');
  useEffect(() => {
    if (!chatting) { setPhase('hero'); return; }
    if (phase !== 'hero') return;
    if (reduced()) { setPhase('chat'); return; }
    setPhase('leaving');
    const t = setTimeout(() => setPhase('chat'), 300);
    return () => clearTimeout(t);
  }, [chatting]);

  // the live connection dropped (not just starting up): say so
  const [offline, setOffline] = useState(false);
  const wasLive = useRef(false);
  useEffect(() => {
    if (chat.connected) { wasLive.current = true; setOffline(false); return; }
    if (!wasLive.current) return;
    const t = setTimeout(() => setOffline(true), 4000);
    return () => clearTimeout(t);
  }, [chat.connected]);

  // after each answer: the replies you'd likely type next (the AI's own, or from what just happened)
  const next = useMemo(() => (chat.running ? [] : nextReplies(chat.messages, decided)), [chat.messages, chat.running, decided]);

  const title = convs.data?.find((c) => c.id === chat.convId)?.title ?? chat.messages.find((m) => m.role === 'user')?.content.text as string | undefined;
  const panel = <PanelBody me={me} pending={pending} reload={approvals.reload} g={g} />;
  const panelLabel = pending.length ? `${pending.length} waiting for you, and health` : 'Waiting for you, and health';

  return (
    <div className="chat-home flex min-h-0 flex-1 gap-3 min-[90rem]:gap-4">
      <Rail current={chat.convId} onOpen={chat.open} onNew={chat.newChat} folded={folded} onFold={fold} />

      <section aria-label="Ask Unit7" className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-line bg-surface shadow-soft md:rounded-[32px]">
        <Sky on={phase !== 'chat'} />

        <header className={cx('relative z-10 flex h-14 shrink-0 items-center gap-1.5 px-3 md:px-4', !chatting && 'lg:hidden', chatting && 'border-b border-line')}>
          <IconButton label="Past conversations" onClick={() => setSheet('rail')} className="lg:hidden"><History size={18} /></IconButton>
          <div className="min-w-0 flex-1 px-1.5">
            <p className="truncate text-[14px] font-medium text-ink-2" title={title}>{chatting ? title ?? 'Conversation' : ''}</p>
            {chatting && about.length > 0 && <AboutLine about={about} logoFor={logoFor} />}
          </div>
          {chatting && <IconButton label="New chat" onClick={chat.newChat}><SquarePen size={17} /></IconButton>}
          <IconButton label={panelLabel} onClick={() => setSheet('panel')} className="lg:hidden">
            <ShieldCheck size={18} />{pending.length > 0 && <Count n={pending.length} />}
          </IconButton>
        </header>

        {offline && (
          <p role="status" className="animate-pop absolute left-1/2 top-[66px] z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] text-bg shadow-float">
            <WifiOff size={13} />Reconnecting… live updates are paused
          </p>
        )}

        <ChatScroll follow={`${chat.convId}:${chat.nonce}`} pin={phase === 'chat'}>
          <div className={cx(COLUMN, 'relative flex flex-1 flex-col px-4 md:px-8')}>
            {phase !== 'chat' && (
              <div className={cx('my-auto', phase === 'leaving' && 'animate-[hero-out_.3s_ease-in_both]')} inert={phase === 'leaving'}>
                <Hero me={me} setup={setup} tasks={tasks.list} busy={busy} onDo={doTask} onDismiss={(t) => tasks.dismiss(t, true)} />
              </div>
            )}
            {phase === 'chat' && (
              <div className="flex flex-1 flex-col animate-[fade_.35s_ease-out_both] pt-2">
                {chat.failed ? <LoadError text={chat.failed} retry={chat.retry} />
                  : !chat.messages.length ? <ThreadSkeleton />
                  : <Thread messages={chat.messages} conversationId={chat.convId ?? ''} running={chat.running} stalled={chat.stalled} working={chat.working} fresh={chat.fresh}
                      approvals={decided} brains={chat.brains} onRetry={chat.lastAsk ? () => void chat.send(chat.lastAsk!) : undefined} />}
                {!chat.failed && <SaveAsRoutine conversationId={chat.convId ?? ''} messages={chat.messages} running={chat.running} className="mb-2 mt-3 self-start" />}
              </div>
            )}
          </div>
        </ChatScroll>

        {/* the ask box, pinned: a soft fade above it so the thread slides under */}
        <div className="relative z-10 px-2.5 pb-2.5 md:px-6 md:pb-5">
          {phase === 'chat' && <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-surface to-transparent" />}
          <div className={COLUMN}>
            <Composer chat={chat} items={items} starters={phase !== 'chat' && tasks.list?.length ? QUICK_STARTERS : undefined} next={phase === 'chat' ? next : undefined} />
          </div>
        </div>
      </section>

      {/* wide screens: the panel; a bit narrower: one round button for it; phones: the button in the chat's header */}
      <aside aria-label="Waiting for you and health" className="hidden w-[284px] shrink-0 flex-col gap-3 overflow-y-auto pb-24 xl:flex [&>*]:shrink-0 min-[90rem]:w-[304px] min-[105rem]:w-[336px]">{panel}</aside>
      <aside aria-label="Waiting for you and health" className="hidden w-12 shrink-0 flex-col items-center pt-1 lg:flex xl:hidden">
        <IconButton label={panelLabel} onClick={() => setSheet('panel')} className="border border-line bg-surface shadow-soft">
          <ShieldCheck size={18} />{pending.length > 0 && <Count n={pending.length} />}
        </IconButton>
      </aside>

      <Drawer open={sheet === 'rail'} onClose={() => setSheet(null)} title="Conversations">
        <Button variant="dark" className="mb-3 w-full" icon={<SquarePen size={15} />} onClick={() => { chat.newChat(); setSheet(null); }}>New chat</Button>
        <RailList current={chat.convId} onOpen={(id) => { chat.open(id); setSheet(null); }} />
      </Drawer>
      <Drawer open={sheet === 'panel'} onClose={() => setSheet(null)} title="Overview">
        <div className="space-y-3">{panel}</div>
      </Drawer>
    </div>
  );
}

// The map's data (what every connected account holds), for "At a glance". undefined while loading; null when it
// can't be read, and then the glance counts what Unit7 itself knows.
function useMapData() {
  const [m, setM] = useState<MapData | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () => runTool('map.get').then((r) => { if (alive) setM(r.status === 'ok' ? r.output as MapData : null); }).catch(() => { if (alive) setM(null); });
    void load();
    // also after any Check again (or a fix's own check), and when something is hidden or brought back, so the glance
    // agrees with the Map and the tasks
    const off = onLive((e) => { if (e.type === 'sync.done' || e.type.startsWith('domain.') || e.type === 'map.rechecked' || (e.type === 'action.completed' && /^(snooze|home)\.(set|clear|dismiss)$/.test(String(e.data?.tool)))) void load(); });
    return () => { alive = false; off(); };
  }, []);
  return m;
}
const SICK = new Set(['unhealthy', 'failed', 'down']);
function glanceOf(graph: any, m: MapData | null): Glance {
  const svcs = graph.projects.flatMap((p: any) => p.environments.flatMap((e: any) => e.services));
  return glance(m ? derive(m) : null, {
    apps: svcs.filter((s: any) => !isDb(s.kind)).map((s: any) => ({ id: s.id, sick: SICK.has(s.status) })),
    servers: graph.servers.map((s: any) => ({ name: s.name, ready: s.status === 'ready' })),
    domains: svcs.flatMap((s: any) => s.domains ?? []).map((d: any) => ({ active: d.status === 'active' })),
  });
}

function IconButton({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} aria-label={label} title={label} className={cx('relative grid size-10 shrink-0 place-items-center rounded-full text-ink-2 transition hover:bg-raised hover:text-ink', className)}>{children}</button>;
}
const Count = ({ n }: { n: number }) => <span className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-blue px-1 text-[10.5px] font-semibold text-white ring-2 ring-surface">{n}</span>;

// the shape of a real thread: your message, the AI's words, a card, your next message
function ThreadSkeleton() {
  return (
    <div className="space-y-5 pt-4" aria-busy="true" aria-label="Loading the conversation">
      <Skeleton className="ml-auto h-11 w-[46%] rounded-[22px] rounded-br-[8px]" />
      <div className="flex gap-3">
        <Skeleton className="hidden size-7 shrink-0 rounded-full sm:block" />
        <div className="min-w-0 flex-1 space-y-2.5 pt-1">
          <Skeleton className="h-3.5 w-[78%] rounded-full" /><Skeleton className="h-3.5 w-[56%] rounded-full" />
          <div className="!mt-4 rounded-[20px] border border-line p-4">
            <div className="flex items-center gap-3"><Skeleton className="size-10 shrink-0 rounded-[14px]" /><div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-[40%] rounded-full" /><Skeleton className="h-3 w-[24%] rounded-full" /></div><Skeleton className="h-8 w-20 rounded-full" /></div>
            <Skeleton className="mt-4 h-2 w-full rounded-full" />
          </div>
        </div>
      </div>
      <Skeleton className="ml-auto h-11 w-[34%] rounded-[22px] rounded-br-[8px]" />
    </div>
  );
}

function LoadError({ text, retry }: { text: string; retry: () => void }) {
  return (
    <div className="my-auto flex flex-col items-center py-10 text-center animate-rise">
      <img src="/illustrations/offline.webp" alt="" width={96} height={100} draggable={false} className="float-y h-[92px] w-auto drop-shadow-[0_12px_16px_rgb(40_30_90/0.16)]" />
      <p className="mt-4 text-[15px] font-medium">Couldn’t load this conversation</p>
      <p className="mt-1 max-w-sm text-[13px] text-muted">{text}</p>
      <Button variant="soft" size="sm" className="mt-4" icon={<RefreshCw size={13} />} onClick={retry}>Try again</Button>
    </div>
  );
}

// --- before the first message ---------------------------------------------------------------------
// the time of day sets the greeting and the sky's colours; at night a few stars come out
type Period = 'morning' | 'afternoon' | 'evening' | 'night';
const periodOf = (h: number): Period => (h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 21 ? 'evening' : 'night');
const SKY: Record<Period, [string, string, string]> = {
  morning: ['#ffc29e', '#ffb3d4', '#a9c6ff'],
  afternoon: ['#9ab9ff', '#d4f76a', '#9fe3ff'],
  evening: ['#ffb07a', '#b9a2ff', '#ff9fcf'],
  night: ['#8f94ff', '#a98bff', '#6f9bff'],
};
const STARS = [[10, 14, 2.6], [19, 34, 3.4], [27, 9, 2.2], [41, 22, 3.8], [63, 11, 2.9], [72, 30, 3.1], [83, 15, 2.4], [91, 38, 3.6], [55, 4, 4.2], [6, 46, 3]] as const;

function greeting(first: string, h: number) {
  if (h < 5) return `Up late, ${first}?`;
  return `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}, ${first}`;
}

function Sky({ on }: { on: boolean }) {
  const p = periodOf(new Date().getHours());
  const [a, b, c] = SKY[p];
  const blob = (bg: string, pos: React.CSSProperties, t: string, dx: string, dy: string) =>
    <span className="sky-blob" style={{ background: bg, ...pos, ['--t' as string]: t, ['--dx' as string]: dx, ['--dy' as string]: dy }} />;
  return (
    <div aria-hidden className={cx('pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-700', on ? 'opacity-100' : 'opacity-0')}>
      <div className="absolute inset-0 opacity-[0.3] dark:opacity-[0.13]">
        {blob(a, { width: '52%', height: '58%', left: '-14%', top: '-22%' }, '26s', '7%', '6%')}
        {blob(b, { width: '44%', height: '52%', right: '-12%', top: '-16%' }, '31s', '-6%', '8%')}
        {blob(c, { width: '50%', height: '50%', right: '-8%', bottom: '-24%' }, '23s', '-8%', '-5%')}
      </div>
      {p === 'night' && (
        <div className="absolute inset-x-0 top-0 h-1/2 text-[#6d5bd0] dark:text-white">
          {STARS.map(([x, y, t]) => <i key={`${x}-${y}`} className="sky-star" style={{ left: `${x}%`, top: `${y}%`, ['--t' as string]: `${t}s` }} />)}
        </div>
      )}
    </div>
  );
}

function Hero({ me, setup, tasks, busy, onDo, onDismiss }: { me: Me; setup: ReturnType<typeof useSetup>; tasks: Task[] | null; busy: string | null; onDo: (t: Task, direct?: boolean) => void; onDismiss: (t: Task) => void }) {
  const first = me.user.name.split(' ')[0]!;
  const ready = setup?.ai && setup.server && setup.live;
  return (
    <div className={cx('flex flex-col items-center text-center', tasks?.length ? 'py-4 md:py-6 min-[105rem]:py-10' : 'py-6 md:py-10 min-[105rem]:py-14')}>
      <div className="animate-rise"><SparkleMark /></div>
      <h1 className="mt-3 text-[27px] font-semibold tracking-[-0.035em] animate-rise md:text-[34px] min-[105rem]:text-[38px]">
        {greeting(first, new Date().getHours())} <span className="inline-block origin-[70%_70%] motion-safe:animate-[wave_1.6s_ease-in-out_0.4s_2]">👋</span>
      </h1>
      <p className="mt-1 text-[15px] text-muted animate-rise md:text-[16.5px]">Tell Unit7 what you need, and it’ll handle the rest.</p>
      <a href="/help-now" onClick={(e) => { e.preventDefault(); navigate('/help-now'); }} className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition hover:text-bad">Help, something’s wrong</a>
      {tasks === null ? <SuggestedSkeleton /> : tasks.length ? <Suggested tasks={tasks} busy={busy} onDo={onDo} onDismiss={onDismiss} /> : <QuickActions />}
      {setup && !ready && <div className="mt-7 w-full text-left animate-rise [animation-delay:300ms]"><GetStarted s={setup} /></div>}
    </div>
  );
}

// the blue four-point sparkle from the reference, with a little twin
function SparkleMark() {
  return (
    <svg width="48" height="48" viewBox="0 0 44 44" aria-hidden className="motion-safe:animate-[sparkle_4s_ease-in-out_infinite]">
      <defs>
        <linearGradient id="spk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7FA6FF" /><stop offset="0.6" stopColor="#1F5BFF" /><stop offset="1" stopColor="#7C4DFF" /></linearGradient>
      </defs>
      <path d="M19 6c1.2 7.6 4.4 10.8 12 12-7.6 1.2-10.8 4.4-12 12-1.2-7.6-4.4-10.8-12-12 7.6-1.2 10.8-4.4 12-12z" fill="url(#spk)" />
      <path d="M35 4.5c.5 3 1.7 4.2 4.5 4.5-2.8.3-4 1.5-4.5 4.5-.5-3-1.7-4.2-4.5-4.5 2.8-.3 4-1.5 4.5-4.5z" fill="#1F5BFF" opacity="0.55" />
    </svg>
  );
}

const QUICK = [
  { key: 'deploy', title: 'Deploy an app', img: '/illustrations/deploy.webp', bg: 'linear-gradient(145deg, #e7e2ff 0%, #d8e3ff 55%, #ffe4d4 100%)', dark: 'linear-gradient(145deg, #b9b0ea 0%, #a9bbef 55%, #e9c3ad 100%)' },
  { key: 'domain', title: 'Connect a domain', img: '/illustrations/domain.webp', bg: 'linear-gradient(145deg, #d9f1ff 0%, #e1e6ff 50%, #ebfbc9 100%)', dark: 'linear-gradient(145deg, #a8cfe6 0%, #b3bce9 50%, #c3dc90 100%)' },
  { key: 'backup', title: 'Back up everything', img: '/illustrations/backup.webp', bg: 'linear-gradient(145deg, #f0e6ff 0%, #fae1ef 55%, #ffe8d8 100%)', dark: 'linear-gradient(145deg, #c6b3ea 0%, #e2b4cc 55%, #ebc4a9 100%)' },
  { key: 'servers', title: 'Check my servers', img: '/illustrations/servers.webp', bg: 'linear-gradient(145deg, #e4f9d4 0%, #d9f3ea 50%, #e1e3ff 100%)', dark: 'linear-gradient(145deg, #b5d993 0%, #a5d3c2 50%, #b3b6ec 100%)' },
] as const;

// each card leans toward the pointer, its picture drifts the other way and a soft light follows; the AI ring shows
// it hands the request to Unit7 (it fills the ask box; nothing runs until you send)
function tilt(e: React.PointerEvent<HTMLButtonElement>) {
  if (e.pointerType !== 'mouse' || reduced()) return;
  const el = e.currentTarget, r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const set = (k: string, v: string) => el.style.setProperty(k, v);
  set('--rx', `${((0.5 - y) * 9).toFixed(2)}deg`); set('--ry', `${((x - 0.5) * 11).toFixed(2)}deg`);
  set('--px', (x - 0.5).toFixed(3)); set('--py', (y - 0.5).toFixed(3));
  set('--mx', `${(x * 100).toFixed(1)}%`); set('--my', `${(y * 100).toFixed(1)}%`);
}
const untilt = (e: React.PointerEvent<HTMLButtonElement>) => ['--rx', '--ry', '--px', '--py'].forEach((k) => e.currentTarget.style.removeProperty(k));

function QuickActions() {
  return (
    <div className="mt-7 grid w-full grid-cols-2 gap-3 md:mt-9 md:grid-cols-4 md:gap-4">
      {QUICK.map((q, i) => (
        <div key={q.key} className="animate-rise" style={{ animationDelay: `${120 + i * 60}ms` }}>
          <button type="button" onClick={() => (q.key === 'domain' ? openDomainLaunch() : q.key === 'servers' ? navigate('/checkup?run=1') : fillAsk(ASK[q.key]))} onPointerMove={tilt} onPointerLeave={untilt}
            className="quick quick-tilt ai-ring group relative flex h-[118px] w-full flex-col items-start justify-between overflow-hidden rounded-[22px] p-4 text-left text-[#141419] active:scale-[0.98] md:h-[150px] md:rounded-[24px] min-[105rem]:h-[172px] min-[105rem]:p-5"
            style={{ ['--q' as string]: q.bg, ['--qd' as string]: q.dark }}>
            <span className="relative z-10 line-clamp-2 max-w-[84%] text-[14px] font-semibold leading-snug tracking-[-0.01em] xl:text-[15px] min-[105rem]:text-[16px]">{q.title}</span>
            {/* a small AI badge that opens into "Ask Unit7" on hover */}
            <span className="relative z-10 hidden h-7 items-center rounded-full bg-white/70 px-[7px] text-[11.5px] font-medium text-[#141419]/80 shadow-[0_1px_2px_rgb(20_20_40/0.08)] backdrop-blur md:inline-flex">
              <AiSparkle size={14} still />
              <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity,margin] duration-300 ease-out-soft group-hover:ml-1 group-hover:max-w-[80px] group-hover:opacity-100 group-focus-visible:ml-1 group-focus-visible:max-w-[80px] group-focus-visible:opacity-100">Ask Unit7</span>
            </span>
            <img src={q.img} alt="" draggable={false} loading="lazy"
              className="pointer-events-none absolute -bottom-2 -right-1.5 h-[70px] w-auto max-w-[62%] object-contain drop-shadow-[0_10px_14px_rgb(40_30_90/0.18)] md:h-[100px] min-[105rem]:h-[122px]" />
          </button>
        </div>
      ))}
    </div>
  );
}

// --- suggested tasks (home.suggest): five things worth doing next, from what Unit7 already knows -----------------
// One quiet list under the greeting: a small icon and the sentence. The one action shows on hover or focus (always,
// small, on phones); where it came from and why show in the hover card; urgent ones carry a single red dot. The
// sentence itself puts the task in the ask box, so nothing runs from a stray click.
export interface Task {
  id: string; text: string; why: string; source: 'problem' | 'approval' | 'stale' | 'history' | 'suggestion' | 'setup'; label: string; icon: string; related?: number;
  severity: 'alert' | 'warn' | 'info'; fix?: { tool: string; input: Record<string, unknown>; label: string; success?: string };
  href?: string; cta?: string; ask?: string; conversationId?: string; about?: ContextItem; at?: string;
  explain?: Explain; snoozeKey?: string; // plain words for the hover; what "This is fine" hides
}
const QUICK_STARTERS: Starter[] = [
  { label: 'Deploy an app', ask: ASK.deploy }, { label: 'Connect a domain', ask: ASK.domain.trim() }, { label: 'Back up everything', ask: ASK.backup },
];

// loads once, then again (quietly) whenever something real happens; a dismissed one leaves at once
function useTasks() {
  const [list, setList] = useState<Task[] | null>(null);
  const load = useCallback(() => runTool('home.suggest').then((r) => setList(r.status === 'ok' ? (r.output as { tasks: Task[] }).tasks : [])).catch(() => setList((l) => l ?? [])), []);
  useEffect(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => { if (e.live && e.type !== 'agent.done') return; clearTimeout(t); t = setTimeout(load, 1200); });
    return () => { off(); clearTimeout(t); };
  }, [load]);
  const dismiss = async (task: Task, hidden = false) => {
    setList((l) => l?.filter((x) => x.id !== task.id) ?? l);
    if (hidden) { void load(); return; } // "This is fine" or "Hide for now" already hid it
    try {
      const r = await runTool('home.dismiss', { id: task.id });
      if (r.status === 'ok') toast('info', 'Hidden for a week', task.text, { action: { label: 'Undo', onClick: async () => { await runTool('home.dismiss', { id: task.id, hide: false }); void load(); } } });
    } catch { /* it comes back on the next load */ }
    void load();
  };
  return { list, reload: load, dismiss };
}

const TASK_ICON: Record<string, typeof Globe> = {
  alert: TriangleAlert, backup: DatabaseBackup, shield: ShieldAlert, globe: Globe, server: Server, app: AppWindow, history: History, repeat: Repeat,
  bell: BellRing, wallet: Wallet, approval: ShieldCheck, lock: Lock, disk: HardDrive, bug: Bug, database: Database, mail: MailWarning,
};
const SEV_WORD: Record<Task['severity'], string> = { alert: 'Urgent', warn: 'Worth a look soon', info: 'When you have a minute' };
const sevDot = (s: Task['severity']) => (s === 'alert' ? 'bg-bad' : s === 'warn' ? 'bg-[#f59e0b]' : '');

function TaskIcon({ t }: { t: Task }) {
  const I = TASK_ICON[t.icon];
  return <span aria-hidden className="grid size-5 shrink-0 place-items-center text-muted">{I ? <I size={16} strokeWidth={1.9} /> : <BrandLogo id={t.icon} size={15} />}</span>;
}

// the why, on hover or keyboard focus: how urgent, where it came from, the reason, and what one click does
function Why({ t }: { t: Task }) {
  return (
    <div className="max-w-[300px] space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted">
        {t.severity !== 'info' && <span aria-hidden className={cx('size-1.5 rounded-full', sevDot(t.severity))} />}{SEV_WORD[t.severity]} · {t.label}
      </p>
      {t.explain?.why ? <ExplainBlock e={{ ...t.explain, advanced: undefined }} compact /> : <p className="text-[13px] leading-snug text-ink-2">{tidy(t.why)}</p>}
      {t.fix ? <p className="text-[12px] text-faint">{t.fix.label} runs it in one click.</p>
        : !t.href && <p className="text-[12px] text-faint">{t.conversationId ? 'Opens that chat so Unit7 can carry on.' : 'Puts it in the ask box. Nothing runs until you send it.'}</p>}
    </div>
  );
}

// the one action: the fix's own words, "Review ↗" for a page, otherwise "Do it →"
function DoIt({ t, busy, onDo }: { t: Task; busy: boolean; onDo: () => void }) {
  const label = t.fix ? t.fix.label : t.href ? t.cta ?? 'Open' : t.conversationId ? 'Carry on' : 'Do it';
  const Icon = busy ? Loader2 : t.href ? ArrowUpRight : ArrowRight;
  return (
    <button type="button" onClick={onDo} disabled={busy} title={t.fix ? `${t.fix.label}: runs it now` : undefined}
      className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-medium text-blue-text transition-colors hover:bg-blue-soft disabled:opacity-60">
      {label}<Icon size={13} aria-hidden className={cx(busy && 'animate-spin', !busy && 'transition-transform group-hover:translate-x-0.5')} />
    </button>
  );
}

function Suggested({ tasks, busy, onDo, onDismiss }: { tasks: Task[]; busy: string | null; onDo: (t: Task, direct?: boolean) => void; onDismiss: (t: Task) => void }) {
  // "Check again" on a problem: its mark works, then turns into a tick and the row folds away, or says it's still there
  const [mark, setMark] = useState<Record<string, MarkState>>({});
  const again = async (t: Task) => {
    const c = taskCheck(t);
    if (!c) return;
    setMark((m) => ({ ...m, [t.id]: 'work' }));
    try {
      const r = await runTool('alert.recheck', c);
      const fixed = r.status === 'ok' ? !!r.output?.fixed : r.status === 'error' && r.error.code === 'not_found';
      if (fixed) { setMark((m) => ({ ...m, [t.id]: 'ok' })); setTimeout(() => onDismiss(t), 1400); return; }
      setMark((m) => ({ ...m, [t.id]: 'warn' }));
      toast('warn', 'Still there', r.status === 'ok' ? r.output?.still ?? r.output?.note : r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : undefined,
        t.ask ? { action: { label: 'Ask Unit7 to fix it', onClick: () => onDo(t, false) } } : undefined);
    } catch (e) { setMark((m) => { const { [t.id]: _, ...rest } = m; return rest; }); toast('bad', 'Couldn’t check', (e as Error).message); }
  };
  return (
    <section aria-labelledby="suggested-h" className="mt-8 w-full max-w-[640px] text-left md:mt-10">
      <h2 id="suggested-h" className="mb-1 px-3 text-[12px] font-medium text-faint animate-rise [animation-delay:80ms]">Suggested for you</h2>
      <ul>
        {tasks.map((t, i) => (
          <li key={t.id} className="group relative flex min-h-11 items-center gap-3 rounded-[14px] py-1.5 pl-3 pr-1 transition-colors focus-within:bg-raised/70 hover:bg-raised/70 animate-rise" style={{ animationDelay: `${120 + i * 50}ms` }}>
            {t.severity === 'alert' && !mark[t.id] && <span aria-hidden className="absolute left-[3px] top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-bad" />}
            {mark[t.id] ? <StatusMark state={mark[t.id]} size={18} label={mark[t.id] === 'ok' ? 'Fixed and checked' : mark[t.id] === 'work' ? 'Checking again' : 'Still there'} className="shrink-0" /> : <TaskIcon t={t} />}
            <HoverCard content={<Why t={t} />}>
              <button type="button" onClick={() => onDo(t, false)} aria-label={`${t.text}. ${SEV_WORD[t.severity]}, from ${t.label}`}
                className="min-w-0 flex-1 truncate rounded-md py-1 text-left text-[14px] text-ink-2 outline-none transition-colors group-hover:text-ink focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-blue/40">{t.text}{t.related ? <span className="ml-1.5 text-[12px] text-muted">+{t.related} related</span> : null}</button>
            </HoverCard>
            <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100 pointer-coarse:opacity-100">
              {taskCheck(t) && mark[t.id] !== 'ok' && (
                <button type="button" onClick={() => void again(t)} disabled={mark[t.id] === 'work'} aria-label={`Check again: ${t.text}`} title="Check again (read-only)"
                  className="grid size-7 shrink-0 place-items-center rounded-full text-muted transition hover:bg-blue-soft hover:text-blue-text disabled:opacity-60">
                  <RefreshCw size={13} aria-hidden className={cx(mark[t.id] === 'work' && 'animate-spin motion-reduce:animate-none')} />
                </button>
              )}
              <DoIt t={t} busy={busy === t.id} onDo={() => onDo(t)} />
              <SnoozeMenu id={t.snoozeKey ?? t.id} title={t.text} kind="task" iconOnly onDone={() => onDismiss(t)} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SuggestedSkeleton() {
  return (
    <div className="mt-8 w-full max-w-[640px] md:mt-10" aria-busy="true" aria-label="Loading suggestions">
      <Skeleton className="mb-3 ml-3 h-3 w-24 rounded-full" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex min-h-11 items-center gap-3 px-3">
          <Skeleton className="size-4 rounded-[5px]" /><Skeleton className={cx('h-3 rounded-full', ['w-[52%]', 'w-[40%]', 'w-[58%]', 'w-[34%]', 'w-[46%]'][i])} />
        </div>
      ))}
    </div>
  );
}

// the thread's header: "About" and the chips of what this chat looks at
function AboutLine({ about, logoFor }: { about: ContextItem[]; logoFor: (id: string) => string | undefined }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11.5px] text-muted" aria-label={`About: ${about.map((c) => c.name).join(', ')}`}>
      <span className="shrink-0">About</span>
      {about.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <span aria-hidden className="text-faint">·</span>}
          <span className="inline-flex min-w-0 shrink-0 items-center gap-1 font-medium text-ink-2 last:shrink" title={c.name}><AboutLogo kind={c.kind} logo={logoFor(c.id)} size={11} /><span className="truncate">{c.name}</span></span>
        </Fragment>
      ))}
    </p>
  );
}

// --- the side panel: what's waiting for you, and how things are ----------------------------------
function PanelBody({ me, pending, reload, g }: { me: Me; pending: any[]; reload: () => void; g: Glance | null }) {
  // all clear: there's something to watch, and none of it needs a look
  const calm = !!g && g.apps.n + g.servers.n + g.domains.n > 0 && !g.apps.look && !g.servers.look && !g.domains.look;
  // the morning's story first, then what needs you, how things are, and what it all costs
  return <><SevenLine /><MorningBrief hideApprovals={pending.length > 0} /><Waiting items={pending} me={me} reload={reload} calm={calm} /><FreshHomeCard /><GlanceCard g={g} /><CostRadar compact /></>;
}

function Waiting({ items, me, reload, calm }: { items: any[]; me: Me; reload: () => void; calm: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const canDecide = ['owner', 'admin', 'developer'].includes(me.role);
  // you just cleared the last one: the all-clear plays again
  const [cleared, setCleared] = useState(0);
  const had = useRef(items.length);
  useEffect(() => { if (had.current > 0 && !items.length) setCleared((n) => n + 1); had.current = items.length; }, [items.length]);
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      const r = await api(`/api/approvals/${id}/${approve ? 'approve' : 'reject'}`, { body: {} });
      if (r.status === 'ok') toast('ok', 'Approved and done');
      else if (r.status === 'rejected') toast('info', 'Skipped', 'Nothing was changed.');
      else if (r.status === 'error') toast('bad', 'Approved, but it didn’t work', r.error.message, { action: askAction(`I approved an action and it didn’t work: “${r.error.message.slice(0, 240)}”. Why, and how do I fix it?`) });
      else if (r.status === 'denied') toast('bad', 'Your rules blocked it', r.why);
    } catch (e) {
      toast('bad', 'Could not record that', (e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };
  if (!items.length && calm) return <AllClear key={cleared} />;
  return (
    <section className={cx('rounded-[24px] border bg-surface p-4 shadow-soft transition-shadow', items.length ? 'border-blue/25 ring-4 ring-blue-soft' : 'border-line')}>
      <div className="flex items-center gap-2.5">
        <IconCircle size={34} tone={items.length ? 'blue' : 'lime'}>{items.length ? <ShieldCheck size={16} /> : <Check size={16} strokeWidth={2.6} />}</IconCircle>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14.5px] font-medium tracking-[-0.01em]"><A href="/approvals" className="hover:underline decoration-line-strong underline-offset-4">Waiting for you</A></h2>
          <p className="text-[12px] leading-snug text-muted">{items.length ? 'Nothing happens until you say yes.' : 'Nothing needs your OK right now.'}</p>
        </div>
        {items.length > 0 && <Badge tone="ember" solid className="tabular">{items.length}</Badge>}
      </div>
      {items.length > 0 && (
        <ul className="mt-3 space-y-2">
          {items.slice(0, 4).map((a) => { const w = approvalWords(a); return (
            <li key={a.id} className="rounded-[16px] bg-raised p-3 animate-rise">
              <p className="text-[13px] font-medium leading-snug" title={w.raw || undefined}>{w.title}</p>
              <p className="mt-0.5 truncate text-[11.5px] text-muted">{w.who} · {timeAgo(a.created_at)}{a.environment ? ` · ${a.environment}` : ''}</p>
              <ExplainBlock compact className="mt-2" e={{ ...explainOf(a, w, changeWords(a.tool, a.input)), what: '', advanced: undefined }} labels={APPROVAL_LABELS} />
              {/* the shared choice row: Approve recommended when it's safe; a hard one is reviewed on Approvals (its name is typed there) */}
              {canDecide ? (
                <Choices className="mt-2.5" label="Your OK" disabled={!!busy} why={false}
                  choices={approvalChoices({ tier: a.tier, hard: (a.tier ?? 0) >= 3 && !!a.confirm }).filter((c) => !((a.tier ?? 0) >= 3 && a.confirm && c.key === 'approve'))}
                  onPick={(c) => (c.key === 'approve' ? (void decide(a.id, true), true) : c.key === 'reject' ? (void decide(a.id, false), true) : false)} />
              ) : <Badge tone="warn" className="mt-2">Needs an admin</Badge>}
            </li>
          ); })}
        </ul>
      )}
      <A href="/approvals" className="mt-3 inline-block text-[12.5px] font-medium text-blue-text hover:underline">{items.length > 4 ? `See all ${items.length}` : 'Past decisions'}</A>
    </section>
  );
}

// nothing waiting and nothing wrong: a little moment, once when it appears (and again when you clear the last one)
const BURST = ['#c6f432', '#1f5bff', '#8b5cf6', '#c6f432', '#26b5f0', '#1f5bff', '#d16bf5', '#c6f432'];
function AllClear() {
  return (
    <section className="relative overflow-hidden rounded-[24px] border border-line bg-surface p-4 shadow-soft animate-rise">
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 size-40 rounded-full bg-lime/25 blur-2xl dark:bg-lime/10" />
      <div className="relative flex items-center gap-3.5">
        <span className="relative grid size-16 shrink-0 place-items-center">
          <span aria-hidden className="burst absolute inset-0">{BURST.map((c, i) => <i key={i} style={{ background: c, ['--a' as string]: `${i * 45 + 20}deg`, animationDelay: `${180 + (i % 3) * 40}ms` }} />)}</span>
          <img src="/illustrations/clear.webp" alt="" width={56} height={66} draggable={false} className="float-y relative h-[62px] w-auto drop-shadow-[0_10px_14px_rgb(40_30_90/0.18)]" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.015em]">All clear</h2>
          <p className="text-[12.5px] leading-snug text-muted">Nothing needs you. Unit7 keeps watch day and night.</p>
          <A href="/approvals" className="mt-1 inline-block text-[12px] font-medium text-blue-text hover:underline">Past decisions</A>
        </div>
      </div>
    </section>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const lookWords = (n: number) => `${n} need${n === 1 ? 's' : ''} a look`;
function GlanceCard({ g }: { g: Glance | null }) {
  if (!g) {
    return (
      <section aria-busy="true" aria-label="Loading how things are" className="rounded-[24px] border border-line bg-surface p-2 shadow-soft">
        <Skeleton className="mx-2.5 mb-3 mt-3 h-3.5 w-20 rounded-full" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 px-2.5 py-2.5">
            <Skeleton className="size-9 shrink-0 rounded-[12px]" />
            <div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-16 rounded-full" /><Skeleton className="h-2.5 w-24 rounded-full" /></div>
            <Skeleton className="h-6 w-8 rounded-[8px]" />
          </div>
        ))}
      </section>
    );
  }
  const { apps, servers, domains } = g;
  const tone = (n: number, look: number): 'ok' | 'bad' | 'idle' => (look ? 'bad' : n ? 'ok' : 'idle');
  return (
    <section className="rounded-[24px] border border-line bg-surface p-2 shadow-soft">
      <h2 className="px-2.5 pb-1 pt-2 text-[14.5px] font-medium tracking-[-0.01em]">At a glance</h2>
      <HealthRow href="/map?type=app" icon={<AppWindow size={16} />} label="Apps" n={apps.n} tone={tone(apps.n, apps.look)}
        word={apps.look ? lookWords(apps.look) : apps.n ? 'All good' : 'None yet'}
        extra={apps.hosts.length > 0 && (
          <span className="ml-1.5 inline-flex items-center" title={`On ${apps.hosts.map(providerName).join(', ')}`}>
            {apps.hosts.slice(0, 4).map((h, i) => <span key={h} className="grid size-[18px] place-items-center rounded-full bg-surface ring-2 ring-surface" style={{ marginLeft: i ? -5 : 0, zIndex: 4 - i }}><BrandLogo id={h} size={12} /></span>)}
            {apps.hosts.length > 4 && <span className="ml-1 text-[11px] text-faint">+{apps.hosts.length - 4}</span>}
          </span>
        )} />
      <HealthRow href="/servers" icon={<Server size={16} />} label="Servers" n={servers.n} tone={tone(servers.n, servers.look)}
        word={servers.look ? lookWords(servers.look) : servers.n ? 'All good' : 'None yet'} />
      <HealthRow href={domains.look ? '/map?type=domain&status=attention' : '/map?type=domain'} icon={<Globe size={16} />} label="Domains" n={domains.n} tone={tone(domains.n, domains.look)}
        aria={`${plural(domains.n, 'domain')} · ${plural(domains.subs, 'subdomain')}`}
        word={[domains.subs ? plural(domains.subs, 'subdomain') : '', domains.look ? lookWords(domains.look) : domains.n ? 'All good' : 'None yet'].filter(Boolean)} />
      {!g.synced && <A href="/map" className="mx-2.5 mb-2 mt-1 flex items-center gap-1.5 text-[12px] font-medium text-blue-text hover:underline">See everything you run on the Map<ArrowUpRight size={13} /></A>}
    </section>
  );
}
// word: one phrase, or a few that wrap whole ("17 subdomains ·" / "3 need a look")
function HealthRow({ href, icon, label, n, word, tone, extra, aria }: { href: string; icon: React.ReactNode; label: string; n: number; word: string | string[]; tone: 'ok' | 'bad' | 'warn' | 'idle'; extra?: React.ReactNode; aria?: string }) {
  const words = typeof word === 'string' ? [word] : word;
  return (
    <A href={href} aria-label={`${label}: ${aria ?? n}, ${words.join(', ')}`} className="group flex items-center gap-3 rounded-[16px] px-2.5 py-2.5 transition hover:bg-raised">
      <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-raised text-ink-2 transition group-hover:bg-surface">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center text-[13px] font-medium text-ink">{label}{extra}</span>
        <span className="flex items-start gap-1.5 text-[11.5px] leading-snug text-muted">
          <span className={cx('mt-[5px] size-1.5 shrink-0 rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-[#f59e0b]' : 'bg-faint/60')} />
          <span className="min-w-0">{words.map((w, i) => <Fragment key={w}>{i > 0 && ' '}<span className="whitespace-nowrap">{w}{i < words.length - 1 && ' ·'}</span></Fragment>)}</span>
        </span>
      </span>
      <span className="text-[22px] font-semibold leading-none tracking-[-0.04em]"><CountUp value={n} /></span>
      <ArrowUpRight size={14} aria-hidden className="shrink-0 text-faint transition group-hover:text-ink" />
    </A>
  );
}
