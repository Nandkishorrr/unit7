// Routines: what Unit7 does for you on a schedule, as you, with the same approvals. The page shows each routine calmly
// (what, when, how its last run went) with on/off and Run now; a click opens its runs in a pop-up. New routine saves
// an ask in plain words; SaveAsRoutine (under the Home chat) turns the steps that worked in a chat into a routine.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, CalendarClock, Check, ChevronDown, Clock, ListChecks, Loader2, Play, Repeat, Smartphone, Trash2, TriangleAlert, X } from 'lucide-react';
import { onLive, runTool, type ToolResult } from '../../lib/api';
import { navigate } from '../../lib/router';
import { toolWords } from '../../lib/words';
import { A, act, AiButton, AiSparkle, Badge, Button, Card, Empty, Field, HoldButton, IconCircle, Illustration, Input, Modal, PageHeader, Skeleton, Switch, Textarea, cx, timeAgo, toast } from '../../ui';
import { Menu } from '../kit';
import { aboutOf, type ContextItem } from '../chat/about';
import type { ChatMsg } from '../chat/types';

export interface RoutineStep { tool: string; title: string; input?: unknown }
export interface Routine {
  id: string; name: string; kind: 'steps' | 'ask'; ask: string | null; askBy?: 'person' | 'ai' | 'unknown'; steps: RoutineStep[]; schedule: string; scheduleText: string; tz: string | null;
  scope: ContextItem[]; report: string[]; next: string | null; last: string | null; lastStatus: string | null; lastSummary: string | null;
  paused: boolean; pausedWhy: string | null; fails: number; owner: string; mine: boolean; runsOn: string | null; running: boolean;
}
interface StepResult { tool: string; title: string; status: 'running' | 'ok' | 'waiting' | 'failed' | 'refused'; note?: string; ms?: number }
interface RunRow { id: string; why: string; status: string; summary: string | null; steps: StepResult[]; conversation_id: string | null; started_at: string; finished_at: string | null }

const myZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };
const errText = (r: ToolResult) => (r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? `Waiting for approval: ${r.why}` : '');

// "in 2 days · Fri 10:00", "in 40m"
export function whenWords(iso: string | null | undefined) {
  if (!iso) return 'not scheduled';
  const t = new Date(iso), s = (t.getTime() - Date.now()) / 1000;
  const at = t.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (s < 60) return 'any minute now';
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h · ${at}`;
  return `in ${Math.round(s / 86400)} day${Math.round(s / 86400) > 1 ? 's' : ''} · ${at}`;
}
const RESULT: Record<string, { tone: 'ok' | 'warn' | 'bad' | 'neutral'; word: string }> = {
  ok: { tone: 'ok', word: 'Worked' }, waiting: { tone: 'warn', word: 'Waiting for you' }, failed: { tone: 'bad', word: 'Didn’t work' },
  refused: { tone: 'bad', word: 'Can’t run' }, stopped: { tone: 'neutral', word: 'You said not now' }, running: { tone: 'neutral', word: 'Running' },
};
const resultOf = (status: string | null | undefined) => (status ? RESULT[status] ?? { tone: 'neutral' as const, word: status } : { tone: 'neutral' as const, word: 'Not run yet' });

// --- the list, live --------------------------------------------------------------------------------------------------
function useRoutines() {
  const [state, setState] = useState<{ list: Routine[] | null; noBrain?: string; error?: string }>({ list: null });
  const load = useCallback(async () => {
    const r = await runTool('routine.list').catch((e: Error) => ({ status: 'error', error: { code: 'http', message: e.message } }) as ToolResult);
    setState(r.status === 'ok' ? { list: r.output.routines, noBrain: r.output.noBrain } : { list: [], error: errText(r) });
  }, []);
  useEffect(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => { if (e.type.startsWith('routine.') && (e.type !== 'routine.run' || e.data?.status)) { clearTimeout(t); t = setTimeout(load, 250); } });
    return () => { off(); clearTimeout(t); };
  }, [load]);
  return { ...state, reload: load };
}

// --- the schedule, in plain words, with a live preview --------------------------------------------------------------
const PRESETS: [string, string][] = [['Every day, 9:00', 'every day at 09:00'], ['Weekdays, 8:00', 'every weekday at 08:00'], ['Fridays, 10:00', 'every Friday at 10:00'], ['Mondays, 9:00', 'every Monday at 09:00'], ['Every hour', 'every hour']];
export function ScheduleField({ value, onChange, preview, error }: { value: string; onChange: (v: string) => void; preview?: { schedule: string; next: string } | null; error?: string }) {
  return (
    <Field label="When" hint="In your own words: “every Friday at 10:00”, “every weekday at 8am”. At most once an hour.">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="every Friday at 10:00" aria-describedby="schedule-said" />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {PRESETS.map(([label, p]) => (
          <button key={p} type="button" onClick={() => onChange(p)} aria-pressed={value.toLowerCase() === p.toLowerCase()}
            className={cx('h-7 rounded-full border px-2.5 text-[12px] font-medium transition', value.toLowerCase() === p.toLowerCase() ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2 hover:bg-raised')}>
            {label}
          </button>
        ))}
      </div>
      <p id="schedule-said" aria-live="polite" className={cx('mt-2 flex min-h-5 items-center gap-1.5 text-[12.5px]', error ? 'text-warn' : 'text-muted')}>
        {error ? <><TriangleAlert size={13} aria-hidden />{error}</>
          : preview ? <><CalendarClock size={13} aria-hidden className="text-blue-text" /><span className="font-medium text-ink">{preview.schedule}</span> · next {whenWords(preview.next)}</>
          : null}
      </p>
    </Field>
  );
}

// a routine as it would be saved: the dry run says the schedule, next run, steps and what it runs on (debounced)
function usePreview(input: Record<string, unknown> | null) {
  const [state, setState] = useState<{ plan?: any; error?: string; loading: boolean }>({ loading: false });
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!input) { setState({ loading: false }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      void runTool('routine.create', input, { dryRun: true }).then((r) => { if (live) setState(r.status === 'dry_run' ? { plan: r.plan, loading: false } : { error: errText(r), loading: false }); })
        .catch((e: Error) => { if (live) setState({ error: e.message, loading: false }); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function PhoneSwitch({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[18px] border border-line bg-raised/50 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Smartphone size={17} aria-hidden className="shrink-0 text-muted" />
        <div className="min-w-0"><p className="text-[13.5px] font-medium">Tell me on my phone</p><p className="text-[12px] text-muted">It’s always in Activity. A run that fails always reaches your phone.</p></div>
      </div>
      <Switch checked={on} onChange={set} label="Tell me on my phone" />
    </div>
  );
}

function StepList({ steps, results }: { steps: { tool: string; title?: string }[]; results?: StepResult[] }) {
  return (
    <ol className="space-y-1.5">
      {steps.map((s, i) => {
        const r = results?.[i];
        return (
          <li key={i} className="flex items-start gap-3 rounded-[14px] bg-raised/60 px-3 py-2.5">
            <StepMark n={i + 1} status={r?.status} />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium leading-snug">{toolWords(s.tool, s.title)}</p>
              {r?.note && <p className={cx('mt-0.5 text-[12px] leading-snug', r.status === 'failed' || r.status === 'refused' ? 'text-bad' : 'text-muted')}>{r.note}</p>}
            </div>
            {r?.ms !== undefined && r.status === 'ok' && <span className="shrink-0 text-[11.5px] tabular text-faint">{r.ms < 1000 ? `${r.ms}ms` : `${Math.round(r.ms / 1000)}s`}</span>}
          </li>
        );
      })}
    </ol>
  );
}
function StepMark({ n, status }: { n: number; status?: StepResult['status'] }) {
  const c = 'grid size-6 shrink-0 place-items-center rounded-full text-[11.5px] font-semibold';
  if (status === 'ok') return <span className={cx(c, 'check-pop bg-ok/12 text-ok')}><Check size={13} strokeWidth={2.6} aria-label="Worked" /></span>;
  if (status === 'running') return <span className={cx(c, 'bg-blue-soft text-blue-text')}><Loader2 size={13} className="animate-spin" aria-label="Running" /></span>;
  if (status === 'waiting') return <span className={cx(c, 'bg-warn/12 text-warn')}><Clock size={13} aria-label="Waiting for you" /></span>;
  if (status === 'failed' || status === 'refused') return <span className={cx(c, 'bg-bad/10 text-bad')}><X size={13} strokeWidth={2.6} aria-label="Didn’t work" /></span>;
  return <span className={cx(c, 'bg-surface text-muted ring-1 ring-line-strong')}>{n}</span>;
}

// --- save a chat's steps as a routine (mounted under the Home chat thread) ------------------------------------------
const LOOKING = new Set(['graph.get', 'map.get', 'memory.recall', 'project.list', 'account.list', 'environment.get', 'approval.list', 'routine.list', 'domain.ideas']);
export const canSaveSteps = (messages: ChatMsg[]) => messages.some((m) => m.role === 'tool' && m.content.status === 'ok' && !LOOKING.has(m.content.tool) && !m.content.tool.startsWith('ui.'));

export function SaveAsRoutine({ conversationId, messages, running, className }: { conversationId: string; messages: ChatMsg[]; running?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!conversationId || running || !canSaveSteps(messages)) return null;
  const first = messages.find((m) => m.role === 'user') as Extract<ChatMsg, { role: 'user' }> | undefined;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={cx('animate-rise inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 shadow-soft transition hover:border-ink hover:text-ink', className)}>
        <Repeat size={14} aria-hidden />Run this every Monday?
      </button>
      <SaveDialog open={open} onClose={() => setOpen(false)} conversationId={conversationId} name={(first?.content.text ?? 'My routine').replace(/\s+/g, ' ').slice(0, 60)} scope={aboutOf(messages)} />
    </>
  );
}

function SaveDialog({ open, onClose, conversationId, name: initialName, scope }: { open: boolean; onClose: () => void; conversationId: string; name: string; scope: ContextItem[] }) {
  const [name, setName] = useState(initialName);
  const [schedule, setSchedule] = useState('every Monday at 09:00');
  const [phone, setPhone] = useState(true);
  const [saving, setSaving] = useState(false);
  const input = useMemo(() => ({ name: name.trim() || 'My routine', schedule, conversationId, scope, report: phone ? ['phone'] : [], tz: myZone() }), [name, schedule, conversationId, scope, phone]);
  const pv = usePreview(open && schedule.trim().length >= 3 ? input : null);
  const scheduleErr = pv.error && /hour|schedule|understand|time|day|week|month/i.test(pv.error) ? pv.error : undefined;
  const save = async () => {
    setSaving(true);
    const r = await act('routine.create', input);
    setSaving(false);
    if (r) { onClose(); toast('ok', `Saved “${input.name}”`, `${r.output.schedule}. It runs as you, with the same approvals.`, { action: { label: 'See routines', onClick: () => navigate('/routines') } }); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Save as a routine" size="md">
      <div className="space-y-5">
        <p className="text-[13.5px] text-muted">Unit7 does these steps again on a schedule, exactly as they worked here. No AI needed, so it’s the same every time.</p>
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-muted"><ListChecks size={14} aria-hidden />What it does</p>
          {pv.plan?.steps ? <StepList steps={pv.plan.steps} />
            : pv.error && !scheduleErr ? <p className="rounded-[14px] bg-warn/10 px-3 py-2.5 text-[13px] text-warn">{pv.error}</p>
            : <div className="space-y-1.5">{[0, 1].map((i) => <Skeleton key={i} className="h-11 rounded-[14px]" />)}</div>}
          {!!pv.plan?.skipped?.length && (
            <details className="mt-2 text-[12.5px] text-muted">
              <summary className="cursor-pointer select-none">{pv.plan.skipped.length} step{pv.plan.skipped.length > 1 ? 's' : ''} left out</summary>
              <ul className="mt-1.5 space-y-1 pl-4">{pv.plan.skipped.map((s: any, i: number) => <li key={i} className="list-disc"><span className="text-ink-2">{toolWords(s.tool, s.title)}</span>: {s.why}</li>)}</ul>
            </details>
          )}
        </div>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <ScheduleField value={schedule} onChange={setSchedule} preview={pv.plan} error={scheduleErr} />
        <PhoneSwitch on={phone} set={setPhone} />
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Repeat size={15} />} loading={saving} disabled={!pv.plan || pv.loading} onClick={save}>Save routine</Button>
        </div>
      </div>
    </Modal>
  );
}

// --- a new routine from plain words ----------------------------------------------------------------------------------
function NewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [ask, setAsk] = useState('');
  const [schedule, setSchedule] = useState('every Friday at 10:00');
  const [phone, setPhone] = useState(true);
  const [saving, setSaving] = useState(false);
  const input = useMemo(() => ({ name: name.trim() || ask.trim().slice(0, 60) || 'My routine', schedule, ask: ask.trim(), report: phone ? ['phone'] : [], tz: myZone() }), [name, ask, schedule, phone]);
  const pv = usePreview(open && ask.trim().length >= 3 && schedule.trim().length >= 3 ? input : null);
  useEffect(() => { if (!open) { setName(''); setAsk(''); } }, [open]);
  const save = async () => {
    setSaving(true);
    const r = await act('routine.create', input, { success: `Saved “${input.name}”` });
    setSaving(false);
    if (r) onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="New routine">
      <div className="space-y-5">
        <Field label="What should Unit7 do?" hint="Plain words, like you’d ask it. Your own AI does it each time, as you, with the same approvals.">
          <Textarea rows={3} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Update the images on staging, check it works, and tell me how it went." autoFocus />
        </Field>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={ask.trim().slice(0, 60) || 'Friday refresh'} maxLength={80} /></Field>
        <ScheduleField value={schedule} onChange={setSchedule} preview={pv.plan} error={pv.error} />
        <PhoneSwitch on={phone} set={setPhone} />
        {pv.plan && (
          <p className={cx('flex items-start gap-2 rounded-[14px] px-3 py-2.5 text-[12.5px]', pv.plan.runsOn ? 'bg-blue-soft text-blue-text' : 'bg-warn/10 text-warn')}>
            {pv.plan.runsOn ? <><AiSparkle size={14} still className="mt-px shrink-0" />Runs on {pv.plan.runsOn.replace(/^Your/, 'your')}. Only your own routines ever use it.</>
              : <><TriangleAlert size={14} className="mt-px shrink-0" />{pv.plan.noBrain}</>}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Repeat size={15} />} loading={saving} disabled={!pv.plan || pv.loading} onClick={save}>Save routine</Button>
        </div>
      </div>
    </Modal>
  );
}

// --- one routine's details and runs ----------------------------------------------------------------------------------
function Details({ routine, onClose }: { routine: Routine | null; onClose: () => void }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [schedule, setSchedule] = useState('');
  const id = routine?.id;
  const load = useCallback(async () => {
    if (!id) return;
    const r = await runTool('routine.list', { routineId: id }).catch(() => undefined);
    if (r?.status === 'ok') { setRuns(r.output.runs); setOpenRun((o) => o ?? r.output.runs[0]?.id ?? null); }
  }, [id]);
  useEffect(() => {
    setRuns(null); setOpenRun(null); setEditing(false);
    if (!id) return;
    void load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => { if (e.type === 'routine.run' && e.data?.routineId === id) { clearTimeout(t); t = setTimeout(load, 150); } });
    return () => { off(); clearTimeout(t); };
  }, [id, load]);
  // the schedule's words and next run (a one-step stand-in, so no AI is asked just to preview a time)
  const pv = usePreview(editing && routine && schedule.trim().length >= 3 ? { name: routine.name, schedule, steps: [{ tool: 'graph.get', input: {} }], tz: myZone() } : null);
  if (!routine) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  const r = routine;
  const saveSchedule = async () => { if (await act('routine.update', { routineId: r.id, schedule, tz: myZone() }, { success: 'Schedule changed' })) setEditing(false); };
  return (
    <Modal open={!!routine} onClose={onClose} title={r.name} size="lg">
      <div className="space-y-6">
        <section className="grid gap-3 sm:grid-cols-3">
          <Fact label="When">{r.schedule}</Fact>
          <Fact label="Next">{r.paused ? 'Paused' : whenWords(r.next)}</Fact>
          <Fact label="Runs on">{r.kind === 'steps' ? 'Saved steps, no AI' : r.runsOn ?? 'No AI set up'}</Fact>
        </section>
        {r.paused && r.pausedWhy && <p className="flex items-start gap-2 rounded-[14px] bg-warn/10 px-3 py-2.5 text-[13px] text-warn"><TriangleAlert size={15} className="mt-px shrink-0" />{r.pausedWhy}</p>}
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">What it does</h3>
          {r.kind === 'steps' ? <StepList steps={r.steps} /> : <blockquote className="rounded-[14px] bg-raised/60 px-4 py-3 text-[14px] leading-relaxed">“{r.ask}”</blockquote>}
          {r.kind === 'ask' && r.askBy && r.askBy !== 'person' && <p className="mt-2 text-[12.5px] text-muted">{r.askBy === 'ai' ? 'Written by an AI' : 'Saved before Unit7 noted who wrote it'}: it runs as a suggestion, not as your own words.</p>}
          {!!r.scope.length && <p className="mt-2 text-[12.5px] text-muted">About {r.scope.map((s) => s.name).join(', ')}</p>}
        </section>
        {r.mine && (
          <section>
            {editing ? (
              <div className="space-y-3 rounded-[18px] border border-line p-4">
                <ScheduleField value={schedule} onChange={setSchedule} preview={pv.plan} error={pv.error} />
                <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button><Button variant="dark" size="sm" disabled={!pv.plan} onClick={saveSchedule}>Save</Button></div>
              </div>
            ) : <Button variant="soft" size="sm" icon={<CalendarClock size={14} />} onClick={() => { setSchedule(r.scheduleText); setEditing(true); }}>Change when</Button>}
          </section>
        )}
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">Runs</h3>
          {!runs ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-[16px]" />)}</div>
            : !runs.length ? <p className="rounded-[16px] border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">No runs yet. {r.paused ? '' : `The first is ${whenWords(r.next)}.`}</p>
            : (
              <ul className="space-y-2">
                {runs.map((x) => {
                  const res = resultOf(x.status), on = openRun === x.id;
                  return (
                    <li key={x.id} className="overflow-hidden rounded-[16px] border border-line">
                      <button type="button" onClick={() => setOpenRun(on ? null : x.id)} aria-expanded={on} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-raised/60">
                        <Badge tone={res.tone === 'neutral' ? 'neutral' : res.tone}>{x.status === 'running' && <Loader2 size={12} className="animate-spin" />}{res.word}</Badge>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{x.summary ?? (x.status === 'running' ? 'Working on it…' : '')}</span>
                        <span className="shrink-0 text-[12px] text-faint" title={new Date(x.started_at).toLocaleString()}>{x.why === 'now' ? 'Run now · ' : ''}{timeAgo(x.started_at)}</span>
                        <ChevronDown size={15} aria-hidden className={cx('shrink-0 text-muted transition-transform', on && 'rotate-180')} />
                      </button>
                      {on && (
                        <div className="animate-pop border-t border-line px-4 py-3">
                          {r.kind === 'steps' ? <StepList steps={x.steps.length ? x.steps : r.steps} results={x.steps} />
                            : <p className="text-[13px] leading-relaxed text-ink-2">{x.summary ?? 'Working on it…'}</p>}
                          {x.status === 'waiting' && <A href="/approvals" className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-blue-text hover:underline">Open Approvals<ArrowUpRight size={13} /></A>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
        </section>
      </div>
    </Modal>
  );
}
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="rounded-[18px] bg-raised/60 px-4 py-3"><p className="text-[12px] text-muted">{label}</p><p className="mt-0.5 text-[14px] font-medium leading-snug">{children}</p></div>
);

// --- the page --------------------------------------------------------------------------------------------------------
export function RoutinesPage() {
  const { list, noBrain, error, reload } = useRoutines();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Routine | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const routine = list?.find((r) => r.id === shown) ?? null;
  const next = list?.filter((r) => !r.paused && r.next).sort((a, b) => a.next!.localeCompare(b.next!))[0];
  const toggle = async (r: Routine, on: boolean) => { setBusy(r.id); await act('routine.pause', { routineId: r.id, paused: !on }, { success: on ? `“${r.name}” is on` : `“${r.name}” is paused`, undo: false }); setBusy(null); void reload(); };
  const runNow = async (r: Routine) => { setBusy(r.id); if (await act('routine.run_now', { routineId: r.id }, { success: `Running “${r.name}”`, undo: false })) setShown(r.id); setBusy(null); };
  return (
    <div>
      <PageHeader title="Routines" subtitle="What Unit7 does for you on a schedule, as you, with the same approvals as when you ask."
        actions={<AiButton onClick={() => setCreating(true)}>New routine</AiButton>} />
      {error && <p className="mb-4 rounded-[16px] bg-bad/10 px-4 py-3 text-[13.5px] text-bad">{error}</p>}
      {noBrain && <p className="mb-4 flex items-start gap-2 rounded-[16px] bg-warn/10 px-4 py-3 text-[13px] text-warn"><TriangleAlert size={15} className="mt-px shrink-0" />{noBrain}</p>}
      {!list ? <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[84px] rounded-[24px]" />)}</div>
        : !list.length ? (
          <Empty art={<Illustration name="routines" size={104} />} title="No routines yet"
            body="After something works in the chat, press “Save as a routine” under it. Or tell Unit7 what to do every week, in your own words."
            action={<AiButton strong onClick={() => setCreating(true)}>New routine</AiButton>} />
        ) : (
          <>
            {next && (
              <Card className="relative mb-4 overflow-hidden p-5 animate-rise">
                <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 size-48 rounded-full bg-blue/10 blur-2xl" />
                <div className="relative flex flex-wrap items-center gap-4">
                  <IconCircle tone="blue" size={48}><CalendarClock size={21} /></IconCircle>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] text-muted">Next up</p>
                    <p className="truncate text-[18px] font-semibold tracking-[-0.02em]">{next.name}</p>
                    <p className="text-[13px] text-ink-2">{whenWords(next.next)}</p>
                  </div>
                  <div className="flex gap-6 text-right">
                    <Stat n={list.filter((r) => !r.paused).length} label="on" />
                    <Stat n={list.filter((r) => r.lastStatus === 'waiting').length} label="waiting for you" warn />
                    <Stat n={list.filter((r) => r.lastStatus === 'failed' || r.lastStatus === 'refused').length} label="need a look" bad />
                  </div>
                </div>
              </Card>
            )}
            <ul className="space-y-2.5">
              {list.map((r, i) => {
                const res = r.running ? RESULT.running! : resultOf(r.lastStatus);
                return (
                  <li key={r.id} className="animate-rise" style={{ animationDelay: `${60 + i * 40}ms` }}>
                    <div className={cx('group flex flex-wrap items-center gap-3 rounded-[24px] border border-line bg-surface p-4 shadow-soft transition hover:border-line-strong sm:flex-nowrap', r.paused && 'opacity-75')}>
                      <button type="button" onClick={() => setShown(r.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left max-sm:basis-full" aria-label={`${r.name}: details and runs`}>
                        <IconCircle tone={r.kind === 'ask' ? 'soft' : 'neutral'} size={42}>{r.kind === 'ask' ? <AiSparkle size={18} still /> : <Repeat size={18} />}</IconCircle>
                        <span className="min-w-0">
                          <span className="block truncate text-[15px] font-medium tracking-[-0.01em]">{r.name}</span>
                          <span className="block truncate text-[12.5px] text-muted">{r.schedule}{r.paused ? ' · paused' : ` · next ${whenWords(r.next)}`}{r.mine ? '' : ` · ${r.owner}’s`}</span>
                        </span>
                      </button>
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium" title={r.lastSummary ?? undefined}>
                        {r.running ? <Loader2 size={13} className="animate-spin text-blue-text" aria-hidden /> : <span aria-hidden className={cx('size-2 rounded-full', res.tone === 'ok' ? 'bg-ok' : res.tone === 'warn' ? 'bg-[#f59e0b]' : res.tone === 'bad' ? 'bg-bad' : 'bg-faint/60')} />}
                        <span className={cx(res.tone === 'bad' ? 'text-bad' : res.tone === 'warn' ? 'text-warn' : 'text-ink-2')}>{res.word}</span>
                        {r.last && <span className="font-normal text-faint">· {timeAgo(r.last)}</span>}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <Switch checked={!r.paused} onChange={(on) => toggle(r, on)} label={r.paused ? `Turn on ${r.name}` : `Pause ${r.name}`} disabled={busy === r.id} />
                        {r.mine && (
                          <button type="button" onClick={() => runNow(r)} disabled={busy === r.id || r.running || r.paused} aria-label={`Run ${r.name} now`} title="Run now"
                            className="grid size-9 place-items-center rounded-full border border-line-strong text-ink transition hover:border-ink hover:bg-ink hover:text-bg disabled:pointer-events-none disabled:opacity-40">
                            {busy === r.id ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                          </button>
                        )}
                        <Menu label={`More for ${r.name}`} items={[
                          { label: 'Details and runs', icon: <ListChecks size={16} />, onSelect: () => setShown(r.id) },
                          { label: 'Remove…', icon: <Trash2 size={16} />, danger: true, onSelect: () => setRemoving(r) },
                        ]} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      <NewDialog open={creating} onClose={() => { setCreating(false); void reload(); }} />
      <Details routine={routine} onClose={() => setShown(null)} />
      <Modal open={!!removing} onClose={() => setRemoving(null)} title={`Remove “${removing?.name ?? ''}”?`} size="sm">
        <p className="text-[13.5px] text-muted">It stops running and its run history goes. Nothing it already did is undone.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(null)}>Keep it</Button>
          <HoldButton icon={<Trash2 size={15} />} onConfirm={async () => { const r = removing!; setRemoving(null); if (await act('routine.remove', { routineId: r.id }, { success: `Removed “${r.name}”`, undo: false })) void reload(); }}>Remove</HoldButton>
        </div>
      </Modal>
    </div>
  );
}
function Stat({ n, label, warn, bad }: { n: number; label: string; warn?: boolean; bad?: boolean }) {
  return (
    <div className="min-w-[56px]">
      <p className={cx('text-[22px] font-semibold tabular leading-none tracking-[-0.03em]', n && warn ? 'text-warn' : n && bad ? 'text-bad' : 'text-ink', !n && (warn || bad) && 'text-faint')}>{n}</p>
      <p className="mt-1 text-[11.5px] text-muted">{label}</p>
    </div>
  );
}
