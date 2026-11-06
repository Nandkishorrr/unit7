// Who answers the ask box, and getting them ready right there: your own Claude subscription or Google account
// (Install / Sign in opens Terminal on the Mac where Unit7 runs, then this flips to Ready by itself), or a model on
// an API key. The same rows show inline in the box while nothing can answer yet, and in the picker after.
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Download, KeyRound, LogIn, Lock, Terminal } from 'lucide-react';
import { api, useApi } from '../../lib/api';
import { A, Button, CopyButton, cx, toast } from '../../ui';
import { BrandLogo } from '../../brand/BrandLogo';

export type Cli = 'claude';
type BrainState = 'ready' | 'not-installed' | 'sign-in' | 'taken';
export interface BrainStatus {
  ready: boolean; model: string; mode?: string; reason?: string; models?: { ref: string; label: string; source: string }[]; bridge?: { watching: boolean; pending: number };
  brain?: Cli | null; brains?: { id: Cli; label: string; state: BrainState; note: string }[]; // your own Claude / Google account
}
type Step = 'install' | 'sign-in';
interface SetupInfo { canOpen: boolean; commands: Record<Cli, Record<Step, string>> }

const NAME: Record<Cli, string> = { claude: 'Claude' };
const VIA: Record<Cli, string> = { claude: 'your Claude subscription' };

// The brains' state plus the setup in progress. After Install / Sign in it checks every 3 seconds (for up to ten
// minutes) until that AI is ready; then, if nothing else answers the box yet, it starts using it.
export function useBrains(status: BrainStatus | undefined, reload: () => void) {
  const setup = useApi<SetupInfo>('/api/agent/setup', { live: false });
  const [waiting, setWaiting] = useState<Partial<Record<Cli, Step>>>({});
  const [busy, setBusy] = useState<Cli | null>(null);
  const any = Object.keys(waiting).length > 0;
  useEffect(() => {
    if (!any) return;
    const t = setInterval(reload, 3000);
    const give = setTimeout(() => setWaiting({}), 10 * 60_000);
    return () => { clearInterval(t); clearTimeout(give); };
  }, [any]);
  useEffect(() => {
    const done = (status?.brains ?? []).filter((b) => waiting[b.id] && b.state === 'ready');
    if (!done.length) return;
    setWaiting((w) => { const n = { ...w }; done.forEach((b) => delete n[b.id]); return n; });
    const b = done[0]!;
    if (!status!.ready) void choose(b.id);
    else toast('ok', `${NAME[b.id]} is ready`, 'Pick it in the box whenever you like.');
  }, [status]);

  const choose = async (cli: Cli | null) => {
    try {
      await api('/api/agent/brain', { body: { brain: cli } });
      reload();
      if (cli) toast('ok', `${NAME[cli]} now answers your ask box`, `It runs on ${VIA[cli]}, no API key.`);
    } catch (e) { toast('bad', 'Couldn’t switch', (e as Error).message); }
  };
  const pickModel = async (ref: string, label: string) => {
    try {
      if (status?.brain) await api('/api/agent/brain', { body: { brain: null } });
      if (ref !== status?.model) await api('/api/org/settings', { method: 'PATCH', body: { agentModel: ref } });
      reload();
      toast('ok', `Unit7 AI now uses ${label}`);
    } catch (e) { toast('bad', 'Couldn’t switch', (e as Error).message); }
  };
  const start = async (cli: Cli, step: Step) => {
    setBusy(cli);
    try {
      await api('/api/agent/setup', { body: { cli, step } });
      setWaiting((w) => ({ ...w, [cli]: step }));
    } catch (e) { toast('bad', 'Terminal didn’t open', (e as Error).message); }
    finally { setBusy(null); }
  };
  return { status, setup: setup.data, waiting, busy, choose, pickModel, start };
}
export type Brains = ReturnType<typeof useBrains>;

// the one click that connects an AI: the next thing to do for the first one free. Nothing when Terminal can't be opened from here: the
// strip in the ask box shows the command then.
export function connectOne(brains: Brains) {
  const b = (brains.status?.brains ?? []).find((x) => x.state !== 'taken');
  if (!b) return undefined;
  if (b.state === 'ready') return { label: `Use my ${NAME[b.id]}`, go: () => void brains.choose(b.id) };
  if (!brains.setup?.canOpen) return undefined;
  const step: Step = b.state === 'not-installed' ? 'install' : 'sign-in';
  return { label: step === 'install' ? `Install ${NAME[b.id]}` : `Sign in to ${NAME[b.id]}`, go: () => void brains.start(b.id, step) };
}

// One AI: its logo, where it stands in plain words, and the one thing to do next
function BrainRow({ b, brains, dense }: { b: NonNullable<BrainStatus['brains']>[number]; brains: Brains; dense?: boolean }) {
  const { status, setup, waiting, busy } = brains;
  const current = status?.brain === b.id;
  const wait = waiting[b.id];
  const step: Step | null = b.state === 'not-installed' ? 'install' : b.state === 'sign-in' ? 'sign-in' : null;
  const line = wait ? (wait === 'install' ? 'Installing in Terminal…' : 'Waiting for you to sign in…')
    // "can answer here", so it never reads like Connections' "Claude Code can use Unit7" (a different thing)
    : current ? 'Answers your ask box' : b.state === 'ready' ? 'Can answer here'
    : b.state === 'not-installed' ? 'Install it to answer here' : b.state === 'sign-in' ? 'Sign in to answer here'
    : 'Someone else on this Mac uses it';
  return (
    <div className={cx('rounded-[18px] transition-colors', dense ? 'bg-surface p-2.5 ring-1 ring-line' : 'p-2', current && 'bg-blue-soft/60')}>
      <div className="flex items-center gap-3">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-[12px] bg-raised">
          <BrandLogo id={b.id} size={18} />
          <span aria-hidden className={cx('absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-surface',
            b.state === 'ready' ? 'bg-ok' : wait ? 'animate-working bg-blue' : b.state === 'taken' ? 'bg-faint' : 'bg-[#f59e0b]')} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium text-ink" title={`${NAME[b.id]} on ${VIA[b.id]}`}>{NAME[b.id]}</p>
          <p className={cx('truncate text-[12px]', wait ? 'text-blue-text' : 'text-muted')} title={b.state === 'taken' ? b.note : undefined}>{line}</p>
        </div>
        {b.state === 'ready'
          ? current ? <span className="inline-flex h-8 items-center gap-1 px-2 text-[12.5px] font-medium text-blue-text"><Check size={14} strokeWidth={2.6} />In use</span>
            : <Button size="sm" variant="soft" onClick={() => void brains.choose(b.id)}>Use</Button>
          : b.state === 'taken' ? <Lock size={15} aria-label="Taken" className="mx-2 text-faint" />
          : step && setup?.canOpen && !wait ? <Button size="sm" variant="primary" loading={busy === b.id} icon={step === 'install' ? <Download size={13} /> : <LogIn size={13} />} onClick={() => void brains.start(b.id, step)}>{step === 'install' ? 'Install' : 'Sign in'}</Button>
          : null}
      </div>
      {wait && <p className="mt-2 rounded-[12px] bg-blue-soft px-3 py-2 text-[12.5px] text-blue-text animate-pop">Finish {wait === 'install' ? 'installing and signing in' : 'signing in'} in the Terminal window that opened. This updates by itself.</p>}
      {step && setup && !setup.canOpen && (
        <div className="mt-2 flex items-center gap-2 rounded-[12px] bg-raised py-1.5 pl-3 pr-1.5">
          <Terminal size={13} aria-hidden className="shrink-0 text-muted" />
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={setup.commands[b.id][step]}>{setup.commands[b.id][step]}</code>
          <CopyButton text={setup.commands[b.id][step]} />
        </div>
      )}
      {step && setup && !setup.canOpen && <p className="mt-1.5 px-1 text-[11.5px] text-muted">Run this in Terminal on the computer where Unit7 runs{step === 'install' ? ', then sign in' : ''}.</p>}
    </div>
  );
}

// Inside the ask box while nothing can answer it: both AIs, with their button right there
export function BrainStrip({ brains }: { brains: Brains }) {
  const list = brains.status?.brains ?? [];
  if (!list.length) return null;
  return (
    <div data-brainstrip className="border-b border-line px-3 pb-3 pt-3 animate-rise">
      <p className="px-1 pb-2 text-[12.5px] font-medium text-ink-2">Who should answer? <span className="font-normal text-muted">Use your own account, no API key.</span></p>
      <div className="grid gap-2 sm:grid-cols-2">{list.map((b) => <BrainRow key={b.id} b={b} brains={brains} dense />)}</div>
      <p className="px-1 pt-2 text-[12px] text-muted">Or <A href="/connections" className="font-medium text-blue-text hover:underline">add an API key</A> for a model.</p>
    </div>
  );
}

// The pill in the box's corner, and the panel it opens (upward: the box sits at the bottom of the screen). While the
// AI works, a soft ring breathes out of its logo.
export function BrainPicker({ brains, working }: { brains: Brains; working?: boolean }) {
  const { status } = brains;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[data-panel] button, [data-panel] a')?.focus();
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  if (!status) return <span className="h-8 w-28 rounded-full skeleton" />;
  const mine = status.brains?.find((b) => b.id === status.brain);
  const model = !mine && status.ready ? status.models?.find((m) => m.ref === status.model) : undefined;
  const current = mine ? NAME[mine.id] : model?.label ?? 'Choose who answers';
  const setupNeeded = (status.brains ?? []).some((b) => b.state === 'sign-in' || b.state === 'not-installed');
  return (
    <div ref={box} className="relative min-w-0">
      <button ref={btn} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label={`Who answers: ${current}`}
        className={cx('inline-flex h-8 min-w-0 max-w-[230px] items-center gap-2 rounded-full pl-2 pr-2 text-[12.5px] text-ink-2 outline-none transition hover:bg-sunken focus-visible:ring-4 focus-visible:ring-blue-soft', open ? 'bg-sunken' : 'bg-raised')}>
        {mine || model
          ? <span className={cx('grid size-[18px] shrink-0 place-items-center rounded-full bg-surface', working && 'ai-ping')}><BrandLogo id={mine ? mine.id : model!.ref.split(':')[0]!} size={13} /></span>
          : <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[#f59e0b]" />}
        <span className="truncate">{current}</span>{working && <span className="sr-only"> is working</span>}
        <ChevronDown size={13} aria-hidden className={cx('shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div data-panel role="dialog" aria-label="Who answers your ask box"
          className="animate-pop absolute bottom-full left-0 z-40 mb-2 max-h-[min(70dvh,560px)] w-[min(360px,calc(100vw-40px))] origin-bottom-left overflow-y-auto rounded-[22px] border border-line bg-surface p-1.5 shadow-float">
          <p className="px-3 pb-1 pt-2 text-[11.5px] font-medium text-faint">Your own account · no API key</p>
          {(status.brains ?? []).map((b) => <BrainRow key={b.id} b={b} brains={brains} />)}
          {setupNeeded && !brains.setup?.canOpen && brains.setup && <p className="px-3 pb-1 text-[11.5px] text-muted">Only an owner or admin, on the Mac where Unit7 runs, can install from here.</p>}
          <p className="mt-1 border-t border-line px-3 pb-1 pt-2.5 text-[11.5px] font-medium text-faint">With an API key</p>
          {status.models?.length ? status.models.map((m) => {
            const on = m.ref === model?.ref;
            return (
              <button key={m.ref} type="button" onClick={() => { setOpen(false); if (!on) void brains.pickModel(m.ref, m.label); }}
                className={cx('flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left text-[13.5px] transition hover:bg-raised focus-visible:bg-raised', on && 'bg-blue-soft/60')}>
                <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-raised"><KeyRound size={15} className="text-ink-2" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium text-ink">{m.label}</span><span className="block truncate text-[12px] text-muted">{m.source}</span></span>
                {on && <Check size={15} strokeWidth={2.6} className="text-blue-text" aria-label="In use" />}
              </button>
            );
          }) : (
            <A href="/connections" onClick={() => setOpen(false)} className="flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-[13.5px] transition hover:bg-raised">
              <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-raised"><KeyRound size={15} className="text-ink-2" /></span>
              <span className="min-w-0 flex-1"><span className="block font-medium text-ink">Add an API key</span><span className="block text-[12px] text-muted">In Connections, under AI models</span></span>
            </A>
          )}
        </div>
      )}
    </div>
  );
}

// No model connected: your own Claude Code answers this box (over MCP, no API key, no Claude login)
export function BridgeChip({ watching }: { watching: boolean }) {
  return (
    <span className="inline-flex h-8 min-w-0 items-center gap-2 rounded-full bg-raised px-3 text-[12.5px] text-ink-2" title={watching ? 'Your Claude Code is listening and answers here' : 'Your Claude Code answers here once it’s set up'}>
      <span className={cx('size-1.5 shrink-0 rounded-full', watching ? 'bg-ok' : 'bg-[#f59e0b]')} />
      <span className="truncate">{watching ? 'Claude Code is listening' : 'Claude Code isn’t listening yet'}</span>
    </span>
  );
}
