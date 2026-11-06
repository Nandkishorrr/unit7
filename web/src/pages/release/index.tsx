// A release as one story: Build → Test → Database → Start → Check → Switch → Drain → Watch → Done. The same timeline
// on the app page, in a chat card and in Activity. Live while it runs (deployment.step events), with how long this app
// usually takes, the commits it ships, the measured proof ("0 s down · 0 failed requests") and the watch after the
// switch. `lanes` draws one row per server (a rollout across many servers).
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, GitCommitHorizontal, RotateCcw, ShieldCheck, ThumbsUp } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { act, Button, Card, CardHeader, ChipSelect, HoverCard, Input, StatusMark, Switch, confirmDialog, cx, type MarkState } from '../../ui';
import { AskButton } from '../Help';
import { Choices } from '../choices';
import { deployChoices, type Choice } from '../../lib/choices';

export type StepState = 'active' | 'done' | 'failed' | 'skipped' | 'todo';
export interface Step { key: string; state: StepState; at?: string; ms?: number; note?: string; line?: number }
export interface Proof { measured: boolean; why?: string; requests?: number; failed?: number | null; downtimeSeconds?: number }
export interface Release {
  deploymentId: string; serviceId: string; service?: string; kind?: string; number: number; status: string; triggeredBy?: string | null;
  startedAt: string; finishedAt: string | null; error: string | null; steps: Step[]; commits: string[]; commit?: string;
  proof: Proof | null; watch: { status: string; until?: string; minutes?: number; reason?: string; base?: Counts; now?: Counts; autoRollback?: boolean } | null;
  usualMs: number | null; lines: string[];
  choices?: Choice[]; // the build doctor's own way forward for this deploy (src/deploy/heal.ts), when it has one
}
interface Counts { requests: number; errors: number; p95?: number }
export interface Lane { key: string; label: ReactNode; steps: Step[]; note?: ReactNode }

// the nine steps, each with the one sentence that explains it (shown on hover, and while it's the step at work)
export const STEPS: { key: string; label: string; says: string }[] = [
  { key: 'build', label: 'Build', says: 'Gets your code and builds the new version.' },
  { key: 'test', label: 'Test', says: 'Runs the app’s own tests, so a broken change stops here.' },
  { key: 'database', label: 'Database', says: 'Makes the database changes the new version needs, after a backup.' },
  { key: 'start', label: 'Start', says: 'Starts the new version beside the live one. Visitors still use the old one.' },
  { key: 'check', label: 'Check', says: 'Makes sure it answers, and opens your busiest pages so they’re warm.' },
  { key: 'switch', label: 'Switch', says: 'Moves visitors to the new version in one step.' },
  { key: 'drain', label: 'Drain', says: 'Lets the old version finish what it’s doing before it stops, so nobody is cut off.' },
  { key: 'watch', label: 'Watch', says: 'Watches errors and speed for a few minutes, and goes back by itself if they get clearly worse.' },
  { key: 'done', label: 'Done', says: 'The new version is live and settled.' },
];
// what to do next when a step fails
const NEXT: Record<string, string> = {
  build: 'The build log under Advanced shows where it broke.',
  test: 'Fix the failing test and deploy again. A person can choose “Deploy anyway”.',
  database: 'Nothing changed in the database that the old version can’t use.',
  start: 'The new version didn’t start; the old one kept serving.',
  check: 'The old version kept serving; visitors never saw the new one.',
  switch: 'Visitors were moved back to the old version.',
  drain: 'The new version is live; only the old one’s stop had trouble.',
  watch: 'The version before is live again. Fix it and deploy again.',
};

export function dur(ms?: number | null) {
  if (ms == null || ms < 50) return '';
  if (ms < 1000) return `${Math.max(0.1, Math.round(ms / 100) / 10)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const s = Math.round((ms % 60_000) / 1000);
  return `${Math.floor(ms / 60_000)} min${s ? ` ${s} s` : ''}`;
}
const pct = (c?: Counts) => (c && c.requests ? `${(Math.round((c.errors / c.requests) * 1000) / 10).toString()}%` : null);
const MARK: Record<StepState, MarkState> = { done: 'ok', active: 'work', failed: 'bad', skipped: 'off', todo: 'off' };

// the nine steps from what the server recorded: missing ones are still to come (or never ran, after a failure)
export function stepsOf(r: Pick<Release, 'steps' | 'status'>): Step[] {
  const by = new Map(r.steps.map((s) => [s.key, s]));
  return STEPS.map((x) => by.get(x.key) ?? { key: x.key, state: 'todo' as const });
}
const labelOf = (key: string) => STEPS.find((x) => x.key === key)?.label ?? key;
const saysOf = (key: string) => STEPS.find((x) => x.key === key)?.says ?? '';

// a ticking clock while something is under way
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!on) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [on]);
  return now;
}

// one deploy, fetched and kept live. Without a deploymentId it follows the service's newest deploy (and adopts the one
// a running deploy announces).
export function useRelease(deploymentId?: string, serviceId?: string) {
  const [r, setR] = useState<Release | null | undefined>(undefined);
  const [id, setId] = useState(deploymentId);
  useEffect(() => setId(deploymentId), [deploymentId]);
  const load = async () => {
    if (!id && !serviceId) return;
    const res = await runTool('deployment.release', id ? { deploymentId: id } : { serviceId }).catch(() => null);
    setR(res?.status === 'ok' ? (res.output as Release | null) : null);
  };
  useEffect(() => { void load(); }, [id, serviceId]);
  useEffect(() => onLive((e) => {
    const d = e.data ?? {};
    if (e.type === 'deployment.step' && (d.deploymentId === id || (!id && serviceId && d.serviceId === serviceId))) {
      if (!id) setId(d.deploymentId);
      setR((cur) => (cur && cur.deploymentId === d.deploymentId ? { ...cur, steps: d.steps } : cur));
      if (!r || r.deploymentId !== d.deploymentId) void load();
    } else if (/^deployment\.(watch_|rolled_back|succeeded|failed|rolledback)/.test(e.type) && (d.deploymentId === id || e.resource === serviceId || d.serviceId === (r?.serviceId ?? serviceId))) void load();
  }), [id, serviceId, r?.deploymentId]);
  return { release: r, reload: load };
}

// "0 s down · 0 failed requests", from what the proxy saw; never a made-up 0
export function ProofChip({ proof, className }: { proof?: Proof | null; className?: string }) {
  if (!proof) return null;
  if (!proof.measured) return <HoverCard content={<p className="max-w-[260px] text-[12.5px] text-ink-2">{proof.why ?? 'Unit7 couldn’t read the proxy’s log for this switch.'}</p>}><span tabIndex={0} className={cx('inline-flex h-6 items-center rounded-full bg-raised px-2.5 text-[11.5px] font-medium text-muted', className)}>Not measured</span></HoverCard>;
  const bad = (proof.failed ?? 0) > 0;
  const tip = proof.requests ? `Counted from ${proof.requests} request${proof.requests === 1 ? '' : 's'} through the proxy while visitors moved to the new version (Unit7 sends a few of its own, so there’s always something to count).` : 'No requests went through the proxy while visitors moved, so there was nothing to count.';
  return (
    <HoverCard content={<p className="max-w-[260px] text-[12.5px] text-ink-2">{tip}</p>}>
      <span tabIndex={0} className={cx('tabular inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-semibold', bad ? 'bg-bad/12 text-bad' : 'bg-ok/12 text-ok', className)}>
        <ShieldCheck size={12} aria-hidden />{proof.requests ? `${Math.round(proof.downtimeSeconds ?? 0)} s down · ${proof.failed ?? 0} failed request${proof.failed === 1 ? '' : 's'}` : 'No traffic to measure'}
      </span>
    </HoverCard>
  );
}

// --- the timeline ------------------------------------------------------------------------------------------------
// running: a deploy was just asked for; until it shows up, the service's newest (older) deploy isn't shown as if it were this one
export function ReleaseTimeline({ deploymentId, serviceId, release: given, lanes, compact, running, fallback, className }: {
  deploymentId?: string; serviceId?: string; release?: Release | null; lanes?: Lane[]; compact?: boolean; running?: boolean; fallback?: ReactNode; className?: string;
}) {
  const live = useRelease(given ? undefined : deploymentId, given ? undefined : serviceId);
  const r = given ?? live.release;
  if (lanes) return <Lanes lanes={lanes} className={className} />;
  if (r === undefined) return <div className={cx('h-16 animate-pulse rounded-[16px] bg-raised/70', className)} aria-hidden />;
  if (!r || !r.steps.length || (running && !deploymentId && r.status !== 'building' && r.status !== 'deploying')) return <>{fallback ?? null}</>;
  return <Story r={r} reload={live.reload} compact={compact} className={className} />;
}

function Story({ r, reload, compact, className }: { r: Release; reload: () => void; compact?: boolean; className?: string }) {
  const steps = stepsOf(r);
  const running = r.status === 'building' || r.status === 'deploying';
  const watching = r.watch?.status === 'watching';
  const now = useNow(running || watching);
  // the step in focus: the one that failed or is at work; a finished release opens one only when it's picked
  const at = steps.find((x) => x.state === 'failed') ?? steps.find((x) => x.state === 'active');
  const [picked, setPicked] = useState<string | null>(null);
  const focus = steps.find((x) => x.key === picked) ?? at;
  const elapsed = running ? now - Date.parse(r.startedAt) : r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null;
  return (
    <div className={cx('@container min-w-0', className)}>
      {/* the version, its commit and what it ships; how long this usually takes */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]">
        <span className="tabular font-semibold text-ink">v{r.number}</span>
        {r.commit && <span className="font-mono text-[11.5px] text-muted">{r.commit.slice(0, 7)}</span>}
        {r.commits[0] && <span className="min-w-0 truncate text-ink-2">“{r.commits[0]}”</span>}
        <span className="ml-auto tabular text-muted">{running ? <>{dur(elapsed ?? 0)}{r.usualMs ? <> · usually {dur(r.usualMs)}</> : null}</> : elapsed ? <>took {dur(elapsed)}</> : null}</span>
      </div>
      {!compact && r.commits.length > 1 && (
        <ul className="mt-1.5 space-y-0.5 text-[12px] text-muted">
          {r.commits.slice(1, 3).map((c, i) => <li key={i} className="flex min-w-0 items-center gap-1.5"><GitCommitHorizontal size={12} className="shrink-0" aria-hidden /><span className="truncate">{c}</span></li>)}
          {r.commits.length > 3 && <li className="pl-[18px]">and {r.commits.length - 3} more</li>}
        </ul>
      )}
      {/* nine dots joined by a line; on a narrow card, a list */}
      <ol className="mt-3 grid gap-1 @lg:grid-cols-9 @lg:gap-0" aria-label="Release steps">
        {steps.map((st, i) => {
          const on = focus?.key === st.key;
          return (
            <li key={st.key} className="relative min-w-0">
              {i < steps.length - 1 && <span aria-hidden className={cx('absolute hidden h-0.5 @lg:block', 'left-[calc(50%+13px)] right-[calc(-50%+13px)] top-[11px] rounded-full', st.state === 'done' || st.state === 'skipped' ? 'bg-ok/45' : 'bg-line-strong')} />}
              <HoverCard content={<div className="max-w-[240px]"><p className="font-medium">{labelOf(st.key)}</p><p className="mt-0.5 text-[12.5px] text-ink-2">{saysOf(st.key)}</p>{st.note && <p className="mt-1.5 text-[12px] text-muted">{st.note}</p>}</div>}>
                <button type="button" onClick={() => setPicked(on && picked ? null : st.key)} aria-pressed={on}
                  className={cx('flex w-full min-w-0 items-center gap-2 rounded-[12px] px-1.5 py-1 text-left transition-colors @lg:flex-col @lg:gap-1 @lg:text-center', on ? 'bg-raised' : 'hover:bg-raised/60', st.state === 'todo' && 'opacity-50')}>
                  <StatusMark state={MARK[st.state]} size={22} solid={st.state === 'done'} label={`${labelOf(st.key)}: ${st.state === 'todo' ? 'not yet' : st.state === 'skipped' ? 'nothing to do' : st.state}`} />
                  <span className="min-w-0 flex-1 @lg:flex-none">
                    <span className={cx('block truncate text-[12px] font-medium leading-tight', st.state === 'failed' ? 'text-bad' : st.state === 'active' ? 'text-ink' : 'text-ink-2')}>{labelOf(st.key)}</span>
                    <span className="tabular block text-[11px] text-muted @lg:min-h-[14px]">{st.state === 'active' && st.at ? dur(now - Date.parse(st.at)) : st.state === 'done' || st.state === 'failed' ? dur(st.ms) : ''}</span>
                  </span>
                  {st.note && <span className="line-clamp-2 min-w-0 flex-[2] text-[12px] text-muted @lg:hidden">{st.note}</span>}
                </button>
              </HoverCard>
            </li>
          );
        })}
      </ol>
      {focus && <Focus r={r} st={focus} steps={steps} reload={reload} compact={compact} />}
      {r.watch && r.watch.status !== 'watching' && r.watch.status !== 'stopped' && r.watch.status !== 'ended' && r.watch.reason && focus?.key !== 'watch' && (
        <p className="mt-2 text-[12.5px] text-warn">{r.watch.reason}</p>
      )}
      {watching && <Watching r={r} now={now} reload={reload} />}
      {!running && r.proof && <div className="mt-2.5 flex flex-wrap items-center gap-2"><ProofChip proof={r.proof} /></div>}
    </div>
  );
}

// the step in focus: its one plain line; a failed step says why and what's next; Advanced holds its own log lines
function Focus({ r, st, steps, reload, compact }: { r: Release; st: Step; steps: Step[]; reload: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState(false);
  useEffect(() => { setOpen(false); setWhy(false); }, [st.key]);
  const nextLine = steps.map((x) => x.line).filter((n, i) => n !== undefined && i > steps.indexOf(st)).find((n) => n! > (st.line ?? 0));
  const lines = st.line === undefined ? [] : r.lines.slice(st.line, nextLine ?? undefined).filter(Boolean);
  const failed = st.state === 'failed';
  return (
    <div className={cx('mt-2 rounded-[14px] px-3 py-2.5 text-[12.5px]', failed ? 'bg-bad/8' : 'bg-raised/70')}>
      <p className={cx('flex flex-wrap items-center gap-x-2 gap-y-1', failed ? 'text-bad' : 'text-ink-2')}>
        <span className="font-medium">{labelOf(st.key)}</span>
        <span className="min-w-0 flex-1">{st.note || saysOf(st.key)}</span>
        {failed && <button type="button" onClick={() => setWhy(!why)} aria-expanded={why} className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">Why?</button>}
        {lines.length > 0 && <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-0.5 text-muted hover:text-ink">Advanced<ChevronDown size={13} className={cx('transition-transform', open && 'rotate-180')} /></button>}
      </p>
      {failed && why && (
        <div className="mt-2 space-y-2 text-ink-2">
          <p className="[overflow-wrap:anywhere]">{(r.error ?? st.note ?? '').split('\n').slice(0, 3).join(' ')}</p>
          <p className="text-muted">{NEXT[st.key] ?? 'Your site kept running the old version.'}</p>
          {compact && <AskButton label="Ask Unit7 to fix it" prompt={`The ${labelOf(st.key).toLowerCase()} step of deploy v${r.number}${r.service ? ` of ${r.service}` : ''} failed: ${(r.error ?? st.note ?? '').slice(0, 300)}. Read its log, tell me why in plain words, and fix it.`} />}
        </div>
      )}
      {/* the failed step's way forward, as buttons (a compact timeline sits in a card that has its own) */}
      {failed && !compact && <Choices className="mt-2.5" label="What to do now" onDone={reload}
        choices={r.choices?.length ? r.choices : deployChoices({ serviceId: r.serviceId, error: r.error ?? st.note, step: labelOf(st.key).toLowerCase(), service: r.service, number: r.number })} />}
      {open && <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[12px] bg-[#111115] p-3 font-mono text-[11px] leading-relaxed text-white/80">{lines.join('\n')}</pre>}
    </div>
  );
}

// "Watching the new version · 3:42 left · errors 0.1% (usual 0.2%)", with the two ways out
function Watching({ r, now, reload }: { r: Release; now: number; reload: () => void }) {
  const w = r.watch!;
  const left = Math.max(0, Date.parse(w.until ?? '') - now);
  const [busy, setBusy] = useState<string | null>(null);
  const cur = pct(w.now), usual = pct(w.base);
  const go = async (what: string, fn: () => Promise<unknown>) => { setBusy(what); await fn(); setBusy(null); reload(); };
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-line px-3 py-2.5 text-[12.5px]">
      <span className="relative flex size-2.5 shrink-0" aria-hidden><span className="absolute inset-0 animate-ping rounded-full bg-blue/50 motion-reduce:hidden" /><span className="relative size-2.5 rounded-full bg-blue" /></span>
      <p className="tabular min-w-0 flex-1 text-ink-2">
        Watching the new version · {Math.floor(left / 60_000)}:{String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')} left
        {cur ? <> · errors {cur}{usual ? <span className="text-muted"> (usual {usual})</span> : null}</> : <span className="text-muted"> · no visits yet</span>}
        {w.autoRollback === false && <span className="block text-[12px] text-muted">It won’t roll back by itself{w.reason ? '' : ' (this deploy changed the database, or a person turned that off)'}.</span>}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="soft" icon={<ThumbsUp size={13} />} loading={busy === 'ok'} disabled={!!busy} onClick={() => go('ok', () => act('deployment.watch_stop', { serviceId: r.serviceId }, { success: 'Stopped watching' }))}>Looks good, stop watching</Button>
        <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} loading={busy === 'back'} disabled={!!busy} onClick={() => go('back', () => act('deployment.rollback', { serviceId: r.serviceId }, { success: 'Rolled back' }))}>Roll back</Button>
      </div>
    </div>
  );
}

// many servers: one row per server, the steps as columns, filling left to right
function Lanes({ lanes, className }: { lanes: Lane[]; className?: string }) {
  return (
    <div className={cx('min-w-0 overflow-x-auto', className)}>
      <table className="w-full min-w-[560px] border-separate border-spacing-y-1 text-[12px]">
        <thead><tr><th className="w-[22%] text-left font-medium text-muted"><span className="sr-only">Server</span></th>{STEPS.map((s) => <th key={s.key} scope="col" className="font-medium text-muted">{s.label}</th>)}</tr></thead>
        <tbody>
          {lanes.map((l) => {
            const steps = stepsOf({ steps: l.steps, status: '' });
            return (
              <tr key={l.key}>
                <th scope="row" className="truncate rounded-l-[12px] bg-raised/60 px-2.5 py-1.5 text-left font-medium text-ink">{l.label}{l.note && <span className="block truncate text-[11px] font-normal text-muted">{l.note}</span>}</th>
                {steps.map((st, i) => (
                  <td key={st.key} className={cx('bg-raised/60 py-1.5 text-center', i === steps.length - 1 && 'rounded-r-[12px]', st.state === 'todo' && 'opacity-50')}>
                    <span className="inline-flex flex-col items-center gap-0.5">
                      <StatusMark state={MARK[st.state]} size={18} solid={st.state === 'done'} label={`${labelOf(st.key)}: ${st.state}`} />
                      <span className="tabular min-h-[13px] text-[10.5px] text-muted">{st.state === 'done' || st.state === 'failed' ? dur(st.ms) : ''}</span>
                    </span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- the app page's "How releases work" card ------------------------------------------------------------------------
interface ReleaseCfg { drainSeconds: number; websockets: boolean; watchMinutes: number; autoRollback: boolean; mustContain: string; workerGraceSeconds: number; proof?: { deploys: number; measured: number; downtimeSeconds: number; failedRequests: number } }
export function lastDeploysLine(p?: ReleaseCfg['proof']) {
  if (!p?.measured) return null;
  return `Last ${p.measured} deploy${p.measured === 1 ? '' : 's'}: ${Math.round(p.downtimeSeconds)} second${Math.round(p.downtimeSeconds) === 1 ? '' : 's'} of downtime`;
}

export function HowReleases({ serviceId, worker, cfg, onChange, className }: { serviceId: string; worker?: boolean; cfg: ReleaseCfg; onChange: () => void; className?: string }) {
  const [text, setText] = useState(cfg.mustContain);
  useEffect(() => setText(cfg.mustContain), [cfg.mustContain]);
  const set = async (input: object, success: string) => { if (await act('release.settings', { serviceId, ...input }, { success })) onChange(); };
  // turning a safety off: a person, who says so out loud
  const off = async (input: object, title: string, body: string, success: string) => { if (await confirmDialog({ title, body, confirm: 'Turn it off', danger: true })) await set(input, success); };
  const secs = (n: number) => (n < 60 ? `${n} s` : `${n / 60} min`);
  const line = lastDeploysLine(cfg.proof);
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<ShieldCheck size={19} />} title="How releases work" sub="A new version takes over without dropping anyone" />
      {line && <p className="mt-4 rounded-[16px] bg-ok/10 px-4 py-3 text-[13.5px] font-medium text-ok">{line}<span className="block text-[12px] font-normal text-muted">Counted from the proxy’s own log while visitors moved over.</span></p>}
      <div className="mt-2 divide-y divide-line">
        {!worker && (
          <Row title="Let it finish" body={`Before the old version stops, it finishes what it’s doing: up to ${secs(cfg.drainSeconds)}${cfg.websockets ? ', longer because this app keeps live connections' : ''}.`}>
            <ChipSelect label="How long the old version may finish" value={String(cfg.drainSeconds)} onChange={(v) => set({ drainSeconds: Number(v) }, 'Saved')} options={[10, 30, 60, 120, 300].map((n) => ({ value: String(n), label: secs(n) }))} />
          </Row>
        )}
        {!worker && (
          <Row title="Watch after a release" body={cfg.watchMinutes ? `For ${cfg.watchMinutes} minutes after the switch, Unit7 compares errors and speed with the usual.` : 'Off: nobody watches the new version right after it goes live.'}>
            <ChipSelect label="How long to watch" value={String(cfg.watchMinutes)} options={[0, 2, 5, 10, 15].map((n) => ({ value: String(n), label: n ? `${n} min` : 'Off' }))}
              onChange={(v) => (Number(v) ? set({ watchMinutes: Number(v) }, 'Saved') : off({ watchMinutes: 0 }, 'Stop watching new versions?', 'Unit7 won’t compare errors after a release, and won’t roll back by itself.', 'Watching is off'))} />
          </Row>
        )}
        {!worker && (
          <Row title="Roll back by itself" body="If errors jump or it stops answering, the version before comes back on its own and you get told why.">
            <Switch label="Roll back by itself" checked={cfg.autoRollback} disabled={!cfg.watchMinutes}
              onChange={(v) => (v ? set({ autoRollback: true }, 'On') : off({ autoRollback: false }, 'Stop rolling back by itself?', 'A bad release stays live until someone rolls it back.', 'Rolling back by itself is off'))} />
          </Row>
        )}
        {worker && (
          <Row title="Let the old worker finish" body={`A new worker starts first; the old one gets ${secs(cfg.workerGraceSeconds)} to finish its job, then stops.`}>
            <ChipSelect label="Grace time for the old worker" value={String(cfg.workerGraceSeconds)} onChange={(v) => set({ workerGraceSeconds: Number(v) }, 'Saved')} options={[30, 60, 120, 300].map((n) => ({ value: String(n), label: secs(n) }))} />
          </Row>
        )}
      </div>
      {!worker && (
        <details className="group mt-1">
          <summary className="flex cursor-pointer list-none items-center gap-1 py-2 text-[12.5px] font-medium text-muted hover:text-ink">Advanced<ChevronDown size={13} className="transition-transform group-open:rotate-180" /></summary>
          <form className="space-y-2 pb-1" onSubmit={(e) => { e.preventDefault(); if (text.trim() === cfg.mustContain) return; void (text.trim() ? set({ mustContain: text.trim() }, 'Saved') : off({ mustContain: '' }, 'Remove the page check?', 'The new version only has to answer, not show this text.', 'Removed')); }}>
            <label htmlFor={`must-${serviceId}`} className="block text-[13px] font-medium text-ink">The page must contain</label>
            <p className="text-[12px] text-muted">Visitors move only when the health page shows this text (say, a word only a working page has). Empty: any good answer will do.</p>
            <div className="flex gap-2"><Input id={`must-${serviceId}`} value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="e.g. Welcome back" /><Button size="sm" variant="secondary" disabled={text.trim() === cfg.mustContain}>Save</Button></div>
          </form>
          <p className="pb-1 text-[12px] text-muted">The old version is stopped, not deleted, so going back takes seconds. Database changes that would break it are checked before they run.</p>
        </details>
      )}
    </Card>
  );
}

function Row({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className="min-w-[200px] flex-1"><span className="block text-[13.5px] font-medium text-ink">{title}</span><span className="block text-[12.5px] text-muted">{body}</span></span>
      {children}
    </div>
  );
}

