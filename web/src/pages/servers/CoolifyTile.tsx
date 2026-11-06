// Coolify, connected by Unit7 itself: with root on the server it turns Coolify's API on and makes its own key there
// (coolify.connect auto), so there's nothing to copy or paste. Pasting a token made in Coolify stays as the fallback.
// CoolifyConnectModal is the pop-up the server page and the Connections tile open; ConnectFlow is what's inside it.
import { useEffect, useState } from 'react';
import { CircleAlert, ExternalLink, KeyRound, Plug, Power, RefreshCw, Search, ShieldCheck, Undo2, Unplug } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { runTool, type ToolResult } from '../../lib/api';
import { tidy } from '../../lib/words';
import { Button, Input, Modal, act, confirmDialog, cx, toast, StatusMark } from '../../ui';
import { useProgress } from '../chat/cards/kit';

interface Status {
  version?: string; dashboard?: string; projects?: number; auto?: string[]; steps: { step: number; text: string; url?: string }[];
  connected: null | { accountId: string; status: string; version?: string; abilities: string[]; can: string[]; automatic?: boolean; key?: string; expiresAt?: string };
}
interface Result { status: string; version?: string; key?: string; can?: string[]; abilities?: string[]; expiresAt?: string; changeId?: string; apiChange?: string; note?: string; problem?: string; replaced?: string }
const errOf = (r: ToolResult) => (r.status === 'error' ? tidy(r.error.message) : r.status === 'denied' ? r.why : r.status === 'approval_required' ? 'It’s waiting for an approval.' : 'That didn’t work.');
const run = (input: Record<string, unknown>) => runTool('coolify.connect', input).catch((e: Error): ToolResult => ({ status: 'error', error: { code: 'network', message: e.message } }));
const until = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : undefined);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function useStatus(serverId: string) {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => void run({ serverId }).then((r) => (r.status === 'ok' ? (setS(r.output as Status), setErr(null)) : setErr(errOf(r))));
  useEffect(reload, [serverId]);
  return { s, err, reload };
}

// The four things "Connect automatically" does, lit up as the live progress reaches them
const STEPS: { icon: typeof Search; label: string }[] = [
  { icon: Search, label: 'Find Coolify on the server' },
  { icon: Power, label: 'Turn on its API, if it’s off' },
  { icon: KeyRound, label: 'Make Unit7 its own key there' },
  { icon: ShieldCheck, label: 'Keep it in the vault and check it' },
];
const reached = (lines: string[]) => lines.reduce((n, l) => Math.max(n, /Keeping the key/.test(l) ? 3 : /its API/.test(l) ? 1 : 0), 0);
function Steps({ at, done, failed }: { at: number; done?: boolean; failed?: boolean }) {
  return (
    <ol className="space-y-1" aria-label="What Unit7 does">
      {STEPS.map(({ icon: Icon, label }, i) => {
        const state = done || i < at ? 'done' : i === at ? (failed ? 'failed' : 'now') : i === at + 1 && at === 1 ? 'now' : 'later';
        return (
          <li key={label} className="animate-rise flex items-center gap-3 rounded-[14px] px-2 py-1.5" style={{ animationDelay: `${i * 60}ms` }}>
            {state === 'done' ? <StatusMark state="ok" size={32} solid label="Done" className="shrink-0" /> : (
              <span className={cx('grid size-8 shrink-0 place-items-center rounded-full transition-colors duration-300',
                state === 'failed' ? 'bg-bad-solid text-white' : state === 'now' ? 'bg-blue text-white' : 'bg-raised text-faint')}>
                {state === 'failed' ? <CircleAlert size={15} /> : <Icon size={15} className={state === 'now' ? 'motion-safe:animate-pulse' : undefined} />}
              </span>
            )}
            <span className={cx('text-[13.5px]', state === 'later' ? 'text-muted' : 'text-ink')}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

// connect, reconnect, paste, disconnect: everything for one server's Coolify
export function ConnectFlow({ serverId, serverName, human, onConnected, paste: pasteFirst = false }: { serverId: string; serverName: string; human: boolean; onConnected?: () => void; paste?: boolean }) {
  const { s, err, reload } = useStatus(serverId);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'failed' | 'paste'>(pasteFirst ? 'paste' : 'idle');
  const [secrets, setSecrets] = useState(false);
  const [out, setOut] = useState<Result | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = useProgress(['coolify.connect'], phase === 'running');
  const connect = async (readSecrets = secrets) => {
    setPhase('running'); setProblem(null); setSecrets(readSecrets); // Try again asks for the same
    const r = await run({ serverId, auto: true, readSecrets });
    const o = r.status === 'ok' ? (r.output as Result) : undefined;
    if (!o || o.status !== 'verified') { setProblem(o?.problem ? tidy(o.problem) : errOf(r)); setOut(o ?? null); setPhase('failed'); return; }
    setOut(o); setPhase('done'); reload(); onConnected?.();
    toast('ok', 'Coolify is connected', 'Unit7 now shows its real names, domains and deploys.');
  };
  const paste = async () => {
    setBusy(true); setProblem(null);
    const r = await run({ serverId, token: token.trim() });
    setBusy(false);
    const o = r.status === 'ok' ? (r.output as Result) : undefined;
    if (!o || o.status !== 'verified') { setProblem(o?.problem ? tidy(o.problem) : errOf(r)); return; }
    setToken(''); setOut(o); setPhase('done'); reload(); onConnected?.();
    toast('ok', 'Coolify is connected', 'Unit7 now shows its real names, domains and deploys.');
  };
  const disconnect = async () => {
    if (!(await confirmDialog({ title: `Disconnect Coolify on ${serverName}?`, body: 'Unit7 deletes the key it made in Coolify and forgets it. Your apps keep running; Unit7 only sees them from their labels until you connect again.', confirm: 'Disconnect', danger: true }))) return;
    setBusy(true);
    const r = await act('coolify.disconnect', { serverId }, { success: 'Coolify disconnected' });
    setBusy(false);
    if (r) { setOut(null); setPhase('idle'); reload(); onConnected?.(); }
  };

  if (err) return <p role="alert" className="text-[13px] text-bad">{err}</p>;
  if (!s) return <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="skeleton block h-9 rounded-[12px]" />)}</div>;
  const conn = s.connected?.status === 'verified' ? s.connected : null;

  if (phase === 'running' || phase === 'failed') return (
    <div className="space-y-4">
      <Steps at={phase === 'failed' ? Math.max(1, reached(lines)) : reached(lines)} failed={phase === 'failed'} />
      {phase === 'running' && <p aria-live="polite" className="min-h-[18px] text-[12.5px] text-muted">{lines.at(-1) ?? 'Talking to the server…'}</p>}
      {phase === 'failed' && (
        <div className="space-y-3">
          <p role="alert" className="rounded-[14px] bg-bad/10 px-3.5 py-2.5 text-[13px] text-ink">{problem}</p>
          {out?.apiChange && <ApiChange text={out.apiChange} changeId={out.changeId} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" icon={<RefreshCw size={13} />} onClick={() => void connect()}>Try again</Button>
            <button type="button" onClick={() => setPhase('paste')} className="text-[12.5px] font-medium text-blue-text underline-offset-2 hover:underline">Paste a token instead</button>
          </div>
        </div>
      )}
    </div>
  );

  if (phase === 'done' && out) return (
    <div className="animate-rise space-y-4">
      <div className="flex items-center gap-3">
        <StatusMark state="ok" size={40} solid label="Connected" className="shrink-0" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">Coolify is connected</p>
          <p className="truncate text-[12.5px] text-muted" title={out.key}>{[out.version && `Version ${out.version}`, out.expiresAt ? `Unit7’s own key, valid until ${until(out.expiresAt)}` : out.key && 'Unit7’s own key'].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <Can can={out.can ?? []} />
      {out.apiChange && <ApiChange text={out.apiChange} changeId={out.changeId} />}
      {out.replaced && <p className="text-[12px] text-faint">{out.replaced}</p>}
    </div>
  );

  if (phase === 'paste') return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (token.trim().length >= 8) void paste(); }}>
      <p className="text-[13px] text-ink-2">In Coolify, open Keys & Tokens → API Tokens, make a token for Unit7 and copy it (Coolify shows it once).</p>
      {s.dashboard && <a href={`${s.dashboard}/security/api-tokens`} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[12.5px] font-medium transition hover:bg-raised">Open API tokens<ExternalLink size={12} /></a>}
      <label className="relative block"><span className="sr-only">Coolify token</span>
        <KeyRound size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the token" className="pl-8 font-mono text-[12.5px]" />
      </label>
      {problem && <p role="alert" className="text-[12.5px] text-bad">{problem}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={token.trim().length < 8} icon={<Plug size={13} />}>Check and connect</Button>
        <button type="button" onClick={() => setPhase('idle')} className="text-[12.5px] font-medium text-blue-text underline-offset-2 hover:underline">Connect automatically instead</button>
      </div>
    </form>
  );

  if (conn) return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-2" title={conn.key}>{[conn.version && `Coolify ${conn.version}`, conn.automatic ? 'Unit7’s own key' : 'a pasted token', conn.expiresAt && `valid until ${until(conn.expiresAt)}`].filter(Boolean).join(' · ')}</p>
      <Can can={conn.can} />
      {/* without read:sensitive, setting values and (from Coolify 4.4) logs stay hidden: one click for Unit7's own key */}
      {human && !conn.abilities.includes('read:sensitive') && !conn.abilities.includes('root') && (
        <div className="space-y-2 rounded-[14px] bg-raised px-3.5 py-3">
          <p className="text-[12.5px] text-ink-2">{conn.automatic
            ? 'Unit7 can’t see setting values or, on Coolify 4.4 and newer, logs. Allowing it makes a new key that can, and deletes the old one. Values are only ever shown to people.'
            : 'This pasted token can’t read setting values or, on Coolify 4.4 and newer, logs. In Coolify, make a token with “read” and “read:sensitive” (or “root”) and paste it, or let Unit7 make its own key.'}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" icon={<KeyRound size={13} />} onClick={() => void connect(true)}>{conn.automatic ? 'Allow Unit7 to see setting values' : 'Let Unit7 make its own key'}</Button>
            {!conn.automatic && <Button size="sm" variant="ghost" onClick={() => setPhase('paste')}>Paste a new token</Button>}
          </div>
        </div>
      )}
      {human && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={() => void connect(conn.abilities.includes('read:sensitive'))}>Make a new key</Button>
          <Button size="sm" variant="ghost" loading={busy} icon={<Unplug size={13} />} onClick={() => void disconnect()}>Disconnect</Button>
        </div>
      )}
    </div>
  );

  // not connected: one line, one button
  return (
    <div className="space-y-4">
      <p className="text-[13.5px] leading-snug text-ink-2">Unit7 turns on Coolify’s API and makes its own key there, over the server connection it already has. Nothing to copy or paste, and you can undo it.</p>
      {human ? (
        <>
          <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] text-ink-2">
            <input type="checkbox" checked={secrets} onChange={(e) => setSecrets(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--blue)]" />
            <span>Let Unit7 read secret settings too (logs and setting values; values are only shown to people)</span>
          </label>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button variant="primary" icon={<Plug size={15} />} onClick={() => void connect()}>Connect automatically</Button>
            <button type="button" onClick={() => setPhase('paste')} className="text-[12.5px] font-medium text-muted underline-offset-2 transition hover:text-ink hover:underline">Paste a token instead</button>
          </div>
        </>
      ) : <p className="text-[12.5px] text-muted">An owner or admin connects it.</p>}
    </div>
  );
}

function Can({ can }: { can: string[] }) {
  if (!can.length) return null;
  return (
    <ul className="space-y-1.5" aria-label="What Unit7 may do in Coolify">
      {can.map((c) => <li key={c} className="flex items-start gap-2 text-[13px] text-ink-2"><StatusMark state="ok" size={16} label="Can do" className="mt-0.5 shrink-0" />{cap(c)}</li>)}
    </ul>
  );
}
function ApiChange({ text, changeId }: { text: string; changeId?: string }) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  if (gone) return <p className="text-[12.5px] text-muted">Coolify’s API settings are back as they were.</p>;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[14px] bg-raised px-3.5 py-2.5 text-[12.5px] text-ink-2">
      <span className="min-w-0 flex-1 basis-[220px]">{text.replace(/ Undo puts it back.*$/, '')}</span>
      {changeId && <Button size="sm" variant="ghost" loading={busy} icon={<Undo2 size={13} />} onClick={async () => { setBusy(true); if (await act('change.undo', { changeId }, { success: 'Coolify’s API settings are back as they were', undo: false })) setGone(true); setBusy(false); }}>Undo</Button>}
    </p>
  );
}

// --- the pop-up the server page and the Connections tile open ------------------------------------------------
export function CoolifyConnectModal({ open, onClose, serverId, serverName, human, paste, onConnected }: { open: boolean; onClose: () => void; serverId?: string; serverName: string; human: boolean; paste?: boolean; onConnected?: () => void }) {
  return (
    <Modal open={open && !!serverId} onClose={onClose} title={<span className="flex items-center gap-3"><BrandLogo id="coolify" size={22} />Coolify on {serverName}</span>}>
      {serverId && <ConnectFlow key={`${serverId}${paste ? ':paste' : ''}`} serverId={serverId} serverName={serverName} human={human} paste={paste} onConnected={onConnected} />}
    </Modal>
  );
}
