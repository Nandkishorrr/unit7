// The security check, on screen: one button looks at everything Unit7 can see, steps show live while it
// works, and every finding comes with its fix one click away (or "Show me how" when a person has to do it).
// Settings shows the whole picture; a server's page shows the same check for just that server.
import { useEffect, useState, type ReactNode } from 'react';
import { ShieldCheck, Check, Loader2, ArrowUpRight, Undo2, Server, Globe, Boxes, Wand2, History, CalendarClock, AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { A, AiButton, AiSparkle, Badge, Button, Card, CardHeader, Gauge, IconCircle, Skeleton, SwitchRow, cx, promptDialog, timeAgo, toast, StatusMark, stepAction } from '../../ui';
import { tidy } from '../../lib/words';
import { askOnHome } from '../Help';
import { confirmField } from '../watch/QuickFix';
import { openCoolifyDomain } from '../servers/CoolifyDomain';
import { askFallback, verifiedOf } from '../../lib/alertActions';
import { BackBadge, ExplainBlock, HiddenList, SnoozeMenu, type Explain } from '../explain';
import { Choices } from '../choices';
import { pick } from '../../lib/choices';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type Act = { tool: string; input: Record<string, unknown>; label: string };
// byHand: extra steps a person may take; typeName: hard to undo, so the person types this name first; ask: the button sends
// this question straight to Unit7's AI on Home
// alt: other one-click ways, offered second ("Use Coolify's backups" next to Unit7's own)
export type AltFix = Act & { change: string; safe?: boolean; undo?: Act };
export type Fix = (Act & { change: string; safe?: boolean; undo?: Act; byHand?: string[]; typeName?: string; alt?: AltFix[] }) | { manual: string[]; label?: string; href?: string; ask?: string; flow?: { kind: 'coolify-domain'; serverId: string } };
export interface Finding {
  id: string; severity: Severity; area: 'server' | 'app' | 'domain' | 'unit7'; title: string; detail: string; evidence?: string;
  about?: { kind: 'server' | 'app' | 'domain'; id?: string; name: string }; serverId?: string; fix?: Fix; by: 'unit7' | 'ai';
  explain?: Explain; back?: string; // plain words (what happened, what it can cause, what Unit7 will do); "Back after 7 days: still here"
}
export interface Coverage { apps: { checked: number; found: number }; skipped: string[] }
// a score only means something next to what it looked at: most apps unchecked, no score (src/care/coverage.ts)
export const lowCoverage = (c?: Coverage) => !!c && c.apps.found > 0 && c.apps.checked * 2 < c.apps.found;
export interface Report { coverage?: Coverage; id: string; at: string; serverId: string | null; by: string; score: number; counts: Record<Severity, number>; findings: Finding[]; notes: string[]; fresh: string[]; ms: number }
interface Past { id: string; at: string; serverId: string | null; by: string; score: number; counts: Record<Severity, number> }
interface Data { latest: Report | null; history: Past[]; weekly: boolean }

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const SEV: Record<Severity, { label: string; dot: string; ring: string }> = {
  critical: { label: 'Critical', dot: 'bg-bad', ring: 'border-bad/30 bg-bad/[0.04]' },
  high: { label: 'High', dot: 'bg-[#f97316]', ring: 'border-[#f97316]/30' },
  medium: { label: 'Medium', dot: 'bg-[#f59e0b]', ring: 'border-line' },
  low: { label: 'Low', dot: 'bg-blue', ring: 'border-line' },
  info: { label: 'Good to know', dot: 'bg-faint/60', ring: 'border-line' },
};
const isTool = (f?: Fix): f is Act & { change: string; safe?: boolean; undo?: Act; byHand?: string[]; typeName?: string; alt?: AltFix[] } => !!f && 'tool' in f;
// word, gauge colour, headline colour, score pill (AA contrast in both themes)
const verdict = (s: number, critical = 0) => (critical ? ['Fix these now', '#ef4444', 'text-bad', 'bg-bad-solid text-white'] : s >= 90 ? ['Looking good', '#16a34a', 'text-ok', 'bg-ok-solid text-white'] : s >= 70 ? ['A few things to fix', 'var(--blue)', 'text-blue-text', 'bg-blue text-white']
  : s >= 40 ? ['Needs attention', '#f59e0b', 'text-warn', 'bg-[#f59e0b] text-[#1f1300]'] : ['Fix these now', '#ef4444', 'text-bad', 'bg-bad-solid text-white']) as [string, string, string, string];
const who = (by: string) => (/warden/i.test(by) ? 'Warden' : tidy(by));

// --- loading, running (with live steps) ----------------------------------------------------------------
export function useSecurity(serverId?: string) {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[] | null>(null);
  const input = serverId ? { serverId } : {};
  const load = async () => {
    try { const r = await runTool('security.reports', input); if (r.status === 'ok') { setData(r.output); setFailed(null); } else setFailed(r.status === 'error' ? r.error.message : 'Not allowed to see the reports.'); }
    catch (e) { setFailed((e as Error).message); }
  };
  useEffect(() => { setData(null); void load(); }, [serverId]);
  const check = async () => {
    setSteps([serverId ? 'Connecting to the server…' : 'Starting the check…']);
    const off = onLive((e) => { if (e.type === 'tool.progress' && e.data?.tool === 'security.check') setSteps((s) => (s && !s.includes(e.message) ? [...s, e.message] : s)); });
    try {
      const r = await runTool('security.check', input);
      if (r.status === 'ok') await load();
      else toast('bad', 'The check didn’t run', r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'It needs approval.', { action: r.status === 'error' ? { label: 'Try again', onClick: check } : stepAction(r) });
    } catch (e) { toast('bad', 'The check didn’t run', (e as Error).message, { action: { label: 'Try again', onClick: check } }); }
    off();
    setSteps(null);
  };
  return { data, failed, steps, running: !!steps, check, load, setData };
}

// --- one fix: what changes, the result in place, approvals as they are ----------------------------------
type FixState = { s: 'busy' } | { s: 'done'; text: string; undo?: Act; still?: string } | { s: 'wait'; why: string } | { s: 'no'; text: string } | { s: 'undone' } | { s: 'still'; text: string };
function doneWords(tool: string, o: any): string {
  if (tool === 'server.close_port') return o?.closed ? `Port ${o.closed} is closed to the internet.` : `Port ${o?.opened} answers again.`;
  if (tool === 'server.harden') return o?.verified ? 'Locked down: passwords are off, updates install by themselves.' : tidy(`Done. ${o?.findings?.[0] ?? ''}`);
  if (tool === 'docker.prune') return `Freed ${o?.freed ?? 'some space'}. ${o?.disk ? `Now ${o.disk}.` : ''}`;
  if (tool === 'domain.protect_email') return o?.dmarc && o.dmarc !== 'already set' ? `Protected.${o.spf ? ` ${o.spf}` : ''}` : o?.dmarc ? 'It was already protected.' : `Add this where the domain’s DNS lives: ${(o?.addThese ?? []).map((r: any) => `${r.type} ${r.name} → ${r.value}`).join('; ')}`;
  if (tool === 'server.bootstrap') return 'The firewall is on. Only sign-in and web traffic get in.';
  if (tool === 'backup.schedule') return 'Backed up every day from now on.';
  if (tool === 'backup.verify') return o?.ok === false ? `The restore test failed: ${o.note ?? 'see Backups'}.` : 'The backup restores. Your safety net works.';
  if (tool === 'security.fix_pr') return o?.pr ? 'Opened a pull request with the fix.' : tidy(o?.nothingToDo ?? o?.already ?? 'Done.');
  if (tool === 'shield.block') return 'Blocked. It lifts by itself.';
  if (tool === 'server.repair') return tidy(o?.done ?? 'Restarting.');
  if (tool === 'server.tidy_logs') return `Tidied up: freed ${o?.freed ?? 'some space'}. The system journal stays under 500 MB from now on.`;
  if (tool === 'server.swap') return o?.already ? 'It already has swap.' : `Added ${o?.added ?? 'swap'}. A memory spike now slows it down instead of stopping apps.`;
  if (tool === 'server.time_sync') return o?.already ? 'The clock was already kept in time.' : o?.synced ? 'Time sync is on and the clock is right.' : 'Time sync is on; the clock catches up within a few minutes.';
  if (tool === 'domain.renew_https') return `Renewed. Good for ${o?.daysLeft ?? 'many'} more days.`;
  if (tool === 'part.limits') return `Capped at ${o?.capped ?? 'the new limit'}. It keeps running.`;
  if (tool === 'part.remove') return `Moved ${o?.removed ?? 'it'} to the trash for ${o?.trash ?? '7 days'}.`;
  if (tool === 'coolify.backup') return o?.reused ? 'Coolify already backs it up daily.' : 'Coolify backs it up every day from now on.';
  if (tool === 'part.backup_schedule') return `Backed up ${o?.part ?? 'it'} just now${o?.firstBackup?.offServer?.length ? `, and the copy is safe off the server (${o.firstBackup.offServer.join(', ')})` : ''}. Unit7 does it again every day.`;
  if (tool === 'part.backup') return `Backed up ${o?.part ?? 'it'} just now.`;
  if (tool === 'server.reboot') return 'Restarted. Every site came back.';
  if (tool === 'reboot.window') return `Unit7 restarts it ${o?.words ?? 'at night'} when updates need it.`;
  if (tool === 'secrets.rotation') return `Database passwords change every ${o?.databases ?? 90} days from now on.`;
  return 'Done.';
}
async function runFix(a: Act): Promise<FixState> {
  try {
    const r = await runTool(a.tool, a.input);
    const o = r.status === 'ok' ? r.output : undefined;
    // a change on a server that its health check put back didn't happen
    if (o?.changed === false) return { s: 'no', text: o.why ?? 'It didn’t take, so Unit7 put it back as it was.' };
    // the undo a tool hands back: a ready action, or a recorded change Unit7 can take back
    const undo: Act | undefined = o?.undo && typeof o.undo === 'object' ? o.undo : o?.changeId ? { tool: 'change.undo', input: { changeId: o.changeId }, label: 'Undo' } : undefined;
    // Unit7 looked again at what the fix touched: "fixed" only when that check no longer sees it
    const v = verifiedOf(o);
    if (r.status === 'ok') return { s: 'done', text: v?.fixed ? `${doneWords(a.tool, o)} Fixed and checked.` : doneWords(a.tool, o), undo, ...(v && !v.fixed && { still: v.still ?? 'The check still sees it.' }) };
    if (r.status === 'approval_required') return { s: 'wait', why: r.why };
    if (r.status === 'denied') return { s: 'no', text: r.why };
    if (r.status === 'error') return { s: 'no', text: r.error.message };
    return { s: 'no', text: 'That didn’t run.' };
  } catch (e) { return { s: 'no', text: (e as Error).message }; }
}

function Result({ st, onUndo }: { st: FixState; onUndo: (a: Act) => void }) {
  if (st.s === 'busy') return null;
  if (st.s === 'undone') return <p className="mt-2 text-[12.5px] text-muted animate-pop">Put back the way it was.</p>;
  if (st.s === 'wait') return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] animate-pop">
      <span className="inline-flex items-center gap-1.5 font-medium text-warn"><span className="size-1.5 animate-working rounded-full bg-current" />Waiting for your OK</span>
      <A href="/approvals" className="inline-flex items-center gap-0.5 font-medium text-blue-text hover:underline">Open approvals<ArrowUpRight size={12} /></A>
    </p>
  );
  if (st.s === 'no') return <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-bad animate-pop"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{tidy(st.text)}</p>;
  if (st.s === 'still') return <StillThere text={st.text} />;
  return (<>
    <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] animate-pop">
      <span className="inline-flex items-start gap-1.5 text-ok"><Check size={14} strokeWidth={3} className="mt-px shrink-0" /><span className="text-ink-2">{st.text}</span></span>
      {st.undo && <button type="button" onClick={() => onUndo(st.undo!)} className="inline-flex items-center gap-1 rounded-full px-1.5 font-medium text-muted hover:text-ink"><Undo2 size={12} />{st.undo.label}</button>}
    </p>
    {st.still && <StillThere text={st.still} />}
  </>);
}
// the re-check after a fix still sees the problem: said plainly, with the next step (Unit7, or the fix's other options)
const StillThere = ({ text }: { text: string }) => (
  <p className="mt-2 flex items-start gap-2 text-[12.5px] text-ink animate-pop"><StatusMark state="warn" size={16} label="Still there" className="mt-px shrink-0" /><span><span className="font-medium">Still there:</span> {tidy(text)}</span></p>
);

// the steps a person can take instead of the one-click fix (or the AI's look): under Advanced when the plain words show
export const handSteps = (fix?: Fix) => (isTool(fix) ? fix.byHand : fix?.ask ? fix.manual : undefined);
function FixArea({ f, st, setSt, handInAdvanced }: { f: Finding; st?: FixState; setSt: (s: FixState) => void; handInAdvanced?: boolean }) {
  const [open, setOpen] = useState(false);
  const fix = f.fix;
  if (!fix) return null;
  // a guided pop-up does it step by step (Coolify's own address first, then its port)
  if (!isTool(fix) && fix.flow) return (
    <div className="mt-3">
      <Button size="sm" variant="dark" icon={<ShieldCheck size={13} />} onClick={() => openCoolifyDomain(fix.flow!.serverId)}>{fix.label ?? 'Show me'}</Button>
      {fix.manual.length > 0 && !handInAdvanced && <ByHand steps={fix.manual} />}
    </div>
  );
  // a question for the AI: it goes straight to Home's ask box and runs there
  if (!isTool(fix) && fix.ask) return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <AiButton size="sm" title="Unit7’s AI looks into it and tells you what it finds. Nothing changes without you." onClick={() => askOnHome(fix.ask!, { send: true })}>{fix.label ?? 'Ask Unit7'}</AiButton>
        {!handInAdvanced && <span className="min-w-0 flex-1 basis-[220px] text-[12.5px] text-muted">Unit7’s AI looks into it and tells you what it finds. Nothing changes without you.</span>}
      </div>
      {fix.manual.length > 0 && !handInAdvanced && <ByHand steps={fix.manual} />}
    </div>
  );
  if (!isTool(fix)) return (
    <div className="mt-3">
      <Button size="sm" variant="soft" aria-expanded={open} icon={<ChevronRight size={13} className={cx('transition-transform', open && 'rotate-90')} />} onClick={() => setOpen(!open)}>{open ? 'Hide the steps' : 'Show me how'}</Button>
      {open && (
        <div className="mt-2.5 rounded-[16px] bg-raised px-4 py-3 animate-pop">
          <ol className="list-decimal space-y-1.5 pl-4 text-[13px] text-ink-2">{fix.manual.map((m, i) => <li key={i}>{tidy(m)}</li>)}</ol>
          {fix.href && <A href={fix.href} className="mt-2.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-blue-text hover:underline">{fix.label && fix.label !== 'Show me how' ? fix.label : 'Take me there'}<ArrowUpRight size={12} /></A>}
        </div>
      )}
    </div>
  );
  return <ToolFix fix={handInAdvanced ? { ...fix, byHand: undefined } : fix} st={st} setSt={setSt} strong={f.severity === 'critical' || f.severity === 'high'} quiet={handInAdvanced} />;
}
export const ByHand = ({ steps, open }: { steps: string[]; open?: boolean }) => (
  <details className="group mt-2 text-[12.5px]" open={open}>
    <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-muted hover:text-ink"><ChevronRight size={12} className="transition-transform group-open:rotate-90" />Do it by hand instead</summary>
    <ol className="mt-1.5 list-decimal space-y-1 rounded-[14px] bg-surface py-2.5 pl-8 pr-3 text-ink-2">{steps.map((m, i) => <li key={i}>{tidy(m)}</li>)}</ol>
  </details>
);

type ToolFixT = Act & { change: string; undo?: Act; byHand?: string[]; typeName?: string; alt?: AltFix[] };
function ToolFix({ fix, st, setSt, strong, onDone, quiet }: { fix: ToolFixT; st?: FixState; setSt: (s: FixState) => void; strong?: boolean; onDone?: () => void; quiet?: boolean }) {
  const go = async (a: Act) => {
    // hard to undo: the person types the name first, as anywhere else in Unit7
    let input = a.input;
    if (fix.typeName && a === fix) {
      const typed = await promptDialog({ title: `${fix.label}?`, label: `Type ${fix.typeName} to confirm`, placeholder: fix.typeName, hint: fix.change, confirm: fix.label,
        warn: (v) => (v && v.toLowerCase() !== fix.typeName!.toLowerCase() ? 'That isn’t the name.' : undefined) });
      if (!typed || typed.toLowerCase() !== fix.typeName.toLowerCase()) return;
      input = { ...a.input, [confirmField(a.tool)]: typed };
    }
    setSt({ s: 'busy' }); const r = await runFix({ ...a, input }); setSt(r); if (r.s === 'done') onDone?.();
  };
  const undo = async (a: Act) => { setSt({ s: 'busy' }); const r = await runFix(a); setSt(r.s === 'done' ? { s: 'undone' } : r); if (r.s === 'done') onDone?.(); };
  return (
    <div className="mt-3">
      {/* the fix and its other ways as one choice row: the fix recommended, each one's change in its tooltip */}
      {st?.s !== 'done' && st?.s !== 'wait' && (
        <>
          <Choices disabled={st?.s === 'busy'} label="Ways to fix it" onPick={(c) => { const a = c.key === 'main' ? fix : fix.alt?.[Number(c.key?.slice(4))]; if (a) void go(a); return true; }}
            choices={pick([{ key: 'main', label: fix.label, tool: fix.tool, change: fix.change, recommended: true, risk: fix.typeName ? 'danger' : (fix as { safe?: boolean }).safe ? 'safe' : 'change',
              why: fix.typeName ? 'it fixes the cause; it’s hard to undo, so you type the name first' : (fix as { safe?: boolean }).safe ? 'it’s safe and can be undone' : fix.undo ? 'it fixes the cause and can be undone' : 'it fixes the cause' },
              ...(fix.alt ?? []).map((a, i) => ({ key: `alt:${i}`, label: a.label, tool: a.tool, change: a.change }))])} />
          {!quiet && <p className="mt-1.5 text-[12.5px] text-muted">{fix.change}</p>}
          {st?.s === 'busy' && <p role="status" className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-muted"><Loader2 size={13} className="animate-spin" />Working on it…</p>}
        </>
      )}
      {st && <Result st={st} onUndo={undo} />}
      {fix.byHand?.length ? (
        <details className="group mt-2 text-[12.5px]">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-muted hover:text-ink"><ChevronRight size={12} className="transition-transform group-open:rotate-90" />Do it by hand instead</summary>
          <ol className="mt-1.5 list-decimal space-y-1 rounded-[14px] bg-raised py-2.5 pl-8 pr-3 text-ink-2">{fix.byHand.map((m, i) => <li key={i}>{tidy(m)}</li>)}</ol>
        </details>
      ) : null}
    </div>
  );
}

// a fix on its own (the server page's basic rows): the same button, change line and result in place
export function FixButton({ fix, strong, onDone, quiet }: { fix: ToolFixT; strong?: boolean; onDone?: () => void; quiet?: boolean }) {
  const [st, setSt] = useState<FixState>();
  return <ToolFix fix={fix} st={st} setSt={setSt} strong={strong} onDone={onDone} quiet={quiet} />;
}

const ABOUT = { server: Server, app: Boxes, domain: Globe } as const;
function FindingRow({ f, isNew, st, setSt, onHide }: { f: Finding; isNew: boolean; st?: FixState; setSt: (s: FixState) => void; onHide: () => void }) {
  const Icon = f.about ? ABOUT[f.about.kind] : undefined;
  const fixed = st?.s === 'done' && !st.still;
  // "Check again": the one check behind this finding, read-only
  const again = async () => {
    setSt({ s: 'busy' });
    try {
      const r = await runTool('alert.recheck', { key: f.id, ...((f.serverId ?? (f.about?.kind === 'server' ? f.about.id : undefined)) && { serverId: f.serverId ?? f.about!.id }) });
      if (r.status === 'ok') setSt(r.output?.fixed ? { s: 'done', text: 'Gone: Unit7 checked again just now.' } : { s: 'still', text: r.output?.still ?? 'The check still sees it.' });
      else if (r.status === 'error' && r.error.code === 'not_found') setSt({ s: 'done', text: 'Already gone.' });
      else setSt({ s: 'no', text: r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'It needs approval.' });
    } catch (e) { setSt({ s: 'no', text: (e as Error).message }); }
  };
  return (
    <li className={cx('rounded-[20px] border p-4 transition-colors md:p-5', fixed ? 'border-ok/30 bg-ok/[0.04]' : SEV[f.severity].ring)}>
      <div className="flex items-start gap-3">
        <span className={cx('mt-[7px] size-2.5 shrink-0 rounded-full', fixed ? 'bg-ok' : SEV[f.severity].dot)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cx('text-[14.5px] font-medium tracking-[-0.01em]', fixed && 'text-ink-2')}>{tidy(f.title)}</span>
            <span className="sr-only">Severity: {SEV[f.severity].label}.</span>
            {fixed && <Badge tone="ok"><Check size={11} strokeWidth={3} />Fixed</Badge>}
            {isNew && !fixed && <Badge tone="info">New</Badge>}
            {!fixed && <BackBadge back={f.back} />}
          </p>
          {f.explain ? <ExplainBlock e={f.explain} className="mt-2">{handSteps(f.fix)?.length ? <ByHand steps={handSteps(f.fix)!} /> : null}</ExplainBlock> : <>
            <p className="mt-0.5 text-[13px] text-ink-2">{tidy(f.detail)}</p>
            {f.evidence && <p className="mt-2 break-words rounded-[12px] bg-raised px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">{tidy(f.evidence)}</p>}
          </>}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
            {f.about && Icon && (f.about.kind === 'server' && f.about.id
              ? <A href={`/servers/${f.about.id}`} className="inline-flex items-center gap-1 hover:text-ink"><Icon size={12} />{f.about.name}</A>
              : <span className="inline-flex items-center gap-1"><Icon size={12} />{f.about.name}</span>)}
            <span className="inline-flex items-center gap-1">{f.by === 'ai' ? <><AiSparkle size={13} still />Found by AI</> : <><ShieldCheck size={12} />Found by Unit7</>}</span>
            {!fixed && f.by !== 'ai' && <button type="button" onClick={() => void again()} disabled={st?.s === 'busy'} title="Runs the check behind this again, read-only"
              className="ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2 font-medium text-muted transition hover:bg-raised hover:text-ink disabled:opacity-50"><RefreshCw size={12} className={cx(st?.s === 'busy' && 'animate-spin motion-reduce:animate-none')} />Check again</button>}
            {!fixed && <span className={cx(f.by === 'ai' && 'ml-auto')}><SnoozeMenu id={f.id} title={f.title} severity={f.severity} small onDone={onHide} /></span>}
          </div>
          <FixArea f={f} st={st} setSt={setSt} handInAdvanced={!!f.explain} />
          {(!f.fix || !isTool(f.fix)) && st && <Result st={st} onUndo={() => undefined} />}
          {/* no fix Unit7 can run: its AI can still look into it */}
          {!f.fix && !fixed && <AiButton size="sm" className="mt-3" onClick={() => askOnHome(askFallback(`${tidy(f.title)}. ${tidy(f.detail)}`), { send: true })}>Ask Unit7 to fix it</AiButton>}
        </div>
      </div>
    </li>
  );
}

// --- the list, grouped by how bad, with "Fix all safe ones" -------------------------------------------------
export function Findings({ report, firstRun, compact }: { report: Report; firstRun?: boolean; compact?: boolean }) {
  const [states, setStates] = useState<Record<string, FixState>>({});
  const [bulk, setBulk] = useState<{ done: number; of: number } | null>(null);
  // what a person just hid ("This is fine"): gone from the list at once (the next load leaves it out)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  useEffect(() => setStates({}), [report.id]);
  report = { ...report, findings: report.findings.filter((f) => !hidden.has(f.id)) };
  const set = (id: string) => (s: FixState) => setStates((x) => ({ ...x, [id]: s }));
  const safe = report.findings.filter((f) => isTool(f.fix) && f.fix.safe && !states[f.id]);
  const fixAll = async () => {
    setBulk({ done: 0, of: safe.length });
    for (const [i, f] of safe.entries()) { set(f.id)({ s: 'busy' }); set(f.id)(await runFix(f.fix as Act)); setBulk({ done: i + 1, of: safe.length }); }
    setBulk(null);
  };
  const real = report.findings.filter((f) => f.severity !== 'info');
  const info = report.findings.filter((f) => f.severity === 'info');
  const row = (f: Finding) => <FindingRow key={f.id} f={f} isNew={!firstRun && report.fresh.includes(f.id)} st={states[f.id]} setSt={set(f.id)} onHide={() => setHidden((h) => new Set([...h, f.id]))} />;
  return (
    <div>
      {(safe.length > 0 || bulk) && (
        <div className={cx('mb-4 flex flex-wrap items-center gap-3 rounded-[18px] bg-blue-soft px-4 py-3', compact && 'mb-3')}>
          <Wand2 size={16} className="shrink-0 text-blue-text" />
          <p className="min-w-0 flex-1 basis-[200px] text-[13px] text-ink">{bulk ? `Fixing ${Math.min(bulk.done + 1, bulk.of)} of ${bulk.of}…` : `${safe.length} fix${safe.length === 1 ? ' is' : 'es are'} safe to do now: small and easy to undo.`}</p>
          <Button size="sm" variant="primary" loading={!!bulk} onClick={fixAll}>Fix all safe ones</Button>
        </div>
      )}
      {!real.length ? (
        <div className="flex items-center gap-3 rounded-[18px] bg-ok/[0.07] px-4 py-4"><StatusMark state="ok" size={36} solid label="All good" /><p className="text-[13.5px] text-ink">Nothing to fix. {compact ? 'This server looks well guarded.' : 'Everything Unit7 can see looks well guarded.'}</p></div>
      ) : ORDER.filter((s) => s !== 'info').map((sev) => {
        const items = real.filter((f) => f.severity === sev);
        if (!items.length) return null;
        return (
          <section key={sev} className="mb-5 last:mb-0" aria-label={`${SEV[sev].label}: ${items.length}`}>
            <h3 className="mb-2 flex items-center gap-2 px-1 text-[12px] font-semibold uppercase tracking-[0.07em] text-muted"><span className={cx('size-2 rounded-full', SEV[sev].dot)} />{SEV[sev].label}<span className="font-normal normal-case tracking-normal">· {items.length}</span></h3>
            <ul className="space-y-2.5">{items.map(row)}</ul>
          </section>
        );
      })}
      {info.length > 0 && (
        <details className="group mt-4 rounded-[18px] border border-line px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-ink-2"><ChevronRight size={14} className="transition-transform group-open:rotate-90" />Good to know · {info.length}<span className="font-normal text-muted">fine, but worth knowing</span></summary>
          <ul className="mt-3 space-y-2.5">{info.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

// --- live steps while it works ---------------------------------------------------------------------------
export function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-2" aria-live="polite" aria-label="Checking">
      {steps.map((s, i) => {
        const last = i === steps.length - 1 && !/^Done/.test(s);
        return (
          <li key={s} className="flex items-center gap-2.5 text-[13px] animate-pop">
            {last ? <span className="grid size-5 shrink-0 place-items-center rounded-full bg-blue-soft text-blue-text"><Loader2 size={12} className="animate-spin" /></span> : <StatusMark state="ok" size={20} solid label="Done" />}
            <span className={last ? 'font-medium text-ink' : 'text-muted'}>{tidy(s)}</span>
          </li>
        );
      })}
    </ol>
  );
}

const Counts = ({ counts }: { counts: Record<Severity, number> }) => (
  <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
    {ORDER.filter((s) => s !== 'info').map((s) => (
      <span key={s} className={cx('inline-flex items-center gap-1.5 text-[12.5px]', counts[s] ? 'text-ink' : 'text-faint')}>
        <span className={cx('size-2 rounded-full', counts[s] ? SEV[s].dot : 'bg-line-strong')} /><span className="tabular font-semibold">{counts[s]}</span>{SEV[s].label.toLowerCase()}
      </span>
    ))}
  </span>
);

// The AI looks further: the report goes into the ask box on Home (the person's chosen brain answers there),
// with read-only rules. What it finds comes back into the report, marked "found by AI".
export function deepCheckPrompt(r: Report | null, server?: string) {
  const found = (r?.findings ?? []).filter((f) => f.severity !== 'info').slice(0, 12).map((f) => `- ${f.severity}: ${f.title}`).join('\n');
  return [
    `Do a deep security check of ${server ? `my server ${server}` : 'everything I run'} and look further than Unit7’s own check${r ? ` (score ${r.score}/100)` : ''}.`,
    found && `Unit7 already found these, so no need to repeat them:\n${found}`,
    'Only look, don’t change anything yet. Use Unit7’s read-only tools: server logs and busiest programs, containers and their logs and settings, app errors, app settings (names only), the map.',
    'Look for: programs, users or scheduled jobs that don’t belong; break-in attempts or strange lines in the logs; risky settings in the apps and the proxy; code risks you can see; anything open that shouldn’t be.',
    'Add each new problem to my security report (it shows there as found by AI), in plain words without tool names or codes, and never with a secret’s value. Then tell me what you found, worst first, and offer a fix for each. Ask before fixing anything.',
  ].filter(Boolean).join('\n\n');
}
export const deepCheck = (r: Report | null, server?: string) => askOnHome(deepCheckPrompt(r, server), { send: true });

// --- Settings → Security ----------------------------------------------------------------------------------
export function SecurityTab({ canChange }: { canChange: boolean }) {
  const sec = useSecurity();
  const { data, steps, running } = sec;
  const r = data?.latest ?? null;
  if (!data) return sec.failed
    ? <Card className="flex flex-wrap items-center gap-4 p-5 lg:col-span-2"><p className="min-w-0 grow basis-[220px] text-[14px]">Couldn’t load the security reports. {tidy(sec.failed)}</p><Button variant="soft" onClick={sec.load}>Try again</Button></Card>
    : <><Skeleton className="h-[230px] rounded-[24px] lg:col-span-2" /><Skeleton className="h-[320px] rounded-[24px] lg:col-span-2" /></>;
  const [word, color, text] = verdict(r?.score ?? 100, r?.counts.critical);
  return (
    <>
      <Card className="overflow-hidden lg:col-span-2">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-6 p-5 md:p-7">
          {r ? (
            <div className="shrink-0">
              <Gauge value={lowCoverage(r.coverage) ? 0 : r.score / 100} size={190} track="var(--line-strong)" color={color}>
                <p className="tabular text-[44px] font-semibold leading-none tracking-[-0.05em]">{lowCoverage(r.coverage) ? '–' : r.score}</p>
                <p className="mt-1 text-[12px] text-muted">{lowCoverage(r.coverage) ? 'most apps not checked' : 'out of 100'}</p>
              </Gauge>
            </div>
          ) : <IconCircle size={64} tone="soft"><ShieldCheck size={28} /></IconCircle>}
          <div className="min-w-0 flex-1 basis-[280px]">
            {r ? (
              <>
                <h2 className={cx('text-[24px] font-semibold tracking-[-0.03em]', text)}>{word}</h2>
                <div className="mt-2"><Counts counts={r.counts} /></div>
                <p className="mt-3 text-[12.5px] text-muted">Checked {timeAgo(r.at)} by {who(r.by)}{r.ms ? ` · took ${Math.max(1, Math.round(r.ms / 1000))}s` : ''}</p>
                {r.coverage && r.coverage.apps.found > 0 && (
                  <p className="mt-1 text-[12.5px] text-ink-2">Apps checked: <b className="tabular">{r.coverage.apps.checked} of {r.coverage.apps.found}</b>{r.coverage.skipped.length ? <span className="text-muted"> · not checked for known holes or exposed secrets: {r.coverage.skipped.slice(0, 4).join(', ')}{r.coverage.skipped.length > 4 ? ` and ${r.coverage.skipped.length - 4} more` : ''}</span> : null}</p>
                )}
                {r.notes.map((n) => <p key={n} className="mt-1 text-[12.5px] text-warn">{tidy(n)}</p>)}
              </>
            ) : (
              <>
                <h2 className="text-[22px] font-semibold tracking-[-0.03em]">Check everything in one click</h2>
                <p className="mt-1.5 max-w-xl text-[13.5px] text-ink-2">Unit7 looks at your servers, apps, domains and its own settings for open doors, leaked secrets and weak spots, then puts a fix next to each one.</p>
              </>
            )}
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto">
            <Button size="lg" variant="primary" loading={running} icon={<ShieldCheck size={17} />} onClick={sec.check}>{running ? 'Checking…' : r ? 'Check again' : 'Run a security check'}</Button>
            <AiButton size="lg" disabled={running} onClick={() => deepCheck(r)}>Deep check with AI</AiButton>
          </div>
        </div>
        {steps && <div className="border-t border-line bg-raised/50 px-5 py-4 md:px-7"><Steps steps={steps} /></div>}
        {!steps && <p className="border-t border-line px-5 py-3 text-[12.5px] text-muted md:px-7">Unit7 checks what it can see itself. The AI deep check reads further (configs, logs, code) and adds what it finds here, marked “Found by AI”.</p>}
      </Card>

      {r && (
        <Card className="p-5 md:p-6 lg:col-span-2">
          <CardHeader icon={<ShieldCheck size={19} />} title="What Unit7 found" sub={`${r.findings.filter((f) => f.severity !== 'info').length} to look at · worst first`} />
          <div className="mt-5"><Findings report={r} firstRun={data.history.length < 2} /></div>
          <HiddenList className="mt-4" />
        </Card>
      )}

      <Card className="p-5 md:p-6">
        <CardHeader icon={<History size={19} />} title="Past checks" sub={data.history.length ? `The last ${data.history.length}` : 'None yet'} />
        {!data.history.length ? <p className="mt-4 rounded-[16px] bg-raised px-4 py-5 text-[13px] text-muted">Your first check shows up here, then every one after it.</p> : (
          <ul className="mt-3 divide-y divide-line">
            {data.history.map((h) => {
              const pill = verdict(h.score, h.counts.critical)[3];
              return (
                <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <span className={cx('tabular grid h-7 min-w-11 place-items-center rounded-full px-2 text-[12.5px] font-semibold', pill)}>{h.score}</span>
                  <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">{timeAgo(h.at)} · {who(h.by)}{h.serverId ? ' · one server' : ''}</span>
                  <span className="flex items-center gap-1" aria-label={ORDER.filter((s) => s !== 'info').map((s) => `${h.counts[s]} ${s}`).join(', ')}>
                    {ORDER.filter((s) => s !== 'info' && h.counts[s]).map((s) => <span key={s} className="inline-flex items-center gap-1 text-[11.5px] text-muted"><span className={cx('size-1.5 rounded-full', SEV[s].dot)} />{h.counts[s]}</span>)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="p-5 md:p-6">
        <CardHeader icon={<CalendarClock size={19} />} title="Every week" sub="Warden checks while you sleep." />
        <div className="mt-2">
          <SwitchRow title="Run the check every week" body="Warden runs it once a week and tells you right away about anything new and serious (on your phone too, if alerts are set up)."
            checked={data.weekly} disabled={!canChange} onChange={async (on) => {
              const res = await runTool('security.weekly', { on }).catch((e) => ({ status: 'error' as const, error: { code: 'network', message: (e as Error).message } }));
              if (res.status === 'ok') { sec.setData({ ...data, weekly: on }); toast('ok', on ? 'Weekly check is on' : 'Weekly check is off'); }
              else toast('bad', 'Couldn’t change that', res.status === 'error' ? res.error.message : res.status === 'denied' ? res.why : undefined, { action: stepAction(res as never) });
            }} />
        </div>
      </Card>
    </>
  );
}

// --- a server's page: the same check, for just this server ---------------------------------------------------
export function ServerSecurityCheck({ sec, name }: { sec: ReturnType<typeof useSecurity>; name: string }) {
  const r = sec.data?.latest ?? null;
  const shown: ReactNode = sec.steps ? <div className="mt-3"><Steps steps={sec.steps} /></div>
    : r ? <div className="mt-4"><Findings report={r} compact firstRun={(sec.data?.history.length ?? 0) < 2} /></div> : null;
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-[180px]">
          <p className="text-[13.5px] font-medium">Security check</p>
          <p className="text-[12.5px] text-muted">{r ? <>Score <b className="tabular text-ink">{r.score}</b> · checked {timeAgo(r.at)}</> : `Ports, sign-in, firewall, containers and logs on ${name}.`}</p>
        </div>
        <Button size="sm" variant={r ? 'soft' : 'dark'} loading={sec.running} icon={<ShieldCheck size={13} />} onClick={sec.check}>{sec.running ? 'Checking…' : r ? 'Check again' : 'Run a security check'}</Button>
        <AiButton size="sm" disabled={sec.running} onClick={() => deepCheck(r, name)}>Deep check with AI</AiButton>
      </div>
      {shown}
    </div>
  );
}
