// Coolify's dashboard on its own HTTPS address, then its port closed, without ever locking anyone out. One centred
// pop-up: pick a name (coolify.<one of your domains>), then Unit7 does it step by step, live, and closes port 8000 only
// once the HTTPS address answers. "Close without a domain" is for people only, held to confirm, and shows the SSH
// tunnel that still reaches the dashboard. openCoolifyDomain(serverId) opens it from anywhere (<CoolifyDomainHost />
// is mounted once, in App). Also here: the header's "Coolify dashboard" line and the closed ports, checked from outside.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowUpRight, Lock, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { onLive, runTool, type ToolResult } from '../../lib/api';
import { tidy } from '../../lib/words';
import { AiButton, Button, CopyButton, HoldButton, Input, Modal, Skeleton, StatusMark, SwitchRow, act, cx, timeAgo } from '../../ui';
import { StepMark } from '../flow/DomainLaunch';
import { askOnHome } from '../Help';

interface Dash {
  serverId: string; server: string; coolify: boolean; url: string; host?: string; https: boolean; answers?: boolean; why?: string; at: string; ipOnly: boolean; apiPort: number;
  portOpen: boolean; portClosed: boolean; realtimeOpen: number[]; suggestions: string[]; tunnel: string; docs: string;
}
interface FlowStep { key: string; label: string; state: 'todo' | 'running' | 'ok' | 'waiting' | 'failed' | 'skipped'; note?: string }
interface Flow { url?: string; done: boolean; steps: FlowStep[]; next?: string; said?: string }
interface Reach { state: 'open' | 'closed' | 'unknown'; at: string; why?: string }
interface Closed { port: number; what: string; coolify: boolean; rule?: boolean; outside: Reach | null; said: string; again?: { tool: string; input: Record<string, unknown>; label: string } }

const errText = (r: ToolResult) => (r.status === 'error' ? tidy(r.error.message) : r.status === 'denied' ? r.why : r.status === 'approval_required' ? 'It’s waiting for your OK on Approvals.' : '');
const and = (xs: number[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const BURST = ['#c6f432', '#1f5bff', '#8b5cf6', '#c6f432', '#26b5f0', '#1f5bff', '#d16bf5', '#c6f432'];

export function useCoolifyDashboard(serverId: string | undefined, on = true) {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = (check = false) => {
    if (!serverId) return Promise.resolve();
    return runTool('coolify.dashboard', { serverId, check }).then((r) => { if (r.status === 'ok') { setD(r.output as Dash); setErr(null); } else setErr(errText(r)); }, (e: Error) => setErr(e.message));
  };
  useEffect(() => { if (on) void load(); }, [serverId, on]);
  return { d, err, reload: load };
}

// --- open it from anywhere ---------------------------------------------------------------------------------------
let want: { serverId: string } | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());
export function openCoolifyDomain(serverId: string) { want = { serverId }; tell(); }
export function CoolifyDomainHost() {
  const w = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => want);
  return w ? <CoolifyDomain serverId={w.serverId} onClose={() => { want = null; tell(); }} /> : null;
}

type Stage = { at: 'pick' } | { at: 'run'; domain?: string; ports: number[] } | { at: 'anyway' };
function CoolifyDomain({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const { d, err, reload } = useCoolifyDashboard(serverId);
  const [stage, setStage] = useState<Stage>({ at: 'pick' });
  const close = () => { setOpen(false); setTimeout(onClose, 200); };
  const title = stage.at === 'anyway' ? `Close ${d?.apiPort ?? 8000} without a domain` : 'Close Coolify’s port safely';
  return (
    <Modal open={open} onClose={close} size="lg" title={<span className="flex items-center gap-2"><BrandLogo id="coolify" size={18} />{title}</span>}>
      {!d && !err && <div className="space-y-3" aria-busy="true"><Skeleton className="h-16" /><Skeleton className="h-28" /></div>}
      {err && !d && <p className="rounded-[16px] bg-bad/10 px-4 py-3 text-[13.5px] text-bad">{err}</p>}
      {d && !d.coolify && <p className="text-[13.5px] text-muted">Unit7 doesn’t see Coolify on this server.</p>}
      {d?.coolify && stage.at === 'pick' && <PickStage d={d} onGo={(domain, ports) => setStage({ at: 'run', domain, ports })} onAnyway={() => setStage({ at: 'anyway' })} />}
      {d?.coolify && stage.at === 'run' && <RunStage d={d} domain={stage.domain} ports={stage.ports} onBack={() => setStage({ at: 'pick' })} onDone={() => { void reload(); close(); }} />}
      {d?.coolify && stage.at === 'anyway' && <AnywayStage d={d} onBack={() => setStage({ at: 'pick' })} onDone={() => { void reload(); close(); }} />}
    </Modal>
  );
}

// where it opens now, in one line
function Now({ d }: { d: Dash }) {
  const good = d.https && d.answers;
  return (
    <div className={cx('flex items-start gap-3 rounded-[18px] px-4 py-3.5', good ? 'bg-ok/[0.07]' : 'bg-warn/10')}>
      <StatusMark state={good ? 'ok' : 'warn'} size={30} solid={!!good} label={good ? 'Fine' : 'Needs a look'} className="shrink-0" />
      <div className="min-w-0 text-[13.5px]">
        <p className="font-medium text-ink">{good ? <>Coolify opens at <span className="break-all">{d.url}</span></> : d.https ? <>Coolify’s address <span className="break-all">{d.url}</span> doesn’t answer over HTTPS yet</> : <>Coolify opens only at <span className="break-all font-mono text-[12.5px]">{d.url}</span></>}</p>
        <p className="mt-0.5 text-[12.5px] text-muted">{good ? 'With HTTPS, so its port can close and you still sign in there.' : `Closing port ${d.apiPort} now would lock you out. Give it its own address first; Unit7 closes the port only once that works.`}</p>
      </div>
    </div>
  );
}

function PickStage({ d, onGo, onAnyway }: { d: Dash; onGo: (domain: string | undefined, ports: number[]) => void; onAnyway: () => void }) {
  const ready = d.https && !!d.answers;
  const [name, setName] = useState(d.suggestions[0] ?? '');
  const [realtime, setRealtime] = useState(true);
  const ports = [...(d.portOpen || !d.portClosed ? [d.apiPort] : []), ...(realtime ? d.realtimeOpen : [])];
  const valid = ready || /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$/i.test(name.trim());
  const plan = ready ? [`Close port${ports.length === 1 ? '' : 's'} ${and(ports)}`, 'Check from outside that nothing answers']
    : [`Point ${name.trim() || 'the name'} at this server`, 'Make it Coolify’s own address (Activity can undo it)', 'Wait until it answers over HTTPS', `Only then close port${ports.length === 1 ? '' : 's'} ${and(ports)}`, 'Check from outside that nothing answers'];
  return (
    <div className="space-y-5">
      <Now d={d} />
      {!ready && (
        <section aria-labelledby="cd-name">
          <h3 id="cd-name" className="text-[13.5px] font-semibold">Give it a name</h3>
          {d.suggestions.length > 0 && (
            <div role="radiogroup" aria-label="Suggested names" className="mt-2 flex flex-wrap gap-1.5">
              {d.suggestions.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={name === s} onClick={() => setName(s)}
                  className={cx('inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition', name === s ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2 hover:border-ink/40')}>
                  <Lock size={12} aria-hidden />{s}
                </button>
              ))}
            </div>
          )}
          <Input className="mt-2.5" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="coolify.example.com" aria-label="Or type a name" autoComplete="off" spellCheck={false} />
          <p className="mt-1.5 text-[12px] text-muted">A subdomain nothing else uses. You’ll sign in to Coolify there from now on.</p>
        </section>
      )}
      {d.realtimeOpen.length > 0 && (
        <SwitchRow title={`Also close ${and(d.realtimeOpen)}`} checked={realtime} onChange={setRealtime}
          body={<>Coolify’s live updates and terminal go through the new address once it works, so these can close too. <a href={d.docs} target="_blank" rel="noopener" className="font-medium text-blue-text hover:underline">Coolify’s firewall docs</a></>} />
      )}
      <ol className="space-y-1.5" aria-label="What Unit7 does">
        {plan.map((p, i) => <li key={p} className="flex items-center gap-3 rounded-[14px] bg-raised/50 px-3 py-2 text-[13px] text-ink-2 animate-rise" style={{ animationDelay: `${i * 50}ms` }}><StepMark state="todo" n={i + 1} />{p}</li>)}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {!ready ? <button type="button" onClick={onAnyway} className="text-[12.5px] font-medium text-muted underline-offset-2 hover:text-ink hover:underline">Close it without a domain</button> : <span />}
        <Button variant="primary" size="lg" disabled={!valid || !ports.length} icon={<ShieldCheck size={16} />} onClick={() => onGo(ready ? undefined : name.trim(), ports)}>{ready ? `Close ${and(ports)}` : 'Set it up'}</Button>
      </div>
    </div>
  );
}

function RunStage({ d, domain, ports, onBack, onDone }: { d: Dash; domain?: string; ports: number[]; onBack: () => void; onDone: () => void }) {
  const first = useMemo<FlowStep[]>(() => ['Pick its name', 'Point it at this server', 'Make it Coolify’s own address', 'Wait until it answers over HTTPS', `Close port${ports.length === 1 ? '' : 's'} ${and(ports)}`, 'Check from outside']
    .map((label, i) => ({ key: String(i), label, state: 'todo' as const })), [ports.join()]);
  const [steps, setSteps] = useState<FlowStep[]>(first);
  const [done, setDone] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setDone(null); setError(null); setSteps(first);
    const off = onLive((e) => { if (e.type === 'coolify.dashboard' && e.data?.serverId === d.serverId && live) setSteps(e.data.steps); });
    void runTool('coolify.dashboard_domain', { serverId: d.serverId, ...(domain && { domain }), ports }).then((r) => {
      if (!live) return;
      if (r.status === 'ok') { setDone(r.output as Flow); setSteps((r.output as Flow).steps); } else setError(errText(r));
    }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; off(); };
  }, [d.serverId, domain, ports.join(), round]);
  const url = done?.url ?? (domain ? `https://${domain}` : d.url);
  return (
    <div className="space-y-5">
      {done?.done ? (
        <div className="flex flex-col items-center px-2 pb-1 pt-3 text-center animate-rise">
          <span className="relative mb-4 grid size-20 place-items-center">
            <span aria-hidden className="burst absolute inset-0">{BURST.map((c, i) => <i key={i} style={{ background: c, ['--a' as string]: `${i * 45 + 20}deg`, animationDelay: `${120 + (i % 3) * 40}ms` }} />)}</span>
            <StatusMark state="ok" size={64} solid label="Done" />
          </span>
          <p className="text-[20px] font-semibold tracking-[-0.03em]">Coolify opens at {url.replace(/^https:\/\//, '')}</p>
          <p className="mt-1 max-w-[420px] text-[13.5px] text-muted">{done.said}</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <a href={url} target="_blank" rel="noopener" className="inline-flex h-11 items-center gap-1.5 rounded-full bg-blue px-5 text-[14px] font-medium text-white hover:brightness-110">Open Coolify<ArrowUpRight size={15} /></a>
            <Button variant="secondary" size="lg" onClick={onDone}>Done</Button>
          </div>
        </div>
      ) : (
        <p className="text-[13.5px] text-muted" aria-live="polite">{done ? (steps.some((s) => s.note === done.next) ? `Stopped here for now. Port ${d.apiPort} stays open, so you can still sign in to Coolify.` : tidy(done.next ?? '')) : error ?? `Working on it, one step at a time. Port ${d.apiPort} stays open until Coolify answers at its new address.`}</p>
      )}
      <ol className="space-y-1.5" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s.key} className={cx('flex items-start gap-3 rounded-[16px] px-3.5 py-2.5 transition-colors', s.state === 'running' ? 'bg-blue-soft/60' : s.state === 'failed' ? 'bg-bad/8' : 'bg-raised/50')}>
            <StepMark state={s.state} n={i + 1} />
            <div className="min-w-0 flex-1">
              <p className={cx('text-[13.5px] font-medium leading-snug', (s.state === 'todo' || s.state === 'skipped') && 'text-muted')}>{s.label}</p>
              {s.note && <p className={cx('mt-0.5 break-words text-[12px] leading-snug', s.state === 'failed' ? 'text-bad' : s.state === 'waiting' ? 'text-warn' : 'text-muted')}>{tidy(s.note)}</p>}
            </div>
          </li>
        ))}
      </ol>
      {!done?.done && (done || error) && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>Other name</Button>
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setRound((n) => n + 1)}>Try again</Button>
          <Button variant="dark" onClick={onDone}>Close</Button>
        </div>
      )}
    </div>
  );
}

// a person insists: the warning, the tunnel that still reaches the dashboard, and a hold to confirm (an AI can't)
function AnywayStage({ d, onBack, onDone }: { d: Dash; onBack: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ said?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null);
    const r = await runTool('server.close_port', { serverId: d.serverId, port: d.apiPort, anyway: true }).catch((e: Error): ToolResult => ({ status: 'error', error: { code: 'network', message: e.message } }));
    setBusy(false);
    if (r.status === 'ok') setOut(r.output as { said?: string }); else setError(errText(r));
  };
  if (out) return (
    <div className="space-y-4 animate-rise">
      <div className="flex items-start gap-3 rounded-[18px] bg-ok/[0.07] px-4 py-3.5"><StatusMark state="ok" size={30} solid label="Closed" className="shrink-0" /><p className="text-[13.5px] text-ink">{tidy(out.said ?? `Port ${d.apiPort} is closed to the internet.`)}</p></div>
      <Tunnel d={d} />
      <div className="flex justify-end"><Button variant="secondary" onClick={onDone}>Done</Button></div>
    </div>
  );
  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="-mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-ink"><ArrowLeft size={14} />Give it a domain instead</button>
      <div className="flex items-start gap-3 rounded-[18px] bg-bad/10 px-4 py-3.5 text-[13.5px]">
        <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0 text-bad" />
        <p className="text-ink"><span className="font-medium">You won’t be able to open Coolify at {d.url}; you’d need an SSH tunnel.</span> Your apps and sites keep running, and Unit7 still reaches Coolify from inside the server.</p>
      </div>
      <Tunnel d={d} />
      {error && <p role="alert" className="rounded-[16px] bg-bad/10 px-4 py-3 text-[13px] text-bad">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>Not now</Button>
        <HoldButton onConfirm={go} loading={busy}>{`Close ${d.apiPort} anyway`}</HoldButton>
      </div>
    </div>
  );
}
function Tunnel({ d }: { d: Dash }) {
  return (
    <div>
      <p className="text-[12.5px] font-medium text-ink-2">To open Coolify then, run this on your computer:</p>
      <div className="mt-1.5 flex items-center gap-2 rounded-[14px] bg-ink px-3.5 py-2.5 text-bg">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px]">{d.tunnel}</code>
        <CopyButton text={d.tunnel} className="shrink-0 text-bg/80 hover:text-bg" />
      </div>
      <p className="mt-1.5 text-[12px] text-muted">Then open http://localhost:{d.apiPort} while it runs.</p>
    </div>
  );
}

// --- the header's line: where Coolify's dashboard opens ------------------------------------------------------------
export function CoolifyDashboardLine({ serverId, className }: { serverId: string; className?: string }) {
  const { d, reload } = useCoolifyDashboard(serverId);
  useEffect(() => onLive((e) => { if (e.type === 'coolify.dashboard_done' || e.type === 'server.port') void reload(); }), [serverId]);
  if (!d?.coolify) return null;
  const good = d.https && d.answers;
  if (good) return (
    <a href={d.url} target="_blank" rel="noopener" aria-label={`Coolify dashboard: ${d.url}. Open`} title={`Signs in over HTTPS${d.portClosed ? `; port ${d.apiPort} is closed to the internet` : ''}`}
      className={cx('inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line-strong bg-surface pl-2 pr-2.5 text-[12.5px] font-medium text-ink-2 transition hover:border-blue/45 hover:text-ink', className)}>
      <Lock size={12} aria-hidden className="shrink-0 text-ok" /><span className="shrink-0 text-muted">Coolify dashboard:</span><span className="truncate"><span className="hidden sm:inline">https://</span>{d.host ?? d.url.replace(/^https:\/\//, '')}</span><span aria-hidden className="text-faint">·</span><span className="inline-flex shrink-0 items-center gap-0.5 text-blue-text">Open<ArrowUpRight size={12} /></span>
    </a>
  );
  return (
    <button type="button" onClick={() => openCoolifyDomain(serverId)} aria-label={`Coolify dashboard: ${d.https ? `${d.url} doesn’t answer. Check` : `only ${d.url.replace(/^http:\/\//, '')}. Give it a domain`}`} title={`Closing port ${d.apiPort} now would lock you out. Give Coolify its own address first.`}
      className={cx('inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-warn/12 pl-2 pr-2.5 text-[12.5px] font-medium text-warn transition hover:bg-warn/20', className)}>
      <TriangleAlert size={12} aria-hidden className="shrink-0" /><span className="shrink-0">Coolify dashboard:</span><span className="truncate font-mono text-[12px]">{d.https ? `${d.url} doesn’t answer` : `only ${d.url.replace(/^http:\/\//, '')}`}</span><span aria-hidden>·</span><span className="shrink-0 underline-offset-2 hover:underline">{d.https ? 'Check' : 'Give it a domain'}</span>
    </button>
  );
}

// --- every port Unit7 closed, checked from outside -------------------------------------------------------------------
export function ClosedPorts({ serverId, className }: { serverId: string; className?: string }) {
  const [list, setList] = useState<Closed[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = () => runTool('server.closed_ports', { serverId }).then((r) => { if (r.status === 'ok') setList((r.output as { ports: Closed[] }).ports); }, () => undefined);
  useEffect(() => { void load(); return onLive((e) => { if (e.type === 'server.port' || e.type === 'coolify.dashboard_done') void load(); }); }, [serverId]);
  const again = async (port: number) => {
    setBusy(port);
    await runTool('alert.recheck', { key: `server:port:${serverId}:${port}`, serverId }).catch(() => undefined);
    await load();
    setBusy(null);
  };
  if (!list?.length) return null;
  return (
    <section aria-label="Ports Unit7 closed" className={cx('rounded-[18px] bg-raised p-4', className)}>
      <p className="flex items-center gap-2 text-[13.5px] font-medium"><ShieldCheck size={15} className="text-ok" />Ports Unit7 closed</p>
      <ul className="mt-2 divide-y divide-line">
        {list.map((c) => {
          const st = c.rule === false ? 'gone' : c.outside?.state ?? 'untested';
          return (
            <li key={c.port} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5">
              <StatusMark state={st === 'closed' ? 'ok' : st === 'open' || st === 'gone' ? 'warn' : 'off'} size={22} label={st === 'closed' ? 'Closed' : st === 'open' ? 'Still reachable' : st === 'gone' ? 'Rule gone' : 'Not tested'} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1 basis-[200px]">
                <p className="text-[13px] font-medium text-ink"><span className="tabular font-mono">{c.port}</span> · {c.what}</p>
                <p className="text-[12.5px] text-muted">
                  {st === 'closed' ? <>Closed to the internet ✓ <span className="whitespace-nowrap">(checked from outside {timeAgo(c.outside!.at)})</span>{c.coolify ? '. Coolify still runs inside the server, which is fine.' : ''}</> : tidy(c.said)}
                </p>
              </div>
              <span className="ml-[34px] flex shrink-0 items-center gap-1 sm:ml-0">
                {st === 'open' && <AiButton size="sm" onClick={() => askOnHome(`On my server, port ${c.port} (${c.what}) is closed at the firewall but still answers from outside. Look first, read-only, and tell me why and the fix.`, { send: true })}>Ask Unit7</AiButton>}
                {st === 'gone' && c.again && <Button size="sm" variant="dark" onClick={() => void act(c.again!.tool, c.again!.input, { success: `Port ${c.port} closed again` }).then(load)}>{c.again.label}</Button>}
                <Button size="sm" variant="ghost" loading={busy === c.port} icon={<RefreshCw size={13} />} onClick={() => void again(c.port)}>Check again</Button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
