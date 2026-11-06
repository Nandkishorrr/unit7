// Keep it fresh on screen: the app page's Updates card ("Up to date", or "3 waiting · 1 security · releasing Tuesday
// 03:00", one switch for how far updates go, a click opens the batch), the Home card with the week and the streak,
// the Settings section with the defaults, freeze windows and each app's own setting, and the chat card.
import { useEffect, useState } from 'react';
import { ArrowRight, CalendarOff, ChevronRight, Package, Plus, RefreshCw, ShieldAlert, Snowflake, Sparkles } from 'lucide-react';
import { act, A, Badge, Button, Card, CardHeader, ChipSelect, cx, Fresh, HoverCard, IconCircle, Illustration, Input, Modal, PILL, Skeleton, StatusMark, SwitchRow, useSlidingPill } from '../../ui';
import { useTool } from '../care/data';
import { BatchModal, FreshTimeline, HoldDialog, StatusBadge } from './Batch';
import { MODES, ended, fmtDate, nice, type AppFresh, type Batch, type Mode, type Overview, type Planned } from './data';

export { BatchModal, FreshTimeline, MajorCard, HoldDialog } from './Batch';

// --- how far updates go: one switch, three stops ---------------------------------------------------------------------------
export function ModeSwitch({ value, onChange, disabled, label = 'Keep it up to date' }: { value: Mode; onChange: (m: Mode) => void; disabled?: boolean; label?: string }) {
  const [ref, pill] = useSlidingPill<HTMLDivElement>(value === 'off' ? null : value);
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={cx('relative grid w-full grid-cols-3 gap-0.5 rounded-full border border-line bg-raised/60 p-1', disabled && 'opacity-60')}>
      <span aria-hidden className={PILL} style={pill} />
      {MODES.map((m) => (
        <HoverCard key={m.value} content={<div className="max-w-[240px]"><p className="font-medium">{m.label}</p><p className="mt-0.5 text-[12.5px] text-ink-2">{m.says}</p></div>}>
          <button type="button" role="radio" aria-checked={value === m.value} data-pill={m.value} disabled={disabled} onClick={() => value !== m.value && onChange(m.value)}
            className={cx('relative z-10 h-8 truncate rounded-full px-2 text-[12.5px] font-medium transition-colors duration-300 max-sm:px-1', value === m.value ? 'text-bg' : 'text-muted hover:text-ink')}><span className="sm:hidden">{m.short}</span><span className="max-sm:hidden">{m.label}</span></button>
        </HoverCard>
      ))}
    </div>
  );
}
const MODE_DONE: Record<Mode, string> = { off: 'Updates are off', security: 'Security fixes only', minor: 'Security, patch and minor updates', all: 'Everything, majors each on their own' };
async function setMode(input: { serviceId?: string; mode: Mode | 'default' }, done: () => void) { if (await act('fresh.settings', input, { success: input.mode === 'default' ? 'Back to the default' : MODE_DONE[input.mode] })) done(); }

// --- the app page's card -----------------------------------------------------------------------------------------------------
const ROW_ICON = (p: Planned) => (p.kind === 'major' ? <span className="grid size-8 shrink-0 place-items-center rounded-[11px] bg-ink text-[11.5px] font-bold text-bg tabular">{p.items[0]?.to.split('.')[0]}</span>
  : <span className={cx('grid size-8 shrink-0 place-items-center rounded-[11px]', p.security ? 'bg-bad/10 text-bad' : 'bg-blue-soft text-blue-text')}>{p.security ? <ShieldAlert size={15} /> : <Package size={15} />}</span>);

export function UpdatesCard({ serviceId, className }: { serviceId: string; className?: string }) {
  const s = useTool<AppFresh>('fresh.status', { serviceId });
  const [open, setOpen] = useState<{ planned?: Planned | null; batchId?: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [pause, setPause] = useState(false);
  const v = s.data;
  // the first time the card shows, look (a GitHub app nobody looked at yet)
  useEffect(() => { if (v && v.state === 'unchecked' && v.source === null) void check(); }, [v?.serviceId, v?.state]);
  const check = async () => { setChecking(true); await act('fresh.plan', { serviceId, refresh: true }, { success: 'Checked' }); setChecking(false); void s.reload(); };
  if (!v && s.error) return <Card className={cx('p-5 md:p-6', className)}><CardHeader icon={<Sparkles size={19} />} tone="grad" title="Updates" sub="Couldn’t load them just now" actions={<Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void s.reload()}>Try again</Button>} /></Card>;
  if (!v) return <Card className={cx('p-5 md:p-6', className)}><Skeleton className="h-6 w-40 rounded-full" /><Skeleton className="mt-4 h-20 rounded-[18px]" /><Skeleton className="mt-3 h-10 rounded-full" /></Card>;
  // a batch at work shows its live steps; one waiting for a person is a row like the rest
  const cur = v.current?.status === 'running' ? v.current : null;
  const waitingFor = (p: Planned) => (v.current && v.current.key === p.key && v.current.status === 'waiting' ? v.current : null);
  const last = v.current && ended(v.current.status) ? v.current : null;
  const fresh = v.state === 'fresh';
  const plannedFor = (b: Batch) => v.batches.find((p) => p.key === b.key) ?? null;
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<Sparkles size={19} />} tone="grad" title="Updates" sub={<>Libraries, base image and fixes · <Fresh at={v.checkedAt} every={12 * 3600_000} /></>}
        actions={<Button size="sm" variant="ghost" icon={<RefreshCw size={13} className={cx(checking && 'animate-spin')} />} disabled={checking} onClick={check} aria-label="Check for updates now">Check</Button>} />
      {/* the one thing to know */}
      {fresh ? (
        <div className="mt-4 flex items-center gap-3 rounded-[18px] bg-ok/10 px-4 py-3.5 animate-rise">
          <StatusMark state="ok" solid size={30} label="Up to date" />
          <div className="min-w-0"><p className="text-[15px] font-semibold text-ok">Up to date</p><p className="text-[12.5px] text-muted">{v.streak.words || `Next look ${v.schedule.slot}`}{v.deps ? ` · ${v.deps} libraries watched` : ''}</p></div>
        </div>
      ) : cur ? (
        <button type="button" onClick={() => setOpen({ batchId: cur.id, planned: plannedFor(cur) })} className="mt-4 block w-full rounded-[18px] bg-blue-soft p-3.5 text-left transition hover:brightness-[0.98]">
          <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><StatusMark state={cur.status === 'waiting' ? 'warn' : 'work'} size={18} />{cur.status === 'waiting' ? `${cur.title} · ready for you` : `Updating now · ${cur.title}`}<ChevronRight size={15} className="ml-auto text-muted" aria-hidden /></p>
          <FreshTimeline steps={cur.steps} compact className="mt-2 pointer-events-none" />
        </button>
      ) : (
        <div className={cx('mt-4 rounded-[18px] px-4 py-3', v.state === 'held' ? 'bg-bad/8' : v.state === 'paused' || v.state === 'off' || v.state === 'unsupported' || v.state === 'unchecked' ? 'bg-raised' : 'bg-blue-soft')}>
          <p className={cx('text-[14px] font-semibold', v.state === 'held' ? 'text-bad' : 'text-ink')}>{v.state === 'held' ? `Held back · ${v.counts.waiting} waiting` : v.line}</p>
          {v.state === 'held' && last?.why && <p className="mt-0.5 text-[12.5px] text-bad">{last.why.replace(/^Held back: /, '')}</p>}
          {v.state === 'held' && <p className="mt-0.5 text-[12px] text-muted">Nothing changed on the live app. Unit7 tries again {v.schedule.slot}, or fix it and press Test and release.</p>}
          {v.state === 'unsupported' && <p className="mt-0.5 text-[12.5px] text-muted">{v.problems[0]}</p>}
          {v.state === 'paused' && <p className="mt-0.5 text-[12.5px] text-muted">Nothing updates until then. <button type="button" className="font-medium text-blue-text hover:underline" onClick={() => document.getElementById(`fresh-holds-${serviceId}`)?.scrollIntoView({ behavior: 'smooth' })}>See holds</button></p>}
        </div>
      )}
      {/* what's waiting: one row per batch, the batch opens in the centred pop-up */}
      {!cur && v.batches.length > 0 && (
        <ul className="mt-2 space-y-1">
          {v.batches.slice(0, 3).map((p) => (
            <li key={p.key}>
              <button type="button" onClick={() => setOpen({ planned: p, batchId: waitingFor(p)?.id ?? null })}
                className="flex w-full items-center gap-3 rounded-[14px] px-2 py-2 text-left transition hover:bg-raised">
                {ROW_ICON(p)}
                <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium text-ink">{p.title}</span><span className="block truncate text-[12px] text-muted">{p.kind === 'major' ? (waitingFor(p) ? 'Tests passed on a copy · waits for you' : 'A new major version · waits for you') : p.items.slice(0, 3).map((i) => nice(i.name)).join(', ') || p.summary[0]}</span></span>
                {waitingFor(p) ? <Badge tone="info">{waitingFor(p)!.tests?.status === 'passed' ? 'Tested · ready' : 'Ready'}</Badge> : p.worst && (p.worst === 'critical' || p.worst === 'high') && <Badge tone="bad">Security</Badge>}
                <ChevronRight size={15} className="shrink-0 text-muted" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* how far it goes by itself */}
      <div className="mt-4">
        <p className="mb-1.5 flex items-center justify-between text-[12.5px] font-medium text-ink-2"><span>Keep it up to date</span>{v.modeOwn ? <button type="button" onClick={() => void setMode({ serviceId, mode: 'default' }, s.reload)} className="text-[12px] font-normal text-muted hover:text-ink">Use the default</button> : <span className="text-[12px] font-normal text-faint">the default</span>}</p>
        <ModeSwitch value={v.mode} onChange={(m) => void setMode({ serviceId, mode: m }, s.reload)} />
        <p className="mt-1.5 text-[12px] text-muted">{v.mode === 'off' ? 'Off for this app.' : `${v.levelWords}: ${v.level >= 3 ? 'it goes by itself after the tests pass' : v.level === 2 ? 'one tap from you releases it' : 'Unit7 gets it ready, you release it'}${v.mode === 'all' && v.level < 4 ? '; majors wait for you' : ''}.`} {v.schedule.next && !fresh && v.mode !== 'off' ? `Weekly: ${v.schedule.slot}${v.schedule.learned ? ', its quietest hour' : ''}.` : ''}</p>
      </div>
      {(v.holds.length > 0 || v.held.length > 0) && (
        <div id={`fresh-holds-${serviceId}`} className="mt-3 space-y-1">
          {v.holds.map((h) => <HoldRow key={h.id} h={h} onDone={s.reload} />)}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
        {last && <button type="button" onClick={() => setOpen({ batchId: last.id })} className="inline-flex items-center gap-1.5 hover:text-ink"><StatusBadge s={last.status} down={last.downSeconds} />{last.title} · {fmtDate(last.finishedAt ?? last.createdAt)}</button>}
        {!v.paused && v.state !== 'off' && <button type="button" onClick={() => setPause(true)} className="ml-auto font-medium hover:text-ink">Pause updates…</button>}
      </div>
      <BatchModal open={!!open} onClose={() => setOpen(null)} serviceId={serviceId} app={v.app} planned={open?.planned} batchId={open?.batchId} onChange={() => void s.reload()} />
      <HoldDialog open={pause} onClose={() => setPause(false)} serviceId={serviceId} app={v.app} onDone={() => void s.reload()} />
    </Card>
  );
}

function HoldRow({ h, onDone }: { h: AppFresh['holds'][number]; onDone: () => void }) {
  const what = h.starts ? `Frozen ${fmtDate(h.starts)} – ${fmtDate(h.until)}` : h.package ? `${nice(h.package)} held${h.until ? ` until ${fmtDate(h.until)}` : ''}` : `Paused${h.until ? ` until ${fmtDate(h.until)}` : ''}`;
  return (
    <div className="flex items-center gap-2 rounded-[12px] bg-raised/70 px-3 py-1.5 text-[12.5px]">
      {h.starts ? <Snowflake size={13} className="text-blue-text" aria-hidden /> : <CalendarOff size={13} className="text-muted" aria-hidden />}
      <span className="min-w-0 flex-1 truncate text-ink-2">{what}{h.reason ? <span className="text-muted"> · {h.reason}</span> : null}</span>
      <button type="button" onClick={() => void act('fresh.hold', { remove: h.id }, { success: 'It goes again' }).then(onDone)} className="font-medium text-muted hover:text-ink">Let it go</button>
    </div>
  );
}

// --- Home: the week, the streak, what needs you --------------------------------------------------------------------------------
function StreakRing({ weeks }: { weeks: number }) {
  const k = Math.min(1, weeks / 12);
  return (
    <span role="img" aria-label={`${weeks} weeks up to date`} className="relative grid size-11 shrink-0 place-items-center">
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden className="absolute inset-0 -rotate-90">
        <circle cx="22" cy="22" r="18" fill="none" stroke="var(--line)" strokeWidth="4" />
        <circle cx="22" cy="22" r="18" fill="none" stroke="var(--ok)" strokeWidth="4" strokeLinecap="round" pathLength={1} strokeDasharray={`${k} 1`} className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-700" />
      </svg>
      <span className="tabular text-[13px] font-bold text-ink">{weeks}</span>
    </span>
  );
}
export function FreshHomeCard({ className }: { className?: string }) {
  const s = useTool<Overview>('fresh.status', {});
  const o = s.data;
  if (!o || !o.apps.length) return null;
  const rank = (a: Overview['apps'][number]) => (a.state === 'held' ? 3 : a.counts.security ? 2 : a.state === 'running' ? 1 : 0);
  const needs = o.apps.filter((a) => a.state === 'held' || a.state === 'waiting' || a.state === 'running').sort((a, b) => rank(b) - rank(a)).slice(0, 3);
  return (
    <section aria-label="Keep it fresh" className={cx('rounded-[24px] border border-line bg-surface p-4 shadow-soft', className)}>
      <div className="flex items-center gap-2.5">
        <IconCircle size={34} tone="grad"><Sparkles size={16} /></IconCircle>
        <div className="min-w-0 flex-1"><h2 className="text-[14.5px] font-medium tracking-[-0.01em]">Keep it fresh</h2><p className="truncate text-[12px] text-muted">{o.streak.words || (o.freeze ? `Frozen until ${fmtDate(o.freeze.until)}` : `${o.modeWords}, every week`)}</p></div>
        {o.streak.weeks > 0 && <StreakRing weeks={o.streak.weeks} />}
      </div>
      <p className="mt-3 text-[13px] leading-snug text-ink">{o.line}</p>
      {needs.length > 0 && (
        <ul className="mt-2 space-y-1">
          {needs.map((a) => (
            <li key={a.serviceId}><A href={`/projects/${a.projectId}/services/${a.serviceId}`} className="flex items-center gap-2.5 rounded-[14px] p-1.5 transition hover:bg-raised">
              <StatusMark state={a.state === 'held' ? 'bad' : a.state === 'running' ? 'work' : a.counts.security ? 'warn' : 'live'} size={18} />
              <span className="min-w-0 flex-1 text-[12.5px]"><span className="block truncate font-medium text-ink">{a.app}<span className="font-normal text-muted"> · {a.project}{a.env ? ` ${a.env}` : ''}</span></span><span className={cx('block truncate', a.state === 'held' ? 'text-bad' : 'text-muted')}>{a.state === 'held' ? a.current?.why ?? 'Held back' : a.line}</span></span>
              <ArrowRight size={13} className="shrink-0 text-muted" aria-hidden />
            </A></li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Settings: the defaults, freeze windows, each app's own ------------------------------------------------------------------------
const LEVELS: [string, string][] = [['Watch, Suggest', 'Unit7 finds what’s new and gets it ready; you release it.'], ['Ask first', 'It tests everything on a copy, then one tap (here or on your phone) releases it.'], ['Fix itself', 'Security, patch and minor updates go by themselves once the tests pass. Majors wait for you.'], ['Autopilot', 'Majors too, once the tests pass and the copy looks normal.']];
const APP_MODES = [{ value: 'default', label: 'Default' }, { value: 'security', label: 'Security only' }, { value: 'minor', label: 'Patch & minor' }, { value: 'all', label: 'Everything' }, { value: 'off', label: 'Off' }];
export function FreshSettings({ canChange }: { canChange: boolean }) {
  const s = useTool<Overview>('fresh.status', {});
  const [freezing, setFreezing] = useState(false);
  const o = s.data;
  if (!o) return <><Skeleton className="h-[360px] rounded-[24px]" /><Skeleton className="h-[360px] rounded-[24px]" /></>;
  const freezes = o.holds.filter((h) => h.starts);
  return (
    <>
      <Card className="p-6">
        <CardHeader tone="grad" icon={<Sparkles size={20} />} title="Keep apps up to date" sub="Every week: tested on a copy, released with zero downtime, undone by itself if it looks worse." />
        <div className="mt-5">
          <p className="mb-1.5 text-[13px] font-medium text-ink">For every app, unless it has its own</p>
          <ModeSwitch value={o.mode} disabled={!canChange} onChange={(m) => void setMode({ mode: m }, s.reload)} />
          <p className="mt-1.5 text-[12px] text-muted">{MODES.find((m) => m.value === o.mode)?.says ?? 'Off.'} {o.mode !== 'off' && canChange && <button type="button" className="font-medium text-muted underline decoration-line-strong underline-offset-4 hover:text-ink" onClick={() => void setMode({ mode: 'off' }, s.reload)}>Turn off</button>}</p>
        </div>
        <div className="mt-2 divide-y divide-line">
          <SwitchRow title="Weekly report" body="Monday morning, on Home and your phone: what was updated, security fixes, seconds down." checked={o.report} disabled={!canChange} onChange={(on) => void act('fresh.settings', { report: on }, { success: on ? 'The weekly report is on' : 'The weekly report is off' }).then(s.reload)} />
          <div className="py-3.5">
            <div className="flex items-center gap-3"><p className="min-w-0 flex-1 text-[14px] font-medium text-ink">Freeze windows</p>{canChange && <Button size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => setFreezing(true)}>Add</Button>}</div>
            <p className="mt-0.5 text-[13px] text-muted">Nothing updates while one is on: “not during my launch week”.</p>
            {freezes.length > 0 && <div className="mt-2 space-y-1">{freezes.map((h) => <HoldRow key={h.id} h={h} onDone={s.reload} />)}</div>}
          </div>
        </div>
        <h3 className="mt-3 text-[13px] font-semibold text-ink">How far it goes by itself</h3>
        <p className="text-[12px] text-muted">It follows each app’s Autopilot level. A failing test always stops it, and a bad release comes back by itself.</p>
        <ul className="mt-2 space-y-1.5">{LEVELS.map(([k, v]) => <li key={k} className="flex gap-2 text-[12.5px]"><span className="w-[92px] shrink-0 font-medium text-ink">{k}</span><span className="text-ink-2">{v}</span></li>)}</ul>
      </Card>
      <Card className="p-6">
        <CardHeader tone="grad" icon={<Package size={20} />} title="Each app" sub={o.line} />
        {o.apps.length ? (
          <ul className="mt-4 divide-y divide-line">
            {o.apps.map((a) => (
              <li key={a.serviceId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <StatusMark state={a.state === 'fresh' ? 'ok' : a.state === 'held' ? 'bad' : a.state === 'running' ? 'work' : a.state === 'waiting' ? 'live' : 'off'} size={18} />
                <span className="min-w-[160px] flex-1"><A href={`/projects/${a.projectId}/services/${a.serviceId}`} className="block truncate text-[13.5px] font-medium text-ink hover:underline">{a.app}<span className="font-normal text-muted"> · {a.project}{a.env ? ` ${a.env}` : ''}</span></A><span className={cx('block truncate text-[12px]', a.state === 'held' ? 'text-bad' : 'text-muted')}>{a.state === 'held' ? a.current?.why ?? 'Held back' : a.line}{a.state === 'fresh' && a.slot ? ` · weekly, ${a.slot}` : ''}</span></span>
                <ChipSelect label={`How far updates go for ${a.app}`} value={a.modeOwn ? a.mode : 'default'} options={APP_MODES} onChange={(m) => void setMode({ serviceId: a.serviceId, mode: m as Mode | 'default' }, s.reload)} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-6 flex flex-col items-center text-center"><Illustration name="apps" size={84} /><p className="mt-3 text-[13.5px] text-muted">Apps you deploy with Unit7 show here.</p></div>
        )}
      </Card>
      <FreezeDialog open={freezing} onClose={() => setFreezing(false)} onDone={s.reload} />
    </>
  );
}

function FreezeDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const today = new Date().toISOString().slice(0, 10), week = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(today), [to, setTo] = useState(week), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setFrom(today); setTo(week); setReason(''); } }, [open]);
  const save = async () => { setBusy(true); const r = await act('fresh.hold', { starts: from, until: to, ...(reason.trim() && { reason: reason.trim() }) }, { success: 'Frozen: nothing updates in that window' }); setBusy(false); if (r) { onClose(); onDone(); } };
  return (
    <Modal open={open} onClose={onClose} title="Freeze updates for a while" size="sm">
      <p className="text-[13px] text-ink-2">Nothing updates between these days, on any app. Updates that were due go out the week after.</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <label className="text-[12.5px] text-muted">From<Input type="date" value={from} min={today} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-10 px-3" /></label>
        <label className="text-[12.5px] text-muted">Until<Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="mt-1 h-10 px-3" /></label>
      </div>
      <label className="mt-3 block text-[12.5px] text-muted">Why (optional)<Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. launch week" className="mt-1 h-10 px-3" /></label>
      <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="dark" icon={<Snowflake size={15} />} loading={busy} disabled={!from || !to || to <= from} onClick={save}>Freeze</Button></div>
    </Modal>
  );
}

// --- the chat card -------------------------------------------------------------------------------------------------------------------
export function FreshChatCard({ tool, output }: { tool: string; input?: any; output: any }) {
  const [open, setOpen] = useState<{ planned?: Planned | null; batchId?: string | null } | null>(null);
  if (Array.isArray(output?.apps)) {
    const o = output as Overview;
    return (
      <div className="rounded-[20px] border border-line bg-surface p-4">
        <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><Sparkles size={15} className="text-blue-text" aria-hidden />{o.line}</p>
        {o.streak.words && <p className="text-[12px] text-muted">{o.streak.words}</p>}
        <ul className="mt-2 divide-y divide-line">{o.apps.map((a) => (
          <li key={a.serviceId}><A href={`/projects/${a.projectId}/services/${a.serviceId}`} className="flex items-center gap-2.5 py-2 hover:opacity-80">
            <StatusMark state={a.state === 'fresh' ? 'ok' : a.state === 'held' ? 'bad' : a.state === 'running' ? 'work' : a.counts.security ? 'warn' : a.state === 'waiting' ? 'live' : 'off'} size={18} />
            <span className="min-w-0 flex-1 truncate text-[13px]"><span className="font-medium text-ink">{a.app}</span><span className="text-muted"> ({a.project}{a.env ? ` ${a.env}` : ''}) · {a.state === 'held' ? a.current?.why ?? 'Held back' : a.line}</span></span><ChevronRight size={14} className="text-muted" aria-hidden />
          </A></li>
        ))}</ul>
      </div>
    );
  }
  if (Array.isArray(output?.batches) && output.serviceId) {
    const v = output as AppFresh;
    return (
      <div className="rounded-[20px] border border-line bg-surface p-4">
        <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><StatusMark state={v.state === 'fresh' ? 'ok' : v.state === 'held' ? 'bad' : 'live'} size={18} />{v.app} · {v.line}</p>
        {v.batches.length > 0 && <ul className="mt-2 space-y-1">{v.batches.map((p) => (
          <li key={p.key}><button type="button" onClick={() => setOpen({ planned: p })} className="flex w-full items-center gap-3 rounded-[14px] px-2 py-1.5 text-left transition hover:bg-raised">{ROW_ICON(p)}<span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink">{p.title}</span><span className="block truncate text-[12px] text-muted">{p.summary[0]}</span></span><ChevronRight size={14} className="text-muted" aria-hidden /></button></li>
        ))}</ul>}
        <BatchModal open={!!open} onClose={() => setOpen(null)} serviceId={v.serviceId} app={v.app} planned={open?.planned} batchId={open?.batchId} />
      </div>
    );
  }
  if (Array.isArray(output?.steps) && output.id) {
    const b = output as Batch;
    return (
      <div className="rounded-[20px] border border-line bg-surface p-4">
        <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink">{b.title}<StatusBadge s={b.status} down={b.downSeconds} /></p>
        <FreshTimeline steps={b.steps} deploymentId={b.deploymentId} className="mt-2" />
        {b.why && <p className="mt-2 text-[12.5px] text-bad">{b.why}</p>}
      </div>
    );
  }
  if (typeof output?.line === 'string' && tool === 'fresh.report') return <div className="rounded-[20px] border border-line bg-surface p-4 text-[13.5px] text-ink">{output.line}{output.streak?.words ? <span className="block text-[12px] text-muted">{output.streak.words}</span> : null}</div>;
  if (output?.upToDate) return <div className="flex items-center gap-2 rounded-[20px] border border-line bg-surface p-4 text-[13.5px] text-ink"><StatusMark state="ok" size={18} />{output.note}</div>;
  return null;
}

export const freshTools = new Set(['fresh.plan', 'fresh.status', 'fresh.run', 'fresh.release', 'fresh.batch', 'fresh.report']);
